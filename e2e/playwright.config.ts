// ShrimpX V2 — Independent Player Flow: Playwright設定
//
// このリポジトリの通常のテスト（npm test）はnode:test（app/**/__tests__/**/*.test.ts）
// であり、ブラウザE2Eの仕組みはこれまで存在しなかった（このE2Eのために新規追加）。
// 3つの独立したbrowser context（GM・BAL・MASS、Cookieを共有しない）で
// dev serverへ実際に接続し、Independent Player Flowの一連のシナリオを検証する。

import path from "node:path";
import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.PLAYER_FLOW_E2E_PORT ?? 4173);
// 【複数lockfile誤検出対策】このrepoは親checkout（/home/user/vietnam-shrimp-game）配下の
// worktreeであり、webServer.commandの既定cwd（このconfigファイルのディレクトリ＝e2e/）
// から起動するとNext.jsが親のlockfileを誤ってworkspace rootと推定してしまう
// （実測: "Couldn't find any `pages` or `app` directory"で起動失敗）。
// 明示的にこのworktreeのルートをcwdに指定する。
const PROJECT_ROOT = path.resolve(__dirname, "..");

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.e2e\.ts/,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    // 【重要】127.0.0.1ではなくlocalhostを使う。Next.js devサーバーは自身のorigin
    // （localhost）以外からのdev asset request（HMR等）をcross-originとして
    // ブロックするため、127.0.0.1でアクセスするとページのhydrationは成立するが
    // click系のイベントdelegationだけが機能しない不具合を実機で確認した
    // （onChangeは動くがonClickだけ効かない、という形で症状が現れた）。
    baseURL: `https://localhost:${PORT}`,
    // 【Secure Cookie検証にHTTPSが必須】staging admin session Cookie
    // （companyLabUiSession.ts）・Player Session Cookie（sessionCookie.ts）は
    // どちらもsecure:trueで発行している。ChromeはSecure属性つきCookieを
    // 平文HTTP（http://localhost含む）ではsilentlyに破棄するため、実機確認の結果
    // このE2Eはplain HTTPでは認証Cookieが一切保存されず、GM/Player認証の検証
    // そのものが成立しなかった。next dev --experimental-httpsの自己署名証明書に対して
    // ignoreHTTPSErrorsで接続する。
    ignoreHTTPSErrors: true,
    launchOptions: {
      // 【この環境の既定Chromiumバージョン】@playwright/testが要求するrevisionと
      // 事前インストール済みChromiumのrevisionが一致しないため、明示的なexecutablePathで
      // 新規ダウンロードを避ける（環境のREADME記載の既定対処）。
      executablePath: "/opt/pw-browsers/chromium",
    },
  },
  webServer: {
    command: `npx next dev --experimental-https --port ${PORT}`,
    cwd: PROJECT_ROOT,
    url: `https://localhost:${PORT}`,
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      STAGING_ADMIN_TOKEN: "e2e-test-token",
      V2_API_E2E_IN_MEMORY: "1",
      // 【V2サブシステムの制約】readAppEnvV2FromEnv()はAPP_ENVに"production"/"staging"
      // のみ許容する（"development"は不可）。本番ではないためstagingを使う。
      APP_ENV: "staging",
    },
  },
});
