import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/tokens.css";
import type { DesktopApi } from "../../shared/contracts";

declare global {
  interface Window {
    desktopApi: DesktopApi;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
