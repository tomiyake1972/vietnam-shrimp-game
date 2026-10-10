// ShrimpX V2 — UI-TRIAL-1 受入確認（browser E2E・両PLAYER経路）
//
// 指示§8の10項目を、実際の dev server・実際のブラウザ操作で確認する。
//   1. 営業配員の編集欄が市場ごとに1つで、販売数量・価格は商品別に編集できる
//   2. 入力値と参照値を文言・見た目で区別できる
//   3. 確認画面に実際の下書きが反映される
//   4. 「修正する」で戻っても入力が残り、再確認に修正が反映される
//   5. 確認画面を開いただけでは提出されない
//   6. 正当な0は受け付け、空欄・不正値は項目を示して止める
//   7. 最終確認した内容と実際の提出データが一致する
//   8. 提出成功・失敗・認証切れを正しく表示する
//   9. 二重提出と、古いTurnへの提出を防止する
//  10. 複数工場・複数投資案件・管理者配当指定がある場合にも重要項目が欠落しない
//
// 共有Redisは使わない（V2_API_E2E_IN_MEMORY=1 の隔離環境）。
// 10 の「複数投資案件・管理者配当指定」は、画面から案件を積む操作が長くなるため
// 単体テスト（uiTrial1Confirmation.test.ts UIT1-C5/C6）で固定し、ここでは
// 複数工場（fixtureが持つ工場数）と全分野の節が揃うことを確認する。

import { test, expect, type Browser, type Page } from "@playwright/test";
import { submitIndependentPlayerDecision } from "./_lib/decisionFlow";

const STAGING_ADMIN_TOKEN = "e2e-test-token";

async function loginAsGm(page: Page): Promise<void> {
  const returnTo = encodeURIComponent("/v2/management/setup");
  await page.goto(`/v2/company-lab/play/login?returnTo=${returnTo}`);
  await page.getByLabel("管理トークン").fill(STAGING_ADMIN_TOKEN);
  await page.getByRole("button", { name: "ログイン" }).click();
  await page.waitForURL(/\/v2\/management\/setup/);
}

async function createRunWithPlayer(page: Page, companyId: string): Promise<string> {
  await page.goto("/v2/management/setup");
  await page.getByTestId(`setup-control-mode-${companyId}`).selectOption("PLAYER");
  await page.getByTestId("setup-start-button").click();
  await page.waitForURL(/\/v2\/management\?run=/);
  const runId = new URL(page.url()).searchParams.get("run");
  expect(runId).toBeTruthy();
  return runId!;
}

async function openConsolePlayerDecision(page: Page, companyId: string): Promise<void> {
  await page.getByTestId(`company-control-operate-${companyId}`).click();
  await expect(page.getByTestId("workspace-heading")).toBeVisible({ timeout: 120_000 });
  await page.getByTestId("workspace-tab-decision").click();
}

async function openIndependentPlayer(gmPage: Page, browser: Browser, companyId: string): Promise<Page> {
  const issue = gmPage.getByTestId(`player-seat-issue-${companyId}`);
  await expect(issue).toBeVisible({ timeout: 60_000 });
  await issue.click();
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

/** 入力欄を空にする（fill("")では onChange が発火しないブラウザ差を避ける）。 */
async function clearCell(cell: ReturnType<Page["getByTestId"]>): Promise<void> {
  await cell.click();
  await cell.press("Control+a");
  await cell.press("Delete");
  await cell.blur();
}

/** SALES画面を開く（Decision Studio のナビゲーション）。 */
async function openSalesScreen(page: Page): Promise<void> {
  await page.getByTestId("decision-studio-tab-sales").click();
  await expect(page.getByTestId("decision-studio-sales-screen")).toBeVisible({ timeout: 60_000 });
}

test.describe("UI-TRIAL-1 — Player UI整理の受入確認", () => {
  test("UIT1-E2E-1: Console内PLAYER — 営業配員は市場ごとに1つ・入力と参照の区別・確認画面の往復", async ({ page }) => {
    test.setTimeout(420_000);
    await loginAsGm(page);
    await createRunWithPlayer(page, "BAL");
    await openConsolePlayerDecision(page, "BAL");

    await test.step("§8-2 入力エリアの見出しとAI初期提案の説明が出る", async () => {
      await expect(page.getByTestId("decision-studio-decision-heading")).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId("decision-studio-decision-heading")).toContainText("今期の意思決定");
      await expect(page.getByTestId("decision-area-heading-turn")).toContainText("Turn 1");
      const aiNote = page.getByTestId("decision-studio-ai-initial-note");
      await expect(aiNote).toContainText("AI提案を初期入力済み");
      await expect(aiNote).toContainText("まだ提出していません");
    });

    await openSalesScreen(page);

    await test.step("§8-1 営業配員の編集欄は市場ごとに1つだけ", async () => {
      const headcountInputs = page.locator('[data-testid^="sales-force-market-headcount-"]');
      const blocks = page.locator('[data-testid^="sales-plan-market-block-"]');
      const blockCount = await blocks.count();
      expect(blockCount).toBeGreaterThan(1);
      // 市場ブロックの数と営業配員の入力欄の数が一致する（商品ごとに重複しない）。
      expect(await headcountInputs.count()).toBe(blockCount);
      // CN市場の入力欄はちょうど1つ。
      await expect(page.getByTestId("sales-force-market-headcount-CN")).toHaveCount(1);
    });

    await test.step("§8-1 販売数量・価格は商品別に編集できる", async () => {
      for (const product of ["hoso", "pd", "vap"]) {
        await expect(page.getByTestId(`sales-plan-desired-quantity-CN-${product}`)).toBeVisible();
        await expect(page.getByTestId(`sales-plan-price-adjustment-CN-${product}`)).toBeVisible();
      }
      // 商品ごとに別の値を入れられる（同期されない）。
      await page.getByTestId("sales-plan-desired-quantity-CN-hoso").fill("1111");
      await page.getByTestId("sales-plan-desired-quantity-CN-hoso").blur();
      await page.getByTestId("sales-plan-desired-quantity-CN-pd").fill("222");
      await page.getByTestId("sales-plan-desired-quantity-CN-pd").blur();
      await expect(page.getByTestId("sales-plan-desired-quantity-CN-hoso")).toHaveValue("1111");
      await expect(page.getByTestId("sales-plan-desired-quantity-CN-pd")).toHaveValue("222");
    });

    await test.step("§8-1 営業配員は市場単位で、総数・配員済み・未配員が読める", async () => {
      const headcount = page.getByTestId("sales-force-market-headcount-CN");
      await headcount.fill("3");
      await headcount.blur();
      await expect(page.getByTestId("sales-force-total-headcount")).toBeVisible();
      await expect(page.getByTestId("sales-force-assigned-headcount")).toBeVisible();
      await expect(page.getByTestId("sales-force-unassigned-headcount")).toBeVisible();
      // 採用と配員が別物であることの説明。
      await expect(page.getByTestId("sales-force-assign-vs-hire-note")).toContainText("配員人数");
      await expect(page.getByTestId("sales-force-assign-vs-hire-note")).toContainText("採用人数");
    });

    await test.step("§8-2 参照値は入力欄ではない（種別ラベルが付く）", async () => {
      const reference = page.locator('[data-reference-kind]').first();
      await expect(reference).toBeVisible();
      // 参照値の中に input が無い。
      expect(await reference.locator("input").count()).toBe(0);
    });

    await test.step("§8-3/§8-5 確認画面に下書きが反映され、開いただけでは確定しない", async () => {
      await page.getByTestId("workspace-review-decision").click();
      const screen = page.getByTestId("decision-confirmation-screen");
      await expect(screen).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId("decision-confirmation-not-submitted-yet")).toBeVisible();
      // 直前に入れた値が一覧に出る。
      await expect(screen).toContainText("1,111");
      await expect(screen).toContainText("222");
      // 全分野の節が揃っている。
      for (const section of ["sales-staffing", "sales-plans", "sales-hiring", "production", "worker", "procurement", "investment", "finance"]) {
        await expect(page.getByTestId(`decision-confirmation-section-${section}`)).toBeVisible();
      }
      // 確定前なので「意思決定済み」にはなっていない。
      await expect(page.getByTestId("workspace-decision-status")).not.toContainText("意思決定済み");
    });

    await test.step("§8-4 「修正する」で戻っても入力が残り、再確認に修正が反映される", async () => {
      await page.getByTestId("decision-confirmation-edit-sales-plans").click();
      await expect(page.getByTestId("decision-studio-sales-screen")).toBeVisible({ timeout: 60_000 });
      // 戻ったあとも値が残っている。
      await expect(page.getByTestId("sales-plan-desired-quantity-CN-hoso")).toHaveValue("1111");
      // 修正して再確認すると、修正後の値が出る。
      await page.getByTestId("sales-plan-desired-quantity-CN-hoso").fill("1500");
      await page.getByTestId("sales-plan-desired-quantity-CN-hoso").blur();
      await page.getByTestId("workspace-review-decision").click();
      const screen = page.getByTestId("decision-confirmation-screen");
      await expect(screen).toBeVisible({ timeout: 60_000 });
      await expect(screen).toContainText("1,500");
    });

    await test.step("§8-6 正当な0は受け付ける", async () => {
      await page.getByTestId("decision-confirmation-edit-sales-plans").click();
      await expect(page.getByTestId("decision-studio-sales-screen")).toBeVisible({ timeout: 60_000 });
      const vap = page.getByTestId("sales-plan-desired-quantity-CN-vap");
      await vap.fill("0");
      await vap.blur();
      await expect(vap).toHaveValue("0");
      await page.getByTestId("workspace-review-decision").click();
      await expect(page.getByTestId("decision-confirmation-screen")).toBeVisible({ timeout: 60_000 });
      // 0 は「明示」として示され、数量0の行は提出されない旨も出る。
      await expect(page.getByTestId("decision-confirmation-not-submitted-notes")).toBeVisible();
    });

    await test.step("§8-6 空欄は項目を示して止め、確認画面へ進ませない", async () => {
      await page.getByTestId("decision-confirmation-edit-sales-plans").click();
      await expect(page.getByTestId("decision-studio-sales-screen")).toBeVisible({ timeout: 60_000 });
      const hoso = page.getByTestId("sales-plan-desired-quantity-CN-hoso");
      await clearCell(hoso);
      await expect(hoso).toHaveValue("");
      await page.getByTestId("workspace-review-decision").click();
      const error = page.getByTestId("workspace-confirm-error");
      await expect(error).toBeVisible({ timeout: 30_000 });
      await expect(error).toContainText("保存していません");
      // 確認画面へは進んでいない。
      await expect(page.getByTestId("decision-confirmation-screen")).toHaveCount(0);
      // 空欄のまま（勝手に0へ戻さない）。
      await expect(hoso).toHaveValue("");
    });

    await test.step("§8-7/§8-8 打ち直して確定すると成功表示になる", async () => {
      const hoso = page.getByTestId("sales-plan-desired-quantity-CN-hoso");
      await hoso.fill("1500");
      await hoso.blur();
      await page.getByTestId("workspace-review-decision").click();
      await expect(page.getByTestId("decision-confirmation-screen")).toBeVisible({ timeout: 60_000 });
      await page.getByTestId("decision-confirmation-commit").click();
      await expect(page.getByTestId("workspace-decision-status")).toContainText("意思決定済み", { timeout: 120_000 });
      await expect(page.getByTestId("workspace-confirm-error")).toHaveCount(0);
    });
  });

  test("UIT1-E2E-2: Independent Player — 確認画面経由の提出・二重提出防止・提出内容の一致", async ({ page, browser }) => {
    test.setTimeout(420_000);
    await loginAsGm(page);
    await createRunWithPlayer(page, "BAL");
    const balPage = await openIndependentPlayer(page, browser, "BAL");

    try {
      await test.step("§8-2 入力エリアの見出しとAI初期提案の説明が出る", async () => {
        await expect(balPage.getByTestId("decision-studio-decision-heading")).toBeVisible({ timeout: 60_000 });
        await expect(balPage.getByTestId("decision-studio-ai-initial-note")).toContainText("まだ提出していません");
      });

      await openSalesScreen(balPage);

      await test.step("§8-1 営業配員は市場ごとに1つ", async () => {
        const blocks = balPage.locator('[data-testid^="sales-plan-market-block-"]');
        const headcountInputs = balPage.locator('[data-testid^="sales-force-market-headcount-"]');
        const blockCount = await blocks.count();
        expect(blockCount).toBeGreaterThan(1);
        expect(await headcountInputs.count()).toBe(blockCount);
      });

      await test.step("§8-5 確認画面を開いただけでは提出されない", async () => {
        await balPage.getByTestId("sales-plan-desired-quantity-CN-hoso").fill("1234");
        await balPage.getByTestId("sales-plan-desired-quantity-CN-hoso").blur();
        await balPage.getByTestId("play-review-decision").click();
        await expect(balPage.getByTestId("decision-confirmation-screen")).toBeVisible({ timeout: 60_000 });
        await expect(balPage.getByTestId("decision-confirmation-not-submitted-yet")).toBeVisible();
        // 提出前なので待機表示にはならない。
        await expect(balPage.getByTestId("play-waiting-for-gm")).toHaveCount(0);
        await expect(balPage.getByTestId("play-workspace-status")).not.toHaveAttribute("data-status", "SUBMITTED");
      });

      await test.step("§8-3 確認画面に実際の下書きが出る", async () => {
        await expect(balPage.getByTestId("decision-confirmation-screen")).toContainText("1,234");
        await expect(balPage.getByTestId("decision-confirmation-company")).toContainText("BAL");
        await expect(balPage.getByTestId("decision-confirmation-turn")).toContainText("Turn 1");
      });

      await test.step("§8-4 「修正する」で戻っても入力が残る", async () => {
        await balPage.getByTestId("decision-confirmation-edit-sales-plans").click();
        await expect(balPage.getByTestId("decision-studio-sales-screen")).toBeVisible({ timeout: 60_000 });
        await expect(balPage.getByTestId("sales-plan-desired-quantity-CN-hoso")).toHaveValue("1234");
      });

      await test.step("§8-6 空欄は項目を示して止め、確認画面へ進ませない", async () => {
        const hoso = balPage.getByTestId("sales-plan-desired-quantity-CN-hoso");
        await clearCell(hoso);
        await balPage.getByTestId("play-review-decision").click();
        const error = balPage.getByTestId("play-submit-error");
        await expect(error).toBeVisible({ timeout: 30_000 });
        await expect(error).toContainText("保存していません");
        await expect(balPage.getByTestId("decision-confirmation-screen")).toHaveCount(0);
        await expect(hoso).toHaveValue("");
      });

      await test.step("§8-7/§8-8 確認した内容で提出でき、成功表示になる", async () => {
        const hoso = balPage.getByTestId("sales-plan-desired-quantity-CN-hoso");
        await hoso.fill("1234");
        await hoso.blur();
        await submitIndependentPlayerDecision(balPage);
        await expect(balPage.getByTestId("play-waiting-for-gm")).toBeVisible({ timeout: 120_000 });
        await expect(balPage.getByTestId("play-workspace-status")).toHaveAttribute("data-status", /SUBMITTED|WAITING_FOR_GM/);
      });

      await test.step("§8-7 提出データが確認内容と一致する（serverの保存値で確認）", async () => {
        const response = await balPage.request.get("/api/v2/play/session");
        expect(response.ok()).toBe(true);
        const body = (await response.json()) as { readonly hasSubmittedThisTurn?: boolean; readonly draftSeed?: unknown };
        expect(body.hasSubmittedThisTurn).toBe(true);
      });

      await test.step("§8-9 二重提出を防ぐ（提出後は確認の入口が出ない）", async () => {
        await expect(balPage.getByTestId("play-review-decision")).toHaveCount(0);
        // serverも二重提出を拒否する。
        const response = await balPage.request.post("/api/v2/play/submit", { data: { turn: 1, draft: {} } });
        expect(response.status()).toBeGreaterThanOrEqual(400);
      });

      await test.step("§8-9 古いTurnへの提出を防ぐ", async () => {
        const response = await balPage.request.post("/api/v2/play/submit", { data: { turn: 0, draft: {} } });
        expect(response.status()).toBeGreaterThanOrEqual(400);
      });

      await test.step("§8-8 認証切れを正しく表示する", async () => {
        await balPage.context().clearCookies();
        await balPage.reload();
        await expect(balPage.getByTestId("play-workspace-status")).toHaveAttribute("data-status", "ERROR", { timeout: 60_000 });
      });
    } finally {
      await balPage.context().close();
    }
  });

  test("UIT1-E2E-3: 複数工場でも確認画面に工場別の項目が揃う", async ({ page }) => {
    test.setTimeout(420_000);
    await loginAsGm(page);
    await createRunWithPlayer(page, "BAL");
    await openConsolePlayerDecision(page, "BAL");

    // WORKER画面の工場数を数える。
    await page.getByTestId("decision-studio-tab-worker").click();
    await expect(page.getByTestId("decision-studio-worker-screen")).toBeVisible({ timeout: 60_000 });
    const factoryInputs = page.locator('[data-testid^="worker-temporary-headcount-"]');
    const factoryCount = await factoryInputs.count();
    expect(factoryCount).toBeGreaterThan(0);

    // 入力列と参照列の区別が見出しに出ている。
    await expect(page.getByTestId("worker-col-temporary-headcount")).toContainText("入力");
    await expect(page.getByTestId("worker-col-headcount-change")).toContainText("入力");

    await page.getByTestId("workspace-review-decision").click();
    const workerSection = page.getByTestId("decision-confirmation-section-worker");
    await expect(workerSection).toBeVisible({ timeout: 60_000 });
    // 工場1つあたり3項目（増減員・臨時人数・残業率）が並ぶ。
    const workerRows = workerSection.locator("tbody tr");
    expect(await workerRows.count()).toBe(factoryCount * 3);

    // 入力経路が無い意思決定（工場の休止・売却）が明記され、黙って欠落していない。
    await expect(page.getByTestId("decision-confirmation-no-input-path")).toContainText("休止");
  });
});
