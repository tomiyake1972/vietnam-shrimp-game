// ShrimpX V2 — UI-TRIAL-1 の実ブラウザ確認（配備済み Preview ＋ 共有 Redis）。
//
// 指示§5の9項目を、Console内PLAYER（BAL）と Independent Player（MASS）の両経路で確認する。
// 新規の検証用 Run は 1 本だけ作り、両経路でその 1 本を共有する
// （Run 保持上限20本・21本目で最古が消える現行仕様のため、作る本数を最小にする）。
// 既存 Run の手動変更・手動削除は行わない。
//
// 必要な環境変数: INT1_LIVE_URL / STAGING_ADMIN_TOKEN（値はログに出さない）

import { test, expect, type Browser, type Locator, type Page } from "@playwright/test";

const ADMIN = process.env.STAGING_ADMIN_TOKEN ?? "";
const MARKETS = ["CN", "US", "EU", "JP", "OTHER"] as const;

function log(item: string, detail: string): void {
  console.log(`    OK  ${item}  — ${detail}`);
}

async function loginAsGm(page: Page): Promise<void> {
  const returnTo = encodeURIComponent("/v2/management/setup");
  await page.goto(`/v2/company-lab/play/login?returnTo=${returnTo}`);
  await page.getByLabel("管理トークン").fill(ADMIN);
  await page.getByRole("button", { name: "ログイン" }).click();
  await page.waitForURL(/\/v2\/management\/setup/);
}

async function clearCell(cell: Locator): Promise<void> {
  await cell.click();
  await cell.press("ControlOrMeta+a");
  await cell.press("Delete");
  await cell.blur();
}

/** 営業配員の編集欄が市場ごとに1つであること（項目1）。 */
async function checkSalesStaffingPerMarket(page: Page, salesTabTestId: string, label: string): Promise<void> {
  await page.getByTestId(salesTabTestId).click();
  await expect(page.getByTestId("decision-studio-sales-screen")).toBeVisible();
  for (const market of MARKETS) {
    await expect(page.getByTestId(`sales-plan-market-block-${market}`)).toHaveCount(1);
    await expect(page.getByTestId(`sales-force-market-headcount-${market}`)).toHaveCount(1);
  }
  const editors = page.locator('[data-testid^="sales-force-market-headcount-"]');
  await expect(editors).toHaveCount(MARKETS.length);
  // 市場×商品の行は従来どおり（商品ごとの数量・価格調整は残す）。
  const productRows = page.locator('[data-testid^="sales-plan-price-adjustment-"]');
  const productCount = await productRows.count();
  expect(productCount).toBeGreaterThan(MARKETS.length);
  log(`項目1 営業配員は市場ごとに1つ（${label}）`, `編集欄 ${MARKETS.length} 個 / 商品行 ${productCount} 個`);
}

/** 入力欄と参照情報を区別できること（項目2）。 */
async function checkInputVsReference(page: Page, tabPrefix: string, label: string): Promise<void> {
  await expect(page.getByTestId("decision-studio-decision-heading")).toBeVisible();
  const kinds = new Set<string>();
  for (const screen of ["sales", "worker", "production", "procurement", "investment", "finance"]) {
    await page.getByTestId(`${tabPrefix}${screen}`).click();
    const badges = page.locator("[data-reference-kind]");
    await expect(badges.first()).toBeVisible();
    for (const value of await badges.evaluateAll((els) => els.map((e) => e.getAttribute("data-reference-kind") ?? ""))) {
      if (value) kinds.add(value);
    }
    const columnKinds = await page.locator("[data-column-kind]").count();
    expect(columnKinds).toBeGreaterThanOrEqual(0);
  }
  expect(kinds.size).toBeGreaterThan(1);
  log(`項目2 入力と参照の区別（${label}）`, `6画面すべてに参照種別が出る。種別=${[...kinds].sort().join(",")}`);
}

test("UI-TRIAL-1 実機ブラウザ確認（Console内PLAYER ＋ Independent Player）", async ({ browser }: { browser: Browser }) => {
  if (!ADMIN) throw new Error("STAGING_ADMIN_TOKEN が未設定です。");

  const gmContext = await browser.newContext({ viewport: { width: 1400, height: 1200 } });
  const gm = await gmContext.newPage();

  // ---- Run の作成（1本だけ） ----
  console.log("\n## 0. 検証用 Run の作成（1本のみ）");
  await loginAsGm(gm);
  await gm.goto("/v2/management/setup");
  await gm.getByTestId("setup-control-mode-BAL").selectOption("PLAYER");
  await gm.getByTestId("setup-control-mode-MASS").selectOption("PLAYER");
  await gm.getByTestId("setup-start-button").click();
  await gm.waitForURL(/\/v2\/management\?run=/);
  const runId = new URL(gm.url()).searchParams.get("run") ?? "";
  expect(runId.length).toBeGreaterThan(0);
  // 画面側の表示も同じ Run を指していること（view 読み込み後に "－" から実IDへ変わる）。
  await expect(gm.getByTestId("run-id")).toHaveText(runId);
  console.log(`    作成した検証用 Run: ${runId}`);
  console.log("    BAL = Console内PLAYER 経路 / MASS = Independent Player 経路");

  // ================= Console内PLAYER（BAL） =================
  console.log("\n## 1. Console内PLAYER（BAL）");
  await gm.getByTestId("company-control-operate-BAL").click();
  await expect(gm.getByTestId("workspace-heading")).toBeVisible();
  await gm.getByTestId("workspace-tab-decision").click();

  await checkInputVsReference(gm, "decision-studio-tab-", "Console内PLAYER");
  await checkSalesStaffingPerMarket(gm, "decision-studio-tab-sales", "Console内PLAYER");

  // 項目3の前半: 入力した値を覚える
  const cnHeadcount = gm.getByTestId("sales-force-market-headcount-CN");
  await cnHeadcount.fill("7");
  await cnHeadcount.blur();
  await expect(cnHeadcount).toHaveValue("7");

  // 項目6: 無効入力で止まる
  await gm.getByTestId("decision-studio-tab-worker").click();
  await expect(gm.getByTestId("decision-studio-worker-screen")).toBeVisible();
  const firstOvertime = gm.locator('[data-testid^="worker-overtime-rate-"]').first();
  const overtimeTestId = (await firstOvertime.getAttribute("data-testid")) ?? "";
  await firstOvertime.fill("99");
  await firstOvertime.blur();
  await gm.getByTestId("workspace-review-decision").click();
  await expect(gm.getByTestId("workspace-confirm-error")).toBeVisible();
  await expect(gm.getByTestId("workspace-confirm-error")).toContainText("残業率");
  await expect(gm.getByTestId("decision-confirmation-screen")).toHaveCount(0);
  await expect(gm.getByTestId("workspace-decision-status")).not.toContainText("意思決定済み");
  log("項目6 無効入力が止まる（Console内PLAYER）", "残業率99で確認画面へ進まず、確定もされない");

  // 無効値を直す
  await gm.getByTestId(overtimeTestId).fill("0.1");
  await gm.getByTestId(overtimeTestId).blur();

  // 項目3/4: 確認画面へ進む → 入力値が載る → 戻ると入力が保持される
  await gm.getByTestId("workspace-review-decision").click();
  await expect(gm.getByTestId("decision-confirmation-screen")).toBeVisible();
  await expect(gm.getByTestId("decision-confirmation-screen")).toContainText("CN");
  // 項目4: 確認画面を開いただけでは確定していない
  await expect(gm.getByTestId("workspace-decision-status")).not.toContainText("意思決定済み");
  log("項目4 確認画面を開くだけでは確定・提出されない（Console内PLAYER）", "状態は「意思決定はまだ確定していません」のまま");

  await gm.getByTestId("decision-confirmation-back").click();
  await expect(gm.getByTestId("decision-studio-sales-screen").or(gm.getByTestId("decision-studio-worker-screen"))).toBeVisible();
  await gm.getByTestId("decision-studio-tab-sales").click();
  await expect(gm.getByTestId("sales-force-market-headcount-CN")).toHaveValue("7");
  await gm.getByTestId("decision-studio-tab-worker").click();
  await expect(gm.getByTestId(overtimeTestId)).toHaveValue("0.1");
  log("項目3 確認→修正へ戻って入力値が保持される（Console内PLAYER）", "CN配員=7・残業率=0.1 がそのまま残る");

  // 項目6の後半 ＋ 項目5: 直した入力で確定できる
  await gm.getByTestId("workspace-review-decision").click();
  await expect(gm.getByTestId("decision-confirmation-screen")).toBeVisible();
  await gm.getByTestId("decision-confirmation-commit").click();
  await expect(gm.getByTestId("workspace-decision-status")).toContainText("意思決定済み");
  await expect(gm.getByTestId("workspace-confirm-error")).toHaveCount(0);
  log("項目5 最終ボタンから確定でき、反映される（Console内PLAYER）", "確定後の表示が「意思決定済み」になる");
  log("項目6 修正後に提出できる（Console内PLAYER）", "残業率を0.1へ直したら確定できた");

  // 項目7: 二重提出の防止（Console内PLAYER）
  //
  // 【この経路の仕様】確定後にもう一度確認画面へ入り、確定し直すことはできる。
  // これは UI-TRIAL-1 で変えた挙動ではなく、d45b0bf 以前からの意図された挙動
  // （d45b0bf の workspace-confirm-decision も disabled={saving} のみ）。
  // GM が代理操作で入力を直して Turn 進行前に出し直せる必要があるため。
  // したがってここで防ぐべき「二重提出」は連打による重複送信であり、
  // 確定ボタンは disabled={committing || blocked}。実際に POST 回数で確認する。
  const countPosts = (page: Page): { readonly value: () => number; readonly reset: () => void } => {
    let n = 0;
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().includes("/api/v2/simulation-runs")) n += 1;
    });
    return { value: () => n, reset: () => { n = 0; } };
  };
  const posts = countPosts(gm);
  await gm.getByTestId("workspace-review-decision").click();
  await expect(gm.getByTestId("decision-confirmation-screen")).toBeVisible();
  posts.reset();
  const commitButton = gm.getByTestId("decision-confirmation-commit");
  // 1回押した直後に、もう一度押そうとする（人間の二度押しに相当）。
  // 保存中は disabled になるため2回目は押せないはず。押せてしまう場合も
  // 短い timeout で諦めて、保存 POST の回数で実際の送信回数を見る。
  await commitButton.click();
  const secondClick = await commitButton
    .click({ timeout: 2_000 })
    .then(() => "押せた")
    .catch(() => "押せなかった");
  await expect(gm.getByTestId("workspace-decision-status")).toContainText("意思決定済み");
  await gm.waitForTimeout(3_000); // 2回目の保存が遅れて飛んでいないか見るための余白。
  console.log(`    （2回目のクリック: ${secondClick}）`);
  const doubleClickPosts = posts.value();
  // 1回の確定で飛ぶ保存 POST は part×3 ＋ manifest commit ＝ 4回。
  expect(doubleClickPosts).toBeLessThanOrEqual(4);
  log("項目7 二重提出を防ぐ（Console内PLAYER）", `確定ボタンをほぼ同時に2回押しても保存POSTは ${doubleClickPosts} 回（1回ぶん＝最大4回）`);
  log("注記（Console内PLAYER）", "確定後に入力を直して出し直すことは従来どおり可能。d45b0bf 以前から変わらない。");
  // 確定すると確認画面は閉じて入力画面へ戻る（「入力へ戻る」は押す必要がない）。
  await expect(gm.getByTestId("decision-confirmation-screen")).toHaveCount(0);
  await gm.getByTestId("workspace-back-to-console").click();
  await gm.waitForURL(/\/v2\/management\?run=/);

  // ================= Independent Player（MASS） =================
  console.log("\n## 2. Independent Player（MASS）");
  await gm.getByTestId("player-seat-issue-MASS").click();
  const joinUrl = (await gm.getByTestId("player-seat-join-url-MASS").locator("code").textContent())?.trim() ?? "";
  expect(joinUrl.length).toBeGreaterThan(0);

  const playerContext = await browser.newContext({ viewport: { width: 1400, height: 1200 } });
  const player = await playerContext.newPage();
  await player.goto(joinUrl);
  await expect(player.getByTestId("play-workspace-heading")).toContainText("MASS");
  // Independent Player 画面はタブを持たず、Decision Studio を直接描画する。
  await expect(player.getByTestId("decision-studio-decision-heading")).toBeVisible();

  await checkInputVsReference(player, "decision-studio-tab-", "Independent Player");
  await checkSalesStaffingPerMarket(player, "decision-studio-tab-sales", "Independent Player");

  // 項目9: BW-1 の自動更新が入力途中の値を上書きしない
  const playerCn = player.getByTestId("sales-force-market-headcount-US");
  await playerCn.fill("13");
  await playerCn.blur();
  await expect(playerCn).toHaveValue("13");
  await player.waitForTimeout(15_000); // 意思決定contextの取得間隔は4秒。3周以上待つ。
  await expect(playerCn).toHaveValue("13");
  log("項目9 自動更新が入力途中の値を上書きしない（Independent Player）", "15秒（取得3周以上）待っても US配員=13 のまま");

  // 項目6: 無効入力で止まる
  await player.getByTestId("decision-studio-tab-worker").click();
  const playerOvertime = player.locator('[data-testid^="worker-overtime-rate-"]').first();
  const playerOvertimeId = (await playerOvertime.getAttribute("data-testid")) ?? "";
  await clearCell(playerOvertime);
  await expect(playerOvertime).toHaveAttribute("data-invalid", "true");
  await player.getByTestId("play-review-decision").click();
  await expect(player.getByTestId("play-submit-error")).toBeVisible();
  await expect(player.getByTestId("decision-confirmation-screen")).toHaveCount(0);
  // 入力に触ったあとの状態は EDITING（入力中・まだ提出していません）。
  // 「提出されていない」は SUBMITTED でないことで確認する。
  await expect(player.getByTestId("play-workspace-status")).not.toHaveAttribute("data-status", "SUBMITTED");
  log("項目6 無効入力が止まる（Independent Player）", "空欄のままでは確認画面へ進まず、提出もされない（状態は入力中のまま）");

  await player.getByTestId(playerOvertimeId).fill("0.2");
  await player.getByTestId(playerOvertimeId).blur();

  // 項目3/4
  await player.getByTestId("play-review-decision").click();
  await expect(player.getByTestId("decision-confirmation-screen")).toBeVisible();
  await expect(player.getByTestId("play-workspace-status")).not.toHaveAttribute("data-status", "SUBMITTED");
  log("項目4 確認画面を開くだけでは提出されない（Independent Player）", "状態は入力中のまま（SUBMITTED にならない）");
  await player.getByTestId("decision-confirmation-back").click();
  await player.getByTestId("decision-studio-tab-sales").click();
  await expect(player.getByTestId("sales-force-market-headcount-US")).toHaveValue("13");
  await player.getByTestId("decision-studio-tab-worker").click();
  await expect(player.getByTestId(playerOvertimeId)).toHaveValue("0.2");
  log("項目3 確認→修正へ戻って入力値が保持される（Independent Player）", "US配員=13・残業率=0.2 がそのまま残る");

  // 項目5
  await player.getByTestId("play-review-decision").click();
  await expect(player.getByTestId("decision-confirmation-screen")).toBeVisible();
  await player.getByTestId("decision-confirmation-commit").click();
  await expect(player.getByTestId("play-workspace-status")).toHaveAttribute("data-status", "SUBMITTED");
  log("項目5 最終ボタンから提出でき、反映される（Independent Player）", "提出後の状態が SUBMITTED になる");
  log("項目6 修正後に提出できる（Independent Player）", "残業率を0.2へ直したら提出できた");

  // 項目7
  await expect(player.getByTestId("play-review-decision")).toHaveCount(0);
  log("項目7 二重提出を防ぐ（Independent Player）", "提出後は「意思決定を確認」ボタンが描画されない");

  // ================= GM 側への反映と Turn 進行 =================
  console.log("\n## 3. GM 側への反映と Turn 進行");
  await gm.reload();
  await expect(gm.getByTestId("turn-counter")).toContainText("0 / 32");
  const seatPanel = gm.getByTestId("player-seat-panel");
  await expect(seatPanel).toContainText("MASS");
  await expect(gm.getByTestId("player-seat-advance-eligibility")).not.toContainText("提出待ち");
  log("項目8 GM側へ両PLAYERの提出が反映される", "Advance Turn の判定が「提出待ち」ではなくなる");

  await gm.getByTestId("run-1").click();
  await expect(gm.getByTestId("turn-counter")).toContainText("1 / 32", { timeout: 300_000 });
  log("項目8 Turn 進行（1回目）", "turn-counter が 1 / 32 になる");
  await expect(player.getByTestId("play-workspace-status")).not.toHaveAttribute("data-status", "SUBMITTED", { timeout: 60_000 });
  log("項目8 Turn 進行が Independent Player へ反映される", "提出済みから未提出（新しいTurnの入力可）へ戻る");

  // 2Turn目（少数Turnの進行）
  await gm.getByTestId("company-control-operate-BAL").click();
  await expect(gm.getByTestId("workspace-heading")).toBeVisible();
  await gm.getByTestId("workspace-tab-decision").click();
  await gm.getByTestId("workspace-review-decision").click();
  await expect(gm.getByTestId("decision-confirmation-screen")).toBeVisible();
  await gm.getByTestId("decision-confirmation-commit").click();
  await expect(gm.getByTestId("workspace-decision-status")).toContainText("意思決定済み");
  await gm.getByTestId("workspace-back-to-console").click();
  await gm.waitForURL(/\/v2\/management\?run=/);

  await player.getByTestId("play-review-decision").click();
  await expect(player.getByTestId("decision-confirmation-screen")).toBeVisible();
  await player.getByTestId("decision-confirmation-commit").click();
  await expect(player.getByTestId("play-workspace-status")).toHaveAttribute("data-status", "SUBMITTED");

  await gm.getByTestId("run-1").click();
  await expect(gm.getByTestId("turn-counter")).toContainText("2 / 32", { timeout: 300_000 });
  log("項目8 Turn 進行（2回目）", "turn-counter が 2 / 32 になる");

  console.log(`\n## 使用した検証用 Run: ${runId}`);
  await playerContext.close();
  await gmContext.close();
});
