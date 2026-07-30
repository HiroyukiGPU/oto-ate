"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { deleteQuiz, listQuizzes, subscribeQuizzes } from "@/lib/quizStore";

const EMPTY: never[] = [];

export default function QuizListPage() {
  const quizzes = useSyncExternalStore(subscribeQuizzes, listQuizzes, () => EMPTY);

  function handleDelete(id: string) {
    deleteQuiz(id);
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-8">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">自分のクイズ</h1>
        <Link
          href="/create"
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
        >
          新しく作る
        </Link>
      </div>

      {quizzes.length === 0 && (
        <p className="text-sm text-neutral-500">
          まだクイズがありません。「新しく作る」から最初のクイズを作りましょう。
        </p>
      )}

      <ul className="flex flex-col gap-3">
        {quizzes.map((quiz) => (
          <li
            key={quiz.id}
            className="flex items-center gap-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800"
          >
            <Link href={`/quiz/${quiz.id}`} className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{quiz.title}</p>
              <p className="truncate text-xs text-neutral-500">{quiz.items.length}問</p>
            </Link>
            <button
              type="button"
              onClick={() => handleDelete(quiz.id)}
              className="shrink-0 rounded-md border border-red-300 px-2 py-1 text-xs text-red-600 dark:border-red-800"
            >
              削除
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
