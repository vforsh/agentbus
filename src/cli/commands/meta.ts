import type { Command, Option } from "commander";
import { buildInfo } from "../../build-info.ts";
import { usageError } from "../../errors.ts";
import { action } from "../action.ts";

export const SKILL_URL = "https://github.com/vforsh/agentbus/tree/main/skill/agentbus";

export function registerBuildInfo(program: Command): void {
  program
    .command("build-info")
    .description("Print build identity and supported mailbox schema")
    .action(
      action((ctx) => {
        const info = buildInfo();
        ctx.emit(
          info,
          () =>
            `${info.version} ${info.compiled ? "compiled" : "source"}\ncommit ${info.commit ?? "unknown"}${info.dirty ? " (dirty)" : ""}\nsource ${info.sourceHash}\nschema ${info.schemaVersion}\nbuilt  ${info.builtAt ?? "not compiled"}\nbun    ${info.bunVersion}`,
        );
      }),
    );
}

export function registerSkill(program: Command): void {
  program
    .command("skill")
    .description("Print the consumer skill installation URL")
    .action(
      action((ctx) => {
        ctx.emit(
          { url: SKILL_URL, install: `npx skills add ${SKILL_URL}` },
          () => SKILL_URL,
          () => SKILL_URL,
        );
      }),
    );
}

interface Node {
  path: string[];
  subcommands: string[];
  options: string[];
}

function walk(cmd: Command, path: string[], out: Node[]): void {
  const subs = cmd.commands.filter((c) => !(c as unknown as { _hidden?: boolean })._hidden);
  out.push({
    path,
    subcommands: subs.flatMap((c) => [c.name(), ...c.aliases()]),
    options: cmd.options.flatMap((o: Option) => [o.long, o.short].filter((x): x is string => !!x)),
  });
  for (const c of subs) walk(c, [...path, c.name()], out);
}

function fish(program: Command, nodes: Node[]): string {
  const name = program.name();
  const lines = [`# fish completion for ${name}`, `complete -c ${name} -f`];
  const globals = nodes[0]!.options;
  for (const opt of globals) if (opt.startsWith("--")) lines.push(`complete -c ${name} -l ${opt.slice(2)}`);
  for (const n of nodes) {
    const cond =
      n.path.length === 0
        ? "__fish_use_subcommand"
        : `__fish_seen_subcommand_from ${n.path[n.path.length - 1]}`;
    for (const s of n.subcommands) lines.push(`complete -c ${name} -n '${cond}' -a ${s}`);
    if (n.path.length > 0) {
      for (const opt of n.options)
        if (opt.startsWith("--")) lines.push(`complete -c ${name} -n '${cond}' -l ${opt.slice(2)}`);
    }
  }
  return lines.join("\n");
}

function bashLike(program: Command, nodes: Node[], shell: "bash" | "zsh"): string {
  const name = program.name();
  const fn = `_${name}_complete`;
  const cases = nodes
    .map((n) => `    "${n.path.join(" ")}") words="${[...n.subcommands, ...n.options].join(" ")}" ;;`)
    .join("\n");
  const body = `${fn}() {
  local cur path="" w words=""
  cur="\${COMP_WORDS[COMP_CWORD]}"
  for w in "\${COMP_WORDS[@]:1:COMP_CWORD-1}"; do
    case "$w" in -*) ;; *) path="\${path:+$path }$w" ;; esac
  done
  case "$path" in
${cases}
  esac
  COMPREPLY=( $(compgen -W "$words" -- "$cur") )
}
complete -F ${fn} ${name}`;
  return shell === "zsh" ? `#compdef ${name}\nautoload -U +X bashcompinit && bashcompinit\n${body}` : body;
}

export function registerCompletion(program: Command): void {
  program
    .command("completion <shell>")
    .description("Print a completion script for fish, zsh or bash to stdout")
    .action(
      action((_ctx, shell: string) => {
        const nodes: Node[] = [];
        walk(program, [], nodes);
        let script: string;
        if (shell === "fish") script = fish(program, nodes);
        else if (shell === "bash" || shell === "zsh") script = bashLike(program, nodes, shell);
        else throw usageError("Supported shells: fish, zsh, bash");
        process.stdout.write(`${script}\n`);
      }),
    );
}
