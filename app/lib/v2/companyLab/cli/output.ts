// ShrimpX V2 — 会社経営統合テスト環境（Phase 6.2） CLI 出力整形
//
// 「すでに計算済みの CompanyLabResult をどう表示するか」だけを扱う。
// 価格・需給・生産計算は一切行わず、industryLab/ui/formatters.tsの数値
// フォーマッタ（画面と共通の表記）をそのまま再利用する。
//
// JSON・CSV出力には説明文・ログを一切混入させない（標準出力に純粋な
// JSON/CSVのみを書き込む。人間向けの注記はsummary形式にのみ含める）。

import { unwrapUnit } from "../../core/units";
import {
  formatHosoEqTons,
  formatRatioAsPercent,
  formatScore,
  formatUsdPerHosoEqKg,
} from "../../industryLab/ui/formatters";
import { CompanyFixture, CompanyLabResult, CompanyQuarterRecord, CompanyQuarterSummary } from "../types";
import { CompanyFinancialQuarterResult } from "../../finance/types";
import { FinancingQuarterResult } from "../../financing/types";

function csvEscape(value: string | number): string {
  const s = String(value);
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function toCsv(header: readonly string[], rows: ReadonlyArray<readonly (string | number)[]>): string {
  const lines = [header.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(row.map(csvEscape).join(","));
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------
// summary（人間向け）
// ---------------------------------------------------------------------

function summaryLineForCompany(s: CompanyQuarterSummary, fixtureName: string): string {
  return [
    `    ${s.companyId}（${fixtureName}）`,
    `      成約: ${formatHosoEqTons(s.newContractedQuantity)} @ 平均$${s.newContractedAveragePrice.toFixed(4)}/kg / 履行: ${formatHosoEqTons(s.fulfilledQuantity)}`,
    `      未履行残高: ${formatHosoEqTons(s.outstandingQuantity)}（うち納期超過 ${formatHosoEqTons(s.overdueQuantity)}）`,
    `      国内買付: ${formatHosoEqTons(s.domesticPurchaseQuantity)} @ ${formatUsdPerHosoEqKg(s.domesticPurchasePrice)} / 輸入中: ${formatHosoEqTons(s.importInTransitQuantity)} / 輸入到着: ${formatHosoEqTons(s.importArrivedQuantity)}`,
    `      養殖中: ${formatHosoEqTons(s.aquacultureGrowingQuantity)} / 収穫: ${formatHosoEqTons(s.aquacultureHarvestedQuantity)} / 原料在庫: ${formatHosoEqTons(s.rawMaterialInventory)}`,
    `      生産: HOSO ${formatHosoEqTons(s.hosoProduced)} / PD ${formatHosoEqTons(s.pdProduced)} / VAP ${formatHosoEqTons(s.vapProduced)} / 完成品在庫: ${formatHosoEqTons(s.finishedGoodsInventory)}`,
    `      未達: 原料 ${formatHosoEqTons(s.rawMaterialShortfall)} / 設備 ${formatHosoEqTons(s.equipmentShortfall)} / ワーカー ${formatHosoEqTons(s.laborShortfall)}`,
    `      稼働率: 設備 ${formatRatioAsPercent(s.equipmentUtilizationRate)} / ワーカー ${formatRatioAsPercent(s.laborUtilizationRate)} / 残業率 ${formatRatioAsPercent(s.overtimeRate)} / 臨時比率 ${formatRatioAsPercent(s.temporaryWorkerShare)}`,
    `      品質(Phase7A): ${formatQualityByProductMap(s.qualityScoreByProduct)} / 操業リスク: ${formatRiskByProductMap(s.operationalRiskByProduct)}`,
    `      格落ち: ${formatHosoEqTons(s.downgradeQuantity)} / 再加工: ${formatHosoEqTons(s.reworkQuantity)} / 廃棄: ${formatHosoEqTons(s.discardQuantity)} / 重大事故: ${s.majorIncidentCount}件${
      s.onTimeDeliveryRate !== undefined ? ` / 納期遵守率: ${s.onTimeDeliveryRate.toFixed(1)}%` : ""
    }`,
    `      顧客信頼: ${formatQualityByProductMap(s.customerTrustByMarket)} / 納期信頼性: ${formatQualityByProductMap(s.deliveryReliabilityByMarket)}`,
    ...(s.rampWarnings.length > 0
      ? [`      増産警告: ${s.rampWarnings.map((w) => `${w.factoryId}/${w.product} stress=${w.productionRampStress.toFixed(2)}`).join(" / ")}`]
      : []),
    ...(s.reasonCodes.length > 0 ? [`      理由: ${s.reasonCodes.map((r) => r.message).join(" / ")}`] : []),
  ].join("\n");
}

/** {product/market -> Score0to100}形式のRecordを"key val / key val"形式へ整形する（品質・顧客信頼・納期信頼性で共用）。 */
function formatQualityByProductMap(m: Readonly<Partial<Record<string, number>>>): string {
  const entries = Object.entries(m).filter((e): e is [string, number] => e[1] !== undefined);
  if (entries.length === 0) return "—";
  return entries.map(([k, v]) => `${k} ${formatScore(v)}`).join(" / ");
}

/** USD金額をUSD百万の表示文字列へ整形する（表示用のみ。内部計算では丸めない）。 */
function formatUsdMillions(v: number): string {
  return `$${(v / 1_000_000).toFixed(1)}M`;
}

/** 1社・1四半期ぶんの財務結果（Phase 8A）のsummary行。 */
function financeLineForCompany(f: CompanyFinancialQuarterResult): string {
  const pl = f.profitAndLoss;
  const bs = f.balanceSheet;
  const cf = f.cashFlow;
  const flags = [
    ...(f.cashShortfall ? [`資金不足 ${formatUsdMillions(f.cashShortfallAmount as unknown as number)}`] : []),
    ...(f.negativeEquity ? ["債務超過"] : []),
  ];
  return [
    `      財務(Phase 8A): 売上高 ${formatUsdMillions(pl.netRevenue as unknown as number)} / 営業利益 ${formatUsdMillions(pl.operatingProfit as unknown as number)} / 純利益 ${formatUsdMillions(pl.netIncome as unknown as number)} / 営業CF ${formatUsdMillions(cf.operatingCashFlow as unknown as number)}`,
    `      財務状態: 期末現金 ${formatUsdMillions(bs.cash as unknown as number)} / 総資産 ${formatUsdMillions(bs.totalAssets as unknown as number)} / 純資産 ${formatUsdMillions(bs.totalEquity as unknown as number)}${flags.length > 0 ? ` / 【${flags.join("・")}】` : ""}`,
  ].join("\n");
}

/**
 * 【Phase 8B-1】1社・1四半期ぶんの資金繰り結果のsummary行。
 * 信用スコア・信用区分・借入申請/承認額・通常/緊急融資実行額・元本返済額・
 * 支払利息・期末借入残高・借入限度額・未使用借入余力・財務制限条項違反・
 * 延滞額・支払不能額・調達縮小・財務状態を1社ぶん要約する。
 */
function financingLineForCompany(fr: FinancingQuarterResult): string {
  const cs = fr.creditScore;
  const bc = fr.borrowingCapacity;
  const uw = fr.underwriting;
  const health = fr.financialHealth;
  const arrearsTotalUsd = fr.arrearsEvents.reduce((s, e) => s + e.amountUsd, 0);
  const healthFlags = [
    health.insolvent ? "債務超過" : undefined,
    health.covenantBreach ? "条項違反" : undefined,
    health.paymentArrears ? "延滞" : undefined,
    health.paymentDefault ? "支払不能" : undefined,
    health.usedEmergencyLoanThisPeriod ? "緊急融資利用" : undefined,
  ].filter((x): x is string => x !== undefined);
  const procurement = fr.procurementConstraint;
  return [
    `      資金繰り(Phase 8B-1): 信用スコア ${cs.score0to100.toFixed(0)}（区分${cs.tier}） / 借入限度額 ${formatUsdMillions(bc.grossLimitUsd)} / 未使用借入余力 ${formatUsdMillions(bc.availableAdditionalCapacityUsd)}`,
    `      融資: 申請 ${formatUsdMillions(uw.requestedAmountUsd)} / 承認 ${formatUsdMillions(uw.approvedAmountUsd)} / 緊急融資実行 ${formatUsdMillions(fr.emergencyLoan?.approvedUsd ?? 0)} / 元本返済 ${formatUsdMillions(fr.principalPaidCashUsd)} / 支払利息 ${formatUsdMillions(fr.interestPaidCashUsd)} / 期末借入残高 ${formatUsdMillions(fr.endingShortTermLoansUsd + fr.endingLongTermLoansUsd)}`,
    `      財務状態: ${health.primary}${healthFlags.length > 0 ? `【${healthFlags.join("・")}】` : ""} / 延滞額 ${formatUsdMillions(arrearsTotalUsd)}${
      procurement ? ` / 調達縮小: 国内買付 ${(procurement.scaleRatio * 100).toFixed(0)}%${procurement.importOrdersBlocked ? "（輸入停止）" : ""}` : ""
    }`,
  ].join("\n");
}

/** {product -> operationalRisk(0-1)}形式のRecordを"key val%"形式へ整形する。 */
function formatRiskByProductMap(m: Readonly<Partial<Record<string, number>>>): string {
  const entries = Object.entries(m).filter((e): e is [string, number] => e[1] !== undefined);
  if (entries.length === 0) return "—";
  return entries.map(([k, v]) => `${k} ${formatRatioAsPercent(v)}`).join(" / ");
}

export function formatCompanyLabResultAsSummary(result: CompanyLabResult, scenarioTitle: string, companyFilter: string): string {
  const nameById = new Map(result.companies.map((c) => [c.companyId, c.displayName]));
  const lines: string[] = [];
  lines.push("ShrimpX V2 会社経営統合テスト環境 CLI — summary");
  lines.push(`シナリオ: ${scenarioTitle}（${result.config.scenarioId}）`);
  lines.push(`モード: ${result.config.mode} / シード: ${result.config.seed} / 実行ターン数: ${result.history.length} / ${result.config.turns}`);
  lines.push("");
  lines.push(
    "注記: 表示中の5社（BAL/MASS/JPQ/VAP/CONSV）はPhase 6.2の統合テスト用フィクスチャであり、本番会社設定・本番AI会社ではない。"
  );
  lines.push("");

  for (const record of result.history) {
    lines.push(`[turn ${record.turn}（${record.period}）]`);
    lines.push(`  ベトナム国内原料価格: ${formatUsdPerHosoEqKg(record.marketResult.vietnamDomestic.price)} / HOSO(VN): ${formatUsdPerHosoEqKg(record.marketResult.hosoPrices.VN.price)}`);
    lines.push(
      `  PD/VAPプレミアム: PD ${formatUsdPerHosoEqKg(record.marketResult.pdPremium.basePremium)} / VAP ${formatUsdPerHosoEqKg(record.marketResult.vapPremium.basePremium)}`
    );
    const summaries = companyFilter === "all" ? record.companySummaries : record.companySummaries.filter((s) => s.companyId === companyFilter);
    for (const s of summaries) {
      lines.push(summaryLineForCompany(s, nameById.get(s.companyId) ?? s.companyId));
      const finance = record.financialResults.find((f) => f.companyId === s.companyId);
      if (finance) {
        lines.push(financeLineForCompany(finance));
      }
      const financing = record.financingResults.find((f) => f.companyId === s.companyId);
      if (financing) {
        lines.push(financingLineForCompany(financing));
      }
    }
    if (record.globalReasonCodes.length > 0) {
      lines.push(`    [全体] ${record.globalReasonCodes.map((r) => r.message).join(" / ")}`);
    }
    lines.push("");
  }

  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------
// json（機械可読）
// ---------------------------------------------------------------------

export function formatCompanyLabResultAsJson(result: CompanyLabResult, scenarioTitle: string, companyFilter: string): string {
  const filteredHistory = result.history.map((record) => ({
    ...record,
    companySummaries: companyFilter === "all" ? record.companySummaries : record.companySummaries.filter((s) => s.companyId === companyFilter),
  }));
  return (
    JSON.stringify(
      {
        config: result.config,
        scenarioTitle,
        companies: result.companies.map((c) => ({ companyId: c.companyId, displayName: c.displayName, archetype: c.archetype, description: c.description })),
        history: filteredHistory,
      },
      null,
      2
    ) + "\n"
  );
}

// ---------------------------------------------------------------------
// csv（表計算向け。会社×四半期の1行1レコード）
// ---------------------------------------------------------------------

const COMPANY_QUARTER_CSV_HEADER: readonly string[] = [
  "turn",
  "periodLabel",
  "companyId",
  "newContractedQuantity",
  "newContractedAveragePrice",
  "fulfilledQuantity",
  "outstandingQuantity",
  "overdueQuantity",
  "domesticPurchaseQuantity",
  "domesticPurchasePrice",
  "importInTransitQuantity",
  "importArrivedQuantity",
  "aquacultureGrowingQuantity",
  "aquacultureHarvestedQuantity",
  "rawMaterialInventory",
  "hosoProduced",
  "pdProduced",
  "vapProduced",
  "finishedGoodsInventory",
  "rawMaterialShortfall",
  "equipmentShortfall",
  "laborShortfall",
  "equipmentUtilizationRate",
  "laborUtilizationRate",
  "overtimeRate",
  "temporaryWorkerShare",
  // Phase 7A（品質・顧客信頼・納期信頼性）。会社×商品/会社×市場のスコアは
  // 列数が可変になるためCSVには集約値のみを出す（会社全体の平均・合計）。
  // 商品別・市場別の内訳はjson出力を参照。
  "qualityScoreAverage",
  "operationalRiskAverage",
  "downgradeQuantity",
  "reworkQuantity",
  "discardQuantity",
  "majorIncidentCount",
  "onTimeDeliveryRate",
  "customerTrustScoreAverage",
  "deliveryReliabilityScoreAverage",
  // 【Phase 8B-1】資金繰り（信用スコア・借入限度額・銀行審査・延滞・支払不能・
  // 財務状態・調達縮小）。
  "creditScore",
  "creditTier",
  "borrowingLimitUsd",
  "unusedBorrowingCapacityUsd",
  "loanRequestedUsd",
  "loanApprovedUsd",
  "emergencyLoanApprovedUsd",
  "principalPaidUsd",
  "interestPaidUsd",
  "endingLoanBalanceUsd",
  "arrearsAmountUsd",
  "financialHealthPrimary",
  "insolvent",
  "covenantBreach",
  "paymentArrears",
  "paymentDefault",
  "domesticPurchaseScaleRatio",
  "importOrdersBlocked",
  "endingCashUsd",
];

function average(values: readonly number[]): string {
  if (values.length === 0) return "";
  return String(values.reduce((a, b) => a + b, 0) / values.length);
}

function summaryToCsvRow(record: CompanyQuarterRecord, s: CompanyQuarterSummary): readonly (string | number)[] {
  const fr = record.financingResults.find((f) => f.companyId === s.companyId);
  const fin = record.financialResults.find((f) => f.companyId === s.companyId);
  const arrearsTotalUsd = fr ? fr.arrearsEvents.reduce((sum, e) => sum + e.amountUsd, 0) : "";
  return [
    record.turn,
    record.period,
    s.companyId,
    unwrapUnit(s.newContractedQuantity),
    s.newContractedAveragePrice,
    unwrapUnit(s.fulfilledQuantity),
    unwrapUnit(s.outstandingQuantity),
    unwrapUnit(s.overdueQuantity),
    unwrapUnit(s.domesticPurchaseQuantity),
    s.domesticPurchasePrice,
    unwrapUnit(s.importInTransitQuantity),
    unwrapUnit(s.importArrivedQuantity),
    unwrapUnit(s.aquacultureGrowingQuantity),
    unwrapUnit(s.aquacultureHarvestedQuantity),
    unwrapUnit(s.rawMaterialInventory),
    unwrapUnit(s.hosoProduced),
    unwrapUnit(s.pdProduced),
    unwrapUnit(s.vapProduced),
    unwrapUnit(s.finishedGoodsInventory),
    unwrapUnit(s.rawMaterialShortfall),
    unwrapUnit(s.equipmentShortfall),
    unwrapUnit(s.laborShortfall),
    unwrapUnit(s.equipmentUtilizationRate),
    unwrapUnit(s.laborUtilizationRate),
    unwrapUnit(s.overtimeRate),
    unwrapUnit(s.temporaryWorkerShare),
    average(Object.values(s.qualityScoreByProduct).filter((v): v is NonNullable<typeof v> => v !== undefined).map((v) => unwrapUnit(v))),
    average(Object.values(s.operationalRiskByProduct).filter((v): v is number => v !== undefined)),
    unwrapUnit(s.downgradeQuantity),
    unwrapUnit(s.reworkQuantity),
    unwrapUnit(s.discardQuantity),
    s.majorIncidentCount,
    s.onTimeDeliveryRate !== undefined ? s.onTimeDeliveryRate : "",
    average(Object.values(s.customerTrustByMarket).filter((v): v is NonNullable<typeof v> => v !== undefined).map((v) => unwrapUnit(v))),
    average(Object.values(s.deliveryReliabilityByMarket).filter((v): v is NonNullable<typeof v> => v !== undefined).map((v) => unwrapUnit(v))),
    fr ? fr.creditScore.score0to100 : "",
    fr ? fr.creditScore.tier : "",
    fr ? fr.borrowingCapacity.grossLimitUsd : "",
    fr ? fr.borrowingCapacity.availableAdditionalCapacityUsd : "",
    fr ? fr.underwriting.requestedAmountUsd : "",
    fr ? fr.underwriting.approvedAmountUsd : "",
    fr ? fr.emergencyLoan?.approvedUsd ?? 0 : "",
    fr ? fr.principalPaidCashUsd : "",
    fr ? fr.interestPaidCashUsd : "",
    fr ? fr.endingShortTermLoansUsd + fr.endingLongTermLoansUsd : "",
    arrearsTotalUsd,
    fr ? fr.financialHealth.primary : "",
    fr ? (fr.financialHealth.insolvent ? 1 : 0) : "",
    fr ? (fr.financialHealth.covenantBreach ? 1 : 0) : "",
    fr ? (fr.financialHealth.paymentArrears ? 1 : 0) : "",
    fr ? (fr.financialHealth.paymentDefault ? 1 : 0) : "",
    fr?.procurementConstraint ? fr.procurementConstraint.scaleRatio : "",
    fr?.procurementConstraint ? (fr.procurementConstraint.importOrdersBlocked ? 1 : 0) : "",
    fin ? (fin.balanceSheet.cash as unknown as number) : "",
  ];
}

export function formatCompanyLabResultAsCsv(result: CompanyLabResult, companyFilter: string): string {
  const rows: (string | number)[][] = [];
  for (const record of result.history) {
    const summaries = companyFilter === "all" ? record.companySummaries : record.companySummaries.filter((s) => s.companyId === companyFilter);
    for (const s of summaries) {
      rows.push([...summaryToCsvRow(record, s)]);
    }
  }
  return toCsv(COMPANY_QUARTER_CSV_HEADER, rows);
}

export function findFixture(companies: readonly CompanyFixture[], companyId: string): CompanyFixture | undefined {
  return companies.find((c) => c.companyId === companyId);
}
