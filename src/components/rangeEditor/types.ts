export type ChorusCandidate = {
  id: string;
  label: string;
  startSeconds: number;
  endSeconds: number;
  confidence: number;
};

export type DragTarget = "start" | "end" | "move" | null;

export type DurationPreset = 5 | 10 | 15 | 20 | "free";
