const { defineConfig } = require("@playwright/test");
module.exports = defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.cjs",
  timeout: 45000,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:8085", channel: "chrome", headless: true, acceptDownloads: true },
  webServer: { command: "node server.cjs", url: "http://127.0.0.1:8085", reuseExistingServer: false },
  reporter: "list"
});
