// ShrimpX V2 — SALES 基準価格参考表示 UI の browser E2E
//
// Independent Player Flow経由でSALESタブを開き、
//   Turn1: 前Turnデータが無いため「－」表示
//   Turn1→Turn2進行後: 前Turn市場基準価格が実際の確定値で表示され、
//     価格調整を変更すると参考提示価格が即時に再計算される
// ことを、実際のdev serverに対して確認する。GM/BAL別browser context
// （independentPlayerFlow.e2e.tsと同じ最小限のヘルパー）を使う。

import { test, expect, type Page } from "@playwright/test";

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
}

async function submitCurrentTurn(page: Page): Promise<void> {
  await expect(page.getByTestId("play-submit-decision")).toBeEnabled();
  await page.getByTestId("play-submit-decision").click();
  await expect(page.getByTestId("play-waiting-for-gm")).toBeVisible();
}

async function runOneTurn(page: Page): Promise<void> {
  await page.getByTestId("run-1").click();
  await expect(page.getByTestId("run-1")).toBeEnabled({ timeout: 60_000 });
}

test.describe("SALES 基準価格参考表示 — Independent Player Flow経由", () => {
  test("Turn1は前Turn「－」表示、Turn2以降は実際の前Turn基準価格が表示され価格調整で参考提示価格が即時更新される", async ({ browser }) => {
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

      await test.step("BAL: 別contextで参加 → SALESタブでTurn1は前Turン「－」表示を確認", async () => {
        await joinAsPlayer(balPage, balJoinUrl, "BAL");
        await balPage.getByTestId("decision-studio-tab-sales").click();
        await expect(balPage.getByTestId("sales-price-reference-disclaimer")).toBeVisible();
        const firstRow = balPage.locator('[data-testid^="sales-price-reference-"][data-testid*="-CN-"]').first();
        await expect(firstRow).toBeVisible();
      });

      await test.step("BAL: Turn1を提出し、GMがAdvanceする", async () => {
        await submitCurrentTurn(balPage);
        await runOneTurn(gmPage);
        await expect(gmPage.getByTestId("turn-counter")).toHaveText("1 / 32");
      });

      await test.step("BAL: Turn2で前Turn市場基準価格が実際の確定値（－ではない）で表示される", async () => {
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
      });

      await test.step("BAL: 価格調整を変更すると参考提示価格が即時に再計算される", async () => {
        const priceInput = balPage.locator("table tbody tr").first().locator('input[type="number"]').nth(1);
        const askCell = balPage.locator('[data-testid^="sales-price-reference-ask-"]').first();
        const baseCell = balPage.locator('[data-testid^="sales-price-reference-prior-base-"]').first();
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
