import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface AsyncSafeStorage {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(value: string): Promise<Buffer>;
  decryptStringAsync(value: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}

export class CredentialVault {
  private readonly keyPath: string;
  constructor(private readonly secretsDirectory: string, private readonly safeStorage: AsyncSafeStorage) {
    this.keyPath = join(secretsDirectory, "openai-api-key.bin");
  }

  async saveKey(value: string): Promise<void> {
    const key = value.trim();
    if (!key || key.length > 512) throw new Error("Model API key must contain 1 to 512 characters");
    if (!await this.safeStorage.isAsyncEncryptionAvailable()) throw new Error("Operating-system encryption is unavailable; the key was not saved");
    const encrypted = await this.safeStorage.encryptStringAsync(key);
    await mkdir(this.secretsDirectory, { recursive: true });
    const temporary = join(this.secretsDirectory, `.openai-api-key.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, encrypted, { flag: "wx", mode: 0o600 });
      await rename(temporary, this.keyPath);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async readKey(): Promise<string | null> {
    let encrypted: Buffer;
    try { encrypted = await readFile(this.keyPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    if (!await this.safeStorage.isAsyncEncryptionAvailable()) throw new Error("Operating-system encryption is unavailable; the key cannot be read");
    const decrypted = await this.safeStorage.decryptStringAsync(encrypted);
    if (decrypted.shouldReEncrypt) await this.saveKey(decrypted.result);
    return decrypted.result;
  }

  async clearKey(): Promise<void> { await rm(this.keyPath, { force: true }); }
}
