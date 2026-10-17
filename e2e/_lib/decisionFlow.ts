// ShrimpX V2 — E2E 共通: 意思決定の確定／提出フロー（UI-TRIAL-1 §5）
//
// 【なぜ必要か】UI-TRIAL-1 で、両PLAYER経路の提出手順が
//   入力 →「意思決定を確認」→ 最終確認画面 →「この内容で確定／提出」
// の2段になった。既存E2Eは1つのボタンを押すだけだったため、ここに手順を1か所だけ
// 用意して全E2Eから使う（各ファイルへ手順を書き写さない）。
//
// 【競合（race）に注意した実装】最初の実装は「確認ボタンを押した直後に
// commit ボタンの count() を見る」形だった。count() は待たないため、
// 描画が間に合わない負荷時には「確認画面がまだ出ていない」＝「検証エラーで
// 進まなかった」と誤判定し、何も押さずに黙って戻っていた。
// 実測: E2E全体を通しで走らせると managementSalesModelSelector の2件が
// 「PLAYERが未確定のままAdvance Turnが gating されて turn-counter が 1/32 のまま」
// で失敗した（単体実行では速いため再現しなかった）。
// そのため、クリック後は「確認画面」か「入力画面のエラー表示」のどちらかが
// 現れるまで必ず待ってから分岐する。

import { expect, type Page } from "@playwright/test";

/**
 * 【PLAYER-INTRO-1】受講者画面は初回だけ導入を全画面で出す。
 * 歩留まり100％の前提を確認するまで閉じられないため、提出手順の前に必ず閉じる。
 * すでに読み終えている（導入が出ていない）場合は何もしない。
 */
export async function dismissPlayerIntroIfPresent(page: Page): Promise<void> {
  const intro = page.getByTestId("play-intro");
  /**
   * 【描画前に判定しない】導入はサーバー応答を受け取ってから出る。
   * 参加直後に即 isVisible() を見ると「まだ無い」と判定してしまい、
   * その後に出た導入が以降のクリックを遮って原因の分かりにくい
   * タイムアウトになる（実測）。まず画面本体かこの導入のどちらかが
   * 描画されるまで待ってから判定する。
   */
  await intro.or(page.getByTestId("play-workspace-tabs")).first().waitFor({ timeout: 60_000 });
  if (!(await intro.isVisible().catch(() => false))) return;
  const ack = page.getByTestId("play-intro-yield-ack-button");
  if (await ack.isVisible().catch(() => false)) await ack.click();
  await page.getByTestId("play-intro-close").click();
  await expect(intro).toBeHidden();
}

/** クリック後に「確認画面」と「エラー表示」のどちらが出たかを、待ってから判定する。 */
async function waitForConfirmOrError(page: Page, errorTestId: string): Promise<"confirm" | "error"> {
  const screen = page.getByTestId("decision-confirmation-screen");
  const error = page.getByTestId(errorTestId);
  // どちらか一方が見えるまで待つ（両方出ないまま進まない）。
  await expect(screen.or(error)).toBeVisible({ timeout: 30_000 });
  return (await screen.isVisible()) ? "confirm" : "error";
}

/**
 * 受講者画面は Overview / Market / Inventory / Decision のタブ構成であり、
 * 「意思決定を確認」ボタンは Decision タブにしか描画されない。
 * どのタブから呼ばれても提出できるよう、必要なときだけ Decision タブへ移る。
 */
async function openPlayerDecisionTabIfNeeded(page: Page): Promise<void> {
  if (await page.getByTestId("play-review-decision").isVisible().catch(() => false)) return;
  const tab = page.getByTestId("play-workspace-tab-decision");
  if (await tab.isVisible().catch(() => false)) await tab.click();
}

/**
 * Independent Player の提出。
 * 入力が有効なら確認画面を経て提出まで行う。無効なら確認画面へ進まずに戻る
 * （呼び出し側の既存のエラー表示アサーションがそのまま通る）。
 */
export async function submitIndependentPlayerDecision(page: Page): Promise<void> {
  await dismissPlayerIntroIfPresent(page);
  await openPlayerDecisionTabIfNeeded(page);
  await page.getByTestId("play-review-decision").click();
  if ((await waitForConfirmOrError(page, "play-submit-error")) === "error") return;
  await page.getByTestId("decision-confirmation-commit").click();
}

/**
 * Management Console 内 PLAYER の確定。
 * 入力が有効なら確認画面を経て確定まで行う。無効なら確認画面へ進まずに戻る。
 */
export async function confirmConsolePlayerDecision(page: Page): Promise<void> {
  await page.getByTestId("workspace-review-decision").click();
  if ((await waitForConfirmOrError(page, "workspace-confirm-error")) === "error") return;
  await page.getByTestId("decision-confirmation-commit").click();
}
