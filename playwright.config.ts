import { defineConfig, devices } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

function loadEnvFileIfExists(filePath: string) {
  const abs = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(abs)) return;

  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile(abs);
    return;
  }

  const raw = fs.readFileSync(abs, "utf-8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvFileIfExists(".env");
loadEnvFileIfExists(".env.local");
loadEnvFileIfExists(".env.e2e");
loadEnvFileIfExists(".env.e2e.local");

if (!process.env.E2E_PASSWORD) {
  process.env.E2E_PASSWORD = "E2E-password-123!";
}
if (!process.env.E2E_CLEANUP_TOKEN) {
  process.env.E2E_CLEANUP_TOKEN = "e2e-local-cleanup-token";
}

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 120_000,
  expect: {
    timeout: 15_000
  },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ],
  webServer: {
    command: "npm run dev",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      E2E_MODE: "1"
    }
  }
});
