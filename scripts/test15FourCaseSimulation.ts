// ShrimpX V2 — Test15 4ケース決定論的シミュレーション（新工場建設・PD省人化投資）
//
// 実際の advanceCompanyLabQuarter / generateAutoPolicyDecision を使って、同一seedの
// 決定論的シミュレーションを複数四半期進め、以下4ケースを比較する:
//   1. baseline           新工場建設・PD省人化のいずれも行わない
//   2. newFactoryOnly     新工場建設のみ（かつ意図的に需要制約シナリオ：追加能力が
//                         余る状況を作り、「需要制約下では能力増強が純負になり得る」
//                         ことを示す）
//   3. pdMechanizationOnly PD省人化投資のみ（既存工場が対象）。低稼働率と高稼働率の
//                         2バリアントを内部的に走らせ、「稼働率が高いほど投資効果が
//                         大きい」ことを示す。
//   4. both               新工場建設＋PD省人化投資の両方（需要制約なし）
//
// 対象会社は BAL に固定する（他4社は全ターン自動方針のまま、比較のノイズにしない）。
//
// このモジュールはCLIスクリプトとしても、Node test からimportして再利用する
// ライブラリとしても使える（run*関数をexportしている）。

import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../app/lib/v2/companyLab/runner";
import { generateAutoPolicyDecision } from "../app/lib/v2/companyLab/autoPolicy";
import { CompanyDecisionInput, CompanyFixture, CompanyLabState, CompanyQuarterRecord } from "../app/lib/v2/companyLab/types";
import { CompanyId } from "../app/lib/v2/sales/types";
import { extractCompanyFinancialResult } from "../app/v2/company-lab/play/_lib/financialViewSelectors";
import {
  computeAdoptionRampProgress,
  computeEffectivePdCoefficient,
  computeMechanizationLevel,
  PD_MECHANIZATION_PARAMETERS_V1,
} from "../app/lib/v2/capex/pdMechanization";

const FOCUS_COMPANY_ID = "BAL";
export const SIMULATION_HORIZON_QUARTERS = 12;

export interface FourCaseSimulationInput {
  readonly newFactory: boolean;
  readonly pdMechanization: boolean;
  /** 需要制約シナリオ（販売希望量を、能力増強前の水準へ固定する）。 */
  readonly demandConstrained: boolean;
  readonly seed: string;
  readonly horizonQuarters?: number;
}

export interface QuarterEndSnapshot {
  readonly turn: number;
  readonly netIncomeUsd: number;
  readonly cashUsd: number;
  readonly equipmentUtilizationRate: number | null;
  readonly laborUtilizationRate: number | null;
  readonly regularHeadcount: number;
  readonly finishedGoodsInventoryTons: number;
  readonly rawMaterialInventoryTons: number;
  readonly hosoProducedTons: number;
  readonly pdProducedTons: number;
  readonly vapProducedTons: number;
}

export interface FourCaseSimulationResult {
  readonly cumulativeNetIncomeUsd: number;
  readonly quarters: readonly QuarterEndSnapshot[];
  readonly finalQuarter: QuarterEndSnapshot;
}

function fixedDemandCapDecision(
  autoDecision: CompanyDecisionInput,
  capByMarketProduct: ReadonlyMap<string, number>,
): CompanyDecisionInput {
  return {
    ...autoDecision,
    salesPlans: autoDecision.salesPlans.map((p) => {
      const cap = capByMarketProduct.get(`${p.market}:${p.product}`);
      if (cap === undefined) return p;
      const desired = p.desiredQuantity as unknown as number;
      return desired > cap ? { ...p, desiredQuantity: cap as unknown as typeof p.desiredQuantity } : p;
    }),
    productionPlans: autoDecision.productionPlans.map((p) => {
      // 生産計画も需要制約に合わせて頭打ちにする（作っても売れない在庫の山を防ぎ、
      // 「能力を増やしても実際の生産・販売が増えない」状況を素直に表現する）。
      const capsForProduct = Array.from(capByMarketProduct.entries())
        .filter(([k]) => k.endsWith(`:${p.product}`))
        .map(([, v]) => v);
      if (capsForProduct.length === 0) return p;
      const totalCapForProduct = capsForProduct.reduce((s, v) => s + v, 0);
      const desired = p.desiredQuantity as unknown as number;
      return desired > totalCapForProduct ? { ...p, desiredQuantity: totalCapForProduct as unknown as typeof p.desiredQuantity } : p;
    }),
  };
}

export function runFourCaseSimulationCase(input: FourCaseSimulationInput): FourCaseSimulationResult {
  const horizon = input.horizonQuarters ?? SIMULATION_HORIZON_QUARTERS;
  const config = { scenarioId: "baseline" as const, mode: "canonical" as const, seed: input.seed, turns: horizon };
  const { state: initialState, fixtures } = initializeCompanyLab(config);
  const focusFixture = fixtures.find((f) => f.companyId === FOCUS_COMPANY_ID)!;
  const targetFactoryId = focusFixture.factories[0].factoryId;

  // 需要制約シナリオ用: ターン0（能力増強前）の自動方針の希望量を「上限」として固定する。
  let demandCapByMarketProduct: Map<string, number> | undefined;

  let state: CompanyLabState = initialState;
  const quarters: QuarterEndSnapshot[] = [];
  let cumulativeNetIncomeUsd = 0;

  for (let turn = 0; turn < horizon; turn++) {
    if (state.isComplete) break;
    const publicInfo = buildPublicMarketInfo(state);
    const decisions: Record<CompanyId, CompanyDecisionInput> = {};
    for (const f of fixtures) {
      const ownState = buildCompanyOwnState(state, f);
      let decision = generateAutoPolicyDecision(f, ownState, publicInfo, state.currentPeriod, state.scenarioState.currentTurn);
      if (f.companyId === FOCUS_COMPANY_ID) {
        if (turn === 0 && input.demandConstrained) {
          demandCapByMarketProduct = new Map(
            decision.salesPlans.map((p) => [`${p.market}:${p.product}`, p.desiredQuantity as unknown as number]),
          );
        }
        if (turn === 0) {
          const newProjectProposals = [
            ...decision.capexDecision.newProjectProposals,
            ...(input.newFactory ? [{ projectType: "newFactoryConstruction" as const }] : []),
            ...(input.pdMechanization ? [{ projectType: "pdMechanization" as const, targetFactoryId }] : []),
          ];
          decision = { ...decision, capexDecision: { ...decision.capexDecision, newProjectProposals } };
        }
        if (input.demandConstrained && demandCapByMarketProduct) {
          decision = fixedDemandCapDecision(decision, demandCapByMarketProduct);
        }
      }
      decisions[f.companyId] = decision;
    }
    const nextState = advanceCompanyLabQuarter(state, fixtures, decisions);
    const record: CompanyQuarterRecord = nextState.history[nextState.history.length - 1];
    const financial = extractCompanyFinancialResult(record, FOCUS_COMPANY_ID);
    const summary = record.companySummaries.find((s) => s.companyId === FOCUS_COMPANY_ID) ?? null;
    const workforce = nextState.workforceState?.companies.find((c) => c.companyId === FOCUS_COMPANY_ID);
    const regularHeadcount = workforce ? workforce.factories.reduce((sum, f) => sum + f.regularHeadcount, 0) : 0;

    const netIncome = financial ? (financial.profitAndLoss.netIncome as unknown as number) : 0;
    cumulativeNetIncomeUsd += netIncome;

    quarters.push({
      turn: record.turn,
      netIncomeUsd: netIncome,
      cashUsd: financial ? (financial.balanceSheet.cash as unknown as number) : 0,
      equipmentUtilizationRate: summary ? (summary.equipmentUtilizationRate as unknown as number) : null,
      laborUtilizationRate: summary ? (summary.laborUtilizationRate as unknown as number) : null,
      regularHeadcount,
      finishedGoodsInventoryTons: summary ? (summary.finishedGoodsInventory as unknown as number) : 0,
      rawMaterialInventoryTons: summary ? (summary.rawMaterialInventory as unknown as number) : 0,
      hosoProducedTons: summary ? (summary.hosoProduced as unknown as number) : 0,
      pdProducedTons: summary ? (summary.pdProduced as unknown as number) : 0,
      vapProducedTons: summary ? (summary.vapProduced as unknown as number) : 0,
    });
    state = nextState;
  }

  const finalQuarter = quarters[quarters.length - 1];
  return { cumulativeNetIncomeUsd, quarters, finalQuarter };
}

export interface FourCaseComparisonTable {
  readonly baseline: FourCaseSimulationResult;
  readonly newFactoryOnly: FourCaseSimulationResult;
  readonly pdMechanizationOnly: FourCaseSimulationResult;
  readonly both: FourCaseSimulationResult;
}

export function runAllFourCases(seedPrefix = "test15-4case"): FourCaseComparisonTable {
  return {
    baseline: runFourCaseSimulationCase({ newFactory: false, pdMechanization: false, demandConstrained: false, seed: `${seedPrefix}-baseline` }),
    newFactoryOnly: runFourCaseSimulationCase({ newFactory: true, pdMechanization: false, demandConstrained: true, seed: `${seedPrefix}-newfactory` }),
    pdMechanizationOnly: runFourCaseSimulationCase({
      newFactory: false,
      pdMechanization: true,
      demandConstrained: false,
      seed: `${seedPrefix}-pdmech`,
    }),
    both: runFourCaseSimulationCase({ newFactory: true, pdMechanization: true, demandConstrained: false, seed: `${seedPrefix}-both` }),
  };
}

// ---------------------------------------------------------------------
// PD省人化投資の「稼働率が高いほど効果が大きい」ことの感度分析
//
// 【なぜ経済シミュレーション全体で示さないか】会社全体の純利益は、需要・価格競争・
// 他社の動向・原料調達等、PD省人化投資と無関係な多数の要因に支配されるため、
// 「PD稼働率だけを変数として動かした2つのフル経済シミュレーション」を作っても、
// 他の要因のノイズに埋もれて比例関係が読み取れない（実際に試したところ、
// 生産希望量を強制的に釣り上げるとPD以外のコスト増（残業・原料不足）が支配的になり、
// 逆の結果になった）。そこで、capex/pdMechanization.tsの純粋関数
// （computeAdoptionRampProgress・computeMechanizationLevel・computeEffectivePdCoefficient）
// を直接呼び、「同じ習熟進捗のもとで前四半期PD稼働率だけを変えると、実効PD係数・
// 削減率が単調に改善する」ことを、エンジンの計算式そのものに基づいて確認する
// （このモジュール自身が新たな計算式を作らない）。
// ---------------------------------------------------------------------

export interface PdUtilizationSensitivityRow {
  readonly previousQuarterPdUtilization: number;
  readonly mechanizationLevel: number;
  readonly effectivePdCoefficient: number;
  readonly reductionRatio: number;
}

export function computePdUtilizationSensitivity(
  quartersSinceActivation: number,
  utilizationLevels: readonly number[] = [0.2, 0.5, 0.9],
): readonly PdUtilizationSensitivityRow[] {
  const rampProgress = computeAdoptionRampProgress(quartersSinceActivation);
  return utilizationLevels.map((utilization) => {
    const mechanizationLevel = computeMechanizationLevel(rampProgress, utilization);
    const effectivePdCoefficient = computeEffectivePdCoefficient(mechanizationLevel);
    return {
      previousQuarterPdUtilization: utilization,
      mechanizationLevel,
      effectivePdCoefficient,
      reductionRatio: 1 - effectivePdCoefficient / PD_MECHANIZATION_PARAMETERS_V1.baseCoefficient,
    };
  });
}

function fmtUsd(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

function printComparisonTable(table: FourCaseComparisonTable): void {
  const rows: readonly [string, FourCaseSimulationResult][] = [
    ["1. baseline（新工場なし・PD省人化なし）", table.baseline],
    ["2. newFactoryOnly（新工場のみ・需要制約下）", table.newFactoryOnly],
    ["3. pdMechanizationOnly（既存工場を対象）", table.pdMechanizationOnly],
    ["4. both（新工場＋PD省人化・需要制約なし）", table.both],
  ];
  console.log(`\n=== Test15 4ケース比較（会社=${FOCUS_COMPANY_ID}, 地平線=${SIMULATION_HORIZON_QUARTERS}四半期）===\n`);
  for (const [label, result] of rows) {
    const f = result.finalQuarter;
    console.log(`--- ${label} ---`);
    console.log(`  累計純利益: ${fmtUsd(result.cumulativeNetIncomeUsd)}`);
    console.log(`  最終四半期純利益: ${fmtUsd(f.netIncomeUsd)}`);
    console.log(`  最終四半期現金: ${fmtUsd(f.cashUsd)}`);
    console.log(`  最終四半期設備稼働率: ${f.equipmentUtilizationRate !== null ? (f.equipmentUtilizationRate * 100).toFixed(1) + "%" : "－"}`);
    console.log(`  最終四半期労働稼働率: ${f.laborUtilizationRate !== null ? (f.laborUtilizationRate * 100).toFixed(1) + "%" : "－"}`);
    console.log(`  最終四半期常用Worker人数: ${f.regularHeadcount.toLocaleString("en-US")}人`);
    console.log(`  最終四半期完成品在庫: ${f.finishedGoodsInventoryTons.toFixed(1)} t`);
    console.log(`  最終四半期原料在庫: ${f.rawMaterialInventoryTons.toFixed(1)} t`);
    console.log("");
  }
  console.log(`基準PD係数: ${PD_MECHANIZATION_PARAMETERS_V1.baseCoefficient}`);

  console.log(`\n=== PD省人化投資: 稼働率感度分析（習熟完了後・quartersSinceActivation=${PD_MECHANIZATION_PARAMETERS_V1.adoptionRampQuarters}） ===\n`);
  const sensitivity = computePdUtilizationSensitivity(PD_MECHANIZATION_PARAMETERS_V1.adoptionRampQuarters);
  for (const row of sensitivity) {
    console.log(
      `  前四半期PD稼働率 ${(row.previousQuarterPdUtilization * 100).toFixed(0)}% → mechanizationLevel ${(row.mechanizationLevel * 100).toFixed(1)}% / 実効PD係数 ${row.effectivePdCoefficient.toFixed(4)} / 削減率 ${(row.reductionRatio * 100).toFixed(2)}%`,
    );
  }
}

if (require.main === module) {
  const table = runAllFourCases();
  printComparisonTable(table);
}
