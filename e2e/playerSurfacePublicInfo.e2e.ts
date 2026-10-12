// ShrimpX V2 — 受講者画面（/v2/play/workspace）の実機確認
// PLAYER-SURFACE-1 / PUBLIC-COMPETITOR-1〜3
//
// 【このE2Eが要る理由】Overview / Market / Inventory の3タブと公開競合情報は
// 単体テストで値の正しさを固定しているが、「実際のブラウザで出るか」「レイアウトが
// 崩れていないか」は一度も見ていなかった。join リンク経由の実セッションで
// 3タブを開き、要素の存在とスクリーンショットを取る。
//
// 【共有Redisを使わない】playwright.config.ts が V2_API_E2E_IN_MEMORY=1 を
// 渡すため、dev server は in-memory repository で動く（停止中の共有DBへは
// 一切アクセスしない）。
//
// 【Turn 2 まで進める理由】公開競合情報は「前四半期の結果」を出す。Turn 1 は
// 開始時点の受注残からの勢力図、Turn 2 以降が実績ベースになるため、
// 両方の状態を実機で確認する。

import path from "node:path";
import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { submitIndependentPlayerDecision } from "./_lib/decisionFlow";

const STAGING_ADMIN_TOKEN = "e2e-test-token";
const SHOT_DIR = path.resolve(__dirname, "../docs/int1/screenshots");

async function loginAsGm(page: Page): Promise<void> {
  const returnTo = encodeURIComponent("/v2/management/setup");
  await page.goto(`/v2/company-lab/play/login?returnTo=${returnTo}`);
  await page.getByLabel("管理トークン").fill(STAGING_ADMIN_TOKEN);
  await page.getByRole("button", { name: "ログイン" }).click();
  await page.waitForURL(/\/v2\/management\/setup/);
}

async function createRunWithPlayer(page: Page): Promise<string> {
  await page.goto("/v2/management/setup");
  await page.getByTestId("setup-control-mode-BAL").selectOption("PLAYER");
  await page.getByTestId("setup-start-button").click();
  await page.waitForURL(/\/v2\/management\?run=/);
  const runId = new URL(page.url()).searchParams.get("run");
  if (!runId) throw new Error("Run作成後のURLにrunIdが無い");
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

/** タブを開いてスクリーンショットを撮る。 */
async function openTab(page: Page, tab: "overview" | "market" | "inventory" | "decision"): Promise<void> {
  await page.getByTestId(`play-workspace-tab-${tab}`).click();
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), fullPage: true });
}

test.describe("受講者画面 — 3タブと公開競合情報", () => {
  let gmContext: BrowserContext;
  let playerContext: BrowserContext;
  let gmPage: Page;
  let playerPage: Page;

  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    gmContext = await browser.newContext({ ignoreHTTPSErrors: true });
    playerContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
    gmPage = await gmContext.newPage();
    playerPage = await playerContext.newPage();
  });

  test.afterAll(async () => {
    await gmContext.close();
    await playerContext.close();
  });

  test("PSE-1: Turn 1 — 3タブが表示され、公開競合情報は開始時点の勢力図として出る", async () => {
    await loginAsGm(gmPage);
    await createRunWithPlayer(gmPage);
    const joinUrl = await issueJoinUrl(gmPage, "BAL");

    await playerPage.goto(joinUrl);
    await playerPage.waitForURL(/\/v2\/play\/workspace/);
    await expect(playerPage.getByTestId("play-workspace-heading")).toContainText("BAL");

    // タブが4つ出ていること。
    await expect(playerPage.getByTestId("play-workspace-tabs")).toBeVisible();
    for (const tab of ["overview", "market", "inventory", "decision"] as const) {
      await expect(playerPage.getByTestId(`play-workspace-tab-${tab}`)).toBeVisible();
    }

    // Overview: まだ確定四半期が無いので空状態の案内が出る。
    await openTab(playerPage, "overview");
    await expect(playerPage.getByTestId("play-overview-empty")).toBeVisible();
    await shoot(playerPage, "turn1-overview");

    // Market: 基準価格15マス（A-8の開始時市場情報）と、開始時点の勢力図。
    await openTab(playerPage, "market");
    await expect(playerPage.getByTestId("play-market-table")).toBeVisible();
    await expect(playerPage.getByTestId("play-competitor")).toBeVisible();
    await expect(playerPage.getByTestId("play-competitor-source")).toContainText("ゲーム開始時点の勢力図");
    await expect(playerPage.getByTestId("play-competitor-salesforce")).toBeVisible();
    await expect(playerPage.getByTestId("play-investments")).toBeVisible();
    await shoot(playerPage, "turn1-market");

    // Inventory: まだ実績が無いので空状態。
    await openTab(playerPage, "inventory");
    await expect(playerPage.getByTestId("play-inventory-empty")).toBeVisible();
    await shoot(playerPage, "turn1-inventory");

    // Decision: 既存の意思決定画面がそのまま出る（3タブ追加で壊れていない）。
    await openTab(playerPage, "decision");
    await expect(playerPage.getByTestId("play-review-decision")).toBeVisible();
  });

  test("PSE-2: Turn 2 — 前Turnの実績にもとづく競合情報とふりかえりが出る", async () => {
    // Turn 1 を提出 → GM がターンを進める。
    await openTab(playerPage, "decision");
    await submitIndependentPlayerDecision(playerPage);
    await expect(playerPage.getByTestId("play-waiting-for-gm")).toBeVisible();

    await gmPage.getByTestId("run-1").click();
    await expect(gmPage.getByTestId("run-1")).toBeEnabled({ timeout: 60_000 });

    await playerPage.reload();
    await expect(playerPage.getByTestId("play-workspace-status")).toHaveAttribute("data-status", "TURN_ACTIVE", {
      timeout: 30_000,
    });

    // Overview: 前Turnのふりかえりが出る。
    await openTab(playerPage, "overview");
    await expect(playerPage.getByTestId("play-overview")).toBeVisible();
    await shoot(playerPage, "turn2-overview");

    // Market: 出所が「Turn 1 の結果」に切り替わる。
    await openTab(playerPage, "market");
    await expect(playerPage.getByTestId("play-competitor-source")).toContainText("Turn 1 の結果");
    await expect(playerPage.getByTestId("play-competitor-grid")).toBeVisible();
    await shoot(playerPage, "turn2-market");

    // 【実機確認で見つけた不具合の回帰】既定の販売モデルには crowding が無く、
    // 以前は全15マスに「混雑度 取得不能」が並んで本来の情報が埋もれていた。
    const gridText = (await playerPage.getByTestId("play-competitor-grid").innerText()) ?? "";
    expect(gridText.includes("取得不能"), "混雑度が1つも無いのにマスへラベルが出ている").toBe(false);

    // ヘッダの状態バッジが、環境バナーに隠れず実際に読めること
    // （どちらも sticky top-0 のため、重なっていないかを viewport で確認する）。
    await playerPage.evaluate(() => window.scrollTo(0, 0));
    await playerPage.screenshot({ path: path.join(SHOT_DIR, "turn2-header-viewport.png") });
    const badge = playerPage.getByTestId("play-workspace-status");
    await expect(badge).toBeVisible();
    const box = await badge.boundingBox();
    expect(box, "状態バッジの位置が取得できない").not.toBeNull();
    const bannerBottom = await playerPage.evaluate(() => {
      const banner = document.querySelector(".bg-amber-500");
      return banner ? banner.getBoundingClientRect().bottom : 0;
    });
    expect(
      box!.y,
      `状態バッジ（上端 ${box!.y}）が環境バナー（下端 ${bannerBottom}）に隠れている`
    ).toBeGreaterThanOrEqual(bannerBottom - 1);

    // Inventory: 実績が入る。
    await openTab(playerPage, "inventory");
    await expect(playerPage.getByTestId("play-inventory")).toBeVisible();
    await shoot(playerPage, "turn2-inventory");
  });

  test("PSE-3【レイアウト】: 横スクロールが発生せず、自社の行だけ正確な % が出る", async () => {
    await openTab(playerPage, "market");

    // 自社（BAL）のシェアだけ % 表記があること。
    const grid = playerPage.getByTestId("play-competitor-grid");
    await expect(grid).toBeVisible();
    const gridText = (await grid.innerText()) ?? "";
    const percentMatches = gridText.match(/\d+\.\d%/g) ?? [];
    expect(percentMatches.length, `% 表記が1つも無い（自社の正確なシェアが出ていない）`).toBeGreaterThan(0);

    // ページ全体が横に溢れていないこと（1280px幅で確認）。
    const overflow = await playerPage.evaluate(() => {
      const el = document.documentElement;
      return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
    });
    expect(
      overflow.scrollWidth - overflow.clientWidth,
      `ページ全体が横に溢れている: scrollWidth=${overflow.scrollWidth} clientWidth=${overflow.clientWidth}`
    ).toBeLessThanOrEqual(1);
  });

  test("PSE-5: 序盤は TSV ランキングを出さず、理由を出す", async () => {
    await openTab(playerPage, "market");
    await expect(playerPage.getByTestId("play-tsv-hidden")).toBeVisible();
    await expect(playerPage.getByTestId("play-tsv-hidden")).toContainText("Turn 12");
    await expect(playerPage.getByTestId("play-tsv-table")).toHaveCount(0);
  });

  test("PSE-6: PROCUREMENT の不足量は「確定不足量」と言い切らない表現になっている", async () => {
    await openTab(playerPage, "decision");
    await playerPage.getByTestId("decision-studio-tab-procurement").click();
    const balance = playerPage.getByTestId("pl-confirmed-balance");
    await expect(balance).toBeVisible();
    const text = (await balance.innerText()) ?? "";
    expect(text.includes("確定不足量"), "不足そのものが確定していると読める表現が残っている").toBe(false);
    expect(/保守的に見た(不足量|余剰量)/.test(text), `期待した表現が無い: ${text}`).toBe(true);
    await shoot(playerPage, "procurement-shortage-label");
  });

  test("PSE-4【情報境界】: 受講者画面に Analysis リンク・会社切替が無い", async () => {
    const html = await playerPage.content();
    expect(html.includes("/v2/management/analysis"), "受講者画面に Analysis へのリンクがある").toBe(false);

    // 他社の Workspace へ移るためのセレクタが無いこと。
    const selects = await playerPage.locator("select").count();
    const companySwitchers = await playerPage.getByTestId(/company-select|run-select/).count();
    expect(companySwitchers, `会社・Run の切替UIがある（select総数 ${selects}）`).toBe(0);
  });
});
