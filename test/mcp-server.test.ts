import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { request } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpHttpServer, type VoiceBackend } from "../src/main/mcp-server.js";
import { SERVER_INSTRUCTIONS } from "../src/shared/instructions.js";

function fakeBackend() {
  return {
    muted: false,
    isMuted: vi.fn(function (this: { muted: boolean }) {
      return this.muted;
    }),
    speak: vi.fn<VoiceBackend["speak"]>(() => ({ id: "msg-1", spokenText: "Hello." })),
    stop: vi.fn(),
    status: vi.fn(() => ({ muted: false, speaking: true, queued: 2 })),
  };
}

let backend: ReturnType<typeof fakeBackend>;
let server: McpHttpServer;
const clients: Client[] = [];

async function connect(name = "claude-code"): Promise<Client> {
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return client;
}

function parse(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]!.text);
}

function raw(path: string, headers: Record<string, string> = {}, method = "GET", body?: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.port, path, method, headers }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

beforeEach(async () => {
  backend = fakeBackend();
  server = new McpHttpServer(backend, "9.9.9");
  await server.listen(0);
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  await server.close();
});

describe("MCP protocol", () => {
  it("sends the speech rules as server instructions", async () => {
    const client = await connect();
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    expect(client.getServerVersion()).toMatchObject({ name: "klat", version: "9.9.9" });
  });

  it("lists the speak, stop and status tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["speak", "status", "stop"]);
    const speak = tools.find((t) => t.name === "speak")!;
    expect(speak.inputSchema.required).toEqual(["text"]);
    expect(Object.keys(speak.inputSchema.properties ?? {})).toEqual(["text", "kind", "interrupt"]);
  });
});

describe("speak tool", () => {
  it("passes the text and uses the client name as the source", async () => {
    const client = await connect("codex");
    const result = parse(await client.callTool({ name: "speak", arguments: { text: "All done.", kind: "attention", interrupt: true } }));
    expect(result).toEqual({ spoken: true, muted: false, id: "msg-1" });
    expect(backend.speak).toHaveBeenCalledWith("All done.", "attention", "codex", true);
  });

  it("uses summary and no interrupt by default", async () => {
    const client = await connect();
    await client.callTool({ name: "speak", arguments: { text: "Hi." } });
    expect(backend.speak).toHaveBeenCalledWith("Hi.", "summary", "claude-code", false);
  });

  it("keeps sources apart for two clients", async () => {
    const a = await connect("claude-code");
    const b = await connect("codex");
    await a.callTool({ name: "speak", arguments: { text: "From a." } });
    await b.callTool({ name: "speak", arguments: { text: "From b." } });
    expect(backend.speak.mock.calls.map((c) => c[2])).toEqual(["claude-code", "codex"]);
  });

  it("does not speak when muted", async () => {
    backend.muted = true;
    const client = await connect();
    const result = parse(await client.callTool({ name: "speak", arguments: { text: "Hello." } }));
    expect(result).toMatchObject({ spoken: false, muted: true });
    expect(backend.speak).not.toHaveBeenCalled();
  });

  it("reports when nothing was left to say", async () => {
    backend.speak.mockReturnValueOnce(null);
    const client = await connect();
    const result = parse(await client.callTool({ name: "speak", arguments: { text: "```x```" } }));
    expect(result).toMatchObject({ spoken: false, muted: false });
  });

  it("rejects empty text and unknown kinds", async () => {
    const client = await connect();
    const empty = await client.callTool({ name: "speak", arguments: { text: "" } });
    const badKind = await client.callTool({ name: "speak", arguments: { text: "Hi.", kind: "shout" } });
    expect(empty.isError).toBe(true);
    expect(badKind.isError).toBe(true);
    expect(backend.speak).not.toHaveBeenCalled();
  });
});

describe("stop and status tools", () => {
  it("stop calls the backend", async () => {
    const client = await connect();
    expect(parse(await client.callTool({ name: "stop", arguments: {} }))).toEqual({ stopped: true });
    expect(backend.stop).toHaveBeenCalledOnce();
  });

  it("status returns the backend status", async () => {
    const client = await connect();
    expect(parse(await client.callTool({ name: "status", arguments: {} }))).toEqual({ muted: false, speaking: true, queued: 2 });
  });
});

describe("HTTP layer", () => {
  it("answers the health check", async () => {
    const response = await raw("/health");
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ app: "klat", version: "9.9.9" });
  });

  it("returns 404 for unknown paths", async () => {
    expect((await raw("/nope")).status).toBe(404);
  });

  it("rejects a foreign Host header", async () => {
    expect((await raw("/health", { host: "evil.example.com" })).status).toBe(403);
  });

  it("rejects requests from a browser page", async () => {
    expect((await raw("/health", { origin: "https://evil.example.com" })).status).toBe(403);
  });

  it("rejects a non-initialize request without a session", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const response = await raw("/mcp", { "content-type": "application/json", accept: "application/json, text/event-stream" }, "POST", body);
    expect(response.status).toBe(400);
  });

  it("rejects GET without a session", async () => {
    expect((await raw("/mcp")).status).toBe(400);
  });

  it("picks a free port when asked for port 0", () => {
    expect(server.port).toBeGreaterThan(0);
  });
});
