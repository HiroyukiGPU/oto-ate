import { useCallback, useState } from "react";
import { isHostMode } from "@/lib/hostMode";
import type { ChorusCandidate } from "./types";

type ChorusDetectionState = {
  candidates: ChorusCandidate[];
  isDetecting: boolean;
  error: string | null;
};

const IDLE_STATE: ChorusDetectionState = { candidates: [], isDetecting: false, error: null };

// Audio-analysis-based chorus detection: calls /api/chorus/detect, which
// only works on the LAN host machine (server/chorus/detect_chorus.py needs
// python3/yt-dlp/librosa/ffmpeg installed there) — see src/lib/hostMode.ts.
// `available` lets callers hide the trigger UI entirely on the normal
// deployed site, where the API route 404s unconditionally.
export function useChorusCandidates(videoId: string) {
  const [state, setState] = useState<ChorusDetectionState>(IDLE_STATE);
  // Reset synchronously during render when a different song loads (React's
  // recommended "adjusting state when a prop changes" pattern), rather than
  // via useEffect — avoids an extra render pass showing the previous song's
  // stale candidates for one frame.
  const [trackedVideoId, setTrackedVideoId] = useState(videoId);
  if (videoId !== trackedVideoId) {
    setTrackedVideoId(videoId);
    setState(IDLE_STATE);
  }

  const detect = useCallback(
    async (chorusDurationSeconds?: number) => {
      setState({ candidates: [], isDetecting: true, error: null });
      try {
        const res = await fetch("/api/chorus/detect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ videoId, duration: chorusDurationSeconds }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data?.error ?? "サビの自動検出に失敗しました");
        }
        setState({ candidates: data.candidates ?? [], isDetecting: false, error: null });
      } catch (err) {
        setState({
          candidates: [],
          isDetecting: false,
          error: err instanceof Error ? err.message : "サビの自動検出に失敗しました",
        });
      }
    },
    [videoId],
  );

  return { ...state, detect, available: isHostMode() };
}
