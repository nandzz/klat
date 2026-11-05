import { app, dialog } from "electron";
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const HOME = homedir();
const SERVER_NAME = "breathing";

interface Step {
  client: string;
  description: string;
  apply: () => Promise<void>;
}

async function loginShell(command: string): Promise<string> {
  const { stdout } = await run("/bin/zsh", ["-lc", command], { timeout: 20_000 });
  return stdout.trim();
}

async function findCommand(name: string): Promise<string | null> {
  try {
    const path = await loginShell(`command -v ${name}`);
    return path || null;
  } catch {
    return null;
  }
}

function skillSource(): string {
  return join(app.getAppPath(), "skill", "breathing");
}

function bridgePath(): string {
  return join(app.getAppPath(), "dist", "bridge", "bridge.js");
}

function bridgeLaunch(): { command: string; args: string[] } {
  return { command: process.execPath, args: [bridgePath()] };
}

function copySkill(target: string): void {
  mkdirSync(dirname(target), { recursive: true });
  cpSync(skillSource(), target, { recursive: true });
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function codexBlock(): string {
  const launch = bridgeLaunch();
  return [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${tomlString(launch.command)}`,
    `args = [${launch.args.map(tomlString).join(", ")}]`,
    `startup_timeout_sec = 40`,
    `env = { ELECTRON_RUN_AS_NODE = "1" }`,
  ].join("\n");
}

function upsertTomlSection(content: string, header: string, block: string): string {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) return `${content.replace(/\s*$/, "")}\n\n${block}\n`;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end]!)) end++;
  lines.splice(start, end - start, ...block.split("\n"), "");
  return lines.join("\n");
}

export async function planInstall(port: number): Promise<Step[]> {
  const steps: Step[] = [];
  const url = `http://127.0.0.1:${port}/mcp`;

  const claude = await findCommand("claude");
  if (claude || existsSync(join(HOME, ".claude"))) {
    const skillTarget = join(HOME, ".claude", "skills", "breathing");
    if (claude) {
      steps.push({
        client: "Claude Code",
        description: `Run: claude mcp add --scope user --transport http ${SERVER_NAME} ${url}`,
        apply: async () => {
          await loginShell(`claude mcp remove --scope user ${SERVER_NAME} >/dev/null 2>&1 || true`);
          await loginShell(`claude mcp add --scope user --transport http ${SERVER_NAME} ${url}`);
        },
      });
    }
    steps.push({
      client: "Claude Code",
      description: `Copy the skill to ${skillTarget.replace(HOME, "~")}`,
      apply: async () => copySkill(skillTarget),
    });
  }

  const codex = await findCommand("codex");
  const codexHome = process.env.CODEX_HOME ?? join(HOME, ".codex");
  if (codex || existsSync(codexHome)) {
    const configFile = join(codexHome, "config.toml");
    const skillTarget = join(codexHome, "skills", "breathing");
    steps.push({
      client: "Codex",
      description: `Add [mcp_servers.${SERVER_NAME}] (stdio bridge) to ${configFile.replace(HOME, "~")}`,
      apply: async () => {
        mkdirSync(codexHome, { recursive: true });
        const current = existsSync(configFile) ? readFileSync(configFile, "utf8") : "";
        writeFileSync(configFile, upsertTomlSection(current, `[mcp_servers.${SERVER_NAME}]`, codexBlock()));
      },
    });
    steps.push({
      client: "Codex",
      description: `Copy the skill to ${skillTarget.replace(HOME, "~")}`,
      apply: async () => copySkill(skillTarget),
    });
  }

  return steps;
}

export async function runInstaller(port: number): Promise<void> {
  const steps = await planInstall(port);
  if (steps.length === 0) {
    await dialog.showMessageBox({
      type: "info",
      message: "No supported AI client found",
      detail: `Breathing looks for Claude Code and Codex. For other MCP clients, add this server:\n\nhttp://127.0.0.1:${port}/mcp\n\nThe README has the manual steps.`,
    });
    return;
  }
  const clients = [...new Set(steps.map((s) => s.client))].join(" and ");
  const { response } = await dialog.showMessageBox({
    type: "question",
    buttons: ["Install", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    message: `Connect Breathing to ${clients}?`,
    detail: `These changes will be made:\n\n${steps.map((s) => `• ${s.description}`).join("\n")}\n\nRestart running agent sessions after the install.`,
  });
  if (response !== 0) return;

  const failures: string[] = [];
  for (const step of steps) {
    try {
      await step.apply();
    } catch (error) {
      failures.push(`${step.description}\n  ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await dialog.showMessageBox({
    type: failures.length ? "warning" : "info",
    message: failures.length ? "Some steps failed" : "Breathing is connected",
    detail: failures.length
      ? failures.join("\n\n")
      : `Done for ${clients}. Start a new agent session so it loads the voice.`,
  });
}
