"use client";

import { formatRange } from "./timeUtils";
import type { ChorusCandidate } from "./types";

type ChorusCandidateListProps = {
  candidates: ChorusCandidate[];
  onSelect: (candidate: ChorusCandidate) => void;
};

export default function ChorusCandidateList({ candidates, onSelect }: ChorusCandidateListProps) {
  if (candidates.length === 0) {
    return (
      <p className="text-xs text-neutral-500">
        サビ候補の自動検出は現在利用できません。タイムラインで手動選択してください。
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-neutral-400">サビ候補</p>
      <div className="flex flex-wrap gap-2">
        {candidates.map((candidate, index) => (
          <button
            key={candidate.id}
            type="button"
            onClick={() => onSelect(candidate)}
            className="rounded-md border border-amber-500/60 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200"
          >
            候補{index + 1}（{formatRange(candidate.startSeconds, candidate.endSeconds)}）
          </button>
        ))}
      </div>
    </div>
  );
}
