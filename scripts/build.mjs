import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsc = join(root, "node_modules", ".bin", "tsc");

rmSync(join(root, "dist"), { recursive: true, force: true });

for (const project of ["tsconfig.esm.json", "tsconfig.cjs.json"]) {
  execFileSync(tsc, ["-p", project], { cwd: root, stdio: "inherit" });
}

mkdirSync(join(root, "dist", "esm"), { recursive: true });
mkdirSync(join(root, "dist", "cjs"), { recursive: true });
writeFileSync(join(root, "dist", "esm", "package.json"), JSON.stringify({ type: "module" }, null, 2) + "\n");
writeFileSync(join(root, "dist", "cjs", "package.json"), JSON.stringify({ type: "commonjs" }, null, 2) + "\n");

console.log("built dist/esm and dist/cjs");
