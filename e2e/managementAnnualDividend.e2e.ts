// ShrimpX V2 — 年間純利益ベース配当: Management Console 表示のE2E
//
// 【何を検証するか】Engineが年度末（Q4）決算後に確定させた annualSettlement を、
// 画面が**そのまま転記**しているかどうか。UI側で配当額・配当性向を計算し直して
// いないことを、実ブラウザで確認する。
//
// 【なぜ手動50%/100%指定を使うのか】現在のStandard AI parameterから率を逆算して
// 表示する実装だと、手動指定した率（50%）ではなく既定の実効率（約15%）が出る。
// 手動指定値がそのまま出ることが、「再計算していない」ことの最も直接的な証拠になる。
//
// 共有Redisは使わない（V2_API_E2E_IN_MEMORY=1 の隔離環境）。
// 新しい巨大シナリオは作らず、既存のSetup→Run→Turn進行の経路を4Turnだけ使う
// （Turn4が年度末Q4であり、年間精算が1回発生する最小の長さ）。

import { test, expect, type Page } from "@playwright/test";

const STAGING_ADMIN_TOKEN = "e2e-test-token";

async function loginAsGm(page: Page): Promise<void> {
  const returnTo = encodeURIComponent("/v2/management/setup");
  await page.goto(`/v2/company-lab/play/login?returnTo=${returnTo}`);
  await page.getByLabel("管理トークン").fill(STAGING_ADMIN_TOKEN);
  await page.getByRole("button", { name: "ログイン" }).click();
  await page.waitForURL(/\/v2\/management\/setup/);
}

async function openBalancePanel(page: Page): Promise<void> {
  const toggle = page.getByTestId("console-balance-adjustment-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(page.getByTestId("balance-apply")).toBeVisible();
}

async function openAnnualDividendPanel(page: Page): Promise<void> {
  const toggle = page.getByTestId("console-annual-dividend-toggle");
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
}

/** "12.34M" のような表示から数値（百万USD）を読む。 */
function parseMillions(text: string): number {
  const match = text.trim().match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : Number.NaN;
}

/**
 * 1行ぶんのセルを列名つきで読む（列順はパネルのthead定義と対応）。
 *
 * 【D1 §9で列が増えた】「操作主体」「管理者指定」「処理状態」の3列が加わったため、
 * 列indexを更新している（値の意味は変えていない）。
 */
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
 * 全社Standard AIのまま新しいRunを開始する（Setup画面の既定のまま開始ボタンを押すだけ）。
 *
 * 【loginAsGm を重ねて呼ばないこと】管理ログインrouteは既に認証済みの場合
 * returnTo へ自動的に戻すため、2回目以降は管理トークン入力欄が表示されない。
 * ログインは各テストの先頭で1回だけ行い、以後はこの関数でRunを作る。
 */
async function startRun(page: Page): Promise<string> {
  await page.goto("/v2/management/setup");
  await page.getByTestId("setup-start-button").click();
  await page.waitForURL(/\/v2\/management\?run=/);
  const runId = new URL(page.url()).searchParams.get("run");
  expect(runId).toBeTruthy();
  return runId!;
}

/** 現在開いているRunへ配当性向を継続適用し、年度末Q4（Turn4）まで進める。 */
async function applyPayoutAndAdvanceToQ4(page: Page, payoutPercent: string): Promise<void> {
  await openBalancePanel(page);
  await page.getByTestId("balance-dividend-percent").fill(payoutPercent);
  await page.getByTestId("balance-mode").selectOption("continuing");
  await page.getByTestId("balance-apply").click();
  await expect(page.getByTestId("balance-state-saved")).toBeVisible();

  // Turn4が年度末Q4。ここで年間精算が1回走る。
  await page.getByTestId("run-4").click();
  await expect(page.getByTestId("turn-counter")).toContainText("4 /", { timeout: 300_000 });
}

// =====================================================================

test("AD-E2E-1: 年度末Q4の精算実績が、Engine記録どおりの値で表示される（手動50%）", async ({ page }) => {
  test.setTimeout(600_000);

  // --- A. Q4未到達の時点では、実支払0と誤表示しない ---
  await loginAsGm(page);
  const runId = await startRun(page);
  await openAnnualDividendPanel(page);
  // 表の行ではなく「まだ年度末に到達していない」という説明が出ること。
  const empty = page.getByTestId("annual-dividend-empty");
  await expect(empty).toBeVisible();
  await expect(empty).toContainText("まだ年度末（Q4）に到達していない");
  await expect(page.getByTestId("annual-dividend-panel")).toHaveCount(0);

  // --- B. 同じRunへ50%を継続適用し、Q4まで進める ---
  await applyPayoutAndAdvanceToQ4(page, "50");

  // --- C. パネルに年度末精算が出る ---
  await openAnnualDividendPanel(page);
  await expect(page.getByTestId("annual-dividend-panel")).toBeVisible();

  // BALは baseline/4Turn で必ず精算される会社（policy gateを通る）。
  const bal = await readRow(page, "annual-dividend-row-4-BAL");

  // --- D. 各項目がEngine記録どおりであること ---
  // 対象年度: Turn4は初年度のQ4。年度は4桁の西暦として表示される。
  expect(bal.year).toMatch(/^\d{4}$/);
  expect(bal.companyId).toBe("BAL");

  // 【再計算していないことの証拠1】手動指定した50.0%がそのまま出る。
  // UIが現在のStandard AI parameterから逆算していれば約15%になるため、
  // この1点で「転記であって再計算ではない」ことが判別できる。
  expect(bal.payoutRatioText).toBe("50.0%");
  expect(bal.source).toBe("管理者の手動指定");

  // 年間純利益が正で、年間配当目標＝年間純利益×50%になっている。
  expect(bal.annualNetIncomeM).toBeGreaterThan(0);
  expect(Math.abs(bal.annualTargetM - bal.annualNetIncomeM * 0.5)).toBeLessThan(0.02);

  // 同年度支払済みは0（この年度はQ4の精算が初回の配当）。
  expect(bal.paidEarlierM).toBe(0);

  // 今回実支払＝年間配当目標−同年度支払済み（資金制約に当たっていない会社）。
  expect(Math.abs(bal.appliedM - (bal.annualTargetM - bal.paidEarlierM))).toBeLessThan(0.02);

  // 未達なし。理由は「－」で、0を理由として誤表示しない。
  expect(bal.shortfallM).toBe(0);
  expect(bal.shortfallReason).toBe("－");

  // --- E. 管理者指定がある年度は、AIの任意gateで見送られない（D1で変わった挙動） ---
  // 【変更前の期待値】以前このテストは「MASSの行自体が出ないこと」を固定していた。
  // baseline/4Turn ではMASSがStandard AIの任意gateで配当を見送っていたためである。
  // D1で「管理者が明示指定した配当性向は全対象会社への配当義務」と定義したので、
  // 管理者50%を適用した今のRunではMASSも精算対象になる。行が出ること自体が
  // D1の受入条件であり、ここは期待値を更新している（見送りの表示契約は
  // 「管理者設定なし」の場合として D1-23b のunit testが固定する）。
  const mass = await readRow(page, "annual-dividend-row-4-MASS");
  expect(mass.companyId).toBe("MASS");
  expect(mass.payoutRatioText).toBe("50.0%");
  expect(mass.source).toBe("管理者の手動指定");

  // --- F. Q1〜Q3は精算対象ではないので行が出ない ---
  for (const turn of [1, 2, 3]) {
    await expect(page.getByTestId(`annual-dividend-row-${turn}-BAL`)).toHaveCount(0);
  }

  // --- G. reload後も同じ実績が残る（画面が持っているのではなくRunの記録である） ---
  await page.reload();
  await expect(page.getByTestId("run-id")).toHaveText(runId, { timeout: 120_000 });
  await openAnnualDividendPanel(page);
  const afterReload = await readRow(page, "annual-dividend-row-4-BAL");
  expect(afterReload).toEqual(bal);
});

test("AD-E2E-2: 資金制約で年間目標に届かない場合、未達額と理由が表示される（CASH_LIMIT）", async ({ page }) => {
  test.setTimeout(600_000);

  // 配当性向100%にすると、年間配当目標＝年間純利益となり、
  // 現金の方が小さい会社で資金制約が発生する（実測で JPQ / VAP が該当）。
  await loginAsGm(page);
  await startRun(page);
  await applyPayoutAndAdvanceToQ4(page, "100");
  await openAnnualDividendPanel(page);
  await expect(page.getByTestId("annual-dividend-panel")).toBeVisible();

  const jpq = await readRow(page, "annual-dividend-row-4-JPQ");
  expect(jpq.payoutRatioText).toBe("100.0%");
  expect(jpq.source).toBe("管理者の手動指定");

  // 【再計算していないことの証拠2】目標と実支払が別の値として出ている。
  // UIが「目標」を実支払から逆算していたり、実支払を目標で置き換えていたりすれば、
  // この2つは一致してしまう。
  expect(jpq.annualTargetM).toBeGreaterThan(jpq.appliedM);

  // 未達額 = 年間配当目標 − 今回実支払（同年度支払済みは0）。
  expect(jpq.shortfallM).toBeGreaterThan(0);
  expect(Math.abs(jpq.shortfallM - (jpq.annualTargetM - jpq.appliedM))).toBeLessThan(0.02);

  // 理由が現金上限であることが日本語で示される。
  expect(jpq.shortfallReason).toBe("現金の上限に達した");

  // 対照: 資金制約に当たっていない会社では未達0・理由「－」のまま
  // （常に未達が表示されるわけではないことを固定する）。
  const bal = await readRow(page, "annual-dividend-row-4-BAL");
  expect(bal.shortfallM).toBe(0);
  expect(bal.shortfallReason).toBe("－");
  expect(Math.abs(bal.appliedM - bal.annualTargetM)).toBeLessThan(0.02);
});
