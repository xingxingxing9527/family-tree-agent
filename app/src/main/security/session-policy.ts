interface PermissionSession {
  setPermissionRequestHandler(handler: (
    webContents: unknown,
    permission: string,
    callback: (allowed: boolean) => void,
    details: unknown
  ) => void): void;
  setPermissionCheckHandler(handler: (...args: unknown[]) => boolean): void;
  on(event: "will-download", handler: (
    event: { preventDefault(): void },
    item: { cancel(): void },
    webContents: unknown
  ) => void): unknown;
}

export function installSessionSecurityPolicy(target: PermissionSession): void {
  target.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  target.setPermissionCheckHandler(() => false);
  target.on("will-download", (event, item) => {
    event.preventDefault();
    item.cancel();
  });
}
