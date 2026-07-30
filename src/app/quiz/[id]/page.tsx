"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { deleteQuiz, getQuiz, subscribeQuizzes } from "@/lib/quizStore";
import { ensureAnonymousUser } from "@/lib/auth";
import { createRoom } from "@/lib/rooms";

export default function QuizDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [isCreatingRoom, setIsCreatingRoom] = useState(false);
  const [roomError, setRoomError] = useState<string | null>(null);
  const quiz = useSyncExternalStore(
    subscribeQuizzes,
    () => getQuiz(params.id),
    () => undefined,
  );

  function handleDelete() {
    if (!quiz) return;
    deleteQuiz(quiz.id);
    router.push("/quiz");
  }

  async function handleCreateRoom() {
    if (!quiz) return;
    setIsCreatingRoom(true);
    setRoomError(null);
    try {
      const uid = await ensureAnonymousUser();
      const code = await createRoom({ quizId: quiz.id, quizTitle: quiz.title, hostId: uid });
      router.push(`/room/${code}/host`);
    } catch {
      setRoomError("ルームの作成に失敗しました。もう一度お試しください。");
      setIsCreatingRoom(false);
    }
  }

  if (quiz === undefined) {
    return (
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-8">
        <p className="text-sm text-neutral-500">読み込み中…</p>
      </main>
    );
  }

  if (quiz === null) {
    return (
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-8">
        <p className="text-sm text-neutral-500">クイズが見つかりませんでした。</p>
        <Link href="/quiz" className="text-sm underline">
          一覧に戻る
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-8">
      <div className="flex flex-col gap-1">
        <Link href="/quiz" className="text-xs text-neutral-500 underline">
          ← 一覧に戻る
        </Link>
        <h1 className="text-xl font-bold">{quiz.title}</h1>
        {quiz.description && <p className="text-sm text-neutral-500">{quiz.description}</p>}
      </div>

      <ul className="flex flex-col gap-2">
        {quiz.items.map((item, index) => (
          <li
            key={item.id}
            className="flex items-center gap-3 rounded-md border border-neutral-200 p-2 dark:border-neutral-800"
          >
            <span className="w-5 text-center text-xs text-neutral-400">{index + 1}</span>
            {item.thumbnailUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={item.thumbnailUrl} alt="" className="h-12 w-20 shrink-0 rounded object-cover" />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{item.answerTitle}</p>
              <p className="truncate text-xs text-neutral-500">
                {item.answerArtist || item.channelTitle} ・ {item.startSeconds}〜{item.endSeconds}秒
              </p>
            </div>
          </li>
        ))}
      </ul>

      {roomError && <p className="text-sm text-red-600">{roomError}</p>}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={handleCreateRoom}
          disabled={isCreatingRoom}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900"
        >
          {isCreatingRoom ? "作成中…" : "このクイズでルームを作る"}
        </button>
        <Link
          href={`/create?edit=${quiz.id}`}
          className="rounded-md border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700"
        >
          編集する
        </Link>
        <button
          type="button"
          onClick={handleDelete}
          className="rounded-md border border-red-300 px-4 py-2 text-sm text-red-600 dark:border-red-800"
        >
          このクイズを削除
        </button>
      </div>
    </main>
  );
}
