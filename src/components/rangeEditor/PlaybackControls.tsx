"use client";

type PlaybackControlsProps = {
  isPlaying: boolean;
  isLooping: boolean;
  onPlaySelection: () => void;
  onPlayLoop: () => void;
  onPlayBeforeSelection: () => void;
  onPlayFromStart: () => void;
  onPlayBeforeEnd: () => void;
  onPause: () => void;
};

export default function PlaybackControls({
  isPlaying,
  isLooping,
  onPlaySelection,
  onPlayLoop,
  onPlayBeforeSelection,
  onPlayFromStart,
  onPlayBeforeEnd,
  onPause,
}: PlaybackControlsProps) {
  const buttonClass =
    "rounded-md border border-neutral-600 px-3 py-2 text-xs font-medium text-neutral-100";
  return (
    <div className="flex flex-wrap gap-2">
      <button type="button" onClick={onPlaySelection} className={buttonClass}>
        選択範囲を再生
      </button>
      <button
        type="button"
        onClick={onPlayLoop}
        className={`${buttonClass} ${isLooping ? "border-emerald-400 bg-emerald-500/20 text-emerald-200" : ""}`}
      >
        {isLooping ? "ループ再生中（解除）" : "選択範囲をループ再生"}
      </button>
      <button type="button" onClick={onPlayBeforeSelection} className={buttonClass}>
        3秒前から再生
      </button>
      <button type="button" onClick={onPlayFromStart} className={buttonClass}>
        開始位置から再生
      </button>
      <button type="button" onClick={onPlayBeforeEnd} className={buttonClass}>
        終了3秒前から再生
      </button>
      <button
        type="button"
        onClick={onPause}
        disabled={!isPlaying}
        className={`${buttonClass} disabled:opacity-40`}
      >
        一時停止
      </button>
    </div>
  );
}
