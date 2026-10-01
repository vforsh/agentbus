// Ctrl-C handling: cleanups registered by long-running commands run before the process exits with 130.

const cleanups = new Set<() => void>();

export function onInterrupt(fn: () => void): () => void {
  cleanups.add(fn);
  return () => cleanups.delete(fn);
}

export function runInterruptCleanups(): void {
  for (const fn of cleanups) {
    try {
      fn();
    } catch {}
  }
  cleanups.clear();
}
