export type Difficulty = "easy" | "normal" | "hard";

export type QuizItem = {
  id: string;
  videoId: string;
  title: string;
  channelTitle: string;
  thumbnailUrl: string;
  duration: number | null;
  startSeconds: number;
  endSeconds: number;
  // Where the "イントロ" clip mode should start (skips silent lead-in); older
  // items saved before this existed won't have it, so read with `?? 0`.
  introStartSeconds?: number;
  answerTitle: string;
  answerArtist: string;
  acceptedAnswers: string[];
  hint: string;
  difficulty: Difficulty;
  // Background chorus-detection lifecycle for songs bulk-imported from a
  // playlist (see src/lib/chorusDetectionQueue.ts): "pending" while
  // startSeconds/endSeconds are still the crude 0〜15秒 default awaiting
  // detection, "detected" once a real chorus range has been applied,
  // "failed" if detection was attempted but didn't succeed. Left entirely
  // unset for songs whose range was set through the manual range editor
  // (single-video add/edit) — those never get auto-detected or randomly
  // substituted during gameplay.
  chorusStatus?: "pending" | "detected" | "failed";
  // Set by the host the first time this video actually fails to play in a
  // live game with a YouTube "embedding not allowed" error (see
  // src/lib/youtubePlayerError.ts) — excluded from being selected as a
  // question in future games (like chorusStatus "failed"), but still usable
  // as an answer-choice distractor since that never needs to actually play.
  embedBlocked?: boolean;
  // Room.multiSelectMode ("誰が歌っているか" quiz) only: the full set of
  // correct singer names for this song — more than one for a collab, where
  // every listed name must be picked (no more, no less) to count as
  // correct. Entered via create/page.tsx's dedicated bulk-editor textarea,
  // one comma-separated line per item. Falls back to [answerArtist] when
  // unset (songs registered before this field existed, or never bulk-edited
  // with it).
  answerArtists?: string[];
};

export type Quiz = {
  id: string;
  title: string;
  description: string;
  items: QuizItem[];
  createdAt: number;
  updatedAt: number;
  // QuizItem ids picked for the most recently started game. Used to bias the
  // NEXT game's random selection away from a repeat of the same lineup —
  // independent per-game random draws can, by chance, pick similar or
  // overlapping subsets back to back, which reads as "not really random"
  // even though no single draw is biased.
  lastPlayedItemIds?: string[];
};

export type RoomStatus = "waiting" | "in_progress" | "finished";
// "buzzer": first to buzz gets the turn. "everyone": everyone answers at
// once, ranked by submission speed. "order": the answer right rotates
// through players one at a time in a fixed order.
export type RoomMode = "buzzer" | "everyone" | "order";
// "configured" plays each item's own start/endSeconds (set in the range
// editor); "intro" always plays the first N seconds of the video; "random"
// plays a fresh random N-second window each time the question comes up.
export type ClipMode = "configured" | "intro" | "random";
// "choices": pick the whole answerTitle from 4 options (today's behavior).
// "spelling": spell the answerTitle out one character at a time, 4 choices
// per character — orthogonal to RoomMode, same as ClipMode. See
// src/lib/spelling.ts.
export type AnswerMode = "choices" | "spelling";
// "everyone" room mode only: how a question's answer window closes.
// "timed" auto-closes EVERYONE_TIME_LIMIT_MS after the question opens,
// regardless of who's answered. "full" (the long-standing behavior, kept as
// the default for rooms created before this existed) waits for every
// eligible player to submit or skip — see the player-facing skip button in
// src/app/room/[code]/player/page.tsx, which exists specifically so "full"
// mode can't be stalled by one silent player.
export type EveryoneTimeMode = "timed" | "full";

export type Room = {
  code: string;
  hostId: string;
  quizId: string;
  quizTitle: string;
  status: RoomStatus;
  mode: RoomMode;
  clipMode: ClipMode;
  // Optional so rooms created before this setting existed fall back to
  // "choices" (today's behavior).
  answerMode?: AnswerMode;
  // "誰が歌っているか"(singer-guessing) quiz sub-feature — orthogonal to
  // answerMode/roomMode like clipMode, but mutually exclusive with
  // answerMode "spelling" (spelling operates on title characters, which
  // doesn't apply once the question is "who's singing"). While true, the
  // choices offered are QuizItem.answerArtists (or [answerArtist] as a
  // fallback) rather than song titles, and the correct answer may require
  // selecting more than one option (a collab) — see buildMultiSelectChoices
  // in src/app/room/[code]/host/page.tsx. Optional so existing rooms default
  // to off.
  multiSelectMode?: boolean;
  // "everyone" mode only; see EveryoneTimeMode. Optional so rooms created
  // before this setting existed keep the original "full" behavior.
  everyoneTimeMode?: EveryoneTimeMode;
  currentQuestionIndex: number;
  questionOrder?: number[];
  createdAt: number;
  hostConnected: boolean;
  // Host-configurable delay after round.openedAt during which buzzes are
  // ignored (see DEFAULT_BUZZ_LOCKOUT_MS). Optional so rooms created before
  // this setting existed fall back to the default.
  buzzLockoutMs?: number;
  // "order" mode only: the fixed player-id sequence the answer right rotates
  // through, captured once when the game starts (join order at that moment).
  turnRotation?: string[];
  // "order" mode only: index into turnRotation for who starts the NEXT
  // question. Advances by one every question (regardless of how many turns
  // that question took), so the "who goes first" advantage rotates fairly
  // across the whole game rather than resetting each question.
  nextTurnStartIndex?: number;
  // A snapshot of every player's score, safe to display before the answer
  // is revealed. The host only ever writes this at two moments: the start
  // of a question (before anyone's been scored) and the official reveal
  // (after everyone HAS). Player screens read this instead of the live,
  // continuously-updating players/{id}/score — reading the live value
  // there would let a bystander watching a waiting screen see a score
  // change (and thus infer right/wrong) mid-question, before the reveal.
  publicScores?: Record<string, number>;
  // Set once, right when the host clicks "クイズを始める" — a client-computed
  // (not server) future timestamp all screens count down to before the very
  // first question actually starts, so everyone gets a synced "3, 2, 1" beat
  // to get ready instead of the first clip starting the instant it's clicked.
  // Cleared once startGame() actually runs.
  countdownEndsAt?: number | null;
};

export type Player = {
  id: string;
  name: string;
  score: number;
  correctCount: number;
  connected: boolean;
  canAnswer: boolean;
  banned: boolean;
  joinedAt: number;
};

// "idle": no question in progress. "loading": choices/currentQuestionIndex
// are set but real playback hasn't been confirmed yet (still buffering) —
// nothing is answerable. "open": confirmed audible playback has started —
// this is when buzzing/answering opens and reaction-time clocks
// (openedAt/turnStartedAt) begin counting, so a player's measured reaction
// time never includes YouTube's own buffering delay (see
// src/app/room/[code]/host/page.tsx's waitForAudibleStart).
export type RoundPhase = "idle" | "loading" | "open";

export type RoundSubmission = {
  // Room.multiSelectMode: the picked SET of indices into round.choices
  // instead (see choiceIndices below) — choiceIndex is set to -1 (never a
  // valid array index) as a sentinel so existing single-choice code that
  // reads it doesn't have to special-case multi-select submissions.
  choiceIndex: number;
  // Room.multiSelectMode only. An empty array is a deliberate "skip" (the
  // player gave up rather than picked a wrong set) — since a real correct
  // set always has at least one member, [] can never accidentally match.
  choiceIndices?: number[];
  submittedAt: number;
};

// answerMode "spelling", buzzer/order rooms: shared progress for whoever
// currently holds the answer (round.winnerId) — position is how many
// characters have been confirmed correct so far; the CURRENT step's 4
// character choices live in round.choices (reused as-is from "choices" mode).
// confirmedChars is the actual characters picked so far (position long),
// synced so every screen can show the word being progressively spelled out.
export type SpellingProgress = {
  position: number;
  totalLength: number;
  confirmedChars: string[];
};

// answerMode "spelling", "everyone" room mode only: each player advances
// independently and privately (unlike buzzer/order's single shared
// round.spelling), so every player needs their own position/choices/status.
export type EveryoneSpellingEntry = {
  position: number;
  totalLength: number;
  choices: string[];
  confirmedChars: string[];
  pendingChoiceIndex: number | null;
  failed: boolean;
  completedAt: number | null;
};

export type Round = {
  phase: RoundPhase;
  openedAt: number | null;
  // Set ONCE when the question starts and left untouched by openRound()'s
  // re-buzz resets — unlike openedAt (which restarts on every wrong answer),
  // this stays stable across a whole question so a waiting player's "how
  // long has this been going" stopwatch doesn't jump back to 0 every time
  // someone else buzzes in and gets it wrong.
  questionStartedAt: number | null;
  // "order" mode only: server timestamp when the CURRENT turn holder's own
  // turn began — the reaction clock for order-mode scoring runs from here,
  // not from openedAt/questionStartedAt.
  turnStartedAt: number | null;
  // "order" mode only: 0-based count of turns already used on this question
  // (0 for whoever gets the first turn, 1 for whoever takes over after a
  // wrong answer, etc.) — feeds the order-correction part of the score.
  turnNumber: number | null;
  // In "order" mode this doubles as "whose turn it currently is" (assigned
  // directly by the host, not raced for), reusing the same field the
  // buzzer/everyone UI already keys off of.
  winnerId: string | null;
  // How long after openedAt the winner buzzed in, in ms. Synced so everyone
  // (not just the winner) can see the reaction time, not just the buzzer.
  winnerReactionMs: number | null;
  // Every player's own reaction time (ms after openedAt), win or lose, keyed
  // by uid. Lets a player who lost a close race compare their own timing
  // against the winner's, rather than only ever seeing the winner's time.
  buzzAttempts: Record<string, number> | null;
  choices: string[] | null;
  selectedChoice: number | null;
  // Room.multiSelectMode, buzzer/order only: the current answerer's (or
  // turn holder's) final picked SET of indices into choices, submitted via
  // one "決定" action rather than a single tap — see submitMultiChoice in
  // src/lib/rooms.ts. An empty array is a deliberate skip, same convention
  // as RoundSubmission.choiceIndices.
  selectedChoices?: number[] | null;
  // Room.multiSelectMode only: the exact index set into choices that counts
  // as correct for THIS question, written once by prepareQuestion() and read
  // at judging time — choices/correctness must be graded against the exact
  // shuffle actually shown to players, not recomputed (buildMultiSelectChoices
  // reshuffles randomly on every call).
  correctChoiceIndices?: number[] | null;
  submissions: Record<string, RoundSubmission> | null;
  spelling?: SpellingProgress | null;
  everyoneSpelling?: Record<string, EveryoneSpellingEntry> | null;
};

export type GamePhase = "playing" | "revealed" | "finished";

export type GameAnswer = {
  title: string;
  artist: string;
};

export type Game = {
  phase: GamePhase;
  answer: GameAnswer | null;
  // Every player who answered this question correctly, set once at
  // revealAnswer() time — empty when nobody got it right. The single
  // authoritative source for "who was correct" so the host and player
  // screens don't each have to re-derive it from round.submissions/choices
  // (whose shape already differs across buzzer/everyone/order and
  // "choices"/"spelling" answerMode).
  correctPlayerIds: string[];
};
