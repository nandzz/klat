export function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function codexServerBlock(name: string, launch: { command: string; args: string[] }): string {
  return [
    `[mcp_servers.${name}]`,
    `command = ${tomlString(launch.command)}`,
    `args = [${launch.args.map(tomlString).join(", ")}]`,
    `startup_timeout_sec = 40`,
    `env = { ELECTRON_RUN_AS_NODE = "1" }`,
  ].join("\n");
}

export function upsertTomlSection(content: string, header: string, block: string): string {
  const name = header.trim().slice(1, -1);
  const belongs = (line: string) => {
    const match = /^\s*\[+\s*([^\]]+?)\s*\]+\s*(?:#.*)?$/.exec(line);
    return match ? match[1] === name || match[1]!.startsWith(`${name}.`) : null;
  };
  const lines = content.split("\n");
  const kept: string[] = [];
  let skipping = false;
  let insertAt = -1;
  for (const line of lines) {
    const isHeader = belongs(line);
    if (isHeader !== null) {
      skipping = isHeader;
      if (isHeader && insertAt === -1) insertAt = kept.length;
    }
    if (!skipping) kept.push(line);
  }
  if (insertAt === -1) {
    const base = content.replace(/\s*$/, "");
    return base ? `${base}\n\n${block}\n` : `${block}\n`;
  }
  kept.splice(insertAt, 0, ...block.split("\n"), "");
  return `${kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s*$/, "")}\n`;
}
