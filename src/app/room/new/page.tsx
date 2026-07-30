"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { listQuizzes, subscribeQuizzes } from "@/lib/quizStore";
import { ensureAnonymousUser } from "@/lib/auth";
import { createRoom } from "@/lib/rooms";

const EMPTY: never[] = [];

export default function NewRoomPage() {
  const router = useRouter();
  const quizzes = useSyncExternalStore(subscribeQuizzes, listQuizzes, () => EMPTY);
  const [creatingId, setCreatingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate(quizId: string, quizTitle: string) {
    setCreatingId(quizId);
    setError(null);
    try {
      const uid = await ensureAnonymousUser();
      const code = await createRoom({ quizId, quizTitle, hostId: uid });
      router.push(`/room/${code}/host`);
    } catch {
      setError("ルームの作成に失敗しました。もう一度お試しください。");
      setCreatingId(null);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-8">
      <h1 className="text-xl font-bold">ルームを作る</h1>
      <p className="text-sm text-neutral-500">どのクイズでルームを作りますか？</p>

      {quizzes.length === 0 && (
        <p className="text-sm text-neutral-500">
          クイズがまだありません。先に
          <Link href="/create" className="underline">
            クイズを作成
          </Link>
          してください。
        </p>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      <ul className="flex flex-col gap-3">
        {quizzes.map((quiz) => (
          <li
            key={quiz.id}
            className="flex items-center gap-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{quiz.title}</p>
              <p className="truncate text-xs text-neutral-500">{quiz.items.length}問</p>
            </div>
            <button
              type="button"
              onClick={() => handleCreate(quiz.id, quiz.title)}
              disabled={creatingId !== null}
              className="shrink-0 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900"
            >
              {creatingId === quiz.id ? "作成中…" : "ルームを作る"}
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
