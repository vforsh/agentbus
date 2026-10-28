import { usageError } from "../errors.ts";
import { PROVIDERS } from "../protocol/types.ts";
import { parseLabels } from "../store/sessions.ts";
import { parseDuration, realOrSelf } from "../util/misc.ts";

export interface MetricsOptions {
  since?: string;
  until?: string;
  project?: string;
  direction?: string;
  model?: string;
  label?: string[];
  groupBy?: string;
}

export interface MetricsFilter {
  since: string | null;
  until: string | null;
  project: string | null;
  direction: string | null;
  labels: Record<string, string>;
  groupBy: string | null;
}

/** Date-only bounds are UTC; timestamps must name an offset so reports do not depend on host timezone. */
function timestamp(value: string, flag: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2}))?$/.exec(
    value,
  );
  const date = match?.[1];
  const ms = Date.parse(value);
  if (
    !date ||
    !Number.isFinite(ms) ||
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date ||
    (match[2] !== undefined && (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59))
  )
    throw usageError(`${flag} must be YYYY-MM-DD (UTC) or an ISO timestamp with a timezone`, { value });
  return new Date(ms).toISOString();
}

function sinceTimestamp(value: string | undefined, now: number): string | null {
  if (value === undefined) return null;
  if (!/^\d+(ms|s|m|h|d)$/.test(value)) return timestamp(value, "--since");
  const at = new Date(now - parseDuration(value, "--since"));
  if (!Number.isFinite(at.getTime()))
    throw usageError("--since lookback is outside the supported date range");
  return at.toISOString();
}

export function metricsFilter(opts: MetricsOptions, now = Date.now()): MetricsFilter {
  const since = sinceTimestamp(opts.since, now);
  const until = opts.until !== undefined ? timestamp(opts.until, "--until") : null;
  if (since && until && since >= until) throw usageError("--since must be earlier than --until");
  const direction = opts.direction ?? null;
  if (direction !== null && !PROVIDERS.some((p) => PROVIDERS.some((w) => direction === `${p}:${w}`)))
    throw usageError("--direction must be parent:worker, e.g. claude:codex");
  let labels = parseLabels(opts.label ?? []);
  if (opts.model !== undefined) {
    if (labels.model !== undefined && labels.model !== opts.model)
      throw usageError("--model conflicts with --label model=...");
    labels = parseLabels([`model=${opts.model}`], labels);
  }
  const groupBy = opts.groupBy ?? null;
  if (
    groupBy !== null &&
    !["project", "direction", "model"].includes(groupBy) &&
    !/^label:[A-Za-z0-9_.-]{1,64}$/.test(groupBy)
  )
    throw usageError("--group-by must be project, direction, model or label:<key>");
  if (opts.project === "") throw usageError("--project must be a directory path");
  return {
    since,
    until,
    project: opts.project ? realOrSelf(opts.project) : null,
    direction,
    labels,
    groupBy,
  };
}

/** Reused by every query: bounds select a delegation cohort, never unrelated message activity. */
export function metricsSelection(parentId: string | null, f: MetricsFilter) {
  const params: Record<string, string | null> = { parent: parentId };
  const where = ["($parent IS NULL OR d.parent_id = $parent)"];
  if (f.since) {
    where.push("d.opened_at >= $since");
    params.since = f.since;
  }
  if (f.until) {
    where.push("d.opened_at < $until");
    params.until = f.until;
  }
  if (f.project) {
    // Path boundaries, not LIKE: project names may themselves contain SQL wildcard characters.
    where.push("(w.cwd_real = $project OR substr(w.cwd_real, 1, length($prefix)) = $prefix)");
    params.project = f.project;
    params.prefix = f.project.endsWith("/") ? f.project : `${f.project}/`;
  }
  if (f.direction) {
    where.push("p.provider || ':' || w.provider = $direction");
    params.direction = f.direction;
  }
  for (const [i, [key, value]] of Object.entries(f.labels).entries()) {
    where.push(
      `EXISTS (SELECT 1 FROM json_each(w.labels) label WHERE label.key = $key${i} AND label.value = $value${i})`,
    );
    params[`key${i}`] = key;
    params[`value${i}`] = value;
  }
  const cte = `WITH selected AS (
    SELECT d.*, w.cwd_real AS project, p.provider || ':' || w.provider AS direction, w.labels
    FROM delegations d JOIN sessions p ON p.id = d.parent_id JOIN sessions w ON w.id = d.worker_id
    WHERE ${where.join(" AND ")}
  )`;
  return { cte, params, filtered: where.length > 1 };
}
