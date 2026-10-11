// ShrimpX V2 — 配備済み Preview に対するブラウザ確認の Playwright 設定。
//
// 通常の e2e/playwright.config.ts は dev server を自分で起動し、
// V2_API_E2E_IN_MEMORY=1 の隔離環境で動く。こちらは逆で、
// すでに配備された Preview（本物の Vercel ＋ 共有 Redis）へ素の HTTPS で接続する。
// webServer は起動しない。環境変数も注入しない（Preview 側の設定をそのまま使う）。
//
// 必要な環境変数（このファイルには値を書かない）
//   INT1_LIVE_URL        Preview の URL
//   STAGING_ADMIN_TOKEN  管理トークン

import { defineConfig } from "@playwright/test";

const BASE = process.env.INT1_LIVE_URL ?? "";
if (!BASE) throw new Error("INT1_LIVE_URL が未設定です。");

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.live\.ts/,
  timeout: 900_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE,
    // 1つの操作が刺さったままテスト全体の時間を食い潰さないよう上限を置く。
    actionTimeout: 60_000,
    navigationTimeout: 120_000,
    launchOptions: { executablePath: "/opt/pw-browsers/chromium" },
  },
});
