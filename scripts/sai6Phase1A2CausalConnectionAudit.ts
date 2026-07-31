#!/usr/bin/env -S npx tsx
// ShrimpX V2 — SAI-6 Phase 1A-2: 資金調達から原料調達への因果接続監査
//
// 【重要】本スクリプトはエンジン・標準AI本体のロジックを一切変更しない。
// fundingOutlookEnabled のOFF/ONそれぞれをフル実行し、同一seed・同一会社・
// 同一四半期を並べて、三宅さんご指示の全項目を比較・分類する読み取り専用の
// 診断スクリプトである。
//
// 【方法上の注意】OFFとONは同じ意思決定ロジックから出発するが、四半期を
// 追うごとに実際の借入額・現金残高が変わるため、状態は徐々に乖離する
// （これはA/B比較として正しい挙動であり、バグではない）。したがって
// 「新旧式の必要借入額」「銀行申請額」等はOFF実行・ON実行それぞれの
// quarterStartCapture・diagnosticsから独立に再計算し、ONの実行結果に
// 依存しない形で両方を比較する。

import * as fs from "node:fs";
import * as path from "node:path";
import { runAutoplayCase } from "../app/lib/v2/companyLab/standardAi/autoplay/runCase";
import { ALL_COMPANY_IDS } from "../app/lib/v2/companyLab/standardAi/report/decomposeHarness";
import {
  STANDARD_BASELINE_CANDIDATES,
  SELECTED_STANDARD_BASELINE_CANDIDATE_ID,
} from "../app/lib/v2/companyLab/standardAi/report/standardBaseline";
import { STANDARD_AI_PARAMETERS_V1 } from "../app/lib/v2/companyLab/standardAi/parameters";
import { FINANCE_PARAMETERS_V1 } from "../app/lib/v2/finance/parameters";
import { computeLoanQuarterlyInterest, computeScheduledPrincipalDue } from "../app/lib/v2/financing/loanSchedule";
import { unwrapUnit } from "../app/lib/v2/core/units";

const candidate = STANDARD_BASELINE_CANDIDATES.find((c) => c.id === SELECTED_STANDARD_BASELINE_CANDIDATE_ID)!;
const SEEDS = Array.from({ length: 4 }, (_, i) => `sai5-ab-${String(i + 1).padStart(3, "0")}`);
const QUARTERS = 32;

function toNumber(v: unknown): number {
  if (v === undefined || v === null) return 0;
  return typeof v === "number" ? v : Number(v);
}

interface Row {
  configId: "off" | "on";
  seed: string;
  companyId: string;
  turn: number;
  openingCashUsd: number;
  reliableCashInflowsUsd: number;
  payablesDueThisPeriodUsd: number;
  scheduledDebtServiceUsd: number;
  domesticPurchaseCashNeedUsd: number;
  laborCashCostUsd: number;
  sgaFixedCashCostUsd: number;
  plannedCashOutflowsUsd: number;
  projectedEndingCashBeforeNewBorrowingUsd: number;
  targetMinimumCashUsd: number;
  oldFormulaDesiredBorrowingUsd: number;
  newFormulaDesiredBorrowingUsd: number;
  actualSubmittedDesiredAmountUsd: number; // OFF=旧式実行値、ON=新式実行値（診断上の実際の申請額）
  approvedNormalLoanUsd: number;
  actualLoanDrawUsd: number; // 通常+緊急
  borrowingCapacityAvailableUsd: number;
  cashPressure: number;
  severeCash: boolean;
  procurementDesiredQuantityTons: number; // finance判断前のprocurement希望量（=AI提出のdomesticPurchasePlan.desiredQuantity）
  procurementConstrainedQuantityTons: number; // 資金制約後の実行量
  procurementScaleRatio: number;
  rawMaterialShortfallTons: number;
  totalProducedTons: number;
  closingCashUsd: number;
  paymentDefault: boolean;
}

function collect(configId: "off" | "on"): Row[] {
  const rows: Row[] = [];
  const params = STANDARD_AI_PARAMETERS_V1;
  const financeParams = FINANCE_PARAMETERS_V1;

  for (const seed of SEEDS) {
    const result = runAutoplayCase({
      scenarioId: "baseline",
      seed,
      quarters: QUARTERS,
      companyIds: ALL_COMPANY_IDS,
      candidate,
      ...(configId === "on" ? { fundingOutlookEnabled: true } : {}),
    });

    for (const h of result.history) {
      for (const companyId of ALL_COMPANY_IDS) {
        const capture = result.quarterStartCaptures.find((c) => c.turn === h.turn && c.companyId === companyId);
        const diag = result.diagnostics.find((d) => d.turn === h.turn && d.companyId === companyId);
        const financing = h.financingResults.find((f) => f.companyId === companyId);
        const summary = h.companySummaries.find((s) => s.companyId === companyId);
        const fin = h.financialResults.find((f) => f.companyId === companyId);
        if (!capture || !diag || !financing || !summary || !fin) continue;

        const { ownState, publicInfo } = capture;
        const period = capture.period;
        const cashUsd = toNumber(ownState.financeState.cash);
        const targetMinimumCashUsd = diag.pressures.targetMinimumCashUsd;

        // --- 資金見通し（診断専用の再計算。decision/finance.tsのロジックと同一だが、
        //     本番コードには一切手を触れていない。OFF/ON両方で同じ式を使い、
        //     「式そのものは同じでも、入力となる状態がOFF/ONで異なる」ことを
        //     区別できるようにする）。 ---
        const reliableCashInflowsUsd = ownState.financeState.receivables
          .filter((r) => r.dueSettlementPeriod === period)
          .reduce((s, r) => s + (r.amount as number), 0);
        const payablesDueThisPeriodUsd = ownState.financeState.payables
          .filter((p) => p.dueSettlementPeriod === period)
          .reduce((s, p) => s + (p.amount as number), 0);
        const scheduledDebtServiceUsd = ownState.financingState.loanPortfolio.loans.reduce(
          (s, loan) => s + computeLoanQuarterlyInterest(loan, period) + computeScheduledPrincipalDue(loan, period),
          0
        );
        const domesticPurchaseCashNeedUsd =
          unwrapUnit(diag.decision.domesticPurchasePlan.desiredQuantity) * 1000 * (publicInfo.vietnamDomesticPriorPrice || params.defaultExpectedRawPriceUsdPerKg);
        const laborCashCostUsd = diag.decision.workerAssignments.reduce((sum, a) => {
          const regularCost = a.regularHeadcount * financeParams.labor.regularWorkerSalaryUsdPerQuarter;
          const temporaryCost = a.temporaryHeadcount * financeParams.labor.temporaryWorkerCostUsdPerQuarter;
          const overtimeCost = regularCost * unwrapUnit(a.overtimeRate) * financeParams.labor.overtimePremiumFactor;
          return sum + regularCost + temporaryCost + overtimeCost;
        }, 0);
        const sgaFixedCashCostUsd =
          financeParams.sellingGeneralAdmin.adminFixedUsdPerQuarter +
          capture.fixture.salesForceHeadcountTotal * financeParams.sellingGeneralAdmin.salesForceSalaryUsdPerQuarter +
          capture.fixture.procurementHeadcountTotal * financeParams.sellingGeneralAdmin.procurementSalaryUsdPerQuarter;
        const plannedCashOutflowsUsd =
          payablesDueThisPeriodUsd + scheduledDebtServiceUsd + domesticPurchaseCashNeedUsd + laborCashCostUsd + sgaFixedCashCostUsd;
        const projectedEndingCashBeforeNewBorrowingUsd = cashUsd + reliableCashInflowsUsd - plannedCashOutflowsUsd;

        const oldFormulaDesiredBorrowingUsd = cashUsd < targetMinimumCashUsd ? targetMinimumCashUsd - cashUsd : 0;
        const newFormulaDesiredBorrowingUsd = Math.max(0, targetMinimumCashUsd - projectedEndingCashBeforeNewBorrowingUsd);

        const pc = (financing as unknown as {
          procurementConstraint?: { originalDomesticPurchaseQuantityTons: number; constrainedDomesticPurchaseQuantityTons: number; scaleRatio: number };
        }).procurementConstraint;

        rows.push({
          configId,
          seed,
          companyId,
          turn: h.turn,
          openingCashUsd: cashUsd,
          reliableCashInflowsUsd,
          payablesDueThisPeriodUsd,
          scheduledDebtServiceUsd,
          domesticPurchaseCashNeedUsd,
          laborCashCostUsd,
          sgaFixedCashCostUsd,
          plannedCashOutflowsUsd,
          projectedEndingCashBeforeNewBorrowingUsd,
          targetMinimumCashUsd,
          oldFormulaDesiredBorrowingUsd,
          newFormulaDesiredBorrowingUsd,
          actualSubmittedDesiredAmountUsd: toNumber(diag.decision.financingRequest.desiredAmountUsd),
          approvedNormalLoanUsd: toNumber(financing.underwriting.approvedAmountUsd),
          actualLoanDrawUsd: toNumber(financing.loanDrawUsd),
          borrowingCapacityAvailableUsd: toNumber(financing.borrowingCapacity.availableAdditionalCapacityUsd),
          cashPressure: diag.pressures.cashPressure,
          severeCash: diag.pressures.cashPressure >= params.severeCashPressureThreshold,
          procurementDesiredQuantityTons: pc ? pc.originalDomesticPurchaseQuantityTons : unwrapUnit(diag.decision.domesticPurchasePlan.desiredQuantity),
          procurementConstrainedQuantityTons: pc ? pc.constrainedDomesticPurchaseQuantityTons : unwrapUnit(diag.decision.domesticPurchasePlan.desiredQuantity),
          procurementScaleRatio: pc ? pc.scaleRatio : 1,
          rawMaterialShortfallTons: unwrapUnit(summary.rawMaterialShortfall),
          totalProducedTons: unwrapUnit(summary.hosoProduced) + unwrapUnit(summary.pdProduced) + unwrapUnit(summary.vapProduced),
          closingCashUsd: toNumber(fin.cashFlow.closingCash),
          paymentDefault: financing.financialHealth.paymentDefault === true,
        });
      }
    }
    console.log(`  ${configId} / ${seed}: ${result.completedTurns}Q 完走`);
  }
  return rows;
}

// ---------------------------------------------------------------------
// OFF/ON差分の分類（A〜F、ケース単位ではなく四半期単位で判定してから
// ケース全体としてどこで差が消えているかを決める）。
// ---------------------------------------------------------------------

type BreakPoint = "A" | "B" | "C" | "D" | "E" | "F";

interface PairedRow {
  seed: string;
  companyId: string;
  turn: number;
  off: Row;
  on: Row;
  requiredBorrowingDeltaUsd: number; // on.newFormula - off.oldFormula
  submittedDeltaUsd: number; // on.actualSubmitted - off.actualSubmitted
  approvedDeltaUsd: number;
  drawDeltaUsd: number;
  procurementDesiredDeltaTons: number;
  procurementConstrainedDeltaTons: number;
  producedDeltaTons: number;
  breakPoint: BreakPoint;
  breakPointReason: string;
}

const EPS_USD = 1000; // 1,000 USD未満の差は「実質的に差なし」とみなす閾値
const EPS_TONS = 1; // 1トン未満の差は「実質的に差なし」

function classifyBreakPoint(off: Row, on: Row): { breakPoint: BreakPoint; reason: string } {
  const requiredDelta = on.newFormulaDesiredBorrowingUsd - off.oldFormulaDesiredBorrowingUsd;
  const submittedDelta = on.actualSubmittedDesiredAmountUsd - off.actualSubmittedDesiredAmountUsd;
  const approvedDelta = on.approvedNormalLoanUsd - off.approvedNormalLoanUsd;
  const drawDelta = on.actualLoanDrawUsd - off.actualLoanDrawUsd;
  const procConstrainedDelta = on.procurementConstrainedQuantityTons - off.procurementConstrainedQuantityTons;
  const producedDelta = on.totalProducedTons - off.totalProducedTons;

  if (Math.abs(requiredDelta) < EPS_USD) {
    return { breakPoint: "A", reason: `新旧式の必要借入額がほぼ同じ（差 ${requiredDelta.toFixed(0)} USD）。この四半期では式の違いが実質的に効いていない。` };
  }
  if (Math.abs(approvedDelta) < EPS_USD && Math.abs(drawDelta) < EPS_USD) {
    return {
      breakPoint: "B",
      reason: `希望借入額は${submittedDelta >= 0 ? "増えた" : "変わった"}が、承認額・実行額はほぼ変化なし（承認差 ${approvedDelta.toFixed(0)} USD、実行差 ${drawDelta.toFixed(0)} USD）。借入余力上限、または銀行審査の他の制約で吸収されている。`,
    };
  }
  if (Math.abs(procConstrainedDelta) < EPS_TONS) {
    return {
      breakPoint: "C",
      reason: `借入実行額は変化した（差 ${drawDelta.toFixed(0)} USD）が、当期の調達実行量はほぼ変化なし（差 ${procConstrainedDelta.toFixed(2)} t）。procurement判断がfinance判断より前に確定しているため、当期へ反映されていない可能性が高い。`,
    };
  }
  if (Math.abs(producedDelta) < EPS_TONS) {
    return {
      breakPoint: "D",
      reason: `調達実行量は改善した（差 ${procConstrainedDelta.toFixed(2)} t）が、生産量はほぼ変化なし（差 ${producedDelta.toFixed(2)} t）。原料以外の制約（労務・設備）が律速している可能性が高い。`,
    };
  }
  if (off.plannedCashOutflowsUsd < EPS_USD && off.reliableCashInflowsUsd < EPS_USD) {
    return { breakPoint: "E", reason: "入出金見積りの主要項目がほぼゼロで、新式が意図どおりの入力を得られていない可能性がある。" };
  }
  return { breakPoint: "F", reason: `借入・調達・生産のいずれも変化しているが、既定の分類に当てはまらない（要個別確認。実行差 ${drawDelta.toFixed(0)} USD、調達差 ${procConstrainedDelta.toFixed(2)} t、生産差 ${producedDelta.toFixed(2)} t）。` };
}

function pairRows(offRows: readonly Row[], onRows: readonly Row[]): PairedRow[] {
  const onByKey = new Map<string, Row>();
  for (const r of onRows) onByKey.set(`${r.seed}::${r.companyId}::${r.turn}`, r);
  const paired: PairedRow[] = [];
  for (const off of offRows) {
    const on = onByKey.get(`${off.seed}::${off.companyId}::${off.turn}`);
    if (!on) continue;
    const { breakPoint, reason } = classifyBreakPoint(off, on);
    paired.push({
      seed: off.seed,
      companyId: off.companyId,
      turn: off.turn,
      off,
      on,
      requiredBorrowingDeltaUsd: on.newFormulaDesiredBorrowingUsd - off.oldFormulaDesiredBorrowingUsd,
      submittedDeltaUsd: on.actualSubmittedDesiredAmountUsd - off.actualSubmittedDesiredAmountUsd,
      approvedDeltaUsd: on.approvedNormalLoanUsd - off.approvedNormalLoanUsd,
      drawDeltaUsd: on.actualLoanDrawUsd - off.actualLoanDrawUsd,
      procurementDesiredDeltaTons: on.procurementDesiredQuantityTons - off.procurementDesiredQuantityTons,
      procurementConstrainedDeltaTons: on.procurementConstrainedQuantityTons - off.procurementConstrainedQuantityTons,
      producedDeltaTons: on.totalProducedTons - off.totalProducedTons,
      breakPoint,
      breakPointReason: reason,
    });
  }
  return paired;
}

function fmtUsd(v: number): string {
  return `${(v / 1e6).toFixed(3)}M`;
}

function main(): void {
  const outDir = path.resolve(process.cwd(), "artifacts/sai6/phase1a2");
  fs.mkdirSync(outDir, { recursive: true });

  console.log("実測中: off ...");
  const offRows = collect("off");
  console.log("実測中: on ...");
  const onRows = collect("on");

  const paired = pairRows(offRows, onRows);

  // --- 破綻前3Qのケースだけ抽出（因果監査の対象と揃える） ---
  const firstDefaultTurnByCase = new Map<string, number>();
  for (const r of offRows) {
    if (!r.paymentDefault) continue;
    const key = `${r.seed}::${r.companyId}`;
    const prev = firstDefaultTurnByCase.get(key);
    if (prev === undefined || r.turn < prev) firstDefaultTurnByCase.set(key, r.turn);
  }
  const preDefaultWindow = paired.filter((p) => {
    const first = firstDefaultTurnByCase.get(`${p.seed}::${p.companyId}`);
    return first !== undefined && p.turn >= first - 3 && p.turn <= first;
  });

  const breakPointCounts: Record<BreakPoint, number> = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 };
  for (const p of preDefaultWindow) breakPointCounts[p.breakPoint]++;

  fs.writeFileSync(
    path.join(outDir, "paired_window.json"),
    JSON.stringify({ generator: "scripts/sai6Phase1A2CausalConnectionAudit.ts", breakPointCounts, preDefaultWindow }, null, 2)
  );

  const csvHeader = [
    "seed,companyId,turn,breakPoint",
    "off_openingCash,off_reliableInflows,off_plannedOutflows,off_projectedEndingCash,off_oldDesiredBorrowing,off_newDesiredBorrowing,off_actualSubmitted,off_approved,off_draw,off_capacity",
    "on_openingCash,on_reliableInflows,on_plannedOutflows,on_projectedEndingCash,on_oldDesiredBorrowing,on_newDesiredBorrowing,on_actualSubmitted,on_approved,on_draw,on_capacity",
    "off_cashPressure,off_severeCash,off_procDesired,off_procConstrained,off_scaleRatio,off_rawMaterialShortfall,off_produced,off_closingCash,off_paymentDefault",
    "on_cashPressure,on_severeCash,on_procDesired,on_procConstrained,on_scaleRatio,on_rawMaterialShortfall,on_produced,on_closingCash,on_paymentDefault",
  ].join(",");
  const csvRows = preDefaultWindow.map((p) =>
    [
      p.seed,
      p.companyId,
      p.turn,
      p.breakPoint,
      p.off.openingCashUsd.toFixed(0),
      p.off.reliableCashInflowsUsd.toFixed(0),
      p.off.plannedCashOutflowsUsd.toFixed(0),
      p.off.projectedEndingCashBeforeNewBorrowingUsd.toFixed(0),
      p.off.oldFormulaDesiredBorrowingUsd.toFixed(0),
      p.off.newFormulaDesiredBorrowingUsd.toFixed(0),
      p.off.actualSubmittedDesiredAmountUsd.toFixed(0),
      p.off.approvedNormalLoanUsd.toFixed(0),
      p.off.actualLoanDrawUsd.toFixed(0),
      p.off.borrowingCapacityAvailableUsd.toFixed(0),
      p.on.openingCashUsd.toFixed(0),
      p.on.reliableCashInflowsUsd.toFixed(0),
      p.on.plannedCashOutflowsUsd.toFixed(0),
      p.on.projectedEndingCashBeforeNewBorrowingUsd.toFixed(0),
      p.on.oldFormulaDesiredBorrowingUsd.toFixed(0),
      p.on.newFormulaDesiredBorrowingUsd.toFixed(0),
      p.on.actualSubmittedDesiredAmountUsd.toFixed(0),
      p.on.approvedNormalLoanUsd.toFixed(0),
      p.on.actualLoanDrawUsd.toFixed(0),
      p.on.borrowingCapacityAvailableUsd.toFixed(0),
      p.off.cashPressure.toFixed(4),
      p.off.severeCash ? 1 : 0,
      p.off.procurementDesiredQuantityTons.toFixed(2),
      p.off.procurementConstrainedQuantityTons.toFixed(2),
      p.off.procurementScaleRatio.toFixed(4),
      p.off.rawMaterialShortfallTons.toFixed(2),
      p.off.totalProducedTons.toFixed(2),
      p.off.closingCashUsd.toFixed(0),
      p.off.paymentDefault ? 1 : 0,
      p.on.cashPressure.toFixed(4),
      p.on.severeCash ? 1 : 0,
      p.on.procurementDesiredQuantityTons.toFixed(2),
      p.on.procurementConstrainedQuantityTons.toFixed(2),
      p.on.procurementScaleRatio.toFixed(4),
      p.on.rawMaterialShortfallTons.toFixed(2),
      p.on.totalProducedTons.toFixed(2),
      p.on.closingCashUsd.toFixed(0),
      p.on.paymentDefault ? 1 : 0,
    ].join(",")
  );
  fs.writeFileSync(path.join(outDir, "paired_window.csv"), [csvHeader, ...csvRows].join("\n"));

  // --- A類型5ケースの個別再確認 ---
  const A_TYPE_CASES = [
    { seed: "sai5-ab-001", companyId: "BAL" },
    { seed: "sai5-ab-001", companyId: "JPQ" },
    { seed: "sai5-ab-001", companyId: "VAP" },
    { seed: "sai5-ab-002", companyId: "MASS" },
    { seed: "sai5-ab-004", companyId: "VAP" },
  ];
  const aTypeDetail = A_TYPE_CASES.map(({ seed, companyId }) => {
    const rows = preDefaultWindow.filter((p) => p.seed === seed && p.companyId === companyId).sort((a, b) => a.turn - b.turn);
    return { seed, companyId, rows };
  });

  const L: string[] = [];
  L.push("# SAI-6 Phase 1A-2 因果接続監査 — OFF/ON差分の遮断点分類");
  L.push("");
  L.push(`破綻前3Q〜default四半期の窓、全体で${preDefaultWindow.length}件（seed4×5社の破綻ケース）。`);
  L.push("");
  L.push("## 遮断点の分布（作業1）");
  L.push("");
  L.push("| 遮断点 | 件数 | 説明 |");
  L.push("|---|---:|---|");
  L.push(`| A. 新旧式の必要借入額がほぼ同じ | ${breakPointCounts.A} | 式の違いが実質的に効いていない四半期 |`);
  L.push(`| B. 希望額は増えるが承認額・実行額は不変 | ${breakPointCounts.B} | 借入余力上限、または銀行審査の他条件で吸収 |`);
  L.push(`| C. 借入実行額は増えるが当期調達へ反映されない | ${breakPointCounts.C} | procurement判断がfinance判断より前に確定しているため |`);
  L.push(`| D. 調達量は増えるが生産量は増えない | ${breakPointCounts.D} | 原料以外の制約（労務・設備）が律速 |`);
  L.push(`| E. 入出金見積りの欠落・過大計上の疑い | ${breakPointCounts.E} | 主要入出金項目がほぼゼロ |`);
  L.push(`| F. その他（要個別確認） | ${breakPointCounts.F} | 上記に当てはまらない |`);
  L.push("");
  L.push("## A類型5ケースの個別再確認（作業1）");
  L.push("");
  for (const { seed, companyId, rows } of aTypeDetail) {
    L.push(`### ${seed} / ${companyId}`);
    L.push("");
    if (rows.length === 0) {
      L.push("（破綻前3Q窓に該当する四半期データなし）");
      L.push("");
      continue;
    }
    L.push("| turn | 遮断点 | off必要借入(新式) | on必要借入(新式) | off借入実行 | on借入実行 | off調達実行(t) | on調達実行(t) | off生産(t) | on生産(t) |");
    L.push("|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|");
    for (const p of rows) {
      L.push(
        `| ${p.turn} | ${p.breakPoint} | ${fmtUsd(p.off.newFormulaDesiredBorrowingUsd)} | ${fmtUsd(p.on.newFormulaDesiredBorrowingUsd)} | ${fmtUsd(p.off.actualLoanDrawUsd)} | ${fmtUsd(p.on.actualLoanDrawUsd)} | ${p.off.procurementConstrainedQuantityTons.toFixed(0)} | ${p.on.procurementConstrainedQuantityTons.toFixed(0)} | ${p.off.totalProducedTons.toFixed(0)} | ${p.on.totalProducedTons.toFixed(0)} |`
      );
    }
    L.push("");
    L.push(`理由（最終四半期）: ${rows[rows.length - 1].breakPointReason}`);
    L.push("");
  }

  fs.writeFileSync(path.join(outDir, "breakpoint_report.md"), L.join("\n"));
  console.log(`\n出力: ${outDir}/{paired_window.json, paired_window.csv, breakpoint_report.md}`);
  console.log(L.join("\n"));
}

main();
