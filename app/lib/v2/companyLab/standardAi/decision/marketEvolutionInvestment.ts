// ShrimpX V2 — 標準AIの市場認識と投資タイミング判断（加工品市場進化 §h）
//
// 【スコープ（コーディネーター指示）】市場条件と見通しの**認識**と、それに基づく
// 投資タイミング判断を実装する。#05 の SAI-6.x 意思決定レイヤの再構成には踏み込まない。
// 既存の観測フィールド（lifecycleTrendByMarket / productSupplyPressureByProduct /
// marketPremiumByProduct / factories / cashUsd 等）を**拡張して使う**のであって、
// 並行する予測システムは作らない。
//
// 【固定ターンのルールにしないこと（実装指示の明示要求）】
// 「turn12になったら工場を建てる」というような時期直書きの規則は一切書かない。
// すべての判断は次の4つの観測量からのみ導く。
//   (1) 予測需要（公開ライフサイクルトレンドの外挿）
//   (2) 能力不足の予測（予測需要 × 現在の稼働率 vs 現在の能力）
//   (3) 期待回収（省人化なら人件費削減、VAP開発なら成約押し上げ）
//   (4) 現金余力（投資後に安全水準を割らないか）
// 結果として現れる時系列の振る舞い（序盤に小さく準備 → 黄金期に拡大 →
// 他産地参入期に省人化 → VAPへ重心移動）は、これらの観測量が時間とともに
// 変化することの**帰結**であって、時期で分岐しているのではない。
//
// 【会社差】判断のしきい値は志向プロファイル（orientationProfile.ts の
// growthTrendResponsiveness / oversupplyRetreatSensitivity / productMultipliers）で
// 会社ごとに変える。これにより「5社が同じ意思決定・同じ破綻結果になる」状態を
// 崩す（受入条件）。会社IDによる直接分岐は書かない。
//
// 【決定論】純粋関数のみ。乱数不使用。

import { DEMAND_MARKET_IDS, Product } from "../../../market/types";
import { CompanyFixture } from "../../types";
import { CompanyOrientationProfile } from "../orientationProfile";
import { PressureScores } from "../pressures";
import { StandardAiObservation } from "../types";
import { StandardAiDiagnosticEntry } from "../reasonCodes";
import { VAP_PRODUCT_DEVELOPMENT_SPEND_TIERS_USD } from "../../productDevelopmentState";
import { PD_MECHANIZATION_PARAMETERS_V1, computeEffectivePdCoefficient } from "../../../capex/pdMechanization";
import { CAPEX_PARAMETERS_V1 } from "../../../capex/parameters";
import { FINANCE_PARAMETERS_V1 } from "../../../finance/parameters";
import { PRODUCTION_PARAMETERS_V1 } from "../../../production/parameters";
import { SALES_CAPABILITY_PARAMETERS_V1 } from "../../../sales/salesCapability";

const EPSILON = 1e-9;

/**
 * 【§6】営業1人あたりの四半期処理能力の目安（HOSO換算工数トン）。
 * sales/salesCapability.ts の throughputTonsPerHead と同じ水準を、判断側の
 * 概算として参照する（正確な処理能力は市場規模係数・顧客開発倍率にも依存するため、
 * ここでは「売り切れる見込みがあるか」の粗い足切りとしてのみ使う）。
 */
const SALES_THROUGHPUT_TONS_PER_HEAD_APPROX = SALES_CAPABILITY_PARAMETERS_V1.throughputTonsPerHead;

export interface MarketEvolutionInvestmentParameters {
  // --- 需要予測 ---
  /**
   * 公開ライフサイクルトレンド（構成比pt/四半期）を何四半期先まで外挿するか。
   * 【初期値の根拠】新工場の建設3四半期＋準備1四半期＝4四半期かかるため、
   * それより先を見ないと「完成した頃には需要が来ている」判断ができない。
   */
  readonly demandForecastHorizonQuarters: number;

  // --- 新工場建設 ---
  /**
   * 予測需要に対する能力不足率がこの水準を超えたら新工場を検討する
   * （1.0 = 予測需要が現能力とちょうど等しい）。
   * growthTrendResponsiveness が高い会社ほどこのしきい値が下がる（早く動く）。
   */
  readonly newFactoryForecastShortfallThreshold: number;
  /** 新工場を検討する最低稼働率（今の設備が実際に埋まっていること）。 */
  readonly newFactoryMinUtilization: number;
  /** 投資後に残すべき現金の、目標最低現金に対する倍率。 */
  readonly newFactoryCashSafetyMultiple: number;

  // --- PD省人化 ---
  /**
   * 省人化を検討する最低PD稼働率。稼働率が低いと削減できる人員も少なく回収できない
   * （Phase5の損益分岐分析の結論を判断条件として明文化したもの）。
   */
  readonly mechanizationMinPdUtilization: number;
  /** 期待回収年数がこの値以下なら投資に値すると判断する（四半期数）。 */
  readonly mechanizationMaxPaybackQuarters: number;
  /** 投資後に残すべき現金の、目標最低現金に対する倍率。 */
  readonly mechanizationCashSafetyMultiple: number;
  /**
   * 【§6】追加出力を売り切れるかの判定に使う、営業対応力の余裕率のしきい値。
   * 「対象需要のうち自社が現実的に狙える取り分」に対して、営業処理能力がこの倍率
   * 以上あることを求める。1.0未満なら「今すでに営業が律速で、増産しても売れない」。
   */
  readonly mechanizationMinSalesHeadroomRatio: number;
  /**
   * 完成品在庫が「対象需要のうち自社の現実的な取り分」の何倍を超えたら
   * 「すでに売れ残っている＝増産しても意味がない」とみなすか。
   */
  readonly mechanizationMaxFinishedGoodsRatio: number;
  /**
   * PDの有利な市場局面が、回収期間より何倍長く続く見込みを要求するか。
   * 1.5なら「回収に8四半期かかるなら、少なくとも12四半期ぶんの有利局面が要る」。
   * 有利局面の長さは、PD供給圧力とPD需要トレンドから推定する（将来の真値は見ない）。
   */
  readonly mechanizationMarketWindowSafetyMultiple: number;

  // --- VAP商品開発 ---
  /**
   * VAP構成比の公開トレンドがこの水準を超えたら開発投資を積極化する
   * （構成比pt/四半期）。
   */
  readonly vapDevelopmentTrendThreshold: number;
  /** 投資後に残すべき現金の、目標最低現金に対する倍率。 */
  readonly vapDevelopmentCashSafetyMultiple: number;
  /**
   * VAP供給圧力がこの水準を超えたら開発投資を1段階抑える
   * （1.0=均衡、>1=供給過剰の持続）。
   */
  readonly vapDevelopmentOversupplyThreshold: number;
}

/**
 * 【加工品市場進化 v1 初期値・要校正】
 * 単位・時期・範囲・事業上の意味は各フィールドのコメントに記載。
 */
export const MARKET_EVOLUTION_INVESTMENT_PARAMETERS_V1: MarketEvolutionInvestmentParameters = {
  demandForecastHorizonQuarters: 6,

  newFactoryForecastShortfallThreshold: 1.05,
  newFactoryMinUtilization: 0.7,
  newFactoryCashSafetyMultiple: 3.0,

  mechanizationMinPdUtilization: 0.6,
  mechanizationMaxPaybackQuarters: 20,
  mechanizationCashSafetyMultiple: 2.0,
  mechanizationMinSalesHeadroomRatio: 1.1,
  mechanizationMaxFinishedGoodsRatio: 0.8,
  mechanizationMarketWindowSafetyMultiple: 1.5,

  vapDevelopmentTrendThreshold: 0.004,
  vapDevelopmentCashSafetyMultiple: 1.5,
  vapDevelopmentOversupplyThreshold: 1.15,
};

/** 標準AIが認識した市場見通し（診断・レポート出力にそのまま載せられる形）。 */
export interface MarketOutlookPerception {
  /** 公開ライフサイクルトレンドの市場平均（構成比pt/四半期）。 */
  readonly pdDemandTrendPerQuarter: number;
  readonly vapDemandTrendPerQuarter: number;
  /** 予測需要倍率（現在を1.0としたときの demandForecastHorizonQuarters 先の相対需要）。 */
  readonly pdDemandForecastMultiple: number;
  readonly vapDemandForecastMultiple: number;
  /** 現在の設備稼働率（前四半期実績）。 */
  readonly equipmentUtilization: number | undefined;
  /** 予測需要に対する能力不足率（1.0超で不足）。 */
  readonly pdForecastCapacityShortfallRatio: number | undefined;
  readonly vapForecastCapacityShortfallRatio: number | undefined;
  /** 商品別供給圧力（1.0=均衡、>1=供給過剰の持続）。 */
  readonly pdSupplyPressure: number | undefined;
  readonly vapSupplyPressure: number | undefined;
  /**
   * PDプレミアムの低下が観測されているか（他産地のPD加工参入の兆候）。
   * 供給圧力が均衡を超えている、かつPD構成比の伸びが鈍い局面を指す。
   */
  readonly pdPremiumErosionDetected: boolean;
  /** 営業対応力が販売のボトルネックになっているか。 */
  readonly salesEffortConstrained: boolean;
  /** 原料供給が制約になっているか。 */
  readonly rawMaterialConstrained: boolean;
  /** 投資後も安全水準を保てる現金余力（USD、負なら余力なし）。 */
  readonly cashHeadroomUsd: number;
}

/**
 * 観測から市場見通しを組み立てる。新しい市場データは作らず、
 * 既存の公開観測フィールドを組み合わせるだけ。
 */
export function perceiveMarketOutlook(
  observation: StandardAiObservation,
  pressures: PressureScores,
  params: MarketEvolutionInvestmentParameters = MARKET_EVOLUTION_INVESTMENT_PARAMETERS_V1
): MarketOutlookPerception {
  const trendOf = (product: "pd" | "vap"): number => {
    if (!observation.lifecycleTrendByMarket) return 0;
    const values = DEMAND_MARKET_IDS.map((m) => observation.lifecycleTrendByMarket![m]?.[product] ?? 0);
    return values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
  };
  const shareOf = (product: "pd" | "vap"): number | undefined => {
    if (!observation.lifecycleSharesByMarket) return undefined;
    const values = DEMAND_MARKET_IDS.map((m) => observation.lifecycleSharesByMarket![m]?.[product] ?? 0);
    return values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
  };

  const pdTrend = trendOf("pd");
  const vapTrend = trendOf("vap");
  const pdShare = shareOf("pd");
  const vapShare = shareOf("vap");

  // 予測需要倍率 = (現在構成比 + トレンド × 予測期間) ÷ 現在構成比。
  // 構成比が観測できない（機能OFF）場合は 1.0（成長を織り込まない）。
  const forecastMultiple = (share: number | undefined, trend: number): number => {
    if (share === undefined || share <= EPSILON) return 1;
    return Math.max(0, (share + trend * params.demandForecastHorizonQuarters) / share);
  };
  const pdDemandForecastMultiple = forecastMultiple(pdShare, pdTrend);
  const vapDemandForecastMultiple = forecastMultiple(vapShare, vapTrend);

  const equipmentUtilization = pressures.hadPriorQuarterUtilization ? pressures.equipmentUtilizationLastQuarter : undefined;

  // 予測能力不足率 = 現在稼働率 × 予測需要倍率。1.0超なら予測時点で能力が足りない。
  const shortfallOf = (multiple: number): number | undefined =>
    equipmentUtilization === undefined ? undefined : equipmentUtilization * multiple;

  const pdSupplyPressure = observation.productSupplyPressureByProduct?.pd;
  const vapSupplyPressure = observation.productSupplyPressureByProduct?.vap;

  // 他産地のPD加工参入は「PD供給圧力が均衡超で持続し、かつPD構成比の伸びが
  // 鈍い」局面として観測される（産地別能力そのものは非公開情報のため直接見ない）。
  const pdPremiumErosionDetected =
    pdSupplyPressure !== undefined && pdSupplyPressure > 1.0 && pdTrend < params.vapDevelopmentTrendThreshold;

  return {
    pdDemandTrendPerQuarter: pdTrend,
    vapDemandTrendPerQuarter: vapTrend,
    pdDemandForecastMultiple,
    vapDemandForecastMultiple,
    equipmentUtilization,
    pdForecastCapacityShortfallRatio: shortfallOf(pdDemandForecastMultiple),
    vapForecastCapacityShortfallRatio: shortfallOf(vapDemandForecastMultiple),
    pdSupplyPressure,
    vapSupplyPressure,
    pdPremiumErosionDetected,
    // 営業対応力のボトルネックは、AIが自ら組んだ販売計画が営業工数制約で
    // 縮小されたかどうか（decision/sales.ts の診断）で判定する必要があるため、
    // ここでは観測できる代理指標として「営業人員あたりの対象需要」を使う。
    salesEffortConstrained: salesEffortLikelyBinding(observation),
    // 原料の逼迫は、在庫ポジション（目標に対する比率）が1を大きく下回る状態で観測する。
    rawMaterialConstrained: pressures.rawMaterialInventoryPosition < 0.8,
    cashHeadroomUsd: observation.cashUsd - pressures.targetMinimumCashUsd,
  };
}

/** 市場進化に基づく投資判断の結果。 */
export interface MarketEvolutionInvestmentDecision {
  /** 追加で提案する設備投資案件。 */
  readonly proposals: readonly { readonly projectType: "newFactoryConstruction" | "pdMechanization"; readonly targetFactoryId?: string }[];
  /** VAP商品開発投資額（許容ティアのいずれか）。 */
  readonly vapProductDevelopmentSpendUsd: number;
  readonly outlook: MarketOutlookPerception;
  readonly diagnostics: readonly StandardAiDiagnosticEntry[];
}

function largestTierAtMost(amountUsd: number): number {
  const tiers = [...VAP_PRODUCT_DEVELOPMENT_SPEND_TIERS_USD].sort((a, b) => a - b);
  let chosen = tiers[0] ?? 0;
  for (const t of tiers) if (t <= amountUsd + EPSILON) chosen = t;
  return chosen;
}

function stepDownTier(amountUsd: number): number {
  const tiers = [...VAP_PRODUCT_DEVELOPMENT_SPEND_TIERS_USD].sort((a, b) => a - b);
  const index = tiers.findIndex((t) => Math.abs(t - amountUsd) < EPSILON);
  return index > 0 ? tiers[index - 1] : tiers[0] ?? 0;
}

/**
 * 市場見通しから、Test15で追加された3つの投資タイプの採否を判断する。
 *
 * どの判断も「予測需要・能力不足・期待回収・現金余力」の4点だけで決まり、
 * ターン番号は一切参照しない。
 */
export function decideMarketEvolutionInvestments(
  fixture: CompanyFixture,
  observation: StandardAiObservation,
  pressures: PressureScores,
  orientation: CompanyOrientationProfile,
  alreadyProposedProjectTypes: ReadonlySet<string>,
  params: MarketEvolutionInvestmentParameters = MARKET_EVOLUTION_INVESTMENT_PARAMETERS_V1
): MarketEvolutionInvestmentDecision {
  const outlook = perceiveMarketOutlook(observation, pressures, params);
  const diagnostics: StandardAiDiagnosticEntry[] = [];
  const proposals: { projectType: "newFactoryConstruction" | "pdMechanization"; targetFactoryId?: string }[] = [];

  diagnostics.push({
    code: "MARKET_OUTLOOK_PERCEIVED",
    domain: "capex",
    companyId: fixture.companyId,
    severity: "info",
    keyValues: {
      pdDemandTrendPerQuarter: outlook.pdDemandTrendPerQuarter,
      vapDemandTrendPerQuarter: outlook.vapDemandTrendPerQuarter,
      pdDemandForecastMultiple: outlook.pdDemandForecastMultiple,
      vapDemandForecastMultiple: outlook.vapDemandForecastMultiple,
      equipmentUtilization: outlook.equipmentUtilization ?? -1,
      pdSupplyPressure: outlook.pdSupplyPressure ?? -1,
      vapSupplyPressure: outlook.vapSupplyPressure ?? -1,
      cashHeadroomUsd: outlook.cashHeadroomUsd,
      pdPremiumErosion: outlook.pdPremiumErosionDetected ? 1 : 0,
      salesEffortConstrained: outlook.salesEffortConstrained ? 1 : 0,
    },
    message:
      `市場見通し: PD需要トレンド${outlook.pdDemandTrendPerQuarter.toFixed(4)}pt/Q・` +
      `VAP需要トレンド${outlook.vapDemandTrendPerQuarter.toFixed(4)}pt/Q、` +
      `${params.demandForecastHorizonQuarters}四半期先の需要倍率 PD=${outlook.pdDemandForecastMultiple.toFixed(2)}・` +
      `VAP=${outlook.vapDemandForecastMultiple.toFixed(2)}。`,
  });

  // -------------------------------------------------------------------
  // 1. 新工場建設: 予測需要に対して能力が足りず、今の設備も埋まっており、
  //    投資後も現金安全水準を保てるとき。
  // -------------------------------------------------------------------
  // 志向の成長応答度が高い会社ほど、しきい値が下がって早く動く。
  const shortfallThreshold = params.newFactoryForecastShortfallThreshold * (2 - orientation.growthTrendResponsiveness) * 0.5 + 0.5;
  const forecastShortfall = Math.max(
    outlook.pdForecastCapacityShortfallRatio ?? 0,
    outlook.vapForecastCapacityShortfallRatio ?? 0
  );
  const cashSafeForFactory = observation.cashUsd >= pressures.targetMinimumCashUsd * params.newFactoryCashSafetyMultiple;
  const utilizationOk = outlook.equipmentUtilization !== undefined && outlook.equipmentUtilization >= params.newFactoryMinUtilization;

  if (!alreadyProposedProjectTypes.has("newFactoryConstruction")) {
    if (forecastShortfall >= shortfallThreshold && utilizationOk && cashSafeForFactory) {
      proposals.push({ projectType: "newFactoryConstruction" });
      diagnostics.push({
        code: "NEW_FACTORY_PROPOSED_FOR_FORECAST_DEMAND",
        domain: "capex",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: { forecastShortfall, shortfallThreshold, equipmentUtilization: outlook.equipmentUtilization ?? -1, cashUsd: observation.cashUsd },
        decisionSummary: "予測需要に対する能力不足を見越して新工場建設を提案",
        message:
          `${params.demandForecastHorizonQuarters}四半期先の予測需要に対する能力不足率が${forecastShortfall.toFixed(2)}` +
          `（しきい値${shortfallThreshold.toFixed(2)}）で、現在稼働率${(outlook.equipmentUtilization ?? 0).toFixed(2)}・` +
          "現金余力も安全水準を満たすため、新工場建設を提案する。",
      });
    } else if (forecastShortfall >= shortfallThreshold) {
      diagnostics.push({
        code: "NEW_FACTORY_DEFERRED",
        domain: "capex",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: {
          forecastShortfall,
          utilizationOk: utilizationOk ? 1 : 0,
          cashSafe: cashSafeForFactory ? 1 : 0,
          cashHeadroomUsd: outlook.cashHeadroomUsd,
        },
        message: "予測需要は能力を上回るが、現在稼働率または現金余力の条件を満たさないため新工場建設を見送る。",
      });
    }
  }

  // -------------------------------------------------------------------
  // 2. PD省人化: PD稼働率が高く（＝削減できる人員が実在し）、期待回収が
  //    許容期間内で、投資後も現金安全水準を保てるとき。
  //    他産地参入によるPDプレミアム低下局面ではコスト競争力が要るため、
  //    しきい値を緩める（＝より積極的に省人化する）。
  // -------------------------------------------------------------------
  const mechanizationTargets = observation.factories
    .filter((f) => f.capacityByProduct.pd > EPSILON)
    // 既に機械化済み（レベル>0）の工場は投資対象から外す。
    .filter((f) => (f.mechanizationLevel ?? 0) <= EPSILON)
    .slice()
    .sort((a, b) => (a.factoryId < b.factoryId ? -1 : a.factoryId > b.factoryId ? 1 : 0));

  const pdUtilization = outlook.equipmentUtilization ?? 0;
  const minPdUtilization = outlook.pdPremiumErosionDetected
    ? params.mechanizationMinPdUtilization * 0.85
    : params.mechanizationMinPdUtilization;
  const cashSafeForMechanization = observation.cashUsd >= pressures.targetMinimumCashUsd * params.mechanizationCashSafetyMultiple;

  if (!alreadyProposedProjectTypes.has("pdMechanization") && mechanizationTargets.length > 0) {
    // 期待回収の見積り: 完全成熟時のPD係数比から、削減できる常用人員の割合を出し、
    // 現在のPD生産に必要な人員 × 給与 × 削減率 で四半期あたりの削減額とする。
    const fullyMechanizedCoefficient = computeEffectivePdCoefficient(1.0, PD_MECHANIZATION_PARAMETERS_V1);
    const reductionRatio = 1 - fullyMechanizedCoefficient / PRODUCTION_PARAMETERS_V1.labor.laborIntensityCoefficient.pd;
    const target = mechanizationTargets[0];
    // その工場のPD生産に張り付いている常用人員の概算（能力比で按分）。
    const totalCapacity = observation.factories.reduce((s, f) => s + f.capacityByProduct.hoso + f.capacityByProduct.pd + f.capacityByProduct.vap, 0);
    const pdShareOfFactory = totalCapacity > EPSILON ? target.capacityByProduct.pd / totalCapacity : 0;
    const pdRelatedHeadcount = observation.regularHeadcountTotal * pdShareOfFactory;
    const quarterlySavingUsd = pdRelatedHeadcount * reductionRatio * FINANCE_PARAMETERS_V1.labor.regularWorkerSalaryUsdPerQuarter;
    const paybackQuarters = quarterlySavingUsd > EPSILON ? CAPEX_PARAMETERS_V1.templatesByType.pdMechanization.standardBudgetUsd / quarterlySavingUsd : Infinity;

    const paybackOk = paybackQuarters <= params.mechanizationMaxPaybackQuarters;

    // 【§6】「係数が下がる」「現金がある」だけでは投資しない。増えた分を
    // 実際に売り切れるか・原料を確保できるか・有利局面が回収期間より長いかを
    // すべて満たしたときにのみ提案する。
    //
    // (a) PDの需要・成約見込みがあるか（需要トレンドが負でない、かつ供給過剰でない）
    const pdDemandProspect =
      outlook.pdDemandTrendPerQuarter >= 0 && (outlook.pdSupplyPressure === undefined || outlook.pdSupplyPressure <= 1.25);
    // (b) 労働が実際にボトルネックか（設備がまだ空いているのに人手だけ足りない状態）
    const laborIsBottleneck = pdUtilization >= minPdUtilization;
    // (c) 増えた分を売り切れるか（営業対応力に余裕があるか）
    const totalTargetDemand = observation.targetDemandTotalByMarket
      ? DEMAND_MARKET_IDS.reduce((sum, m) => sum + (observation.targetDemandTotalByMarket![m] ?? 0), 0)
      : undefined;
    // 5社＋外部選択肢で分け合うため、自社が現実的に狙える取り分は対象需要の1/6程度。
    const realisticOwnDemand = totalTargetDemand !== undefined ? totalTargetDemand / 6 : undefined;
    const salesCapacityTons = observation.salesForceHeadcountTotal * SALES_THROUGHPUT_TONS_PER_HEAD_APPROX;
    const salesHeadroomOk =
      realisticOwnDemand === undefined || realisticOwnDemand <= EPSILON
        ? true // 対象需要が観測できない（turn1等）ときは、この条件では止めない
        : salesCapacityTons / realisticOwnDemand >= params.mechanizationMinSalesHeadroomRatio;
    // (d) 完成品在庫が既に積み上がっていないか
    const finishedGoodsExcess = pressures.finishedGoodsExcessRatioByProduct?.pd ?? 0;
    const inventoryOk = finishedGoodsExcess <= params.mechanizationMaxFinishedGoodsRatio;
    // (e) 原料を確保できるか
    const rawMaterialOk = !outlook.rawMaterialConstrained;
    // (f) 有利局面が回収期間より十分長いか。
    //     PDプレミアムの低下が既に観測されている局面では、残り時間が回収期間の
    //     safetyMultiple倍に満たないとみなす（将来の真値は一切参照しない）。
    const marketWindowOk = !outlook.pdPremiumErosionDetected || paybackQuarters * params.mechanizationMarketWindowSafetyMultiple <= params.mechanizationMaxPaybackQuarters;

    const allConditionsMet =
      pdDemandProspect && laborIsBottleneck && paybackOk && cashSafeForMechanization && salesHeadroomOk && inventoryOk && rawMaterialOk && marketWindowOk;

    if (allConditionsMet) {
      proposals.push({ projectType: "pdMechanization", targetFactoryId: target.factoryId });
      diagnostics.push({
        code: "PD_MECHANIZATION_PROPOSED_FOR_PAYBACK",
        domain: "capex",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: { pdUtilization, minPdUtilization, paybackQuarters, quarterlySavingUsd, pdPremiumErosion: outlook.pdPremiumErosionDetected ? 1 : 0 },
        decisionSummary: `PD省人化投資を提案（対象工場 ${target.factoryId}）`,
        message:
          `PD稼働率${pdUtilization.toFixed(2)}（しきい値${minPdUtilization.toFixed(2)}）で削減可能人員が実在し、` +
          `期待回収${paybackQuarters.toFixed(1)}四半期（許容${params.mechanizationMaxPaybackQuarters}）のため省人化投資を提案する。` +
          (outlook.pdPremiumErosionDetected ? "他産地参入によるPDプレミアム低下局面のため、コスト競争力を優先した。" : ""),
      });
    } else {
      diagnostics.push({
        code: "PD_MECHANIZATION_DEFERRED",
        domain: "capex",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: {
          pdUtilization,
          minPdUtilization,
          paybackQuarters,
          cashSafe: cashSafeForMechanization ? 1 : 0,
          pdDemandProspect: pdDemandProspect ? 1 : 0,
          laborIsBottleneck: laborIsBottleneck ? 1 : 0,
          salesHeadroomOk: salesHeadroomOk ? 1 : 0,
          inventoryOk: inventoryOk ? 1 : 0,
          rawMaterialOk: rawMaterialOk ? 1 : 0,
          marketWindowOk: marketWindowOk ? 1 : 0,
        },
        message:
          "PD需要見込み・労働ボトルネック・期待回収・現金余力・営業対応力の余裕・完成品在庫・原料確保・" +
          "有利局面の長さのいずれかの条件を満たさないため、PD省人化投資を見送る。",
      });
    }
  }

  // -------------------------------------------------------------------
  // 3. VAP商品開発投資: VAP需要が伸びており、営業活動と組み合わせられる
  //    見込みがあり、現金余力があるとき。供給過剰なら1段階抑える。
  // -------------------------------------------------------------------
  const vapOrientation = orientation.productMultipliers.vap;
  const vapTrendThreshold = params.vapDevelopmentTrendThreshold / Math.max(0.1, vapOrientation);
  let vapSpendUsd = 0;

  const affordableCeiling = Math.max(0, observation.cashUsd - pressures.targetMinimumCashUsd * params.vapDevelopmentCashSafetyMultiple);
  if (outlook.vapDemandTrendPerQuarter >= vapTrendThreshold) {
    vapSpendUsd = largestTierAtMost(affordableCeiling);
    // 供給過剰が続いている局面では1段階抑える（過剰投資の抑制）。
    if (outlook.vapSupplyPressure !== undefined && outlook.vapSupplyPressure > params.vapDevelopmentOversupplyThreshold) {
      vapSpendUsd = stepDownTier(vapSpendUsd);
    }
    if (vapSpendUsd > 0) {
      diagnostics.push({
        code: "VAP_DEVELOPMENT_INVESTED_FOR_GROWTH",
        domain: "capex",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: {
          vapSpendUsd,
          vapDemandTrendPerQuarter: outlook.vapDemandTrendPerQuarter,
          vapTrendThreshold,
          vapSupplyPressure: outlook.vapSupplyPressure ?? -1,
          affordableCeiling,
        },
        decisionSummary: `VAP商品開発投資 ${vapSpendUsd.toLocaleString("en-US")} USD`,
        message:
          `VAP需要トレンド${outlook.vapDemandTrendPerQuarter.toFixed(4)}pt/Q（しきい値${vapTrendThreshold.toFixed(4)}）が` +
          "成長局面を示しており、現金余力の範囲でVAP商品開発へ投資する。",
      });
    } else {
      diagnostics.push({
        code: "VAP_DEVELOPMENT_DEFERRED_FOR_CASH",
        domain: "capex",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: { affordableCeiling, cashUsd: observation.cashUsd, targetMinimumCashUsd: pressures.targetMinimumCashUsd },
        message: "VAP需要は成長しているが、投資後に現金安全水準を割るため商品開発投資を見送る。",
      });
    }
  }

  return { proposals, vapProductDevelopmentSpendUsd: vapSpendUsd, outlook, diagnostics };
}

/** 商品ごとの需要予測倍率（レポート出力用の小ヘルパー）。 */
export function forecastMultipleFor(outlook: MarketOutlookPerception, product: Product): number {
  if (product === "pd") return outlook.pdDemandForecastMultiple;
  if (product === "vap") return outlook.vapDemandForecastMultiple;
  return 1;
}

/**
 * 営業対応力が販売の律速になっている可能性が高いか（観測できる代理指標）。
 * 市場ごとの対象需要合計を営業人員1人あたりへ均した値が、1人あたり処理能力の
 * 目安を大きく上回っていれば、営業側が律速とみなす。
 */
function salesEffortLikelyBinding(observation: StandardAiObservation): boolean {
  if (!observation.targetDemandTotalByMarket) return false;
  const totalTargetDemand = DEMAND_MARKET_IDS.reduce((sum, m) => sum + (observation.targetDemandTotalByMarket![m] ?? 0), 0);
  const headcount = Math.max(1, observation.salesForceHeadcountTotal);
  // 5社＋外部選択肢で分け合うことを踏まえ、自社が狙える現実的な取り分を
  // 対象需要の1/6程度と見積もる（allocation.tsのexternalOptionWeightを含む参加者数）。
  const realisticOwnDemand = totalTargetDemand / 6;
  return realisticOwnDemand / headcount > 400;
}
