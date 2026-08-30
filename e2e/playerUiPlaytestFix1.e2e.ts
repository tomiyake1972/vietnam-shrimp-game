// ShrimpX V2 — PLAYER-UI-PLAYTEST-FIX-1 ブラウザE2E
//
// 三宅さんの実Redis Preview手動テストで指摘された3点のうち、company-lab/play
// （GM/開発者用Company Labテストプレイ画面）で確認できるものを、実際のdev serverに
// 対して確認する:
//   ① 製品在庫を商品別（HOSO/PD/VAP）に見られること（新規追加・OpeningCompanyStatePanel）
//   ④ CEO summary（① 今期の基本方針 / ② 経営サマリー）がAI説明パネルの最上部に表示され、
//     既存の詳細説明（③ 分野別の重要提案 等）を消さないこと（コード変更なし・既存動作の確認）
// ②③（SALES基準価格表示）はe2e/salesPriceReference.e2e.ts（Independent Player Flow経由、
// 価格参考表示branchから無変更でcherry-pick済み）が既に検証しているため、ここでは扱わない。
//
// 【この検証環境の既知の制約】ANTHROPIC_API_KEYが未設定のため、AI経営説明の実際の生成
// （Claude API呼び出し）は必ず失敗する（既存のai-explanation-failure状態になる）。
// そのためCEO summary（headline/executiveSummary）の"成功時の実際の表示"はこのE2Eでは
// 確認できない。ここでは「失敗時にCEO summaryが捏造されず、既存のエラー表示（
// ai-explanation-error-category）が壊れていないこと」までを確認し、成功時の表示順序
// （①②が③より前）はソースコード読解で確認済みであることを最終報告で明記する。

import { test, expect, type Page } from "@playwright/test";

const STAGING_ADMIN_TOKEN = "e2e-test-token";
const NEW_LAB_PATH = "/v2/company-lab/play/new";

async function loginAsAdmin(page: Page): Promise<void> {
  const returnTo = encodeURIComponent(NEW_LAB_PATH);
  await page.goto(`/v2/company-lab/play/login?returnTo=${returnTo}`);
  await page.getByLabel("管理トークン").fill(STAGING_ADMIN_TOKEN);
  await page.getByRole("button", { name: "ログイン" }).click();
  await page.waitForURL(new RegExp(`${NEW_LAB_PATH}$`));
}

async function createLab(page: Page): Promise<void> {
  await page.goto(NEW_LAB_PATH);
  await page.getByRole("button", { name: "作成する" }).click();
  // 【非anchorな正規表現に注意】/new自身へのURLにも部分一致してしまうため、
  // salesModelSelector.e2e.tsと同じく"new"を明示的に除外する。
  await page.waitForURL((url) => /\/v2\/company-lab\/play\/[^/]+$/.test(url.pathname) && !url.pathname.endsWith("/new"));
}

test.describe("PLAYER-UI-PLAYTEST-FIX-1 — 製品別在庫表示 / CEO summary非捏造確認", () => {
  test("① 製品在庫（商品別）: turn1でHOSO/PD/VAPすべて0 tと明示され、合計と一致する", async ({ page }) => {
    await loginAsAdmin(page);
    await createLab(page);

    // INFOタブは既定で開いている（DecisionStudioのactiveScreen初期値="info"）。
    await expect(page.getByTestId("decision-studio-tab-info")).toBeVisible();

    // 「自社の状態」セクションはdefaultOpen=falseの<details>のため、summaryをクリックして開く。
    // 【既存の重複表示】PlayerScreenClient.tsx自身とDecisionStudio内のINFOタブ（InformationScreen）
    // の両方が同じOpeningCompanyStatePanelを描画しており、同じtestidが2箇所に存在する
    // （本タスクで新設した重複ではない・既存の画面構成）。値はどちらも同じなので.first()で良い。
    await page.getByTestId("opening-company-state-section").first().locator("> summary").click();
    await expect(page.getByTestId("finished-goods-by-product").first()).toBeVisible();

    const hoso = page.getByTestId("finished-goods-hoso").first();
    const pd = page.getByTestId("finished-goods-pd").first();
    const vap = page.getByTestId("finished-goods-vap").first();
    const total = page.getByTestId("finished-goods-total").first();

    await expect(hoso).toContainText("HOSO");
    await expect(hoso).toContainText("0 t");
    await expect(pd).toContainText("PD");
    await expect(pd).toContainText("0 t");
    await expect(vap).toContainText("VAP");
    await expect(vap).toContainText("0 t");
    await expect(total).toContainText("合計");
    await expect(total).toContainText("0 t");
  });

  test("④ CEO summary: AI説明パネルは捏造せず、失敗時は既存のエラー表示のまま（成功時の表示順序はコード確認済み・本環境では未実測）", async ({ page }) => {
    await loginAsAdmin(page);
    await createLab(page);

    // AI説明パネルはStandard AI診断がある場合のみ表示される（isEditing && aiProposalDiagnostics）。
    const aiSection = page.getByTestId("ai-proposal-diagnostics-section");
    await expect(aiSection).toBeVisible();
    // 【入れ子のCollapsibleSection】この中に「⑧ 詳細な判断ログ」という別のCollapsibleSectionが
    // ネストされているため、直接の子summaryだけをクリックする（内側のsummaryまで開かない）。
    await aiSection.locator("> summary").click();

    // 【既知の環境制約】ANTHROPIC_API_KEY未設定のため、この検証環境では必ずfailureになる。
    // success/failureいずれの状態になっても、次の3点だけを確認する:
    //  (a) どちらかの状態には必ず到達する（無限ローディングのまま止まらない）
    //  (b) failureの場合、捏造された①②の文言が出ていない
    //  (c) failureの場合でも既存のエラー分類表示（ai-explanation-error-category）は壊れていない
    const successBlock = page.getByTestId("ai-explanation-success");
    const failureBlock = page.getByTestId("ai-explanation-failure");
    await expect(successBlock.or(failureBlock)).toBeVisible({ timeout: 40_000 });

    if (await failureBlock.isVisible()) {
      await expect(page.getByTestId("ai-explanation-error-category")).toBeVisible();
      await expect(page.getByTestId("ai-explanation-headline")).toHaveCount(0);
      await expect(page.getByTestId("ai-explanation-executive-summary")).toHaveCount(0);
    } else {
      // 実際にANTHROPIC_API_KEYが設定された環境で成功した場合の確認（本セッションの
      // 検証環境では到達しない分岐だが、将来API keyが設定された環境でも同じテストで
      // 検証できるようにしておく）。
      await expect(page.getByTestId("ai-explanation-headline")).toBeVisible();
      await expect(page.getByTestId("ai-explanation-executive-summary")).toBeVisible();
      await expect(page.getByText("③ 分野別の重要提案")).toBeVisible();
      const headlineBox = await page.getByTestId("ai-explanation-headline").boundingBox();
      const recommendationsBox = await page.getByText("③ 分野別の重要提案").boundingBox();
      if (headlineBox && recommendationsBox) {
        expect(headlineBox.y).toBeLessThan(recommendationsBox.y);
      }
    }
  });
});
