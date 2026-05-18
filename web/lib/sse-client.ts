import type { ServerSentEvent } from "../../types/events.ts";

// Subscribes to the conversation-wide event stream. One stream per loaded
// conversation, opened at App level; panes do NOT each open their own —
// that earlier design caused every text_delta to be applied once per open
// pane, producing visibly duplicated/interleaved response text.
export function openConversationStream(
  onEvent: (ev: ServerSentEvent) => void,
  onError?: (err: Event) => void,
): () => void {
  const es = new EventSource("/api/stream");
  es.onmessage = (msg) => {
    try {
      const ev = JSON.parse(msg.data) as ServerSentEvent;
      onEvent(ev);
    } catch (err) {
      console.error("sse parse error", err, msg.data);
    }
  };
  es.onerror = (err) => {
    onError?.(err);
  };
  return () => es.close();
}
