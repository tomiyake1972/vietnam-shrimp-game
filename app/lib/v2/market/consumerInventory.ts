// ShrimpX V2 — 消費国在庫・購買循環モデル（Phase 8F-1）
//
// 【背景・目的】
//   Phase 8F-1以前、市場別「需要」は実質的に「購買量」であり、最終消費・在庫・
//   購買が1本の数字に混同されていた（監査結果 §1参照）。本モジュールは、
//   各消費市場（CN/US/EU/JP/OTHER）について
//     最終消費 → 消費国在庫 → 輸入・購買
//   の3層を導入し、
//     - 消費は前期消費・景気・季節性・遅行価格効果でゆっくり動く
//     - 購買は消費だけでなく在庫水準・現在価格に反応し、消費より先に動く
//     - 購買された商品はいったん在庫へ入り、消費は在庫から払い出される
//   という循環を表現する。
//
// 【既存モジュールとの関係・二重計上の防止】
//   - market/globalDemand.ts の calculateWorldDemand/calculateMarketDemand
//     （原産国側のHOSO/PD/VAP国際価格形成が使う「世界需要」）は一切変更しない。
//     国際価格形成（hosoPricing.ts・productPremium.ts）は原産国（EC/IN/ID/VN）を
//     軸にした別の層であり、本モジュールが対象とする消費市場（CN/US/EU/JP/OTHER）
//     の在庫・購買循環とは独立に動作し続ける（監査結果 §3参照。ここを変更すると
//     全原産国の価格形成という別の大きな層まで巻き込むため、意図的に対象外とする）。
//   - 二重計上が実際に起きていたのは sales/marketAdapter.ts の deriveTargetDemand
//     （市場別の対象需要を、静的な「前期消費量」の構成比だけで按分していた箇所）
//     である。本モジュールが計算する desiredPurchaseTons が、その構成比の
//     唯一の入れ替え先になる（sales/marketAdapter.ts 側で明示的に差し替える）。
//   - 本モジュールの「消費」（plannedConsumptionTons/realizedConsumptionTons）は
//     完全に新しい状態であり、DemandMarketInput.priorPeriodConsumption
//     （既存フィールド、意味は変更しない）を「前期の消費実績の初期値・入力」
//     としてのみ読む。
//
// 【単位】
//   数量は市場別・全商品合計のHOSO換算トン（HosoEqTons）。細分化（HOSO/PD/VAP別、
//   サイズ別、原産国別、顧客別）はPhase 8F-1のスコープ外（実装指示 §4）。
//   在庫月数（コペレッジ）は月単位。1四半期＝3か月として換算する。
//   価格はUSD/HOSO換算kg（production/yieldConversion.tsのPD/VAP物理歩留まりは
//   一切参照しない）。
//
// 【時系列（循環参照の回避）】
//   当四半期の購買量への短期価格反応は、当四半期開始時点で既知の価格
//   （＝前四半期に確定した市場参照価格。priceHistory の最新値）を使う。
//   消費への遅行価格効果は、それよりもさらに過去（1〜2四半期前）の価格を使う。
//   したがって、当四半期の購買圧力・在庫逼迫度から算出する価格調整は、
//   「次四半期」の市場参照価格へ反映する（sales/marketAdapter.tsの
//   deriveVietnamMarketReferencePricesが使うdestinationMarketPriceCoefficientsを
//   四半期ごとに差し替える形で接続する）。同一四半期内で「価格が購買を動かし、
//   購買が同じ四半期の価格を動かす」という連立方程式にはならない。

import { HosoEqTons, hosoEqTons, unwrapUnit } from "../core/units";
import { PeriodV2, toYearQuarter } from "../core/period";
import { DemandMarketId, DEMAND_MARKET_IDS, DemandMarketInput } from "./types";
import { DestinationMarketPriceCoefficientTable, DestinationMarketPriceCoefficients } from "./destinationPricingParameters";
import { assertFinite, clamp, safeDivide } from "./validation";

// ---------------------------------------------------------------------
// 1. 市場局面
// ---------------------------------------------------------------------

/** 市場の在庫・購買局面。 */
export type MarketPhase = "restocking" | "balanced" | "destocking" | "tight";

// ---------------------------------------------------------------------
// 2. パラメータ（唯一の集約地点）
// ---------------------------------------------------------------------

/**
 * 1市場ぶんの消費国在庫・購買循環パラメータ。すべての係数・clampはこの1か所へ
 * 集約する（実装指示 §8「係数とclampは一か所へ集約し、根拠コメントを付ける」）。
 */
export interface ConsumerMarketInventoryParameters {
  /**
   * 基準の目標在庫月数（在庫月数＝在庫トン数 ÷ 月間消費トン数）。
   * 【値の根拠（暫定値・要校正）】32四半期シミュレーションで在庫が発散せず、
   * かつ在庫調整サイクルが数四半期で観測できる水準として設定した。
   */
  readonly targetCoverageMonthsBase: number;
  /** 目標在庫月数の変動許容範囲（下限・上限）。無制限な発散を防ぐ。 */
  readonly targetCoverageMonthsMin: number;
  readonly targetCoverageMonthsMax: number;
  /**
   * 在庫調整速度（0〜1）。1四半期で埋め合わせる在庫ギャップの比率。
   * 1.0=1四半期で全量埋め合わせ（実装指示 §8「在庫調整は一四半期で全量
   * 完了せず」に反するため1.0は使わない）。
   */
  readonly inventoryAdjustmentSpeed: number;
  /** 消費の遅行価格効果に使う四半期ラグ数（1〜2四半期。実装指示 §6）。 */
  readonly consumptionPriceLagQuarters: 1 | 2;
  /**
   * 消費の価格弾力性（負の値。価格が平常より下がると消費が緩やかに増える）。
   * laggedPriceFactor = 1 + consumptionPriceElasticity × 価格乖離率。
   */
  readonly consumptionPriceElasticity: number;
  /**
   * 購買の即時価格弾力性（正の値。価格が平常より下がると当期の購買量が増える）。
   * 消費より購買が先に動く、という実装指示 §6の要件を担う中心係数。
   */
  readonly purchasePriceElasticity: number;
  /** 消費成長時に目標在庫（≒目標在庫月数）を積み増す感度。 */
  readonly restockingSensitivity: number;
  /** 現在価格が平常より安いとき、積み増し意欲（目標在庫月数）を強める感度。 */
  readonly discountRestockingSensitivity: number;
  /**
   * 供給不安による安全在庫の上乗せ（目標在庫月数への加算比率）。実装指示 §7
   * 「供給不安の指標が無ければ中立値で構わない」に従い、Phase 8F-1では
   * 市場別の中立〜小さな固定値として持つ（架空の供給リスク指標は作らない）。
   */
  readonly supplyRiskCoverageMonthsAddOn: number;
  /**
   * 金利・保管費の高さによる在庫意欲の減衰（0〜1、1に近いほど減衰なし）。
   * 実装指示 §7に従い、既存の利用可能な金利指標が無いため市場別定数とする。
   */
  readonly carryingCostDampingFactor: number;
  /**
   * 継続的な価格下落期待を抑える減衰係数（0〜1）。直近2四半期とも価格が
   * 平常より安く、かつ下落継続中のときにのみ適用し、「買い急ぎの際限ない
   * 加速」を防ぐ（実装指示 §7「継続的な価格下落期待：買い急ぎを抑える」）。
   */
  readonly sustainedDeclineDampingFactor: number;
  /** 四半期番号（1〜4）ごとの消費季節性係数（1.0=季節影響なし）。 */
  readonly seasonalMultiplierByQuarter: Readonly<Record<1 | 2 | 3 | 4, number>>;
  /**
   * 希望購買量の下限・上限（期待消費量に対する比率）。負値・異常な急増を
   * 防ぐための最終clamp（実装指示 §8）。
   */
  readonly desiredPurchaseMinRatioOfConsumption: number;
  readonly desiredPurchaseMaxRatioOfConsumption: number;
  /**
   * 市場参照価格の「平常価格」（USD/HOSO換算kg）。価格履歴が無い初期状態の
   * 種値、および価格乖離率の基準として使う（実装指示 §6「ゲーム開始直後に
   * 不自然な価格効果が出ないようにする」に対応）。
   */
  readonly normalPriceUsdPerHosoEqKg: number;
  /** 購買圧力指数を価格式へ反映する係数（主因。実装指示 §11）。 */
  readonly purchasePressurePriceWeight: number;
  /** 在庫逼迫度指数を価格式へ反映する係数（補助的。purchasePressurePriceWeightより小さくする）。 */
  readonly inventoryTightnessPriceWeight: number;
  /** 価格式へ入る前の購買圧力指数のclamp範囲（絶対値）。 */
  readonly purchasePressureClampForPricing: number;
  /** 仕向市場別価格調整比率（1四半期あたり）の最大変化幅（絶対値）。 */
  readonly maxQuarterlyPriceAdjustmentRatio: number;
  /** marketPhase判定のしきい値。 */
  readonly phaseThresholds: {
    /** 在庫月数が 目標在庫月数×この比率 を下回ったら "tight"。 */
    readonly tightCoverageRatio: number;
    /** 購買圧力指数の絶対値がこの値を超えたら restocking/destocking。 */
    readonly pressureThreshold: number;
  };
}

export type ConsumerMarketInventoryParameterTable = Readonly<Record<DemandMarketId, ConsumerMarketInventoryParameters>>;

/**
 * 【市場別の性格づけ（実装指示 §12の方向性表に対応。数値は32四半期シミュレーション
 * を見ながらの暫定値・要校正）】
 *   US: 景気・価格・販促への反応が大きい／安値で積み増し・在庫調整も大きい
 *       → purchasePriceElasticity・discountRestockingSensitivity・
 *         inventoryAdjustmentSpeedを高めに。
 *   JP: 消費変化が緩やか／計画購買中心・在�庫調整も穏やか
 *       → consumptionPriceElasticity・inventoryAdjustmentSpeedを低めに、
 *         targetCoverageMonthsBaseを高め（計画的に多めの在庫を持つ）。
 *   CN: 価格感応度・季節性が高い／買い急ぎ・買い控えの振幅が大きい
 *       → purchasePriceElasticity・restockingSensitivity・seasonalityを高めに。
 *   EU: 景気・小売価格の影響を受ける／金利・保管費を意識し慎重
 *       → carryingCostDampingFactorを低め（在庫意欲を強く減衰）に。
 *   OTHER: 上記4市場の平均的な性格（残余市場のため中庸値）。
 */
export const CONSUMER_MARKET_INVENTORY_PARAMETERS_V1: ConsumerMarketInventoryParameterTable = {
  US: {
    targetCoverageMonthsBase: 2.5,
    targetCoverageMonthsMin: 1.2,
    targetCoverageMonthsMax: 4.5,
    inventoryAdjustmentSpeed: 0.45,
    consumptionPriceLagQuarters: 1,
    consumptionPriceElasticity: -0.35,
    purchasePriceElasticity: 0.6,
    restockingSensitivity: 1.8,
    discountRestockingSensitivity: 1.2,
    supplyRiskCoverageMonthsAddOn: 0.1,
    carryingCostDampingFactor: 0.9,
    sustainedDeclineDampingFactor: 0.7,
    seasonalMultiplierByQuarter: { 1: 0.97, 2: 0.99, 3: 1.0, 4: 1.06 },
    desiredPurchaseMinRatioOfConsumption: 0.3,
    desiredPurchaseMaxRatioOfConsumption: 2.2,
    normalPriceUsdPerHosoEqKg: 6.4,
    purchasePressurePriceWeight: 0.5,
    inventoryTightnessPriceWeight: 0.15,
    purchasePressureClampForPricing: 0.6,
    maxQuarterlyPriceAdjustmentRatio: 0.08,
    phaseThresholds: { tightCoverageRatio: 0.6, pressureThreshold: 0.08 },
  },
  JP: {
    targetCoverageMonthsBase: 3.2,
    targetCoverageMonthsMin: 1.8,
    targetCoverageMonthsMax: 5.0,
    inventoryAdjustmentSpeed: 0.3,
    consumptionPriceLagQuarters: 2,
    consumptionPriceElasticity: -0.15,
    purchasePriceElasticity: 0.3,
    restockingSensitivity: 1.0,
    discountRestockingSensitivity: 0.6,
    supplyRiskCoverageMonthsAddOn: 0.2,
    carryingCostDampingFactor: 0.85,
    sustainedDeclineDampingFactor: 0.8,
    seasonalMultiplierByQuarter: { 1: 1.05, 2: 0.97, 3: 0.96, 4: 1.02 },
    desiredPurchaseMinRatioOfConsumption: 0.4,
    desiredPurchaseMaxRatioOfConsumption: 1.8,
    normalPriceUsdPerHosoEqKg: 7.0,
    purchasePressurePriceWeight: 0.4,
    inventoryTightnessPriceWeight: 0.12,
    purchasePressureClampForPricing: 0.5,
    maxQuarterlyPriceAdjustmentRatio: 0.06,
    phaseThresholds: { tightCoverageRatio: 0.6, pressureThreshold: 0.06 },
  },
  CN: {
    targetCoverageMonthsBase: 2.0,
    targetCoverageMonthsMin: 0.8,
    targetCoverageMonthsMax: 4.0,
    inventoryAdjustmentSpeed: 0.55,
    consumptionPriceLagQuarters: 1,
    consumptionPriceElasticity: -0.45,
    purchasePriceElasticity: 0.8,
    restockingSensitivity: 2.2,
    discountRestockingSensitivity: 1.6,
    supplyRiskCoverageMonthsAddOn: 0.15,
    carryingCostDampingFactor: 0.95,
    sustainedDeclineDampingFactor: 0.6,
    seasonalMultiplierByQuarter: { 1: 1.12, 2: 0.95, 3: 0.94, 4: 1.03 },
    desiredPurchaseMinRatioOfConsumption: 0.25,
    desiredPurchaseMaxRatioOfConsumption: 2.5,
    normalPriceUsdPerHosoEqKg: 6.0,
    purchasePressurePriceWeight: 0.55,
    inventoryTightnessPriceWeight: 0.18,
    purchasePressureClampForPricing: 0.7,
    maxQuarterlyPriceAdjustmentRatio: 0.09,
    phaseThresholds: { tightCoverageRatio: 0.55, pressureThreshold: 0.09 },
  },
  EU: {
    targetCoverageMonthsBase: 2.7,
    targetCoverageMonthsMin: 1.3,
    targetCoverageMonthsMax: 4.2,
    inventoryAdjustmentSpeed: 0.35,
    consumptionPriceLagQuarters: 2,
    consumptionPriceElasticity: -0.25,
    purchasePriceElasticity: 0.45,
    restockingSensitivity: 1.3,
    discountRestockingSensitivity: 0.8,
    supplyRiskCoverageMonthsAddOn: 0.15,
    carryingCostDampingFactor: 0.75,
    sustainedDeclineDampingFactor: 0.75,
    seasonalMultiplierByQuarter: { 1: 0.98, 2: 0.99, 3: 0.98, 4: 1.05 },
    desiredPurchaseMinRatioOfConsumption: 0.35,
    desiredPurchaseMaxRatioOfConsumption: 1.9,
    normalPriceUsdPerHosoEqKg: 6.8,
    purchasePressurePriceWeight: 0.45,
    inventoryTightnessPriceWeight: 0.13,
    purchasePressureClampForPricing: 0.55,
    maxQuarterlyPriceAdjustmentRatio: 0.07,
    phaseThresholds: { tightCoverageRatio: 0.6, pressureThreshold: 0.07 },
  },
  OTHER: {
    targetCoverageMonthsBase: 2.6,
    targetCoverageMonthsMin: 1.2,
    targetCoverageMonthsMax: 4.2,
    inventoryAdjustmentSpeed: 0.4,
    consumptionPriceLagQuarters: 1,
    consumptionPriceElasticity: -0.3,
    purchasePriceElasticity: 0.5,
    restockingSensitivity: 1.5,
    discountRestockingSensitivity: 1.0,
    supplyRiskCoverageMonthsAddOn: 0.15,
    carryingCostDampingFactor: 0.85,
    sustainedDeclineDampingFactor: 0.7,
    seasonalMultiplierByQuarter: { 1: 1.0, 2: 1.0, 3: 1.0, 4: 1.03 },
    desiredPurchaseMinRatioOfConsumption: 0.3,
    desiredPurchaseMaxRatioOfConsumption: 2.0,
    normalPriceUsdPerHosoEqKg: 6.3,
    purchasePressurePriceWeight: 0.45,
    inventoryTightnessPriceWeight: 0.14,
    purchasePressureClampForPricing: 0.6,
    maxQuarterlyPriceAdjustmentRatio: 0.07,
    phaseThresholds: { tightCoverageRatio: 0.6, pressureThreshold: 0.07 },
  },
};

// ---------------------------------------------------------------------
// 3. 状態（永続化される最小限のcarry state）
// ---------------------------------------------------------------------

/**
 * 四半期をまたいで保持する最小限の状態（1市場ぶん）。これ以外の値
 * （目標在庫・購買量・局面等）はすべて派生値であり、毎期この状態から
 * 再計算する（実装指示§17「派生値を過剰に保存しない」と同じ方針）。
 */
export interface ConsumerMarketCarryState {
  readonly market: DemandMarketId;
  /** 前四半期末の在庫（＝当四半期の期首在庫）。 */
  readonly openingInventoryTons: HosoEqTons;
  /** 前四半期の実現消費量（当四半期の消費成長率算出の基礎）。 */
  readonly priorConsumptionTons: HosoEqTons;
  /**
   * 直近の市場参照価格履歴（USD/HOSO換算kg、古い順）。consumptionPriceLagQuarters
   * （最大2）四半期ぶん遡れるよう、常に最大3件（当期算出前時点でN+1件）を保持する。
   */
  readonly priceHistoryUsdPerHosoEqKg: readonly number[];
}

export type ConsumerMarketCarryStateTable = Readonly<Record<DemandMarketId, ConsumerMarketCarryState>>;

/**
 * 初期状態を組み立てる。実装指示§13「初期在庫は目標在庫付近から開始する」に
 * 従い、初期の期待消費量（priorPeriodConsumption）と目標在庫月数から
 * 決定論的に初期在庫を導出する（ゲーム開始直後の大規模な在庫調整を避ける）。
 * 価格履歴は normalPriceUsdPerHosoEqKg で初期化する（実装指示§6「価格履歴が
 * ない初期状態では現在価格または平常価格で履歴を初期化」）。
 */
export function buildInitialConsumerMarketCarryState(
  market: DemandMarketId,
  initialDemandInput: DemandMarketInput,
  params: ConsumerMarketInventoryParameters
): ConsumerMarketCarryState {
  const priorConsumption = Math.max(0, unwrapUnit(initialDemandInput.priorPeriodConsumption));
  const initialTargetInventory = priorConsumption * (params.targetCoverageMonthsBase / 3);
  return {
    market,
    openingInventoryTons: hosoEqTons(initialTargetInventory),
    priorConsumptionTons: hosoEqTons(priorConsumption),
    priceHistoryUsdPerHosoEqKg: [params.normalPriceUsdPerHosoEqKg, params.normalPriceUsdPerHosoEqKg],
  };
}

export function buildInitialConsumerMarketCarryStateTable(
  demandMarkets: Readonly<Record<DemandMarketId, DemandMarketInput>>,
  params: ConsumerMarketInventoryParameterTable = CONSUMER_MARKET_INVENTORY_PARAMETERS_V1
): ConsumerMarketCarryStateTable {
  const result = {} as Record<DemandMarketId, ConsumerMarketCarryState>;
  for (const market of DEMAND_MARKET_IDS) {
    result[market] = buildInitialConsumerMarketCarryState(market, demandMarkets[market], params[market]);
  }
  return result;
}

/**
 * carry stateが「未初期化のゼロ値」であるかどうかを判定する。
 *
 * 【永続化の後方互換での用途】Phase 8F-1より前（schemaVersion 3未満）の
 * 保存データにはこの状態が一切存在しない。companyLab/persistence/schema.ts の
 * validateConsumerMarketStateは、キー自体が無い場合に全市場をゼロ値
 * （本関数がtrueと判定する組み合わせ）で埋めて返し、
 * restoreCompanyLabStateFromRuntimeSnapshot がこの判定を使って「本当に
 * 未初期化かどうか」を判定したうえで、確定履歴の直近四半期のdemandMarkets
 * 入力から決定論的に再構築する（推測値は作らない。companyLab/workforce.ts の
 * isWorkforceStateEmptyと同じ「キーの有無で判定し、無ければ安全な既定値を
 * 補う」方式）。全市場の期首在庫・前期消費実績・価格履歴がすべてゼロ/空である
 * 場合のみtrueを返す（実際に一四半期でも進行したゲームでは通常あり得ない組み合わせ）。
 */
export function isConsumerMarketStateEmpty(table: ConsumerMarketCarryStateTable): boolean {
  return DEMAND_MARKET_IDS.every((market) => {
    const marketState = table[market];
    return (
      unwrapUnit(marketState.openingInventoryTons) === 0 &&
      unwrapUnit(marketState.priorConsumptionTons) === 0 &&
      marketState.priceHistoryUsdPerHosoEqKg.length === 0
    );
  });
}

// ---------------------------------------------------------------------
// 4. 計画（当期実購買量が確定する前に計算できるすべて）
// ---------------------------------------------------------------------

export interface ConsumerMarketPlanningResult {
  readonly market: DemandMarketId;
  readonly period: PeriodV2;
  readonly openingInventoryTons: HosoEqTons;
  readonly plannedConsumptionTons: HosoEqTons;
  readonly consumptionGrowthRate: number;
  readonly targetCoverageMonths: number;
  readonly targetInventoryTons: HosoEqTons;
  readonly inventoryGapRatio: number;
  /**
   * 在庫調整量（符号付き、HOSO換算トン）。目標在庫へ向けた埋め合わせの
   * 方向・大きさを表す差分であり、過剰在庫時は負値を取り得るため、0以上を
   * 強制するHosoEqTons（物理数量のブランド型）ではなくplain numberとする。
   */
  readonly inventoryAdjustmentTons: number;
  readonly desiredPurchaseTons: HosoEqTons;
  readonly purchasePressureIndex: number;
  /** 次四半期の購買圧力・在庫逼迫度を反映した仕向市場価格係数の算出に使う、当期の生の値。 */
  readonly currentPriceUsdPerHosoEqKg: number;
  readonly laggedPriceUsdPerHosoEqKg: number;
}

// ---------------------------------------------------------------------
// 3.5 構造需要アンカー（シナリオ opt-in）
// ---------------------------------------------------------------------

/**
 * 【解決する問題】本モデルは翌期の消費基準に前期の**実現**消費を使う
 * （rollCarryStateForward: priorConsumptionTons ← realizedConsumptionTons）。
 * 供給が届かなかった四半期は実現消費が計画消費を下回るため、その差だけ翌期の
 * 市場規模が縮む。縮んだ市場は desiredPurchase も小さくなり、
 * deriveMarketWeightsFromDesiredPurchase の按分ウェイトが下がって供給がさらに
 * 遠のく。復元力の無い正のフィードバックであり、baseline 32Q の実測では
 * 日本の対象需要が −99.3%、EUが −97.6% まで縮小して市場が事実上消滅していた。
 *
 * 【方針】長期の市場構造はシナリオが決め、短期の需給はこのモジュールが揺らす。
 * アンカーは「その市場に消費需要が存在し続ける」ことだけを守り、
 * 5社がそれを取れるかどうかには一切関与しない（販売保証ではない）。
 *
 * 【短期メカニクスは温存する】
 *  - 在庫の持ち越し（openingInventoryTons）はアンカーの有無に関係なく残る
 *  - 遅行価格効果・季節性・目標在庫・購買圧力・仕向市場価格係数もすべて従来どおり
 *  - realizedConsumption が計画を下回る（＝その四半期の需要は失われる）挙動も不変
 * 変わるのは「失われた需要が**翌期以降の市場規模そのもの**を恒久的に削るか」だけ。
 */
export interface StructuralDemandAnchorInput {
  /** その turn にシナリオが定義する構造需要水準（HOSO換算トン）。 */
  readonly structuralConsumptionTons: number;
  /** 前期実現消費を構造需要へ引き戻す強さ（0=従来挙動、1=構造需要をそのまま基準にする）。 */
  readonly pullStrength: number;
}

/**
 * 前期実現消費と構造需要を混ぜて、当期の消費基準を返す。
 * アンカー未指定・pullStrength=0 のときは前期実現消費をそのまま返す（従来挙動）。
 */
export function applyStructuralDemandAnchor(priorConsumptionTons: number, anchor?: StructuralDemandAnchorInput): number {
  if (anchor === undefined) return priorConsumptionTons;
  assertFinite(anchor.structuralConsumptionTons, "structuralConsumptionTons");
  assertFinite(anchor.pullStrength, "anchorPullStrength");
  const pull = clamp(anchor.pullStrength, 0, 1);
  if (pull <= 0) return priorConsumptionTons;
  const structural = Math.max(0, anchor.structuralConsumptionTons);
  return priorConsumptionTons + pull * (structural - priorConsumptionTons);
}

/** 価格乖離率 = (価格 - 平常価格) / 平常価格。負で割安、正で割高。 */
function priceDeviationRatio(priceUsdPerHosoEqKg: number, normalPriceUsdPerHosoEqKg: number): number {
  return safeDivide(priceUsdPerHosoEqKg - normalPriceUsdPerHosoEqKg, normalPriceUsdPerHosoEqKg);
}

function quarterOfPeriod(period: PeriodV2): 1 | 2 | 3 | 4 {
  return toYearQuarter(period).quarter;
}

/**
 * 当四半期の最終消費・目標在庫・希望購買量を計画する（実購買量が未確定の
 * 時点で呼べる。実購買量の確定後は settleConsumerMarketQuarter を呼ぶ）。
 */
export function planConsumerMarketQuarter(
  period: PeriodV2,
  carry: ConsumerMarketCarryState,
  demandInput: DemandMarketInput,
  params: ConsumerMarketInventoryParameters,
  demandShockFactor = 1,
  anchor?: StructuralDemandAnchorInput
): ConsumerMarketPlanningResult {
  assertFinite(demandInput.economicIndex, "economicIndex");
  assertFinite(demandInput.populationGrowthRate, "populationGrowthRate");
  assertFinite(demandShockFactor, "demandShockFactor");

  const history = carry.priceHistoryUsdPerHosoEqKg;
  const currentPrice = history.length > 0 ? history[history.length - 1] : params.normalPriceUsdPerHosoEqKg;
  const lagIndex = history.length - 1 - params.consumptionPriceLagQuarters;
  const laggedPrice = lagIndex >= 0 ? history[lagIndex] : params.normalPriceUsdPerHosoEqKg;

  // --- 1. 最終消費（実装指示§6）---
  const macroFactor = Math.max(0, demandInput.economicIndex);
  const seasonalFactor = params.seasonalMultiplierByQuarter[quarterOfPeriod(period)];
  const laggedDeviation = priceDeviationRatio(laggedPrice, params.normalPriceUsdPerHosoEqKg);
  const laggedPriceFactor = Math.max(0, 1 + params.consumptionPriceElasticity * laggedDeviation);
  const populationFactor = Math.max(0, 1 + demandInput.populationGrowthRate);
  const priorConsumption = unwrapUnit(carry.priorConsumptionTons);
  // 【構造需要アンカー】未指定時は priorConsumption そのもの（従来挙動）。
  const consumptionBasis = applyStructuralDemandAnchor(priorConsumption, anchor);
  const plannedConsumptionRaw = consumptionBasis * macroFactor * seasonalFactor * laggedPriceFactor * demandShockFactor * populationFactor;
  const plannedConsumptionTons = hosoEqTons(Math.max(0, plannedConsumptionRaw));

  const consumptionGrowthRate = safeDivide(unwrapUnit(plannedConsumptionTons) - priorConsumption, priorConsumption);

  // --- 2. 目標在庫（実装指示§7）---
  const currentDeviation = priceDeviationRatio(currentPrice, params.normalPriceUsdPerHosoEqKg);
  const cheapnessSignal = Math.max(0, -currentDeviation); // 割安なほど正
  const sustainedDecline =
    laggedDeviation < 0 && currentDeviation < 0 && currentDeviation <= laggedDeviation
      ? params.sustainedDeclineDampingFactor
      : 1;

  const targetCoverageMonthsRaw =
    (params.targetCoverageMonthsBase + params.supplyRiskCoverageMonthsAddOn) *
    (1 + params.restockingSensitivity * Math.max(0, consumptionGrowthRate)) *
    (1 + params.discountRestockingSensitivity * cheapnessSignal) *
    params.carryingCostDampingFactor *
    sustainedDecline;
  const targetCoverageMonths = clamp(targetCoverageMonthsRaw, params.targetCoverageMonthsMin, params.targetCoverageMonthsMax);

  const expectedConsumptionTons = unwrapUnit(plannedConsumptionTons);
  const targetInventoryTons = hosoEqTons(Math.max(0, expectedConsumptionTons * (targetCoverageMonths / 3)));

  // --- 3. 購買需要（実装指示§8）---
  const openingInventory = unwrapUnit(carry.openingInventoryTons);
  const targetInventoryValue = unwrapUnit(targetInventoryTons);
  const inventoryGapRatio = safeDivide(targetInventoryValue - openingInventory, targetInventoryValue);
  const inventoryAdjustmentTons = params.inventoryAdjustmentSpeed * (targetInventoryValue - openingInventory);
  assertFinite(inventoryAdjustmentTons, "inventoryAdjustmentTons");

  const shortTermPriceReactivity = params.purchasePriceElasticity * Math.max(0, -currentDeviation);
  const desiredPurchaseRaw = expectedConsumptionTons + inventoryAdjustmentTons + shortTermPriceReactivity * expectedConsumptionTons;
  const desiredPurchaseTons = hosoEqTons(
    clamp(
      desiredPurchaseRaw,
      params.desiredPurchaseMinRatioOfConsumption * expectedConsumptionTons,
      Math.max(
        params.desiredPurchaseMinRatioOfConsumption * expectedConsumptionTons,
        params.desiredPurchaseMaxRatioOfConsumption * expectedConsumptionTons
      )
    )
  );

  const purchasePressureIndex = safeDivide(unwrapUnit(desiredPurchaseTons) - expectedConsumptionTons, expectedConsumptionTons);

  return {
    market: carry.market,
    period,
    openingInventoryTons: carry.openingInventoryTons,
    plannedConsumptionTons,
    consumptionGrowthRate,
    targetCoverageMonths,
    targetInventoryTons,
    inventoryGapRatio,
    inventoryAdjustmentTons,
    desiredPurchaseTons,
    purchasePressureIndex,
    currentPriceUsdPerHosoEqKg: currentPrice,
    laggedPriceUsdPerHosoEqKg: laggedPrice,
  };
}

/**
 * 全市場ぶんの計画を組み立てる。
 *
 * `anchorPullStrength` を渡すと、各市場の構造需要（シナリオが当該 turn に定義した
 * priorPeriodConsumption。トレンド＋イベント効果適用後の値）へ消費基準を引き戻す。
 * 省略時は完全に従来挙動（既存シナリオ・既存テストへ影響しない）。
 */
export function planConsumerMarketQuarterTable(
  period: PeriodV2,
  carryTable: ConsumerMarketCarryStateTable,
  demandMarkets: Readonly<Record<DemandMarketId, DemandMarketInput>>,
  params: ConsumerMarketInventoryParameterTable = CONSUMER_MARKET_INVENTORY_PARAMETERS_V1,
  anchorPullStrength?: number
): Readonly<Record<DemandMarketId, ConsumerMarketPlanningResult>> {
  const result = {} as Record<DemandMarketId, ConsumerMarketPlanningResult>;
  for (const market of DEMAND_MARKET_IDS) {
    // 構造需要は「シナリオがその turn に定義した市場消費水準」＝ MarketQuarterInput
    // の priorPeriodConsumption（scenarioEngine が REGIONAL_DEMAND トレンドと
    // イベント効果から導いた値）。ここで新しい需要数値を発明しない。
    const anchor: StructuralDemandAnchorInput | undefined =
      anchorPullStrength !== undefined && anchorPullStrength > 0
        ? {
            structuralConsumptionTons: unwrapUnit(demandMarkets[market].priorPeriodConsumption),
            pullStrength: anchorPullStrength,
          }
        : undefined;
    result[market] = planConsumerMarketQuarter(period, carryTable[market], demandMarkets[market], params[market], 1, anchor);
  }
  return result;
}

// ---------------------------------------------------------------------
// 5. 希望購買量 → 対象需要（VNの市場別按分ウェイト）
// ---------------------------------------------------------------------

/**
 * 市場別のdesiredPurchaseTonsから、sales/marketAdapter.tsのderiveTargetDemandが
 * 使う「市場別ウェイト（構成比）」を作る。全市場合計desiredPurchaseが0の場合は
 * 等分（既存のderiveTargetDemandのフォールバックと同じ規約）。
 */
export function deriveMarketWeightsFromDesiredPurchase(
  planning: Readonly<Record<DemandMarketId, ConsumerMarketPlanningResult>>
): Readonly<Record<DemandMarketId, number>> {
  const total = DEMAND_MARKET_IDS.reduce((sum, m) => sum + Math.max(0, unwrapUnit(planning[m].desiredPurchaseTons)), 0);
  const result = {} as Record<DemandMarketId, number>;
  for (const market of DEMAND_MARKET_IDS) {
    result[market] = total > 0 ? Math.max(0, unwrapUnit(planning[market].desiredPurchaseTons)) / total : 1 / DEMAND_MARKET_IDS.length;
  }
  return result;
}

// ---------------------------------------------------------------------
// 6. 実購買量（VN＋非VN原産国の合算。実装指示§9）
// ---------------------------------------------------------------------

export interface OriginCountryMarketFigures {
  /** openHosoMarket/clearHosoMarketが算出済みの、この原産国の世界配分需要。 */
  readonly allocatedDemandTons: number;
  /** この原産国の輸出可能供給量。世界供給不足時の実購買量の上限として使う。 */
  readonly exportableSupplyTons: number;
}

/**
 * 市場別の実購買量を、VN（5社の実際の成約配分。企業の処理能力・営業体制の
 * 制約が既に反映済み）と非VN原産国（EC/IN/ID。会社別モデルが存在しないため、
 * その世界配分需要をVNと同じ市場別ウェイトで按分し、各国の輸出可能供給量で
 * 頭打ちする）の合算として求める。
 *
 * 【非VN原産国をこの方法で扱う理由（実装指示§9・§3のギャップに対する設計判断）】
 * 既存モデルには原産国×消費市場の内訳が存在しない（監査結果§5）。新たに
 * 複雑な原産国別・市場別シェアモデルを作る代わりに、VNの按分に使うのと
 * 同じ市場別ウェイト（desiredPurchaseTonsの構成比）を使う、という最小限の
 * 仮定を置く。これにより「世界供給が不足すれば実購買量が希望購買量を
 * 下回る」という要件を、既存のexportableSupply（原産国別の輸出可能供給量。
 * 新規追加ではない既存値）だけで満たせる。
 */
export function computeActualPurchaseByMarket(
  weightsByMarket: Readonly<Record<DemandMarketId, number>>,
  desiredPurchaseByMarket: Readonly<Record<DemandMarketId, HosoEqTons>>,
  vnActualPurchaseByMarket: Readonly<Record<DemandMarketId, HosoEqTons>>,
  nonVnOrigins: readonly OriginCountryMarketFigures[]
): Readonly<Record<DemandMarketId, HosoEqTons>> {
  const nonVnTotalAllocatedDemand = nonVnOrigins.reduce((sum, o) => sum + Math.max(0, o.allocatedDemandTons), 0);
  const nonVnTotalExportableSupply = nonVnOrigins.reduce((sum, o) => sum + Math.max(0, o.exportableSupplyTons), 0);

  const result = {} as Record<DemandMarketId, HosoEqTons>;
  for (const market of DEMAND_MARKET_IDS) {
    const weight = weightsByMarket[market];
    const nonVnDesiredForMarket = nonVnTotalAllocatedDemand * weight;
    const nonVnSupplyCeilingForMarket = nonVnTotalExportableSupply * weight;
    const nonVnActualForMarket = Math.min(Math.max(0, nonVnDesiredForMarket), Math.max(0, nonVnSupplyCeilingForMarket));

    const vnActual = Math.max(0, unwrapUnit(vnActualPurchaseByMarket[market]));
    const totalActualRaw = vnActual + nonVnActualForMarket;
    // 実購買量は希望購買量を上回らない（希望購買量自体が市場のこの四半期の
    // 上限的な意思決定であるため。企業配分・非VN按分の丸め誤差の吸収も兼ねる）。
    const desired = Math.max(0, unwrapUnit(desiredPurchaseByMarket[market]));
    result[market] = hosoEqTons(Math.min(totalActualRaw, Math.max(desired, totalActualRaw > desired ? desired : totalActualRaw)));
  }
  return result;
}

// ---------------------------------------------------------------------
// 7. 決算（実購買量確定後。在庫更新・局面判定）
// ---------------------------------------------------------------------

export interface ConsumerMarketQuarterRecord {
  readonly market: DemandMarketId;
  readonly period: PeriodV2;
  readonly openingInventoryTons: HosoEqTons;
  readonly plannedConsumptionTons: HosoEqTons;
  readonly realizedConsumptionTons: HosoEqTons;
  readonly targetInventoryTons: HosoEqTons;
  readonly desiredPurchaseTons: HosoEqTons;
  readonly actualPurchaseTons: HosoEqTons;
  /** 在庫調整量（符号付き、HOSO換算トン）。planningと同じ理由でplain number。 */
  readonly inventoryAdjustmentTons: number;
  readonly endingInventoryTons: HosoEqTons;
  readonly inventoryCoverageMonths: number;
  readonly targetCoverageMonths: number;
  readonly inventoryGapRatio: number;
  readonly consumptionGrowthRate: number;
  readonly purchasePressureIndex: number;
  readonly inventoryTightnessIndex: number;
  readonly marketPhase: MarketPhase;
}

function classifyMarketPhase(
  inventoryCoverageMonths: number,
  targetCoverageMonths: number,
  purchasePressureIndex: number,
  params: ConsumerMarketInventoryParameters
): MarketPhase {
  if (inventoryCoverageMonths < targetCoverageMonths * params.phaseThresholds.tightCoverageRatio) {
    return "tight";
  }
  if (purchasePressureIndex > params.phaseThresholds.pressureThreshold) {
    return "restocking";
  }
  if (purchasePressureIndex < -params.phaseThresholds.pressureThreshold) {
    return "destocking";
  }
  return "balanced";
}

/**
 * 実購買量確定後、在庫恒等式（実装指示§10）を守って四半期を確定する。
 *   endingInventoryTons = openingInventoryTons + actualPurchaseTons - realizedConsumptionTons
 * 供給不足で計画消費を賄えない場合は realizedConsumptionTons を縮小し、
 * 在庫を負にしない。未充足消費は失われた需要として扱う（繰越しない）。
 */
export function settleConsumerMarketQuarter(
  planning: ConsumerMarketPlanningResult,
  actualPurchaseTons: HosoEqTons,
  params: ConsumerMarketInventoryParameters
): ConsumerMarketQuarterRecord {
  const actualPurchase = Math.max(0, unwrapUnit(actualPurchaseTons));
  const opening = unwrapUnit(planning.openingInventoryTons);
  const availableForConsumption = opening + actualPurchase;
  const plannedConsumption = unwrapUnit(planning.plannedConsumptionTons);

  const realizedConsumption = Math.min(plannedConsumption, availableForConsumption);
  const endingInventoryRaw = availableForConsumption - realizedConsumption;
  const endingInventory = Math.max(0, endingInventoryRaw);

  const targetInventoryValue = unwrapUnit(planning.targetInventoryTons);
  const inventoryTightnessIndexRaw = safeDivide(targetInventoryValue - endingInventory, targetInventoryValue);
  const inventoryTightnessIndex = clamp(inventoryTightnessIndexRaw, -1, 1);

  const inventoryCoverageMonths = safeDivide(endingInventory * 3, realizedConsumption);

  const marketPhase = classifyMarketPhase(inventoryCoverageMonths, planning.targetCoverageMonths, planning.purchasePressureIndex, params);

  return {
    market: planning.market,
    period: planning.period,
    openingInventoryTons: planning.openingInventoryTons,
    plannedConsumptionTons: planning.plannedConsumptionTons,
    realizedConsumptionTons: hosoEqTons(realizedConsumption),
    targetInventoryTons: planning.targetInventoryTons,
    desiredPurchaseTons: planning.desiredPurchaseTons,
    actualPurchaseTons: hosoEqTons(actualPurchase),
    inventoryAdjustmentTons: planning.inventoryAdjustmentTons,
    endingInventoryTons: hosoEqTons(endingInventory),
    inventoryCoverageMonths,
    targetCoverageMonths: planning.targetCoverageMonths,
    inventoryGapRatio: planning.inventoryGapRatio,
    consumptionGrowthRate: planning.consumptionGrowthRate,
    purchasePressureIndex: planning.purchasePressureIndex,
    inventoryTightnessIndex,
    marketPhase,
  };
}

/**
 * 前四半期のcarry stateの価格履歴へ、当四半期の市場参照価格を追記して
 * 次の四半期用のcarry stateを作る（settleConsumerMarketQuarterとセットで使う）。
 * 履歴は直近3件までに切り詰める（consumptionPriceLagQuarters最大2 + 当期分）。
 */
export function rollCarryStateForward(
  previousCarry: ConsumerMarketCarryState,
  record: ConsumerMarketQuarterRecord,
  currentQuarterMarketPriceUsdPerHosoEqKg: number
): ConsumerMarketCarryState {
  const history = [...previousCarry.priceHistoryUsdPerHosoEqKg, currentQuarterMarketPriceUsdPerHosoEqKg];
  const trimmed = history.slice(Math.max(0, history.length - 3));
  return {
    market: record.market,
    openingInventoryTons: record.endingInventoryTons,
    priorConsumptionTons: record.realizedConsumptionTons,
    priceHistoryUsdPerHosoEqKg: trimmed,
  };
}

// ---------------------------------------------------------------------
// 8. 購買圧力・在庫逼迫度 → 仕向市場価格係数（実装指示§11）
// ---------------------------------------------------------------------

/**
 * 当四半期の購買圧力・在庫逼迫度から、次四半期の仕向市場価格係数を算出する。
 * 主因は購買圧力（希望購買量が通常消費・利用可能供給に対してどれだけ強いか）、
 * 在庫逼迫度は補助的なプレミアム／ディスカウントとする（実装指示§11、
 * 二重計上を避けるため重みはpurchasePressurePriceWeight >
 * inventoryTightnessPriceWeightとする）。
 *
 * 【既存の固定係数を残す】baseCoefficientsは物流費・品質嗜好・関税等の
 * 構造的な市場間価格差（destinationPricingParameters.ts）であり、本関数は
 * それを書き換えず、上に掛け算する形で動的な調整を乗せるだけ（実装指示§11
 * 「合理的な固定差は残す」）。
 *
 * 【成立済み契約価格への非遡及】この関数の出力は、次四半期の
 * deriveVietnamMarketReferencePrices（＝次四半期の新規成約の基準価格）
 * にのみ使われる。既存のSalesContractは作成時の価格を保持したまま変更
 * されない（sales/contracts.tsは一切参照しない）。
 */
export function deriveNextQuarterDestinationPriceCoefficients(
  records: Readonly<Record<DemandMarketId, ConsumerMarketQuarterRecord>>,
  baseCoefficients: DestinationMarketPriceCoefficientTable,
  params: ConsumerMarketInventoryParameterTable = CONSUMER_MARKET_INVENTORY_PARAMETERS_V1
): DestinationMarketPriceCoefficientTable {
  const result = {} as Record<DemandMarketId, DestinationMarketPriceCoefficients>;
  for (const market of DEMAND_MARKET_IDS) {
    const record = records[market];
    const p = params[market];
    const clampedPressure = clamp(record.purchasePressureIndex, -p.purchasePressureClampForPricing, p.purchasePressureClampForPricing);
    const adjustmentRatioRaw = p.purchasePressurePriceWeight * clampedPressure + p.inventoryTightnessPriceWeight * record.inventoryTightnessIndex;
    const adjustmentRatio = clamp(adjustmentRatioRaw, -p.maxQuarterlyPriceAdjustmentRatio, p.maxQuarterlyPriceAdjustmentRatio);
    const base = baseCoefficients[market];
    const factor = 1 + adjustmentRatio;
    result[market] = {
      baseValueCoefficient: base.baseValueCoefficient * factor,
      pdPremiumCoefficient: base.pdPremiumCoefficient * factor,
      vapPremiumCoefficient: base.vapPremiumCoefficient * factor,
    };
  }
  return result;
}

/** 現在の市場参照価格（当四半期に確定した価格）を、次四半期のcarry stateへ渡すための1指標へ束ねる。 */
export function computeBlendedMarketPriceIndex(
  marketReferencePricesForMarket: Readonly<Record<"hoso" | "pd" | "vap", number>>,
  productMixWeights: Readonly<Record<"hoso" | "pd" | "vap", number>>
): number {
  const totalWeight = productMixWeights.hoso + productMixWeights.pd + productMixWeights.vap;
  if (totalWeight <= 0) return marketReferencePricesForMarket.hoso;
  return (
    (marketReferencePricesForMarket.hoso * productMixWeights.hoso +
      marketReferencePricesForMarket.pd * productMixWeights.pd +
      marketReferencePricesForMarket.vap * productMixWeights.vap) /
    totalWeight
  );
}

// ---------------------------------------------------------------------
// 9. 画面・診断出力向け説明文
// ---------------------------------------------------------------------

export const CONSUMER_MARKET_INVENTORY_EXPLANATION_TEXT =
  "各市場の需要は、最終消費・消費国在庫・輸入購買の3層に分かれています。購買は消費だけでなく在庫水準と現在価格に反応し、消費より先に動きます。" +
  "購買された商品はいったん在庫へ入り、消費は在庫から払い出されます。";
