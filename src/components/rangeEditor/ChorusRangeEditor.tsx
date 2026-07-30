"use client";

import { useEffect, useRef, useState } from "react";
import type { YouTubePlayerHandle } from "@/components/YouTubePlayer";
import { describePlaybackError } from "@/lib/youtubePlayerError";
import { formatTime } from "./timeUtils";
import VideoPreview from "./VideoPreview";
import ChorusTimeline from "./ChorusTimeline";
import ZoomTimeline from "./ZoomTimeline";
import RangeInformation from "./RangeInformation";
import PlaybackControls from "./PlaybackControls";
import FineAdjustmentControls from "./FineAdjustmentControls";
import ChorusCandidateList from "./ChorusCandidateList";
import SaveActionBar from "./SaveActionBar";
import { useRangeEditor } from "./useRangeEditor";
import { useChorusCandidates } from "./useChorusCandidates";
import type { ChorusCandidate, DurationPreset } from "./types";

export type RangeEditorResult = {
  videoId: string;
  startSeconds: number;
  endSeconds: number;
  introStartSeconds: number;
  clipDuration: number;
  videoDuration: number;
  title: string;
  artist: string;
};

type ChorusRangeEditorProps = {
  videoId: string;
  thumbnailUrl: string;
  title: string;
  artist: string;
  initialStart: number;
  initialEnd: number;
  initialIntroStart?: number;
  onCancel: () => void;
  onSaveDraft: (result: RangeEditorResult) => void;
  onUseRange: (result: RangeEditorResult) => void;
};

const PRESETS: DurationPreset[] = [5, 10, 15, 20, "free"];

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}

export default function ChorusRangeEditor({
  videoId,
  thumbnailUrl,
  title,
  artist,
  initialStart,
  initialEnd,
  initialIntroStart = 0,
  onCancel,
  onSaveDraft,
  onUseRange,
}: ChorusRangeEditorProps) {
  const playerRef = useRef<YouTubePlayerHandle>(null);
  const [duration, setDuration] = useState(0);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const editor = useRangeEditor({
    playerRef,
    duration,
    initialStart,
    initialEnd,
    initialIntroStart,
  });
  const chorus = useChorusCandidates(videoId);

  useEffect(() => {
    playerRef.current?.cueVideo(videoId);
  }, [videoId]);

  function handleStateChange(state: YT.PlayerState) {
    editor.handlePlayerStateChange(state);
    const d = playerRef.current?.getDuration() ?? 0;
    if (d > 0 && d !== duration) setDuration(d);
  }

  function handlePlaybackError(error: YT.PlayerError) {
    setPlaybackError(describePlaybackError(error));
  }

  function handleSelectCandidate(candidate: ChorusCandidate) {
    editor.setStartSeconds(candidate.startSeconds);
    editor.setEndSeconds(candidate.endSeconds);
    editor.seek(candidate.startSeconds);
  }

  function buildResult(): RangeEditorResult {
    return {
      videoId,
      startSeconds: editor.startSeconds,
      endSeconds: editor.endSeconds,
      introStartSeconds: editor.introStartSeconds,
      clipDuration: editor.endSeconds - editor.startSeconds,
      videoDuration: duration,
      title,
      artist,
    };
  }

  function handleSaveDraft() {
    setIsSaving(true);
    onSaveDraft(buildResult());
    setIsSaving(false);
  }

  function handleUseRange() {
    setIsSaving(true);
    onUseRange(buildResult());
    setIsSaving(false);
  }

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (isEditableTarget(e.target)) return;

      switch (e.key) {
        case " ":
          e.preventDefault();
          editor.togglePlayPause();
          break;
        case "ArrowLeft":
          e.preventDefault();
          editor.seek(editor.currentTime - (e.shiftKey ? 0.1 : 1));
          break;
        case "ArrowRight":
          e.preventDefault();
          editor.seek(editor.currentTime + (e.shiftKey ? 0.1 : 1));
          break;
        case "i":
        case "I":
          editor.setStartSeconds(editor.currentTime);
          break;
        case "o":
        case "O":
          editor.setEndSeconds(editor.currentTime);
          break;
        case "l":
        case "L":
          editor.playSelectionLoop();
          break;
        default:
          break;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [editor]);

  const canSave = duration > 0 && editor.endSeconds > editor.startSeconds;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-neutral-950 text-neutral-100">
      <div className="flex shrink-0 items-center justify-between border-b border-neutral-800 px-4 py-3">
        <h2 className="text-sm font-semibold">サビ範囲エディター</h2>
        <button type="button" onClick={onCancel} className="text-xs text-neutral-400 underline">
          閉じる
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
          <VideoPreview
            playerRef={playerRef}
            thumbnailUrl={thumbnailUrl}
            title={title}
            artist={artist}
            duration={duration}
            onStateChange={handleStateChange}
            onPlaybackError={handlePlaybackError}
            onSetStartHere={() => editor.setStartSeconds(editor.currentTime)}
            onSetEndHere={() => editor.setEndSeconds(editor.currentTime)}
          />
          {playbackError && <p className="text-sm text-red-400">{playbackError}</p>}

          {duration > 0 ? (
            <>
              <section className="flex flex-col gap-2">
                <h3 className="text-xs font-semibold text-neutral-400">サビ範囲タイムライン</h3>
                <ChorusTimeline
                  videoId={videoId}
                  duration={duration}
                  currentTime={editor.currentTime}
                  startSeconds={editor.startSeconds}
                  endSeconds={editor.endSeconds}
                  dragTarget={editor.dragTarget}
                  candidates={chorus.candidates}
                  onSeek={editor.seek}
                  onDragStart={editor.dragStartHandle}
                  onDragEnd={editor.dragEndHandle}
                  onMove={editor.moveSelectionTo}
                  onDragStateChange={editor.setDragTarget}
                />
              </section>

              <section className="flex flex-col gap-2">
                <h3 className="text-xs font-semibold text-neutral-400">拡大タイムライン</h3>
                <ZoomTimeline
                  duration={duration}
                  currentTime={editor.currentTime}
                  startSeconds={editor.startSeconds}
                  endSeconds={editor.endSeconds}
                  zoomWindowSeconds={editor.zoomWindowSeconds}
                  dragTarget={editor.dragTarget}
                  onSeek={editor.seek}
                  onDragStart={editor.dragStartHandle}
                  onDragEnd={editor.dragEndHandle}
                  onMove={editor.moveSelectionTo}
                  onDragStateChange={editor.setDragTarget}
                  onZoomChange={editor.setZoomWindowSeconds}
                />
              </section>

              <RangeInformation
                startSeconds={editor.startSeconds}
                endSeconds={editor.endSeconds}
                onChangeStart={editor.setStartSeconds}
                onChangeEnd={editor.setEndSeconds}
                onSetRange={editor.setRange}
              />

              <section className="flex flex-col gap-2">
                <h3 className="text-xs font-semibold text-neutral-400">微調整</h3>
                <FineAdjustmentControls
                  onAdjustStart={editor.adjustStart}
                  onAdjustEnd={editor.adjustEnd}
                />
              </section>

              <section className="flex flex-col gap-2">
                <h3 className="text-xs font-semibold text-neutral-400">
                  イントロ開始位置（無音スキップ用）
                </h3>
                <p className="text-xs text-neutral-500">
                  「イントロ」モードで出題した時、曲の頭出しに使う位置です。ロゴ表示や無音区間を飛ばしたい場合に設定してください。
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-md border border-neutral-600 px-3 py-1.5 text-sm tabular-nums text-neutral-100">
                    {formatTime(editor.introStartSeconds)}
                  </span>
                  <button
                    type="button"
                    onClick={() => editor.setIntroStartSeconds(editor.currentTime)}
                    className="rounded-md border border-emerald-500 px-3 py-1.5 text-xs text-emerald-300"
                  >
                    現在の再生位置に設定
                  </button>
                  <button
                    type="button"
                    onClick={() => editor.adjustIntroStart(-0.5)}
                    className="rounded-md border border-neutral-600 px-3 py-1.5 text-xs text-neutral-100"
                  >
                    −0.5秒
                  </button>
                  <button
                    type="button"
                    onClick={() => editor.adjustIntroStart(0.5)}
                    className="rounded-md border border-neutral-600 px-3 py-1.5 text-xs text-neutral-100"
                  >
                    +0.5秒
                  </button>
                  <button
                    type="button"
                    onClick={editor.playIntroPreview}
                    className="rounded-md border border-neutral-600 px-3 py-1.5 text-xs text-neutral-100"
                  >
                    ここから試聴
                  </button>
                </div>
              </section>

              <section className="flex flex-col gap-2">
                <h3 className="text-xs font-semibold text-neutral-400">再生確認</h3>
                <PlaybackControls
                  isPlaying={editor.isPlaying}
                  isLooping={editor.isLooping}
                  onPlaySelection={editor.playSelection}
                  onPlayLoop={editor.playSelectionLoop}
                  onPlayBeforeSelection={editor.playBeforeSelection}
                  onPlayFromStart={editor.playFromStartOpenEnded}
                  onPlayBeforeEnd={editor.playBeforeEnd}
                  onPause={editor.pausePlayback}
                />
              </section>

              <section className="flex flex-col gap-2">
                <h3 className="text-xs font-semibold text-neutral-400">クイズ用の長さ</h3>
                <div className="flex flex-wrap items-center gap-2">
                  {PRESETS.map((preset) => (
                    <button
                      key={String(preset)}
                      type="button"
                      onClick={() => editor.applyPreset(preset)}
                      className="rounded-md border border-neutral-600 px-3 py-1.5 text-xs text-neutral-100"
                    >
                      {preset === "free" ? "自由設定" : `${preset}秒`}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={editor.toggleLockDuration}
                    className={`ml-auto rounded-md border px-3 py-1.5 text-xs ${
                      editor.lockDuration
                        ? "border-amber-400 bg-amber-500/20 text-amber-200"
                        : "border-neutral-600 text-neutral-300"
                    }`}
                  >
                    {editor.lockDuration ? "選択範囲を固定中" : "選択範囲を固定"}
                  </button>
                </div>
              </section>

              <section className="flex flex-col gap-2 pb-2">
                {chorus.available && (
                  <div className="flex flex-col gap-1">
                    <button
                      type="button"
                      onClick={() => chorus.detect(editor.endSeconds - editor.startSeconds)}
                      disabled={chorus.isDetecting}
                      className="self-start rounded-md border border-amber-500/60 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {chorus.isDetecting ? "解析中…(1分ほどかかります)" : "サビを自動検出"}
                    </button>
                    {chorus.error && <p className="text-xs text-red-400">{chorus.error}</p>}
                  </div>
                )}
                <ChorusCandidateList candidates={chorus.candidates} onSelect={handleSelectCandidate} />
              </section>
            </>
          ) : (
            <p className="text-sm text-neutral-500">動画を読み込んでいます…</p>
          )}
        </div>
      </div>

      <div className="shrink-0">
        <SaveActionBar
          isSaving={isSaving}
          canSave={canSave}
          onCancel={onCancel}
          onSaveDraft={handleSaveDraft}
          onUseRange={handleUseRange}
        />
      </div>
    </div>
  );
}
