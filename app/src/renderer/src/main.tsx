import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/tokens.css";
import type { FamilyAgentApi } from "../../shared/contracts";
import { ApiProvider } from "./app/ApiContext";

declare global {
  interface Window {
    desktopApi?: FamilyAgentApi;
  }
}

const api = window.desktopApi;
if (!api) throw new Error("FamilyAgent API is unavailable");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ApiProvider api={api}><App /></ApiProvider>
  </StrictMode>
);
