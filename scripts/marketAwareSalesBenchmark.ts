// ShrimpX V2 — market-aware sales allocation 8Qベンチマーク
//
// 【目的】origin/feature/v2-test15-integration（before）と
// feature/v2-standard-ai-market-aware-sales（after）を、完全に同一の
// scenario / seed / 初期条件で5社×8Q走らせ、営業配置・採用・成約・
// 在庫・利益を比較できる形で出力する。
//
// 【決定論性】乱数はscenario側のseedのみ。このスクリプト自身は
// Date.now()・Math.random()を一切使わない。同じbranch・同じ引数なら
// 何度実行しても同じJSONが出る。
//
// 【ゲーム環境を変更しない】initializeCompanyLab / advanceCompanyLabQuarter /
// generateStandardAiDecisionWithDiagnostics をそのまま呼ぶだけ。
// パラメータもfixtureも書き換えない。Redis・永続化層にも触れない。
//
// 使い方:
//   npx tsx scripts/marketAwareSalesBenchmark.ts <label> > artifacts/<label>.json

import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../app/lib/v2/companyLab/runner";
import { generateStandardAiDecisionWithDiagnostics } from "../app/lib/v2/companyLab/standardAi/policy";
import { CompanyLabConfig, CompanyDecisionInput } from "../app/lib/v2/companyLab/types";

const TURNS = 8;
const LABEL = process.argv[2] ?? "unlabeled";

/** before/afterで完全に同一にするための固定設定。 */
function benchmarkConfig(): CompanyLabConfig {
  return {
    scenarioId: "baseline",
    mode: "canonical",
    seed: "market-aware-sales-benchmark-20260808",
    turns: TURNS,
  } as unknown as CompanyLabConfig;
}

interface MarketRow {
  readonly market: string;
  readonly headcount: number;
  readonly desiredQuantity: number;
}

interface TurnRow {
  readonly turn: number;
  readonly companyId: string;
  readonly totalSalesHeadcount: number;
  readonly hiresThisTurn: number;
  readonly layoffsThisTurn: number;
  readonly marketAllocation: readonly MarketRow[];
  readonly japanShare: number | null;
  // 採用diagnostics（存在しない場合はnull。作らない）
  readonly economicallyDesiredHireCount: number | null;
  readonly organizationalHireLimit: number | null;
  readonly actualHireCount: number | null;
  readonly deferredByOrganizationalRamp: number | null;
  // 市場配分diagnostics
  readonly allocationMode: "observed_opportunity" | "legacy_price_rank" | "unknown";
  readonly marketWeights: Readonly<Record<string, number>> | null;
  // 制約
  readonly primaryConstraint: string | null;
  readonly secondaryConstraint: string | null;
  // 実績（前Turnの確定記録から）
  readonly contractedVolume: number | null;
  readonly fulfilledVolume: number | null;
  readonly outstandingVolume: number | null;
  readonly finishedGoodsInventory: number | null;
  readonly rawMaterialShortfall: number | null;
  readonly equipmentShortfall: number | null;
  readonly laborShortfall: number | null;
  readonly revenue: number | null;
  readonly operatingIncome: number | null;
  readonly netIncome: number | null;
  readonly cash: number | null;
}

function numberOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function run(): void {
  const { state: initialState, fixtures } = initializeCompanyLab(benchmarkConfig());
  let state = initialState;
  const rows: TurnRow[] = [];

  for (let turn = 1; turn <= TURNS && !state.isComplete; turn++) {
    const publicInfo = buildPublicMarketInfo(state);
    const decisions: Record<string, CompanyDecisionInput> = {};
    const perCompany: Record<string, Omit<TurnRow, "contractedVolume" | "fulfilledVolume" | "outstandingVolume" | "finishedGoodsInventory" | "rawMaterialShortfall" | "equipmentShortfall" | "laborShortfall" | "revenue" | "operatingIncome" | "netIncome" | "cash">> = {};

    for (const fixture of fixtures) {
      const ownState = buildCompanyOwnState(state, fixture);
      const { decision, diagnostics } = generateStandardAiDecisionWithDiagnostics(
        fixture,
        ownState,
        publicInfo,
        state.currentPeriod,
        turn
      );
      decisions[fixture.companyId] = decision;

      // 市場別の営業配置（同一市場の複数商品を合算）。
      const byMarket = new Map<string, { headcount: number; desired: number }>();
      for (const plan of decision.salesPlans) {
        const cur = byMarket.get(plan.market) ?? { headcount: 0, desired: 0 };
        // 【重要】salesForceHeadcountは市場ごとの値であり、同一市場の全商品行が
        // 同じ値を共有する（sales/salesForce.ts validateSalesForceHeadcountBudget参照）。
        // 商品行を足すと人数が商品数ぶん多重計上されるため、市場ごとに1回だけ採る。
        byMarket.set(plan.market, {
          headcount: Number(plan.salesForceHeadcount ?? 0),
          desired: cur.desired + Number(plan.desiredQuantity ?? 0),
        });
      }
      const marketAllocation: MarketRow[] = [...byMarket.entries()]
        .map(([market, v]) => ({ market, headcount: v.headcount, desiredQuantity: v.desired }))
        .sort((a, b) => a.market.localeCompare(b.market));
      const totalHc = marketAllocation.reduce((a, m) => a + m.headcount, 0);
      const japan = marketAllocation.find((m) => /japan|jp/i.test(m.market));

      // 採用diagnosticsの抽出（存在しなければnull。値を捏造しない）。
      const entries = diagnostics.entries ?? [];
      const hiringEntry = entries.find((e) => e.code === "SALES_HIRING_PROFITABLE_UNSERVED_OPPORTUNITY");
      const kv = (hiringEntry?.keyValues ?? {}) as Record<string, unknown>;
      const allocEntry = entries.find((e) => e.code === "MARKET_ALLOCATION_BY_OBSERVED_OPPORTUNITY");
      const allocKv = (allocEntry?.keyValues ?? {}) as Record<string, unknown>;
      const weights: Record<string, number> = {};
      for (const [k, v] of Object.entries(allocKv)) {
        if (k.startsWith("weight_")) weights[k.slice("weight_".length)] = Number(v);
      }

      const sd = diagnostics.situationDiagnosis;

      perCompany[fixture.companyId] = {
        turn,
        companyId: fixture.companyId,
        totalSalesHeadcount: totalHc,
        hiresThisTurn: Number(decision.salesForceHireCount ?? 0),
        layoffsThisTurn: Number(decision.salesForceLayoffCount ?? 0),
        marketAllocation,
        japanShare: totalHc > 0 && japan ? japan.headcount / totalHc : null,
        economicallyDesiredHireCount: numberOrNull(kv.economicallyDesiredHireCount),
        organizationalHireLimit: numberOrNull(kv.organizationalHireLimit),
        actualHireCount: numberOrNull(kv.actualHireCount),
        deferredByOrganizationalRamp: numberOrNull(kv.deferredByOrganizationalRamp),
        allocationMode: allocEntry ? "observed_opportunity" : "legacy_price_rank",
        marketWeights: Object.keys(weights).length > 0 ? weights : null,
        primaryConstraint: sd ? String(sd.primaryConstraint) : null,
        secondaryConstraint: sd ? String(sd.secondaryConstraint) : null,
      };
    }

    state = advanceCompanyLabQuarter(state, fixtures, decisions);

    // 直近の確定記録から実績を引く（再計算しない）。
    const record = state.history[state.history.length - 1];
    for (const fixture of fixtures) {
      const summary = record?.companySummaries.find((s) => s.companyId === fixture.companyId);
      const fin = record?.financialResults?.find((f) => f.companyId === fixture.companyId);
      rows.push({
        ...perCompany[fixture.companyId],
        contractedVolume: numberOrNull(summary?.newContractedQuantity),
        fulfilledVolume: numberOrNull(summary?.fulfilledQuantity),
        outstandingVolume: numberOrNull(summary?.outstandingQuantity),
        finishedGoodsInventory: numberOrNull(summary?.finishedGoodsInventory),
        rawMaterialShortfall: numberOrNull(summary?.rawMaterialShortfall),
        equipmentShortfall: numberOrNull(summary?.equipmentShortfall),
        laborShortfall: numberOrNull(summary?.laborShortfall),
        revenue: numberOrNull(fin?.profitAndLoss?.revenue),
        operatingIncome: numberOrNull(fin?.profitAndLoss?.operatingIncome),
        netIncome: numberOrNull(fin?.profitAndLoss?.netIncome),
        cash: numberOrNull(fin?.balanceSheet?.cash),
      });
    }
  }

  process.stdout.write(JSON.stringify({ label: LABEL, turns: TURNS, rows }, null, 2));
}

run();
