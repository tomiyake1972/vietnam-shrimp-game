// ShrimpX V2 — SALES 基準価格参考表示 UI の browser E2E
//
// Independent Player Flow経由でSALESタブを開き、
//   Turn1: 前Turnデータが無いため「－」表示
//   Turn1→Turn2進行後: 前Turn市場基準価格が実際の確定値で表示され、
//     価格調整を変更すると参考提示価格が即時に再計算される
// ことを、実際のdev serverに対して確認する。GM/BAL別browser context
// （independentPlayerFlow.e2e.tsと同じ最小限のヘルパー）を使う。

import { test, expect, type Page } from "@playwright/test";
import { dismissPlayerIntroIfPresent, submitIndependentPlayerDecision } from "./_lib/decisionFlow";

const STAGING_ADMIN_TOKEN = "e2e-test-token";

async function loginAsGm(page: Page): Promise<void> {
  const returnTo = encodeURIComponent("/v2/management/setup");
  await page.goto(`/v2/company-lab/play/login?returnTo=${returnTo}`);
  await page.getByLabel("管理トークン").fill(STAGING_ADMIN_TOKEN);
  await page.getByRole("button", { name: "ログイン" }).click();
  await page.waitForURL(/\/v2\/management\/setup/);
}

async function createRunWithBalAsPlayer(page: Page): Promise<void> {
  await page.goto("/v2/management/setup");
  await page.getByTestId("setup-control-mode-BAL").selectOption("PLAYER");
  await page.getByTestId("setup-start-button").click();
  await page.waitForURL(/\/v2\/management\?run=/);
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
  // 【PLAYER-INTRO-1】初回は導入が全画面で出るため、以降の操作の前に閉じる。
  await dismissPlayerIntroIfPresent(page);
}

async function submitCurrentTurn(page: Page): Promise<void> {
  await expect(page.getByTestId("play-review-decision")).toBeEnabled();
  await submitIndependentPlayerDecision(page);
  await expect(page.getByTestId("play-waiting-for-gm")).toBeVisible();
}

async function runOneTurn(page: Page): Promise<void> {
  await page.getByTestId("run-1").click();
  await expect(page.getByTestId("run-1")).toBeEnabled({ timeout: 60_000 });
}

test.describe("SALES 基準価格参考表示 — Independent Player Flow経由", () => {
  test("Turn1は開始時点の市場基準（目安）、Turn2以降は実際の前Turn基準価格が表示され価格調整で参考提示価格が即時更新される", async ({ browser }) => {
    const gmContext = await browser.newContext();
    const balContext = await browser.newContext();
    const gmPage = await gmContext.newPage();
    const balPage = await balContext.newPage();

    try {
      await test.step("GM: ログイン → BALをPLAYERにしてRunを作成 → 参加リンク発行", async () => {
        await loginAsGm(gmPage);
        await createRunWithBalAsPlayer(gmPage);
      });

      let balJoinUrl = "";
      await test.step("GM: BALへ参加リンクを発行", async () => {
        balJoinUrl = await issueJoinUrl(gmPage, "BAL");
      });

      await test.step("BAL: 別contextで参加 → SALESタブでTurn1は「開始時点の市場基準（目安）」が全15セルに表示されることを確認", async () => {
        /**
         * 【UI-CLARITY-1 A-8】以前はTurn1に前四半期が無いため、この15セルすべてが
         * 「－」だった。基準価格が見えないまま調整額だけを入れる状態だったので、
         * ゲーム開始時点の既知市場情報（market/gameStartReferencePrice.ts）を
         * 表示するようにした。ここではその値が実際に出ていることを確認する。
         */
        await joinAsPlayer(balPage, balJoinUrl, "BAL");
        await balPage.getByTestId("decision-studio-tab-sales").click();
        await expect(balPage.getByTestId("sales-price-reference-disclaimer")).toBeVisible();
        await expect(balPage.getByTestId("sales-price-reference-game-start-note")).toBeVisible();
        const priorBaseCells = balPage.locator('[data-testid^="sales-price-reference-prior-base-"]');
        const askCells = balPage.locator('[data-testid^="sales-price-reference-ask-"]');
        const rowCount = await priorBaseCells.count();
        expect(rowCount).toBe(15);
        for (let i = 0; i < rowCount; i++) {
          await expect(priorBaseCells.nth(i)).toHaveText(/^\$\d+\.\d{2}$/);
          await expect(askCells.nth(i)).toHaveText(/^\$\d+\.\d{2}\/kg$/);
        }
        // 出どころがゲーム開始時点の既知市場情報であることを、セルの属性でも確認する。
        const gameStartCells = balPage.locator('[data-base-price-source="GAME_START_MARKET_INFORMATION"]');
        expect(await gameStartCells.count()).toBe(15);
        await balPage.getByTestId("sales-plan-market-blocks").screenshot({
          path: "docs/int1/attachments/uiClarity1/a8-turn1-base-price.png",
        });
      });

      await test.step("BAL: 入力欄の誤操作防止 — 負値はその場で知らせ、ホイールでは値が変わらない", async () => {
        /**
         * 【UI-CLARITY-2 B-1】実機のプレイテストで見つかった2件。
         *   (1) 販売希望量に -100 を入れても画面上は何も言われない
         *       （提出前検証では止まるが、入力の時点では分からなかった）
         *   (2) 入力欄にカーソルが載ったままページをスクロールすると値が動く
         *       （価格調整が 0 → 0.01 に変わる）
         */
        const quantity = balPage.getByTestId("sales-plan-desired-quantity-CN-hoso");
        await quantity.fill("-100");
        await expect(balPage.getByTestId("sales-plan-desired-quantity-CN-hoso-notice")).toHaveText("0以上で入力してください。");
        await expect(quantity).toHaveAttribute("data-out-of-range", "true");
        await quantity.fill("1000");
        await expect(balPage.getByTestId("sales-plan-desired-quantity-CN-hoso-notice")).toHaveCount(0);

        const priceAdjustment = balPage.getByTestId("sales-plan-price-adjustment-CN-hoso");
        await priceAdjustment.fill("0");
        await priceAdjustment.focus();
        await priceAdjustment.hover();
        await balPage.mouse.wheel(0, 200);
        await balPage.mouse.wheel(0, -200);
        await expect(priceAdjustment).toHaveValue("0");
      });

      await test.step("BAL: Turn1を提出し、GMがAdvanceする", async () => {
        await submitCurrentTurn(balPage);
        await runOneTurn(gmPage);
        await expect(gmPage.getByTestId("turn-counter")).toHaveText("1 / 32");
      });

      await test.step("BAL: Turn2では出どころが前Turnの確定結果へ切り替わる", async () => {
        await expect(balPage.getByText(/Turn 2 \//)).toBeVisible({ timeout: 15_000 });
        await balPage.getByTestId("decision-studio-tab-sales").click();
        const priorBaseCells = balPage.locator('[data-testid^="sales-price-reference-prior-base-"]');
        const count = await priorBaseCells.count();
        expect(count).toBeGreaterThan(0);
        let sawRealPrice = false;
        for (let i = 0; i < count; i++) {
          const text = (await priorBaseCells.nth(i).textContent())?.trim() ?? "";
          if (text !== "－" && text.startsWith("$")) {
            sawRealPrice = true;
            break;
          }
        }
        expect(sawRealPrice).toBe(true);
        // 【UI-CLARITY-1 A-8】Turn2以降は開始時点の目安ではなく前Turnの確定結果を使う。
        await expect(balPage.getByTestId("sales-price-reference-game-start-note")).toHaveCount(0);
        expect(await balPage.locator('[data-base-price-source="LAST_QUARTER_MARKET_RESULT"]').count()).toBeGreaterThan(0);
      });

      await test.step("BAL: 価格調整を変更すると参考提示価格が即時に再計算される", async () => {
        /**
         * 【UI-TRIAL-1】位置指定（最初のtable → 最初の行 → n番目のinput）をやめ、
         * 市場×商品で一意な testid で取得する。営業配員を市場ごとに1つへまとめた
         * 組み替えで行の中身が変わっても、この取得方法なら壊れない
         * （以前も受注残パネルの追加で位置指定が壊れている）。
         */
        const priceInput = balPage.getByTestId("sales-plan-price-adjustment-CN-hoso");
        const askCell = balPage.getByTestId("sales-price-reference-ask-CN-hoso");
        const baseCell = balPage.getByTestId("sales-price-reference-prior-base-CN-hoso");
        const baseText = (await baseCell.textContent())?.trim() ?? "";
        if (baseText !== "－") {
          const baseValue = Number(baseText.replace("$", ""));
          await priceInput.fill("-0.30");
          await priceInput.blur();
          await expect(askCell).toHaveText(`$${(baseValue - 0.3).toFixed(2)}/kg`);
        }
      });
    } finally {
      await gmContext.close();
      await balContext.close();
    }
  });
});
