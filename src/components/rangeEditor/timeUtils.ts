export function formatTime(totalSeconds: number): string {
  const totalDeciseconds = Math.max(0, Math.round(totalSeconds * 10));
  const minutes = Math.floor(totalDeciseconds / 600);
  const secs = Math.floor((totalDeciseconds % 600) / 10);
  const tenths = totalDeciseconds % 10;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${tenths}`;
}

export function formatRange(start: number, end: number): string {
  return `${formatTime(start)}〜${formatTime(end)}`;
}

export function parseTimeInput(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const match = trimmed.match(/^(\d+):(\d{1,2})(?:\.(\d))?$/);
  if (match) {
    const minutes = Number(match[1]);
    const seconds = Number(match[2]);
    const tenths = match[3] ? Number(match[3]) : 0;
    return minutes * 60 + seconds + tenths / 10;
  }

  const plain = Number(trimmed);
  return Number.isFinite(plain) ? plain : null;
}

export function formatTimeHMS(totalSeconds: number): string {
  const total = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function formatRangeHMS(start: number, end: number): string {
  return `${formatTimeHMS(start)}~${formatTimeHMS(end)}`;
}

export function parseFlexibleTime(text: string): number | null {
  const match = text.trim().match(/^(\d+(?::\d+){0,2})(?:\.(\d))?$/);
  if (!match) return null;
  const parts = match[1].split(":").map(Number);
  const tenths = match[2] ? Number(match[2]) : 0;
  let seconds: number;
  if (parts.length === 1) {
    [seconds] = parts;
  } else if (parts.length === 2) {
    seconds = parts[0] * 60 + parts[1];
  } else {
    seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return seconds + tenths / 10;
}

export function parseRangeInput(text: string): { start: number; end: number } | null {
  const segments = text.trim().replace(/[〜～]/g, "~").split("~");
  if (segments.length !== 2) return null;
  const start = parseFlexibleTime(segments[0]);
  const end = parseFlexibleTime(segments[1]);
  if (start === null || end === null) return null;
  return { start, end };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function roundToStep(value: number, step: number): number {
  return Math.round(value / step) * step;
}

export function secondsToPixels(
  seconds: number,
  windowStart: number,
  windowEnd: number,
  widthPx: number,
): number {
  const span = windowEnd - windowStart || 1;
  return ((seconds - windowStart) / span) * widthPx;
}

export function pixelsToSeconds(
  px: number,
  windowStart: number,
  windowEnd: number,
  widthPx: number,
): number {
  const span = windowEnd - windowStart || 1;
  return windowStart + (px / Math.max(widthPx, 1)) * span;
}
