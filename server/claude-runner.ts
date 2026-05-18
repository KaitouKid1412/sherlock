import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

const SCRUB_ALLOW = ["PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "TERM"];

function scrubbedEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of SCRUB_ALLOW) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export interface SpawnArgs {
  prompt: string;
  bootstrap?: { sessionId: string };
  resume?: { sessionId: string };
  model?: string;
  allowedTools?: string[];
}

type ClaudeChild = ChildProcessByStdio<null, Readable, Readable>;

export interface RunningClaude {
  child: ClaudeChild;
  onLine: (handler: (line: string) => void) => void;
  onClose: (handler: (code: number | null) => void) => void;
  kill: (signal?: NodeJS.Signals) => void;
}

export function spawnClaude(args: SpawnArgs): RunningClaude {
  const cli: string[] = [
    "-p",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--permission-mode", "dontAsk",
    "--allowedTools", (args.allowedTools ?? ["WebSearch", "WebFetch"]).join(","),
    "--model", args.model ?? "claude-opus-4-7",
  ];
  if (args.bootstrap && args.resume) {
    throw new Error("spawnClaude: pass either bootstrap or resume, not both");
  }
  if (args.bootstrap) {
    cli.push("--session-id", args.bootstrap.sessionId);
  } else if (args.resume) {
    cli.push("--resume", args.resume.sessionId);
  } else {
    throw new Error("spawnClaude: must pass bootstrap or resume");
  }
  cli.push(args.prompt);

  const child = spawn("claude", cli, {
    env: scrubbedEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  const lineHandlers: Array<(line: string) => void> = [];
  const closeHandlers: Array<(code: number | null) => void> = [];

  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    for (const h of lineHandlers) h(line);
  });
  child.on("close", (code) => {
    for (const h of closeHandlers) h(code);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    process.stderr.write(`[claude stderr] ${chunk.toString("utf8")}`);
  });

  return {
    child,
    onLine: (h) => { lineHandlers.push(h); },
    onClose: (h) => { closeHandlers.push(h); },
    kill: (sig: NodeJS.Signals = "SIGTERM") => { child.kill(sig); },
  };
}
