import { describe, expect, it } from "vitest";
import {
  assertContainedPath,
  assertSeparatedRoots,
  betterSqliteNativeRelativePath,
  forbiddenPackageEntries,
  NSIS_APP_GUID,
  nsisRegistryProbes,
  resolveExecutableWorkingDirectory,
  selectInstallerName
} from "../../../scripts/smoke-packaged-app";

describe("packaged smoke destructive-operation guards", () => {
  it("accepts only descendants of the explicit temporary root", () => {
    expect(() => assertContainedPath("C:\\Temp\\family-agent-smoke-abc", "C:\\Temp\\family-agent-smoke-abc\\install", "install")).not.toThrow();
    expect(() => assertContainedPath("C:\\Temp\\family-agent-smoke-abc", "C:\\Temp\\other", "install")).toThrow(/outside/i);
    expect(() => assertContainedPath("C:\\Temp\\family-agent-smoke-abc", "C:\\Temp\\family-agent-smoke-abc", "install")).toThrow(/root itself/i);
  });

  it("keeps installed binaries and persistent data in distinct subtrees", () => {
    expect(() => assertSeparatedRoots("C:\\Temp\\root\\install", "C:\\Temp\\root\\user-data")).not.toThrow();
    expect(() => assertSeparatedRoots("C:\\Temp\\root\\install", "C:\\Temp\\root\\install\\profile")).toThrow(/overlap/i);
  });

  it("runs the uninstaller outside the directory it must remove", () => {
    expect(resolveExecutableWorkingDirectory(
      "C:\\Temp\\smoke\\installed-app\\Uninstall Family Agent.exe"
    )).toBe("C:\\Temp\\smoke\\installed-app");
    expect(resolveExecutableWorkingDirectory(
      "C:\\Temp\\smoke\\installed-app\\Uninstall Family Agent.exe",
      "C:\\Temp\\smoke"
    )).toBe("C:\\Temp\\smoke");
  });

  it("checks the native binary path used by the installed Windows x64 runtime", () => {
    expect(betterSqliteNativeRelativePath("win32", "x64"))
      .toBe("node_modules/better-sqlite3/prebuilds/win32-x64.node");
  });

  it("checks the exact derived NSIS registration keys in both hives and registry views", () => {
    expect(NSIS_APP_GUID).toBe("d1a51a1d-1566-5e0e-9cfa-31a4c775b234");
    const probes = nsisRegistryProbes(NSIS_APP_GUID);
    expect(probes).toHaveLength(8);
    expect(new Set(probes.map(({ view }) => view))).toEqual(new Set(["32", "64"]));
    expect(new Set(probes.map(({ key }) => key))).toEqual(new Set([
      `HKCU\\Software\\${NSIS_APP_GUID}`,
      `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${NSIS_APP_GUID}`,
      `HKLM\\Software\\${NSIS_APP_GUID}`,
      `HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${NSIS_APP_GUID}`
    ]));
  });

  it("selects exactly the reviewed NSIS x64 artifact and rejects package hazards", () => {
    expect(selectInstallerName([
      "family-agent-1.0.0-win-x64.exe",
      "family-agent-1.0.0-win-x64.exe.blockmap",
      "latest.yml"
    ], "1.0.0")).toBe("family-agent-1.0.0-win-x64.exe");
    expect(() => selectInstallerName(["family-agent-1.0.0-win-ia32.exe"], "1.0.0")).toThrow(/installer/i);
    expect(forbiddenPackageEntries([
      "/out/main/index.js",
      "/out/main/index.js.map",
      "/release/old-installer.exe",
      "/node_modules/bluebird/js/release/any.js",
      "/tests/fixture.json",
      "/workspace/genealogy.sqlite",
      "/.env.production"
    ])).toEqual([
      "/.env.production",
      "/out/main/index.js.map",
      "/release/old-installer.exe",
      "/tests/fixture.json",
      "/workspace/genealogy.sqlite"
    ]);
  });
});
