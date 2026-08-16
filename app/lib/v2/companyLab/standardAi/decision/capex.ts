// ShrimpX V2 — Phase SAI-1: 標準経営AI基盤 設備投資ドメイン
//
// 【基本方針（実装指示 §設備投資）】SAI-1はcapexに積極的でない。次のすべてを
// 満たす場合に限り新規投資を提案する。それ以外は「見送り（CAPEX_DEFERRED）」を
// 正常な既定結果として扱う。
//   1. 対象能力が、今期・実際に観測されたボトルネックである
//      （今期の必要量が能力を上回っている）。
//   2. 需要・契約不足が一時的でない（前期も同じ設備区分の稼働率が高水準だった）。
//   3. 既存の完成品在庫が過剰でない。
//   4. 最低現金バッファを安全マージン込みで維持できる。
//   5. 借入余力・財務健全性を著しく損なわない。
//   6. 同じ能力区分に対する案件がすでに進行中（approved/underConstruction）でない。
//
// 【対象範囲（SAI-1のスコープ判断）】HOSO/PD/VAP加工ライン増設・共通前処理能力
// 増設の4種類のみを対象とする。冷凍・包装処理能力／保管能力／品質管理設備／
// 環境設備は生産のボトルネックへの直接効果が薄い、またはSAI-1の観測情報だけでは
// 必要性判断の材料が乏しいため対象外とし、SAI-2handoffへ明記する（実装指示の
// 「無理に対応しない。SAI-2引き継ぎ事項として明記する」という判断基準に従う）。

import { CapexDecisionInput, CapexProjectProposalInput, CapitalProjectType } from "../../../capex/types";
import { CAPEX_PARAMETERS_V1, CapexParameters } from "../../../capex/parameters";
import { computeCandidateProjectSpaceUnits } from "../../../capex/factorySpace";
import { PD_MECHANIZATION_PARAMETERS_V1 } from "../../../capex/pdMechanization";
import { PRODUCTION_PARAMETERS_V1 } from "../../../production/parameters";
import { effectiveEfficiencyPerHeadTons } from "../../../production/labor";
import { FINANCE_PARAMETERS_V1 } from "../../../finance/parameters";
import { Product } from "../../../market/types";
import { CompanyFixture } from "../../types";
import { minimumAcceptablePremium } from "../../premiumPolicy";
import { StandardAiParameters, STANDARD_AI_PARAMETERS_V1 } from "../parameters";
import { PressureScores } from "../pressures";
import { FactoryObservation, ProductAmount, StandardAiObservation } from "../types";
import { StandardAiDiagnosticEntry } from "../reasonCodes";
import { diagnoseFactoryActivation } from "../factoryActivation";

const EPSILON = 1e-6;

const LINE_EXPANSION_BY_PRODUCT: Readonly<Record<Product, CapitalProjectType>> = {
  hoso: "hosoLineExpansion",
  pd: "pdLineExpansion",
  vap: "vapLineExpansion",
};

/**
 * 【複数工場CAPEX Targeting修正・§18/§19】Factory-specific CAPEXの投資先Factoryを選ぶ。
 * 「何に投資するか」（今どの区分がボトルネックか）の判断は上のゲート群が既に行って
 * おり、ここでは一切変更しない。ここは「投資すると決めた後、どのFactoryへ置くか」
 * だけを、既存のobservation.factories（能力認識監査Phase 3で追加済みの、
 * production/capacity.tsの実効能力計算をそのまま使った、Factoryごとの実効能力の
 * 一覧。新しい独立スコアではない）から選ぶ。
 *
 * 選択規則: その区分の実効能力が最も小さいFactory（＝最もbindingしている
 * Factory）を優先する。同点の場合はfactoryId昇順（決定論的にするため）。
 * 会社が1工場しかない場合はその工場がそのまま選ばれる（従来挙動と一致）。
 * observation.factoriesが空（テスト用の合成observation等）ならundefined
 * （呼び出し側はtargetFactoryIdを省略し、承認側の「主工場」規則にフォールバックする）。
 */
function selectTargetFactoryId(observation: StandardAiObservation, dimension: "hoso" | "pd" | "vap" | "commonProcessing"): string | undefined {
  const factories = observation.factories;
  if (!factories || factories.length === 0) return undefined;
  const capacityOf = (f: (typeof factories)[number]): number =>
    dimension === "commonProcessing" ? f.effectiveCommonProcessingCapacity : f.effectiveCapacityByProduct[dimension];
  return [...factories].sort((a, b) => capacityOf(a) - capacityOf(b) || a.factoryId.localeCompare(b.factoryId))[0]?.factoryId;
}

/**
 * このモジュールが提案しうる設備投資の種類（＝Standard AI が提案できる全て）。
 *
 * 【この一覧が意味すること】ゲームエンジン側には他にも案件種別が存在する
 * （capex/types.ts の CAPITAL_PROJECT_TYPES）が、ここに無い種別は
 * **Standard AI からは構造的に一度も提案されない**。
 * 監査・AI Analysis Pack はこの定数を唯一の情報源として参照する
 * （別の場所へ同じ一覧を書き写さない）。
 */
export const STANDARD_AI_PROPOSABLE_CAPEX_TYPES: readonly CapitalProjectType[] = [
  "hosoLineExpansion",
  "pdLineExpansion",
  "vapLineExpansion",
  "commonProcessingExpansion",
  // 【2026-08-09・Vision駆動の戦略成長】新工場建設を Standard AI の候補へ追加した。
  // ただし提案の判断は**このモジュールでは行わない**。既存増設が「今期このラインが
  // 足りるか」という戦術判断であるのに対し、新工場は Vision との規模ギャップから
  // 出発する戦略判断であり、decision/newFactory.ts が専用の評価ゲート群を持つ。
  // ここは「Standard AI が提案しうる種別の唯一の一覧」としての定数であるため、
  // 監査・AI Analysis Pack が実態と食い違わないよう追加している。
  "newFactoryConstruction",
  // 【Standard AI Capability Expansion・Phase CE-1】PD省人化投資（pdMechanization）を
  // 候補種別として追加した。既存のPDライン増設（能力増強）とは別の投資判断軸
  // （労務生産性の向上）であり、buildPdMechanizationCapexCandidate()が専用の
  // 評価ゲート群を持つ（既存のPDライン増設ロジックは一切変更しない）。
  "pdMechanization",
  // 【Standard AI Capability Expansion・Phase CE-3】品質管理設備
  // （qualityControlEquipment）を候補種別として追加した。QI-I1で完成した
  // ゲーム効果（factory-specific operationalRisk -30%・2Qランプ）自体は一切
  // 変更せず、その効果へ「投資するかどうか」の判断だけを追加する。
  "qualityControlEquipment",
];

export interface CapexPlanResult {
  readonly capexDecision: CapexDecisionInput;
  readonly diagnostics: readonly StandardAiDiagnosticEntry[];
}

interface FinancialGateDetail {
  readonly safe: boolean;
  readonly cashSafe: boolean;
  readonly borrowingSafe: boolean;
  readonly requiredCashUsd: number;
  /** 判定対象案件の投資額（legacyMultiple では 0）。 */
  readonly projectCostUsd: number;
  /** 投資後に残る現金の見込み（＝現金 − 投資額）。 */
  readonly cashAfterInvestmentUsd: number;
}

// ---------------------------------------------------------------------
// 【2026-08-09・Test16】設備投資の現金ゲートを「投資額に応じた方式」へ
// ---------------------------------------------------------------------
//
// 【旧方式の問題】
//   requiredCash = targetMinimumCash × capexCashSafetyMultiple(1.75)
// は投資額と無関係に会社規模だけで必要現金を決めていた。実測では
// 8M USD の HOSO 増設に対して 45〜60M USD の現金保有を要求しており、
// 短期運転資金を借りて原料を買う会社とは両立しなかった
// （持続性条件が成立した11件すべてがこの現金条件で落ちていた）。
//
// 【新方式】
//   requiredCash = targetMinimumCash + 投資額 + 投資額 × capexCostSafetyRatio
//
// 第2項（投資額そのもの）は「投資後に最低現金バッファを割らない」という
// 明示のご指示を満たすために必ず要る。ご指示の式
//   targetMinimumCash + 投資額 × capexSafetyRatio
// を字義どおりに取ると、ratio<1 のとき投資直後に現金が
// 最低バッファを下回ってしまい、同じご指示の後半と矛盾する
// （HOSO増設は paymentRatios=[1.0] で全額が単一四半期に出るため）。
// そこで「バッファを割らないぶん」と「追加安全余裕」を分けて足す形にした。
// capexCostSafetyRatio が純粋に『追加の余裕』を表すため、
// 0.25 と 0.50 の比較も意味を持つ。

/** 投資案件1件の標準予算（＝この四半期に出ていく現金）。 */
function projectCostUsdFor(projectType: CapitalProjectType, capexParams: CapexParameters): number {
  return capexParams.templatesByType[projectType]?.standardBudgetUsd ?? 0;
}

/**
 * 設備投資の財務ゲート。
 * 【2026-08-09・Test16】判定結果だけでなく内訳（現金・借入圧力のどちらで落ちたか、
 * 必要現金がいくらか）も返す。従来は safe:0 としか残らず説明できなかった。
 *
 * 借入余力・財務健全性のゲート（borrowingPressure < 1）は変更していない。
 */
function cashAndBorrowingSafe(
  observation: StandardAiObservation,
  pressures: PressureScores,
  params: StandardAiParameters,
  projectType: CapitalProjectType | undefined,
  capexParams: CapexParameters
): FinancialGateDetail {
  const projectCostUsd = projectType !== undefined ? projectCostUsdFor(projectType, capexParams) : 0;
  const requiredCashUsd =
    params.capexCashGateMode === "legacyMultiple"
      ? pressures.targetMinimumCashUsd * params.capexCashSafetyMultiple
      : pressures.targetMinimumCashUsd + projectCostUsd * (1 + params.capexCostSafetyRatio);
  const cashSafe = observation.cashUsd > requiredCashUsd;
  const borrowingSafe = pressures.borrowingPressure < 1;
  return {
    safe: cashSafe && borrowingSafe,
    cashSafe,
    borrowingSafe,
    requiredCashUsd,
    projectCostUsd,
    cashAfterInvestmentUsd: observation.cashUsd - projectCostUsd,
  };
}

// ---------------------------------------------------------------------
// 【2026-08-09・Test16】投資対象設備ごとの稼働率
// ---------------------------------------------------------------------
//
// 【なぜ必要か】従来は投資対象が何であれ、持続性条件に
//   averageEquipmentUtilization = 実生産量 / commonProcessing能力
// という**共通前処理能力を分母にした会社全体の稼働率**を使っていた。
//
// Test16の工場設計は「工場全体の箱（common 30,000t）は大きいが、商品別専用能力が
// 商品構成を制約する」というものであり、この分母では商品別ラインの逼迫が見えない。
// 実測（docs/standard_ai/TEST16_RAW_PROCUREMENT_AUDIT.md）では、
//   理論上の最大稼働率 = Σ商品別能力 / common = 0.633〜0.733
// となり、持続性しきい値0.92へ**算術的に到達不可能**だった。原料を無制限に
// 与えても設備投資が一度も発動しないことを確認している。
//
// 【修正の考え方】「何の設備へ投資するか」に対応する設備の稼働率を見る。
//   HOSO/PD/VAPライン増設 → その商品の 実生産量 / その商品の実効能力
//   共通前処理能力増設     → 全商品の実生産量合計 / 共通前処理の実効能力
//   冷凍・包装能力増設     → 全商品の実生産量合計 / 冷凍・包装の実効能力
//
// しきい値 capexSustainedUtilizationThreshold(0.92) 自体は変更しない。
// まず分母・対象を正しくしたうえで、92%が妥当かをbenchmarkで確かめる。

/** 設備投資の対象設備区分。 */
export type CapexUtilizationTarget = Product | "commonProcessing" | "freezingPackaging";

export interface RelevantUtilization {
  readonly target: CapexUtilizationTarget;
  /** 対象設備の実効能力（capex反映後）。 */
  readonly capacity: number;
  /** 前期の実績生産量（対象設備が処理した量）。 */
  readonly actualProduction: number;
  /** actualProduction / capacity。capacity が0なら0。 */
  readonly utilization: number;
}

function sumLastQuarterProduction(observation: StandardAiObservation): number {
  return (["hoso", "pd", "vap"] as const).reduce((s, p) => s + (observation.lastQuarterActualProductionByProduct[p] ?? 0), 0);
}

/**
 * 投資対象設備に対応する前期稼働率を返す。
 *
 * 分母は必ず**その設備の実効能力**（capex反映後・稼働率係数適用後）であり、
 * production/capacity.ts の calculateFactoryEffectiveCapacity を経由した
 * observation.totalEffective* をそのまま使う。ここで能力を再計算しない。
 */
export function relevantUtilizationFor(observation: StandardAiObservation, target: CapexUtilizationTarget): RelevantUtilization {
  const capacity =
    target === "commonProcessing"
      ? observation.totalEffectiveCommonProcessingCapacity
      : target === "freezingPackaging"
        ? observation.totalEffectiveFreezingPackagingCapacity
        : observation.totalEffectiveCapacityByProduct[target];
  const actualProduction =
    target === "commonProcessing" || target === "freezingPackaging"
      ? sumLastQuarterProduction(observation)
      : (observation.lastQuarterActualProductionByProduct[target] ?? 0);
  return {
    target,
    capacity,
    actualProduction,
    utilization: capacity > EPSILON ? actualProduction / capacity : 0,
  };
}

export function buildStandardAiCapexDecision(
  fixture: CompanyFixture,
  observation: StandardAiObservation,
  pressures: PressureScores,
  productionNeededByProductBeforeCap: ProductAmount,
  requiredRawMaterialUnconstrained: number,
  params: StandardAiParameters = STANDARD_AI_PARAMETERS_V1,
  capexParams: CapexParameters = CAPEX_PARAMETERS_V1
): CapexPlanResult {
  const diagnostics: StandardAiDiagnosticEntry[] = [];
  const proposals: CapexProjectProposalInput[] = [];

  // ---------------------------------------------------------------------
  // 【Standard AI Factory Activation・Phase FA-1】Factory別ボトルネック診断
  // ---------------------------------------------------------------------
  //
  // 【指示§4・§26】新しい独立SSoTは作らず、既存FactoryObservationから
  // factoryActivation.tsの純粋関数でボトルネック（COMMON/PRODUCT_LINE/LABOR/NONE）を
  // 診断し、reason codeとして記録するだけ（診断のみ。CAPEX候補生成ロジック自体は
  // 変更しない。既存のselectTargetFactoryId・PD Mechanization・Quality Equipmentの
  // 各候補生成は「実効能力が最も小さいFactory」を選ぶ設計のため、新設Factoryが
  // 最もボトルネックであれば既存ロジックのままそこが選ばれる）。
  for (const factory of [...observation.factories].sort((a, b) => a.factoryId.localeCompare(b.factoryId))) {
    const activation = diagnoseFactoryActivation(factory);
    const activationKeyValues = {
      effectiveCapacityTons: activation.effectiveCapacityTons,
      effectiveCommonProcessingCapacity: activation.effectiveCommonProcessingCapacity,
      productionTons: activation.productionTons,
      utilization: activation.utilization,
      currentRegularHeadcount: activation.currentRegularHeadcount,
      requiredRegularHeadcount: activation.requiredRegularHeadcount,
      activationNeed: activation.activationNeed,
    };
    diagnostics.push({
      code: "FACTORY_ACTIVATION_CONSIDERED",
      domain: "capex",
      companyId: fixture.companyId,
      severity: "info",
      keyValues: activationKeyValues,
      targetFactoryId: factory.factoryId,
      decisionSummary: `${factory.factoryId}: Factory Activation診断（bottleneck=${activation.bottleneck}）`,
      message: `${factory.factoryId}の稼働率${(activation.utilization * 100).toFixed(1)}%・常用${activation.currentRegularHeadcount}人（必要${activation.requiredRegularHeadcount.toFixed(1)}人）からボトルネックを診断した。`,
    });
    const bottleneckCode =
      activation.bottleneck === "COMMON"
        ? "FACTORY_ACTIVATION_BOTTLENECK_COMMON"
        : activation.bottleneck === "PRODUCT_LINE"
          ? "FACTORY_ACTIVATION_BOTTLENECK_PRODUCT_LINE"
          : activation.bottleneck === "LABOR"
            ? "FACTORY_ACTIVATION_BOTTLENECK_LABOR"
            : "FACTORY_ACTIVATION_NONE_NEEDED";
    diagnostics.push({
      code: bottleneckCode,
      domain: "capex",
      companyId: fixture.companyId,
      severity: activation.bottleneck === "NONE" ? "info" : "warning",
      keyValues: activationKeyValues,
      targetFactoryId: factory.factoryId,
      decisionSummary: `${factory.factoryId}: ${activation.bottleneck}`,
      message:
        activation.bottleneck === "NONE"
          ? `${factory.factoryId}は現時点で顕著なボトルネックが無い。`
          : `${factory.factoryId}は${activation.bottleneck}が最も強い制約と診断した（activationNeed ${activation.activationNeed.toFixed(2)}）。`,
    });
  }

  // ---------------------------------------------------------------------
  // 【Phase 6D-1・修正A】既存増設候補のスペース実現可能性チェック
  // ---------------------------------------------------------------------
  //
  // 【なぜ必要か（Phase 6D 監査で確認）】従来はここでスペースを一切確認せず、
  // 「稼働率・在庫・財務が条件を満たせば増設を提案する」だけだった。実際には
  // capex/factorySpace.ts の承認ゲートがスペース不足を理由に毎四半期その提案を
  // REJECTする（例: BAL は commonProcessingExpansion 必要560units に対し残520units
  // で、Q24〜Q32まで8四半期連続でREJECTされ続けていた）。この「実行不能な提案が
  // 存在する」という事実だけが decision/newFactory.ts の Gate G
  // （EXISTING_EXPANSION_FIRST）を通じて新工場判断を無期限に block していた。
  //
  // 【修正方針】増設そのものを禁止しない。承認可能性が無い候補だけを
  // 「実行可能な既存増設候補」として扱わない（提案しない）。スペースが
  // 実際に十分ならこれまでどおり提案する。既存の観測値
  // （observation.factorySpaceRemainingUnits）と既存の関数
  // （computeCandidateProjectSpaceUnits、承認ゲート自身が使うのと同じ関数）だけを
  // 使い、新しい判定式・新しい閾値は作らない。
  //
  // 同一四半期内で複数案件（HOSO/PD/VAP/共通）を評価するため、実際に提案した
  // ぶんのスペースを都度差し引きながら判定する（1四半期内の二重予約を防ぐ）。
  // 【捏造しない】observation.factorySpaceRemainingUnits を持たない呼び出し元
  // （テスト用の合成observation等）では、スペースという概念自体を検証していないと
  // みなし、無限大（＝常に十分）として扱う。存在しない制約を作らない。
  let spaceRemainingUnits = Number.isFinite(observation.factorySpaceRemainingUnits)
    ? observation.factorySpaceRemainingUnits
    : Number.POSITIVE_INFINITY;
  const checkSpaceFeasible = (projectType: CapitalProjectType): { readonly feasible: boolean; readonly requiredSpaceUnits: number } => {
    const requiredSpaceUnits = computeCandidateProjectSpaceUnits(projectType, capexParams);
    return { feasible: requiredSpaceUnits <= spaceRemainingUnits + EPSILON, requiredSpaceUnits };
  };
  const reserveSpace = (requiredSpaceUnits: number): void => {
    spaceRemainingUnits -= requiredSpaceUnits;
  };
  const recordSpaceInfeasible = (projectType: CapitalProjectType, requiredSpaceUnits: number): void => {
    diagnostics.push({
      code: "CAPEX_DEFERRED_INSUFFICIENT_SPACE",
      domain: "capex",
      companyId: fixture.companyId,
      severity: "info",
      keyValues: {
        requiredSpaceUnits,
        factorySpaceRemainingUnits: spaceRemainingUnits,
        factorySpaceTotalUnits: observation.factorySpaceTotalUnits,
        factorySpaceUsedUnits: observation.factorySpaceUsedUnits,
      },
      decisionSummary: `${projectType} は工場スペース不足のため提案しない`,
      message: `${projectType} の必要スペース ${Math.round(requiredSpaceUnits).toLocaleString()} units が、現在の残スペース ${Math.round(
        spaceRemainingUnits
      ).toLocaleString()} units を上回るため、実行不能な候補として提案しない（承認ゲートでREJECTされ続ける空提案を繰り返さない）。`,
    });
  };

  // 【監査指摘H】PD_CAPACITY_MAINTAINED の判定材料（VAP転換へ追随しなかったか）。
  let vapOversupplyRetreated = false;
  let vapGrowthSignalPresent = false;
  /** 投資対象ごとの財務ゲート（必要現金が投資額に依存するため案件別に判定する）。 */
  const financialGateFor = (projectType: CapitalProjectType) =>
    cashAndBorrowingSafe(observation, pressures, params, projectType, capexParams);
  // 【2026-08-09・Test16】持続性判定は投資対象設備ごとに行う（下の各分岐で算出）。
  // hadPriorQuarterUtilization は「前四半期の操業実績が存在するか」の判定にのみ使う
  // （turn1では前期実績が無いため、いかなる設備区分でも持続性は成立しない）。
  const hasPriorQuarter = pressures.hadPriorQuarterUtilization;
  const sustainedFor = (u: RelevantUtilization): boolean =>
    hasPriorQuarter && u.utilization >= params.capexSustainedUtilizationThreshold;

  /** B3: 「何の設備の何%を見たか」を必ず説明できるようにする共通keyValues。 */
  const utilizationKeyValues = (u: RelevantUtilization, gate: FinancialGateDetail): Record<string, number> => ({
    relevantCapacity: u.capacity,
    relevantActualProduction: u.actualProduction,
    relevantUtilization: u.utilization,
    sustainedThreshold: params.capexSustainedUtilizationThreshold,
    hadPriorQuarter: hasPriorQuarter ? 1 : 0,
    // 財務ゲートの内訳（safe:0 だけでは現金不足か借入過多か分からないため）。
    financialGateCashSafe: gate.cashSafe ? 1 : 0,
    financialGateBorrowingSafe: gate.borrowingSafe ? 1 : 0,
    financialGateRequiredCashUsd: gate.requiredCashUsd,
    projectCostUsd: gate.projectCostUsd,
    cashAfterInvestmentUsd: gate.cashAfterInvestmentUsd,
    cashUsd: observation.cashUsd,
    borrowingPressure: pressures.borrowingPressure,
    // 旧方式（共通前処理能力を分母にした会社全体の稼働率）。新旧の差を追跡できるよう残す。
    legacyOverallEquipmentUtilization: pressures.equipmentUtilizationLastQuarter,
  });

  // 【SAI-5F】拡張判断用の公開シグナル（前四半期までの公開情報のみ。無効時は未使用）。
  const ext = params.standardAiCapexExtensionsEnabled;
  const supplyPressureOf = (product: Product): number | undefined =>
    product === "pd" || product === "vap" ? observation.productSupplyPressureByProduct?.[product] : undefined;
  const lifecycleTrendOf = (product: Product): number | undefined => {
    if (!observation.lifecycleTrendByMarket || (product !== "pd" && product !== "vap")) return undefined;
    // 全市場の構成比トレンドの単純平均（公開の市場調査水準の粗い集計）。
    const markets = Object.values(observation.lifecycleTrendByMarket);
    if (markets.length === 0) return undefined;
    return markets.reduce((s, m) => s + m[product], 0) / markets.length;
  };

  for (const product of ["hoso", "pd", "vap"] as const) {
    // 【2026-08-03・Phase Aハードニング】ボトルネック判定条件1（「対象能力が、
    // 今期・実際に観測されたボトルネックである」）の分母を、ノミナル能力
    // （capex増設前提の理論値）ではなく実効能力（capex反映後の実際に使える能力）
    // へ変更する。ノミナルのままだと実際より能力を高く見積もり、真にボトルネック
    // なのにshortfallRatioが低く出て投資提案が発火しない（sales/production側の
    // 「24,000t」問題とは逆方向だが、同じ「ノミナルを実行可能量として使う」誤り）。
    // Standard AI側の判断ロジックのみの修正であり、capexゲームエンジン自体は
    // 変更しない。
    const capacity = observation.totalEffectiveCapacityByProduct[product];
    if (capacity <= EPSILON) continue;
    const shortfallRatio = productionNeededByProductBeforeCap[product] / capacity;
    const noExcess = observation.finishedGoodsByProduct[product] <= capacity * params.finishedGoodsTargetQuarters * params.excessInventoryRatioForDiscount;
    const alreadyPlanned = observation.activeCapexProjectTargets.has(product);

    // 【SAI-5F】過剰供給リトリート: 公開供給圧力が高止まりしているPD/VAPは、
    // 他の条件を満たしても投資を見送る（志向の強い会社ほどしきい値側の感度
    // oversupplyRetreatSensitivityが低く=追随的、高い=慎重/逆張り）。
    const pressureSignal = ext ? supplyPressureOf(product) : undefined;
    const oversupplyRetreat =
      ext &&
      pressureSignal !== undefined &&
      pressureSignal > params.capexOversupplyPressureThreshold + (1 - params.oversupplyRetreatSensitivity) * 0.3;
    if (oversupplyRetreat) {
      if (product === "vap") vapOversupplyRetreated = true;
      diagnostics.push({
        code: product === "vap" ? "VAP_OVERSUPPLY_RETREAT" : "CAPEX_DEFERRED_OVERSUPPLY",
        domain: "capex",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: { supplyPressureEwma: pressureSignal, threshold: params.capexOversupplyPressureThreshold, oversupplyRetreatSensitivity: params.oversupplyRetreatSensitivity },
        message: `${product.toUpperCase()}の公開供給圧力が高止まりしているため、当期の${product.toUpperCase()}設備投資を見送る。`,
      });
      continue;
    }
    // 【SAI-4追加】経営性格プロファイル（D社=高付加価値重視）向けの差し込み口。
    // capexShortfallThresholdBiasByProduct[product]は既定0（全社共通の
    // capexCurrentShortfallRatioThresholdをそのまま使うのと完全に同じ）。正の値は
    // しきい値をそのぶん下げ、PD/VAPのボトルネック解消投資をわずかに前倒しする
    // （安全ガード：cashAndBorrowingSafe・sustained・noExceptの各条件は一切変更せず、
    // 「投資を検討し始める入口の感度」だけを動かす）。
    const productThresholdBias = params.capexShortfallThresholdBiasByProduct[product] ?? 0;
    const effectiveShortfallThreshold = params.capexCurrentShortfallRatioThreshold - productThresholdBias;
    const isBottleneck = shortfallRatio > effectiveShortfallThreshold;
    // 【2026-08-09・Test16】この商品の専用ラインの稼働率で持続性を判定する。
    // common(30,000t)の稼働率ではなく、HOSOならHOSOラインの稼働率を見る。
    const utilization = relevantUtilizationFor(observation, product);
    const sustained = sustainedFor(utilization);
    // 財務ゲートはこの商品のライン増設案件の投資額で判定する。
    const gate = financialGateFor(LINE_EXPANSION_BY_PRODUCT[product]);
    const safe = gate.safe;

    const lineSpace = checkSpaceFeasible(LINE_EXPANSION_BY_PRODUCT[product]);
    if (isBottleneck && sustained && noExcess && safe && !alreadyPlanned && lineSpace.feasible) {
      proposals.push({ projectType: LINE_EXPANSION_BY_PRODUCT[product], targetFactoryId: selectTargetFactoryId(observation, product) });
      reserveSpace(lineSpace.requiredSpaceUnits);
      diagnostics.push({
        code: "CAPEX_PROPOSED",
        domain: "capex",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: {
          ...utilizationKeyValues(utilization, gate),
          shortfallRatio,
          effectiveShortfallThreshold,
          productThresholdBias,
          financialGate: safe ? 1 : 0,
          inventoryGate: noExcess ? 1 : 0,
          ongoingProjectGate: alreadyPlanned ? 0 : 1,
          shortfallGate: isBottleneck ? 1 : 0,
          sustainedGate: 1,
          spaceGate: 1,
          finalDecision: 1,
        },
        decisionSummary: `${product.toUpperCase()}ライン増設を提案（${product.toUpperCase()}ライン稼働率 ${(utilization.utilization * 100).toFixed(1)}%）`,
        message:
          `${product.toUpperCase()}加工能力が持続的なボトルネックのため、増設案件を提案する。` +
          `判定に使ったのは${product.toUpperCase()}専用ラインの稼働率` +
          `（前期実績 ${Math.round(utilization.actualProduction).toLocaleString()}t ÷ 実効能力 ${Math.round(utilization.capacity).toLocaleString()}t ` +
          `= ${(utilization.utilization * 100).toFixed(1)}%）であり、共通前処理能力の稼働率ではない。`,
      });
    } else if (isBottleneck && sustained && noExcess && safe && !alreadyPlanned && !lineSpace.feasible) {
      recordSpaceInfeasible(LINE_EXPANSION_BY_PRODUCT[product], lineSpace.requiredSpaceUnits);
    } else if (isBottleneck) {
      diagnostics.push({
        code: "CAPEX_DEFERRED",
        domain: "capex",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: {
          ...utilizationKeyValues(utilization, gate),
          shortfallRatio,
          effectiveShortfallThreshold,
          productThresholdBias,
          financialGate: safe ? 1 : 0,
          inventoryGate: noExcess ? 1 : 0,
          ongoingProjectGate: alreadyPlanned ? 0 : 1,
          shortfallGate: isBottleneck ? 1 : 0,
          sustainedGate: sustained ? 1 : 0,
          finalDecision: 0,
        },
        decisionSummary: `${product.toUpperCase()}ライン増設を見送り（${product.toUpperCase()}ライン稼働率 ${(utilization.utilization * 100).toFixed(1)}%）`,
        message:
          `${product.toUpperCase()}は今期は能力不足だが、持続性・在庫・財務健全性のいずれかの条件を満たさないため増設を見送る。` +
          `持続性判定に使ったのは${product.toUpperCase()}専用ラインの稼働率` +
          `（前期実績 ${Math.round(utilization.actualProduction).toLocaleString()}t ÷ 実効能力 ${Math.round(utilization.capacity).toLocaleString()}t ` +
          `= ${(utilization.utilization * 100).toFixed(1)}%、しきい値 ${(params.capexSustainedUtilizationThreshold * 100).toFixed(0)}%）であり、` +
          `共通前処理能力の稼働率ではない。`,
      });
    } else if (ext && (product === "pd" || product === "vap") && !alreadyPlanned && params.growthTrendResponsiveness > 0) {
      // 【SAI-5F】ライフサイクル成長エントリ: 現時点の能力不足（shortfall）が
      // 発生する「手前」でも、(a) 公開ライフサイクルトレンドが十分に正、
      // (b) 前期稼働率が既に高め（growthEntryUtilizationThreshold以上）、
      // (c) 在庫・現金・借入の安全条件は通常capexと同一、を満たす場合に
      // 成長市場向けの増設を提案する。志向のgrowthTrendResponsivenessが高い
      // 会社ほどトレンドしきい値が下がる＝早く動く（将来を知るのではなく、
      // 公開の過去トレンドへの反応速度の違いとして表現）。
      const trend = lifecycleTrendOf(product);
      const trendThreshold = params.capexGrowthEntryTrendPerQuarterThreshold * (2 - params.growthTrendResponsiveness);
      if (product === "vap" && trend !== undefined && trend >= trendThreshold) vapGrowthSignalPresent = true;
      // 【2026-08-09・Test16】成長エントリの稼働率条件も、対象商品の専用ライン稼働率で見る。
      const utilizationOk = hasPriorQuarter && utilization.utilization >= params.capexGrowthEntryUtilizationThreshold;
      const growthEntrySpace = checkSpaceFeasible(LINE_EXPANSION_BY_PRODUCT[product]);
      if (trend !== undefined && trend >= trendThreshold && utilizationOk && noExcess && safe && growthEntrySpace.feasible) {
        proposals.push({ projectType: LINE_EXPANSION_BY_PRODUCT[product], targetFactoryId: selectTargetFactoryId(observation, product) });
        reserveSpace(growthEntrySpace.requiredSpaceUnits);
        diagnostics.push({
          code: product === "vap" ? "VAP_GROWTH_ENTRY" : "LIFECYCLE_GROWTH_PURSUED",
          domain: "capex",
          companyId: fixture.companyId,
          severity: "info",
          keyValues: {
            ...utilizationKeyValues(utilization, gate),
            lifecycleTrendPerQuarter: trend,
            trendThreshold,
            growthEntryUtilizationThreshold: params.capexGrowthEntryUtilizationThreshold,
            growthTrendResponsiveness: params.growthTrendResponsiveness,
            financialGate: safe ? 1 : 0,
            inventoryGate: noExcess ? 1 : 0,
            ongoingProjectGate: alreadyPlanned ? 0 : 1,
            shortfallGate: 0,
            spaceGate: 1,
            finalDecision: 1,
          },
          decisionSummary: `${product.toUpperCase()}ライン増設を成長エントリとして提案`,
          message: `${product.toUpperCase()}の公開ライフサイクルトレンドが成長局面にあり、稼働率・在庫・財務の安全条件を満たすため、能力不足の顕在化前に増設を提案する。`,
        });
      } else if (trend !== undefined && trend >= trendThreshold && utilizationOk && noExcess && safe && !growthEntrySpace.feasible) {
        recordSpaceInfeasible(LINE_EXPANSION_BY_PRODUCT[product], growthEntrySpace.requiredSpaceUnits);
      }
    }
  }

  // ---------------------------------------------------------------------
  // 【Standard AI Capability Expansion・Phase CE-1】PD省人化投資（pdMechanization）
  // ---------------------------------------------------------------------
  //
  // 【狙い（指示§1）】既存のPDライン増設（能力増強）とは別の投資選択肢として、
  // 「PDを省人化して労務生産性を上げる」を追加する。JPQのような品質・PD志向の
  // 会社が"必ず機械化する"という強制ルールは作らず（指示§5禁止）、既存の
  // ManagementProfile/CompanyOrientationProfile（指示§9）が生む自然なバイアスと、
  // 工場ごとの実際の経済性（回収期間）だけで判断する。
  //
  // 【対象externalシグナル】新設したobservation.factories[].pdMechanization
  // （前四半期PD稼働率・既存/進行中案件の有無）だけを使い、新しい生産量観測は
  // 作らない。PD生産量は「前四半期PD稼働率 × 実効PD能力」から逆算する
  // （companyLab/pdMechanizationState.tsが実際に使うのと同じ稼働率の意味）。
  //
  // 【経済性（指示§8）】既存のeffectiveEfficiencyPerHeadTons()をそのまま使い、
  // 機械化前後（PD係数: baseCoefficient→floorCoefficient、いずれも
  // PRODUCTION_PARAMETERS_V1由来で新しい効果値は作らない）の必要Worker数の差から
  // 想定四半期人件費削減額を求め、投資額（capexParams由来）との比で回収期間を計算する。
  //
  // 【戦略適合（指示§9・§13）】新しいStrategyProfile型は作らない。
  // 既存のproductOrientationMultipliers.pd（商品志向）と、既存の
  // capexCurrentShortfallRatioThreshold（SP-Q2のcapexHurdleBiasRatioにより
  // CONSVで既に引き上げ済み＝財務保守性の比率）から、許容回収期間を会社ごとに
  // 加減する。新規パラメータはpdMechanizationMaxPaybackQuartersの1つのみ
  // （基準しきい値、校正前の暫定値、CE-1ベンチマーク前は変更しない・指示§39）。
  //
  // 【工場選定（指示§15・16）】主工場ハードコードをしない。稼働中/完成済み案件が
  // 無い全工場を評価し、回収期間が最も短い（＝最も経済的な）工場を1件だけ選ぶ
  // （指示§20-22・既存の「1区分1提案/turn」慣行に合わせる）。
  {
    const pdMechType: CapitalProjectType = "pdMechanization";
    const pdMechGate = financialGateFor(pdMechType);
    const pdMechSpace = checkSpaceFeasible(pdMechType);
    const investmentCostUsd = projectCostUsdFor(pdMechType, capexParams);
    const financialConservatismRatio =
      params.capexCurrentShortfallRatioThreshold / STANDARD_AI_PARAMETERS_V1.capexCurrentShortfallRatioThreshold;
    // 【戦略適合（指示§9・10-14）】productOrientationMultipliers（会社ごとの商品志向、
    // orientationProfile.ts由来・既存フィールド）は、HOSO（汎用コモディティ品）を含めた
    // 3商品間の"相対的な"重みづけである（絶対値は会社ごとの基準が異なり、単独では
    // 「PD機械化を好むか」を表さない。例: japanQualityはvap=1.2が最大でpd=0.95は
    // 基準1.0未満だが、hoso=0.85よりは高く、"コモディティのHOSOよりPDを選好する"
    // という関係は保たれている）。ここではPD対HOSOの比（pd/hoso）を「コモディティ
    // 増強より高付加価値化・省人化を選ぶ度合い」として使う。全員1.0（neutral)の
    // BALでは比が1になり特別扱いされない（指示§14）。新しいStrategyProfile型は
    // 作らず、既存のorientationProfile.tsの値をそのまま比として再利用するだけ。
    const productOrientationHoso = params.productOrientationMultipliers.hoso ?? 1;
    const productOrientationPd = params.productOrientationMultipliers.pd ?? 1;
    const strategyFitMultiplier = productOrientationHoso > EPSILON ? productOrientationPd / productOrientationHoso : 1;
    const effectiveMaxPaybackQuarters =
      financialConservatismRatio > EPSILON
        ? (params.pdMechanizationMaxPaybackQuarters * strategyFitMultiplier) / financialConservatismRatio
        : params.pdMechanizationMaxPaybackQuarters;

    const regularBaseEfficiencyPerHeadTons = PRODUCTION_PARAMETERS_V1.labor.regularEfficiencyPerHeadTons;
    const efficiencyBeforeMechanization = effectiveEfficiencyPerHeadTons(
      regularBaseEfficiencyPerHeadTons,
      "pd",
      PRODUCTION_PARAMETERS_V1,
      PD_MECHANIZATION_PARAMETERS_V1.baseCoefficient
    );
    const efficiencyAfterMechanization = effectiveEfficiencyPerHeadTons(
      regularBaseEfficiencyPerHeadTons,
      "pd",
      PRODUCTION_PARAMETERS_V1,
      PD_MECHANIZATION_PARAMETERS_V1.floorCoefficient
    );

    interface PdMechCandidate {
      readonly factory: FactoryObservation;
      readonly pdProductionTonsEstimate: number;
      readonly workersBeforeMechanization: number;
      readonly workersAfterMechanization: number;
      readonly laborSavingsHeadcount: number;
      readonly expectedQuarterlySavingUsd: number;
      readonly paybackQuarters: number;
    }

    const eligibleCandidates: PdMechCandidate[] = [];
    for (const factory of [...observation.factories].sort((a, b) => a.factoryId.localeCompare(b.factoryId))) {
      if (factory.pdMechanization.hasActiveOrCompletedProject) {
        diagnostics.push({
          code: "PD_MECH_ALREADY_ACTIVE",
          domain: "capex",
          companyId: fixture.companyId,
          severity: "info",
          keyValues: { factoryPdUtilization: factory.pdMechanization.previousQuarterPdUtilization },
          targetFactoryId: factory.factoryId,
          decisionSummary: `${factory.factoryId}: PD機械化を検討対象から除外（既存/進行中案件あり）`,
          message: `${factory.factoryId}には既にPD省人化投資案件が稼働中または完成済みのため、重複提案しない。`,
        });
        continue;
      }
      const pdUtilization = factory.pdMechanization.previousQuarterPdUtilization;
      diagnostics.push({
        code: "PD_MECH_CONSIDERED",
        domain: "capex",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: { factoryPdUtilization: pdUtilization, capexPdInUseUtilizationThreshold: params.capexPdInUseUtilizationThreshold },
        targetFactoryId: factory.factoryId,
        decisionSummary: `${factory.factoryId}: PD機械化候補として評価`,
        message: `${factory.factoryId}のPD稼働率（前期実績 ${(pdUtilization * 100).toFixed(1)}%）を基に、PD省人化投資の候補として評価する。`,
      });
      if (pdUtilization < params.capexPdInUseUtilizationThreshold) {
        diagnostics.push({
          code: "PD_MECH_LOW_UTILIZATION",
          domain: "capex",
          companyId: fixture.companyId,
          severity: "info",
          keyValues: { factoryPdUtilization: pdUtilization, capexPdInUseUtilizationThreshold: params.capexPdInUseUtilizationThreshold },
          targetFactoryId: factory.factoryId,
          decisionSummary: `${factory.factoryId}: PD稼働率が低いためPD機械化を見送り`,
          message: `${factory.factoryId}のPD稼働率が低く、機械化による削減余地を検討する段階にないため見送る。`,
        });
        continue;
      }

      const pdProductionTonsEstimate = pdUtilization * factory.effectiveCapacityByProduct.pd;
      const workersBeforeMechanization =
        efficiencyBeforeMechanization > EPSILON ? pdProductionTonsEstimate / efficiencyBeforeMechanization : 0;
      const workersAfterMechanization =
        efficiencyAfterMechanization > EPSILON ? pdProductionTonsEstimate / efficiencyAfterMechanization : 0;
      const laborSavingsHeadcount = Math.max(0, workersBeforeMechanization - workersAfterMechanization);
      const expectedQuarterlySavingUsd = laborSavingsHeadcount * FINANCE_PARAMETERS_V1.labor.regularWorkerSalaryUsdPerQuarter;
      const paybackQuarters = expectedQuarterlySavingUsd > EPSILON ? investmentCostUsd / expectedQuarterlySavingUsd : Number.POSITIVE_INFINITY;

      if (!(paybackQuarters <= effectiveMaxPaybackQuarters)) {
        diagnostics.push({
          code: "PD_MECH_PAYBACK_UNATTRACTIVE",
          domain: "capex",
          companyId: fixture.companyId,
          severity: "info",
          keyValues: {
            pdProductionTonsEstimate,
            workersBeforeMechanization,
            workersAfterMechanization,
            laborSavingsHeadcount,
            expectedQuarterlySavingUsd,
            investmentCostUsd,
            paybackQuarters: Number.isFinite(paybackQuarters) ? paybackQuarters : -1,
            effectiveMaxPaybackQuarters,
            strategyFitMultiplier,
            financialConservatismRatio,
          },
          targetFactoryId: factory.factoryId,
          decisionSummary: `${factory.factoryId}: PD機械化の想定回収期間が長すぎるため見送り`,
          message: `${factory.factoryId}のPD省人化投資は想定回収期間（${
            Number.isFinite(paybackQuarters) ? paybackQuarters.toFixed(1) : "無限大"
          }四半期）が許容基準（${effectiveMaxPaybackQuarters.toFixed(1)}四半期）を超えるため見送る。`,
        });
        continue;
      }

      eligibleCandidates.push({
        factory,
        pdProductionTonsEstimate,
        workersBeforeMechanization,
        workersAfterMechanization,
        laborSavingsHeadcount,
        expectedQuarterlySavingUsd,
        paybackQuarters,
      });
    }

    if (eligibleCandidates.length > 0) {
      if (!pdMechGate.safe) {
        diagnostics.push({
          code: "PD_MECH_FINANCE_BLOCKED",
          domain: "capex",
          companyId: fixture.companyId,
          severity: "info",
          keyValues: {
            financialGateCashSafe: pdMechGate.cashSafe ? 1 : 0,
            financialGateBorrowingSafe: pdMechGate.borrowingSafe ? 1 : 0,
            financialGateRequiredCashUsd: pdMechGate.requiredCashUsd,
            cashUsd: observation.cashUsd,
            investmentCostUsd,
          },
          decisionSummary: "PD機械化を財務ゲート未達のため見送り",
          message: "経済性のあるPD省人化投資候補があったが、現金・借入余力の財務ゲートを満たさないため今期は見送る。",
        });
      } else if (!pdMechSpace.feasible) {
        recordSpaceInfeasible(pdMechType, pdMechSpace.requiredSpaceUnits);
      } else {
        const best = [...eligibleCandidates].sort(
          (a, b) => a.paybackQuarters - b.paybackQuarters || a.factory.factoryId.localeCompare(b.factory.factoryId)
        )[0];
        proposals.push({ projectType: pdMechType, targetFactoryId: best.factory.factoryId });
        reserveSpace(pdMechSpace.requiredSpaceUnits);
        diagnostics.push({
          code: "PD_MECH_PROPOSED",
          domain: "capex",
          companyId: fixture.companyId,
          severity: "info",
          keyValues: {
            pdProductionTonsEstimate: best.pdProductionTonsEstimate,
            workersBeforeMechanization: best.workersBeforeMechanization,
            workersAfterMechanization: best.workersAfterMechanization,
            laborSavingsHeadcount: best.laborSavingsHeadcount,
            expectedQuarterlySavingUsd: best.expectedQuarterlySavingUsd,
            investmentCostUsd,
            paybackQuarters: best.paybackQuarters,
            effectiveMaxPaybackQuarters,
            strategyFitMultiplier,
            financialConservatismRatio,
            eligibleCandidateCount: eligibleCandidates.length,
          },
          targetFactoryId: best.factory.factoryId,
          decisionSummary: `${best.factory.factoryId}: PD機械化を提案（想定回収 ${best.paybackQuarters.toFixed(1)}四半期）`,
          message: `${best.factory.factoryId}のPD省人化投資が最も経済的（想定回収期間 ${best.paybackQuarters.toFixed(
            1
          )}四半期、想定人員削減 ${best.laborSavingsHeadcount.toFixed(1)}人）と判断し、提案する。`,
        });
      }
    } else {
      diagnostics.push({
        code: "PD_MECH_DEFERRED",
        domain: "capex",
        companyId: fixture.companyId,
        severity: "info",
        message: "当期はいずれの工場もPD省人化投資の経済性・稼働率条件を満たさないため見送る（既定の正常な結果）。",
      });
    }
  }

  // ---------------------------------------------------------------------
  // 【Standard AI Capability Expansion・Phase CE-3】品質管理設備（qualityControlEquipment）
  // ---------------------------------------------------------------------
  //
  // 【責務の境界（指示§1・§2）】ここで判断するのはあくまで「投資するかどうか・
  // どのFactoryへ」だけであり、qualityControlEquipmentが実際に生む効果
  // （factory-specific operationalRisk -30%・2Qランプ・downgrade/rework/disposal/
  // major incidentの減少・既存Quality Score/Trust/VAP capabilityへの波及）は
  // QI-I1で確定済みのゲームルールをそのまま使う。ここでその効果値・ランプ・
  // 集約ロジックを一切再計算・変更しない。
  //
  // 【観測（指示§3〜§6）】factory.qualityEquipment（companyLab/
  // qualityControlEquipmentState.tsのresolveQualityEquipmentStatusByFactoryが
  // 既存capexState＋既存効果関数から導出）とfactory.qualityMetrics（前四半期の
  // BatchQualityAdjustmentをFactory単位へ集計しただけ）だけを判断材料にする。
  //
  // 【Quality Need（指示§9〜§11）】反応的シグナル（前四半期の実績downgrade/rework/
  // disposalの生産量比・major incident発生）と予防的シグナル（品質敏感商品
  // （PD+VAP）の生産シェア×稼働率）を合成した1つのスコアで表す。事故が起きて
  // からしか動かない・逆に事故が起きなければ絶対動かない、のどちらの極端も
  // 避けるため、operationalRisk自体（現在の操業ストレスの总合指標）も重みに含める。
  //
  // 【経済性（指示§14〜§16）】QI-I1のゲームエンジンには品質損失の$換算式が存在
  // しない（CE-3監査・QI-I1ベンチマークで確認済み。ベンチマークscriptだけが
  // illustrativeな$/kg換算を使っており、ゲームエンジン本体・AI判断コードには
  // 一切存在しない）。ここで新しい$便益式を作らない。代わりに、既存の観測
  // （tons・生産量比）だけで構成した無次元の"qualityRiskProtectionRatio"で
  // Factory間の優先順位を決める。ROI・paybackとは呼ばない（指示§16）。
  //
  // 【CE-3A新設・指示§11-14】params.qualityEquipmentCapabilityEnabled===false の
  // ときだけ、このブロック全体をスキップする（候補評価・診断・提案のいずれも
  // 一切発生しない＝「Quality Equipment候補生成そのものが無い」状態を再現する）。
  // 省略時（undefined）は必ずtrue相当で実行される＝CE-3までの挙動と完全に同一
  // （既存の全呼び出し元・全既存テストへの影響はゼロ）。他のCAPEX判断
  // （PD Mechanization・HOSO/PD/VAPライン増設・共通前処理増設）はこのifの外に
  // あり、一切変更されない。
  if (params.qualityEquipmentCapabilityEnabled !== false) {
    const qualityEquipType: CapitalProjectType = "qualityControlEquipment";
    const qualityEquipGate = financialGateFor(qualityEquipType);
    const qualityEquipSpace = checkSpaceFeasible(qualityEquipType);
    const investmentCostUsd = projectCostUsdFor(qualityEquipType, capexParams);
    const financialConservatismRatio =
      params.capexCurrentShortfallRatioThreshold / STANDARD_AI_PARAMETERS_V1.capexCurrentShortfallRatioThreshold;
    // 【戦略適合（指示§12・§13）】新しいStrategyProfile型は作らない。既存の
    // productOrientationMultipliers（PD Mechanization・§9-14で使うのと同じ既存値）の
    // うち、PD・VAP（品質敏感度が相対的に高いとみなす商品群）の平均をHOSOとの比で
    // 表す。JPQ（quality-sensitive/processed志向）・VAP（high-value/processed志向）は
    // ともにPD/VAPの重みが高いため、この比が1より大きくなり自然にsoft preferenceが
    // 生まれる。BAL（全て1.0）は比が1になり特別扱いされない（指示§39）。
    const productOrientationHoso = params.productOrientationMultipliers.hoso ?? 1;
    const productOrientationPd = params.productOrientationMultipliers.pd ?? 1;
    const productOrientationVap = params.productOrientationMultipliers.vap ?? 1;
    const qualitySensitiveOrientation = (productOrientationPd + productOrientationVap) / 2;
    const strategyFitMultiplier = productOrientationHoso > EPSILON ? qualitySensitiveOrientation / productOrientationHoso : 1;
    // Need側のしきい値なので、方向はPD Mechanizationのpaybackしきい値とは逆
    // （しきい値が低いほど早く動く）。strategyFitMultiplierが高い（品質敏感志向が
    // 強い）ほど割り、financialConservatismRatioが高い（保守的）ほど掛けることで、
    // 「品質敏感な会社は動きやすく、財務保守的な会社は動きにくい」を両立する。
    const effectiveNeedThreshold =
      strategyFitMultiplier > EPSILON
        ? (params.qualityEquipmentNeedThreshold / strategyFitMultiplier) * financialConservatismRatio
        : params.qualityEquipmentNeedThreshold * financialConservatismRatio;

    interface QualityEquipCandidate {
      readonly factory: FactoryObservation;
      readonly qualityNeedScore: number;
      readonly lossExposureCoverage: number;
      readonly qualitySensitiveExposureRatio: number;
      readonly utilization: number;
      readonly qualityRiskProtectionRatio: number;
    }

    const eligibleCandidates: QualityEquipCandidate[] = [];
    for (const factory of [...observation.factories].sort((a, b) => a.factoryId.localeCompare(b.factoryId))) {
      if (factory.qualityEquipment.hasQualityEquipment) {
        // 【指示§19・§20】稼働中(FULL_EFFECT)・ランプ中(RAMPING)・導入進行中
        // (IN_PROGRESS)のいずれであっても再提案しない（ランプ中を「設備なし」と
        // 誤判定しない）。承認段階のガード（QI-I1最終化の
        // hasActiveQualityControlEquipmentProjectForFactory）と二重の安全策になる。
        diagnostics.push({
          code: "QUALITY_EQUIP_ALREADY_ACTIVE",
          domain: "capex",
          companyId: fixture.companyId,
          severity: "info",
          keyValues: {
            equipmentRampProgress: factory.qualityEquipment.equipmentRampProgress,
            qualityEquipmentRiskMultiplier: factory.qualityEquipment.qualityEquipmentRiskMultiplier,
          },
          targetFactoryId: factory.factoryId,
          decisionSummary: `${factory.factoryId}: 品質管理設備を検討対象から除外（状態=${factory.qualityEquipment.qualityEquipmentStatus}）`,
          message: `${factory.factoryId}には既に品質管理設備が${factory.qualityEquipment.qualityEquipmentStatus}のため、重複提案しない。`,
        });
        continue;
      }

      const qm = factory.qualityMetrics;
      const factoryEffectiveCapacityTons = factory.effectiveCapacityByProduct.hoso + factory.effectiveCapacityByProduct.pd + factory.effectiveCapacityByProduct.vap;
      const utilization = factoryEffectiveCapacityTons > EPSILON ? Math.min(1, qm.productionTons / factoryEffectiveCapacityTons) : 0;

      if (qm.productionTons <= EPSILON) {
        // 【指示§9】前四半期の生産実績が無い（turn1・稼働直後等）と品質露出を
        // 観測しようがないため、実績に乏しいことを理由に見送る（架空の値で
        // 判断しない）。
        diagnostics.push({
          code: "QUALITY_EQUIP_LOW_EXPOSURE",
          domain: "capex",
          companyId: fixture.companyId,
          severity: "info",
          keyValues: { productionTons: qm.productionTons },
          targetFactoryId: factory.factoryId,
          decisionSummary: `${factory.factoryId}: 前四半期の生産実績が無いため品質管理設備の検討を見送り`,
          message: `${factory.factoryId}は前四半期の生産実績が無く、品質リスク露出を観測できないため見送る。`,
        });
        continue;
      }

      const lossExposureCoverage = (qm.downgradeTons + qm.reworkTons + qm.disposalTons) / qm.productionTons;
      const qualitySensitiveExposureRatio = qm.qualitySensitiveProductionTons / qm.productionTons;
      // 【指示§10・§11】反応的（実績のdowngrade/rework/disposal・major incident）＋
      // 予防的（品質敏感商品シェア×稼働率）の合成。operationalRisk自体も含めることで、
      // 「まだ大きな事故は無いが操業ストレスが高まっている」局面も拾う（指示§11）。
      const qualityNeedScore =
        0.4 * qm.operationalRisk +
        0.3 * Math.min(1, lossExposureCoverage) +
        0.15 * (qm.majorIncidentOccurred ? 1 : 0) +
        0.15 * qualitySensitiveExposureRatio * utilization;

      diagnostics.push({
        code: "QUALITY_EQUIP_CONSIDERED",
        domain: "capex",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: {
          operationalRisk: qm.operationalRisk,
          lossExposureCoverage,
          qualitySensitiveExposureRatio,
          utilization,
          majorIncidentOccurred: qm.majorIncidentOccurred ? 1 : 0,
          qualityNeedScore,
          effectiveNeedThreshold,
        },
        targetFactoryId: factory.factoryId,
        decisionSummary: `${factory.factoryId}: 品質管理設備候補として評価（Quality Need ${qualityNeedScore.toFixed(3)}）`,
        message: `${factory.factoryId}の前四半期品質実績（operationalRisk ${qm.operationalRisk.toFixed(2)}、損失比率 ${(lossExposureCoverage * 100).toFixed(1)}%）を基に、品質管理設備の候補として評価する。`,
      });

      if (!(qualityNeedScore > effectiveNeedThreshold)) {
        diagnostics.push({
          code: "QUALITY_EQUIP_LOW_NEED",
          domain: "capex",
          companyId: fixture.companyId,
          severity: "info",
          keyValues: { qualityNeedScore, effectiveNeedThreshold, strategyFitMultiplier, financialConservatismRatio },
          targetFactoryId: factory.factoryId,
          decisionSummary: `${factory.factoryId}: Quality Needがしきい値未満のため品質管理設備を見送り`,
          message: `${factory.factoryId}のQuality Needスコア（${qualityNeedScore.toFixed(3)}）が、しきい値（${effectiveNeedThreshold.toFixed(3)}）未満のため見送る。`,
        });
        continue;
      }

      // 【経済性proxy・指示§15・§16】$換算を一切使わない無次元スコア。
      // 生産規模（productionTons）が大きいほど、また品質敏感商品への露出・
      // Quality Needが高いほど、同じ投資額に対する保護価値が大きいとみなす。
      const qualityRiskProtectionRatio =
        investmentCostUsd > EPSILON ? (qualityNeedScore * qm.productionTons) / (investmentCostUsd / 1_000_000) : qualityNeedScore;

      eligibleCandidates.push({ factory, qualityNeedScore, lossExposureCoverage, qualitySensitiveExposureRatio, utilization, qualityRiskProtectionRatio });
    }

    if (eligibleCandidates.length > 0) {
      if (!qualityEquipGate.safe) {
        diagnostics.push({
          code: "QUALITY_EQUIP_FINANCE_BLOCKED",
          domain: "capex",
          companyId: fixture.companyId,
          severity: "info",
          keyValues: {
            financialGateCashSafe: qualityEquipGate.cashSafe ? 1 : 0,
            financialGateBorrowingSafe: qualityEquipGate.borrowingSafe ? 1 : 0,
            financialGateRequiredCashUsd: qualityEquipGate.requiredCashUsd,
            cashUsd: observation.cashUsd,
            investmentCostUsd,
          },
          decisionSummary: "品質管理設備を財務ゲート未達のため見送り",
          message: "Quality Needを満たす品質管理設備候補があったが、現金・借入余力の財務ゲートを満たさないため今期は見送る。",
        });
      } else if (!qualityEquipSpace.feasible) {
        recordSpaceInfeasible(qualityEquipType, qualityEquipSpace.requiredSpaceUnits);
      } else {
        const best = [...eligibleCandidates].sort(
          (a, b) => b.qualityRiskProtectionRatio - a.qualityRiskProtectionRatio || a.factory.factoryId.localeCompare(b.factory.factoryId)
        )[0];
        proposals.push({ projectType: qualityEquipType, targetFactoryId: best.factory.factoryId });
        reserveSpace(qualityEquipSpace.requiredSpaceUnits);
        diagnostics.push({
          code: "QUALITY_EQUIP_PROPOSED",
          domain: "capex",
          companyId: fixture.companyId,
          severity: "info",
          keyValues: {
            qualityNeedScore: best.qualityNeedScore,
            effectiveNeedThreshold,
            lossExposureCoverage: best.lossExposureCoverage,
            qualitySensitiveExposureRatio: best.qualitySensitiveExposureRatio,
            qualityRiskProtectionRatio: best.qualityRiskProtectionRatio,
            investmentCostUsd,
            strategyFitMultiplier,
            financialConservatismRatio,
            eligibleCandidateCount: eligibleCandidates.length,
          },
          targetFactoryId: best.factory.factoryId,
          decisionSummary: `${best.factory.factoryId}: 品質管理設備を提案（Quality Need ${best.qualityNeedScore.toFixed(3)}）`,
          message: `${best.factory.factoryId}の品質管理設備投資が最も合理的（qualityRiskProtectionRatio ${best.qualityRiskProtectionRatio.toFixed(
            2
          )}）と判断し、提案する。`,
        });
      }
    } else {
      diagnostics.push({
        code: "QUALITY_EQUIP_DEFERRED",
        domain: "capex",
        companyId: fixture.companyId,
        severity: "info",
        message: "当期はいずれの工場もQuality Need条件を満たさないため、品質管理設備投資を見送る（既定の正常な結果）。",
      });
    }
  }

  // 【SAI-5F】suspended案件のresume提案: 資金難で中断した案件は、現金が
  // 通常capexと同じ安全水準（目標バッファ×capexCashSafetyMultiple）を回復した
  // 場合に再開を提案する（従来は再開経路が無く、中断案件がCIPに現金を固定した
  // ままデッドロックし得た。Fable事前監査で特定）。
  //
  // 【2026-08-09・Test16】再開判断は「その案件の残額」を観測できないため、
  // 新規提案の投資額ベースゲートを適用できない。上のコメントどおり
  // 従来の「目標バッファ×capexCashSafetyMultiple」を維持する
  // （再開は資金難で中断した案件が対象であり、保守的側に倒すのが妥当）。
  const resumeCashSafe =
    observation.cashUsd > pressures.targetMinimumCashUsd * params.capexCashSafetyMultiple && pressures.borrowingPressure < 1;
  const resumeRequests: { readonly projectId: string }[] = [];
  if (ext) {
    for (const projectId of observation.suspendedCapexProjectIds ?? []) {
      if (resumeCashSafe) {
        resumeRequests.push({ projectId });
        diagnostics.push({
          code: "CAPEX_RESUME_PROPOSED",
          domain: "capex",
          companyId: fixture.companyId,
          severity: "info",
          keyValues: { cashUsd: observation.cashUsd, targetMinimumCashUsd: pressures.targetMinimumCashUsd },
          decisionSummary: `中断中の設備投資案件 ${projectId} の再開を提案`,
          message: "現金が安全水準を回復したため、資金難で中断中の設備投資案件の再開を提案する。",
        });
      }
    }
  }

  // 【監査指摘H・修正】PD_CAPACITY_MAINTAINED を実際の判断へ接続する。
  //
  // 以前はこのreason codeが3箇所（reasonCodes.ts / reasonTaxonomy.ts /
  // reasonCodeCatalog.ts）で定義されているだけで、どこからも発火していなかった
  // （＝仕様書には載っているが実体のない判断）。当初のご指示にある必須reason
  // codeなので削除はせず、次の実際の判断へ接続する:
  //
  //   「VAPが客観的に魅力的に見える局面（成長トレンドが増設しきい値に到達）、
  //     または供給過剰で撤退した局面において、それでもVAP増設へ追随せず、
  //     稼働中で自力採算の取れている既存PD能力で戦うことを選んだ」
  //
  // 5条件すべてを実データから確認したときだけ発火する:
  //   (a) 既存PD能力がある（維持する対象が実在する）
  //   (b) VAP側に追随の誘因が実在した（成長シグナル or 供給過剰撤退）
  //   (c) 当期VAP増設を提案していない（実際に追随しなかった）
  //   (d) PD能力が遊んでおらず、PDプレミアムが自身の最低受注水準を上回っている
  //   (e) VAPの公開供給圧力が抑制しきい値を超えている（＝過熱局面）
  //
  // 【(d)で「PDの単価採算がVAPより良い」を条件にしない理由】本モデルのVAPは
  // 単価あたりの上乗せが構造的にPDより大きく（基準比率 0.55 vs 0.18）、
  // 絶対額でも最低受注水準に対する比率でもPDがVAPを上回る局面は存在しない。
  // それを条件にすると、この判断は定義上一度も成立しない（＝また実体のない
  // reason codeに戻る）。ここで問うべきは「単価の高さ」ではなく「過熱している
  // VAPへ新規投資するより、すでに投資済みで自力採算の取れているPDを回し続ける
  // 方が良い」という限界的な判断であり、(d)+(e)がそれを表す。
  if (ext && params.growthTrendResponsiveness > 0) {
    // 【2026-08-03・Phase Aハードニング】(d)「PD能力が遊んでおらず」の判定
    // (pdInUse)は実際に使える能力に対する稼働率であるべきなので、ここも
    // ノミナルではなく実効能力を使う。
    const pdCapacity = observation.totalEffectiveCapacityByProduct.pd;
    const vapProposed = proposals.some((p) => p.projectType === LINE_EXPANSION_BY_PRODUCT.vap);
    // 前期の公開プレミアムが未取得（turn1等）なら判断材料が無いので発火させない。
    const pdPremium = observation.marketPremiumByProduct.pd;
    const vapPremium = observation.marketPremiumByProduct.vap;
    const pdHeadroomOverMinimum =
      pdPremium === undefined ? undefined : pdPremium - minimumAcceptablePremium(fixture.productEconomics.premiumEconomics.pd);
    const vapHeadroomOverMinimum =
      vapPremium === undefined ? undefined : vapPremium - minimumAcceptablePremium(fixture.productEconomics.premiumEconomics.vap);
    const pdInUse = pdCapacity > EPSILON && productionNeededByProductBeforeCap.pd / pdCapacity > params.capexPdInUseUtilizationThreshold;
    const pdStandsOnItsOwn = pdHeadroomOverMinimum !== undefined && pdHeadroomOverMinimum > 0;
    const vapPressure = supplyPressureOf("vap");
    const vapOverheated = vapPressure !== undefined && vapPressure > params.supplyPressureRetreatThreshold;
    if (
      pdCapacity > EPSILON &&
      (vapGrowthSignalPresent || vapOversupplyRetreated) &&
      !vapProposed &&
      pdInUse &&
      pdStandsOnItsOwn &&
      vapOverheated
    ) {
      diagnostics.push({
        code: "PD_CAPACITY_MAINTAINED",
        domain: "capex",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: {
          pdCapacity,
          pdUtilizationBeforeCap: productionNeededByProductBeforeCap.pd / pdCapacity,
          pdHeadroomOverMinimumPremium: pdHeadroomOverMinimum ?? 0,
          vapHeadroomOverMinimumPremium: vapHeadroomOverMinimum ?? 0,
          vapGrowthSignalPresent: vapGrowthSignalPresent ? 1 : 0,
          vapOversupplyRetreated: vapOversupplyRetreated ? 1 : 0,
          vapSupplyPressureEwma: vapPressure ?? 0,
          supplyPressureRetreatThreshold: params.supplyPressureRetreatThreshold,
        },
        decisionSummary: "VAP転換へ追随せず、既存PD能力の維持を選択",
        message:
          "VAPの公開供給圧力が過熱水準にあり、既存PD能力は稼働中でPDプレミアムが自社の最低受注水準を上回っているため、VAP増設へは追随せずPD能力の維持を選択した。",
      });
    }
  }

  // 【2026-08-03・Phase Aハードニング】共通前処理能力のボトルネック判定も、
  // capex反映後の実効能力を分母に使う（ノミナルのままだと同様に過大評価する）。
  const commonCapacity = observation.totalEffectiveCommonProcessingCapacity;
  if (commonCapacity > EPSILON) {
    const commonShortfallRatio = requiredRawMaterialUnconstrained / commonCapacity;
    const alreadyPlannedCommon = observation.activeCapexProjectTargets.has("commonProcessing");
    const isBottleneck = commonShortfallRatio > params.capexCurrentShortfallRatioThreshold;
    // 【2026-08-09・Test16】共通前処理能力への投資は、共通前処理能力の稼働率で判定する
    // （この設備区分に限っては従来と同じ分母だが、判定経路は商品別と同じ形に揃える）。
    const commonUtilization = relevantUtilizationFor(observation, "commonProcessing");
    const commonSustained = sustainedFor(commonUtilization);
    const commonGate = financialGateFor("commonProcessingExpansion");
    const safe = commonGate.safe;
    const commonSpace = checkSpaceFeasible("commonProcessingExpansion");
    if (isBottleneck && commonSustained && safe && !alreadyPlannedCommon && commonSpace.feasible) {
      proposals.push({ projectType: "commonProcessingExpansion", targetFactoryId: selectTargetFactoryId(observation, "commonProcessing") });
      reserveSpace(commonSpace.requiredSpaceUnits);
      diagnostics.push({
        code: "CAPEX_PROPOSED",
        domain: "capex",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: {
          ...utilizationKeyValues(commonUtilization, commonGate),
          commonShortfallRatio,
          financialGate: safe ? 1 : 0,
          inventoryGate: 1,
          ongoingProjectGate: alreadyPlannedCommon ? 0 : 1,
          shortfallGate: isBottleneck ? 1 : 0,
          sustainedGate: 1,
          spaceGate: 1,
          finalDecision: 1,
        },
        decisionSummary: `共通前処理能力の増設を提案（共通前処理稼働率 ${(commonUtilization.utilization * 100).toFixed(1)}%）`,
        message: "共通原料処理能力が持続的なボトルネックのため、増設案件を提案する。",
      });
    } else if (isBottleneck && commonSustained && safe && !alreadyPlannedCommon && !commonSpace.feasible) {
      recordSpaceInfeasible("commonProcessingExpansion", commonSpace.requiredSpaceUnits);
    } else if (isBottleneck) {
      diagnostics.push({
        code: "CAPEX_DEFERRED",
        domain: "capex",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: {
          ...utilizationKeyValues(commonUtilization, commonGate),
          commonShortfallRatio,
          financialGate: safe ? 1 : 0,
          inventoryGate: 1,
          ongoingProjectGate: alreadyPlannedCommon ? 0 : 1,
          shortfallGate: isBottleneck ? 1 : 0,
          sustainedGate: commonSustained ? 1 : 0,
          finalDecision: 0,
        },
        decisionSummary: `共通前処理能力の増設を見送り（共通前処理稼働率 ${(commonUtilization.utilization * 100).toFixed(1)}%）`,
        message: "共通原料処理能力は今期不足だが、持続性・財務健全性のいずれかの条件を満たさないため増設を見送る。",
      });
    }
  }

  if (proposals.length === 0 && diagnostics.length === 0) {
    diagnostics.push({
      code: "CAPEX_DEFERRED",
      domain: "capex",
      companyId: fixture.companyId,
      severity: "info",
      message: "当期はいずれの能力区分にもボトルネックが観測されないため、設備投資を見送る（既定の正常な結果）。",
    });
  }

  return {
    capexDecision: {
      companyId: fixture.companyId,
      newProjectProposals: proposals,
      cancelRequests: [],
      resumeRequests,
    },
    diagnostics,
  };
}
