/**
 * `tsc` only emits JavaScript, so the hand-written client in `src/ui` is copied
 * into `dist/ui` here. The HTTP layer probes both source and build layouts, so
 * this step exists to make `dist/` shippable on its own.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "src", "ui");
const target = join(root, "dist", "ui");

mkdirSync(target, { recursive: true });
const files = readdirSync(source).filter((name) => name.endsWith(".html") || name.endsWith(".css") || name.endsWith(".js") || name.endsWith(".svg") || name.endsWith(".webmanifest"));
for (const file of files) {
  copyFileSync(join(source, file), join(target, file));
}
console.log(`copied ${files.length} UI asset${files.length === 1 ? "" : "s"} to ${existsSync(target) ? "dist/ui" : target}`);
