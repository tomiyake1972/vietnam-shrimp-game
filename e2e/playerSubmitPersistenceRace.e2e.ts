// ShrimpX V2 — O1: PLAYER提出がGM保存に消されないこと（browser E2E）
//
// 【D1で入れていたrace回避を外す】D1-22のE2Eは「GMのAdvanceボタンが再enableになるまで待つ」
// ことで競合を避けていた。それは製品の修正ではなくテスト側の回避である。
// ここでは待たない。GMが次Turnを公開したことをPlayer側が検知した直後、可能な限り早く提出し、
// その提出が消えないことを見る。
//
// 【sleep頼みにしない】待ち合わせはすべて「画面の状態が変わったこと」を条件にする
// （Playerのstatusが TURN_ACTIVE になる / turn counterが変わる）。固定時間のsleepは使わない。
//
// 共有Redisは使わない（V2_API_E2E_IN_MEMORY=1 の隔離環境）。

import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

const STAGING_ADMIN_TOKEN = "e2e-test-token";

async function loginAsGm(page: Page): Promise<void> {
  // 【loginAsGmを重ねて呼ばないこと】管理ログインrouteは認証済みなら returnTo へ自動で戻す。
  const returnTo = encodeURIComponent("/v2/management/setup");
  await page.goto(`/v2/company-lab/play/login?returnTo=${returnTo}`);
  await page.getByLabel("管理トークン").fill(STAGING_ADMIN_TOKEN);
  await page.getByRole("button", { name: "ログイン" }).click();
  await page.waitForURL(/\/v2\/management\/setup/);
}

async function createRun(page: Page, playerCompanies: readonly string[]): Promise<string> {
  await page.goto("/v2/management/setup");
  for (const companyId of playerCompanies) {
    await page.getByTestId(`setup-control-mode-${companyId}`).selectOption("PLAYER");
  }
  await page.getByTestId("setup-start-button").click();
  await page.waitForURL(/\/v2\/management\?run=/);
  const runId = new URL(page.url()).searchParams.get("run");
  expect(runId).toBeTruthy();
  return runId!;
}

async function issueJoinUrl(page: Page, companyId: string): Promise<string> {
  await page.getByTestId(`player-seat-issue-${companyId}`).click();
  const code = page.getByTestId(`player-seat-join-url-${companyId}`).locator("code");
  await expect(code).toBeVisible();
  return (await code.textContent())!.trim();
}

async function joinAsPlayer(page: Page, joinUrl: string, companyId: string): Promise<void> {
  await page.goto(joinUrl);
  await page.waitForURL(/\/v2\/play\/workspace/);
  await expect(page.getByTestId("play-workspace-heading")).toContainText(companyId);
}

/** 「提出できる状態になった瞬間」に提出する。固定sleepを挟まない。 */
async function submitAsSoonAsPossible(page: Page): Promise<void> {
  await expect(page.getByTestId("play-workspace-status")).toHaveAttribute("data-status", "TURN_ACTIVE", { timeout: 120_000 });
  await page.getByTestId("play-submit-decision").click();
  await expect(page.getByTestId("play-waiting-for-gm")).toBeVisible();
}

/** GMがTurnを1つ進める。ボタンの再enableは待たない（待つと競合窓を避けてしまう）。 */
async function gmAdvanceOneTurn(gmPage: Page, expectedTurn: number): Promise<void> {
  await expect(gmPage.getByTestId("run-1")).toBeEnabled({ timeout: 300_000 });
  await gmPage.getByTestId("run-1").click();
  await expect(gmPage.getByTestId("turn-counter")).toContainText(`${expectedTurn} /`, { timeout: 300_000 });
}

// =====================================================================
// A. Independent Player race（D1で入れていた待機を外す）
// =====================================================================

test("O1-E2E-A: GMがTurnを公開した直後にPlayerが提出しても、その提出が消えずGMが次Turnで使える", async ({ browser }: { browser: Browser }) => {
  test.setTimeout(900_000);
  let gmContext: BrowserContext | null = null;
  let playerContext: BrowserContext | null = null;
  try {
    gmContext = await browser.newContext();
    playerContext = await browser.newContext();
    const gmPage = await gmContext.newPage();
    const playerPage = await playerContext.newPage();

    await loginAsGm(gmPage);
    const runId = await createRun(gmPage, ["BAL"]);
    const joinUrl = await issueJoinUrl(gmPage, "BAL");
    await joinAsPlayer(playerPage, joinUrl, "BAL");

    for (let turn = 1; turn <= 3; turn += 1) {
      await submitAsSoonAsPossible(playerPage);
      // 【ここが要点】GMの保存完了（Advanceボタン再enable）を待たずにTurnを進め、
      // 次の周回でPlayerがすぐ提出する。以前はこの窓でGMのstale保存が提出を消していた。
      await gmAdvanceOneTurn(gmPage, turn);
      if (turn < 3) await playerPage.reload();
    }

    // 3Turn進めきれたこと自体が「提出が消えていない」ことの証明
    // （消えていればGMは未提出と判断してTurnを進められない）。
    await expect(gmPage.getByTestId("turn-counter")).toContainText("3 /");

    /**
     * 保存された正本から見ても、提出待ちで止まっていないこと。
     *
     * 【ここだけは保存完了を待つ】上のループでは競合窓を作るためにあえて保存完了を
     * 待っていないが、この確認は「hard reload後もサーバーの正本に残っているか」という
     * 耐久性の確認なので、保存が終わる前にreloadしては意味が違う
     * （実測で、保存完了前にreloadするとcounterが 2 のままになることがあった）。
     * Advanceボタンが再びenabledになることが、Console側の保存完了の合図である。
     */
    await expect(gmPage.getByTestId("run-1")).toBeEnabled({ timeout: 300_000 });
    await gmPage.reload();
    await expect(gmPage.getByTestId("run-id")).toHaveText(runId, { timeout: 120_000 });
    await expect(gmPage.getByTestId("turn-counter")).toContainText("3 /", { timeout: 120_000 });
  } finally {
    await gmContext?.close();
    await playerContext?.close();
  }
});

// =====================================================================
// B. 2 Independent Players
// =====================================================================

test("O1-E2E-B: BALとMASSが同じTurnへほぼ同時に提出しても、両方が残りGMが進められる", async ({ browser }: { browser: Browser }) => {
  test.setTimeout(900_000);
  let gmContext: BrowserContext | null = null;
  let balContext: BrowserContext | null = null;
  let massContext: BrowserContext | null = null;
  try {
    gmContext = await browser.newContext();
    balContext = await browser.newContext();
    massContext = await browser.newContext();
    const gmPage = await gmContext.newPage();
    const balPage = await balContext.newPage();
    const massPage = await massContext.newPage();

    await loginAsGm(gmPage);
    await createRun(gmPage, ["BAL", "MASS"]);
    const balJoin = await issueJoinUrl(gmPage, "BAL");
    const massJoin = await issueJoinUrl(gmPage, "MASS");
    await joinAsPlayer(balPage, balJoin, "BAL");
    await joinAsPlayer(massPage, massJoin, "MASS");

    // 2社が同じTurnへ同時に提出する（クリックを並行に発火させる）。
    await expect(balPage.getByTestId("play-workspace-status")).toHaveAttribute("data-status", "TURN_ACTIVE", { timeout: 120_000 });
    await expect(massPage.getByTestId("play-workspace-status")).toHaveAttribute("data-status", "TURN_ACTIVE", { timeout: 120_000 });
    await Promise.all([balPage.getByTestId("play-submit-decision").click(), massPage.getByTestId("play-submit-decision").click()]);
    await expect(balPage.getByTestId("play-waiting-for-gm")).toBeVisible();
    await expect(massPage.getByTestId("play-waiting-for-gm")).toBeVisible();

    // 【両方残っていることの確認】どちらかが消えていればAdvanceは提出待ちで止まる。
    await gmAdvanceOneTurn(gmPage, 1);
    await expect(gmPage.getByTestId("turn-counter")).toContainText("1 /");

    // 2周目も同じ条件で成立すること。
    await balPage.reload();
    await massPage.reload();
    await expect(balPage.getByTestId("play-workspace-status")).toHaveAttribute("data-status", "TURN_ACTIVE", { timeout: 120_000 });
    await expect(massPage.getByTestId("play-workspace-status")).toHaveAttribute("data-status", "TURN_ACTIVE", { timeout: 120_000 });
    await Promise.all([balPage.getByTestId("play-submit-decision").click(), massPage.getByTestId("play-submit-decision").click()]);
    await expect(balPage.getByTestId("play-waiting-for-gm")).toBeVisible();
    await expect(massPage.getByTestId("play-waiting-for-gm")).toBeVisible();
    await gmAdvanceOneTurn(gmPage, 2);
  } finally {
    await gmContext?.close();
    await balContext?.close();
    await massContext?.close();
  }
});

// =====================================================================
// C. Console PLAYER + Independent Player（O1-09）
// =====================================================================

test("O1-E2E-C: Console内PLAYERの確定とIndependent Playerの提出が、互いを消さない", async ({ browser }: { browser: Browser }) => {
  test.setTimeout(900_000);
  let gmContext: BrowserContext | null = null;
  let massContext: BrowserContext | null = null;
  try {
    gmContext = await browser.newContext();
    massContext = await browser.newContext();
    const gmPage = await gmContext.newPage();
    const massPage = await massContext.newPage();

    await loginAsGm(gmPage);
    // BAL = Management Console内PLAYER（GM代理操作）、MASS = Independent Player。
    await createRun(gmPage, ["BAL", "MASS"]);
    const massJoin = await issueJoinUrl(gmPage, "MASS");
    await joinAsPlayer(massPage, massJoin, "MASS");

    // 先にIndependent Player（MASS）が提出する。
    await submitAsSoonAsPossible(massPage);

    // そのあとConsole内PLAYER（BAL）を確定する。
    // 【修正前の構造】BALの保存はタブ内キャッシュ由来の confirmedPlayerDecisions を
    // そのまま全体上書きしていたため、MASSの提出を消し得た。
    await gmPage.getByTestId("company-control-operate-BAL").click();
    await expect(gmPage.getByTestId("workspace-heading")).toBeVisible({ timeout: 120_000 });
    await gmPage.getByTestId("workspace-tab-decision").click();
    await gmPage.getByTestId("workspace-confirm-decision").click();
    // 保存の成否を待ってから確定表示になる（O1 §10）。エラー表示が出ていないこと。
    await expect(gmPage.getByTestId("workspace-decision-status")).toContainText("意思決定済み", { timeout: 120_000 });
    await expect(gmPage.getByTestId("workspace-confirm-error")).toHaveCount(0);

    // 両方残っていればTurnを進められる（片方でも消えていれば提出待ちで止まる）。
    await gmPage.getByTestId("workspace-back-to-console").click();
    await gmAdvanceOneTurn(gmPage, 1);
    await expect(gmPage.getByTestId("turn-counter")).toContainText("1 /");

    // 逆順（Console内PLAYERが先、Independent Playerが後）でも成立すること。
    await gmPage.getByTestId("company-control-operate-BAL").click();
    await expect(gmPage.getByTestId("workspace-heading")).toBeVisible({ timeout: 120_000 });
    await gmPage.getByTestId("workspace-tab-decision").click();
    await gmPage.getByTestId("workspace-confirm-decision").click();
    await expect(gmPage.getByTestId("workspace-decision-status")).toContainText("意思決定済み", { timeout: 120_000 });
    await gmPage.getByTestId("workspace-back-to-console").click();

    await massPage.reload();
    await submitAsSoonAsPossible(massPage);
    await gmAdvanceOneTurn(gmPage, 2);
    await expect(gmPage.getByTestId("turn-counter")).toContainText("2 /");
  } finally {
    await gmContext?.close();
    await massContext?.close();
  }
});
