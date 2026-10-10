// ShrimpX V2 — UI-TRIAL-1 完了報告用のスクリーンショット取得（検証ではなく記録）
//
// 指示§9で求められた3点（営業配員 / 入力と参照の区別 / 最終確認画面）を、
// 実際の dev server の画面から撮る。アサーションは「撮る対象が存在すること」だけに
// とどめ、受入確認そのものは uiTrial1PlayerUi.e2e.ts が行う。
//
// 共有Redisは使わない（V2_API_E2E_IN_MEMORY=1 の隔離環境）。

import { test, expect, type Page } from "@playwright/test";

const STAGING_ADMIN_TOKEN = "e2e-test-token";
const OUT = "docs/int1/attachments/uiTrial1";

async function loginAsGm(page: Page): Promise<void> {
  const returnTo = encodeURIComponent("/v2/management/setup");
  await page.goto(`/v2/company-lab/play/login?returnTo=${returnTo}`);
  await page.getByLabel("管理トークン").fill(STAGING_ADMIN_TOKEN);
  await page.getByRole("button", { name: "ログイン" }).click();
  await page.waitForURL(/\/v2\/management\/setup/);
}

test("UI-TRIAL-1 スクリーンショット（Console内PLAYER）", async ({ page }) => {
  test.setTimeout(420_000);
  await page.setViewportSize({ width: 1280, height: 1400 });
  await loginAsGm(page);
  await page.goto("/v2/management/setup");
  await page.getByTestId("setup-control-mode-BAL").selectOption("PLAYER");
  await page.getByTestId("setup-start-button").click();
  await page.waitForURL(/\/v2\/management\?run=/);
  await page.getByTestId("company-control-operate-BAL").click();
  await expect(page.getByTestId("workspace-heading")).toBeVisible({ timeout: 120_000 });
  await page.getByTestId("workspace-tab-decision").click();

  // (2) 入力エリアの見出し・AI初期提案の説明・色の凡例
  await expect(page.getByTestId("decision-studio-decision-heading")).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: `${OUT}/02-input-vs-reference-heading.png`, fullPage: false });

  // (1) 営業配員（市場ごとに1つ）
  await page.getByTestId("decision-studio-tab-sales").click();
  await expect(page.getByTestId("decision-studio-sales-screen")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("sales-force-market-headcount-CN")).toBeVisible();
  await page.getByTestId("sales-plan-market-blocks").screenshot({ path: `${OUT}/01-sales-staffing-by-market.png` });

  // (2b) 入力列と参照列の区別（WORKER画面の表の見出し）
  await page.getByTestId("decision-studio-tab-worker").click();
  await expect(page.getByTestId("decision-studio-worker-screen")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("worker-assignment-section").screenshot({ path: `${OUT}/02b-worker-input-vs-reference-columns.png` });

  // (2c) 残り4画面の入力／参照の区別（UI-TRIAL-1 限定仕上げ §1）
  const screens: readonly { readonly key: string; readonly testId: string; readonly file: string }[] = [
    { key: "production", testId: "decision-studio-production-screen", file: "04-production.png" },
    { key: "procurement", testId: "domestic-purchase-section", file: "05-procurement.png" },
    { key: "investment", testId: "decision-studio-investment-screen", file: "06-investment.png" },
    { key: "finance", testId: "decision-studio-finance-screen", file: "07-finance.png" },
  ];
  for (const screen of screens) {
    await page.getByTestId(`decision-studio-tab-${screen.key}`).click();
    await expect(page.getByTestId(screen.testId)).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: `${OUT}/${screen.file}`, fullPage: true });
  }

  // (3) 最終確認画面
  await page.getByTestId("workspace-review-decision").click();
  await expect(page.getByTestId("decision-confirmation-screen")).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: `${OUT}/03-confirmation-top.png`, fullPage: false });
  await page.screenshot({ path: `${OUT}/03b-confirmation-full.png`, fullPage: true });
});
