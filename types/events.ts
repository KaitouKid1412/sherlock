export type ServerSentEvent =
  | { type: "session_ready"; sessionId: string }
  | { type: "turn_started"; turnId: string; prompt: string; status: TurnStatus; nodeId?: string }
  | { type: "turn_status"; turnId: string; status: TurnStatus }
  | { type: "text_delta"; turnId: string; text: string }
  | { type: "tool_use_start"; turnId: string; toolName: string; toolUseId: string; blockIndex: number }
  | { type: "tool_use_input_delta"; turnId: string; partialJson: string; blockIndex: number }
  | { type: "assistant_message"; turnId: string; messageId: string; text: string }
  | { type: "done"; turnId: string; result: string; costUsd?: number }
  | { type: "error"; turnId?: string; message: string }
  | { type: "node_added"; node: TreeNodePublic }
  | { type: "tree_updated"; rootSessionId: string };

export type TurnStatus = "queued" | "streaming" | "done" | "error" | "cancelled";

export interface TurnPublic {
  turnId: string;
  prompt: string;
  text: string;
  status: TurnStatus;
  startedAt: number;
  endedAt?: number;
  nodeId?: string;
}

export interface PanePublic {
  paneId: string;
  rootSessionId: string | null;
  currentNodeId: string | null;
  createdAt: number;
}

export interface StatePublic {
  rootSessionId: string | null;
  panes: PanePublic[];
  turns: Record<string, TurnPublic>;
  tree: ConversationTreePublic | null;
}

// Sherlock's tree of conversation nodes. One node = one Q&A turn. The tree
// lives in ~/Library/Application Support/Sherlock/trees/<rootSessionId>.json
// and references one or more Claude Code session .jsonl files: linear paths
// share a session; siblings live in forked sessions (one snapshot per fork).
export interface TreeNodePublic {
  nodeId: string;
  parentNodeId: string | null;
  sessionId: string;            // Claude Code session containing this node's turn
  claudeUuid: string;           // assistant uuid within that session
  prompt: string;
  text: string;
  status: TurnStatus;
  createdAt: number;
}

export interface ConversationTreePublic {
  version: 1;
  rootSessionId: string;
  rootNodeId: string;
  nodes: Record<string, TreeNodePublic>;
}
