#!/usr/bin/env -S npx tsx
// Dynamic Scenario 1 — Phase 5: crowding counterfactual benchmark（read-only）
//
// 【問い】シナリオが機会を作ったとき、5社全員が同じところへ殺到すると
// 自分たちで利益機会を潰すのか。それとも「ニュースを見た全社が同じ戦略を取れば
// 全員が同じ利益を取れる」ゲームになってしまっているのか。
//
// 3つの局面を、それぞれ「1社だけ動く」「5社全社が動く」で比較する:
//   A. China HOSO spike（T13/T15/T23 …）
//   B. Japan VAP growth（T8以降）
//   C. Vietnam raw の安い四半期（主漁期 Q3）での国内買付集中
//
// 【ゲームロジックは変更しない】通常ゲームと同じ関数を同じ順序で回し、
// 意思決定（販売計画の希望数量・国内買付の希望数量）だけを差し替える。
// これは「もし5社がこう動いたら」という反実仮想であり、Standard AI の
// 改造ではない。

import { runCompanyLab, DS1_SAI5_FLAGS, DecisionOverride } from "./_dynamicScenario1Harness";
import { DEMAND_MARKET_IDS, DemandMarketId, Product } from "../app/lib/v2/market/types";
import { hosoEqTons, unwrapUnit } from "../app/lib/v2/core/units";
import { CompanyLabState, CompanyQuarterRecord } from "../app/lib/v2/companyLab/types";

const SCENARIO = "dynamic-scenario-1";
const SEED = "ds1-crowding";
const TURNS = 32;
/** 集中させるときに希望数量へ掛ける倍率（提示が需要上限を超えるまで押し込む）。 */
const PILE_MULTIPLIER = 4;

/** 販売計画の希望数量を、指定した市場×商品についてだけ増やす override を作る。 */
function salesPile(market: DemandMarketId, product: Product, companyIds: readonly string[] | "ALL"): DecisionOverride {
  return ({ fixture, aiDecision }) => {
    if (companyIds !== "ALL" && !companyIds.includes(fixture.companyId)) return undefined;
    return {
      ...aiDecision,
      salesPlans: aiDecision.salesPlans.map((p) =>
        p.market === market && p.product === product
          ? { ...p, desiredQuantity: hosoEqTons(unwrapUnit(p.desiredQuantity) * PILE_MULTIPLIER) }
          : p
      ),
    };
  };
}

/** 国内原料の買付希望量を増やす override。 */
function domesticPile(companyIds: readonly string[] | "ALL"): DecisionOverride {
  return ({ fixture, aiDecision }) => {
    if (companyIds !== "ALL" && !companyIds.includes(fixture.companyId)) return undefined;
    return {
      ...aiDecision,
      domesticPurchasePlan: {
        ...aiDecision.domesticPurchasePlan,
        desiredQuantity: hosoEqTons(unwrapUnit(aiDecision.domesticPurchasePlan.desiredQuantity) * PILE_MULTIPLIER),
      },
    };
  };
}

// ---------------------------------------------------------------------
// 計測
// ---------------------------------------------------------------------

interface CellStat {
  readonly offered: number;
  readonly contracted: number;
  readonly targetDemand: number;
  readonly externalOption: number;
  readonly price: number;
  readonly unfilled: number;
}

function cellStat(record: CompanyQuarterRecord | undefined, market: DemandMarketId, product: Product): CellStat {
  const alloc = record?.salesRecord.allocations.find((a) => a.market === market && a.product === product);
  const offered = (record?.decisions ?? [])
    .flatMap((d) => d.salesPlans)
    .filter((p) => p.market === market && p.product === product)
    .reduce((s, p) => s + unwrapUnit(p.desiredQuantity), 0);
  const contracted = (alloc?.companies ?? []).reduce((s, e) => s + unwrapUnit(e.allocatedQuantity), 0);
  return {
    offered,
    contracted,
    targetDemand: alloc ? unwrapUnit(alloc.targetDemand) : 0,
    externalOption: alloc ? unwrapUnit(alloc.externalOptionQuantity) : 0,
    price: alloc ? unwrapUnit(alloc.basePrice) : 0,
    unfilled: Math.max(0, offered - contracted),
  };
}

function averageOver(state: CompanyLabState, turns: readonly number[], market: DemandMarketId, product: Product) {
  const byTurn = new Map(state.history.map((h) => [h.turn, h]));
  const stats = turns.map((t) => cellStat(byTurn.get(t), market, product));
  const n = Math.max(1, stats.length);
  const sum = (f: (s: CellStat) => number) => stats.reduce((a, s) => a + f(s), 0);
  return {
    offered: sum((s) => s.offered) / n,
    contracted: sum((s) => s.contracted) / n,
    targetDemand: sum((s) => s.targetDemand) / n,
    externalOption: sum((s) => s.externalOption) / n,
    price: sum((s) => s.price) / n,
    unfilled: sum((s) => s.unfilled) / n,
    fillRatio: sum((s) => s.offered) > 0 ? sum((s) => s.contracted) / sum((s) => s.offered) : 1,
    share: sum((s) => s.targetDemand) > 0 ? sum((s) => s.contracted) / sum((s) => s.targetDemand) : 0,
  };
}

function companyProfit(state: CompanyLabState, companyId: string): number {
  return state.history.reduce((sum, h) => {
    const fin = h.financialResults.find((f) => f.companyId === companyId);
    return sum + (fin ? Number(fin.profitAndLoss.operatingProfit) : 0);
  }, 0);
}

function totalProfit(state: CompanyLabState, companyIds: readonly string[]): number {
  return companyIds.reduce((s, id) => s + companyProfit(state, id), 0);
}

// ---------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------

const control = runCompanyLab({ scenarioId: SCENARIO, seed: SEED, turns: TURNS, sai5: DS1_SAI5_FLAGS });
const companyIds = control.fixtures.map((f) => f.companyId);
const soloCompany = companyIds[0];

console.log(`# Dynamic Scenario 1 — crowding counterfactual (seed=${SEED}, pile x${PILE_MULTIPLIER})`);
console.log(`# 会社: ${companyIds.join(", ")} / SOLO=${soloCompany}`);
if (control.error) console.log(`# CONTROL ERROR: ${control.error}`);

interface Case {
  readonly label: string;
  readonly market: DemandMarketId;
  readonly product: Product;
  readonly turns: readonly number[];
  readonly solo: DecisionOverride;
  readonly crowd: DecisionOverride;
}

const CASES: readonly Case[] = [
  {
    label: "A. China HOSO spike",
    market: "CN",
    product: "hoso",
    turns: [13, 15, 23, 25, 27, 29, 31],
    solo: salesPile("CN", "hoso", [soloCompany]),
    crowd: salesPile("CN", "hoso", "ALL"),
  },
  {
    label: "B. Japan VAP growth",
    market: "JP",
    product: "vap",
    turns: [12, 16, 20, 24, 28, 32],
    solo: salesPile("JP", "vap", [soloCompany]),
    crowd: salesPile("JP", "vap", "ALL"),
  },
];

for (const c of CASES) {
  const solo = runCompanyLab({ scenarioId: SCENARIO, seed: SEED, turns: TURNS, sai5: DS1_SAI5_FLAGS, decisionOverride: c.solo });
  const crowd = runCompanyLab({ scenarioId: SCENARIO, seed: SEED, turns: TURNS, sai5: DS1_SAI5_FLAGS, decisionOverride: c.crowd });

  console.log(`\n## ${c.label} — ${c.market}/${c.product}（対象ターン ${c.turns.join(",")} の平均）`);
  console.log(["case", "5社提示", "5社成約", "対象需要", "外部供給", "実現価格", "成約率", "5社シェア", "未充足提示"].join("\t"));
  for (const [label, r] of [
    ["CONTROL", control],
    ["SOLO(1社)", solo],
    ["CROWD(5社)", crowd],
  ] as const) {
    if (r.error) {
      console.log(`${label}\tERROR: ${r.error}`);
      continue;
    }
    const a = averageOver(r.state, c.turns, c.market, c.product);
    console.log(
      [
        label,
        Math.round(a.offered),
        Math.round(a.contracted),
        Math.round(a.targetDemand),
        Math.round(a.externalOption),
        a.price.toFixed(3),
        (a.fillRatio * 100).toFixed(1) + "%",
        (a.share * 100).toFixed(1) + "%",
        Math.round(a.unfilled),
      ].join("\t")
    );
  }

  console.log(`\n### ${c.label} — 収益（累計営業利益、USD）`);
  console.log(["case", `SOLO社(${soloCompany})`, "他4社合計", "5社合計"].join("\t"));
  const others = companyIds.filter((id) => id !== soloCompany);
  for (const [label, r] of [
    ["CONTROL", control],
    ["SOLO(1社)", solo],
    ["CROWD(5社)", crowd],
  ] as const) {
    if (r.error) continue;
    console.log(
      [
        label,
        Math.round(companyProfit(r.state, soloCompany)).toLocaleString(),
        Math.round(totalProfit(r.state, others)).toLocaleString(),
        Math.round(totalProfit(r.state, companyIds)).toLocaleString(),
      ].join("\t")
    );
  }
}

// ---------------------------------------------------------------------
// C. Vietnam raw の買付集中
// ---------------------------------------------------------------------

const rawSolo = runCompanyLab({ scenarioId: SCENARIO, seed: SEED, turns: TURNS, sai5: DS1_SAI5_FLAGS, decisionOverride: domesticPile([soloCompany]) });
const rawCrowd = runCompanyLab({ scenarioId: SCENARIO, seed: SEED, turns: TURNS, sai5: DS1_SAI5_FLAGS, decisionOverride: domesticPile("ALL") });

console.log("\n## C. Vietnam raw 国内買付の集中（主漁期Q3 = T15,19,23,27,31 の平均）");
const rawTurns = [15, 19, 23, 27, 31];
console.log(["case", "国内価格", "買付意向", "供給", "取引量", "未売却", "買付上限"].join("\t"));
for (const [label, r] of [
  ["CONTROL", control],
  ["SOLO(1社)", rawSolo],
  ["CROWD(5社)", rawCrowd],
] as const) {
  if (r.error) {
    console.log(`${label}\tERROR: ${r.error}`);
    continue;
  }
  const byTurn = new Map(r.state.history.map((h) => [h.turn, h]));
  const rows = rawTurns.map((t) => byTurn.get(t)).filter((x): x is CompanyQuarterRecord => x !== undefined);
  const n = Math.max(1, rows.length);
  const avg = (f: (h: CompanyQuarterRecord) => number) => rows.reduce((a, h) => a + f(h), 0) / n;
  console.log(
    [
      label,
      avg((h) => unwrapUnit(h.marketResult.vietnamDomestic.price)).toFixed(3),
      Math.round(avg((h) => unwrapUnit(h.marketResult.vietnamDomestic.effectiveDemand))),
      Math.round(avg((h) => unwrapUnit(h.marketResult.vietnamDomestic.supply))),
      Math.round(avg((h) => unwrapUnit(h.marketResult.vietnamDomestic.transactedVolume))),
      Math.round(avg((h) => unwrapUnit(h.marketResult.vietnamDomestic.unsoldSupply))),
      avg((h) => unwrapUnit(h.marketResult.vietnamDomestic.buyingCeiling)).toFixed(3),
    ].join("\t")
  );
}

console.log("\n### C. 収益（累計営業利益、USD）");
console.log(["case", `SOLO社(${soloCompany})`, "他4社合計", "5社合計"].join("\t"));
const others = companyIds.filter((id) => id !== soloCompany);
for (const [label, r] of [
  ["CONTROL", control],
  ["SOLO(1社)", rawSolo],
  ["CROWD(5社)", rawCrowd],
] as const) {
  if (r.error) continue;
  console.log(
    [
      label,
      Math.round(companyProfit(r.state, soloCompany)).toLocaleString(),
      Math.round(totalProfit(r.state, others)).toLocaleString(),
      Math.round(totalProfit(r.state, companyIds)).toLocaleString(),
    ].join("\t")
  );
}

// ---------------------------------------------------------------------
// D. 逆張りの余地: CROWD 時に他市場の競争が緩むか
// ---------------------------------------------------------------------

console.log("\n## D. China HOSO へ全社殺到したとき、他市場の競争は緩むか（T13–T31平均）");
const crowdCn = runCompanyLab({ scenarioId: SCENARIO, seed: SEED, turns: TURNS, sai5: DS1_SAI5_FLAGS, decisionOverride: salesPile("CN", "hoso", "ALL") });
const observeTurns = [13, 15, 17, 19, 21, 23, 25, 27, 29, 31];
console.log(["market", "product", "CONTROL 5社シェア", "CROWD 5社シェア", "CONTROL価格", "CROWD価格"].join("\t"));
for (const market of DEMAND_MARKET_IDS) {
  for (const product of ["hoso", "pd", "vap"] as const) {
    if (market === "CN" && product === "hoso") continue;
    const a = averageOver(control.state, observeTurns, market, product);
    const b = averageOver(crowdCn.state, observeTurns, market, product);
    console.log(
      [market, product, (a.share * 100).toFixed(1) + "%", (b.share * 100).toFixed(1) + "%", a.price.toFixed(3), b.price.toFixed(3)].join("\t")
    );
  }
}
