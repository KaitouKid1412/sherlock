import type { ServerSentEvent } from "../types/events.ts";

interface RawEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  apiKeySource?: string;
  event?: {
    type?: string;
    index?: number;
    content_block?: { type?: string; id?: string; name?: string };
    delta?: { type?: string; text?: string; partial_json?: string };
  };
  message?: { id?: string; content?: Array<{ type?: string; text?: string }> };
  result?: string;
  total_cost_usd?: number;
}

type Emit = (ev: ServerSentEvent) => void;
type Debug = (label: string, payload: unknown) => void;

export interface ParserCtx {
  turnId: string;
}

export function createStreamParser(ctx: ParserCtx, emit: Emit, debug: Debug) {
  const { turnId } = ctx;
  return (line: string): void => {
    if (line.trim().length === 0) return;
    let obj: RawEvent;
    try {
      obj = JSON.parse(line) as RawEvent;
    } catch (err) {
      debug("parse_error", { line, err: String(err) });
      return;
    }

    if (obj.type === "system" && obj.subtype === "init") {
      if (obj.apiKeySource && obj.apiKeySource !== "none") {
        emit({
          type: "error",
          turnId,
          message: `claude is using API-key auth (${obj.apiKeySource}), not subscription. Refusing.`,
        });
        return;
      }
      if (typeof obj.session_id === "string") {
        emit({ type: "session_ready", sessionId: obj.session_id });
      }
      return;
    }

    if (obj.type === "stream_event" && obj.event) {
      const ev = obj.event;
      if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
        emit({
          type: "tool_use_start",
          turnId,
          toolName: ev.content_block.name ?? "(unknown)",
          toolUseId: ev.content_block.id ?? "",
          blockIndex: ev.index ?? 0,
        });
        return;
      }
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
        emit({ type: "text_delta", turnId, text: ev.delta.text });
        return;
      }
      if (ev.type === "content_block_delta" && ev.delta?.type === "input_json_delta" && typeof ev.delta.partial_json === "string") {
        emit({
          type: "tool_use_input_delta",
          turnId,
          partialJson: ev.delta.partial_json,
          blockIndex: ev.index ?? 0,
        });
        return;
      }
      debug("stream_event_skipped", ev);
      return;
    }

    if (obj.type === "assistant" && obj.message) {
      const text = (obj.message.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      emit({ type: "assistant_message", turnId, messageId: obj.message.id ?? "", text });
      return;
    }

    if (obj.type === "result") {
      emit({
        type: "done",
        turnId,
        result: obj.result ?? "",
        costUsd: obj.total_cost_usd,
      });
      return;
    }

    debug("event_dropped", obj);
  };
}
