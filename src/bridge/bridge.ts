import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { SERVER_INSTRUCTIONS } from "../shared/instructions.js";

const DEFAULT_PORT = 48613;
const VERSION = "0.1.0";

function log(message: string): void {
  process.stderr.write(`[klat-bridge] ${message}\n`);
}

function readPort(): number {
  if (process.env.KLAT_PORT) return Number(process.env.KLAT_PORT);
  const file = join(homedir(), "Library", "Application Support", "Klat", "settings.json");
  try {
    if (existsSync(file)) return Number(JSON.parse(readFileSync(file, "utf8")).port) || DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
  return DEFAULT_PORT;
}

const port = readPort();
const baseUrl = `http://127.0.0.1:${port}`;

async function isAppRunning(): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) });
    const body = (await response.json()) as { app?: string };
    return body.app === "klat";
  } catch {
    return false;
  }
}

function launchApp(): void {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const exec = process.execPath;
  if (exec.includes(".app/Contents/MacOS/") && !exec.includes("node_modules")) {
    spawn(exec, [], { detached: true, stdio: "ignore", env }).unref();
  } else if (exec.includes("node_modules/electron")) {
    spawn(exec, [resolve(import.meta.dirname, "..", "..")], { detached: true, stdio: "ignore", env }).unref();
  } else {
    spawn("open", ["-b", "com.nandzz.klat"], { detached: true, stdio: "ignore" }).unref();
  }
}

async function ensureApp(): Promise<void> {
  if (await isAppRunning()) return;
  log("Klat app is not running, starting it");
  launchApp();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isAppRunning()) return;
  }
  throw new Error("The Klat app did not start. Open it from Applications.");
}

let remote: Promise<Client> | null = null;

function connectRemote(clientName: string): Promise<Client> {
  if (remote) return remote;
  const attempt = (async () => {
    await ensureApp();
    const client = new Client({ name: clientName, version: VERSION });
    client.onclose = () => {
      if (remote === attempt) remote = null;
    };
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
    return client;
  })();
  remote = attempt;
  attempt.catch(() => {
    if (remote === attempt) remote = null;
  });
  return attempt;
}

const server = new Server(
  { name: "klat", version: VERSION },
  { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
);

const clientName = () => server.getClientVersion()?.name ?? "agent";

async function withRemote<T>(action: (client: Client) => Promise<T>): Promise<T> {
  try {
    return await action(await connectRemote(clientName()));
  } catch (error) {
    log(`retrying after error: ${error instanceof Error ? error.message : String(error)}`);
    const stale = remote;
    remote = null;
    await stale?.then((client) => client.close()).catch(() => undefined);
    return action(await connectRemote(clientName()));
  }
}

server.setRequestHandler(ListToolsRequestSchema, async () => withRemote((client) => client.listTools()));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    return await withRemote((client) => client.callTool(request.params));
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: `Voice not available: ${error instanceof Error ? error.message : String(error)}. Continue in text.` }],
    };
  }
});

server.oninitialized = () => {
  connectRemote(clientName()).catch((error) => log(String(error)));
};

await server.connect(new StdioServerTransport());
