// ShrimpX V2 — Independent Player Flow: 3 browser context（GM / BAL Player / MASS Player）E2E
//
// 指示の必須シナリオをそのまま自動化する:
//  GM Run作成 → BAL/MASSへ参加リンク発行 → BALが別contextでjoin → BALが提出
//  → GMはAdvance不可（MASS未提出） → MASSがjoin・提出 → GMがAdvance可能 → Turn進行
//  → 両Playerが自然に次Turnへ切り替わる → context close/reopen（同一Cookieでの復帰）
//  → Game End → Playerは Final Results のみ閲覧可 → 以後のSubmitはserver側で拒否
//
// 【liveSessionRegistryに依存しないことの検証】BAL/MASSはGM Consoleと完全に別の
// browser context（Cookie共有なし）であり、GM Consoleのタブ内キャッシュに触れる
// 手段が無い。それでも参加・復帰・提出が成立することが、この検証そのものになる。

import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

const STAGING_ADMIN_TOKEN = "e2e-test-token";

async function loginAsGm(page: Page): Promise<void> {
  // 【returnToで直接Setup画面へ】returnToを付けずにログインすると既定の遷移先
  // （Company Labの一覧画面）を経由するが、その画面はこのE2Eが必要としない別の
  // Redis依存を持ち、実credentials無しの検証環境では無関係なエラーで落ちる。
  // 【waitForURLの正規表現に注意】非anchorな正規表現（例: /\/v2\/company-lab\/play/）は
  // ログイン画面自身のURL（/v2/company-lab/play/login）にも部分一致してしまい、
  // 実際のリダイレクトを待たずに即座に解決してしまう（実機で確認済みの落とし穴）。
  // returnToで遷移先を確定させ、その確定したURLで待つことでこの罠を避ける。
  const returnTo = encodeURIComponent("/v2/management/setup");
  await page.goto(`/v2/company-lab/play/login?returnTo=${returnTo}`);
  await page.getByLabel("管理トークン").fill(STAGING_ADMIN_TOKEN);
  await page.getByRole("button", { name: "ログイン" }).click();
  await page.waitForURL(/\/v2\/management\/setup/);
}

async function createRunWithTwoPlayerCompanies(page: Page): Promise<string> {
  await page.goto("/v2/management/setup");
  await page.getByTestId("setup-control-mode-BAL").selectOption("PLAYER");
  await page.getByTestId("setup-control-mode-MASS").selectOption("PLAYER");
  await page.getByTestId("setup-start-button").click();
  await page.waitForURL(/\/v2\/management\?run=/);
  const url = new URL(page.url());
  const runId = url.searchParams.get("run");
  if (!runId) throw new Error("Run作成後のURLにrunIdが無い");
  await expect(page.getByTestId("run-id")).toHaveText(runId);
  return runId;
}

async function issueJoinUrl(page: Page, companyId: string): Promise<string> {
  await page.getByTestId(`player-seat-issue-${companyId}`).click();
  const codeLocator = page.getByTestId(`player-seat-join-url-${companyId}`).locator("code");
  await expect(codeLocator).toBeVisible();
  const joinUrl = await codeLocator.textContent();
  if (!joinUrl) throw new Error(`${companyId}の参加リンクが取得できない`);
  return joinUrl.trim();
}

async function joinAsPlayer(page: Page, joinUrl: string, companyId: string): Promise<void> {
  await page.goto(joinUrl);
  await page.waitForURL(/\/v2\/play\/workspace/);
  await expect(page.getByTestId("play-workspace-heading")).toContainText(companyId);
}

async function submitCurrentTurn(page: Page): Promise<void> {
  await expect(page.getByTestId("play-workspace-status")).toHaveAttribute("data-status", "TURN_ACTIVE");
  await page.getByTestId("play-submit-decision").click();
  await expect(page.getByTestId("play-waiting-for-gm")).toBeVisible();
  // 提出直後はjustSubmitted=trueのためSUBMITTED表示。ページを再訪問/再読み込みした後は
  // WAITING_FOR_GM表示に切り替わる（PlayerWorkspacePage側のstatus導出ロジック通り）。
  await expect(page.getByTestId("play-workspace-status")).toHaveAttribute("data-status", "SUBMITTED");
}

async function runOneTurn(page: Page): Promise<void> {
  await page.getByTestId("run-1").click();
  await expect(page.getByTestId("run-1")).toBeEnabled({ timeout: 60_000 });
}

test.describe("Independent Player Flow — GM / BAL / MASS", () => {
  let gmContext: BrowserContext;
  let balContext: BrowserContext;
  let massContext: BrowserContext;
  let gmPage: Page;
  let balPage: Page;
  let massPage: Page;

  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    // 【非cookie共有】3つとも別々のbrowser context（別端末・別browser相当）。
    gmContext = await browser.newContext();
    balContext = await browser.newContext();
    massContext = await browser.newContext();
    gmPage = await gmContext.newPage();
    balPage = await balContext.newPage();
    massPage = await massContext.newPage();
  });

  test.afterAll(async () => {
    await gmContext.close();
    await balContext.close();
    await massContext.close();
  });

  test("GM Run作成 → BAL/MASS参加 → 提出・Advance gating → Turn進行 → セッション復帰 → Game End → Final Results → 以後Submit拒否", async () => {
    await test.step("GM: ログイン → BAL/MASSをPLAYERにしてRunを作成", async () => {
      await loginAsGm(gmPage);
      const runId = await createRunWithTwoPlayerCompanies(gmPage);
      expect(runId).toBeTruthy();
      await expect(gmPage.getByTestId("turn-counter")).toHaveText("0 / 32");
    });

    let balJoinUrl = "";
    let massJoinUrl = "";
    await test.step("GM: BAL/MASSへ参加リンクを発行", async () => {
      balJoinUrl = await issueJoinUrl(gmPage, "BAL");
      massJoinUrl = await issueJoinUrl(gmPage, "MASS");
      expect(balJoinUrl).not.toEqual(massJoinUrl);
    });

    await test.step("BAL: 別contextで参加 → Turn1を提出", async () => {
      await joinAsPlayer(balPage, balJoinUrl, "BAL");
      await submitCurrentTurn(balPage);
    });

    await test.step("GM: MASSが未提出のためAdvanceが成立しない（server-side gate）", async () => {
      await runOneTurn(gmPage);
      // gateがserver側で拒否するため、completedTurnsは0のまま進まない。
      await expect(gmPage.getByTestId("turn-counter")).toHaveText("0 / 32");
      await expect(gmPage.getByTestId("player-seat-advance-eligibility")).toContainText("提出待ち");
    });

    await test.step("MASS: 別contextで参加 → Turn1を提出", async () => {
      await joinAsPlayer(massPage, massJoinUrl, "MASS");
      await submitCurrentTurn(massPage);
    });

    await test.step("GM: 全PLAYER会社が提出済みになったのでAdvanceが成立する", async () => {
      await runOneTurn(gmPage);
      await expect(gmPage.getByTestId("turn-counter")).toHaveText("1 / 32");
    });

    await test.step("BAL/MASS: ポーリングで自然に次Turnへ切り替わる", async () => {
      await expect(balPage.getByText(/Turn 2 \//)).toBeVisible({ timeout: 15_000 });
      await expect(balPage.getByTestId("play-workspace-status")).toHaveAttribute("data-status", "TURN_ACTIVE", { timeout: 15_000 });
      await expect(massPage.getByText(/Turn 2 \//)).toBeVisible({ timeout: 15_000 });
      await expect(massPage.getByTestId("play-workspace-status")).toHaveAttribute("data-status", "TURN_ACTIVE", { timeout: 15_000 });
    });

    await test.step("BAL: contextを閉じて別contextで再度開いても、同じCookieでRun/Companyへ復帰する（liveSessionRegistryに依存しない）", async () => {
      const storageState = await balContext.storageState();
      const reopenedContext = await gmPage.context().browser()!.newContext({ storageState, ignoreHTTPSErrors: true });
      const reopenedPage = await reopenedContext.newPage();
      try {
        await reopenedPage.goto("/v2/play/workspace");
        await expect(reopenedPage.getByTestId("play-workspace-heading")).toContainText("BAL");
        await expect(reopenedPage.getByText(/Turn 2 \//)).toBeVisible();
      } finally {
        await reopenedContext.close();
      }
    });

    await test.step("BAL/MASS: Turn2も提出し、GMがもう1Turn進める", async () => {
      await submitCurrentTurn(balPage);
      await submitCurrentTurn(massPage);
      await runOneTurn(gmPage);
      await expect(gmPage.getByTestId("turn-counter")).toHaveText("2 / 32");
    });

    await test.step("GM: ゲームを終了する（Game End）", async () => {
      await gmPage.getByTestId("end-game").click();
      await gmPage.getByTestId("end-game-confirm").click();
      await expect(gmPage.getByTestId("end-game-confirm-dialog")).toBeHidden();
      await expect(gmPage.getByTestId("end-game")).toBeDisabled();
    });

    await test.step("BAL: ポーリングでFinal Resultsへ自動的に切り替わる（AI講評は無し・5社比較のみ）", async () => {
      await expect(balPage.getByTestId("play-workspace-status")).toHaveAttribute("data-status", "FINISHED", { timeout: 15_000 });
      await expect(balPage.getByTestId("play-final-results")).toBeVisible();
      await expect(balPage.getByTestId("play-final-results-own-rank")).toBeVisible();
    });

    await test.step("BAL: Game End後のSubmitはserver側でも拒否される（UIのボタン自体も既に無い）", async () => {
      await expect(balPage.getByTestId("play-submit-decision")).toHaveCount(0);
      const response = await balPage.request.post("/api/v2/play/submit", {
        data: { turn: 3, draft: {} },
      });
      expect(response.status()).toBeGreaterThanOrEqual(400);
      const body = (await response.json()) as { readonly error?: { readonly code?: string } };
      expect(["RUN_FINISHED", "NOT_RESUMABLE", "STALE_TURN"]).toContain(body.error?.code);
    });

    await test.step("MASS: GMのFull Run APIにはPlayer Cookieだけではアクセスできない（別APIサーフェス・別認証）", async () => {
      const response = await massPage.request.get("/api/v2/simulation-runs");
      expect(response.status()).toBe(403);
    });
  });
});
