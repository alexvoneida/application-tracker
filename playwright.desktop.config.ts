import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/desktop",
  outputDir: process.env.FIELDWORK_PACKAGED_EXECUTABLE
    ? "test-results/packaged"
    : "test-results/electron",
  workers: 1,
  timeout: 60000,
  expect: { timeout: 15000 },
  use: { screenshot: "only-on-failure", trace: "retain-on-failure" },
});
