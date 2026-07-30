import Link from "next/link";

const ACTIONS = [
  { label: "クイズを作る", href: "/create", enabled: true },
  { label: "自分のクイズ", href: "/quiz", enabled: true },
  { label: "ルームを作る", href: "/room/new", enabled: true },
  { label: "ルームに参加", href: "/room/join", enabled: true },
  { label: "公開クイズを探す", href: "#", enabled: false },
  { label: "最近遊んだクイズ", href: "#", enabled: false },
];

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">おとアテ！</h1>
        <p className="text-sm text-neutral-500">
          好きな曲のサビだけで、早押し音楽クイズを作って遊べます。
        </p>
      </div>

      <nav className="flex flex-col gap-3">
        {ACTIONS.map((action) =>
          action.enabled ? (
            <Link
              key={action.label}
              href={action.href}
              className="rounded-lg bg-neutral-900 px-4 py-4 text-center text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
            >
              {action.label}
            </Link>
          ) : (
            <span
              key={action.label}
              className="cursor-not-allowed rounded-lg border border-neutral-200 px-4 py-4 text-center text-sm font-medium text-neutral-400 dark:border-neutral-800"
              title="準備中"
            >
              {action.label}（準備中）
            </span>
          ),
        )}
      </nav>
    </main>
  );
}
