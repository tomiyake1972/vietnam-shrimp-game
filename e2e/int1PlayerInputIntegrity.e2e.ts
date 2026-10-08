// ShrimpX V2 — INT-1 §6: 提出値の消失・無効な値の保存・古いTurn混在（browser E2E）
//
// 統合候補の上で、実際のdev serverに対して確認する。
//   INT1-E2E-1 無効な値を含む提出はserverが400(INVALID_DECISION)で拒否し、何も保存しない
//   INT1-E2E-2 拒否後も同じTurnへ正しい値で提出でき、GMがTurnを進められる
//   INT1-E2E-3 Console内PLAYER画面が、GMのTurn進行後に古いTurnを表示しない
//   INT1-E2E-4 確定した提出値が実際のTurn計算に使われている（提出した会社の実績が記録される）
//
// 共有Redisは使わない（V2_API_E2E_IN_MEMORY=1 の隔離環境）。

import { test, expect, type Browser, type Page } from "@playwright/test";

const STAGING_ADMIN_TOKEN = "e2e-test-token";

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

async function advanceOneTurn(gmPage: Page, expectedTurn: number): Promise<void> {
  const counter = gmPage.getByTestId("turn-counter");
  const runButton = gmPage.getByTestId("run-1");
  await expect(runButton).toBeEnabled({ timeout: 300_000 });
  await runButton.click();
  await expect(counter).toContainText(`${expectedTurn} /`, { timeout: 120_000 });
  await expect(runButton).toBeEnabled({ timeout: 300_000 });
}

/** 参加リンクを発行して、別browser contextのPLAYERを開く。 */
async function openIndependentPlayer(gmPage: Page, browser: Browser, companyId: string): Promise<Page> {
  const issue = gmPage.getByTestId(`player-seat-issue-${companyId}`);
  await expect(issue).toBeVisible({ timeout: 60_000 });
  await issue.click();
  // 【URLの取り出し方】data-testid要素には説明文も含まれるため、<code> の中身だけを取る
  // （independentPlayerFlow.e2e.ts の issueJoinUrl と同じ方法）。
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

test("INT1-E2E-1/2: 無効な値を含む提出はserverが拒否し保存せず、正しい値で提出し直せる", async ({ page, browser }) => {
  test.setTimeout(300_000);
  await loginAsGm(page);
  await createRunWithPlayerBal(page);
  const balPage = await openIndependentPlayer(page, browser, "BAL");

  await test.step("無効な値（負の生産数量）はHTTP 400 INVALID_DECISION で拒否される", async () => {
    const res = await balPage.request.post("/api/v2/play/submit", {
      data: {
        turn: 1,
        draft: {
          companyId: "BAL",
          salesPlans: [],
          domesticPurchase: { desiredQuantity: 0, priceAdjustmentUsdPerHosoEqKg: 0, procurementHeadcount: 0 },
          importOrders: [],
          aquacultureStockingPlans: [],
          productionPlans: [{ factoryId: "BAL-F1", product: "hoso", desiredQuantity: -9999, priority: 1 }],
          workerAssignments: [],
          financingRequest: {
            desiredAmountUsd: 0,
            desiredLoanType: "shortTerm",
            desiredTermQuarters: 4,
            desiredRepaymentMethod: "equalPrincipal",
            desiredPrepaymentUsd: 0,
            emergencyAcceptable: false,
          },
          capexDecision: { newProjectProposals: [], cancelRequests: [], resumeRequests: [] },
          salesForceHireCount: 0,
          salesForceLayoffCount: 0,
          vapProductDevelopmentSpendUsd: 0,
          dividendAmountUsd: 0,
        },
      },
    });
    expect(res.status()).toBe(400);
    const body = (await res.json()) as { readonly error?: { readonly code?: string; readonly message?: string } };
    expect(body.error?.code).toBe("INVALID_DECISION");
    expect(body.error?.message ?? "").toContain("保存していません");
  });

  await test.step("形が壊れた下書きも500ではなく400で拒否される", async () => {
    const res = await balPage.request.post("/api/v2/play/submit", { data: { turn: 1, draft: { companyId: "BAL" } } });
    expect(res.status()).toBe(400);
    const body = (await res.json()) as { readonly error?: { readonly code?: string } };
    expect(body.error?.code).toBe("INVALID_DECISION");
  });

  await test.step("拒否は保存されていないため、同じTurnへ正しい値で提出できる", async () => {
    await expect(balPage.getByTestId("play-workspace-status")).toHaveAttribute("data-status", "TURN_ACTIVE");
    await balPage.getByTestId("play-submit-decision").click();
    await expect(balPage.getByTestId("play-waiting-for-gm")).toBeVisible();
  });

  await test.step("GMはTurnを進められる（無効値が保存されて詰まっていない）", async () => {
    await advanceOneTurn(page, 1);
  });

  await balPage.context().close();
});

test("INT1-E2E-3/4: Console内PLAYER画面が古いTurnを表示せず、確定した提出値がTurn計算に使われる", async ({ page }) => {
  test.setTimeout(300_000);
  await loginAsGm(page);
  const runId = await createRunWithPlayerBal(page);

  // Turn1: Console内PLAYERとして確定する。
  await page.getByTestId("company-control-operate-BAL").click();
  await page.waitForURL(/\/v2\/management\/player/);
  await expect(page.getByTestId("workspace-turn")).toHaveAttribute("data-turn", "1");
  await page.getByTestId("workspace-tab-decision").click();
  await page.getByTestId("workspace-confirm-decision").click();
  // O1契約: サーバ保存が成立してから「意思決定済み」になる。
  await expect(page.getByTestId("workspace-decision-status")).toContainText("意思決定済み", { timeout: 120_000 });
  await expect(page.getByTestId("workspace-confirm-error")).toHaveCount(0);
  await page.getByTestId("workspace-back-to-console").click();
  await expect(page.getByTestId("run-id")).toHaveText(runId, { timeout: 120_000 });

  await advanceOneTurn(page, 1);

  await test.step("INT1-E2E-3: 進行後に開き直したPLAYER画面が古いTurn（1）を表示しない", async () => {
    await page.getByTestId("company-control-operate-BAL").click();
    await page.waitForURL(/\/v2\/management\/player/);
    await expect(page.getByTestId("workspace-turn")).toHaveAttribute("data-turn", "2", { timeout: 60_000 });
    // 前Turnの確定表示が残っていない（Turn2はまだ未確定）。
    await expect(page.getByTestId("workspace-decision-status")).not.toContainText("意思決定済み");
  });

  await test.step("INT1-E2E-4: 確定した提出値が実際のTurn計算に使われている（Turn1の実績が記録されている）", async () => {
    // Overviewタブに前四半期の実績（Sales/Backlog）が出る＝Turn1が計算され記録された。
    await page.getByTestId("workspace-tab-overview").click();
    await expect(page.getByTestId("workspace-sales-backlog")).toBeVisible({ timeout: 60_000 });
    await page.getByTestId("workspace-back-to-console").click();
    await expect(page.getByTestId("run-id")).toHaveText(runId, { timeout: 120_000 });
    // GM側のTurnカウンタも1completedのまま（提出待ちで止まっていない）。
    await expect(page.getByTestId("turn-counter")).toContainText("1 /");
  });
});
