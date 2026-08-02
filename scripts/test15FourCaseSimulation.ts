// ShrimpX V2 — Test15 4ケース決定論的シミュレーション（新工場建設・PD省人化投資）
//
// 実際の advanceCompanyLabQuarter / generateAutoPolicyDecision を使って、決定論的な
// 経済シミュレーションを複数四半期進め、以下の比較を行う:
//
//   【develop/v2統合・Required fix 4で全面見直し】
//   コーディネーター指摘: 「全ケースが同一seed・同一初期状態・同一需要制約・
//   同一の他社方針を使い、新工場建設／PD省人化の意思決定だけが異なる」という
//   条件を満たしていなかった（旧実装はケースごとに異なるseedを使っており、
//   需要制約もケース間で不揃いだった）。
//
//   本実装では、SINGLE_SEEDという単一の共通seedを全ケースで使う。会社BAL以外の
//   4社は全ケース・全ターンでgenerateAutoPolicyDecision（自動方針）のみを使い、
//   一切上書きしない（他社方針も完全に同一）。BALの意思決定も、対象の投資提案
//   （newFactoryConstruction／pdMechanization）と、比較ペアで揃える需要関連の
//   上書き以外は自動方針そのまま。
//
//   比較A（需要制約下の新工場建設）: baselineDemandConstrained と
//   newFactoryDemandConstrained は、同一seed・同一の需要上限（turn0の自動方針の
//   希望量から算出した固定値）を両方に適用し、newFactoryConstruction提案の
//   有無だけが違う。
//
//   比較B（高PD稼働率下のPD省人化投資、実シミュレーションによる比較）:
//   pdMechanizationOff/On は、同一seed・同一の「PD需要を意図的に高水準へ
//   引き上げる」上書き（既存工場のPD稼働率を高く保つための希望量の下限）を
//   両方に適用し、pdMechanization提案の有無だけが違う。実際に
//   advanceCompanyLabQuarterを通した結果から、PD生産量・必要/配置ワーカー数・
//   残業費・原料/労働不足量・PD省人化投資のcapex（保守費・減価償却費）・
//   純利益・現金を報告する（純粋関数のみの感度分析はcomputePdUtilizationSensitivity
//   として引き続き補助的に残す）。
//
//   参考ケース: baseline（需要制約なし・投資なし）、both（需要制約なし・
//   新工場建設＋PD省人化投資の両方）も、同一SINGLE_SEEDで走らせ、全体像の
//   参考値として残す。
//
// このモジュールはCLIスクリプトとしても、Node test からimportして再利用する
// ライブラリとしても使える（run*関数をexportしている）。

import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../app/lib/v2/companyLab/runner";
import { generateAutoPolicyDecision } from "../app/lib/v2/companyLab/autoPolicy";
import { CompanyDecisionInput, CompanyLabState, CompanyQuarterRecord } from "../app/lib/v2/companyLab/types";
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

/**
 * 【develop/v2統合・Required fix 4】全ケース共通の単一seed。
 * 「全ケースが同一seed・同一初期状態・同一の他社方針を使う」という要求に
 * 従い、ケースごとに異なるseedを使わない。
 */
export const SINGLE_SEED = "test15-4case-canonical-seed";

export interface FourCaseSimulationInput {
  readonly seed: string;
  readonly newFactory: boolean;
  readonly pdMechanization: boolean;
  /** 需要上限（市場×商品ごとの希望量の固定上限）。両ケースへ同一の値を渡すのは呼び出し側の責務。 */
  readonly demandCapByMarketProduct?: ReadonlyMap<string, number>;
  /**
   * 【比較B用】既存工場のPD希望量の「下限」（意図的にPD稼働率を高水準に保つための
   * 上書き）。両ケースへ同一の値を渡すのは呼び出し側の責務。
   */
  readonly pdDesiredQuantityFloorByFactory?: ReadonlyMap<string, number>;
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
  /** 【Required fix 4】残業費（overtimeCost、manufacturingCost内）。 */
  readonly overtimeCostUsd: number;
  /** 【Required fix 4】原料不足量（rawMaterialShortfall、HOSO換算トン）。 */
  readonly rawMaterialShortfallTons: number;
  /** 【Required fix 4】設備不足量（equipmentShortfall、HOSO換算トン）。 */
  readonly equipmentShortfallTons: number;
  /** 【Required fix 4】労働不足量（laborShortfall、HOSO換算トン）。 */
  readonly laborShortfallTons: number;
  /** 【Required fix 4】当期の稼働中capex資産の保守費合計（診断用、会社全体）。 */
  readonly capexMaintenanceCostUsd: number;
  /** 【Required fix 4】当期の稼働開始済み新規capex資産の減価償却費合計（診断用、会社全体）。 */
  readonly capexAssetsDepreciationUsd: number;
  /** 【Required fix 4】当期の設備投資現金支払合計（診断用、会社全体）。 */
  readonly capexTotalPaidUsd: number;
}

export interface FourCaseSimulationResult {
  readonly cumulativeNetIncomeUsd: number;
  readonly quarters: readonly QuarterEndSnapshot[];
  readonly finalQuarter: QuarterEndSnapshot;
}

/** turn0の自動方針の希望量から、市場×商品ごとの需要上限マップを構築する（比較A用）。 */
export function buildDemandCapFromAutoDecision(decision: CompanyDecisionInput): ReadonlyMap<string, number> {
  return new Map(decision.salesPlans.map((p) => [`${p.market}:${p.product}`, p.desiredQuantity as unknown as number]));
}

function applyDemandCap(decision: CompanyDecisionInput, capByMarketProduct: ReadonlyMap<string, number>): CompanyDecisionInput {
  return {
    ...decision,
    salesPlans: decision.salesPlans.map((p) => {
      const cap = capByMarketProduct.get(`${p.market}:${p.product}`);
      if (cap === undefined) return p;
      const desired = p.desiredQuantity as unknown as number;
      return desired > cap ? { ...p, desiredQuantity: cap as unknown as typeof p.desiredQuantity } : p;
    }),
    productionPlans: decision.productionPlans.map((p) => {
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

function applyPdDemandFloor(decision: CompanyDecisionInput, floorByFactory: ReadonlyMap<string, number>): CompanyDecisionInput {
  // BALの自動方針の商品構成上、pdの生産計画行がそもそも生成されない場合がある
  // （neededByProduct.pd<=0だとautoPolicy.tsのbuildProductionPlansが行を作らない）。
  // その場合は、対象工場向けにpd行を新規挿入する（PD稼働率を意図的に高水準へ
  // 保つための、比較B専用の意図的な上書き。demandCapとは独立の別軸のため
  // 併用しない）。
  const touchedFactoryIds = new Set<string>();
  const updatedExisting = decision.productionPlans.map((p) => {
    if (p.product !== "pd") return p;
    const floor = floorByFactory.get(p.factoryId);
    if (floor === undefined) return p;
    touchedFactoryIds.add(p.factoryId);
    const desired = p.desiredQuantity as unknown as number;
    return desired < floor ? { ...p, desiredQuantity: floor as unknown as typeof p.desiredQuantity, priority: 1 } : p;
  });
  const insertedRows = Array.from(floorByFactory.entries())
    .filter(([factoryId]) => !touchedFactoryIds.has(factoryId))
    .map(([factoryId, floor]) => ({
      companyId: decision.companyId,
      factoryId,
      product: "pd" as const,
      desiredQuantity: floor as unknown as CompanyDecisionInput["productionPlans"][number]["desiredQuantity"],
      priority: 1,
    }));
  // 【実際に生産できる高PD稼働率を作るための追加調達】このシード・シナリオでは
  // BALは既に原料不足（rawMaterialShortfall）が常態化しており、単にpd生産計画を
  // 積み増すだけでは原料配分の奪い合いに敗れて実際の生産に反映されない
  // （比較の意味がなくなる）。そのため、追加したpd希望量ぶんの原料を、
  // 国内調達希望量へ同量加算する（HOSO換算の粗い1:1近似。歩留まりの精緻な
  // 計算はこの実験的シナリオの主目的ではない）。この加算はpdMechanizationOn/Off
  // 両ケースへ同一のfloorByFactoryを渡すため、両ケースへ全く同一に適用され、
  // どちらか一方だけを有利にするものではない。
  const totalAddedPdFloor = Array.from(floorByFactory.values()).reduce((s, v) => s + v, 0);
  const domesticPurchasePlan =
    totalAddedPdFloor > 0
      ? {
          ...decision.domesticPurchasePlan,
          desiredQuantity: ((decision.domesticPurchasePlan.desiredQuantity as unknown as number) + totalAddedPdFloor) as unknown as CompanyDecisionInput["domesticPurchasePlan"]["desiredQuantity"],
        }
      : decision.domesticPurchasePlan;
  return { ...decision, productionPlans: [...updatedExisting, ...insertedRows], domesticPurchasePlan };
}

export function runFourCaseSimulationCase(input: FourCaseSimulationInput): FourCaseSimulationResult {
  const horizon = input.horizonQuarters ?? SIMULATION_HORIZON_QUARTERS;
  const config = { scenarioId: "baseline" as const, mode: "canonical" as const, seed: input.seed, turns: horizon };
  const { state: initialState, fixtures } = initializeCompanyLab(config);
  const focusFixture = fixtures.find((f) => f.companyId === FOCUS_COMPANY_ID)!;
  const targetFactoryId = focusFixture.factories[0].factoryId;

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
        if (turn === 0) {
          const newProjectProposals = [
            ...decision.capexDecision.newProjectProposals,
            ...(input.newFactory ? [{ projectType: "newFactoryConstruction" as const }] : []),
            ...(input.pdMechanization ? [{ projectType: "pdMechanization" as const, targetFactoryId }] : []),
          ];
          decision = { ...decision, capexDecision: { ...decision.capexDecision, newProjectProposals } };
        }
        // 案件は現金不足の四半期があると"suspended"になり、明示的な再開要求が
        // ない限り二度と支払対象に戻らない（projectLifecycle.ts）。自動方針は
        // 再開要求を出さないため、capexIntegration.test.tsと同じパターンで、
        // suspended状態の自社案件は毎期再開要求を出し続ける（全ケース共通の
        // 挙動であり、特定ケースだけに手心を加えるものではない）。
        const suspendedProjectIds = ownState.capexState.portfolio.projects.filter((p) => p.status === "suspended").map((p) => p.projectId);
        if (suspendedProjectIds.length > 0) {
          decision = {
            ...decision,
            capexDecision: { ...decision.capexDecision, resumeRequests: suspendedProjectIds.map((projectId) => ({ projectId })) },
          };
        }
        if (input.demandCapByMarketProduct) {
          decision = applyDemandCap(decision, input.demandCapByMarketProduct);
        }
        if (input.pdDesiredQuantityFloorByFactory) {
          decision = applyPdDemandFloor(decision, input.pdDesiredQuantityFloorByFactory);
        }
      }
      decisions[f.companyId] = decision;
    }
    const nextState = advanceCompanyLabQuarter(state, fixtures, decisions);
    const record: CompanyQuarterRecord = nextState.history[nextState.history.length - 1];
    const financial = extractCompanyFinancialResult(record, FOCUS_COMPANY_ID);
    const summary = record.companySummaries.find((s) => s.companyId === FOCUS_COMPANY_ID) ?? null;
    const capexResult = record.capexResults.find((c) => c.companyId === FOCUS_COMPANY_ID) ?? null;
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
      overtimeCostUsd: financial ? (financial.manufacturingCost.overtimeCost as unknown as number) : 0,
      rawMaterialShortfallTons: summary ? (summary.rawMaterialShortfall as unknown as number) : 0,
      equipmentShortfallTons: summary ? (summary.equipmentShortfall as unknown as number) : 0,
      laborShortfallTons: summary ? (summary.laborShortfall as unknown as number) : 0,
      capexMaintenanceCostUsd: capexResult ? capexResult.capexMaintenanceCostUsd : 0,
      capexAssetsDepreciationUsd: capexResult ? capexResult.capexAssetsDepreciationUsd : 0,
      capexTotalPaidUsd: capexResult ? capexResult.totalPaidThisQuarterUsd : 0,
    });
    state = nextState;
  }

  const finalQuarter = quarters[quarters.length - 1];
  return { cumulativeNetIncomeUsd, quarters, finalQuarter };
}

export interface FourCaseComparisonTable {
  /** 参考ケース: 需要制約なし・投資なし。 */
  readonly baseline: FourCaseSimulationResult;
  /** 比較A用baseline: 需要制約あり・投資なし。newFactoryDemandConstrainedと同一の需要上限。 */
  readonly baselineDemandConstrained: FourCaseSimulationResult;
  /** 比較A: 需要制約あり・新工場建設のみ。baselineDemandConstrainedと同一の需要上限。 */
  readonly newFactoryDemandConstrained: FourCaseSimulationResult;
  /** 比較B用baseline: 高PD需要下・PD省人化投資なし。pdMechanizationOnと同一の高PD需要下限。 */
  readonly pdMechanizationOff: FourCaseSimulationResult;
  /** 比較B: 高PD需要下・PD省人化投資あり。pdMechanizationOffと同一の高PD需要下限。 */
  readonly pdMechanizationOn: FourCaseSimulationResult;
  /** 参考ケース: 需要制約なし・新工場建設＋PD省人化投資の両方。 */
  readonly both: FourCaseSimulationResult;
}

export function runAllFourCases(seed = SINGLE_SEED): FourCaseComparisonTable {
  // 比較A用の需要上限を、投資なし・需要制約なしの「素の」turn0自動方針から算出する
  // （baselineDemandConstrained・newFactoryDemandConstrained両方へ同一の値を渡す）。
  const { state: probeState, fixtures: probeFixtures } = initializeCompanyLab({
    scenarioId: "baseline" as const,
    mode: "canonical" as const,
    seed,
    turns: 1,
  });
  const probeFixture = probeFixtures.find((f) => f.companyId === FOCUS_COMPANY_ID)!;
  const probeOwn = buildCompanyOwnState(probeState, probeFixture);
  const probePublicInfo = buildPublicMarketInfo(probeState);
  const probeDecision = generateAutoPolicyDecision(probeFixture, probeOwn, probePublicInfo, probeState.currentPeriod, 1);
  const demandCap = buildDemandCapFromAutoDecision(probeDecision);

  // 比較B用のPD需要下限を、対象工場のPD処理能力（フィクスチャの代表値）に近い
  // 水準へ設定する（高PD稼働率を意図的に作るため）。
  const targetFactory = probeFixture.factories[0];
  const pdCapacityTons = targetFactory.pdCapacity as unknown as number;
  // 【校正】floorを大きくしすぎると、追加調達（applyPdDemandFloorが加算する
  // domesticPurchasePlan）の現金支出がpdMechanization投資自体の分割払いの
  // 現金を食いつぶし、投資そのものが完成しなくなる（=「機械化ON」のはずの
  // ケースで実際には機械化が有効化されない）ことを実測で確認した。0.05倍で
  // 投資が両ケースとも問題なく完成しつつ、PD稼働率を意図的に押し上げられる
  // 水準を採用する。
  const pdDemandFloor = new Map<string, number>([[targetFactory.factoryId, pdCapacityTons * 0.05]]);

  return {
    baseline: runFourCaseSimulationCase({ seed, newFactory: false, pdMechanization: false }),
    baselineDemandConstrained: runFourCaseSimulationCase({ seed, newFactory: false, pdMechanization: false, demandCapByMarketProduct: demandCap }),
    newFactoryDemandConstrained: runFourCaseSimulationCase({ seed, newFactory: true, pdMechanization: false, demandCapByMarketProduct: demandCap }),
    // 【比較Bのみ地平線を短縮する理由】このseed・シナリオでは、BALは投資の
    // 有無に関わらずturn7以降に原料調達（procurement）が需要へ追いつかなくなり
    // 原料不足が急拡大し始める（PD省人化投資・pd需要下限の注入とは無関係の、
    // 既存の原料調達バランスの既知の脆弱性。会社ラボ全体の既存の経済バランス
    // 課題であり、本Required fix 4の対象外）。PD省人化投資は稼働開始（提案から
    // 4四半期目）後、習熟ランプ（2四半期）を経て完全習熟に達するため、
    // 6四半期あれば「完全習熟後の稼働実績を含む、原料不足の急拡大が始まる前」
    // の安定した窓で両ケースを比較できる。
    pdMechanizationOff: runFourCaseSimulationCase({ seed, newFactory: false, pdMechanization: false, pdDesiredQuantityFloorByFactory: pdDemandFloor, horizonQuarters: 6 }),
    pdMechanizationOn: runFourCaseSimulationCase({ seed, newFactory: false, pdMechanization: true, pdDesiredQuantityFloorByFactory: pdDemandFloor, horizonQuarters: 6 }),
    both: runFourCaseSimulationCase({ seed, newFactory: true, pdMechanization: true }),
  };
}

// ---------------------------------------------------------------------
// PD省人化投資の「稼働率が高いほど効果が大きい」ことの感度分析（補助・純粋関数のみ）
//
// 上記のpdMechanizationOff/On（実シミュレーション比較）を主とし、こちらは
// capex/pdMechanization.tsの純粋関数（computeAdoptionRampProgress・
// computeMechanizationLevel・computeEffectivePdCoefficient）を直接呼び、
// 「同じ習熟進捗のもとで前四半期PD稼働率だけを変えると、実効PD係数・削減率が
// 単調に改善する」ことを、エンジンの計算式そのものに基づいて確認する
// （このモジュール自身が新たな計算式を作らない）補助的なチェックとして残す。
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

function printResultBlock(label: string, result: FourCaseSimulationResult): void {
  const f = result.finalQuarter;
  console.log(`--- ${label} ---`);
  console.log(`  累計純利益: ${fmtUsd(result.cumulativeNetIncomeUsd)}`);
  console.log(`  最終四半期純利益: ${fmtUsd(f.netIncomeUsd)}`);
  console.log(`  最終四半期現金: ${fmtUsd(f.cashUsd)}`);
  console.log(`  最終四半期設備稼働率: ${f.equipmentUtilizationRate !== null ? (f.equipmentUtilizationRate * 100).toFixed(1) + "%" : "－"}`);
  console.log(`  最終四半期労働稼働率: ${f.laborUtilizationRate !== null ? (f.laborUtilizationRate * 100).toFixed(1) + "%" : "－"}`);
  console.log(`  最終四半期常用Worker人数: ${f.regularHeadcount.toLocaleString("en-US")}人`);
  console.log(`  最終四半期PD生産量: ${f.pdProducedTons.toFixed(1)} t`);
  console.log(`  最終四半期完成品在庫: ${f.finishedGoodsInventoryTons.toFixed(1)} t`);
  console.log(`  最終四半期原料在庫: ${f.rawMaterialInventoryTons.toFixed(1)} t`);
  console.log(`  最終四半期残業費: ${fmtUsd(f.overtimeCostUsd)}`);
  console.log(`  最終四半期原料/設備/労働不足量: ${f.rawMaterialShortfallTons.toFixed(1)}/${f.equipmentShortfallTons.toFixed(1)}/${f.laborShortfallTons.toFixed(1)} t`);
  console.log(`  最終四半期capex保守費/減価償却費/支払額: ${fmtUsd(f.capexMaintenanceCostUsd)}/${fmtUsd(f.capexAssetsDepreciationUsd)}/${fmtUsd(f.capexTotalPaidUsd)}`);
  console.log("");
}

function printComparisonTable(table: FourCaseComparisonTable): void {
  console.log(`\n=== Test15 4ケース比較（会社=${FOCUS_COMPANY_ID}, 地平線=${SIMULATION_HORIZON_QUARTERS}四半期, 全ケース共通seed=${SINGLE_SEED}）===\n`);
  printResultBlock("参考: baseline（需要制約なし・投資なし）", table.baseline);
  printResultBlock("比較A-1: baselineDemandConstrained（需要制約あり・投資なし）", table.baselineDemandConstrained);
  printResultBlock("比較A-2: newFactoryDemandConstrained（需要制約あり・新工場建設のみ、A-1と同一需要上限）", table.newFactoryDemandConstrained);
  printResultBlock("比較B-1: pdMechanizationOff（高PD需要下・PD省人化投資なし）", table.pdMechanizationOff);
  printResultBlock("比較B-2: pdMechanizationOn（高PD需要下・PD省人化投資あり、B-1と同一高PD需要）", table.pdMechanizationOn);
  printResultBlock("参考: both（需要制約なし・新工場建設＋PD省人化投資の両方）", table.both);
  console.log(`基準PD係数: ${PD_MECHANIZATION_PARAMETERS_V1.baseCoefficient}`);

  console.log(`\n=== PD省人化投資: 稼働率感度分析（補助・純粋関数のみ。習熟完了後・quartersSinceActivation=${PD_MECHANIZATION_PARAMETERS_V1.adoptionRampQuarters}） ===\n`);
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
