import React, { useCallback, useEffect, useRef, useState, type ChangeEvent, type JSX } from "react";
import type { MediaApi, MediaAssetReadModel } from "../../../../shared/contracts";
import { uploadFile } from "../../api/file-client";
import { isHttpApiGroup } from "../../api/http-client";

interface MediaGalleryProps {
  personId: string;
  media: MediaApi;
  assets?: MediaAssetReadModel[];
}

export function MediaGallery({ personId, media, assets: initialAssets = [] }: MediaGalleryProps): JSX.Element {
  const [assets, setAssets] = useState<MediaAssetReadModel[]>(initialAssets);
  const [caption, setCaption] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const webMode = isHttpApiGroup(media);

  const load = useCallback(async (): Promise<void> => {
    const activeRequest = ++requestId.current;
    setLoading(true);
    try {
      const result = await media.listForPerson({ personId });
      if (activeRequest !== requestId.current) return;
      if (!result?.ok) { setError(result?.error.message ?? "无法读取媒体资料"); return; }
      setAssets(result.value);
      setError(null);
    } catch {
      if (activeRequest === requestId.current) setError("无法读取媒体资料");
    } finally {
      if (activeRequest === requestId.current) setLoading(false);
    }
  }, [media, personId]);

  useEffect(() => {
    setAssets(initialAssets);
    void load();
    return () => { requestId.current += 1; };
  }, [load, personId]);

  const add = async (): Promise<void> => {
    if (busy) return;
    if (webMode) { fileInput.current?.click(); return; }
    setBusy(true);
    setError(null);
    try {
      const selected = await media.select();
      if (!selected.ok) { setError(selected.error.message); return; }
      const imported = await media.import({ fileToken: selected.value.fileToken });
      if (!imported.ok) { setError(imported.error.message); return; }
      const attached = await media.attach({ mediaAssetId: imported.value.id, personId, ...(caption.trim() ? { caption: caption.trim() } : {}) });
      if (!attached.ok) { setError(attached.error.message); return; }
      setCaption("");
      await load();
    } catch {
      setError("无法添加媒体资料");
    } finally { setBusy(false); }
  };

  const uploadAndAdd = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || busy) return;
    setBusy(true); setError(null);
    try {
      const uploaded = await uploadFile("media", file);
      if (!uploaded.ok) { setError(uploaded.error.message); return; }
      const imported = await media.import({ fileToken: uploaded.value.fileToken });
      if (!imported.ok) { setError(imported.error.message); return; }
      const attached = await media.attach({ mediaAssetId: imported.value.id, personId, ...(caption.trim() ? { caption: caption.trim() } : {}) });
      if (!attached.ok) { setError(attached.error.message); return; }
      setCaption(""); await load();
    } catch { setError("无法添加媒体资料"); }
    finally { setBusy(false); }
  };

  return (
    <section className="media-gallery" aria-label="人物媒体">
      <h3>照片与录音</h3>
      <input ref={fileInput} hidden type="file" accept="image/jpeg,image/png,image/webp,audio/mpeg,audio/wav,audio/mp4,audio/ogg" onChange={(event) => void uploadAndAdd(event)} />
      <label>媒体说明<input className="field-control" aria-label="媒体说明" value={caption} onChange={(event) => setCaption(event.target.value)} /></label>
      <div className="button-row"><button className="button secondary-button" type="button" disabled={busy} onClick={() => void add()}>{busy ? "添加中…" : "添加媒体"}</button>
        <button className="button secondary-button" type="button" disabled={busy || loading} onClick={() => void load()}>{loading ? "刷新中…" : "刷新媒体"}</button></div>
      {error && <p className="error-banner" role="alert">{error}</p>}
      {loading && assets.length === 0 ? <p role="status">正在加载媒体资料…</p>
        : assets.length === 0 ? <p className="text-secondary">还没有媒体资料</p>
          : <div className="media-grid">{assets.map((asset) => asset.mimeType.startsWith("image/")
            ? <figure key={asset.id}><img src={asset.url} alt={asset.caption || asset.fileName} /><figcaption>{asset.caption || asset.fileName}</figcaption></figure>
            : <figure key={asset.id}><audio controls aria-label={`播放：${asset.caption || asset.fileName}`} src={asset.url} /><figcaption>{asset.caption || asset.fileName}</figcaption></figure>)}</div>}
    </section>
  );
}
