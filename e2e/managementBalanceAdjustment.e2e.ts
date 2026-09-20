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

// =====================================================================
// 【受入前修正】保存の成否と表示・Turn進行の整合
//
// 「保存失敗時に保存済みと表示しない／未保存設定でTurnを進めない」という
// 必須要件を、サーバー保存（POST /api/v2/simulation-runs）を実際に失敗させて
// 実測する。アプリ側にテスト専用の分岐は一切入れていない。
// =====================================================================

const SAVE_ENDPOINT = "**/api/v2/simulation-runs";

/** Runを1つ作り、バランス調整パネルを開いた状態にする。 */
async function startRunAndOpenPanel(page: Page): Promise<string> {
  await loginAsGm(page);
  await page.getByTestId("setup-start-button").click();
  await page.waitForURL(/\/v2\/management\?run=/);
  const runId = new URL(page.url()).searchParams.get("run");
  expect(runId).toBeTruthy();
  await openBalancePanel(page);
  return runId!;
}

async function fillBalanceDraft(page: Page): Promise<void> {
  await page.getByTestId("balance-sales-index").fill("95");
  await page.getByTestId("balance-raw-index").fill("105");
}

test("MB-E2E-3: persist成功が解決するまで「保存済み・適用予定」と表示されない", async ({ page }) => {
  test.setTimeout(300_000);
  await startRunAndOpenPanel(page);

  // 保存POSTを意図的に遅延させ、「保存中」の状態を観測できるようにする。
  let releaseSave: (() => void) | null = null;
  const savePending = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  let intercepted = false;
  await page.route(SAVE_ENDPOINT, async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    intercepted = true;
    await savePending;
    await route.fallback();
  });

  await fillBalanceDraft(page);
  await expect(page.getByTestId("balance-state-editing")).toBeVisible();

  await page.getByTestId("balance-apply").click();

  // --- 保存中: 「保存中…」が出て、「保存済み・適用予定」は出ない ---
  await expect(page.getByTestId("balance-state-saving")).toBeVisible();
  await expect(page.getByTestId("balance-state-saved")).toHaveCount(0);
  // 保存中はTurn進行も編集もできない。
  await expect(page.getByTestId("run-1")).toBeDisabled();
  await expect(page.getByTestId("balance-apply")).toBeDisabled();
  await expect(page.getByTestId("balance-sales-index")).toBeDisabled();
  expect(intercepted).toBe(true);

  // --- 保存を解放 → はじめて「保存済み・適用予定」 ---
  releaseSave!();
  await expect(page.getByTestId("balance-state-saved")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("balance-state-saving")).toHaveCount(0);
  await expect(page.getByTestId("run-1")).toBeEnabled();
});

test("MB-E2E-4: persist失敗時は保存済みと表示されず、設定も保存されず、Turnも進められない", async ({ page }) => {
  test.setTimeout(300_000);
  const runId = await startRunAndOpenPanel(page);

  // サーバー保存だけを失敗させる（browser cacheの挙動は既存のまま）。
  await page.route(SAVE_ENDPOINT, async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "E2E_FORCED" } }) });
  });

  await fillBalanceDraft(page);
  await page.getByTestId("balance-apply").click();

  // --- 「保存済み・適用予定」にならない。入力内容は保持され「入力中」のまま ---
  await expect(page.getByTestId("balance-state-editing")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("balance-state-saved")).toHaveCount(0);
  await expect(page.getByTestId("balance-sales-index")).toHaveValue("95");

  // --- localの正式scheduleは保存前のまま（適用予定表がTurn1で補正なし） ---
  await expect(page.getByTestId("balance-schedule-row-1")).toContainText("－（補正なし）");

  // --- Turnを進められない（persistenceBlocked） ---
  await expect(page.getByTestId("run-1")).toBeDisabled();

  // --- server側scheduleが変わっていないことを、interceptを外してreloadして確認 ---
  await page.unroute(SAVE_ENDPOINT);
  await page.reload();
  await expect(page.getByTestId("run-id")).toHaveText(runId, { timeout: 60_000 });
  await openBalancePanel(page);
  await expect(page.getByTestId("balance-state-none")).toBeVisible();
  await expect(page.getByTestId("balance-schedule-row-1")).toContainText("－（補正なし）");
});

test("MB-E2E-5: persist成功時のみ正式反映され、reload/resume後も同値が残る", async ({ page }) => {
  test.setTimeout(300_000);
  const runId = await startRunAndOpenPanel(page);

  // まず失敗させ、そのあと成功させる（同一セッション内で成否を切り替える）。
  let failNext = true;
  await page.route(SAVE_ENDPOINT, async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    if (failNext) {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "E2E_FORCED" } }) });
      return;
    }
    await route.fallback();
  });

  await fillBalanceDraft(page);
  await page.getByTestId("balance-apply").click();
  await expect(page.getByTestId("balance-state-editing")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("balance-state-saved")).toHaveCount(0);

  // 成功させて再試行（入力内容は残っているのでそのまま押せる）。
  failNext = false;
  await page.getByTestId("balance-apply").click();
  await expect(page.getByTestId("balance-state-saved")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("balance-schedule-row-1")).toContainText("95");
  await expect(page.getByTestId("balance-schedule-row-1")).toContainText("105");

  // reload / resume 後も同値。
  await page.reload();
  await expect(page.getByTestId("run-id")).toHaveText(runId, { timeout: 60_000 });
  await openBalancePanel(page);
  await expect(page.getByTestId("balance-state-saved")).toBeVisible();
  await expect(page.getByTestId("balance-schedule-row-1")).toContainText("95");
  await expect(page.getByTestId("balance-schedule-row-1")).toContainText("105");
});

test("MB-E2E-6: 保存直後に+1を連打しても、保存完了前にTurnが始まらない", async ({ page }) => {
  test.setTimeout(300_000);
  await startRunAndOpenPanel(page);

  let releaseSave: (() => void) | null = null;
  const savePending = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await page.route(SAVE_ENDPOINT, async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await savePending;
    await route.fallback();
  });

  await fillBalanceDraft(page);
  await page.getByTestId("balance-apply").click();
  await expect(page.getByTestId("balance-state-saving")).toBeVisible();

  // 保存中に+1を連打する。disabledでも強制的にクリックを送り、
  // 「ボタンが無効」だけでなく「Turnが始まらない」ことを実測する。
  const runButton = page.getByTestId("run-1");
  for (let i = 0; i < 5; i += 1) {
    await runButton.dispatchEvent("click");
  }

  // 保存が解決する前にTurnカウンタが動いていないこと。
  await expect(page.getByTestId("turn-counter")).toContainText("0 /");
  await expect(page.getByTestId("balance-state-saving")).toBeVisible();

  // 保存を解放 → 保存済みになり、ここではじめてTurnを進められる。
  releaseSave!();
  await expect(page.getByTestId("balance-state-saved")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("turn-counter")).toContainText("0 /");
  await expect(runButton).toBeEnabled();

  await page.unroute(SAVE_ENDPOINT);
  await runButton.click();
  await expect(page.getByTestId("turn-counter")).toContainText("1 /", { timeout: 120_000 });
});
