#!/usr/bin/env -S npx tsx
// ShrimpX V2 — SAI-6 Phase 1A-2 追加監査: 「調達時の資金制約 179/208件」の直接原因分解
//
// 三宅さんのご指摘（2026-08-01夜）: control生存期間で
//   - 調達時の資金制約（procurementConstraint.scaleRatio<1） 179/208件
//   - 会社全体の利用可能資金不足（借入余力超過）            20/208件
//   - 平均資金枠余裕                                        +14.79M
// という一見矛盾する3つの数値を、179件を一律「銀行与信上限が支配的制約」と
// 分類せずに、次の4つの反実仮想（counterfactual）カバレッジ判定に分解して説明する。
//
// 【2026-08-01夜・訂正（三宅さんのご指摘）】以下(A)(C)(D)はいずれも
// 「特定の追加資金を仮に全額動員できたと仮定した反実仮想で、資金需要が充足するか」
// を判定しているに過ぎない。当期の売掛金回収（reliableCashInflowsUsd）は買掛金・
// 人件費・元利払い・加工費・SGA・法人税等、国内原料買付以外にも競合する使途があり、
// それらを実際に差し引いた上で買付に回せたかどうかは本スクリプトでは未検証。
// 同様に緊急融資も、調達判断の時点で実際に引き出せたかどうか（時間順序の制約）は
// 未検証であり、「反実仮想上カバーされる」ことと「実際に利用可能だった」ことは別問題。
// したがって(A)(C)(D)はいずれも「原因の確定」ではなく「反実仮想でのカバレッジ」を
// 意味する分類名に改めている。
//
//   (A) gross funding upper bound（与信上限＋緊急融資＋当期売掛金回収の全額を
//       すべて動員できたと仮定した反実仮想上の資金上限）でもなお国内買付の
//       必要額を満たせないケース（0件）。「真の資金不足」への一般化はしない。
//   (B) procurementが承認可能借入額（＝与信上限そのもの）を認識しないこと …
//       与信上限（capacity.availableAdditionalCapacityUsd）自体は必要額を
//       満たすのに、AIの実際の申請額（financingRequest.desiredAmountUsd）が
//       それに届かず、承認額が申請額どまりになっている
//   (C) 緊急融資を調達時点で利用できたと仮定する反実仮想では充足する … 通常融資の
//       承認自体は同一四半期・同一ループ内でprocurementの制約計算より前に確定する
//       （既存の因果接続監査で確認済み）が、緊急融資（emergencyLoan）は
//       `closeQuarterWithFinancing`（四半期末）で初めて確定し、procurementの
//       制約計算より後になる。したがって、当期に緊急融資が出た会社では、
//       procurementはその緊急融資を一切認識できない。ここでの判定は「もし
//       procurementの時点で緊急融資分を先に使えたと仮定したら充足するか」という
//       反実仮想であり、「実際にその時点で利用可能だった」ことの証明ではない
//   (D) 当期売掛金回収を全額利用する反実仮想では充足する … procurementの
//       流動性チェックは「前期末現金の60%（domesticPurchaseCashAllocationRatio）
//       ＋承認済み通常融資」だけを見ており、当期中に決済期が到来する売掛金回収
//       （当期の確実な収入、fundingOutlookのreliableCashInflowsUsdと同じ定義。
//       ただし本スクリプトはfundingOutlookのON/OFFに関わらず、常にこの値を
//       独立に再計算するだけで、意思決定ロジックは一切変更しない）を国内買付へ
//       仮に全額充当できたと仮定すれば充足する、という反実仮想上のカバレッジで
//       あり、当期売掛金回収は買掛金・人件費・元利払い・加工費・SGA・法人税等の
//       競合する使途もあるため、実際に買付へ回せたかどうかは未検証・未確立である
//
// 判定の優先順位（安価な説明から順に、実際にデータで確認する）:
//   1. 与信上限（capacity）だけで足りるか？ → 足りれば (B)
//   2. 与信上限＋当期の緊急融資（あれば、反実仮想）で足りるか？ → 足りれば (C)
//   3. 与信上限＋緊急融資＋当期の確実な収入（反実仮想）で足りるか？ → 足りれば (D)
//   4. それでも足りなければ (A)
//
// 【重要】本スクリプトは読み取り専用の診断であり、エンジン・標準AI本体の
// ロジックは一切変更しない。procurement/financeの決定順序、cashPressure本体、
// pendingHires、価格戦略、capex、初期資本構成は変更していない。

import * as fs from "node:fs";
import * as path from "node:path";
import { runAutoplayCase } from "../app/lib/v2/companyLab/standardAi/autoplay/runCase";
import { ALL_COMPANY_IDS } from "../app/lib/v2/companyLab/standardAi/report/decomposeHarness";
import {
  STANDARD_BASELINE_CANDIDATES,
  SELECTED_STANDARD_BASELINE_CANDIDATE_ID,
} from "../app/lib/v2/companyLab/standardAi/report/standardBaseline";
import { FINANCING_PARAMETERS_V1 } from "../app/lib/v2/financing/parameters";
import { ProcurementConstraintResult, EmergencyLoanResult } from "../app/lib/v2/financing/types";

const candidate = STANDARD_BASELINE_CANDIDATES.find((c) => c.id === SELECTED_STANDARD_BASELINE_CANDIDATE_ID)!;
const SEEDS = Array.from({ length: 4 }, (_, i) => `sai5-ab-${String(i + 1).padStart(3, "0")}`);
const QUARTERS = 32;
const EPS = 1e-6;
const ALLOCATION_RATIO = FINANCING_PARAMETERS_V1.liquidity.domesticPurchaseCashAllocationRatio;

function toNumber(v: unknown): number {
  if (v === undefined || v === null) return 0;
  return typeof v === "number" ? v : Number(v);
}

type Category =
  | "A_gross_upper_bound_insufficient"
  | "B_request_below_capacity"
  | "C_emergency_loan_counterfactual_covers"
  | "D_gross_ar_inclusive_counterfactual_covers"
  | "none_not_constrained";

interface Row {
  seed: string;
  companyId: string;
  turn: number;
  preDefault: boolean;
  plannedCashNeedUsd: number;
  prevCashUsd: number;
  allocatedPrevCashUsd: number;
  requestedAmountUsd: number;
  approvedAmountUsd: number;
  capacityCeilingUsd: number;
  emergencyLoanApprovedUsd: number;
  reliableCashInflowsUsd: number;
  actualScaleRatio: number;
  ratioWithCapacityCeiling: number;
  ratioWithEmergencyLoan: number;
  ratioWithReliableInflow: number;
  category: Category;
}

function scaleRatioFor(availableLiquidityUsd: number, plannedCashNeedUsd: number): number {
  if (plannedCashNeedUsd <= FINANCING_PARAMETERS_V1.epsilonUsd) return 1;
  return Math.max(0, Math.min(1, availableLiquidityUsd / plannedCashNeedUsd));
}

function collect(): Row[] {
  const rows: Row[] = [];
  for (const seed of SEEDS) {
    const result = runAutoplayCase({ scenarioId: "baseline", seed, quarters: QUARTERS, companyIds: ALL_COMPANY_IDS, candidate });

    const firstDefaultTurn = new Map<string, number>();
    for (const h of result.history) {
      for (const companyId of ALL_COMPANY_IDS) {
        const financing = h.financingResults.find((f) => f.companyId === companyId);
        if (financing?.financialHealth?.paymentDefault === true) {
          const key = companyId;
          const prev = firstDefaultTurn.get(key);
          if (prev === undefined || h.turn < prev) firstDefaultTurn.set(key, h.turn);
        }
      }
    }

    for (const h of result.history) {
      for (const companyId of ALL_COMPANY_IDS) {
        const financing = h.financingResults.find((f) => f.companyId === companyId);
        const capture = result.quarterStartCaptures.find((c) => c.turn === h.turn && c.companyId === companyId);
        if (!financing || !capture) continue;

        const pc = financing.procurementConstraint as ProcurementConstraintResult | undefined;
        if (!pc) continue;

        const first = firstDefaultTurn.get(companyId);
        const preDefault = first === undefined || h.turn < first;

        const prevCashUsd = toNumber(capture.ownState.financeState.cash);
        const allocatedPrevCashUsd = Math.max(0, prevCashUsd) * ALLOCATION_RATIO;
        const requestedAmountUsd = financing.underwriting.requestedAmountUsd;
        const approvedAmountUsd = financing.underwriting.approvedAmountUsd;
        const capacityCeilingUsd = financing.borrowingCapacity.availableAdditionalCapacityUsd;
        const emergency = financing.emergencyLoan as EmergencyLoanResult | undefined;
        const emergencyLoanApprovedUsd = emergency?.approvedUsd ?? 0;

        // 当期の確実な現金収入（決済期が当期に到来する売掛金の回収額）。
        // fundingOutlookのON/OFFに関わらず常に独立に再計算する（本体ロジックは不変）。
        const period = capture.period;
        const reliableCashInflowsUsd = capture.ownState.financeState.receivables
          .filter((r) => r.dueSettlementPeriod === period)
          .reduce((s, r) => s + (r.amount as number), 0);

        const plannedCashNeedUsd = pc.plannedCashNeedUsd;
        const actualScaleRatio = pc.scaleRatio;

        const ratioWithCapacityCeiling = scaleRatioFor(allocatedPrevCashUsd + capacityCeilingUsd, plannedCashNeedUsd);
        const ratioWithEmergencyLoan = scaleRatioFor(allocatedPrevCashUsd + capacityCeilingUsd + emergencyLoanApprovedUsd, plannedCashNeedUsd);
        const ratioWithReliableInflow = scaleRatioFor(
          allocatedPrevCashUsd + capacityCeilingUsd + emergencyLoanApprovedUsd + reliableCashInflowsUsd,
          plannedCashNeedUsd
        );

        let category: Category;
        if (actualScaleRatio >= 1 - EPS) {
          category = "none_not_constrained";
        } else if (ratioWithCapacityCeiling >= 1 - EPS) {
          category = "B_request_below_capacity";
        } else if (ratioWithEmergencyLoan >= 1 - EPS) {
          category = "C_emergency_loan_counterfactual_covers";
        } else if (ratioWithReliableInflow >= 1 - EPS) {
          category = "D_gross_ar_inclusive_counterfactual_covers";
        } else {
          category = "A_gross_upper_bound_insufficient";
        }

        rows.push({
          seed,
          companyId,
          turn: h.turn,
          preDefault,
          plannedCashNeedUsd,
          prevCashUsd,
          allocatedPrevCashUsd,
          requestedAmountUsd,
          approvedAmountUsd,
          capacityCeilingUsd,
          emergencyLoanApprovedUsd,
          reliableCashInflowsUsd,
          actualScaleRatio,
          ratioWithCapacityCeiling,
          ratioWithEmergencyLoan,
          ratioWithReliableInflow,
          category,
        });
      }
    }
    console.log(`  control / ${seed}: ${result.completedTurns}Q 完走`);
  }
  return rows;
}

function main(): void {
  const outDir = path.resolve(process.cwd(), "artifacts/sai6/phase1a2");
  fs.mkdirSync(outDir, { recursive: true });

  console.log("実測中: control（全機能OFF）でcomputeProcurementConstraint分解を収集...");
  const rows = collect();
  const pre = rows.filter((r) => r.preDefault);

  const constrained = pre.filter((r) => r.category !== "none_not_constrained");
  const counts: Record<string, number> = {};
  for (const r of constrained) counts[r.category] = (counts[r.category] ?? 0) + 1;

  const fundingHeadroomMean =
    // 参考: Phase 0のresourceFundingHeadroom定義（期首現金＋借入余力＋当期確実収入－実際支出）とは
    // 別に、本スクリプトのスコープでは調達時点の狭い流動性チェックのみを対象とする。
    null;
  void fundingHeadroomMean;

  const summary = {
    generator: "scripts/sai6Phase1A2CashConstraintDecomposition.ts",
    quartersTotal: pre.length,
    quartersConstrained: constrained.length,
    categoryCounts: counts,
    domesticPurchaseCashAllocationRatio: ALLOCATION_RATIO,
  };
  fs.writeFileSync(path.join(outDir, "cash_constraint_decomposition.json"), JSON.stringify({ summary, rows: pre }, null, 2));

  const csvHeader = [
    "seed,companyId,turn,preDefault,plannedCashNeedUsd,prevCashUsd,allocatedPrevCashUsd,requestedAmountUsd,approvedAmountUsd",
    "capacityCeilingUsd,emergencyLoanApprovedUsd,reliableCashInflowsUsd,actualScaleRatio,ratioWithCapacityCeiling",
    "ratioWithEmergencyLoan,ratioWithReliableInflow,category",
  ].join(",");
  const csvRows = pre.map((r) =>
    [
      r.seed,
      r.companyId,
      r.turn,
      r.preDefault ? 1 : 0,
      r.plannedCashNeedUsd.toFixed(0),
      r.prevCashUsd.toFixed(0),
      r.allocatedPrevCashUsd.toFixed(0),
      r.requestedAmountUsd.toFixed(0),
      r.approvedAmountUsd.toFixed(0),
      r.capacityCeilingUsd.toFixed(0),
      r.emergencyLoanApprovedUsd.toFixed(0),
      r.reliableCashInflowsUsd.toFixed(0),
      r.actualScaleRatio.toFixed(4),
      r.ratioWithCapacityCeiling.toFixed(4),
      r.ratioWithEmergencyLoan.toFixed(4),
      r.ratioWithReliableInflow.toFixed(4),
      r.category,
    ].join(",")
  );
  fs.writeFileSync(path.join(outDir, "cash_constraint_decomposition.csv"), [csvHeader, ...csvRows].join("\n"));

  const L: string[] = [];
  L.push("# SAI-6 Phase 1A-2 追加監査 — 調達時資金制約179/208件のgross funding upper bound反実仮想分解");
  L.push("");
  L.push(`対象: control（全機能OFF）生存期間、${pre.length}四半期（4 seed×5社×32Q、破綻後除く）。`);
  L.push("");
  L.push(`調達時の資金制約（scaleRatio<1）: ${constrained.length}/${pre.length}件。`);
  L.push("");
  L.push(
    "**注意**: 以下(A)(C)(D)は「特定の追加資金を全額動員できたと仮定した反実仮想で資金需要が" +
      "充足するか」の判定であり、「原因の確定」ではない。当期売掛金回収（C・Dが加算する額）には" +
      "買掛金・人件費・元利払い・加工費・SGA・法人税等の競合する使途があり、実際に国内買付へ" +
      "回せたかどうかは本スクリプトでは未検証。緊急融資（Cが加算する額）も調達判断の時点で" +
      "実際に引き出せたかは未検証（時間順序の制約、上記コメント参照）。"
  );
  L.push("");
  L.push("| 分類 | 件数 | 割合 |");
  L.push("|---|---:|---:|");
  const labels: [Category, string][] = [
    [
      "A_gross_upper_bound_insufficient",
      "(A) 売掛金回収等を全額加えたgross funding upper boundでも不足するケースは0件（与信上限＋緊急融資＋当期売掛金回収を全て反実仮想で動員しても不足）",
    ],
    ["B_request_below_capacity", "(B) procurementが承認可能借入額（与信上限）を認識しない（申請額が与信上限未満）"],
    [
      "C_emergency_loan_counterfactual_covers",
      "(C) 緊急融資を調達時点で利用できる反実仮想では充足（実際にその時点で利用可能だったことの証明ではない）",
    ],
    [
      "D_gross_ar_inclusive_counterfactual_covers",
      "(D) 当期売掛金回収を全額利用する反実仮想では充足（買付以外の競合する使途を考慮した実際の充当可否は未検証）",
    ],
  ];
  for (const [key, label] of labels) {
    const n = counts[key] ?? 0;
    L.push(`| ${label} | ${n} | ${constrained.length > 0 ? ((n / constrained.length) * 100).toFixed(1) : "0.0"}% |`);
  }
  L.push("");
  L.push(
    `判定は「安価な説明から順」に行っている: (B)与信上限だけで足りるか→(C)＋当期緊急融資（反実仮想）で足りるか→` +
      `(D)＋当期確実収入（反実仮想）で足りるか→(A)それでも足りない、の優先順位。`
  );
  L.push("");
  L.push(`国内買付の現金配分比率（domesticPurchaseCashAllocationRatio）: ${ALLOCATION_RATIO}（前期末現金のこの割合のみが対象）。`);
  L.push("");

  fs.writeFileSync(path.join(outDir, "cash_constraint_decomposition.md"), L.join("\n"));
  console.log(`\n出力: ${outDir}/cash_constraint_decomposition.{json,csv,md}`);
  console.log(L.join("\n"));
}

main();
