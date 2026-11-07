import { defineConfig } from "@playwright/test";
const production = process.env.CAMPUS_PRODUCTION_TEST === "1";
const baseURL = production ? "http://127.0.0.1:4173" : "http://127.0.0.1:5173";
export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.{js,ts}",
  timeout: 360000,
  workers: 1,
  use: {
    baseURL,
    viewport: { width: 1000, height: 700 },
    launchOptions: {
      executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
      args: [
        "--no-sandbox",
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
      ],
    },
    screenshot: "only-on-failure",
  },
  webServer: {
    command: production ? "npm run preview -- --port 4173" : "npm run dev",
    url: baseURL,
    reuseExistingServer: true,
    timeout: 30000,
  },
});
