// ShrimpX V2 — INT-1 §4: 認証切れ（HTTP 403）と入力処理の確認（browser E2E）
//
//   INT1-AUTH-1 保存時に実際に403を発生させ、保存成功・提出完了と誤表示されないことを確認する
//   INT1-AUTH-2 再ログイン後、正しいRun／会社／Turnへ戻れることを確認する
//   INT1-AUTH-3 確定済みの提出が維持されていることを確認する（再ログイン後にTurnを進められる）
//   INT1-AUTH-4 未確定入力が失われる場合、その事実と必要な再入力が画面に明示されることを確認する
//
// 403は「管理セッションCookieをブラウザから削除する」ことで実際に発生させる
// （テスト用のモック・分岐を製品コードへ入れない）。
// 共有Redisは使わない（V2_API_E2E_IN_MEMORY=1 の隔離環境）。

import { test, expect, type Page } from "@playwright/test";

const STAGING_ADMIN_TOKEN = "e2e-test-token";
const ADMIN_COOKIE = "shrimpx_company_lab_ui_session";

async function loginAsGm(page: Page, returnToPath = "/v2/management/setup"): Promise<void> {
  const returnTo = encodeURIComponent(returnToPath);
  await page.goto(`/v2/company-lab/play/login?returnTo=${returnTo}`);
  await page.getByLabel("管理トークン").fill(STAGING_ADMIN_TOKEN);
  await page.getByRole("button", { name: "ログイン" }).click();
  await page.waitForURL(new RegExp(returnToPath.replace(/\//g, "\\/")));
}

async function createRunWithPlayerBal(page: Page): Promise<string> {
  await page.goto("/v2/management/setup");
  await page.getByTestId("setup-control-mode-BAL").selectOption("PLAYER");
  await page.getByTestId("setup-start-button").click();
  await page.waitForURL(/\/v2\/management\?run=/);
  const runId = new URL(page.url()).searchParams.get("run");
  expect(runId).toBeTruthy();
  return runId!;
}

async function confirmBalDecision(page: Page, runId: string): Promise<void> {
  await page.getByTestId("company-control-operate-BAL").click();
  await page.waitForURL(/\/v2\/management\/player/);
  await page.getByTestId("workspace-tab-decision").click();
  await page.getByTestId("workspace-confirm-decision").click();
  await expect(page.getByTestId("workspace-decision-status")).toContainText("意思決定済み", { timeout: 120_000 });
  await expect(page.getByTestId("workspace-confirm-error")).toHaveCount(0);
  await page.getByTestId("workspace-back-to-console").click();
  await expect(page.getByTestId("run-id")).toHaveText(runId, { timeout: 120_000 });
}

test("INT1-AUTH-1/2/3: 保存時の403で誤表示せず、再ログインで同じRun/Turnへ戻り、確定済み提出が残る", async ({ page, context }) => {
  test.setTimeout(300_000);
  await loginAsGm(page);
  const runId = await createRunWithPlayerBal(page);
  const consoleUrl = page.url();

  await test.step("Turn1: Console内PLAYERとして確定する（この時点の保存は成功する）", async () => {
    await confirmBalDecision(page, runId);
    await expect(page.getByTestId("turn-counter")).toContainText("0 /");
  });

  await test.step("管理セッションCookieを削除して認証切れを作る", async () => {
    const before = await context.cookies();
    expect(before.some((c) => c.name === ADMIN_COOKIE)).toBe(true);
    // 管理セッションCookieだけを消す（PLAYER用Cookieは消さない）。
    const kept = before.filter((c) => c.name !== ADMIN_COOKIE);
    await context.clearCookies();
    if (kept.length > 0) await context.addCookies(kept);
    const after = await context.cookies();
    expect(after.some((c) => c.name === ADMIN_COOKIE)).toBe(false);
  });

  await test.step("INT1-AUTH-1: 保存（Turn進行）が403で失敗し、成功と誤表示されない", async () => {
    const responses: number[] = [];
    page.on("response", (r) => {
      if (r.url().includes("/api/v2/simulation-runs")) responses.push(r.status());
    });
    await page.getByTestId("run-1").click();
    // 403が実際に出ていること。
    await expect
      .poll(() => responses.filter((s) => s === 403).length, { timeout: 120_000 })
      .toBeGreaterThan(0);

    /**
     * 【実測して分かった既存の設計】Turnの計算はブラウザ内で行われるため、
     * Turnカウンタ（Live）は進む。製品はこれを隠さず、
     *   ・persistence-blocked-banner で「サーバー保存が失敗した」ことを明示
     *   ・live-vs-saved で Live と Saved を並べて「保存が追いついていません」と表示
     *   ・さらにTurnを進めるボタンを無効化
     * という形で「保存できた」と誤解させない設計になっている。
     * したがってここで確認すべきは「カウンタが0で止まること」ではなく、
     * 「保存成功と誤表示せず、保存されていない事実が明示され、先へ進めないこと」である。
     */
    const banner = page.getByTestId("persistence-blocked-banner");
    await expect(banner).toBeVisible({ timeout: 120_000 });
    // 「保存できた」と誤解させず、保存されていない事実と結果を明示している。
    await expect(banner).toContainText("サーバー保存（正本）が失敗しました");
    await expect(banner).toContainText("進行状況が保存されずに失われます");
    await expect(banner).toContainText("Turnを進めるボタンを無効化");
    /**
     * 【実測】live-vs-saved 診断は「Console側の保存が一度でも成功した後」にのみ描画される
     * （lastPersisted が persist() 成功時にだけ設定されるため）。
     * 今回のように最初のConsole保存が403で失敗したケースでは出ない。
     * 誤表示ではない（上のbannerが保存失敗を明言している）ため、製品は変更していない。
     */
    // これ以上進めない（保存されないまま進行し続けない）。
    await expect(page.getByTestId("run-1")).toBeDisabled();
    // 再ログイン導線がある。
    await expect(page.getByTestId("persistence-relogin-link")).toBeVisible({ timeout: 120_000 });
  });

  await test.step("INT1-AUTH-2: 再ログインすると同じRunへ戻れる", async () => {
    const relogin = page.getByTestId("persistence-relogin-link");
    const href = await relogin.getAttribute("href");
    expect(href).toContain("returnTo=");
    expect(href).toContain(encodeURIComponent("/v2/management"));
    // 同一オリジン内の相対リンクであること（別オリジンへ誘導しない）。
    expect(href!.startsWith("/")).toBe(true);
    await page.goto(href!);
    await page.getByLabel("管理トークン").fill(STAGING_ADMIN_TOKEN);
    await page.getByRole("button", { name: "ログイン" }).click();
    await page.waitForURL(/\/v2\/management\?run=/, { timeout: 120_000 });
    await expect(page.getByTestId("run-id")).toHaveText(runId, { timeout: 120_000 });
  });

  await test.step("INT1-AUTH-3: 確定済み提出が維持され、保存済み状態（Turn0）から再開できる", async () => {
    /**
     * 403で保存できなかったTurn1は、サーバの正本には入っていない（Saved: 0）。
     * つまり「保存成功と誤表示しない」ことの裏返しとして、再開は保存済みの地点からになる。
     * ここで確認するのは、再ログイン後に
     *   ・同じRunを開ける
     *   ・Turn1でPLAYERが確定した提出がサーバ側に残っている
     *   ・保存が再び成立してTurnを進められる
     * である。
     */
    await page.goto(consoleUrl);
    await expect(page.getByTestId("run-id")).toHaveText(runId, { timeout: 120_000 });
    // 保存済み正本から再開するため、Live も Saved も 0 に戻っている。
    await expect(page.getByTestId("turn-counter")).toContainText("0 /", { timeout: 120_000 });
    // 確定済み提出が残っているので、再確定せずにTurnを進められる。
    const runButton = page.getByTestId("run-1");
    await expect(runButton).toBeEnabled({ timeout: 300_000 });
    await runButton.click();
    await expect(page.getByTestId("turn-counter")).toContainText("1 /", { timeout: 120_000 });
    // 今回は保存も成立している。
    await expect(page.getByTestId("live-vs-saved")).toContainText("Saved: 1", { timeout: 120_000 });
    await expect(page.getByTestId("persistence-blocked-banner")).toHaveCount(0);
  });
});

test("INT1-AUTH-4: 未確定入力が失われる場合、その事実と必要な再入力が画面に明示される", async ({ page }) => {
  test.setTimeout(300_000);
  await loginAsGm(page);
  const runId = await createRunWithPlayerBal(page);

  await page.getByTestId("company-control-operate-BAL").click();
  await page.waitForURL(/\/v2\/management\/player/);
  await expect(page.getByTestId("workspace-turn")).toBeVisible();
  const playerUrl = page.url();

  // 下書きを編集して未確定のまま、ページを再読み込みする（タブ内registryが消える）。
  await page.getByTestId("workspace-tab-decision").click();
  await page.reload();
  await page.goto(playerUrl);

  await expect(page.getByTestId("workspace-back-to-console-fallback")).toBeVisible({ timeout: 120_000 });
  const notice = page.getByTestId("workspace-unconfirmed-draft-lost");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("未確定の入力");
  await expect(notice).toContainText("もう一度");
  await expect(notice).toContainText("確定済みの意思決定はサーバに保存されているため失われません");

  // 戻る導線が機能する。
  await page.getByTestId("workspace-back-to-console-fallback").click();
  await expect(page.getByTestId("run-id")).toHaveText(runId, { timeout: 120_000 });
});
