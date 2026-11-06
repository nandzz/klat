import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const args = process.argv.slice(2);
const kindIndex = args.indexOf("--kind");
const kind = kindIndex >= 0 ? args.splice(kindIndex, 2)[1] : "summary";
const interrupt = args.includes("--interrupt") ? (args.splice(args.indexOf("--interrupt"), 1), true) : false;
const command = args[0] === "status" || args[0] === "stop" ? args.shift() : "speak";
const text = args.join(" ");
const port = process.env.KLAT_PORT ?? 48613;

const client = new Client({ name: process.env.KLAT_CLIENT ?? "say-script", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
const result =
  command === "speak"
    ? await client.callTool({ name: "speak", arguments: { text, kind, interrupt } })
    : await client.callTool({ name: command, arguments: {} });
console.log(result.content?.[0]?.text ?? JSON.stringify(result));
await client.close();
