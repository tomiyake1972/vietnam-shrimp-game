// ShrimpX V2 — UI-SALES-MODEL-SELECT-1: Sales Model 選択・表示 UI ブラウザE2E
//
// 指示§17「可能ならローカルまたは既存test環境でブラウザE2Eで確認してください。
// Preview deployは禁止。」に対応する。実Upstash資格情報の無いこの検証環境では
// createCompanyLabApiDependencies()が例外を投げるため、既存のuiDependencies.tsの
// COMPANY_LAB_UI_E2E_IN_MEMORY=1フォールバック（新規実装ではない、Phase 8C-3B時点の
// 既存フォールバック）を使う。プロセス内シングルトンのため、ブラウザの再読み込み・
// 再訪問（resume相当）でも同一サーバープロセス内であればデータが保持される。
//
// 検証するシナリオ（指示§17の(1)〜(7)）:
//  (1) ラボ作成画面を開く → (2) 販売市場モデルを選択する → (3) tieredで作成する
//  → (4) 作成後の表示を確認する → (5) turnを進める → (6) resume（再訪問）する
//  → (7) 表示が保持されることを確認する
// 加えて、legacy（既定値のまま）作成時に表示が変わらないことも確認する。

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

async function createLabAndGetId(page: Page, salesModelLabel?: string): Promise<string> {
  await page.goto(NEW_LAB_PATH);
  if (salesModelLabel !== undefined) {
    await page.locator("#salesModelId").selectOption({ label: salesModelLabel });
  }
  await page.getByRole("button", { name: "作成する" }).click();
  // 【非anchorな正規表現に注意】/\/v2\/company-lab\/play\/[^/]+$/ は
  // このフォーム自身のURL（/v2/company-lab/play/new）にも部分一致してしまい、
  // 実際の作成後リダイレクトを待たずに即座に解決してしまう（実機で確認済みの落とし穴。
  // independentPlayerFlow.e2e.tsのloginAsGmコメントと同じ罠）。"new"を明示的に除外する。
  await page.waitForURL((url) => /\/v2\/company-lab\/play\/[^/]+$/.test(url.pathname) && !url.pathname.endsWith("/new"));
  const url = new URL(page.url());
  const labId = url.pathname.split("/").pop();
  if (!labId) throw new Error("作成後のURLからlabIdが取得できない");
  return labId;
}

async function submitAndProcessQuarter(page: Page): Promise<void> {
  await page.getByRole("button", { name: "この内容で提出する" }).click();
  await expect(page.getByRole("button", { name: "四半期を処理する" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "四半期を処理する" }).click();
  await page.getByRole("button", { name: "はい、処理する" }).click();
  // 処理完了後は次turnのediting画面（「この内容で提出する」）へ戻る。
  await expect(page.getByRole("button", { name: "この内容で提出する" })).toBeVisible({ timeout: 15_000 });
}

test.describe("UI-SALES-MODEL-SELECT-1 — 管理者用 Sales Model 選択・表示 UI", () => {
  test("(1)-(7) tiered選択でラボ作成 → 作成後表示 → turn進行 → resumeでも表示保持", async ({ page }) => {
    let labId = "";

    await test.step("(1)(2)(3) ログイン → ラボ作成画面を開く → 三層顧客価格モデル V2.00候補を選択して作成する", async () => {
      await loginAsAdmin(page);
      labId = await createLabAndGetId(page, "三層顧客価格モデル V2.00候補");
    });

    await test.step("(4) 作成後の表示を確認する（販売モデル: 三層顧客価格モデル V2.00候補）", async () => {
      await expect(page.getByTestId("lab-sales-model-label")).toHaveText("販売モデル: 三層顧客価格モデル V2.00候補");
    });

    await test.step("(5) turnを進める（提出 → 四半期処理）", async () => {
      await submitAndProcessQuarter(page);
    });

    await test.step("表示はturn進行後も三層顧客価格モデルのまま", async () => {
      await expect(page.getByTestId("lab-sales-model-label")).toHaveText("販売モデル: 三層顧客価格モデル V2.00候補");
    });

    await test.step("(6) resume相当（同じlabId URLへ再訪問）", async () => {
      await page.goto(`/v2/company-lab/play/${labId}`);
    });

    await test.step("(7) resume後も表示が保持される", async () => {
      await expect(page.getByTestId("lab-sales-model-label")).toHaveText("販売モデル: 三層顧客価格モデル V2.00候補");
    });
  });

  test("legacy（既定値のまま）で作成すると従来市場モデル表示のまま", async ({ page }) => {
    await loginAsAdmin(page);
    // 販売市場モデルselectを一切操作しない＝既定値（DEFAULT_SALES_MODEL_ID＝legacy）のまま送信する。
    await createLabAndGetId(page);
    await expect(page.getByTestId("lab-sales-model-label")).toHaveText("販売モデル: 従来市場モデル");
  });
});
