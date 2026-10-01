import { defineConfig } from "@playwright/test";

const port = 8791;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e-web",
  timeout: 60_000,
  expect: { timeout: 12_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL,
    channel: "msedge",
    locale: "zh-CN",
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  webServer: {
    // Keep the HTTP server in Playwright's direct child process so teardown
    // reliably releases the port on Windows (the tsx CLI adds a wrapper).
    command: "node --import tsx scripts/start-web-e2e-server.ts",
    url: `${baseURL}/api/health`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: { ...process.env, FAMILY_AGENT_PORT: String(port) }
  }
});
