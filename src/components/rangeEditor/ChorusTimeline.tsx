"use client";

import { useMemo, useRef } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import RangeHandles from "./RangeHandles";
import { formatTime, pixelsToSeconds } from "./timeUtils";
import type { ChorusCandidate, DragTarget } from "./types";

type ChorusTimelineProps = {
  videoId: string;
  duration: number;
  currentTime: number;
  startSeconds: number;
  endSeconds: number;
  dragTarget: DragTarget;
  candidates: ChorusCandidate[];
  onSeek: (seconds: number) => void;
  onDragStart: (value: number) => void;
  onDragEnd: (value: number) => void;
  onMove: (newStart: number) => void;
  onDragStateChange: (target: DragTarget) => void;
};

const BAR_COUNT = 140;

function seededRandom(seed: number): number {
  const x = Math.sin(seed * 999.77) * 10000;
  return x - Math.floor(x);
}

function pickTickStep(duration: number): number {
  if (duration <= 60) return 5;
  if (duration <= 180) return 15;
  if (duration <= 600) return 30;
  return 60;
}

export default function ChorusTimeline({
  videoId,
  duration,
  currentTime,
  startSeconds,
  endSeconds,
  dragTarget,
  candidates,
  onSeek,
  onDragStart,
  onDragEnd,
  onMove,
  onDragStateChange,
}: ChorusTimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);

  const bars = useMemo(() => {
    let seed = 1;
    for (let i = 0; i < videoId.length; i++) seed += videoId.charCodeAt(i) * (i + 7);
    return Array.from({ length: BAR_COUNT }, (_, i) => 0.12 + seededRandom(seed + i * 3.1) * 0.88);
  }, [videoId]);

  const ticks = useMemo(() => {
    const step = pickTickStep(duration);
    const result: number[] = [];
    for (let t = 0; t <= duration; t += step) result.push(t);
    return result;
  }, [duration]);

  function handleTrackClick(e: ReactMouseEvent<HTMLDivElement>) {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return;
    const seconds = pixelsToSeconds(e.clientX - rect.left, 0, duration, rect.width);
    onSeek(Math.min(Math.max(seconds, 0), duration));
  }

  const playheadPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between text-xs text-neutral-400">
        <span>00:00</span>
        <span>現在 {formatTime(currentTime)}</span>
        <span>{formatTime(duration)}</span>
      </div>
      <div
        ref={trackRef}
        data-testid="chorus-timeline-track"
        onClick={handleTrackClick}
        className="relative h-20 w-full cursor-pointer touch-none overflow-hidden rounded-md bg-neutral-800 select-none"
      >
        <div className="absolute inset-0 flex items-end gap-px px-1">
          {bars.map((h, i) => (
            <span
              key={i}
              className="min-w-px flex-1 rounded-t-sm bg-neutral-600"
              style={{ height: `${h * 100}%` }}
            />
          ))}
        </div>

        {candidates.map((candidate) => (
          <div
            key={candidate.id}
            className="pointer-events-none absolute inset-y-0 bg-amber-400/25"
            style={{
              left: `${(candidate.startSeconds / duration) * 100}%`,
              width: `${((candidate.endSeconds - candidate.startSeconds) / duration) * 100}%`,
            }}
          />
        ))}

        {ticks.map((t) => (
          <span
            key={t}
            className="pointer-events-none absolute inset-y-0 w-px bg-white/10"
            style={{ left: `${(t / duration) * 100}%` }}
          />
        ))}

        <RangeHandles
          trackRef={trackRef}
          windowStart={0}
          windowEnd={duration}
          startSeconds={startSeconds}
          endSeconds={endSeconds}
          minSeconds={0}
          maxSeconds={duration}
          snapStep={0.1}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onMove={onMove}
          onDragStateChange={onDragStateChange}
          dragTarget={dragTarget}
          testIdPrefix="chorus-handle"
        />

        <div
          className="pointer-events-none absolute inset-y-0 z-20 w-0.5 bg-white shadow"
          style={{ left: `${playheadPercent}%` }}
        />
      </div>
    </div>
  );
}
