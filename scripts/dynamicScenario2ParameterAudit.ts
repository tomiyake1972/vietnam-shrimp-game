// ShrimpX V2 — Dynamic Scenario 2 パラメータ監査（DS3設計の前提整理・読み取り専用）
//
// 指示§20「実装前に DS2 の Turn別世界需要・市場別需要・商品別需要・販売価格・
// EC/IN/VN 原料価格・原料供給量・主要イベント・News を整理する」に対応する。
//
// 【読み取り専用】シナリオ定義・ゲームロジック・保存データを一切変更しない。
// シナリオ側の解決値は getScenarioTurnInput（純粋関数）から、実現価格・実現需要は
// 実ゲームと同じ engine.ts 経路の32Turn実行結果から取る（別計算式を作らない）。
//
//   npx tsx scripts/dynamicScenario2ParameterAudit.ts
//   SCENARIO=dynamic-scenario-1-v0.1 npx tsx scripts/dynamicScenario2ParameterAudit.ts

import { createSimulationSession, advanceSimulationTurn } from "../app/lib/v2/companyLab/simulation/engine";
import { SimulationSession } from "../app/lib/v2/companyLab/simulation/types";
import { DYNAMIC_SCENARIO_2 } from "../app/lib/v2/scenario/definitions/dynamicScenario2";
import { getScenarioTurnInput } from "../app/lib/v2/scenario/scenarioEngine";
import { unwrapUnit } from "../app/lib/v2/core/units";
import { CountryId, DemandMarketId } from "../app/lib/v2/market/types";

const SCENARIO_ID = process.env.SCENARIO ?? DYNAMIC_SCENARIO_2.scenarioId;
const SEED = process.env.SEED ?? "ds2-audit";
const TURNS = 32;
const AT = "2026-01-01T00:00:00.000Z";
const COUNTRIES: readonly CountryId[] = ["VN", "EC", "IN", "ID"];
const MARKETS: readonly DemandMarketId[] = ["CN", "US", "EU", "JP", "OTHER"];
const PRODUCTS = ["hoso", "pd", "vap"] as const;

const n0 = (v: number) => Math.round(v).toLocaleString();
const f2 = (v: number) => v.toFixed(2);
const f3 = (v: number) => v.toFixed(3);

// ---------------------------------------------------------------------
// 32Turn 実行（実ゲームと同じ経路）
// ---------------------------------------------------------------------
let session: SimulationSession = createSimulationSession({
  simulationRunId: `ds2-audit-${SEED}`,
  scenarioId: SCENARIO_ID,
  seed: SEED,
  requestedTurns: TURNS,
  startedAt: AT,
});
const definition = session.state.scenarioState.definition;

interface TurnRow {
  readonly turn: number;
  readonly worldSupply: number;
  readonly worldDemand: number;
  readonly balance: number;
  readonly hosoFob: Record<string, number>;
  readonly vnDomesticPrice: number;
  readonly vnDomesticSupply: number;
  readonly vnDomesticTraded: number;
  readonly pdPremium: number;
  readonly vapPremium: number;
  readonly pdUtilization: number;
  readonly vapUtilization: number;
  /** 5社の成約から測った実現販売単価（市場別・商品別の加重平均、USD/HOSO換算kg）。 */
  readonly realizedPriceByMarket: Record<string, number>;
  readonly realizedPriceByProduct: Record<string, number>;
  readonly contractedTons: number;
}

const rows: TurnRow[] = [];
for (let t = 0; t < TURNS; t++) {
  const outcome = advanceSimulationTurn(session, AT);
  if (!outcome.advanced) break;
  session = outcome.session;
  const record = session.state.history[session.state.history.length - 1];
  const m = record.marketResult;

  const wsum: Record<string, { q: number; v: number }> = {};
  const psum: Record<string, { q: number; v: number }> = {};
  let contractedTons = 0;
  for (const c of record.salesRecord.newContracts) {
    const q = unwrapUnit(c.originalQuantity);
    const price = Number(c.unitPrice);
    (wsum[c.market] ??= { q: 0, v: 0 }).q += q;
    wsum[c.market].v += q * price;
    (psum[c.product] ??= { q: 0, v: 0 }).q += q;
    psum[c.product].v += q * price;
    contractedTons += q;
  }
  const avg = (acc: Record<string, { q: number; v: number }>, key: string) =>
    acc[key] && acc[key].q > 0 ? acc[key].v / acc[key].q : 0;

  rows.push({
    turn: t + 1,
    worldSupply: unwrapUnit(m.worldSupply),
    worldDemand: unwrapUnit(m.worldDemand),
    balance: m.worldSupplyDemandBalance,
    hosoFob: Object.fromEntries(COUNTRIES.map((c) => [c, Number(m.hosoPrices[c].price)])),
    vnDomesticPrice: Number(m.vietnamDomestic.price),
    vnDomesticSupply: unwrapUnit(m.vietnamDomestic.supply),
    vnDomesticTraded: unwrapUnit(m.vietnamDomestic.transactedVolume),
    pdPremium: Number(m.pdPremium.basePremium),
    vapPremium: Number(m.vapPremium.basePremium),
    pdUtilization: m.pdPremium.globalUtilization,
    vapUtilization: m.vapPremium.globalUtilization,
    realizedPriceByMarket: Object.fromEntries(MARKETS.map((k) => [k, avg(wsum, k)])),
    realizedPriceByProduct: Object.fromEntries(PRODUCTS.map((p) => [p, avg(psum, p)])),
    contractedTons,
  });
}

console.log(`=== Dynamic Scenario 2 パラメータ監査（scenarioId=${SCENARIO_ID} / seed=${SEED} / ${rows.length}Turn）===`);
console.log(`title: ${definition.title}`);

// ---------------------------------------------------------------------
// 1. シナリオ側の解決値（Turn別）
// ---------------------------------------------------------------------
const scenarioAt = (turn: number) => getScenarioTurnInput(session.state.scenarioState, turn);

console.log("\n### 1. 市場別 構造需要 REGIONAL_DEMAND ×（景気指数を掛ける前の潜在需要, HOSO換算t）");
console.log("  ※ シナリオ側の解決値。イベント（消費ブーム/需要ショック/CN HOSOスパイク）込み。");
console.log("  Turn " + MARKETS.map((k) => k.padStart(10)).join("") + "      合計");
for (let turn = 1; turn <= TURNS; turn++) {
  const input = scenarioAt(turn);
  const values = MARKETS.map((k) => unwrapUnit(input.demandMarkets[k].priorPeriodConsumption));
  console.log(`  T${String(turn).padEnd(4)}` + values.map((v) => n0(v).padStart(10)).join("") + n0(values.reduce((a, b) => a + b, 0)).padStart(10));
}

console.log("\n### 2. 市場別 景気指数 ECONOMIC_INDEX（1.000=中立）");
console.log("  Turn " + MARKETS.map((k) => k.padStart(9)).join(""));
for (let turn = 1; turn <= TURNS; turn++) {
  const input = scenarioAt(turn);
  console.log(`  T${String(turn).padEnd(4)}` + MARKETS.map((k) => f3(input.demandMarkets[k].economicIndex).padStart(9)).join(""));
}

console.log("\n### 3. 産地別 養殖コスト指数 AQUACULTURE_COST（原料価格アンカーの支配的レバー）");
console.log("  Turn " + COUNTRIES.map((c) => c.padStart(9)).join(""));
for (let turn = 1; turn <= TURNS; turn++) {
  const input = scenarioAt(turn);
  console.log(`  T${String(turn).padEnd(4)}` + COUNTRIES.map((c) => f3(input.countries[c].aquacultureCostIndex).padStart(9)).join(""));
}

console.log("\n### 4. 産地別 供給量 production（HOSO換算t/四半期）と VAP加工能力");
console.log("  Turn " + COUNTRIES.map((c) => `${c}生産`.padStart(11)).join("") + COUNTRIES.map((c) => `${c}VAP`.padStart(9)).join(""));
for (let turn = 1; turn <= TURNS; turn++) {
  const input = scenarioAt(turn);
  console.log(
    `  T${String(turn).padEnd(4)}` +
      COUNTRIES.map((c) => n0(unwrapUnit(input.countries[c].production)).padStart(11)).join("") +
      COUNTRIES.map((c) => n0(unwrapUnit(input.countries[c].vapProcessingCapacity)).padStart(9)).join("")
  );
}

console.log("\n### 5. PD / VAP 世界需要（シナリオ解決値, HOSO換算t）");
console.log("  Turn      PD需要     VAP需要");
for (let turn = 1; turn <= TURNS; turn++) {
  const input = scenarioAt(turn);
  console.log(`  T${String(turn).padEnd(4)}` + n0(unwrapUnit(input.pdVapDemand.pdDemand)).padStart(12) + n0(unwrapUnit(input.pdVapDemand.vapDemand)).padStart(12));
}

// ---------------------------------------------------------------------
// 6. 実現した価格・需給（32Turn実行の結果）
// ---------------------------------------------------------------------
console.log("\n### 6. 実現世界需給と価格（USD/HOSO換算kg）");
console.log("  Turn   世界供給   世界需要   需給差  VN_FOB EC_FOB IN_FOB ID_FOB  VN国内  PDprem VAPprem PD稼働 VAP稼働");
for (const r of rows) {
  console.log(
    `  T${String(r.turn).padEnd(4)}` +
      n0(r.worldSupply).padStart(11) +
      n0(r.worldDemand).padStart(11) +
      `${(r.balance * 100).toFixed(1)}%`.padStart(9) +
      f2(r.hosoFob.VN).padStart(8) +
      f2(r.hosoFob.EC).padStart(7) +
      f2(r.hosoFob.IN).padStart(7) +
      f2(r.hosoFob.ID).padStart(7) +
      f2(r.vnDomesticPrice).padStart(8) +
      f2(r.pdPremium).padStart(8) +
      f2(r.vapPremium).padStart(8) +
      f2(r.pdUtilization).padStart(7) +
      f2(r.vapUtilization).padStart(8)
  );
}

console.log("\n### 7. 5社の実現販売単価（成約加重平均, USD/HOSO換算kg）と成約量");
console.log("  Turn " + MARKETS.map((k) => k.padStart(8)).join("") + "  |" + PRODUCTS.map((p) => p.toUpperCase().padStart(8)).join("") + "     成約t");
for (const r of rows) {
  console.log(
    `  T${String(r.turn).padEnd(4)}` +
      MARKETS.map((k) => f2(r.realizedPriceByMarket[k]).padStart(8)).join("") +
      "  |" +
      PRODUCTS.map((p) => f2(r.realizedPriceByProduct[p]).padStart(8)).join("") +
      n0(r.contractedTons).padStart(10)
  );
}

// ---------------------------------------------------------------------
// 8. イベント・News
// ---------------------------------------------------------------------
console.log("\n### 8. 主要イベント（Turn別の有効イベント）");
for (let turn = 1; turn <= TURNS; turn++) {
  const ids = scenarioAt(turn).activeEventIds;
  if (ids.length > 0) console.log(`  T${String(turn).padEnd(4)} ${ids.join(", ")}`);
}

console.log("\n### 9. Scenario News（availableFromTurn 別の本数と見出し）");
const releases = definition.informationReleases ?? [];
const byTurn = new Map<number, string[]>();
for (const r of releases) {
  const list = byTurn.get(r.availableFromTurn) ?? [];
  list.push(`${r.informationLevel}${r.isRumor ? "/噂" : ""}: ${r.headlineTemplate}`);
  byTurn.set(r.availableFromTurn, list);
}
console.log(`  総本数: ${releases.length}`);
for (const turn of [...byTurn.keys()].sort((a, b) => a - b)) {
  const list = byTurn.get(turn)!;
  console.log(`  T${String(turn).padEnd(3)} (${list.length}本)`);
  for (const h of list) console.log(`        ${h}`);
}

// ---------------------------------------------------------------------
// 10. DS3設計のための要約
// ---------------------------------------------------------------------
console.log("\n### 10. DS3設計用サマリ");
const at = (turn: number) => rows.find((r) => r.turn === turn)!;
const marks = [1, 8, 12, 16, 20, 23, 24, 25, 26, 28, 29, 30, 32].filter((t) => rows.some((r) => r.turn === t));
console.log("  Turn  世界需要   実現HOSO単価(全市場加重)   VN国内原料   EC_FOB   T20比HOSO単価");
const base20 = at(20).realizedPriceByProduct.hoso;
for (const t of marks) {
  const r = at(t);
  console.log(
    `  T${String(t).padEnd(4)}` +
      n0(r.worldDemand).padStart(10) +
      f2(r.realizedPriceByProduct.hoso).padStart(25) +
      f2(r.vnDomesticPrice).padStart(13) +
      f2(r.hosoFob.EC).padStart(9) +
      `${((r.realizedPriceByProduct.hoso / base20) * 100).toFixed(1)}%`.padStart(16)
  );
}

// ---------------------------------------------------------------------
// 11. 会社別の終盤規模（DS3 §4 の目標レンジとの距離を測る）
// ---------------------------------------------------------------------
console.log("\n### 11. 会社別 成約量 t/Turn（終盤）と 5社合計・世界需要に対するシェア");
{
  const COMPANIES = ["BAL", "MASS", "JPQ", "VAP", "CONSV"] as const;
  const late = [16, 20, 24, 26, 28, 30, 32];
  console.log("  Turn " + COMPANIES.map((c) => c.padStart(10)).join("") + "     5社計   世界需要   5社シェア");
  for (const t of late) {
    const record = session.state.history.find((h) => h.turn === t);
    if (!record) continue;
    const byCompany = new Map<string, number>();
    for (const c of record.salesRecord.newContracts) {
      byCompany.set(c.companyId, (byCompany.get(c.companyId) ?? 0) + unwrapUnit(c.originalQuantity));
    }
    const total = [...byCompany.values()].reduce((a, b) => a + b, 0);
    const worldDemand = unwrapUnit(record.marketResult.worldDemand);
    console.log(
      `  T${String(t).padEnd(4)}` +
        COMPANIES.map((c) => n0(byCompany.get(c) ?? 0).padStart(10)).join("") +
        n0(total).padStart(11) +
        n0(worldDemand).padStart(11) +
        `${((total / worldDemand) * 100).toFixed(1)}%`.padStart(12)
    );
  }

  console.log("\n  【DS3 §4 目標との距離】");
  const targets: Readonly<Record<string, readonly [number, number]>> = {
    MASS: [90000, 100000],
    BAL: [55000, 65000],
    JPQ: [45000, 55000],
    VAP: [45000, 55000],
    CONSV: [45000, 50000],
  };
  const last = session.state.history[session.state.history.length - 1];
  const byCompany = new Map<string, number>();
  for (const c of last.salesRecord.newContracts) {
    byCompany.set(c.companyId, (byCompany.get(c.companyId) ?? 0) + unwrapUnit(c.originalQuantity));
  }
  let targetTotal = 0;
  for (const [companyId, [lo, hi]] of Object.entries(targets)) {
    const actual = byCompany.get(companyId) ?? 0;
    targetTotal += (lo + hi) / 2;
    console.log(`    ${companyId.padEnd(6)} DS2実測 T32 = ${n0(actual).padStart(8)}t  目標 ${n0(lo)}〜${n0(hi)}t  倍率 ${(((lo + hi) / 2) / Math.max(1, actual)).toFixed(1)}x`);
  }
  const actualTotal = [...byCompany.values()].reduce((a, b) => a + b, 0);
  console.log(`    5社計   DS2実測 T32 = ${n0(actualTotal).padStart(8)}t  目標中央値計 ${n0(targetTotal)}t  倍率 ${(targetTotal / Math.max(1, actualTotal)).toFixed(2)}x`);
  console.log(`    参考: T32 世界需要 ${n0(unwrapUnit(last.marketResult.worldDemand))}t / VN生産 ${n0(unwrapUnit(scenarioAt(32).countries.VN.production))}t`);
  console.log(`    → 目標を満たすと5社シェアは ${((actualTotal / unwrapUnit(last.marketResult.worldDemand)) * 100).toFixed(1)}% → ${((targetTotal / unwrapUnit(last.marketResult.worldDemand)) * 100).toFixed(1)}% になる`);
}

console.log("\n### 12. 5社の生産能力と稼働（終盤・工場能力が制約かどうかの判定）");
{
  const COMPANIES = ["BAL", "MASS", "JPQ", "VAP", "CONSV"] as const;
  for (const t of [16, 24, 32]) {
    const record = session.state.history.find((h) => h.turn === t);
    if (!record) continue;
    console.log(`  [T${t}]`);
    for (const companyId of COMPANIES) {
      const s = record.companySummaries.find((c) => c.companyId === companyId);
      if (!s) continue;
      const produced = unwrapUnit(s.hosoProduced) + unwrapUnit(s.pdProduced) + unwrapUnit(s.vapProduced);
      console.log(
        `    ${companyId.padEnd(6)} 生産=${n0(produced).padStart(8)}t  調達=${n0(unwrapUnit(s.domesticPurchaseQuantity)).padStart(8)}t` +
          `  受注残=${n0(unwrapUnit(s.outstandingBacklog ?? 0)).padStart(8)}t  製品在庫=${n0(unwrapUnit(s.finishedGoodsInventory)).padStart(8)}t`
      );
    }
  }
}
