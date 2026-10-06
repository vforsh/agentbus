import type { Command } from "commander";
import pc from "picocolors";
import { z } from "zod";
import { inputError, notFound, usageError } from "../../errors.ts";
import { PROVIDERS, type Provider } from "../../protocol/types.ts";
import { resolveCallerRef } from "../../services/caller.ts";
import { returnReadiness } from "../../services/returnpath.ts";
import { type InitResult, initStore, tx } from "../../store/db.ts";
import {
  bindSession,
  getSession,
  listSessions,
  parseLabels,
  registerSession,
  requireAddress,
  resolveAddress,
  toSession,
  validateExternalId,
} from "../../store/sessions.ts";
import { canonicalDir, nowIso, parseDuration } from "../../util/misc.ts";
import { action } from "../action.ts";
import { collect, readBody } from "../context.ts";
import { sessionLine } from "../render.ts";

const ReturnBindingSchema = z
  .object({
    strategy: z.enum(["heartbeat", "background_wait", "manual", "adapter"]),
    status: z.enum(["setup_required", "ready", "unsupported"]),
    handle: z.string().max(500).nullable().optional(),
    checkedAt: z.iso.datetime().optional(),
    /** Heartbeat cadence such as "5m"; a check-in stays fresh for three intervals (default 15m). */
    interval: z
      .string()
      .refine((v) => {
        try {
          return parseDuration(v, "interval") > 0;
        } catch {
          return false;
        }
      }, "interval must be a duration such as 5m")
      .optional(),
    reason: z.string().max(1000).optional(),
  })
  .strict();

const AdapterPatchSchema = z.record(z.string().max(64), z.unknown());

function initMessage(r: InitResult): string {
  if (r.created) return `Initialized mailbox at ${r.dbPath} (schema v${r.toVersion})`;
  if (r.applied.length > 0) return `Migrated mailbox ${r.dbPath} from v${r.fromVersion} to v${r.toVersion}`;
  return `Mailbox ${r.dbPath} is up to date (schema v${r.toVersion})`;
}

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("Create the state directory and mailbox schema, or migrate it forward (idempotent)")
    .action(
      action((ctx) => {
        const r = initStore(ctx.paths);
        ctx.emit(
          { ...r, stateDir: ctx.paths.stateDir },
          () => initMessage(r),
          () => [r.dbPath, String(r.toVersion)].join("\t"),
        );
      }),
    );
}

export function registerWhoami(program: Command): void {
  program
    .command("whoami")
    .description("Print the resolved caller address, its source and registration state")
    .action(
      action((ctx) => {
        const ref = resolveCallerRef(ctx.opts.as);
        let registered: ReturnType<typeof toSession> | null = null;
        let storeState = "ok";
        if (ref) {
          try {
            const row = resolveAddress(ctx.db(), ref.address);
            registered = row ? toSession(row) : null;
          } catch (err) {
            storeState = (err as { code?: string }).code ?? "unavailable";
          }
        }
        const data = {
          address: ref?.address ?? null,
          source: ref?.source ?? null,
          sourceDetail: ref?.detail ?? null,
          registered: !!registered,
          session: registered,
          store: storeState,
        };
        ctx.emit(
          data,
          () => {
            if (!ref) {
              return pc.yellow(
                "No caller identity: pass --as, set AGENTBUS_SESSION_ID, or run inside a Claude/Codex session",
              );
            }
            let state = pc.yellow(`store ${storeState}`);
            if (registered) state = pc.green(`registered as ${registered.id}`);
            else if (storeState === "ok") state = pc.yellow("not registered");
            return `${ref.address} ${pc.dim(`(from ${ref.detail})`)} ${state}`;
          },
          () => [ref?.address ?? "-", ref?.source ?? "-", registered?.id ?? "-"].join("\t"),
        );
      }),
    );
}

function parseProvider(value: string): Provider {
  if (!(PROVIDERS as readonly string[]).includes(value)) {
    throw usageError(`--provider must be one of ${PROVIDERS.join(", ")}`);
  }
  return value as Provider;
}

async function readJsonFile(path: string, what: string): Promise<unknown> {
  const text = await readBody(path, 64 * 1024, what);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw inputError("invalid_json", `${what} is not valid JSON: ${(err as Error).message}`);
  }
}

export function registerSessionCommands(program: Command): void {
  const session = program.command("session").description("Register, bind and inspect sessions");

  session
    .command("register")
    .description("Register a session (idempotent on provider and external ID)")
    .requiredOption("--provider <provider>", "codex, claude or generic")
    .option("--external-id <id>", "native session identifier (full UUID for codex/claude)")
    .option("--pending", "register a pending worker whose native ID is not known yet")
    .option("--cwd <dir>", "project directory (default: current directory)")
    .option("--name <name>", "display name")
    .option("--label <k=v>", "display label (repeatable, at most 16)", collect, [])
    .action(
      action(
        (
          ctx,
          opts: {
            provider: string;
            externalId?: string;
            pending?: boolean;
            cwd?: string;
            name?: string;
            label: string[];
          },
        ) => {
          const provider = parseProvider(opts.provider);
          if (!!opts.externalId === !!opts.pending)
            throw usageError("Pass exactly one of --external-id or --pending");
          if (opts.externalId) validateExternalId(provider, opts.externalId);
          const dir = canonicalDir(opts.cwd ?? process.cwd());
          const db = ctx.db();
          const { row, created } = tx(db, () =>
            registerSession(db, {
              provider,
              externalId: opts.externalId ?? null,
              name: opts.name ?? null,
              cwd: dir.display,
              cwdReal: dir.real,
              labels: parseLabels(opts.label),
            }),
          );
          const s = toSession(row);
          ctx.emit(
            { sessionId: s.id, address: s.address, created, session: s },
            () =>
              `${created ? "Registered" : "Already registered"} ${s.address ?? `${s.provider} (pending)`} as ${s.id}`,
            () => [s.id, s.address ?? "-"].join("\t"),
          );
        },
      ),
    );

  session
    .command("bind <session>")
    .description("Bind a pending session's native ID, or confirm an existing token claim")
    .requiredOption("--external-id <id>", "native session identifier")
    .option("--short-id <id>", "Claude CLI short handle printed by claude --bg")
    .option("--binding-file <path>", "JSON object merged into the adapter binding")
    .action(
      action(
        async (ctx, target: string, opts: { externalId: string; shortId?: string; bindingFile?: string }) => {
          const patch: Record<string, unknown> = opts.bindingFile
            ? (AdapterPatchSchema.parse(await readJsonFile(opts.bindingFile, "binding file")) as Record<
                string,
                unknown
              >)
            : {};
          if (opts.shortId) patch.shortId = opts.shortId;
          const db = ctx.db();
          const result = tx(db, () =>
            bindSession(db, requireAddress(db, target, "session"), opts.externalId, patch),
          );
          const s = toSession(result.row);
          ctx.emit(
            { sessionId: s.id, address: s.address, alreadyBound: result.alreadyBound, session: s },
            () => `${result.alreadyBound ? "Confirmed" : "Bound"} ${s.id} → ${s.address}`,
            () => [s.id, s.address ?? "-"].join("\t"),
          );
        },
      ),
    );

  session
    .command("list")
    .alias("ls")
    .description("List registered sessions (never probes providers)")
    .action(
      action((ctx) => {
        const sessions = listSessions(ctx.db()).map(toSession);
        ctx.emit(
          { sessions },
          () =>
            sessions.length === 0
              ? pc.dim("No sessions.")
              : sessions
                  .map((s) =>
                    `${s.id}  ${s.address ?? pc.yellow(`${s.provider}:pending`)}  ${s.name ?? ""}`.trimEnd(),
                  )
                  .join("\n"),
          () => sessions.map(sessionLine),
        );
      }),
    );

  session
    .command("show <session>")
    .description("Show one session's metadata")
    .action(
      action((ctx, target: string) => {
        const s = toSession(requireAddress(ctx.db(), target, "session"));
        ctx.emit(
          { session: s },
          () => JSON.stringify(s, null, 2),
          () => sessionLine(s),
        );
      }),
    );

  session
    .command("update <session>")
    .description("Update display metadata, labels or the return binding; identity is immutable")
    .option("--name <name>", "display name")
    .option("--label <k=v>", "set a label (repeatable)", collect, [])
    .option("--unset-label <key>", "remove a label (repeatable)", collect, [])
    .option(
      "--binding-file <path|->",
      "return binding JSON: {strategy, status, handle?, checkedAt?, interval?, reason?}",
    )
    .option("--refresh", "record a fresh check-in of the existing return binding (each heartbeat run)")
    .action(
      action(
        async (
          ctx,
          target: string,
          opts: {
            name?: string;
            label: string[];
            unsetLabel: string[];
            bindingFile?: string;
            refresh?: boolean;
          },
        ) => {
          if (opts.refresh && opts.bindingFile) throw usageError("Pass either --binding-file or --refresh");
          let returnBinding: z.infer<typeof ReturnBindingSchema> | undefined;
          if (opts.bindingFile) {
            const parsed = ReturnBindingSchema.safeParse(
              await readJsonFile(opts.bindingFile, "binding file"),
            );
            if (!parsed.success)
              throw inputError("invalid_binding", `Invalid return binding: ${z.prettifyError(parsed.error)}`);
            returnBinding = { ...parsed.data, checkedAt: parsed.data.checkedAt ?? nowIso() };
          }
          const db = ctx.db();
          const row = tx(db, () => {
            const s = requireAddress(db, target, "session");
            if (s.provider === "system") throw usageError("The system observer cannot be updated");
            const labels = parseLabels(opts.label, JSON.parse(s.labels));
            for (const k of opts.unsetLabel) delete labels[k];
            if (opts.refresh) {
              if (!s.return_binding)
                throw notFound(
                  "return_binding_not_found",
                  "No return binding to refresh; record one with --binding-file",
                );
              returnBinding = { ...JSON.parse(s.return_binding), checkedAt: nowIso() };
            }
            db.query(
              "UPDATE sessions SET name = ?, labels = ?, return_binding = ?, updated_at = ? WHERE id = ?",
            ).run(
              opts.name ?? s.name,
              JSON.stringify(labels),
              returnBinding ? JSON.stringify(returnBinding) : s.return_binding,
              nowIso(),
              s.id,
            );
            // Readiness is derived from this report and from live watchers when read (services/returnpath.ts);
            // delegation rows keep the status proposed when they opened.
            const updated = getSession(db, s.id);
            if (!updated) throw notFound("session_not_found", "Session disappeared during update");
            return updated;
          });
          const s = toSession(row);
          // As a parent: what a delegation opened now would report, from the evidence just recorded.
          const readiness = returnBinding ? returnReadiness(db, s.id, null) : null;
          ctx.emit(
            { session: s, ...(readiness ? { returnReadiness: readiness } : {}) },
            () =>
              readiness
                ? `Updated ${s.id}\nreturn  ${readiness.strategy} — ${readiness.status} (${readiness.readiness}): ${readiness.reason}`
                : `Updated ${s.id}`,
            () => sessionLine(s),
          );
        },
      ),
    );
}
