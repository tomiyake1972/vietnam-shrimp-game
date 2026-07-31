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
import { MarketProductMix } from "../market/productLifecycle";
import { DEMAND_MARKET_IDS, DemandMarketId } from "../market/types";

/**
 * 供給圧力の定義（分子・分母の意味をそろえるための候補）。
 * 【SAI-5 監査指摘B】どれを採用したか・他をなぜ棄却したかは
 * docs/v2/design/sai5_market_evolution_design.md §2.6 に記録する。
 */
export type SupplyPressureDefinition =
  /** 旧実装（棄却）: 5社の提示量 ÷ 全ベトナム対象需要。分子は5社、分母は全ベトナムでスケールが違い1.0を中心にできない。 */
  | "raw_target_demand"
  /** 候補(i): 5社の提示量 ÷ 5社が構造的に配分を受けられる需要（対象需要×5社の均衡シェア）。 */
  | "addressable_demand"
  /** 候補(ii): 生の比率を、同じ比率の長期EWMA（中立ベースライン）で正規化した無次元指数。 */
  | "neutral_baseline"
  /** 候補(iii): 分子を「5社提示量＋外部供給量」に補完し、全ベトナム対象需要と同じ母集団にそろえる。 */
  | "completed_supply";

/** 1商品（pd/vap）ぶんの進化carry state。 */
export interface ProductEvolutionEntry {
  /** 供給圧力のEWMA。1.0=需給均衡、>1=供給過剰。定義はSupplyPressureDefinition参照。 */
  readonly supplyPressureEwma: number;
  /** 当期に適用したプレミアム比率倍率（次期の平滑化・変動上限の起点）。 */
  readonly premiumRatioMultiplier: number;
  /** 割安シグナルのEWMA（正=実現プレミアムが基準より安い状態が持続）。 */
  readonly affordabilitySignalEwma: number;
  /**
   * 候補(ii) neutral_baseline 専用の遅いEWMA（生比率の長期基準）。
   * 他の定義では未使用（undefined）。
   */
  readonly supplyRatioBaselineEwma?: number;
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
  /** 供給圧力の定義（監査指摘Bの構造修正）。 */
  readonly supplyPressureDefinition: SupplyPressureDefinition;
  /** 候補(ii)専用: 中立ベースラインEWMAの平滑化係数（小さいほど基準が遅く動く）。 */
  readonly supplyRatioBaselineEwmaAlpha: number;
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
  // 【監査指摘B・採用】実測比較（scripts/sai5SupplyPressureStudy.ts、4seed×32Q）の
  // 結果、中立状態で1.0を中心にできたのは completed_supply だけだった。
  // 採否の根拠は docs/v2/design/sai5_market_evolution_design.md §2.6 に記録。
  supplyPressureDefinition: "completed_supply",
  supplyRatioBaselineEwmaAlpha: 0.12,
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
  /**
   * 【監査指摘B】5社が構造的に配分を受けられる需要（＝分子と母集団をそろえた分母）。
   * 対象需要 × 5社の水位法均衡シェア（後述 computeAddressableDemand）。
   */
  readonly addressableDemandByProduct: Readonly<Record<"pd" | "vap", number>>;
  /** 外部選択肢（非5社供給）へ流れた需要の商品別合計（候補(iii)の分子補完に使う）。 */
  readonly externalOptionQuantityByProduct: Readonly<Record<"pd" | "vap", number>>;
  /** 当期の市場結果（実現プレミアムの読み取りのみ）。 */
  readonly marketResult: MarketQuarterResult;
  /** 基準プレミアム比率（MarketParameters.pdVapPremiumの基準値）。 */
  readonly referencePremiumRatios: Readonly<Record<"pd" | "vap", number>>;
}

const EPSILON = 1e-9;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * 【監査指摘B・構造修正の中核】1つの市場×商品について、5社が構造的に配分を
 * 受けられる需要（addressable demand）を返す。
 *
 * 成約配分は水位法（allocation.ts）で、5社と外部選択肢（他産地供給者・非購入、
 * ウェイト externalOptionWeight）が対象需要という予算を奪い合う。誰も上限に
 * 当たっていない均衡では、5社の取り分は
 *
 *     targetDemand × Σᵢwᵢ / (Σᵢwᵢ + w_ext)
 *
 * になる。つまり「5社が全力で提示したときに取れる量」がこれであり、これを
 * 分母に置くと供給圧力は
 *
 *     pressure = 5社提示量 ÷ 5社が取れる量
 *
 * となって分子・分母の母集団が一致し、「ちょうど取れる分だけ提示している中立
 * 状態」で厳密に1.0になる。旧実装は分母が全ベトナム対象需要だったため、分子が
 * 5社だけなのに分母が全体という非対称があり、構造的に1.0を中心にできなかった。
 *
 * 係数は externalOptionWeight（既存の設計パラメータ）と、当期に実際に配分へ
 * 使われた各社の競争力ウェイトだけで決まる。A/B結果に合わせて後から当てはめた
 * 定数・会社別の補正は一切含まない。
 */
export function computeAddressableDemand(targetDemand: number, totalCompanyWeight: number, externalOptionWeight: number): number {
  const denominator = totalCompanyWeight + externalOptionWeight;
  if (!(denominator > EPSILON) || !(targetDemand > EPSILON)) return 0;
  return targetDemand * (totalCompanyWeight / denominator);
}

/**
 * 当期の生の供給圧力（EWMA適用前）を、採用した定義に従って計算する。
 * 需要ゼロ・分母ゼロは中立1として扱う（発散を構造的に排除）。
 */
export function computeRawSupplyPressure(
  product: "pd" | "vap",
  inputs: MarketEvolutionQuarterInputs,
  params: MarketEvolutionParameters,
  prevBaselineEwma: number | undefined
): { readonly pressure: number; readonly nextBaselineEwma: number | undefined } {
  const targetDemand = inputs.targetDemandByProduct[product];
  const offered = inputs.offeredByProduct[product];
  const rawRatio = targetDemand > EPSILON ? offered / targetDemand : 1;

  switch (params.supplyPressureDefinition) {
    case "raw_target_demand":
      return { pressure: rawRatio, nextBaselineEwma: undefined };

    case "addressable_demand": {
      const addressable = inputs.addressableDemandByProduct[product];
      return { pressure: addressable > EPSILON ? offered / addressable : 1, nextBaselineEwma: undefined };
    }

    case "neutral_baseline": {
      // 生比率を、同じ比率の遅いEWMA（中立ベースライン）で割った無次元指数。
      // 定常状態では定義上1.0へ収束する。
      const baseline = prevBaselineEwma !== undefined && prevBaselineEwma > EPSILON ? prevBaselineEwma : rawRatio;
      const pressure = baseline > EPSILON ? rawRatio / baseline : 1;
      const nextBaselineEwma = baseline + params.supplyRatioBaselineEwmaAlpha * (rawRatio - baseline);
      return { pressure, nextBaselineEwma };
    }

    case "completed_supply": {
      // 【採用】分子を「5社提示量＋外部選択肢が実際に埋めた量」に補完し、
      // 全ベトナム対象需要と同じ母集団にそろえる。
      //
      // 外部選択肢が埋めた量は水位法の残差（＝対象需要 − 5社成約量）なので、
      // この式は代数的に
      //     pressure = 1 + (5社の提示量 − 5社の成約量) / 対象需要
      // と等しい。つまり「5社が売りたかったのに売れ残った量が、市場需要の
      // 何％にあたるか」という、意味の明確な供給過剰指標になる。
      //   - 提示した分がすべて成約した中立状態 → 厳密に1.0
      //   - 提示だけ増やす → 売れ残りが増えて上昇
      //   - 提示を減らす → 売れ残りが減って1.0へ低下
      // 分子・分母はどちらも「同じ市場×商品のHOSO換算トン」で母集団が一致する。
      //
      // 【外部選択肢との二重計上について】外部選択肢の数量はここで1度だけ、
      // 「市場全体の供給量を数える」目的に使う。プレミアムへ別経路で加算する
      // ことはないため、二重計上にはあたらない。
      //
      // 【1.0が下限になることの意味】本モデルの外部選択肢は上限なし（完全弾力的）
      // として定義されているため、市場が構造的に供給不足になることは起こり得ない。
      // したがって供給圧力は1.0を下回らず、プレミアム倍率は中立1.0以下の範囲で
      // 動く（供給過剰でプレミアムが下がり、過剰が解消すると1.0へ回復する）。
      // 対称な上振れを作るには根拠のない基準定数が必要になるため採らない。
      const total = offered + inputs.externalOptionQuantityByProduct[product];
      return { pressure: targetDemand > EPSILON ? total / targetDemand : 1, nextBaselineEwma: undefined };
    }
  }
}

function updateEntry(
  prev: ProductEvolutionEntry,
  product: "pd" | "vap",
  inputs: MarketEvolutionQuarterInputs,
  params: MarketEvolutionParameters
): ProductEvolutionEntry {
  // --- 供給圧力: 採用した定義で算出（分子・分母の母集団を一致させる） ---
  const { pressure, nextBaselineEwma } = computeRawSupplyPressure(product, inputs, params, prev.supplyRatioBaselineEwma);
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

  return {
    supplyPressureEwma,
    premiumRatioMultiplier,
    affordabilitySignalEwma,
    ...(nextBaselineEwma !== undefined ? { supplyRatioBaselineEwma: nextBaselineEwma } : {}),
  };
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
  /** 当期実績から更新した生の供給圧力（採用定義で算出、EWMA適用前）。 */
  readonly supplyPressureByProduct: Readonly<Record<"pd" | "vap", number>>;
  /** EWMA適用後の供給圧力（＝実際に翌期プレミアム倍率を決める値）。 */
  readonly supplyPressureEwmaByProduct: Readonly<Record<"pd" | "vap", number>>;
  /** 商品別の提示量・対象需要・addressable需要・外部流出量（HOSO換算トン、監査可能性のため生値を保存）。 */
  readonly offeredByProduct: Readonly<Record<"pd" | "vap", number>>;
  readonly targetDemandByProduct: Readonly<Record<"pd" | "vap", number>>;
  readonly addressableDemandByProduct: Readonly<Record<"pd" | "vap", number>>;
  readonly externalOptionQuantityByProduct: Readonly<Record<"pd" | "vap", number>>;
  /** この四半期に用いた供給圧力の定義（後からの再現・監査用）。 */
  readonly supplyPressureDefinition: SupplyPressureDefinition;
}
