import { app, dialog } from "electron";
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { codexServerBlock, upsertTomlSection } from "./toml.js";

const run = promisify(execFile);
const HOME = homedir();
const SERVER_NAME = "klat";

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
  return join(app.getAppPath(), "skill", "klat");
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function planInstall(): Promise<Step[]> {
  const steps: Step[] = [];

  const claude = await findCommand("claude");
  if (claude || existsSync(join(HOME, ".claude"))) {
    const skillTarget = join(HOME, ".claude", "skills", "klat");
    if (claude) {
      steps.push({
        client: "Claude Code",
        description: `Run: claude mcp add --scope user ${SERVER_NAME} (stdio bridge, starts the app when needed)`,
        apply: async () => {
          const launch = bridgeLaunch();
          const command = [launch.command, ...launch.args].map(shellQuote).join(" ");
          await loginShell(`claude mcp remove --scope user ${SERVER_NAME} >/dev/null 2>&1 || true`);
          await loginShell(`claude mcp add --scope user ${SERVER_NAME} -e ELECTRON_RUN_AS_NODE=1 -- ${command}`);
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
    const skillTarget = join(codexHome, "skills", "klat");
    steps.push({
      client: "Codex",
      description: `Add [mcp_servers.${SERVER_NAME}] (stdio bridge) to ${configFile.replace(HOME, "~")}`,
      apply: async () => {
        mkdirSync(codexHome, { recursive: true });
        const current = existsSync(configFile) ? readFileSync(configFile, "utf8") : "";
        writeFileSync(configFile, upsertTomlSection(current, `[mcp_servers.${SERVER_NAME}]`, codexServerBlock(SERVER_NAME, bridgeLaunch())));
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
  const steps = await planInstall();
  if (steps.length === 0) {
    await dialog.showMessageBox({
      type: "info",
      message: "No supported AI client found",
      detail: `Klat looks for Claude Code and Codex. For other MCP clients, add this server:\n\nhttp://127.0.0.1:${port}/mcp\n\nThe README has the manual steps.`,
    });
    return;
  }
  const clients = [...new Set(steps.map((s) => s.client))].join(" and ");
  const { response } = await dialog.showMessageBox({
    type: "question",
    buttons: ["Install", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    message: `Connect Klat to ${clients}?`,
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
    message: failures.length ? "Some steps failed" : "Klat is connected",
    detail: failures.length
      ? failures.join("\n\n")
      : `Done for ${clients}. Start a new agent session so it loads the voice.`,
  });
}
