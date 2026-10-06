import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { SCHEMA_VERSION } from "./store/db.ts";

export interface BuildInfo {
  version: string;
  schemaVersion: number;
  compiled: boolean;
  commit: string | null;
  dirty: boolean | null;
  sourceHash: string;
  sourceRoot: string;
  builtAt: string | null;
  bunVersion: string;
}

declare const AGENTBUS_BUILD_INFO: BuildInfo | undefined;

// Include all executable inputs, including untracked source files and dependency/build configuration.
const INPUTS = ["src", "scripts", "package.json", "bun.lock", "tsconfig.json"];

export function sourceHash(root: string): string {
  const hash = createHash("sha256");
  const add = (relative: string) => {
    const path = join(root, relative);
    const entries = readdirSync(path, { withFileTypes: true });
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const name = `${relative}/${e.name}`;
      if (e.isDirectory()) add(name);
      else if (e.isFile()) file(name);
      else throw new Error(`Build input must be a regular file or directory: ${name}`);
    }
  };
  const file = (relative: string) => {
    const bytes = readFileSync(join(root, relative));
    hash.update(`${relative}\0${bytes.length}\0`).update(bytes);
  };
  for (const name of INPUTS) {
    if (name === "src" || name === "scripts") add(name);
    else file(name);
  }
  return hash.digest("hex");
}

function git(root: string, args: string[]): string | null {
  try {
    const r = Bun.spawnSync(["git", "-C", root, ...args], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: 3000,
    });
    return r.exitCode === 0 ? r.stdout.toString().trim() : null;
  } catch {
    return null;
  }
}

export function checkoutBuildInfo(root = resolve(import.meta.dir, "..")): BuildInfo {
  const status = git(root, ["status", "--porcelain", "--untracked-files=normal"]);
  return {
    version: pkg.version,
    schemaVersion: SCHEMA_VERSION,
    compiled: false,
    commit: git(root, ["rev-parse", "HEAD"]),
    dirty: status === null ? null : status.length > 0,
    sourceHash: sourceHash(root),
    sourceRoot: root,
    builtAt: null,
    bunVersion: Bun.version,
  };
}

export function buildInfo(): BuildInfo {
  return typeof AGENTBUS_BUILD_INFO !== "undefined" && AGENTBUS_BUILD_INFO
    ? AGENTBUS_BUILD_INFO
    : checkoutBuildInfo();
}

export function sourceFreshness(info: BuildInfo): "current" | "stale" | "unavailable" {
  if (!existsSync(join(info.sourceRoot, "src"))) return "unavailable";
  try {
    return sourceHash(info.sourceRoot) === info.sourceHash ? "current" : "stale";
  } catch {
    return "unavailable";
  }
}

/** Query the executable itself: a sidecar can become detached from the actual binary. */
export function executableBuildInfo(path: string): BuildInfo | null {
  try {
    const r = Bun.spawnSync([path, "build-info", "--json"], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: 5000,
    });
    if (r.exitCode !== 0) return null;
    const receipt = JSON.parse(r.stdout.toString());
    const info = receipt?.data;
    return receipt.ok &&
      info?.compiled === true &&
      /^[a-f0-9]{64}$/.test(info.sourceHash) &&
      Number.isSafeInteger(info.schemaVersion) &&
      typeof info.sourceRoot === "string"
      ? (info as BuildInfo)
      : null;
  } catch {
    return null;
  }
}
