import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialVault } from "../../../src/main/security/credential-vault";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("CredentialVault", () => {
  it("persists encrypted bytes below the injected user-data secrets directory and decrypts asynchronously", async () => {
    const root = await mkdtemp(join(tmpdir(), "credential-vault-")); roots.push(root);
    const secrets = join(root, "user-data", "secrets"); await mkdir(secrets, { recursive: true });
    const safeStorage = {
      isAsyncEncryptionAvailable: vi.fn().mockResolvedValue(true),
      encryptStringAsync: vi.fn(async (value: string) => Buffer.from(`encrypted:${value}`)),
      decryptStringAsync: vi.fn(async (value: Buffer) => ({ result: value.toString().replace("encrypted:", ""), shouldReEncrypt: false }))
    };
    const vault = new CredentialVault(secrets, safeStorage);

    await vault.saveKey("sk-secret");
    expect((await readFile(join(secrets, "openai-api-key.bin"))).toString()).toBe("encrypted:sk-secret");
    expect(await vault.readKey()).toBe("sk-secret");
    expect(JSON.stringify(await readFile(join(secrets, "openai-api-key.bin")))).not.toContain("sk-secret");
  });

  it("re-encrypts rotated ciphertext and never persists plaintext when encryption is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "credential-vault-")); roots.push(root);
    const unavailable = {
      isAsyncEncryptionAvailable: vi.fn().mockResolvedValue(false), encryptStringAsync: vi.fn(), decryptStringAsync: vi.fn()
    };
    await expect(new CredentialVault(join(root, "secrets"), unavailable).saveKey("sk-plain")).rejects.toThrow(/encryption is unavailable/i);
    await expect(readFile(join(root, "secrets", "openai-api-key.bin"))).rejects.toMatchObject({ code: "ENOENT" });

    const available = {
      isAsyncEncryptionAvailable: vi.fn().mockResolvedValue(true),
      encryptStringAsync: vi.fn(async (value: string) => Buffer.from(`v2:${value}`)),
      decryptStringAsync: vi.fn(async () => ({ result: "sk-rotated", shouldReEncrypt: true }))
    };
    const vault = new CredentialVault(join(root, "rotated"), available);
    await vault.saveKey("old");
    expect(await vault.readKey()).toBe("sk-rotated");
    expect((await readFile(join(root, "rotated", "openai-api-key.bin"))).toString()).toBe("v2:sk-rotated");
  });

  it("rejects empty and unbounded keys", async () => {
    const safeStorage = { isAsyncEncryptionAvailable: vi.fn().mockResolvedValue(true), encryptStringAsync: vi.fn(), decryptStringAsync: vi.fn() };
    const vault = new CredentialVault(join(tmpdir(), "unused-vault"), safeStorage);
    await expect(vault.saveKey(" ")).rejects.toThrow(/key/i);
    await expect(vault.saveKey("x".repeat(513))).rejects.toThrow(/key/i);
    expect(safeStorage.encryptStringAsync).not.toHaveBeenCalled();
  });
});
