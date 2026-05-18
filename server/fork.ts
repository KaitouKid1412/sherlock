import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

// Claude Code stores transcripts under ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl.
// To fork mid-session we copy lines up to (and including) a target UUID into a
// new session file with a new sessionId, then resume Claude Code on the new
// session. Claude Code thereafter appends turns to the new file — which is
// exactly what we want for a branch.
const PROJECTS_BASE = path.join(os.homedir(), ".claude", "projects");

interface JsonlLine {
  uuid?: string;
  sessionId?: string;
  // We don't enumerate every field; we'll round-trip the rest unchanged.
  [k: string]: unknown;
}

async function findSessionFile(sessionId: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(PROJECTS_BASE);
  } catch {
    return null;
  }
  for (const dirName of entries) {
    const candidate = path.join(PROJECTS_BASE, dirName, sessionId + ".jsonl");
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* not in this dir */
    }
  }
  return null;
}

// Encode a cwd into Claude Code's project-dir name. Claude Code replaces
// `/` and space with `-` (and likely other non-word chars). We match that
// for the common cases — slashes and spaces are enough for darwin paths.
function encodeCwdAsProjectDir(cwd: string): string {
  return cwd.replace(/[\/\s]/g, "-");
}

function currentSherlockProjectDir(): string {
  return path.join(PROJECTS_BASE, encodeCwdAsProjectDir(process.cwd()));
}

export interface SnapshotResult {
  newSessionId: string;
  newPath: string;
}

// Walk the source .jsonl line by line; for each line, if it's a content
// message (user/assistant/attachment/system) with a uuid, include it. Stop
// AFTER we've written the line whose uuid === untilUuid. Non-content lines
// like queue-operation, ai-title, last-prompt have no uuid and are kept
// alongside the chain — they're metadata that Claude Code may want.
//
// Rewrites the `sessionId` field on every line so Claude Code's internal
// bookkeeping matches the new file name. The `parentUuid` chain is preserved
// verbatim.
export async function snapshotSession(
  sourceSessionId: string,
  untilUuid: string,
): Promise<SnapshotResult> {
  const sourcePath = await findSessionFile(sourceSessionId);
  if (!sourcePath) {
    throw new Error(`snapshotSession: no .jsonl found for session ${sourceSessionId}`);
  }
  const newSessionId = randomUUID();
  // Write the snapshot into Sherlock's current project dir (cwd-encoded),
  // not the source's. Claude Code looks up sessions in process.cwd()'s
  // project dir on --resume; placing the snapshot there means the fork is
  // discoverable regardless of where the source originally lived (could be
  // a legacy dev-checkout session, an installed-app session, etc.).
  const targetDir = currentSherlockProjectDir();
  await fs.mkdir(targetDir, { recursive: true });
  const newPath = path.join(targetDir, newSessionId + ".jsonl");

  const raw = await fs.readFile(sourcePath, "utf8");
  const lines = raw.split("\n");
  const outLines: string[] = [];
  let foundTarget = false;

  for (const line of lines) {
    if (line.length === 0) continue;
    let obj: JsonlLine;
    try {
      obj = JSON.parse(line) as JsonlLine;
    } catch {
      // Skip unparseable lines rather than aborting the fork.
      continue;
    }
    if (typeof obj.sessionId === "string") obj.sessionId = newSessionId;
    outLines.push(JSON.stringify(obj));
    if (typeof obj.uuid === "string" && obj.uuid === untilUuid) {
      foundTarget = true;
      break;
    }
  }
  if (!foundTarget) {
    throw new Error(`snapshotSession: untilUuid ${untilUuid} not found in ${sourceSessionId}`);
  }

  await fs.writeFile(newPath, outLines.join("\n") + "\n", "utf8");
  return { newSessionId, newPath };
}

// Read back the last-assistant UUID for a node's turn — used when we add a
// new child of an existing node and need to record where in the .jsonl
// that node's turn ends. The "tail UUID" of a turn is the uuid of its final
// assistant message before the next user prompt.
export async function findTurnTailUuid(
  sessionId: string,
  promptId: string,
): Promise<string | null> {
  const sourcePath = await findSessionFile(sessionId);
  if (!sourcePath) return null;
  const raw = await fs.readFile(sourcePath, "utf8");
  let inTurn = false;
  let lastAssistantUuid: string | null = null;
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    let obj: JsonlLine;
    try { obj = JSON.parse(line) as JsonlLine; } catch { continue; }
    if (obj.type === "user" && obj.promptId === promptId) {
      inTurn = true;
      lastAssistantUuid = null;
      continue;
    }
    if (inTurn && obj.type === "user" && obj.promptId !== promptId) {
      // Entered the next turn — stop.
      break;
    }
    if (inTurn && obj.type === "assistant" && typeof obj.uuid === "string") {
      lastAssistantUuid = obj.uuid;
    }
  }
  return lastAssistantUuid;
}

// Read the final assistant UUID of an entire session (for the case where we
// want to fork from the very end of the session, equivalent to --fork-session
// without specifying a parent UUID).
export async function findSessionTailUuid(sessionId: string): Promise<string | null> {
  const sourcePath = await findSessionFile(sessionId);
  if (!sourcePath) return null;
  const raw = await fs.readFile(sourcePath, "utf8");
  let last: string | null = null;
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    let obj: JsonlLine;
    try { obj = JSON.parse(line) as JsonlLine; } catch { continue; }
    if (obj.type === "assistant" && typeof obj.uuid === "string") last = obj.uuid;
  }
  return last;
}

export async function deleteSessionFile(sessionId: string): Promise<void> {
  const sourcePath = await findSessionFile(sessionId);
  if (!sourcePath) return;
  try {
    await fs.unlink(sourcePath);
  } catch {
    /* already gone */
  }
}
