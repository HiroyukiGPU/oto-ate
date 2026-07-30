import { backend } from "@/lib/sync/backend";
import type {
  AnswerMode,
  ClipMode,
  EveryoneSpellingEntry,
  EveryoneTimeMode,
  Game,
  GameAnswer,
  Player,
  Room,
  RoomMode,
  Round,
} from "@/lib/types";

const { ref, get, set, update, remove, onValue, runTransaction, onDisconnect, serverTimestamp } =
  backend;

export const ANSWER_TIME_LIMIT_MS = 5000;
// "everyone" mode, Room.everyoneTimeMode "timed" only: the round auto-closes
// this long after opening no matter who has/hasn't answered yet — see
// EveryoneTimeMode in src/lib/types.ts.
export const EVERYONE_TIME_LIMIT_MS = 15000;
export const REVEAL_AUTO_ADVANCE_MS = 5000;
export const NO_BUZZ_GRACE_MS = 5000;
// Default for Room.buzzLockoutMs (host-configurable) — minimum time after
// round.openedAt before a buzz is accepted. Blocks presses that land before
// the player could have actually heard the clip start (audio/network
// latency, or a reflexive press right as the round opens), which would
// otherwise let a lucky guess beat everyone who's actually listening.
export const DEFAULT_BUZZ_LOCKOUT_MS = 200;
// How long the synced "3, 2, 1" countdown runs before the very first
// question of a game actually starts.
export const GAME_START_COUNTDOWN_MS = 3000;

// "order" mode scoring: base points fall off per turn used on the question
// (earlier turns get less information than later ones, so they're worth
// more), plus a small bonus for answering quickly within your own turn.
const ORDER_MODE_BASE_POINTS = 100;
const ORDER_MODE_TURN_PENALTY = 15;
const ORDER_MODE_MIN_BASE_POINTS = 20;
const ORDER_MODE_TIME_BONUS_MAX = 20;
const ORDER_MODE_TIME_BONUS_STEP_MS = 500;

export function computeOrderModeScore(turnNumber: number, reactionMs: number): number {
  const base = Math.max(
    ORDER_MODE_MIN_BASE_POINTS,
    ORDER_MODE_BASE_POINTS - turnNumber * ORDER_MODE_TURN_PENALTY,
  );
  const timeBonus = Math.max(
    0,
    ORDER_MODE_TIME_BONUS_MAX - Math.floor(reactionMs / ORDER_MODE_TIME_BONUS_STEP_MS),
  );
  return base + timeBonus;
}

function generateRoomCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export async function createRoom(params: {
  quizId: string;
  quizTitle: string;
  hostId: string;
}): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generateRoomCode();
    const roomRef = ref(`rooms/${code}`);
    const snapshot = await get(roomRef);
    if (snapshot.exists()) continue;

    await set(roomRef, {
      code,
      hostId: params.hostId,
      quizId: params.quizId,
      quizTitle: params.quizTitle,
      status: "waiting",
      mode: "buzzer",
      clipMode: "configured",
      answerMode: "choices",
      multiSelectMode: false,
      everyoneTimeMode: "full",
      buzzLockoutMs: DEFAULT_BUZZ_LOCKOUT_MS,
      currentQuestionIndex: 0,
      createdAt: serverTimestamp(),
      hostConnected: true,
      round: {
        phase: "idle",
        openedAt: null,
        questionStartedAt: null,
        turnStartedAt: null,
        turnNumber: null,
        winnerId: null,
        winnerReactionMs: null,
        buzzAttempts: null,
        choices: null,
        selectedChoice: null,
        selectedChoices: null,
        correctChoiceIndices: null,
        submissions: null,
        spelling: null,
        everyoneSpelling: null,
      },
      game: {
        phase: "playing",
        answer: null,
        correctPlayerIds: [],
      },
    });
    return code;
  }
  throw new Error("ルームコードの発行に失敗しました。もう一度お試しください。");
}

export async function roomExists(code: string): Promise<boolean> {
  const snapshot = await get(ref(`rooms/${code}`));
  return snapshot.exists();
}

export function subscribeRoom(code: string, callback: (room: Room | null) => void): () => void {
  const roomRef = ref(`rooms/${code}`);
  return onValue(roomRef, (snapshot) => callback(snapshot.val()));
}

export function subscribePlayers(code: string, callback: (players: Player[]) => void): () => void {
  const playersRef = ref(`rooms/${code}/players`);
  return onValue(playersRef, (snapshot) => {
    const value = snapshot.val() as Record<string, Omit<Player, "id">> | null;
    const players = value
      ? Object.entries(value).map(([id, player]) => ({ id, ...player }))
      : [];
    callback(players.sort((a, b) => a.joinedAt - b.joinedAt));
  });
}

export function subscribePlayer(
  code: string,
  uid: string,
  callback: (player: Player | null) => void,
): () => void {
  const playerRef = ref(`rooms/${code}/players/${uid}`);
  return onValue(playerRef, (snapshot) => {
    const value = snapshot.val();
    callback(value ? { id: uid, ...value } : null);
  });
}

export async function joinRoom(code: string, uid: string, name: string): Promise<void> {
  const playerRef = ref(`rooms/${code}/players/${uid}`);
  await set(playerRef, {
    name,
    score: 0,
    correctCount: 0,
    connected: true,
    canAnswer: true,
    banned: false,
    joinedAt: Date.now(),
  });
  onDisconnect(playerRef).update({ connected: false });
}

export async function setRoomMode(code: string, mode: RoomMode): Promise<void> {
  await update(ref(`rooms/${code}`), { mode });
}

export async function setClipMode(code: string, clipMode: ClipMode): Promise<void> {
  await update(ref(`rooms/${code}`), { clipMode });
}

export async function setAnswerMode(code: string, answerMode: AnswerMode): Promise<void> {
  await update(ref(`rooms/${code}`), { answerMode });
}

// multiSelectMode is mutually exclusive with answerMode "spelling" (see
// Room.multiSelectMode) — turning it on forces answerMode back to "choices"
// in the same write so a room can never be left in the nonsensical
// "spelling" + "multiSelect" combination.
export async function setMultiSelectMode(code: string, multiSelectMode: boolean): Promise<void> {
  const updates: Record<string, unknown> = { multiSelectMode };
  if (multiSelectMode) {
    updates.answerMode = "choices";
  }
  await update(ref(`rooms/${code}`), updates);
}

export async function setEveryoneTimeMode(
  code: string,
  everyoneTimeMode: EveryoneTimeMode,
): Promise<void> {
  await update(ref(`rooms/${code}`), { everyoneTimeMode });
}

export async function setBuzzLockoutMs(code: string, buzzLockoutMs: number): Promise<void> {
  await update(ref(`rooms/${code}`), { buzzLockoutMs });
}

export async function markPlayerConnected(code: string, uid: string): Promise<void> {
  const playerRef = ref(`rooms/${code}/players/${uid}`);
  await update(playerRef, { connected: true });
  onDisconnect(playerRef).update({ connected: false });
}

export async function setPlayerBanned(code: string, uid: string, banned: boolean): Promise<void> {
  await update(ref(`rooms/${code}/players/${uid}`), { banned });
}

export async function markHostConnected(code: string): Promise<void> {
  const roomRef = ref(`rooms/${code}`);
  await update(roomRef, { hostConnected: true });
  onDisconnect(roomRef).update({ hostConnected: false });
}

export async function kickPlayer(code: string, uid: string): Promise<void> {
  await remove(ref(`rooms/${code}/players/${uid}`));
}

export async function leaveRoom(code: string, uid: string): Promise<void> {
  // Keep the player's name and score in the room so they remain in the
  // final ranking. Game progression ignores disconnected players; an
  // explicit host kick still removes the record via kickPlayer().
  await update(ref(`rooms/${code}/players/${uid}`), { connected: false });
}

export function subscribeRound(code: string, callback: (round: Round | null) => void): () => void {
  const roundRef = ref(`rooms/${code}/round`);
  return onValue(roundRef, (snapshot) => callback(snapshot.val()));
}

export async function openRound(code: string): Promise<void> {
  await update(ref(`rooms/${code}/round`), {
    phase: "open",
    openedAt: serverTimestamp(),
    winnerId: null,
    turnStartedAt: null,
    turnNumber: null,
    winnerReactionMs: null,
    buzzAttempts: null,
    selectedChoice: null,
    selectedChoices: null,
  });
}

export async function buzzIn(code: string, uid: string, reactionMs: number): Promise<boolean> {
  const winnerRef = ref(`rooms/${code}/round/winnerId`);
  // applyLocally: false — when two players buzz within the same round trip,
  // each client's transaction would otherwise optimistically (and locally
  // only) apply ITS OWN uid as the winner before the server arbitrates,
  // flashing the 4-choice screen on the client that's about to lose the
  // race. Waiting for the server's authoritative result avoids that.
  const result = await runTransaction(
    winnerRef,
    (current) => {
      if (current !== null) return undefined;
      return uid;
    },
    { applyLocally: false },
  );
  // Record THIS player's own attempt time regardless of whether they won —
  // otherwise a player who loses a close race never finds out how their own
  // reaction compared to the winner's.
  const updates: Record<string, unknown> = { [`buzzAttempts/${uid}`]: reactionMs };
  if (result.committed) {
    // Synced (not just kept client-local) so every player and the host can
    // see how fast the winner actually buzzed in, not just the winner.
    updates.winnerReactionMs = reactionMs;
  }
  await update(ref(`rooms/${code}/round`), updates);
  return result.committed;
}

export async function submitChoice(
  code: string,
  choiceIndex: number,
  reactionMs?: number,
): Promise<boolean> {
  // "order" mode has no buzz race to time — the reaction clock instead runs
  // from turnStartedAt, so the caller computes and passes it in here. Written
  // BEFORE the selectedChoice transaction below (and awaited first) so the
  // host never observes selectedChoice change while winnerReactionMs is
  // still the stale value from a previous turn.
  if (reactionMs != null) {
    await update(ref(`rooms/${code}/round`), { winnerReactionMs: reactionMs });
  }
  const selectedRef = ref(`rooms/${code}/round/selectedChoice`);
  const result = await runTransaction(selectedRef, (current) => {
    if (current !== null) return undefined;
    return choiceIndex;
  });
  return result.committed;
}

// Room.multiSelectMode, buzzer/order only: the current answerer's/turn
// holder's final picked SET, submitted once via a "決定" action instead of a
// single tap — see Round.selectedChoices. An empty array is a valid
// submission (nothing looked right); the transaction guard just prevents a
// double-submit from silently overwriting an already-pending pick, same as
// submitChoice above.
export async function submitMultiChoice(
  code: string,
  choiceIndices: number[],
  reactionMs?: number,
): Promise<boolean> {
  if (reactionMs != null) {
    await update(ref(`rooms/${code}/round`), { winnerReactionMs: reactionMs });
  }
  const selectedRef = ref(`rooms/${code}/round/selectedChoices`);
  const result = await runTransaction(selectedRef, (current) => {
    if (current !== null) return undefined;
    return choiceIndices;
  });
  return result.committed;
}

export async function submitEveryoneChoice(
  code: string,
  uid: string,
  choiceIndex: number,
): Promise<void> {
  await set(ref(`rooms/${code}/round/submissions/${uid}`), {
    choiceIndex,
    submittedAt: serverTimestamp(),
  });
}

// Room.multiSelectMode, "everyone" mode: each player submits their own picked
// SET independently (round.choices/correctChoiceIndices are shared, like
// "choices" mode's single-pick submissions) — an empty array is this mode's
// "skip" (see the player-facing skip button, used in EveryoneTimeMode
// "full" so one undecided player can't stall the round forever).
export async function submitEveryoneMultiChoice(
  code: string,
  uid: string,
  choiceIndices: number[],
): Promise<void> {
  await set(ref(`rooms/${code}/round/submissions/${uid}`), {
    choiceIndex: -1,
    choiceIndices,
    submittedAt: serverTimestamp(),
  });
}

export function subscribeGame(code: string, callback: (game: Game | null) => void): () => void {
  const gameRef = ref(`rooms/${code}/game`);
  return onValue(gameRef, (snapshot) => callback(snapshot.val()));
}

// Returns the score AFTER the delta is applied — callers use this to build
// an accurate publicScores snapshot without waiting for their own
// subscription to round-trip (see Room.publicScores).
export async function addScore(code: string, playerId: string, delta: number): Promise<number> {
  const scoreRef = ref(`rooms/${code}/players/${playerId}/score`);
  const result = await runTransaction(scoreRef, (current: number | null) => (current ?? 0) + delta);
  return (result.snapshot.val() as number | null) ?? 0;
}

export async function incrementCorrectCount(code: string, playerId: string): Promise<void> {
  const countRef = ref(`rooms/${code}/players/${playerId}/correctCount`);
  await runTransaction(countRef, (current: number | null) => (current ?? 0) + 1);
}

export async function revealAnswer(
  code: string,
  answer: GameAnswer,
  // Every player who got THIS question right — empty if nobody did (nobody
  // buzzed in time, everyone answered wrong, etc.). The host computes this
  // itself at the exact moment it decides to reveal, since only it knows
  // which case just happened; see src/lib/types.ts's Game.correctPlayerIds.
  correctPlayerIds: string[],
  publicScores?: Record<string, number>,
): Promise<void> {
  // Single atomic update: publicScores becomes visible in the SAME write as
  // the reveal itself, so no client can ever observe "revealed" without the
  // final scores (or vice versa).
  const updates: Record<string, unknown> = {
    "game/phase": "revealed",
    "game/answer": answer,
    "game/correctPlayerIds": correctPlayerIds,
  };
  if (publicScores) {
    updates.publicScores = publicScores;
  }
  await update(ref(`rooms/${code}`), updates);
}

// Kicks off the synced pre-game countdown. A plain client timestamp (not
// serverTimestamp()) is fine here — every screen is just counting down to a
// shared "get ready" moment, not scoring anything off it, so the usual
// clock-skew concerns don't apply.
export async function startCountdown(code: string): Promise<void> {
  await update(ref(`rooms/${code}`), {
    countdownEndsAt: Date.now() + GAME_START_COUNTDOWN_MS,
  });
}

export async function startGame(
  code: string,
  questionOrder: number[],
  turnRotation: string[],
): Promise<void> {
  // turnRotation is captured once here (join order at game start) and reused
  // for the whole game, even in modes that don't use it — cheap to store,
  // and "order" mode needs it fixed rather than re-derived each question.
  await update(ref(`rooms/${code}`), {
    status: "in_progress",
    questionOrder,
    turnRotation,
    nextTurnStartIndex: 0,
    countdownEndsAt: null,
  });
}

// Sets up everything needed to show a new question EXCEPT actually opening
// it for answers — choices are ready and playback can be issued, but
// round.phase stays "loading" until the host confirms real audible playback
// via openQuestion() below. Splitting this from openQuestion() is what lets
// reaction-time clocks (openedAt/turnStartedAt) start from the moment audio
// is actually confirmed playing, not from whenever this was called.
export async function prepareQuestion(
  code: string,
  questionIndex: number,
  choices: string[],
  // "order" mode: pass an updated rotation array when players have joined
  // since it was last set, so they're appended instead of being permanently
  // excluded from ever getting a turn.
  turnRotation?: string[],
  // Snapshot of every player's score as of THIS question's start — safe to
  // publish immediately since nobody's been scored on it yet. See
  // Room.publicScores.
  publicScores?: Record<string, number>,
  // answerMode "spelling" (buzzer/order): the shared spelling progress for
  // this question, starting at position 0. `choices` above is already this
  // question's FIRST character's 4 choices in that case — see
  // buildSpellingStepChoices in src/lib/spelling.ts.
  spelling?: { totalLength: number },
  // Room.multiSelectMode only: the exact index set into `choices` above that
  // counts as correct for this question — see Round.correctChoiceIndices and
  // buildMultiSelectChoices in src/app/room/[code]/host/page.tsx.
  multiSelect?: { correctIndices: number[] },
): Promise<void> {
  // A single multi-path update() is atomic in RTDB: listeners never observe an
  // in-between state (e.g. currentQuestionIndex already pointing at the next
  // question while game.phase is still "revealed" from the previous one,
  // which briefly flashed the next question's thumbnail).
  const updates: Record<string, unknown> = {
    currentQuestionIndex: questionIndex,
    "game/phase": "playing",
    "game/answer": null,
    "round/choices": choices,
    "round/submissions": null,
    "round/phase": "loading",
    "round/openedAt": null,
    "round/questionStartedAt": null,
    "round/winnerId": null,
    "round/turnStartedAt": null,
    "round/turnNumber": null,
    "round/winnerReactionMs": null,
    "round/buzzAttempts": null,
    "round/selectedChoice": null,
    "round/selectedChoices": null,
    "round/correctChoiceIndices": multiSelect ? multiSelect.correctIndices : null,
    "round/spelling": spelling
      ? { position: 0, totalLength: spelling.totalLength, confirmedChars: [] }
      : null,
    // "everyone" mode + spelling seeds this separately via initEveryoneSpelling()
    // once the round is open (needs the confirmed player list) — always clear
    // it here so a previous question's entries can't leak into this one.
    "round/everyoneSpelling": null,
  };
  if (turnRotation) {
    updates.turnRotation = turnRotation;
  }
  if (publicScores) {
    updates.publicScores = publicScores;
  }
  await update(ref(`rooms/${code}`), updates);
}

// Called once the host has confirmed the clip is genuinely audible (see
// waitForAudibleStart in src/app/room/[code]/host/page.tsx) — this is the
// moment buzzing/answering actually opens, and reaction-time clocks
// (openedAt/turnStartedAt) start counting from HERE rather than from
// prepareQuestion(), so a player's measured reaction time never includes
// YouTube's own buffering delay.
export async function openQuestion(
  code: string,
  playerIds: string[],
  // "order" mode assigns the first turn immediately instead of waiting for
  // a buzz — reuses winnerId so the existing buzzer/everyone UI branches
  // (choice picker for the turn holder, waiting screen for everyone else)
  // work for it unchanged.
  orderTurn?: { playerId: string; nextTurnStartIndex: number },
): Promise<void> {
  const updates: Record<string, unknown> = {
    "round/phase": "open",
    "round/openedAt": serverTimestamp(),
    "round/questionStartedAt": serverTimestamp(),
    "round/winnerId": orderTurn?.playerId ?? null,
    "round/turnStartedAt": orderTurn ? serverTimestamp() : null,
    "round/turnNumber": orderTurn ? 0 : null,
  };
  if (orderTurn) {
    updates.nextTurnStartIndex = orderTurn.nextTurnStartIndex;
  }
  playerIds.forEach((id) => {
    updates[`players/${id}/canAnswer`] = true;
  });
  await update(ref(`rooms/${code}`), updates);
}

// answerMode "spelling", buzzer/order: called once the current answerer
// picks the correct next character but the word isn't fully spelled yet —
// advances round.spelling.position and swaps round.choices for the next
// character's 4 options (built by src/lib/spelling.ts's
// buildSpellingStepChoices), then resets selectedChoice so the same
// selectedChoice-watching effect that handles "choices" mode can process
// the next pick. Reaching the final character is NOT handled here — the
// caller uses the existing markAnswerCorrect/markOrderAnswerCorrect flow for
// that, unchanged.
export async function advanceSpellingStep(
  code: string,
  position: number,
  choices: string[],
  confirmedChars: string[],
): Promise<void> {
  await update(ref(`rooms/${code}/round`), {
    "spelling/position": position,
    "spelling/confirmedChars": confirmedChars,
    choices,
    selectedChoice: null,
  });
}

// answerMode "spelling", "everyone" mode: seeds every eligible player's
// independent spelling progress once the round opens. Each player gets
// their OWN copy of the first step's choices (computed once by the host —
// same 4 characters for everyone at position 0, since nobody's diverged
// yet).
export async function initEveryoneSpelling(
  code: string,
  playerIds: string[],
  firstStepChoices: string[],
  totalLength: number,
): Promise<void> {
  const entries: Record<string, EveryoneSpellingEntry> = {};
  playerIds.forEach((id) => {
    entries[id] = {
      position: 0,
      totalLength,
      choices: firstStepChoices,
      confirmedChars: [],
      pendingChoiceIndex: null,
      failed: false,
      completedAt: null,
    };
  });
  await update(ref(`rooms/${code}/round`), { everyoneSpelling: entries });
}

// answerMode "spelling", "everyone" mode: this player's pick for their OWN
// current character step — a transaction (like submitChoice) so a
// double-submit can't silently overwrite an already-pending pick before the
// host has processed it.
export async function submitEveryoneSpellingChoice(
  code: string,
  uid: string,
  characterIndex: number,
): Promise<boolean> {
  const pendingRef = ref(`rooms/${code}/round/everyoneSpelling/${uid}/pendingChoiceIndex`);
  const result = await runTransaction(pendingRef, (current) => {
    if (current !== null) return undefined;
    return characterIndex;
  });
  return result.committed;
}

// answerMode "spelling", "everyone" mode: the host's resolution of one
// player's pendingChoiceIndex — advances their position/choices, marks them
// completed once they've spelled the whole title, or marks them failed on a
// wrong pick. Always clears pendingChoiceIndex so the next pick can land.
export async function resolveEveryoneSpellingStep(
  code: string,
  uid: string,
  result:
    | { position: number; choices: string[]; confirmedChars: string[] }
    | { completedAt: number }
    | { failed: true },
): Promise<void> {
  const entryRef = ref(`rooms/${code}/round/everyoneSpelling/${uid}`);
  if ("failed" in result) {
    await update(entryRef, { failed: true, pendingChoiceIndex: null });
  } else if ("completedAt" in result) {
    await update(entryRef, { completedAt: result.completedAt, pendingChoiceIndex: null });
  } else {
    await update(entryRef, {
      position: result.position,
      choices: result.choices,
      confirmedChars: result.confirmedChars,
      pendingChoiceIndex: null,
    });
  }
}

// "order" mode: hands the turn directly to a specific player (no race),
// resetting their personal reaction clock. turnNumber is the caller-computed
// 0-based count of turns used on this question so far, feeding the
// order-correction part of computeOrderModeScore.
export async function assignNextTurn(
  code: string,
  playerId: string,
  turnNumber: number,
): Promise<void> {
  await update(ref(`rooms/${code}/round`), {
    phase: "open",
    winnerId: playerId,
    turnStartedAt: serverTimestamp(),
    turnNumber,
    winnerReactionMs: null,
    selectedChoice: null,
    selectedChoices: null,
  });
}

// currentScores is the caller's best-known snapshot of every player's score
// BEFORE this one is applied (typically accumulated across the question's
// earlier turns) — merged with the fresh post-delta score here and passed
// straight to revealAnswer's publicScores, so nobody ever has to wait for
// their own players/{id}/score subscription to round-trip.
export async function markAnswerCorrect(
  code: string,
  playerId: string,
  answer: GameAnswer,
  points: number = 100,
  currentScores?: Record<string, number>,
): Promise<void> {
  const newScore = await addScore(code, playerId, points);
  await incrementCorrectCount(code, playerId);
  const publicScores = currentScores ? { ...currentScores, [playerId]: newScore } : undefined;
  await revealAnswer(code, answer, [playerId], publicScores);
}

// "order" mode: awards points for a correct answer WITHOUT revealing —
// everyone in the rotation gets a turn on the same question regardless of
// whether earlier turns were right or wrong, so the question only ends once
// nobody's left (the caller decides that via advanceOrderTurn). Locks the
// player out of a second turn on this question the same way a wrong answer
// does. Returns the post-delta score so the caller can accumulate it into
// the question's running publicScores snapshot for whenever it does reveal.
export async function markOrderAnswerCorrect(
  code: string,
  playerId: string,
  points: number,
): Promise<number> {
  const newScore = await addScore(code, playerId, points);
  await incrementCorrectCount(code, playerId);
  await update(ref(`rooms/${code}/players/${playerId}`), { canAnswer: false });
  return newScore;
}

// Deducts the wrong-answer penalty and locks the player out of the rest of
// this question. Does NOT reopen the round or advance turns — callers decide
// what happens next (buzzer mode re-opens to everyone via openRound();
// "order" mode hands the turn to the next player via assignNextTurn(), or
// reveals if nobody's left). Returns the post-delta score for the same
// reason markOrderAnswerCorrect does.
export async function markAnswerIncorrect(code: string, playerId: string): Promise<number> {
  const newScore = await addScore(code, playerId, -30);
  await update(ref(`rooms/${code}/players/${playerId}`), { canAnswer: false });
  return newScore;
}

// "order" mode: the host manually skipping a stalled/disconnected turn
// holder. No score penalty (unlike a wrong guess) — just forfeits their one
// turn on this question, same as markAnswerIncorrect/markOrderAnswerCorrect
// do after an actual answer, so the rotation still correctly detects
// "everyone's had a turn" later in the same question.
export async function skipPlayerTurn(code: string, playerId: string): Promise<void> {
  await update(ref(`rooms/${code}/players/${playerId}`), { canAnswer: false });
}

export async function finishGame(code: string): Promise<void> {
  await update(ref(`rooms/${code}`), { status: "finished" });
  await update(ref(`rooms/${code}/game`), { phase: "finished" });
}
