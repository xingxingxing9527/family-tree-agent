import React, { useEffect, useState, type FormEvent, type JSX } from "react";
import type { FamilyAgentApi } from "../../../../shared/contracts";
import { isHttpApiGroup } from "../../api/http-client";

export function ModelSettings({ api }: { api: FamilyAgentApi["modelSettings"] }): JSX.Element {
  const webMode = isHttpApiGroup(api);
  const [configured, setConfigured] = useState(false); const [key, setKey] = useState(""); const [message, setMessage] = useState("");
  const [error, setError] = useState(""); const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false);
  useEffect(() => {
    let current = true;
    void api.status().then((result) => {
      if (!current) return;
      if (result.ok) setConfigured(result.value.configured); else setError(result.error.message);
    }).catch(() => { if (current) setError("无法检查在线模型设置"); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [api]);
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); const value = key; setKey(""); setSaving(true); setError(""); setMessage("");
    try {
      const result = await api.saveKey({ key: value });
      if (result.ok) { setConfigured(true); setMessage("密钥已安全保存"); } else setError(result.error.message);
    } catch { setError("无法保存在线模型密钥"); }
    finally { setSaving(false); }
  };
  return (
    <section aria-label="在线模型设置"><h2>在线模型</h2>{loading ? <p role="status">正在检查在线模型设置…</p> : <p>{configured ? "已配置在线模型密钥" : "尚未配置在线模型密钥"}</p>}
      {webMode ? <p className="text-secondary">网页版本的密钥仅由服务器环境变量 FAMILY_AGENT_OPENAI_API_KEY 配置，浏览器不会读取或保存密钥。</p> : <form onSubmit={(event) => void save(event)}><label>OpenAI API 密钥<input aria-label="OpenAI API 密钥" type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} /></label>
        <button type="submit" disabled={saving || !key.trim()}>{saving ? "保存中…" : "安全保存"}</button></form>}{message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
    </section>
  );
}
