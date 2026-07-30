import type { Quiz } from "@/lib/types";

const STORAGE_KEY = "oto-ate:quizzes";

// useSyncExternalStore requires getSnapshot to return a stable (===) reference
// when nothing changed, so reads are cached and only rebuilt on write.
let cache: Quiz[] | null = null;
let sortedCache: Quiz[] | null = null;

function readAll(): Quiz[] {
  if (typeof window === "undefined") return [];
  if (cache) return cache;

  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    cache = [];
    return cache;
  }
  try {
    cache = JSON.parse(raw) as Quiz[];
  } catch {
    cache = [];
  }
  return cache;
}

function writeAll(quizzes: Quiz[]): void {
  cache = quizzes;
  sortedCache = null;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(quizzes));
  notify();
}

const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

export function subscribeQuizzes(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function listQuizzes(): Quiz[] {
  if (!sortedCache) {
    sortedCache = [...readAll()].sort((a, b) => b.updatedAt - a.updatedAt);
  }
  return sortedCache;
}

export function getQuiz(id: string): Quiz | null {
  return readAll().find((quiz) => quiz.id === id) ?? null;
}

export function saveQuiz(quiz: Quiz): void {
  const quizzes = readAll();
  const index = quizzes.findIndex((q) => q.id === quiz.id);
  if (index === -1) {
    quizzes.push(quiz);
  } else {
    quizzes[index] = quiz;
  }
  writeAll(quizzes);
}

// Records which items were just selected for a game, without touching
// updatedAt (that's reserved for content edits, not "last played").
export function recordQuizPlay(quizId: string, itemIds: string[]): void {
  const quizzes = readAll();
  const index = quizzes.findIndex((q) => q.id === quizId);
  if (index === -1) return;
  const next = [...quizzes];
  next[index] = { ...next[index], lastPlayedItemIds: itemIds };
  writeAll(next);
}

export function deleteQuiz(id: string): void {
  writeAll(readAll().filter((quiz) => quiz.id !== id));
}
