import { useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { UiPane } from "../state/panes.ts";
import { PaneView } from "./PaneView.tsx";

interface Props {
  panes: UiPane[];
  defaultWidth: number;
  isLastColumn: boolean;
  rightmostPaneId: string;
}

const MIN_COLUMN_WIDTH = 380;
const MAX_COLUMN_WIDTH = 1400;
const MIN_ROW_HEIGHT = 140;

export function PaneColumn({ panes, defaultWidth, isLastColumn, rightmostPaneId }: Props) {
  const [width, setWidth] = useState(defaultWidth);
  const [topShare, setTopShare] = useState(0.5); // proportion of column height the top pane gets when there are two panes
  const columnRef = useRef<HTMLDivElement | null>(null);

  const startColumnResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      const next = Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, startWidth + delta));
      setWidth(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const startRowResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    const rect = columnRef.current?.getBoundingClientRect();
    if (!rect) return;
    const totalH = rect.height;
    if (totalH <= 2 * MIN_ROW_HEIGHT) return;
    const startY = e.clientY;
    const startTopPx = topShare * totalH;
    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientY - startY;
      const nextPx = Math.max(MIN_ROW_HEIGHT, Math.min(totalH - MIN_ROW_HEIGHT, startTopPx + delta));
      setTopShare(nextPx / totalH);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const columnStyle = isLastColumn
    ? { flex: `1 1 ${width}px`, minWidth: width }
    : { flex: `0 0 ${width}px`, width };

  const renderPane = (pane: UiPane) => (
    <PaneView paneId={pane.paneId} isRightmost={pane.paneId === rightmostPaneId} />
  );

  const hasTwo = panes.length === 2;

  return (
    <div ref={columnRef} className="pane-column" style={columnStyle}>
      {hasTwo ? (
        <>
          <div className="pane-slot" style={{ flex: `${topShare} 1 0`, minHeight: MIN_ROW_HEIGHT }}>
            {renderPane(panes[0]!)}
          </div>
          <div className="row-resize-handle" onMouseDown={startRowResize} />
          <div className="pane-slot" style={{ flex: `${1 - topShare} 1 0`, minHeight: MIN_ROW_HEIGHT }}>
            {renderPane(panes[1]!)}
          </div>
        </>
      ) : (
        <div className="pane-slot">{renderPane(panes[0]!)}</div>
      )}
      {isLastColumn ? null : (
        <div className="column-resize-handle" onMouseDown={startColumnResize} />
      )}
    </div>
  );
}
