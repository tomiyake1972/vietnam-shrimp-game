// ShrimpX V2 — A-2: 同一時点スナップショット基盤からの完全中間値表（時点ラベル明示）
// 三宅さんovernight指示Part A・A-2への対応（2026-08-04）。
//
// 【目的】代表会社・代表turnについて、以下を「時点ラベルつきで」1つの表にまとめる:
//   collateralBasedLimit, earningsBasedLimit, creditTierCap, grossLimit,
//   existingLoanBalance, availableAdditionalCapacity, selectedBasis, creditTier,
//   承認/却下, rejectionReason, requestedAmount, approvedAmount
//
// 【時点の定義（本番コードの実際の参照タイミングに基づく。§11-1と同じ設計）】
//   - 「前期末」= prevFinanceState/prevFinancingState由来の値
//     （existingLoanBalance・totalEquity・EBITDA代理・担保入力すべてがこれ）。
//     本番の銀行は「当期の意思決定が確定する時点で既に確定している情報」
//     しか見ない設計のため、担保・収益・自己資本すべてが前期末値である。
//   - 「当期・申請前」= 上記の前期末インプットから computeBorrowingCapacity で
//     算出されたgrossLimit・availableAdditionalCapacity（＝当期の引受枠。
//     当期の実際の融資申請額とは独立に決まる）。
//   - 「当期・申請後」= 引受枠に対して当期の実際の申請額(requestedAmountUsd)を
//     適用した結果（承認/却下・approvedAmountUsd・deniedAmountUsd・reasons）。
// 本番コードでは「当期・申請前」の枠を決めてから「当期・申請後」の判定を行う
// 一連の処理であり、両者の間で担保・収益等の入力が変わることはない
// （=同一のUnderwritingSnapshotから両方を読み取れる）。
//
// 【本スクリプトは診断専用】observation-onlyフックのみ使用。develop/v2・pd_labor
// 両方で相対importのみのため、そのままpd_laborへ一時コピーして実行できる。
//
// 使い方: npx tsx scripts/a2LabeledIntermediatesTable.ts

import { CompanyLabConfig } from "../app/lib/v2/companyLab/types";
import {
  SELECTED_STANDARD_BASELINE_CANDIDATE_ID,
  STANDARD_BASELINE_CANDIDATES,
} from "../app/lib/v2/companyLab/standardAi/report/standardBaseline";
import {
  ALL_COMPANY_IDS,
  initializeUnifiedCompanyLabFromTemplate,
  runFromInit,
} from "../app/lib/v2/companyLab/standardAi/report/decomposeHarness";
import { generateStandardAiDecision } from "../app/lib/v2/companyLab/standardAi/policy";
import { setUnderwritingSnapshotObserver, UnderwritingSnapshot } from "../app/lib/v2/financing/liquidityClose";
import { periodToString } from "../app/lib/v2/core/period";

const BASE = STANDARD_BASELINE_CANDIDATES.find((c) => c.id === SELECTED_STANDARD_BASELINE_CANDIDATE_ID)!;

const TARGET_COMPANY = "BAL";
const SEED = "sai3a-grid-001";
const TARGET_TURNS = [1, 3, 5, 6, 7, 8];

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}
function periodOf(turn: number): string {
  const startYear = 2015;
  const q = ((turn - 1) % 4) + 1;
  const year = startYear + Math.floor((turn - 1) / 4);
  return `${year}Q${q}`;
}

function run(stackLabel: string) {
  const config: CompanyLabConfig = { scenarioId: "baseline", mode: "canonical", seed: SEED, turns: 8 };
  const uw: UnderwritingSnapshot[] = [];
  setUnderwritingSnapshotObserver((s) => uw.push(s));
  const init = initializeUnifiedCompanyLabFromTemplate(config, BASE.buildFixtureTemplate, BASE.financeFixtureTemplate, BASE.contractDefs, ALL_COMPANY_IDS);
  runFromInit(init, generateStandardAiDecision);
  setUnderwritingSnapshotObserver(undefined);

  console.log(`\n\n========== A-2 完全中間値表（時点ラベル付き）: ${stackLabel}・seed=${SEED}・会社=${TARGET_COMPANY} ==========\n`);

  for (const t of TARGET_TURNS) {
    const s = uw.find((x) => x.companyId === TARGET_COMPANY && periodToString(x.period) === periodOf(t));
    if (!s) continue;
    const r = s.borrowingCapacityResult;
    const bi = s.borrowingCapacityInput;
    const u = s.underwriting;
    console.log(`--- turn ${t}（period=${periodToString(s.period)}） ---`);
    console.log(`[前期末インプット（prevFinanceState/prevFinancingState由来。当期の引受枠計算にそのまま使われる）]`);
    console.log(`  担保: 売掛金=${fmt(bi.collateral.receivablesUsd)} 原料使用可=${fmt(bi.collateral.rawMaterialAvailableUsd)} 原料輸送中=${fmt(bi.collateral.rawMaterialInTransitUsd)} 完成品=${fmt(bi.collateral.finishedGoodsUsd)}`);
    console.log(`  EBITDA代理(前期実績)=${fmt(bi.ebitdaLikeQuarterlyUsd)}  総自己資本(前期末)=${fmt(bi.totalEquityUsd)}`);
    console.log(`  既存債務残高(前期末existingLoanBalanceUsd)=${fmt(bi.existingLoanBalanceUsd)}`);
    console.log(`  信用区分(creditTier、前期実績から算出)=${bi.creditTier}  重大延滞=${bi.severeArrears}  債務超過=${bi.insolvent}`);
    console.log(`[当期・申請前（＝前期末インプットからcomputeBorrowingCapacityで算出した当期の引受枠）]`);
    console.log(`  collateralBasedLimit=${fmt(r.collateralBasedLimitUsd)}  earningsBasedLimit=${fmt(r.earningsBasedLimitUsd)}  creditTierCap=${fmt(r.creditTierCapUsd)}`);
    console.log(`  grossLimit=min(max(collateral,earnings),tierCap)=${fmt(r.grossLimitUsd)}`);
    console.log(`  selectedBasis(bindingConstraint、§11-6の用語是正済み定義)=${r.bindingConstraint}`);
    console.log(`  existingLoanBalance(=前期末と同一値の再掲)=${fmt(r.existingLoanBalanceUsd)}`);
    console.log(`  availableAdditionalCapacity=max(0,grossLimit-existingLoanBalance)（frozen時0）=${fmt(r.availableAdditionalCapacityUsd)}  underwritingFrozen=${r.underwritingFrozen}`);
    console.log(`[当期・申請後（＝上記の枠に対し、当期の実際の融資申請を適用した結果）]`);
    console.log(`  requestedAmount=${fmt(s.requestedAmountUsd)}  applicationType=${s.applicationType}`);
    console.log(`  approvedAmount=${fmt(u.approvedAmountUsd)}  deniedAmount=${fmt(u.deniedAmountUsd)}`);
    console.log(`  承認/却下=${u.approvedAmountUsd > 0 ? "承認" : "却下/申請なし"}  reasons=[${u.reasons.join(" / ") || "(なし)"}]`);
    console.log("");
  }
}

run(process.argv.includes("--pd-labor") ? "pd_labor(48コミットスタック・PD係数1.8)" : "develop/v2");
