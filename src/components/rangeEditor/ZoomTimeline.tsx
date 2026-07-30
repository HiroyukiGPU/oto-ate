"use client";

import { useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, WheelEvent as ReactWheelEvent } from "react";
import RangeHandles from "./RangeHandles";
import { clamp, formatTime, pixelsToSeconds } from "./timeUtils";
import type { DragTarget } from "./types";

type ZoomTimelineProps = {
  duration: number;
  currentTime: number;
  startSeconds: number;
  endSeconds: number;
  zoomWindowSeconds: number;
  dragTarget: DragTarget;
  onSeek: (seconds: number) => void;
  onDragStart: (value: number) => void;
  onDragEnd: (value: number) => void;
  onMove: (newStart: number) => void;
  onDragStateChange: (target: DragTarget) => void;
  onZoomChange: (seconds: number) => void;
};

function pickZoomTickStep(windowSeconds: number): number {
  if (windowSeconds <= 10) return 1;
  if (windowSeconds <= 30) return 2;
  if (windowSeconds <= 60) return 5;
  return 10;
}

export default function ZoomTimeline({
  duration,
  currentTime,
  startSeconds,
  endSeconds,
  zoomWindowSeconds,
  dragTarget,
  onSeek,
  onDragStart,
  onDragEnd,
  onMove,
  onDragStateChange,
  onZoomChange,
}: ZoomTimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);

  // While the selection fits inside the zoomed window, center on the
  // selection itself. Once it's wider than the window can show, there's no
  // single "selection center" worth looking at — follow the live playhead
  // instead so whichever boundary is currently playing stays in view.
  const selectionSpan = endSeconds - startSeconds;
  const liveCenter =
    selectionSpan > zoomWindowSeconds ? currentTime : (startSeconds + endSeconds) / 2;

  // Freeze the window's center for the duration of a drag. Without this, a
  // handle drag shifts startSeconds/endSeconds, which shifts liveCenter,
  // which pans the window under the cursor — turning a simple drag into a
  // moving-target feedback loop. Captured/released from beginDrag/endDrag
  // (real event handlers), never during render.
  const [frozenCenter, setFrozenCenter] = useState<number | null>(null);

  function handleDragStateChange(target: DragTarget) {
    if (target !== null) {
      setFrozenCenter((prev) => prev ?? liveCenter);
    } else {
      setFrozenCenter(null);
    }
    onDragStateChange(target);
  }

  const center = frozenCenter ?? liveCenter;

  let windowStart = center - zoomWindowSeconds / 2;
  let windowEnd = center + zoomWindowSeconds / 2;
  if (windowStart < 0) {
    windowEnd -= windowStart;
    windowStart = 0;
  }
  if (windowEnd > duration) {
    windowStart -= windowEnd - duration;
    windowEnd = duration;
  }
  windowStart = Math.max(0, windowStart);
  windowEnd = Math.min(duration, windowEnd);

  const ticks = useMemo(() => {
    const step = pickZoomTickStep(zoomWindowSeconds);
    const result: number[] = [];
    const first = Math.ceil(windowStart / step) * step;
    for (let t = first; t <= windowEnd; t += step) result.push(Number(t.toFixed(2)));
    return result;
  }, [windowStart, windowEnd, zoomWindowSeconds]);

  function handleTrackClick(e: ReactMouseEvent<HTMLDivElement>) {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return;
    const seconds = pixelsToSeconds(e.clientX - rect.left, windowStart, windowEnd, rect.width);
    onSeek(clamp(seconds, 0, duration));
  }

  function handleWheel(e: ReactWheelEvent<HTMLDivElement>) {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    onZoomChange(zoomWindowSeconds * factor);
  }

  const span = windowEnd - windowStart || 1;
  const playheadPercent =
    currentTime >= windowStart && currentTime <= windowEnd
      ? ((currentTime - windowStart) / span) * 100
      : null;
  const isDragging = dragTarget !== null;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-xs text-neutral-400">
        <span>拡大タイムライン（表示幅 約{Math.round(zoomWindowSeconds)}秒・0.1秒単位）</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onZoomChange(zoomWindowSeconds * 1.4)}
            className="rounded border border-neutral-600 px-2 py-0.5 text-xs text-neutral-200"
            aria-label="縮小"
          >
            −
          </button>
          <button
            type="button"
            onClick={() => onZoomChange(zoomWindowSeconds / 1.4)}
            className="rounded border border-neutral-600 px-2 py-0.5 text-xs text-neutral-200"
            aria-label="拡大"
          >
            ＋
          </button>
        </div>
      </div>
      <div
        ref={trackRef}
        data-testid="zoom-timeline-track"
        onClick={handleTrackClick}
        onWheel={handleWheel}
        className="relative h-16 w-full cursor-pointer touch-none overflow-hidden rounded-md bg-neutral-800 select-none"
      >
        {ticks.map((t) => (
          <div
            key={t}
            className={`pointer-events-none absolute inset-y-0 flex flex-col items-center ${
              isDragging ? "" : "transition-all duration-150 ease-out"
            }`}
            style={{ left: `${((t - windowStart) / span) * 100}%` }}
          >
            <span className="h-full w-px bg-white/10" />
            <span className="absolute bottom-0.5 -translate-x-1/2 text-[10px] text-neutral-400">
              {formatTime(t)}
            </span>
          </div>
        ))}

        <RangeHandles
          trackRef={trackRef}
          windowStart={windowStart}
          windowEnd={windowEnd}
          startSeconds={startSeconds}
          endSeconds={endSeconds}
          minSeconds={0}
          maxSeconds={duration}
          snapStep={0.1}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onMove={onMove}
          onDragStateChange={handleDragStateChange}
          dragTarget={dragTarget}
          testIdPrefix="zoom-handle"
        />

        {playheadPercent !== null && (
          <div
            className="pointer-events-none absolute inset-y-0 z-20 w-0.5 bg-white shadow"
            style={{ left: `${playheadPercent}%` }}
          />
        )}
      </div>
    </div>
  );
}
