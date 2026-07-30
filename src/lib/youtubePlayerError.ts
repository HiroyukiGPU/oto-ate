// YT.PlayerError is a type-only enum in @types/youtube — the real IFrame API
// never exposes it as a runtime object, so the codes are compared as numbers.
const EMBEDDING_NOT_ALLOWED = 101;
const EMBEDDING_NOT_ALLOWED_LEGACY = 150;
const VIDEO_NOT_FOUND = 100;

export function describePlaybackError(error: YT.PlayerError): string {
  const code = Number(error);
  if (code === EMBEDDING_NOT_ALLOWED || code === EMBEDDING_NOT_ALLOWED_LEGACY) {
    return "この動画は埋め込み再生が許可されていません";
  }
  if (code === VIDEO_NOT_FOUND) {
    return "この動画は見つかりませんでした（削除・非公開の可能性があります）";
  }
  return "この動画は再生できませんでした";
}

// Distinguishes the specific "video owner disabled embedding" failure from
// other playback errors (deleted/private video, transient glitches, …) —
// this one is permanent for as long as the song stays on this quiz, so the
// host skips it immediately (no countdown) and excludes it from future
// games instead of just retrying/waiting like other errors.
export function isEmbedNotAllowedError(error: YT.PlayerError): boolean {
  const code = Number(error);
  return code === EMBEDDING_NOT_ALLOWED || code === EMBEDDING_NOT_ALLOWED_LEGACY;
}
