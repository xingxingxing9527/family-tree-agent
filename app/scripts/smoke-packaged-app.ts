import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { listPackage } from "@electron/asar";
import { _electron as electron, type ElectronApplication } from "playwright";

const EXPECTED_API_GROUPS = [
  "app", "chat", "dataManagement", "imports", "media", "merges",
  "modelSettings", "people", "query", "relations", "wiki", "workspaces"
] as const;

export const NSIS_APP_GUID = "d1a51a1d-1566-5e0e-9cfa-31a4c775b234";

export interface RegistryProbe {
  key: string;
  view: "32" | "64";
}

export interface RegistrySnapshot {
  probe: RegistryProbe;
  values: Record<string, string>;
}

export function nsisRegistryProbes(guid: string): RegistryProbe[] {
  const keys = [
    `HKCU\\Software\\${guid}`,
    `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}`,
    `HKLM\\Software\\${guid}`,
    `HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}`
  ];
  return keys.flatMap((key) => (["32", "64"] as const).map((view) => ({ key, view })));
}

function normalizedWindowsPath(path: string): string {
  return resolve(path).replaceAll("/", "\\").toLowerCase();
}

function executableFromRegistryCommand(command: string): string | null {
  const trimmed = command.trim();
  if (trimmed.startsWith('"')) {
    const closingQuote = trimmed.indexOf('"', 1);
    return closingQuote > 1 ? trimmed.slice(1, closingQuote) : null;
  }
  const match = /^(.+?\.exe)(?:\s|$)/iu.exec(trimmed);
  return match?.[1] ?? null;
}

export function validateInstalledRegistrySnapshots(
  snapshots: readonly RegistrySnapshot[],
  installRoot: string,
  uninstaller: string,
  version: string
): { installViews: Array<"32" | "64">; uninstallViews: Array<"32" | "64">; installLocation: string; uninstallExecutable: string } {
  assertContainedPath(installRoot, uninstaller, "registered uninstaller");
  const machine = snapshots.filter(({ probe }) => probe.key.toUpperCase().startsWith("HKLM\\"));
  if (machine.length > 0) throw new Error(`Unexpected HKLM registration: ${machine.map(({ probe }) => `${probe.key} [${probe.view}]`).join(", ")}`);

  const installKey = `HKCU\\Software\\${NSIS_APP_GUID}`.toLowerCase();
  const uninstallKey = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${NSIS_APP_GUID}`.toLowerCase();
  const installs = snapshots.filter(({ probe }) => probe.key.toLowerCase() === installKey);
  const uninstalls = snapshots.filter(({ probe }) => probe.key.toLowerCase() === uninstallKey);
  if (installs.length === 0 || uninstalls.length === 0) throw new Error("Expected HKCU install and uninstall registry keys were not observed");
  const expectedInstallRoot = normalizedWindowsPath(installRoot);
  const expectedUninstaller = normalizedWindowsPath(uninstaller);
  for (const { probe, values } of installs) {
    if (!values.InstallLocation || normalizedWindowsPath(values.InstallLocation) !== expectedInstallRoot) {
      throw new Error(`InstallLocation is outside or differs from the isolated install root (${probe.view}-bit view)`);
    }
  }
  for (const { probe, values } of uninstalls) {
    if (values.DisplayVersion !== version) throw new Error(`DisplayVersion differs from ${version} (${probe.view}-bit view)`);
    const normalExecutable = executableFromRegistryCommand(values.UninstallString ?? "");
    const quietExecutable = executableFromRegistryCommand(values.QuietUninstallString ?? "");
    if (!normalExecutable || !quietExecutable
      || normalizedWindowsPath(normalExecutable) !== expectedUninstaller
      || normalizedWindowsPath(quietExecutable) !== expectedUninstaller) {
      throw new Error(`Registered uninstaller is outside or differs from the installed uninstaller (${probe.view}-bit view)`);
    }
    if (!/(?:^|\s)\/S(?:\s|$)/iu.test(values.QuietUninstallString ?? "")) {
      throw new Error(`QuietUninstallString is not silent (${probe.view}-bit view)`);
    }
  }
  return {
    installViews: installs.map(({ probe }) => probe.view).sort(),
    uninstallViews: uninstalls.map(({ probe }) => probe.view).sort(),
    installLocation: installs[0]!.values.InstallLocation!,
    uninstallExecutable: executableFromRegistryCommand(uninstalls[0]!.values.UninstallString!)!
  };
}

export function newShortcutPaths(before: readonly string[], after: readonly string[]): string[] {
  const previous = new Set(before.map(normalizedWindowsPath));
  return after.filter((path) => !previous.has(normalizedWindowsPath(path))).sort();
}

export function shortcutSnapshotDiff(
  baseline: readonly string[],
  observed: readonly string[]
): { added: string[]; removed: string[]; unchanged: boolean } {
  const added = newShortcutPaths(baseline, observed);
  const removed = newShortcutPaths(observed, baseline);
  return { added, removed, unchanged: added.length === 0 && removed.length === 0 };
}

function pathIsInside(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

export function assertContainedPath(root: string, candidate: string, label: string): void {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  if (rootPath === candidatePath) throw new Error(`${label} must not be the temporary root itself`);
  if (!pathIsInside(rootPath, candidatePath)) throw new Error(`${label} is outside the explicit temporary root`);
}

export function assertSeparatedRoots(installRoot: string, userDataRoot: string): void {
  if (pathIsInside(installRoot, userDataRoot) || pathIsInside(userDataRoot, installRoot)) {
    throw new Error("Install and user-data roots overlap");
  }
}

export function selectInstallerName(entries: readonly string[], version: string): string {
  const expected = `family-agent-${version}-win-x64.exe`;
  const matches = entries.filter((entry) => entry === expected);
  if (matches.length !== 1) throw new Error(`Expected exactly one reviewed x64 NSIS installer named ${expected}`);
  return matches[0]!;
}

export function forbiddenPackageEntries(entries: readonly string[]): string[] {
  return entries.filter((entry) => {
    const path = entry.replaceAll("\\", "/").toLowerCase();
    return path.endsWith(".map")
      || /(^|\/)tests?(\/|$)/u.test(path)
      || /(^|\/)fixtures?(\/|$)/u.test(path)
      || /(^|\/)coverage(\/|$)/u.test(path)
      || /^\/release(?:\/|$)/u.test(path)
      || /(^|\/)test-results(\/|$)/u.test(path)
      || /(^|\/)\.env(?:\.|$)/u.test(path)
      || /\.sqlite(?:-wal|-shm)?$/u.test(path)
      || /(^|\/)workspaces?(\/|$)/u.test(path)
      || /(^|\/)(?:openai-)?api-key(?:\.|$)/u.test(path);
  }).sort();
}

export function betterSqliteNativeRelativePath(platform: NodeJS.Platform, architecture: string): string {
  return `node_modules/better-sqlite3/prebuilds/${platform}-${architecture}.node`;
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch { return false; }
}

async function filesBelow(root: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) output.push(path);
    }
  }
  if (await exists(root)) await visit(root);
  return output.sort();
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolveHash, rejectHash) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", rejectHash);
    stream.once("end", resolveHash);
  });
  return hash.digest("hex");
}

export function resolveExecutableWorkingDirectory(file: string, workingDirectory?: string): string {
  return resolve(workingDirectory ?? dirname(file));
}

export async function runExecutable(
  file: string,
  args: string[],
  timeoutMs = 120_000,
  workingDirectory?: string,
  environment: NodeJS.ProcessEnv = process.env
): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(file, args, {
      cwd: resolveExecutableWorkingDirectory(file, workingDirectory),
      env: environment,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    child.stdout.on("data", (chunk: Buffer) => { stdout = `${stdout}${chunk.toString("utf8")}`.slice(-8_000); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_000); });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectRun(error);
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (timedOut) rejectRun(new Error(`${basename(file)} timed out after ${timeoutMs} ms; process termination was observed`));
      else if (code === 0) resolveRun();
      else rejectRun(new Error(`${basename(file)} exited ${code ?? "without a code"}\n${stdout}\n${stderr}`));
    });
  });
}

export interface PackagedSmokeCleanupState {
  temporaryRoot: string;
  installRoot: string;
  uninstaller?: string;
  installationMayExist: boolean;
}

export interface PackagedSmokeCleanupOperations {
  discoverUninstaller(): Promise<string | undefined>;
  runUninstaller(uninstaller: string): Promise<void>;
  installRootExists(): Promise<boolean>;
  registeredInstallations(): Promise<RegistryProbe[]>;
  removeTemporaryRoot(): Promise<void>;
}

export async function finalizePackagedSmokeCleanup(
  state: PackagedSmokeCleanupState,
  operations: PackagedSmokeCleanupOperations
): Promise<{ temporaryRootRemoved: true; uninstallerRun: boolean; uninstaller: string | null }> {
  let installPresent = await operations.installRootExists();
  let registrations = await operations.registeredInstallations();
  if (!state.installationMayExist && registrations.length === 0) {
    await operations.removeTemporaryRoot();
    return { temporaryRootRemoved: true, uninstallerRun: false, uninstaller: null };
  }

  let uninstaller = state.uninstaller;
  if (!uninstaller && installPresent) uninstaller = await operations.discoverUninstaller();
  let uninstallerRun = false;
  if (installPresent || registrations.length > 0) {
    if (!uninstaller) {
      throw new Error(`Packaged-smoke recovery is required; temporary root preserved at ${state.temporaryRoot}; exact uninstaller=not-found`);
    }
    assertContainedPath(state.installRoot, uninstaller, "cleanup uninstaller");
    try {
      await operations.runUninstaller(uninstaller);
      uninstallerRun = true;
    } catch (error) {
      throw new Error(`Packaged-smoke cleanup failed; temporary root preserved at ${state.temporaryRoot} for recovery; exact uninstaller=${uninstaller}`, { cause: error });
    }
  }

  installPresent = await operations.installRootExists();
  registrations = await operations.registeredInstallations();
  if (installPresent || registrations.length > 0) {
    throw new Error(`Packaged-smoke cleanup is incomplete; temporary root preserved at ${state.temporaryRoot} for recovery; exact uninstaller=${uninstaller ?? "not-found"} (${registrations.length} registry keys remain)`);
  }
  await operations.removeTemporaryRoot();
  return { temporaryRootRemoved: true, uninstallerRun, uninstaller: uninstaller ?? null };
}

export interface PackagedSmokeRecoveryInput {
  temporaryRoot: string;
  installRoot: string;
  uninstaller?: string;
  registry: readonly RegistryProbe[];
  reason: string;
}

export function buildPackagedSmokeRecoveryReport(input: PackagedSmokeRecoveryInput): object {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    passed: false,
    recoveryRequired: true,
    temporaryRoot: input.temporaryRoot,
    installRoot: input.installRoot,
    exactUninstaller: input.uninstaller ?? null,
    registry: input.registry,
    failure: input.reason,
    recovery: {
      instruction: input.uninstaller
        ? `Run the retained uninstaller silently and inspect its exit status: \"${input.uninstaller}\" /S`
        : "Inspect the retained install root for its exact uninstaller; do not delete the root while registration may remain.",
      removeTemporaryRootOnlyAfter: [
        "uninstaller succeeds",
        "install root is absent",
        "all expected registry probes are absent"
      ]
    }
  };
}

function parseRegistryValues(output: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s+(\S+)\s+REG_\S+\s+(.*)$/u.exec(line);
    if (match) values[match[1]!] = match[2]!.trim();
  }
  return values;
}

async function registrySnapshot(probe: RegistryProbe): Promise<RegistrySnapshot | null> {
  return new Promise<RegistrySnapshot | null>((resolveQuery, rejectQuery) => {
    const child = spawn("reg.exe", ["query", probe.key, `/reg:${probe.view}`], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", rejectQuery);
    child.once("exit", (code) => {
      if (code === 0) {
        resolveQuery({ probe, values: parseRegistryValues(Buffer.concat(stdout).toString("utf8")) });
      } else if (code === 1) {
        resolveQuery(null);
      } else {
        rejectQuery(new Error(`Unable to inspect ${probe.key} (${probe.view}-bit view): reg.exe exited ${code ?? "without a code"}: ${Buffer.concat(stderr).toString("utf8")}`));
      }
    });
  });
}

async function installedRegistrySnapshots(): Promise<RegistrySnapshot[]> {
  const snapshots = await Promise.all(nsisRegistryProbes(NSIS_APP_GUID).map(registrySnapshot));
  return snapshots.filter((entry): entry is RegistrySnapshot => entry !== null);
}

async function registeredInstallations(): Promise<RegistryProbe[]> {
  return (await installedRegistrySnapshots()).map(({ probe }) => probe);
}

async function assertNoRegisteredInstallation(stage: string): Promise<void> {
  const existing = await registeredInstallations();
  if (existing.length > 0) {
    throw new Error(`${stage}: refusing to touch an existing Family Agent installation (${existing.map(({ key, view }) => `${key} [${view}]`).join(", ")})`);
  }
}

async function waitFor(description: string, predicate: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

interface ShortcutLocation {
  label: string;
  path: string;
}

export function shortcutLocations(
  isolatedAppData: string,
  isolatedProfile: string,
  hostEnvironment: NodeJS.ProcessEnv = process.env
): ShortcutLocation[] {
  const candidates: ShortcutLocation[] = [
    { label: "isolated-user-desktop", path: join(isolatedProfile, "Desktop") },
    { label: "isolated-user-start-menu", path: join(isolatedAppData, "Microsoft", "Windows", "Start Menu", "Programs") }
  ];
  if (hostEnvironment.USERPROFILE) candidates.push({ label: "actual-user-desktop", path: join(hostEnvironment.USERPROFILE, "Desktop") });
  if (hostEnvironment.APPDATA) candidates.push({ label: "actual-user-start-menu", path: join(hostEnvironment.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs") });
  if (hostEnvironment.PUBLIC) candidates.push({ label: "public-desktop", path: join(hostEnvironment.PUBLIC, "Desktop") });
  if (hostEnvironment.ProgramData) candidates.push({ label: "machine-start-menu", path: join(hostEnvironment.ProgramData, "Microsoft", "Windows", "Start Menu", "Programs") });
  const seen = new Set<string>();
  return candidates.filter(({ path }) => {
    const identity = normalizedWindowsPath(path);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

async function shortcutSnapshot(locations: readonly ShortcutLocation[]): Promise<string[]> {
  const shortcuts: string[] = [];
  for (const location of locations) {
    for (const file of await filesBelow(location.path)) {
      if (file.toLowerCase().endsWith(".lnk")) shortcuts.push(file);
    }
  }
  return shortcuts.sort();
}

async function discoverContainedUninstaller(installRoot: string): Promise<string | undefined> {
  if (!await exists(installRoot)) return undefined;
  const matches = (await readdir(installRoot)).filter((entry) => /^uninstall.*\.exe$/iu.test(entry));
  if (matches.length !== 1) return undefined;
  const uninstaller = await realpath(resolve(installRoot, matches[0]!));
  assertContainedPath(installRoot, uninstaller, "discovered cleanup uninstaller");
  return uninstaller;
}

async function packageScan(packageRoot: string): Promise<{ files: number; asarEntries: number; nativeModule: string }> {
  const files = await filesBelow(packageRoot);
  const diskEntries = files.map((path) => `/${relative(packageRoot, path).replaceAll("\\", "/")}`);
  const appAsar = join(packageRoot, "resources", "app.asar");
  if (!await exists(appAsar)) throw new Error(`Missing app.asar in ${basename(packageRoot)}`);
  const asarEntries = listPackage(appAsar, { isPack: false });
  const forbidden = forbiddenPackageEntries([...diskEntries, ...asarEntries]);
  if (forbidden.length > 0) throw new Error(`Forbidden package entries: ${forbidden.join(", ")}`);
  const nativeModule = join(
    packageRoot,
    "resources",
    "app.asar.unpacked",
    ...betterSqliteNativeRelativePath(process.platform, process.arch).split("/")
  );
  if (!await exists(nativeModule)) throw new Error("Packaged better-sqlite3 native module is missing from app.asar.unpacked");
  return {
    files: files.length,
    asarEntries: asarEntries.length,
    nativeModule: relative(packageRoot, nativeModule).replaceAll("\\", "/")
  };
}

interface LaunchResult {
  application: ElectronApplication;
  workspaceId: string;
  personId: string;
  runtime: {
    isPackaged: boolean;
    contextIsolation: boolean;
    sandbox: boolean;
    nodeIntegration: boolean;
    url: string;
    apiGroups: string[];
    chatErrorCode: string | null;
  };
}

async function launchInstalledAndCreate(
  executablePath: string,
  profile: string,
  environment: NodeJS.ProcessEnv
): Promise<LaunchResult> {
  const application = await electron.launch({ executablePath, args: [`--user-data-dir=${profile}`], env: environment });
  try {
    const window = await application.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    const mainSecurity = await application.evaluate(({ app, BrowserWindow }) => {
      const preferences = BrowserWindow.getAllWindows()[0]?.webContents.getLastWebPreferences();
      return {
        isPackaged: app.isPackaged,
        contextIsolation: preferences?.contextIsolation === true,
        sandbox: preferences?.sandbox === true,
        nodeIntegration: preferences?.nodeIntegration === true
      };
    });
    const renderer = await window.evaluate(async () => {
      const api = window.desktopApi;
      const created = await api.workspaces.create({ name: "安装包持久化谱册" });
      if (!created.ok) throw new Error(created.error.message);
      const opened = await api.workspaces.open({ id: created.value.id });
      if (!opened.ok) throw new Error(opened.error.message);
      const saved = await api.people.save({
        draft: {
          displayName: "安装包持久化人物",
          aliases: ["烟测人物"],
          gender: "unknown",
          birth: null,
          death: null,
          notes: "NSIS installed application smoke",
          sourceDescription: "Task 15 packaged smoke"
        },
        confirmWarnings: true
      });
      if (!saved.ok) throw new Error(saved.error.message);
      const authorization = await api.chat.authorize({
        sessionId: "15000000-0000-4000-8000-000020260916",
        operation: "ask",
        payload: { question: "有多少成员？", viewpointId: saved.value.entityId, selectedPersonId: null }
      });
      let chatErrorCode: string | null = authorization.ok ? null : authorization.error.code;
      if (authorization.ok) {
        const answer = await api.chat.ask({
          sessionId: "15000000-0000-4000-8000-000020260916",
          authorizationToken: authorization.value.authorizationToken,
          payload: { question: "有多少成员？", viewpointId: saved.value.entityId, selectedPersonId: null }
        });
        chatErrorCode = answer.ok ? null : answer.error.code;
      }
      return {
        url: window.location.href,
        requireType: typeof window.require,
        processType: typeof window.process,
        apiGroups: Object.keys(api).sort(),
        workspaceId: created.value.id,
        personId: saved.value.entityId,
        chatErrorCode
      };
    });
    if (!renderer.url.startsWith("app://renderer/")) throw new Error(`Packaged renderer loaded an untrusted URL: ${renderer.url}`);
    if (renderer.requireType !== "undefined" || renderer.processType !== "undefined") throw new Error("Packaged renderer exposed Node globals");
    if (JSON.stringify(renderer.apiGroups) !== JSON.stringify([...EXPECTED_API_GROUPS].sort())) throw new Error("Packaged DesktopApi surface changed");
    if (!mainSecurity.isPackaged || !mainSecurity.contextIsolation || !mainSecurity.sandbox || mainSecurity.nodeIntegration) {
      throw new Error("Packaged BrowserWindow security preferences are not enforced");
    }
    if (renderer.chatErrorCode !== "MODEL_UNAVAILABLE") {
      throw new Error(`Packaged deterministic chat seam was not disabled: ${renderer.chatErrorCode ?? "unexpected success"}`);
    }
    return {
      application,
      workspaceId: renderer.workspaceId,
      personId: renderer.personId,
      runtime: { ...mainSecurity, url: renderer.url, apiGroups: renderer.apiGroups, chatErrorCode: renderer.chatErrorCode }
    };
  } catch (error) {
    await application.close().catch(() => undefined);
    throw error;
  }
}

async function launchInstalledAndReopen(
  executablePath: string,
  profile: string,
  environment: NodeJS.ProcessEnv,
  workspaceId: string,
  personId: string
): Promise<{ application: ElectronApplication; persisted: boolean }> {
  const application = await electron.launch({ executablePath, args: [`--user-data-dir=${profile}`], env: environment });
  try {
    const window = await application.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    const persisted = await window.evaluate(async ({ expectedWorkspaceId, expectedPersonId }) => {
      const listed = await window.desktopApi.workspaces.list();
      if (!listed.ok || !listed.value.some(({ id }) => id === expectedWorkspaceId)) return false;
      const opened = await window.desktopApi.workspaces.open({ id: expectedWorkspaceId });
      if (!opened.ok) return false;
      const people = await window.desktopApi.people.list({ limit: 100, offset: 0 });
      return people.ok && people.value.some(({ id, displayName }) => id === expectedPersonId && displayName === "安装包持久化人物");
    }, { expectedWorkspaceId: workspaceId, expectedPersonId: personId });
    return { application, persisted };
  } catch (error) {
    await application.close().catch(() => undefined);
    throw error;
  }
}

async function removeSmokeRoot(root: string): Promise<void> {
  const resolvedTemporary = resolve(tmpdir());
  const resolvedRoot = resolve(root);
  if (!pathIsInside(resolvedTemporary, resolvedRoot) || !basename(resolvedRoot).startsWith("family-agent-packaged-smoke-")) {
    throw new Error("Refusing to remove an unverified packaged-smoke directory");
  }
  await rm(resolvedRoot, { recursive: true, force: true });
}

export async function smokePackagedApp(): Promise<string> {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Packaged smoke requires Windows x64");
  const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8")) as { version: string };
  const releaseRoot = resolve("release");
  const installerName = selectInstallerName(await readdir(releaseRoot), packageJson.version);
  const installerPath = resolve(releaseRoot, installerName);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "family-agent-packaged-smoke-"));
  const installRoot = resolve(temporaryRoot, "installed-app");
  const userDataRoot = resolve(temporaryRoot, "persistent-user-data");
  const profile = resolve(userDataRoot, "profile");
  const appData = resolve(userDataRoot, "appdata");
  const localAppData = resolve(userDataRoot, "localappdata");
  const installerProfile = resolve(userDataRoot, "installer-profile");
  const guard = resolve(temporaryRoot, "must-survive-uninstall.txt");
  const importCanary = resolve(temporaryRoot, "hostile-import.csv");
  const mediaCanary = resolve(temporaryRoot, "hostile-media.jpg");
  const backupCanary = resolve(temporaryRoot, "hostile-backup.zip");
  let application: ElectronApplication | undefined;
  let uninstaller: string | undefined;
  let installationMayExist = false;
  let lifecycleFailure: unknown;
  let shortcutBaseline: string[] = [];

  assertContainedPath(temporaryRoot, installRoot, "install root");
  assertContainedPath(temporaryRoot, userDataRoot, "user-data root");
  assertSeparatedRoots(installRoot, userDataRoot);
  await mkdir(installRoot, { recursive: true });
  await mkdir(profile, { recursive: true });
  await mkdir(appData, { recursive: true });
  await mkdir(localAppData, { recursive: true });
  await mkdir(resolve(installerProfile, "Desktop"), { recursive: true });
  await mkdir(resolve(appData, "Microsoft", "Windows", "Start Menu", "Programs"), { recursive: true });
  await writeFile(guard, "installer and uninstaller must preserve this sibling\n", "utf8");
  await writeFile(importCanary, "hostile seam must not be consumed\n", "utf8");
  await writeFile(mediaCanary, "hostile seam must not be consumed\n", "utf8");

  const resolvedTemporaryRoot = await realpath(temporaryRoot);
  const resolvedInstallRoot = await realpath(installRoot);
  const resolvedUserDataRoot = await realpath(userDataRoot);
  assertContainedPath(resolvedTemporaryRoot, resolvedInstallRoot, "resolved install root");
  assertContainedPath(resolvedTemporaryRoot, resolvedUserDataRoot, "resolved user-data root");
  assertSeparatedRoots(resolvedInstallRoot, resolvedUserDataRoot);

  const installerEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    USERPROFILE: installerProfile
  };
  const observedShortcutLocations = shortcutLocations(appData, installerProfile);
  shortcutBaseline = await shortcutSnapshot(observedShortcutLocations);
  const reportDirectory = resolve(releaseRoot, "reports");
  const recoveryReportPath = resolve(reportDirectory, "packaged-smoke-recovery-report.json");

  try {
    const unpackedRoot = resolve(releaseRoot, "win-unpacked");
    const unpackedScan = await packageScan(unpackedRoot);
    await assertNoRegisteredInstallation("Pre-install registry check");
    installationMayExist = true;
    await runExecutable(
      installerPath,
      ["/S", "/currentuser", `/D=${resolvedInstallRoot}`],
      120_000,
      releaseRoot,
      installerEnvironment
    );
    const executable = resolve(resolvedInstallRoot, "family-agent.exe");
    await waitFor("installed executable", () => exists(executable));
    const resolvedExecutable = await realpath(executable);
    assertContainedPath(resolvedInstallRoot, resolvedExecutable, "installed executable");

    const installEntries = await readdir(resolvedInstallRoot);
    const uninstallerName = installEntries.find((entry) => /^uninstall.*\.exe$/iu.test(entry));
    if (!uninstallerName) throw new Error("Installed NSIS uninstaller was not found");
    uninstaller = await realpath(resolve(resolvedInstallRoot, uninstallerName));
    assertContainedPath(resolvedInstallRoot, uninstaller, "uninstaller");
    const installedRegistry = validateInstalledRegistrySnapshots(
      await installedRegistrySnapshots(),
      resolvedInstallRoot,
      uninstaller,
      packageJson.version
    );
    const shortcutsAfterInstall = await shortcutSnapshot(observedShortcutLocations);
    const shortcutInstallDiff = shortcutSnapshotDiff(shortcutBaseline, shortcutsAfterInstall);
    if (!shortcutInstallDiff.unchanged) {
      throw new Error(
        `NSIS changed shortcuts after install (added: ${shortcutInstallDiff.added.join(", ") || "none"}; removed: ${shortcutInstallDiff.removed.join(", ") || "none"})`
      );
    }
    const installedScan = await packageScan(resolvedInstallRoot);

    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      USERPROFILE: installerProfile,
      ELECTRON_RENDERER_URL: "https://example.invalid/hostile-renderer",
      FAMILY_AGENT_E2E_IMPORT_PATH: importCanary,
      FAMILY_AGENT_E2E_MEDIA_PATH: mediaCanary,
      FAMILY_AGENT_E2E_BACKUP_PATH: backupCanary,
      FAMILY_AGENT_E2E_CHAT: "1"
    };
    const first = await launchInstalledAndCreate(resolvedExecutable, profile, environment);
    application = first.application;
    await application.close();
    application = undefined;

    const second = await launchInstalledAndReopen(resolvedExecutable, profile, environment, first.workspaceId, first.personId);
    application = second.application;
    if (!second.persisted) throw new Error("Installed application did not reopen its persistent workspace and person");
    await application.close();
    application = undefined;

    if (await exists(backupCanary)) throw new Error("Packaged backup E2E seam wrote the hostile canary path");
    if (await readFile(importCanary, "utf8") !== "hostile seam must not be consumed\n") throw new Error("Packaged import E2E seam consumed its canary");
    if (await readFile(mediaCanary, "utf8") !== "hostile seam must not be consumed\n") throw new Error("Packaged media E2E seam consumed its canary");

    const databases = (await filesBelow(userDataRoot)).filter((path) => basename(path) === "genealogy.sqlite");
    if (databases.length !== 1) throw new Error(`Expected one persistent workspace database, found ${databases.length}`);
    const databaseHashBeforeUninstall = await sha256(databases[0]!);
    const userDataFilesBeforeUninstall = (await filesBelow(userDataRoot)).length;

    const installerStats = await stat(installerPath);
    const artifacts = {
      installer: { file: installerName, bytes: installerStats.size, sha256: await sha256(installerPath) },
      installedExecutable: { file: "family-agent.exe", sha256: await sha256(resolvedExecutable) },
      appAsar: { file: "resources/app.asar", sha256: await sha256(resolve(resolvedInstallRoot, "resources", "app.asar")) }
    };

    const installRootBeforeUninstall = await realpath(resolvedInstallRoot);
    const userDataRootBeforeUninstall = await realpath(resolvedUserDataRoot);
    assertContainedPath(resolvedTemporaryRoot, installRootBeforeUninstall, "pre-uninstall install root");
    assertContainedPath(resolvedTemporaryRoot, userDataRootBeforeUninstall, "pre-uninstall user-data root");
    assertSeparatedRoots(installRootBeforeUninstall, userDataRootBeforeUninstall);
    assertContainedPath(installRootBeforeUninstall, uninstaller, "pre-uninstall executable");
    await runExecutable(uninstaller, ["/S"], 120_000, resolvedTemporaryRoot, installerEnvironment);
    await waitFor("temporary install root removal", async () => !await exists(resolvedInstallRoot));
    await waitFor("temporary install registry removal", async () => (await registeredInstallations()).length === 0);
    const shortcutsAfterUninstall = await shortcutSnapshot(observedShortcutLocations);
    const shortcutUninstallDiff = shortcutSnapshotDiff(shortcutBaseline, shortcutsAfterUninstall);
    if (!shortcutUninstallDiff.unchanged) {
      throw new Error(
        `NSIS changed shortcuts after uninstall (added: ${shortcutUninstallDiff.added.join(", ") || "none"}; removed: ${shortcutUninstallDiff.removed.join(", ") || "none"})`
      );
    }

    if (!await exists(guard)) throw new Error("Uninstaller removed a sibling outside the temporary install root");
    if (!await exists(userDataRootBeforeUninstall)) throw new Error("Uninstaller deleted the isolated persistent user-data root");
    if (!await exists(databases[0]!)) throw new Error("Uninstaller deleted the persistent workspace database");
    const databaseHashAfterUninstall = await sha256(databases[0]!);
    if (databaseHashAfterUninstall !== databaseHashBeforeUninstall) throw new Error("Uninstaller modified the persistent workspace database");

    const report = {
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      platform: { platform: process.platform, architecture: process.arch, node: process.version },
      installerMode: { silent: true, currentUser: true, customTemporaryDirectory: true },
      scans: { winUnpacked: unpackedScan, installed: installedScan },
      runtime: first.runtime,
      persistence: {
        reopened: second.persisted,
        workspaceCount: 1,
        databaseSha256BeforeUninstall: databaseHashBeforeUninstall,
        databaseSha256AfterUninstall: databaseHashAfterUninstall,
        userDataFilesBeforeUninstall,
        userDataPreservedAfterUninstall: true
      },
      uninstall: { exactTemporaryInstallRemoved: true, exactUninstallerSucceeded: true, siblingGuardPreserved: true },
      registry: {
        guid: NSIS_APP_GUID,
        checkedHives: ["HKCU", "HKLM"],
        checkedViews: ["32", "64"],
        cleanBeforeInstall: true,
        cleanAfterUninstall: true,
        observedAfterInstall: installedRegistry
      },
      shortcuts: {
        checkedLocations: observedShortcutLocations.map(({ label }) => label),
        baselineCount: shortcutBaseline.length,
        afterInstallCount: shortcutsAfterInstall.length,
        afterUninstallCount: shortcutsAfterUninstall.length,
        afterInstall: shortcutInstallDiff,
        afterUninstall: shortcutUninstallDiff,
        createdAfterInstall: shortcutInstallDiff.added,
        remainingAfterUninstall: shortcutUninstallDiff.added,
        existingEntriesNeverDeletedBySmoke:
          shortcutInstallDiff.removed.length === 0 && shortcutUninstallDiff.removed.length === 0
      },
      artifacts,
      passed: true
    };
    await mkdir(reportDirectory, { recursive: true });
    const reportPath = resolve(reportDirectory, "packaged-smoke-report.json");
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(resolve(reportDirectory, "artifact-sha256.txt"), [
      `${artifacts.installer.sha256}  ${artifacts.installer.file}`,
      `${artifacts.installedExecutable.sha256}  installed/family-agent.exe`,
      `${artifacts.appAsar.sha256}  installed/resources/app.asar`
    ].join("\n") + "\n", "utf8");
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return reportPath;
  } catch (error) {
    lifecycleFailure = error;
    throw error;
  } finally {
    await application?.close().catch(() => undefined);
    try {
      const retainedUninstaller = uninstaller ?? await discoverContainedUninstaller(resolvedInstallRoot);
      if (retainedUninstaller) uninstaller = retainedUninstaller;
      await finalizePackagedSmokeCleanup({
        temporaryRoot: resolvedTemporaryRoot,
        installRoot: resolvedInstallRoot,
        uninstaller,
        installationMayExist
      }, {
        discoverUninstaller: () => discoverContainedUninstaller(resolvedInstallRoot),
        runUninstaller: async (cleanupUninstaller) => {
          await runExecutable(cleanupUninstaller, ["/S"], 60_000, resolvedTemporaryRoot, installerEnvironment);
          await waitFor("cleanup install-root removal", async () => !await exists(resolvedInstallRoot));
          await waitFor("cleanup registry removal", async () => (await registeredInstallations()).length === 0);
          const cleanupShortcutDiff = shortcutSnapshotDiff(
            shortcutBaseline,
            await shortcutSnapshot(observedShortcutLocations)
          );
          if (!cleanupShortcutDiff.unchanged) {
            throw new Error(
              `Cleanup changed shortcuts (added: ${cleanupShortcutDiff.added.join(", ") || "none"}; removed: ${cleanupShortcutDiff.removed.join(", ") || "none"})`
            );
          }
        },
        installRootExists: () => exists(resolvedInstallRoot),
        registeredInstallations,
        removeTemporaryRoot: () => removeSmokeRoot(resolvedTemporaryRoot)
      });
    } catch (cleanupError) {
      const registry = await registeredInstallations().catch(() => []);
      await mkdir(reportDirectory, { recursive: true });
      const reason = [lifecycleFailure, cleanupError]
        .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined && entry !== null)
        .map((entry) => entry instanceof Error ? entry.stack ?? entry.message : String(entry))
        .join("\n--- cleanup ---\n");
      const recovery = buildPackagedSmokeRecoveryReport({
        temporaryRoot: resolvedTemporaryRoot,
        installRoot: resolvedInstallRoot,
        uninstaller,
        registry,
        reason
      });
      await writeFile(recoveryReportPath, `${JSON.stringify(recovery, null, 2)}\n`, "utf8");
      throw new AggregateError(
        lifecycleFailure ? [lifecycleFailure, cleanupError] : [cleanupError],
        `Packaged smoke left recoverable state; follow ${recoveryReportPath}`
      );
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  smokePackagedApp().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
