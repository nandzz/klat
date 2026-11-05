import { describe, expect, it } from "vitest";
import { codexServerBlock, tomlString, upsertTomlSection } from "../src/main/toml.js";

const block = codexServerBlock("breathing", {
  command: "/Applications/Breathing.app/Contents/MacOS/Breathing",
  args: ["/Applications/Breathing.app/Contents/Resources/app.asar/dist/bridge/bridge.js"],
});

describe("tomlString", () => {
  it("quotes and escapes", () => {
    expect(tomlString('a "b" \\ c')).toBe('"a \\"b\\" \\\\ c"');
  });
});

describe("codexServerBlock", () => {
  it("writes a stdio server block for the bridge", () => {
    expect(block).toBe(
      [
        "[mcp_servers.breathing]",
        'command = "/Applications/Breathing.app/Contents/MacOS/Breathing"',
        'args = ["/Applications/Breathing.app/Contents/Resources/app.asar/dist/bridge/bridge.js"]',
        "startup_timeout_sec = 40",
        'env = { ELECTRON_RUN_AS_NODE = "1" }',
      ].join("\n"),
    );
  });
});

describe("upsertTomlSection", () => {
  it("writes only the block into an empty file", () => {
    expect(upsertTomlSection("", "[mcp_servers.breathing]", block)).toBe(`${block}\n`);
  });

  it("appends the block after existing content", () => {
    const content = 'model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n';
    expect(upsertTomlSection(content, "[mcp_servers.breathing]", block)).toBe(
      `model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n\n${block}\n`,
    );
  });

  it("replaces an existing section and keeps the sections after it", () => {
    const content = [
      'model = "o3"',
      "",
      "[mcp_servers.breathing]",
      'command = "old"',
      'args = ["old.js"]',
      "",
      "[mcp_servers.other]",
      'command = "x"',
      "",
    ].join("\n");
    const result = upsertTomlSection(content, "[mcp_servers.breathing]", block);
    expect(result).not.toContain('"old"');
    expect(result).toContain(block);
    expect(result).toContain('[mcp_servers.other]\ncommand = "x"');
    expect(result.match(/\[mcp_servers\.breathing\]/g)).toHaveLength(1);
  });

  it("removes old sub-tables of the section", () => {
    const content = [
      "[mcp_servers.breathing]",
      'command = "old"',
      "",
      "[mcp_servers.breathing.env]",
      'OLD = "1"',
      "",
      "[mcp_servers.other]",
      'command = "x"',
      "",
    ].join("\n");
    const result = upsertTomlSection(content, "[mcp_servers.breathing]", block);
    expect(result).not.toContain("[mcp_servers.breathing.env]");
    expect(result).not.toContain("OLD");
    expect(result).toContain('[mcp_servers.other]\ncommand = "x"');
  });

  it("gives the same result when run twice", () => {
    const content = 'model = "o3"\n';
    const once = upsertTomlSection(content, "[mcp_servers.breathing]", block);
    expect(upsertTomlSection(once, "[mcp_servers.breathing]", block)).toBe(once);
  });
});
