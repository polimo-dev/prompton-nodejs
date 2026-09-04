import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "prompton-install-"));
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const spec = `git+file://${root}#${head}`;

const probe = `import { PromptOn } from "prompton-sdk";
import { createRequire } from "node:module";

const required = createRequire(import.meta.url)("prompton-sdk");
if (typeof PromptOn !== "function") throw new Error("the ESM entry point exports no PromptOn");
if (typeof required.PromptOn !== "function") throw new Error("the CJS entry point exports no PromptOn");
if (PromptOn.version !== required.PromptOn.version) throw new Error("ESM and CJS disagree on the version");
console.log("installed from git and imported: prompton-sdk " + PromptOn.version + " (esm + cjs)");
`;

try {
  writeFileSync(
    join(scratch, "package.json"),
    JSON.stringify({ name: "prompton-install-check", private: true, version: "0.0.0" }, null, 2) + "\n",
  );
  writeFileSync(join(scratch, "probe.mjs"), probe);
  console.log(`installing ${spec}`);
  execFileSync("npm", ["install", "--no-audit", "--no-fund", spec], {
    cwd: scratch,
    stdio: "inherit",
  });
  execFileSync(process.execPath, ["probe.mjs"], { cwd: scratch, stdio: "inherit" });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
