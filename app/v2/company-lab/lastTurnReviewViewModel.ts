// ShrimpX V2 — 「前Turnに何を指示し、その結果どうなったか」のふりかえり
//
// 【直す問題】ターンが新しくなったとき、プレイヤーが最初に見る Overview の先頭が
// Vision・Strategy Profile・Commercial Growth（＝Standard AI の戦略説明）だった。
// 経営者が最初に知りたいのは「前期に自分が出した指示が、どう実行され、どういう
// 結果になったか」であり、志の再掲ではない。この画面を作り直すための view model。
//
// 【新しい計算をしない】ここは確定済みの CompanyQuarterRecord を読み替えるだけの
// 純粋関数である。指示側は record.decisions（実際に四半期処理へ渡った提出内容）、
// 結果側は companySummaries / financialResults / financingResults / dividendResults /
// capexResults / salesRecord をそのまま転記する。再計算・推測・補完は一切しない。
// 読めない値は「記録なし」と書き、0 で埋めない。
//
// 【情報境界】対象会社1社ぶんだけを抜き出す。他社の提出内容・他社の結果には
// 一切触れない（salesRecord.newContracts は全社ぶんを含むため companyId で絞る）。

import { unwrapUnit } from "../../lib/v2/core/units";
import { unwrapUsd } from "../../lib/v2/finance/types";
import type { CompanyId } from "../../lib/v2/sales/types";
import type { DemandMarketId, Product } from "../../lib/v2/market/types";
import type { CompanyDecisionInput, CompanyQuarterRecord } from "../../lib/v2/companyLab/types";
import { humanizeFinanceReason } from "./financeReasonText";

const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];
const PRODUCT_LABELS: Readonly<Record<Product, string>> = { hoso: "HOSO", pd: "PD", vap: "VAP" };

export type ReviewTone = "neutral" | "good" | "warn";

/** ふりかえり1行。「指示」と「結果」を必ず並べる（片方しか無い行もある）。 */
export interface ReviewLine {
  readonly label: string;
  /** 前Turnに提出した指示。その項目に指示という概念が無い場合は undefined。 */
  readonly instructed?: string;
  /** 実際の結果。記録が無い場合は undefined（0で埋めない）。 */
  readonly result?: string;
  /** 指示と結果が食い違った理由・補足。 */
  readonly note?: string;
  readonly tone?: ReviewTone;
  readonly testId: string;
}

export type ReviewSectionKey = "performance" | "sales" | "production" | "procurement" | "finance" | "investment";

export interface ReviewSection {
  readonly key: ReviewSectionKey;
  readonly title: string;
  /** 折りたたんだ状態でも要点が分かる1行。 */
  readonly headline: string;
  readonly tone?: ReviewTone;
  readonly lines: readonly ReviewLine[];
}

export interface LastTurnReview {
  /** ふりかえり対象（＝直近に確定した四半期）。 */
  readonly turn: number;
  readonly period: string;
  readonly companyId: CompanyId;
  /** この会社の提出内容が記録に残っていたか。false なら「指示」列は出せない。 */
  readonly hasSubmittedDecision: boolean;
  readonly sections: readonly ReviewSection[];
}

// ---------------------------------------------------------------------
// 表示フォーマッタ（この画面専用。計算はしない）
// ---------------------------------------------------------------------

function tons(value: number): string {
  return `${Math.round(value).toLocaleString("en-US")} t`;
}

function usd(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function usdMillions(value: number): string {
  return `$${(value / 1e6).toFixed(2)}M`;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function signedUsdMillions(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "±";
  return `${sign}$${(Math.abs(value) / 1e6).toFixed(2)}M`;
}

/** 達成率。分母が0のときは率を作らない（0除算で嘘の数字を出さない）。 */
function achievementRatio(result: number, instructed: number): number | undefined {
  return instructed > 0 ? result / instructed : undefined;
}

// ---------------------------------------------------------------------
// 各セクション
// ---------------------------------------------------------------------

function buildPerformanceSection(
  record: CompanyQuarterRecord,
  previousRecord: CompanyQuarterRecord | undefined,
  companyId: CompanyId
): ReviewSection | undefined {
  const financial = record.financialResults.find((f) => f.companyId === companyId);
  if (financial === undefined) return undefined;
  const previous = previousRecord?.financialResults.find((f) => f.companyId === companyId);

  const netRevenue = unwrapUsd(financial.profitAndLoss.netRevenue);
  const operatingProfit = unwrapUsd(financial.profitAndLoss.operatingProfit);
  const netIncome = unwrapUsd(financial.profitAndLoss.netIncome);
  const cash = unwrapUsd(financial.balanceSheet.cash);
  const equity = unwrapUsd(financial.balanceSheet.totalEquity);
  const debt = unwrapUsd(financial.balanceSheet.shortTermLoans) + unwrapUsd(financial.balanceSheet.longTermLoans);

  const delta = (current: number, pick: (f: NonNullable<typeof previous>) => number): string | undefined =>
    previous === undefined ? undefined : `前Turn比 ${signedUsdMillions(current - pick(previous))}`;

  return {
    key: "performance",
    title: "業績（この四半期の結果）",
    headline: `純売上 ${usdMillions(netRevenue)} ／ 営業利益 ${usdMillions(operatingProfit)} ／ 純利益 ${usdMillions(netIncome)}`,
    tone: operatingProfit >= 0 ? "good" : "warn",
    lines: [
      {
        label: "純売上高",
        result: usdMillions(netRevenue),
        note: delta(netRevenue, (f) => unwrapUsd(f.profitAndLoss.netRevenue)),
        testId: "review-performance-net-revenue",
      },
      {
        label: "営業利益",
        result: usdMillions(operatingProfit),
        note: delta(operatingProfit, (f) => unwrapUsd(f.profitAndLoss.operatingProfit)),
        tone: operatingProfit >= 0 ? "good" : "warn",
        testId: "review-performance-operating-profit",
      },
      {
        label: "当期純利益",
        result: usdMillions(netIncome),
        note: delta(netIncome, (f) => unwrapUsd(f.profitAndLoss.netIncome)),
        tone: netIncome >= 0 ? "good" : "warn",
        testId: "review-performance-net-income",
      },
      {
        label: "期末現金",
        result: usdMillions(cash),
        note: delta(cash, (f) => unwrapUsd(f.balanceSheet.cash)),
        testId: "review-performance-cash",
      },
      {
        label: "有利子負債",
        result: usdMillions(debt),
        note: delta(debt, (f) => unwrapUsd(f.balanceSheet.shortTermLoans) + unwrapUsd(f.balanceSheet.longTermLoans)),
        testId: "review-performance-debt",
      },
      {
        label: "自己資本",
        result: usdMillions(equity),
        note: delta(equity, (f) => unwrapUsd(f.balanceSheet.totalEquity)),
        testId: "review-performance-equity",
      },
    ],
  };
}

function buildSalesSection(
  record: CompanyQuarterRecord,
  decision: CompanyDecisionInput | undefined,
  companyId: CompanyId
): ReviewSection | undefined {
  const summary = record.companySummaries.find((s) => s.companyId === companyId);
  if (summary === undefined) return undefined;

  const instructedTotal = (decision?.salesPlans ?? []).reduce((sum, p) => sum + unwrapUnit(p.desiredQuantity), 0);
  const contracted = unwrapUnit(summary.newContractedQuantity);
  const delivered = unwrapUnit(summary.fulfilledQuantity);
  const backlog = unwrapUnit(summary.outstandingQuantity);
  const overdue = unwrapUnit(summary.overdueQuantity);
  const ratio = achievementRatio(contracted, instructedTotal);

  // 市場別（提示 → 成約）。成約は自社ぶんの新規契約だけを数える。
  const contractedByMarket = new Map<DemandMarketId, number>();
  for (const contract of record.salesRecord.newContracts) {
    if (contract.companyId !== companyId) continue;
    contractedByMarket.set(contract.market, (contractedByMarket.get(contract.market) ?? 0) + unwrapUnit(contract.originalQuantity));
  }
  const instructedByMarket = new Map<DemandMarketId, number>();
  const headcountByMarket = new Map<DemandMarketId, number>();
  for (const plan of decision?.salesPlans ?? []) {
    instructedByMarket.set(plan.market, (instructedByMarket.get(plan.market) ?? 0) + unwrapUnit(plan.desiredQuantity));
    headcountByMarket.set(plan.market, plan.salesForceHeadcount);
  }
  const markets = Array.from(new Set([...instructedByMarket.keys(), ...contractedByMarket.keys()]));

  const lines: ReviewLine[] = [
    {
      label: "販売提示量 → 新規成約量",
      instructed: decision === undefined ? undefined : tons(instructedTotal),
      result: tons(contracted),
      note: ratio === undefined ? undefined : `成約率 ${percent(ratio)}`,
      tone: ratio !== undefined && ratio < 0.8 ? "warn" : "neutral",
      testId: "review-sales-contracted",
    },
    { label: "納品量", result: tons(delivered), testId: "review-sales-delivered" },
    {
      label: "受注残（未履行）",
      result: tons(backlog),
      note: backlog > 0 ? "次Turn以降に納品する約束です。生産・原料の計画に織り込んでください。" : undefined,
      tone: backlog > 0 ? "warn" : "neutral",
      testId: "review-sales-backlog",
    },
    {
      label: "納期超過",
      result: tons(overdue),
      tone: overdue > 0 ? "warn" : "good",
      note: overdue > 0 ? "納期を過ぎた受注です。顧客信頼・納期信頼性が下がります。" : undefined,
      testId: "review-sales-overdue",
    },
  ];

  for (const market of markets) {
    const instructedTons = instructedByMarket.get(market) ?? 0;
    const contractedTons = contractedByMarket.get(market) ?? 0;
    const marketRatio = achievementRatio(contractedTons, instructedTons);
    const headcount = headcountByMarket.get(market);
    lines.push({
      label: `${market} 市場`,
      instructed: decision === undefined ? undefined : `${tons(instructedTons)}${headcount === undefined ? "" : `／営業${headcount}人`}`,
      result: tons(contractedTons),
      note: marketRatio === undefined ? undefined : `成約率 ${percent(marketRatio)}`,
      tone: marketRatio !== undefined && marketRatio < 0.8 ? "warn" : "neutral",
      testId: `review-sales-market-${market}`,
    });
  }

  if (decision?.salesForceHireCount !== undefined || decision?.salesForceLayoffCount !== undefined) {
    lines.push({
      label: "営業人員の採用・減員",
      instructed: `採用 ${decision?.salesForceHireCount ?? 0}人 ／ 減員 ${decision?.salesForceLayoffCount ?? 0}人`,
      result: "次Turnから配員できます",
      note: "採用した人員が販売に効くのは次の四半期からです。",
      testId: "review-sales-hiring",
    });
  }

  return {
    key: "sales",
    title: "販売活動（指示 → 結果）",
    headline:
      ratio === undefined
        ? `新規成約 ${tons(contracted)} ／ 受注残 ${tons(backlog)}`
        : `提示 ${tons(instructedTotal)} → 成約 ${tons(contracted)}（成約率 ${percent(ratio)}）`,
    tone: overdue > 0 ? "warn" : "neutral",
    lines,
  };
}

function buildProductionSection(
  record: CompanyQuarterRecord,
  decision: CompanyDecisionInput | undefined,
  companyId: CompanyId
): ReviewSection | undefined {
  const summary = record.companySummaries.find((s) => s.companyId === companyId);
  if (summary === undefined) return undefined;

  const producedByProduct: Readonly<Record<Product, number>> = {
    hoso: unwrapUnit(summary.hosoProduced),
    pd: unwrapUnit(summary.pdProduced),
    vap: unwrapUnit(summary.vapProduced),
  };
  const plannedByProduct = new Map<Product, number>();
  for (const plan of decision?.productionPlans ?? []) {
    plannedByProduct.set(plan.product, (plannedByProduct.get(plan.product) ?? 0) + unwrapUnit(plan.desiredQuantity));
  }
  const plannedTotal = Array.from(plannedByProduct.values()).reduce((a, b) => a + b, 0);
  const producedTotal = PRODUCTS.reduce((sum, p) => sum + producedByProduct[p], 0);
  const ratio = achievementRatio(producedTotal, plannedTotal);

  const lines: ReviewLine[] = [
    {
      label: "生産計画 → 実際の生産量",
      instructed: decision === undefined ? undefined : tons(plannedTotal),
      result: tons(producedTotal),
      note: ratio === undefined ? undefined : `計画比 ${percent(ratio)}`,
      tone: ratio !== undefined && ratio < 0.8 ? "warn" : "neutral",
      testId: "review-production-total",
    },
  ];
  for (const product of PRODUCTS) {
    const planned = plannedByProduct.get(product);
    lines.push({
      label: `${PRODUCT_LABELS[product]} 生産`,
      instructed: planned === undefined ? undefined : tons(planned),
      result: tons(producedByProduct[product]),
      testId: `review-production-${product}`,
    });
  }

  const rawShortfall = unwrapUnit(summary.rawMaterialShortfall);
  const equipmentShortfall = unwrapUnit(summary.equipmentShortfall);
  const laborShortfall = unwrapUnit(summary.laborShortfall);
  const shortfalls: { readonly label: string; readonly value: number; readonly remedy: string }[] = [
    { label: "原料不足", value: rawShortfall, remedy: "PROCUREMENT で国内買付・輸入を増やすと解消します。" },
    { label: "設備能力不足", value: equipmentShortfall, remedy: "INVESTMENT で該当する加工能力を増やすと解消します。" },
    { label: "労働力不足", value: laborShortfall, remedy: "WORKER で人員を増やすか、残業率を上げると解消します。" },
  ];
  for (const shortfall of shortfalls) {
    if (shortfall.value <= 0) continue;
    lines.push({
      label: `減産の原因: ${shortfall.label}`,
      result: tons(shortfall.value),
      note: shortfall.remedy,
      tone: "warn",
      testId: `review-production-shortfall-${shortfall.label}`,
    });
  }

  lines.push({
    label: "稼働率",
    result: `設備 ${percent(unwrapUnit(summary.equipmentUtilizationRate))} ／ 労働 ${percent(unwrapUnit(summary.laborUtilizationRate))} ／ 残業 ${percent(unwrapUnit(summary.overtimeRate))}`,
    testId: "review-production-utilization",
  });

  const downgrade = unwrapUnit(summary.downgradeQuantity);
  const rework = unwrapUnit(summary.reworkQuantity);
  const discard = unwrapUnit(summary.discardQuantity);
  if (downgrade > 0 || rework > 0 || discard > 0 || summary.majorIncidentCount > 0) {
    lines.push({
      label: "品質による損失",
      result: `格下げ ${tons(downgrade)} ／ 再加工 ${tons(rework)} ／ 廃棄 ${tons(discard)}`,
      note: summary.majorIncidentCount > 0 ? `重大品質事故 ${summary.majorIncidentCount}件` : undefined,
      tone: summary.majorIncidentCount > 0 || discard > 0 ? "warn" : "neutral",
      testId: "review-production-quality-loss",
    });
  }

  return {
    key: "production",
    title: "生産活動（指示 → 結果）",
    headline:
      ratio === undefined
        ? `生産 ${tons(producedTotal)}`
        : `計画 ${tons(plannedTotal)} → 生産 ${tons(producedTotal)}（計画比 ${percent(ratio)}）`,
    tone: ratio !== undefined && ratio < 0.8 ? "warn" : "neutral",
    lines,
  };
}

function buildProcurementSection(
  record: CompanyQuarterRecord,
  decision: CompanyDecisionInput | undefined,
  companyId: CompanyId
): ReviewSection | undefined {
  const summary = record.companySummaries.find((s) => s.companyId === companyId);
  if (summary === undefined) return undefined;

  const domesticInstructed = decision === undefined ? undefined : unwrapUnit(decision.domesticPurchasePlan.desiredQuantity);
  const domesticActual = unwrapUnit(summary.domesticPurchaseQuantity);
  const domesticRatio = domesticInstructed === undefined ? undefined : achievementRatio(domesticActual, domesticInstructed);

  const importOrdered = (decision?.importOrders ?? []).reduce((sum, o) => sum + unwrapUnit(o.orderedQuantity), 0);
  const importArrived = unwrapUnit(summary.importArrivedQuantity);
  const importInTransit = unwrapUnit(summary.importInTransitQuantity);
  const stocking = (decision?.aquacultureStockingPlans ?? []).reduce((sum, p) => sum + unwrapUnit(p.plannedStockingQuantity), 0);

  const lines: ReviewLine[] = [
    {
      label: "国内買付 希望 → 実際",
      instructed: domesticInstructed === undefined ? undefined : tons(domesticInstructed),
      result: tons(domesticActual),
      note:
        domesticRatio === undefined
          ? undefined
          : domesticRatio < 0.95
            ? `希望の ${percent(domesticRatio)} しか買えませんでした（産地の供給上限を他社と分け合うため）。`
            : `希望どおり買えました（${percent(domesticRatio)}）。`,
      tone: domesticRatio !== undefined && domesticRatio < 0.95 ? "warn" : "neutral",
      testId: "review-procurement-domestic",
    },
    {
      label: "買付単価",
      result: `$${summary.domesticPurchasePrice.toFixed(2)} /kg`,
      instructed:
        decision === undefined
          ? undefined
          : `価格調整 ${decision.domesticPurchasePlan.priceAdjustmentUsdPerHosoEqKg >= 0 ? "+" : ""}$${decision.domesticPurchasePlan.priceAdjustmentUsdPerHosoEqKg.toFixed(2)} /kg`,
      testId: "review-procurement-price",
    },
    {
      label: "輸入 発注 → 到着",
      instructed: decision === undefined ? undefined : importOrdered > 0 ? tons(importOrdered) : "発注なし",
      result: tons(importArrived),
      note: importInTransit > 0 ? `輸送中 ${tons(importInTransit)}（次Turn以降に到着します）` : undefined,
      testId: "review-procurement-import",
    },
    {
      label: "自社養殖 池入れ → 収穫",
      instructed: decision === undefined ? undefined : stocking > 0 ? tons(stocking) : "池入れなし",
      result: tons(unwrapUnit(summary.aquacultureHarvestedQuantity)),
      note: unwrapUnit(summary.aquacultureGrowingQuantity) > 0 ? `育成中 ${tons(unwrapUnit(summary.aquacultureGrowingQuantity))}` : undefined,
      testId: "review-procurement-aquaculture",
    },
    { label: "期末の原料在庫", result: tons(unwrapUnit(summary.rawMaterialInventory)), testId: "review-procurement-inventory" },
  ];

  return {
    key: "procurement",
    title: "調達活動（指示 → 結果）",
    headline: `国内買付 ${tons(domesticActual)} ／ 輸入到着 ${tons(importArrived)} ／ 期末原料在庫 ${tons(unwrapUnit(summary.rawMaterialInventory))}`,
    tone: domesticRatio !== undefined && domesticRatio < 0.95 ? "warn" : "neutral",
    lines,
  };
}

function buildFinanceSection(
  record: CompanyQuarterRecord,
  decision: CompanyDecisionInput | undefined,
  companyId: CompanyId
): ReviewSection | undefined {
  const financing = record.financingResults.find((f) => f.companyId === companyId);
  const dividend = (record.dividendResults ?? []).find((d) => d.companyId === companyId);
  if (financing === undefined && dividend === undefined) return undefined;

  const lines: ReviewLine[] = [];
  let headline = "記録なし";

  if (financing !== undefined) {
    const u = financing.underwriting;
    const playerRequested = decision?.financingRequest.desiredAmountUsd;
    const denied = u.deniedAmountUsd;
    lines.push({
      label: "借入 申請 → 承認",
      instructed:
        playerRequested === undefined
          ? undefined
          : playerRequested === u.requestedAmountUsd
            ? usd(playerRequested)
            : `${usd(playerRequested)}（審査へ渡った申請額は ${usd(u.requestedAmountUsd)}）`,
      result: `承認 ${usd(u.approvedAmountUsd)} ／ 否決 ${usd(denied)}`,
      note:
        u.reasons.length > 0
          ? u.reasons.map(humanizeFinanceReason).join(" ")
          : denied > 0
            ? "否決理由は記録されていません。"
            : undefined,
      tone: denied > 0 ? "warn" : "neutral",
      testId: "review-finance-loan",
    });
    lines.push({
      label: "借入の余力",
      result: `残り ${usd(financing.borrowingCapacity.availableAdditionalCapacityUsd)}（限度額 ${usd(financing.borrowingCapacity.grossLimitUsd)} − 既存 ${usd(financing.borrowingCapacity.existingLoanBalanceUsd)}）`,
      note: `信用区分 ${financing.creditScore.tier}（スコア ${financing.creditScore.score0to100.toFixed(1)}）`,
      testId: "review-finance-capacity",
    });
    lines.push({
      label: "利息・元本返済",
      result: `支払利息 ${usd(financing.interestPaidCashUsd)} ／ 元本返済 ${usd(financing.principalPaidCashUsd)}`,
      note: financing.arrearsEvents.length > 0 ? `延滞 ${financing.arrearsEvents.length}件` : undefined,
      tone: financing.arrearsEvents.length > 0 ? "warn" : "neutral",
      testId: "review-finance-interest",
    });
    headline = `借入 申請 ${usd(u.requestedAmountUsd)} → 承認 ${usd(u.approvedAmountUsd)}`;
  }

  if (dividend !== undefined) {
    lines.push({
      label: "配当 申請 → 支払",
      instructed: decision?.dividendDecision === undefined ? usd(dividend.requestedDividendUsd) : usd(decision.dividendDecision.dividendAmountUsd),
      result: dividend.rejected ? `却下（支払 ${usd(dividend.appliedDividendUsd)}）` : usd(dividend.appliedDividendUsd),
      note:
        dividend.rejectionReason !== null
          ? humanizeFinanceReason(dividend.rejectionReason)
          : `この四半期の配当可能額は ${usd(dividend.maxDividendUsd)} でした。`,
      tone: dividend.rejected ? "warn" : "neutral",
      testId: "review-finance-dividend",
    });
  }

  return {
    key: "finance",
    title: "財務活動（申請 → 結果）",
    headline,
    tone: lines.some((l) => l.tone === "warn") ? "warn" : "neutral",
    lines,
  };
}

function buildInvestmentSection(
  record: CompanyQuarterRecord,
  decision: CompanyDecisionInput | undefined,
  companyId: CompanyId
): ReviewSection | undefined {
  const capex = record.capexResults.find((c) => c.companyId === companyId);
  if (capex === undefined) return undefined;

  const proposals = decision?.capexDecision.newProjectProposals ?? [];
  const lines: ReviewLine[] = [
    {
      label: "新規の投資提案 → 受理",
      instructed: decision === undefined ? undefined : proposals.length > 0 ? proposals.map((p) => p.projectType).join(" / ") : "提案なし",
      result: `受理 ${proposals.length - capex.rejectedProposals.length}件 ／ 却下 ${capex.rejectedProposals.length}件`,
      note:
        capex.rejectedProposals.length > 0
          ? capex.rejectedProposals.map((r) => `${r.projectType}: ${r.reasons.join(" ")}`).join(" / ")
          : undefined,
      tone: capex.rejectedProposals.length > 0 ? "warn" : "neutral",
      testId: "review-investment-proposals",
    },
    {
      label: "この四半期の投資支払額",
      result: usd(capex.totalPaidThisQuarterUsd),
      note: `期末の建設中勘定 ${usd(capex.endingConstructionInProgressUsd)}`,
      testId: "review-investment-paid",
    },
  ];

  for (const event of capex.events) {
    lines.push({
      label: `案件 ${event.projectType}`,
      result: `${event.statusBefore} → ${event.statusAfter}（支払 ${usd(event.paymentSucceededUsd)}）`,
      note: event.reasons.length > 0 ? event.reasons.join(" ") : undefined,
      testId: `review-investment-event-${event.projectId}`,
    });
  }

  if (capex.completedProjectsTransferUsd > 0) {
    lines.push({
      label: "完成して固定資産へ振り替えた額",
      result: usd(capex.completedProjectsTransferUsd),
      note: "能力が増えるのは、完成した四半期ではなく稼働開始四半期からです。",
      tone: "good",
      testId: "review-investment-completed",
    });
  }

  return {
    key: "investment",
    title: "投資活動（提案 → 結果）",
    headline: `支払 ${usd(capex.totalPaidThisQuarterUsd)} ／ 建設中 ${usd(capex.endingConstructionInProgressUsd)}`,
    tone: capex.rejectedProposals.length > 0 ? "warn" : "neutral",
    lines,
  };
}

// ---------------------------------------------------------------------
// 組み立て
// ---------------------------------------------------------------------

/**
 * 直近に確定した四半期について、「指示 → 結果」のふりかえりを組み立てる。
 * 確定記録がまだ1件も無い（Turn 1 の意思決定前）場合は null を返す。
 */
export function buildLastTurnReview(input: {
  readonly companyId: CompanyId;
  readonly record: CompanyQuarterRecord | undefined;
  readonly previousRecord?: CompanyQuarterRecord;
}): LastTurnReview | null {
  const { companyId, record, previousRecord } = input;
  if (record === undefined) return null;

  const decision = record.decisions.find((d) => d.companyId === companyId);
  const sections = [
    buildPerformanceSection(record, previousRecord, companyId),
    buildSalesSection(record, decision, companyId),
    buildProductionSection(record, decision, companyId),
    buildProcurementSection(record, decision, companyId),
    buildFinanceSection(record, decision, companyId),
    buildInvestmentSection(record, decision, companyId),
  ].filter((s): s is ReviewSection => s !== undefined);

  if (sections.length === 0) return null;

  return {
    turn: record.turn,
    period: record.period,
    companyId,
    hasSubmittedDecision: decision !== undefined,
    sections,
  };
}
