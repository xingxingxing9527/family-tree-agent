import { useCallback, useState } from "react";
import type { MutationApi, MutationIntent, MutationPreview, MutationReceipt } from "../../../../shared/mutations";

export function useStagedMutation(api: MutationApi | undefined, onCommitted?: (receipt: MutationReceipt) => void | Promise<void>) {
  const [preview, setPreview] = useState<MutationPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stage = useCallback(async (intents: MutationIntent[]): Promise<boolean> => {
    if (!api || busy) return false;
    setBusy(true); setError(null);
    try {
      const result = await api.stage({ intents });
      if (!result.ok) { setError(result.error.message); return false; }
      setPreview(result.value);
      return true;
    } catch { setError("无法生成写入预览，请稍后重试"); return false; }
    finally { setBusy(false); }
  }, [api, busy]);

  const confirm = useCallback(async (selectedChangeIds: string[], acknowledgedWarningCodes: string[]): Promise<boolean> => {
    if (!api || !preview || busy) return false;
    setBusy(true); setError(null);
    try {
      const result = await api.confirm({ draftId: preview.id, draftVersion: preview.version, selectedChangeIds, acknowledgedWarningCodes });
      if (!result.ok) { setError(result.error.message); return false; }
      setPreview(null);
      await onCommitted?.(result.value);
      return true;
    } catch { setError("无法确认写入，请稍后重试"); return false; }
    finally { setBusy(false); }
  }, [api, busy, onCommitted, preview]);

  return { preview, busy, error, stage, confirm, cancel: () => setPreview(null), clearError: () => setError(null) };
}
