"use client";

import { useState } from "react";
import {
  formatRange,
  formatRangeHMS,
  formatTime,
  parseRangeInput,
  parseTimeInput,
} from "./timeUtils";

type RangeInformationProps = {
  startSeconds: number;
  endSeconds: number;
  onChangeStart: (value: number) => void;
  onChangeEnd: (value: number) => void;
  onSetRange: (start: number, end: number) => void;
};

export default function RangeInformation({
  startSeconds,
  endSeconds,
  onChangeStart,
  onChangeEnd,
  onSetRange,
}: RangeInformationProps) {
  const [editingField, setEditingField] = useState<"start" | "end" | null>(null);
  const [draftValue, setDraftValue] = useState("");

  const [editingRange, setEditingRange] = useState(false);
  const [rangeDraft, setRangeDraft] = useState("");
  const [rangeError, setRangeError] = useState(false);

  function beginEdit(field: "start" | "end") {
    setEditingField(field);
    setDraftValue(formatTime(field === "start" ? startSeconds : endSeconds));
  }

  function commitEdit() {
    const parsed = parseTimeInput(draftValue);
    if (parsed !== null) {
      if (editingField === "start") onChangeStart(parsed);
      if (editingField === "end") onChangeEnd(parsed);
    }
    setEditingField(null);
  }

  function beginRangeEdit() {
    setEditingRange(true);
    setRangeError(false);
    setRangeDraft(formatRangeHMS(startSeconds, endSeconds));
  }

  function commitRangeEdit() {
    const parsed = parseRangeInput(rangeDraft);
    if (parsed === null) {
      setRangeError(true);
      return;
    }
    onSetRange(parsed.start, parsed.end);
    setEditingRange(false);
    setRangeError(false);
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-neutral-700 bg-neutral-800/50 p-3">
      <p className="text-center text-lg font-semibold tabular-nums text-white">
        {formatRange(startSeconds, endSeconds)}
      </p>
      <div className="flex justify-around text-center text-xs">
        <div>
          <p className="text-neutral-400">開始</p>
          {editingField === "start" ? (
            <input
              autoFocus
              value={draftValue}
              onChange={(e) => setDraftValue(e.target.value)}
              onBlur={commitEdit}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitEdit();
                if (e.key === "Escape") setEditingField(null);
              }}
              className="w-24 rounded border border-neutral-600 bg-neutral-900 px-1 py-0.5 text-center text-sm tabular-nums text-white"
            />
          ) : (
            <button
              type="button"
              onClick={() => beginEdit("start")}
              className="tabular-nums text-emerald-300 underline decoration-dotted"
            >
              {formatTime(startSeconds)}
            </button>
          )}
        </div>
        <div>
          <p className="text-neutral-400">終了</p>
          {editingField === "end" ? (
            <input
              autoFocus
              value={draftValue}
              onChange={(e) => setDraftValue(e.target.value)}
              onBlur={commitEdit}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitEdit();
                if (e.key === "Escape") setEditingField(null);
              }}
              className="w-24 rounded border border-neutral-600 bg-neutral-900 px-1 py-0.5 text-center text-sm tabular-nums text-white"
            />
          ) : (
            <button
              type="button"
              onClick={() => beginEdit("end")}
              className="tabular-nums text-rose-300 underline decoration-dotted"
            >
              {formatTime(endSeconds)}
            </button>
          )}
        </div>
        <div>
          <p className="text-neutral-400">切り抜き時間</p>
          <p className="tabular-nums text-white">{(endSeconds - startSeconds).toFixed(1)}秒</p>
        </div>
      </div>

      <div className="flex flex-col items-center gap-1 border-t border-neutral-700 pt-2">
        {editingRange ? (
          <>
            <input
              autoFocus
              value={rangeDraft}
              placeholder="00:00:00~00:00:00"
              onChange={(e) => {
                setRangeDraft(e.target.value);
                setRangeError(false);
              }}
              onBlur={commitRangeEdit}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRangeEdit();
                if (e.key === "Escape") setEditingRange(false);
              }}
              className={`w-48 rounded border bg-neutral-900 px-2 py-1 text-center text-sm tabular-nums text-white ${
                rangeError ? "border-red-500" : "border-neutral-600"
              }`}
            />
            {rangeError && (
              <p className="text-[11px] text-red-400">
                00:00:00〜00:00:00 の形式で入力してください
              </p>
            )}
          </>
        ) : (
          <button
            type="button"
            onClick={beginRangeEdit}
            className="text-xs text-neutral-400 underline decoration-dotted hover:text-neutral-200"
          >
            範囲をまとめて入力（00:00:00〜00:00:00）
          </button>
        )}
      </div>
    </div>
  );
}
