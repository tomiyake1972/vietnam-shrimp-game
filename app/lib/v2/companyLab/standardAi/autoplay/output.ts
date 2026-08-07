// ShrimpX V2 — Phase SAI-3A: 判断記録基盤 — ファイル出力整形（純粋関数のみ）
//
// 【方針】ここではファイルI/O（fs書き込み）を一切行わない。AutoplayBatchResult /
// AutoplayRunManifestを受け取り、書き込むべき「ファイル内容の文字列」を返すだけの
// 純粋関数群。実際のfs.writeFileSync呼び出しはCLI層（cli/runCli.ts・
// scripts/sai3aAutoplay.ts）が担当する（既存companyLab/cli/output.tsの
// 「計算は一切行わず整形のみ」という方針を踏襲）。
//
// 巨大な一つのJSONにはしない（三宅さんの指示§7）。用途別に分割する:
//   manifest.json          — 実行条件（再現性のためのマニフェスト）
//   case-summary.csv        — 1社×1seedぶんの最終集計（5社×12seedなら60行）
//   quarter-summary.csv      — 会社×seed×turnぶんの開始状態＋結果の主要スカラー値
//   decision-trace.jsonl     — 会社×seed×turnぶんの「開始状態→希望→最終決定→
//                              市場別販売数量トレース→結果」を1行1JSONで保持する
//                              唯一の完全な記録（SAI-3Bの主要な入力）
//   adjustment-trace.csv     — 希望→最終決定までの全調整エントリ（before/after/delta/reason code）
//   warnings.csv             — 四半期結果に記録された理由コード（reasonCodes）の一覧
//   run-summary.json         — run全体の集計＋失敗ケースの診断情報

import {
  AdjustmentTraceEntry,
  AutoplayRunManifest,
  CaseSummaryRow,
  MarketAllocationTraceEntry,
  QuarterDecisionLog,
  QuarterResultLog,
  QuarterStartState,
  RunSummary,
  SalesQuantityTraceEntry,
} from "./schema";
import { AutoplayBatchResult } from "./runBatch";

// SAI-3B-2で追加。market/typesのProduct/DemandMarketIdは固定・少数の集合
// （hoso/pd/vap、CN/US/EU/JP/OTHER）であるため、CSV列として安全に列展開できる
// （任意のキー集合を持つRecordを無理に列展開すると将来の市場追加等で破綻するが、
// 本リストは既存のmarket/types.tsの型定義そのものであり、新しい判定・新しい
// 分類を導入するものではない）。
const SAI3B2_PRODUCTS: readonly string[] = ["hoso", "pd", "vap"];
const SAI3B2_MARKETS: readonly string[] = ["CN", "US", "EU", "JP", "OTHER"];

function csvEscape(value: string | number | boolean): string {
  const s = String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(header: readonly string[], rows: ReadonlyArray<readonly (string | number | boolean)[]>): string {
  const lines = [header.map(csvEscape).join(",")];
  for (const row of rows) lines.push(row.map(csvEscape).join(","));
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------
// manifest.json
// ---------------------------------------------------------------------

export function formatManifestJson(manifest: AutoplayRunManifest): string {
  return JSON.stringify(manifest, null, 2) + "\n";
}

// ---------------------------------------------------------------------
// case-summary.csv
// ---------------------------------------------------------------------

const CASE_SUMMARY_CSV_HEADER: readonly string[] = [
  "seed",
  "companyId",
  "completedTurns",
  "requestedTurns",
  "completed",
  "cumulativeRevenueUsd",
  "cumulativeGrossProfitUsd",
  "cumulativeOperatingProfitUsd",
  "cumulativeSalesForceCostUsd",
  "finalCashUsd",
  "finalLoansUsd",
  "finalAvailableAdditionalCapacityUsd",
  "paymentDefaultEverByRequestedTurns",
  "paymentDefaultFirstTurn",
  "underwritingFrozenEverByRequestedTurns",
  "underwritingFrozenFirstTurn",
  "topReasonCodes",
  "warningCount",
];

function caseSummaryRowToCsv(r: CaseSummaryRow): readonly (string | number | boolean)[] {
  return [
    r.seed,
    r.companyId,
    r.completedTurns,
    r.requestedTurns,
    r.completed,
    r.cumulativeRevenueUsd,
    r.cumulativeGrossProfitUsd,
    r.cumulativeOperatingProfitUsd,
    r.cumulativeSalesForceCostUsd,
    r.finalCashUsd,
    r.finalLoansUsd,
    r.finalAvailableAdditionalCapacityUsd,
    r.paymentDefaultEverByRequestedTurns,
    r.paymentDefaultFirstTurn ?? "",
    r.underwritingFrozenEverByRequestedTurns,
    r.underwritingFrozenFirstTurn ?? "",
    r.topReasonCodes.join("|"),
    r.warningCount,
  ];
}

export function formatCaseSummaryCsv(batch: AutoplayBatchResult): string {
  const rows = batch.caseLogs.flatMap((log) => log.caseSummaryRows.map(caseSummaryRowToCsv));
  return toCsv(CASE_SUMMARY_CSV_HEADER, rows);
}

// ---------------------------------------------------------------------
// quarter-summary.csv — 会社×seed×turnの開始状態＋結果の主要スカラー値
// （SAI-3B-2で列を追加。品質・顧客信頼・納期信頼性・生産/販売数量の商品/市場別
//  内訳は、対応するキー集合（Product=hoso/pd/vap、DemandMarketId=CN/US/EU/JP/OTHER）
//  が固定・少数であるため、列展開してCSVへ含める。値が存在しない場合は空欄とし、
//  0へ変換しない。pressures等、キー集合が可変・非構造の値は引き続き
//  decision-trace.jsonl側の完全な記録のみを参照する）。
// ---------------------------------------------------------------------

const QUARTER_SUMMARY_CSV_HEADER: readonly string[] = [
  "seed",
  "companyId",
  "turn",
  "period",
  // A: 開始時状態
  "startCashUsd",
  "startShortTermLoansUsd",
  "startLongTermLoansUsd",
  "startAvailableAdditionalCapacityUsd",
  "startCreditTier",
  "startCreditScore0to100",
  "startFinancialHealthTier",
  "startPaymentDefault",
  "startUnderwritingFrozen",
  "startRawMaterialInventoryHosoEqTons",
  "startFinishedGoodsInventoryHosoEqTons",
  "startSalesForceHeadcountTotal",
  // 参考値（会社全人員を単一市場に集中投入したと仮定した能力。QuarterStartState
  // 側のコメント参照。市場別配分に基づく実際の能力とは一致しないことがある）。
  "startSalesEffortCapacityHosoEqTonsReference",
  // E: 結果
  "netRevenueUsd",
  "grossProfitUsd",
  "operatingProfitUsd",
  "netIncomeUsd",
  "closingCashUsd",
  "endingShortTermLoansUsd",
  "endingLongTermLoansUsd",
  "endingAvailableAdditionalCapacityUsd",
  // 当四半期に実際に使われた市場別営業人員配分から積み上げた、営業工数換算の
  // 能力・使用量（単位は営業工数換算トン。物理数量の単純合計ではない）。
  "salesEffortCapacityHosoEqTonsActual",
  "salesEffortUsedHosoEqTons",
  "salesEffortUtilizationRate",
  "salesReductionFromEffortConstraintHosoEqTons",
  "rawMaterialInventoryHosoEqTons",
  "finishedGoodsInventoryHosoEqTons",
  "discardQuantityHosoEqTons",
  // --- SAI-3B-2で追加（すべてbuildQuarterResultLogで既に計算済みだった値。
  //     以前はここに列挙されておらずファイル出力から漏れていただけであり、
  //     新しい計算は一切加えていない）。 ---
  "operatingCashFlowUsd",
  "investingCashFlowUsd",
  "financingCashFlowUsd",
  "downgradeQuantityHosoEqTons",
  "newContractedQuantityHosoEqTons",
  "fulfilledQuantityHosoEqTons",
  "outstandingQuantityHosoEqTons",
  "overdueQuantityHosoEqTons",
  ...SAI3B2_PRODUCTS.map((p) => `productionQuantityHosoEqTons_${p}`),
  ...SAI3B2_PRODUCTS.map((p) => `salesQuantityHosoEqTons_${p}`),
  ...SAI3B2_MARKETS.map((m) => `customerTrustAtEnd_${m}`),
  ...SAI3B2_PRODUCTS.map((p) => `qualityScoreAtEnd_${p}`),
  ...SAI3B2_MARKETS.map((m) => `deliveryReliabilityAtEnd_${m}`),
  "paymentDefault",
  "paymentDefaultNewlyTriggered",
  "underwritingFrozen",
  "underwritingFrozenNewlyTriggered",
  "warningCount",
];

export function formatQuarterSummaryCsv(batch: AutoplayBatchResult): string {
  const rows: (string | number | boolean)[][] = [];
  for (const log of batch.caseLogs) {
    const startByKey = new Map<string, QuarterStartState>();
    for (const s of log.quarterStartStates) startByKey.set(`${s.companyId}::${s.turn}`, s);
    for (const r of log.quarterResults) {
      const start = startByKey.get(`${r.companyId}::${r.turn}`);
      rows.push([
        log.seed,
        r.companyId,
        r.turn,
        r.period,
        start?.cashUsd ?? "",
        start?.shortTermLoansUsd ?? "",
        start?.longTermLoansUsd ?? "",
        start?.availableAdditionalCapacityUsd ?? "",
        start?.creditTier ?? "",
        start?.creditScore0to100 ?? "",
        start?.financialHealthTier ?? "",
        start?.paymentDefault ?? "",
        start?.underwritingFrozen ?? "",
        start?.rawMaterialInventoryHosoEqTons ?? "",
        start?.finishedGoodsInventoryHosoEqTons ?? "",
        start?.salesForceHeadcountTotal ?? "",
        start?.salesEffortCapacityHosoEqTons ?? "",
        r.netRevenueUsd,
        r.grossProfitUsd,
        r.operatingProfitUsd,
        r.netIncomeUsd,
        r.closingCashUsd,
        r.shortTermLoansUsd,
        r.longTermLoansUsd,
        r.availableAdditionalCapacityUsd,
        r.salesEffortCapacityHosoEqTons,
        r.salesEffortUsedHosoEqTons,
        r.salesEffortCapacityHosoEqTons > 0 ? r.salesEffortUsedHosoEqTons / r.salesEffortCapacityHosoEqTons : "",
        r.salesReductionFromEffortConstraintHosoEqTons,
        r.rawMaterialInventoryHosoEqTons,
        r.finishedGoodsInventoryHosoEqTons,
        r.discardQuantityHosoEqTons,
        r.operatingCashFlowUsd,
        r.investingCashFlowUsd,
        r.financingCashFlowUsd,
        r.downgradeQuantityHosoEqTons,
        r.newContractedQuantityHosoEqTons,
        r.fulfilledQuantityHosoEqTons,
        r.outstandingQuantityHosoEqTons,
        r.overdueQuantityHosoEqTons,
        ...SAI3B2_PRODUCTS.map((p) => r.productionQuantityByProduct[p] ?? ""),
        ...SAI3B2_PRODUCTS.map((p) => r.salesQuantityByProduct[p] ?? ""),
        ...SAI3B2_MARKETS.map((m) => r.customerTrustByMarket[m] ?? ""),
        ...SAI3B2_PRODUCTS.map((p) => r.qualityScoreByProduct[p] ?? ""),
        ...SAI3B2_MARKETS.map((m) => r.deliveryReliabilityByMarket[m] ?? ""),
        r.paymentDefault,
        r.paymentDefaultNewlyTriggered,
        r.underwritingFrozen,
        r.underwritingFrozenNewlyTriggered,
        r.warningCount,
      ]);
    }
  }
  return toCsv(QUARTER_SUMMARY_CSV_HEADER, rows);
}

// ---------------------------------------------------------------------
// decision-trace.jsonl — 会社×seed×turnの「開始状態→希望→最終決定→
// 市場別販売数量トレース」を1行1JSONで保持する完全な記録。
// ---------------------------------------------------------------------

export interface DecisionTraceLine {
  readonly seed: string;
  readonly companyId: string;
  readonly turn: number;
  readonly period: string;
  readonly startState: QuarterStartState;
  readonly decision: QuarterDecisionLog;
  readonly salesQuantityTrace: readonly SalesQuantityTraceEntry[];
}

export function formatDecisionTraceJsonl(batch: AutoplayBatchResult): string {
  const lines: string[] = [];
  for (const log of batch.caseLogs) {
    const startByKey = new Map<string, QuarterStartState>();
    for (const s of log.quarterStartStates) startByKey.set(`${s.companyId}::${s.turn}`, s);
    const salesTraceByKey = new Map<string, SalesQuantityTraceEntry[]>();
    for (const t of log.salesQuantityTrace) {
      const key = `${t.companyId}::${t.turn}`;
      const arr = salesTraceByKey.get(key);
      if (arr) arr.push(t);
      else salesTraceByKey.set(key, [t]);
    }
    for (const decision of log.decisionLogs) {
      const key = `${decision.companyId}::${decision.turn}`;
      const startState = startByKey.get(key);
      if (!startState) continue;
      const entry: DecisionTraceLine = {
        seed: log.seed,
        companyId: decision.companyId,
        turn: decision.turn,
        period: decision.period,
        startState,
        decision,
        salesQuantityTrace: salesTraceByKey.get(key) ?? [],
      };
      lines.push(JSON.stringify(entry));
    }
  }
  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}

// ---------------------------------------------------------------------
// adjustment-trace.csv
// ---------------------------------------------------------------------

const ADJUSTMENT_TRACE_CSV_HEADER: readonly string[] = [
  "seed",
  "companyId",
  "turn",
  "period",
  "category",
  "source",
  "code",
  "severity",
  "affectedDecision",
  "affectedMarketOrProduct",
  "before",
  "after",
  "delta",
  "message",
  "threshold",
  "relevantMetric",
];

function adjustmentEntryToCsv(seed: string, e: AdjustmentTraceEntry): readonly (string | number | boolean)[] {
  return [
    seed,
    e.companyId,
    e.turn,
    e.period,
    e.category,
    e.source,
    e.code,
    e.severity,
    e.affectedDecision,
    e.affectedMarketOrProduct ?? "",
    e.before ?? "",
    e.after ?? "",
    e.delta ?? "",
    e.message,
    e.threshold ?? "",
    e.relevantMetric ?? "",
  ];
}

export function formatAdjustmentTraceCsv(batch: AutoplayBatchResult): string {
  const rows = batch.caseLogs.flatMap((log) => log.adjustmentTrace.map((e) => adjustmentEntryToCsv(log.seed, e)));
  return toCsv(ADJUSTMENT_TRACE_CSV_HEADER, rows);
}

// ---------------------------------------------------------------------
// warnings.csv — 四半期結果に記録された理由コード（QuarterResultLog.reasonCodes）
// ---------------------------------------------------------------------

const WARNINGS_CSV_HEADER: readonly string[] = ["seed", "companyId", "turn", "period", "code", "source", "severity", "message"];

function quarterResultWarningsToCsv(seed: string, r: QuarterResultLog): readonly (readonly (string | number)[])[] {
  return r.reasonCodes.map((rc) => [seed, r.companyId, r.turn, r.period, rc.code, rc.source, rc.severity, rc.message] as const);
}

export function formatWarningsCsv(batch: AutoplayBatchResult): string {
  const rows = batch.caseLogs.flatMap((log) => log.quarterResults.flatMap((r) => quarterResultWarningsToCsv(log.seed, r)));
  return toCsv(WARNINGS_CSV_HEADER, rows);
}

// ---------------------------------------------------------------------
// market-allocation-trace.csv — SAI-3B-2で追加。市場×商品×会社×turnぶんの
// 需要・配分結果（schema.tsのMarketAllocationTraceEntry + seed）。
// 【後方互換】既存run（このファイルを含まない古いrunディレクトリ）でも
// SAI-3Bが読み込めるよう、SAI-3B側ではこのファイルを必須としない
// （loadRun.tsのSAI3A_REQUIRED_RUN_FILESには含めず、任意ファイルとして扱う）。
// ---------------------------------------------------------------------

const MARKET_ALLOCATION_TRACE_CSV_HEADER: readonly string[] = [
  "seed",
  "turn",
  "period",
  "market",
  "product",
  "companyId",
  "targetDemandHosoEqTons",
  "externalOptionQuantityHosoEqTons",
  "askPriceUsdPerHosoEqKg",
  "basePriceUsdPerHosoEqKg",
  "allocatedQuantityHosoEqTons",
  "coverageScore",
  "competitivenessWeight",
];

function marketAllocationEntryToCsv(seed: string, e: MarketAllocationTraceEntry): readonly (string | number | boolean)[] {
  return [
    seed,
    e.turn,
    e.period,
    e.market,
    e.product,
    e.companyId,
    e.targetDemandHosoEqTons,
    e.externalOptionQuantityHosoEqTons,
    e.askPriceUsdPerHosoEqKg,
    e.basePriceUsdPerHosoEqKg,
    e.allocatedQuantityHosoEqTons,
    e.coverageScore,
    e.competitivenessWeight,
  ];
}

export function formatMarketAllocationTraceCsv(batch: AutoplayBatchResult): string {
  const rows = batch.caseLogs.flatMap((log) => log.marketAllocationTrace.map((e) => marketAllocationEntryToCsv(log.seed, e)));
  return toCsv(MARKET_ALLOCATION_TRACE_CSV_HEADER, rows);
}

// ---------------------------------------------------------------------
// 【SAI-5G】market-evolution-trace.csv / lifecycle-mix-trace.csv /
// sales-base-trace.csv — 市場進化・営業基盤の因果トレース（任意ファイル。
// SAI-5機能フラグ有効時のみ出力する。market-allocation-trace.csvと同じ
// 「存在しないrunでは生成しない」方式で、既存SAI-3Bパーサーへの影響なし）
// ---------------------------------------------------------------------

const SAI5_MARKET_EVOLUTION_TRACE_CSV_HEADER: readonly string[] = [
  "seed",
  "turn",
  "period",
  "product",
  "offeredHosoEqTons",
  "targetDemandHosoEqTons",
  "addressableDemandHosoEqTons",
  "externalOptionQuantityHosoEqTons",
  "supplyPressure",
  "supplyPressureEwma",
  "supplyPressureDefinition",
  "appliedPremiumRatioMultiplier",
  "appliedAdoptionTurnShift",
  "substitutionShareShift",
];

export function formatSai5MarketEvolutionTraceCsv(batch: AutoplayBatchResult): string | undefined {
  const rows = batch.caseLogs.flatMap((log) =>
    (log.sai5MarketEvolutionTrace ?? []).map((e) => [
      log.seed,
      e.turn,
      e.period,
      e.product,
      e.offeredHosoEqTons,
      e.targetDemandHosoEqTons,
      e.addressableDemandHosoEqTons,
      e.externalOptionQuantityHosoEqTons,
      e.supplyPressure,
      e.supplyPressureEwma,
      e.supplyPressureDefinition,
      e.appliedPremiumRatioMultiplier,
      e.appliedAdoptionTurnShift,
      e.substitutionShareShift,
    ])
  );
  if (rows.length === 0) return undefined;
  return toCsv(SAI5_MARKET_EVOLUTION_TRACE_CSV_HEADER, rows);
}

const SAI5_LIFECYCLE_MIX_TRACE_CSV_HEADER: readonly string[] = [
  "seed",
  "turn",
  "period",
  "market",
  "hosoShare",
  "pdShare",
  "vapShare",
];

export function formatSai5LifecycleMixTraceCsv(batch: AutoplayBatchResult): string | undefined {
  const rows = batch.caseLogs.flatMap((log) =>
    (log.sai5LifecycleMixTrace ?? []).map((e) => [
      log.seed,
      e.turn,
      e.period,
      e.market,
      e.hosoShare,
      e.pdShare,
      e.vapShare,
    ])
  );
  if (rows.length === 0) return undefined;
  return toCsv(SAI5_LIFECYCLE_MIX_TRACE_CSV_HEADER, rows);
}

const SAI5_SALES_BASE_TRACE_CSV_HEADER: readonly string[] = [
  "seed",
  "turn",
  "period",
  "companyId",
  "market",
  "product",
  "salesBaseScore",
];

export function formatSai5SalesBaseTraceCsv(batch: AutoplayBatchResult): string | undefined {
  const rows = batch.caseLogs.flatMap((log) =>
    (log.sai5SalesBaseTrace ?? []).map((e) => [
      log.seed,
      e.turn,
      e.period,
      e.companyId,
      e.market,
      e.product,
      e.salesBaseScore,
    ])
  );
  if (rows.length === 0) return undefined;
  return toCsv(SAI5_SALES_BASE_TRACE_CSV_HEADER, rows);
}

// ---------------------------------------------------------------------
// run-summary.json — run全体の集計＋失敗ケースの診断情報
// ---------------------------------------------------------------------

export interface RunSummaryJson {
  readonly runSummary: RunSummary;
  readonly errors: AutoplayBatchResult["errors"];
}

export function formatRunSummaryJson(batch: AutoplayBatchResult): string {
  const payload: RunSummaryJson = { runSummary: batch.runSummary, errors: batch.errors };
  return JSON.stringify(payload, null, 2) + "\n";
}
