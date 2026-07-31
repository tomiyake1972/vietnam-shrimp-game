#!/usr/bin/env -S npx tsx
// ShrimpX V2 — SAI-6 Phase 1A: 「借入不足→原料調達縮小→生産不能→売上減少→
// paymentDefault」仮説の実データ因果監査。
//
// 【重要】本スクリプトはエンジン・標準AIの本体ロジックを一切変更しない。
// 既存の control 設定（SAI-5機能OFF）で実エンジンを回し、各社ケースの
// 最初の paymentDefault の前後を四半期単位で追跡し、記録・分類するだけの
// 読み取り専用の診断スクリプトである（実装済みfinance/procurementロジックの
// 挙動をそのまま観測する）。
//
// 【仮説】「借入余力があるにもかかわらず、AIが必要額を借りず、現金制約で
// 原料調達が縮小し、生産不能→売上減少→paymentDefaultへ連鎖している」
//
// 【分類】
//   A. 借入不足による流動性破綻
//   B. 借入では解決できない構造的赤字
//   C. 入金・支払タイミングのズレによるもの
//   D. 破綻後に現れる下流の結果（原因ではない）

import * as fs from "node:fs";
import * as path from "node:path";
import { runAutoplayCase } from "../app/lib/v2/companyLab/standardAi/autoplay/runCase";
import { ALL_COMPANY_IDS } from "../app/lib/v2/companyLab/standardAi/report/decomposeHarness";
import {
  STANDARD_BASELINE_CANDIDATES,
  SELECTED_STANDARD_BASELINE_CANDIDATE_ID,
} from "../app/lib/v2/companyLab/standardAi/report/standardBaseline";
import { unwrapUnit } from "../app/lib/v2/core/units";

const candidate = STANDARD_BASELINE_CANDIDATES.find((c) => c.id === SELECTED_STANDARD_BASELINE_CANDIDATE_ID)!;
const SEEDS = Array.from({ length: 4 }, (_, i) => `sai5-ab-${String(i + 1).padStart(3, "0")}`);
const QUARTERS = 32;
const LOOKBACK_QUARTERS = 3; // 最初のpaymentDefaultの何四半期前から記録するか

function toNumber(v: unknown): number {
  if (v === undefined || v === null) return 0;
  return typeof v === "number" ? v : Number(v);
}

interface AuditRow {
  seed: string;
  companyId: string;
  turn: number;
  quartersBeforeDefault: number; // 0 = default四半期そのもの、正の値=手前、負の値=破綻後
  // --- 資金 ---
  openingCashUsd: number;
  reliableInflowsUsd: number; // 顧客からの回収（receiptsFromCustomers, 既に決済期到来分）
  plannedOutflowsUsd: number; // 原料・製造・販管・利息・税（新規借入・元本返済を含まない）
  projectedEndingCashBeforeNewBorrowingUsd: number;
  targetMinimumCashUsd: number;
  requiredBorrowingProxyUsd: number; // max(0, targetMinimumCash - projectedEndingCashBeforeNewBorrowing)
  aiRequestedBorrowingUsd: number; // decision.financingRequest.desiredAmountUsd（AIの希望）
  approvedNormalLoanUsd: number; // 銀行が承認した通常融資枠
  actualLoanDrawUsd: number; // 通常＋緊急の実際の借入実行額
  availableAdditionalBorrowingCapacityUsd: number;
  borrowingShortfallUsd: number; // max(0, requiredBorrowingProxy - actualLoanDraw)
  capacityWasAvailable: boolean; // 借入余力 > 実際の借入 + 微小値
  // --- 調達 ---
  desiredDomesticPurchaseTons: number;
  constrainedDomesticPurchaseTons: number;
  procurementScaleRatio: number;
  procurementCashConstrainedDiagnosticFired: boolean; // AI自身の自制（procurement.ts）
  procurementLiquidityScaledDown: boolean; // liquidityClose.tsのscaleRatio<1
  // --- 生産・売上 ---
  desiredProductionTons: number;
  actualProducedTons: number;
  rawMaterialShortfallTons: number;
  netRevenueUsd: number;
  operatingProfitUsd: number;
  // --- 財務健全性 ---
  paymentDefault: boolean;
  insolvent: boolean;
  usedEmergencyLoan: boolean;
}

function collect(): AuditRow[] {
  const rows: AuditRow[] = [];
  for (const seed of SEEDS) {
    const result = runAutoplayCase({
      scenarioId: "baseline",
      seed,
      quarters: QUARTERS,
      companyIds: ALL_COMPANY_IDS,
      candidate,
      // control: SAI-5機能はすべてOFF（デフォルト）
    });

    for (const h of result.history) {
      for (const companyId of ALL_COMPANY_IDS) {
        const fin = h.financialResults.find((f) => f.companyId === companyId);
        const summary = h.companySummaries.find((s) => s.companyId === companyId);
        const financing = h.financingResults.find((f) => f.companyId === companyId);
        const diag = result.diagnostics.find((d) => d.turn === h.turn && d.companyId === companyId);
        if (!fin || !summary || !financing || !diag) continue;

        const cf = fin.profitAndLoss;
        const cashFlow = fin.cashFlow;
        const od = cashFlow.operatingDirect;

        const reliableInflowsUsd = toNumber(od.receiptsFromCustomers);
        const plannedOutflowsUsd =
          Math.abs(toNumber(od.paymentsForRawMaterials)) +
          Math.abs(toNumber(od.paymentsForManufacturing)) +
          Math.abs(toNumber(od.paymentsForSellingGeneralAdmin)) +
          Math.abs(toNumber(od.interestPaid)) +
          Math.abs(toNumber(od.incomeTaxPaid));
        const openingCashUsd = toNumber(cashFlow.openingCash);
        const projectedEndingCashBeforeNewBorrowingUsd = openingCashUsd + reliableInflowsUsd - plannedOutflowsUsd;
        const targetMinimumCashUsd = diag.pressures.targetMinimumCashUsd;
        const requiredBorrowingProxyUsd = Math.max(0, targetMinimumCashUsd - projectedEndingCashBeforeNewBorrowingUsd);

        const aiRequestedBorrowingUsd = toNumber(diag.decision.financingRequest.desiredAmountUsd);
        const approvedNormalLoanUsd = toNumber(financing.underwriting.approvedAmountUsd);
        const actualLoanDrawUsd = toNumber(financing.loanDrawUsd);
        const availableAdditionalBorrowingCapacityUsd = toNumber(financing.borrowingCapacity.availableAdditionalCapacityUsd);
        const borrowingShortfallUsd = Math.max(0, requiredBorrowingProxyUsd - actualLoanDrawUsd);
        const capacityWasAvailable = availableAdditionalBorrowingCapacityUsd > 1000; // 千USD超なら「余力あり」とみなす

        const pc = (financing as unknown as { procurementConstraint?: {
          originalDomesticPurchaseQuantityTons: number;
          constrainedDomesticPurchaseQuantityTons: number;
          scaleRatio: number;
        }; }).procurementConstraint;
        const desiredDomesticPurchaseTons = pc ? pc.originalDomesticPurchaseQuantityTons : unwrapUnit(diag.decision.domesticPurchasePlan.desiredQuantity);
        const constrainedDomesticPurchaseTons = pc ? pc.constrainedDomesticPurchaseQuantityTons : desiredDomesticPurchaseTons;
        const procurementScaleRatio = pc ? pc.scaleRatio : 1;
        const procurementCashConstrainedDiagnosticFired = diag.entries.some((e) => e.code === "PROCUREMENT_CASH_CONSTRAINED");
        const procurementLiquidityScaledDown = procurementScaleRatio < 0.999;

        const desiredProductionTons = diag.decision.productionPlans.reduce((s, p) => s + unwrapUnit(p.desiredQuantity), 0);
        const actualProducedTons = unwrapUnit(summary.hosoProduced) + unwrapUnit(summary.pdProduced) + unwrapUnit(summary.vapProduced);
        const rawMaterialShortfallTons = unwrapUnit(summary.rawMaterialShortfall);

        rows.push({
          seed,
          companyId,
          turn: h.turn,
          quartersBeforeDefault: NaN, // 後段で埋める
          openingCashUsd,
          reliableInflowsUsd,
          plannedOutflowsUsd,
          projectedEndingCashBeforeNewBorrowingUsd,
          targetMinimumCashUsd,
          requiredBorrowingProxyUsd,
          aiRequestedBorrowingUsd,
          approvedNormalLoanUsd,
          actualLoanDrawUsd,
          availableAdditionalBorrowingCapacityUsd,
          borrowingShortfallUsd,
          capacityWasAvailable,
          desiredDomesticPurchaseTons,
          constrainedDomesticPurchaseTons,
          procurementScaleRatio,
          procurementCashConstrainedDiagnosticFired,
          procurementLiquidityScaledDown,
          desiredProductionTons,
          actualProducedTons,
          rawMaterialShortfallTons,
          netRevenueUsd: toNumber(cf.netRevenue),
          operatingProfitUsd: toNumber(cf.operatingProfit),
          paymentDefault: financing.financialHealth.paymentDefault === true,
          insolvent: financing.financialHealth.insolvent === true,
          usedEmergencyLoan: financing.financialHealth.usedEmergencyLoanThisPeriod === true,
        });
      }
    }
    console.log(`  control / ${seed}: ${result.completedTurns}Q 完走`);
  }
  return rows;
}

interface CaseClassification {
  seed: string;
  companyId: string;
  firstDefaultTurn: number;
  category: "A" | "B" | "C" | "D" | "none";
  reasonJa: string;
  evidence: {
    quartersWithCapacityAvailableButShortfall: number;
    quartersWithProcurementConstrained: number;
    quartersWithRawMaterialShortfall: number;
    borrowingShortfallPrecedesProcurementContraction: boolean;
    fullCapacityUsedButStillShort: boolean;
    meanBorrowingShortfallUsd: number;
    meanAvailableCapacityUsd: number;
  };
}

function classifyCases(rows: AuditRow[]): { windowed: AuditRow[]; classifications: CaseClassification[] } {
  const byCase = new Map<string, AuditRow[]>();
  for (const r of rows) {
    const key = `${r.seed}::${r.companyId}`;
    const arr = byCase.get(key);
    if (arr) arr.push(r);
    else byCase.set(key, [r]);
  }

  const windowed: AuditRow[] = [];
  const classifications: CaseClassification[] = [];

  for (const [key, caseRows] of byCase.entries()) {
    const sorted = [...caseRows].sort((a, b) => a.turn - b.turn);
    const firstDefault = sorted.find((r) => r.paymentDefault);
    if (!firstDefault) continue; // このケースは32Q以内に破綻していない→監査対象外（ご指示どおりdefaultケースのみ追跡）

    const [seed, companyId] = key.split("::");
    const lo = firstDefault.turn - LOOKBACK_QUARTERS;
    const windowRows = sorted.filter((r) => r.turn >= lo && r.turn <= firstDefault.turn);
    for (const r of windowRows) {
      windowed.push({ ...r, quartersBeforeDefault: firstDefault.turn - r.turn });
    }

    // 破綻「前」（当該四半期含む）だけで因果を評価する（破綻後はD類型として別扱い）。
    const preRows = windowRows.filter((r) => r.turn <= firstDefault.turn);

    const quartersWithCapacityAvailableButShortfall = preRows.filter(
      (r) => r.capacityWasAvailable && r.borrowingShortfallUsd > 1000
    ).length;
    const quartersWithProcurementConstrained = preRows.filter(
      (r) => r.procurementCashConstrainedDiagnosticFired || r.procurementLiquidityScaledDown
    ).length;
    const quartersWithRawMaterialShortfall = preRows.filter((r) => r.rawMaterialShortfallTons > 1).length;

    // 時間的前後関係: 「借入不足が発生した四半期」が「調達縮小が発生した四半期」と
    // 同期または先行しているか（同一四半期内の因果は許容。調達縮小の方が先行する
    // ケースは仮説と矛盾する＝Cまたは別要因の可能性）。
    const shortfallTurns = preRows.filter((r) => r.capacityWasAvailable && r.borrowingShortfallUsd > 1000).map((r) => r.turn);
    const constrainedTurns = preRows
      .filter((r) => r.procurementCashConstrainedDiagnosticFired || r.procurementLiquidityScaledDown)
      .map((r) => r.turn);
    const borrowingShortfallPrecedesProcurementContraction =
      shortfallTurns.length > 0 &&
      constrainedTurns.length > 0 &&
      Math.min(...shortfallTurns) <= Math.min(...constrainedTurns);

    // 借入余力自体がほぼゼロ（凍結・支払不能等）で「借りたくても借りられない」ケース
    // →借入判断の是正では解決しない構造的問題（B類型）。
    const fullCapacityUsedButStillShort =
      preRows.filter((r) => r.availableAdditionalBorrowingCapacityUsd < 1000 && r.plannedOutflowsUsd > r.openingCashUsd + r.reliableInflowsUsd).length >=
      Math.max(1, preRows.length - 1);

    const meanBorrowingShortfallUsd = preRows.length ? preRows.reduce((s, r) => s + r.borrowingShortfallUsd, 0) / preRows.length : 0;
    const meanAvailableCapacityUsd = preRows.length ? preRows.reduce((s, r) => s + r.availableAdditionalBorrowingCapacityUsd, 0) / preRows.length : 0;

    let category: CaseClassification["category"];
    let reasonJa: string;
    if (fullCapacityUsedButStillShort) {
      category = "B";
      reasonJa = "借入余力がほぼ枯渇（凍結・支払不能等）しており、借入判断を是正しても解決しない構造的赤字。";
    } else if (
      quartersWithCapacityAvailableButShortfall > 0 &&
      quartersWithProcurementConstrained > 0 &&
      quartersWithRawMaterialShortfall > 0 &&
      borrowingShortfallPrecedesProcurementContraction
    ) {
      category = "A";
      reasonJa = "借入余力があるのに必要額を借りず、それが原料調達の現金制約→原料不足に先行して連鎖している。";
    } else if (quartersWithCapacityAvailableButShortfall > 0 && quartersWithProcurementConstrained === 0) {
      category = "C";
      reasonJa = "借入不足自体は観測されるが、調達縮小には結びついていない（入金・支払タイミングのズレ、または他要因が支配的）。";
    } else {
      category = "D";
      reasonJa = "破綻前の窓では借入不足・調達縮小・原料不足の連鎖が確認できない（下流の結果、または他要因）。";
    }

    classifications.push({
      seed,
      companyId,
      firstDefaultTurn: firstDefault.turn,
      category,
      reasonJa,
      evidence: {
        quartersWithCapacityAvailableButShortfall,
        quartersWithProcurementConstrained,
        quartersWithRawMaterialShortfall,
        borrowingShortfallPrecedesProcurementContraction,
        fullCapacityUsedButStillShort,
        meanBorrowingShortfallUsd,
        meanAvailableCapacityUsd,
      },
    });
  }

  return { windowed, classifications };
}

function fmtUsd(v: number): string {
  return `${(v / 1e6).toFixed(3)}M`;
}

function main(): void {
  const outDir = path.resolve(process.cwd(), "artifacts/sai6/phase1a");
  fs.mkdirSync(outDir, { recursive: true });

  console.log("実測中: control（因果監査、破綻前後の窓）...");
  const rows = collect();
  const { windowed, classifications } = classifyCases(rows);

  const counts = { A: 0, B: 0, C: 0, D: 0, none: 0 };
  for (const c of classifications) counts[c.category]++;

  fs.writeFileSync(
    path.join(outDir, "classifications.json"),
    JSON.stringify({ generator: "scripts/sai6Phase1ACausalAudit.ts", seeds: SEEDS, lookbackQuarters: LOOKBACK_QUARTERS, counts, classifications }, null, 2)
  );

  const csvHeader = [
    "seed,companyId,turn,quartersBeforeDefault,openingCashUsd,reliableInflowsUsd,plannedOutflowsUsd,projectedEndingCashBeforeNewBorrowingUsd",
    "targetMinimumCashUsd,requiredBorrowingProxyUsd,aiRequestedBorrowingUsd,approvedNormalLoanUsd,actualLoanDrawUsd,availableAdditionalBorrowingCapacityUsd,borrowingShortfallUsd,capacityWasAvailable",
    "desiredDomesticPurchaseTons,constrainedDomesticPurchaseTons,procurementScaleRatio,procurementCashConstrainedDiagnosticFired,procurementLiquidityScaledDown",
    "desiredProductionTons,actualProducedTons,rawMaterialShortfallTons,netRevenueUsd,operatingProfitUsd,paymentDefault,insolvent,usedEmergencyLoan",
  ].join(",");
  const csvRows = [...windowed]
    .sort((a, b) => (a.seed + a.companyId).localeCompare(b.seed + b.companyId) || a.turn - b.turn)
    .map((r) =>
      [
        r.seed,
        r.companyId,
        r.turn,
        r.quartersBeforeDefault,
        r.openingCashUsd.toFixed(0),
        r.reliableInflowsUsd.toFixed(0),
        r.plannedOutflowsUsd.toFixed(0),
        r.projectedEndingCashBeforeNewBorrowingUsd.toFixed(0),
        r.targetMinimumCashUsd.toFixed(0),
        r.requiredBorrowingProxyUsd.toFixed(0),
        r.aiRequestedBorrowingUsd.toFixed(0),
        r.approvedNormalLoanUsd.toFixed(0),
        r.actualLoanDrawUsd.toFixed(0),
        r.availableAdditionalBorrowingCapacityUsd.toFixed(0),
        r.borrowingShortfallUsd.toFixed(0),
        r.capacityWasAvailable ? 1 : 0,
        r.desiredDomesticPurchaseTons.toFixed(2),
        r.constrainedDomesticPurchaseTons.toFixed(2),
        r.procurementScaleRatio.toFixed(4),
        r.procurementCashConstrainedDiagnosticFired ? 1 : 0,
        r.procurementLiquidityScaledDown ? 1 : 0,
        r.desiredProductionTons.toFixed(2),
        r.actualProducedTons.toFixed(2),
        r.rawMaterialShortfallTons.toFixed(2),
        r.netRevenueUsd.toFixed(0),
        r.operatingProfitUsd.toFixed(0),
        r.paymentDefault ? 1 : 0,
        r.insolvent ? 1 : 0,
        r.usedEmergencyLoan ? 1 : 0,
      ].join(",")
    );
  fs.writeFileSync(path.join(outDir, "window.csv"), [csvHeader, ...csvRows].join("\n"));

  const L: string[] = [];
  L.push("# SAI-6 Phase 1A 因果監査結果（control、破綻前後の窓）");
  L.push("");
  L.push(`${SEEDS.length} seed × ${ALL_COMPANY_IDS.length}社。破綻した会社ケース: ${classifications.length}。`);
  L.push(`窓: 最初のpaymentDefaultの${LOOKBACK_QUARTERS}四半期前〜default発生四半期。`);
  L.push("");
  L.push("## 分類結果");
  L.push("");
  L.push("| 類型 | 件数 | 説明 |");
  L.push("|---|---:|---|");
  L.push(`| A. 借入不足による流動性破綻 | ${counts.A} | 借入余力があるのに必要額を借りず、それが原料調達の現金制約→原料不足に先行して連鎖 |`);
  L.push(`| B. 借入では解決できない構造的赤字 | ${counts.B} | 借入余力がほぼ枯渇しており、借入判断の是正では解決しない |`);
  L.push(`| C. タイミングのズレ等 | ${counts.C} | 借入不足自体はあるが、調達縮小には結びついていない |`);
  L.push(`| D. 下流の結果／その他 | ${counts.D} | 破綻前の窓で借入不足→調達縮小→原料不足の連鎖が確認できない |`);
  L.push("");
  L.push("## ケース別詳細");
  L.push("");
  L.push("| seed | 会社 | 破綻四半期 | 類型 | 借入余力あり×不足 四半期数 | 調達制約 四半期数 | 原料不足 四半期数 | 借入不足→調達縮小の先行 | 平均借入不足 | 平均借入余力 |");
  L.push("|---|---|---:|---|---:|---:|---:|---|---:|---:|");
  for (const c of classifications) {
    L.push(
      `| ${c.seed} | ${c.companyId} | ${c.firstDefaultTurn} | **${c.category}** | ${c.evidence.quartersWithCapacityAvailableButShortfall} | ${c.evidence.quartersWithProcurementConstrained} | ${c.evidence.quartersWithRawMaterialShortfall} | ${c.evidence.borrowingShortfallPrecedesProcurementContraction ? "○" : "×"} | ${fmtUsd(c.evidence.meanBorrowingShortfallUsd)} | ${fmtUsd(c.evidence.meanAvailableCapacityUsd)} |`
    );
  }
  L.push("");
  L.push("## 仮説検証の判定条件（ご指示）");
  L.push("");
  const conditionA = classifications.some((c) => c.evidence.quartersWithCapacityAvailableButShortfall > 0);
  const conditionB = classifications.some((c) => c.evidence.meanBorrowingShortfallUsd > 0);
  const conditionC = classifications.some((c) => c.evidence.quartersWithProcurementConstrained > 0);
  const conditionD = counts.A > 0;
  L.push(`- (a) 破綻前の複数ケースで借入余力が残っている: ${conditionA ? "確認" : "未確認"}`);
  L.push(`- (b) 実際の借入額が資金見通し上の必要額を下回っている: ${conditionB ? "確認" : "未確認"}`);
  L.push(`- (c) 現金制約による原料調達縮小が続いている: ${conditionC ? "確認" : "未確認"}`);
  L.push(`- (d) 十分な借入があればその縮小の一部を回避できた可能性がある（A類型が存在する）: ${conditionD ? "確認" : "未確認"}`);
  L.push("");
  const allConfirmed = conditionA && conditionB && conditionC && conditionD;
  L.push(`**総合判定: ${allConfirmed ? "仮説を支持する証拠あり（A類型が存在）→ Phase 1A 実装条件を満たす" : "仮説を支持する証拠が不十分 → Phase 1A実装見送りを検討"}**`);
  L.push("");
  L.push("【注記】requiredBorrowingProxyUsd はこの監査専用の簡易プロキシ（期首現金＋顧客からの回収−当期支出、を最低現金バッファまで埋めるのに必要な額）であり、");
  L.push("実装時の正式な資金見通し・必要借入計算式とは別物である。原料調達の現金制約は procurement.ts（AI自身の希望量自制、PROCUREMENT_CASH_CONSTRAINED診断）と");
  L.push("liquidityClose.ts（承認済み融資枠＋期首現金に基づく事後スケール、scaleRatio）の二段階で発生し得るため、両方を`procurementCashConstrainedDiagnosticFired`/`procurementLiquidityScaledDown`として別々に記録した。");

  fs.writeFileSync(path.join(outDir, "causal_audit_report.md"), L.join("\n"));
  console.log(`\n出力: ${outDir}/{classifications.json, window.csv, causal_audit_report.md}`);
  console.log(L.join("\n"));
}

main();
