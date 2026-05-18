export type ServerSentEvent =
  | { type: "session_ready"; sessionId: string }
  | { type: "turn_started"; turnId: string; prompt: string; status: TurnStatus }
  | { type: "turn_status"; turnId: string; status: TurnStatus }
  | { type: "text_delta"; turnId: string; text: string }
  | { type: "tool_use_start"; turnId: string; toolName: string; toolUseId: string; blockIndex: number }
  | { type: "tool_use_input_delta"; turnId: string; partialJson: string; blockIndex: number }
  | { type: "assistant_message"; turnId: string; messageId: string; text: string }
  | { type: "done"; turnId: string; result: string; costUsd?: number }
  | { type: "error"; turnId?: string; message: string };

export type TurnStatus = "queued" | "streaming" | "done" | "error" | "cancelled";

export interface TurnPublic {
  turnId: string;
  prompt: string;
  text: string;
  status: TurnStatus;
  startedAt: number;
  endedAt?: number;
}

export interface PanePublic {
  paneId: string;
  turnIds: string[];
  createdAt: number;
}

export interface StatePublic {
  sessionId: string | null;
  panes: PanePublic[];
  turns: Record<string, TurnPublic>;
}
