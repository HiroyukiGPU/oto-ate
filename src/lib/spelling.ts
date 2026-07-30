// Supports the "文字当て" (spelling) answer mode: the correct answerTitle is
// revealed one character at a time, 4 choices per step, instead of picking
// the whole title from 4 options at once. See src/app/room/[code]/host/
// page.tsx for how these are wired into the buzzer/order/everyone room
// modes.

// Hiragana, katakana (incl. the ー long vowel mark), common + extended kanji,
// half-width alphabet, and "#" (kept on request — appears in some titles,
// e.g. hashtag-style song names) — everything else, notably "!" and "'"
// along with other punctuation/digits/symbols/emoji/full-width spaces, is
// stripped before spelling begins.
const KEEP_PATTERN = /[぀-ゟ゠-ヿ㐀-䶿一-鿿A-Za-z#]/;

// Array.from (not .split("")) so surrogate-pair kanji outside the BMP don't
// get split into two broken halves.
export function normalizeTitleForSpelling(title: string): string[] {
  return Array.from(title).filter((char) => KEEP_PATTERN.test(char));
}

// Katakana ァ-ヶ (U+30A1-U+30F6) folds to hiragana ぁ-ゖ (U+3041-U+3096) by a
// fixed -0x60 offset — used ONLY for comparison (matching prefixes / the
// correct answer), never for display, so a katakana distractor still shows
// as katakana on screen.
export function foldKana(char: string): string {
  const code = char.codePointAt(0) ?? 0;
  if (code >= 0x30a1 && code <= 0x30f6) {
    return String.fromCodePoint(code - 0x60);
  }
  return char;
}

function foldedPrefix(chars: string[], length: number): string {
  return chars.slice(0, length).map(foldKana).join("");
}

function shuffle<T>(items: T[]): T[] {
  const result = items.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Generic fallback pool, used only when there aren't enough OTHER titles to
// draw confusing distractors from (e.g. a tiny quiz).
const FALLBACK_KANA_POOL = [
  "あ", "い", "う", "え", "お",
  "か", "き", "く", "け", "こ",
  "さ", "し", "す", "せ", "そ",
  "た", "ち", "つ", "て", "と",
  "な", "に", "ぬ", "ね", "の",
  "は", "ひ", "ふ", "へ", "ほ",
  "ま", "み", "む", "め", "も",
  "や", "ゆ", "よ",
  "ら", "り", "る", "れ", "ろ",
  "わ", "を", "ん",
];

// Builds the 4 choices for one step: the real next character plus 3
// distractors, prioritized by how likely they are to genuinely mislead —
// another answer in the quiz that shares this EXACT prefix so far (folded)
// is the strongest distractor (e.g. "りんご" vs "リアル" both start "り",
// so リアル's 2nd character becomes a deliberately confusing option for
// りんご's 2nd character) — falling back to any other answer's character at
// this position, then to a generic kana pool if the quiz is too small.
export function buildSpellingStepChoices(
  targetChars: string[],
  position: number,
  otherAnswers: string[][],
): string[] {
  const correctChar = targetChars[position];
  const correctFolded = foldKana(correctChar);
  const targetPrefixFolded = foldedPrefix(targetChars, position);

  const distractors: string[] = [];

  const addCandidate = (char: string) => {
    const folded = foldKana(char);
    if (folded === correctFolded) return;
    // Compare FOLDED forms, not raw characters — otherwise katakana "ア" and
    // hiragana "あ" (the same sound) could both end up as separate choices.
    if (distractors.some((existing) => foldKana(existing) === folded)) return;
    distractors.push(char);
  };

  // Priority 1: other answers sharing the same folded prefix up to here.
  for (const other of otherAnswers) {
    if (distractors.length >= 3) break;
    if (other.length <= position) continue;
    if (foldedPrefix(other, position) === targetPrefixFolded) {
      addCandidate(other[position]);
    }
  }
  // Priority 2: any other answer's character at this exact position.
  if (distractors.length < 3) {
    for (const other of otherAnswers) {
      if (distractors.length >= 3) break;
      if (other.length <= position) continue;
      addCandidate(other[position]);
    }
  }
  // Priority 3: generic fallback pool.
  let fallbackIndex = 0;
  while (distractors.length < 3 && fallbackIndex < FALLBACK_KANA_POOL.length * 2) {
    addCandidate(FALLBACK_KANA_POOL[fallbackIndex % FALLBACK_KANA_POOL.length]);
    fallbackIndex++;
  }

  return shuffle([correctChar, ...shuffle(distractors).slice(0, 3)]);
}
