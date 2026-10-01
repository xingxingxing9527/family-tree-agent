import type { AppResult, DownloadDescriptor, UploadKind, UploadedFileToken } from "../../../shared/contracts";

export async function uploadFile(kind: UploadKind, file: File, baseUrl = ""): Promise<AppResult<UploadedFileToken>> {
  const response = await fetch(`${baseUrl}/api/files/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(file.name) },
    body: file
  });
  return response.json() as Promise<AppResult<UploadedFileToken>>;
}

export function startDownload(descriptor: DownloadDescriptor, baseUrl = ""): void {
  const link = document.createElement("a");
  link.href = `${baseUrl}${descriptor.downloadUrl}`;
  link.download = descriptor.fileName;
  link.rel = "noopener";
  link.click();
}
