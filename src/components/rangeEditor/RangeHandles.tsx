"use client";

import { useRef } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import { clamp, formatTime } from "./timeUtils";
import type { DragTarget } from "./types";

type RangeHandlesProps = {
  trackRef: RefObject<HTMLDivElement | null>;
  windowStart: number;
  windowEnd: number;
  startSeconds: number;
  endSeconds: number;
  minSeconds: number;
  maxSeconds: number;
  snapStep: number;
  onDragStart: (value: number) => void;
  onDragEnd: (value: number) => void;
  onMove: (newStart: number) => void;
  onDragStateChange: (target: DragTarget) => void;
  dragTarget: DragTarget;
  testIdPrefix?: string;
};

type DragInfo = {
  target: "start" | "end" | "move";
  pointerId: number;
  startClientX: number;
  originStart: number;
  originEnd: number;
};

export default function RangeHandles({
  trackRef,
  windowStart,
  windowEnd,
  startSeconds,
  endSeconds,
  minSeconds,
  maxSeconds,
  snapStep,
  onDragStart,
  onDragEnd,
  onMove,
  onDragStateChange,
  dragTarget,
  testIdPrefix,
}: RangeHandlesProps) {
  const dragInfo = useRef<DragInfo | null>(null);

  function beginDrag(target: DragInfo["target"], e: ReactPointerEvent) {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragInfo.current = {
      target,
      pointerId: e.pointerId,
      startClientX: e.clientX,
      originStart: startSeconds,
      originEnd: endSeconds,
    };
    onDragStateChange(target);
  }

  function handleMove(e: ReactPointerEvent) {
    const info = dragInfo.current;
    if (!info || info.pointerId !== e.pointerId) return;
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return;
    const deltaPx = e.clientX - info.startClientX;
    const deltaSeconds = (deltaPx / rect.width) * (windowEnd - windowStart);
    const snappedDelta = Math.round(deltaSeconds / snapStep) * snapStep;

    if (info.target === "start") {
      onDragStart(clamp(info.originStart + snappedDelta, minSeconds, maxSeconds));
    } else if (info.target === "end") {
      onDragEnd(clamp(info.originEnd + snappedDelta, minSeconds, maxSeconds));
    } else {
      onMove(clamp(info.originStart + snappedDelta, minSeconds, maxSeconds));
    }
  }

  function endDrag(e: ReactPointerEvent) {
    const info = dragInfo.current;
    if (!info || info.pointerId !== e.pointerId) return;
    dragInfo.current = null;
    onDragStateChange(null);
  }

  // Positions are derived as percentages of the window span so nothing here
  // reads trackRef.current during render (ref reads are only safe inside the
  // pointer event handlers above, e.g. handleMove's getBoundingClientRect()).
  const span = windowEnd - windowStart || 1;
  const startPercent = ((startSeconds - windowStart) / span) * 100;
  const endPercent = ((endSeconds - windowStart) / span) * 100;

  // Only transition position changes that happen while idle (a preset click,
  // a fine-adjust button, or the zoom window recentering once a drag ends).
  // During an active drag we want instant 1:1 movement, not a lagged tween.
  const transitionClass = dragTarget === null ? "transition-all duration-150 ease-out" : "";

  return (
    <div className="absolute inset-0">
      <div
        className={`pointer-events-none absolute inset-y-0 left-0 bg-black/55 ${transitionClass}`}
        style={{ width: `${Math.max(0, startPercent)}%` }}
      />
      <div
        className={`pointer-events-none absolute inset-y-0 right-0 bg-black/55 ${transitionClass}`}
        style={{ left: `${Math.max(0, endPercent)}%` }}
      />

      <div
        data-testid={testIdPrefix ? `${testIdPrefix}-move` : undefined}
        onPointerDown={(e) => beginDrag("move", e)}
        onPointerMove={handleMove}
        onPointerUp={endDrag}
        className={`absolute inset-y-0 cursor-grab touch-none border-y-2 border-emerald-400/80 bg-emerald-400/20 active:cursor-grabbing ${transitionClass}`}
        style={{ left: `${startPercent}%`, width: `${Math.max(0, endPercent - startPercent)}%` }}
      />

      <div
        data-testid={testIdPrefix ? `${testIdPrefix}-start` : undefined}
        onPointerDown={(e) => beginDrag("start", e)}
        onPointerMove={handleMove}
        onPointerUp={endDrag}
        className={`absolute inset-y-0 z-10 flex w-8 -translate-x-1/2 cursor-ew-resize touch-none items-center justify-center ${transitionClass}`}
        style={{ left: `${startPercent}%` }}
      >
        <div className="flex h-full w-2.5 items-center justify-center rounded-l-sm border-2 border-emerald-300 bg-emerald-500 shadow">
          <span className="text-[8px] leading-none text-emerald-950">▶</span>
        </div>
        {dragTarget === "start" && (
          <span className="pointer-events-none absolute -top-7 whitespace-nowrap rounded bg-neutral-900 px-2 py-0.5 text-xs text-white shadow">
            開始 {formatTime(startSeconds)}
          </span>
        )}
      </div>

      <div
        data-testid={testIdPrefix ? `${testIdPrefix}-end` : undefined}
        onPointerDown={(e) => beginDrag("end", e)}
        onPointerMove={handleMove}
        onPointerUp={endDrag}
        className={`absolute inset-y-0 z-10 flex w-8 -translate-x-1/2 cursor-ew-resize touch-none items-center justify-center ${transitionClass}`}
        style={{ left: `${endPercent}%` }}
      >
        <div className="flex h-full w-2.5 items-center justify-center rounded-r-sm border-2 border-dashed border-rose-300 bg-rose-500 shadow">
          <span className="text-[8px] leading-none text-rose-950">◀</span>
        </div>
        {dragTarget === "end" && (
          <span className="pointer-events-none absolute -top-7 whitespace-nowrap rounded bg-neutral-900 px-2 py-0.5 text-xs text-white shadow">
            終了 {formatTime(endSeconds)}
          </span>
        )}
      </div>
    </div>
  );
}
