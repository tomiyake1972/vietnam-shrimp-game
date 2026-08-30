// ShrimpX V2 — COMPANYLAB-DETAIL-LOAD-404-1 ブラウザE2E
//
// 実 Redis 手動試験で「一覧には出るのに詳細だけ『ラボが見つかりません』になる」
// 事象が報告された。その導線（作成直後 / 一覧の再開 / reload）をブラウザから通し、
// ASCII・日本語・空白入りの labId で詳細画面へ入れることを固定する。
//
// 実 Upstash 資格情報の無いこの検証環境では、既存の
// COMPANY_LAB_UI_E2E_IN_MEMORY=1 フォールバック（playwright.config.ts が設定）を使う。
// したがって本E2Eが検証するのは **UI導線と labId の受け渡し** であり、
// 実 Redis の decode / schema 経路は unit テスト（detailLoad404.test.ts）が
// fake Redis client + redisRepository + codec で担当する。

import { test, expect, type Page } from "@playwright/test";

const STAGING_ADMIN_TOKEN = "e2e-test-token";
const NEW_LAB_PATH = "/v2/company-lab/play/new";
const LIST_PATH = "/v2/company-lab/play";

async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto(`/v2/company-lab/play/login?returnTo=${encodeURIComponent(NEW_LAB_PATH)}`);
  await page.getByLabel("管理トークン").fill(STAGING_ADMIN_TOKEN);
  await page.getByRole("button", { name: "ログイン" }).click();
  await page.waitForURL(new RegExp(`${NEW_LAB_PATH}$`));
}

/** 詳細画面が「見つかりません」でも「読み込めませんでした」でもなく、実際に開けていること。 */
async function expectDetailLoaded(page: Page): Promise<void> {
  await expect(page.getByText("ラボが見つかりません")).toHaveCount(0);
  await expect(page.getByText("ラボを読み込めませんでした")).toHaveCount(0);
  await expect(page.getByTestId("lab-sales-model-label")).toBeVisible({ timeout: 15_000 });
}

async function createLab(page: Page, labId: string, salesModelLabel?: string): Promise<void> {
  await page.goto(NEW_LAB_PATH);
  await page.locator("#labId").fill(labId);
  if (salesModelLabel !== undefined) await page.locator("#salesModelId").selectOption({ label: salesModelLabel });
  await page.getByRole("button", { name: "作成する" }).click();
  await page.waitForURL((url) => /\/v2\/company-lab\/play\/[^/]+$/.test(url.pathname) && !url.pathname.endsWith("/new"));
}

const CASES: Array<{ readonly name: string; readonly labId: string; readonly model?: string; readonly expected: string }> = [
  { name: "ASCII labId / tiered", labId: "e2e-detail-ascii", model: "三層顧客価格モデル V2.00候補", expected: "三層顧客価格モデル V2.00候補" },
  { name: "ASCII+空白 labId / legacy（既定）", labId: "e2e detail ascii space", expected: "従来市場モデル" },
  { name: "日本語+空白 labId / legacy（既定）", labId: "E2E 詳細テスト", expected: "従来市場モデル" },
];

test.describe("COMPANYLAB-DETAIL-LOAD-404-1 — 保存済みLabの詳細画面へ入れる", () => {
  for (const c of CASES) {
    test(`${c.name}: 作成直後 → 一覧 → 再開 → reload のすべてで詳細が開ける`, async ({ page }) => {
      await test.step("ログインしてラボを作成する（作成直後は詳細画面へリダイレクトされる）", async () => {
        await loginAsAdmin(page);
        await createLab(page, c.labId, c.model);
        await expectDetailLoaded(page);
        await expect(page.getByTestId("lab-sales-model-label")).toContainText(c.expected);
      });

      await test.step("一覧へ戻ると作成したラボが表示される", async () => {
        await page.goto(LIST_PATH);
        await expect(page.getByText(c.labId, { exact: true })).toBeVisible({ timeout: 15_000 });
      });

      await test.step("一覧の「再開」から詳細へ入れる", async () => {
        const row = page.locator("tr", { hasText: c.labId });
        await row.getByRole("link", { name: "再開" }).click();
        await expectDetailLoaded(page);
        await expect(page.getByTestId("lab-sales-model-label")).toContainText(c.expected);
      });

      await test.step("詳細画面を reload しても開ける", async () => {
        await page.reload();
        await expectDetailLoaded(page);
        await expect(page.getByTestId("lab-sales-model-label")).toContainText(c.expected);
      });
    });
  }

  test("存在しない labId だけが「ラボが見つかりません」になる", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/v2/company-lab/play/e2e-does-not-exist-xyz");
    await expect(page.getByText("ラボが見つかりません")).toBeVisible({ timeout: 15_000 });
  });
});
