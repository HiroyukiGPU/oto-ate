"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ensureAnonymousUser } from "@/lib/auth";
import {
  ANSWER_TIME_LIMIT_MS,
  DEFAULT_BUZZ_LOCKOUT_MS,
  buzzIn,
  leaveRoom,
  markPlayerConnected,
  resolveEveryoneSpellingStep,
  submitChoice,
  submitEveryoneChoice,
  submitEveryoneMultiChoice,
  submitEveryoneSpellingChoice,
  submitMultiChoice,
  subscribeGame,
  subscribePlayer,
  subscribePlayers,
  subscribeRoom,
  subscribeRound,
} from "@/lib/rooms";
import type { Game, Player, Room, Round } from "@/lib/types";

// Room.multiSelectMode: checkbox-style picker shared by the buzzer/order
// "you have the floor" screen and the everyone-mode self-answer screen —
// unlike single-select's tap-to-submit, multiple choices can be right (a
// collab), so picks accumulate locally until the player explicitly submits.
function MultiChoiceSelector({
  choices,
  picked,
  onToggle,
  onSubmit,
}: {
  choices: string[];
  picked: number[];
  onToggle: (index: number) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="flex w-full max-w-sm flex-col gap-3">
      {choices.map((choice, index) => {
        const isPicked = picked.includes(index);
        return (
          <button
            key={index}
            type="button"
            onClick={() => onToggle(index)}
            className={`rounded-lg border-2 px-4 py-4 text-base font-medium shadow active:scale-95 ${
              isPicked
                ? "border-emerald-500 bg-emerald-50 text-emerald-900"
                : "border-transparent bg-white text-neutral-900"
            }`}
          >
            {isPicked ? "☑" : "☐"} {choice}
          </button>
        );
      })}
      <button
        type="button"
        onClick={onSubmit}
        disabled={picked.length === 0}
        className="rounded-lg border-2 border-white px-4 py-3 text-base font-bold text-white disabled:opacity-40"
      >
        決定（{picked.length}件選択中）
      </button>
    </div>
  );
}

// Renders the word being spelled out: confirmed characters so far, then a
// blank tile per remaining character — never reveals characters beyond what
// the player has actually confirmed.
function SpellingProgressDisplay({
  confirmedChars,
  totalLength,
}: {
  confirmedChars: string[];
  totalLength: number;
}) {
  const tiles = Array.from({ length: totalLength }, (_, i) => confirmedChars[i] ?? "＿");
  return (
    <p className="flex flex-wrap justify-center gap-2 text-3xl font-bold tracking-wide">
      {tiles.map((tile, i) => (
        <span key={i} className="inline-block min-w-[1.5rem]">
          {tile}
        </span>
      ))}
    </p>
  );
}

export default function PlayerRoomPage() {
  const params = useParams<{ code: string }>();
  const router = useRouter();
  const code = params.code;

  const [uid, setUid] = useState<string | null>(null);
  const [room, setRoom] = useState<Room | null | undefined>(undefined);
  const [me, setMe] = useState<Player | null | undefined>(undefined);
  const [players, setPlayers] = useState<Player[]>([]);
  const [round, setRound] = useState<Round | null>(null);
  const [game, setGame] = useState<Game | null>(null);
  const [hasBuzzedAt, setHasBuzzedAt] = useState<number | null>(null);
  const [answerCountdown, setAnswerCountdown] = useState<number | null>(null);
  const [liveElapsedMs, setLiveElapsedMs] = useState<number | null>(null);
  const [gameStartCountdown, setGameStartCountdown] = useState<number | null>(null);
  // Room.multiSelectMode: this player's LOCAL in-progress picks before they
  // hit "決定" — never written to round until submit, so a half-finished
  // selection is never visible to anyone else.
  const [multiSelectPicked, setMultiSelectPicked] = useState<number[]>([]);
  // Tracks round.choices so multiSelectPicked can be cleared the moment a
  // NEW question's choices arrive — adjusted during render (not an effect)
  // per this codebase's usual pattern for "reset local state when a prop
  // changes". round.choices is only ever rewritten once per question (see
  // prepareQuestion in src/lib/rooms.ts), so this never fires mid-question.
  const [prevChoicesForMultiSelect, setPrevChoicesForMultiSelect] = useState(round?.choices);
  if (round?.choices !== prevChoicesForMultiSelect) {
    setPrevChoicesForMultiSelect(round?.choices);
    setMultiSelectPicked([]);
  }
  const connectedMarkedRef = useRef(false);
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const liveElapsedIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const buzzTriggeredAtRef = useRef<number | null>(null);

  useEffect(() => {
    ensureAnonymousUser().then(setUid);
  }, []);

  useEffect(() => subscribeRoom(code, setRoom), [code]);
  useEffect(() => subscribePlayers(code, setPlayers), [code]);
  useEffect(() => subscribeRound(code, setRound), [code]);
  useEffect(() => subscribeGame(code, setGame), [code]);

  useEffect(() => {
    if (!uid) return;
    return subscribePlayer(code, uid, setMe);
  }, [code, uid]);

  useEffect(() => {
    if (me === null) {
      router.replace(`/room/join?code=${code}`);
    }
  }, [me, code, router]);

  useEffect(() => {
    if (!uid || !me || connectedMarkedRef.current) return;
    connectedMarkedRef.current = true;
    markPlayerConnected(code, uid);
  }, [uid, me, code]);

  useEffect(() => {
    const isMeWinner = round?.winnerId != null && round.winnerId === uid;
    // "order" mode has no time limit — a slow-but-correct answer should
    // never lose a race against an auto-timeout, so don't even show a
    // countdown that implies one exists.
    if (
      !isMeWinner ||
      round?.selectedChoice != null ||
      round?.selectedChoices != null ||
      room?.mode === "order"
    ) {
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current);
        countdownIntervalRef.current = null;
      }
      return;
    }
    const deadline = Date.now() + ANSWER_TIME_LIMIT_MS;
    const tick = () => {
      setAnswerCountdown(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    };
    // Fire the first tick on a macrotask rather than waiting for the first
    // 200ms interval — otherwise the countdown (and the choice buttons below
    // it) pop into the layout well after this screen first paints, right in
    // the window where a fast tap could land.
    const immediateTickTimeout = setTimeout(tick, 0);
    countdownIntervalRef.current = setInterval(tick, 200);
    return () => {
      clearTimeout(immediateTickTimeout);
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current);
        countdownIntervalRef.current = null;
      }
    };
  }, [round?.winnerId, round?.selectedChoice, round?.selectedChoices, uid, room?.mode]);

  // Ticks the synced "3, 2, 1" pre-game countdown (host-driven, see
  // room.countdownEndsAt) before the very first question starts.
  useEffect(() => {
    const endsAt = room?.countdownEndsAt;
    const tick = () => {
      setGameStartCountdown(endsAt == null ? null : Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)));
    };
    const immediateTickTimeout = setTimeout(tick, 0);
    const tickInterval = endsAt == null ? null : setInterval(tick, 200);
    return () => {
      clearTimeout(immediateTickTimeout);
      if (tickInterval) clearInterval(tickInterval);
    };
  }, [room?.countdownEndsAt]);


  // Ticks a live stopwatch while this player can still buzz, so they can see
  // how much time has passed. Anchored to questionStartedAt (set once per
  // question) rather than openedAt (which restarts every time someone else
  // buzzes in and gets it wrong) — otherwise a waiting player's timer would
  // keep jumping back to 0 for wrong answers that have nothing to do with
  // them, even though the clip itself never stopped playing.
  useEffect(() => {
    const questionStartedAt = round?.questionStartedAt ?? null;
    const canStillBuzz =
      round?.phase === "open" &&
      round.winnerId == null &&
      hasBuzzedAt !== round.openedAt &&
      me?.canAnswer !== false &&
      me?.banned !== true;
    if (!canStillBuzz || questionStartedAt === null) {
      if (liveElapsedIntervalRef.current) {
        clearInterval(liveElapsedIntervalRef.current);
        liveElapsedIntervalRef.current = null;
      }
      return;
    }
    liveElapsedIntervalRef.current = setInterval(() => {
      setLiveElapsedMs(Date.now() - questionStartedAt);
    }, 50);
    return () => {
      if (liveElapsedIntervalRef.current) {
        clearInterval(liveElapsedIntervalRef.current);
        liveElapsedIntervalRef.current = null;
      }
    };
  }, [
    round?.phase,
    round?.winnerId,
    round?.openedAt,
    round?.questionStartedAt,
    hasBuzzedAt,
    me?.canAnswer,
    me?.banned,
  ]);

  function handleLeave() {
    if (!uid) return;
    if (!window.confirm("ルームを退出しますか？")) return;
    leaveRoom(code, uid);
    router.push("/");
  }

  function handleBuzz() {
    if (!uid || !round || round.openedAt == null) return;
    // Guards against firing twice for the same round-open window — this
    // fires on pointerdown (the rising edge of the press) rather than click
    // (which only fires after release), and is also wired to keydown for
    // keyboard users, so a fast tap-and-hold or a stray double-event
    // shouldn't send a second buzzIn() for the same press.
    if (buzzTriggeredAtRef.current === round.openedAt) return;
    // Ignore presses that land before the host-configured lockout window has
    // elapsed — see Room.buzzLockoutMs for why.
    const lockoutMs = room?.buzzLockoutMs ?? DEFAULT_BUZZ_LOCKOUT_MS;
    if (Date.now() - round.openedAt < lockoutMs) return;
    buzzTriggeredAtRef.current = round.openedAt;
    setHasBuzzedAt(round.openedAt);
    const reactionMs = Date.now() - round.openedAt;
    buzzIn(code, uid, reactionMs);
  }

  // "order" mode's reaction clock runs from turnStartedAt (when the turn was
  // handed to this player), not from a buzz — buzzer mode already records
  // its reaction time at buzz-in, so reactionMs stays undefined there.
  async function handleSelectChoice(index: number, reactionMs?: number) {
    // "order" mode lets multiple players answer the same question in turn,
    // so unlike buzzer mode's single winnerId, correctness at reveal time
    // needs each player's own pick recorded — same submissions record
    // "everyone" mode already uses for exactly that purpose. Awaited BEFORE
    // submitChoice (which is what the host reacts to) so a slow submissions
    // write can never land after the host's already moved on to the next
    // turn or revealed the answer — which would otherwise leave this player
    // permanently missing from the "who answered correctly" list.
    if (room?.mode === "order" && uid) {
      await submitEveryoneChoice(code, uid, index);
    }
    submitChoice(code, index, reactionMs);
  }

  function handleSelectEveryoneChoice(index: number) {
    if (!uid) return;
    submitEveryoneChoice(code, uid, index);
  }

  function handleSelectEveryoneSpellingChoice(index: number) {
    if (!uid) return;
    submitEveryoneSpellingChoice(code, uid, index);
  }

  function toggleMultiSelectPick(index: number) {
    setMultiSelectPicked((prev) =>
      prev.includes(index) ? prev.filter((i) => i !== index) : [...prev, index],
    );
  }

  // Room.multiSelectMode, buzzer/order: mirrors handleSelectChoice's "order"
  // mode also needing its own per-turn submissions record (see there for
  // why), just with the whole picked SET instead of a single index.
  async function handleSubmitMultiChoice(reactionMs?: number) {
    if (room?.mode === "order" && uid) {
      await submitEveryoneMultiChoice(code, uid, multiSelectPicked);
    }
    submitMultiChoice(code, multiSelectPicked, reactionMs);
  }

  function handleSubmitEveryoneMultiChoice() {
    if (!uid) return;
    submitEveryoneMultiChoice(code, uid, multiSelectPicked);
  }

  // "最後まで"(EveryoneTimeMode "full") mode's escape hatch: without this, a
  // player who doesn't know the answer and never taps anything would leave
  // the round open forever (see the host's allFinished auto-close effect,
  // which needs every eligible player to submit OR skip). Submitting an
  // empty/-1 pick can never accidentally match a real correct answer (see
  // RoundSubmission.choiceIndices/EveryoneSpellingEntry).
  function handleSkipEveryoneChoice() {
    if (!uid) return;
    if (room?.multiSelectMode) {
      submitEveryoneMultiChoice(code, uid, []);
    } else {
      submitEveryoneChoice(code, uid, -1);
    }
  }

  function handleSkipEveryoneSpelling() {
    if (!uid) return;
    resolveEveryoneSpellingStep(code, uid, { failed: true });
  }

  if (room === undefined || me === undefined || me === null) {
    return (
      <main className="flex min-h-dvh flex-1 flex-col items-center justify-center gap-3 px-4">
        <p className="text-sm text-neutral-500">読み込み中…</p>
      </main>
    );
  }

  if (room === null) {
    return (
      <main className="flex min-h-dvh flex-1 flex-col items-center justify-center gap-3 px-4">
        <p className="text-sm text-neutral-500">ルームが見つかりませんでした。</p>
      </main>
    );
  }

  if (room.status === "finished") {
    const ranking = [...players].sort((a, b) => b.score - a.score);
    const myRank = ranking.findIndex((p) => p.id === uid) + 1;
    return (
      <main className="flex min-h-dvh flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
        <p className="text-sm text-neutral-500">結果発表</p>
        <p className="text-3xl font-bold">{myRank}位</p>
        <ol className="flex w-full max-w-xs flex-col gap-2 text-left">
          {ranking.map((player, index) => (
            <li
              key={player.id}
              className={`flex items-center gap-3 rounded-md border p-2 ${player.id === uid ? "border-emerald-500" : "border-neutral-200 dark:border-neutral-800"}`}
            >
              <span className="w-5 text-center text-xs text-neutral-400">
                {index === 0 ? "🏆" : index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{player.name}</p>
                <p className="text-xs text-neutral-500">正解 {player.correctCount}問</p>
              </div>
              <span className="shrink-0 text-sm font-bold">{player.score}点</span>
            </li>
          ))}
        </ol>
        <button
          type="button"
          onClick={handleLeave}
          className="rounded-md border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700"
        >
          ホームに戻る
        </button>
      </main>
    );
  }

  const isEveryoneMode = room.mode === "everyone";
  const iWon = round?.winnerId != null && round.winnerId === uid;
  const someoneElseWon = round?.winnerId != null && round.winnerId !== uid;
  const winnerName = someoneElseWon ? players.find((p) => p.id === round?.winnerId)?.name : null;
  const isBanned = me.banned === true;
  const isLockedOut = me.canAnswer === false || isBanned;
  const canBuzz =
    round?.phase === "open" &&
    round.winnerId == null &&
    hasBuzzedAt !== round.openedAt &&
    !isLockedOut;
  const mySubmission = uid && round?.submissions ? round.submissions[uid] : undefined;
  const iAlreadySubmitted = mySubmission !== undefined;
  const isOrderMode = room.mode === "order";
  const isSpellingMode = room.answerMode === "spelling";
  // "everyone" mode + 文字当て only: this player's own private progress,
  // independent of everyone else's (see EveryoneSpellingEntry).
  const mySpelling = uid && round?.everyoneSpelling ? round.everyoneSpelling[uid] : undefined;
  const mySpellingFinished = mySpelling ? mySpelling.failed || mySpelling.completedAt != null : false;
  // Ranked using room.publicScores (only ever written by the host at a
  // question's start or its official reveal) rather than the live,
  // continuously-updating player scores — so nobody watching a waiting
  // screen can see a score change and infer right/wrong before the reveal.
  const publicRanking = [...players]
    .map((p) => ({ ...p, score: room.publicScores?.[p.id] ?? p.score }))
    .sort((a, b) => b.score - a.score);

  if (game?.phase === "revealed" && game.answer) {
    // game.correctPlayerIds is the host's own authoritative record of who
    // got THIS question right (set at reveal time) — using it directly
    // means this doesn't need its own per-mode re-derivation (and doesn't
    // inherit the buzzer-mode edge case a plain `iWon` check would: if
    // everyone who buzzed in got it wrong, round.winnerId is left pointing
    // at the last WRONG answerer, not blanked out).
    const correctPlayerIds = game.correctPlayerIds ?? [];
    const gotItRight = !!uid && correctPlayerIds.includes(uid);
    const correctNames = correctPlayerIds
      .map((id) => players.find((p) => p.id === id)?.name)
      .filter((name): name is string => !!name);
    return (
      <main className="flex min-h-dvh flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        {gotItRight && <p className="text-lg font-bold text-emerald-600">🎉 正解できました！</p>}
        <p className="text-sm text-neutral-500">正解</p>
        <p className="text-2xl font-bold">{game.answer.title}</p>
        <p className="text-base text-neutral-500">{game.answer.artist}</p>
        <p className="text-sm text-neutral-500">
          {correctNames.length > 0 ? `正解者：${correctNames.join("、")}` : "誰も正解できませんでした"}
        </p>
      </main>
    );
  }

  // The host confirms real audible playback (see waitForAudibleStart in
  // src/app/room/[code]/host/page.tsx) before round.phase becomes "open" —
  // so nobody sees buzz/choice buttons before they could actually hear
  // anything, without needing a guessed fixed delay.
  if (round?.phase === "loading") {
    return (
      <main className="flex min-h-dvh flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-sm text-neutral-500">まもなく開始します…</p>
      </main>
    );
  }

  if (isEveryoneMode && isSpellingMode) {
    if (round?.phase === "open" && mySpelling && !mySpellingFinished && !isBanned) {
      return (
        <main className="flex min-h-dvh flex-1 flex-col items-center justify-center gap-4 bg-neutral-900 px-6 py-10 text-center text-white">
          <SpellingProgressDisplay
            confirmedChars={mySpelling.confirmedChars}
            totalLength={mySpelling.totalLength}
          />
          <p className="text-sm">{me.name}さん、次の文字を選んでください</p>
          <div className="flex w-full max-w-sm flex-col gap-3">
            {mySpelling.choices.map((choice, index) => (
              <button
                key={index}
                type="button"
                onClick={() => handleSelectEveryoneSpellingChoice(index)}
                className="rounded-lg bg-white px-4 py-4 text-base font-medium text-neutral-900 shadow active:scale-95"
              >
                {choice}
              </button>
            ))}
            <button
              type="button"
              onClick={handleSkipEveryoneSpelling}
              className="rounded-lg border border-white/40 px-4 py-3 text-sm text-white/80"
            >
              わからない（スキップ）
            </button>
          </div>
        </main>
      );
    }

    if (mySpellingFinished) {
      return (
        <main className="flex min-h-dvh flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <p className="text-2xl font-bold">回答しました</p>
          <p className="text-sm text-neutral-500">他の人の回答をお待ちください…</p>
        </main>
      );
    }

    if (isBanned) {
      return (
        <main className="flex min-h-dvh flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <p className="text-base">主催者により回答が禁止されています</p>
        </main>
      );
    }
  } else if (isEveryoneMode) {
    if (round?.phase === "open" && round.choices && !iAlreadySubmitted && !isBanned) {
      return (
        <main className="flex min-h-dvh flex-1 flex-col items-center justify-center gap-4 bg-neutral-900 px-6 py-10 text-center text-white">
          <p className="text-sm">
            {me.name}さん、{room.multiSelectMode ? "歌手を選んでください（複数可）" : "答えを選んでください"}
          </p>
          {room.multiSelectMode ? (
            <MultiChoiceSelector
              choices={round.choices}
              picked={multiSelectPicked}
              onToggle={toggleMultiSelectPick}
              onSubmit={handleSubmitEveryoneMultiChoice}
            />
          ) : (
            <div className="flex w-full max-w-sm flex-col gap-3">
              {round.choices.map((choice, index) => (
                <button
                  key={index}
                  type="button"
                  onClick={() => handleSelectEveryoneChoice(index)}
                  className="rounded-lg bg-white px-4 py-4 text-base font-medium text-neutral-900 shadow active:scale-95"
                >
                  {choice}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={handleSkipEveryoneChoice}
            className="rounded-lg border border-white/40 px-4 py-3 text-sm text-white/80"
          >
            わからない（スキップ）
          </button>
        </main>
      );
    }

    if (iAlreadySubmitted) {
      return (
        <main className="flex min-h-dvh flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <p className="text-2xl font-bold">回答しました</p>
          <p className="text-sm text-neutral-500">他の人の回答をお待ちください…</p>
        </main>
      );
    }

    if (isBanned) {
      return (
        <main className="flex min-h-dvh flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <p className="text-base">主催者により回答が禁止されています</p>
        </main>
      );
    }
  } else {
    // 文字当て: round.selectedChoice cycles null → picked-index → null again
    // on EVERY correct character (see advanceSpellingStep in
    // src/lib/rooms.ts), not just once per question — gating this screen on
    // "selectedChoice == null" would flash the "回答しました" screen below
    // for a moment after every single correct pick. Whether this player
    // still holds the floor (canAnswer) is the stable signal here instead.
    if (
      iWon &&
      round.choices &&
      (isSpellingMode && round.spelling
        ? me.canAnswer !== false
        : room.multiSelectMode
          ? round.selectedChoices == null
          : round.selectedChoice == null)
    ) {
      return (
        <main className="flex min-h-dvh flex-1 flex-col items-center justify-center gap-4 bg-emerald-600 px-6 py-10 text-center text-white">
          <p className="text-2xl font-bold">{isOrderMode ? "あなたの番です！" : "回答権獲得！"}</p>
          {/* No ranking and no winnerReactionMs on this screen: this is the
              "button" screen (choice buttons below). Ranking now lives on
              the waiting screens instead — showing it here would also risk
              popping in after the fact (winnerReactionMs/scores arrive via a
              separate, later network write) and shifting the buttons right
              as a tap can land. */}
          {answerCountdown !== null && (
            <p className="text-5xl font-bold tabular-nums">{answerCountdown}</p>
          )}
          {isSpellingMode && round.spelling && (
            <SpellingProgressDisplay
              confirmedChars={round.spelling.confirmedChars}
              totalLength={round.spelling.totalLength}
            />
          )}
          <p className="text-sm">
            {me.name}さん、
            {isSpellingMode
              ? "次の文字を選んでください"
              : room.multiSelectMode
                ? "歌手を選んでください（複数可）"
                : "答えを選んでください"}
          </p>
          {room.multiSelectMode ? (
            <MultiChoiceSelector
              choices={round.choices}
              picked={multiSelectPicked}
              onToggle={toggleMultiSelectPick}
              onSubmit={() => {
                const reactionMs =
                  round?.turnStartedAt != null ? Date.now() - round.turnStartedAt : undefined;
                handleSubmitMultiChoice(reactionMs);
              }}
            />
          ) : (
            <div className="flex w-full max-w-sm flex-col gap-3">
              {round.choices.map((choice, index) => (
                <button
                  key={index}
                  type="button"
                  onClick={() => {
                    const reactionMs =
                      round?.turnStartedAt != null ? Date.now() - round.turnStartedAt : undefined;
                    handleSelectChoice(index, reactionMs);
                  }}
                  className="rounded-lg bg-white px-4 py-4 text-base font-medium text-emerald-700 shadow active:scale-95"
                >
                  {choice}
                </button>
              ))}
            </div>
          )}
        </main>
      );
    }

    if (iWon) {
      return (
        <main className="flex min-h-dvh flex-1 flex-col items-center justify-center gap-4 bg-emerald-600 px-6 text-center text-white">
          <p className="text-2xl font-bold">回答しました</p>
          {round.winnerReactionMs != null && (
            <p className="text-xs opacity-80">
              {(round.winnerReactionMs / 1000).toFixed(2)}秒で
              {isOrderMode ? "回答しました" : "押しました"}
            </p>
          )}
          <p className="text-sm">判定をお待ちください…</p>
        </main>
      );
    }
  }

  return (
    <main className="relative flex min-h-dvh flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
      <button
        type="button"
        onClick={handleLeave}
        className="absolute right-4 top-4 rounded-md border border-neutral-300 px-3 py-1.5 text-xs dark:border-neutral-700"
      >
        退出する
      </button>

      <p className="text-sm text-neutral-500">{room.quizTitle}</p>
      <div className="flex flex-col gap-1">
        <p className="text-2xl font-bold">{me.name}</p>
        <p className="text-sm text-neutral-500">として参加中</p>
      </div>

      {room.hostConnected === false && (
        <p className="rounded-md bg-amber-100 px-4 py-2 text-sm text-amber-800 dark:bg-amber-900 dark:text-amber-100">
          主催者との接続が切れています。しばらくお待ちください…
        </p>
      )}

      {someoneElseWon ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-neutral-200 px-6 py-8 dark:border-neutral-800">
          <p className="text-base">
            {isOrderMode
              ? `現在${winnerName ?? "だれか"}さんの番です`
              : `${winnerName ?? "だれか"}さんが回答権を獲得しました`}
          </p>
          {round?.winnerReactionMs != null && (
            <p className="text-xs text-neutral-500">
              {(round.winnerReactionMs / 1000).toFixed(2)}秒で
              {isOrderMode ? "回答しました" : "押しました"}
            </p>
          )}
          {uid &&
            round?.buzzAttempts?.[uid] != null &&
            (() => {
              const myMs = round.buzzAttempts[uid];
              const winnerMs = round.winnerReactionMs;
              return (
                <div className="mt-2 flex flex-col items-center gap-1 border-t border-neutral-200 pt-2 text-xs text-neutral-500 dark:border-neutral-800">
                  <p>あなたの反応タイム：{(myMs / 1000).toFixed(2)}秒</p>
                  {winnerMs != null &&
                    (myMs <= winnerMs ? (
                      <p className="text-amber-600 dark:text-amber-400">
                        あなたの反応の方が{((winnerMs - myMs) / 1000).toFixed(2)}秒速かったですが、
                        サーバーには{winnerName ?? "相手"}さんが先に届きました
                      </p>
                    ) : (
                      <p>{((myMs - winnerMs) / 1000).toFixed(2)}秒差で先を越されました</p>
                    ))}
                </div>
              );
            })()}
        </div>
      ) : canBuzz ? (
        <div className="flex flex-col items-center gap-3">
          {liveElapsedMs !== null && (
            <p className="text-2xl font-bold tabular-nums text-neutral-500">
              {(liveElapsedMs / 1000).toFixed(2)}秒
            </p>
          )}
          <button
            type="button"
            onPointerDown={handleBuzz}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                handleBuzz();
              }
            }}
            className="flex h-56 w-56 items-center justify-center rounded-full bg-red-600 text-3xl font-bold text-white shadow-lg active:scale-95"
          >
            押す！
          </button>
        </div>
      ) : isLockedOut ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-neutral-200 px-6 py-8 dark:border-neutral-800">
          <p className="text-base">
            {isBanned
              ? "主催者により早押しが禁止されています"
              : "不正解でした。他の人の回答を待っています…"}
          </p>
        </div>
      ) : gameStartCountdown !== null ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-neutral-200 px-6 py-8 dark:border-neutral-800">
          <p className="text-base text-neutral-500">まもなく開始します…</p>
          <p className="text-6xl font-bold tabular-nums">
            {gameStartCountdown > 0 ? gameStartCountdown : "0"}
          </p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-neutral-200 px-6 py-8 dark:border-neutral-800">
          <p className="text-base">主催者が開始するのを待っています…</p>
          <p className="text-xs text-neutral-500">参加者 {players.length}人</p>
        </div>
      )}

      {/* Ranking lives on the waiting screens (here), not the button/choice
          screens — shown only while just watching, never while answering.
          Uses publicScores (not live player scores) so nobody watching can
          infer the current answer's correctness from a score jump before
          the official reveal. */}
      {!canBuzz && publicRanking.length > 0 && (
        <div className="flex w-full max-w-xs flex-col gap-1 rounded-lg border border-neutral-200 p-3 text-left dark:border-neutral-800">
          <p className="text-xs font-semibold text-neutral-500">ランキング</p>
          <ol className="flex max-h-40 flex-col gap-1 overflow-y-auto">
            {publicRanking.map((player, index) => (
              <li
                key={player.id}
                className={`flex items-center gap-2 rounded px-1.5 py-1 text-xs ${player.id === uid ? "bg-neutral-100 font-bold dark:bg-neutral-800" : ""}`}
              >
                <span className="w-5 shrink-0 text-center text-neutral-400">
                  {index === 0 ? "🏆" : index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate">{player.name}</span>
                <span className="shrink-0">{player.score}点</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </main>
  );
}
