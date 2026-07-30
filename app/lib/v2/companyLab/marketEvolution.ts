// ShrimpX V2 — Phase SAI-5E: 競合供給・価格・需要の相互作用（carry stateと更新則）
//
// 【3つの因果チャネル（設計メモ§2.3〜2.5）】
//  1. 供給圧力→翌期プレミアム: 5社が成約配分へ提示した数量÷商品別対象需要の
//     EWMAが高止まりすると、翌期のPD/VAPベースプレミアム比率へ乗じる倍率が
//     低下する（平滑化・四半期変動上限±12%・下限0.6/上限1.4・商業的な床は
//     既存のminPremiumUsdPerKgが担保）。**当期の契約単価には一切影響しない**
//     （unitPriceは成約時スナップショット。翌期の市場価格形成にのみ効く）。
//  2. 安値による遅行需要（affordability）: 実現プレミアム比率が基準比率より
//     低い状態の持続（EWMA、2〜4四半期遅行）が、商品ライフサイクルの普及を
//     前倒しする（adoptionTurnShift、±4四半期でclamp）。総需要は増やさない
//     （構成比の普及速度のみ＝既存のconsumerInventory価格弾力性との重複計上を
//     構造的に回避）。HOSOの安値→市場全体需要は、既存の消費遅行弾力性が既に
//     同じ因果を実装済みのため**意図的に追加しない**。
//  3. PD⇔VAP代替: 前期の実現プレミアム比の基準比からの乖離に応じ、構成比
//     行列の中でPD⇄VAP間のシェアを最大10%移動する（元から減らして先へ足す
//     ＝総需要の二重計上なし。HOSO⇔VAPの直接代替は保守的に0で開始）。
//
// 【時間順序】全チャネルとも「前期までの実績→当期の市場入力」の片方向。
// 当期の決定・結果が当期の価格・需要へ再帰する経路はない（consumerInventory.ts
// と同じ循環回避規約）。
//
// 【決定論】乱数不使用。状態更新は純粋関数。

import { unwrapUnit } from "../core/units";
import { MarketQuarterResult, Product } from "../market/types";
import { MarketProductMix, PRODUCT_LIFECYCLE_PARAMETERS_V1 } from "../market/productLifecycle";
import { DEMAND_MARKET_IDS, DemandMarketId } from "../market/types";

/** 1商品（pd/vap）ぶんの進化carry state。 */
export interface ProductEvolutionEntry {
  /** 供給圧力（5社提示量÷対象需要）のEWMA。1.0=需給均衡、>1=供給過剰。 */
  readonly supplyPressureEwma: number;
  /** 当期に適用したプレミアム比率倍率（次期の平滑化・変動上限の起点）。 */
  readonly premiumRatioMultiplier: number;
  /** 割安シグナルのEWMA（正=実現プレミアムが基準より安い状態が持続）。 */
  readonly affordabilitySignalEwma: number;
}

/** SAI-5Eのcarry state（CompanyLabState.marketEvolutionState）。 */
export interface MarketEvolutionState {
  readonly pd: ProductEvolutionEntry;
  readonly vap: ProductEvolutionEntry;
}

export interface MarketEvolutionParameters {
  /** 供給圧力EWMAの平滑化係数（新しい観測の重み）。 */
  readonly supplyPressureEwmaAlpha: number;
  /** 供給圧力→目標プレミアム倍率の感度（target = 1 − (pressure−1)×sensitivity）。 */
  readonly premiumTargetSensitivity: number;
  /** プレミアム倍率の四半期変動上限（±比率。急変防止、指示の±10〜15%の中間）。 */
  readonly premiumMultiplierMaxQuarterlyChange: number;
  /** プレミアム倍率の下限・上限。 */
  readonly premiumMultiplierFloor: number;
  readonly premiumMultiplierCap: number;
  /** 割安シグナルEWMAの平滑化係数（0.35 → 実効遅行約2〜3四半期）。 */
  readonly affordabilityEwmaAlpha: number;
  /** 割安シグナル→普及前倒し四半期数の感度（shift = signal × sensitivity）。 */
  readonly adoptionShiftSensitivityQuarters: number;
  /** PD⇔VAP代替の最大移動比率（当該商品構成比に対する割合。指示: 最大10%程度）。 */
  readonly substitutionMaxShare: number;
  /** 代替が発動し始めるプレミアム比の乖離しきい値（基準比に対する相対乖離）。 */
  readonly substitutionActivationThreshold: number;
}

/**
 * SAI-5Eの初期値（校正対象の暫定値）。
 * - premiumMultiplierMaxQuarterlyChange=0.12: 指示の±10〜15%の中間。
 * - premiumTargetSensitivity=0.5: 供給圧力が需要の2倍(pressure=2)でも目標倍率
 *   0.5（floor 0.6でclamp）に留まり、単四半期の提示過剰で価格が崩壊しない。
 * - affordability: alpha=0.35で2〜3四半期の遅行。sensitivity=8は「基準比から
 *   25%割安が持続すると普及が約2四半期前倒し」の水準（shift上限±4は
 *   productLifecycle側のmaxAdoptionTurnShiftでclamp）。
 * - substitution: 基準プレミアム比（vap/pd≈3.06）から10%を超えて縮小した分に
 *   比例して最大10%のPD需要シェアがVAPへ移動（逆方向も対称）。
 */
export const MARKET_EVOLUTION_PARAMETERS_V1: MarketEvolutionParameters = {
  supplyPressureEwmaAlpha: 0.4,
  premiumTargetSensitivity: 0.5,
  premiumMultiplierMaxQuarterlyChange: 0.12,
  premiumMultiplierFloor: 0.6,
  premiumMultiplierCap: 1.4,
  affordabilityEwmaAlpha: 0.35,
  adoptionShiftSensitivityQuarters: 8,
  substitutionMaxShare: 0.1,
  substitutionActivationThreshold: 0.1,
};

export function initialMarketEvolutionState(): MarketEvolutionState {
  const neutral: ProductEvolutionEntry = { supplyPressureEwma: 1, premiumRatioMultiplier: 1, affordabilitySignalEwma: 0 };
  return { pd: neutral, vap: neutral };
}

/** 当期実績からの更新入力。 */
export interface MarketEvolutionQuarterInputs {
  /** 5社が成約配分へ提示した商品別合計数量（HOSO換算トン）。 */
  readonly offeredByProduct: Readonly<Record<"pd" | "vap", number>>;
  /** 商品別の対象需要合計（deriveTargetDemandの商品合計、HOSO換算トン）。 */
  readonly targetDemandByProduct: Readonly<Record<"pd" | "vap", number>>;
  /** 当期の市場結果（実現プレミアムの読み取りのみ）。 */
  readonly marketResult: MarketQuarterResult;
  /** 基準プレミアム比率（MarketParameters.pdVapPremiumの基準値）。 */
  readonly referencePremiumRatios: Readonly<Record<"pd" | "vap", number>>;
}

const EPSILON = 1e-9;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function updateEntry(
  prev: ProductEvolutionEntry,
  product: "pd" | "vap",
  inputs: MarketEvolutionQuarterInputs,
  params: MarketEvolutionParameters
): ProductEvolutionEntry {
  // --- 供給圧力: 提示量/需要（需要ゼロなら中立1として扱う） ---
  const demand = inputs.targetDemandByProduct[product];
  const offered = inputs.offeredByProduct[product];
  const pressure = demand > EPSILON ? offered / demand : 1;
  const supplyPressureEwma =
    prev.supplyPressureEwma + params.supplyPressureEwmaAlpha * (clamp(pressure, 0, 5) - prev.supplyPressureEwma);

  // --- プレミアム倍率: 目標へ向かって平滑化＋四半期変動上限±12%＋床/天井 ---
  const target = clamp(1 - (supplyPressureEwma - 1) * params.premiumTargetSensitivity, params.premiumMultiplierFloor, params.premiumMultiplierCap);
  const maxStep = prev.premiumRatioMultiplier * params.premiumMultiplierMaxQuarterlyChange;
  const stepped = clamp(target, prev.premiumRatioMultiplier - maxStep, prev.premiumRatioMultiplier + maxStep);
  const premiumRatioMultiplier = clamp(stepped, params.premiumMultiplierFloor, params.premiumMultiplierCap);

  // --- 割安シグナル: 実現プレミアム比率 vs 基準比率（正=割安が持続） ---
  const premiumResult = product === "pd" ? inputs.marketResult.pdPremium : inputs.marketResult.vapPremium;
  const hosoPriceVn = unwrapUnit(inputs.marketResult.hosoPrices.VN.price);
  const realizedRatio = hosoPriceVn > EPSILON ? unwrapUnit(premiumResult.byCountry.VN.premium) / hosoPriceVn : inputs.referencePremiumRatios[product];
  const reference = inputs.referencePremiumRatios[product];
  const cheapness = reference > EPSILON ? clamp((reference - realizedRatio) / reference, -1, 1) : 0;
  const affordabilitySignalEwma = prev.affordabilitySignalEwma + params.affordabilityEwmaAlpha * (cheapness - prev.affordabilitySignalEwma);

  return { supplyPressureEwma, premiumRatioMultiplier, affordabilitySignalEwma };
}

/** 四半期末のcarry state更新（純粋関数・決定論的）。 */
export function updateMarketEvolutionState(
  prev: MarketEvolutionState | undefined,
  inputs: MarketEvolutionQuarterInputs,
  params: MarketEvolutionParameters = MARKET_EVOLUTION_PARAMETERS_V1
): MarketEvolutionState {
  const base = prev ?? initialMarketEvolutionState();
  return {
    pd: updateEntry(base.pd, "pd", inputs, params),
    vap: updateEntry(base.vap, "vap", inputs, params),
  };
}

/** 翌期の普及前倒しシフト（四半期数。productLifecycle側で±maxAdoptionTurnShiftへclampされる）。 */
export function deriveAdoptionTurnShift(
  state: MarketEvolutionState | undefined,
  params: MarketEvolutionParameters = MARKET_EVOLUTION_PARAMETERS_V1
): Readonly<Record<"pd" | "vap", number>> {
  if (!state) return { pd: 0, vap: 0 };
  return {
    pd: state.pd.affordabilitySignalEwma * params.adoptionShiftSensitivityQuarters,
    vap: state.vap.affordabilitySignalEwma * params.adoptionShiftSensitivityQuarters,
  };
}

/**
 * PD⇔VAP代替を構成比行列へ適用する（前期の実現プレミアム比に基づく決定論的な
 * 後処理。元商品から減らして先へ足すため各市場の行和=1は不変＝総需要保存）。
 *
 * - 実現プレミアム比 r = VAPプレミアム/PDプレミアム が基準比 r0 =
 *   vapBasePremiumRatio/pdBasePremiumRatio より「しきい値を超えて」縮小した場合
 *   （VAP価格がPDへ近づいた）: PD構成比の一部（最大substitutionMaxShare）をVAPへ移す。
 * - 逆にrがr0より拡大した場合（VAPが相対的に高い）: VAP構成比の一部をPDへ移す。
 * - HOSOは動かさない（HOSO⇔VAPの直接代替はPD⇔VAPより弱いという指示を
 *   保守的に0として開始。係数を外部化済みのため将来調整可能）。
 */
export function applyProductSubstitution(
  mix: MarketProductMix,
  priorMarketResult: MarketQuarterResult | undefined,
  referencePremiumRatios: Readonly<Record<"pd" | "vap", number>>,
  params: MarketEvolutionParameters = MARKET_EVOLUTION_PARAMETERS_V1
): { readonly mix: MarketProductMix; readonly substitutionShareShift: number } {
  if (!priorMarketResult) return { mix, substitutionShareShift: 0 };
  const pdPremium = unwrapUnit(priorMarketResult.pdPremium.byCountry.VN.premium);
  const vapPremium = unwrapUnit(priorMarketResult.vapPremium.byCountry.VN.premium);
  if (pdPremium <= EPSILON || referencePremiumRatios.pd <= EPSILON) return { mix, substitutionShareShift: 0 };

  const realizedRatio = vapPremium / pdPremium;
  const referenceRatio = referencePremiumRatios.vap / referencePremiumRatios.pd;
  const relativeGap = (realizedRatio - referenceRatio) / referenceRatio; // 負=VAPが相対的に安い

  let shift = 0; // 正=PD→VAPへ移動する比率、負=VAP→PDへ移動する比率
  if (relativeGap < -params.substitutionActivationThreshold) {
    shift = params.substitutionMaxShare * clamp((-relativeGap - params.substitutionActivationThreshold) / (1 - params.substitutionActivationThreshold), 0, 1);
  } else if (relativeGap > params.substitutionActivationThreshold) {
    shift = -params.substitutionMaxShare * clamp((relativeGap - params.substitutionActivationThreshold) / (1 - params.substitutionActivationThreshold), 0, 1);
  }
  if (shift === 0) return { mix, substitutionShareShift: 0 };

  const out = {} as Record<DemandMarketId, Record<Product, number>>;
  for (const market of DEMAND_MARKET_IDS) {
    const row = mix[market];
    if (shift > 0) {
      const moved = row.pd * shift; // PD需要の一部がVAPへ
      out[market] = { hoso: row.hoso, pd: row.pd - moved, vap: row.vap + moved };
    } else {
      const moved = row.vap * -shift; // VAP需要の一部がPDへ
      out[market] = { hoso: row.hoso, pd: row.pd + moved, vap: row.vap - moved };
    }
  }
  return { mix: out, substitutionShareShift: shift };
}

/**
 * 当期の市場計算に使うPD/VAPベースプレミアム比率の倍率（前期末のcarry stateから）。
 * 未初期化（機能OFF→ON直後の1期目等）は中立1。
 */
export function derivePremiumRatioMultipliers(state: MarketEvolutionState | undefined): Readonly<Record<"pd" | "vap", number>> {
  if (!state) return { pd: 1, vap: 1 };
  return { pd: state.pd.premiumRatioMultiplier, vap: state.vap.premiumRatioMultiplier };
}

/** 1四半期ぶんの記録（CompanyQuarterRecord.sai5MarketEvolution、ログ・分析用）。 */
export interface Sai5MarketEvolutionRecord {
  /** 当期に市場計算へ適用したプレミアム倍率（前期末state由来）。 */
  readonly appliedPremiumRatioMultipliers: Readonly<Record<"pd" | "vap", number>>;
  /** 当期に適用した普及前倒しシフト（四半期数、clamp前の導出値）。 */
  readonly appliedAdoptionTurnShift: Readonly<Record<"pd" | "vap", number>>;
  /** 当期に適用したPD⇔VAP代替の移動比率（正=PD→VAP）。 */
  readonly substitutionShareShift: number;
  /** 当期に実際に適用した市場×商品構成比（ライフサイクル+代替適用後）。 */
  readonly appliedMix?: MarketProductMix;
  /** 当期実績から更新した供給圧力（提示量/需要）。 */
  readonly supplyPressureByProduct: Readonly<Record<"pd" | "vap", number>>;
  /** 商品別の提示量・対象需要（供給圧力の分子・分母、HOSO換算トン）。 */
  readonly offeredByProduct: Readonly<Record<"pd" | "vap", number>>;
  readonly targetDemandByProduct: Readonly<Record<"pd" | "vap", number>>;
}
