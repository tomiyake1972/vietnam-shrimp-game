// ShrimpX V2 — PLAY画面 管理者再ログイン導線 ブラウザE2E
//
// 指示§「テスト」の1〜9を、実際のdev serverに対して確認する。
// 新しい認証方式・新しいreturnTo機構は作っていない（既存のCOMPANY_LAB_UI_LOGIN_PATH・
// sanitizeReturnToPath・requireStagingSessionをそのまま使うだけ）ため、ここでは
// 「元画面 → （セッション切れを模擬） → 🔐管理者ログイン押下 → login → 元画面へ戻る」
// という往復と、既存挙動（ログイン済みなら壊さない・外部URLへは戻さない・
// Independent Player Sessionには一切触れない）を確認する。

import { test, expect, type Page } from "@playwright/test";

const STAGING_ADMIN_TOKEN = "e2e-test-token";
const NEW_LAB_PATH = "/v2/company-lab/play/new";
const HOME_PATH = "/v2/company-lab/play";

async function loginAsAdmin(page: Page): Promise<void> {
  const returnTo = encodeURIComponent(NEW_LAB_PATH);
  await page.goto(`/v2/company-lab/play/login?returnTo=${returnTo}`);
  await page.getByLabel("管理トークン").fill(STAGING_ADMIN_TOKEN);
  await page.getByRole("button", { name: "ログイン" }).click();
  await page.waitForURL(new RegExp(`${NEW_LAB_PATH}$`));
}

async function createLab(page: Page): Promise<string> {
  await page.goto(NEW_LAB_PATH);
  await page.getByRole("button", { name: "作成する" }).click();
  // 【非anchorな正規表現に注意】/new自身のURLにも部分一致してしまうため除外する
  // （salesModelSelector.e2e.ts等、既存E2Eと同じ落とし穴・同じ対策）。
  await page.waitForURL((url) => /\/v2\/company-lab\/play\/[^/]+$/.test(url.pathname) && !url.pathname.endsWith("/new"));
  return page.url();
}

async function loginWithForm(page: Page): Promise<void> {
  await page.getByLabel("管理トークン").fill(STAGING_ADMIN_TOKEN);
  await page.getByRole("button", { name: "ログイン" }).click();
}

async function createRunWithBalAsPlayer(page: Page): Promise<void> {
  await page.goto("/v2/management/setup");
  await page.getByTestId("setup-control-mode-BAL").selectOption("PLAYER");
  await page.getByTestId("setup-start-button").click();
  await page.waitForURL(/\/v2\/management\?run=/);
}

test.describe("PLAY画面 管理者再ログイン導線", () => {
  test("(1)(2)(3)(4)(6)(9) Company Lab PLAY画面: セッション切れ→再ログイン→同じ画面へ復帰、ログイン済み時は壊さない、reload後も状態復元", async ({ page, context }) => {
    let labUrl = "";

    await test.step("ログイン → Labを作成 → PLAY画面（詳細）へ", async () => {
      await loginAsAdmin(page);
      labUrl = await createLab(page);
    });

    await test.step("(6) ログイン済みのまま「🔐 管理者ログイン」を押しても、フォームを見せずに同じ画面へ戻る（既存挙動を壊さない）", async () => {
      await page.getByTestId("admin-relogin-link").click();
      await page.waitForURL(labUrl);
      // ログインフォームが一瞬でも最終的に残っていないこと（redirect後の状態で確認）。
      await expect(page.getByRole("button", { name: "ログイン" })).toHaveCount(0);
    });

    await test.step("(1)(2) セッション切れを模擬（Cookie削除、ページはreloadしない）→「🔐 管理者ログイン」押下でlogin画面へ", async () => {
      await context.clearCookies();
      await page.getByTestId("admin-relogin-link").click();
      await page.waitForURL(/\/v2\/company-lab\/play\/login\?returnTo=/);
      await expect(page.getByRole("button", { name: "ログイン" })).toBeVisible();
    });

    await test.step("(3) ログイン成功後、元のPLAY画面（同じURL・labId）へ自動的に戻る", async () => {
      await loginWithForm(page);
      await page.waitForURL(labUrl);
    });

    await test.step("(9) その後ブラウザreloadしても、既存ゲームstateは従来どおり復元される（管理者再ログイン導線が状態復元を壊していない）", async () => {
      await page.reload();
      await expect(page.getByTestId("lab-sales-model-label")).toBeVisible();
      await expect(page).toHaveURL(labUrl);
    });
  });

  test("(4)(5) query params（run/company）を含むPlayer Workspace URLでも、returnToが完全に保持される", async ({ page, context }) => {
    let workspaceUrl = "";

    await test.step("GM: ログイン → BALをPLAYERにしてRunを作成 → 「この会社を操作」でPlayer Workspace（run/company付きURL）を開く", async () => {
      await loginAsAdmin(page);
      await createRunWithBalAsPlayer(page);
      const url = new URL(page.url());
      const runId = url.searchParams.get("run");
      if (!runId) throw new Error("Run作成後のURLにrunIdが無い");
      // 【liveSessionRegistry依存】このRunはブラウザのin-memory状態（Management
      // Consoleのタブ内）にのみ存在するため、直接page.gotoで/v2/management/playerへ
      // 飛ぶと「このタブがそのRunの進行状態を持っていない」エラーになる（実機で確認済み）。
      // 実際のGM操作どおり、ManagementConsole上の「この会社を操作」ボタン（client側
      // router.push）を経由して同じタブ内のまま遷移する必要がある。
      await page.getByTestId("company-control-operate-BAL").click();
      await expect(page.getByTestId("workspace-heading")).toBeVisible();
      workspaceUrl = page.url();
      expect(new URL(workspaceUrl).searchParams.get("run")).toBe(runId);
      expect(new URL(workspaceUrl).searchParams.get("company")).toBe("BAL");
    });

    await test.step("(4)(5) セッション切れを模擬 →「🔐 管理者ログイン」押下 → ログイン → run/company付きの同じURL（returnTo）へ完全に戻る", async () => {
      await context.clearCookies();
      await page.getByTestId("admin-relogin-link").first().click();
      await page.waitForURL(/\/v2\/company-lab\/play\/login\?returnTo=/);
      await loginWithForm(page);
      await page.waitForURL(workspaceUrl);
      // 【スコープの境界】ここで確認するのはreturnTo機構そのもの（run/companyを含む
      // URLが1文字も欠けずに復元されること）。PlayerWorkspace自体の画面content
      // （workspace-heading等）は、このRunのGM側liveSessionRegistryがタブ内
      // in-memory状態であるため、reload・別タブでの再訪問では既存仕様として
      // 復元されない（実機で確認済み・PlayerWorkspace自身が「別のタブで開いた・
      // ページを再読み込みした等の理由で状態を持っていない」と案内する既存挙動。
      // admin-relogin機構が壊した状態ではなく、この画面が元から持つ制約）。
      // そのためここではURL一致だけを検証し、contentの復元は主張しない。
      const finalUrl = new URL(page.url());
      expect(finalUrl.pathname).toBe("/v2/management/player");
      expect(finalUrl.searchParams.get("run")).toBe(new URL(workspaceUrl).searchParams.get("run"));
      expect(finalUrl.searchParams.get("company")).toBe("BAL");
    });
  });

  test("(7)【セキュリティ】外部URLをreturnToに指定しても、ログイン後は外部URLへ遷移しない", async ({ page }) => {
    await page.goto(`/v2/company-lab/play/login?returnTo=${encodeURIComponent("https://evil.example.com")}`);
    await loginWithForm(page);
    // sanitizeReturnToPathが"://"を含む値を拒否するため、既定のCOMPANY_LAB_UI_HOME_PATHへ
    // フォールバックする（evil.example.comへは絶対に遷移しない）。
    await page.waitForURL(new RegExp(`${HOME_PATH}$`));
    expect(page.url()).not.toContain("evil.example.com");
  });

  test("(8) Independent Player Session（Player Cookie）は、Admin側の再ログイン操作に一切影響されない", async ({ browser }) => {
    const gmContext = await browser.newContext();
    const balContext = await browser.newContext();
    const gmPage = await gmContext.newPage();
    const balPage = await balContext.newPage();

    try {
      let balJoinUrl = "";
      await test.step("GM: ログイン → BALをPLAYERにしてRunを作成 → 参加リンク発行", async () => {
        await loginAsAdmin(gmPage);
        await createRunWithBalAsPlayer(gmPage);
        await gmPage.getByTestId("player-seat-issue-BAL").click();
        const codeLocator = gmPage.getByTestId("player-seat-join-url-BAL").locator("code");
        await expect(codeLocator).toBeVisible();
        balJoinUrl = ((await codeLocator.textContent()) ?? "").trim();
      });

      await test.step("BAL: 別contextで参加（Player Session Cookieのみ、Admin Cookieは一切持たない）", async () => {
        await balPage.goto(balJoinUrl);
        await balPage.waitForURL(/\/v2\/play\/workspace/);
        await expect(balPage.getByTestId("play-workspace-heading")).toContainText("BAL");
        // Independent Player画面には管理者再ログインリンクを一切追加していない
        // （Player SessionとAdmin Sessionを混同・統合しないため）。
        await expect(balPage.getByTestId("admin-relogin-link")).toHaveCount(0);
      });

      await test.step("GM: 自分のAdmin Cookieだけを削除し、管理者再ログイン導線で再ログインする", async () => {
        await gmPage.goto("/v2/management");
        await gmContext.clearCookies();
        await gmPage.getByTestId("admin-relogin-link").click();
        await gmPage.waitForURL(/\/v2\/company-lab\/play\/login\?returnTo=/);
        await loginWithForm(gmPage);
      });

      await test.step("BAL: GM側の再ログイン操作の前後で、Player Workspaceの状態・Cookieは変化しない", async () => {
        await expect(balPage.getByTestId("play-workspace-heading")).toContainText("BAL");
        await expect(balPage.getByTestId("play-workspace-status")).toHaveAttribute("data-status", "TURN_ACTIVE");
        const balCookies = await balContext.cookies();
        const hasAdminCookie = balCookies.some((c) => c.name === "shrimpx_company_lab_ui_session");
        expect(hasAdminCookie).toBe(false);
      });
    } finally {
      await gmContext.close();
      await balContext.close();
    }
  });
});
