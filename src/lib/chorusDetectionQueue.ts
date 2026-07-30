// Module-level (not component-level) background queue for chorus detection
// of SAVED quizzes. Living at module scope — rather than inside a React
// component — is what lets it keep working across client-side navigation
// (create page -> quiz list -> a live game's host page all stay mounted
// within the same SPA session) and even resume after a reload, since
// "still needs detection" is persisted on the quiz item itself
// (QuizItem.chorusStatus) rather than only in memory.
//
// Deliberately separate from src/app/create/useAutoChorusDetection.ts, which
// still owns the in-session experience for songs not yet saved (no quizId
// to write back to yet). This queue only ever touches quizzes already in
// quizStore, so the two never race over the same in-memory draft.
import { getQuiz, listQuizzes, saveQuiz } from "@/lib/quizStore";
import { isHostMode } from "@/lib/hostMode";

type QueueEntry = { quizId: string; itemId: string; videoId: string; duration: number };

const queued = new Set<string>(); // "<quizId>:<itemId>", including ones already processed once
const queue: QueueEntry[] = [];
let running = false;

function keyFor(quizId: string, itemId: string): string {
  return `${quizId}:${itemId}`;
}

async function processEntry(entry: QueueEntry): Promise<void> {
  try {
    const res = await fetch("/api/chorus/detect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoId: entry.videoId, duration: entry.duration }),
    });
    const data = await res.json();
    const top = data?.candidates?.[0];
    if (!res.ok || !top) throw new Error(data?.error ?? "failed");

    // Re-read the quiz fresh — it may have been edited/saved again since
    // this entry was queued.
    const quiz = getQuiz(entry.quizId);
    if (!quiz) return; // deleted in the meantime
    const itemIndex = quiz.items.findIndex((item) => item.id === entry.itemId);
    if (itemIndex === -1) return; // removed in the meantime
    if (quiz.items[itemIndex].chorusStatus !== "pending") return; // no longer needs it

    const nextItems = quiz.items.slice();
    nextItems[itemIndex] = {
      ...nextItems[itemIndex],
      startSeconds: top.startSeconds,
      endSeconds: top.endSeconds,
      chorusStatus: "detected",
    };
    saveQuiz({ ...quiz, items: nextItems });
  } catch {
    const quiz = getQuiz(entry.quizId);
    if (!quiz) return;
    const itemIndex = quiz.items.findIndex((item) => item.id === entry.itemId);
    if (itemIndex === -1 || quiz.items[itemIndex].chorusStatus !== "pending") return;
    const nextItems = quiz.items.slice();
    nextItems[itemIndex] = { ...nextItems[itemIndex], chorusStatus: "failed" };
    saveQuiz({ ...quiz, items: nextItems });
  }
}

async function runQueue(): Promise<void> {
  if (running) return;
  running = true;
  while (queue.length > 0) {
    const entry = queue.shift();
    if (!entry) break;
    await processEntry(entry);
  }
  running = false;
}

function enqueue(quizId: string, itemId: string, videoId: string, duration: number): void {
  const key = keyFor(quizId, itemId);
  if (queued.has(key)) return;
  queued.add(key);
  queue.push({ quizId, itemId, videoId, duration });
  void runQueue();
}

// Scans every saved quiz for songs still awaiting detection and enqueues
// them. Safe to call repeatedly and often (every page mount, right after
// saving a quiz, etc.) — already-queued entries are skipped via `queued`, so
// repeated calls are cheap no-ops once everything pending has been picked up.
export function ensureChorusDetectionStarted(): void {
  if (!isHostMode()) return;
  for (const quiz of listQuizzes()) {
    for (const item of quiz.items) {
      if (item.chorusStatus !== "pending") continue;
      enqueue(quiz.id, item.id, item.videoId, item.endSeconds - item.startSeconds);
    }
  }
}
