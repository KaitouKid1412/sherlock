import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { ConversationTreePublic, TreeNodePublic, TurnStatus } from "../types/events.ts";

// Where Sherlock's tree metadata lives. One file per conversation, named by
// the root node's session id. Claude Code's .jsonl files stay untouched in
// ~/.claude/projects/; we only own the tree shape on top.
const TREES_DIR = path.join(os.homedir(), "Library", "Application Support", "Sherlock", "trees");

async function ensureTreesDir(): Promise<void> {
  await fs.mkdir(TREES_DIR, { recursive: true });
}

function treePath(rootSessionId: string): string {
  return path.join(TREES_DIR, rootSessionId + ".json");
}

export async function loadTree(rootSessionId: string): Promise<ConversationTreePublic | null> {
  try {
    const raw = await fs.readFile(treePath(rootSessionId), "utf8");
    return JSON.parse(raw) as ConversationTreePublic;
  } catch {
    return null;
  }
}

export async function saveTree(tree: ConversationTreePublic): Promise<void> {
  await ensureTreesDir();
  // Atomic write: tmp + rename, so a crash mid-write doesn't corrupt the file.
  const target = treePath(tree.rootSessionId);
  const tmp = target + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(tree, null, 2), "utf8");
  await fs.rename(tmp, target);
}

export function createTree(rootSessionId: string, rootPrompt: string): ConversationTreePublic {
  const rootNodeId = randomUUID();
  const root: TreeNodePublic = {
    nodeId: rootNodeId,
    parentNodeId: null,
    sessionId: rootSessionId,
    claudeUuid: "",
    prompt: rootPrompt,
    text: "",
    status: "streaming",
    createdAt: Date.now(),
  };
  return {
    version: 1,
    rootSessionId,
    rootNodeId,
    nodes: { [rootNodeId]: root },
  };
}

export function addNode(
  tree: ConversationTreePublic,
  parentNodeId: string,
  sessionId: string,
  prompt: string,
): TreeNodePublic {
  const parent = tree.nodes[parentNodeId];
  if (!parent) throw new Error(`addNode: parent ${parentNodeId} not in tree`);
  const node: TreeNodePublic = {
    nodeId: randomUUID(),
    parentNodeId,
    sessionId,
    claudeUuid: "",
    prompt,
    text: "",
    status: "streaming",
    createdAt: Date.now(),
  };
  tree.nodes[node.nodeId] = node;
  return node;
}

export function getChildren(tree: ConversationTreePublic, nodeId: string): TreeNodePublic[] {
  return Object.values(tree.nodes)
    .filter((n) => n.parentNodeId === nodeId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function getPath(tree: ConversationTreePublic, nodeId: string): TreeNodePublic[] {
  const path: TreeNodePublic[] = [];
  let cur: TreeNodePublic | undefined = tree.nodes[nodeId];
  while (cur) {
    path.unshift(cur);
    cur = cur.parentNodeId ? tree.nodes[cur.parentNodeId] : undefined;
  }
  return path;
}

// A node can be extended linearly (same Claude Code session) ONLY if no
// existing child of that node lives in the same session — otherwise the
// session's append-only .jsonl tail is past the parent and we must fork.
export function canLinearContinue(tree: ConversationTreePublic, parentNodeId: string): boolean {
  const parent = tree.nodes[parentNodeId];
  if (!parent) return false;
  const children = getChildren(tree, parentNodeId);
  return children.every((c) => c.sessionId !== parent.sessionId);
}

export function getDescendants(tree: ConversationTreePublic, nodeId: string): TreeNodePublic[] {
  const out: TreeNodePublic[] = [];
  const queue = [nodeId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const child of getChildren(tree, cur)) {
      out.push(child);
      queue.push(child.nodeId);
    }
  }
  return out;
}

export function removeSubtree(tree: ConversationTreePublic, nodeId: string): TreeNodePublic[] {
  const removed = getDescendants(tree, nodeId);
  const node = tree.nodes[nodeId];
  if (node) removed.push(node);
  for (const r of removed) delete tree.nodes[r.nodeId];
  return removed;
}

export function updateNode(
  tree: ConversationTreePublic,
  nodeId: string,
  patch: Partial<Pick<TreeNodePublic, "text" | "status" | "claudeUuid">>,
): TreeNodePublic | null {
  const node = tree.nodes[nodeId];
  if (!node) return null;
  if (patch.text !== undefined) node.text = patch.text;
  if (patch.status !== undefined) node.status = patch.status;
  if (patch.claudeUuid !== undefined) node.claudeUuid = patch.claudeUuid;
  return node;
}

// Synthesize a tree from a legacy .jsonl (pre-tree-feature). The .jsonl is
// a linear conversation, so the synthesized tree is a single spine.
// Called lazily when the user opens a session with no tree.json yet.
export function synthesizeTreeFromTurns(
  rootSessionId: string,
  turns: Array<{ prompt: string; text: string; lastClaudeUuid: string }>,
): ConversationTreePublic {
  const tree: ConversationTreePublic = {
    version: 1,
    rootSessionId,
    rootNodeId: "",
    nodes: {},
  };
  let parentNodeId: string | null = null;
  for (const t of turns) {
    const nodeId = randomUUID();
    const node: TreeNodePublic = {
      nodeId,
      parentNodeId,
      sessionId: rootSessionId,
      claudeUuid: t.lastClaudeUuid,
      prompt: t.prompt,
      text: t.text,
      status: "done" as TurnStatus,
      createdAt: Date.now(),
    };
    tree.nodes[nodeId] = node;
    if (parentNodeId === null) tree.rootNodeId = nodeId;
    parentNodeId = nodeId;
  }
  return tree;
}

export async function listTreeFiles(): Promise<string[]> {
  try {
    const entries = await fs.readdir(TREES_DIR);
    return entries.filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"));
  } catch {
    return [];
  }
}

export async function deleteTree(rootSessionId: string): Promise<void> {
  try {
    await fs.unlink(treePath(rootSessionId));
  } catch {
    /* not there or already gone */
  }
}

export function getTreesDir(): string {
  return TREES_DIR;
}
