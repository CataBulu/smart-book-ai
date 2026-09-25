import { defineConfig, devices } from '@playwright/test'
import os from 'node:os'
import path from 'node:path'

// Smoke tests run against an isolated backend in fake-LLM mode (no Ollama needed) with a fresh data dir,
// on their own ports so they never touch the real library.
const API_PORT = 8001
const WEB_PORT = 5174
const dataDir = path.join(os.tmpdir(), `smartbook-e2e-${process.pid}`)

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: 'retain-on-failure',
    permissions: ['microphone'],
    launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } }],
  webServer: [
    {
      command: 'uv run --project ../backend smartbook',
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        SMARTBOOK_FAKE_LLM: '1',
        SMARTBOOK_AUTOSEED: '1',
        SMARTBOOK_PORT: String(API_PORT),
        SMARTBOOK_DATA_DIR: dataDir,
        SMARTBOOK_RELEVANCE_MAX_DISTANCE: '0.9',
      },
    },
    {
      command: 'npm run dev',
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { SMARTBOOK_BACKEND: `http://127.0.0.1:${API_PORT}`, SMARTBOOK_WEB_PORT: String(WEB_PORT) },
    },
  ],
})
