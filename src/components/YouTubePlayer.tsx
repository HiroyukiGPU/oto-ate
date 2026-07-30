"use client";

import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import { loadYouTubeIframeApi } from "@/lib/loadYouTubeIframeApi";

export type YouTubePlayerHandle = {
  playClip: (videoId: string, startSeconds: number, endSeconds: number) => void;
  cueVideo: (videoId: string) => void;
  isReady: () => boolean;
  pause: () => void;
  resume: () => void;
  seekTo: (seconds: number, allowSeekAhead?: boolean) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  getPlayerState: () => YT.PlayerState;
};

type Clip = {
  videoId: string;
  startSeconds: number;
  endSeconds: number;
};

type PendingAction = { type: "play"; clip: Clip } | { type: "cue"; videoId: string };

type Props = {
  onStateChange?: (state: YT.PlayerState) => void;
  onPlaybackError?: (error: YT.PlayerError) => void;
};

const YouTubePlayer = forwardRef<YouTubePlayerHandle, Props>(function YouTubePlayer(
  { onStateChange, onPlaybackError },
  ref,
) {
  const containerId = useId();
  const playerRef = useRef<YT.Player | null>(null);
  const pendingActionRef = useRef<PendingAction | null>(null);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    loadYouTubeIframeApi().then((YTApi) => {
      if (cancelled) return;

      playerRef.current = new YTApi.Player(containerId, {
        height: "100%",
        width: "100%",
        playerVars: {
          controls: 1,
          modestbranding: 1,
          rel: 0,
        },
        events: {
          onReady: () => {
            setIsReady(true);
            const action = pendingActionRef.current;
            if (!action) return;
            pendingActionRef.current = null;
            if (action.type === "play") {
              playerRef.current?.loadVideoById(action.clip);
            } else {
              playerRef.current?.cueVideoById(action.videoId);
            }
          },
          onStateChange: (event) => onStateChange?.(event.data),
          onError: (event) => onPlaybackError?.(event.data),
        },
      });
    });

    return () => {
      cancelled = true;
      playerRef.current?.destroy();
      playerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(ref, () => ({
    playClip: (videoId, startSeconds, endSeconds) => {
      const clip: Clip = { videoId, startSeconds, endSeconds };
      if (!isReady) {
        pendingActionRef.current = { type: "play", clip };
        return;
      }
      playerRef.current?.loadVideoById(clip);
    },
    cueVideo: (videoId) => {
      if (!isReady) {
        pendingActionRef.current = { type: "cue", videoId };
        return;
      }
      playerRef.current?.cueVideoById(videoId);
    },
    isReady: () => isReady && playerRef.current !== null,
    pause: () => {
      playerRef.current?.pauseVideo();
    },
    resume: () => {
      playerRef.current?.playVideo();
    },
    seekTo: (seconds, allowSeekAhead = true) => {
      playerRef.current?.seekTo(seconds, allowSeekAhead);
    },
    getCurrentTime: () => playerRef.current?.getCurrentTime() ?? 0,
    getDuration: () => playerRef.current?.getDuration() ?? 0,
    getPlayerState: () => playerRef.current?.getPlayerState() ?? -1,
  }));

  return (
    <div className="aspect-video w-full overflow-hidden rounded-lg bg-black">
      <div id={containerId} className={isReady ? undefined : "opacity-0"} />
    </div>
  );
});

export default YouTubePlayer;
