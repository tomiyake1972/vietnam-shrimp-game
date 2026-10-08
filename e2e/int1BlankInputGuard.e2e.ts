// ShrimpX V2 — INT-1 §1（監査後修正）: 空欄・不正数値が無言で0にならないことの実ブラウザ確認
//
// 【なぜ実ブラウザが必要か】APIへの直接POSTでは、入力欄が値をどう保持するかを確認できない。
// 旧実装の欠陥は「利用者が空欄にした／打ち間違えた値が、画面側で0や範囲内の値へ
// 書き換えられてから下書きへ入る」ことであり、POSTの時点ではすでに書き換え後だった。
// ここでは実際に input を操作し、
//   (a) 明示的な0は受理される
//   (b) 空欄は空欄のまま保たれ、0へ変わらない
//   (c) 範囲外の値がクランプされない
//   (d) その状態では提出・確定が対象項目を示して止まる
//   (e) 打ち直せば再び提出できる
// を Console内PLAYER と Independent Player の両経路で確認する。
//
// 共有Redisは使わない（V2_API_E2E_IN_MEMORY=1 の隔離環境）。

import { test, expect, type Browser, type Locator, type Page } from "@playwright/test";

const STAGING_ADMIN_TOKEN = "e2e-test-token";
const SALES_QUANTITY_CELL = "sales-plan-desired-quantity-CN-hoso";

async function loginAsGm(page: Page): Promise<void> {
  const returnTo = encodeURIComponent("/v2/management/setup");
  await page.goto(`/v2/company-lab/play/login?returnTo=${returnTo}`);
  await page.getByLabel("管理トークン").fill(STAGING_ADMIN_TOKEN);
  await page.getByRole("button", { name: "ログイン" }).click();
  await page.waitForURL(/\/v2\/management\/setup/);
}

async function createRunWithPlayerBal(page: Page): Promise<string> {
  await page.goto("/v2/management/setup");
  await page.getByTestId("setup-control-mode-BAL").selectOption("PLAYER");
  await page.getByTestId("setup-start-button").click();
  await page.waitForURL(/\/v2\/management\?run=/);
  const runId = new URL(page.url()).searchParams.get("run");
  expect(runId).toBeTruthy();
  return runId!;
}

async function openIndependentPlayer(gmPage: Page, browser: Browser, companyId: string): Promise<Page> {
  const issue = gmPage.getByTestId(`player-seat-issue-${companyId}`);
  await expect(issue).toBeVisible({ timeout: 60_000 });
  await issue.click();
  const codeLocator = gmPage.getByTestId(`player-seat-join-url-${companyId}`).locator("code");
  await expect(codeLocator).toBeVisible({ timeout: 60_000 });
  const joinUrl = ((await codeLocator.textContent()) ?? "").trim();
  if (!joinUrl) throw new Error(`${companyId}の参加リンクが取得できない`);
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await page.goto(joinUrl);
  await page.waitForURL(/\/v2\/play\/workspace/);
  await expect(page.getByTestId("play-workspace-heading")).toContainText(companyId);
  return page;
}

async function advanceOneTurn(gmPage: Page, expectedTurn: number): Promise<void> {
  const counter = gmPage.getByTestId("turn-counter");
  const runButton = gmPage.getByTestId("run-1");
  await expect(runButton).toBeEnabled({ timeout: 300_000 });
  await runButton.click();
  await expect(counter).toContainText(`${expectedTurn} /`, { timeout: 120_000 });
  await expect(runButton).toBeEnabled({ timeout: 300_000 });
}

/** 入力欄を実際に空欄へする（利用者が値を削除した操作）。 */
async function clearCell(cell: Locator): Promise<void> {
  await cell.click();
  await cell.press("ControlOrMeta+a");
  await cell.press("Delete");
  await cell.blur();
}

/** WORKER画面の最初の工場行のtestid接尾辞（工場IDはscenario依存なので実物から取る）。 */
async function firstWorkerFactoryTestId(page: Page): Promise<string> {
  const first = page.locator('[data-testid^="worker-headcount-change-"]').first();
  await expect(first).toBeVisible({ timeout: 60_000 });
  const id = await first.getAttribute("data-testid");
  if (id === null) throw new Error("WORKER画面の増減欄が見つからない");
  return id.replace("worker-headcount-change-", "");
}

test("INT1-BLANK-1: Console内PLAYER — 販売数量の 0／空欄／打ち直し", async ({ page }) => {
  test.setTimeout(300_000);
  await loginAsGm(page);
  await createRunWithPlayerBal(page);

  await page.getByTestId("company-control-operate-BAL").click();
  await page.waitForURL(/\/v2\/management\/player/);
  await expect(page.getByTestId("workspace-turn")).toHaveAttribute("data-turn", "1");
  await page.getByTestId("workspace-tab-decision").click();
  await page.getByTestId("decision-studio-tab-sales").click();

  const quantity = page.getByTestId(SALES_QUANTITY_CELL);
  await expect(quantity).toBeVisible({ timeout: 60_000 });

  await test.step("(a) 明示的な0は受理され、警告状態にならない", async () => {
    await quantity.fill("0");
    await quantity.blur();
    await expect(quantity).toHaveValue("0");
    await expect(quantity).not.toHaveAttribute("data-invalid", "true");
  });

  await test.step("(b) 空欄にしても0へ書き換わらず、空欄のまま保たれる", async () => {
    await clearCell(quantity);
    await expect(quantity).toHaveValue("");
    await expect(quantity).toHaveAttribute("data-invalid", "true");
  });

  await test.step("(d) 空欄のまま確定すると、対象項目を示して止まる", async () => {
    await page.getByTestId("workspace-confirm-decision").click();
    const error = page.getByTestId("workspace-confirm-error");
    await expect(error).toBeVisible({ timeout: 30_000 });
    await expect(error).toContainText("提示数量");
    await expect(error).toContainText("保存していません");
    await expect(page.getByTestId("workspace-decision-status")).not.toContainText("意思決定済み");
    // 止めた後も入力は空欄のまま（勝手に0へ戻さない）。
    await expect(quantity).toHaveValue("");
  });

  await test.step("(e) 打ち直せば確定できる", async () => {
    await quantity.fill("1500");
    await quantity.blur();
    await expect(quantity).toHaveValue("1500");
    await page.getByTestId("workspace-confirm-decision").click();
    await expect(page.getByTestId("workspace-decision-status")).toContainText("意思決定済み", { timeout: 120_000 });
  });
});

test("INT1-BLANK-2: Console内PLAYER — 人員配置の空欄と比率の範囲外", async ({ page }) => {
  test.setTimeout(300_000);
  await loginAsGm(page);
  await createRunWithPlayerBal(page);

  await page.getByTestId("company-control-operate-BAL").click();
  await page.waitForURL(/\/v2\/management\/player/);
  await page.getByTestId("workspace-tab-decision").click();
  await page.getByTestId("decision-studio-tab-worker").click();
  await expect(page.getByTestId("decision-studio-worker-screen")).toBeVisible({ timeout: 60_000 });
  const factoryId = await firstWorkerFactoryTestId(page);
  const headcountChange = page.getByTestId(`worker-headcount-change-${factoryId}`);
  const overtimeRate = page.getByTestId(`worker-overtime-rate-${factoryId}`);

  await test.step("人員配置（増員／減員）を空欄にしても0へ書き換わらない", async () => {
    await clearCell(headcountChange);
    await expect(headcountChange).toHaveValue("");
    await expect(headcountChange).toHaveAttribute("data-invalid", "true");
  });

  await test.step("空欄のまま確定すると、増員／減員を示して止まる", async () => {
    await page.getByTestId("workspace-confirm-decision").click();
    const error = page.getByTestId("workspace-confirm-error");
    await expect(error).toBeVisible({ timeout: 30_000 });
    await expect(error).toContainText("増員／減員");
    await expect(page.getByTestId("workspace-decision-status")).not.toContainText("意思決定済み");
  });

  await test.step("増員／減員を0へ打ち直し、比率へ範囲外の99を入れてもクランプされない", async () => {
    await headcountChange.fill("0");
    await headcountChange.blur();
    await expect(headcountChange).toHaveValue("0");
    // 旧実装は Math.min(1, Math.max(0, n)) で 99 を 1 へ書き換えていた。
    await overtimeRate.fill("99");
    await overtimeRate.blur();
    await expect(overtimeRate).toHaveValue("99");
  });

  await test.step("範囲外の比率は残業率を示して止まる", async () => {
    await page.getByTestId("workspace-confirm-decision").click();
    const error = page.getByTestId("workspace-confirm-error");
    await expect(error).toBeVisible({ timeout: 30_000 });
    await expect(error).toContainText("残業率");
    await expect(page.getByTestId("workspace-decision-status")).not.toContainText("意思決定済み");
  });

  await test.step("比率を空欄にしても0へ書き換わらず、やはり止まる", async () => {
    await clearCell(overtimeRate);
    await expect(overtimeRate).toHaveValue("");
    await expect(overtimeRate).toHaveAttribute("data-invalid", "true");
    await page.getByTestId("workspace-confirm-decision").click();
    await expect(page.getByTestId("workspace-confirm-error")).toContainText("残業率", { timeout: 30_000 });
  });

  await test.step("正当な比率へ打ち直せば確定できる", async () => {
    await overtimeRate.fill("0.1");
    await overtimeRate.blur();
    await expect(overtimeRate).toHaveValue("0.1");
    await page.getByTestId("workspace-confirm-decision").click();
    await expect(page.getByTestId("workspace-decision-status")).toContainText("意思決定済み", { timeout: 120_000 });
  });
});

test("INT1-BLANK-3: Independent Player — 空欄のまま提出すると項目名を示して止まり、直せば提出できる", async ({ page, browser }) => {
  test.setTimeout(300_000);
  await loginAsGm(page);
  await createRunWithPlayerBal(page);
  const balPage = await openIndependentPlayer(page, browser, "BAL");

  await balPage.getByTestId("decision-studio-tab-sales").click();
  const quantity = balPage.getByTestId(SALES_QUANTITY_CELL);
  await expect(quantity).toBeVisible({ timeout: 60_000 });

  await test.step("明示的な0は受理される（提出を止めない値であることを確認）", async () => {
    await quantity.fill("0");
    await quantity.blur();
    await expect(quantity).toHaveValue("0");
    await expect(quantity).not.toHaveAttribute("data-invalid", "true");
  });

  await test.step("空欄のまま提出すると、対象項目を示して止まる", async () => {
    await clearCell(quantity);
    await expect(quantity).toHaveValue("");
    await balPage.getByTestId("play-submit-decision").click();
    const error = balPage.getByTestId("play-submit-error");
    await expect(error).toBeVisible({ timeout: 30_000 });
    await expect(error).toContainText("提示数量");
    await expect(error).toContainText("保存していません");
    await expect(balPage.getByTestId("play-waiting-for-gm")).toHaveCount(0);
    await expect(quantity).toHaveValue("");
  });

  await test.step("打ち直せば提出できる", async () => {
    await quantity.fill("1200");
    await quantity.blur();
    await balPage.getByTestId("play-submit-decision").click();
    await expect(balPage.getByTestId("play-waiting-for-gm")).toBeVisible({ timeout: 60_000 });
  });

  await balPage.context().close();
});

test("INT1-BLANK-4: Independent Player — JSON送信経路でも空欄が項目名付きで拒否され、未保存のまま直して提出できる", async ({ page, browser }) => {
  test.setTimeout(300_000);
  await loginAsGm(page);
  await createRunWithPlayerBal(page);
  const balPage = await openIndependentPlayer(page, browser, "BAL");

  await balPage.getByTestId("decision-studio-tab-worker").click();
  await expect(balPage.getByTestId("decision-studio-worker-screen")).toBeVisible({ timeout: 60_000 });
  const factoryId = await firstWorkerFactoryTestId(balPage);
  const headcountChange = balPage.getByTestId(`worker-headcount-change-${factoryId}`);

  await test.step("明示的な0は受理される（警告状態にならない）", async () => {
    await headcountChange.fill("0");
    await headcountChange.blur();
    await expect(headcountChange).toHaveValue("0");
    await expect(headcountChange).not.toHaveAttribute("data-invalid", "true");
  });

  await test.step("空欄のまま提出すると、増員／減員を示して止まり未保存のままになる", async () => {
    await clearCell(headcountChange);
    await expect(headcountChange).toHaveValue("");
    await expect(headcountChange).toHaveAttribute("data-invalid", "true");
    await balPage.getByTestId("play-submit-decision").click();
    const error = balPage.getByTestId("play-submit-error");
    await expect(error).toBeVisible({ timeout: 30_000 });
    await expect(error).toContainText("増員／減員");
    await expect(error).toContainText("保存していません");
    // 提出が成立していない（GM待ちにならず、同じTurnの編集を続けられる）。
    // 入力を触った後の状態は EDITING＝「入力中（まだ提出していません）」であり、
    // これが未保存であることの画面上の表示そのもの（実測）。
    await expect(balPage.getByTestId("play-waiting-for-gm")).toHaveCount(0);
    await expect(balPage.getByTestId("play-workspace-status")).toHaveAttribute("data-status", "EDITING");
    await expect(balPage.getByTestId("play-workspace-status")).toContainText("まだ提出していません");
    await expect(headcountChange).toHaveValue("");
  });

  await test.step("正当な減員（負の増減）へ直すと同じTurnに提出できる", async () => {
    await headcountChange.fill("-10");
    await headcountChange.blur();
    await expect(headcountChange).toHaveValue("-10");
    await balPage.getByTestId("play-submit-decision").click();
    await expect(balPage.getByTestId("play-waiting-for-gm")).toBeVisible({ timeout: 60_000 });
    await expect(balPage.getByTestId("play-submit-error")).toHaveCount(0);
  });

  await test.step("GMはこのTurnを進められる（無効値が保存されて詰まっていない）", async () => {
    await advanceOneTurn(page, 1);
  });

  await balPage.context().close();
});
