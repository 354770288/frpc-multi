import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  use: { baseURL: 'http://127.0.0.1:5184', browserName: 'chromium' },
  webServer: { command: 'npm run dev -- --port 5184', url: 'http://127.0.0.1:5184', reuseExistingServer: false, timeout: 30000 },
});
