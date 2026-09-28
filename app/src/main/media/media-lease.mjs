import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, rmdir, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const DEFAULT_MAX_WAIT_MS = 120_000;
const DEFAULT_STALE_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_RETRY_MIN_MS = 10;
const DEFAULT_RETRY_MAX_MS = 200;

export class MediaLeaseOwnershipError extends Error {
  constructor(message = "Media hash lease ownership was lost") {
    super(message);
    this.name = "MediaLeaseOwnershipError";
    this.code = "MEDIA_LEASE_OWNERSHIP_LOST";
  }
}

const positiveNumber = (value, fallback, name) => {
  const selected = value ?? fallback;
  if (!Number.isFinite(selected) || selected <= 0) throw new TypeError(`${name} must be a positive number`);
  return selected;
};

const optionsWithDefaults = (options) => {
  const result = {
    maxWaitMs: positiveNumber(options.maxWaitMs, DEFAULT_MAX_WAIT_MS, "maxWaitMs"),
    staleMs: positiveNumber(options.staleMs, DEFAULT_STALE_MS, "staleMs"),
    heartbeatMs: positiveNumber(options.heartbeatMs, DEFAULT_HEARTBEAT_MS, "heartbeatMs"),
    retryMinMs: positiveNumber(options.retryMinMs, DEFAULT_RETRY_MIN_MS, "retryMinMs"),
    retryMaxMs: positiveNumber(options.retryMaxMs, DEFAULT_RETRY_MAX_MS, "retryMaxMs")
  };
  if (result.retryMinMs > result.retryMaxMs) throw new TypeError("retryMinMs must not exceed retryMaxMs");
  return result;
};

const isCode = (error, code) => error && typeof error === "object" && error.code === code;
const delay = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
const ownerDirectoryName = (token) => `owner-${token}`;

const pathInside = (directory, candidate) => {
  const root = resolve(directory);
  const target = resolve(candidate);
  return target.startsWith(`${root}${sep}`);
};

async function inspectLease(path, staleMs) {
  let directoryInfo;
  try {
    directoryInfo = await lstat(path);
  } catch (error) {
    if (isCode(error, "ENOENT")) return { exists: false, stale: false };
    throw error;
  }
  if (!directoryInfo.isDirectory()) return { exists: true, stale: Date.now() - directoryInfo.mtimeMs > staleMs };

  const entries = await readdir(path, { withFileTypes: true }).catch((error) => {
    if (isCode(error, "ENOENT")) return [];
    throw error;
  });
  const owners = entries.filter((entry) => entry.isDirectory() && /^owner-[0-9a-f-]{36}$/.test(entry.name));
  if (owners.length !== 1) return { exists: true, stale: Date.now() - directoryInfo.mtimeMs > staleMs };

  const heartbeatPath = join(path, owners[0].name, "heartbeat");
  try {
    const heartbeat = await stat(heartbeatPath);
    return { exists: true, stale: Date.now() - heartbeat.mtimeMs > staleMs };
  } catch (error) {
    if (isCode(error, "ENOENT")) return { exists: true, stale: Date.now() - directoryInfo.mtimeMs > staleMs };
    throw error;
  }
}

async function removeStaleQuarantines(directory, lockName, staleMs) {
  const prefix = `${lockName}.quarantine.`;
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (isCode(error, "ENOENT")) return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix) || !/^[0-9a-f-]{36}$/.test(entry.name.slice(prefix.length))) continue;
    const candidate = join(directory, entry.name);
    if (!pathInside(directory, candidate)) continue;
    const state = await inspectLease(candidate, staleMs);
    if (state.exists && state.stale) await rm(candidate, { recursive: true, force: true });
  }
}

async function quarantineIfStale(lockPath, staleMs) {
  const before = await inspectLease(lockPath, staleMs);
  if (!before.exists || !before.stale) return false;

  const quarantinePath = `${lockPath}.quarantine.${randomUUID()}`;
  try {
    await rename(lockPath, quarantinePath);
  } catch (error) {
    if (isCode(error, "ENOENT") || isCode(error, "EEXIST") || isCode(error, "ENOTEMPTY")) return true;
    throw error;
  }

  const after = await inspectLease(quarantinePath, staleMs);
  if (!after.stale) {
    try {
      await rename(quarantinePath, lockPath);
    } catch (error) {
      if (!isCode(error, "EEXIST") && !isCode(error, "ENOTEMPTY")) throw error;
    }
    return false;
  }

  await rm(quarantinePath, { recursive: true, force: true });
  return true;
}

async function createLease(lockPath, token, heartbeatMs) {
  try {
    await mkdir(lockPath);
  } catch (error) {
    if (isCode(error, "EEXIST")) return null;
    throw error;
  }

  const ownerPath = join(lockPath, ownerDirectoryName(token));
  const tokenPath = join(ownerPath, "token");
  const heartbeatPath = join(ownerPath, "heartbeat");
  try {
    await mkdir(ownerPath);
    await writeFile(tokenPath, token, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await writeFile(heartbeatPath, token, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    await unlink(heartbeatPath).catch(() => undefined);
    await unlink(tokenPath).catch(() => undefined);
    await rmdir(ownerPath).catch(() => undefined);
    await rmdir(lockPath).catch(() => undefined);
    throw error;
  }

  let stopped = false;
  let timer;
  let renewal;

  const owns = async () => {
    try {
      return (await readFile(tokenPath, "utf8")) === token;
    } catch {
      return false;
    }
  };

  const assertOwned = async () => {
    if (!await owns()) throw new MediaLeaseOwnershipError();
  };

  const scheduleHeartbeat = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      renewal = (async () => {
        try {
          await assertOwned();
          const now = new Date();
          await utimes(heartbeatPath, now, now);
        } catch {
          stopped = true;
        } finally {
          renewal = undefined;
          scheduleHeartbeat();
        }
      })();
    }, heartbeatMs);
    timer.unref?.();
  };

  scheduleHeartbeat();

  return {
    token,
    path: lockPath,
    assertOwned,
    async release() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await renewal?.catch(() => undefined);
      if (!await owns()) return false;
      await assertOwned();
      try {
        await unlink(heartbeatPath);
        await unlink(tokenPath);
        await rmdir(ownerPath);
      } catch (error) {
        if (isCode(error, "ENOENT")) return false;
        throw error;
      }
      await rmdir(lockPath).catch((error) => {
        if (!isCode(error, "ENOENT") && !isCode(error, "ENOTEMPTY") && !isCode(error, "EEXIST")) throw error;
      });
      return true;
    }
  };
}

export async function acquireHashLease(directory, hash, options = {}) {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new TypeError("hash must be a lowercase SHA-256 value");
  const selected = optionsWithDefaults(options);
  await mkdir(directory, { recursive: true });
  const canonicalDirectory = await stat(directory).then(() => resolve(directory));
  const lockName = `.${hash}.lock`;
  const lockPath = join(canonicalDirectory, lockName);
  const deadline = Date.now() + selected.maxWaitMs;
  const token = randomUUID();
  let attempt = 0;

  await removeStaleQuarantines(canonicalDirectory, lockName, selected.staleMs);
  for (;;) {
    const lease = await createLease(lockPath, token, selected.heartbeatMs);
    if (lease) return lease;
    if (await quarantineIfStale(lockPath, selected.staleMs)) continue;

    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Timed out acquiring media hash lease");
    const backoff = Math.min(selected.retryMaxMs, selected.retryMinMs * (2 ** Math.min(attempt, 10)));
    attempt += 1;
    await delay(Math.min(backoff, remaining));
  }
}
