import { useCallback, useRef, useState } from "react";
import { isHostMode } from "@/lib/hostMode";

export type ChorusDetectionStatus = "detecting" | "done" | "error";

export type ChorusDetectionResult =
  | { status: "detected"; startSeconds: number; endSeconds: number }
  | { status: "failed" };

type QueueItem = { id: string; videoId: string; duration: number };

// Automatically runs server-side chorus detection (src/app/api/chorus/detect/
// route.ts) for songs added WITHOUT a manual range-editing step — currently
// only the playlist bulk-import flow, since the single-video flow already
// goes through ChorusRangeEditor (which has its own manual "サビを自動検出"
// button) before a song is registered, so re-running it there would silently
// override a range the user just deliberately set.
//
// This hook only ever handles songs from the CURRENT (unsaved) create-page
// session — once the quiz is saved, src/lib/chorusDetectionQueue.ts takes
// over for anything still "pending", independent of this page staying open.
// `onResolved` should set the item's chorusStatus accordingly so that
// handoff is consistent regardless of which one finishes the job.
//
// Requests are queued and processed ONE AT A TIME: each call downloads audio
// via yt-dlp and runs librosa, so firing them all in parallel for a large
// playlist import would hammer the network/CPU and likely time out.
export function useAutoChorusDetection(
  onResolved: (id: string, result: ChorusDetectionResult) => void,
) {
  const [status, setStatus] = useState<Record<string, ChorusDetectionStatus>>({});
  const queueRef = useRef<QueueItem[]>([]);
  const runningRef = useRef(false);

  const runQueue = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    while (queueRef.current.length > 0) {
      const next = queueRef.current.shift();
      if (!next) break;
      setStatus((prev) => ({ ...prev, [next.id]: "detecting" }));
      try {
        const res = await fetch("/api/chorus/detect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ videoId: next.videoId, duration: next.duration }),
        });
        const data = await res.json();
        const top = data?.candidates?.[0];
        if (!res.ok || !top) {
          throw new Error(data?.error ?? "サビの自動検出に失敗しました");
        }
        onResolved(next.id, {
          status: "detected",
          startSeconds: top.startSeconds,
          endSeconds: top.endSeconds,
        });
        setStatus((prev) => ({ ...prev, [next.id]: "done" }));
      } catch {
        onResolved(next.id, { status: "failed" });
        setStatus((prev) => ({ ...prev, [next.id]: "error" }));
      }
    }
    runningRef.current = false;
  }, [onResolved]);

  const enqueue = useCallback(
    (item: { id: string; videoId: string; startSeconds: number; endSeconds: number }) => {
      if (!isHostMode()) return;
      queueRef.current.push({
        id: item.id,
        videoId: item.videoId,
        duration: item.endSeconds - item.startSeconds,
      });
      void runQueue();
    },
    [runQueue],
  );

  return { status, enqueue };
}
