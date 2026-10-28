export type IntervalState = "measured" | "pending" | "missing" | "settled" | "invalid" | "unobserved";
export interface Interval {
  state: IntervalState;
  ms: number | null;
}

export const absent = (state: Exclude<IntervalState, "measured">): Interval => ({ state, ms: null });

export function interval(start: string | null, end: string | null): Interval {
  if (!start) return absent("missing");
  const from = Date.parse(start);
  if (!Number.isFinite(from)) return absent("invalid");
  if (!end) return absent("pending");
  const ms = Date.parse(end) - from;
  return !Number.isFinite(ms) || ms < 0 ? absent("invalid") : { state: "measured", ms };
}

export function distribution(points: Interval[]) {
  const counts = { measured: 0, pending: 0, missing: 0, settled: 0, invalid: 0, unobserved: 0 };
  const values: number[] = [];
  for (const point of points) {
    counts[point.state]++;
    if (point.ms !== null) values.push(point.ms);
  }
  values.sort((a, b) => a - b);
  // Linear interpolation (R-7): the median is the midpoint for an even sample count.
  const percentile = (p: number): number | null => {
    if (values.length === 0) return null;
    const index = (values.length - 1) * p;
    const lower = Math.floor(index);
    return values[lower]! + (values[Math.ceil(index)]! - values[lower]!) * (index - lower);
  };
  return {
    ...counts,
    minMs: values[0] ?? null,
    maxMs: values.at(-1) ?? null,
    meanMs: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
    p50Ms: percentile(0.5),
    p90Ms: percentile(0.9),
    p95Ms: percentile(0.95),
  };
}
