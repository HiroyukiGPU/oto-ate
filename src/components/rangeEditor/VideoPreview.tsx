"use client";

import type { RefObject } from "react";
import YouTubePlayer, { YouTubePlayerHandle } from "@/components/YouTubePlayer";
import { formatTime } from "./timeUtils";

type VideoPreviewProps = {
  playerRef: RefObject<YouTubePlayerHandle | null>;
  thumbnailUrl: string;
  title: string;
  artist: string;
  duration: number;
  onStateChange: (state: YT.PlayerState) => void;
  onPlaybackError: (error: YT.PlayerError) => void;
  onSetStartHere: () => void;
  onSetEndHere: () => void;
};

export default function VideoPreview({
  playerRef,
  thumbnailUrl,
  title,
  artist,
  duration,
  onStateChange,
  onPlaybackError,
  onSetStartHere,
  onSetEndHere,
}: VideoPreviewProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        {thumbnailUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumbnailUrl} alt="" className="h-14 w-24 shrink-0 rounded object-cover" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-white">{title || "曲名を取得中…"}</p>
          <p className="truncate text-xs text-neutral-400">{artist || "アーティスト名を取得中…"}</p>
          {duration > 0 && (
            <p className="text-xs text-neutral-500">総再生時間 {formatTime(duration)}</p>
          )}
        </div>
      </div>

      <YouTubePlayer ref={playerRef} onStateChange={onStateChange} onPlaybackError={onPlaybackError} />

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onSetStartHere}
          className="flex-1 rounded-md border border-emerald-500 px-3 py-2 text-xs font-medium text-emerald-300"
        >
          現在位置を開始地点に設定
        </button>
        <button
          type="button"
          onClick={onSetEndHere}
          className="flex-1 rounded-md border border-rose-500 px-3 py-2 text-xs font-medium text-rose-300"
        >
          現在位置を終了地点に設定
        </button>
      </div>
    </div>
  );
}
