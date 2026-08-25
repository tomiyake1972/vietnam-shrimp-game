// ShrimpX V2 — Player工場操作Phase 1: Independent Player Flow経由でのFactory Mothball/Reactivate E2E
//
// 実装指示§20の必須シナリオをそのまま自動化する:
//  GM Run作成（BAL=PLAYER） → BALへ参加リンク発行 → BALが別contextでjoin
//  → BALがINVESTMENTタブでFactory休止を選択 → confirmation確認 → Submit
//  → GM Advance → BAL次Turn → Factory能力0確認 → reload → state維持
//  → BALが次Turnで再稼働を選択 → Submit → GM Advance → next Turnで能力復帰
//
// 【売却(SELL_FACTORY)について】既定シナリオの各会社は初期工場1つのみのため
// （実装指示§16「Redis namespace変更禁止」「schema変更禁止」と同じ理由で、この
// タスクの範囲でfixtureを書き換えることはしない）、「売却しても保有工場が1つ
// 残る」ような実データ上のE2Eはこの環境では組めない。SELL_FACTORY自体の
// 正しさ（T→T+1 SALE_PENDING→T+2 SOLD・売却代金・disposal gain/loss）は
// 既存のapp/lib/v2/companyLab/__tests__/engFac1FactoryLifecycle.test.ts（変更なし・
// このタスクでも実行して確認済み）と、本タスクの新規ユニットテスト
// （factoryOperationsViewModel.test.ts FAC-VM-3/4等）で確認済みであり、ここでは
// 重複させない。

import { test, expect, type Page } from "@playwright/test";

const STAGING_ADMIN_TOKEN = "e2e-test-token";

async function loginAsGm(page: Page): Promise<void> {
  const returnTo = encodeURIComponent("/v2/management/setup");
  await page.goto(`/v2/company-lab/play/login?returnTo=${returnTo}`);
  await page.getByLabel("管理トークン").fill(STAGING_ADMIN_TOKEN);
  await page.getByRole("button", { name: "ログイン" }).click();
  await page.waitForURL(/\/v2\/management\/setup/);
}

async function createRunWithBalAsPlayer(page: Page): Promise<string> {
  await page.goto("/v2/management/setup");
  await page.getByTestId("setup-control-mode-BAL").selectOption("PLAYER");
  await page.getByTestId("setup-start-button").click();
  await page.waitForURL(/\/v2\/management\?run=/);
  const url = new URL(page.url());
  const runId = url.searchParams.get("run");
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

async function joinAsPlayer(page: Page, joinUrl: string, companyId: string): Promise<void> {
  await page.goto(joinUrl);
  await page.waitForURL(/\/v2\/play\/workspace/);
  await expect(page.getByTestId("play-workspace-heading")).toContainText(companyId);
}

async function submitCurrentTurn(page: Page): Promise<void> {
  // 【本E2E固有】Factory操作の選択自体がdraftの変更（onChange）であり、その時点で
  // PlayerWorkspacePageのstatusは既にTURN_ACTIVEからEDITINGへ進んでいる（touched=true）。
  // どちらも「未提出」の正当な状態であり、提出前チェックとしてはSubmitボタンが
  // 有効であることだけを見ればよい。
  await expect(page.getByTestId("play-submit-decision")).toBeEnabled();
  await page.getByTestId("play-submit-decision").click();
  await expect(page.getByTestId("play-waiting-for-gm")).toBeVisible();
}

async function runOneTurn(page: Page): Promise<void> {
  await page.getByTestId("run-1").click();
  await expect(page.getByTestId("run-1")).toBeEnabled({ timeout: 60_000 });
}

test.describe("Player工場操作Phase 1 — Independent Player Flow経由のFactory Mothball/Reactivate", () => {
  test("BAL: INVESTMENTタブでFactory休止を選択 → confirmation → Submit → GM Advance → 能力0確認 → reload復旧 → 再稼働 → 能力復帰", async ({ browser }) => {
    const gmContext = await browser.newContext();
    const balContext = await browser.newContext();
    const gmPage = await gmContext.newPage();
    const balPage = await balContext.newPage();

    try {
      let runId = "";
      await test.step("GM: ログイン → BALをPLAYERにしてRunを作成 → 参加リンク発行", async () => {
        await loginAsGm(gmPage);
        runId = await createRunWithBalAsPlayer(gmPage);
        expect(runId).toBeTruthy();
      });

      let balJoinUrl = "";
      await test.step("GM: BALへ参加リンクを発行", async () => {
        balJoinUrl = await issueJoinUrl(gmPage, "BAL");
      });

      await test.step("BAL: 別contextで参加", async () => {
        await joinAsPlayer(balPage, balJoinUrl, "BAL");
      });

      await test.step("BAL: INVESTMENTタブでFactory休止(MOTHBALL_FACTORY)を選択し、confirmationを確認する", async () => {
        await balPage.getByTestId("decision-studio-tab-investment").click();
        await expect(balPage.getByTestId("factory-operations-section")).toBeVisible();
        await expect(balPage.getByTestId("factory-operations-status-BAL-F1")).toHaveText("稼働中");
        await balPage.getByTestId("factory-operations-action-BAL-F1-MOTHBALL_FACTORY").click();

        const confirmation = balPage.getByTestId("factory-operations-confirmation-BAL-F1");
        await expect(confirmation).toBeVisible();
        await expect(confirmation).toContainText("生産能力が0になります");
        await expect(confirmation).toContainText("Workerは自動的には減りません");
      });

      await test.step("BAL: Turn1を提出する", async () => {
        await submitCurrentTurn(balPage);
      });

      await test.step("GM: Advanceして Turn2 へ進める", async () => {
        await runOneTurn(gmPage);
        await expect(gmPage.getByTestId("turn-counter")).toHaveText("1 / 32");
      });

      await test.step("BAL: 次Turnへ自動的に切り替わり、Factoryが休止中・能力0になっている", async () => {
        await expect(balPage.getByText(/Turn 2 \//)).toBeVisible({ timeout: 15_000 });
        await balPage.getByTestId("decision-studio-tab-investment").click();
        await expect(balPage.getByTestId("factory-operations-status-BAL-F1")).toHaveText("休止中");
        await expect(balPage.getByTestId("factory-operations-row-BAL-F1")).toContainText("生産能力（前処理）: 0 t/四半期");
      });

      await test.step("BAL: reloadしても休止状態が維持される（サーバー側が正本）", async () => {
        await balPage.reload();
        await balPage.getByTestId("decision-studio-tab-investment").click();
        await expect(balPage.getByTestId("factory-operations-status-BAL-F1")).toHaveText("休止中");
      });

      await test.step("BAL: 再稼働(REACTIVATE_FACTORY)を選択してTurn2を提出する", async () => {
        await balPage.getByTestId("factory-operations-action-BAL-F1-REACTIVATE_FACTORY").click();
        await expect(balPage.getByTestId("factory-operations-confirmation-BAL-F1")).toContainText("再稼働費用");
        await submitCurrentTurn(balPage);
      });

      await test.step("GM: Advanceして Turn3 へ進める", async () => {
        await runOneTurn(gmPage);
        await expect(gmPage.getByTestId("turn-counter")).toHaveText("2 / 32");
      });

      await test.step("BAL: 次Turnで生産能力が復帰する", async () => {
        await expect(balPage.getByText(/Turn 3 \//)).toBeVisible({ timeout: 15_000 });
        await balPage.getByTestId("decision-studio-tab-investment").click();
        await expect(balPage.getByTestId("factory-operations-status-BAL-F1")).toHaveText("稼働中");
        await expect(balPage.getByTestId("factory-operations-row-BAL-F1")).not.toContainText("生産能力（前処理）: 0 t/四半期");
      });
    } finally {
      await gmContext.close();
      await balContext.close();
    }
  });
});
