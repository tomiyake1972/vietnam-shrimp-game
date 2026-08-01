// ShrimpX V2 — 会社経営統合テスト環境（Phase 6.2） 統合四半期ランナー
//
// Phase1（市場・価格形成）・Phase2（長期シナリオ・イベント）・Phase4（販売・
// 約定残）・Phase5（国内原料・輸入・養殖・原料在庫）・Phase6（工場・ワーカー・
// 生産・完成品在庫・契約履行）を、1つの決定論的な純粋関数として連結する。
// 既存の各Phaseの計算ロジックは一切複製・書き換えず、既存の公開関数
// （runTurn・advanceProductionQuarter・applyFulfillments等）をそのまま呼び出す。
// UI・API・Redis・生成AIには一切依存しない。
//
// 【既存ターン・オーケストレーター（app/lib/v2/turn/runner.ts）との関係】
// turn/runner.ts の runTurn は、すでにPhase1・Phase4・Phase5を次の順序で
// 実行する（turn/runner.ts冒頭コメントより）。
//   1. 各社の有効買付意向を算出 → 2. 集計 → 3. 市場入力へ上書き適用
//   → 4. calculateMarketQuarter → 5. Phase4販売処理 → 6. 必要原料量集計
//   → 7. Phase5国内買付配分 → 8. 国内買付ロット生成 → 9. 輸入注文・到着処理
//   → 10. 養殖池入れ・収穫処理 → 11. 期限切れ・在庫状態遷移処理
// 本ランナーはこれをそのまま呼び出し、その前後にPhase2（シナリオ→市場入力
// 変換、industryLab/simulationRunner.tsと同じ手順）とPhase6（生産・契約履行）
// を追加する。
//
// 【実装指示の四半期順序との差異と理由】
// 実装指示は「1. 前期からの輸入到着・養殖収穫・期限切れ」を最初の手順として
// 挙げているが、既存のPhase5（advanceRawMaterialsQuarter）は新規輸入発注の
// 着地価格計算に当期のHOSO FOB価格（calculateMarketQuarterの結果）を必要と
// するため、「到着処理」と「新規発注」が同一関数呼び出し内で不可分に結合されて
// いる（turn/runner.ts冒頭コメント参照）。既存モジュールの公開契約を書き換え
// ないという開発ルールに従い、本ランナーは「輸入到着・養殖収穫・期限切れの
// 処理」を独立した最初の手順として切り出さず、既存のPhase5実行順序
// （四半期の市場計算の直後）をそのまま踏襲する。所有権・時系列上の実体（前期に
// 池入れ・発注されたものが当期到着する）は変わらないため、数量・価格の計算
// 結果には影響しない（テストの数量保存・決定論性で確認する）。
//
// 実装指示の「3. 国内買付意向とPD/VAP供給計画を集計」は、既存モジュールに
// 欠けていた新規の統合ステップである（production/supplySignal.tsはPhase6
// 実装時点で用意されていたが、Phase6はturn/へ未接続だった）。本ランナーは
// calculateMarketQuarter（turn/runner内部）を呼ぶ前に、当期の各社生産計画
// （plannedQuantity）からPD/VAP供給シグナルを集計し、市場入力
// （CountrySupplyInput.pdProcessingCapacity/vapProcessingCapacity）へ適用する
// （PD/VAP供給増加が当期のプレミアムを引き下げる、という受入条件を満たすために
// 必須の配線）。

import { PeriodV2 } from "../core/period";
import { HosoEqTons, hosoEqTons, ratio, roundHosoEqTons, Score0to100, score0to100, unwrapUnit, usdPerHosoEqKg } from "../core/units";
import { COUNTRY_IDS, CountryId, DEMAND_MARKET_IDS, DemandMarketId, MarketQuarterInput, MarketQuarterResult, Product } from "../market/types";
import {
  CONSUMER_MARKET_INVENTORY_PARAMETERS_V1,
  ConsumerMarketCarryState,
  ConsumerMarketQuarterRecord,
  buildInitialConsumerMarketCarryStateTable,
  computeActualPurchaseByMarket,
  deriveMarketWeightsFromDesiredPurchase,
  deriveNextQuarterDestinationPriceCoefficients,
  planConsumerMarketQuarterTable,
  rollCarryStateForward,
  settleConsumerMarketQuarter,
} from "../market/consumerInventory";
import { CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTS, DestinationMarketPriceCoefficientTable } from "../market/destinationPricingParameters";
import { applyLifecycleDemandToMarketInput, computeMarketProductMix, MarketProductMix, PRODUCT_LIFECYCLE_PARAMETERS_V1 } from "../market/productLifecycle";
import { lookupSalesBaseScore, salesBaseSliceForCompany, updateSalesBaseState } from "./salesBase";
import {
  buildInitialProductDevelopmentState,
  lookupProductDevelopmentScore,
  ProductDevelopmentState,
  updateProductDevelopmentState,
} from "./productDevelopmentState";
import { calculateCompanyCapabilityCoefficient } from "./premiumPolicy";
import { SALES_PARAMETERS_SAI5_SALES_BASE_V1, SALES_PARAMETERS_TEST15_VAP_CAPABILITY_V1, SALES_PARAMETERS_V1, SalesParameters } from "../sales/parameters";
import { MARKET_PARAMETERS_V1 } from "../market/parameters";
import {
  applyProductSubstitution,
  computeAddressableDemand,
  computeRawSupplyPressure,
  deriveAdoptionTurnShift,
  derivePremiumRatioMultipliers,
  initialMarketEvolutionState,
  pushRecentAppliedMix,
  updateMarketEvolutionState,
  MARKET_EVOLUTION_PARAMETERS_V1,
  MarketEvolutionParameters,
  Sai5MarketEvolutionRecord,
} from "./marketEvolution";
import { deriveVietnamMarketReferencePrices } from "../sales/marketAdapter";
import {
  advanceScenarioTurn,
  getScenarioTurnInput,
  initializeScenario,
  PreviousMarketContext,
  ScenarioDefinition,
  ScenarioTurnFeedback,
  ScenarioTurnInput,
  toMarketQuarterInput,
} from "../scenario";
import { listScenarioAliases, resolveScenarioDefinition } from "../industryLab/cli/scenarioAliases";
import { INDUSTRY_LAB_ASSUMPTIONS_V1 } from "../industryLab/assumptions";
import { runTurn } from "../turn/runner";
import { TurnOrchestratorInput } from "../turn/types";
import { applyFulfillments, updateContractStatusesForQuarterEnd } from "../sales/backlog";
import { validateSalesForceHeadcountBudget } from "../sales/salesForce";
import { MarketSalesEffortAdjustment } from "../sales/marketEffort";
import { CompanyId, MarketProductAllocationResult, SalesContract } from "../sales/types";
import { AquacultureHarvestResult, DomesticPurchaseAllocationResult, RawMaterialLot } from "../rawMaterials/types";
import {
  advanceProductionQuarter,
  aggregateProductionSupplySignals,
  applyFinishedGoodsExpiryForQuarterEnd,
  applySupplySignalToCountrySupply,
  consumeFinishedGoods,
  createFinishedGoodsLots,
  initializeProductionState,
  planContractFulfillment,
  PRODUCTION_PARAMETERS_V1,
} from "../production";
import {
  CompanyLoadMetrics,
  ContractFulfillmentPlan,
  FinishedGoodsLot,
  FinishedGoodsUsageRecord,
  ProductionAllocationEntry,
  ProductionBatch,
  ProductionQuarterInput,
  ProductionSupplySignalInput,
} from "../production/types";
import {
  applyQualityToBatches,
  adjustmentsByBatchId,
  attachQualityInfoToFinishedGoodsLots,
  computeMarketDeliveryObservations,
  computeMarketTrustObservations,
  initializeQualityReliabilityState,
  updateQualityByCompanyProduct,
  updateTrustByCompanyMarket,
} from "../quality";
import type { QualityAdjustmentInput } from "../quality";
import type { QualityReliabilityState } from "../quality/types";
import { buildCompanyQualitySummary } from "./qualitySummary";
import { buildCompanyFixtures } from "./fixtures";
import { buildInitialWorkforceState, deriveNextWorkforceState } from "./workforce";
import {
  buildInitialPdMechanizationState,
  buildPdCoefficientOverridesByFactory,
  computeCurrentQuarterPdUtilizationByFactory,
  deriveNextPdMechanizationState,
} from "./pdMechanizationState";
import { FINANCE_PARAMETERS_V1, buildCompanyQuarterBusinessActuals, buildInitialCompanyFinanceState } from "../finance";
import type { CompanyFinanceState, CompanyFinancialQuarterResult, FinanceState } from "../finance/types";
import { unwrapUsd } from "../finance/types";
import {
  FINANCING_PARAMETERS_V1,
  buildCollateralInputFromCompanyLab,
  buildInitialCompanyFinancingState,
  closeQuarterWithFinancing,
  computeProcurementConstraint,
  planQuarterFinancing,
} from "../financing";
import type { CompanyFinancingState, FinancingQuarterResult, FinancingState } from "../financing/types";
import type { QuarterFinancingPlan } from "../financing/liquidityClose";
import {
  CAPEX_PARAMETERS_V1,
  applyCapexCapacityToFactories,
  applyNewFactoryConstructionToFactories,
  buildCompanyFactorySpaceState,
  buildFactorySpaceApprovalBudget,
  buildInitialCompanyCapexState,
  closeQuarterWithCapex,
} from "../capex";
import type { CapexQuarterResult, CapexState, CompanyCapexState } from "../capex/types";
import type { ProposalApprovalGate } from "../capex/projectLifecycle";
import { calculateExternalProcessorIntent } from "./externalDemand";
import { EXTERNAL_PROCESSOR_DEMAND_ASSUMPTIONS_V1, REFERENCE_WORLD_CONSUMPTION_TONS } from "./parameters";
import {
  globalReasonCodesFromMarketDrivers,
  reasonCodeFromDomesticCompetition,
  reasonCodeFromImportInTransit,
  reasonCodesFromAquacultureHarvest,
  reasonCodesFromOverdueContracts,
  reasonCodesFromProductionEntries,
  reasonCodesFromSalesAllocation,
  reasonCodesFromSalesEffortAdjustments,
} from "./reasonCodes";
import { generateInitialContracts } from "./initialContracts";
import {
  CompanyDecisionInput,
  CompanyFixture,
  CompanyLabConfig,
  CompanyLabError,
  CompanyLabResult,
  CompanyLabState,
  CompanyOwnState,
  CompanyQuarterRecord,
  CompanyQuarterSummary,
  CompanyReasonEntry,
  PublicMarketInfo,
} from "./types";

const EPSILON = 1e-6;

/**
 * scenarioIdから ScenarioDefinition を解決する。完全ID（例: "baseline-v0.1"）と、
 * industryLabのCLIがすでに採用しているバージョン接尾辞省略形（例: "baseline"）の
 * どちらも受け付ける（resolveScenarioDefinition・industryLab/cli/scenarioAliases.ts
 * をそのまま再利用し、ID解決ロジックを重複実装しない）。
 */
export function findScenarioDefinitionForCompanyLab(scenarioId: string): ScenarioDefinition {
  const definition = resolveScenarioDefinition(scenarioId);
  if (!definition) {
    throw new CompanyLabError(
      `scenarioId "${scenarioId}" に一致するシナリオ定義が見つかりません。利用可能なシナリオ: ${listScenarioAliases()
        .map((e) => `${e.alias}（正式ID: ${e.definition.scenarioId}）`)
        .join(", ")}`
    );
  }
  return definition;
}

function priorHosoFobPriceFromPrehistory(definition: ScenarioDefinition): PreviousMarketContext["priorHosoFobPrice"] {
  const result = {} as Record<CountryId, PreviousMarketContext["priorHosoFobPrice"][CountryId]>;
  for (const c of COUNTRY_IDS) {
    result[c] = usdPerHosoEqKg(definition.prehistory.priorHosoFobPriceUsdPerKg[c]);
  }
  return result;
}

function priorHosoFobPriceFromLastQuarter(lastResult: MarketQuarterResult): PreviousMarketContext["priorHosoFobPrice"] {
  const result = {} as Record<CountryId, PreviousMarketContext["priorHosoFobPrice"][CountryId]>;
  for (const c of COUNTRY_IDS) {
    result[c] = lastResult.hosoPrices[c].price;
  }
  return result;
}

/**
 * 当期のPreviousMarketContextを組み立てる（industryLab/simulationRunner.tsと同じ手順）。
 * domesticProcurementIntentは「上書き前の参考値」であり、turn/runner.ts内部で
 * 各社の実際の国内買付計画（DomesticPurchaseIntentSource.companyPlans）により
 * 必ず上書きされるため、ここでの値そのものが最終結果へ影響することはない。
 */
export function buildPreviousMarketContext(
  definition: ScenarioDefinition,
  turn: number,
  scenarioTurnInput: ScenarioTurnInput,
  lastQuarterMarketResult: MarketQuarterResult | undefined
): PreviousMarketContext {
  if (turn === 1 || !lastQuarterMarketResult) {
    return {
      priorHosoFobPrice: priorHosoFobPriceFromPrehistory(definition),
      domesticProcurementIntent: hosoEqTons(Math.max(0, definition.initialStateOverrides.initialDomesticProcurementIntentHosoEqTons)),
    };
  }
  return {
    priorHosoFobPrice: priorHosoFobPriceFromLastQuarter(lastQuarterMarketResult),
    domesticProcurementIntent: hosoEqTons(
      Math.max(0, unwrapUnit(scenarioTurnInput.vietnamTrailingAverageDomesticPurchase) * INDUSTRY_LAB_ASSUMPTIONS_V1.domesticProcurementIntentToTrailingAverageRatio)
    ),
  };
}

/**
 * 【Phase 8F-1】市場別配列（1市場1件、DEMAND_MARKET_IDS全件を含む前提）を
 * DemandMarketId をキーとするRecordへ変換する（deriveNextQuarterDestinationPriceCoefficients
 * が要求する入力形へ、保存形式（配列）を合わせるだけの小さなアダプター）。
 */
function consumerMarketRecordsToTable(
  records: readonly ConsumerMarketQuarterRecord[]
): Readonly<Record<DemandMarketId, ConsumerMarketQuarterRecord>> {
  const result = {} as Record<DemandMarketId, ConsumerMarketQuarterRecord>;
  for (const record of records) {
    result[record.market] = record;
  }
  return result;
}

function buildCompanyCountryMap(fixtures: readonly CompanyFixture[]): Readonly<Record<CompanyId, CountryId>> {
  const result: Record<CompanyId, CountryId> = {};
  for (const f of fixtures) result[f.companyId] = f.country;
  return result;
}

/** 会社の生産計画（plannedQuantity）と前期実績（actualQuantity）から、PD/VAP供給シグナル入力を組み立てる。 */
function buildSupplySignalInputs(
  decisions: readonly CompanyDecisionInput[],
  lastQuarterActualProduction: Readonly<Record<CompanyId, Readonly<Partial<Record<Product, number>>>>>
): readonly ProductionSupplySignalInput[] {
  const signals: ProductionSupplySignalInput[] = [];
  for (const d of decisions) {
    for (const product of ["pd", "vap"] as const) {
      const planned = d.productionPlans.filter((p) => p.product === product).reduce((sum, p) => sum + unwrapUnit(p.desiredQuantity), 0);
      const actual = lastQuarterActualProduction[d.companyId]?.[product] ?? 0;
      if (planned <= EPSILON && actual <= EPSILON) continue;
      signals.push({
        companyId: d.companyId,
        product,
        plannedQuantity: hosoEqTons(Math.round(planned * 100) / 100),
        actualQuantity: hosoEqTons(Math.round(actual * 100) / 100),
      });
    }
  }
  return signals;
}

function applyProductionSupplySignalsToMarketInput(
  marketInput: MarketQuarterInput,
  signals: readonly ProductionSupplySignalInput[],
  companyCountry: Readonly<Record<CompanyId, CountryId>>
): MarketQuarterInput {
  const pdCountrySignals = aggregateProductionSupplySignals(signals, companyCountry, "pd");
  const vapCountrySignals = aggregateProductionSupplySignals(signals, companyCountry, "vap");
  const afterPd = applySupplySignalToCountrySupply(marketInput.countries, pdCountrySignals, "pd", false);
  const afterVap = applySupplySignalToCountrySupply(afterPd, vapCountrySignals, "vap", false);
  return { ...marketInput, countries: afterVap };
}

export interface CompanyLabInitResult {
  readonly state: CompanyLabState;
  readonly fixtures: readonly CompanyFixture[];
}

/** 会社経営統合テスト環境を初期化する（5社フィクスチャの初期原料在庫込み）。 */
export function initializeCompanyLab(config: CompanyLabConfig): CompanyLabInitResult {
  const definition = findScenarioDefinitionForCompanyLab(config.scenarioId);
  if (!Number.isInteger(config.turns) || config.turns < 1 || config.turns > definition.durationTurns) {
    throw new CompanyLabError(
      `turns は1〜${definition.durationTurns}（シナリオ"${definition.scenarioId}"のdurationTurns）の整数である必要があります。受け取った値: ${config.turns}`
    );
  }

  const scenarioState = initializeScenario(definition, config.mode, config.seed);
  const startPeriod = getScenarioTurnInput(scenarioState, 1).period;
  const fixtures = buildCompanyFixtures(startPeriod);

  // 【Phase 8A】5社の初期財務状態。原料在庫の初期金額は各社の初期原料ロット
  // （実データ）から算出し、開始時点の貸借一致を構造的に保証する。
  const initialFinanceCompanies = fixtures.map((f) => buildInitialCompanyFinanceState(f.companyId, f.initialRawMaterialLots, startPeriod));

  // 【初期成約】初期売掛金に対応する「前期営業成約」を配置し、
  // 「当期にデリバリーされる契約」として明示的に定義する。
  const initialContracts = generateInitialContracts(startPeriod);

  // 【Phase 8F-1】初期の消費国在庫carry state。ターン1のdemandMarkets入力
  // （Phase2のシナリオ→市場入力変換。advanceCompanyLabQuarterのターン1が
  // 実際に使うものと完全に同じ決定論的な手順・入力で、副作用も乱数も無いため
  // ここで再計算しても結果は一致する）から、市場別の初期在庫を構築する
  // （実装指示§13「初期在庫は目標在庫付近から開始する」）。
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
    // 【Phase 7A】品質・顧客信頼・納期信頼性の初期状態。全社×全商品・全社×全市場を
    // 中立値（qualityはbaselineOperationalQuality、顧客信頼・納期信頼性はneutralScore）
    // で初期化する。既存フィクスチャに品質能力・顧客関係の値がなかったため
    // （調査結果、§完了報告参照）、アーキタイプ別の差別化は行わない。
    qualityState: initializeQualityReliabilityState(
      fixtures.map((f) => f.companyId),
      ["hoso", "pd", "vap"]
    ),
    // 【Phase 8A】5社の初期財務状態。
    financeState: { companies: initialFinanceCompanies },
    // 【Phase 8B-1】5社の初期資金繰り状態。既存の初期短期/長期借入金（上記
    // initialFinanceCompanies）を、二重計上を避けつつ合成融資として1:1で
    // 接続する（financing/initialPortfolio.ts参照）。
    financingState: {
      companies: initialFinanceCompanies.map((fs) => buildInitialCompanyFinancingState(fs, startPeriod)),
    },
    // 【Phase 8B-2A】5社の初期設備投資状態（案件なし。過去分の合成は行わない。
    // 初期fixedAssetsGross＝Phase 8Aの初期財務フィクスチャそのものであり、
    // capex経由の完成振替はゲーム開始後にのみ発生する）。
    capexState: {
      companies: fixtures.map((f) => buildInitialCompanyCapexState(f.companyId)),
    },
    // 【Phase 8D-4】Worker総人数の初期状態。fixture.workerBaselineの常用人数を
    // そのまま初期値とするため、Phase 8D以前と初期人数は完全に同じ。
    workforceState: buildInitialWorkforceState(fixtures),
    // 【Test15新設】Factory単位のPD稼働率の初期状態（疎配列・空。全FactoryがPD
    // 省人化投資パラメータのinitialPdUtilizationRatio扱いになる）。
    pdMechanizationState: buildInitialPdMechanizationState(),
    // 【Test15新設】VAP商品開発スコアの初期状態（疎配列・空。全会社が中立値50扱い）。
    productDevelopmentState: buildInitialProductDevelopmentState(),
    // 【Phase 8F-1】市場別（CN/US/EU/JP/OTHER）の消費国在庫・購買循環モデルの
    // 初期carry state。
    consumerMarketState: buildInitialConsumerMarketCarryStateTable(initialMarketInput.demandMarkets),
    history: [],
    isComplete: false,
  };

  return { state, fixtures };
}

/** 自社ぶんに絞り込んだCompanyOwnStateを組み立てる（自動方針・プレイヤー入力編集の双方が使う）。 */
export function buildCompanyOwnState(state: CompanyLabState, fixture: CompanyFixture): CompanyOwnState {
  const lastRecord = state.history[state.history.length - 1];
  const factoryIds = new Set(fixture.factories.map((f) => f.factoryId));

  // 【Phase 7A】state.qualityStateは「前四半期末までの状態」（advanceCompanyLabQuarterが
  // 当期処理の最後に更新するため、当期の意思決定を作る本関数呼び出し時点では常に
  // 1つ前のターンの結果を指す）。今期の品質結果を今期の成約へ遡及適用しないという
  // 実装指示を、この呼び出し順序だけで自然に満たす。
  const qualityScoreByProduct: Record<string, Score0to100> = {};
  for (const s of state.qualityState.qualityByCompanyProduct) {
    if (s.companyId === fixture.companyId) qualityScoreByProduct[s.product] = s.qualityScore;
  }
  const customerTrustByMarket: Record<string, Score0to100> = {};
  const deliveryReliabilityByMarket: Record<string, Score0to100> = {};
  for (const t of state.qualityState.trustByCompanyMarket) {
    if (t.companyId !== fixture.companyId) continue;
    customerTrustByMarket[t.market] = t.customerTrustScore;
    deliveryReliabilityByMarket[t.market] = t.deliveryReliabilityScore;
  }

  // 【Phase 8B-1】前期末までの財務・資金繰り状態（自動方針の資金調達希望が
  // 参照してよい唯一の財務情報。当期の市場・生産実績は含まれない）。
  const financeStateForCompany = state.financeState.companies.find((c) => c.companyId === fixture.companyId);
  const financingStateForCompany = state.financingState.companies.find((c) => c.companyId === fixture.companyId);
  const capexStateForCompany = state.capexState.companies.find((c) => c.companyId === fixture.companyId);
  if (!financeStateForCompany || !financingStateForCompany || !capexStateForCompany) {
    throw new CompanyLabError(`会社 "${fixture.companyId}" の財務・資金繰り・設備投資状態が初期化されていません。`);
  }
  // 【Phase 8D-4】前期末までの自社Worker総人数。旧保存データから復元した場合など、
  // 万一この会社ぶんが欠けていれば fixture の基準人数から組み立て直す（0で埋めない）。
  const workforceStateForCompany =
    state.workforceState?.companies.find((c) => c.companyId === fixture.companyId) ??
    buildInitialWorkforceState([fixture]).companies[0];

  return {
    companyId: fixture.companyId,
    contracts: state.contracts.filter((c) => c.companyId === fixture.companyId),
    rawMaterialLots: state.rawMaterialLots.filter((l) => l.companyId === fixture.companyId),
    finishedGoodsLots: state.productionState.finishedGoodsLots.filter((l) => l.companyId === fixture.companyId),
    lastQuarterFactoryLoadMetrics: lastRecord ? lastRecord.factoryLoadMetrics.filter((m) => factoryIds.has(m.factoryId)) : [],
    lastQuarterActualProductionByProduct: state.lastQuarterActualProduction[fixture.companyId] ?? {},
    qualityScoreByProduct,
    customerTrustByMarket,
    deliveryReliabilityByMarket,
    financeState: financeStateForCompany,
    financingState: financingStateForCompany,
    capexState: capexStateForCompany,
    workforceState: workforceStateForCompany,
    // 【SAI-5D】前四半期末までの自社の営業基盤（quality/trustと同じ「当期処理の
    // 最後に更新される＝呼び出し時点では常に前期末値」の規約）。無効時はundefined。
    ...(state.salesBaseState ? { salesBaseByMarketProduct: salesBaseSliceForCompany(state.salesBaseState, fixture.companyId) } : {}),
    // 【監査指摘G】営業基盤が当期の成約へ実際にどれだけ効くか（ウェイト）。
    // 機能OFFなら0＝「基盤の高低は成約に一切影響しない」ことが判断側から分かる。
    salesBaseCompetitivenessWeight: salesParametersFor(state.config).competitivenessWeights.salesBase,
  };
}

/**
 * 当期の成約配分に使うSalesParameters（SAI-5D有効時のみ営業基盤ウェイトが正、
 * 【Test15新設】vapProductDevelopmentCompetitiveness有効時のみVAP能力ウェイトが正）。
 * 【Test15暫定値・要校正】両方同時有効時の重み配分定数は未整備のため、
 * vapProductDevelopmentCompetitivenessを優先する（salesBaseAccumulationも同時に
 * trueの場合はsalesBase側のウェイトが0に戻る。組み合わせが必要になった時点で
 * 専用の定数を追加する）。
 */
function salesParametersFor(config: CompanyLabConfig): SalesParameters {
  if (config.sai5?.vapProductDevelopmentCompetitiveness) return SALES_PARAMETERS_TEST15_VAP_CAPABILITY_V1;
  return config.sai5?.salesBaseAccumulation ? SALES_PARAMETERS_SAI5_SALES_BASE_V1 : SALES_PARAMETERS_V1;
}

/** 自動方針・プレイヤー入力の双方が参照してよい公開市場情報を組み立てる。 */
/**
 * 【監査指摘I・修正】販売計画の salesBaseScore を、エンジンが持つ正典の
 * SalesBaseState で必ず上書きする。
 *
 * 以前は Standard AI の販売判断（standardAi/decision/sales.ts）だけが
 * salesBaseScore を計画へ載せており、autoPolicy.ts（暫定自動方針）と
 * 手入力・意思決定編集の経路では常に undefined ＝ 成約競争力の計算で中立50
 * として扱われていた。同じ状態を持っているのに、どの意思決定経路を通ったかで
 * 成約結果が変わってしまう（かつ、意思決定側が任意の値を申告できてしまう）。
 *
 * ここで一括して上書きすることで:
 *  - 経路によらず、当期の成約に使われる営業基盤は必ず「前期末の正典の状態」になる
 *  - 意思決定側が自己申告した値は採用されない（情報境界の担保）
 *  - 機能OFF・旧stateでは salesBaseScore を**付けない**（undefined のまま）。
 *    競争力ウェイトも0のため、既存挙動とビット単位で一致する
 *    （未取得の値を無条件に50で埋めない、というご指示への対応）。
 */
function applyAuthoritativeSalesBaseScores(state: CompanyLabState, decision: CompanyDecisionInput): CompanyDecisionInput {
  // 機能OFFのときは何もしない（既存挙動とビット単位で一致）。
  // 機能ONなら、stateがまだ無い1期目でも必ず通す。sliceが空になり、意思決定側が
  // 自己申告した salesBaseScore はすべて削除される（情報境界の担保）。
  if (!state.config.sai5?.salesBaseAccumulation) return decision;
  const slice = salesBaseSliceForCompany(state.salesBaseState, decision.companyId);
  return {
    ...decision,
    salesPlans: decision.salesPlans.map((plan) => {
      const score = slice[plan.market]?.[plan.product];
      // 状態に該当エントリが無い（＝一度も活動していない市場×商品）場合は
      // キー自体を付けない。allocation.ts側が params.neutralScore を使う。
      if (score === undefined) {
        if (plan.salesBaseScore === undefined) return plan;
        const rest = { ...plan };
        delete (rest as { salesBaseScore?: unknown }).salesBaseScore;
        return rest;
      }
      return { ...plan, salesBaseScore: score };
    }),
  };
}

/**
 * 【Test15新設】販売計画のVAP entryへ、正典のVAP能力合成係数
 * （companyLab/premiumPolicy.tsのcalculateCompanyCapabilityCoefficient）を
 * 上書きで設定する。applyAuthoritativeSalesBaseScoresと同じ設計方針:
 *  - 意思決定側が自己申告したvapCapabilityScoreは採用されない（情報境界の担保）
 *  - product!=="vap"のentryにはそもそも値を付けない（HOSO/PDへは構造的に無関係）
 *  - 常に前四半期末までの状態だけを読む（今期の実績を遡及しない）
 *
 * ウェイト（competitivenessWeights.vapCapability）が既定0のため、この関数は
 * 常時有効でも既存の全allocation結果とビット単位で一致する（値を設定しても
 * 寄与が0×xで必ず0になるため）。
 */
function applyAuthoritativeVapCapabilityScores(state: CompanyLabState, decision: CompanyDecisionInput): CompanyDecisionInput {
  // 機能OFFのときは何もしない（既存挙動とビット単位で一致、salesBase側と同じ方針）。
  if (!state.config.sai5?.vapProductDevelopmentCompetitiveness) return decision;
  const hasVapPlan = decision.salesPlans.some((p) => p.product === "vap");
  if (!hasVapPlan) return decision;

  const productDevelopmentScore = score0to100(lookupProductDevelopmentScore(state.productDevelopmentState, decision.companyId));

  const vapSalesBaseScores = DEMAND_MARKET_IDS.map((market) => lookupSalesBaseScore(state.salesBaseState, decision.companyId, market, "vap"));
  const salesBaseAvg = vapSalesBaseScores.reduce((s, v) => s + v, 0) / Math.max(1, vapSalesBaseScores.length);

  const qualityEntry = state.qualityState.qualityByCompanyProduct.find((q) => q.companyId === decision.companyId && q.product === "vap");
  const qualityScore = qualityEntry?.qualityScore;

  const trustEntries = state.qualityState.trustByCompanyMarket.filter((t) => t.companyId === decision.companyId);
  const deliveryAvg =
    trustEntries.length > 0 ? trustEntries.reduce((s, t) => s + unwrapUnit(t.deliveryReliabilityScore), 0) / trustEntries.length : undefined;

  const coefficient = calculateCompanyCapabilityCoefficient({
    productDevelopmentScore,
    salesBaseScore: score0to100(salesBaseAvg),
    qualityScore,
    deliveryReliabilityScore: deliveryAvg !== undefined ? score0to100(deliveryAvg) : undefined,
  });
  const vapCapabilityScore = score0to100(coefficient);

  return {
    ...decision,
    salesPlans: decision.salesPlans.map((plan) => {
      if (plan.product !== "vap") {
        if (plan.vapCapabilityScore === undefined) return plan;
        const rest = { ...plan };
        delete (rest as { vapCapabilityScore?: unknown }).vapCapabilityScore;
        return rest;
      }
      return { ...plan, vapCapabilityScore };
    }),
  };
}

export function buildPublicMarketInfo(state: CompanyLabState): PublicMarketInfo {
  const lastRecord = state.history[state.history.length - 1];

  // 【SAI-5C】ライフサイクル公開トレンド。「前四半期までに適用された構成比」
  // のみを公開する（当期の構成比・実現需要は含まない＝lastMarketResultと同じ
  // 「前四半期の結果のみ公開」の情報境界）。構成比は決定論的な関数
  // computeMarketProductMixで再計算する（turn1では前期が存在しないためundefined）。
  let productLifecycleOutlook: PublicMarketInfo["productLifecycleOutlook"];
  if (state.config.sai5?.productLifecycle) {
    // 【監査指摘F・修正】turnはシナリオ状態（scenarioState.currentTurn）を正典と
    // する。以前は state.history.length + 1 で導出していたが、永続化からの復元
    // 経路ではサービス側が「直近1件の記録」しか注入しないことがあり、その場合
    // nextTurnが常に2に張り付いて nextTurn >= 3 の分岐へ到達せず、ライフサイクル
    // トレンドが恒久的にゼロになっていた（＝AIの成長局面判断が働かない）。
    const nextTurn = state.scenarioState.currentTurn;
    if (nextTurn >= 2) {
      // 【SAI-5E】adoption前倒し・PD⇔VAP代替の適用後に実際に使われた構成比が
      // 履歴に記録されていればそれを優先する（公開情報は「実際に適用された値」）。
      // 記録が無い場合（SAI-5E無効・旧履歴）は決定論的な基礎曲線で再計算する。
      // 【監査指摘F】直近2四半期に実際に適用された構成比は carry state
      // （marketEvolutionState.recentAppliedMixes）から読む。履歴配列の深さに
      // 依存しないため、永続化から直近1件だけを注入して再開した場合でも、
      // 中断なし実行と完全に同じ公開情報になる。
      // carry stateが無い場合（SAI-5E無効・旧スナップショット）は従来どおり
      // 履歴 → 決定論的な基礎曲線の順にフォールバックする。
      const recentMixes = state.marketEvolutionState?.recentAppliedMixes ?? [];
      const prevRecord = state.history[state.history.length - 1];
      const prevPrevRecord = state.history[state.history.length - 2];
      const prevMix = recentMixes[0] ?? prevRecord?.sai5MarketEvolution?.appliedMix ?? computeMarketProductMix(nextTurn - 1);
      const prevPrevMix =
        nextTurn >= 3
          ? recentMixes[1] ?? prevPrevRecord?.sai5MarketEvolution?.appliedMix ?? computeMarketProductMix(nextTurn - 2)
          : prevMix;
      const trend = {} as Record<DemandMarketId, Record<Product, number>>;
      for (const market of DEMAND_MARKET_IDS) {
        trend[market] = {
          hoso: prevMix[market].hoso - prevPrevMix[market].hoso,
          pd: prevMix[market].pd - prevPrevMix[market].pd,
          vap: prevMix[market].vap - prevPrevMix[market].vap,
        };
      }
      productLifecycleOutlook = { sharesByMarket: prevMix, quarterlyTrendByMarket: trend };
    }
  }

  return {
    lastMarketResult: lastRecord?.marketResult,
    vietnamDomesticPriorPrice: lastRecord ? unwrapUnit(lastRecord.marketResult.vietnamDomestic.price) : 0,
    ...(productLifecycleOutlook ? { productLifecycleOutlook } : {}),
    // 【SAI-5E】前四半期末までの商品別供給圧力EWMA（公開の業界需給統計に相当）。
    ...(state.marketEvolutionState
      ? {
          productSupplyPressureOutlook: {
            pd: state.marketEvolutionState.pd.supplyPressureEwma,
            vap: state.marketEvolutionState.vap.supplyPressureEwma,
          },
        }
      : {}),
  };
}

function buildCompanySummary(
  fixture: CompanyFixture,
  period: PeriodV2,
  decisions: readonly CompanyDecisionInput[],
  // 【Phase 6.3修正】当期の新規契約のみ（turnResult.salesRecord.newContracts）を
  // 受け取る。累積契約一覧（turnResult.contracts）を渡すと、新規成約量・成約単価が
  // 「これまでの全契約の累積」になってしまう（Phase 6.2診断のバグA）。
  newContracts: readonly SalesContract[],
  contractsBefore: readonly SalesContract[],
  contractsAfter: readonly SalesContract[],
  // 【Phase 6.3修正】当期の実際の完成品充当実績（fulfillmentPlan.usage）。
  // 履行量は契約残高の前後差分ではなくこの実績から直接集計する（Phase 6.2診断の
  // バグB: 差分方式は「当期に新規成約し、当期中に即時履行された契約」を
  // contractsBeforeに存在しないため構造的に取りこぼしていた）。
  fulfillmentUsage: readonly FinishedGoodsUsageRecord[],
  domesticAllocation: DomesticPurchaseAllocationResult,
  salesAllocations: readonly MarketProductAllocationResult[],
  // 【SAI-2追加作業: 市場別営業配置・商品別営業工数】当期、営業工数換算能力の
  // 不足により販売計画が縮小された会社×市場の記録（turnResult.salesRecord.salesEffortAdjustments）。
  salesEffortAdjustments: readonly MarketSalesEffortAdjustment[],
  newImportLots: readonly RawMaterialLot[],
  arrivedImportLots: readonly RawMaterialLot[],
  newGrowingLots: readonly RawMaterialLot[],
  harvestedLots: readonly RawMaterialLot[],
  updatedRawMaterialLots: readonly RawMaterialLot[],
  productionEntries: readonly ProductionAllocationEntry[],
  batches: readonly ProductionBatch[],
  finishedGoodsLotsAfter: readonly FinishedGoodsLot[],
  companyLoadMetrics: CompanyLoadMetrics | undefined,
  aquacultureHarvestResults: readonly AquacultureHarvestResult[]
): {
  // 【Phase 7A】品質・信頼フィールドはbuildCompanyQualitySummary（呼び出し側）が
  // 別途算出しspreadで合成するため、本関数のsummaryはそれらを除いた形にする。
  readonly summary: Omit<
    CompanyQuarterSummary,
    | "qualityScoreByProduct"
    | "operationalRiskByProduct"
    | "downgradeQuantity"
    | "reworkQuantity"
    | "discardQuantity"
    | "majorIncidentCount"
    | "onTimeDeliveryRate"
    | "customerTrustByMarket"
    | "deliveryReliabilityByMarket"
    | "rampWarnings"
  >;
  readonly reasonCodes: readonly CompanyReasonEntry[];
} {
  const companyId = fixture.companyId;
  const companyContracts = newContracts.filter((c) => c.companyId === companyId);
  const newContractedQuantity = companyContracts.reduce((sum, c) => sum + unwrapUnit(c.originalQuantity), 0);
  const newContractedAveragePrice =
    newContractedQuantity > EPSILON
      ? companyContracts.reduce((sum, c) => sum + unwrapUnit(c.unitPrice) * unwrapUnit(c.originalQuantity), 0) / newContractedQuantity
      : 0;

  const afterCompany = contractsAfter.filter((c) => c.companyId === companyId);
  const beforeCompany = contractsBefore.filter((c) => c.companyId === companyId);
  const outstandingQuantity = afterCompany
    .filter((c) => c.status !== "fulfilled" && c.status !== "cancelled")
    .reduce((sum, c) => sum + unwrapUnit(c.outstandingQuantity), 0);
  const overdueQuantity = afterCompany.filter((c) => c.status === "overdue").reduce((sum, c) => sum + unwrapUnit(c.outstandingQuantity), 0);
  // 当期の実際の完成品充当実績を会社IDで絞り込んで直接合計する（契約別・商品別の
  // 内訳はfulfillmentPlan.usage自体が契約ID・商品を保持しており、会社合計・全社合計と
  // 整合する）。当期成約・当期即時履行の契約も必ず含まれる。
  const fulfilledQuantity = fulfillmentUsage
    .filter((u) => u.companyId === companyId)
    .reduce((sum, u) => sum + unwrapUnit(u.quantity), 0);

  const domesticEntry = domesticAllocation.companies.find((c) => c.companyId === companyId);
  const desiredDomesticQuantity = unwrapUnit(decisions.find((d) => d.companyId === companyId)?.domesticPurchasePlan.desiredQuantity ?? hosoEqTons(0));

  const importInTransitQuantity = newImportLots.filter((l) => l.companyId === companyId).reduce((sum, l) => sum + unwrapUnit(l.originalQuantity), 0);
  const importArrivedQuantity = arrivedImportLots.filter((l) => l.companyId === companyId).reduce((sum, l) => sum + unwrapUnit(l.originalQuantity), 0);
  const aquacultureGrowingQuantity = newGrowingLots.filter((l) => l.companyId === companyId).reduce((sum, l) => sum + unwrapUnit(l.originalQuantity), 0);
  const aquacultureHarvestedQuantity = harvestedLots.filter((l) => l.companyId === companyId).reduce((sum, l) => sum + unwrapUnit(l.originalQuantity), 0);
  const rawMaterialInventory = updatedRawMaterialLots
    .filter((l) => l.companyId === companyId && l.status === "available")
    .reduce((sum, l) => sum + unwrapUnit(l.remainingQuantity), 0);

  const companyEntries = productionEntries.filter((e) => e.companyId === companyId);
  const hosoProduced = batches.filter((b) => b.companyId === companyId && b.product === "hoso").reduce((sum, b) => sum + unwrapUnit(b.finishedGoodsQuantity), 0);
  const pdProduced = batches.filter((b) => b.companyId === companyId && b.product === "pd").reduce((sum, b) => sum + unwrapUnit(b.finishedGoodsQuantity), 0);
  const vapProduced = batches.filter((b) => b.companyId === companyId && b.product === "vap").reduce((sum, b) => sum + unwrapUnit(b.finishedGoodsQuantity), 0);
  const finishedGoodsInventory = finishedGoodsLotsAfter
    .filter((l) => l.companyId === companyId && l.status === "available")
    .reduce((sum, l) => sum + unwrapUnit(l.remainingQuantity), 0);

  const rawMaterialShortfall = companyEntries.filter((e) => e.shortfallReasons.includes("rawMaterialShortage")).reduce((sum, e) => sum + unwrapUnit(e.shortfallQuantity), 0);
  const equipmentShortfall = companyEntries
    .filter((e) => e.shortfallReasons.some((r) => r === "commonCapacityShortage" || r === "productCapacityShortage" || r === "packagingCapacityShortage"))
    .reduce((sum, e) => sum + unwrapUnit(e.shortfallQuantity), 0);
  const laborShortfall = companyEntries.filter((e) => e.shortfallReasons.includes("laborShortage")).reduce((sum, e) => sum + unwrapUnit(e.shortfallQuantity), 0);

  const salesReasonCodes = salesAllocations.flatMap((allocation) => {
    const entry = allocation.companies.find((c) => c.companyId === companyId);
    return entry ? reasonCodesFromSalesAllocation(companyId, entry, unwrapUnit(allocation.basePrice)) : [];
  });
  const salesEffortReasonCodes = reasonCodesFromSalesEffortAdjustments(companyId, salesEffortAdjustments);

  const reasonCodes: CompanyReasonEntry[] = [
    ...reasonCodesFromProductionEntries(companyId, companyEntries),
    ...salesReasonCodes,
    ...salesEffortReasonCodes,
    ...(domesticEntry && desiredDomesticQuantity > EPSILON
      ? reasonCodeFromDomesticCompetition(companyId, domesticEntry.coverageScore, unwrapUnit(domesticEntry.allocatedQuantity) / desiredDomesticQuantity)
      : []),
    ...reasonCodeFromImportInTransit(companyId, importInTransitQuantity),
    ...reasonCodesFromAquacultureHarvest(
      companyId,
      aquacultureHarvestResults.filter((r) => r.companyId === companyId)
    ),
    ...reasonCodesFromOverdueContracts(companyId, beforeCompany, afterCompany),
  ];

  const summary = {
    companyId,
    period,
    newContractedQuantity: hosoEqTons(Math.round(newContractedQuantity * 100) / 100),
    newContractedAveragePrice: Math.round(newContractedAveragePrice * 100) / 100,
    fulfilledQuantity: hosoEqTons(Math.round(Math.max(0, fulfilledQuantity) * 100) / 100),
    outstandingQuantity: hosoEqTons(Math.round(outstandingQuantity * 100) / 100),
    overdueQuantity: hosoEqTons(Math.round(overdueQuantity * 100) / 100),
    domesticPurchaseQuantity: domesticEntry ? hosoEqTons(Math.round(unwrapUnit(domesticEntry.allocatedQuantity) * 100) / 100) : hosoEqTons(0),
    domesticPurchasePrice: domesticEntry ? unwrapUnit(domesticEntry.bidPrice) : 0,
    importInTransitQuantity: hosoEqTons(Math.round(importInTransitQuantity * 100) / 100),
    importArrivedQuantity: hosoEqTons(Math.round(importArrivedQuantity * 100) / 100),
    aquacultureGrowingQuantity: hosoEqTons(Math.round(aquacultureGrowingQuantity * 100) / 100),
    aquacultureHarvestedQuantity: hosoEqTons(Math.round(aquacultureHarvestedQuantity * 100) / 100),
    rawMaterialInventory: hosoEqTons(Math.round(rawMaterialInventory * 100) / 100),
    hosoProduced: hosoEqTons(Math.round(hosoProduced * 100) / 100),
    pdProduced: hosoEqTons(Math.round(pdProduced * 100) / 100),
    vapProduced: hosoEqTons(Math.round(vapProduced * 100) / 100),
    finishedGoodsInventory: hosoEqTons(Math.round(finishedGoodsInventory * 100) / 100),
    rawMaterialShortfall: hosoEqTons(Math.round(rawMaterialShortfall * 100) / 100),
    equipmentShortfall: hosoEqTons(Math.round(equipmentShortfall * 100) / 100),
    laborShortfall: hosoEqTons(Math.round(laborShortfall * 100) / 100),
    equipmentUtilizationRate: companyLoadMetrics ? companyLoadMetrics.equipmentUtilizationRate : ratio(0),
    laborUtilizationRate: companyLoadMetrics ? companyLoadMetrics.laborUtilizationRate : ratio(0),
    overtimeRate: companyLoadMetrics ? companyLoadMetrics.overtimeRate : ratio(0),
    temporaryWorkerShare: companyLoadMetrics ? companyLoadMetrics.temporaryWorkerShare : ratio(0),
    reasonCodes,
  };

  return { summary, reasonCodes };
}

/**
 * 会社経営統合テスト環境を1四半期分だけ進める（純粋関数、入力stateは変更しない）。
 * decisionsByCompanyId は、その四半期のfixturesに含まれる全社ぶんの意思決定
 * （自動方針・プレイヤー入力編集のいずれか、または混在）を渡す。
 */
export function advanceCompanyLabQuarter(
  state: CompanyLabState,
  fixtures: readonly CompanyFixture[],
  decisionsByCompanyId: Readonly<Record<CompanyId, CompanyDecisionInput>>
): CompanyLabState {
  if (state.isComplete) {
    throw new CompanyLabError(`会社経営統合テスト環境はすでに完了しています（${state.history.length}四半期分の実績があります）。`);
  }

  const definition = findScenarioDefinitionForCompanyLab(state.config.scenarioId);
  const turn = state.scenarioState.currentTurn;
  const decisions = fixtures.map((f) => {
    const d = decisionsByCompanyId[f.companyId];
    if (!d) throw new CompanyLabError(`会社 "${f.companyId}" の当期意思決定が指定されていません。`);
    try {
      validateSalesForceHeadcountBudget(d.salesPlans, f.salesForceHeadcountTotal);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new CompanyLabError(`会社 "${f.companyId}" の意思決定が不正です: ${message}`);
    }
    return applyAuthoritativeVapCapabilityScores(state, applyAuthoritativeSalesBaseScores(state, d));
  });

  // --- Phase2: シナリオ → 市場入力（industryLab/simulationRunner.tsと同じ手順） ---
  const scenarioTurnInput = getScenarioTurnInput(state.scenarioState, turn);
  const lastRecord = state.history[state.history.length - 1];
  const previousMarketContext = buildPreviousMarketContext(definition, turn, scenarioTurnInput, lastRecord?.marketResult);
  const baseMarketInput = toMarketQuarterInput(scenarioTurnInput, previousMarketContext);

  // --- 【SAI-5C/5E】市場別の商品ライフサイクル＋遅行需要＋PD⇔VAP代替
  // （opt-in。config.sai5未指定なら完全に従来経路） ---
  // 世界PD/VAP需要（プレミアム計算の入力）を「市場別消費×市場別ライフサイクル
  // 構成比」の合計で置き換える。市場全体の消費量そのものは一切変更しない
  // （構成比のみ＝総需要の二重計上なし）。同じ行列を成約側の対象需要按分
  // （turnInput.marketProductMix経由）にも渡し、プレミアム側と成約上限側の
  // 構成比の食い違いを構造的に防ぐ（market/productLifecycle.tsヘッダ参照）。
  // 【SAI-5E】(a) 前期末までの割安シグナル（affordability EWMA）が普及を前倒しし、
  // (b) 前期の実現プレミアム比に応じてPD⇔VAP間で構成比を限定的に移動する。
  // いずれも「前期実績→当期入力」の片方向で、当期内の循環はない。
  const sai5ReferencePremiumRatios = {
    pd: MARKET_PARAMETERS_V1.pdVapPremium.pdBasePremiumRatio,
    vap: MARKET_PARAMETERS_V1.pdVapPremium.vapBasePremiumRatio,
  } as const;
  // 【監査指摘B】当期の成約配分に実際に使うSalesParametersと、市場進化パラメータ。
  // 供給圧力の分母（addressable demand）は前者のexternalOptionWeightから導くため、
  // 両者が同じ値を参照することを1箇所で保証する。
  const salesParametersForThisQuarter: SalesParameters = salesParametersFor(state.config);
  const marketEvolutionParameters: MarketEvolutionParameters = state.config.sai5?.supplyPressureDefinition
    ? { ...MARKET_EVOLUTION_PARAMETERS_V1, supplyPressureDefinition: state.config.sai5.supplyPressureDefinition }
    : MARKET_EVOLUTION_PARAMETERS_V1;
  const appliedAdoptionTurnShift = state.config.sai5?.productLifecycle
    ? deriveAdoptionTurnShift(state.marketEvolutionState)
    : ({ pd: 0, vap: 0 } as const);
  let lifecycleMix: MarketProductMix | undefined;
  let substitutionShareShift = 0;
  if (state.config.sai5?.productLifecycle) {
    const shiftByMarket = Object.fromEntries(
      DEMAND_MARKET_IDS.map((m) => [m, { pd: appliedAdoptionTurnShift.pd, vap: appliedAdoptionTurnShift.vap }])
    ) as Readonly<Partial<Record<DemandMarketId, { pd: number; vap: number }>>>;
    const baseMix = computeMarketProductMix(turn, PRODUCT_LIFECYCLE_PARAMETERS_V1, shiftByMarket);
    const substitution = applyProductSubstitution(baseMix, lastRecord?.marketResult, sai5ReferencePremiumRatios);
    lifecycleMix = substitution.mix;
    substitutionShareShift = substitution.substitutionShareShift;
  }
  const lifecycleAdjustedMarketInput = lifecycleMix ? applyLifecycleDemandToMarketInput(baseMarketInput, lifecycleMix) : baseMarketInput;
  // 【SAI-5E】前期末までの供給圧力EWMAから導いた、当期のPD/VAPベースプレミアム
  // 比率の倍率（当期の契約単価への遡及は構造上ない。成約単価は成約時スナップショット）。
  const appliedPremiumRatioMultipliers = state.config.sai5?.supplyPremiumFeedback
    ? derivePremiumRatioMultipliers(state.marketEvolutionState)
    : ({ pd: 1, vap: 1 } as const);

  // --- 実装指示 §3: PD/VAP供給計画（会社の生産計画）の集計 → 市場入力への適用 ---
  const companyCountry = buildCompanyCountryMap(fixtures);
  const supplySignals = buildSupplySignalInputs(decisions, state.lastQuarterActualProduction);
  const marketInput = applyProductionSupplySignalsToMarketInput(lifecycleAdjustedMarketInput, supplySignals, companyCountry);

  // --- 【Phase 8F-1】消費国在庫・購買循環モデル: 当期の計画(実購買量が確定する前) ---
  // 市場価格形成（globalDemand.ts・hosoPricing.ts）は一切変更しない。ここで計算する
  // のは、(a) 対象需要を市場別に按分するウェイト（sales/marketAdapter.ts
  // deriveTargetDemandの既存priorPeriodConsumptionベース按分の置き換え）と、
  // (b) 前四半期の購買圧力・在庫逼迫度から導く当四半期の仕向市場価格係数
  // （既存のTurnOrchestratorParameters.destinationMarketPricingスロットへ渡すだけ。
  // 新しいスロットは追加しない）の2つだけである。
  const consumerMarketPlanning = planConsumerMarketQuarterTable(state.currentPeriod, state.consumerMarketState, marketInput.demandMarkets);
  const consumerMarketWeights = deriveMarketWeightsFromDesiredPurchase(consumerMarketPlanning);
  const lastConsumerMarketRecords = lastRecord?.consumerMarketRecords;
  const destinationMarketPricingForThisQuarter: DestinationMarketPriceCoefficientTable =
    lastConsumerMarketRecords && lastConsumerMarketRecords.length > 0
      ? deriveNextQuarterDestinationPriceCoefficients(
          consumerMarketRecordsToTable(lastConsumerMarketRecords),
          CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTS
        )
      : CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTS;

  // --- Phase1・Phase4・Phase5（既存turn/runner.tsをそのまま呼び出す） ---
  // 【Phase 6.3（実装指示 §5）】外部加工業者需要。5社の買付意向だけで
  // ベトナム国全体の加工需要を置き換えない。世界需要指数（需要市場の前期消費×
  // 景気指数の合計 / 基準値）と前期国内価格に決定論的に反応する。
  const worldDemandIndex =
    Object.values(marketInput.demandMarkets).reduce(
      (sum, m) => sum + unwrapUnit(m.priorPeriodConsumption) * m.economicIndex,
      0
    ) / REFERENCE_WORLD_CONSUMPTION_TONS;
  const externalIntent = calculateExternalProcessorIntent(
    {
      priorVietnamDomesticPrice: lastRecord ? unwrapUnit(lastRecord.marketResult.vietnamDomestic.price) : undefined,
      worldDemandIndex,
    },
    EXTERNAL_PROCESSOR_DEMAND_ASSUMPTIONS_V1
  );

  // --- 【Phase 8B-1 実装指示§5.8手順1〜3】期首の与信判断・調達制約 ---
  // 当期のturnResult（市場・生産実績）が確定する前に、前期末までの財務・資金繰り
  // 状態だけを使って、会社ごとに信用スコア・借入限度額・銀行審査を確定し
  // （planQuarterFinancing）、その承認結果と期首現金から、国内買付（即金支払）の
  // 希望数量・輸入発注可否を必要なら縮小する（computeProcurementConstraint）。
  // 縮小した数量は、既存のproduction/allocation.ts側の原料不足ロジックへそのまま
  // 渡すため、生産・在庫・契約履行・品質・会計への一貫した反映は既存構造にまかせる。
  const financingPlanByCompanyId = new Map<CompanyId, QuarterFinancingPlan>();
  const collateralByCompanyId = new Map<CompanyId, ReturnType<typeof buildCollateralInputFromCompanyLab>>();
  const procurementConstraintByCompanyId = new Map<CompanyId, ReturnType<typeof computeProcurementConstraint>>();
  // 【Phase 8B-2A】新規設備投資案件の承認判定に使う与信ゲート（実装指示§12。
  // 銀行の与信判断と同じ「前期末までの情報のみ」原則。当期のturnResultより前に
  // 確定するplan.borrowingCapacity・前期末までのfinancingHistoryだけで決める）。
  const capexApprovalGateByCompanyId = new Map<CompanyId, ProposalApprovalGate>();
  const fallbackExpectedDomesticPriceUsdPerKg = 2.5; // autoPolicy.tsのDEFAULT_EXPECTED_RAW_PRICE_USD_PER_KGと同じ暫定値（要校正）。

  for (const f of fixtures) {
    const prevFinance = state.financeState.companies.find((c) => c.companyId === f.companyId);
    const prevFinancingState = state.financingState.companies.find((c) => c.companyId === f.companyId);
    if (!prevFinance || !prevFinancingState) {
      throw new CompanyLabError(`会社 ${f.companyId} の財務・資金繰り状態が初期化されていません。`);
    }
    const decision = decisions.find((d) => d.companyId === f.companyId)!;
    const priorQuarterResult = lastRecord?.financialResults.find((r) => r.companyId === f.companyId);
    const collateral = buildCollateralInputFromCompanyLab({
      companyId: f.companyId,
      rawMaterialLotsAtStart: state.rawMaterialLots,
      prevFinanceState: prevFinance,
      priorQuarterResult,
    });
    collateralByCompanyId.set(f.companyId, collateral);

    const plan = planQuarterFinancing(
      {
        companyId: f.companyId,
        period: state.currentPeriod,
        prevFinanceState: prevFinance,
        prevFinancingState,
        priorQuarterResult,
        collateral,
        financingRequest: decision.financingRequest,
      },
      FINANCE_PARAMETERS_V1,
      FINANCING_PARAMETERS_V1
    );
    financingPlanByCompanyId.set(f.companyId, plan);
    capexApprovalGateByCompanyId.set(f.companyId, {
      borrowingCapacityFrozen: plan.borrowingCapacity.underwritingFrozen,
      severelyDistressed:
        prevFinancingState.history.lastFinancialHealth === "paymentDefault" || prevFinancingState.history.lastFinancialHealth === "insolvent",
    });

    const expectedDomesticPriceUsdPerKg = lastRecord ? unwrapUnit(lastRecord.marketResult.vietnamDomestic.price) : fallbackExpectedDomesticPriceUsdPerKg;
    const procurementConstraint = computeProcurementConstraint(
      {
        companyId: f.companyId,
        period: state.currentPeriod,
        originalDomesticPurchaseQuantityTons: unwrapUnit(decision.domesticPurchasePlan.desiredQuantity),
        expectedDomesticPriceUsdPerKg,
        prevCashUsd: unwrapUsd(prevFinance.cash),
        approvedNormalLoanDrawUsd: plan.underwriting.approvedAmountUsd,
        severeArrearsOrInsolvent: plan.borrowingCapacity.underwritingFrozen,
      },
      FINANCING_PARAMETERS_V1
    );
    procurementConstraintByCompanyId.set(f.companyId, procurementConstraint);
  }

  // --- 資金制約後の実行計画: 国内買付希望数量を縮小し、重大延滞・支払不能の会社は
  // 輸入発注も止める（決定した希望自体=decisionsは変更せず、turnInputへ渡す実行値
  // だけを別に作る。実装指示§5.11「計画値と実行値を区別」）。
  //
  // 【fix/v2-procurement-mix-after-emergency-maturity Step 2】自社養殖の池入れ計画
  // にも、国内買付と同じ資金制約スケール（constraint.scaleRatio）を適用する。
  // これまで自社養殖だけが資金制約を一切受けずに希望どおり実行されており、
  // 資金難の会社ほど自社養殖比率が不自然に高くなる（調達構成テストで検出された
  // VAPの68%依存）原因になっていた。新しい係数・下限フロアは追加せず、
  // 既存の scaleRatio をそのまま再利用する（将来の池入れ・収穫支出に対する
  // 財務能力の簡略的な代理指標として、国内買付と同じ計算を流用するだけ）。
  // scaleRatio=0（最大制約）の場合は池入れ量ゼロも許容する。輸入の二値遮断
  // ロジックは変更しない。養殖原料の現金支出タイミング（収穫時）も変更しない。
  const constrainedDecisions: CompanyDecisionInput[] = decisions.map((d) => {
    const constraint = procurementConstraintByCompanyId.get(d.companyId)!;
    return {
      ...d,
      domesticPurchasePlan: { ...d.domesticPurchasePlan, desiredQuantity: hosoEqTons(constraint.constrainedDomesticPurchaseQuantityTons) },
      importOrders: constraint.importOrdersBlocked ? [] : d.importOrders,
      aquacultureStockingPlans: d.aquacultureStockingPlans.map((plan) => ({
        ...plan,
        plannedStockingQuantity: hosoEqTons(roundHosoEqTons(unwrapUnit(plan.plannedStockingQuantity) * constraint.scaleRatio)),
      })),
    };
  });

  const turnInput: TurnOrchestratorInput = {
    currentPeriod: state.currentPeriod,
    marketInput,
    scenarioVariables: { diseasePressure: scenarioTurnInput.countries.VN.diseasePressure },
    salesPlans: decisions.flatMap((d) => d.salesPlans),
    domesticPurchaseIntentSource: {
      type: "companyPlans",
      plans: constrainedDecisions.map((d) => d.domesticPurchasePlan),
      externalIntent,
    },
    importOrders: constrainedDecisions.flatMap((d) => d.importOrders),
    aquacultureStockingPlans: constrainedDecisions.flatMap((d) => d.aquacultureStockingPlans),
    existingContracts: state.contracts,
    existingLots: state.rawMaterialLots,
    seed: state.config.seed,
    // 【Phase 8F-1】対象需要の市場別按分ウェイト（希望購買量ベース）と、
    // 前四半期の購買圧力・在庫逼迫度から導いた当四半期の仕向市場価格係数。
    marketWeights: consumerMarketWeights,
    // 【SAI-5C】市場×商品の需要構成比行列（undefinedなら従来の世界一律構成比）。
    marketProductMix: lifecycleMix,
    parameters: {
      destinationMarketPricing: destinationMarketPricingForThisQuarter,
      // 【SAI-5D】営業基盤ウェイト有効化版のSalesParameters（合計1.0を保った
      // 再配分。無効時はキー自体を渡さず、turn/runner.tsの既定
      // SALES_PARAMETERS_V1＝salesBaseウェイト0で従来と完全に同一）。
      ...(state.config.sai5?.salesBaseAccumulation ? { sales: salesParametersForThisQuarter } : {}),
      // 【SAI-5E】供給圧力フィードバック有効時のみ、PD/VAPベースプレミアム比率へ
      // 前期末stateの倍率を乗じたMarketParametersを渡す（市場モジュール内部は
      // 無変更。既存の稼働率倍率clamp・最低プレミアム床はそのまま機能する）。
      ...(state.config.sai5?.supplyPremiumFeedback
        ? {
            market: {
              ...MARKET_PARAMETERS_V1,
              pdVapPremium: {
                ...MARKET_PARAMETERS_V1.pdVapPremium,
                pdBasePremiumRatio: MARKET_PARAMETERS_V1.pdVapPremium.pdBasePremiumRatio * appliedPremiumRatioMultipliers.pd,
                vapBasePremiumRatio: MARKET_PARAMETERS_V1.pdVapPremium.vapBasePremiumRatio * appliedPremiumRatioMultipliers.vap,
              },
            },
          }
        : {}),
    },
  };
  const turnResult = runTurn(turnInput);

  // --- Phase6: 工場・ワーカー・生産・完成品在庫・契約履行 ---
  // 【Phase 8B-2B 実装指示§3.3】静的fixtureをmutation・蓄積せず、当該四半期の
  // 生産開始時点で利用可能な「前期末までのcapex状態」（state.capexState。当期の
  // capexクローズはこの後の§財務処理でまだ実行されていない）から、稼働開始済み
  // 案件ぶんの累計能力増加だけを毎期再導出してFactoryへ加算する。能力増加残高を
  // 別の永続状態として二重管理しない（capex/capacityEffect.ts参照）。
  const baseFactories = fixtures.flatMap((f) => f.factories);
  const factoriesWithCapexCapacity = applyCapexCapacityToFactories(baseFactories, state.capexState, state.currentPeriod);
  // 【Test15新設】稼働開始済みのnewFactoryConstruction案件ぶんの新設Factoryを
  // 追加する（既存工場への能力加算＝applyCapexCapacityToFactoriesとは独立した
  // 別処理。capex/factoryConstruction.ts参照）。この時点で追加されたFactoryが
  // 以降の生産エンジン・工場スペース・投資計画画面のすべてへ自動的に伝播する
  // （baseFactoriesではなくfactoriesWithCapexCapacityへ以降のすべての箇所が
  // 揃って接続されているため）。
  const factoriesWithCapex = applyNewFactoryConstructionToFactories(factoriesWithCapexCapacity, state.capexState, state.currentPeriod);
  // 【Test15新設・PD省人化投資】当四半期の実効PD係数の上書きは、必ず「前四半期末
  // までのPD稼働率」（state.pdMechanizationState）と「前四半期末までのcapex状態」
  // （state.capexState、上のfactoriesWithCapexCapacity算出と同じ基準）から算出する。
  // 当期の生産実績を当期の効果算出へ遡及させない（先読み禁止）。
  const pdCoefficientOverrideByFactoryId = buildPdCoefficientOverridesByFactory(state.capexState, state.pdMechanizationState, state.currentPeriod);
  const productionInput: ProductionQuarterInput = {
    factories: factoriesWithCapex,
    workerAssignments: decisions.flatMap((d) => d.workerAssignments),
    plans: decisions.flatMap((d) => d.productionPlans),
    companyCountry,
    pdCoefficientOverrideByFactoryId,
  };
  const { state: productionStateAfter, updatedRawMaterialLots } = advanceProductionQuarter(
    state.productionState,
    productionInput,
    turnResult.contracts,
    turnResult.lots,
    supplySignals
  );
  const productionRecord = productionStateAfter.history[productionStateAfter.history.length - 1];

  // --- 【Phase 7A】品質調整: Phase6の生産バッチ（saleableRecoveryRatio=1.00基準）へ、
  // 当期の操業リスク・重大品質事故から算出した品質結果を一度だけ適用する。
  // production/allocation.ts・batches.ts自体は一切書き換えず、Phase6が既に出力した
  // factoryLoadMetrics・batchesへの後段アダプターとして接続する（開発ルール
  // 「既存公開関数を不必要に書き換えず、アダプターと状態遷移で接続する」に従う）。
  const qualityAdjustmentInput: QualityAdjustmentInput = {
    batches: productionRecord.batches,
    factoryLoadMetrics: productionRecord.factoryLoadMetrics,
    factories: productionInput.factories,
    rampHistory: state.qualityState.rampHistory,
    overtimeRateCap: PRODUCTION_PARAMETERS_V1.labor.overtimeRateCap,
    period: state.currentPeriod,
    turn,
    gameSeed: state.config.seed,
  };
  const { adjustedBatches, adjustments, updatedRampHistory } = applyQualityToBatches(qualityAdjustmentInput);

  // --- 品質調整後のバッチから完成品ロットを再生成する（createFinishedGoodsLotsを
  // そのまま再利用。関数自体は書き換えない）。品質情報（観測品質スコア・格落ち率・
  // 重大事故ID）をロットへ付与し、後日の契約充当時に市場別の顧客信頼算出へ使う。
  const newFinishedGoodsLotsRaw = createFinishedGoodsLots(adjustedBatches, PRODUCTION_PARAMETERS_V1);
  const newFinishedGoodsLots = attachQualityInfoToFinishedGoodsLots(newFinishedGoodsLotsRaw, adjustedBatches, adjustmentsByBatchId(adjustments));
  const lotsAfterProduction = [...state.productionState.finishedGoodsLots, ...newFinishedGoodsLots];

  // --- 契約充当計画を、品質調整後のロットに対して再計算する
  // （planContractFulfillmentをそのまま再利用。Phase6内部で計算済みの、
  // 品質調整前のfulfillmentPlanは使わない）。
  //
  // 【バグ修正（fix/v2-procurement-mix-after-emergency-maturity）】期限切れ処理
  // （applyFinishedGoodsExpiryForQuarterEnd）は、当四半期の契約充当消費より前に
  // 適用してはならない。修正前は「期限切れ処理 → 消費」の順で、
  // fulfillmentPlanは期限切れ処理"前"のlotsAfterProductionを見て充当可能と
  // 判断したのに、実際の消費（consumeFinishedGoods）は期限切れ処理"後"の
  // 集合に対して行われていた。原料調達が枯渇するなどして新規生産がほぼ止まり、
  // 既存の完成品在庫だけで古い契約を充当し続けるシナリオでは、計画時点で
  // 「充当可能」と判定した数量が、消費実行までの間に期限切れで消えてしまい、
  // 過剰消費拒否（ProductionValidationError）でシミュレーション全体が停止する
  // （原料不足そのものではなく、期限切れ処理の順序が原因）。
  // 「四半期末の期限切れ」は文字どおり当四半期の契約充当が終わった後に、
  // 未使用のまま残った在庫にだけ適用されるべきものであり、消費より後に
  // 適用する順序へ修正する。
  const fulfillmentPlan: ContractFulfillmentPlan = planContractFulfillment(turnResult.contracts, lotsAfterProduction);

  // --- 契約履行の実適用（Phase4既存関数applyFulfillmentsをそのまま呼び出す） ---
  const contractsAfterFulfillment = applyFulfillments(turnResult.contracts, fulfillmentPlan.explicitInstructions);
  const nextPeriodValue = turnResult.pendingState.nextPeriod;
  const contractsAfterOverdue = updateContractStatusesForQuarterEnd(contractsAfterFulfillment, nextPeriodValue);

  // --- 完成品ロットの実消費（Phase6既存関数consumeFinishedGoodsをそのまま呼び出す）。
  // fulfillmentPlanが充当可能と判断した集合（lotsAfterProduction）に対して、
  // 期限切れ処理より前に実行する。 ---
  const finishedGoodsLotsAfterConsumption = consumeFinishedGoods(lotsAfterProduction, fulfillmentPlan.finishedGoodsConsumption);

  // --- 四半期末の期限切れ処理は、当四半期の契約充当消費が終わった後の残数量に
  // 対してのみ適用する（未使用のまま残った在庫だけが期限切れの対象になる）。
  const finishedGoodsLotsAfterExpiry = applyFinishedGoodsExpiryForQuarterEnd(finishedGoodsLotsAfterConsumption, state.currentPeriod);

  // --- 【Phase 7A】納期観測・顧客信頼観測 → 品質・信頼状態の更新 ---
  const companyMarketPairs = fixtures.flatMap((f) => DEMAND_MARKET_IDS.map((market) => ({ companyId: f.companyId, market })));
  const deliveryObservations = computeMarketDeliveryObservations(companyMarketPairs, contractsAfterOverdue, state.currentPeriod);
  const contractsById = new Map(turnResult.contracts.map((c) => [c.contractId, c]));
  // ロットの静的な属性（品質情報等）の参照専用ルックアップ。lotIdは消費・期限切れの
  // いずれでも不変のため、いずれの時点の集合から作っても同じ属性が引ける。
  const lotsById = new Map(lotsAfterProduction.map((l) => [l.lotId, l]));
  const trustObservations = computeMarketTrustObservations(fulfillmentPlan.usage, contractsById, lotsById, deliveryObservations);
  const qualityStateAfter: QualityReliabilityState = {
    qualityByCompanyProduct: updateQualityByCompanyProduct(state.qualityState.qualityByCompanyProduct, adjustments),
    trustByCompanyMarket: updateTrustByCompanyMarket(state.qualityState.trustByCompanyMarket, deliveryObservations, trustObservations),
    rampHistory: updatedRampHistory,
  };

  // 【監査指摘B/D】営業工数制約（applyMarketSalesEffortCapacity）で比例縮小された
  // 後の「実際に市場へ提示した数量」。供給圧力の分子（SAI-5E）と、営業基盤の
  // 成約充足率の分母（SAI-5D）は、どちらも成約配分が見た量と同じでなければならない。
  // 縮小前の希望量を使うと、市場に出していない量まで「売れ残り」「未達」として
  // 数えてしまう。
  const effortScaleByCompanyMarket = new Map(
    turnResult.salesRecord.salesEffortAdjustments.map((a) => [`${a.companyId}::${a.market}`, a.scaleFactor])
  );
  const effortAdjustedSalesPlans = decisions.flatMap((d) =>
    d.salesPlans.map((p) => {
      const scale = effortScaleByCompanyMarket.get(`${p.companyId}::${p.market}`) ?? 1;
      return scale === 1 ? p : { ...p, desiredQuantity: hosoEqTons(unwrapUnit(p.desiredQuantity) * scale) };
    })
  );

  // --- 【SAI-5D】営業基盤の四半期末更新（quality/trust状態と同じ位置＝当期の
  // 成約・履行・品質調整がすべて確定した後。当期の成約競争力に使われたのは
  // 前期末値のみであり、この更新値が効くのは次期から＝遡及なし）。無効時は
  // 従来どおりundefinedのまま持ち越す。 ---
  const salesBaseStateAfter = state.config.sai5?.salesBaseAccumulation
    ? updateSalesBaseState(
        state.salesBaseState,
        {
          salesPlans: effortAdjustedSalesPlans,
          allocations: turnResult.salesRecord.allocations,
          qualityAdjustments: adjustments,
          lifecycleMix,
        },
        fixtures.map((f) => f.companyId)
      )
    : state.salesBaseState;

  // --- 【SAI-5E】市場進化carry stateの四半期末更新（供給圧力EWMA・プレミアム
  // 倍率・割安シグナル）。productLifecycle/supplyPremiumFeedbackのどちらかが
  // 有効なら更新する（affordabilityシグナルはライフサイクル側の普及前倒しにも
  // 使うため）。無効時はundefinedのまま＝既存スナップショットと同一形状。 ---
  const sai5Active = Boolean(state.config.sai5?.productLifecycle) || Boolean(state.config.sai5?.supplyPremiumFeedback);
  let marketEvolutionStateAfter = state.marketEvolutionState;
  let sai5MarketEvolutionRecord: Sai5MarketEvolutionRecord | undefined;
  if (sai5Active) {
    // 【監査指摘B】分子は「実際に成約配分へ提示された数量」（営業工数制約適用後）。
    const offeredByProduct = { pd: 0, vap: 0 };
    for (const p of effortAdjustedSalesPlans) {
      if (p.product !== "pd" && p.product !== "vap") continue;
      offeredByProduct[p.product] += unwrapUnit(p.desiredQuantity);
    }
    // 【監査指摘B】分母は「全ベトナム対象需要」ではなく「5社が構造的に配分を
    // 受けられる需要（addressable demand）」を市場×商品ごとに積み上げる。
    // 各社の競争力ウェイトは当期の配分で実際に使われた値をそのまま用いる
    // （新たな推定・当てはめは行わない）。
    const externalOptionWeight = salesParametersForThisQuarter.externalOptionWeight;
    const targetDemandByProduct = { pd: 0, vap: 0 };
    const addressableDemandByProduct = { pd: 0, vap: 0 };
    const externalOptionQuantityByProduct = { pd: 0, vap: 0 };
    for (const alloc of turnResult.salesRecord.allocations) {
      if (alloc.product !== "pd" && alloc.product !== "vap") continue;
      const targetDemand = unwrapUnit(alloc.targetDemand);
      const totalCompanyWeight = alloc.companies.reduce((sum, c) => sum + c.competitivenessWeight, 0);
      targetDemandByProduct[alloc.product] += targetDemand;
      addressableDemandByProduct[alloc.product] += computeAddressableDemand(targetDemand, totalCompanyWeight, externalOptionWeight);
      externalOptionQuantityByProduct[alloc.product] += unwrapUnit(alloc.externalOptionQuantity);
    }
    const evolutionInputs = {
      offeredByProduct,
      targetDemandByProduct,
      addressableDemandByProduct,
      externalOptionQuantityByProduct,
      marketResult: turnResult.marketResult,
      referencePremiumRatios: sai5ReferencePremiumRatios,
    };
    marketEvolutionStateAfter = pushRecentAppliedMix(
      updateMarketEvolutionState(state.marketEvolutionState, evolutionInputs, marketEvolutionParameters),
      lifecycleMix
    );
    const prevEntry = state.marketEvolutionState ?? initialMarketEvolutionState();
    sai5MarketEvolutionRecord = {
      appliedPremiumRatioMultipliers,
      appliedAdoptionTurnShift,
      substitutionShareShift,
      ...(lifecycleMix ? { appliedMix: lifecycleMix } : {}),
      supplyPressureByProduct: {
        pd: computeRawSupplyPressure("pd", evolutionInputs, marketEvolutionParameters, prevEntry.pd.supplyRatioBaselineEwma).pressure,
        vap: computeRawSupplyPressure("vap", evolutionInputs, marketEvolutionParameters, prevEntry.vap.supplyRatioBaselineEwma).pressure,
      },
      supplyPressureEwmaByProduct: {
        pd: marketEvolutionStateAfter.pd.supplyPressureEwma,
        vap: marketEvolutionStateAfter.vap.supplyPressureEwma,
      },
      offeredByProduct,
      targetDemandByProduct,
      addressableDemandByProduct,
      externalOptionQuantityByProduct,
      supplyPressureDefinition: marketEvolutionParameters.supplyPressureDefinition,
    };
  }

  // --- 次期のPD/VAP供給シグナル用に、当期の実績生産量（品質調整後＝販売可能量）を会社×商品で集計する ---
  const lastQuarterActualProduction: Record<CompanyId, Record<Product, number>> = {};
  for (const f of fixtures) {
    const byProduct: Record<Product, number> = { hoso: 0, pd: 0, vap: 0 };
    for (const b of adjustedBatches.filter((b) => b.companyId === f.companyId)) {
      byProduct[b.product] += unwrapUnit(b.finishedGoodsQuantity);
    }
    lastQuarterActualProduction[f.companyId] = byProduct;
  }

  // --- 会社別サマリー・理由コードの構築 ---
  const globalReasonCodes = globalReasonCodesFromMarketDrivers(turnResult.marketResult.globalDrivers);
  const companySummaries = fixtures.map((f) => {
    const companyLoadMetrics = productionRecord.companyLoadMetrics.find((m) => m.companyId === f.companyId);
    const { summary } = buildCompanySummary(
      f,
      state.currentPeriod,
      decisions,
      turnResult.salesRecord.newContracts,
      state.contracts,
      contractsAfterOverdue,
      fulfillmentPlan.usage,
      turnResult.domesticAllocation,
      turnResult.salesRecord.allocations,
      turnResult.salesRecord.salesEffortAdjustments,
      turnResult.newImportLots,
      turnResult.arrivedImportLots,
      turnResult.newGrowingLots,
      turnResult.harvestedLots,
      updatedRawMaterialLots,
      productionRecord.allocation.entries,
      adjustedBatches,
      finishedGoodsLotsAfterExpiry,
      companyLoadMetrics,
      turnResult.aquacultureHarvestResults
    );
    const qualityFields = buildCompanyQualitySummary(f.companyId, adjustments, qualityStateAfter, deliveryObservations);
    return { ...summary, ...qualityFields };
  });

  // --- 【Phase 8A】財務決算: 当期の実績データ（履行・生産・品質・原料ロット・
  // 意思決定）から、会社別のPL/BS/CF・原価内訳・管理会計を生成し、財務状態を
  // 次期へ繰り越す。financeモジュールは実績の抽出・金額換算・会計処理のみを行い、
  // 販売量・生産量・廃棄量・価格の再計算は一切行わない。
  const nextFinanceCompanies: CompanyFinanceState[] = [];
  const financialResults: CompanyFinancialQuarterResult[] = [];
  // 【Phase 8B-1】資金繰り: 当期の実績が確定した後、実際に支払える利息・元本を
  // 算出し、緊急融資・延滞・支払不能判定を行う（financing/liquidityClose.ts
  // closeQuarterWithFinancing。二段呼び出しでclosefinancialQuarterを呼ぶため、
  // financeモジュールの会計処理を複製しない）。
  const nextFinancingCompanies: CompanyFinancingState[] = [];
  const financingResults: FinancingQuarterResult[] = [];
  // 【Phase 8B-2A】設備投資: financing決算確定後の現金を起点に、当期の
  // 案件承認・取消/再開・分割払いを処理し、finance/へ三段目のclosefinancialQuarter
  // 呼び出しで最終PL/BS/CFを確定する（capex/capexClose.ts closeQuarterWithCapex。
  // financingロジックは再計算せず、公開結果から再構成するだけ）。
  const nextCapexCompanies: CompanyCapexState[] = [];
  const capexResults: CapexQuarterResult[] = [];
  for (const f of fixtures) {
    const prevFinance = state.financeState.companies.find((c) => c.companyId === f.companyId);
    const prevFinancingState = state.financingState.companies.find((c) => c.companyId === f.companyId);
    const prevCapexState = state.capexState.companies.find((c) => c.companyId === f.companyId);
    if (!prevFinance || !prevFinancingState || !prevCapexState) {
      throw new CompanyLabError(`会社 ${f.companyId} の財務・資金繰り・設備投資状態が初期化されていません。`);
    }
    const companyLoad = productionRecord.companyLoadMetrics.find((m) => m.companyId === f.companyId);
    const companyDecision = decisions.find((d) => d.companyId === f.companyId);
    const actuals = buildCompanyQuarterBusinessActuals({
      companyId: f.companyId,
      period: state.currentPeriod,
      usage: fulfillmentPlan.usage,
      contracts: turnResult.contracts,
      adjustedBatches,
      // 【商品別実労務配分】productionRecord.allocation.entries（労働配分の実データ、
      // labor.assignedRegularHeadcount等）をfinance層へ橋渡しする。全社ぶんそのまま渡し、
      // companyLabAdapter.ts側でcompanyIdによる絞り込みとfactoryId+productの対応付けを行う。
      productionAllocationEntries: productionRecord.allocation.entries,
      qualityAdjustments: adjustments,
      newFinishedGoodsLots,
      allRawMaterialLotsAfterTurn: turnResult.lots,
      newImportLots: turnResult.newImportLots,
      harvestedLots: turnResult.harvestedLots,
      rawMaterialLotsAtStart: state.rawMaterialLots,
      rawMaterialLotsAtEnd: updatedRawMaterialLots,
      // 【バグ修正・上記の並び順修正に伴う変更】期限切れ処理は当四半期の消費より
      // 後に適用するため、「消費適用前」の正しいスナップショットは
      // lotsAfterProduction（品質調整後・当四半期の消費適用前）になる。
      finishedGoodsLotsBeforeConsumption: lotsAfterProduction,
      finishedGoodsLotsAtEnd: finishedGoodsLotsAfterExpiry,
      workerAssignments: companyDecision?.workerAssignments ?? [],
      appliedOvertimeRate: companyLoad ? unwrapUnit(companyLoad.overtimeRate) : 0,
      // 【Test15修正】f.factories（fixture静的）ではなくfactoriesWithCapex（当期の
      // 実効Factory[]。稼働開始済みのnewFactoryConstruction案件による新設Factoryを
      // 含む）を基準にする。新設Factoryはoperational（完成+操業準備期間経過）に
      // 達するまでfactoriesWithCapexへ一切現れない（applyNewFactoryConstructionToFactories
      // 参照）ため、この変更だけで「稼働開始後にのみactiveFactoryCountへ計上される」
      // という要件を満たす。既存のライン増設は主工場の能力を書き換えるだけで
      // Factory[]の要素数を変えないため、この変更はTest15以前の挙動と完全に一致する。
      activeFactoryCount: factoriesWithCapex.filter((factory) => factory.companyId === f.companyId && factory.status === "active").length,
      salesForceHeadcount: f.salesForceHeadcountTotal,
      procurementHeadcount: f.procurementHeadcountTotal,
      // 【Test15新設】会計計上（SG&A・キャッシュフロー）とVAP商品開発スコア更新の
      // 唯一の情報源。companyDecision.vapProductDevelopmentSpendUsdをそのまま渡す
      // （未設定時は0。ここで別の金額を作らない）。
      vapProductDevelopmentSpendUsd: companyDecision?.vapProductDevelopmentSpendUsd ?? 0,
    });
    const plan = financingPlanByCompanyId.get(f.companyId)!;
    const collateral = collateralByCompanyId.get(f.companyId)!;
    const procurementConstraint = procurementConstraintByCompanyId.get(f.companyId)!;
    // 【Phase 8B-2A】nextFinanceStateはfinancing決算確定後・設備投資前の中間状態
    // であり、この後のcapex三段目クローズが最終nextFinanceStateを再確定するため
    // 使わない（destructureしない。financeResultはcapexへの入力としてのみ使う）。
    const { financeResult, financingQuarterResult, nextFinancingState } = closeQuarterWithFinancing(
      {
        companyId: f.companyId,
        period: state.currentPeriod,
        prevFinanceState: prevFinance,
        prevFinancingState,
        actuals,
        plan,
        financingRequest: companyDecision!.financingRequest,
        collateralForEmergency: collateral,
      },
      FINANCE_PARAMETERS_V1,
      FINANCING_PARAMETERS_V1,
      PRODUCTION_PARAMETERS_V1.cost.baseProcessingCostUsdPerTon
    );
    // 調達制約（procurementConstraint）はrunner.ts側でのみ確定するため、
    // liquidityClose.tsが返すfinancingQuarterResultへ後付けで合成する
    // （closeQuarterWithFinancing自体は当期の国内買付縮小を知らない設計。§5.8参照）。
    financingResults.push({ ...financingQuarterResult, procurementConstraint });
    nextFinancingCompanies.push(nextFinancingState);

    // 【Phase 8B-2A】設備投資の三段目クローズ。financeResult（financing決算確定後・
    // 設備投資前の最終財務結果）を起点に、当期の案件処理と最終PL/BS/CFを確定する。
    const capexApprovalGate = capexApprovalGateByCompanyId.get(f.companyId)!;
    const { financeResult: finalFinanceResult, nextFinanceState: finalNextFinanceState, nextCapexState, capexQuarterResult } = closeQuarterWithCapex(
      {
        companyId: f.companyId,
        period: state.currentPeriod,
        prevFinanceState: prevFinance,
        actuals,
        financeResultBeforeCapex: financeResult,
        financingQuarterResult,
        beginningAccruedInterestPayableUsd: prevFinancingState.accruedInterestPayableUsd,
        prevCapexState,
        decision: companyDecision!.capexDecision,
        approvalGate: capexApprovalGate,
        // 【Phase 8D-3】工場スペースによる承認ゲート。当期の生産で実際に使った
        // factoriesWithCapex（＝稼働開始済み投資を反映済みのFactory。Test15で
        // 新設Factoryぶんも合成済み）を「稼働中設備の使用量」の基準にし、まだ
        // 稼働開始していない案件を予約量として数える。稼働中と予約が二重に
        // 数えられることはない（判定は isCapexProjectOperationalAt へ一元化されて
        // いるため）。【Test15の既知の制約】buildCompanyFactorySpaceStateは
        // baseFactories（fixture.factories、静的）とfactoryId一致でのみ工場
        // スペース状態を組み立てるため、fixtureに存在しない新設Factory自体の
        // スペース使用率はここには現れない（新設Factoryは既存工場のスペース
        // プールを消費しない設計。capex/factoryConstruction.ts参照。新設Factory
        // 自身のスペース状態表示は本タスクの範囲外・将来課題）。
        //
        // 【Phase 8D監査L-1・安全側の仕様（意図的、修正不要）】このスペース枠は
        // state.capexState（＝当四半期のcloseQuarterWithCapex呼び出しより前、
        // すなわち当四半期の取消要求がまだ適用されていない状態）から算出する。
        // そのため、同一四半期に取り消した案件のスペースは、その四半期の新規案件
        // 承認には反映されず（再利用できず）、翌四半期のこの算出からはじめて
        // 反映される。取消と新規承認を同時に行っても案件を過剰承認しない
        // 安全側の挙動であり、意図した仕様である（Phase 8D監査L-1）。
        factorySpaceBudget: buildFactorySpaceApprovalBudget(
          buildCompanyFactorySpaceState({
            companyId: f.companyId,
            baseFactories,
            currentFactories: factoriesWithCapex,
            capexState: state.capexState,
            period: state.currentPeriod,
          })
        ),
        // 【Test15新設】newFactoryConstruction提案の1社あたり工場数上限（4工場）判定に使う、
        // この会社の既存（静的fixture）工場数。capex/factoryConstruction.ts参照。
        existingFactoryCount: f.factories.length,
      },
      FINANCE_PARAMETERS_V1,
      CAPEX_PARAMETERS_V1,
      PRODUCTION_PARAMETERS_V1.cost.baseProcessingCostUsdPerTon
    );
    financialResults.push(finalFinanceResult);
    nextFinanceCompanies.push(finalNextFinanceState);
    nextCapexCompanies.push(nextCapexState);
    capexResults.push(capexQuarterResult);
  }
  const financeStateAfter: FinanceState = { companies: nextFinanceCompanies };
  const financingStateAfter: FinancingState = { companies: nextFinancingCompanies };
  const capexStateAfter: CapexState = { companies: nextCapexCompanies };

  // --- 【Phase 8F-1】消費国在庫・購買循環モデル: 実購買量確定後の決算 ---
  // (a) VNの実購買量＝5社の当期成約配分の実績合計（市場別、商品を問わず合算。
  //     本モデルは全商品合計のHOSO換算トンのみを扱う＝実装指示§4のスコープ）。
  const vnActualPurchaseByMarket = {} as Record<DemandMarketId, HosoEqTons>;
  for (const market of DEMAND_MARKET_IDS) {
    const totalForMarket = turnResult.salesRecord.allocations
      .filter((allocation) => allocation.market === market)
      .reduce((sum, allocation) => sum + allocation.companies.reduce((s, c) => s + unwrapUnit(c.allocatedQuantity), 0), 0);
    vnActualPurchaseByMarket[market] = hosoEqTons(totalForMarket);
  }
  // (b) 非VN原産国（EC/IN/ID）の世界配分需要・輸出可能供給量（既存のPhase1
  //     国際HOSO市場結果からそのまま読むだけ。新規の原産国別・市場別内訳は作らない。
  //     監査結果で特定したギャップへの最小限の設計判断、market/consumerInventory.ts
  //     computeActualPurchaseByMarketのコメント参照）。
  const nonVnOrigins = COUNTRY_IDS.filter((c) => c !== "VN").map((countryId) => ({
    allocatedDemandTons: unwrapUnit(turnResult.marketResult.hosoPrices[countryId].allocatedDemand),
    exportableSupplyTons: unwrapUnit(turnResult.marketResult.hosoPrices[countryId].exportableSupply),
  }));
  const desiredPurchaseByMarket = Object.fromEntries(
    DEMAND_MARKET_IDS.map((market) => [market, consumerMarketPlanning[market].desiredPurchaseTons])
  ) as Readonly<Record<DemandMarketId, HosoEqTons>>;
  const consumerMarketActualPurchase = computeActualPurchaseByMarket(
    consumerMarketWeights,
    desiredPurchaseByMarket,
    vnActualPurchaseByMarket,
    nonVnOrigins
  );
  const consumerMarketRecords: readonly ConsumerMarketQuarterRecord[] = DEMAND_MARKET_IDS.map((market) =>
    settleConsumerMarketQuarter(
      consumerMarketPlanning[market],
      consumerMarketActualPurchase[market],
      CONSUMER_MARKET_INVENTORY_PARAMETERS_V1[market]
    )
  );
  // 当四半期に確定した仕向市場参照価格（HOSOベース）を、次期のcarry stateの
  // 価格履歴へ追記する。全商品合計モデルのため、HOSO価格を市場ごとの単一の
  // 価格指標として使う（商品ミックスの重みは既存モデルに存在しないため、
  // 新規に架空の重みを作らずHOSOを代表値とする簡略化。実装指示§7「架空の複雑な
  // マクロモジュールは作らない」に沿う判断）。
  const marketReferencePricesThisQuarter = deriveVietnamMarketReferencePrices(turnResult.marketResult, destinationMarketPricingForThisQuarter);
  const consumerMarketStateAfter = {} as Record<DemandMarketId, ConsumerMarketCarryState>;
  for (const record of consumerMarketRecords) {
    const currentQuarterPrice = unwrapUnit(marketReferencePricesThisQuarter[record.market].hoso);
    consumerMarketStateAfter[record.market] = rollCarryStateForward(state.consumerMarketState[record.market], record, currentQuarterPrice);
  }

  const record: CompanyQuarterRecord = {
    turn,
    period: state.currentPeriod,
    decisions,
    marketInput,
    marketResult: turnResult.marketResult,
    salesRecord: turnResult.salesRecord,
    rawMaterialRequirements: turnResult.rawMaterialRequirements,
    domesticAllocation: turnResult.domesticAllocation,
    productionAllocation: productionRecord.allocation,
    batches: adjustedBatches,
    newFinishedGoodsLots,
    fulfillmentPlan,
    companyLoadMetrics: productionRecord.companyLoadMetrics,
    factoryLoadMetrics: productionRecord.factoryLoadMetrics,
    companySummaries,
    globalReasonCodes,
    turnDebug: turnResult.debug,
    qualityAdjustments: adjustments,
    qualityStateAfter,
    deliveryObservations,
    financialResults,
    financingResults,
    capexResults,
    consumerMarketRecords,
    // 【SAI-5E】市場進化の因果ログ（機能有効時のみ。optionalのため既存の
    // 履歴形状・persistence・SAI-3Bパーサーへの影響はない）。
    ...(sai5MarketEvolutionRecord ? { sai5MarketEvolution: sai5MarketEvolutionRecord } : {}),
  };

  const canAdvanceWithinScenario = turn < definition.durationTurns;
  const feedback: ScenarioTurnFeedback = { realizedMarketResult: turnResult.marketResult };
  const nextScenarioState = canAdvanceWithinScenario ? advanceScenarioTurn(state.scenarioState, feedback) : state.scenarioState;

  const history = [...state.history, record];
  const isComplete = turn >= state.config.turns || !canAdvanceWithinScenario;

  return {
    config: state.config,
    currentPeriod: nextPeriodValue,
    scenarioState: nextScenarioState,
    contracts: contractsAfterOverdue,
    rawMaterialLots: updatedRawMaterialLots,
    productionState: { ...productionStateAfter, finishedGoodsLots: finishedGoodsLotsAfterExpiry },
    lastQuarterActualProduction,
    qualityState: qualityStateAfter,
    ...(salesBaseStateAfter ? { salesBaseState: salesBaseStateAfter } : {}),
    ...(marketEvolutionStateAfter ? { marketEvolutionState: marketEvolutionStateAfter } : {}),
    financeState: financeStateAfter,
    financingState: financingStateAfter,
    capexState: capexStateAfter,
    // 【Phase 8D-4】次期へ繰り越すWorker総人数は、当期にエンジンが実際に使った
    // WorkerAssignment の絶対人数そのもの。UI側の増減計算とずれないよう、
    // 差分を足し直すのではなく「実際に動かした人数」を保存する。
    workforceState: deriveNextWorkforceState(
      state.workforceState ?? buildInitialWorkforceState(fixtures),
      fixtures,
      new Map(decisions.map((d) => [d.companyId, d.workerAssignments]))
    ),
    // 【Test15新設】次期へ繰り越すFactory単位のPD稼働率。当四半期に確定した
    // 実績（factoriesWithCapex・productionRecord.batches）から算出する。ここで
    // 算出した値は「次期の」pdCoefficientOverrideByFactoryId算出でのみ読まれ、
    // 当期の効果算出（既にproductionInput構築前に終わっている）には遡及しない。
    pdMechanizationState: deriveNextPdMechanizationState(
      state.pdMechanizationState,
      factoriesWithCapex,
      computeCurrentQuarterPdUtilizationByFactory(factoriesWithCapex, productionRecord.batches)
    ),
    // 【Test15新設】次期へ繰り越すVAP商品開発スコア。当四半期のdecisions（会計計上と
    // 同一のvapProductDevelopmentSpendUsd）から算出する。今期の効果算出
    // （applyAuthoritativeVapCapabilityScores呼び出し）は既に本関数の先頭で
    // state.productDevelopmentState（前四半期末までの値）だけを使って終わっている
    // ため、ここでの更新が今期の成約へ遡及することはない。
    productDevelopmentState: updateProductDevelopmentState(
      state.productDevelopmentState,
      new Map(decisions.map((d) => [d.companyId, d.vapProductDevelopmentSpendUsd ?? 0])),
      fixtures.map((f) => f.companyId)
    ),
    // 【Phase 8F-1】次期へ繰り越す市場別の消費国在庫carry state。
    consumerMarketState: consumerMarketStateAfter,
    history,
    isComplete,
  };
}

/** 全社を暫定自動方針で動かして最後まで一括実行する。 */
export function runCompanyLabWithAutoPolicyForAllCompanies(
  config: CompanyLabConfig,
  decisionProvider: (fixture: CompanyFixture, ownState: CompanyOwnState, publicInfo: PublicMarketInfo, period: PeriodV2, turn: number) => CompanyDecisionInput
): CompanyLabResult {
  const { state: initialState, fixtures } = initializeCompanyLab(config);
  let state = initialState;
  while (!state.isComplete) {
    const publicInfo = buildPublicMarketInfo(state);
    const decisionsByCompanyId: Record<CompanyId, CompanyDecisionInput> = {};
    for (const f of fixtures) {
      const ownState = buildCompanyOwnState(state, f);
      decisionsByCompanyId[f.companyId] = decisionProvider(f, ownState, publicInfo, state.currentPeriod, state.scenarioState.currentTurn);
    }
    state = advanceCompanyLabQuarter(state, fixtures, decisionsByCompanyId);
  }
  return { config: state.config, companies: fixtures, history: state.history };
}
