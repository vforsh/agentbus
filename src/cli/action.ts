import type { Command } from "commander";
import { Ctx } from "./context.ts";

/** Wraps a command action: builds the context from global options and always closes the store. */
export function action<A extends unknown[]>(fn: (ctx: Ctx, ...args: A) => Promise<void> | void) {
  return async (...args: unknown[]): Promise<void> => {
    const cmd = args[args.length - 1] as Command;
    const ctx = Ctx.from(cmd);
    try {
      await fn(ctx, ...(args.slice(0, -1) as A));
    } finally {
      ctx.close();
    }
    if (ctx.exitCode) process.exitCode = ctx.exitCode;
  };
}
