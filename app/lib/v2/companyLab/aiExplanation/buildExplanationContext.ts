// ShrimpX V2 — Standard AI経営説明レポート機能 Claude入力コンテキスト組み立て（MVP）
//
// 【目的・安全境界】Standard AIが計算した意思決定（診断情報つき）を、Claudeへ渡して
// よいALLOWLIST済みの範囲だけへ絞り込む、副作用のない純粋関数。
//   - 入力は app/v2/company-lab/play/_lib/viewModel.ts の PlayerScreenViewModel が
//     既に画面へ渡している範囲（fixture・ownState・publicInfo・diagnostics）だけに
//     限定する。他社の非公開データ・生のCompanyLabState・履歴全体は、この関数の
//     入力型（ExplanationContextInput）にそもそも存在しないため、構造的に混入できない。
//   - すべての数量・金額フィールドは number | null。「データが無い」ことを裸の0で
//     表現しない（NO_VALUE_TEXTと同じ規約。0は「実際に0件・0トン」の場合のみ使う）。
//   - publicInfo.vietnamDomesticPriorPrice は turn1では実際には存在しない価格を
//     表す副作用的な0であるため、publicInfo.lastMarketResult === undefined の場合は
//     この関数は当該フィールドを一切参照せず、必ずnull + dataLimitationNoteで表現する。
//   - Standard AIの決定・診断エントリ（diagnostics.decision / diagnostics.entries）は
//     「AI自身が今回の提案について持つ理由付け」そのものであるため、フィールド名を
//     維持したまま素通しする（新しい計算・変更は一切行わない）。

import { PeriodV2, toYearQuarter } from "../../core/period";
import { DemandMarketId, Product } from "../../market/types";
import { CompanyDecisionInput, CompanyFixture, CompanyOwnState, PublicMarketInfo } from "../types";
import { StandardAiDiagnosticEntry } from "../standardAi/reasonCodes";
import { StandardAiQuarterDiagnostics } from "../standardAi/policy";
import {
  computeBacklogByMarketProduct,
  computeFactoryCapacitySummaries,
  computeLaborProductivityByProduct,
  computeOpeningBalanceSheetSummary,
  computeSalesForceCapacitySummary,
  groupRawMaterialLotsByAvailability,
} from "../openingStateSummary";
import { buildLifecycleTrendRows, buildSupplyPressureRows, LifecycleTrendRow, SupplyPressureRow } from "../aiMarketInfoSummary";
import { getExplanationModelConfig } from "./claudeClient";
import { EXPLANATION_PROMPT_VERSION } from "./systemPrompt";

/** このExplanationContextの構造バージョン。フィールドの追加・削除・意味変更のたびに上げる。 */
export const EXPLANATION_CONTEXT_SCHEMA_VERSION = 1;

export interface ExplanationContextIdentity {
  readonly labId: string;
  readonly companyId: string;
  readonly turn: number;
  readonly year: number;
  readonly quarter: number;
  readonly scenarioId: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly contextSchemaVersion: number;
}

export interface ExplanationContextBalanceSheet {
  readonly cashUsd: number;
  readonly totalAssetsUsd: number;
  readonly totalLiabilitiesUsd: number;
  readonly totalEquityUsd: number;
  readonly receivablesUsd: number;
  readonly receivablesCount: number;
  readonly payablesUsd: number;
  readonly payablesCount: number;
  readonly shortTermLoansUsd: number;
  readonly longTermLoansUsd: number;
  readonly accruedInterestPayableUsd: number;
  readonly activeLoanCount: number;
}

export interface ExplanationContextBacklogEntry {
  readonly market: DemandMarketId;
  readonly product: Product;
  readonly outstandingTons: number;
  readonly contractCount: number;
  readonly nearestDueDateLabel: string;
}

export interface ExplanationContextRawMaterialGroup {
  readonly availableFromLabel: string;
  readonly quantityTons: number;
  readonly lotCount: number;
}

export interface ExplanationContextFactoryCapacity {
  readonly factoryId: string;
  readonly nominal: Readonly<Record<string, number>>;
  readonly effective: Readonly<Record<string, number>>;
}

export interface ExplanationContextLaborProductivity {
  readonly factoryId: string;
  readonly product: Product;
  readonly tonsPerRegularWorker: number;
}

export interface ExplanationContextWorkforce {
  readonly totalRegularHeadcount: number;
  readonly byFactory: readonly { readonly factoryId: string; readonly regularHeadcount: number }[];
}

export interface ExplanationContextSalesForce {
  readonly headcountTotal: number;
  readonly coverageScore: number;
  readonly currentProcessingCapacityTons: number;
}

export interface ExplanationContextOwnState {
  readonly balanceSheet: ExplanationContextBalanceSheet;
  readonly contractBacklog: readonly ExplanationContextBacklogEntry[];
  readonly rawMaterialInventory: {
    readonly totalTons: number;
    readonly groups: readonly ExplanationContextRawMaterialGroup[];
  };
  readonly finishedGoodsInventoryUsd: number;
  readonly factoryCapacity: readonly ExplanationContextFactoryCapacity[];
  readonly laborProductivity: readonly ExplanationContextLaborProductivity[];
  readonly workforce: ExplanationContextWorkforce;
  readonly salesForce: ExplanationContextSalesForce;
  readonly qualityScoreByProduct: Readonly<Partial<Record<Product, number>>>;
  readonly customerTrustByMarket: Readonly<Partial<Record<DemandMarketId, number>>>;
  readonly deliveryReliabilityByMarket: Readonly<Partial<Record<DemandMarketId, number>>>;
}

export interface ExplanationContextMarketInfo {
  readonly hasPriorMarketData: boolean;
  /** turn1等、前四半期データが存在しない場合の説明。値が無い理由をClaudeへ明示するためのもの。 */
  readonly dataLimitationNote: string | null;
  /** 【安全対策】publicInfo.vietnamDomesticPriorPriceはturn1では意味を持たない副作用的な0のため、
   *  hasPriorMarketData=falseのときは必ずnull（0を代入しない）。 */
  readonly vietnamDomesticPriorPriceUsd: number | null;
  readonly lifecycleTrends: readonly LifecycleTrendRow[] | null;
  readonly supplyPressure: readonly SupplyPressureRow[] | null;
}

export interface ExplanationContextStandardAi {
  /** Standard AIが当四半期に提出した意思決定そのもの（素通し。再計算・変更なし）。 */
  readonly decision: CompanyDecisionInput;
  /** Standard AIの診断エントリ一覧（理由コード・鍵となる入力値・閾値・メッセージ）。素通し。 */
  readonly diagnosticEntries: readonly StandardAiDiagnosticEntry[];
}

export interface ExplanationContext {
  readonly identity: ExplanationContextIdentity;
  readonly ownState: ExplanationContextOwnState;
  readonly marketInfo: ExplanationContextMarketInfo;
  readonly standardAi: ExplanationContextStandardAi;
}

export interface ExplanationContextInput {
  readonly labId: string;
  readonly companyId: string;
  readonly turn: number;
  readonly period: PeriodV2;
  readonly scenarioId: string;
  readonly fixture: CompanyFixture;
  readonly ownState: CompanyOwnState;
  readonly publicInfo: PublicMarketInfo;
  readonly diagnostics: StandardAiQuarterDiagnostics;
}

function buildOwnStateContext(fixture: CompanyFixture, ownState: CompanyOwnState): ExplanationContextOwnState {
  const bs = computeOpeningBalanceSheetSummary(ownState);
  const backlog = computeBacklogByMarketProduct(ownState.contracts, ownState.companyId);
  const rawMaterialGroups = groupRawMaterialLotsByAvailability(ownState.rawMaterialLots, ownState.companyId);
  const factoryCapacity = computeFactoryCapacitySummaries(fixture.factories);
  const laborProductivity = computeLaborProductivityByProduct(fixture.workerBaseline);
  const salesForce = computeSalesForceCapacitySummary(fixture.salesForceHeadcountTotal);

  const workforceByFactory = ownState.workforceState.factories.map((f) => ({
    factoryId: f.factoryId,
    regularHeadcount: f.regularHeadcount,
  }));
  const totalRegularHeadcount = workforceByFactory.reduce((sum, f) => sum + f.regularHeadcount, 0);

  return {
    balanceSheet: {
      cashUsd: bs.cashUsd,
      totalAssetsUsd: bs.totalAssetsUsd,
      totalLiabilitiesUsd: bs.totalLiabilitiesUsd,
      totalEquityUsd: bs.totalEquityUsd,
      receivablesUsd: bs.receivablesUsd,
      receivablesCount: ownState.financeState.receivables.length,
      payablesUsd: bs.payablesUsd,
      payablesCount: ownState.financeState.payables.length,
      shortTermLoansUsd: bs.shortTermLoansUsd,
      longTermLoansUsd: bs.longTermLoansUsd,
      accruedInterestPayableUsd: bs.accruedInterestPayableUsd,
      activeLoanCount: ownState.financingState.loanPortfolio.loans.filter((l) => l.status !== "closed").length,
    },
    contractBacklog: backlog.map((b) => ({
      market: b.market,
      product: b.product,
      outstandingTons: b.outstandingTons,
      contractCount: b.contractCount,
      nearestDueDateLabel: b.nearestDueDateLabel,
    })),
    rawMaterialInventory: {
      totalTons: rawMaterialGroups.reduce((sum, g) => sum + g.quantityTons, 0),
      groups: rawMaterialGroups.map((g) => ({
        availableFromLabel: g.availableFromLabel,
        quantityTons: g.quantityTons,
        lotCount: g.lotCount,
      })),
    },
    finishedGoodsInventoryUsd: bs.finishedGoodsInventoryUsd,
    factoryCapacity: factoryCapacity.map((c) => ({
      factoryId: c.factoryId,
      nominal: { ...c.nominal },
      effective: { ...c.effective },
    })),
    laborProductivity: laborProductivity.map((p) => ({
      factoryId: p.factoryId,
      product: p.product,
      tonsPerRegularWorker: p.tonsPerRegularWorker,
    })),
    workforce: { totalRegularHeadcount, byFactory: workforceByFactory },
    salesForce: {
      headcountTotal: salesForce.headcountTotal,
      coverageScore: salesForce.coverageScore,
      currentProcessingCapacityTons: salesForce.currentProcessingCapacityTons,
    },
    qualityScoreByProduct: numberRecordOf(ownState.qualityScoreByProduct),
    customerTrustByMarket: numberRecordOf(ownState.customerTrustByMarket),
    deliveryReliabilityByMarket: numberRecordOf(ownState.deliveryReliabilityByMarket),
  };
}

/** Score0to100等のbrand付き数値レコードを、プレーンなnumberレコードへ変換する（値そのものは変えない）。 */
function numberRecordOf<K extends string>(record: Readonly<Partial<Record<K, unknown>>>): Readonly<Partial<Record<K, number>>> {
  const result: Partial<Record<K, number>> = {};
  for (const key of Object.keys(record) as K[]) {
    const value = record[key];
    if (value !== undefined) {
      result[key] = value as number;
    }
  }
  return result;
}

function buildMarketInfoContext(publicInfo: PublicMarketInfo): ExplanationContextMarketInfo {
  const hasPriorMarketData = publicInfo.lastMarketResult !== undefined;

  const lifecycleTrends = publicInfo.productLifecycleOutlook ? buildLifecycleTrendRows(publicInfo.productLifecycleOutlook) : null;
  const supplyPressure = publicInfo.productSupplyPressureOutlook ? buildSupplyPressureRows(publicInfo.productSupplyPressureOutlook) : null;

  if (!hasPriorMarketData) {
    return {
      hasPriorMarketData: false,
      dataLimitationNote:
        "この四半期はターン1（初回）のため、前四半期の市場実績データはまだ存在しません。ベトナム国内相場の前期実勢価格・前期市場結果は未取得です。",
      // 【安全対策】publicInfo.vietnamDomesticPriorPriceはturn1では実在する価格ではなく
      // 副作用的な0であるため、ここでは絶対に参照・転記しない。
      vietnamDomesticPriorPriceUsd: null,
      lifecycleTrends,
      supplyPressure,
    };
  }

  return {
    hasPriorMarketData: true,
    dataLimitationNote: null,
    vietnamDomesticPriorPriceUsd: publicInfo.vietnamDomesticPriorPrice,
    lifecycleTrends,
    supplyPressure,
  };
}

/**
 * ExplanationContextInput（PlayerScreenViewModelの許可された部分集合＋識別情報）から、
 * Claudeへ渡してよいALLOWLIST済みのExplanationContextを組み立てる。
 */
export function buildExplanationContext(input: ExplanationContextInput): ExplanationContext {
  const { year, quarter } = toYearQuarter(input.period);
  const modelConfig = getExplanationModelConfig();

  return {
    identity: {
      labId: input.labId,
      companyId: input.companyId,
      turn: input.turn,
      year,
      quarter,
      scenarioId: input.scenarioId,
      model: modelConfig.model,
      promptVersion: EXPLANATION_PROMPT_VERSION,
      contextSchemaVersion: EXPLANATION_CONTEXT_SCHEMA_VERSION,
    },
    ownState: buildOwnStateContext(input.fixture, input.ownState),
    marketInfo: buildMarketInfoContext(input.publicInfo),
    standardAi: {
      decision: input.diagnostics.decision,
      diagnosticEntries: input.diagnostics.entries,
    },
  };
}
