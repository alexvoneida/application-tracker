import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.TRACKER_E2E_DIR ||= mkdtempSync(
  join(tmpdir(), "fieldwork-browser-"),
);
export default defineConfig({
  testDir: "./tests/browser",
  outputDir: "test-results/browser",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:3221",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm start",
    url: "http://127.0.0.1:3221",
    reuseExistingServer: false,
    env: {
      PORT: "3221",
      TRACKER_DATA_DIR: process.env.TRACKER_E2E_DIR,
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      OPENAI_API_KEY: "",
    },
    timeout: 30000,
  },
});
