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

function cashAndBorrowingSafe(observation: StandardAiObservation, pressures: PressureScores, params: StandardAiParameters): boolean {
  const cashSafe = observation.cashUsd > pressures.targetMinimumCashUsd * params.capexCashSafetyMultiple;
  const borrowingSafe = pressures.borrowingPressure < 1;
  return cashSafe && borrowingSafe;
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
  const safe = cashAndBorrowingSafe(observation, pressures, params);
  const sustained = pressures.hadPriorQuarterUtilization && pressures.equipmentUtilizationLastQuarter >= params.capexSustainedUtilizationThreshold;

  for (const product of ["hoso", "pd", "vap"] as const) {
    const capacity = observation.totalCapacityByProduct[product];
    if (capacity <= EPSILON) continue;
    const shortfallRatio = productionNeededByProductBeforeCap[product] / capacity;
    const noExcess = observation.finishedGoodsByProduct[product] <= capacity * params.finishedGoodsTargetQuarters * params.excessInventoryRatioForDiscount;
    const alreadyPlanned = observation.activeCapexProjectTargets.has(product);
    // 【SAI-4追加】経営性格プロファイル（D社=高付加価値重視）向けの差し込み口。
    // capexShortfallThresholdBiasByProduct[product]は既定0（全社共通の
    // capexCurrentShortfallRatioThresholdをそのまま使うのと完全に同じ）。正の値は
    // しきい値をそのぶん下げ、PD/VAPのボトルネック解消投資をわずかに前倒しする
    // （安全ガード：cashAndBorrowingSafe・sustained・noExceptの各条件は一切変更せず、
    // 「投資を検討し始める入口の感度」だけを動かす）。
    const productThresholdBias = params.capexShortfallThresholdBiasByProduct[product] ?? 0;
    const effectiveShortfallThreshold = params.capexCurrentShortfallRatioThreshold - productThresholdBias;
    const isBottleneck = shortfallRatio > effectiveShortfallThreshold;

    if (isBottleneck && sustained && noExcess && safe && !alreadyPlanned) {
      proposals.push({ projectType: LINE_EXPANSION_BY_PRODUCT[product] });
      diagnostics.push({
        code: "CAPEX_PROPOSED",
        domain: "capex",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: {
          shortfallRatio,
          equipmentUtilizationLastQuarter: pressures.equipmentUtilizationLastQuarter,
          effectiveShortfallThreshold,
          productThresholdBias,
        },
        message: `${product.toUpperCase()}加工能力が持続的なボトルネックのため、増設案件を提案する。`,
      });
    } else if (isBottleneck) {
      diagnostics.push({
        code: "CAPEX_DEFERRED",
        domain: "capex",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: {
          shortfallRatio,
          sustained: sustained ? 1 : 0,
          noExcess: noExcess ? 1 : 0,
          safe: safe ? 1 : 0,
          alreadyPlanned: alreadyPlanned ? 1 : 0,
          effectiveShortfallThreshold,
          productThresholdBias,
        },
        message: `${product.toUpperCase()}は今期は能力不足だが、持続性・在庫・財務健全性のいずれかの条件を満たさないため増設を見送る。`,
      });
    }
  }

  const commonCapacity = observation.totalCommonProcessingCapacity;
  if (commonCapacity > EPSILON) {
    const commonShortfallRatio = requiredRawMaterialUnconstrained / commonCapacity;
    const alreadyPlannedCommon = observation.activeCapexProjectTargets.has("commonProcessing");
    const isBottleneck = commonShortfallRatio > params.capexCurrentShortfallRatioThreshold;
    if (isBottleneck && sustained && safe && !alreadyPlannedCommon) {
      proposals.push({ projectType: "commonProcessingExpansion" });
      diagnostics.push({
        code: "CAPEX_PROPOSED",
        domain: "capex",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: { commonShortfallRatio },
        message: "共通原料処理能力が持続的なボトルネックのため、増設案件を提案する。",
      });
    } else if (isBottleneck) {
      diagnostics.push({
        code: "CAPEX_DEFERRED",
        domain: "capex",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: { commonShortfallRatio },
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
      resumeRequests: [],
    },
    diagnostics,
  };
}
