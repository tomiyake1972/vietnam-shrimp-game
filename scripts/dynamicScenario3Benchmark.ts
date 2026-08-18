// ShrimpX V2 — Dynamic Scenario 3 のベンチマーク（読み取り専用）
//
// 実ゲームと同じ engine.ts 経路（createSimulationSession → advanceSimulationTurn）で
// 5社 Standard AI を回し、指示§13/§14 が要求する項目をすべて収集する。
// シナリオ定義・ゲームロジック・保存データは一切変更しない。
//
//   npx tsx scripts/dynamicScenario3Benchmark.ts
//   SCENARIO=dynamic-scenario-2-v0.1 npx tsx scripts/dynamicScenario3Benchmark.ts   # DS2比較
//   SEEDS=5 TURNS=32 npx tsx scripts/dynamicScenario3Benchmark.ts
//   SUMMARY=1 npx tsx scripts/dynamicScenario3Benchmark.ts                          # 要約のみ

import { createSimulationSession, advanceSimulationTurn } from "../app/lib/v2/companyLab/simulation/engine";
import { SimulationSession } from "../app/lib/v2/companyLab/simulation/types";
import { DYNAMIC_SCENARIO_3 } from "../app/lib/v2/scenario/definitions/dynamicScenario3";
import { DS3_DOWN_CYCLE_SENSITIVITY, DS3_VIETNAM_DISASTER_CASE_B } from "../app/lib/v2/scenario/definitions/dynamicScenario3Parameters";
import { DS3_EVENT_IDS } from "../app/lib/v2/scenario/definitions/dynamicScenario3News";
import { ScenarioEffect, ScenarioEvent } from "../app/lib/v2/scenario/types";
import { unwrapUnit } from "../app/lib/v2/core/units";
import { CountryId, DemandMarketId } from "../app/lib/v2/market/types";

const SCENARIO_ID = process.env.SCENARIO ?? DYNAMIC_SCENARIO_3.scenarioId;
const TURNS = process.env.TURNS ? Number(process.env.TURNS) : 32;
const SEED_COUNT = process.env.SEEDS ? Number(process.env.SEEDS) : 5;
const SUMMARY_ONLY = process.env.SUMMARY === "1";
const ALL_SEEDS = ["ds3-a", "ds3-b", "ds3-c", "ds3-d", "ds3-e", "ds3-f", "ds3-g", "ds3-h", "ds3-i", "ds3-j"];
const SEEDS = ALL_SEEDS.slice(0, SEED_COUNT);
const AT = "2026-01-01T00:00:00.000Z";

/**
 * 【感度比較用の一時的な差し替え】DS3 定義そのものは変更せず、このプロセス内でだけ
 * イベント強度を置き換える。指示§5（down-cycle）・§6（EC/IN 災害倍率）・§7（Case A/B）の
 * 感度比較のための注入口であり、既定（環境変数なし）ではシナリオ定義のまま走る。
 *
 *   DOWN_CYCLE=mild|base|strong
 *   EC_COST=1.25|1.35|1.45
 *   IN_COST=1.25|1.35|1.45
 *   VN_CASE=A|B      （B は T31 Vietnam shock あり）
 */
function applySensitivityOverrides(): string[] {
  const notes: string[] = [];
  const events = DYNAMIC_SCENARIO_3.scheduledEvents as ScenarioEvent[];
  const find = (id: string) => events.find((e) => e.eventId === id);

  const dc = process.env.DOWN_CYCLE as keyof typeof DS3_DOWN_CYCLE_SENSITIVITY | undefined;
  if (dc && DS3_DOWN_CYCLE_SENSITIVITY[dc]) {
    const target = find(DS3_EVENT_IDS.priceDownCycle);
    if (target) {
      const preset = DS3_DOWN_CYCLE_SENSITIVITY[dc];
      (target as unknown as { effects: readonly ScenarioEffect[] }).effects = [
        { variable: "REGIONAL_DEMAND", mode: "multiplicative", magnitude: preset.regionalDemandMultiplier },
        { variable: "UTILIZATION_RATE", mode: "multiplicative", magnitude: preset.utilizationMultiplier },
      ];
      notes.push(`down-cycle=${dc}(demand×${preset.regionalDemandMultiplier}/util×${preset.utilizationMultiplier})`);
    }
  }

  const ec = process.env.EC_COST ? Number(process.env.EC_COST) : undefined;
  if (ec !== undefined) {
    const target = find(DS3_EVENT_IDS.ecuadorDisaster);
    if (target) {
      (target as unknown as { effects: readonly ScenarioEffect[] }).effects = target.effects.map((e) =>
        e.variable === "AQUACULTURE_COST" ? { ...e, magnitude: ec } : e
      );
      notes.push(`EC原料コスト×${ec}`);
    }
  }

  const inCost = process.env.IN_COST ? Number(process.env.IN_COST) : undefined;
  if (inCost !== undefined) {
    const target = find(DS3_EVENT_IDS.indiaDisaster);
    if (target) {
      (target as unknown as { effects: readonly ScenarioEffect[] }).effects = target.effects.map((e) =>
        e.variable === "AQUACULTURE_COST" ? { ...e, magnitude: inCost } : e
      );
      notes.push(`IN原料コスト×${inCost}`);
    }
  }

  if (process.env.VN_CASE === "B" && !find(DS3_EVENT_IDS.vietnamDisasterCaseB)) {
    events.push({
      eventId: DS3_EVENT_IDS.vietnamDisasterCaseB,
      eventType: "DISEASE_OUTBREAK",
      targetCountries: ["VN"],
      targetMarkets: [],
      startTurn: DS3_VIETNAM_DISASTER_CASE_B.startTurn,
      durationTurns: DS3_VIETNAM_DISASTER_CASE_B.durationTurns,
      rampUpTurns: DS3_VIETNAM_DISASTER_CASE_B.rampUpTurns,
      recoveryTurns: DS3_VIETNAM_DISASTER_CASE_B.recoveryTurns,
      hiddenDescription: "【Case B のみ】終盤のベトナム疾病。原料高が Margin squeeze の上に重なる。",
      effects: [
        { variable: "SURVIVAL_RATE", mode: "additivePoint", magnitude: DS3_VIETNAM_DISASTER_CASE_B.survivalRateDelta },
        { variable: "AQUACULTURE_COST", mode: "multiplicative", magnitude: DS3_VIETNAM_DISASTER_CASE_B.aquacultureCostMultiplier },
      ],
      informationReleaseIds: [],
    });
    notes.push("VN Case B（T31 Vietnam shock あり）");
  }
  return notes;
}

const SENSITIVITY_NOTES = applySensitivityOverrides();

const COMPANIES = ["BAL", "MASS", "JPQ", "VAP", "CONSV"] as const;
const PRODUCTS = ["hoso", "pd", "vap"] as const;
const MARKETS: readonly DemandMarketId[] = ["CN", "US", "EU", "JP", "OTHER"];
const COUNTRIES: readonly CountryId[] = ["VN", "EC", "IN", "ID"];

const n0 = (v: number) => Math.round(v).toLocaleString();
const M = (v: number) => (v / 1e6).toFixed(1);
const f2 = (v: number) => v.toFixed(2);
const pct = (part: number, total: number) => (total <= 0 ? "  -" : `${((part / total) * 100).toFixed(0)}`.padStart(3));

interface CompanyTurn {
  readonly turn: number;
  readonly companyId: string;
  readonly attainableProfitableTons: number;
  readonly commercialAmbitionTons: number;
  readonly submissionTargetTons: number;
  readonly allocatedSalesTons: number;
  readonly revenue: number;
  readonly op: number;
  readonly cash: number;
  readonly debt: number;
  readonly shortfall: boolean;
  readonly finishedGoods: number;
  readonly backlog: number;
  readonly rawMaterialCostPerTon: number;
  readonly prod: Record<string, number>;
  readonly salesByProduct: Record<string, number>;
  readonly salesByMarket: Record<string, number>;
  readonly capexEvents: number;
}

interface WorldTurn {
  readonly turn: number;
  readonly worldDemand: number;
  readonly worldSupply: number;
  readonly balance: number;
  readonly hosoPrice: number;
  readonly pdPrice: number;
  readonly vapPrice: number;
  readonly fob: Record<string, number>;
  readonly vnDomestic: number;
}

interface SeedResult {
  readonly seed: string;
  readonly companyTurns: readonly CompanyTurn[];
  readonly worldTurns: readonly WorldTurn[];
}

function runSeed(seed: string): SeedResult {
  let session: SimulationSession = createSimulationSession({
    simulationRunId: `ds3-bench-${seed}`,
    scenarioId: SCENARIO_ID,
    seed,
    requestedTurns: TURNS,
    startedAt: AT,
  });
  const companyTurns: CompanyTurn[] = [];
  const worldTurns: WorldTurn[] = [];

  for (let t = 0; t < TURNS; t++) {
    const outcome = advanceSimulationTurn(session, AT);
    if (!outcome.advanced) break;
    session = outcome.session;
    const turn = t + 1;
    const record = session.state.history[session.state.history.length - 1];
    const m = record.marketResult;

    const priceAcc: Record<string, { q: number; v: number }> = {};
    for (const c of record.salesRecord.newContracts) {
      const q = unwrapUnit(c.originalQuantity);
      (priceAcc[c.product] ??= { q: 0, v: 0 }).q += q;
      priceAcc[c.product].v += q * Number(c.unitPrice);
    }
    const avgPrice = (p: string) => (priceAcc[p] && priceAcc[p].q > 0 ? priceAcc[p].v / priceAcc[p].q : 0);

    worldTurns.push({
      turn,
      worldDemand: unwrapUnit(m.worldDemand),
      worldSupply: unwrapUnit(m.worldSupply),
      balance: m.worldSupplyDemandBalance,
      hosoPrice: avgPrice("hoso"),
      pdPrice: avgPrice("pd"),
      vapPrice: avgPrice("vap"),
      fob: Object.fromEntries(COUNTRIES.map((c) => [c, Number(m.hosoPrices[c].price)])),
      vnDomestic: Number(m.vietnamDomestic.price),
    });

    for (const companyId of COMPANIES) {
      const pack = session.packCompanyTurns.find((x) => x.turn === turn && x.companyId === companyId) as
        | { readonly commercialGrowth?: Record<string, number | null> }
        | undefined;
      const cg = pack?.commercialGrowth ?? {};
      const summary = record.companySummaries.find((s) => s.companyId === companyId);
      const fin = record.financialResults.find((r) => r.companyId === companyId);
      const salesByProduct: Record<string, number> = { hoso: 0, pd: 0, vap: 0 };
      const salesByMarket: Record<string, number> = { CN: 0, US: 0, EU: 0, JP: 0, OTHER: 0 };
      let allocated = 0;
      for (const c of record.salesRecord.newContracts) {
        if (c.companyId !== companyId) continue;
        const q = unwrapUnit(c.originalQuantity);
        salesByProduct[c.product] += q;
        salesByMarket[c.market] += q;
        allocated += q;
      }
      const purchased = summary ? unwrapUnit(summary.domesticPurchaseQuantity) : 0;
      companyTurns.push({
        turn,
        companyId,
        attainableProfitableTons: Number(cg.profitableOpportunityTons ?? 0),
        commercialAmbitionTons: Number(cg.commercialAmbitionTons ?? 0),
        submissionTargetTons: Number(cg.commercialCommitmentTons ?? 0),
        allocatedSalesTons: allocated,
        revenue: fin ? Number(fin.profitAndLoss.netRevenue) : 0,
        op: fin ? Number(fin.profitAndLoss.operatingProfit) : 0,
        cash: fin ? Number(fin.balanceSheet.cash) : 0,
        debt: fin ? Number(fin.balanceSheet.shortTermLoans) + Number(fin.balanceSheet.longTermLoans) : 0,
        shortfall: Boolean(fin?.cashShortfall),
        finishedGoods: summary ? unwrapUnit(summary.finishedGoodsInventory) : 0,
        backlog: summary ? unwrapUnit(summary.outstandingQuantity) : 0,
        // 原料コストの代理指標：当期の国内買付量に対する VN 国内価格（USD/kg）。
        rawMaterialCostPerTon: purchased > 0 ? Number(m.vietnamDomestic.price) * 1000 : 0,
        prod: {
          hoso: summary ? unwrapUnit(summary.hosoProduced) : 0,
          pd: summary ? unwrapUnit(summary.pdProduced) : 0,
          vap: summary ? unwrapUnit(summary.vapProduced) : 0,
        },
        salesByProduct,
        salesByMarket,
        capexEvents: (record.capexResults ?? []).find((r) => r.companyId === companyId)?.events?.length ?? 0,
      });
    }
  }
  return { seed, companyTurns, worldTurns };
}

console.log(`=== Dynamic Scenario 3 benchmark（scenarioId=${SCENARIO_ID} / ${TURNS}Turn / seed×${SEEDS.length}）===`);
if (SENSITIVITY_NOTES.length > 0) console.log(`感度設定: ${SENSITIVITY_NOTES.join(" / ")}`);
const results = SEEDS.map(runSeed);
const first = results[0];
const at = (r: SeedResult, turn: number, companyId: string) => r.companyTurns.find((x) => x.turn === turn && x.companyId === companyId)!;
const world = (r: SeedResult, turn: number) => r.worldTurns.find((x) => x.turn === turn)!;

// ---------------------------------------------------------------------
// §13 規模Acceptance：制約チェーンをTurnごとに見る
// ---------------------------------------------------------------------
console.log("\n### §13 販売希望量の制約チェーン（seed=" + first.seed + "）");
console.log("  ※ attainable=採算機会 / ambition=志の量 / target=取りに行く量 / actual=実配分");
for (const turn of [24, 28, 32].filter((t) => t <= TURNS)) {
  console.log(`\n  [T${turn}]  会社    attainable   ambition     target     actual   制約`);
  for (const companyId of COMPANIES) {
    const c = at(first, turn, companyId);
    const limiter =
      c.submissionTargetTons <= c.attainableProfitableTons * 0.5 + 1 && c.submissionTargetTons < c.commercialAmbitionTons - 1
        ? "機会上限(attainable×0.5)"
        : c.submissionTargetTons <= c.commercialAmbitionTons + 1
          ? "志の量(ambition)"
          : "その他";
    console.log(
      `        ${companyId.padEnd(7)}${n0(c.attainableProfitableTons).padStart(11)}${n0(c.commercialAmbitionTons).padStart(11)}` +
        `${n0(c.submissionTargetTons).padStart(11)}${n0(c.allocatedSalesTons).padStart(11)}   ${limiter}`
    );
  }
}

console.log("\n### §13 会社別 販売量の目標到達判定（全seed）");
const TARGETS: Readonly<Record<string, readonly [number, number]>> = {
  MASS: [90000, 100000],
  BAL: [55000, 65000],
  JPQ: [45000, 55000],
  VAP: [45000, 55000],
  CONSV: [45000, 50000],
};
console.log("  会社   目標レンジ           T28平均      T32平均      T32最大   到達seed数");
for (const companyId of COMPANIES) {
  const [lo, hi] = TARGETS[companyId];
  const t28 = results.map((r) => at(r, Math.min(28, TURNS), companyId).allocatedSalesTons);
  const t32 = results.map((r) => at(r, TURNS, companyId).allocatedSalesTons);
  const reached = results.filter((r) => Math.max(at(r, TURNS, companyId).allocatedSalesTons, at(r, Math.min(28, TURNS), companyId).allocatedSalesTons) >= lo).length;
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  console.log(
    `  ${companyId.padEnd(6)} ${(n0(lo) + "〜" + n0(hi)).padEnd(20)}${n0(avg(t28)).padStart(10)}${n0(avg(t32)).padStart(13)}` +
      `${n0(Math.max(...t32)).padStart(13)}${String(reached + "/" + results.length).padStart(11)}`
  );
}

// ---------------------------------------------------------------------
// §5 価格 down-cycle / §8 Margin squeeze
// ---------------------------------------------------------------------
console.log("\n### §5 販売価格の推移（全seed平均・USD/HOSO換算kg）と T16 比");
console.log("  Turn     HOSO      PD     VAP    T16比HOSO   世界需給差   VN国内原料   EC_FOB   IN_FOB");
const avgWorld = (turn: number, pick: (w: WorldTurn) => number) =>
  results.reduce((a, r) => a + pick(world(r, turn)), 0) / results.length;
const base16 = avgWorld(Math.min(16, TURNS), (w) => w.hosoPrice);
for (const turn of [12, 16, 20, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32].filter((t) => t <= TURNS)) {
  console.log(
    `  T${String(turn).padEnd(4)}${f2(avgWorld(turn, (w) => w.hosoPrice)).padStart(9)}${f2(avgWorld(turn, (w) => w.pdPrice)).padStart(8)}` +
      `${f2(avgWorld(turn, (w) => w.vapPrice)).padStart(8)}${(((avgWorld(turn, (w) => w.hosoPrice) / base16) * 100).toFixed(1) + "%").padStart(12)}` +
      `${((avgWorld(turn, (w) => w.balance) * 100).toFixed(1) + "%").padStart(13)}${f2(avgWorld(turn, (w) => w.vnDomestic)).padStart(13)}` +
      `${f2(avgWorld(turn, (w) => w.fob.EC)).padStart(9)}${f2(avgWorld(turn, (w) => w.fob.IN)).padStart(9)}`
  );
}

console.log("\n### §8 Margin squeeze 成立確認（全seed・5社合算）");
console.log("  Turn   売上M   営業利益M   営業利益率   VN国内原料   EC_FOB   販売HOSO単価");
for (const turn of [20, 22, 24, 25, 26, 27, 28, 29, 30, 31, 32].filter((t) => t <= TURNS)) {
  const rev = results.reduce((a, r) => a + COMPANIES.reduce((b, c) => b + at(r, turn, c).revenue, 0), 0) / results.length;
  const op = results.reduce((a, r) => a + COMPANIES.reduce((b, c) => b + at(r, turn, c).op, 0), 0) / results.length;
  console.log(
    `  T${String(turn).padEnd(4)}${M(rev).padStart(8)}${M(op).padStart(12)}${((op / Math.max(1, rev)) * 100).toFixed(1).padStart(11)}%` +
      `${f2(avgWorld(turn, (w) => w.vnDomestic)).padStart(13)}${f2(avgWorld(turn, (w) => w.fob.EC)).padStart(9)}${f2(avgWorld(turn, (w) => w.hosoPrice)).padStart(14)}`
  );
}

if (!SUMMARY_ONLY) {
  console.log("\n### §15/§16 商品構成・市場構成（seed=" + first.seed + "・成約ベース）");
  for (const turn of [16, 24, 28, 32].filter((t) => t <= TURNS)) {
    console.log(`\n  [T${turn}] 会社    HOSO/PD/VAP        CN/US/EU/JP/OTHER`);
    for (const companyId of COMPANIES) {
      const c = at(first, turn, companyId);
      const pTotal = PRODUCTS.reduce((a, p) => a + c.salesByProduct[p], 0);
      const mTotal = MARKETS.reduce((a, k) => a + c.salesByMarket[k], 0);
      console.log(
        `        ${companyId.padEnd(7)}` +
          PRODUCTS.map((p) => pct(c.salesByProduct[p], pTotal)).join("/") +
          "        " +
          MARKETS.map((k) => pct(c.salesByMarket[k], mTotal)).join("/")
      );
    }
  }

  console.log("\n### §17/§18/§19 Cash / Debt / Distress / Inventory / Backlog（全seed平均）");
  for (const turn of [24, 28, 32].filter((t) => t <= TURNS)) {
    console.log(`\n  [T${turn}] 会社    現金M    借入M   資金不足   製品在庫t   受注残t   CAPEX累計`);
    for (const companyId of COMPANIES) {
      const avg = (pick: (c: CompanyTurn) => number) => results.reduce((a, r) => a + pick(at(r, turn, companyId)), 0) / results.length;
      const shortfalls =
        results.reduce((a, r) => a + r.companyTurns.filter((x) => x.companyId === companyId && x.turn <= turn && x.shortfall).length, 0) / results.length;
      const capex =
        results.reduce((a, r) => a + r.companyTurns.filter((x) => x.companyId === companyId && x.turn <= turn).reduce((b, x) => b + x.capexEvents, 0), 0) /
        results.length;
      console.log(
        `        ${companyId.padEnd(7)}${M(avg((c) => c.cash)).padStart(8)}${M(avg((c) => c.debt)).padStart(9)}${shortfalls.toFixed(1).padStart(10)}` +
          `${n0(avg((c) => c.finishedGoods)).padStart(12)}${n0(avg((c) => c.backlog)).padStart(10)}${capex.toFixed(1).padStart(11)}`
      );
    }
  }
}

console.log("\n### seed別 最終順位（累計営業利益）");
for (const r of results) {
  const ranked = COMPANIES.map((c) => ({
    companyId: c,
    op: r.companyTurns.filter((x) => x.companyId === c).reduce((a, x) => a + x.op, 0),
    sales32: at(r, TURNS, c).allocatedSalesTons,
    shortfall: r.companyTurns.filter((x) => x.companyId === c && x.shortfall).length,
  })).sort((a, b) => b.op - a.op);
  console.log(
    `  [${r.seed}] ` + ranked.map((x, i) => `${i + 1}位${x.companyId}(OP=${M(x.op)}M,T32=${n0(x.sales32)}t,不足${x.shortfall})`).join("  ")
  );
}
