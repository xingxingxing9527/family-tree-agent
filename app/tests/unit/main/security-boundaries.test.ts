import { describe, expect, it, vi } from "vitest";
import { installNavigationPolicy } from "../../../src/main/security/navigation-policy";
import { resolveRuntimeSeams } from "../../../src/main/security/runtime-seams";
import { installSessionSecurityPolicy } from "../../../src/main/security/session-policy";

describe("Electron security boundaries", () => {
  it("accepts development seams only in an unpackaged process", () => {
    const hostileEnvironment = {
      ELECTRON_RENDERER_URL: "https://attacker.invalid/renderer",
      FAMILY_AGENT_E2E_IMPORT_PATH: "C:\\hostile\\import.csv",
      FAMILY_AGENT_E2E_MEDIA_PATH: "C:\\hostile\\media.jpg",
      FAMILY_AGENT_E2E_BACKUP_PATH: "C:\\hostile\\backup.zip",
      FAMILY_AGENT_E2E_CHAT: "1"
    };

    expect(resolveRuntimeSeams(true, hostileEnvironment)).toEqual({
      rendererUrl: null,
      importPath: null,
      mediaPath: null,
      backupPath: null,
      deterministicChat: false
    });
    expect(resolveRuntimeSeams(false, hostileEnvironment)).toEqual({
      rendererUrl: hostileEnvironment.ELECTRON_RENDERER_URL,
      importPath: hostileEnvironment.FAMILY_AGENT_E2E_IMPORT_PATH,
      mediaPath: hostileEnvironment.FAMILY_AGENT_E2E_MEDIA_PATH,
      backupPath: hostileEnvironment.FAMILY_AGENT_E2E_BACKUP_PATH,
      deterministicChat: true
    });
  });

  it("allows navigation only within the exact app renderer origin and denies new windows", () => {
    let navigate: ((event: { preventDefault(): void }, url: string) => void) | undefined;
    let open: (() => { action: string }) | undefined;
    const window = {
      webContents: {
        on: vi.fn((name: string, handler: typeof navigate) => { if (name === "will-navigate") navigate = handler; }),
        setWindowOpenHandler: vi.fn((handler: typeof open) => { open = handler; })
      }
    };
    installNavigationPolicy(window as never);

    for (const trusted of ["app://renderer/index.html", "app://renderer/index.html#/workspace/abc/tree"]) {
      const event = { preventDefault: vi.fn() };
      navigate!(event, trusted);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    for (const hostile of ["https://example.com", "app://evil/index.html", "app://renderer.evil/index.html", "app-media://asset/file"] ) {
      const event = { preventDefault: vi.fn() };
      navigate!(event, hostile);
      expect(event.preventDefault).toHaveBeenCalledOnce();
    }
    expect(open!()).toEqual({ action: "deny" });
  });

  it("denies every permission request/check and cancels downloads", () => {
    let request: ((_contents: unknown, permission: string, callback: (allowed: boolean) => void) => void) | undefined;
    let check: (() => boolean) | undefined;
    let download: ((event: { preventDefault(): void }, item: { cancel(): void }) => void) | undefined;
    const target = {
      setPermissionRequestHandler: vi.fn((handler: typeof request) => { request = handler; }),
      setPermissionCheckHandler: vi.fn((handler: typeof check) => { check = handler; }),
      on: vi.fn((name: string, handler: typeof download) => { if (name === "will-download") download = handler; })
    };
    installSessionSecurityPolicy(target);

    const callback = vi.fn();
    request!({}, "geolocation", callback);
    expect(callback).toHaveBeenCalledWith(false);
    expect(check!()).toBe(false);
    const event = { preventDefault: vi.fn() };
    const item = { cancel: vi.fn() };
    download!(event, item);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(item.cancel).toHaveBeenCalledOnce();
  });
});
