"use client";

type SaveActionBarProps = {
  isSaving: boolean;
  canSave: boolean;
  onCancel: () => void;
  onSaveDraft: () => void;
  onUseRange: () => void;
};

export default function SaveActionBar({
  isSaving,
  canSave,
  onCancel,
  onSaveDraft,
  onUseRange,
}: SaveActionBarProps) {
  return (
    <div className="flex gap-2 border-t border-neutral-700 bg-neutral-900 p-3">
      <button
        type="button"
        onClick={onCancel}
        disabled={isSaving}
        className="rounded-md border border-neutral-600 px-4 py-3 text-sm text-neutral-200 disabled:opacity-40"
      >
        キャンセル
      </button>
      <button
        type="button"
        onClick={onSaveDraft}
        disabled={isSaving || !canSave}
        className="flex-1 rounded-md border border-neutral-500 px-4 py-3 text-sm text-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
      >
        下書き保存
      </button>
      <button
        type="button"
        onClick={onUseRange}
        disabled={isSaving || !canSave}
        className="flex-1 rounded-md bg-emerald-500 px-4 py-3 text-sm font-semibold text-emerald-950 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {isSaving ? "保存中…" : "この範囲を使用"}
      </button>
    </div>
  );
}
