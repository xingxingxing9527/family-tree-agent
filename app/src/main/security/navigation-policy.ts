import type { BrowserWindow } from "electron";

export function installNavigationPolicy(window: BrowserWindow): void {
  window.webContents.on("will-navigate", (event, url) => {
    let trusted = false;
    try {
      const destination = new URL(url);
      trusted = destination.protocol === "app:" && destination.hostname === "renderer"
        && destination.username === "" && destination.password === "" && destination.port === "";
    } catch {
      trusted = false;
    }
    if (!trusted) {
      event.preventDefault();
    }
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}
