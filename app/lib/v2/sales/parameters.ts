// ShrimpX V2 — 販売計画・営業人員・成約・約定残モジュール パラメータ定義（Phase 4）
//
// 市場価格形成モジュール（app/lib/v2/market/parameters.ts）と同じ方針で、
// 計算ロジックにマジックナンバーを直接書かず、すべての係数をこの1ファイルへ
// 集約する。すべて「Phase4新規・要校正」の暫定値であり、ゲームバランス調整
// フェーズで再検討する前提とする（ChatGPT側の指示に数値そのものの指定はないため、
// 要求された「効果の方向性」（例: 逓減する、価格が高いほど不利になる）を満たす
// 最小限の暫定値として置く）。

import { Score0to100, score0to100 } from "../core/units";

export interface SalesParameters {
  readonly parametersVersion: string;

  // --- 営業人員 → 市場カバレッジ（0〜1、逓減曲線） ---
  // coverageScore(headcount) = baseline + (1 - baseline) * headcount / (headcount + saturation)
  // headcount=0 でも baseline 分だけ既存顧客による最低限の成約力を残す。
  readonly salesForce: {
    /** headcount=0 のときのカバレッジ（既存顧客による最低限の成約力）。 */
    readonly baselineCoverageAtZeroHeadcount: number;
    /** カバレッジ逓減曲線の半飽和点（この人数でbaselineと1の中間に到達）。 */
    readonly coverageSaturationHeadcount: number;
    /** headcount=0 のときの処理能力（HOSO換算トン、既存顧客分）。 */
    readonly baselineCapacityTons: number;
    /** 処理能力逓減曲線の漸近的な増分上限（HOSO換算トン）。 */
    readonly capacityMaxIncrementTons: number;
    /** 処理能力逓減曲線の半飽和点（この人数で増分上限の半分に到達）。 */
    readonly capacitySaturationHeadcount: number;
  };

  // --- 成約競争力の合成ウェイト（合計1.0を推奨） ---
  readonly competitivenessWeights: {
    readonly price: number;
    readonly coverage: number;
    readonly relationship: number;
    readonly quality: number;
    readonly deliveryReliability: number;
  };

  /**
   * 価格競争力の感度係数。priceScore = exp(-priceSensitivity * (askPrice - basePrice) / basePrice)。
   * 大きいほど「基準価格からの乖離」が競争力に与える影響が強くなる。
   */
  readonly priceSensitivity: number;
  /** priceScoreを[0, priceScoreClampMax]へclampしてから[0,1]へ正規化する（他ウェイトとスケールを揃えるため）。 */
  readonly priceScoreClampMax: number;

  /**
   * 5社以外の外部選択肢（他産地供給者・非購入）の競争力ウェイト。
   * 5社の合成競争力と同じスケール（0〜1程度）で比較する。
   */
  readonly externalOptionWeight: number;

  /** 顧客関係・品質・納期信頼性が未接続の場合に使う中立値（0〜100スケール）。 */
  readonly neutralScore: Score0to100;

  /** 標準リードタイム（ターン数）。希望リードタイム未指定時に使用。仕様上、成約の翌四半期。 */
  readonly standardLeadTimeTurns: number;

  // --- 提示価格の入力検証 ---
  /** askPrice が basePrice のこの比率を下回ったら異常値としてエラー。 */
  readonly minAskPriceRatioOfBase: number;
  /** askPrice が basePrice のこの比率を上回ったら異常値としてエラー。 */
  readonly maxAskPriceRatioOfBase: number;
}

export const SALES_PARAMETERS_V1: SalesParameters = {
  parametersVersion: "sales-v0.1",

  salesForce: {
    baselineCoverageAtZeroHeadcount: 0.15,
    coverageSaturationHeadcount: 6,
    baselineCapacityTons: 200,
    capacityMaxIncrementTons: 4800,
    capacitySaturationHeadcount: 10,
  },

  competitivenessWeights: {
    price: 0.35,
    coverage: 0.25,
    relationship: 0.15,
    quality: 0.15,
    deliveryReliability: 0.1,
  },

  priceSensitivity: 3.0,
  priceScoreClampMax: 2.0,

  externalOptionWeight: 0.35,

  neutralScore: score0to100(50),

  standardLeadTimeTurns: 1,

  minAskPriceRatioOfBase: 0.5,
  maxAskPriceRatioOfBase: 2.0,
};
