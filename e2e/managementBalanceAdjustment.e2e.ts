// ShrimpX V2 — MANUAL-BALANCE-1: Management Console 手動バランス調整 E2E
//
// 実装指示の必須シナリオ「設定入力→保存→1ターン進行→結果確認」を、
// 全社Standard AI（PLAYERへ切り替えない）運用のまま自動化する。
//
//  A. GMログイン → Setup → 全社Standard AIのままRun開始
//  B. バランス調整パネルを開く
//  C. 配当性向・販売指数・原料指数を入力（入力中バッジ）
//  D. 保存 → 「保存済み・適用予定」バッジ
//  E. Turn1を進める
//  F. 適用実績に Turn1 の補正前／適用後が出る
//  G. reload / resume 後も設定と適用実績が残っている

import { test, expect, type Page } from "@playwright/test";

const STAGING_ADMIN_TOKEN = "e2e-test-token";

async function loginAsGm(page: Page): Promise<void> {
  const returnTo = encodeURIComponent("/v2/management/setup");
  await page.goto(`/v2/company-lab/play/login?returnTo=${returnTo}`);
  await page.getByLabel("管理トークン").fill(STAGING_ADMIN_TOKEN);
  await page.getByRole("button", { name: "ログイン" }).click();
  await page.waitForURL(/\/v2\/management\/setup/);
}

/** バランス調整パネル（Collapsible）を開く。既に開いていれば何もしない。 */
async function openBalancePanel(page: Page): Promise<void> {
  const toggle = page.getByTestId("console-balance-adjustment-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
  await expect(page.getByTestId("balance-apply")).toBeVisible();
}

test("MB-E2E: バランス調整の入力→保存→1ターン進行→結果確認が、全社Standard AIのまま成立する", async ({ page }) => {
  test.setTimeout(300_000);

  // --- A. Run開始（全社Standard AI＝既定のまま、PLAYERへ切り替えない） ---
  await loginAsGm(page);
  await page.getByTestId("setup-start-button").click();
  await page.waitForURL(/\/v2\/management\?run=/);
  const runId = new URL(page.url()).searchParams.get("run");
  expect(runId).toBeTruthy();

  // --- B. バランス調整パネルを開く ---
  await openBalancePanel(page);
  // 初期状態は手動補正なし。
  await expect(page.getByTestId("balance-state-none")).toBeVisible();

  // --- C. 設定を入力（入力中バッジへ変わる） ---
  await page.getByTestId("balance-dividend-percent").fill("20");
  await page.getByTestId("balance-sales-index").fill("95");
  await page.getByTestId("balance-raw-index").fill("105");
  await expect(page.getByTestId("balance-state-editing")).toBeVisible();

  // 継続適用にする（次Turn以降ずっと効く）。
  await page.getByTestId("balance-mode").selectOption("continuing");

  // --- D. 保存 → 「保存済み・適用予定」 ---
  await page.getByTestId("balance-apply").click();
  await expect(page.getByTestId("balance-state-saved")).toBeVisible();
  // 適用予定表にTurn1の最終適用値が出る。
  await expect(page.getByTestId("balance-schedule-row-1")).toContainText("95");
  await expect(page.getByTestId("balance-schedule-row-1")).toContainText("105");
  await expect(page.getByTestId("balance-schedule-row-1")).toContainText("20.0%");

  // --- E. Turn1を進める ---
  await page.getByTestId("run-1").click();
  await expect(page.getByTestId("turn-counter")).toContainText("1 /", { timeout: 120_000 });

  // --- F. 適用実績にTurn1が出る（補正前と適用後が別の値として並ぶ） ---
  await openBalancePanel(page);
  const appliedRow = page.getByTestId("balance-applied-row-1");
  await expect(appliedRow).toBeVisible();
  await expect(appliedRow).toContainText("Turn1で適用済み");
  await expect(appliedRow).toContainText("×1.05");

  // 補正前と適用後が同じ値になっていない（＝指数が実際に効いている）ことを実測する。
  const cells = await appliedRow.locator("td").allInnerTexts();
  // 列順: Turn / 配当性向 / 販売指数 / 原料指数 / 原料補正前 / 原料適用後 / Scenario捕捉指数
  // 適用後セルには "4.1234 ×1.05" のように倍率バッジが同居するため、先頭の数値だけを読む。
  const firstNumber = (text: string): number => {
    const match = text.match(/-?\d+(\.\d+)?/);
    return match ? Number(match[0]) : Number.NaN;
  };
  const preManual = firstNumber(cells[4]);
  const applied = firstNumber(cells[5]);
  expect(preManual).toBeGreaterThan(0);
  expect(applied).toBeGreaterThan(0);
  // 原料指数105 ＝ そのTurnの補正前価格の1.05倍（再クランプしていない）。
  expect(Math.abs(applied - preManual * 1.05)).toBeLessThan(0.001);

  // --- G. reload / resume 後も設定と適用実績が残っている ---
  await page.reload();
  await expect(page.getByTestId("run-id")).toHaveText(runId!, { timeout: 60_000 });
  await openBalancePanel(page);
  await expect(page.getByTestId("balance-state-saved")).toBeVisible();
  await expect(page.getByTestId("balance-applied-row-1")).toBeVisible();
  await expect(page.getByTestId("balance-applied-row-1")).toContainText("×1.05");

  // 管理会計の限界表示が常に出ている（結果の読み方を誤らせないため）。
  await expect(page.getByTestId("management-accounting-limitation")).toBeVisible();
});

test("MB-E2E-2: 不正な入力（単位間違い・空欄由来の0）は保存できない", async ({ page }) => {
  test.setTimeout(300_000);

  await loginAsGm(page);
  await page.getByTestId("setup-start-button").click();
  await page.waitForURL(/\/v2\/management\?run=/);
  await openBalancePanel(page);

  // 0.95（比率で入れてしまった単位間違い）は保存ボタンが無効のまま。
  await page.getByTestId("balance-sales-index").fill("0.95");
  await expect(page.getByTestId("balance-validation-error")).toBeVisible();
  await expect(page.getByTestId("balance-apply")).toBeDisabled();

  // 0（空欄が0として送られた場合に相当）も拒否される。
  await page.getByTestId("balance-sales-index").fill("0");
  await expect(page.getByTestId("balance-apply")).toBeDisabled();

  // 正しい値（95）にすると保存できる。
  await page.getByTestId("balance-sales-index").fill("95");
  await expect(page.getByTestId("balance-apply")).toBeEnabled();
});
