import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const src = "src/renderer";
const out = "dist/renderer";
mkdirSync(out, { recursive: true });
for (const name of readdirSync(src)) {
  if (name.endsWith(".html") || name.endsWith(".css")) {
    cpSync(join(src, name), join(out, name));
  }
}
