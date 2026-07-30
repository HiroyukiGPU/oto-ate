"use client";

type FineAdjustmentControlsProps = {
  onAdjustStart: (delta: number) => void;
  onAdjustEnd: (delta: number) => void;
};

export default function FineAdjustmentControls({
  onAdjustStart,
  onAdjustEnd,
}: FineAdjustmentControlsProps) {
  const btn = "flex-1 rounded-md border border-neutral-600 py-2 text-xs font-medium text-neutral-100";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <p className="text-xs text-neutral-400">開始位置の微調整</p>
        <div className="flex gap-1">
          <button type="button" onClick={() => onAdjustStart(-1)} className={btn}>
            −1秒
          </button>
          <button type="button" onClick={() => onAdjustStart(-0.1)} className={btn}>
            −0.1秒
          </button>
          <button type="button" onClick={() => onAdjustStart(0.1)} className={btn}>
            ＋0.1秒
          </button>
          <button type="button" onClick={() => onAdjustStart(1)} className={btn}>
            ＋1秒
          </button>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-xs text-neutral-400">終了位置の微調整</p>
        <div className="flex gap-1">
          <button type="button" onClick={() => onAdjustEnd(-1)} className={btn}>
            −1秒
          </button>
          <button type="button" onClick={() => onAdjustEnd(-0.1)} className={btn}>
            −0.1秒
          </button>
          <button type="button" onClick={() => onAdjustEnd(0.1)} className={btn}>
            ＋0.1秒
          </button>
          <button type="button" onClick={() => onAdjustEnd(1)} className={btn}>
            ＋1秒
          </button>
        </div>
      </div>
    </div>
  );
}
