// ShrimpX V2 — A-6検証: pdLaborInitialDebtReductionCompare.ts(§19)のB/S整合性を確認する。
//
// 【背景】三宅さんの指示（A-6）は「shortTermLoans/longTermLoansのみを削減し、
// 相殺勘定なしでB/Sが不整合になっている」ことを懸念していた。しかし実際には
// companyLab/standardAi/report/decomposeHarness.tsのbuildUnifiedFinanceState
// （およびfinance/initialState.tsのbuildInitialCompanyFinanceState）は、
// retainedEarnings = totalAssets - totalLiabilities - capitalStock という
// 「残差（プラグ）」として利益剰余金を構造的に計算しており、これは
// buildInitialCompanyFinanceStateのコード内コメント（「開始時の貸借一致の保証」）
// にも明記されている。したがって shortTermLoans/longTermLoans を変更すると
// totalLiabilitiesが変化し、retainedEarnings（＝純資産の一部）がその分だけ
// 自動的に相殺方向に動く——つまり§19の4条件は、意図せずして
// A-6の変種(b)「debtを減らしequityを同額増やす」と数学的に同一の効果を
// 既に持っていたことになる。本スクリプトはこれを実測で確認する
// （読み取り専用、fixture・本番コードへの変更なし）。
//
// 使い方: npx tsx scripts/pdLaborInitialDebtReductionBsCheck.ts

import {
  SELECTED_STANDARD_BASELINE_CANDIDATE_ID,
  STANDARD_BASELINE_CANDIDATES,
} from "../app/lib/v2/companyLab/standardAi/report/standardBaseline";
import { ALL_COMPANY_IDS, initializeUnifiedCompanyLabFromTemplate } from "../app/lib/v2/companyLab/standardAi/report/decomposeHarness";
import { unwrapUsd } from "../app/lib/v2/finance/types";
import { CompanyLabConfig } from "../app/lib/v2/companyLab/types";

const BASE = STANDARD_BASELINE_CANDIDATES.find((c) => c.id === SELECTED_STANDARD_BASELINE_CANDIDATE_ID)!;

const VARIANTS = [
  { label: "0%（現行baseline）", pct: 0 },
  { label: "-20%", pct: 0.2 },
  { label: "-30%", pct: 0.3 },
  { label: "-40%", pct: 0.4 },
];

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

console.log("条件 | 現金 | 売掛金 | 原料在庫 | その他流動資産 | 固定資産(総額) | 資産合計 | 短期債務 | 長期債務 | その他負債 | 負債合計 | 資本金 | 利益剰余金(残差) | 純資産合計 | 負債+純資産 | 差分(資産-(負債+純資産))");
console.log("-".repeat(260));

for (const v of VARIANTS) {
  const shortTermLoans = Math.round(BASE.financeFixtureTemplate.shortTermLoans * (1 - v.pct));
  const longTermLoans = Math.round(BASE.financeFixtureTemplate.longTermLoans * (1 - v.pct));
  const financeTemplate = { ...BASE.financeFixtureTemplate, shortTermLoans, longTermLoans };
  const config: CompanyLabConfig = { scenarioId: "baseline", mode: "canonical", seed: "sai3a-grid-001", turns: 1 };
  const init = initializeUnifiedCompanyLabFromTemplate(config, BASE.buildFixtureTemplate, financeTemplate, BASE.contractDefs, ALL_COMPANY_IDS);
  const fin = init.state.financeState.companies.find((f) => f.companyId === "BAL")!;

  const cash = unwrapUsd(fin.cash);
  const receivables = fin.receivables.reduce((s, r) => s + unwrapUsd(r.amount), 0);
  const rawMaterialInventory = 0; // BALの初期ロットは別途state.rawMaterialLotsに保持（このB/S内訳には現れない）— fixedAssetsGross等はfinance側の値をそのまま表示
  const otherCurrentAssets = unwrapUsd(fin.otherCurrentAssets);
  const fixedAssetsGross = unwrapUsd(fin.fixedAssetsGross);
  const totalAssets = cash + receivables + otherCurrentAssets + fixedAssetsGross; // rawMaterialInventoryはfinance/initialState.ts側でtotalAssets計算に含まれ、cashなどに混在しないため別建て（下記注記参照）

  const st = unwrapUsd(fin.shortTermLoans);
  const lt = unwrapUsd(fin.longTermLoans);
  const otherLiab = unwrapUsd(fin.otherLiabilities);
  const totalLiabilities = st + lt + otherLiab;

  const capitalStock = unwrapUsd(fin.capitalStock);
  const retainedEarnings = unwrapUsd(fin.retainedEarnings);
  const totalEquity = capitalStock + retainedEarnings;

  const diff = totalAssets - (totalLiabilities + totalEquity);

  console.log(
    `${v.label.padEnd(20)} | ${fmt(cash).padStart(10)} | ${fmt(receivables).padStart(11)} | ${fmt(rawMaterialInventory).padStart(9)} | ` +
      `${fmt(otherCurrentAssets).padStart(14)} | ${fmt(fixedAssetsGross).padStart(14)} | ${fmt(totalAssets).padStart(12)} | ` +
      `${fmt(st).padStart(10)} | ${fmt(lt).padStart(10)} | ${fmt(otherLiab).padStart(10)} | ${fmt(totalLiabilities).padStart(11)} | ` +
      `${fmt(capitalStock).padStart(10)} | ${fmt(retainedEarnings).padStart(17)} | ${fmt(totalEquity).padStart(11)} | ` +
      `${fmt(totalLiabilities + totalEquity).padStart(12)} | ${fmt(diff).padStart(10)}`
  );
}
console.log(
  "\n【注記】原料在庫（rawMaterialInventoryValueUsd）は実ロットデータから別途算出され" +
    "totalAssets計算に加算されるが（decomposeHarness.ts buildUnifiedFinanceState参照）、" +
    "本表のCompanyFinanceState自体には独立フィールドとして現れない（原料在庫はstate.rawMaterialLotsで" +
    "別管理）。したがって上表のtotalAssetsはfin.cash+receivables+otherCurrentAssets+fixedAssetsGrossの" +
    "合算であり、原料在庫を含まない。差分列（diff）はこの4項目ベースで見た場合の値であり、" +
    "0にならないのは原料在庫分（4条件とも同一ロット構成のため一定額）が欠けているため。" +
    "重要なのは差分が4条件すべてで【同一の定数】であること——retainedEarningsが残差として" +
    "機能し、debt変化に対して自動的に相殺していることの確認になる。"
);
