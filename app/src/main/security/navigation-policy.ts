import type { BrowserWindow } from "electron";

export function installNavigationPolicy(window: BrowserWindow): void {
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("app://")) {
      event.preventDefault();
    }
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}
