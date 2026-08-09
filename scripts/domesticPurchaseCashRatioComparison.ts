// ShrimpX V2 — Test16: domesticPurchaseCashAllocationRatio の比較ベンチマーク
//
// 【背景】このパラメータは「調達（国内買付）に充当してよい、利用可能流動性に対する
// 割合（残りは賃金等の最優先支払に確保）」を表す。現行値は 0.6。
//
// 今回導入した短期運転資金評価は、資金需要側で既に
//   給与 / 当期決済買掛 / 元利返済 / 最低現金バッファ
// を差し引いている。0.6 の留保はこれと同じリスクを二重に手当てしている可能性が高い。
//
// 【この比較の位置づけ】
// **本番パラメータは変更していない。** このスクリプトの実行中だけ、
// プロセス内のパラメータ値を差し替えて挙動を測る（下の withRatio 参照）。
// 差し替えはケースごとに必ず元へ戻す。リポジトリ上の既定値は 0.6 のままである。
//
// 【決定論性】Date.now()・Math.random()を使わない。
//
// 使い方: npx tsx scripts/domesticPurchaseCashRatioComparison.ts > artifacts/domesticPurchaseCashRatioComparison.json

import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../app/lib/v2/companyLab/runner";
import { generateStandardAiDecisionWithDiagnostics } from "../app/lib/v2/companyLab/standardAi/policy";
import { FINANCING_PARAMETERS_V1 } from "../app/lib/v2/financing/parameters";
import { CompanyLabConfig, CompanyDecisionInput } from "../app/lib/v2/companyLab/types";

const TURNS = 8;
const RATIOS = [0.6, 0.8, 1.0] as const;

function config(): CompanyLabConfig {
  return {
    scenarioId: "baseline",
    mode: "canonical",
    seed: "market-aware-sales-benchmark-20260808",
    turns: TURNS,
  } as unknown as CompanyLabConfig;
}

/**
 * ベンチマーク実行中だけ比率を差し替える。**必ず元へ戻す。**
 * エンジンがモジュール定数を直接参照しており注入口が無いための措置であり、
 * ゲーム側のロジック・既定値は変更していない。
 */
function withRatio<T>(ratio: number, fn: () => T): T {
  const liquidity = FINANCING_PARAMETERS_V1.liquidity as { domesticPurchaseCashAllocationRatio: number };
  const original = liquidity.domesticPurchaseCashAllocationRatio;
  liquidity.domesticPurchaseCashAllocationRatio = ratio;
  try {
    return fn();
  } finally {
    liquidity.domesticPurchaseCashAllocationRatio = original;
  }
}

interface Row {
  readonly turn: number;
  readonly companyId: string;
  readonly procurementScaleRatio: number | null;
  readonly domesticProcured: number | null;
  readonly rawMaterialShortfall: number | null;
  readonly rawMaterialInventory: number | null;
  readonly finishedGoodsInventory: number | null;
  readonly cash: number | null;
  readonly debt: number | null;
  readonly loanApprovedUsd: number | null;
  readonly operatingProfit: number | null;
  readonly creditTier: string | null;
  /** 延滞イベント件数（>0 なら支払遅延が起きている）。 */
  readonly arrearsEventCount: number | null;
  readonly capexProposals: readonly string[];
}

function n(v: unknown): number | null {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function runCase(): Row[] {
  const { state: initialState, fixtures } = initializeCompanyLab(config());
  let state = initialState;
  const rows: Row[] = [];

  for (let turn = 1; turn <= TURNS && !state.isComplete; turn++) {
    const publicInfo = buildPublicMarketInfo(state);
    const decisions: Record<string, CompanyDecisionInput> = {};
    const proposals: Record<string, string[]> = {};
    for (const fixture of fixtures) {
      const ownState = buildCompanyOwnState(state, fixture);
      const { decision } = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, state.currentPeriod, turn);
      decisions[fixture.companyId] = decision;
      proposals[fixture.companyId] = (decision.capexDecision?.newProjectProposals ?? []).map((p) => String(p.projectType));
    }

    state = advanceCompanyLabQuarter(state, fixtures, decisions);
    const record = state.history[state.history.length - 1];

    for (const fixture of fixtures) {
      const id = fixture.companyId;
      const summary = record?.companySummaries.find((s) => s.companyId === id);
      const fin = record?.financialResults?.find((f) => f.companyId === id);
      const financing = record?.financingResults?.find((f) => f.companyId === id);
      rows.push({
        turn,
        companyId: id,
        procurementScaleRatio: n(financing?.procurementConstraint?.scaleRatio),
        domesticProcured: n(summary?.domesticPurchaseQuantity),
        rawMaterialShortfall: n(summary?.rawMaterialShortfall),
        rawMaterialInventory: n(summary?.rawMaterialInventory),
        finishedGoodsInventory: n(summary?.finishedGoodsInventory),
        cash: n(fin?.balanceSheet?.cash),
        debt: (financing?.endingShortTermLoansUsd ?? 0) + (financing?.endingLongTermLoansUsd ?? 0),
        loanApprovedUsd: n(financing?.underwriting?.approvedAmountUsd),
        operatingProfit: n(fin?.profitAndLoss?.operatingProfit),
        creditTier: financing?.creditScore ? String((financing.creditScore as { tier?: unknown }).tier ?? "") : null,
        arrearsEventCount: financing?.arrearsEvents?.length ?? 0,
        capexProposals: proposals[id] ?? [],
      });
    }
  }
  return rows;
}

function run(): void {
  const results = RATIOS.map((ratio) => ({ ratio, rows: withRatio(ratio, runCase) }));
  process.stdout.write(
    JSON.stringify(
      {
        label: "domestic-purchase-cash-ratio-comparison",
        turns: TURNS,
        note: "本番の既定値は0.6のまま。実行中だけ差し替えて比較している。",
        repositoryDefault: FINANCING_PARAMETERS_V1.liquidity.domesticPurchaseCashAllocationRatio,
        results,
      },
      null,
      2
    )
  );
}

run();
