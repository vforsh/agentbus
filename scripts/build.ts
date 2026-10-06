import { chmodSync } from "node:fs";
import { resolve } from "node:path";
import { type BuildInfo, checkoutBuildInfo, sourceHash } from "../src/build-info.ts";

export const ROOT = resolve(import.meta.dir, "..");

export function buildCandidate(outfile: string): BuildInfo {
  const info: BuildInfo = {
    ...checkoutBuildInfo(ROOT),
    compiled: true,
    builtAt: new Date().toISOString(),
  };
  const r = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "--compile",
      "--minify",
      "src/main.ts",
      "--outfile",
      outfile,
      "--define",
      `AGENTBUS_BUILD_INFO=${JSON.stringify(info)}`,
    ],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe", timeout: 120_000 },
  );
  if (r.exitCode !== 0) throw new Error(`Compilation failed: ${r.stderr.toString()}`);
  if (sourceHash(ROOT) !== info.sourceHash) throw new Error("Build inputs changed during compilation; retry");
  chmodSync(outfile, 0o700);
  return info;
}
