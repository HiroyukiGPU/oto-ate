"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { extractPlaylistId, extractVideoId } from "@/lib/youtube";
import { fetchVideoInfo } from "@/lib/youtubeOEmbed";
import { fetchPlaylistImport } from "@/lib/youtubePlaylistImport";
import { generateId } from "@/lib/id";
import { getQuiz, saveQuiz } from "@/lib/quizStore";
import { ensureChorusDetectionStarted } from "@/lib/chorusDetectionQueue";
import ChorusRangeEditor from "@/components/rangeEditor/ChorusRangeEditor";
import { useAutoChorusDetection } from "./useAutoChorusDetection";
import type { Difficulty, Quiz, QuizItem } from "@/lib/types";
import type { PlaylistImportResult } from "@/lib/youtubePlaylistImport";
import type { RangeEditorResult } from "@/components/rangeEditor/ChorusRangeEditor";

const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  easy: "やさしい",
  normal: "ふつう",
  hard: "むずかしい",
};

const EMPTY_DRAFT = {
  urlInput: "",
  videoId: null as string | null,
  thumbnailUrl: "",
  channelTitle: "",
  duration: null as number | null,
  startSeconds: 0,
  endSeconds: 15,
  introStartSeconds: 0,
  answerTitle: "",
  answerArtist: "",
  acceptedAnswersInput: "",
  hint: "",
  difficulty: "normal" as Difficulty,
};

export default function CreateQuizPage() {
  const router = useRouter();

  const [quizTitle, setQuizTitle] = useState("");
  const [quizDescription, setQuizDescription] = useState("");
  const [items, setItems] = useState<QuizItem[]>([]);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  // The existing quiz being edited (via /create?edit=<id>), if any — kept
  // around (rather than just its id) so saving can preserve fields this form
  // doesn't surface, like createdAt and lastPlayedItemIds.
  const [editingQuiz, setEditingQuiz] = useState<Quiz | null>(null);

  useEffect(() => {
    const editId = new URLSearchParams(window.location.search).get("edit");
    if (!editId) return;
    const quiz = getQuiz(editId);
    if (!quiz) return;
    const timeout = setTimeout(() => {
      setEditingQuiz(quiz);
      setQuizTitle(quiz.title);
      setQuizDescription(quiz.description);
      setItems(quiz.items);
    }, 0);
    return () => clearTimeout(timeout);
  }, []);

  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [isLoadingVideo, setIsLoadingVideo] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedQuizTitle, setSavedQuizTitle] = useState<string | null>(null);
  const [rangeEditorOpen, setRangeEditorOpen] = useState(false);

  const [playlistResult, setPlaylistResult] = useState<PlaylistImportResult | null>(null);
  const [selectedVideoIds, setSelectedVideoIds] = useState<Set<string>>(new Set());
  const [isLoadingPlaylist, setIsLoadingPlaylist] = useState(false);
  const [playlistError, setPlaylistError] = useState<string | null>(null);

  const chorusDetection = useAutoChorusDetection((id, result) => {
    setItems((prev) =>
      prev.map((item) =>
        item.id === id
          ? result.status === "detected"
            ? {
                ...item,
                startSeconds: result.startSeconds,
                endSeconds: result.endSeconds,
                chorusStatus: "detected",
              }
            : { ...item, chorusStatus: "failed" }
          : item,
      ),
    );
  });

  const [bulkTitlesText, setBulkTitlesText] = useState("");
  const [bulkTitlesError, setBulkTitlesError] = useState<string | null>(null);
  const [bulkTitlesSuccess, setBulkTitlesSuccess] = useState(false);
  const [bulkTitlesCopied, setBulkTitlesCopied] = useState(false);

  // Room.multiSelectMode's answer key — one comma-separated line per song
  // (e.g. "初音ミク,重音テト" for a collab), mirroring the title bulk-editor
  // below. Falls back to answerArtist per song until bulk-edited here.
  const [bulkArtistsText, setBulkArtistsText] = useState("");
  const [bulkArtistsError, setBulkArtistsError] = useState<string | null>(null);
  const [bulkArtistsSuccess, setBulkArtistsSuccess] = useState(false);
  const [bulkArtistsCopied, setBulkArtistsCopied] = useState(false);

  // Keeps the bulk-edit fields showing every registered song's title/artists
  // automatically — added/removed/edited songs should always be reflected
  // here without requiring an explicit "書き出す" click first. Adjusted
  // synchronously during render (React's recommended pattern for "derive
  // state from a changed value") rather than via useEffect, since items is
  // replaced with a new array reference on every add/remove/edit.
  const [lastSyncedItems, setLastSyncedItems] = useState(items);
  if (items !== lastSyncedItems) {
    setLastSyncedItems(items);
    setBulkTitlesText(items.map((item) => item.answerTitle).join("\n"));
    setBulkTitlesError(null);
    setBulkTitlesSuccess(false);
    setBulkTitlesCopied(false);
    setBulkArtistsText(
      items.map((item) => (item.answerArtists ?? [item.answerArtist]).join(",")).join("\n"),
    );
    setBulkArtistsError(null);
    setBulkArtistsSuccess(false);
    setBulkArtistsCopied(false);
  }

  function updateDraft(patch: Partial<typeof draft>) {
    setDraft((prev) => ({ ...prev, ...patch }));
  }

  async function handleLoadUrl() {
    const videoId = extractVideoId(draft.urlInput);
    if (videoId) {
      setPlaylistResult(null);
      setPlaylistError(null);
      await loadSingleVideo(videoId);
      return;
    }

    const playlistId = extractPlaylistId(draft.urlInput);
    if (playlistId) {
      setUrlError(null);
      await loadPlaylist(playlistId);
      return;
    }

    setUrlError("YouTubeの動画URLまたはプレイリストURLを正しく入力してください");
  }

  async function loadSingleVideo(id: string) {
    setUrlError(null);
    setIsLoadingVideo(true);
    try {
      const info = await fetchVideoInfo(id);
      updateDraft({
        videoId: id,
        thumbnailUrl: info?.thumbnailUrl ?? "",
        channelTitle: info?.channelTitle ?? "",
        answerTitle: draft.answerTitle || info?.title || "",
        answerArtist: draft.answerArtist || info?.channelTitle || "",
        duration: null,
      });
      setRangeEditorOpen(true);
    } finally {
      setIsLoadingVideo(false);
    }
  }

  async function loadPlaylist(playlistId: string) {
    setIsLoadingPlaylist(true);
    setPlaylistError(null);
    try {
      const result = await fetchPlaylistImport(playlistId);
      // A playlist can itself contain the same video more than once (added
      // twice by its creator) — dedupe by videoId before showing it, on top
      // of the existing "already in this quiz" check per item below.
      const seenVideoIds = new Set<string>();
      const dedupedItems = result.items.filter((item) => {
        if (seenVideoIds.has(item.videoId)) return false;
        seenVideoIds.add(item.videoId);
        return true;
      });
      setPlaylistResult({ ...result, items: dedupedItems });
      setSelectedVideoIds(new Set());
      if (!quizTitle.trim() && result.playlistTitle) {
        setQuizTitle(result.playlistTitle);
      }
    } catch (err) {
      setPlaylistError(err instanceof Error ? err.message : "プレイリストの取得に失敗しました");
    } finally {
      setIsLoadingPlaylist(false);
    }
  }

  function toggleSelectedVideo(videoId: string) {
    setSelectedVideoIds((prev) => {
      const next = new Set(prev);
      if (next.has(videoId)) {
        next.delete(videoId);
      } else {
        next.add(videoId);
      }
      return next;
    });
  }

  function handleSelectAllPlaylistItems() {
    if (!playlistResult) return;
    setSelectedVideoIds(
      new Set(
        playlistResult.items
          .filter(
            (item) => item.embeddable && !items.some((existing) => existing.videoId === item.videoId),
          )
          .map((item) => item.videoId),
      ),
    );
  }

  function handleImportSelectedPlaylistItems() {
    if (!playlistResult) return;
    const newItems: QuizItem[] = playlistResult.items
      .filter((item) => selectedVideoIds.has(item.videoId))
      .map((item) => ({
        id: generateId(),
        videoId: item.videoId,
        title: item.title,
        channelTitle: item.channelTitle,
        thumbnailUrl: item.thumbnailUrl,
        duration: item.duration,
        startSeconds: 0,
        endSeconds: item.duration ? Math.min(15, item.duration) : 15,
        introStartSeconds: 0,
        answerTitle: item.title,
        answerArtist: item.channelTitle,
        acceptedAnswers: [],
        hint: "",
        difficulty: "normal",
        chorusStatus: "pending",
      }));
    setItems((prev) => [...prev, ...newItems]);
    setPlaylistResult(null);
    setSelectedVideoIds(new Set());
    updateDraft({ urlInput: "" });
    // Bulk-imported songs skip the per-song range editor (their start/end
    // start at a crude 0〜15秒 default), so kick off background chorus
    // detection for each one now instead — see useAutoChorusDetection.
    newItems.forEach((item) => chorusDetection.enqueue(item));
  }

  function handleRangeEditorResult(result: RangeEditorResult) {
    updateDraft({
      startSeconds: result.startSeconds,
      endSeconds: result.endSeconds,
      introStartSeconds: result.introStartSeconds,
      duration: result.videoDuration,
    });
    setRangeEditorOpen(false);
  }

  function resetDraft() {
    setDraft(EMPTY_DRAFT);
    setEditingItemId(null);
    setUrlError(null);
    setRangeError(null);
  }

  function handleAddOrUpdateItem() {
    if (!draft.videoId) {
      setUrlError("先にYouTubeのURLを読み込んでください");
      return;
    }
    if (!draft.answerTitle.trim()) {
      setRangeError("正解の曲名を入力してください");
      return;
    }
    const isDuplicate = items.some(
      (existing) => existing.videoId === draft.videoId && existing.id !== editingItemId,
    );
    if (isDuplicate) {
      setRangeError("この曲はすでに登録されています");
      return;
    }
    setRangeError(null);

    const item: QuizItem = {
      id: editingItemId ?? generateId(),
      videoId: draft.videoId,
      title: draft.answerTitle.trim(),
      channelTitle: draft.channelTitle,
      thumbnailUrl: draft.thumbnailUrl,
      duration: draft.duration,
      startSeconds: draft.startSeconds,
      endSeconds: draft.endSeconds,
      introStartSeconds: draft.introStartSeconds,
      answerTitle: draft.answerTitle.trim(),
      answerArtist: draft.answerArtist.trim(),
      acceptedAnswers: draft.acceptedAnswersInput
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      hint: draft.hint.trim(),
      difficulty: draft.difficulty,
    };

    setItems((prev) => {
      if (editingItemId) {
        return prev.map((existing) => (existing.id === editingItemId ? item : existing));
      }
      return [...prev, item];
    });

    resetDraft();
  }

  function handleEditItem(item: QuizItem) {
    setEditingItemId(item.id);
    setDraft({
      urlInput: `https://www.youtube.com/watch?v=${item.videoId}`,
      videoId: item.videoId,
      thumbnailUrl: item.thumbnailUrl,
      channelTitle: item.channelTitle,
      duration: item.duration,
      startSeconds: item.startSeconds,
      endSeconds: item.endSeconds,
      introStartSeconds: item.introStartSeconds ?? 0,
      answerTitle: item.answerTitle,
      answerArtist: item.answerArtist,
      acceptedAnswersInput: item.acceptedAnswers.join(", "),
      hint: item.hint,
      difficulty: item.difficulty,
    });
  }

  function handleRemoveItem(id: string) {
    setItems((prev) => prev.filter((item) => item.id !== id));
    if (editingItemId === id) resetDraft();
  }

  async function handleCopyBulkTitles() {
    await navigator.clipboard.writeText(bulkTitlesText);
    setBulkTitlesCopied(true);
    setTimeout(() => setBulkTitlesCopied(false), 2000);
  }

  // Maps the (presumably AI-cleaned) text back onto items by line position —
  // line 1 becomes item 1's answer, etc. Blank lines are dropped before
  // counting so a stray trailing newline doesn't cause an off-by-one
  // mismatch; the line count must still match the song count exactly so a
  // genuine mismatch (a line accidentally merged/split) can't silently
  // misassign titles to the wrong songs.
  function handleApplyBulkTitles() {
    const lines = bulkTitlesText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length !== items.length) {
      setBulkTitlesError(
        `行数（${lines.length}）が登録曲数（${items.length}）と一致しません。1曲につき1行になるよう調整してください。`,
      );
      setBulkTitlesSuccess(false);
      return;
    }
    setItems((prev) =>
      prev.map((item, index) => ({ ...item, title: lines[index], answerTitle: lines[index] })),
    );
    setBulkTitlesError(null);
    setBulkTitlesSuccess(true);
  }

  async function handleCopyBulkArtists() {
    await navigator.clipboard.writeText(bulkArtistsText);
    setBulkArtistsCopied(true);
    setTimeout(() => setBulkArtistsCopied(false), 2000);
  }

  // Room.multiSelectMode's answer key: line N's comma-separated names become
  // item N's answerArtists — same 1-line-per-song mapping and line-count
  // guard as handleApplyBulkTitles, so a merged/split line can't silently
  // assign the wrong singers to a song. Blank names between commas (e.g. a
  // trailing comma) are dropped.
  function handleApplyBulkArtists() {
    const lines = bulkArtistsText.split("\n").map((line) => line.trim());
    // Unlike titles, a blank LINE is meaningful here only if every line is
    // blank (nothing entered yet) — a genuinely blank line for one song
    // among others is almost certainly a mismatch, so only trailing blank
    // lines from a stray newline are dropped before counting.
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    if (lines.length !== items.length) {
      setBulkArtistsError(
        `行数（${lines.length}）が登録曲数（${items.length}）と一致しません。1曲につき1行になるよう調整してください。`,
      );
      setBulkArtistsSuccess(false);
      return;
    }
    const parsedLines = lines.map((line) =>
      line
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0),
    );
    if (parsedLines.some((names) => names.length === 0)) {
      setBulkArtistsError("歌手名が空の行があります。1曲につき最低1人は入力してください。");
      setBulkArtistsSuccess(false);
      return;
    }
    setItems((prev) => prev.map((item, index) => ({ ...item, answerArtists: parsedLines[index] })));
    setBulkArtistsError(null);
    setBulkArtistsSuccess(true);
  }

  function handleSaveQuiz() {
    if (!quizTitle.trim()) {
      setSaveError("クイズ名を入力してください");
      return;
    }
    if (items.length === 0) {
      setSaveError("曲を1つ以上追加してください");
      return;
    }
    setSaveError(null);

    const now = Date.now();
    const quiz: Quiz = {
      id: editingQuiz?.id ?? generateId(),
      title: quizTitle.trim(),
      description: quizDescription.trim(),
      items,
      createdAt: editingQuiz?.createdAt ?? now,
      updatedAt: now,
      ...(editingQuiz?.lastPlayedItemIds
        ? { lastPlayedItemIds: editingQuiz.lastPlayedItemIds }
        : {}),
    };
    saveQuiz(quiz);
    // Anything still "pending" (this page's own in-session detection hadn't
    // finished yet) now hands off to the background queue, which keeps
    // going even after navigating away from this page.
    ensureChorusDetectionStarted();
    setSavedQuizTitle(quiz.title);
    setTimeout(() => router.push(editingQuiz ? `/quiz/${quiz.id}` : "/quiz"), 800);
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-4 py-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-bold">{editingQuiz ? "クイズを編集" : "クイズを作る"}</h1>
        <p className="text-sm text-neutral-500">
          YouTubeのURLを読み込んで、サビ部分と正解を登録しましょう。
        </p>
      </div>

      <section className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm font-medium">
          クイズ名
          <input
            type="text"
            value={quizTitle}
            onChange={(e) => setQuizTitle(e.target.value)}
            placeholder="例：2010年代J-POPサビ当てクイズ"
            className="rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          説明（任意）
          <textarea
            value={quizDescription}
            onChange={(e) => setQuizDescription(e.target.value)}
            rows={2}
            className="rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
        </label>
      </section>

      <section className="flex flex-col gap-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="text-sm font-semibold">
          {editingItemId ? "曲を編集" : "曲を追加"}
        </h2>

        <div className="flex flex-col gap-2">
          <label htmlFor="url" className="text-sm font-medium">
            YouTube動画URL・プレイリストURL
          </label>
          <div className="flex gap-2">
            <input
              id="url"
              type="text"
              value={draft.urlInput}
              onChange={(e) => updateDraft({ urlInput: e.target.value })}
              placeholder="https://www.youtube.com/watch?v=... または /playlist?list=..."
              className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
            <button
              type="button"
              onClick={handleLoadUrl}
              disabled={isLoadingVideo || isLoadingPlaylist}
              className="shrink-0 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900"
            >
              {isLoadingVideo || isLoadingPlaylist ? "読み込み中…" : "読み込む"}
            </button>
          </div>
          {urlError && <p className="text-sm text-red-600">{urlError}</p>}
          {playlistError && <p className="text-sm text-red-600">{playlistError}</p>}
        </div>

        {playlistResult && (
          <div className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
            <div className="flex items-center justify-between gap-2">
              <p className="min-w-0 flex-1 truncate text-sm font-medium">
                {playlistResult.playlistTitle ?? "プレイリスト"}（{playlistResult.items.length}曲）
              </p>
              <button
                type="button"
                onClick={() => setPlaylistResult(null)}
                className="shrink-0 text-xs underline"
              >
                閉じる
              </button>
            </div>

            <div className="flex gap-2 text-xs">
              <button
                type="button"
                onClick={handleSelectAllPlaylistItems}
                className="rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-700"
              >
                選択可能な曲をすべて選択
              </button>
              <button
                type="button"
                onClick={() => setSelectedVideoIds(new Set())}
                className="rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-700"
              >
                選択解除
              </button>
            </div>

            <ul className="flex max-h-96 flex-col gap-1 overflow-y-auto">
              {playlistResult.items.map((item) => {
                const alreadyAdded = items.some((existing) => existing.videoId === item.videoId);
                const disabled = !item.embeddable || alreadyAdded;
                return (
                  <li
                    key={item.videoId}
                    className={`flex items-center gap-2 rounded-md border border-neutral-200 p-2 text-sm dark:border-neutral-800 ${disabled ? "opacity-40" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedVideoIds.has(item.videoId)}
                      disabled={disabled}
                      onChange={() => toggleSelectedVideo(item.videoId)}
                    />
                    {item.thumbnailUrl && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={item.thumbnailUrl}
                        alt=""
                        className="h-9 w-16 shrink-0 rounded object-cover"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate">{item.title}</p>
                      <p className="truncate text-xs text-neutral-500">
                        {item.channelTitle}
                        {!item.embeddable && "・埋め込み不可"}
                        {alreadyAdded && "・追加済み"}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>

            <button
              type="button"
              onClick={handleImportSelectedPlaylistItems}
              disabled={selectedVideoIds.size === 0}
              className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white dark:text-neutral-900"
            >
              選択した{selectedVideoIds.size}曲を追加(開始・終了位置は後で調整してください)
            </button>
          </div>
        )}

        {!playlistResult && (
          <>
            {draft.videoId && (
              <div className="flex items-center gap-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
                {draft.thumbnailUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={draft.thumbnailUrl}
                    alt=""
                    className="h-14 w-24 shrink-0 rounded object-cover"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    選択範囲：{draft.startSeconds.toFixed(1)}〜{draft.endSeconds.toFixed(1)}秒
                  </p>
                  <p className="text-xs text-neutral-500">
                    切り抜き 約{(draft.endSeconds - draft.startSeconds).toFixed(1)}秒
                    {draft.duration != null && `・動画の長さ 約${Math.round(draft.duration)}秒`}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setRangeEditorOpen(true)}
                  className="shrink-0 rounded-md border border-neutral-300 px-3 py-2 text-xs font-medium dark:border-neutral-700"
                >
                  範囲を編集
                </button>
              </div>
            )}

            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-sm font-medium">
                正解の曲名
                <input
                  type="text"
                  value={draft.answerTitle}
                  onChange={(e) => updateDraft({ answerTitle: e.target.value })}
                  className="rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm font-medium">
                正解のアーティスト名
                <input
                  type="text"
                  value={draft.answerArtist}
                  onChange={(e) => updateDraft({ answerArtist: e.target.value })}
                  className="rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm font-medium">
                別表記（カンマ区切り、任意）
                <input
                  type="text"
                  value={draft.acceptedAnswersInput}
                  onChange={(e) => updateDraft({ acceptedAnswersInput: e.target.value })}
                  placeholder="例：ヨルシカ, yorushika"
                  className="rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm font-medium">
                ヒント（任意）
                <input
                  type="text"
                  value={draft.hint}
                  onChange={(e) => updateDraft({ hint: e.target.value })}
                  className="rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm font-medium">
                難易度
                <select
                  value={draft.difficulty}
                  onChange={(e) => updateDraft({ difficulty: e.target.value as Difficulty })}
                  className="rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                >
                  {(Object.keys(DIFFICULTY_LABEL) as Difficulty[]).map((d) => (
                    <option key={d} value={d}>
                      {DIFFICULTY_LABEL[d]}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {rangeError && <p className="text-sm text-red-600">{rangeError}</p>}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleAddOrUpdateItem}
                className="flex-1 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white dark:text-neutral-900"
              >
                {editingItemId ? "この曲を更新" : "この曲を追加"}
              </button>
              {editingItemId && (
                <button
                  type="button"
                  onClick={resetDraft}
                  className="rounded-md border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700"
                >
                  編集をやめる
                </button>
              )}
            </div>
          </>
        )}
      </section>

      <section className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="text-sm font-semibold">曲名を一括編集（AIで整形）</h2>
        <p className="text-xs text-neutral-500">
          登録済みの曲名が1曲1行で自動的に表示されます。それをコピーしてAIなどに渡し、曲名だけの一覧に整形してもらってから、この欄に貼り直して「反映する」を押すと、上から順番に各曲の正解として反映されます。
        </p>
        <textarea
          value={bulkTitlesText}
          onChange={(e) => {
            setBulkTitlesText(e.target.value);
            setBulkTitlesError(null);
            setBulkTitlesSuccess(false);
          }}
          rows={8}
          placeholder="曲を登録すると、ここに曲名が自動的に表示されます"
          className="rounded-md border border-neutral-300 px-3 py-2 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-900"
        />
        {bulkTitlesError && <p className="text-sm text-red-600">{bulkTitlesError}</p>}
        {bulkTitlesSuccess && <p className="text-sm text-emerald-600">曲名を反映しました</p>}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleCopyBulkTitles}
            disabled={!bulkTitlesText.trim()}
            className="shrink-0 rounded-md border border-neutral-300 px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-40 dark:border-neutral-700"
          >
            {bulkTitlesCopied ? "コピーしました" : "コピー"}
          </button>
          <button
            type="button"
            onClick={handleApplyBulkTitles}
            disabled={!bulkTitlesText.trim() || items.length === 0}
            className="flex-1 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white dark:text-neutral-900"
          >
            反映する
          </button>
        </div>
      </section>

      <section className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="text-sm font-semibold">歌手を一括編集（複数選択モード用）</h2>
        <p className="text-xs text-neutral-500">
          「複数選択」回答モード(誰が歌っているか当てるモード)の正解を1曲1行で設定します。コラボ曲はカンマ区切りで歌手を並べてください（例：初音ミク,重音テト）。未編集の曲は通常のアーティスト名がそのまま使われます。
        </p>
        <textarea
          value={bulkArtistsText}
          onChange={(e) => {
            setBulkArtistsText(e.target.value);
            setBulkArtistsError(null);
            setBulkArtistsSuccess(false);
          }}
          rows={8}
          placeholder={"初音ミク,重音テト\n重音テト"}
          className="rounded-md border border-neutral-300 px-3 py-2 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-900"
        />
        {bulkArtistsError && <p className="text-sm text-red-600">{bulkArtistsError}</p>}
        {bulkArtistsSuccess && <p className="text-sm text-emerald-600">歌手を反映しました</p>}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleCopyBulkArtists}
            disabled={!bulkArtistsText.trim()}
            className="shrink-0 rounded-md border border-neutral-300 px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-40 dark:border-neutral-700"
          >
            {bulkArtistsCopied ? "コピーしました" : "コピー"}
          </button>
          <button
            type="button"
            onClick={handleApplyBulkArtists}
            disabled={!bulkArtistsText.trim() || items.length === 0}
            className="flex-1 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white dark:text-neutral-900"
          >
            反映する
          </button>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">登録した曲（{items.length}曲）</h2>
        {items.length === 0 && (
          <p className="text-sm text-neutral-500">まだ曲が追加されていません。</p>
        )}
        <ul className="flex flex-col gap-2">
          {items.map((item, index) => (
            <li
              key={item.id}
              role="button"
              tabIndex={0}
              onClick={() => handleEditItem(item)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  handleEditItem(item);
                }
              }}
              className={`flex cursor-pointer items-center gap-3 rounded-md border p-2 transition-colors hover:border-neutral-400 dark:hover:border-neutral-500 ${
                editingItemId === item.id
                  ? "border-emerald-500 dark:border-emerald-500"
                  : "border-neutral-200 dark:border-neutral-800"
              }`}
            >
              <span className="w-5 text-center text-xs text-neutral-400">{index + 1}</span>
              {item.thumbnailUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={item.thumbnailUrl}
                  alt=""
                  className="h-12 w-20 shrink-0 rounded object-cover"
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{item.answerTitle}</p>
                <p className="truncate text-xs text-neutral-500">
                  {item.answerArtists && item.answerArtists.length > 1
                    ? item.answerArtists.join("・")
                    : item.answerArtist || item.channelTitle}{" "}
                  ・ {item.startSeconds}〜{item.endSeconds}秒
                  {chorusDetection.status[item.id] === "detecting" && (
                    <span className="ml-2 text-amber-500">サビ解析中…</span>
                  )}
                  {chorusDetection.status[item.id] === "done" && (
                    <span className="ml-2 text-emerald-500">サビ検出済み</span>
                  )}
                  {chorusDetection.status[item.id] === "error" && (
                    <span className="ml-2 text-red-500">サビ自動検出に失敗(手動で調整してください)</span>
                  )}
                  {item.embedBlocked && (
                    <span className="ml-2 text-red-500">埋め込み不可(出題されません)</span>
                  )}
                </p>
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleRemoveItem(item.id);
                }}
                className="shrink-0 rounded-md border border-red-300 px-2 py-1 text-xs text-red-600 dark:border-red-800"
              >
                削除
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-2 border-t border-neutral-200 pt-6 dark:border-neutral-800">
        {saveError && <p className="text-sm text-red-600">{saveError}</p>}
        {savedQuizTitle && (
          <p className="text-sm text-emerald-600">「{savedQuizTitle}」を保存しました</p>
        )}
        <button
          type="button"
          onClick={handleSaveQuiz}
          className="rounded-md bg-emerald-600 px-4 py-3 text-sm font-medium text-white"
        >
          {editingQuiz ? "変更を保存" : "クイズを保存"}
        </button>
      </section>

      {rangeEditorOpen && draft.videoId && (
        <ChorusRangeEditor
          videoId={draft.videoId}
          thumbnailUrl={draft.thumbnailUrl}
          title={draft.answerTitle}
          artist={draft.answerArtist}
          initialStart={draft.startSeconds}
          initialEnd={draft.endSeconds}
          initialIntroStart={draft.introStartSeconds}
          onCancel={() => setRangeEditorOpen(false)}
          onSaveDraft={handleRangeEditorResult}
          onUseRange={handleRangeEditorResult}
        />
      )}
    </main>
  );
}
