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
import { Product } from "../../../market/types";
import { CompanyFixture } from "../../types";
import { minimumAcceptablePremium } from "../../premiumPolicy";
import { StandardAiParameters, STANDARD_AI_PARAMETERS_V1 } from "../parameters";
import { PressureScores } from "../pressures";
import { ProductAmount, StandardAiObservation } from "../types";
import { StandardAiDiagnosticEntry } from "../reasonCodes";

const EPSILON = 1e-6;

const LINE_EXPANSION_BY_PRODUCT: Readonly<Record<Product, CapitalProjectType>> = {
  hoso: "hosoLineExpansion",
  pd: "pdLineExpansion",
  vap: "vapLineExpansion",
};

export interface CapexPlanResult {
  readonly capexDecision: CapexDecisionInput;
  readonly diagnostics: readonly StandardAiDiagnosticEntry[];
}

interface FinancialGateDetail {
  readonly safe: boolean;
  readonly cashSafe: boolean;
  readonly borrowingSafe: boolean;
  readonly requiredCashUsd: number;
}

/**
 * 設備投資の財務ゲート。
 * 【2026-08-09・Test16】判定結果だけでなく内訳（現金・借入圧力のどちらで落ちたか）も
 * 返す。従来は safe:0 としか残らず、「なぜ投資しないのか」を説明できなかった。
 */
function cashAndBorrowingSafe(observation: StandardAiObservation, pressures: PressureScores, params: StandardAiParameters): FinancialGateDetail {
  const requiredCashUsd = pressures.targetMinimumCashUsd * params.capexCashSafetyMultiple;
  const cashSafe = observation.cashUsd > requiredCashUsd;
  const borrowingSafe = pressures.borrowingPressure < 1;
  return { safe: cashSafe && borrowingSafe, cashSafe, borrowingSafe, requiredCashUsd };
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
  params: StandardAiParameters = STANDARD_AI_PARAMETERS_V1
): CapexPlanResult {
  const diagnostics: StandardAiDiagnosticEntry[] = [];
  const proposals: CapexProjectProposalInput[] = [];
  // 【監査指摘H】PD_CAPACITY_MAINTAINED の判定材料（VAP転換へ追随しなかったか）。
  let vapOversupplyRetreated = false;
  let vapGrowthSignalPresent = false;
  const financialGate = cashAndBorrowingSafe(observation, pressures, params);
  const safe = financialGate.safe;
  // 【2026-08-09・Test16】持続性判定は投資対象設備ごとに行う（下の各分岐で算出）。
  // hadPriorQuarterUtilization は「前四半期の操業実績が存在するか」の判定にのみ使う
  // （turn1では前期実績が無いため、いかなる設備区分でも持続性は成立しない）。
  const hasPriorQuarter = pressures.hadPriorQuarterUtilization;
  const sustainedFor = (u: RelevantUtilization): boolean =>
    hasPriorQuarter && u.utilization >= params.capexSustainedUtilizationThreshold;

  /** B3: 「何の設備の何%を見たか」を必ず説明できるようにする共通keyValues。 */
  const utilizationKeyValues = (u: RelevantUtilization): Record<string, number> => ({
    relevantCapacity: u.capacity,
    relevantActualProduction: u.actualProduction,
    relevantUtilization: u.utilization,
    sustainedThreshold: params.capexSustainedUtilizationThreshold,
    hadPriorQuarter: hasPriorQuarter ? 1 : 0,
    // 財務ゲートの内訳（safe:0 だけでは現金不足か借入過多か分からないため）。
    financialGateCashSafe: financialGate.cashSafe ? 1 : 0,
    financialGateBorrowingSafe: financialGate.borrowingSafe ? 1 : 0,
    financialGateRequiredCashUsd: financialGate.requiredCashUsd,
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

    if (isBottleneck && sustained && noExcess && safe && !alreadyPlanned) {
      proposals.push({ projectType: LINE_EXPANSION_BY_PRODUCT[product] });
      diagnostics.push({
        code: "CAPEX_PROPOSED",
        domain: "capex",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: {
          ...utilizationKeyValues(utilization),
          shortfallRatio,
          effectiveShortfallThreshold,
          productThresholdBias,
          financialGate: safe ? 1 : 0,
          inventoryGate: noExcess ? 1 : 0,
          ongoingProjectGate: alreadyPlanned ? 0 : 1,
          shortfallGate: isBottleneck ? 1 : 0,
          sustainedGate: 1,
          finalDecision: 1,
        },
        decisionSummary: `${product.toUpperCase()}ライン増設を提案（${product.toUpperCase()}ライン稼働率 ${(utilization.utilization * 100).toFixed(1)}%）`,
        message:
          `${product.toUpperCase()}加工能力が持続的なボトルネックのため、増設案件を提案する。` +
          `判定に使ったのは${product.toUpperCase()}専用ラインの稼働率` +
          `（前期実績 ${Math.round(utilization.actualProduction).toLocaleString()}t ÷ 実効能力 ${Math.round(utilization.capacity).toLocaleString()}t ` +
          `= ${(utilization.utilization * 100).toFixed(1)}%）であり、共通前処理能力の稼働率ではない。`,
      });
    } else if (isBottleneck) {
      diagnostics.push({
        code: "CAPEX_DEFERRED",
        domain: "capex",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: {
          ...utilizationKeyValues(utilization),
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
      if (trend !== undefined && trend >= trendThreshold && utilizationOk && noExcess && safe) {
        proposals.push({ projectType: LINE_EXPANSION_BY_PRODUCT[product] });
        diagnostics.push({
          code: product === "vap" ? "VAP_GROWTH_ENTRY" : "LIFECYCLE_GROWTH_PURSUED",
          domain: "capex",
          companyId: fixture.companyId,
          severity: "info",
          keyValues: {
            ...utilizationKeyValues(utilization),
            lifecycleTrendPerQuarter: trend,
            trendThreshold,
            growthEntryUtilizationThreshold: params.capexGrowthEntryUtilizationThreshold,
            growthTrendResponsiveness: params.growthTrendResponsiveness,
            financialGate: safe ? 1 : 0,
            inventoryGate: noExcess ? 1 : 0,
            ongoingProjectGate: alreadyPlanned ? 0 : 1,
            shortfallGate: 0,
            finalDecision: 1,
          },
          decisionSummary: `${product.toUpperCase()}ライン増設を成長エントリとして提案`,
          message: `${product.toUpperCase()}の公開ライフサイクルトレンドが成長局面にあり、稼働率・在庫・財務の安全条件を満たすため、能力不足の顕在化前に増設を提案する。`,
        });
      }
    }
  }

  // 【SAI-5F】suspended案件のresume提案: 資金難で中断した案件は、現金が
  // 通常capexと同じ安全水準（目標バッファ×capexCashSafetyMultiple）を回復した
  // 場合に再開を提案する（従来は再開経路が無く、中断案件がCIPに現金を固定した
  // ままデッドロックし得た。Fable事前監査で特定）。
  const resumeRequests: { readonly projectId: string }[] = [];
  if (ext) {
    for (const projectId of observation.suspendedCapexProjectIds ?? []) {
      if (safe) {
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
    if (isBottleneck && commonSustained && safe && !alreadyPlannedCommon) {
      proposals.push({ projectType: "commonProcessingExpansion" });
      diagnostics.push({
        code: "CAPEX_PROPOSED",
        domain: "capex",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: {
          ...utilizationKeyValues(commonUtilization),
          commonShortfallRatio,
          financialGate: safe ? 1 : 0,
          inventoryGate: 1,
          ongoingProjectGate: alreadyPlannedCommon ? 0 : 1,
          shortfallGate: isBottleneck ? 1 : 0,
          sustainedGate: 1,
          finalDecision: 1,
        },
        decisionSummary: `共通前処理能力の増設を提案（共通前処理稼働率 ${(commonUtilization.utilization * 100).toFixed(1)}%）`,
        message: "共通原料処理能力が持続的なボトルネックのため、増設案件を提案する。",
      });
    } else if (isBottleneck) {
      diagnostics.push({
        code: "CAPEX_DEFERRED",
        domain: "capex",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: {
          ...utilizationKeyValues(commonUtilization),
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
