import React, { type JSX } from "react";

export function OnlineModelDisclosure({ onConfirm, onCancel, busy = false }: { onConfirm(): void; onCancel(): void; busy?: boolean }): JSX.Element {
  return (
    <div role="dialog" aria-modal="true" aria-label="在线模型披露" className="online-model-disclosure">
      <h3>发送到在线模型</h3>
      <p>将发送当前问题、必要人物摘要和查询结果。不会发送媒体文件、电脑路径、模型密钥或审计历史。</p>
      <button type="button" disabled={busy} onClick={onCancel}>取消</button>
      <button type="button" disabled={busy} onClick={onConfirm}>同意并发送</button>
    </div>
  );
}
