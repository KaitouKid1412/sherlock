import type { ServerSentEvent } from "../../types/events.ts";

export function openPaneStream(
  paneId: string,
  onEvent: (ev: ServerSentEvent) => void,
  onError?: (err: Event) => void,
): () => void {
  const es = new EventSource(`/api/panes/${paneId}/stream`);
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
