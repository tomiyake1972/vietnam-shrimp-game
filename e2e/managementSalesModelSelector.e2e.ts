// ShrimpX V2 — MANAGEMENT-CONSOLE-SALES-MODEL-1: Management Setup 販売市場モデル選択 E2E
//
// 指示§10 の必須シナリオ A〜H をそのまま自動化する:
//  A. Setupで「三層顧客価格モデル V2.00候補」を選択
//  B. 5社のうち1社（BAL）をPLAYER・他4社はStandard AI（既定）
//  C. Run開始
//  D. Management Consoleで販売市場モデル表示を確認
//  E. Turn1処理
//  F. reload / resume
//  G. Turn2
//  H. salesModelIdが維持されていること（reload後・Turn2後も表示が変わらない）

import { test, expect, type Page } from "@playwright/test";

const STAGING_ADMIN_TOKEN = "e2e-test-token";
const TIERED_LABEL = "三層顧客価格モデル V2.00候補";
const LEGACY_LABEL = "従来市場モデル";

async function loginAsGm(page: Page): Promise<void> {
  const returnTo = encodeURIComponent("/v2/management/setup");
  await page.goto(`/v2/company-lab/play/login?returnTo=${returnTo}`);
  await page.getByLabel("管理トークン").fill(STAGING_ADMIN_TOKEN);
  await page.getByRole("button", { name: "ログイン" }).click();
  await page.waitForURL(/\/v2\/management\/setup/);
}

/** PLAYER会社（BAL）の当期意思決定を、Management Console側のPLAYER Workspaceで確定する。 */
async function confirmPlayerDecision(page: Page): Promise<void> {
  await page.getByTestId("company-control-operate-BAL").click();
  await page.waitForURL(/\/v2\/management\/player/);
  // 【§5・Player Workspaceのread-only表示】
  await expect(page.getByTestId("workspace-sales-model")).toContainText(TIERED_LABEL);
  // 意思決定確定ボタンは「意思決定」タブにだけ描画される（実測）。
  await page.getByTestId("workspace-tab-decision").click();
  await page.getByTestId("workspace-confirm-decision").click();
  await page.getByTestId("workspace-back-to-console").click();
  await page.waitForURL(/\/v2\/management\?run=/);
}

test("MC-SALES-E2E: Setupでtieredを選んで作成したRunが、Console表示・Turn進行・reload/resumeを通じてtieredを維持する", async ({ page }) => {
  test.setTimeout(300_000);

  // --- A. Setupで三層顧客価格モデルを選択 ---
  await loginAsGm(page);
  const select = page.getByTestId("setup-sales-model-select");
  // 既定は従来市場モデル（legacy）。
  await expect(select).toHaveValue("legacy-waterfall-v1");
  await select.selectOption("tiered-v200-candidate-v1");

  // --- B. BALだけPLAYER、他4社はStandard AI（既定のまま） ---
  await page.getByTestId("setup-control-mode-BAL").selectOption("PLAYER");

  // --- C. Run開始 ---
  await page.getByTestId("setup-start-button").click();
  await page.waitForURL(/\/v2\/management\?run=/);
  const runId = new URL(page.url()).searchParams.get("run");
  expect(runId).toBeTruthy();

  // --- D. Management Consoleでの販売市場モデル表示 ---
  await expect(page.getByTestId("console-sales-model")).toHaveText(TIERED_LABEL);

  // --- E. Turn1処理（PLAYER会社の意思決定を確定してから進める） ---
  await confirmPlayerDecision(page);
  await page.getByTestId("run-1").click();
  await expect(page.getByTestId("turn-counter")).toContainText("1 /", { timeout: 120_000 });
  await expect(page.getByTestId("console-sales-model")).toHaveText(TIERED_LABEL);

  // --- F. reload / resume ---
  await page.reload();
  await expect(page.getByTestId("run-id")).toHaveText(runId!, { timeout: 60_000 });
  // --- H(1). reload後もtieredが維持されている ---
  await expect(page.getByTestId("console-sales-model")).toHaveText(TIERED_LABEL);
  await expect(page.getByTestId("console-sales-model")).not.toHaveText(LEGACY_LABEL);

  // --- G. Turn2 ---
  await confirmPlayerDecision(page);
  await page.getByTestId("run-1").click();
  await expect(page.getByTestId("turn-counter")).toContainText("2 /", { timeout: 120_000 });

  // --- H(2). Turn2後もtieredが維持されている ---
  await expect(page.getByTestId("console-sales-model")).toHaveText(TIERED_LABEL);
});

test("MC-SALES-E2E-legacy: 既定（従来市場モデル）のまま作成したRunは従来市場モデルと表示される", async ({ page }) => {
  test.setTimeout(180_000);
  await loginAsGm(page);
  await expect(page.getByTestId("setup-sales-model-select")).toHaveValue("legacy-waterfall-v1");
  await page.getByTestId("setup-start-button").click();
  await page.waitForURL(/\/v2\/management\?run=/);
  await expect(page.getByTestId("console-sales-model")).toHaveText(LEGACY_LABEL);
});
