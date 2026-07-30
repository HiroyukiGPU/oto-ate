"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import QRCode from "qrcode";
import { ensureAnonymousUser } from "@/lib/auth";
import { getQuiz, recordQuizPlay, saveQuiz, subscribeQuizzes } from "@/lib/quizStore";
import YouTubePlayer, { YouTubePlayerHandle } from "@/components/YouTubePlayer";
import {
  ANSWER_TIME_LIMIT_MS,
  DEFAULT_BUZZ_LOCKOUT_MS,
  EVERYONE_TIME_LIMIT_MS,
  GAME_START_COUNTDOWN_MS,
  NO_BUZZ_GRACE_MS,
  REVEAL_AUTO_ADVANCE_MS,
  addScore,
  advanceSpellingStep,
  assignNextTurn,
  computeOrderModeScore,
  finishGame,
  incrementCorrectCount,
  initEveryoneSpelling,
  kickPlayer,
  markAnswerCorrect,
  markAnswerIncorrect,
  markHostConnected,
  markOrderAnswerCorrect,
  openQuestion,
  openRound,
  prepareQuestion,
  resolveEveryoneSpellingStep,
  revealAnswer,
  setAnswerMode,
  setBuzzLockoutMs,
  setClipMode,
  setEveryoneTimeMode,
  setMultiSelectMode,
  setPlayerBanned,
  setRoomMode,
  skipPlayerTurn,
  startCountdown,
  startGame,
  subscribeGame,
  subscribePlayers,
  subscribeRoom,
  subscribeRound,
} from "@/lib/rooms";
import { describePlaybackError, isEmbedNotAllowedError } from "@/lib/youtubePlayerError";
import { buildSpellingStepChoices, foldKana, normalizeTitleForSpelling } from "@/lib/spelling";
import type {
  AnswerMode,
  ClipMode,
  EveryoneTimeMode,
  Game,
  Player,
  Quiz,
  QuizItem,
  Room,
  RoomMode,
  Round,
} from "@/lib/types";

const EVERYONE_MODE_POINTS = [100, 80, 60, 40, 20];
const PLAYBACK_ERROR_SKIP_MS = 3000;
const MIN_QUESTIONS = 4;
// Default 出題数 shown/used before the host explicitly picks a number —
// capped by the quiz's actual song count when it has fewer than this.
const DEFAULT_QUESTION_COUNT = 20;
const SPECIAL_CLIP_SECONDS = 15;
// Extra slack added to ANSWER_TIME_LIMIT_MS before actually timing a player
// out. A choice submitted right at the deadline still needs a network round
// trip to land — without this, the host's local timer could fire and mark a
// genuinely-correct, already-submitted answer as a timeout purely because it
// hadn't arrived yet. Doesn't affect the displayed countdown, which still
// reaches 0 at the nominal ANSWER_TIME_LIMIT_MS.
const ANSWER_TIMEOUT_GRACE_MS = 1200;

function buildChoices(quiz: Quiz, questionIndex: number): string[] | null {
  const correct = quiz.items[questionIndex].answerTitle;
  const pool = Array.from(
    new Set(
      quiz.items
        .filter((_, i) => i !== questionIndex)
        .map((item) => item.answerTitle)
        .filter((title) => title !== correct),
    ),
  );
  if (pool.length < 3) return null;
  const distractors = [...pool].sort(() => Math.random() - 0.5).slice(0, 3);
  return [correct, ...distractors].sort(() => Math.random() - 0.5);
}

// answerMode "spelling": a title needs at least this many kept characters
// (see normalizeTitleForSpelling) to be worth spelling out one at a time —
// below that there's nothing left after stripping symbols/numbers, or a
// single-character "word" wouldn't be much of a game.
const MIN_SPELLING_LENGTH = 2;

function normalizedAnswerLength(item: QuizItem): number {
  return normalizeTitleForSpelling(item.answerTitle).length;
}

// answerMode "spelling": normalizes questionIndex's answerTitle and builds
// the first character's 4 choices, drawing distractors from every OTHER
// item's normalized answerTitle (see src/lib/spelling.ts). Returns null if
// the title is too short once symbols/numbers are stripped — same
// reasoning as buildChoices() returning null when there aren't enough
// distinct titles.
function buildSpellingStart(
  quiz: Quiz,
  questionIndex: number,
): { targetChars: string[]; firstChoices: string[] } | null {
  const targetChars = normalizeTitleForSpelling(quiz.items[questionIndex].answerTitle);
  if (targetChars.length < MIN_SPELLING_LENGTH) return null;
  const otherAnswers = quiz.items
    .filter((_, i) => i !== questionIndex)
    .map((item) => normalizeTitleForSpelling(item.answerTitle));
  const firstChoices = buildSpellingStepChoices(targetChars, 0, otherAnswers);
  return { targetChars, firstChoices };
}

// Room.multiSelectMode: falls back to a single-name array when
// answerArtists hasn't been bulk-edited for this item yet.
function normalizedArtists(item: QuizItem): string[] {
  const names = (item.answerArtists ?? [item.answerArtist])
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  return Array.from(new Set(names));
}

// Room.multiSelectMode ("誰が歌っているか" quiz): the correct answer is
// EVERY name in questionIndex's answerArtists (a collab needs all of them
// picked — no more, no less, see the exact-set-match judging where
// Round.correctChoiceIndices is read) rather than a single song title.
// Distractors are drawn from every OTHER item's artist names, deduplicated
// and never overlapping this item's own correct set, so a name never
// appears as both correct and a decoy. Returns null when there isn't even
// one distractor candidate available yet — same "not enough songs" reasoning
// as buildChoices/buildSpellingStart returning null.
function buildMultiSelectChoices(
  quiz: Quiz,
  questionIndex: number,
): { choices: string[]; correctIndices: number[] } | null {
  const correct = normalizedArtists(quiz.items[questionIndex]);
  if (correct.length === 0) return null;
  const correctSet = new Set(correct);
  const pool = Array.from(
    new Set(
      quiz.items
        .filter((_, i) => i !== questionIndex)
        .flatMap((item) => normalizedArtists(item))
        .filter((name) => !correctSet.has(name)),
    ),
  );
  if (pool.length < 1) return null;
  const distractorsNeeded = Math.max(4 - correct.length, 1);
  const distractors = [...pool].sort(() => Math.random() - 0.5).slice(0, distractorsNeeded);
  const choices = [...correct, ...distractors].sort(() => Math.random() - 0.5);
  const correctIndices = choices
    .map((name, i) => (correctSet.has(name) ? i : -1))
    .filter((i) => i !== -1);
  return { choices, correctIndices };
}

// Bundles the 3 mutually-exclusive ways a question's choices/answer-key can
// be built (plain title choices, 文字当て's first step, multiSelect's
// artist set) so handleStartGame/handleNextQuestion don't each duplicate the
// branching. Returns null when the room's current mode can't build a valid
// question for this item (see the individual builders above) — callers stop
// the game/show an error in that case, exactly as they already did before
// multiSelect existed.
function buildQuestionSetup(
  room: Room,
  quiz: Quiz,
  questionIndex: number,
): {
  choices: string[];
  spelling?: { totalLength: number };
  multiSelect?: { correctIndices: number[] };
} | null {
  if (room.answerMode === "spelling") {
    const spellingStart = buildSpellingStart(quiz, questionIndex);
    if (!spellingStart) return null;
    return {
      choices: spellingStart.firstChoices,
      spelling: { totalLength: spellingStart.targetChars.length },
    };
  }
  if (room.multiSelectMode) {
    const multi = buildMultiSelectChoices(quiz, questionIndex);
    if (!multi) return null;
    return { choices: multi.choices, multiSelect: { correctIndices: multi.correctIndices } };
  }
  const choices = buildChoices(quiz, questionIndex);
  if (!choices) return null;
  return { choices };
}

function shuffledIndices(count: number): number[] {
  const order = Array.from({ length: count }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

// Each individual game's draw is already uniformly random over the full
// library, but independent draws can by chance overlap a lot between
// consecutive games (especially with a small pick count) — that reads as
// "not really random" even though it isn't biased. Bias AWAY from whatever
// was picked last time instead: shuffle the not-recently-played items first,
// only falling back to recently-played ones once those run out.
//
// `excludeIndices`, when given, keeps those items out of the played
// question order entirely (used to keep chorus-detection-failures out of
// サビ mode — see resolveClipRange/handleStartGame) — they still count
// as answer-choice distractors via buildChoices, which draws from the full
// quiz.items regardless. Falls back to including everyone if excluding
// would leave nothing left to play.
function selectQuestionOrder(quiz: Quiz, count: number, excludeIndices?: Set<number>): number[] {
  const recentIds = new Set(quiz.lastPlayedItemIds ?? []);
  const eligible =
    excludeIndices && excludeIndices.size < quiz.items.length
      ? (_item: unknown, i: number) => !excludeIndices.has(i)
      : () => true;
  const freshIndices: number[] = [];
  const staleIndices: number[] = [];
  quiz.items.forEach((item, i) => {
    if (!eligible(item, i)) return;
    (recentIds.has(item.id) ? staleIndices : freshIndices).push(i);
  });
  const shuffledFresh = shuffledIndices(freshIndices.length).map((i) => freshIndices[i]);
  const shuffledStale = shuffledIndices(staleIndices.length).map((i) => staleIndices[i]);
  return [...shuffledFresh, ...shuffledStale].slice(0, count);
}

// currentQuestionIndex is the player's POSITION in the play order (0..N-1);
// questionOrder maps that position to the actual index in quiz.items.
function quizItemIndexAt(room: Room, position: number): number {
  return room.questionOrder?.[position] ?? position;
}

// questionOrder may be a random SUBSET of the quiz (not just a full shuffle),
// so the number of questions in THIS game is its length, not quiz.items.length.
function totalQuestionsFor(room: Room, quiz: Quiz): number {
  return room.questionOrder?.length ?? quiz.items.length;
}

// Resolves which portion of the video to actually play for this question,
// based on the room's clip mode:
// - "configured": the range set in the サビ範囲エディター for this item —
//   unless background chorus detection (see src/lib/chorusDetectionQueue.ts)
//   hasn't finished (or failed) for it yet, in which case it falls back to
//   the same random-window pick as "random" mode below, just for this one
//   playthrough. Nothing is persisted, so once detection does complete, the
//   next time this question comes up it uses the real chorus range.
// - "intro": always the first SPECIAL_CLIP_SECONDS of the video.
// - "random": a fresh random SPECIAL_CLIP_SECONDS window each time.
function resolveClipRange(
  item: QuizItem,
  clipMode: ClipMode,
  roomMode: RoomMode,
): { startSeconds: number; endSeconds: number } {
  if (roomMode === "order") {
    // "order" mode can take several turns to resolve a single question, so a
    // fixed SPECIAL_CLIP_SECONDS window risks running out of audio mid-
    // rotation — always play from a random point through to the end instead.
    // Leaves at least SPECIAL_CLIP_SECONDS of runway after the random start.
    const totalDuration = item.duration ?? item.endSeconds;
    const maxStart = Math.max(0, totalDuration - SPECIAL_CLIP_SECONDS);
    const startSeconds = Math.random() * maxStart;
    return { startSeconds, endSeconds: totalDuration };
  }
  if (clipMode === "intro") {
    // introStartSeconds lets a song skip a silent lead-in (label ident, etc.)
    // instead of always starting at the literal beginning of the video.
    const startSeconds = item.introStartSeconds ?? 0;
    return { startSeconds, endSeconds: startSeconds + SPECIAL_CLIP_SECONDS };
  }
  const needsRandomFallback =
    clipMode === "random" || item.chorusStatus === "pending" || item.chorusStatus === "failed";
  if (needsRandomFallback) {
    const totalDuration = item.duration ?? item.endSeconds;
    const maxStart = Math.max(0, totalDuration - SPECIAL_CLIP_SECONDS);
    const startSeconds = Math.random() * maxStart;
    return { startSeconds, endSeconds: startSeconds + SPECIAL_CLIP_SECONDS };
  }
  return { startSeconds: item.startSeconds, endSeconds: item.endSeconds };
}

// "order" mode: finds the next player in turnRotation (starting at
// startIndex, wrapping around) who is eligible for a turn. excludePlayerId
// skips a specific id even if their canAnswer/banned fields haven't
// round-tripped back through the listener yet (the same reason
// handleWrongAnswer below excludes by id rather than trusting a live flag).
// requireCanAnswer additionally skips anyone who's already used their turn
// on THIS question (right or wrong both set canAnswer false) — needed when
// advancing mid-question so "everyone's had a turn" is detected correctly,
// but must stay OFF when picking who starts a brand-new question: canAnswer
// is only reset to true by the very same openQuestion() call that's still
// in flight, so the locally-known players array still reflects the END of
// the PREVIOUS question (where every participant's canAnswer is false).
// Returns the absolute index into turnRotation, or -1 if nobody qualifies.
function findNextEligibleTurnIndex(
  players: Player[],
  turnRotation: string[],
  startIndex: number,
  options: { excludePlayerId?: string; requireCanAnswer?: boolean } = {},
): number {
  const { excludePlayerId, requireCanAnswer = false } = options;
  if (turnRotation.length === 0) return -1;
  for (let step = 0; step < turnRotation.length; step++) {
    const idx = (startIndex + step) % turnRotation.length;
    const candidateId = turnRotation[idx];
    if (candidateId === excludePlayerId) continue;
    const candidate = players.find((p) => p.id === candidateId);
    // Disconnected players remain stored for the final ranking, but must
    // not receive a turn that can no longer be completed.
    if (!candidate || candidate.banned || !candidate.connected) continue;
    if (requireCanAnswer && candidate.canAnswer === false) continue;
    return idx;
  }
  return -1;
}

// "order" mode: resolves who should hold the first turn of a NEW question,
// plus the rotation pointer the FOLLOWING question should start from (always
// startIndex + 1, regardless of how many turns this question ends up
// taking — that's what keeps the "who goes first" advantage rotating fairly
// across the whole game rather than resetting every question).
function resolveOrderTurnForQuestionStart(
  mode: RoomMode | undefined,
  players: Player[],
  turnRotation: string[],
  startIndex: number,
): { playerId: string; nextTurnStartIndex: number } | undefined {
  if (mode !== "order") return undefined;
  const idx = findNextEligibleTurnIndex(players, turnRotation, startIndex);
  if (idx === -1) return undefined;
  return { playerId: turnRotation[idx], nextTurnStartIndex: (idx + 1) % turnRotation.length };
}

export default function HostRoomPage() {
  const params = useParams<{ code: string }>();
  const code = params.code;
  const playerRef = useRef<YouTubePlayerHandle>(null);
  const prevWinnerRef = useRef<string | null>(null);
  const prevSelectedChoiceRef = useRef<number | null>(null);
  // Room.multiSelectMode: parallels prevSelectedChoiceRef, but for the
  // array-valued round.selectedChoices (see Round.selectedChoices).
  const prevSelectedChoicesRef = useRef<number[] | null>(null);
  // Room.everyoneTimeMode "timed": force-closes the round EVERYONE_TIME_LIMIT_MS
  // after it opens regardless of who has/hasn't answered yet.
  const everyoneTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 文字当て(buzzer mode): tracks round.spelling.position so the answer
  // countdown/timeout can re-arm on EVERY character step for the same
  // winner — winnerId itself doesn't change between characters, so without
  // this a player correctly spelling a multi-character word would be timed
  // out by the very first character's countdown alone.
  const prevSpellingPositionRef = useRef<number | null>(null);
  const hostConnectedMarkedRef = useRef(false);
  const playbackSyncedRef = useRef(false);
  const answerTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const answerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const noBuzzTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noBuzzGraceStartTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noBuzzGraceIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Cancels an in-flight waitForAudibleStart() poll — needed if a new
  // question starts (or the component unmounts) before the previous one
  // confirmed real playback, so a stale poll can't later call openQuestion()
  // for the wrong question.
  const audibleStartPollRef = useRef<{ cancel: () => void } | null>(null);
  const playersRef = useRef<Player[]>([]);
  // Guards handleStartGame against a double-click during the brief window
  // before countdownEndsAt round-trips back and the "ゲームを開始" button is
  // replaced by the countdown display — without this, a second click in that
  // window would restart the countdown or, worse, run startGame/prepareQuestion
  // twice.
  const gameStartingRef = useRef(false);
  const quizRef = useRef<Quiz | null | undefined>(undefined);
  const roomStateRef = useRef<Room | null | undefined>(undefined);
  const roundRef = useRef<Round | null>(null);
  // The clip range actually chosen for the current question — resolved once
  // in playQuestion() and reused everywhere else, so "random" mode doesn't
  // re-roll a different window every time playback resumes/reveals.
  const currentClipRangeRef = useRef<{ startSeconds: number; endSeconds: number } | null>(null);
  // Exact position captured right before we pause for a buzz-in. A bare
  // resume()/playVideo() call is unreliable once the player has reached
  // YouTube's native "ended" state (which happens whenever a buzz lands
  // right as the clip hits its configured endSeconds) — some of the time it
  // silently no-ops instead of resuming, which is why music sometimes never
  // came back during the reveal. Explicitly seeking to the captured position
  // before every resume() sidesteps that "ended" state ambiguity entirely.
  const pausedAtSecondsRef = useRef<number | null>(null);
  // Every player's score as of the start of the CURRENT question, updated in
  // place as each turn on this question gets graded (right or wrong). Passed
  // to revealAnswer as Room.publicScores so player screens can show a safe,
  // reveal-time-accurate ranking without ever reading the live, continuously
  // -updating players/{id}/score (which would leak who just got scored,
  // before the official reveal).
  const questionScoresRef = useRef<Record<string, number>>({});
  // "order" mode only: accumulates every player who's answered THIS question
  // correctly across its (possibly several) turns, so the final reveal —
  // once nobody's left — can report all of them, not just whoever happened
  // to take the last turn. Reset alongside questionScoresRef at each new
  // question. Buzzer mode never needs this: at most one player can ever be
  // correct per question, so its reveal call sites pass that id (or [])
  // directly.
  const questionCorrectPlayersRef = useRef<string[]>([]);

  function resumeFromPause() {
    // Nothing to resume if we never paused (e.g. "order" mode's turn
    // handoffs, which deliberately leave the clip playing) — calling
    // resume()/playVideo() anyway would be a no-op at best, but could
    // needlessly restart a clip that reached YouTube's native "ended" state
    // on its own.
    if (pausedAtSecondsRef.current === null) return;
    playerRef.current?.seekTo(pausedAtSecondsRef.current, true);
    playerRef.current?.resume();
  }

  const [uid, setUid] = useState<string | null>(null);
  const [room, setRoom] = useState<Room | null | undefined>(undefined);
  const [players, setPlayers] = useState<Player[]>([]);
  const [round, setRound] = useState<Round | null>(null);
  const [game, setGame] = useState<Game | null>(null);
  const [joinUrl, setJoinUrl] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [embedBlockedNotice, setEmbedBlockedNotice] = useState<string | null>(null);
  const [gameStartError, setGameStartError] = useState<string | null>(null);
  const [skipCountdown, setSkipCountdown] = useState<number | null>(null);
  const [maxQuestionsInput, setMaxQuestionsInput] = useState<number | null>(null);
  const [answerCountdown, setAnswerCountdown] = useState<number | null>(null);
  const [nextQuestionCountdown, setNextQuestionCountdown] = useState<number | null>(null);
  const [noBuzzGraceCountdown, setNoBuzzGraceCountdown] = useState<number | null>(null);
  const [gameStartCountdown, setGameStartCountdown] = useState<number | null>(null);
  const handleNextQuestionRef = useRef<() => void>(() => {});
  const handleCloseEveryoneRoundRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const closingEveryoneRoundRef = useRef(false);

  const quiz = useSyncExternalStore(
    subscribeQuizzes,
    () => (room ? getQuiz(room.quizId) : undefined),
    () => undefined,
  );

  useEffect(() => {
    playersRef.current = players;
  }, [players]);

  useEffect(() => {
    quizRef.current = quiz;
  }, [quiz]);

  useEffect(() => {
    roomStateRef.current = room;
  }, [room]);

  useEffect(() => {
    roundRef.current = round;
  }, [round]);

  useEffect(() => {
    ensureAnonymousUser().then(setUid);
  }, []);

  useEffect(() => subscribeRoom(code, setRoom), [code]);
  useEffect(() => subscribePlayers(code, setPlayers), [code]);
  useEffect(() => subscribeRound(code, setRound), [code]);
  useEffect(() => subscribeGame(code, setGame), [code]);

  useEffect(() => {
    const url = `${window.location.origin}/room/join?code=${code}`;
    QRCode.toDataURL(url, { width: 240, margin: 1 }).then((dataUrl) => {
      setJoinUrl(url);
      setQrDataUrl(dataUrl);
    });
  }, [code]);

  useEffect(() => {
    return () => {
      if (answerTimeoutRef.current) clearTimeout(answerTimeoutRef.current);
      if (answerIntervalRef.current) clearInterval(answerIntervalRef.current);
      if (noBuzzTimeoutRef.current) clearTimeout(noBuzzTimeoutRef.current);
      if (noBuzzGraceStartTimeoutRef.current) clearTimeout(noBuzzGraceStartTimeoutRef.current);
      if (noBuzzGraceIntervalRef.current) clearInterval(noBuzzGraceIntervalRef.current);
      if (everyoneTimeoutRef.current) clearTimeout(everyoneTimeoutRef.current);
      audibleStartPollRef.current?.cancel();
    };
  }, []);

  function clearEveryoneTimer() {
    if (everyoneTimeoutRef.current) {
      clearTimeout(everyoneTimeoutRef.current);
      everyoneTimeoutRef.current = null;
    }
  }

  // Room.everyoneTimeMode "timed": force-closes the round EVERYONE_TIME_LIMIT_MS
  // after it opens, regardless of who has/hasn't answered — unlike "full"
  // mode's wait-for-everyone-or-skip behavior (see the allFinished effect
  // below and the player-facing skip button in src/app/room/[code]/player/page.tsx).
  function startEveryoneTimer() {
    clearEveryoneTimer();
    everyoneTimeoutRef.current = setTimeout(() => {
      if (closingEveryoneRoundRef.current) return;
      closingEveryoneRoundRef.current = true;
      handleCloseEveryoneRoundRef.current().finally(() => {
        closingEveryoneRoundRef.current = false;
      });
    }, EVERYONE_TIME_LIMIT_MS);
  }

  // Unlike answerCountdown/nextQuestionCountdown, this one DOES need to be
  // reset here: the "早押し受付中…" branch it renders in is re-entered
  // multiple times per question (initial wait, then again after every wrong
  // answer reopens the round), so a stale value from a previous grace period
  // would otherwise flash "残り1秒" immediately even though the fresh grace
  // period hasn't started counting down yet.
  function clearNoBuzzTimer() {
    if (noBuzzTimeoutRef.current) {
      clearTimeout(noBuzzTimeoutRef.current);
      noBuzzTimeoutRef.current = null;
    }
    if (noBuzzGraceStartTimeoutRef.current) {
      clearTimeout(noBuzzGraceStartTimeoutRef.current);
      noBuzzGraceStartTimeoutRef.current = null;
    }
    if (noBuzzGraceIntervalRef.current) {
      clearInterval(noBuzzGraceIntervalRef.current);
      noBuzzGraceIntervalRef.current = null;
    }
    setNoBuzzGraceCountdown(null);
  }

  // Waits for (this clip's duration + a grace period) after a question opens
  // for buzzing. If nobody has buzzed in by then, reveals the answer instead
  // of leaving the room stuck on "早押し受付中…" with a clip that already
  // finished playing. Takes the item directly rather than resolving it via
  // currentQuizItem()'s refs, since those can still reflect the PREVIOUS
  // question for a moment right when a new one starts (the room subscription
  // hasn't round-tripped yet).
  function startNoBuzzTimer(item: { startSeconds: number; endSeconds: number }) {
    clearNoBuzzTimer();
    const clipDurationMs = Math.max(0, (item.endSeconds - item.startSeconds) * 1000);
    // The visible countdown only covers the grace period AFTER the clip's
    // own duration — it starts ticking once the clip would naturally end.
    noBuzzGraceStartTimeoutRef.current = setTimeout(() => {
      const graceDeadline = Date.now() + NO_BUZZ_GRACE_MS;
      noBuzzGraceIntervalRef.current = setInterval(() => {
        setNoBuzzGraceCountdown(Math.max(0, Math.ceil((graceDeadline - Date.now()) / 1000)));
      }, 200);
    }, clipDurationMs);
    noBuzzTimeoutRef.current = setTimeout(() => {
      handleNoOneBuzzed();
    }, clipDurationMs + NO_BUZZ_GRACE_MS);
  }

  async function handleNoOneBuzzed() {
    clearNoBuzzTimer();
    const item = currentQuizItem();
    if (!item) return;
    await revealAnswer(
      code,
      { title: item.answerTitle, artist: normalizedArtists(item).join("、") },
      [],
      { ...questionScoresRef.current },
    );
    playerRef.current?.seekTo(currentClipRangeRef.current?.startSeconds ?? item.startSeconds, true);
    playerRef.current?.resume();
  }

  // Only clears the timer refs — deliberately does not touch answerCountdown.
  // The countdown display is already gated by round.selectedChoice/winnerId in
  // the JSX, so it never renders stale once those clear; the next buzz-in
  // overwrites it with a fresh value before the interval starts ticking.
  function clearAnswerTimer() {
    if (answerTimeoutRef.current) {
      clearTimeout(answerTimeoutRef.current);
      answerTimeoutRef.current = null;
    }
    if (answerIntervalRef.current) {
      clearInterval(answerIntervalRef.current);
      answerIntervalRef.current = null;
    }
  }

  function currentQuizItem() {
    const r = roomStateRef.current;
    const q = quizRef.current;
    if (!r || !q) return undefined;
    return q.items[quizItemIndexAt(r, r.currentQuestionIndex)];
  }

  // "order" mode: hands the turn to whoever's next in the fixed rotation
  // after afterPlayerId, or reveals the answer if nobody's left. Everyone in
  // the rotation gets a turn on the same question regardless of right/wrong,
  // so this is shared by the correct-answer path, the wrong-answer path, and
  // the host's manual "skip this turn" override — afterPlayerId is always
  // someone who's already used up (or forfeited) their one turn.
  async function advanceOrderTurn(afterPlayerId: string) {
    const turnRotation = roomStateRef.current?.turnRotation ?? [];
    const currentTurnNumber = roundRef.current?.turnNumber ?? 0;
    const currentIdx = turnRotation.indexOf(afterPlayerId);
    const nextIdx = findNextEligibleTurnIndex(
      playersRef.current,
      turnRotation,
      currentIdx === -1 ? 0 : currentIdx + 1,
      { excludePlayerId: afterPlayerId, requireCanAnswer: true },
    );
    if (nextIdx !== -1) {
      await assignNextTurn(code, turnRotation[nextIdx], currentTurnNumber + 1);
      return;
    }
    const item = currentQuizItem();
    if (item) {
      await revealAnswer(
        code,
        { title: item.answerTitle, artist: normalizedArtists(item).join("、") },
        questionCorrectPlayersRef.current,
        { ...questionScoresRef.current },
      );
    }
  }

  // Marks a wrong answer, then hands things off to whoever's next. "order"
  // mode passes the turn to the next player in the fixed rotation (or
  // reveals if none remain); buzzer mode reopens the round for anyone still
  // eligible to buzz (or reveals if none remain) — instead of leaving the
  // screen stuck on "早押し受付中…" with no one left able to answer.
  async function handleWrongAnswer(playerId: string) {
    clearAnswerTimer();
    const newScore = await markAnswerIncorrect(code, playerId);
    questionScoresRef.current[playerId] = newScore;
    if (roomStateRef.current?.mode === "order") {
      await advanceOrderTurn(playerId);
    } else {
      const item = currentQuizItem();
      const stillAnswerable = playersRef.current.some(
        (p) => !p.banned && p.id !== playerId && p.canAnswer,
      );
      if (stillAnswerable) {
        await openRound(code);
      } else if (item) {
        // Buzzer mode: reaching here means every attempt on this question
        // was wrong, so nobody was ever correct.
        await revealAnswer(
          code,
          { title: item.answerTitle, artist: normalizedArtists(item).join("、") },
          [],
          { ...questionScoresRef.current },
        );
      }
    }
    // Resume from wherever playback was paused when this player's turn
    // started — NOT seek back to the clip's start, so the music continues
    // naturally as the next player (or the reveal) picks up right where it
    // left off.
    resumeFromPause();
  }

  useEffect(() => {
    const currentWinner = round?.winnerId ?? null;
    const isRevealedNow = game?.phase === "revealed";
    // "order" mode hands winnerId directly from one player to the next
    // (never passing through null in between), so this must fire on ANY
    // change to a new truthy value, not just a null→truthy transition — a
    // bare `!prevWinnerRef.current` check would silently skip re-arming the
    // answer countdown/timeout for every turn after the first.
    const isNewWinner = !!currentWinner && currentWinner !== prevWinnerRef.current;
    // 文字当て(buzzer mode only — see prevSpellingPositionRef): advancing to
    // a new character keeps the SAME winnerId, so without tracking this
    // separately the countdown/timeout armed for the FIRST character would
    // be the only one ever set, timing out a player still correctly
    // spelling later characters.
    const spellingPosition =
      roomStateRef.current?.answerMode === "spelling" ? (round?.spelling?.position ?? null) : null;
    const isNewSpellingStep =
      !!currentWinner &&
      !isNewWinner &&
      spellingPosition !== null &&
      spellingPosition !== prevSpellingPositionRef.current;

    if (isNewWinner) {
      clearNoBuzzTimer();
      // "order" mode plays one continuous random-start clip across the whole
      // rotation specifically so nobody has to stop and restart it — pausing
      // on every turn handoff would cut the music exactly where this was
      // meant to avoid it, so only buzzer/everyone (single-answer-then-pause)
      // modes pause here.
      if (roomStateRef.current?.mode !== "order") {
        pausedAtSecondsRef.current = playerRef.current?.getCurrentTime() ?? null;
        playerRef.current?.pause();
      }
    }
    // "order" mode has no time limit — a slow-but-correct answer should
    // never lose a race against an auto-timeout (that race is exactly what
    // used to let network lag turn a correct pick into a missed turn).
    if ((isNewWinner || isNewSpellingStep) && roomStateRef.current?.mode === "buzzer") {
      clearAnswerTimer();
      const deadline = Date.now() + ANSWER_TIME_LIMIT_MS;
      setAnswerCountdown(Math.ceil(ANSWER_TIME_LIMIT_MS / 1000));
      answerIntervalRef.current = setInterval(() => {
        setAnswerCountdown(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
      }, 200);
      answerTimeoutRef.current = setTimeout(() => {
        // The player's choice may have already been submitted (even a
        // correct one) but not yet round-tripped back through the round
        // listener — re-check the freshest known state before timing out,
        // so a genuinely-answered pick right at the deadline isn't
        // discarded by this timer winning a race against the network.
        const alreadyAnswered = roomStateRef.current?.multiSelectMode
          ? roundRef.current?.selectedChoices != null
          : roundRef.current?.selectedChoice != null;
        if (alreadyAnswered) return;
        handleWrongAnswer(currentWinner);
      }, ANSWER_TIME_LIMIT_MS + ANSWER_TIMEOUT_GRACE_MS);
    }
    if (!currentWinner) {
      clearAnswerTimer();
      // Nobody's buzzed (yet) for this question — start the "nobody knows
      // it" grace timer, but only while a question is actually in progress
      // and waiting for a buzz, not during the "waiting" lobby or a reveal.
      // Reuse the SAME clip range already chosen for this question (not a
      // fresh resolve), so "random" mode doesn't re-roll on every reopen.
      const reopenedRange =
        !isRevealedNow && roomStateRef.current?.mode === "buzzer"
          ? currentClipRangeRef.current
          : null;
      if (roomStateRef.current?.status === "in_progress" && reopenedRange) {
        startNoBuzzTimer(reopenedRange);
      } else {
        clearNoBuzzTimer();
      }
    }
    prevWinnerRef.current = currentWinner;
    prevSpellingPositionRef.current = spellingPosition;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handleWrongAnswer/clearAnswerTimer/startNoBuzzTimer read live state via refs and are redefined every render
  }, [round?.winnerId, round?.spelling?.position, game?.phase]);

  // Shared by both the "choices" full-title path and the "spelling" path's
  // final character below — awards points (buzzer/everyone flat 100,
  // "order" via computeOrderModeScore) and either reveals (buzzer/everyone)
  // or hands the turn onward ("order", which reveals on its own once
  // nobody's left).
  function finalizeCorrectAnswer(winnerId: string, item: QuizItem) {
    if (roomStateRef.current?.mode === "order") {
      const points = computeOrderModeScore(
        roundRef.current?.turnNumber ?? 0,
        roundRef.current?.winnerReactionMs ?? 0,
      );
      markOrderAnswerCorrect(code, winnerId, points).then((newScore) => {
        questionScoresRef.current[winnerId] = newScore;
        questionCorrectPlayersRef.current = [...questionCorrectPlayersRef.current, winnerId];
        advanceOrderTurn(winnerId).then(() => resumeFromPause());
      });
    } else {
      markAnswerCorrect(
        code,
        winnerId,
        { title: item.answerTitle, artist: normalizedArtists(item).join("、") },
        100,
        { ...questionScoresRef.current },
      ).then(() => {
        resumeFromPause();
      });
    }
  }

  useEffect(() => {
    const isMultiSelect = room?.multiSelectMode === true;
    const currentChoice = round?.selectedChoice ?? null;
    const currentChoices = round?.selectedChoices ?? null;

    if (
      isMultiSelect &&
      currentChoices !== null &&
      prevSelectedChoicesRef.current === null &&
      round?.winnerId &&
      round.choices &&
      quiz &&
      room
    ) {
      // Room.multiSelectMode: the winner/turn-holder submits a whole SET at
      // once (via a "決定" action, see submitMultiChoice) rather than a
      // single tap — correct only on an exact match (no more, no less)
      // against the index set prepareQuestion() wrote for this question.
      clearAnswerTimer();
      const item = quiz.items[quizItemIndexAt(room, room.currentQuestionIndex)];
      const correctSet = new Set(round.correctChoiceIndices ?? []);
      const pickedSet = new Set(currentChoices);
      const isExactMatch =
        correctSet.size > 0 &&
        pickedSet.size === correctSet.size &&
        [...pickedSet].every((i) => correctSet.has(i));
      if (isExactMatch) {
        finalizeCorrectAnswer(round.winnerId, item);
      } else {
        handleWrongAnswer(round.winnerId);
      }
    } else if (
      !isMultiSelect &&
      currentChoice !== null &&
      prevSelectedChoiceRef.current === null &&
      round?.winnerId &&
      round.choices &&
      quiz &&
      room
    ) {
      clearAnswerTimer();
      const item = quiz.items[quizItemIndexAt(room, room.currentQuestionIndex)];
      const pickedText = round.choices[currentChoice];
      const spelling = room.answerMode === "spelling" ? round.spelling : null;

      if (spelling) {
        // 文字当て: each pick confirms one character of item.answerTitle
        // rather than the whole title at once — see src/lib/spelling.ts.
        const targetChars = normalizeTitleForSpelling(item.answerTitle);
        const correctChar = targetChars[spelling.position];
        const pickedCorrect = correctChar != null && foldKana(pickedText) === foldKana(correctChar);
        if (!pickedCorrect) {
          handleWrongAnswer(round.winnerId);
        } else {
          const nextPosition = spelling.position + 1;
          if (nextPosition >= spelling.totalLength) {
            finalizeCorrectAnswer(round.winnerId, item);
          } else {
            const otherAnswers = quiz.items
              .filter((_, i) => i !== quizItemIndexAt(room, room.currentQuestionIndex))
              .map((other) => normalizeTitleForSpelling(other.answerTitle));
            const nextChoices = buildSpellingStepChoices(targetChars, nextPosition, otherAnswers);
            const nextConfirmedChars = [...spelling.confirmedChars, correctChar];
            advanceSpellingStep(code, nextPosition, nextChoices, nextConfirmedChars);
          }
        }
      } else if (pickedText === item.answerTitle) {
        finalizeCorrectAnswer(round.winnerId, item);
      } else {
        handleWrongAnswer(round.winnerId);
      }
    }
    prevSelectedChoiceRef.current = currentChoice;
    prevSelectedChoicesRef.current = currentChoices;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- clearAnswerTimer/handleWrongAnswer/finalizeCorrectAnswer read live state via refs and are redefined every render
  }, [round, quiz, room, code]);

  useEffect(() => {
    handleNextQuestionRef.current = handleNextQuestion;
  });

  useEffect(() => {
    handleCloseEveryoneRoundRef.current = handleCloseEveryoneRound;
  });

  // "全員回答" mode: close the round automatically once every connected,
  // non-banned
  // player has submitted (answerMode "choices") or finished (answerMode
  // "spelling": completed the whole title or got a character wrong) —
  // instead of always requiring the host to notice and click 回答を締め切る.
  // Disconnected players remain in the room for the final ranking, so they
  // are deliberately excluded from the completion wait here.
  useEffect(() => {
    if (room?.mode !== "everyone" || room?.status !== "in_progress") return;
    if (game?.phase !== "playing") return;
    if (closingEveryoneRoundRef.current) return;
    const eligiblePlayers = playersRef.current.filter((p) => p.connected && !p.banned);
    if (eligiblePlayers.length === 0) return;

    let allFinished: boolean;
    if (room.answerMode === "spelling") {
      const entries = round?.everyoneSpelling ?? {};
      allFinished = eligiblePlayers.every((p) => {
        const entry = entries[p.id];
        return !!entry && (entry.failed || entry.completedAt != null);
      });
    } else {
      if (!round?.submissions) return;
      allFinished = Object.keys(round.submissions).length >= eligiblePlayers.length;
    }
    if (!allFinished) return;

    closingEveryoneRoundRef.current = true;
    handleCloseEveryoneRoundRef.current().finally(() => {
      closingEveryoneRoundRef.current = false;
    });
  }, [round?.submissions, round?.everyoneSpelling, room?.mode, room?.status, room?.answerMode, game?.phase]);

  // answerMode "spelling", "everyone" mode: each player advances privately
  // at their own pace (see src/lib/types.ts's EveryoneSpellingEntry) — this
  // resolves whichever players currently have a pending pick, independent of
  // everyone else's progress.
  useEffect(() => {
    if (room?.mode !== "everyone" || room?.answerMode !== "spelling") return;
    if (!round?.everyoneSpelling || !quiz || !room) return;
    const questionIndex = quizItemIndexAt(room, room.currentQuestionIndex);
    const item = quiz.items[questionIndex];
    const targetChars = normalizeTitleForSpelling(item.answerTitle);
    const otherAnswers = quiz.items
      .filter((_, i) => i !== questionIndex)
      .map((other) => normalizeTitleForSpelling(other.answerTitle));

    Object.entries(round.everyoneSpelling).forEach(([playerId, entry]) => {
      if (entry.pendingChoiceIndex == null || entry.failed || entry.completedAt != null) return;
      const pickedText = entry.choices[entry.pendingChoiceIndex];
      const correctChar = targetChars[entry.position];
      const pickedCorrect = correctChar != null && foldKana(pickedText) === foldKana(correctChar);
      if (!pickedCorrect) {
        resolveEveryoneSpellingStep(code, playerId, { failed: true });
        return;
      }
      const nextPosition = entry.position + 1;
      if (nextPosition >= targetChars.length) {
        resolveEveryoneSpellingStep(code, playerId, { completedAt: Date.now() });
      } else {
        const nextChoices = buildSpellingStepChoices(targetChars, nextPosition, otherAnswers);
        const nextConfirmedChars = [...entry.confirmedChars, correctChar];
        resolveEveryoneSpellingStep(code, playerId, {
          position: nextPosition,
          choices: nextChoices,
          confirmedChars: nextConfirmedChars,
        });
      }
    });
  }, [round?.everyoneSpelling, room, quiz, code]);

  // Ticks the synced "3, 2, 1" pre-game countdown, mirrored on the player
  // screens off the same room.countdownEndsAt.
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

  // Auto-advance the reveal ("結果") screen after a few seconds so the host
  // doesn't have to click through every question manually. Cleared for free
  // whenever the deps change (host clicks 次の問題へ early, or the next
  // question already started), since the returned cleanup runs before the
  // effect body re-executes.
  useEffect(() => {
    const isRevealed = game?.phase === "revealed" && !!game.answer;
    if (!isRevealed) return;
    const deadline = Date.now() + REVEAL_AUTO_ADVANCE_MS;
    const tickInterval = setInterval(() => {
      setNextQuestionCountdown(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    }, 200);
    const advanceTimeout = setTimeout(() => {
      handleNextQuestionRef.current();
    }, REVEAL_AUTO_ADVANCE_MS);
    return () => {
      clearInterval(tickInterval);
      clearTimeout(advanceTimeout);
    };
  }, [game?.phase, game?.answer]);

  // Videos that fail to play for reasons that might just be transient (not
  // "embedding not allowed" — that case skips immediately, see
  // handlePlaybackError) would otherwise strand the room on a manual "skip"
  // button — auto-skip instead, after a short grace period.
  useEffect(() => {
    if (!playbackError) return;
    const deadline = Date.now() + PLAYBACK_ERROR_SKIP_MS;
    const tickInterval = setInterval(() => {
      setSkipCountdown(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    }, 200);
    const skipTimeout = setTimeout(() => {
      handleNextQuestionRef.current();
    }, PLAYBACK_ERROR_SKIP_MS);
    return () => {
      clearInterval(tickInterval);
      clearTimeout(skipTimeout);
    };
  }, [playbackError]);

  // Self-clearing notice shown after an embedding-not-allowed skip (see
  // handlePlaybackError) — purely informational, doesn't gate anything.
  useEffect(() => {
    if (!embedBlockedNotice) return;
    const t = setTimeout(() => setEmbedBlockedNotice(null), 6000);
    return () => clearTimeout(t);
  }, [embedBlockedNotice]);

  useEffect(() => {
    if (!uid || !room || uid !== room.hostId || hostConnectedMarkedRef.current) return;
    hostConnectedMarkedRef.current = true;
    markHostConnected(code);
  }, [uid, room, code]);

  useEffect(() => {
    if (playbackSyncedRef.current) return;
    if (!room || !quiz) return;
    if (room.status !== "in_progress") return;
    if (game?.phase === "finished") return;
    const index = quizItemIndexAt(room, room.currentQuestionIndex);
    if (round?.phase === "loading") {
      // A previous host instance's playQuestion() was interrupted (e.g. this
      // page reloaded) before confirming playback and opening the round —
      // finish that handoff now instead of leaving it stuck forever.
      const orderTurn =
        room.mode === "order"
          ? resolveOrderTurnForQuestionStart(
              room.mode,
              playersRef.current,
              room.turnRotation ?? [],
              room.nextTurnStartIndex ?? 0,
            )
          : undefined;
      // prepareQuestion() already wrote this question's first-step choices
      // (and spelling.totalLength) to round before this page reloaded —
      // reuse them as-is rather than recomputing (which would risk
      // different distractors).
      const everyoneSpelling =
        room.mode === "everyone" && room.answerMode === "spelling" && round.choices && round.spelling
          ? { choices: round.choices, totalLength: round.spelling.totalLength }
          : undefined;
      playQuestion(
        index,
        playersRef.current.map((p) => p.id),
        orderTurn,
        everyoneSpelling,
      );
    } else {
      resyncPlaybackOnly(index);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- playQuestion/resyncPlaybackOnly are redefined every render; playbackSyncedRef already guards against re-running
  }, [room, quiz, game?.phase, round?.phase]);

  function handleCopy() {
    navigator.clipboard.writeText(joinUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  function handleKick(playerId: string) {
    kickPlayer(code, playerId);
  }

  function handleToggleBanned(player: Player) {
    setPlayerBanned(code, player.id, !player.banned);
  }

  function handleSetMode(mode: RoomMode) {
    setRoomMode(code, mode);
  }

  function handleSetClipMode(mode: ClipMode) {
    setClipMode(code, mode);
  }

  function handleSetAnswerMode(mode: AnswerMode) {
    setAnswerMode(code, mode);
  }

  function handleSetMultiSelectMode(multiSelectMode: boolean) {
    setMultiSelectMode(code, multiSelectMode);
  }

  function handleSetEveryoneTimeMode(mode: EveryoneTimeMode) {
    setEveryoneTimeMode(code, mode);
  }

  function handleSetBuzzLockoutMs(ms: number) {
    setBuzzLockoutMs(code, Math.max(0, ms));
  }

  // Waits for CONFIRMED audible playback rather than trusting YouTube's
  // PLAYING state-change event alone — that event can fire transiently
  // during a seek/load before the timeline is actually advancing. Polling
  // getCurrentTime() for real forward progress past the seek target is the
  // strongest signal available (dB-level detection isn't possible at all
  // for a cross-origin YouTube embed). Falls back to just proceeding after
  // MAX_WAIT_MS so a genuinely stuck/silent video can't stall the game
  // forever.
  function waitForAudibleStart(seekTargetSeconds: number): Promise<void> {
    const POLL_INTERVAL_MS = 50;
    const PROGRESS_THRESHOLD_SECONDS = 0.15;
    const MAX_WAIT_MS = 8000;
    // getCurrentTime() progress is the primary signal, but as a faster
    // fallback than the full MAX_WAIT_MS timeout: if the player reports the
    // PLAYING state (1 — see useRangeEditor.ts's handlePlayerStateChange for
    // the same convention) for a few consecutive polls in a row, trust that
    // too. Requiring several consecutive ticks (not just one) still avoids
    // the transient/premature PLAYING blips a bare state-change LISTENER
    // would catch during a seek — this is polled state, confirmed stable.
    const PLAYING_STATE = 1;
    const PLAYING_CONFIRM_TICKS = 3;
    audibleStartPollRef.current?.cancel();
    return new Promise((resolve) => {
      const startedAt = Date.now();
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let playingTicks = 0;
      audibleStartPollRef.current = {
        cancel: () => {
          cancelled = true;
          if (timer) clearTimeout(timer);
        },
      };
      const poll = () => {
        if (cancelled) return;
        const currentTime = playerRef.current?.getCurrentTime() ?? 0;
        playingTicks = playerRef.current?.getPlayerState() === PLAYING_STATE ? playingTicks + 1 : 0;
        if (
          currentTime >= seekTargetSeconds + PROGRESS_THRESHOLD_SECONDS ||
          playingTicks >= PLAYING_CONFIRM_TICKS ||
          Date.now() - startedAt > MAX_WAIT_MS
        ) {
          resolve();
          return;
        }
        timer = setTimeout(poll, POLL_INTERVAL_MS);
      };
      poll();
    });
  }

  // <YouTubePlayer> is only mounted once room.status === "in_progress" (see
  // the JSX below) — for the very FIRST question, startGame() (which writes
  // that status) and playQuestion() (which needs playerRef.current to issue
  // playClip()) both run back-to-back inside the same setTimeout callback,
  // with no guarantee React has actually committed the re-render that mounts
  // the player in between. Losing that race silently no-ops playClip()
  // against a null ref, so waitForAudibleStart's currentTime/state polling
  // never sees real progress and only resolves via its own MAX_WAIT_MS
  // fallback — leaving round.phase stuck on "loading" for that question.
  // Every LATER question is unaffected: room.status never changes again
  // mid-game, so the player has already been mounted since question 1.
  function waitForPlayerReady(): Promise<void> {
    if (playerRef.current?.isReady()) return Promise.resolve();
    const POLL_INTERVAL_MS = 20;
    const MAX_WAIT_MS = 10000;
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const poll = () => {
        if (playerRef.current?.isReady() || Date.now() - startedAt > MAX_WAIT_MS) {
          resolve();
          return;
        }
        setTimeout(poll, POLL_INTERVAL_MS);
      };
      poll();
    });
  }

  // Issues playClip() for the given question and resolves its clip range —
  // shared by playQuestion() (a fresh question, needs to open the round once
  // audible) and resyncPlaybackOnly() (this host page reloaded mid-question;
  // the round is already open/loading from before, only this browser's local
  // player needs to catch up).
  function loadClipForIndex(index: number): { startSeconds: number; endSeconds: number } | null {
    const item = quiz?.items[index];
    if (!item) return null;
    playbackSyncedRef.current = true;
    setPlaybackError(null);
    const range = resolveClipRange(
      item,
      roomStateRef.current?.clipMode ?? "configured",
      roomStateRef.current?.mode ?? "buzzer",
    );
    currentClipRangeRef.current = range;
    pausedAtSecondsRef.current = null;
    playerRef.current?.playClip(item.videoId, range.startSeconds, range.endSeconds);
    return range;
  }

  async function playQuestion(
    index: number,
    playerIds: string[],
    orderTurn?: { playerId: string; nextTurnStartIndex: number },
    // answerMode "spelling" + "everyone" room mode only: seeds every
    // player's independent spelling progress right after the round opens
    // (see initEveryoneSpelling in src/lib/rooms.ts).
    everyoneSpelling?: { choices: string[]; totalLength: number },
  ) {
    await waitForPlayerReady();
    const range = loadClipForIndex(index);
    if (!range) return;
    clearAnswerTimer();
    clearNoBuzzTimer();
    clearEveryoneTimer();
    await waitForAudibleStart(range.startSeconds);
    await openQuestion(code, playerIds, orderTurn);
    if (everyoneSpelling) {
      await initEveryoneSpelling(code, playerIds, everyoneSpelling.choices, everyoneSpelling.totalLength);
    }
    // "order" mode always has a turn holder assigned immediately, so the
    // "nobody buzzed" fallback timer is never needed there.
    if (roomStateRef.current?.mode === "buzzer") {
      startNoBuzzTimer(range);
    } else if (
      roomStateRef.current?.mode === "everyone" &&
      roomStateRef.current?.everyoneTimeMode === "timed"
    ) {
      startEveryoneTimer();
    }
  }

  // This host page loaded/reloaded while a question was already
  // loading/open — the round's state (openedAt/winnerId/etc.) already
  // exists from before, so just get this fresh player instance's local
  // playback caught up without re-running prepareQuestion()/openQuestion(),
  // which would otherwise reset an already-in-progress question's reaction
  // timing for every connected player.
  function resyncPlaybackOnly(index: number) {
    loadClipForIndex(index);
  }

  function handlePlaybackError(error: YT.PlayerError) {
    // The no-buzz/answer timers were armed against THIS clip; since it's
    // about to be auto-skipped, clear them so they can't fire later and
    // reveal/advance a completely different, unrelated question.
    audibleStartPollRef.current?.cancel();
    clearNoBuzzTimer();
    clearAnswerTimer();

    if (isEmbedNotAllowedError(error)) {
      // Permanent for this song (the video owner disabled embedding — that
      // won't change on retry), so skip it right away instead of making
      // everyone sit through the usual countdown, and exclude it from
      // future games with this quiz (see handleStartGame's excludeIndices).
      const item = currentQuizItem();
      const currentQuiz = quizRef.current;
      if (item && currentQuiz) {
        saveQuiz({
          ...currentQuiz,
          items: currentQuiz.items.map((existing) =>
            existing.id === item.id ? { ...existing, embedBlocked: true } : existing,
          ),
          updatedAt: Date.now(),
        });
      }
      setEmbedBlockedNotice(
        `「${item?.answerTitle ?? "この曲"}」は埋め込みが許可されていないため、次回以降は出題されません`,
      );
      handleNextQuestionRef.current();
      return;
    }

    setPlaybackError(describePlaybackError(error));
  }

  async function handleStartGame() {
    if (!room || !quiz || gameStartingRef.current) return;
    gameStartingRef.current = true;
    // Latch this NOW, before any writes below. startGame() below writes
    // room.status to "in_progress" and prepareQuestion() (a separate write,
    // moments later) sets round.phase to "loading" — between those two
    // writes there's a render where room already reads "in_progress" but
    // round hasn't caught up yet. Without this early latch, the reload-
    // resync effect (which exists to resume a genuinely interrupted reload)
    // can misread that in-between moment as "this page reloaded mid-
    // question" and call resyncPlaybackOnly() — starting playback outside
    // playQuestion()'s own waitForAudibleStart()/openQuestion() sequence, so
    // round.phase never opens for this question. Only the very first
    // question is exposed to this: by question 2 the ref this effect checks
    // is already latched true from question 1.
    playbackSyncedRef.current = true;
    if (quiz.items.length < MIN_QUESTIONS) {
      setGameStartError("4択クイズには4曲以上の登録が必要です");
      gameStartingRef.current = false;
      return;
    }
    const questionCount = Math.min(
      Math.max(maxQuestionsInput ?? Math.min(quiz.items.length, DEFAULT_QUESTION_COUNT), MIN_QUESTIONS),
      quiz.items.length,
    );
    // In サビ("configured") mode, a song whose chorus detection failed has
    // no reliable clip to play — keep it out of the actual question order,
    // but it still stays in quiz.items so buildChoices can use it as an
    // answer-choice distractor. "order" room mode always plays a random
    // window regardless of clip mode, so there's nothing to exclude there.
    const effectiveClipMode = room.clipMode ?? "configured";
    const isSpelling = room.answerMode === "spelling";
    const isMultiSelect = room.multiSelectMode === true;
    const excludeIndices = new Set(
      quiz.items.reduce<number[]>((acc, item, i) => {
        const chorusExcluded =
          effectiveClipMode === "configured" && room.mode !== "order" && item.chorusStatus === "failed";
        const tooShortForSpelling = isSpelling && normalizedAnswerLength(item) < MIN_SPELLING_LENGTH;
        const tooFewArtistsForMultiSelect = isMultiSelect && buildMultiSelectChoices(quiz, i) === null;
        // Unlike the chorus/spelling exclusions above, this applies no
        // matter the clip mode or room mode — if the video can't embed at
        // all, no clip mode can play it.
        if (chorusExcluded || tooShortForSpelling || tooFewArtistsForMultiSelect || item.embedBlocked) {
          acc.push(i);
        }
        return acc;
      }, []),
    );
    // Both randomizes the ORDER and randomly SELECTS which songs are in
    // play (rather than always playing every registered song), and biases
    // away from whatever the previous game with this quiz just played.
    const questionOrder = selectQuestionOrder(quiz, questionCount, excludeIndices);
    const setup = buildQuestionSetup(room, quiz, questionOrder[0]);
    if (!setup) {
      setGameStartError(
        isSpelling
          ? "文字当てを使うには、記号以外の文字を含む曲がもう少し必要です"
          : isMultiSelect
            ? "複数選択を使うには、歌手が異なる曲がもう少し必要です"
            : "選択肢を作るには、正解が異なる曲がもう少し必要です",
      );
      gameStartingRef.current = false;
      return;
    }
    setGameStartError(null);
    recordQuizPlay(
      quiz.id,
      questionOrder.map((i) => quiz.items[i].id),
    );
    // Synced "3, 2, 1" beat before the very first clip plays, so it doesn't
    // just start the instant the host clicks. The actual game-start writes
    // are delayed until the countdown elapses; re-read players/room via refs
    // at that point (not the possibly-stale `players`/`room` closed over
    // here) in case anyone joined or the mode changed during those 3 seconds.
    await startCountdown(code);
    setTimeout(async () => {
      const currentPlayers = playersRef.current;
      const turnRotation = currentPlayers.map((p) => p.id);
      await startGame(code, questionOrder, turnRotation);
      const orderTurn = resolveOrderTurnForQuestionStart(
        roomStateRef.current?.mode,
        currentPlayers,
        turnRotation,
        0,
      );
      // Safe to publish immediately: nobody's been scored on this question yet.
      const publicScores = Object.fromEntries(currentPlayers.map((p) => [p.id, p.score]));
      questionScoresRef.current = { ...publicScores };
      questionCorrectPlayersRef.current = [];
      await prepareQuestion(
        code,
        0,
        setup.choices,
        undefined,
        publicScores,
        setup.spelling,
        setup.multiSelect,
      );
      playQuestion(
        questionOrder[0],
        currentPlayers.map((p) => p.id),
        orderTurn,
        roomStateRef.current?.mode === "everyone" && setup.spelling
          ? { choices: setup.choices, totalLength: setup.spelling.totalLength }
          : undefined,
      );
    }, GAME_START_COUNTDOWN_MS);
  }

  async function handleNextQuestion() {
    if (!room || !quiz) return;
    const nextPosition = room.currentQuestionIndex + 1;
    if (nextPosition >= totalQuestionsFor(room, quiz)) {
      await finishGame(code);
      return;
    }
    const nextItemIndex = quizItemIndexAt(room, nextPosition);
    const setup = buildQuestionSetup(room, quiz, nextItemIndex);
    if (!setup) {
      await finishGame(code);
      return;
    }
    // Players who joined after turnRotation was last set (game start, or a
    // previous question) aren't in it yet — append them so "order" mode
    // eventually gives everyone a turn instead of permanently skipping
    // anyone who joined even slightly late.
    const existingRotation = room.turnRotation ?? [];
    const newcomerIds = players.map((p) => p.id).filter((id) => !existingRotation.includes(id));
    const turnRotation =
      newcomerIds.length > 0 ? [...existingRotation, ...newcomerIds] : existingRotation;
    const orderTurn = resolveOrderTurnForQuestionStart(
      room.mode,
      players,
      turnRotation,
      room.nextTurnStartIndex ?? 0,
    );
    // Safe to publish immediately: nobody's been scored on this question yet.
    const publicScores = Object.fromEntries(players.map((p) => [p.id, p.score]));
    questionScoresRef.current = { ...publicScores };
    questionCorrectPlayersRef.current = [];
    await prepareQuestion(
      code,
      nextPosition,
      setup.choices,
      newcomerIds.length > 0 ? turnRotation : undefined,
      publicScores,
      setup.spelling,
      setup.multiSelect,
    );
    playQuestion(
      nextItemIndex,
      players.map((p) => p.id),
      orderTurn,
      room.mode === "everyone" && setup.spelling
        ? { choices: setup.choices, totalLength: setup.spelling.totalLength }
        : undefined,
    );
  }

  // "order" mode has no auto-timeout (see the winnerId-change effect above),
  // so this is the ONLY way to move on from a stalled/disconnected turn
  // holder — skip them (no penalty, unlike a wrong guess) and hand the turn
  // to the next player in rotation. Buzzer mode keeps its original meaning:
  // reopen the round to everyone still eligible.
  async function handleResetRound() {
    clearAnswerTimer();
    if (room?.mode === "order" && round?.winnerId) {
      // Forfeits this player's turn (no penalty) before moving on, so the
      // rotation still correctly detects "everyone's had a turn" later.
      await skipPlayerTurn(code, round.winnerId);
      await advanceOrderTurn(round.winnerId);
    } else {
      await openRound(code);
    }
    resumeFromPause();
  }

  async function handleCloseEveryoneRound() {
    if (!quiz || !room || !round) return;
    clearEveryoneTimer();
    const item = quiz.items[quizItemIndexAt(room, room.currentQuestionIndex)];

    // [playerId, sortKey] — sortKey is submittedAt ("choices" mode) or
    // completedAt ("spelling" mode), both ms timestamps ranked ascending
    // (fastest correct first) into the same EVERYONE_MODE_POINTS tiers.
    let correctEntries: [string, number][];
    if (room.answerMode === "spelling") {
      const entries = round.everyoneSpelling ?? {};
      correctEntries = Object.entries(entries)
        .filter(([, entry]) => entry.completedAt != null)
        .map(([playerId, entry]): [string, number] => [playerId, entry.completedAt as number])
        .sort((a, b) => a[1] - b[1]);
    } else if (room.multiSelectMode) {
      // Each player submits their own picked SET independently (see
      // submitEveryoneMultiChoice) — correct only on an exact match against
      // this question's correctChoiceIndices, same rule as buzzer/order.
      const correctSet = new Set(round.correctChoiceIndices ?? []);
      const submissions = round.submissions ?? {};
      correctEntries = Object.entries(submissions)
        .filter(([, sub]) => {
          const picked = sub.choiceIndices ?? [];
          return (
            correctSet.size > 0 &&
            picked.length === correctSet.size &&
            picked.every((i) => correctSet.has(i))
          );
        })
        .map(([playerId, sub]): [string, number] => [playerId, sub.submittedAt])
        .sort((a, b) => a[1] - b[1]);
    } else {
      if (!round.choices) return;
      const submissions = round.submissions ?? {};
      correctEntries = Object.entries(submissions)
        .filter(([, sub]) => round.choices?.[sub.choiceIndex] === item.answerTitle)
        .map(([playerId, sub]): [string, number] => [playerId, sub.submittedAt])
        .sort((a, b) => a[1] - b[1]);
    }

    await Promise.all(
      correctEntries.map(async ([playerId], index) => {
        const points = EVERYONE_MODE_POINTS[Math.min(index, EVERYONE_MODE_POINTS.length - 1)];
        const [newScore] = await Promise.all([
          addScore(code, playerId, points),
          incrementCorrectCount(code, playerId),
        ]);
        questionScoresRef.current[playerId] = newScore;
      }),
    );
    await revealAnswer(
      code,
      { title: item.answerTitle, artist: normalizedArtists(item).join("、") },
      correctEntries.map(([playerId]) => playerId),
      { ...questionScoresRef.current },
    );
    playerRef.current?.seekTo(currentClipRangeRef.current?.startSeconds ?? item.startSeconds, true);
    playerRef.current?.resume();
  }

  if (room === undefined) {
    return (
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-8">
        <p className="text-sm text-neutral-500">読み込み中…</p>
      </main>
    );
  }

  if (room === null) {
    return (
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-8">
        <p className="text-sm text-neutral-500">ルームが見つかりませんでした。</p>
        <Link href="/room/new" className="text-sm underline">
          ルームを作り直す
        </Link>
      </main>
    );
  }

  if (room.status === "finished") {
    const ranking = [...players].sort((a, b) => b.score - a.score);
    return (
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-8">
        <h1 className="text-xl font-bold">結果発表</h1>
        <ol className="flex flex-col gap-2">
          {ranking.map((player, index) => (
            <li
              key={player.id}
              className={`flex items-center gap-3 rounded-md border p-3 ${
                index === 0
                  ? "border-amber-400 bg-amber-50 dark:bg-amber-950"
                  : "border-neutral-200 dark:border-neutral-800"
              }`}
            >
              <span className="w-6 text-center text-sm font-bold text-neutral-500">
                {index === 0 ? "🏆" : index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{player.name}</p>
                <p className="text-xs text-neutral-500">正解 {player.correctCount}問</p>
              </div>
              <span className="shrink-0 text-sm font-bold">{player.score}点</span>
            </li>
          ))}
        </ol>
        <Link href="/room/new" className="text-sm underline">
          新しいルームを作る
        </Link>
      </main>
    );
  }

  if (room.status === "in_progress") {
    const winner = round?.winnerId ? players.find((p) => p.id === round.winnerId) : undefined;
    const totalQuestions = quiz ? totalQuestionsFor(room, quiz) : 0;
    const currentItem = quiz?.items[quizItemIndexAt(room, room.currentQuestionIndex)];
    const isRevealed = game?.phase === "revealed" && !!game.answer;
    // room.currentQuestionIndex and game.phase/answer come from two separate
    // RTDB listeners, so they can land in separate renders even though the
    // underlying write was atomic. Guard the thumbnail by content, not just
    // isRevealed, so it never flashes the NEXT question's art while the
    // "revealed" game state briefly still describes the PREVIOUS one.
    const revealedItem =
      isRevealed && currentItem?.answerTitle === game?.answer?.title ? currentItem : undefined;
    const answeredCount = round?.submissions ? Object.keys(round.submissions).length : 0;
    // game.correctPlayerIds is the host's own authoritative record of who
    // got THIS question right (set at revealAnswer() time — see
    // finalizeCorrectAnswer/handleNoOneBuzzed/handleWrongAnswer/
    // handleCloseEveryoneRound), so it already works correctly across every
    // mode and answerMode combination without re-deriving it here from
    // round.submissions/choices (whose shape differs by mode, and doesn't
    // even hold full titles in answerMode "spelling").
    const correctPlayerIds = new Set(isRevealed ? (game?.correctPlayerIds ?? []) : []);
    const correctPlayerNames = isRevealed
      ? (game?.correctPlayerIds ?? [])
          .map((playerId) => players.find((p) => p.id === playerId)?.name)
          .filter((name): name is string => !!name)
      : [];

    return (
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-8">
        <p className="text-sm text-neutral-500">
          {room.quizTitle} ・ 問題 {room.currentQuestionIndex + 1} / {totalQuestions}
        </p>

        {embedBlockedNotice && (
          <p className="rounded-md bg-amber-100 px-4 py-2 text-sm text-amber-800 dark:bg-amber-900 dark:text-amber-100">
            {embedBlockedNotice}
          </p>
        )}

        <div className="relative">
          <YouTubePlayer ref={playerRef} onPlaybackError={handlePlaybackError} />
          {revealedItem?.thumbnailUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={revealedItem.thumbnailUrl}
              alt=""
              className="absolute inset-0 h-full w-full rounded-lg object-cover"
            />
          )}
        </div>

        {/* min-h reserves enough room for the tallest of these branches
            (turn holder mid-answer: title + turn count + countdown +
            button) so shorter branches — "早押し受付中…", a winner's
            green text disappearing back to idle, etc. — don't collapse
            this section and shove the 参加者 list below it up/down. */}
        <section className="flex min-h-56 flex-col items-center justify-center gap-3 rounded-lg border border-neutral-200 p-6 text-center dark:border-neutral-800">
          {playbackError ? (
            <>
              <p className="text-sm text-red-600">{playbackError}</p>
              <button
                type="button"
                onClick={handleNextQuestion}
                className="rounded-md bg-neutral-900 px-4 py-3 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
              >
                この曲をスキップして次へ
              </button>
              {skipCountdown !== null && (
                <p className="text-xs text-neutral-500">{skipCountdown}秒後に自動でスキップ</p>
              )}
            </>
          ) : isRevealed && game?.answer ? (
            <>
              {room.mode === "everyone" || room.mode === "order" ? (
                correctPlayerNames.length > 0 ? (
                  <div className="flex flex-col items-center gap-1">
                    <p className="text-sm text-neutral-500">正解者</p>
                    <p className="text-3xl font-bold text-emerald-600">
                      {correctPlayerNames.join("・")}
                    </p>
                  </div>
                ) : (
                  <p className="text-2xl font-bold text-neutral-500">誰も正解できませんでした</p>
                )
              ) : winner && correctPlayerIds.has(winner.id) ? (
                // round.winnerId (winner) just points at whoever held the
                // buzz LAST — once everyone eligible has had a wrong turn,
                // handleWrongAnswer reveals without resetting it, so a plain
                // `winner` check here would show the last WRONG answerer as
                // correct. game.correctPlayerIds (correctPlayerIds) is the
                // host's own authoritative record of who was actually right,
                // same source the player screens already use for this.
                <p className="text-3xl font-bold text-emerald-600">🎉 {winner.name} さん正解！</p>
              ) : (
                <p className="text-2xl font-bold text-neutral-500">誰も正解できませんでした</p>
              )}
              <p className="text-sm text-neutral-500">正解</p>
              <p className="text-lg font-bold">
                {game.answer.title}（{game.answer.artist}）
              </p>
              <button
                type="button"
                onClick={handleNextQuestion}
                className="rounded-md bg-neutral-900 px-4 py-3 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
              >
                次の問題へ
              </button>
              {nextQuestionCountdown !== null && (
                <p className="text-xs text-neutral-500">{nextQuestionCountdown}秒後に自動で次へ</p>
              )}
            </>
          ) : room.mode === "everyone" ? (
            <>
              <p className="text-sm text-neutral-500">回答受付中…（{answeredCount}人が回答済み）</p>
              <button
                type="button"
                onClick={handleCloseEveryoneRound}
                className="rounded-md bg-neutral-900 px-4 py-3 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
              >
                回答を締め切る
              </button>
            </>
          ) : winner ? (
            <>
              <p className="text-lg font-bold text-emerald-600">
                {room.mode === "order"
                  ? `${winner.name}さんの番です。回答`
                  : `🎉 ${winner.name}さん（${room.publicScores?.[winner.id] ?? winner.score}点）が回答`}
                {round?.selectedChoice == null ? "中…" : "しました。判定中…"}
              </p>
              {room.mode === "order" && typeof round?.turnNumber === "number" && (
                <p className="text-xs text-neutral-500">{round.turnNumber + 1}人目の挑戦</p>
              )}
              {round?.winnerReactionMs != null && (
                <p className="text-xs text-neutral-500">
                  {(round.winnerReactionMs / 1000).toFixed(2)}秒で
                  {room.mode === "order" ? "回答しました" : "押しました"}
                </p>
              )}
              {round?.selectedChoice == null && (
                <>
                  {answerCountdown !== null && (
                    <p className="text-2xl font-bold tabular-nums text-neutral-500">
                      残り{answerCountdown}秒
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={handleResetRound}
                    className="rounded-md border border-neutral-300 px-3 py-1 text-xs dark:border-neutral-700"
                  >
                    {room.mode === "order"
                      ? "回答がない場合は次の人へ"
                      : "回答がない場合は早押しをリセット"}
                  </button>
                </>
              )}
            </>
          ) : (
            <>
              <p className="text-sm text-neutral-500">早押し受付中…</p>
              {noBuzzGraceCountdown !== null && (
                <p className="text-2xl font-bold tabular-nums text-neutral-500">
                  誰も押さなければ残り{noBuzzGraceCountdown}秒で答え合わせ
                </p>
              )}
            </>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">参加者（{players.length}人）</h2>
          <ul className="flex flex-col gap-2">
            {[...players]
              .sort((a, b) => {
                // In "order" mode, sort by rotation position (not score) so
                // the "N番" badges below actually read 1, 2, 3… top to
                // bottom instead of appearing scrambled by score.
                if (room.mode === "order" && room.turnRotation) {
                  const turnRotation = room.turnRotation;
                  const idxA = turnRotation.indexOf(a.id);
                  const idxB = turnRotation.indexOf(b.id);
                  return (idxA === -1 ? Infinity : idxA) - (idxB === -1 ? Infinity : idxB);
                }
                // publicScores, not the live score — otherwise a row could
                // visibly jump position the instant someone's answer is
                // scored, leaking right/wrong before the reveal even without
                // showing the number itself.
                const scoreA = room.publicScores?.[a.id] ?? a.score;
                const scoreB = room.publicScores?.[b.id] ?? b.score;
                return scoreB - scoreA;
              })
              .map((player) => {
                const gotItRight = correctPlayerIds.has(player.id);
                const isCurrentTurn = room.mode === "order" && round?.winnerId === player.id;
                return (
                <li
                  key={player.id}
                  className={`flex items-center gap-3 rounded-md border p-2 ${
                    gotItRight
                      ? "border-amber-400 bg-amber-50 dark:bg-amber-950"
                      : isCurrentTurn
                        ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950"
                        : "border-neutral-200 dark:border-neutral-800"
                  }`}
                >
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${player.connected ? "bg-emerald-500" : "bg-neutral-300"}`}
                  />
                  {room.mode === "order" &&
                    room.turnRotation &&
                    room.turnRotation.indexOf(player.id) !== -1 && (
                      <span className="shrink-0 rounded-full border border-neutral-300 px-1.5 py-0.5 text-xs text-neutral-500 dark:border-neutral-700">
                        {room.turnRotation.indexOf(player.id) + 1}番
                      </span>
                    )}
                  <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-sm">
                    <span className="truncate">{player.name}</span>
                    {gotItRight && (
                      <span className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700 dark:bg-amber-900 dark:text-amber-300">
                        🎉正解
                      </span>
                    )}
                  </span>
                  {/* publicScores, not the live player.score — the host's
                      screen is often displayed on a shared/projected screen,
                      so it needs the same reveal-time gate as player
                      screens: a live score would tell everyone watching
                      whether this press was right or wrong before the
                      official reveal. */}
                  <span className="shrink-0 text-sm font-bold">
                    {room.publicScores?.[player.id] ?? player.score}点
                  </span>
                  {uid === room.hostId && (
                    <button
                      type="button"
                      onClick={() => handleToggleBanned(player)}
                      className={`shrink-0 rounded-md border px-2 py-1 text-xs ${player.banned ? "border-red-300 text-red-600 dark:border-red-800" : "border-neutral-300 dark:border-neutral-700"}`}
                    >
                      {player.banned ? "禁止解除" : room.mode === "buzzer" ? "早押し禁止" : "回答禁止"}
                    </button>
                  )}
                </li>
                );
              })}
          </ul>
        </section>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-8">
      <div className="flex flex-col gap-1">
        <p className="text-sm text-neutral-500">{room.quizTitle}</p>
        <h1 className="text-xl font-bold">ロビー</h1>
      </div>

      <section className="flex flex-col items-center gap-3 rounded-lg border border-neutral-200 p-6 dark:border-neutral-800">
        <p className="text-sm text-neutral-500">ルームコード</p>
        <p className="text-5xl font-bold tracking-widest">{code}</p>
        {qrDataUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={qrDataUrl} alt="参加用QRコード" className="h-48 w-48" />
        )}
        <div className="flex w-full items-center gap-2">
          <input
            readOnly
            value={joinUrl}
            className="flex-1 truncate rounded-md border border-neutral-300 px-3 py-2 text-xs dark:border-neutral-700 dark:bg-neutral-900"
          />
          <button
            type="button"
            onClick={handleCopy}
            className="shrink-0 rounded-md border border-neutral-300 px-3 py-2 text-xs dark:border-neutral-700"
          >
            {copied ? "コピーしました" : "コピー"}
          </button>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">出題モード</h2>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => handleSetMode("buzzer")}
            className={`flex-1 rounded-md border px-3 py-3 text-sm ${
              (room.mode ?? "buzzer") === "buzzer"
                ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                : "border-neutral-300 dark:border-neutral-700"
            }`}
          >
            早押し
            <span className="block text-xs opacity-70">最初に押した人が回答</span>
          </button>
          <button
            type="button"
            onClick={() => handleSetMode("everyone")}
            className={`flex-1 rounded-md border px-3 py-3 text-sm ${
              room.mode === "everyone"
                ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                : "border-neutral-300 dark:border-neutral-700"
            }`}
          >
            全員回答
            <span className="block text-xs opacity-70">早く正解した人ほど高得点</span>
          </button>
          <button
            type="button"
            onClick={() => handleSetMode("order")}
            className={`flex-1 rounded-md border px-3 py-3 text-sm ${
              room.mode === "order"
                ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                : "border-neutral-300 dark:border-neutral-700"
            }`}
          >
            順番
            <span className="block text-xs opacity-70">回答権が順番にまわる</span>
          </button>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">再生範囲</h2>
        {room.mode === "order" ? (
          <p className="text-sm text-neutral-500">
            順番モードでは常にランダムな位置から曲の最後まで再生されます
          </p>
        ) : (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => handleSetClipMode("configured")}
              className={`flex-1 rounded-md border px-3 py-3 text-sm ${
                (room.clipMode ?? "configured") === "configured"
                  ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                  : "border-neutral-300 dark:border-neutral-700"
              }`}
            >
              サビ
              <span className="block text-xs opacity-70">登録時に設定した範囲</span>
            </button>
            <button
              type="button"
              onClick={() => handleSetClipMode("intro")}
              className={`flex-1 rounded-md border px-3 py-3 text-sm ${
                room.clipMode === "intro"
                  ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                  : "border-neutral-300 dark:border-neutral-700"
              }`}
            >
              イントロ（{SPECIAL_CLIP_SECONDS}秒）
              <span className="block text-xs opacity-70">曲の最初から</span>
            </button>
            <button
              type="button"
              onClick={() => handleSetClipMode("random")}
              className={`flex-1 rounded-md border px-3 py-3 text-sm ${
                room.clipMode === "random"
                  ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                  : "border-neutral-300 dark:border-neutral-700"
              }`}
            >
              ランダム（{SPECIAL_CLIP_SECONDS}秒）
              <span className="block text-xs opacity-70">毎回ランダムな範囲</span>
            </button>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">回答方式</h2>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => handleSetAnswerMode("choices")}
            className={`flex-1 rounded-md border px-3 py-3 text-sm ${
              (room.answerMode ?? "choices") === "choices"
                ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                : "border-neutral-300 dark:border-neutral-700"
            }`}
          >
            4択
            <span className="block text-xs opacity-70">正解のタイトルを丸ごと選ぶ</span>
          </button>
          <button
            type="button"
            onClick={() => handleSetAnswerMode("spelling")}
            disabled={room.multiSelectMode === true}
            className={`flex-1 rounded-md border px-3 py-3 text-sm disabled:cursor-not-allowed disabled:opacity-40 ${
              room.answerMode === "spelling"
                ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                : "border-neutral-300 dark:border-neutral-700"
            }`}
          >
            文字当て
            <span className="block text-xs opacity-70">1文字ずつ選んで正解を当てる</span>
          </button>
        </div>
        {room.multiSelectMode === true && (
          <p className="text-xs text-neutral-500">複数選択モード中は4択のみ使えます</p>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">複数選択（歌手当て）</h2>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => handleSetMultiSelectMode(false)}
            className={`flex-1 rounded-md border px-3 py-3 text-sm ${
              room.multiSelectMode !== true
                ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                : "border-neutral-300 dark:border-neutral-700"
            }`}
          >
            通常
          </button>
          <button
            type="button"
            onClick={() => handleSetMultiSelectMode(true)}
            className={`flex-1 rounded-md border px-3 py-3 text-sm ${
              room.multiSelectMode === true
                ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                : "border-neutral-300 dark:border-neutral-700"
            }`}
          >
            複数選択
            <span className="block text-xs opacity-70">歌手を選ぶ・コラボは複数正解</span>
          </button>
        </div>
      </section>

      {room.mode === "everyone" && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">回答時間</h2>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => handleSetEveryoneTimeMode("full")}
              className={`flex-1 rounded-md border px-3 py-3 text-sm ${
                (room.everyoneTimeMode ?? "full") === "full"
                  ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                  : "border-neutral-300 dark:border-neutral-700"
              }`}
            >
              最後まで
              <span className="block text-xs opacity-70">全員が回答/スキップするまで待つ</span>
            </button>
            <button
              type="button"
              onClick={() => handleSetEveryoneTimeMode("timed")}
              className={`flex-1 rounded-md border px-3 py-3 text-sm ${
                room.everyoneTimeMode === "timed"
                  ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                  : "border-neutral-300 dark:border-neutral-700"
              }`}
            >
              15秒
              <span className="block text-xs opacity-70">開始から15秒で自動的に締め切る</span>
            </button>
          </div>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">早押しロック時間</h2>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={0}
            max={2000}
            step={50}
            value={room.buzzLockoutMs ?? DEFAULT_BUZZ_LOCKOUT_MS}
            onChange={(e) => handleSetBuzzLockoutMs(Number(e.target.value))}
            className="w-20 rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          <span className="text-sm text-neutral-500">
            ms（曲が流れ始めてからこの時間はボタンを押しても無効）
          </span>
        </div>
      </section>

      {quiz && quiz.items.length > MIN_QUESTIONS && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">出題数</h2>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={MIN_QUESTIONS}
              max={quiz.items.length}
              value={Math.min(
                Math.max(maxQuestionsInput ?? Math.min(quiz.items.length, DEFAULT_QUESTION_COUNT), MIN_QUESTIONS),
                quiz.items.length,
              )}
              onChange={(e) => setMaxQuestionsInput(Number(e.target.value))}
              className="w-20 rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
            <span className="text-sm text-neutral-500">
              問（登録{quiz.items.length}曲からランダムに選出）
            </span>
          </div>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">参加者（{players.length}人）</h2>
        {players.length === 0 && (
          <p className="text-sm text-neutral-500">まだ参加者がいません。</p>
        )}
        <ul className="flex flex-col gap-2">
          {players.map((player) => (
            <li
              key={player.id}
              className="flex items-center gap-3 rounded-md border border-neutral-200 p-2 dark:border-neutral-800"
            >
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${player.connected ? "bg-emerald-500" : "bg-neutral-300"}`}
              />
              <span className="min-w-0 flex-1 truncate text-sm">{player.name}</span>
              {uid === room.hostId && (
                <>
                  <button
                    type="button"
                    onClick={() => handleToggleBanned(player)}
                    className={`shrink-0 rounded-md border px-2 py-1 text-xs ${player.banned ? "border-red-300 text-red-600 dark:border-red-800" : "border-neutral-300 dark:border-neutral-700"}`}
                  >
                    {player.banned ? "禁止解除" : room.mode === "buzzer" ? "早押し禁止" : "回答禁止"}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleKick(player.id)}
                    className="shrink-0 rounded-md border border-red-300 px-2 py-1 text-xs text-red-600 dark:border-red-800"
                  >
                    追放
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      </section>

      {quiz === null ? (
        <p className="text-sm text-red-600">
          このクイズのデータが見つかりませんでした。クイズを作成した端末でルームを作り直してください。
        </p>
      ) : gameStartCountdown !== null ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-neutral-200 py-8 dark:border-neutral-800">
          <p className="text-sm text-neutral-500">まもなく開始します…</p>
          <p className="text-6xl font-bold tabular-nums">
            {gameStartCountdown > 0 ? gameStartCountdown : "0"}
          </p>
        </div>
      ) : (
        <>
          {gameStartError && <p className="text-sm text-red-600">{gameStartError}</p>}
          <button
            type="button"
            onClick={handleStartGame}
            disabled={!quiz}
            className="rounded-md bg-neutral-900 px-4 py-3 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900"
          >
            ゲームを開始
          </button>
        </>
      )}
    </main>
  );
}
