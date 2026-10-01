import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../harness.ts";

const stores: Store[] = [];
const fresh = (config: Record<string, unknown> = {}) => {
  const s = new Store(config);
  stores.push(s);
  return s;
};
afterAll(() => {
  for (const s of stores) s.cleanup();
});

describe("help, version and diagnostics", () => {
  test("help and version work from an empty directory without a mailbox", () => {
    const s = fresh();
    const help = s.run(["--help"], { json: false });
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("delegate");
    expect(s.run(["--version"], { json: false }).stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(s.run(["wait", "--help"], { json: false }).code).toBe(0);
    expect(existsSync(s.stateDir)).toBe(false);
  });

  test("usage errors exit 2 with a JSON error object", () => {
    const s = fresh();
    const r = s.run(["send"]);
    expect(r.code).toBe(2);
    expect(r.json?.ok).toBe(false);
    expect(r.json?.error.code).toBe("invalid_usage");
    expect(s.run(["read", "--json", "--plain"]).code).toBe(2);
  });

  test("commands refuse a missing store with a remediation hint", () => {
    const s = fresh();
    const r = s.run(["read"], { as: "generic:a" });
    expect(r.code).toBe(4);
    expect(r.json?.error.message).toContain("agentbus init");
    expect(existsSync(s.stateDir)).toBe(false);
  });

  test("doctor is read-only and reports missing state", () => {
    const s = fresh();
    const r = s.run(["doctor"]);
    expect(r.code).toBe(1);
    const checks = r.json?.data.checks as { name: string; status: string }[];
    expect(checks.find((c) => c.name === "store")?.status).toBe("fail");
    expect(existsSync(s.stateDir)).toBe(false);
    expect(existsSync(s.settingsPath)).toBe(false);
    s.init();
    const ok = s.run(["check"]);
    expect(ok.json?.data.checks.find((c: any) => c.name === "store").status).toBe("ok");
  });

  test("init is idempotent and creates private files", () => {
    const s = fresh();
    expect(s.ok(["init"]).created).toBe(true);
    const again = s.ok(["init"]);
    expect(again.created).toBe(false);
    expect(again.applied).toEqual([]);
    const { statSync } = require("node:fs");
    expect(statSync(s.stateDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(s.stateDir, "agentbus.sqlite3")).mode & 0o777).toBe(0o600);
    expect(s.sql("PRAGMA journal_mode")[0].journal_mode).toBe("delete");
  });

  test("completion scripts print to stdout", () => {
    const s = fresh();
    for (const shell of ["fish", "zsh", "bash"]) {
      const r = s.run(["completion", shell], { json: false });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("agentbus");
    }
    expect(s.run(["completion", "tcsh"]).code).toBe(2);
  });

  test("skill prints the repository URL", () => {
    expect(fresh().ok(["skill"]).url).toContain("github.com/vforsh/agentbus");
  });
});

describe("config", () => {
  test("set, get, unset, import and export round-trip; unknown keys are rejected", () => {
    const s = fresh();
    s.ok(["config", "set", "codexBin=/opt/codex", "claudeBin=/opt/claude"]);
    expect(s.ok(["cfg", "get", "codexBin", "claudeBin"])).toEqual({
      codexBin: "/opt/codex",
      claudeBin: "/opt/claude",
    });
    s.ok(["config", "set", "cliCommand", "-"], { input: "agentbus\n" });
    expect(s.ok(["config", "get", "cliCommand"]).cliCommand).toBe("agentbus");
    s.ok(["config", "unset", "cliCommand"]);
    expect(s.run(["config", "set", "nope=1"]).code).toBe(2);
    const exported = s.ok(["config", "export"]);
    expect(exported.codexBin).toBe("/opt/codex");
    s.ok(["config", "import"], { input: JSON.stringify({ codexBin: "/x/codex" }) });
    expect(s.ok(["config", "export"])).toEqual({ codexBin: "/x/codex" });
    expect(s.run(["config", "import"], { input: JSON.stringify({ bogus: true }) }).code).toBe(2);
    expect(s.ok(["config", "ls"]).configPath).toBe(s.configPath);
  });

  test("an invalid config file fails clearly", () => {
    const s = fresh();
    writeFileSync(s.configPath, JSON.stringify({ unknownKey: 1 }));
    const r = s.run(["config", "path"]);
    expect(r.code).toBe(1);
    expect(r.json?.error.code).toBe("config_invalid");
  });
});

describe("claude hook installation", () => {
  const existing = {
    model: "opus",
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "echo user-stop" }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo guard" }] }],
    },
  };

  test("dry-run writes nothing; install is idempotent and preserves unrelated entries", () => {
    const s = fresh();
    writeFileSync(s.settingsPath, JSON.stringify(existing, null, 2));
    const dry = s.ok(["hooks", "claude", "install", "--dry-run"]);
    expect(dry.changed).toBe(true);
    expect(JSON.parse(readFileSync(s.settingsPath, "utf8"))).toEqual(existing);
    expect(readdirSync(s.dir).filter((f) => f.includes("agentbus-backup"))).toHaveLength(0);

    const first = s.ok(["hooks", "claude", "install"]);
    expect(first.backupPath).toContain("agentbus-backup");
    expect(JSON.parse(readFileSync(first.backupPath, "utf8"))).toEqual(existing);
    const installed = JSON.parse(readFileSync(s.settingsPath, "utf8"));
    expect(installed.model).toBe("opus");
    expect(installed.hooks.PreToolUse).toEqual(existing.hooks.PreToolUse);
    expect(installed.hooks.Stop[0]).toEqual(existing.hooks.Stop[0]);
    expect(installed.hooks.Stop).toHaveLength(2);
    for (const e of [
      "SessionStart",
      "UserPromptSubmit",
      "PermissionRequest",
      "Stop",
      "StopFailure",
      "SessionEnd",
    ]) {
      const ours = installed.hooks[e]
        .flatMap((g: any) => g.hooks)
        .filter((h: any) => h.command.includes("agentbus-hook"));
      expect(ours).toHaveLength(1);
      expect(ours[0].command).toContain(`--state-dir ${s.stateDir}`);
    }
    expect(s.ok(["hooks", "claude", "install"]).changed).toBe(false);
    expect(s.ok(["hooks", "claude", "status"]).current).toBe(true);

    const removed = s.ok(["hooks", "claude", "uninstall"]);
    expect(removed.removed).toBe(6);
    expect(JSON.parse(readFileSync(s.settingsPath, "utf8"))).toEqual(existing);
    expect(s.run(["hooks", "claude", "status"]).code).toBe(1);
  });

  test("per-worker mode needs no user-level install; print can write a standalone file", () => {
    const s = fresh().init();
    const doctor = s.run(["doctor"]).json?.data.checks.find((c: any) => c.name === "claude_hooks");
    expect(doctor).toMatchObject({ status: "ok" });
    expect(doctor.message).toContain("per-worker");
    const file = join(s.dir, "worker-settings.json");
    s.ok(["hooks", "claude", "print", "--settings-file", file]);
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8")).hooks)).toHaveLength(6);
    expect(existsSync(s.settingsPath)).toBe(false);
  });

  test("malformed settings are left unchanged", () => {
    const s = fresh();
    writeFileSync(s.settingsPath, "{ not json");
    const r = s.run(["hooks", "claude", "install"]);
    expect(r.code).toBe(1);
    expect(readFileSync(s.settingsPath, "utf8")).toBe("{ not json");
  });

  test("the installed guard is a silent no-op when the binary is unavailable", () => {
    const s = fresh();
    const snippet = s.ok(["hooks", "claude", "print"]);
    const command: string = snippet.hooks.Stop[0].hooks[0].command;
    const missing = command.replaceAll(
      join(import.meta.dir, "../../bin/agentbus").replace(/\/tests\/integration\/\.\.\/\.\./, ""),
      "/Volumes/NotMounted/agentbus/bin/agentbus",
    );
    const broken = command
      .split(" ")
      .map((w) => (w.endsWith("bin/agentbus") ? "/Volumes/NotMounted/bin/agentbus" : w))
      .join(" ");
    for (const cmd of [missing, broken]) {
      const r = Bun.spawnSync(["sh", "-c", cmd], {
        stdin: Buffer.from("{}"),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout.toString()).toBe("");
    }
  });
});
