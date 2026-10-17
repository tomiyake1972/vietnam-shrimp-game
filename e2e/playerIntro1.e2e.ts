// ShrimpX V2 — PLAYER-INTRO-1 §9 受講者向け導入・基本目安の実機確認
//
// 検証項目（指示§9）:
//   - 歩留まり100％が初回に明示され、確認を求められる
//   - 営業・Workerの数量目安が表示され、商品混在時に能力を重複計上しない文言がある
//   - 現在の費用条件（当Turnの実効単価）が表示される
//   - 増減員の反映時期と一時費用が出る
//   - 再訪時に導入を強制しない／「遊び方」から開き直せる
//   - 説明の開閉で入力や提出状態を壊さない
//   - スマートフォン幅で読める
//
// 新しいポーリング・新しい大量取得を増やしていないことは、この画面が
// 既存の /api/v2/play/session 以外を叩かないこと（追加fetchを書いていないこと）で担保する。

import { test, expect, type Page } from "@playwright/test";
import { dismissPlayerIntroIfPresent, submitIndependentPlayerDecision } from "./_lib/decisionFlow";

// 【操作のタイムアウトを明示する】Playwright の既定では click 等の操作に
// タイムアウトが無く、要素が他の要素に覆われていると無限に待ち続ける
// （実測: 画面上部の環境バナーに覆われた「閉じる」で30分以上ハングした）。
// 原因が分かる形で失敗させるため、この spec では操作にも上限を置く。
test.use({ actionTimeout: 20_000 });

const STAGING_ADMIN_TOKEN = "e2e-test-token";
const SHOTS = "e2e/__screenshots__";

async function loginAsGm(page: Page): Promise<void> {
  const returnTo = encodeURIComponent("/v2/management/setup");
  await page.goto(`/v2/company-lab/play/login?returnTo=${returnTo}`);
  await page.getByLabel("管理トークン").fill(STAGING_ADMIN_TOKEN);
  await page.getByRole("button", { name: "ログイン" }).click();
  await page.waitForURL(/\/v2\/management\/setup/);
}

async function createRunWithBalAsPlayer(page: Page): Promise<void> {
  await page.goto("/v2/management/setup");
  await page.getByTestId("setup-control-mode-BAL").selectOption("PLAYER");
  await page.getByTestId("setup-start-button").click();
  await page.waitForURL(/\/v2\/management\?run=/);
}

async function issueJoinUrl(page: Page, companyId: string): Promise<string> {
  await page.getByTestId(`player-seat-issue-${companyId}`).click();
  const codeLocator = page.getByTestId(`player-seat-join-url-${companyId}`).locator("code");
  await expect(codeLocator).toBeVisible();
  const joinUrl = await codeLocator.textContent();
  if (!joinUrl) throw new Error(`${companyId}の参加リンクが取得できない`);
  return joinUrl.trim();
}

test.describe("PLAYER-INTRO-1 受講者向け導入", () => {
  test("初回に歩留まり100％を確認させ、基本目安が現行値で出て、再訪では強制せず、入力を壊さない", async ({ browser }) => {
    test.setTimeout(900_000);

    const gmContext = await browser.newContext();
    const gmPage = await gmContext.newPage();
    const playerContext = await browser.newContext();
    const playerPage = await playerContext.newPage();

    try {
      await loginAsGm(gmPage);
      await createRunWithBalAsPlayer(gmPage);
      const joinUrl = await issueJoinUrl(gmPage, "BAL");

      // --- A. 初回参加：導入が自動で開く ---
      await playerPage.goto(joinUrl);
      await playerPage.waitForURL(/\/v2\/play\/workspace/);
      const intro = playerPage.getByTestId("play-intro");
      await expect(intro).toBeVisible({ timeout: 30_000 });
      await expect(intro).toHaveAttribute("data-mode", "firstVisit");
      // 【§4A】終了Turnを参加中Runの設定から出す（「取得できていません」で済ませない）。
      await expect(playerPage.getByTestId("play-intro-overview")).toContainText("このゲームは全 32 Turn（8年）の予定です");
      await expect(playerPage.getByTestId("play-intro-overview")).toContainText("残りは 32 Turn です");

      // --- B. 歩留まり100％のカードが折りたたまれずに出ている ---
      const yieldCard = playerPage.getByTestId("play-intro-yield-card");
      await expect(yieldCard).toBeVisible();
      await expect(yieldCard).toContainText("加工歩留まりを100％として扱います");
      await expect(yieldCard).toContainText("原料1tは製品1tとして数量換算");
      await expect(yieldCard).toContainText("PDを1,000t生産する計画");

      // 確認するまでは閉じるボタンを出さない。
      await expect(playerPage.getByTestId("play-intro-close")).toHaveCount(0);
      await expect(playerPage.getByTestId("play-intro-yield-ack")).toBeVisible();
      await playerPage.screenshot({ path: `${SHOTS}/intro-01-first-visit-desktop.png`, fullPage: true });

      // --- C. 確認すると閉じられるようになる ---
      await playerPage.getByTestId("play-intro-yield-ack-button").click();
      await expect(playerPage.getByTestId("play-intro-yield-acknowledged")).toBeVisible();
      await expect(playerPage.getByTestId("play-intro-close")).toBeVisible();

      // --- D. AI初期入力の説明が導入に入っている ---
      await playerPage.getByTestId("play-intro-ai-draft-toggle").click();
      const aiNote = playerPage.getByTestId("play-intro-ai-draft");
      await expect(aiNote).toContainText("Standard AIが考えた案が入っています");
      await expect(aiNote).toContainText("保証するものではありません");
      await expect(aiNote).toContainText("まだ提出されていません");

      // --- E. 最初の2Turnの練習案内がある（禁止ではなく推奨であること） ---
      await playerPage.getByTestId("play-intro-practice-toggle").click();
      const practice = playerPage.getByTestId("play-intro-practice");
      await expect(practice).toContainText("おすすめの練習手順");
      await expect(practice).toContainText("変更が禁止されているわけではありません");
      await expect(practice).toContainText("2四半期ぶんの結果を見る");

      // --- F. 経営の基本目安が現行値で出る ---
      await playerPage.getByTestId("play-intro-baselines-toggle").click();
      const baselines = playerPage.getByTestId("play-management-baselines");
      await expect(baselines).toBeVisible();

      // 営業：1人あたりのトン数で示され、足し合わせられないことが明示される
      const sales = playerPage.getByTestId("play-baselines-sales");
      await expect(sales).toContainText("営業：1人あたり何トン売れるか");
      await expect(sales).toContainText("その商品だけを売った場合の目安");
      await expect(sales).toContainText("この3つを足して同時に売ることはできません");
      await expect(sales).toContainText("割合を足して100%以内");
      // 受講者向けの画面に「工数」という語を出さない。
      await expect(sales).not.toContainText("工数換算");

      // Worker：商品別の1人あたり能力と、設備・原料が上限になる旨
      const worker = playerPage.getByTestId("play-baselines-worker");
      await expect(worker).toContainText("HOSO");
      await expect(worker).toContainText("PD");
      await expect(worker).toContainText("VAP");
      await expect(worker).toContainText("いちばん小さいもの");

      // 増減員：営業は翌期反映・退職金あり、Workerは当期反映
      const headcount = playerPage.getByTestId("play-baselines-headcount");
      await expect(headcount).toContainText("次の四半期から営業能力");
      await expect(headcount).toContainText("退職金");
      await expect(headcount).toContainText("すぐ反映されます");

      // 人件費：当Turnの実効値であることと、固定費を分けていること
      const cost = playerPage.getByTestId("play-baselines-labor-cost");
      await expect(cost).toContainText("USD／人／四半期");
      await expect(cost).toContainText("人数に関係なく発生する費用");
      await expect(cost).toContainText("残業費は含みません");
      // 常用と臨時の金銭差が、1トンあたりで比べられる形で出ている。
      await expect(cost).toContainText("常用Worker と 臨時Worker の違い（お金の面）");
      await expect(cost).toContainText("1トンあたりの人件費");
      await expect(cost).toContainText("1トンあたりで見ると常用より割高");
      // このバージョンでは臨時雇用の意味が薄いという事実と、現実とのちがいを書く。
      const tmpNote = playerPage.getByTestId("play-baselines-temporary-worker-note");
      await expect(tmpNote).toContainText("臨時Workerを使う金銭的な理由はほとんどありません");
      await expect(tmpNote).toContainText("解雇に退職金や手続き費用がかからず");
      await expect(tmpNote).toContainText("実際の経営では、解雇に退職金や法令上の手続きが必要");
      await playerPage.screenshot({ path: `${SHOTS}/intro-02-baselines-desktop.png`, fullPage: true });

      // --- G. 閉じて画面へ戻る ---
      await playerPage.getByTestId("play-intro-close").click();
      await expect(intro).toHaveCount(0);
      // 歩留まり前提は Overview にも短い形で常設されている。
      await expect(playerPage.getByTestId("play-yield-note-compact")).toContainText("加工歩留まりを100％として扱います");

      // --- H. 意思決定画面に目安のヒントが出る ---
      await playerPage.getByTestId("play-workspace-tab-decision").click();
      await playerPage.getByTestId("decision-studio-tab-sales").click();
      const salesHint = playerPage.getByTestId("play-baseline-hint-sales");
      await expect(salesHint).toBeVisible();
      await expect(salesHint).toContainText("営業1人あたりの目安は");
      await expect(salesHint).toContainText("3つを足して同時には売れません");
      await expect(salesHint).not.toContainText("工数");

      await playerPage.getByTestId("decision-studio-tab-worker").click();
      const workerHint = playerPage.getByTestId("play-baseline-hint-worker");
      await expect(workerHint).toBeVisible();
      await expect(workerHint).toContainText("／人／四半期");
      await expect(workerHint).toContainText("トンあたりでは割高");
      await expect(workerHint).toContainText("臨時Workerを使う金銭的な理由はほとんどありません");

      await playerPage.getByTestId("decision-studio-tab-production").click();
      await expect(playerPage.getByTestId("play-baseline-hint-production")).toContainText("加工歩留まりは100％");

      await playerPage.getByTestId("decision-studio-tab-procurement").click();
      await expect(playerPage.getByTestId("play-baseline-hint-procurement")).toContainText("加工歩留まりは100％");
      await playerPage.screenshot({ path: `${SHOTS}/intro-03-decision-hint-desktop.png`, fullPage: true });

      // --- I. 説明の開閉で入力が失われない ---
      await playerPage.getByTestId("decision-studio-tab-worker").click();
      const firstNumberInput = playerPage.locator('input[type="number"]').first();
      await firstNumberInput.waitFor();
      await firstNumberInput.fill("7");
      await expect(firstNumberInput).toHaveValue("7");
      // ヒントから基本目安を開く → 閉じる
      await playerPage.getByTestId("play-baseline-hint-open-worker").click();
      await expect(playerPage.getByTestId("play-management-baselines")).toBeVisible();
      await playerPage.getByTestId("play-intro-close").click();
      await expect(playerPage.getByTestId("play-intro")).toHaveCount(0);
      // 入力は残っている。提出状態も変わっていない。
      await expect(firstNumberInput).toHaveValue("7");
      await expect(playerPage.getByTestId("play-workspace-status")).toHaveAttribute("data-status", "EDITING");

      // --- J. 再訪（reload）では導入を強制しない ---
      await playerPage.reload();
      await playerPage.waitForURL(/\/v2\/play\/workspace/);
      await expect(playerPage.getByTestId("play-workspace-heading")).toContainText("BAL");
      // 少し待っても自動では開かない。
      await expect(playerPage.getByTestId("play-intro")).toHaveCount(0);

      // --- K. 「遊び方」からいつでも開き直せる（歩留まりの再確認も可能） ---
      await playerPage.getByTestId("play-open-how-to-play").click();
      await expect(playerPage.getByTestId("play-intro")).toHaveAttribute("data-mode", "reopened");
      await expect(playerPage.getByTestId("play-intro-yield-card")).toBeVisible();
      await playerPage.getByTestId("play-intro-close").click();

      await playerPage.getByTestId("play-open-baselines").click();
      await expect(playerPage.getByTestId("play-management-baselines")).toBeVisible();
      await playerPage.getByTestId("play-intro-close").click();

      // --- L. スマートフォン幅で読める（横スクロールが出ない） ---
      await playerPage.setViewportSize({ width: 390, height: 844 });
      await playerPage.getByTestId("play-open-how-to-play").click();
      await expect(playerPage.getByTestId("play-intro")).toBeVisible();
      await playerPage.screenshot({ path: `${SHOTS}/intro-04-first-visit-mobile.png`, fullPage: true });
      await playerPage.getByTestId("play-intro-baselines-toggle").click();
      await expect(playerPage.getByTestId("play-management-baselines")).toBeVisible();
      await playerPage.screenshot({ path: `${SHOTS}/intro-05-baselines-mobile.png`, fullPage: true });
      const overflow = await playerPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      await playerPage.getByTestId("play-intro-close").click();
      await playerPage.setViewportSize({ width: 1280, height: 900 });

      // --- M. 提出は従来どおり成立する（導入を入れても壊れない） ---
      await playerPage.getByTestId("play-workspace-tab-decision").click();
      await submitIndependentPlayerDecision(playerPage);
      await expect(playerPage.getByTestId("play-waiting-for-gm")).toBeVisible();
      await playerPage.screenshot({ path: `${SHOTS}/intro-06-submitted-desktop.png`, fullPage: true });

      // --- N. 提出済みでも「遊び方」「基本目安」は開ける ---
      await playerPage.getByTestId("play-open-baselines").click();
      await expect(playerPage.getByTestId("play-management-baselines")).toBeVisible();
      await playerPage.getByTestId("play-intro-close").click();
      await expect(playerPage.getByTestId("play-workspace-status")).toHaveAttribute("data-status", "SUBMITTED");
    } finally {
      await playerContext.close();
      await gmContext.close();
    }
  });

  test("途中参加（Turn 2以降）では「いまの状態」として案内し、Turn 1からやり直すとは書かない", async ({ browser }) => {
    test.setTimeout(900_000);

    const gmContext = await browser.newContext();
    const gmPage = await gmContext.newPage();
    const firstContext = await browser.newContext();
    const firstPage = await firstContext.newPage();

    try {
      await loginAsGm(gmPage);
      await createRunWithBalAsPlayer(gmPage);
      const joinUrl = await issueJoinUrl(gmPage, "BAL");

      // Turn 1 を進めてから「別端末で初めて開く」状況を作る。
      await firstPage.goto(joinUrl);
      await firstPage.waitForURL(/\/v2\/play\/workspace/);
      await dismissPlayerIntroIfPresent(firstPage);
      await submitIndependentPlayerDecision(firstPage);
      await expect(firstPage.getByTestId("play-waiting-for-gm")).toBeVisible();
      await gmPage.getByTestId("run-1").click();
      await expect(gmPage.getByTestId("turn-counter")).toContainText("1 /", { timeout: 120_000 });

      // 同じ参加リンクを、導入を一度も読んでいない別contextで開く。
      const lateContext = await browser.newContext();
      const latePage = await lateContext.newPage();
      try {
        await latePage.goto(joinUrl);
        await latePage.waitForURL(/\/v2\/play\/workspace/);
        const intro = latePage.getByTestId("play-intro");
        await expect(intro).toBeVisible({ timeout: 30_000 });
        await latePage.getByTestId("play-intro-yield-ack-button").click();
        await latePage.getByTestId("play-intro-company-toggle").click();
        const company = latePage.getByTestId("play-intro-company");
        await expect(company).toContainText("いまの状態");
        await expect(company).toContainText("Turn 1 からやり直すわけではありません");
        await latePage.screenshot({ path: `${SHOTS}/intro-07-midgame-join-desktop.png`, fullPage: true });
      } finally {
        await lateContext.close();
      }
    } finally {
      await firstContext.close();
      await gmContext.close();
    }
  });
});
