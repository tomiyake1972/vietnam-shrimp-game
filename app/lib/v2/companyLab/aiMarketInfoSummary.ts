// ShrimpX V2 — 「AIが見ている市場情報」パネル向け 集計・ラベル付けヘルパー
// (test/sai6-manual-observation-2026-08-01: 三宅さんの3回目の手動観察テストで
//  「市場レベルの価格・需要・需要トレンド（伸びている市場／縮んでいる市場が
//  分かればよい）が画面のどこにも出ていない」という指摘を受けた)
//
// 【設計原則】
//   - Standard AIの意思決定関数（standardAi/policy.tsのgenerateStandardAiDecision）
//     が実際に受け取る入力は fixture・ownState・publicInfo（PublicMarketInfo）・
//     period・turn の5つだけ（policy.ts冒頭コメント参照）。本ファイルはこの
//     publicInfo.productLifecycleOutlook / publicInfo.productSupplyPressureOutlook を
//     読み取り専用で「伸びている／縮んでいる」「供給過剰／供給不足」という定性
//     ラベルへ変換するだけの純粋関数群であり、新しい市場トレンドの計算式は
//     一切導入しない（値そのものはmarket/productLifecycle.ts・companyLab/
//     marketEvolution.tsが既に計算済みのものをそのまま使う）。
//   - 価格そのもの（消費国別・産地国別）は既存の marketPriceViewModel.ts
//     （buildDestinationMarketPriceRows等）をそのまま再利用する。本ファイルは
//     価格を扱わない。
//   - config.sai5.productLifecycle / config.sai5.supplyPremiumFeedback等が
//     無効なラボでは publicInfo.productLifecycleOutlook / productSupplyPressureOutlook
//     自体がundefinedになる（値を0や中立値で埋めない、既存の情報境界の規約）。
//     本ファイルの関数はその場合、呼び出し側で「機能が無効」と分かるよう、
//     関数自体を呼ばない（undefinedのまま画面へ渡す）という前提で設計している。

import { DEMAND_MARKET_IDS, DemandMarketId, Product } from "../market/types";
import { ProductLifecycleOutlook } from "./types";

const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

// ---------------------------------------------------------------------
// A. 市場×商品の需要構成比トレンド（伸びている／縮んでいる／横ばい）
// ---------------------------------------------------------------------

export type LifecycleTrendLabel = "growing" | "shrinking" | "flat";

/**
 * 【閾値の根拠】market/productLifecycle.tsのPRODUCT_LIFECYCLE_PARAMETERS_V1では、
 * 加速期に入る前の定常成長（baseGrowthPerQuarter）はPDで0.002pt/四半期、
 * VAPで0.001pt/四半期程度（実測確認済み: computeMarketProductMixをturn差分で
 * 比較すると、非加速期は0.001〜0.002、S字カーブの加速期は0.005〜0.036に達する）。
 * 0.005（0.5ポイント/四半期）を閾値にすることで、「定常的な緩やかな浸透（横ばい
 * 扱い）」と「実際に加速期に入って明確に伸びている／それに伴い他商品のシェアが
 * 縮んでいる」局面を分離できる。これは校正済みの精密な閾値ではなく、あくまで
 * おおまかな方向性（伸び／縮み／横ばい）を示すための目安であることを画面側の
 * 文言でも明示する。
 */
export const LIFECYCLE_TREND_THRESHOLD = 0.005;

export function classifyLifecycleTrend(trendValue: number, threshold: number = LIFECYCLE_TREND_THRESHOLD): LifecycleTrendLabel {
  if (trendValue > threshold) return "growing";
  if (trendValue < -threshold) return "shrinking";
  return "flat";
}

export interface LifecycleTrendRow {
  readonly market: DemandMarketId;
  readonly product: Product;
  /** 前四半期の構成比 − 前々四半期の構成比（四半期あたりの変化量。pt）。 */
  readonly trendValue: number;
  readonly label: LifecycleTrendLabel;
}

/**
 * productLifecycleOutlook.quarterlyTrendByMarketを、5市場×3商品の行一覧へ展開し、
 * それぞれに定性ラベルを付ける。sharesByMarketの行和が1という制約上、hosoの
 * トレンドはpd・vapのトレンドの符号反転（残差）になる（新しい値を計算していない）。
 */
export function buildLifecycleTrendRows(
  outlook: ProductLifecycleOutlook,
  threshold: number = LIFECYCLE_TREND_THRESHOLD
): readonly LifecycleTrendRow[] {
  const rows: LifecycleTrendRow[] = [];
  for (const market of DEMAND_MARKET_IDS) {
    for (const product of PRODUCTS) {
      const trendValue = outlook.quarterlyTrendByMarket[market][product];
      rows.push({ market, product, trendValue, label: classifyLifecycleTrend(trendValue, threshold) });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------
// B. 商品別供給圧力（供給過剰／供給不足／概ね均衡）
// ---------------------------------------------------------------------

export type SupplyPressureLabel = "oversupply" | "undersupply" | "balanced";

/**
 * 【閾値の根拠】companyLab/marketEvolution.tsのsupplyPressureEwmaは1.0=需給均衡、
 * EWMAの平滑化係数(alpha=0.4)がかかった値（既定のsupplyPressureDefinition=
 * "completed_supply"では構造上1.0が下限になり、1.0を下回ることは通常ない）。
 * ±0.1（10%）を閾値にすることで、通常の四半期ノイズ（EWMAで平滑化済みのため
 * 小さいはず）と、持続的な需給の偏りを大まかに分離する。校正済みの精密な閾値
 * ではなく、あくまで大まかな方向性の目安であることを画面側の文言でも明示する。
 */
export const SUPPLY_PRESSURE_BAND = 0.1;

export function classifySupplyPressure(value: number, band: number = SUPPLY_PRESSURE_BAND): SupplyPressureLabel {
  if (value > 1 + band) return "oversupply";
  if (value < 1 - band) return "undersupply";
  return "balanced";
}

export interface SupplyPressureRow {
  readonly product: "pd" | "vap";
  readonly value: number;
  readonly label: SupplyPressureLabel;
}

export function buildSupplyPressureRows(
  outlook: Readonly<Record<"pd" | "vap", number>>,
  band: number = SUPPLY_PRESSURE_BAND
): readonly SupplyPressureRow[] {
  return (["pd", "vap"] as const).map((product) => ({
    product,
    value: outlook[product],
    label: classifySupplyPressure(outlook[product], band),
  }));
}
