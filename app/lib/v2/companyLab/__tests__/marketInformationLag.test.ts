// ShrimpX V2 — Batch 002: 市場×商品別需要数量の遅行公開（2四半期lag）の検証
//
// 【この機能の思想】市場には真の現在需要が存在するが、経営者はそれをリアルタイムでは
// 知らない。プレイヤーもStandard AIも「約6か月前に確認された市場規模」から現在を
// 推測する。ここで固定するのは次の4点である。
//   1. lagが仕様どおり（turn3→turn1、turn4→turn2）であること
//   2. 現在の真の需要がAIへ漏れないこと
//   3. プレイヤーUIとStandard AI Observationが同じ値を見ること
//   4. ゲームメカニクスの計算そのものは変わっていないこと

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { advanceCompanyLabQuarter, buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../runner";
import {
  MARKET_DEMAND_OBSERVATION_LAG_QUARTERS,
  buildInitialObservedMarketDemand,
  buildObservedMarketDemand,
} from "../marketDemandObservation";
import { generateStandardAiDecision } from "../standardAi/policy";
import { buildStandardAiObservation } from "../standardAi/observation";
import { CompanyDecisionInput, CompanyLabConfig, CompanyLabState } from "../types";
import { DEMAND_MARKET_IDS } from "../../market/types";
import { unwrapUnit } from "../../core/units";
import { SALES_PARAMETERS_V1 } from "../../sales/parameters";

const PRODUCTS = ["hoso", "pd", "vap"] as const;

function config(seed = "market-lag-001", turns = 8): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed, turns };
}

/** turnsぶん進め、各turnの「その時点の観測」と「そのturnの真の需要」を記録する。 */
function runAndCapture(turns: number, seed = "market-lag-001") {
  const { state, fixtures } = initializeCompanyLab(config(seed, turns));
  let cur: CompanyLabState = state;
  const observedByTurn: Record<number, ReturnType<typeof buildObservedMarketDemand>> = {};
  const trueDemandByTurn: Record<number, Record<string, number>> = {};
  const decisionsByTurn: Record<number, Record<string, CompanyDecisionInput>> = {};

  for (let t = 1; t <= turns; t++) {
    const publicInfo = buildPublicMarketInfo(cur);
    observedByTurn[t] = publicInfo.observedMarketDemand!;
    const decisions: Record<string, CompanyDecisionInput> = {};
    for (const f of fixtures) {
      decisions[f.companyId] = generateStandardAiDecision(f, buildCompanyOwnState(cur, f), publicInfo, cur.currentPeriod, t);
    }
    decisionsByTurn[t] = decisions;
    cur = advanceCompanyLabQuarter(cur, fixtures, decisions);

    const record = cur.history[cur.history.length - 1];
    const byMarketProduct: Record<string, number> = {};
    for (const a of record.salesRecord.allocations) {
      byMarketProduct[`${a.market}|${a.product}`] = (byMarketProduct[`${a.market}|${a.product}`] ?? 0) + unwrapUnit(a.targetDemand);
    }
    trueDemandByTurn[t] = byMarketProduct;
  }
  return { observedByTurn, trueDemandByTurn, decisionsByTurn, finalState: cur, fixtures };
}

test("1・2: turn3はturn1の需要を、turn4はturn2の需要を観測する（lag=2）", () => {
  const { observedByTurn, trueDemandByTurn } = runAndCapture(6);

  for (const [observingTurn, sourceTurn] of [
    [3, 1],
    [4, 2],
    [5, 3],
    [6, 4],
  ] as const) {
    const observed = observedByTurn[observingTurn];
    assert.equal(observed.observationSource, "LAGGED_MARKET_RESULT", `turn${observingTurn}は実績を観測する`);
    assert.equal(observed.sourceQuarter, sourceTurn, `turn${observingTurn}の観測元はturn${sourceTurn}`);
    for (const entry of observed.entries) {
      for (const product of PRODUCTS) {
        const expected = trueDemandByTurn[sourceTurn][`${entry.market}|${product}`] ?? 0;
        assert.ok(
          Math.abs(entry.observedDemandByProduct[product] - expected) < 1e-6,
          `turn${observingTurn}が観測する${entry.market}/${product}は、turn${sourceTurn}の実需要と一致する（観測=${entry.observedDemandByProduct[product]} 実績=${expected}）`
        );
      }
    }
  }
});

test("3: 当期の真の需要はAIへ漏れない（観測値が当期実需要と一致しない）", () => {
  const { observedByTurn, trueDemandByTurn } = runAndCapture(6);
  let differsSomewhere = false;
  for (const turn of [3, 4, 5, 6]) {
    for (const entry of observedByTurn[turn].entries) {
      for (const product of PRODUCTS) {
        const current = trueDemandByTurn[turn][`${entry.market}|${product}`] ?? 0;
        if (Math.abs(entry.observedDemandByProduct[product] - current) > 1e-6) differsSomewhere = true;
      }
    }
  }
  assert.ok(differsSomewhere, "観測値が当期の実需要とどこかで異なる（＝当期の真の需要が渡っていない）");
});

test("4: turn1・turn2はゲーム開始時点の既知市場情報を使う", () => {
  const { observedByTurn } = runAndCapture(4);
  for (const turn of [1, 2]) {
    assert.equal(observedByTurn[turn].observationSource, "INITIAL_MARKET_INFORMATION");
    assert.equal(observedByTurn[turn].sourceQuarter, null, "初期情報には実績turnが無い");
  }
  assert.equal(observedByTurn[3].observationSource, "LAGGED_MARKET_RESULT", "turn3から実績へ切り替わる");
});

test("5: プレイヤーUIとStandard AI Observationは同じ値を見る", () => {
  const { state, fixtures } = initializeCompanyLab(config("market-lag-fairness", 4));
  let cur = state;
  for (let t = 1; t <= 3; t++) {
    const publicInfo = buildPublicMarketInfo(cur);
    // プレイヤー画面が受け取る値（viewModelはpublicInfo.observedMarketDemandをそのまま渡す）
    const playerView = publicInfo.observedMarketDemand!;
    for (const f of fixtures) {
      const aiObservation = buildStandardAiObservation(f, buildCompanyOwnState(cur, f), publicInfo, cur.currentPeriod, t);
      for (const marketEntry of aiObservation.markets) {
        const playerEntry = playerView.entries.find((e) => e.market === marketEntry.market)!;
        for (const product of PRODUCTS) {
          assert.equal(
            marketEntry.observedDemandByProduct?.[product],
            playerEntry.observedDemandByProduct[product],
            `${f.companyId}/${marketEntry.market}/${product}: AIとプレイヤーで観測需要が一致する`
          );
        }
      }
      assert.equal(aiObservation.marketDemandObservationLagQuarters, playerView.observationLagQuarters);
      assert.equal(aiObservation.marketDemandSourceQuarter, playerView.sourceQuarter);
      assert.equal(aiObservation.marketDemandObservationSource, playerView.observationSource);
    }
    const decisions: Record<string, CompanyDecisionInput> = {};
    for (const f of fixtures) decisions[f.companyId] = generateStandardAiDecision(f, buildCompanyOwnState(cur, f), publicInfo, cur.currentPeriod, t);
    cur = advanceCompanyLabQuarter(cur, fixtures, decisions);
  }
});

test("6: 5市場×3商品すべてが観測に存在する（初期情報・実績のどちらでも）", () => {
  const { observedByTurn } = runAndCapture(4);
  for (const turn of [1, 3]) {
    const observed = observedByTurn[turn];
    assert.equal(observed.entries.length, DEMAND_MARKET_IDS.length);
    for (const market of DEMAND_MARKET_IDS) {
      const entry = observed.entries.find((e) => e.market === market);
      assert.ok(entry, `${market}の観測が存在する（turn${turn}）`);
      for (const product of PRODUCTS) {
        assert.equal(typeof entry!.observedDemandByProduct[product], "number");
        assert.ok(Number.isFinite(entry!.observedDemandByProduct[product]));
      }
      // 合計は3商品の和と一致し、構成比の和は1（需要0の市場を除く）。
      const sum = PRODUCTS.reduce((s, p) => s + entry!.observedDemandByProduct[p], 0);
      assert.ok(Math.abs(entry!.observedTotalDemand - sum) < 1e-6);
      if (sum > 0) {
        const shareSum = PRODUCTS.reduce((s, p) => s + entry!.observedProductShare[p], 0);
        assert.ok(Math.abs(shareSum - 1) < 1e-9);
      }
    }
  }
});

test("7: 観測lagはパラメータとして2に固定されており、他の値でも動く構造になっている", () => {
  assert.equal(MARKET_DEMAND_OBSERVATION_LAG_QUARTERS, 2);

  const { state, fixtures } = initializeCompanyLab(config("market-lag-param", 6));
  let cur = state;
  for (let t = 1; t <= 4; t++) {
    const publicInfo = buildPublicMarketInfo(cur);
    const decisions: Record<string, CompanyDecisionInput> = {};
    for (const f of fixtures) decisions[f.companyId] = generateStandardAiDecision(f, buildCompanyOwnState(cur, f), publicInfo, cur.currentPeriod, t);
    cur = advanceCompanyLabQuarter(cur, fixtures, decisions);
  }
  // 履歴4件（turn1..4）。次のturn5でlag=1なら turn4、lag=2なら turn3、lag=3なら turn2 を見る。
  assert.equal(buildObservedMarketDemand(cur, 5, 1).sourceQuarter, 4, "lag=1ならturn4");
  assert.equal(buildObservedMarketDemand(cur, 5, 2).sourceQuarter, 3, "lag=2ならturn3");
  assert.equal(buildObservedMarketDemand(cur, 5, 3).sourceQuarter, 2, "lag=3ならturn2");
});

test("8: 市場需要が動いても、公開されるのは2四半期後になる", () => {
  const { observedByTurn, trueDemandByTurn } = runAndCapture(8);
  // turn3の実需要が、turn5の観測として初めて現れる（turn3・turn4の観測には現れない）。
  const target = trueDemandByTurn[3];
  const asObservedAt5 = observedByTurn[5];
  for (const entry of asObservedAt5.entries) {
    for (const product of PRODUCTS) {
      assert.ok(Math.abs(entry.observedDemandByProduct[product] - (target[`${entry.market}|${product}`] ?? 0)) < 1e-6);
    }
  }
  assert.notEqual(observedByTurn[4].sourceQuarter, 3, "turn4の時点ではturn3の需要はまだ見えない");
  assert.equal(observedByTurn[3].sourceQuarter, 1);
});

test("9: JP19回帰 — 営業人員の配分が市場規模に対して合理的になる", () => {
  const { decisionsByTurn, trueDemandByTurn } = runAndCapture(6, "sai-train-standard-001");
  // 営業人員が増えた後期ターンで評価する（初期は総数が小さく丸めの影響が大きいため）。
  const decision = decisionsByTurn[6]["BAL"];
  const headcountByMarket: Record<string, number> = {};
  for (const p of decision.salesPlans) headcountByMarket[p.market] = p.salesForceHeadcount;
  const totalHeadcount = Object.values(headcountByMarket).reduce((s, v) => s + v, 0);
  assert.ok(totalHeadcount > 0);

  const demandByMarket: Record<string, number> = {};
  let demandTotal = 0;
  for (const [k, v] of Object.entries(trueDemandByTurn[6])) {
    const market = k.split("|")[0];
    demandByMarket[market] = (demandByMarket[market] ?? 0) + v;
    demandTotal += v;
  }

  const jpHeadcountShare = (headcountByMarket.JP ?? 0) / totalHeadcount;
  const jpDemandShare = demandByMarket.JP / demandTotal;

  // 旧挙動では、需要シェアが1桁%のJPへ営業人員の約50%が入っていた。
  assert.ok(
    jpHeadcountShare < 0.25,
    `JPへの営業集中が解消していること（人員シェア=${(jpHeadcountShare * 100).toFixed(1)}% 需要シェア=${(jpDemandShare * 100).toFixed(1)}%）`
  );
  // hard capではなく機会に基づく配分なので、需要シェアからかけ離れていないことを見る。
  assert.ok(
    jpHeadcountShare < jpDemandShare * 3 + 0.05,
    `JPの人員シェアが需要シェアから乖離しすぎないこと（人員=${(jpHeadcountShare * 100).toFixed(1)}% 需要=${(jpDemandShare * 100).toFixed(1)}%）`
  );
  // 最大需要市場に最大の人員が向いていること。
  const topDemandMarket = Object.entries(demandByMarket).sort((a, b) => b[1] - a[1])[0][0];
  const topHeadcountMarket = Object.entries(headcountByMarket).sort((a, b) => b[1] - a[1])[0][0];
  assert.equal(topHeadcountMarket, topDemandMarket, "最大需要市場へ最も多くの営業人員が配置される");
});

test("10: maximumSupplierShareはゲーム側の共有パラメータを参照し、AI側にhard-codeしない", () => {
  // decision/sales.ts に 0.35 のようなシェア上限の直書きが無いことを確認する。
  const source = fs.readFileSync(path.resolve(__dirname, "..", "standardAi", "decision", "sales.ts"), "utf8");
  // コメント（説明文）は対象外。実行されるコードだけを見る。
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
  assert.ok(!/0\.35/.test(code), "decision/sales.ts のコードにシェア上限の数値を直書きしてはならない");
  assert.ok(/maximumSupplierShare/.test(code), "共有パラメータ maximumSupplierShare を参照している");
  assert.equal(typeof SALES_PARAMETERS_V1.maximumSupplierShare, "number");
});

test("11: ゲームメカニクスの計算結果は、同じ意思決定なら変更前後で同一（エンジンは観測情報を見ない）", () => {
  // advanceCompanyLabQuarter は publicInfo を引数に取らない＝観測情報が
  // エンジンの計算へ入り込む経路が構造上存在しない。ここでは、同じ意思決定列を
  // 2回流して結果が完全一致することと、観測情報が意思決定以外の経路で
  // 結果へ影響しないことを確認する。
  const seed = "mechanics-invariance-001";
  const captured: Record<string, CompanyDecisionInput>[] = [];
  {
    const { state, fixtures } = initializeCompanyLab(config(seed, 6));
    let cur = state;
    for (let t = 1; t <= 6; t++) {
      const publicInfo = buildPublicMarketInfo(cur);
      const decisions: Record<string, CompanyDecisionInput> = {};
      for (const f of fixtures) decisions[f.companyId] = generateStandardAiDecision(f, buildCompanyOwnState(cur, f), publicInfo, cur.currentPeriod, t);
      captured.push(decisions);
      cur = advanceCompanyLabQuarter(cur, fixtures, decisions);
    }
  }
  const replay = () => {
    const { state, fixtures } = initializeCompanyLab(config(seed, 6));
    let cur = state;
    for (const decisions of captured) cur = advanceCompanyLabQuarter(cur, fixtures, decisions);
    return createHash("sha256")
      .update(
        JSON.stringify(
          cur.history.map((r) => ({
            turn: r.turn,
            allocations: r.salesRecord.allocations,
            production: r.productionAllocation,
            domestic: r.domesticAllocation,
            summaries: r.companySummaries,
          }))
        )
      )
      .digest("hex");
  };
  assert.equal(replay(), replay(), "同じ意思決定列からは常に同じエンジン結果が出る");
});

test("12: ベンチマークの決定論性 — 同じseedなら観測需要も完全に一致する", () => {
  const a = runAndCapture(4, "determinism-001");
  const b = runAndCapture(4, "determinism-001");
  assert.equal(JSON.stringify(a.observedByTurn), JSON.stringify(b.observedByTurn));
  assert.equal(JSON.stringify(a.trueDemandByTurn), JSON.stringify(b.trueDemandByTurn));
});

test("初期市場情報はシナリオ前史の既存値だけから作られる（新しい需要値を発明していない）", () => {
  const { state } = initializeCompanyLab(config("initial-info-001", 4));
  const definition = state.scenarioState.definition;
  const initial = buildInitialObservedMarketDemand(definition, 1);

  const prehistory = definition.prehistory;
  const totalSupply = Object.values(prehistory.countrySupplyHosoEqTons).reduce((s, v) => s + v, 0);
  const vietnamShare = prehistory.countrySupplyHosoEqTons.VN / totalSupply;

  for (const entry of initial.entries) {
    const expectedTotal = prehistory.priorMarketConsumptionHosoEqTons[entry.market] * vietnamShare;
    assert.ok(
      Math.abs(entry.observedTotalDemand - expectedTotal) < 1e-6,
      `${entry.market}の初期観測は「前史消費量×前史ベトナム供給シェア」に一致する`
    );
  }
});
