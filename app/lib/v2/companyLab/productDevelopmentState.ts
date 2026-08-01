// ShrimpX V2 — VAP差別化戦略（顧客理解型） VAP商品開発投資の蓄積状態（2026-08-01新規）
//
// 【目的】VAP差別化戦略（顧客理解型）を成立させるため、「会社別に獲得できる
// VAPプレミアム」（companyLab/premiumPolicy.ts の calculateCompanyCapabilityCoefficient）
// を構成する1要素として、会社の継続的なVAP商品開発投資（新規レシピ・仕様開発・
// 試作評価等の人的・資金的投資、Phase 8の正式capex体系とは別枠の暫定入力）が
// 会社×商品開発力として蓄積される状態を導入する。
//
// 【既存状態との役割分担（二重加算の防止）】
//  - companyLab/salesBase.ts の営業基盤（会社×市場×商品）は「顧客接点・成約
//    実績」の蓄積であり、本ファイルの商品開発力（会社単位、市場非依存）とは
//    別のシグナルから更新される（営業活動 vs 商品開発投資）。同じ入力を両方の
//    状態へ流用しない。
//  - quality/scoreUpdates.ts の品質スコアは「操業結果（実績の品質）」の観測系列
//    であり、本ファイルは「商品企画・開発への投資」という将来能力の蓄積で、
//    やはり別の観測系列。
//
// 【設計パターン】salesBase.ts と同じ設計（スパース表現・純粋関数・決定論的な
// companyId固定順ソート）を踏襲する。新規に同種の状態を重複して作らない
// （商品開発力は市場×商品ではなく会社単位のストックであるため、salesBase.ts
// そのものを拡張するのではなく、粒度の異なる別ファイルとして新設する）。
//
// 【時間順序】salesBase.ts・quality状態と同じ規約: 更新は四半期処理の最後に
// 行い、当期の受注判断（premiumPolicy.ts経由）に使われるのは前四半期末までの
// 値のみ（companyLab/runner.ts の buildCompanyOwnState が、当期の意思決定を
// 作る前のstateから組み立てることで自然に満たす）。
//
// 【決定論】乱数不使用。エントリはcompanyId固定順でソートして保持する。

import { Score0to100, score0to100, unwrapUnit } from "../core/units";
import { CompanyId } from "../sales/types";

/** 1件の商品開発力エントリ（会社単位。市場×商品ではなく会社全体のVAP開発力）。 */
export interface ProductDevelopmentEntry {
  readonly companyId: CompanyId;
  /** 0-100スケール（salesBaseと同じScore0to100レンジ）。中立値50=未投資の基準点。 */
  readonly score: Score0to100;
}

/** VAP商品開発投資の蓄積状態全体（スパース表現。存在しない会社は中立値とみなす）。 */
export interface ProductDevelopmentState {
  readonly entries: readonly ProductDevelopmentEntry[];
}

/** VAP商品開発投資の更新パラメータ（一箇所集約。すべて校正対象の暫定値）。 */
export interface ProductDevelopmentParameters {
  /** 中立値（未投資の基準点。既存スコア体系の中立値50に合わせる）。 */
  readonly neutralScore: number;
  /**
   * 標準投資額（当期投資額がこの額のとき、ゲインが下記
   * investmentGainPerQuarterAtStandardBudgetそのものになる基準額）。
   * 【暫定値・要校正】capex/parameters.tsのvapLineExpansion標準投資額
   * （6,000,000 USD、複数四半期に分割払い）とは別枠の「商品開発活動」向け
   * 予算という位置づけのため、1桁小さい四半期あたりの目安額を暫定的に置く。
   */
  readonly standardBudgetUsd: number;
  /** 標準投資額を投じたときの1四半期あたりの獲得速度（点/四半期。ヘッドルームを
   *  乗じるため上限に漸近する。salesBase.tsのactiveAcquisitionPerQuarterと同じ設計）。 */
  readonly investmentGainPerQuarterAtStandardBudget: number;
  /** 投資額が標準投資額を上回る場合のゲイン倍率の上限（青天井の即時飽和を防ぐ）。 */
  readonly investmentRatioCap: number;
  /** 放置（無投資）時の中立値への減衰比率（現在値の中立超過分に対する比率/四半期）。 */
  readonly idleDecayRatioPerQuarter: number;
  readonly floor: number;
  readonly cap: number;
}

export const PRODUCT_DEVELOPMENT_PARAMETERS_V1: ProductDevelopmentParameters = {
  neutralScore: 50,
  // 【暫定値・要校正】salesBase.tsの営業人員基準予算感（数十万〜百万USD/四半期の
  // オーダー）を参考に、VAP商品開発の四半期あたり標準予算として置く。
  standardBudgetUsd: 400_000,
  // salesBase.tsのactiveAcquisitionPerQuarter(4.0)と同水準（標準的な継続投資で
  // 中立50から上限付近まで数年かかる、というsalesBase.tsと同じ「年単位の
  // 継続が必要」という意図）。
  investmentGainPerQuarterAtStandardBudget: 4.0,
  investmentRatioCap: 2.0,
  // salesBase.tsのidleDecayRatioPerQuarter(0.06)と同水準。
  idleDecayRatioPerQuarter: 0.06,
  floor: 0,
  cap: 100,
};

const EPSILON = 1e-9;

/** 空の商品開発状態（全社中立）。 */
export function emptyProductDevelopmentState(): ProductDevelopmentState {
  return { entries: [] };
}

/** 会社のVAP商品開発力スコアを引く（存在しなければ中立値）。 */
export function lookupProductDevelopmentScore(
  state: ProductDevelopmentState | undefined,
  companyId: CompanyId,
  params: ProductDevelopmentParameters = PRODUCT_DEVELOPMENT_PARAMETERS_V1
): number {
  if (!state) return params.neutralScore;
  const entry = state.entries.find((e) => e.companyId === companyId);
  return entry ? unwrapUnit(entry.score) : params.neutralScore;
}

/**
 * 四半期末のVAP商品開発力更新（純粋関数・決定論的）。
 *
 *   次期スコア = clamp( 前期スコア
 *                       + 投資あり: gainPerQuarterAtStandardBudget
 *                                   × min(investmentRatioCap, 当期投資額/標準投資額)
 *                                   × ヘッドルーム(1 - score/100)
 *                       − 投資なし（当期投資額<=0）: 中立値へ向けた減衰
 *                       , floor, cap )
 *
 * - 当期投資額が標準投資額の何倍かに応じてゲイン量を線形にスケールする
 *   （投資半分なら伸びも半分。投資ゼロなら無投資扱いでidle decayへ回る）。
 * - ヘッドルームを乗じるため、継続投資でも上限100へ急速に飽和しない
 *   （salesBase.tsの営業基盤と同じ設計上の理由）。
 */
export function updateProductDevelopmentState(
  previous: ProductDevelopmentState | undefined,
  companyIds: readonly CompanyId[],
  investmentAmountByCompanyUsd: ReadonlyMap<CompanyId, number>,
  standardBudgetUsd: number,
  params: ProductDevelopmentParameters = PRODUCT_DEVELOPMENT_PARAMETERS_V1
): ProductDevelopmentState {
  const prevScores = new Map<string, number>();
  for (const e of previous?.entries ?? []) {
    prevScores.set(e.companyId, unwrapUnit(e.score));
  }

  const safeStandardBudget = standardBudgetUsd > EPSILON ? standardBudgetUsd : params.standardBudgetUsd;

  const entries: ProductDevelopmentEntry[] = [];
  // companyId固定順で決定論的に走査する（salesBase.tsと同じ規約）。
  const sortedCompanyIds = [...companyIds].sort();
  for (const companyId of sortedCompanyIds) {
    let score = prevScores.get(companyId) ?? params.neutralScore;
    const investment = investmentAmountByCompanyUsd.get(companyId) ?? 0;
    if (investment > EPSILON) {
      const investmentRatio = Math.min(params.investmentRatioCap, investment / safeStandardBudget);
      const headroom = 1 - score / 100;
      score += params.investmentGainPerQuarterAtStandardBudget * investmentRatio * headroom;
    } else {
      // 放置減衰は中立値へ向かって減衰する（salesBase.tsと同じ規約。0へは向かわない）。
      score = params.neutralScore + (score - params.neutralScore) * (1 - params.idleDecayRatioPerQuarter);
    }
    score = Math.max(params.floor, Math.min(params.cap, score));
    // スパース表現: 中立値と実質同値（±0.005未満）のエントリは保存しない。
    if (Math.abs(score - params.neutralScore) >= 0.005) {
      entries.push({ companyId, score: score0to100(score) });
    }
  }
  return { entries };
}
