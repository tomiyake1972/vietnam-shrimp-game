// ShrimpX V2 — BALANCE-PROFILE-1: Balance Profile の32Turn自動テストプレイ E2E
//
// 指示§14 S の必須シナリオを実ブラウザで通す。
//   Management Setup → Balance Profile選択 → Run開始 → 全社Standard AI
//   → 32Turn → 最終適用実績確認
//
// Profileは「Consoleで手動設定 → Profileとして保存」という実際の経路で作る
// （localStorageへテスト専用の値を直接書き込まない＝保存経路そのものを検証する）。
//
// 共有Redisは使わない（V2_API_E2E_IN_MEMORY=1 の隔離環境）。

import { test, expect, type Page } from "@playwright/test";

const STAGING_ADMIN_TOKEN = "e2e-test-token";
const PROFILE_NAME = "E2E-Block-A";

async function loginAsGm(page: Page): Promise<void> {
  const returnTo = encodeURIComponent("/v2/management/setup");
  await page.goto(`/v2/company-lab/play/login?returnTo=${returnTo}`);
  await page.getByLabel("管理トークン").fill(STAGING_ADMIN_TOKEN);
  await page.getByRole("button", { name: "ログイン" }).click();
  await page.waitForURL(/\/v2\/management\/setup/);
}

async function openPanel(page: Page, toggleTestId: string, anchorTestId: string): Promise<void> {
  const toggle = page.getByTestId(toggleTestId);
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
  await expect(page.getByTestId(anchorTestId)).toBeVisible();
}

/**
 * <details> セクションを開く。
 *
 * Profileの保存・再適用・持ち出しのフォームは <details> の中にあり、
 * 閉じている間はDOMに存在しても操作できない（fillがactionability待ちで
 * タイムアウトするまで延々リトライする）。開いているかを確認してから開く。
 */
async function openDetails(page: Page, summaryText: string): Promise<void> {
  const details = page.locator("details").filter({ hasText: summaryText }).first();
  const isOpen = await details.evaluate((el) => (el as HTMLDetailsElement).open);
  if (!isOpen) {
    await details.locator("summary").first().click();
  }
  await expect(details).toHaveJSProperty("open", true);
}

/** 失敗を30分待たずに顕在化させるための共通待ち時間。 */
const ACTION_TIMEOUT = 20_000;

test("BP-E2E: Profileを作成し、それを選んだ全社Standard AIのRunで32Turnを完走して適用実績を確認できる", async ({ page }) => {
  test.setTimeout(1_800_000);

  // ============================================================
  // 第1部: Consoleで手動設定を作り、Balance Profileとして保存する
  // ============================================================
  await loginAsGm(page);
  await page.getByTestId("setup-start-button").click();
  await page.waitForURL(/\/v2\/management\?run=/);

  await openPanel(page, "console-balance-adjustment-toggle", "balance-apply");
  await page.getByTestId("balance-sales-index").fill("95", { timeout: ACTION_TIMEOUT });
  await page.getByTestId("balance-raw-index").fill("105", { timeout: ACTION_TIMEOUT });
  await page.getByTestId("balance-mode").selectOption("continuing");
  await page.getByTestId("balance-apply").click();
  await expect(page.getByTestId("balance-state-saved")).toBeVisible({ timeout: 60_000 });

  // Profileとして保存（§7の経路そのもの）。
  await openPanel(page, "console-balance-profile-toggle", "console-origin-profile");
  // このRunはProfileを使わずに開始したので、元Profileの記録は無い。
  await expect(page.getByTestId("console-origin-profile-none")).toBeVisible();

  await openDetails(page, "現在の設定をBalance Profileとして保存");
  await page.getByTestId("profile-save-name").fill(PROFILE_NAME, { timeout: ACTION_TIMEOUT });
  await page.getByTestId("profile-save-description").fill("E2E用: 販売95 / 原料105 をTurn1から継続", { timeout: ACTION_TIMEOUT });
  await page.getByTestId("profile-save-button").click();
  await expect(page.getByTestId("profile-message")).toContainText("として保存しました");

  // ============================================================
  // 第2部: Setupでそのprofileを選んで、新しいRunを開始する
  // ============================================================
  await page.goto("/v2/management/setup");
  const select = page.getByTestId("setup-balance-profile-select");
  await expect(select).toBeVisible();
  // 既定は Neutral。
  await expect(page.getByTestId("setup-balance-profile-neutral-note")).toBeVisible();

  await select.selectOption({ label: PROFILE_NAME });
  // 開始前に中身（Turn別の指数）が確認できること（§5）。
  await expect(page.getByTestId("setup-balance-profile-description")).toContainText("販売95");
  const previewRow1 = page.getByTestId("setup-balance-profile-row-1");
  await expect(previewRow1).toBeVisible();
  await expect(previewRow1).toContainText("95");
  await expect(previewRow1).toContainText("105");
  await expect(page.getByTestId("setup-balance-profile-range")).toContainText("Turn 1");

  // 全社Standard AIのまま（PLAYERへ一社も切り替えない）Run開始。
  await page.getByTestId("setup-start-button").click();
  await page.waitForURL(/\/v2\/management\?run=/);
  const runId = new URL(page.url()).searchParams.get("run");
  expect(runId).toBeTruthy();

  // 元Profileがread-onlyで確認できる（§6）。
  await openPanel(page, "console-balance-profile-toggle", "console-origin-profile");
  await expect(page.getByTestId("console-origin-profile-name")).toHaveText(PROFILE_NAME);
  await expect(page.getByTestId("console-origin-profile-drift")).toContainText("Profile適用時から変更なし");

  // ============================================================
  // 第3部: 32Turnを一括実行し、最後まで自動適用されることを確認する
  // ============================================================
  await page.getByTestId("run-32").click();
  await expect(page.getByTestId("turn-counter")).toContainText("32 /", { timeout: 1_500_000 });

  // 最終Turnまで適用実績が残っていること（§9「途中で人間が操作しなくても最後まで」）。
  await openPanel(page, "console-balance-adjustment-toggle", "balance-applied-table");
  for (const turn of [1, 16, 32]) {
    const row = page.getByTestId(`balance-applied-row-${turn}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText("×1.05");
  }

  // 実績の数値そのものを検証する（補正前×1.05＝適用後）。
  const lastRow = page.getByTestId("balance-applied-row-32");
  const cells = await lastRow.locator("td").allInnerTexts();
  const firstNumber = (text: string): number => {
    const m = text.match(/-?\d+(\.\d+)?/);
    return m ? Number(m[0]) : Number.NaN;
  };
  const preManual = firstNumber(cells[4]);
  const applied = firstNumber(cells[5]);
  expect(preManual).toBeGreaterThan(0);
  expect(Math.abs(applied - preManual * 1.05)).toBeLessThan(0.001);

  // ============================================================
  // 第4部: reload後もProfile由来情報と実績が残る（§14 L）
  // ============================================================
  await page.reload();
  await expect(page.getByTestId("run-id")).toHaveText(runId!, { timeout: 120_000 });
  await openPanel(page, "console-balance-profile-toggle", "console-origin-profile");
  await expect(page.getByTestId("console-origin-profile-name")).toHaveText(PROFILE_NAME);
  await openPanel(page, "console-balance-adjustment-toggle", "balance-applied-table");
  await expect(page.getByTestId("balance-applied-row-32")).toBeVisible();
});

test("BP-E2E-2: Neutralを選んだRunにはProfileの記録が残らない", async ({ page }) => {
  test.setTimeout(300_000);

  await loginAsGm(page);
  // 既定（Neutral）のまま開始する。
  await expect(page.getByTestId("setup-balance-profile-neutral-note")).toBeVisible();
  await page.getByTestId("setup-start-button").click();
  await page.waitForURL(/\/v2\/management\?run=/);

  await openPanel(page, "console-balance-profile-toggle", "console-origin-profile");
  await expect(page.getByTestId("console-origin-profile-none")).toBeVisible();
  await expect(page.getByTestId("console-origin-profile-name")).toHaveCount(0);
});
