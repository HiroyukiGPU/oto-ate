"use client";

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { YouTubePlayerHandle } from "@/components/YouTubePlayer";
import { clamp } from "./timeUtils";
import type { DragTarget, DurationPreset } from "./types";

const MIN_SELECTION_SECONDS = 1;
const DEFAULT_ZOOM_WINDOW_SECONDS = 20;
const MIN_ZOOM_WINDOW_SECONDS = 4;
const MAX_ZOOM_WINDOW_SECONDS = 120;
const BOUNDARY_EPSILON = 0.05;

type UseRangeEditorParams = {
  playerRef: RefObject<YouTubePlayerHandle | null>;
  duration: number;
  initialStart: number;
  initialEnd: number;
  initialIntroStart?: number;
};

export function useRangeEditor({
  playerRef,
  duration,
  initialStart,
  initialEnd,
  initialIntroStart = 0,
}: UseRangeEditorParams) {
  const [startSeconds, setStartSecondsState] = useState(initialStart);
  const [endSeconds, setEndSecondsState] = useState(initialEnd);
  const [introStartSeconds, setIntroStartSecondsState] = useState(initialIntroStart);
  const [currentTime, setCurrentTime] = useState(initialStart);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLooping, setIsLooping] = useState(false);
  const [lockDuration, setLockDuration] = useState(false);
  const [dragTarget, setDragTarget] = useState<DragTarget>(null);
  const [zoomWindowSeconds, setZoomWindowSecondsState] = useState(DEFAULT_ZOOM_WINDOW_SECONDS);

  const boundedPlaybackRef = useRef(true);
  const rafRef = useRef<number | null>(null);
  const isLoopingRef = useRef(false);
  const boundsRef = useRef({ startSeconds, endSeconds });

  const effectiveDuration = duration > 0 ? duration : Math.max(endSeconds, initialEnd, 1);

  useEffect(() => {
    boundsRef.current = { startSeconds, endSeconds };
  }, [startSeconds, endSeconds]);

  useEffect(() => {
    isLoopingRef.current = isLooping;
  }, [isLooping]);

  useEffect(() => {
    if (!isPlaying) return;

    function tick() {
      const player = playerRef.current;
      if (!player) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      const t = player.getCurrentTime();
      setCurrentTime(t);

      const { startSeconds: s, endSeconds: e } = boundsRef.current;
      if (t >= e - BOUNDARY_EPSILON) {
        if (isLoopingRef.current) {
          player.seekTo(s, true);
        } else if (boundedPlaybackRef.current) {
          player.pause();
          setCurrentTime(e);
          return;
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [isPlaying, playerRef]);

  function handlePlayerStateChange(state: YT.PlayerState) {
    if (state === 1) setIsPlaying(true);
    else if (state === 2 || state === 0) setIsPlaying(false);
  }

  function resizeStart(value: number) {
    const next = clamp(value, 0, endSeconds - MIN_SELECTION_SECONDS);
    setStartSecondsState(next);
  }

  function resizeEnd(value: number) {
    const next = clamp(value, startSeconds + MIN_SELECTION_SECONDS, effectiveDuration);
    setEndSecondsState(next);
  }

  function setRange(newStart: number, newEnd: number) {
    const lo = Math.min(newStart, newEnd);
    const hi = Math.max(newStart, newEnd);
    const clampedStart = clamp(lo, 0, Math.max(0, effectiveDuration - MIN_SELECTION_SECONDS));
    const clampedEnd = clamp(hi, clampedStart + MIN_SELECTION_SECONDS, effectiveDuration);
    setStartSecondsState(clampedStart);
    setEndSecondsState(clampedEnd);
  }

  function moveSelectionTo(newStart: number) {
    const length = endSeconds - startSeconds;
    const clampedStart = clamp(newStart, 0, Math.max(0, effectiveDuration - length));
    setStartSecondsState(clampedStart);
    setEndSecondsState(clampedStart + length);
  }

  function dragStartHandle(value: number) {
    if (lockDuration) {
      moveSelectionTo(value);
    } else {
      resizeStart(value);
    }
  }

  function dragEndHandle(value: number) {
    if (lockDuration) {
      const length = endSeconds - startSeconds;
      moveSelectionTo(value - length);
    } else {
      resizeEnd(value);
    }
  }

  function adjustStart(delta: number) {
    resizeStart(startSeconds + delta);
  }

  function adjustEnd(delta: number) {
    resizeEnd(endSeconds + delta);
  }

  function applyPreset(preset: DurationPreset) {
    if (preset === "free") return;
    resizeEnd(startSeconds + preset);
  }

  function setIntroStartSeconds(value: number) {
    setIntroStartSecondsState(clamp(value, 0, effectiveDuration));
  }

  function adjustIntroStart(delta: number) {
    setIntroStartSeconds(introStartSeconds + delta);
  }

  // Open-ended (not bounded to startSeconds/endSeconds, which belong to the
  // chorus selection and are unrelated to where the intro starts) so the
  // host can freely listen past the silent lead-in and manually pause.
  function playIntroPreview() {
    setIsLooping(false);
    playFrom(introStartSeconds, { boundedAtEnd: false });
  }

  function seek(seconds: number) {
    const clamped = clamp(seconds, 0, effectiveDuration);
    setCurrentTime(clamped);
    playerRef.current?.seekTo(clamped, true);
  }

  function playFrom(seekSeconds: number, options?: { boundedAtEnd?: boolean }) {
    const player = playerRef.current;
    if (!player) return;
    boundedPlaybackRef.current = options?.boundedAtEnd ?? true;
    const clamped = clamp(seekSeconds, 0, effectiveDuration);
    player.seekTo(clamped, true);
    player.resume();
    setCurrentTime(clamped);
  }

  function playSelection() {
    setIsLooping(false);
    playFrom(startSeconds, { boundedAtEnd: true });
  }

  function playSelectionLoop() {
    const next = !isLooping;
    setIsLooping(next);
    if (next) {
      playFrom(startSeconds, { boundedAtEnd: true });
    }
  }

  function playBeforeSelection() {
    setIsLooping(false);
    playFrom(Math.max(0, startSeconds - 3), { boundedAtEnd: true });
  }

  function playFromStartOpenEnded() {
    setIsLooping(false);
    playFrom(startSeconds, { boundedAtEnd: false });
  }

  function playBeforeEnd() {
    setIsLooping(false);
    playFrom(Math.max(startSeconds, endSeconds - 3), { boundedAtEnd: true });
  }

  function pausePlayback() {
    playerRef.current?.pause();
  }

  function togglePlayPause() {
    if (isPlaying) {
      pausePlayback();
    } else {
      playFrom(currentTime, { boundedAtEnd: boundedPlaybackRef.current });
    }
  }

  function setZoomWindowSeconds(value: number) {
    setZoomWindowSecondsState(
      clamp(value, MIN_ZOOM_WINDOW_SECONDS, Math.min(MAX_ZOOM_WINDOW_SECONDS, effectiveDuration || MAX_ZOOM_WINDOW_SECONDS)),
    );
  }

  return {
    startSeconds,
    endSeconds,
    introStartSeconds,
    currentTime,
    duration: effectiveDuration,
    isPlaying,
    isLooping,
    lockDuration,
    dragTarget,
    zoomWindowSeconds,
    setDragTarget,
    setStartSeconds: resizeStart,
    setEndSeconds: resizeEnd,
    setRange,
    setIntroStartSeconds,
    adjustIntroStart,
    playIntroPreview,
    dragStartHandle,
    dragEndHandle,
    moveSelectionTo,
    adjustStart,
    adjustEnd,
    applyPreset,
    seek,
    playSelection,
    playSelectionLoop,
    playBeforeSelection,
    playFromStartOpenEnded,
    playBeforeEnd,
    pausePlayback,
    togglePlayPause,
    toggleLockDuration: () => setLockDuration((v) => !v),
    setZoomWindowSeconds,
    handlePlayerStateChange,
  };
}

export type RangeEditorState = ReturnType<typeof useRangeEditor>;
