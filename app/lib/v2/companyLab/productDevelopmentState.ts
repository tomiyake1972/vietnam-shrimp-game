// ShrimpX V2 — VAP商品開発投資（vapProductDevelopmentSpendUsd）のスコア状態（Test15新設）
//
// 【目的】会社が毎四半期選択するVAP商品開発費（$0/$100,000/$250,000/$500,000の
// 4段階）が、会社ごとのVAP商品開発スコア（0〜100、中立50）を積み上げる。
// このスコアは sales/allocation.ts の合成競争力ウェイト（vapCapability経由、
// companyLab/premiumPolicy.tsのcalculateCompanyCapabilityCoefficient経由）へのみ
// 接続し、marketPremiumByProduct.vapや他の共有市場観測データは一切書き換えない。
//
// 【単一の情報源（会計との整合）】このモジュールが読む spend（投資額）は、
// companyLab/runner.tsがCompanyDecisionInput.vapProductDevelopmentSpendUsdから
// そのまま渡す値そのもの。同じ変数が finance/quarterClose.ts の
// CompanyQuarterBusinessActuals.vapProductDevelopmentSpendUsd としてSG&A・
// キャッシュフローへも計上される（runner.ts参照。二重に定義しない）。
//
// 【設計パターン】salesBase.ts と同じ「スパース配列・companyId昇順ソート・
// 決定論的」パターンを踏襲する。ただしこちらは会社×商品×市場ではなく会社単位
// （VAP商品開発はその会社全体の開発体制への投資であり、市場別に分けない設計）。
//
// 【タイミング規約】salesBase.ts / quality/scoreUpdates.ts と同じ規約:
// 当四半期の意思決定・効果算出には「前四半期末までの値」だけを使い、当四半期の
// spendで更新したスコアは次四半期の効果算出にのみ使う（companyLab/runner.tsの
// 呼び出し順序でこれを構造的に保証する）。

import { Score0to100, score0to100, unwrapUnit } from "../core/units";
import { CompanyId } from "../sales/types";

// ---------------------------------------------------------------------
// 1. 支払段階（4段階、自由入力ではない）
// ---------------------------------------------------------------------

/** 【実装指示どおり固定】VAP商品開発費の選択可能な4段階（USD）。 */
export const VAP_PRODUCT_DEVELOPMENT_SPEND_TIERS_USD: readonly number[] = [0, 100_000, 250_000, 500_000];

/** 指定された金額が、許容される4段階のいずれかと厳密に一致するか。 */
export function isValidVapProductDevelopmentSpendTier(amountUsd: number): boolean {
  return VAP_PRODUCT_DEVELOPMENT_SPEND_TIERS_USD.some((tier) => Math.abs(tier - amountUsd) < 1e-6);
}

// ---------------------------------------------------------------------
// 2. パラメータ・状態
// ---------------------------------------------------------------------

export interface ProductDevelopmentParameters {
  readonly parametersVersion: string;
  /** 中立値（未投資・新規参入の基準点。既存スコア体系と同じ50）。 */
  readonly neutralScore: number;
  /** 標準投資額（USD/四半期）。【Test15で校正対象】投資比率(spend/standardBudgetUsd)の基準点。 */
  readonly standardBudgetUsd: number;
  /** 標準投資額どおりに投資したときの、四半期あたりスコア増加量。【Test15で校正対象】 */
  readonly gainCoefficient: number;
  /** 投資比率(spend/standardBudgetUsd)の上限。最上位$500,000枠 ÷ standardBudgetUsd(=$250,000) = 2.0とちょうど一致する設計。 */
  readonly investmentRatioCap: number;
  /** 当四半期spend=0のときの、中立値への減衰比率（常に適用。省略不可）。 */
  readonly idleDecayRatioPerQuarter: number;
  readonly floor: number;
  readonly cap: number;
}

export const PRODUCT_DEVELOPMENT_PARAMETERS_V1: ProductDevelopmentParameters = {
  parametersVersion: "productDevelopment-v0.1",
  neutralScore: 50,
  // 【Test15で校正対象】
  standardBudgetUsd: 250_000,
  // 【Test15で校正対象】
  gainCoefficient: 4.0,
  investmentRatioCap: 2.0,
  idleDecayRatioPerQuarter: 0.06,
  floor: 0,
  cap: 100,
};

export interface ProductDevelopmentEntry {
  readonly companyId: CompanyId;
  readonly score: Score0to100;
}

/** VAP商品開発スコアの全体状態（スパース表現。存在しない会社は中立値50とみなす）。 */
export interface ProductDevelopmentState {
  readonly entries: readonly ProductDevelopmentEntry[];
}

export function buildInitialProductDevelopmentState(): ProductDevelopmentState {
  return { entries: [] };
}

/** 会社のVAP商品開発スコアを引く（存在しなければ中立値）。 */
export function lookupProductDevelopmentScore(
  state: ProductDevelopmentState | undefined,
  companyId: CompanyId,
  params: ProductDevelopmentParameters = PRODUCT_DEVELOPMENT_PARAMETERS_V1
): number {
  if (!state) return params.neutralScore;
  const entry = state.entries.find((e) => e.companyId === companyId);
  return entry ? unwrapUnit(entry.score) : params.neutralScore;
}

// ---------------------------------------------------------------------
// 3. 更新（四半期末）
// ---------------------------------------------------------------------

/**
 * 四半期末のVAP商品開発スコア更新（純粋関数・決定論的）。
 *
 * 【develop/v2統合・Required fix 3で修正】以前の実装は
 *   score += gainCoefficient × min(spend/standardBudgetUsd, investmentRatioCap)
 * という線形式で、ヘッドルーム（スコアが100に近いほど伸びが縮む効果）が
 * 欠落していた誤りだった。正しい式は、旧ブランチ
 * feature/v2-product-strategy-economics の
 * app/lib/v2/companyLab/productDevelopmentState.ts（updateProductDevelopmentState）
 * および最終設計提示 task_d_redesign_v2.md §1-1（「式自体（ヘッドルーム式）は
 * 正しく、ミスは分母の定数だけでした」）で確定した、以下のヘッドルーム付き式：
 *
 *   spend > 0: score += gainCoefficient
 *                        × min(spend/standardBudgetUsd, investmentRatioCap)
 *                        × headroom（= 1 − score/100。スコアが100に近いほど
 *                          同じ投資額での増分が縮み、score=100では増分ゼロになる）
 *   spend = 0: score = neutral + (score - neutral) × (1 - idleDecayRatioPerQuarter)
 *              （spend=0のときは必ずこの減衰を適用する。条件によりスキップしない）
 *   その後 [floor, cap] へclamp。
 *
 * spendByCompanyIdは、companyLab/runner.tsがCompanyDecisionInput.
 * vapProductDevelopmentSpendUsdからそのまま渡す値（会計計上と同一の値、唯一の情報源）。
 */
export function updateProductDevelopmentState(
  prev: ProductDevelopmentState | undefined,
  spendByCompanyId: ReadonlyMap<CompanyId, number>,
  companyIds: readonly CompanyId[],
  params: ProductDevelopmentParameters = PRODUCT_DEVELOPMENT_PARAMETERS_V1
): ProductDevelopmentState {
  const prevScores = new Map<string, number>();
  for (const e of prev?.entries ?? []) {
    prevScores.set(e.companyId, unwrapUnit(e.score));
  }

  const entries: ProductDevelopmentEntry[] = [];
  const sortedCompanyIds = [...companyIds].sort();
  for (const companyId of sortedCompanyIds) {
    let score = prevScores.get(companyId) ?? params.neutralScore;
    const spend = spendByCompanyId.get(companyId) ?? 0;
    if (spend > 0) {
      const investmentRatio = Math.min(spend / params.standardBudgetUsd, params.investmentRatioCap);
      const headroom = 1 - score / 100;
      score += params.gainCoefficient * investmentRatio * headroom;
    } else {
      // spend=0のときは常にこの減衰を適用する（スキップ不可）。
      score = params.neutralScore + (score - params.neutralScore) * (1 - params.idleDecayRatioPerQuarter);
    }
    score = Math.max(params.floor, Math.min(params.cap, score));
    if (Math.abs(score - params.neutralScore) >= 0.005) {
      entries.push({ companyId, score: score0to100(score) });
    }
  }
  return { entries };
}
