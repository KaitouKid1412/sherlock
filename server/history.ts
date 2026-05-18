import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

function encodeCwdToProjectDir(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

function projectDir(cwd: string): string {
  return path.join(os.homedir(), ".claude", "projects", encodeCwdToProjectDir(cwd));
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
  message?: {
    role?: string;
    content?: unknown;
  };
}

export async function listHistory(cwd: string): Promise<HistoryEntry[]> {
  const dir = projectDir(cwd);
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
  results.sort((a, b) => b.lastModifiedAt - a.lastModifiedAt);
  return results;
}

export async function loadSession(cwd: string, sessionId: string): Promise<LoadedSession | null> {
  const dir = projectDir(cwd);
  const fullPath = path.join(dir, sessionId + ".jsonl");
  let raw: string;
  try {
    raw = await fs.readFile(fullPath, "utf8");
  } catch {
    return null;
  }

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
    }
  }
  if (current !== null) turns.push(current);
  return { sessionId, turns };
}
