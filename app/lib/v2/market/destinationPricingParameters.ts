// ShrimpX V2 — 商品×仕向市場の参照価格差別化 パラメータ定義（Phase 8P-0A）
//
// 実装指示 ShrimpX V2 Phase 8P-0A §12「二段階実装」・§13「初期係数の方向性」・
// §14「加重平均の中立化」に対応する係数テーブルをこの1ファイルへ集約する
// （既存モジュール（market/parameters.ts等）の「マジックナンバーを直接書かず、
// 必ず中央パラメータ経由で参照する」規約をそのまま踏襲）。
//
// 2段階のコミット構成:
//   Commit A（構造実装）: 全係数=1.0（DESTINATION_MARKET_PRICE_COEFFICIENTS_NEUTRAL_V1）。
//     この状態では商品×市場参照価格が既存の商品別基準価格と完全に一致する
//     （後方互換性の検証对象）。
//   Commit B（初期係数投入）: DESTINATION_MARKET_PRICE_COEFFICIENTS_INITIAL_V1を追加し、
//     CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTSの参照先をこちらへ切り替える。
// 旧バージョンは削除しない（全体実装計画書 v0.1 §20「balanceVersionを更新し、
// 旧版を削除しない」に準じる）。

import { DemandMarketId, DEMAND_MARKET_IDS } from "./types";

/**
 * 1市場ぶんの参照価格係数。実装指示 §7の式で、それぞれ次の部分にのみ適用する
 * （価格全体への単純乗算ではない）。
 *   baseValueCoefficient: HOSO基礎価値部分（HOSO/PD/VAPの全商品に共通して含まれる）
 *   pdPremiumCoefficient: PD加工プレミアム部分（PD・VAPの両方に含まれる。HOSOには含まれない）
 *   vapPremiumCoefficient: VAP追加プレミアム部分（VAPのみに含まれる）
 * いずれも1.0が「既存モデルと同一」を意味する中立値。Ratioブランド型（[0,1]制約）は
 * 1.0を超える値を扱えないため、意図的にプレーンnumberとして持つ
 * （market/parameters.ts の pdBasePremiumRatio 等、既存の「比率だが[0,1]に収まらない
 * パラメータ」と同じ扱い）。
 */
export interface DestinationMarketPriceCoefficients {
  readonly baseValueCoefficient: number;
  readonly pdPremiumCoefficient: number;
  readonly vapPremiumCoefficient: number;
}

export type DestinationMarketPriceCoefficientTable = Readonly<Record<DemandMarketId, DestinationMarketPriceCoefficients>>;

function neutralCoefficients(): DestinationMarketPriceCoefficients {
  return { baseValueCoefficient: 1, pdPremiumCoefficient: 1, vapPremiumCoefficient: 1 };
}

/**
 * Commit A（構造実装）用の中立係数テーブル。全市場・全部分係数=1.0。
 * この係数を使う限り、deriveMarketReferencePrices の結果は既存の
 * deriveVietnamBasePrices（商品別・市場非依存の基準価格）と厳密に一致する
 * （market/__tests__/destinationPricing.test.ts で検証）。
 */
export const DESTINATION_MARKET_PRICE_COEFFICIENTS_NEUTRAL_V1: DestinationMarketPriceCoefficientTable = {
  CN: neutralCoefficients(),
  US: neutralCoefficients(),
  EU: neutralCoefficients(),
  JP: neutralCoefficients(),
  OTHER: neutralCoefficients(),
};

/**
 * 【実装指示 §14「加重平均の中立化」で用いた基準需要（重み）】
 * scenario/parameters.ts の SCENARIO_PREHISTORY_BASELINE_V1.priorMarketConsumptionHosoEqTons
 * （CN 380,000 / US 320,000 / EU 260,000 / JP 90,000 / OTHER 150,000、HOSO換算トン。
 * 全シナリオ共通の基準期需要）をそのまま採用した。sales/marketAdapter.ts の
 * deriveTargetDemand が商品区分（hoso/pd/vap）によらず同一の市場シェアベクトルを
 * 使っている（Phase4固有の簡略化前提）ため、HOSO基礎価値・PDプレミアム・VAP
 * プレミアムのいずれの加重平均も、この同一の重みで計算する。
 *   シェア: CN 31.667% / US 26.667% / EU 21.667% / JP 7.5% / OTHER 12.5%
 */
export const DESTINATION_MARKET_DEMAND_WEIGHTS_V1: Readonly<Record<DemandMarketId, number>> = {
  CN: 380_000 / 1_200_000,
  US: 320_000 / 1_200_000,
  EU: 260_000 / 1_200_000,
  JP: 90_000 / 1_200_000,
  OTHER: 150_000 / 1_200_000,
};

/**
 * Commit B（初期係数投入）用の暫定係数テーブル（実装指示 §13の方向性表・
 * §14の加重平均中立化要件に基づく）。
 *
 * 【方向性（実装指示 §13の表のとおり）】
 *   CN:    基礎価値やや低い〜中立 / PDプレミアムやや低い / VAPプレミアム低い
 *   US:    基礎価値中立         / PDプレミアム中立     / VAPプレミアムやや高い
 *   EU:    基礎価値やや高い     / PDプレミアムやや高い  / VAPプレミアム高い
 *   JP:    基礎価値やや高い     / PDプレミアム高い      / VAPプレミアム最も高い
 *   OTHER: 基礎価値やや低い     / PDプレミアムやや低い  / VAPプレミアムやや低い
 *
 * 【許容範囲（実装指示 §13）】
 *   baseValueCoefficient: 0.98〜1.02 / pdPremiumCoefficient: 0.90〜1.10 /
 *   vapPremiumCoefficient: 0.85〜1.25
 *
 * 【正規化方法（実装指示 §14）】
 * 上記の方向性に沿った素案の値を、DESTINATION_MARKET_DEMAND_WEIGHTS_V1 による
 * 加重平均が各部分係数についてちょうど1.0000になるよう、素案値をその加重平均で
 * 除して求めた（計算過程は docs/v2/DESTINATION_MARKET_PRICING_v0.1.md §加重平均の
 * 正規化に記載）。丸め誤差により加重平均は1.0000±0.0001程度。
 */
export const DESTINATION_MARKET_PRICE_COEFFICIENTS_INITIAL_V1: DestinationMarketPriceCoefficientTable = {
  CN: { baseValueCoefficient: 0.9917, pdPremiumCoefficient: 0.9395, vapPremiumCoefficient: 0.8627 },
  US: { baseValueCoefficient: 1.0017, pdPremiumCoefficient: 1.0104, vapPremiumCoefficient: 1.0352 },
  EU: { baseValueCoefficient: 1.0118, pdPremiumCoefficient: 1.071, vapPremiumCoefficient: 1.1502 },
  JP: { baseValueCoefficient: 1.0168, pdPremiumCoefficient: 1.0963, vapPremiumCoefficient: 1.2173 },
  OTHER: { baseValueCoefficient: 0.9867, pdPremiumCoefficient: 0.9498, vapPremiumCoefficient: 0.8819 },
};

/**
 * 現在有効な係数テーブル。Commit Aでは NEUTRAL_V1、Commit Bでは INITIAL_V1 を指す
 * （このエクスポートの参照先だけを切り替えることで2段階実装を表現する。
 * turn/runner.ts・companyLab/autoPolicy.ts はこの CURRENT_* だけを既定値として使う）。
 */
/**
 * 【Commit A時点】構造実装のみを検証する段階のため、中立係数（NEUTRAL_V1）を指す。
 * Commit B（初期係数投入）でこの参照先を DESTINATION_MARKET_PRICE_COEFFICIENTS_INITIAL_V1
 * へ切り替える。
 */
export const CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTS: DestinationMarketPriceCoefficientTable =
  DESTINATION_MARKET_PRICE_COEFFICIENTS_NEUTRAL_V1;

/** 加重平均の中立化を検証するためのヘルパー（テスト・診断出力から利用）。 */
export function weightedAverageCoefficient(
  table: DestinationMarketPriceCoefficientTable,
  field: keyof DestinationMarketPriceCoefficients,
  weights: Readonly<Record<DemandMarketId, number>> = DESTINATION_MARKET_DEMAND_WEIGHTS_V1
): number {
  return DEMAND_MARKET_IDS.reduce((sum, market) => sum + table[market][field] * weights[market], 0);
}
