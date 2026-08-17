// ShrimpX V2 — Dynamic Scenario 2: 会社別 product mix / market mix の推移診断
//
// 【診断専用・読み取り専用】Standard AI・orientationProfile・シナリオ・保存データを
// 一切変更しない。newContracts（当期の成約）から市場×商品の構成を測る。
//
//   npx tsx scripts/dynamicScenario2MixDiagnostic.ts

import { initializeCompanyLab, advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo } from "../app/lib/v2/companyLab/runner";
import { generateStandardAiDecision } from "../app/lib/v2/companyLab/standardAi/policy";
import { DYNAMIC_SCENARIO_2 } from "../app/lib/v2/scenario/definitions/dynamicScenario2";
import { unwrapUnit } from "../app/lib/v2/core/units";
import { CompanyLabState } from "../app/lib/v2/companyLab/types";

const COMPANIES = ["BAL", "MASS", "JPQ", "VAP", "CONSV"] as const;
const PRODUCTS = ["hoso", "pd", "vap"] as const;
const MARKETS = ["CN", "US", "EU", "JP", "OTHER"] as const;
const SNAPSHOTS = [1, 4, 8, 12, 16, 20, 24, 28, 32];
const SEED = "ds2-full-a";

const pct = (part: number, total: number) => (total <= 0 ? "  -" : `${((part / total) * 100).toFixed(0)}`.padStart(3));

interface TurnMix {
  readonly turn: number;
  readonly companyId: string;
  readonly prod: Record<string, number>;
  readonly salesByProduct: Record<string, number>;
  readonly salesByMarket: Record<string, number>;
}

const { state: initialState, fixtures } = initializeCompanyLab({
  scenarioId: DYNAMIC_SCENARIO_2.scenarioId,
  mode: "canonical",
  seed: SEED,
  turns: 32,
});

let state: CompanyLabState = initialState;
const mixes: TurnMix[] = [];
let turn = 0;

while (!state.isComplete) {
  const publicInfo = buildPublicMarketInfo(state);
  const decisions = fixtures.map((f) =>
    generateStandardAiDecision(f, buildCompanyOwnState(state, f), publicInfo, state.currentPeriod, state.scenarioState.currentTurn)
  );
  state = advanceCompanyLabQuarter(state, fixtures, Object.fromEntries(decisions.map((d) => [d.companyId, d])));
  const record = state.history[state.history.length - 1];
  turn += 1;

  for (const companyId of COMPANIES) {
    const s = record.companySummaries.find((c) => c.companyId === companyId);
    const prod: Record<string, number> = {
      hoso: s ? unwrapUnit(s.hosoProduced) : 0,
      pd: s ? unwrapUnit(s.pdProduced) : 0,
      vap: s ? unwrapUnit(s.vapProduced) : 0,
    };
    const salesByProduct: Record<string, number> = { hoso: 0, pd: 0, vap: 0 };
    const salesByMarket: Record<string, number> = { CN: 0, US: 0, EU: 0, JP: 0, OTHER: 0 };
    for (const c of record.salesRecord.newContracts) {
      if (c.companyId !== companyId) continue;
      const q = unwrapUnit(c.originalQuantity);
      salesByProduct[c.product] = (salesByProduct[c.product] ?? 0) + q;
      salesByMarket[c.market] = (salesByMarket[c.market] ?? 0) + q;
    }
    mixes.push({ turn, companyId, prod, salesByProduct, salesByMarket });
  }
}

console.log(`=== Dynamic Scenario 2 mix 診断（seed=${SEED}, ${turn}Turn）===`);

console.log("\n### 生産構成 %（HOSO / PD / VAP）");
console.log("  Turn " + COMPANIES.map((c) => c.padStart(14)).join(""));
for (const t of SNAPSHOTS) {
  const row = COMPANIES.map((companyId) => {
    const m = mixes.find((x) => x.turn === t && x.companyId === companyId)!;
    const total = PRODUCTS.reduce((a, p) => a + m.prod[p], 0);
    return `${pct(m.prod.hoso, total)}/${pct(m.prod.pd, total)}/${pct(m.prod.vap, total)}`.padStart(14);
  }).join("");
  console.log(`  T${String(t).padEnd(4)}` + row);
}

console.log("\n### 成約構成 %（HOSO / PD / VAP）");
console.log("  Turn " + COMPANIES.map((c) => c.padStart(14)).join(""));
for (const t of SNAPSHOTS) {
  const row = COMPANIES.map((companyId) => {
    const m = mixes.find((x) => x.turn === t && x.companyId === companyId)!;
    const total = PRODUCTS.reduce((a, p) => a + m.salesByProduct[p], 0);
    return `${pct(m.salesByProduct.hoso, total)}/${pct(m.salesByProduct.pd, total)}/${pct(m.salesByProduct.vap, total)}`.padStart(14);
  }).join("");
  console.log(`  T${String(t).padEnd(4)}` + row);
}

console.log("\n### 会社間の商品構成ばらつき（最大share − 最小share、%ポイント）");
console.log("  Turn   生産HOSO 生産PD 生産VAP   成約HOSO 成約PD 成約VAP");
for (const t of SNAPSHOTS) {
  const rows = COMPANIES.map((companyId) => mixes.find((x) => x.turn === t && x.companyId === companyId)!);
  const spread = (pick: (m: TurnMix) => Record<string, number>, key: string) => {
    const shares = rows.map((m) => {
      const total = PRODUCTS.reduce((a, p) => a + pick(m)[p], 0);
      return total <= 0 ? 0 : (pick(m)[key] / total) * 100;
    });
    return (Math.max(...shares) - Math.min(...shares)).toFixed(1).padStart(8);
  };
  console.log(
    `  T${String(t).padEnd(4)}` +
      spread((m) => m.prod, "hoso") +
      spread((m) => m.prod, "pd") +
      spread((m) => m.prod, "vap") +
      "   " +
      spread((m) => m.salesByProduct, "hoso") +
      spread((m) => m.salesByProduct, "pd") +
      spread((m) => m.salesByProduct, "vap")
  );
}

console.log("\n### 成約の市場構成 %（CN / US / EU / JP / OTHER）");
for (const companyId of COMPANIES) {
  console.log(`\n  [${companyId}]`);
  for (const t of SNAPSHOTS) {
    const m = mixes.find((x) => x.turn === t && x.companyId === companyId)!;
    const total = MARKETS.reduce((a, k) => a + m.salesByMarket[k], 0);
    console.log(`    T${String(t).padEnd(3)} ` + MARKETS.map((k) => `${k}=${pct(m.salesByMarket[k], total)}%`).join("  "));
  }
}

console.log("\n### 会社間の市場構成ばらつき（最大share − 最小share、%ポイント）");
console.log("  Turn " + MARKETS.map((k) => k.padStart(8)).join(""));
for (const t of SNAPSHOTS) {
  const rows = COMPANIES.map((companyId) => mixes.find((x) => x.turn === t && x.companyId === companyId)!);
  const row = MARKETS.map((k) => {
    const shares = rows.map((m) => {
      const total = MARKETS.reduce((a, kk) => a + m.salesByMarket[kk], 0);
      return total <= 0 ? 0 : (m.salesByMarket[k] / total) * 100;
    });
    return (Math.max(...shares) - Math.min(...shares)).toFixed(1).padStart(8);
  }).join("");
  console.log(`  T${String(t).padEnd(4)}` + row);
}
