import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const normalizePathIdentity = (path: string): string => {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
};

export function pathContains(root: string, candidate: string): boolean {
  const part = relative(root, candidate);
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

export const pathsOverlap = (first: string, second: string): boolean => pathContains(first, second) || pathContains(second, first);

export async function canonicalPlainDirectory(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Directory is linked or is not a directory");
  const canonical = await realpath(path);
  if (normalizePathIdentity(canonical) !== normalizePathIdentity(path)) throw new Error("Directory does not resolve to its expected canonical path");
  return canonical;
}
