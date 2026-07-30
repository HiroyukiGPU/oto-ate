"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ensureAnonymousUser } from "@/lib/auth";
import { joinRoom, roomExists } from "@/lib/rooms";

export default function JoinRoomPage() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [isJoining, setIsJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // window.location is only available post-hydration; seeding this from a
    // lazy useState initializer would mismatch the server-rendered markup.
    const params = new URLSearchParams(window.location.search);
    const codeParam = params.get("code");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (codeParam) setCode(codeParam.replace(/\D/g, "").slice(0, 6));
  }, []);

  async function handleJoin() {
    const trimmedCode = code.trim();
    const trimmedName = name.trim();

    if (!/^\d{6}$/.test(trimmedCode)) {
      setError("6桁のルームコードを入力してください");
      return;
    }
    if (!trimmedName) {
      setError("名前を入力してください");
      return;
    }

    setIsJoining(true);
    setError(null);
    try {
      const uid = await ensureAnonymousUser();
      const exists = await roomExists(trimmedCode);
      if (!exists) {
        setError("そのルームコードは見つかりませんでした");
        return;
      }
      await joinRoom(trimmedCode, uid, trimmedName);
      router.push(`/room/${trimmedCode}/player`);
    } catch {
      setError("参加に失敗しました。もう一度お試しください。");
    } finally {
      setIsJoining(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-10">
      <h1 className="text-xl font-bold">ルームに参加</h1>

      <label className="flex flex-col gap-1 text-sm font-medium">
        ルームコード（6桁）
        <input
          type="text"
          inputMode="numeric"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          placeholder="123456"
          className="rounded-md border border-neutral-300 px-3 py-3 text-center text-2xl tracking-widest dark:border-neutral-700 dark:bg-neutral-900"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm font-medium">
        名前
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="ニックネーム"
          maxLength={20}
          className="rounded-md border border-neutral-300 px-3 py-3 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
      </label>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <button
        type="button"
        onClick={handleJoin}
        disabled={isJoining}
        className="rounded-md bg-neutral-900 px-4 py-4 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900"
      >
        {isJoining ? "参加中…" : "参加する"}
      </button>
    </main>
  );
}
