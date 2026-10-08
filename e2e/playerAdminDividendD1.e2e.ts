// ShrimpX V2 — D1: 管理者指定配当をPLAYER含む全社へ共通強制精算する（browser E2E）
//
// 【AIだけのE2Eでは受入不可】D1で直すのは「PLAYERが操作している会社だけ年度末精算の
// コードパスに入らない」という欠陥である。全社Standard AIのE2Eでは、直っていなくても
// 通ってしまう。そのため
//   D1-21: Management Console内のPLAYER Workspaceから提出したRun
//   D1-22: 別browser context（別端末相当）のIndependent Playerが提出したRun
// の2経路を、実ブラウザで別々に確認する。
//
// 共有Redisは使わない（V2_API_E2E_IN_MEMORY=1 の隔離環境）。
// Turn4が年度末Q4であり、年間精算が1回発生する最小の長さ。

import { test, expect, type Browser, type Page } from "@playwright/test";

const STAGING_ADMIN_TOKEN = "e2e-test-token";
const ADMIN_PAYOUT_PERCENT = "50";

async function loginAsGm(page: Page): Promise<void> {
  // 【loginAsGmを重ねて呼ばないこと】管理ログインrouteは既に認証済みの場合
  // returnToへ自動的に戻すため、2回目以降は管理トークン入力欄が表示されない。
  const returnTo = encodeURIComponent("/v2/management/setup");
  await page.goto(`/v2/company-lab/play/login?returnTo=${returnTo}`);
  await page.getByLabel("管理トークン").fill(STAGING_ADMIN_TOKEN);
  await page.getByRole("button", { name: "ログイン" }).click();
  await page.waitForURL(/\/v2\/management\/setup/);
}

/** BALをPLAYERにしてRunを作る（他4社はStandard AIのまま）。 */
async function createRunWithPlayerBal(page: Page): Promise<string> {
  await page.goto("/v2/management/setup");
  await page.getByTestId("setup-control-mode-BAL").selectOption("PLAYER");
  await page.getByTestId("setup-start-button").click();
  await page.waitForURL(/\/v2\/management\?run=/);
  const runId = new URL(page.url()).searchParams.get("run");
  expect(runId).toBeTruthy();
  return runId!;
}

/** 管理者の配当性向を継続適用する（Turn1以降ずっと有効）。 */
async function applyAdminPayout(page: Page, percent: string): Promise<void> {
  const toggle = page.getByTestId("console-balance-adjustment-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(page.getByTestId("balance-apply")).toBeVisible();
  await page.getByTestId("balance-dividend-percent").fill(percent);
  await page.getByTestId("balance-mode").selectOption("continuing");
  await page.getByTestId("balance-apply").click();
  await expect(page.getByTestId("balance-state-saved")).toBeVisible();
}

async function openAnnualDividendPanel(page: Page): Promise<void> {
  const toggle = page.getByTestId("console-annual-dividend-toggle");
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
}

function parseMillions(text: string): number {
  const match = text.trim().match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : Number.NaN;
}

/** 年度末パネルの1行を列名つきで読む（列順はAnnualDividendPanelのthead定義と対応）。 */
async function readRow(page: Page, testId: string) {
  const cells = await page.getByTestId(testId).locator("td").allInnerTexts();
  return {
    year: cells[0].trim(),
    companyId: cells[1].trim(),
    decisionOwner: cells[2].trim(),
    adminRatioText: cells[3].trim(),
    annualNetIncomeM: parseMillions(cells[4]),
    payoutRatioText: cells[5].trim(),
    source: cells[6].trim(),
    annualTargetM: parseMillions(cells[7]),
    paidEarlierM: parseMillions(cells[8]),
    appliedM: parseMillions(cells[9]),
    shortfallM: parseMillions(cells[10]),
    shortfallReason: cells[11].trim(),
    status: cells[12].trim(),
  };
}

/**
 * Turnを1つ進める。
 *
 * 【なぜretryするか】PLAYER会社がいるRunでは、GM Consoleが「PLAYERが提出済みである」
 * ことを認識する前にAdvanceを押すと、サーバー側のgateで拒否されてTurnが進まない
 * （実測: 4Turn目で "3 / 32" のまま停止した）。押し直せば進むため、
 * 「進むまで押す」ことでタイミング依存を取り除く。既にexpectedTurnへ達していれば
 * 押さないので、二重進行にはならない。
 */
async function advanceOneTurn(gmPage: Page, expectedTurn: number): Promise<void> {
  const counter = gmPage.getByTestId("turn-counter");
  const runButton = gmPage.getByTestId("run-1");
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    if (!(await counter.innerText()).includes(`${expectedTurn} /`)) {
      await expect(runButton).toBeEnabled({ timeout: 300_000 });
      await runButton.click();
      try {
        await expect(counter).toContainText(`${expectedTurn} /`, { timeout: 120_000 });
      } catch {
        continue; // 進まなかった（提出待ちgate）。次のattemptで押し直す。
      }
    }
    /**
     * 【カウンタ表示だけで次へ進まないこと】Consoleはターン処理直後にカウンタを更新し、
     * そのあとで保存（persist）を行う。保存中はAdvanceボタンがdisabledのままであり、
     * この保存は「消費済みのPLAYER意思決定（空）」を書き戻す。カウンタが変わった瞬間に
     * Playerが次Turnを提出すると、その提出が直後の保存で上書きされ、GMからは
     * 「未提出」に見えてTurnが進まなくなる（実測でD1-22の4Turn目が停止した原因）。
     * 保存完了＝ボタンが再びenabledになるまで待ってから次の提出へ進む。
     */
    await expect(runButton).toBeEnabled({ timeout: 300_000 });
    return;
  }
  await expect(counter).toContainText(`${expectedTurn} /`, { timeout: 120_000 });
}

/** FINANCE画面を開いて、年度中の配当参考表示（§8）を読む。 */
async function readYearInProgressGuidance(page: Page) {
  await page.getByTestId("decision-studio-tab-finance").click();
  const panel = page.getByTestId("annual-dividend-guidance");
  await expect(panel).toBeVisible();
  return {
    headline: (await page.getByTestId("annual-dividend-guidance-headline").innerText()).trim(),
    body: (await panel.innerText()).trim(),
    ytdNetIncome: (await page.getByTestId("annual-dividend-guidance-ytd-net-income").innerText()).trim(),
    referenceDividend: (await page.getByTestId("annual-dividend-guidance-reference-dividend").innerText()).trim(),
    payable: (await page.getByTestId("annual-dividend-guidance-payable").innerText()).trim(),
    cashAfter: (await page.getByTestId("annual-dividend-guidance-cash-after").innerText()).trim(),
  };
}

/** 年度末精算の行が「管理者指定どおりにPLAYER会社へ実行された」ことを確認する。 */
function expectSettledByAdminOverride(row: Awaited<ReturnType<typeof readRow>>) {
  expect(row.companyId).toBe("BAL");
  expect(row.decisionOwner).toBe("PLAYER");
  expect(row.adminRatioText).toBe("50.0%");
  // 【再計算していないことの証拠】手動指定した50.0%がそのまま出る。
  // UIが現在のStandard AI parameterから逆算していれば約15%になる。
  expect(row.payoutRatioText).toBe("50.0%");
  expect(row.source).toBe("管理者の手動指定");
  expect(row.annualNetIncomeM).toBeGreaterThan(0);
  expect(Math.abs(row.annualTargetM - row.annualNetIncomeM * 0.5)).toBeLessThan(0.02);
  // 【D1の核心】PLAYER会社でも実際に支払われている（記録だけ作って0で終わらない）。
  expect(row.appliedM).toBeGreaterThan(0);
  expect(row.status).not.toBe("記録なし（UNKNOWN・この機能より前のRun）");
}

// =====================================================================
// D1-21: Management Console内PLAYER
// =====================================================================

test("D1-21: Management Console内PLAYERが配当欄を触らなくても、管理者50%でQ4に自動精算される", async ({ page }) => {
  test.setTimeout(900_000);

  await loginAsGm(page);
  const runId = await createRunWithPlayerBal(page);
  await applyAdminPayout(page, ADMIN_PAYOUT_PERCENT);

  // --- A. PLAYER Workspaceで、年度中の参考表示が出る（§8） ---
  // 【page.gotoでWorkspaceを開かないこと】Console内PLAYER Workspaceは、GMのタブ内に
  // 保持されたlive session（liveSessionRegistry）から会社状態を読む。URL直打ちの
  // full page loadではそのタブ内stateが消えるため、Workspaceが開けない（実測で確認）。
  // Consoleの「この会社を操作」ボタン経由のclient-side遷移で開く。
  await page.getByTestId("company-control-operate-BAL").click();
  await expect(page.getByTestId("workspace-heading")).toBeVisible({ timeout: 120_000 });
  await page.getByTestId("workspace-tab-decision").click();
  const guidance = await readYearInProgressGuidance(page);
  expect(guidance.headline).toContain("50.0%");
  expect(guidance.body).toContain("Q4決算直後");
  expect(guidance.body).toContain("追加操作は不要");
  // 【予測を見せない】将来のQ4利益ではなく年初来実績であることを明示している。
  expect(guidance.body).toContain("年初来実績ベース参考額");

  // --- B. 配当額欄は0のまま、4Turn提出して進める ---
  // Turn1の意思決定は既に開いているWorkspaceでそのまま確定する。
  for (let turn = 1; turn <= 4; turn += 1) {
    if (turn > 1) {
      await page.getByTestId("company-control-operate-BAL").click();
      await expect(page.getByTestId("workspace-heading")).toBeVisible({ timeout: 120_000 });
      await page.getByTestId("workspace-tab-decision").click();
    }
    await page.getByTestId("workspace-confirm-decision").click();
    await page.getByTestId("workspace-back-to-console").click();
    await expect(page.getByTestId("run-id")).toHaveText(runId, { timeout: 120_000 });
    await advanceOneTurn(page, turn);
  }

  // --- C. 年度末パネルにPLAYER会社の精算が出る ---
  await openAnnualDividendPanel(page);
  await expect(page.getByTestId("annual-dividend-panel")).toBeVisible();
  const bal = await readRow(page, "annual-dividend-row-4-BAL");
  expectSettledByAdminOverride(bal);

  // --- D. reload後も同じ実績（画面が持っているのではなくRunの記録である） ---
  await page.reload();
  await expect(page.getByTestId("run-id")).toHaveText(runId, { timeout: 120_000 });
  await openAnnualDividendPanel(page);
  expect(await readRow(page, "annual-dividend-row-4-BAL")).toEqual(bal);
});

// =====================================================================
// D1-22: Independent Player（別browser context）
// =====================================================================

test("D1-22: 別端末のIndependent Playerでも、管理者50%がそのまま届きQ4に自動精算される", async ({ browser }: { browser: Browser }) => {
  test.setTimeout(900_000);

  // 【非cookie共有】GMとPlayerは別々のbrowser context（別端末・別browser相当）。
  // Playerのブラウザは GM Console のタブ内キャッシュへ一切触れられない。
  const gmContext = await browser.newContext();
  const playerContext = await browser.newContext();
  const gmPage = await gmContext.newPage();
  const playerPage = await playerContext.newPage();

  try {
    await loginAsGm(gmPage);
    await createRunWithPlayerBal(gmPage);
    await applyAdminPayout(gmPage, ADMIN_PAYOUT_PERCENT);

    // --- A. 参加リンクを発行して別contextでjoin ---
    await gmPage.getByTestId("player-seat-issue-BAL").click();
    const codeLocator = gmPage.getByTestId("player-seat-join-url-BAL").locator("code");
    await expect(codeLocator).toBeVisible();
    const joinUrl = (await codeLocator.textContent())!.trim();

    await playerPage.goto(joinUrl);
    await playerPage.waitForURL(/\/v2\/play\/workspace/);
    await expect(playerPage.getByTestId("play-workspace-heading")).toContainText("BAL");

    // --- B. Playerのブラウザに管理者指定が届いている（§8・別永続化経路でも同じ値） ---
    const guidance = await readYearInProgressGuidance(playerPage);
    expect(guidance.headline).toContain("50.0%");
    expect(guidance.body).toContain("Q4決算直後");
    expect(guidance.body).toContain("追加操作は不要");
    expect(guidance.body).toContain("年初来実績ベース参考額");

    // --- C. 配当欄を触らずに4Turn提出する ---
    for (let turn = 1; turn <= 4; turn += 1) {
      await expect(playerPage.getByTestId("play-workspace-status")).toHaveAttribute("data-status", "TURN_ACTIVE", { timeout: 120_000 });
      await playerPage.getByTestId("play-submit-decision").click();
      await expect(playerPage.getByTestId("play-waiting-for-gm")).toBeVisible();

      await advanceOneTurn(gmPage, turn);
      if (turn < 4) await playerPage.reload();
    }

    // --- D. 年度末パネルにPLAYER会社の精算が出る ---
    await openAnnualDividendPanel(gmPage);
    await expect(gmPage.getByTestId("annual-dividend-panel")).toBeVisible();
    expectSettledByAdminOverride(await readRow(gmPage, "annual-dividend-row-4-BAL"));
  } finally {
    await gmContext.close();
    await playerContext.close();
  }
});
