import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import { SERVER_INSTRUCTIONS } from "../shared/instructions.js";
import type { SpeechKind } from "../shared/types.js";

export interface VoiceBackend {
  isMuted(): boolean;
  speak(text: string, kind: SpeechKind, source: string, interrupt: boolean): { id: string; spokenText: string } | null;
  stop(): void;
  status(): Record<string, unknown>;
}

const SPEAK_DESCRIPTION = `Say a short spoken message to the user through their speakers. Returns at once; audio plays in the background.
Use it like a coworker: give context and point to your output ("I fixed the bug and added two tests. Check the auth changes."). Do not read your answer aloud.
Keep it to one or two plain sentences unless the user asked for more. No code, paths, URLs or Markdown.`;

export class McpHttpServer {
  private http: Server | null = null;
  private sessions = new Map<string, StreamableHTTPServerTransport>();

  constructor(private backend: VoiceBackend, private version: string) {}

  listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const http = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          if (!res.headersSent) {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: String(error) }));
          }
        });
      });
      http.once("error", reject);
      http.listen(port, "127.0.0.1", () => {
        http.off("error", reject);
        this.http = http;
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    for (const transport of this.sessions.values()) await transport.close();
    this.sessions.clear();
    await new Promise<void>((resolve) => (this.http ? this.http.close(() => resolve()) : resolve()));
    this.http = null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (!["127.0.0.1", "localhost", "[::1]"].includes(host) || req.headers.origin) {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ app: "breathing", version: this.version }));
      return;
    }
    if (url.pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }

    const sessionId = req.headers["mcp-session-id"];
    const existing = typeof sessionId === "string" ? this.sessions.get(sessionId) : undefined;
    if (existing) {
      await existing.handleRequest(req, res, req.method === "POST" ? await readJson(req) : undefined);
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(400).end("No valid session");
      return;
    }
    const body = await readJson(req);
    if (!isInitializeRequest(body)) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "No valid session" }, id: null }));
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        this.sessions.set(id, transport);
      },
      onsessionclosed: (id) => {
        this.sessions.delete(id);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) this.sessions.delete(transport.sessionId);
    };
    const server = this.createMcpServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  private createMcpServer(): McpServer {
    const server = new McpServer(
      { name: "breathing", version: this.version },
      { instructions: SERVER_INSTRUCTIONS },
    );
    const sourceName = () => server.server.getClientVersion()?.name ?? "agent";

    server.registerTool(
      "speak",
      {
        title: "Speak to the user",
        description: SPEAK_DESCRIPTION,
        inputSchema: {
          text: z.string().min(1).max(2000).describe("What to say. Plain spoken English, usually one or two sentences."),
          kind: z
            .enum(["summary", "progress", "attention"])
            .default("summary")
            .describe("summary: end of turn. progress: a milestone in a long task. attention: blocked, needs a decision, or urgent news."),
          interrupt: z
            .boolean()
            .default(false)
            .describe("Stop your own message that is playing now and clear your queued messages first."),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async ({ text, kind, interrupt }) => {
        if (this.backend.isMuted()) {
          return result({ spoken: false, muted: true, note: "The user muted the voice. Continue in text." });
        }
        const queued = this.backend.speak(text, kind, sourceName(), interrupt);
        if (!queued) return result({ spoken: false, muted: false, note: "Nothing to say after cleanup (only code or links)." });
        return result({ spoken: true, muted: false, id: queued.id });
      },
    );

    server.registerTool(
      "stop",
      {
        title: "Stop speaking",
        description: "Stop the voice now and clear all queued speech.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async () => {
        this.backend.stop();
        return result({ stopped: true });
      },
    );

    server.registerTool(
      "status",
      {
        title: "Voice status",
        description: "Get the voice status: muted, speaking, queue length and current voice.",
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async () => result(this.backend.status()),
    );

    return server;
  }
}

function result(data: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new Error("Request too large");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}
