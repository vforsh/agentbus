import type { Command } from "commander";
import pc from "picocolors";
import { spoolCounts } from "../../adapters/claude/spool.ts";
import { resolveCallerRef } from "../../services/caller.ts";
import { probeDelegations } from "../../services/probe.ts";
import { SYSTEM_OBSERVER_ID } from "../../store/db.ts";
import { getDelegation, openDelegationForWorker } from "../../store/delegations.ts";
import { observationsForSession } from "../../store/observations.ts";
import { requireAddress, resolveAddress, toSession } from "../../store/sessions.ts";
import { action } from "../action.ts";
import { drainBeforeRead } from "./messaging.ts";

export function registerStatus(program: Command): void {
  program
    .command("status [session]")
    .description("Mailbox counts and spool backlog; with a session, its latest observations")
    .option("--probe", "add live provider activity (runs provider subprocesses)")
    .action(
      action((ctx, target: string | undefined, opts: { probe?: boolean }) => {
        const db = ctx.db();
        drainBeforeRead(ctx, db);
        const count = (sql: string, ...p: string[]) => db.query<{ n: number }, string[]>(sql).get(...p)!.n;
        const totals = {
          sessions: count("SELECT count(*) AS n FROM sessions WHERE id <> ?", SYSTEM_OBSERVER_ID),
          pendingSessions: count("SELECT count(*) AS n FROM sessions WHERE external_id IS NULL"),
          messages: count("SELECT count(*) AS n FROM messages"),
          unacknowledged: count("SELECT count(*) AS n FROM receipts WHERE acknowledged_at IS NULL"),
          openDelegations: count("SELECT count(*) AS n FROM delegations WHERE state = 'open'"),
          observations: count("SELECT count(*) AS n FROM observations"),
        };
        const spool = spoolCounts(ctx.paths);
        const ref = resolveCallerRef(ctx.opts.as);
        const callerRow = ref ? resolveAddress(db, ref.address) : null;
        const caller = callerRow
          ? {
              sessionId: callerRow.id,
              unacknowledged: count(
                "SELECT count(*) AS n FROM receipts WHERE recipient_id = ? AND acknowledged_at IS NULL",
                callerRow.id,
              ),
              unseen: count(
                "SELECT count(*) AS n FROM receipts WHERE recipient_id = ? AND acknowledged_at IS NULL AND seen_at IS NULL",
                callerRow.id,
              ),
            }
          : null;
        let session: unknown = null;
        if (target) {
          const row = requireAddress(db, target, "session");
          const observations = observationsForSession(db, row.id, 20).map((o) => ({
            id: o.id,
            kind: o.kind,
            source: o.source,
            capturedAt: o.captured_at,
            turnRef: o.turn_ref,
            noticeId: o.notice_id,
            suppressedBy: o.suppressed_by,
            detail: JSON.parse(o.detail),
          }));
          const open = openDelegationForWorker(db, row.id);
          const probe =
            opts.probe && open
              ? probeDelegations(db, ctx.paths, [getDelegation(db, open.request_id)!], {
                  deadline: Date.now() + 15_000,
                })
              : null;
          session = {
            session: toSession(row),
            openDelegation: open?.request_id ?? null,
            observations,
            probe,
          };
        }
        const data = {
          stateDir: ctx.paths.stateDir,
          totals,
          spool,
          caller,
          ...(session ? { detail: session } : {}),
        };
        ctx.emit(
          data,
          () => {
            const lines = [
              `store       ${ctx.paths.dbPath}`,
              `sessions    ${totals.sessions} (${totals.pendingSessions} pending)`,
              `messages    ${totals.messages} (${totals.unacknowledged} unacknowledged)`,
              `delegations ${totals.openDelegations} open`,
              `spool       ${spool.backlog} pending, ${spool.quarantined} quarantined`,
            ];
            if (caller)
              lines.push(
                `caller      ${caller.sessionId}: ${caller.unseen} unseen, ${caller.unacknowledged} unacknowledged`,
              );
            if (session) lines.push("", pc.bold("session"), JSON.stringify(session, null, 2));
            return lines.join("\n");
          },
          () =>
            [
              totals.sessions,
              totals.messages,
              totals.unacknowledged,
              totals.openDelegations,
              spool.backlog,
            ].join("\t"),
        );
      }),
    );
}
