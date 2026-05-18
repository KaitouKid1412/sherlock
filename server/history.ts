import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { listTreeFiles, loadTree } from "./tree.ts";

const PROJECTS_BASE = path.join(os.homedir(), ".claude", "projects");

// Claude Code encodes cwd by replacing `/` AND space (and likely other
// non-word chars) with `-`, but we don't need to match it exactly: we just
// scan for any project dir whose last segment is `sherlock` (case-insensitive)
// and treat them all as Sherlock's history. That handles both:
//   - the dev checkout    (/Users/x/sherlock          → -Users-x-sherlock)
//   - the installed .app  (/Users/x/Library/Application Support/Sherlock
//                          → -Users-x-Library-Application-Support-Sherlock)
// plus any future install path the user might use.
async function findSherlockProjectDirs(): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(PROJECTS_BASE);
  } catch {
    return [];
  }
  return entries
    .filter((name) => {
      const segments = name.split("-").filter(Boolean);
      const last = segments[segments.length - 1] ?? "";
      return last.toLowerCase() === "sherlock";
    })
    .map((name) => path.join(PROJECTS_BASE, name));
}

export interface HistoryEntry {
  sessionId: string;
  title: string;
  lastModifiedAt: number;
  turnCount: number;
  byteSize: number;
}

export interface LoadedTurn {
  prompt: string;
  text: string;
  toolCalls: Array<{ toolName: string; toolUseId: string; partialJson: string; blockIndex: number }>;
  // UUID of the last assistant message in this turn. Used as a fork point
  // when a legacy linear conversation gets branched: we snapshot the .jsonl
  // up to and including this uuid into a new session.
  lastClaudeUuid?: string;
}

export interface LoadedSession {
  sessionId: string;
  turns: LoadedTurn[];
}

interface RawLine {
  type?: string;
  isSidechain?: boolean;
  aiTitle?: string;
  sessionId?: string;
  uuid?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

async function readEntriesFromDir(dir: string): Promise<HistoryEntry[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const results: HistoryEntry[] = [];
  for (const f of entries) {
    if (!f.endsWith(".jsonl")) continue;
    const sessionId = f.replace(/\.jsonl$/, "");
    const fullPath = path.join(dir, f);
    let stat;
    try {
      stat = await fs.stat(fullPath);
    } catch {
      continue;
    }

    let title: string | null = null;
    let firstUserMessage: string | null = null;
    let turnCount = 0;

    try {
      const text = await fs.readFile(fullPath, "utf8");
      for (const line of text.split("\n")) {
        if (line.length === 0) continue;
        let obj: RawLine;
        try {
          obj = JSON.parse(line) as RawLine;
        } catch {
          continue;
        }
        if (obj.type === "ai-title" && typeof obj.aiTitle === "string") {
          title = obj.aiTitle;
        }
        if (obj.type === "user" && obj.isSidechain === false) {
          if (typeof obj.message?.content === "string") {
            const msg = obj.message.content;
            if (firstUserMessage === null) firstUserMessage = msg;
            turnCount += 1;
          }
        }
      }
    } catch {
      /* skip unreadable */
    }

    if (turnCount === 0) continue;
    const finalTitle = title ?? (firstUserMessage ? firstUserMessage.slice(0, 80) : "(untitled)");
    results.push({
      sessionId,
      title: finalTitle,
      lastModifiedAt: stat.mtimeMs,
      turnCount,
      byteSize: stat.size,
    });
  }
  return results;
}

// Walk every tree.json to map: sessionId → its role (root or fork). Forks
// are .jsonl files Sherlock created when branching; they're meaningful only
// within their tree and should NOT appear as standalone conversations in
// history. Roots are still listed (one per conversation) so trees show up.
async function buildSessionRoleMap(): Promise<{
  roots: Set<string>;
  forks: Set<string>;
  nodeCountByRoot: Map<string, number>;
}> {
  const roots = new Set<string>();
  const forks = new Set<string>();
  const nodeCountByRoot = new Map<string, number>();
  const treeFiles = await listTreeFiles();
  for (const f of treeFiles) {
    const rootSessionId = f.replace(/\.json$/, "");
    const tree = await loadTree(rootSessionId);
    if (!tree) continue;
    roots.add(tree.rootSessionId);
    nodeCountByRoot.set(tree.rootSessionId, Object.keys(tree.nodes).length);
    for (const node of Object.values(tree.nodes)) {
      if (node.sessionId !== tree.rootSessionId) forks.add(node.sessionId);
    }
  }
  return { roots, forks, nodeCountByRoot };
}

export async function listHistory(_cwd: string): Promise<HistoryEntry[]> {
  // _cwd is ignored — we scan ALL Sherlock project dirs and merge so the
  // sidebar shows history regardless of which cwd Sherlock was launched in.
  const [dirs, { forks, nodeCountByRoot }] = await Promise.all([
    findSherlockProjectDirs(),
    buildSessionRoleMap(),
  ]);
  const perDir = await Promise.all(dirs.map(readEntriesFromDir));
  const all: HistoryEntry[] = [];
  const seen = new Set<string>();
  for (const list of perDir) {
    for (const entry of list) {
      if (seen.has(entry.sessionId)) continue;
      // Hide fork sessions: they're internal to a tree, not standalone.
      if (forks.has(entry.sessionId)) continue;
      seen.add(entry.sessionId);
      // For sessions that are tree roots, prefer the tree's node count
      // over the .jsonl's turn count (the .jsonl only has THIS path's turns;
      // the tree may have more across forks).
      const treeNodeCount = nodeCountByRoot.get(entry.sessionId);
      if (treeNodeCount !== undefined) entry.turnCount = treeNodeCount;
      all.push(entry);
    }
  }
  all.sort((a, b) => b.lastModifiedAt - a.lastModifiedAt);
  return all;
}


export async function loadSession(_cwd: string, sessionId: string): Promise<LoadedSession | null> {
  // Search every Sherlock project dir for this sessionId.
  const dirs = await findSherlockProjectDirs();
  for (const dir of dirs) {
    const fullPath = path.join(dir, sessionId + ".jsonl");
    let raw: string;
    try {
      raw = await fs.readFile(fullPath, "utf8");
    } catch {
      continue;
    }
    return parseSessionJsonl(sessionId, raw);
  }
  return null;
}

function parseSessionJsonl(sessionId: string, raw: string): LoadedSession {
  // Build (user → all-following-assistants-until-next-user) groups.
  // Claude Code emits multiple assistant entries per turn when extended
  // thinking or tool-use is involved; we concatenate them all so the
  // final visible text is recovered.
  const turns: LoadedTurn[] = [];
  let current: LoadedTurn | null = null;
  let toolBlockSeq = 0;

  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    let obj: RawLine;
    try {
      obj = JSON.parse(line) as RawLine;
    } catch {
      continue;
    }
    if (obj.isSidechain) continue;

    if (obj.type === "user") {
      const c = obj.message?.content;
      if (typeof c === "string") {
        if (current !== null) turns.push(current);
        current = { prompt: c, text: "", toolCalls: [] };
        toolBlockSeq = 0;
      }
      // Array content on user messages = tool_result blocks; not a new prompt.
      continue;
    }

    if (obj.type === "assistant" && current !== null && Array.isArray(obj.message?.content)) {
      const blocks = obj.message!.content as Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }>;
      for (const b of blocks) {
        if (b.type === "text" && typeof b.text === "string") {
          current.text += b.text;
        } else if (b.type === "tool_use") {
          current.toolCalls.push({
            toolName: b.name ?? "(unknown)",
            toolUseId: b.id ?? "",
            partialJson: b.input ? JSON.stringify(b.input) : "",
            blockIndex: toolBlockSeq++,
          });
        }
        // thinking blocks: ignored on purpose — internal reasoning, not shown.
      }
      // Record this assistant message's uuid as the running "tail" of the
      // current turn. The last one wins, which is what we want: the final
      // assistant message before the next user prompt.
      if (typeof obj.uuid === "string") current.lastClaudeUuid = obj.uuid;
    }
  }
  if (current !== null) turns.push(current);
  return { sessionId, turns };
}
