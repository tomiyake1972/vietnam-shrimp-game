// ShrimpX V2 — Phase SAI-1.5: 原因分解テスト専用ハーネス（Test B「同一初期条件」）
//
// 【重要】これはテスト専用の比較runnerであり、本番のCompanyLab初期化
// （companyLab/runner.ts の initializeCompanyLab）を一切変更しない。
// 三宅さんの指示（§7 Test B）どおり「完全同一化に大規模変更が必要な場合は、
// 無理に本番fixtureを変更せず、テスト専用fixtureまたは比較runnerで実施する」を
// 踏襲し、既に公開されている初期化用の部品関数（buildCompanyFixtures・
// buildInitialCompanyFinancingState・buildInitialCompanyCapexState・
// buildInitialWorkforceState・initializeQualityReliabilityState・
// buildInitialConsumerMarketCarryStateTable・initializeScenario・
// getScenarioTurnInput・buildPreviousMarketContext・toMarketQuarterInput・
// initializeProductionState）だけを組み合わせて、5社のfixture・初期財務・
// 初期契約を「1社のテンプレートを会社IDだけ差し替えて複製したもの」に
// 揃えた初期状態を構築する。
//
// 【finance/initialState.tsのbuildInitialCompanyFinanceStateを直接使わない理由】
// この関数は内部でINITIAL_FINANCE_FIXTURES_V1を「渡されたcompanyIdそのもの」で
// 検索する（finance/initialState.ts:82）。Test Bでは「原料ロットは各社固有の
// companyIdでタグ付けされたまま（生産・調達ロジックが会社IDでロットを識別する
// ため、ここは変えられない）、財務の絶対値だけをテンプレート会社のものに揃える」
// 必要があるため、同じ計算式（総資産-総負債-資本金=利益剰余金の残差決定）を
// テンプレートのInitialFinanceFixtureを直接引数に取る形で再実装する
// （buildUnifiedFinanceState）。ロジック自体はfinance/initialState.tsと完全に同じ。

import { PeriodV2, previousPeriod, parsePeriod } from "../../../core/period";
import { hosoEqTons, ratio, usdPerHosoEqKg } from "../../../core/units";
import { CompanyId } from "../../../sales/types";
import { RawMaterialLot } from "../../../rawMaterials/types";
import {
  CompanyFinanceState,
  ReceivableRecord,
  nonNegativeUsd,
  usd,
} from "../../../finance/types";
import { INITIAL_FINANCE_FIXTURES_V1, InitialFinanceFixture, rawMaterialInventoryValueUsd } from "../../../finance/initialState";
import { buildInitialCompanyFinancingState } from "../../../financing/initialPortfolio";
import { buildInitialCompanyCapexState } from "../../../capex/capexClose";
import { initializeQualityReliabilityState } from "../../../quality/stateUpdate";
import { buildInitialConsumerMarketCarryStateTable } from "../../../market/consumerInventory";
import { initializeScenario, getScenarioTurnInput } from "../../../scenario/scenarioEngine";
import { toMarketQuarterInput } from "../../../scenario/marketAdapter";
import { initializeProductionState } from "../../../production/runner";
import { generateInitialContracts } from "../../initialContracts";
import { SalesContract } from "../../../sales/types";
import { buildCompanyFixtures } from "../../fixtures";
import {
  CompanyLabConfig,
  CompanyLabState,
  CompanyDecisionInput,
  CompanyFixture,
  CompanyOwnState,
  PublicMarketInfo,
} from "../../types";
import {
  CompanyLabInitResult,
  findScenarioDefinitionForCompanyLab,
  buildPreviousMarketContext,
  buildPublicMarketInfo,
  buildCompanyOwnState,
  advanceCompanyLabQuarter,
} from "../../runner";
import { buildInitialWorkforceState } from "../../workforce";

export const ALL_COMPANY_IDS: readonly CompanyId[] = ["BAL", "MASS", "JPQ", "VAP", "CONSV"];

function cloneFixtureForCompany(template: CompanyFixture, targetCompanyId: CompanyId): CompanyFixture {
  return {
    ...template,
    companyId: targetCompanyId,
    displayName: `[Test B 統一版] ${targetCompanyId}（テンプレート: ${template.companyId}）`,
    factories: template.factories.map((f) => ({
      ...f,
      factoryId: `${targetCompanyId}-UNIFIED-F1`,
      companyId: targetCompanyId,
    })),
    workerBaseline: template.workerBaseline.map((w) => ({
      ...w,
      factoryId: `${targetCompanyId}-UNIFIED-F1`,
      companyId: targetCompanyId,
    })),
    initialRawMaterialLots: template.initialRawMaterialLots.map(
      (lot, i): RawMaterialLot => ({
        ...lot,
        lotId: `${targetCompanyId}-UNIFIED-RM-INIT-${i}`,
        companyId: targetCompanyId,
      })
    ),
  };
}

/** テンプレート会社1社の値へ、5社の非会社ID項目を揃えたfixture一覧を作る。
 *  `order`（既定はALL_COMPANY_IDSの並び）は、原因分解Test B-order（§三宅さん指示1）で
 *  「fixtures配列内の処理順」そのものが結果に影響するかどうかを確認するために
 *  差し替え可能にしてある。順序を変えても各会社の非会社ID項目（fixture値）自体は
 *  一切変わらない（cloneFixtureForCompanyは常にtemplateの値をそのcompanyIdへ複製する
 *  だけで、orderはあくまで返す配列内の並び順にしか影響しない）。 */
export function buildUnifiedFixtures(startPeriod: PeriodV2, templateCompanyId: CompanyId, order: readonly CompanyId[] = ALL_COMPANY_IDS): readonly CompanyFixture[] {
  const templates = buildCompanyFixtures(startPeriod);
  const template = templates.find((f) => f.companyId === templateCompanyId);
  if (!template) throw new Error(`テンプレート会社IDが見つかりません: ${templateCompanyId}`);
  return order.map((id) => cloneFixtureForCompany(template, id));
}

/** finance/initialState.tsのbuildInitialCompanyFinanceStateと同じ計算式を、
 *  テンプレートのInitialFinanceFixtureを直接引数に取る形で再実装したもの
 *  （Test B専用。本番の会社別ハードコード検索を経由しない）。 */
function buildUnifiedFinanceState(companyId: CompanyId, rawMaterialLots: readonly RawMaterialLot[], startPeriod: PeriodV2, templateFixture: InitialFinanceFixture): CompanyFinanceState {
  const rawMaterialInventory = rawMaterialInventoryValueUsd(rawMaterialLots, companyId);
  const totalAssets = templateFixture.cash + templateFixture.initialAccountsReceivable + rawMaterialInventory + templateFixture.otherCurrentAssets + templateFixture.fixedAssetsGross;
  const totalLiabilities = templateFixture.shortTermLoans + templateFixture.longTermLoans + templateFixture.otherLiabilities;
  const retainedEarnings = totalAssets - totalLiabilities - templateFixture.capitalStock;
  const initialReceivables: ReceivableRecord[] =
    templateFixture.initialAccountsReceivable > 0
      ? [
          {
            id: `${companyId}-AR-initial-unified`,
            companyId,
            market: "OTHER",
            amount: nonNegativeUsd(templateFixture.initialAccountsReceivable, "初期売掛金（Test B統一）"),
            originPeriod: startPeriod,
            dueSettlementPeriod: startPeriod,
            sourceRef: "initial:unified-test-harness",
          },
        ]
      : [];
  return {
    companyId,
    cash: usd(templateFixture.cash),
    receivables: initialReceivables,
    payables: [],
    otherCurrentAssets: nonNegativeUsd(templateFixture.otherCurrentAssets, "その他流動資産（Test B統一）"),
    fixedAssetsGross: nonNegativeUsd(templateFixture.fixedAssetsGross, "固定資産（Test B統一）"),
    accumulatedDepreciation: nonNegativeUsd(0, "減価償却累計額"),
    shortTermLoans: nonNegativeUsd(templateFixture.shortTermLoans, "短期借入金（Test B統一）"),
    longTermLoans: nonNegativeUsd(templateFixture.longTermLoans, "長期借入金（Test B統一）"),
    otherLiabilities: nonNegativeUsd(templateFixture.otherLiabilities, "その他負債（Test B統一）"),
    capitalStock: nonNegativeUsd(templateFixture.capitalStock, "資本金（Test B統一）"),
    retainedEarnings: usd(retainedEarnings),
    finishedGoodsCostLedger: [],
  };
}

function buildUnifiedContracts(startPeriod: PeriodV2, templateCompanyId: CompanyId, order: readonly CompanyId[]): SalesContract[] {
  const templateContracts = generateInitialContracts(startPeriod).filter((c) => c.companyId === templateCompanyId);
  const out: SalesContract[] = [];
  for (const id of order) {
    templateContracts.forEach((c, i) => {
      out.push({ ...c, contractId: `${c.contractId}-UNIFIED-${id}-${i}`, companyId: id });
    });
  }
  return out;
}

/** initializeCompanyLabと同じ手順を、5社の非会社ID項目をtemplateCompanyIdへ
 *  統一したfixture・財務・契約で組み立てる（Test B専用）。
 *  `order`（§三宅さん指示1「Test B-order」用）は5社をfixtures配列・契約配列・
 *  会社別financeState配列へ並べる順序。既定はALL_COMPANY_IDSの並び
 *  （BAL, MASS, JPQ, VAP, CONSV）で、逆順・巡回シフトを渡すことで
 *  「配列内の処理順そのもの」が結果に影響するかどうかを検証できる。 */
export function initializeUnifiedCompanyLab(config: CompanyLabConfig, templateCompanyId: CompanyId, order: readonly CompanyId[] = ALL_COMPANY_IDS): CompanyLabInitResult {
  const definition = findScenarioDefinitionForCompanyLab(config.scenarioId);
  const scenarioState = initializeScenario(definition, config.mode, config.seed);
  const startPeriod = getScenarioTurnInput(scenarioState, 1).period;
  const fixtures = buildUnifiedFixtures(startPeriod, templateCompanyId, order);
  const templateFinanceFixture = INITIAL_FINANCE_FIXTURES_V1.find((f) => f.companyId === templateCompanyId);
  if (!templateFinanceFixture) throw new Error(`初期財務テンプレートが見つかりません: ${templateCompanyId}`);

  const initialFinanceCompanies = fixtures.map((f) => buildUnifiedFinanceState(f.companyId, f.initialRawMaterialLots, startPeriod, templateFinanceFixture));
  const initialContracts = buildUnifiedContracts(startPeriod, templateCompanyId, order);

  const initialScenarioTurnInput = getScenarioTurnInput(scenarioState, 1);
  const initialPreviousMarketContext = buildPreviousMarketContext(definition, 1, initialScenarioTurnInput, undefined);
  const initialMarketInput = toMarketQuarterInput(initialScenarioTurnInput, initialPreviousMarketContext);

  const state: CompanyLabState = {
    config,
    currentPeriod: startPeriod,
    scenarioState,
    contracts: initialContracts,
    rawMaterialLots: fixtures.flatMap((f) => f.initialRawMaterialLots),
    productionState: initializeProductionState(startPeriod),
    lastQuarterActualProduction: Object.fromEntries(fixtures.map((f) => [f.companyId, {}])),
    qualityState: initializeQualityReliabilityState(
      fixtures.map((f) => f.companyId),
      ["hoso", "pd", "vap"]
    ),
    financeState: { companies: initialFinanceCompanies },
    financingState: {
      companies: initialFinanceCompanies.map((fs) => buildInitialCompanyFinancingState(fs, startPeriod)),
    },
    capexState: {
      companies: fixtures.map((f) => buildInitialCompanyCapexState(f.companyId)),
    },
    workforceState: buildInitialWorkforceState(fixtures),
    consumerMarketState: buildInitialConsumerMarketCarryStateTable(initialMarketInput.demandMarkets),
    history: [],
    isComplete: false,
  };

  return { state, fixtures };
}

// ---------------------------------------------------------------------
// 【SAI-2】任意のテンプレート（既存5社のcompanyIdに紐づかない、独立に設計した
// 標準初期条件）から5社を複製する汎用版。Test B（既存5社のいずれかをテンプレート
// にする、companyId引きの版）はそのまま残し、挙動を一切変えていない。
// ---------------------------------------------------------------------

/** 初期契約1件ぶんの定義（`companyLab/initialContracts.ts`のInitialContractDefと
 *  同じ形。既存5社のcompanyIdに紐づかない、独立の契約定義を渡せるようにする）。 */
export interface UnifiedContractDef {
  readonly market: "CN" | "US" | "EU" | "JP" | "OTHER";
  readonly product: "hoso" | "pd" | "vap";
  readonly quantity: number;
  readonly unitPrice: number;
  readonly dueDateStr: string;
}

/** 任意のCompanyFixtureテンプレート（既存5社のcompanyIdに紐づかない）から、
 *  5社ぶんのfixtureを複製する（cloneFixtureForCompanyをそのまま再利用）。 */
export function buildUnifiedFixturesFromTemplate(template: CompanyFixture, order: readonly CompanyId[] = ALL_COMPANY_IDS): readonly CompanyFixture[] {
  return order.map((id) => cloneFixtureForCompany(template, id));
}

/** 任意のUnifiedContractDef[]（既存5社のcompanyIdに紐づかない）から、5社ぶんの
 *  初期契約を複製する（generateInitialContractsと同じcontractedPeriod/dueDate
 *  導出ロジックを再利用）。 */
function buildUnifiedContractsFromDefs(startPeriod: PeriodV2, contractDefs: readonly UnifiedContractDef[], order: readonly CompanyId[]): SalesContract[] {
  const contractedPeriod = previousPeriod(startPeriod);
  const out: SalesContract[] = [];
  for (const id of order) {
    contractDefs.forEach((def, i) => {
      const dueDate = parsePeriod(def.dueDateStr);
      out.push({
        contractId: `SC-STD-${contractedPeriod}-${def.market}-${def.product}-${id}-${i}`,
        companyId: id,
        market: def.market,
        product: def.product,
        contractedPeriod,
        dueDate,
        originalQuantity: hosoEqTons(def.quantity),
        outstandingQuantity: hosoEqTons(def.quantity),
        unitPrice: usdPerHosoEqKg(def.unitPrice),
        status: "open",
      });
    });
  }
  return out;
}

/** initializeUnifiedCompanyLabの汎用版。既存5社のcompanyIdに紐づかない、独立に
 *  設計したfixtureテンプレート・財務テンプレート・契約定義から、5社を同一条件へ
 *  複製した初期状態を構築する（SAI-2の標準初期条件・基準テスト用）。 */
export function initializeUnifiedCompanyLabFromTemplate(
  config: CompanyLabConfig,
  buildFixtureTemplate: (startPeriod: PeriodV2) => CompanyFixture,
  financeFixtureTemplate: Omit<InitialFinanceFixture, "companyId">,
  contractDefs: readonly UnifiedContractDef[],
  order: readonly CompanyId[] = ALL_COMPANY_IDS
): CompanyLabInitResult {
  const definition = findScenarioDefinitionForCompanyLab(config.scenarioId);
  const scenarioState = initializeScenario(definition, config.mode, config.seed);
  const startPeriod = getScenarioTurnInput(scenarioState, 1).period;
  const fixtureTemplate = buildFixtureTemplate(startPeriod);
  const fixtures = buildUnifiedFixturesFromTemplate(fixtureTemplate, order);
  const templateFinanceFixture: InitialFinanceFixture = { companyId: fixtureTemplate.companyId, ...financeFixtureTemplate };

  const initialFinanceCompanies = fixtures.map((f) => buildUnifiedFinanceState(f.companyId, f.initialRawMaterialLots, startPeriod, templateFinanceFixture));
  const initialContracts = buildUnifiedContractsFromDefs(startPeriod, contractDefs, order);

  const initialScenarioTurnInput = getScenarioTurnInput(scenarioState, 1);
  const initialPreviousMarketContext = buildPreviousMarketContext(definition, 1, initialScenarioTurnInput, undefined);
  const initialMarketInput = toMarketQuarterInput(initialScenarioTurnInput, initialPreviousMarketContext);

  const state: CompanyLabState = {
    config,
    currentPeriod: startPeriod,
    scenarioState,
    contracts: initialContracts,
    rawMaterialLots: fixtures.flatMap((f) => f.initialRawMaterialLots),
    productionState: initializeProductionState(startPeriod),
    lastQuarterActualProduction: Object.fromEntries(fixtures.map((f) => [f.companyId, {}])),
    qualityState: initializeQualityReliabilityState(
      fixtures.map((f) => f.companyId),
      ["hoso", "pd", "vap"]
    ),
    financeState: { companies: initialFinanceCompanies },
    financingState: {
      companies: initialFinanceCompanies.map((fs) => buildInitialCompanyFinancingState(fs, startPeriod)),
    },
    capexState: {
      companies: fixtures.map((f) => buildInitialCompanyCapexState(f.companyId)),
    },
    workforceState: buildInitialWorkforceState(fixtures),
    consumerMarketState: buildInitialConsumerMarketCarryStateTable(initialMarketInput.demandMarkets),
    history: [],
    isComplete: false,
  };

  return { state, fixtures };
}

export type DecisionProviderFn = (
  fixture: CompanyFixture,
  ownState: CompanyOwnState,
  publicInfo: PublicMarketInfo,
  period: PeriodV2,
  turn: number
) => CompanyDecisionInput;

/** runCompanyLabWithAutoPolicyForAllCompaniesと同じループを、任意のinitResultから
 *  走らせる（Test B・Test Cの両方から使う共通実行部）。 */
export function runFromInit(initResult: CompanyLabInitResult, decisionProvider: DecisionProviderFn) {
  const { fixtures } = initResult;
  let state = initResult.state;
  while (!state.isComplete) {
    const publicInfo = buildPublicMarketInfo(state);
    const decisionsByCompanyId: Record<CompanyId, CompanyDecisionInput> = {} as Record<CompanyId, CompanyDecisionInput>;
    for (const f of fixtures) {
      const ownState = buildCompanyOwnState(state, f);
      decisionsByCompanyId[f.companyId] = decisionProvider(f, ownState, publicInfo, state.currentPeriod, state.scenarioState.currentTurn);
    }
    state = advanceCompanyLabQuarter(state, fixtures, decisionsByCompanyId);
  }
  return { config: state.config, companies: fixtures, history: state.history };
}

/** Test C用: 会社に関わらず常に同一の最小限意思決定（新規契約なし・生産0・
 *  調達floor分のみ・資金調達なし・capex提案なし）を返す固定プロバイダー。
 *  salesForceHeadcountTotal等の会社別上限に対しても常に妥当（0はどの会社でも
 *  合法な下限）であるため、"companyIdによる分岐なしの真に同一の意思決定"が
 *  会社によって拒否される心配がない。 */
export function fixedMinimalDecisionProvider(fixture: CompanyFixture): CompanyDecisionInput {
  return {
    companyId: fixture.companyId,
    salesPlans: [],
    domesticPurchasePlan: { companyId: fixture.companyId, desiredQuantity: hosoEqTons(0), priceAdjustmentUsdPerHosoEqKg: 0, procurementHeadcount: fixture.procurementHeadcountTotal },
    importOrders: [],
    aquacultureStockingPlans: [],
    productionPlans: [],
    workerAssignments: fixture.workerBaseline.map((w) => ({
      factoryId: w.factoryId,
      companyId: w.companyId,
      regularHeadcount: w.regularHeadcount,
      temporaryHeadcount: 0,
      overtimeRate: ratio(0),
      attendanceRate: w.attendanceRate,
      skills: w.skills,
    })),
    financingRequest: { desiredAmountUsd: 0, desiredLoanType: "workingCapital", desiredTermQuarters: 4, desiredRepaymentMethod: "bulletAtMaturity", desiredPrepaymentUsd: 0, emergencyAcceptable: true },
    capexDecision: { companyId: fixture.companyId, newProjectProposals: [], cancelRequests: [], resumeRequests: [] },
  };
}
