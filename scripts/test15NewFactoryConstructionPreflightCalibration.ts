// ShrimpX V2 — Test15前 新工場建設 プリフライト校正（Phase6・診断専用スクリプト）
//
// 【本スクリプトの位置づけ（重要）】
//   これは診断専用スクリプトであり、ゲーム本体の共有デフォルトパラメータ
//   （production/parameters.ts・capex/parameters.ts・finance/parameters.ts等）を
//   一切変更しない。3つの環境（需要不足/均衡/能力制約）を作るための需要・輸入
//   倍率、新設Factoryへの手動ワーカー配置・生産計画注入は、すべてこの
//   スクリプト内のシナリオ構築（BAL固有の意思決定上書き）としてのみ存在し、
//   通常プレイの意思決定・初期状態には一切影響しない（他の4社・他の会社ラボ
//   呼び出し元は一切触れていない）。
//
// 【方法論】
//   同一会社(BAL)・同一初期状態・同一seed・同一市場条件のマッチドペア
//   （construction off/on）を、3つの環境で構築する。
//
//   環境の作り方（実測で確認済み・コード読解による裏付けあり）:
//     - 国内原料は5社共有の有限プール（rawMaterials/domesticPurchase.tsの
//       waterFillAllocate）に上限があり、需要だけを増やしても実測設備稼働率は
//       頭打ちになる（Phase5で確認済みの根本原因と同一）。
//     - 一方、輸入原料（rawMaterials/imports.ts）は原産国別に独立した上限
//       （originExportableSupply[country] × importAvailableSupplyRatio）を持つ、
//       既存の実在するゲーム内チャネルである。自動方針は輸入注文量を
//       requiredRawMaterial（≒国内需要）に比例させて生成する
//       （companyLab/autoPolicy.tsのbuildImportOrders）ため、需要倍率と同時に
//       輸入注文量も比例させれば、国内プールのボトルネックを回避しつつ
//       追加の原料を調達できる（実測で確認: 下記CALIBRATION PROBEの結果を
//       本ファイルのコメントに転記）。
//     - この「需要×輸入注文の比例スケーリング」を診断用シナリオ構築として
//       スクリプト内だけで行う（BAL固有の意思決定上書き。共有パラメータ・
//       他社には一切触れない）。
//
//   【校正探索の実測結果（seed=test15-newfactory-seed-1、6ターン、BALのみへ
//   demand×import倍率を適用、既存工場1つのみ・新設Factory提案なしの状態で
//   測定）】
//     倍率=1    equipUtil=20.2% laborUtil=70.4%  equipShortfall=0      rawShortfall=0
//     倍率=3.5  equipUtil=45.1% laborUtil=84.2%  equipShortfall=0      rawShortfall=0
//     倍率=5    equipUtil=60.4% laborUtil=87.7%  equipShortfall=15994  rawShortfall=0
//     倍率=7    equipUtil=72.7% laborUtil=100.0% equipShortfall=24555  rawShortfall=0
//     倍率=10   equipUtil=70.6% laborUtil=100.0% equipShortfall=41344  rawShortfall=0
//     倍率=15   equipUtil=45.5% laborUtil=100.0% equipShortfall=73381  rawShortfall=63371（輸入上限にも到達し崩壊）
//   → 倍率=1を環境1（需要不足・能力に余裕）、倍率=5を環境2（概ね均衡）、
//     倍率=7を環境3（能力制約・労働も同時に上限。原料は制約になっていない）
//     として採用する。倍率=7では原料は制約でない（rawShortfall=0）ため、
//     「能力（設備・労働）が制約であり原料は制約でない」という環境3の要件を
//     満たす。ただし労働も同時に100%へ達しているため、新設Factoryへワーカーを
//     追加しない限り、追加された設備能力を使い切れないことがそのまま実測される
//     （6-3の分析観点そのもの）。
//
//   各環境で3ケースを比較する（同一環境・同一seed内）:
//     off        : 新設Factory提案なし（現状ベースライン）。
//     on-unstaffed: turn1にnewFactoryConstructionを提案するのみ。稼働開始後も
//                   新設Factoryへワーカー・生産計画を一切追加しない
//                   （実装済みの仕様どおり、新設Factoryはゼロ人・ゼロ生産の
//                   まま。プレイヤーが「建てただけで放置した」場合の挙動を
//                   そのまま再現する）。
//     on-staffed : turn1に提案し、稼働開始後は新設Factoryへワーカー
//                   （常用1,500人・技能水準0.7・稼働可能率0.95、
//                   decisionDraft.tsの新設Factoryデフォルト値の規約と同じ
//                   技能・稼働可能率を使用）と、新設Factory標準能力ぶんの
//                   生産計画を手動で入力する（人間プレイヤーがDecisionEditor
//                   経由で入力するのと同じ操作をスクリプト内で再現）。
//
// 通常ゲーム条件（variant A・診断用現金付与なし）を基本とする。BAL初期現金
// $30,000,000は新工場$22,000,000の3分割払いに対し単独では十分だが、需要
// 倍率適用による原料買付・輸入コストの急増と両立できない場合に限り、
// 診断用感応度分析（variant B・off/on/両ケースへ同一の追加現金を付与）を
// 併用し、両方を明示的にラベル分けして報告する。

import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../app/lib/v2/companyLab/runner";
import { generateAutoPolicyDecision } from "../app/lib/v2/companyLab/autoPolicy";
import { CompanyDecisionInput, CompanyLabState, CompanyQuarterRecord } from "../app/lib/v2/companyLab/types";
import { CompanyId } from "../app/lib/v2/sales/types";
import { Product } from "../app/lib/v2/market/types";
import { extractCompanyFinancialResult } from "../app/v2/company-lab/play/_lib/financialViewSelectors";
import { buildNewFactoryId, computeEffectiveFactories } from "../app/lib/v2/capex/factoryConstruction";
import { CAPEX_PARAMETERS_V1 } from "../app/lib/v2/capex/parameters";
import { WorkerAssignment, CompanyProductionPlanEntry, FactoryLoadMetrics } from "../app/lib/v2/production/types";
import { calculateLaborCapacityFromAssignedHeadcount } from "../app/lib/v2/production/labor";
import { PRODUCTION_PARAMETERS_V1 } from "../app/lib/v2/production/parameters";
import { hosoEqTons, ratio, unwrapUnit } from "../app/lib/v2/core/units";
import { usd } from "../app/lib/v2/finance/types";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const FOCUS_COMPANY_ID = "BAL";
const HORIZON_QUARTERS = 16; // 提案(turn1)を含め16ターン（構築3Q+準備1Q後、少なくとも12Q追跡できる）
const SEED = "test15-newfactory-seed-1";

/** 【診断用のみ】新設Factoryへ手動配置する常用ワーカー人数。BAL-F1自身のワーカー密度
 * （6,000人 ÷ commonProcessing能力22,000トン ≈ 0.273人/トン）よりは控えめな
 * 水準（現金負担・現実的な採用ペースを考慮した診断用の仮定値）。 */
const STAFFED_NEW_FACTORY_REGULAR_HEADCOUNT = 1500;
const NEW_FACTORY_DEFAULT_SKILL_LEVEL = 0.7; // decisionDraft.tsの新設Factoryデフォルトと同じ規約
const NEW_FACTORY_DEFAULT_ATTENDANCE_RATE = 0.95;

// 【診断用のみ】自動方針は営業キャッシュフローを使い切る設計であり
// （companyLab/__tests__/test15NewFactoryDecisionInput.test.tsの既存コメント
// 参照）、16四半期という長い追跡期間では建設の有無に関わらず現金が枯渇に
// 向かう。8四半期規模だったPhase5より長い horizon・需要倍率適用による調達
// コスト増も加わるため、Phase5のDIAGNOSTIC_CASH_GRANT_USD($20,000,000)では
// 新工場建設の3四半期分割払いが完了しない（実測で確認済み）。本スクリプトの
// 診断用感応度分析では、off/on両ケースへ完全に同一額・同一タイミング
// （turn1開始前）で付与する（投資の有無以外の条件は依然として揃っている）。
const DIAGNOSTIC_CASH_GRANT_USD = 400_000_000;

export type EnvironmentId = "env1-slack" | "env2-balanced" | "env3-constrained";

export interface EnvironmentDefinition {
  readonly id: EnvironmentId;
  readonly label: string;
  readonly demandImportMultiplier: number;
}

export const ENVIRONMENTS: readonly EnvironmentDefinition[] = [
  { id: "env1-slack", label: "環境1: 需要不足・既存能力に余裕", demandImportMultiplier: 1 },
  { id: "env2-balanced", label: "環境2: 既存能力と需要が概ね均衡", demandImportMultiplier: 5 },
  { id: "env3-constrained", label: "環境3: 能力制約・販売機会を逸失中", demandImportMultiplier: 7 },
];

export type ConstructionCase = "off" | "on-unstaffed" | "on-staffed";

// ---------------------------------------------------------------------
// 1. 診断用シナリオ構築ヘルパー（このスクリプト内だけで完結。共有デフォルトへは書き込まない）
// ---------------------------------------------------------------------

/** BALの意思決定について、需要（sales/production/domesticPurchase）と輸入注文を同一倍率でスケールする。 */
function applyDemandAndImportMultiplier(decision: CompanyDecisionInput, multiplier: number): CompanyDecisionInput {
  if (multiplier === 1) return decision;
  const scaleQty = <T extends { readonly desiredQuantity: unknown }>(p: T): T => ({
    ...p,
    desiredQuantity: ((p.desiredQuantity as unknown as number) * multiplier) as unknown as T["desiredQuantity"],
  });
  return {
    ...decision,
    salesPlans: decision.salesPlans.map((p) => scaleQty(p)),
    productionPlans: decision.productionPlans.map((p) => scaleQty(p)),
    domesticPurchasePlan: {
      ...decision.domesticPurchasePlan,
      desiredQuantity: ((decision.domesticPurchasePlan.desiredQuantity as unknown as number) * multiplier) as unknown as typeof decision.domesticPurchasePlan.desiredQuantity,
    },
    importOrders: decision.importOrders.map((o) => ({
      ...o,
      orderedQuantity: ((o.orderedQuantity as unknown as number) * multiplier) as unknown as typeof o.orderedQuantity,
    })),
  };
}

/** BALの当期首現金へ、診断用の追加流動性を一括加算した新しいCompanyLabStateを返す（純関数、副作用なし）。 */
function applyDiagnosticCashGrant(state: CompanyLabState, companyId: string, amountUsd: number): CompanyLabState {
  if (amountUsd === 0) return state;
  return {
    ...state,
    financeState: {
      ...state.financeState,
      companies: state.financeState.companies.map((c) =>
        c.companyId === companyId ? { ...c, cash: usd((c.cash as unknown as number) + amountUsd) } : c
      ),
    },
  };
}

/**
 * 稼働開始済みの新設Factoryへ、常用ワーカー・新設Factory標準能力ぶんの生産計画を
 * 手動で追加する（人間プレイヤーがDecisionEditor経由で入力する操作を再現）。
 * 既存Factoryの行には一切触れない。
 */
function injectStaffedNewFactoryDecision(
  decision: CompanyDecisionInput,
  companyId: string,
  newFactoryId: string,
  capacityByProduct: Readonly<Record<Product, number>>
): CompanyDecisionInput {
  const skills = (["hoso", "pd", "vap"] as const).map((product) => ({ product, skillLevel: ratio(NEW_FACTORY_DEFAULT_SKILL_LEVEL) }));
  const workerAssignment: WorkerAssignment = {
    factoryId: newFactoryId,
    companyId: companyId as CompanyId,
    regularHeadcount: STAFFED_NEW_FACTORY_REGULAR_HEADCOUNT,
    temporaryHeadcount: 0,
    skills,
    overtimeRate: ratio(0),
    attendanceRate: ratio(NEW_FACTORY_DEFAULT_ATTENDANCE_RATE),
  };
  const workerAssignments = [...decision.workerAssignments.filter((w) => w.factoryId !== newFactoryId), workerAssignment];

  // 【診断用・過大投入の防止】desiredQuantityを新設Factoryの定格能力そのままにすると、
  // 配置したワーカー(1,500人)だけでは到底処理しきれない量の原料購入・生産計画を
  // 会社全体へ発生させてしまい、既存Factoryの原料配分を不当に圧迫する（実測で
  // 確認: 定格能力そのまま投入した初回の試行では純利益差が非現実的に悪化した）。
  // production/labor.tsのcalculateLaborCapacityFromAssignedHeadcount（唯一の
  // 労働能力算出式）で、実際に配置した人数で処理しきれる量まで desiredQuantity を
  // 抑える（人間プレイヤーが「配置人数に見合った生産計画を入力する」のと同じ判断）。
  const newProductionRows: CompanyProductionPlanEntry[] = (["hoso", "pd", "vap"] as const)
    .filter((product) => capacityByProduct[product] > 0)
    .map((product, index) => {
      const maxOutputForHeadcount = calculateLaborCapacityFromAssignedHeadcount(
        STAFFED_NEW_FACTORY_REGULAR_HEADCOUNT,
        0,
        NEW_FACTORY_DEFAULT_ATTENDANCE_RATE,
        NEW_FACTORY_DEFAULT_SKILL_LEVEL,
        0,
        capacityByProduct[product],
        PRODUCTION_PARAMETERS_V1,
        product
      );
      return {
        companyId: companyId as CompanyId,
        factoryId: newFactoryId,
        product,
        desiredQuantity: hosoEqTons(Math.min(capacityByProduct[product], maxOutputForHeadcount)),
        priority: index + 1,
      };
    });
  const productionPlans = [...decision.productionPlans.filter((p) => p.factoryId !== newFactoryId), ...newProductionRows];

  return { ...decision, workerAssignments, productionPlans };
}

// ---------------------------------------------------------------------
// 2. 1ケースぶんのシミュレーション（実エンジンを通す。並行計算式を作らない）
// ---------------------------------------------------------------------

export interface QuarterMetricsRow {
  readonly environment: EnvironmentId;
  readonly caseType: ConstructionCase;
  readonly seed: string;
  readonly companyId: string;
  readonly quarter: number;
  readonly period: string;
  readonly diagnosticCashGrantUsd: number;
  readonly newFactoryId: string | null;
  readonly newFactoryOperational: boolean;
  readonly newFactoryProjectStatus: string | null;
  readonly newFactoryProposedPeriod: string | null;
  readonly newFactoryCompletedPeriod: string | null;
  readonly companyEquipmentUtilizationRate: number;
  readonly companyLaborUtilizationRate: number;
  readonly companyRawMaterialShortfallTons: number;
  readonly companyEquipmentShortfallTons: number;
  readonly companyLaborShortfallTons: number;
  readonly hosoProducedTons: number;
  readonly pdProducedTons: number;
  readonly vapProducedTons: number;
  readonly newContractedQuantityTons: number;
  readonly salesDesiredQuantityTons: number;
  readonly newFactoryEquipUtilizationRate: number | null;
  readonly newFactoryLaborUtilizationRate: number | null;
  readonly newFactoryProducedTons: number | null;
  readonly newFactoryRegularHeadcount: number;
  readonly newFactoryRequiredWorkersApprox: number | null;
  readonly capexPaymentUsd: number;
  readonly capexMaintenanceCostUsd: number;
  readonly capexDepreciationUsd: number;
  readonly sellingGeneralAdminUsd: number;
  readonly operatingIncomeUsd: number;
  readonly netIncomeUsd: number;
  readonly cashUsd: number;
  readonly borrowingUsd: number;
  readonly insolvent: boolean;
}

export interface CaseRunOptions {
  readonly environment: EnvironmentDefinition;
  readonly caseType: ConstructionCase;
  readonly seed: string;
  readonly horizonQuarters: number;
  readonly diagnosticCashGrantUsd: number;
}

export function runCase(options: CaseRunOptions): readonly QuarterMetricsRow[] {
  const config = { scenarioId: "baseline" as const, mode: "canonical" as const, seed: options.seed, turns: options.horizonQuarters };
  const { state: initialState, fixtures } = initializeCompanyLab(config);
  const focusFixture = fixtures.find((f) => f.companyId === FOCUS_COMPANY_ID)!;
  const constructOn = options.caseType !== "off";

  let state: CompanyLabState = applyDiagnosticCashGrant(initialState, FOCUS_COMPANY_ID, options.diagnosticCashGrantUsd);
  const rows: QuarterMetricsRow[] = [];
  let newFactoryId: string | undefined;
  const newFactoryStandardCapacity = CAPEX_PARAMETERS_V1.templatesByType.newFactoryConstruction.newFactoryEffect!.fullCapacities;

  for (let turn = 0; turn < options.horizonQuarters; turn++) {
    if (state.isComplete) break;
    const publicInfo = buildPublicMarketInfo(state);
    const decisions: Record<CompanyId, CompanyDecisionInput> = {};
    const ownStateBAL = buildCompanyOwnState(state, focusFixture);
    for (const f of fixtures) {
      const ownState = buildCompanyOwnState(state, f);
      let decision = generateAutoPolicyDecision(f, ownState, publicInfo, state.currentPeriod, state.scenarioState.currentTurn);
      if (f.companyId === FOCUS_COMPANY_ID) {
        decision = applyDemandAndImportMultiplier(decision, options.environment.demandImportMultiplier);
        if (turn === 0 && constructOn) {
          decision = {
            ...decision,
            capexDecision: {
              ...decision.capexDecision,
              newProjectProposals: [...decision.capexDecision.newProjectProposals, { projectType: "newFactoryConstruction" as const }],
            },
          };
        }
        const suspendedProjectIds = ownStateBAL.capexState.portfolio.projects.filter((p) => p.status === "suspended").map((p) => p.projectId);
        if (suspendedProjectIds.length > 0) {
          decision = {
            ...decision,
            capexDecision: { ...decision.capexDecision, resumeRequests: suspendedProjectIds.map((projectId) => ({ projectId })) },
          };
        }
        if (options.caseType === "on-staffed" && newFactoryId && ownStateBAL.effectiveFactories.some((ef) => ef.factoryId === newFactoryId)) {
          decision = injectStaffedNewFactoryDecision(decision, FOCUS_COMPANY_ID, newFactoryId, {
            hoso: newFactoryStandardCapacity.hoso,
            pd: newFactoryStandardCapacity.pd,
            vap: newFactoryStandardCapacity.vap,
          });
        }
      }
      decisions[f.companyId] = decision;
    }

    const nextState = advanceCompanyLabQuarter(state, fixtures, decisions);
    const record: CompanyQuarterRecord = nextState.history[nextState.history.length - 1];
    const financial = extractCompanyFinancialResult(record, FOCUS_COMPANY_ID);
    const capexResult = record.capexResults.find((c) => c.companyId === FOCUS_COMPANY_ID) ?? null;
    const summary = record.companySummaries.find((s) => s.companyId === FOCUS_COMPANY_ID)!;

    if (constructOn && !newFactoryId) {
      const companyCapex = nextState.capexState.companies.find((c) => c.companyId === FOCUS_COMPANY_ID);
      const project = companyCapex?.portfolio.projects.find((p) => p.projectType === "newFactoryConstruction");
      if (project) newFactoryId = buildNewFactoryId(project);
    }

    const companyCapexAfter = nextState.capexState.companies.find((c) => c.companyId === FOCUS_COMPANY_ID);
    const nfProject = newFactoryId ? companyCapexAfter?.portfolio.projects.find((p) => buildNewFactoryId(p) === newFactoryId) : undefined;

    const effectiveFactoriesAfter = computeEffectiveFactories(fixtures.flatMap((f) => f.factories), nextState.capexState, nextState.currentPeriod);
    const newFactoryOperational = !!(newFactoryId && effectiveFactoriesAfter.some((ef) => ef.factoryId === newFactoryId));

    let newFactoryLoad: FactoryLoadMetrics | undefined;
    let newFactoryProducedTons: number | null = null;
    let newFactoryRegularHeadcount = 0;
    if (newFactoryOperational && newFactoryId) {
      newFactoryLoad = record.factoryLoadMetrics.find((m) => m.factoryId === newFactoryId && m.companyId === FOCUS_COMPANY_ID);
      newFactoryProducedTons = record.batches
        .filter((b) => b.factoryId === newFactoryId && b.companyId === FOCUS_COMPANY_ID)
        .reduce((sum, b) => sum + unwrapUnit(b.finishedGoodsQuantity), 0);
      const wa = decisions[FOCUS_COMPANY_ID].workerAssignments.find((w) => w.factoryId === newFactoryId);
      newFactoryRegularHeadcount = wa ? wa.regularHeadcount : 0;
    }

    const salesDesiredQuantityTons = decisions[FOCUS_COMPANY_ID].salesPlans.reduce((s, p) => s + unwrapUnit(p.desiredQuantity), 0);

    rows.push({
      environment: options.environment.id,
      caseType: options.caseType,
      seed: options.seed,
      companyId: FOCUS_COMPANY_ID,
      quarter: record.turn,
      period: record.period,
      diagnosticCashGrantUsd: options.diagnosticCashGrantUsd,
      newFactoryId: newFactoryId ?? null,
      newFactoryOperational,
      newFactoryProjectStatus: nfProject ? nfProject.status : null,
      newFactoryProposedPeriod: nfProject ? nfProject.proposedPeriod : null,
      newFactoryCompletedPeriod: nfProject?.completedPeriod ?? null,
      companyEquipmentUtilizationRate: unwrapUnit(summary.equipmentUtilizationRate),
      companyLaborUtilizationRate: unwrapUnit(summary.laborUtilizationRate),
      companyRawMaterialShortfallTons: unwrapUnit(summary.rawMaterialShortfall),
      companyEquipmentShortfallTons: unwrapUnit(summary.equipmentShortfall),
      companyLaborShortfallTons: unwrapUnit(summary.laborShortfall),
      hosoProducedTons: unwrapUnit(summary.hosoProduced),
      pdProducedTons: unwrapUnit(summary.pdProduced),
      vapProducedTons: unwrapUnit(summary.vapProduced),
      newContractedQuantityTons: unwrapUnit(summary.newContractedQuantity),
      salesDesiredQuantityTons,
      newFactoryEquipUtilizationRate: newFactoryLoad ? unwrapUnit(newFactoryLoad.equipmentUtilizationRate) : null,
      newFactoryLaborUtilizationRate: newFactoryLoad ? unwrapUnit(newFactoryLoad.laborUtilizationRate) : null,
      newFactoryProducedTons,
      newFactoryRegularHeadcount,
      newFactoryRequiredWorkersApprox: options.caseType === "on-staffed" && newFactoryOperational ? STAFFED_NEW_FACTORY_REGULAR_HEADCOUNT : null,
      capexPaymentUsd: capexResult ? capexResult.totalPaidThisQuarterUsd : 0,
      capexMaintenanceCostUsd: capexResult ? capexResult.capexMaintenanceCostUsd : 0,
      capexDepreciationUsd: capexResult ? capexResult.capexAssetsDepreciationUsd : 0,
      sellingGeneralAdminUsd: financial ? (financial.profitAndLoss.sellingGeneralAdmin as unknown as number) : 0,
      operatingIncomeUsd: financial ? (financial.profitAndLoss.operatingProfit as unknown as number) : 0,
      netIncomeUsd: financial ? (financial.profitAndLoss.netIncome as unknown as number) : 0,
      cashUsd: financial ? (financial.balanceSheet.cash as unknown as number) : 0,
      borrowingUsd: financial
        ? (financial.balanceSheet.shortTermLoans as unknown as number) + (financial.balanceSheet.longTermLoans as unknown as number)
        : 0,
      insolvent: financial ? financial.negativeEquity || financial.cashShortfall : false,
    });
    state = nextState;
  }

  return rows;
}

// ---------------------------------------------------------------------
// 3. 全体オーケストレーション
// ---------------------------------------------------------------------

export interface EnvironmentResult {
  readonly environment: EnvironmentDefinition;
  readonly diagnosticCashGrantUsd: number;
  readonly variant: "A" | "B";
  readonly rowsOff: readonly QuarterMetricsRow[];
  readonly rowsOnUnstaffed: readonly QuarterMetricsRow[];
  readonly rowsOnStaffed: readonly QuarterMetricsRow[];
}

function cumulativeNetIncome(rows: readonly QuarterMetricsRow[]): number {
  return rows.reduce((s, r) => s + r.netIncomeUsd, 0);
}

/** offケースが着工しない前提でnewFactory系列を持たないため、on側だけの完成有無を見て
 * variant A（現金付与なし）で構築が完了するかを確認し、完了しない場合はvariant Bへ切り替える。 */
function determineVariantForEnvironment(env: EnvironmentDefinition): "A" | "B" {
  const probeRows = runCase({ environment: env, caseType: "on-unstaffed", seed: SEED, horizonQuarters: HORIZON_QUARTERS, diagnosticCashGrantUsd: 0 });
  const completed = probeRows.some((r) => r.newFactoryProjectStatus === "completed" || r.newFactoryOperational);
  return completed ? "A" : "B";
}

export function runFullStudy(): readonly EnvironmentResult[] {
  const results: EnvironmentResult[] = [];
  for (const env of ENVIRONMENTS) {
    const variant = determineVariantForEnvironment(env);
    const cashGrant = variant === "A" ? 0 : DIAGNOSTIC_CASH_GRANT_USD;

    const rowsOff = runCase({ environment: env, caseType: "off", seed: SEED, horizonQuarters: HORIZON_QUARTERS, diagnosticCashGrantUsd: cashGrant });
    const rowsOnUnstaffed = runCase({ environment: env, caseType: "on-unstaffed", seed: SEED, horizonQuarters: HORIZON_QUARTERS, diagnosticCashGrantUsd: cashGrant });
    const rowsOnStaffed = runCase({ environment: env, caseType: "on-staffed", seed: SEED, horizonQuarters: HORIZON_QUARTERS, diagnosticCashGrantUsd: cashGrant });

    results.push({ environment: env, diagnosticCashGrantUsd: cashGrant, variant, rowsOff, rowsOnUnstaffed, rowsOnStaffed });
  }
  return results;
}

// ---------------------------------------------------------------------
// 4. CSV/JSON出力
// ---------------------------------------------------------------------

const CSV_COLUMNS: readonly (keyof QuarterMetricsRow)[] = [
  "environment",
  "caseType",
  "seed",
  "companyId",
  "quarter",
  "period",
  "diagnosticCashGrantUsd",
  "newFactoryId",
  "newFactoryOperational",
  "newFactoryProjectStatus",
  "newFactoryProposedPeriod",
  "newFactoryCompletedPeriod",
  "companyEquipmentUtilizationRate",
  "companyLaborUtilizationRate",
  "companyRawMaterialShortfallTons",
  "companyEquipmentShortfallTons",
  "companyLaborShortfallTons",
  "hosoProducedTons",
  "pdProducedTons",
  "vapProducedTons",
  "newContractedQuantityTons",
  "salesDesiredQuantityTons",
  "newFactoryEquipUtilizationRate",
  "newFactoryLaborUtilizationRate",
  "newFactoryProducedTons",
  "newFactoryRegularHeadcount",
  "newFactoryRequiredWorkersApprox",
  "capexPaymentUsd",
  "capexMaintenanceCostUsd",
  "capexDepreciationUsd",
  "sellingGeneralAdminUsd",
  "operatingIncomeUsd",
  "netIncomeUsd",
  "cashUsd",
  "borrowingUsd",
  "insolvent",
];

export function toCsv(rows: readonly QuarterMetricsRow[]): string {
  const header = CSV_COLUMNS.join(",");
  const lines = rows.map((r) => CSV_COLUMNS.map((c) => String(r[c])).join(","));
  return [header, ...lines].join("\n");
}

export function writeStudyOutputs(results: readonly EnvironmentResult[], outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  const allRows: QuarterMetricsRow[] = results.flatMap((r) => [...r.rowsOff, ...r.rowsOnUnstaffed, ...r.rowsOnStaffed]);
  writeFileSync(join(outDir, "test15-new-factory-preflight.csv"), toCsv(allRows), "utf8");
  writeFileSync(
    join(outDir, "test15-new-factory-preflight.json"),
    JSON.stringify(
      {
        seed: SEED,
        environments: ENVIRONMENTS,
        results: results.map((r) => ({
          environment: r.environment.id,
          variant: r.variant,
          diagnosticCashGrantUsd: r.diagnosticCashGrantUsd,
          cumulativeNetIncomeOff: cumulativeNetIncome(r.rowsOff),
          cumulativeNetIncomeOnUnstaffed: cumulativeNetIncome(r.rowsOnUnstaffed),
          cumulativeNetIncomeOnStaffed: cumulativeNetIncome(r.rowsOnStaffed),
        })),
      },
      null,
      2
    ),
    "utf8"
  );
}

// ---------------------------------------------------------------------
// 5. CLIエントリポイント
// ---------------------------------------------------------------------

function fmtUsd(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

function printStudySummary(results: readonly EnvironmentResult[]): void {
  console.log("\n=== Test15前 新工場建設プリフライト校正（マッチドペア研究） ===\n");
  for (const r of results) {
    const label = r.variant === "A" ? "A(通常ゲーム条件)" : `B(診断用感応度分析・現金付与${fmtUsd(r.diagnosticCashGrantUsd)})`;
    console.log(`--- ${r.environment.label} [seed=${SEED}] ${label} ---`);

    const cumOff = cumulativeNetIncome(r.rowsOff);
    const cumOnU = cumulativeNetIncome(r.rowsOnUnstaffed);
    const cumOnS = cumulativeNetIncome(r.rowsOnStaffed);
    console.log(`  累計純利益: off=${fmtUsd(cumOff)} on-unstaffed=${fmtUsd(cumOnU)}(差=${fmtUsd(cumOnU - cumOff)}) on-staffed=${fmtUsd(cumOnS)}(差=${fmtUsd(cumOnS - cumOff)})`);

    const finalOff = r.rowsOff[r.rowsOff.length - 1];
    const finalOnU = r.rowsOnUnstaffed[r.rowsOnUnstaffed.length - 1];
    const finalOnS = r.rowsOnStaffed[r.rowsOnStaffed.length - 1];
    console.log(`  最終現金: off=${fmtUsd(finalOff?.cashUsd ?? 0)} on-unstaffed=${fmtUsd(finalOnU?.cashUsd ?? 0)} on-staffed=${fmtUsd(finalOnS?.cashUsd ?? 0)}`);
    console.log(`  insolvent(最終期): off=${finalOff?.insolvent} on-unstaffed=${finalOnU?.insolvent} on-staffed=${finalOnS?.insolvent}`);

    const opRow = r.rowsOnUnstaffed.find((row) => row.newFactoryOperational);
    console.log(`  新設Factory稼働開始四半期: ${opRow ? opRow.quarter : "未稼働"}`);
    if (opRow) {
      const opRowsUnstaffed = r.rowsOnUnstaffed.filter((row) => row.newFactoryOperational);
      const opRowsStaffed = r.rowsOnStaffed.filter((row) => row.newFactoryOperational);
      const avgEquipUnstaffed = opRowsUnstaffed.reduce((s, row) => s + (row.newFactoryEquipUtilizationRate ?? 0), 0) / Math.max(1, opRowsUnstaffed.length);
      const avgEquipStaffed = opRowsStaffed.reduce((s, row) => s + (row.newFactoryEquipUtilizationRate ?? 0), 0) / Math.max(1, opRowsStaffed.length);
      console.log(`  新設Factory設備稼働率（稼働開始後平均）: on-unstaffed=${(avgEquipUnstaffed * 100).toFixed(1)}% on-staffed=${(avgEquipStaffed * 100).toFixed(1)}%`);
      console.log(`  会社全体equipmentShortfall（稼働開始後平均トン）: off=${(r.rowsOff.filter((row) => row.quarter >= opRow.quarter).reduce((s, row) => s + row.companyEquipmentShortfallTons, 0) / Math.max(1, r.rowsOff.filter((row) => row.quarter >= opRow.quarter).length)).toFixed(0)} on-staffed=${(opRowsStaffed.reduce((s, row) => s + row.companyEquipmentShortfallTons, 0) / Math.max(1, opRowsStaffed.length)).toFixed(0)}`);
    }
  }
}

if (require.main === module) {
  const results = runFullStudy();
  printStudySummary(results);
  const outDir = join(__dirname, "..", "artifacts", "test15", "preflight-calibration");
  writeStudyOutputs(results, outDir);
  console.log(`\nCSV/JSON出力: ${outDir}/test15-new-factory-preflight.csv / .json`);
}
