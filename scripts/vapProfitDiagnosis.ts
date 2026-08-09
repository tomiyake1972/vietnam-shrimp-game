// ShrimpX V2 — Test16: VAP営業利益低下の商品別・市場別診断
//
// 【背景】domesticPurchaseCashAllocationRatio を 0.6 → 1.0 にしたところ、
// VAP社の8Q累計営業利益が 71.6M → 55.1M へ低下した。他4社は改善または横ばい。
//
// 【確認したいこと】
//   「資金制約が緩んだことで、低採算の商品・市場まで生産・販売するようになったか」
//
// もしそうなら finance 側を戻すのではなく、Standard AI の商品別・市場別
// 採算判断の課題として切り分ける。
//
// 【本番パラメータは変更しない】比較のため実行中だけ比率を差し替え、必ず元へ戻す。
// 【決定論性】Date.now()・Math.random()を使わない。
//
// 使い方: npx tsx scripts/vapProfitDiagnosis.ts > artifacts/vapProfitDiagnosis.json

import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../app/lib/v2/companyLab/runner";
import { generateStandardAiDecisionWithDiagnostics } from "../app/lib/v2/companyLab/standardAi/policy";
import { FINANCING_PARAMETERS_V1 } from "../app/lib/v2/financing/parameters";
import { CompanyLabConfig, CompanyDecisionInput } from "../app/lib/v2/companyLab/types";
import { unwrapUnit } from "../app/lib/v2/core/units";

const TURNS = 8;
const FOCUS = "VAP";
const RATIOS = [0.6, 1.0] as const;

function config(): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed: "market-aware-sales-benchmark-20260808", turns: TURNS } as unknown as CompanyLabConfig;
}

/** 実行中だけ比率を差し替える。必ず元へ戻す。 */
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

function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

interface DimensionRow {
  readonly key: string;
  readonly netRevenue: number;
  readonly variableCost: number;
  readonly contributionMargin: number;
  readonly contributionMarginRatio: number | null;
  readonly directFixedCost: number;
}

interface MarketProductRow {
  readonly market: string;
  readonly product: string;
  readonly askPrice: number;
  readonly allocatedQuantity: number;
}

interface TurnRow {
  readonly turn: number;
  // 生産・出荷
  readonly hosoProduced: number;
  readonly pdProduced: number;
  readonly vapProduced: number;
  readonly fulfilledQuantity: number;
  readonly outstandingQuantity: number;
  readonly finishedGoodsInventory: number;
  readonly rawMaterialInventory: number;
  // 調達
  readonly domesticProcured: number;
  readonly rawMaterialShortfall: number;
  // 損益
  readonly netRevenue: number;
  readonly operatingProfit: number;
  readonly rawMaterialCost: number;
  readonly contributionMarginTotal: number;
  readonly totalFixedCost: number;
  readonly byProduct: readonly DimensionRow[];
  readonly byMarket: readonly DimensionRow[];
  // 販売配分（市場×商品）
  readonly allocations: readonly MarketProductRow[];
  // 労務
  readonly regularHeadcount: number;
  readonly laborShortfall: number;
}

function runCase(): TurnRow[] {
  const { state: initialState, fixtures } = initializeCompanyLab(config());
  let state = initialState;
  const rows: TurnRow[] = [];

  for (let turn = 1; turn <= TURNS && !state.isComplete; turn++) {
    const publicInfo = buildPublicMarketInfo(state);
    const decisions: Record<string, CompanyDecisionInput> = {};
    for (const fixture of fixtures) {
      const ownState = buildCompanyOwnState(state, fixture);
      const { decision } = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, state.currentPeriod, turn);
      decisions[fixture.companyId] = decision;
    }
    state = advanceCompanyLabQuarter(state, fixtures, decisions);
    const record = state.history[state.history.length - 1];

    const summary = record?.companySummaries.find((s) => s.companyId === FOCUS);
    const fin = record?.financialResults?.find((f) => f.companyId === FOCUS);
    const cm = fin?.contributionMargin;

    const dim = (entries: readonly { key: string; netRevenue: unknown; variableCost: unknown; contributionMargin: unknown; contributionMarginRatio?: number; directFixedCost: unknown }[] | undefined): DimensionRow[] =>
      (entries ?? []).map((e) => ({
        key: String(e.key),
        netRevenue: n(e.netRevenue),
        variableCost: n(e.variableCost),
        contributionMargin: n(e.contributionMargin),
        contributionMarginRatio: e.contributionMarginRatio ?? null,
        directFixedCost: n(e.directFixedCost),
      }));

    const allocations: MarketProductRow[] = [];
    for (const a of record?.salesRecord?.allocations ?? []) {
      const entry = a.companies.find((c) => c.companyId === FOCUS);
      if (!entry) continue;
      const qty = n(unwrapUnit(entry.allocatedQuantity));
      if (qty <= 0) continue;
      allocations.push({
        market: String(a.market),
        product: String(a.product),
        askPrice: n(unwrapUnit(entry.askPrice)),
        allocatedQuantity: qty,
      });
    }

    const workforce = state.workforceState?.companies.find((c) => c.companyId === FOCUS);

    rows.push({
      turn,
      hosoProduced: n(unwrapUnit(summary!.hosoProduced)),
      pdProduced: n(unwrapUnit(summary!.pdProduced)),
      vapProduced: n(unwrapUnit(summary!.vapProduced)),
      fulfilledQuantity: n(unwrapUnit(summary!.fulfilledQuantity)),
      outstandingQuantity: n(unwrapUnit(summary!.outstandingQuantity)),
      finishedGoodsInventory: n(unwrapUnit(summary!.finishedGoodsInventory)),
      rawMaterialInventory: n(unwrapUnit(summary!.rawMaterialInventory)),
      domesticProcured: n(unwrapUnit(summary!.domesticPurchaseQuantity)),
      rawMaterialShortfall: n(unwrapUnit(summary!.rawMaterialShortfall)),
      netRevenue: n(fin?.profitAndLoss?.netRevenue),
      operatingProfit: n(fin?.profitAndLoss?.operatingProfit),
      rawMaterialCost: n(cm?.variableRawMaterialCost),
      contributionMarginTotal: n(cm?.contributionMargin),
      totalFixedCost: n(cm?.totalFixedCost),
      byProduct: dim(cm?.byProduct as never),
      byMarket: dim(cm?.byMarket as never),
      allocations,
      regularHeadcount: (workforce?.factories ?? []).reduce((s, f) => s + f.regularHeadcount, 0),
      laborShortfall: n(unwrapUnit(summary!.laborShortfall)),
    });
  }
  return rows;
}

function run(): void {
  const results = RATIOS.map((ratio) => ({ ratio, rows: withRatio(ratio, runCase) }));
  process.stdout.write(
    JSON.stringify(
      { label: "vap-profit-diagnosis", focusCompany: FOCUS, turns: TURNS, repositoryDefault: FINANCING_PARAMETERS_V1.liquidity.domesticPurchaseCashAllocationRatio, results },
      null,
      2
    )
  );
}

run();
