import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { installedBinPath, resolvePaths } from "../src/config/config.ts";
import { ensurePrivateDir } from "../src/util/fsx.ts";
import { buildCandidate } from "./build.ts";
import { smoke } from "./smoke.ts";
import { installCandidate } from "./upgrade.ts";

async function main() {
  process.umask(0o077);
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: { "state-dir": { type: "string" }, config: { type: "string" } },
  });
  const mode = positionals[0];
  if (positionals.length !== 1 || (mode !== "check" && mode !== "upgrade"))
    throw new Error("Usage: bun scripts/release.ts <check|upgrade> [--state-dir DIR] [--config FILE]");
  const target = installedBinPath();
  const parent = mode === "upgrade" ? dirname(target) : tmpdir();
  ensurePrivateDir(parent);
  const stage = mkdtempSync(join(parent, ".agentbus-release-"));
  try {
    const candidate = join(stage, "agentbus");
    process.stderr.write("Building standalone candidate…\n");
    const info = buildCandidate(candidate);
    process.stderr.write("Checking compiled delegation, worker wrapper, hooks and migrations…\n");
    smoke(candidate);
    if (mode === "check") {
      console.log(JSON.stringify({ ok: true, build: info }));
      return;
    }
    const paths = resolvePaths({ stateDir: values["state-dir"], config: values.config });
    process.stderr.write("Checking offline upgrade eligibility and installing…\n");
    console.log(JSON.stringify({ ok: true, ...installCandidate(candidate, target, paths) }));
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exitCode = 1;
});
