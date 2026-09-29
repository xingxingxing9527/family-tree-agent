import { describe, expect, it } from "vitest";
import {
  assertContainedPath,
  assertSeparatedRoots,
  betterSqliteNativeRelativePath,
  buildPackagedSmokeRecoveryReport,
  finalizePackagedSmokeCleanup,
  forbiddenPackageEntries,
  newShortcutPaths,
  NSIS_APP_GUID,
  nsisRegistryProbes,
  resolveExecutableWorkingDirectory,
  runExecutable,
  selectInstallerName,
  shortcutLocations,
  validateInstalledRegistrySnapshots
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

  it("requires exact contained HKCU install and uninstall values and rejects HKLM registration", () => {
    const installRoot = "C:\\Temp\\family-agent-smoke-abc\\installed-app";
    const uninstaller = `${installRoot}\\Uninstall 家谱智能体.exe`;
    const snapshots = [
      {
        probe: { key: `HKCU\\Software\\${NSIS_APP_GUID}`, view: "64" as const },
        values: { InstallLocation: installRoot }
      },
      {
        probe: { key: `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${NSIS_APP_GUID}`, view: "64" as const },
        values: {
          DisplayVersion: "1.0.0",
          UninstallString: `"${uninstaller}" --updated`,
          QuietUninstallString: `"${uninstaller}" --updated /S`
        }
      }
    ];

    expect(validateInstalledRegistrySnapshots(snapshots, installRoot, uninstaller, "1.0.0")).toEqual({
      installViews: ["64"],
      uninstallViews: ["64"],
      installLocation: installRoot,
      uninstallExecutable: uninstaller
    });
    expect(() => validateInstalledRegistrySnapshots([
      ...snapshots.slice(0, 1),
      {
        ...snapshots[1]!,
        values: {
          ...snapshots[1]!.values,
          UninstallString: "\"C:\\Program Files\\Unrelated\\uninstall.exe\"",
          QuietUninstallString: "\"C:\\Program Files\\Unrelated\\uninstall.exe\" /S"
        }
      }
    ], installRoot, uninstaller, "1.0.0")).toThrow(/outside|uninstaller/i);
    expect(() => validateInstalledRegistrySnapshots([
      ...snapshots,
      { probe: { key: `HKLM\\Software\\${NSIS_APP_GUID}`, view: "64" as const }, values: { InstallLocation: installRoot } }
    ], installRoot, uninstaller, "1.0.0")).toThrow(/HKLM/i);
  });

  it("reports only shortcuts created by this installation", () => {
    expect(newShortcutPaths(
      ["C:\\Users\\test\\Desktop\\preexisting.lnk", "C:\\Users\\test\\Desktop\\家谱智能体.lnk"],
      ["C:\\Users\\test\\Desktop\\preexisting.lnk", "C:\\Users\\test\\Desktop\\家谱智能体.lnk", "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\family-agent.lnk"]
    )).toEqual(["C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\family-agent.lnk"]);
  });

  it("observes isolated and real user/machine shortcut locations without selecting files to delete", () => {
    const locations = shortcutLocations(
      "C:\\Temp\\smoke\\user-data\\appdata",
      "C:\\Temp\\smoke\\installer-profile",
      {
        USERPROFILE: "C:\\Users\\reviewer",
        APPDATA: "C:\\Users\\reviewer\\AppData\\Roaming",
        PUBLIC: "C:\\Users\\Public",
        ProgramData: "C:\\ProgramData"
      }
    );
    expect(locations).toEqual([
      { label: "isolated-user-desktop", path: "C:\\Temp\\smoke\\installer-profile\\Desktop" },
      { label: "isolated-user-start-menu", path: "C:\\Temp\\smoke\\user-data\\appdata\\Microsoft\\Windows\\Start Menu\\Programs" },
      { label: "actual-user-desktop", path: "C:\\Users\\reviewer\\Desktop" },
      { label: "actual-user-start-menu", path: "C:\\Users\\reviewer\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs" },
      { label: "public-desktop", path: "C:\\Users\\Public\\Desktop" },
      { label: "machine-start-menu", path: "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs" }
    ]);
  });

  it.each([
    ["installer timeout", false, undefined, true],
    ["installer nonzero", false, undefined, true],
    ["app timeout", true, "C:\\Temp\\family-agent-packaged-smoke-test\\installed-app\\Uninstall.exe", false],
    ["app nonzero", true, "C:\\Temp\\family-agent-packaged-smoke-test\\installed-app\\Uninstall.exe", false],
    ["uninstaller timeout", true, "C:\\Temp\\family-agent-packaged-smoke-test\\installed-app\\Uninstall.exe", true],
    ["uninstaller nonzero", true, "C:\\Temp\\family-agent-packaged-smoke-test\\installed-app\\Uninstall.exe", true]
  ] as const)("keeps cleanup recoverable after %s without deleting an unrelated guard", async (_label, canDiscover, knownUninstaller, initiallyFails) => {
    let installPresent = true;
    let registrations = [{ key: `HKCU\\Software\\${NSIS_APP_GUID}`, view: "64" as const }];
    let uninstallerFails = initiallyFails;
    let removedTemporaryRoot = false;
    const unrelatedGuard = { exists: true };
    const state = {
      temporaryRoot: "C:\\Temp\\family-agent-packaged-smoke-test",
      installRoot: "C:\\Temp\\family-agent-packaged-smoke-test\\installed-app",
      uninstaller: knownUninstaller,
      installationMayExist: true
    };
    const operations = {
      discoverUninstaller: async () => canDiscover
        ? "C:\\Temp\\family-agent-packaged-smoke-test\\installed-app\\Uninstall.exe"
        : undefined,
      runUninstaller: async () => {
        if (uninstallerFails) throw new Error("uninstaller exited 7");
        installPresent = false;
        registrations = [];
      },
      installRootExists: async () => installPresent,
      registeredInstallations: async () => registrations,
      removeTemporaryRoot: async () => { removedTemporaryRoot = true; }
    };

    if (_label.startsWith("app")) {
      await expect(finalizePackagedSmokeCleanup(state, operations)).resolves.toMatchObject({ temporaryRootRemoved: true });
    } else {
      const failure = finalizePackagedSmokeCleanup(state, operations);
      await expect(failure).rejects.toThrow(/preserved|recovery/i);
      if (knownUninstaller) await expect(failure).rejects.toThrow(knownUninstaller);
      expect(removedTemporaryRoot).toBe(false);
      if (_label.startsWith("installer")) state.uninstaller = "C:\\Temp\\family-agent-packaged-smoke-test\\installed-app\\Uninstall.exe";
      uninstallerFails = false;
      await expect(finalizePackagedSmokeCleanup(state, operations)).resolves.toMatchObject({ temporaryRootRemoved: true });
    }
    expect(unrelatedGuard.exists).toBe(true);
  });

  it("records exact retained cleanup paths and registry probes for manual recovery", () => {
    expect(buildPackagedSmokeRecoveryReport({
      temporaryRoot: "C:\\Temp\\family-agent-packaged-smoke-test",
      installRoot: "C:\\Temp\\family-agent-packaged-smoke-test\\installed-app",
      uninstaller: "C:\\Temp\\family-agent-packaged-smoke-test\\installed-app\\Uninstall.exe",
      registry: [{ key: `HKCU\\Software\\${NSIS_APP_GUID}`, view: "64" }],
      reason: "Uninstall.exe exited 7"
    })).toMatchObject({
      passed: false,
      recoveryRequired: true,
      exactUninstaller: "C:\\Temp\\family-agent-packaged-smoke-test\\installed-app\\Uninstall.exe",
      recovery: {
        instruction: expect.stringContaining("Uninstall.exe"),
        removeTemporaryRootOnlyAfter: ["uninstaller succeeds", "install root is absent", "all expected registry probes are absent"]
      }
    });
  });

  it("surfaces executable timeout and nonzero failures for lifecycle recovery", async () => {
    await expect(runExecutable(process.execPath, ["-e", "process.exit(7)"], 5_000)).rejects.toThrow(/exited 7/i);
    await expect(runExecutable(process.execPath, ["-e", "setInterval(() => {}, 1000)"], 50)).rejects.toThrow(/timed out/i);
  });
});
