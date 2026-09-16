import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: { rollupOptions: { external: ["better-sqlite3"] } }
  },
  preload: {
    build: { rollupOptions: { output: { format: "cjs" } } }
  },
  renderer: {
    root: resolve("src/renderer"),
    plugins: [react()]
  }
});
