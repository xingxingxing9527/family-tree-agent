import { useCallback, useEffect, useRef, useState } from "react";
import type { MutationApi, MutationIntent, MutationPreview, MutationReceipt } from "../../../../shared/mutations";

interface StagedMutationOptions {
  onPersisted?(receipt: MutationReceipt): void | Promise<void>;
}

export function useStagedMutation(
  api: MutationApi | undefined,
  onCommitted?: (receipt: MutationReceipt) => void | Promise<void>,
  { onPersisted }: StagedMutationOptions = {}
) {
  const [preview, setPreview] = useState<MutationPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestGeneration.current += 1;
    };
  }, []);

  const requestIsCurrent = (generation: number): boolean => mounted.current && requestGeneration.current === generation;

  const stage = useCallback(async (intents: MutationIntent[]): Promise<boolean> => {
    if (!api || busy) return false;
    const generation = requestGeneration.current;
    setBusy(true); setError(null);
    try {
      const result = await api.stage({ intents });
      if (!requestIsCurrent(generation)) return false;
      if (!result.ok) { setError(result.error.message); return false; }
      setPreview(result.value);
      return true;
    } catch {
      if (requestIsCurrent(generation)) setError("无法生成写入预览，请稍后重试");
      return false;
    } finally {
      if (requestIsCurrent(generation)) setBusy(false);
    }
  }, [api, busy]);

  const confirm = useCallback(async (selectedChangeIds: string[], acknowledgedWarningCodes: string[]): Promise<boolean> => {
    if (!api || !preview || busy) return false;
    const generation = requestGeneration.current;
    setBusy(true); setError(null);
    try {
      const result = await api.confirm({ draftId: preview.id, draftVersion: preview.version, selectedChangeIds, acknowledgedWarningCodes });
      if (!result.ok) {
        if (requestIsCurrent(generation)) setError(result.error.message);
        return false;
      }
      try {
        await onPersisted?.(result.value);
      } catch {
        // Persistence already succeeded; invalidation is best-effort and must not make the mutation retryable.
      }
      if (!requestIsCurrent(generation)) return false;
      setPreview(null);
      await onCommitted?.(result.value);
      return requestIsCurrent(generation);
    } catch {
      if (requestIsCurrent(generation)) setError("无法确认写入，请稍后重试");
      return false;
    } finally {
      if (requestIsCurrent(generation)) setBusy(false);
    }
  }, [api, busy, onCommitted, onPersisted, preview]);

  const reset = useCallback((): void => {
    requestGeneration.current += 1;
    setPreview(null);
    setBusy(false);
    setError(null);
  }, []);
  const cancel = useCallback((): void => setPreview(null), []);
  const clearError = useCallback((): void => setError(null), []);

  return { preview, busy, error, stage, confirm, cancel, clearError, reset };
}
