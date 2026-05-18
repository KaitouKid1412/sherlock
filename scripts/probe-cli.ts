/**
 * M0 probe — runs `claude` twice (bootstrap + --resume) and dumps every
 * stdout line verbatim to scripts/probe-output.jsonl so we can lock down
 * event shapes before writing the real stream-parser.
 *
 * Uses only Node built-ins so it can run before `npm install` completes.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.resolve(__dirname, "probe-output.jsonl");

function scrubbedEnv(): NodeJS.ProcessEnv {
  const allow = new Set(["PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "TERM"]);
  const out: NodeJS.ProcessEnv = {};
  for (const k of allow) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

interface RunResult {
  sessionIdFromInit: string | null;
  lineCount: number;
  exitCode: number | null;
}

async function runClaude(
  out: NodeJS.WritableStream,
  args: string[],
  label: string,
): Promise<RunResult> {
  out.write(`\n=== ${label} ===\n`);
  out.write(`# argv: ${JSON.stringify(args)}\n`);

  const child = spawn("claude", args, {
    env: scrubbedEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  const rl = createInterface({ input: child.stdout });
  let sessionIdFromInit: string | null = null;
  let lineCount = 0;

  rl.on("line", (line) => {
    lineCount += 1;
    out.write(line + "\n");
    if (sessionIdFromInit === null) {
      try {
        const obj = JSON.parse(line);
        if (obj?.type === "system" && obj?.subtype === "init" && typeof obj?.session_id === "string") {
          sessionIdFromInit = obj.session_id;
        }
      } catch {
        // not JSON — ignore for purposes of detection
      }
    }
  });

  let stderrBuf = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString("utf8");
  });

  const exitCode: number | null = await new Promise((resolve) => {
    child.on("close", (code) => resolve(code));
  });

  if (stderrBuf.length > 0) {
    out.write(`# STDERR (${stderrBuf.length} bytes):\n`);
    for (const line of stderrBuf.split("\n")) out.write(`# stderr> ${line}\n`);
  }
  out.write(`# exit: ${exitCode}, lines: ${lineCount}, session_id from init: ${sessionIdFromInit ?? "(none)"}\n`);
  return { sessionIdFromInit, lineCount, exitCode };
}

async function main() {
  const out = createWriteStream(OUTPUT_PATH, { flags: "w" });
  out.write(`# probe-cli — ${new Date().toISOString()}\n`);
  out.write(`# claude binary: ${process.env.PATH}\n`);

  const baseFlags = [
    "-p",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    "WebSearch,WebFetch",
    "--model",
    "claude-opus-4-7",
  ];

  // Bootstrap turn — supply our own session-id so we know it without waiting.
  const seedId = randomUUID();
  out.write(`# seedSessionId we passed via --session-id: ${seedId}\n`);

  const r1 = await runClaude(
    out,
    [
      ...baseFlags,
      "--session-id",
      seedId,
      "Reply with exactly the three words: alpha bravo charlie. Nothing else.",
    ],
    "TURN 1 (bootstrap)",
  );

  // Some CLIs return a *different* session_id from init than the one passed
  // via --session-id; we capture both so we know which to use for --resume.
  const resumeId = r1.sessionIdFromInit ?? seedId;
  out.write(`# resuming with: ${resumeId}\n`);

  const r2 = await runClaude(
    out,
    [
      ...baseFlags,
      "--resume",
      resumeId,
      "What were the three words you said? Reply with exactly those three words, nothing else.",
    ],
    "TURN 2 (--resume)",
  );

  out.write(`\n# DONE. seed=${seedId} init1=${r1.sessionIdFromInit} init2=${r2.sessionIdFromInit}\n`);
  out.end();

  // Read it back to print a tiny summary to stdout.
  const fh = await open(OUTPUT_PATH, "r");
  const text = await fh.readFile({ encoding: "utf8" });
  await fh.close();
  const lines = text.split("\n").length;
  console.log(`Wrote ${lines} lines to ${OUTPUT_PATH}`);
  console.log(`Turn 1: exit=${r1.exitCode}, stdout-lines=${r1.lineCount}, init session_id=${r1.sessionIdFromInit}`);
  console.log(`Turn 2: exit=${r2.exitCode}, stdout-lines=${r2.lineCount}, init session_id=${r2.sessionIdFromInit}`);
}

main().catch((err) => {
  console.error("probe failed:", err);
  process.exit(1);
});
