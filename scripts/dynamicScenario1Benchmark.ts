#!/usr/bin/env -S npx tsx
// Dynamic Scenario 1 — Phase 5: 5社×32Q deterministic benchmark（read-only）
//
// 【この benchmark が答える問い】
//  (1) シナリオが指定した市場構造変化が、過去の供給不足で消されていないか
//      （Japan / EU / Others が後半に自然消滅しないか）
//  (2) 短期の需給メカニクス（価格・在庫・供給不足）が残っているか
//  (3) 「シナリオで市場が悪化した」のか「5社が殺到して自分たちで悪化させた」のかを
//      区別できる crowding 診断が取れるか
//
// ゲームロジックは一切変更しない。通常ゲームと同じ関数を同じ順序で回し、
// 記録済みの値を読み出して整形するだけ。
//
// 使い方:
//   npx tsx scripts/dynamicScenario1Benchmark.ts [scenarioId] [seed] [--no-lifecycle]

import { runCompanyLab, DS1_SAI5_FLAGS } from "./_dynamicScenario1Harness";
import { DYNAMIC_SCENARIO_1 } from "../app/lib/v2/scenario/definitions/dynamicScenario1";
import { initializeScenario, getScenarioTurnInput } from "../app/lib/v2/scenario/scenarioEngine";
import { resolveScenarioProductLifecycleParameters } from "../app/lib/v2/scenario/lifecycle";
import { computeMarketProductMix } from "../app/lib/v2/market/productLifecycle";
import { DEMAND_MARKET_IDS, DemandMarketId, Product } from "../app/lib/v2/market/types";
import { unwrapUnit } from "../app/lib/v2/core/units";
import { CompanyQuarterRecord } from "../app/lib/v2/companyLab/types";

const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];
const REPORT_TURNS = [1, 8, 16, 20, 24, 28, 32];
const scenarioId = process.argv[2] ?? "dynamic-scenario-1";
const seed = process.argv[3] ?? "ds1-benchmark";
const lifecycleOn = !process.argv.includes("--no-lifecycle");

const result = runCompanyLab({ scenarioId, seed, turns: 32, ...(lifecycleOn ? { sai5: DS1_SAI5_FLAGS } : {}) });
console.log(
  `# Dynamic Scenario 1 benchmark — scenario=${scenarioId} seed=${seed} lifecycle=${lifecycleOn ? "ON" : "OFF"} completed=${result.completedTurns}/32`
);
if (result.error) console.log(`# ERROR: ${result.error}`);

const historyByTurn = new Map(result.state.history.map((h) => [h.turn, h]));

// ---------------------------------------------------------------------
// 構造需要（シナリオが定義した世界）— 実現とは別系統として算出する
// ---------------------------------------------------------------------

const scenarioState = initializeScenario(DYNAMIC_SCENARIO_1, "canonical", seed);
const lifecycleParams = resolveScenarioProductLifecycleParameters(DYNAMIC_SCENARIO_1);

function structuralDemand(turn: number, market: DemandMarketId, product: Product): number {
  const si = getScenarioTurnInput(scenarioState, turn);
  const mix = computeMarketProductMix(turn, lifecycleParams);
  return unwrapUnit(si.demandMarkets[market].priorPeriodConsumption) * mix[market][product];
}
const structuralMarketTotal = (turn: number, m: DemandMarketId) => PRODUCTS.reduce((s, p) => s + structuralDemand(turn, m, p), 0);

// ---------------------------------------------------------------------
// 実現側（市場エンジン + 5社の行動の結果）
// ---------------------------------------------------------------------

interface Cell {
  readonly targetDemand: number;
  readonly offered: number;
  readonly contracted: number;
  readonly externalOption: number;
  readonly price: number;
  readonly maxCompanyShare: number;
  readonly companyCount: number;
}

function cell(record: CompanyQuarterRecord | undefined, market: DemandMarketId, product: Product): Cell {
  const alloc = record?.salesRecord.allocations.find((a) => a.market === market && a.product === product);
  const offered = (record?.decisions ?? [])
    .flatMap((d) => d.salesPlans)
    .filter((p) => p.market === market && p.product === product)
    .reduce((sum, p) => sum + unwrapUnit(p.desiredQuantity), 0);
  const companies = alloc?.companies ?? [];
  const contracted = companies.reduce((s, e) => s + unwrapUnit(e.allocatedQuantity), 0);
  const maxAllocated = companies.reduce((mx, e) => Math.max(mx, unwrapUnit(e.allocatedQuantity)), 0);
  return {
    targetDemand: alloc ? unwrapUnit(alloc.targetDemand) : 0,
    offered,
    contracted,
    externalOption: alloc ? unwrapUnit(alloc.externalOptionQuantity) : 0,
    price: alloc ? unwrapUnit(alloc.basePrice) : 0,
    maxCompanyShare: contracted > 0 ? maxAllocated / contracted : 0,
    companyCount: companies.filter((e) => unwrapUnit(e.allocatedQuantity) > 0).length,
  };
}
const realizedMarketTotal = (turn: number, m: DemandMarketId) =>
  PRODUCTS.reduce((s, p) => s + cell(historyByTurn.get(turn), m, p).targetDemand, 0);

// ---------------------------------------------------------------------
// A. 市場が後半に自然消滅していないか（最重要確認）
// ---------------------------------------------------------------------

console.log("\n## A. 市場別 構造需要 vs 実現対象需要（HOSO換算トン、比=実現/構造）");
console.log(["turn", ...DEMAND_MARKET_IDS.flatMap((m) => [`${m}_構造`, `${m}_実現`, `${m}_比`])].join("\t"));
for (const turn of REPORT_TURNS) {
  const row: (string | number)[] = [turn];
  for (const m of DEMAND_MARKET_IDS) {
    const s = structuralMarketTotal(turn, m);
    const r = realizedMarketTotal(turn, m);
    row.push(Math.round(s), Math.round(r), s > 0 ? (r / s).toFixed(3) : "-");
  }
  console.log(row.join("\t"));
}

console.log("\n## B. 追跡対象セル（構造 / 実現）");
const TRACKED: readonly (readonly [DemandMarketId, Product | "ALL", string])[] = [
  ["JP", "ALL", "Japan total"],
  ["JP", "vap", "Japan VAP"],
  ["OTHER", "pd", "Others PD"],
  ["OTHER", "vap", "Others VAP"],
  ["CN", "hoso", "China HOSO"],
  ["CN", "pd", "China PD"],
  ["CN", "vap", "China VAP"],
];
console.log(["指標", "系列", ...REPORT_TURNS.map((t) => `T${t}`)].join("\t"));
for (const [market, product, label] of TRACKED) {
  const struct = REPORT_TURNS.map((t) => Math.round(product === "ALL" ? structuralMarketTotal(t, market) : structuralDemand(t, market, product)));
  const real = REPORT_TURNS.map((t) =>
    Math.round(product === "ALL" ? realizedMarketTotal(t, market) : cell(historyByTurn.get(t), market, product).targetDemand)
  );
  console.log([label, "構造", ...struct].join("\t"));
  console.log([label, "実現", ...real].join("\t"));
}

console.log("\n## C. 市場ウェイト（実現対象需要の構成比、%）");
console.log(["turn", ...DEMAND_MARKET_IDS].join("\t"));
for (const turn of REPORT_TURNS) {
  const totals = DEMAND_MARKET_IDS.map((m) => realizedMarketTotal(turn, m));
  const sum = totals.reduce((a, b) => a + b, 0);
  console.log([turn, ...totals.map((v) => (sum > 0 ? ((v / sum) * 100).toFixed(1) : "-"))].join("\t"));
}

// ---------------------------------------------------------------------
// D. Crowding 診断
// ---------------------------------------------------------------------

console.log("\n## D. Crowding 診断（市場×商品）");
console.log(
  ["turn", "mkt", "prod", "構造需要", "対象需要", "5社提示", "5社成約", "外部供給", "供給/需要", "実現価格", "5社シェア%", "最大社/5社%", "成約社数", "未充足提示"].join("\t")
);
for (const turn of REPORT_TURNS) {
  const record = historyByTurn.get(turn);
  for (const market of DEMAND_MARKET_IDS) {
    for (const product of PRODUCTS) {
      const c = cell(record, market, product);
      console.log(
        [
          turn,
          market,
          product,
          Math.round(structuralDemand(turn, market, product)),
          Math.round(c.targetDemand),
          Math.round(c.offered),
          Math.round(c.contracted),
          Math.round(c.externalOption),
          c.targetDemand > 0 ? ((c.offered + c.externalOption) / c.targetDemand).toFixed(2) : "-",
          c.price.toFixed(3),
          c.targetDemand > 0 ? ((c.contracted / c.targetDemand) * 100).toFixed(1) : "-",
          (c.maxCompanyShare * 100).toFixed(1),
          c.companyCount,
          Math.round(Math.max(0, c.offered - c.contracted)),
        ].join("\t")
      );
    }
  }
}

// ---------------------------------------------------------------------
// E. 5社 vs 外部供給者
// ---------------------------------------------------------------------

console.log("\n## E. 5社 vs 外部供給者（全市場×商品の合計）");
console.log(["turn", "対象需要", "5社提示", "5社成約", "外部供給", "5社シェア%", "外部シェア%"].join("\t"));
for (let turn = 1; turn <= 32; turn++) {
  const record = historyByTurn.get(turn);
  let demand = 0;
  let offered = 0;
  let contracted = 0;
  let external = 0;
  for (const market of DEMAND_MARKET_IDS) {
    for (const product of PRODUCTS) {
      const c = cell(record, market, product);
      demand += c.targetDemand;
      offered += c.offered;
      contracted += c.contracted;
      external += c.externalOption;
    }
  }
  console.log(
    [
      turn,
      Math.round(demand),
      Math.round(offered),
      Math.round(contracted),
      Math.round(external),
      demand > 0 ? ((contracted / demand) * 100).toFixed(1) : "-",
      demand > 0 ? ((external / demand) * 100).toFixed(1) : "-",
    ].join("\t")
  );
}

// ---------------------------------------------------------------------
// F. 原料・価格（短期メカニクスが生きているか）
// ---------------------------------------------------------------------

console.log("\n## F. 原料・価格（全32ターン）");
console.log(["turn", "VN国内価格", "VN供給", "VN取引量", "未売却", "VN_FOB", "IN_FOB", "EC_FOB"].join("\t"));
for (let turn = 1; turn <= 32; turn++) {
  const record = historyByTurn.get(turn);
  if (!record) continue;
  const d = record.marketResult.vietnamDomestic;
  const h = record.marketResult.hosoPrices;
  console.log(
    [
      turn,
      unwrapUnit(d.price).toFixed(3),
      Math.round(unwrapUnit(d.supply)),
      Math.round(unwrapUnit(d.transactedVolume)),
      Math.round(unwrapUnit(d.unsoldSupply)),
      unwrapUnit(h.VN.price).toFixed(3),
      unwrapUnit(h.IN.price).toFixed(3),
      unwrapUnit(h.EC.price).toFixed(3),
    ].join("\t")
  );
}

// ---------------------------------------------------------------------
// G. 会社別の結果（勝者・敗者が分かれているか）
// ---------------------------------------------------------------------

console.log("\n## G. 会社別 累計営業利益 / 期末現金 / 期末自己資本 / 累計成約量");
console.log(["company", "累計営業利益", "期末現金", "期末自己資本", "累計成約量"].join("\t"));
for (const fixture of result.fixtures) {
  const companyId = fixture.companyId;
  let cumulativeOp = 0;
  let cumulativeContracted = 0;
  let lastCash = 0;
  let lastEquity = 0;
  for (const h of result.state.history) {
    const fin = h.financialResults.find((f) => f.companyId === companyId);
    if (fin) {
      cumulativeOp += Number(fin.profitAndLoss.operatingProfit);
      lastCash = Number(fin.balanceSheet.cash);
      lastEquity = Number(fin.balanceSheet.totalEquity);
    }
    for (const alloc of h.salesRecord.allocations) {
      for (const e of alloc.companies) {
        if (e.companyId === companyId) cumulativeContracted += unwrapUnit(e.allocatedQuantity);
      }
    }
  }
  console.log(
    [
      companyId,
      Math.round(cumulativeOp).toLocaleString(),
      Math.round(lastCash).toLocaleString(),
      Math.round(lastEquity).toLocaleString(),
      Math.round(cumulativeContracted).toLocaleString(),
    ].join("\t")
  );
}

// ---------------------------------------------------------------------
// H. 会社×ターン 詳細指標（#04 指示 §14）
// ---------------------------------------------------------------------

console.log("\n## H. 会社×ターン 詳細（全32ターン）");
console.log(
  [
    "turn","company","成約量","成約単価","履行量","受注残","国内買付","国内買付単価","輸入到着","原料在庫",
    "HOSO生産","PD生産","VAP生産","完成品在庫","原料不足","設備稼働率","労働稼働率","残業率",
    "営業利益","現金","有利子負債","品質(PD)","顧客信頼(平均)",
  ].join("\t")
);
for (const h of result.state.history) {
  for (const sum of h.companySummaries) {
    const fin = h.financialResults.find((f) => f.companyId === sum.companyId);
    const trustValues = Object.values(sum.customerTrustByMarket).filter((v): v is NonNullable<typeof v> => v !== undefined).map(Number);
    const avgTrust = trustValues.length > 0 ? trustValues.reduce((a, b) => a + b, 0) / trustValues.length : 0;
    const debt = fin ? Number(fin.balanceSheet.shortTermLoans) + Number(fin.balanceSheet.longTermLoans) : 0;
    console.log(
      [
        h.turn,
        sum.companyId,
        Math.round(unwrapUnit(sum.newContractedQuantity)),
        sum.newContractedAveragePrice.toFixed(3),
        Math.round(unwrapUnit(sum.fulfilledQuantity)),
        Math.round(unwrapUnit(sum.outstandingQuantity)),
        Math.round(unwrapUnit(sum.domesticPurchaseQuantity)),
        sum.domesticPurchasePrice.toFixed(3),
        Math.round(unwrapUnit(sum.importArrivedQuantity)),
        Math.round(unwrapUnit(sum.rawMaterialInventory)),
        Math.round(unwrapUnit(sum.hosoProduced)),
        Math.round(unwrapUnit(sum.pdProduced)),
        Math.round(unwrapUnit(sum.vapProduced)),
        Math.round(unwrapUnit(sum.finishedGoodsInventory)),
        Math.round(unwrapUnit(sum.rawMaterialShortfall)),
        unwrapUnit(sum.equipmentUtilizationRate).toFixed(3),
        unwrapUnit(sum.laborUtilizationRate).toFixed(3),
        unwrapUnit(sum.overtimeRate).toFixed(3),
        fin ? Math.round(Number(fin.profitAndLoss.operatingProfit)) : "-",
        fin ? Math.round(Number(fin.balanceSheet.cash)) : "-",
        Math.round(debt),
        sum.qualityScoreByProduct.pd !== undefined ? Number(sum.qualityScoreByProduct.pd).toFixed(1) : "-",
        avgTrust.toFixed(1),
      ].join("\t")
    );
  }
}

// ---------------------------------------------------------------------
// I. 局面別の会社別サマリー（#04 指示 §14）
// ---------------------------------------------------------------------

const PHASES: readonly { readonly label: string; readonly turns: readonly number[] }[] = [
  { label: "T1-4 序盤成長", turns: [1, 2, 3, 4] },
  { label: "T7-9 原料ショック", turns: [7, 8, 9] },
  { label: "T8-12 再建・消費ブーム", turns: [8, 9, 10, 11, 12] },
  { label: "T13-16 global調達転換", turns: [13, 14, 15, 16] },
  { label: "T17-20 世界需要ショック", turns: [17, 18, 19, 20] },
  { label: "T22-24 再開ブーム", turns: [22, 23, 24] },
  { label: "T25-32 拡大・中国高付加価値化", turns: [25, 26, 27, 28, 29, 30, 31, 32] },
];

console.log("\n## I. 局面別 会社別サマリー");
console.log(["局面", "company", "営業利益計", "成約量計", "生産量計", "国内買付計", "輸入到着計", "国内比率", "平均設備稼働率", "期末現金", "期末受注残"].join("\t"));
for (const phase of PHASES) {
  for (const fixture of result.fixtures) {
    const id = fixture.companyId;
    const rows = phase.turns.map((t) => historyByTurn.get(t)).filter((h): h is CompanyQuarterRecord => h !== undefined);
    let op = 0, contracted = 0, produced = 0, domestic = 0, imported = 0, util = 0, n = 0, cash = 0, backlog = 0;
    for (const h of rows) {
      const sum = h.companySummaries.find((c) => c.companyId === id);
      const fin = h.financialResults.find((f) => f.companyId === id);
      if (!sum) continue;
      n += 1;
      op += fin ? Number(fin.profitAndLoss.operatingProfit) : 0;
      contracted += unwrapUnit(sum.newContractedQuantity);
      produced += unwrapUnit(sum.hosoProduced) + unwrapUnit(sum.pdProduced) + unwrapUnit(sum.vapProduced);
      domestic += unwrapUnit(sum.domesticPurchaseQuantity);
      imported += unwrapUnit(sum.importArrivedQuantity);
      util += unwrapUnit(sum.equipmentUtilizationRate);
      cash = fin ? Number(fin.balanceSheet.cash) : cash;
      backlog = unwrapUnit(sum.outstandingQuantity);
    }
    const rawTotal = domestic + imported;
    console.log(
      [
        phase.label,
        id,
        Math.round(op).toLocaleString(),
        Math.round(contracted).toLocaleString(),
        Math.round(produced).toLocaleString(),
        Math.round(domestic).toLocaleString(),
        Math.round(imported).toLocaleString(),
        rawTotal > 0 ? ((domestic / rawTotal) * 100).toFixed(1) + "%" : "-",
        n > 0 ? (util / n).toFixed(3) : "-",
        Math.round(cash).toLocaleString(),
        Math.round(backlog).toLocaleString(),
      ].join("\t")
    );
  }
}
