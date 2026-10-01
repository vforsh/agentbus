import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { inputError } from "../errors.ts";

const decoder = new TextDecoder("utf-8", { fatal: true });

/** Decodes bytes as strict UTF-8; malformed input is an input error, never silently replaced. */
export function decodeUtf8(bytes: Uint8Array, what: string): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw inputError("invalid_utf8", `${what} is not valid UTF-8`);
  }
}

/** Reads at most `limit` bytes from a file; larger input fails before decoding. */
export function readBoundedFile(path: string, limit: number, what: string): Uint8Array {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (err) {
    throw inputError("input_unreadable", `Cannot read ${what} from ${path}: ${(err as Error).message}`);
  }
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    const buf = new Uint8Array(64 * 1024);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      total += n;
      if (total > limit) {
        throw inputError("input_too_large", `${what} exceeds the ${limit}-byte limit`, { limit });
      }
      chunks.push(buf.slice(0, n));
    }
    return concat(chunks, total);
  } finally {
    closeSync(fd);
  }
}

/** Reads stdin up to `limit` bytes. */
export async function readBoundedStdin(limit: number, what: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of Bun.stdin.stream()) {
    total += chunk.byteLength;
    if (total > limit) {
      throw inputError("input_too_large", `${what} exceeds the ${limit}-byte limit`, { limit });
    }
    chunks.push(chunk);
  }
  return concat(chunks, total);
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Private directory, created recursively with mode 0700. */
export function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

/** Writes a private file atomically: temp file in the same directory, fsync, rename. */
export function writeFileAtomic(path: string, data: string | Uint8Array, mode = 0o600): void {
  const dir = dirname(path);
  ensurePrivateDir(dir);
  const tmp = join(dir, `.tmp-${process.pid}-${randomUUID()}`);
  const fd = openSync(tmp, "wx", mode);
  try {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    let offset = 0;
    while (offset < bytes.byteLength) offset += writeSync(fd, bytes, offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  try {
    const dfd = openSync(dir, "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    // Directory fsync is best effort on platforms that refuse it.
  }
}

export function fileExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

export function modeOf(path: string): number | null {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}
