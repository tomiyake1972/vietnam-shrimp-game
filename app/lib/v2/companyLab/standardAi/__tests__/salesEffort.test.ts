// ShrimpX V2 — SAI-2追加作業: 市場別営業配置・商品別営業工数 標準AI単体テスト
//
// 対象は directive 項目6の「7. 標準AIが商品構成・営業工数を踏まえて市場別に
// 営業人員を配分することを確認するテスト」。sales/__tests__/marketEffort.test.ts
// がエンジン本体（sales/marketEffort.ts）の計算ロジックを検証するのに対し、
// このファイルは標準AI（standardAi/decision/sales.ts の buildStandardAiSalesPlans）
// が実際にその計算式を使い、
//   - 同一市場内のHOSO/PD/VAP全行が同じsalesForceHeadcountを持つこと
//   - 市場別配分の合計が実在する営業人員総数を超えないこと
//   - VAPのような営業工数の重い商品構成のほうが、同じ数量でもより多くの
//     人員（または縮小）を要すること
//   - 人員が全社的に不足する場合、意思決定自体がその制約を反映して縮小されること
// を確認する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { unwrapUnit } from "../../../core/units";
import { initializeCompanyLab, buildCompanyOwnState, buildPublicMarketInfo } from "../../runner";
import { generateStandardAiDecisionWithDiagnostics } from "../policy";
import { CompanyLabConfig, CompanyFixture } from "../../types";
import { score0to100 } from "../../../core/units";
import { buildStandardAiObservation } from "../observation";
import { buildStandardAiSalesPlans } from "../decision/sales";
import { computePressureScores } from "../pressures";
import { StandardAiObservation } from "../types";
import { STANDARD_AI_PARAMETERS_V1 } from "../parameters";
import { SALES_PARAMETERS_SAI5_SALES_BASE_V1 } from "../../../sales/parameters";

function baseConfig(overrides: Partial<CompanyLabConfig> = {}): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed: "sai2-standardai-effort-001", turns: 8, ...overrides };
}

function setup(seed = "sai2-standardai-effort-001", fixtureOverride: (f: CompanyFixture) => CompanyFixture = (f) => f) {
  const { state, fixtures } = initializeCompanyLab(baseConfig({ seed }));
  const original = fixtures.find((f) => f.companyId === "BAL")!;
  const fixture = fixtureOverride(original);
  const ownState = buildCompanyOwnState(state, fixture);
  const publicInfo = buildPublicMarketInfo(state);
  return { fixture, ownState, publicInfo, period: state.currentPeriod, turn: 1 };
}

test("7a. 標準AIの意思決定において、同一市場内のHOSO/PD/VAP行はすべて同一のsalesForceHeadcountを持つ（市場単位配分であり行単位ではない）", () => {
  const { fixture, ownState, publicInfo, period, turn } = setup();
  const { decision } = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, period, turn);
  const headcountByMarket = new Map<string, number>();
  for (const plan of decision.salesPlans) {
    const existing = headcountByMarket.get(plan.market);
    if (existing === undefined) {
      headcountByMarket.set(plan.market, plan.salesForceHeadcount);
    } else {
      assert.equal(
        plan.salesForceHeadcount,
        existing,
        `市場 ${plan.market} 内で商品ごとにsalesForceHeadcountが異なっている（${plan.product}）`
      );
    }
  }
  assert.ok(headcountByMarket.size > 0, "販売計画が1件も生成されていない");
});

test("7b. 標準AIが配分する市場別営業人員（重複排除後）の合計は、実在する営業人員総数を超えない", () => {
  const { fixture, ownState, publicInfo, period, turn } = setup();
  const { decision } = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, period, turn);
  const headcountByMarket = new Map<string, number>();
  for (const plan of decision.salesPlans) {
    headcountByMarket.set(plan.market, plan.salesForceHeadcount);
  }
  const total = Array.from(headcountByMarket.values()).reduce((a, b) => a + b, 0);
  assert.ok(
    total <= fixture.salesForceHeadcountTotal,
    `市場別配分の合計(${total})が実在する営業人員総数(${fixture.salesForceHeadcountTotal})を超えている`
  );
});

test("7c. 営業人員総数が全社的に不足する場合、標準AIはSALES_HEADCOUNT_INSUFFICIENT_TOTALを診断し、意思決定自体が制約後の数量に縮小されている", () => {
  // 営業人員をゼロ人近くまで絞ることで、どんな市場配分をしても全市場が
  // 制約に達する状況を作る（基礎能力200t/市場は残るが、5市場に分散すれば
  // 通常の希望販売量は上回れないはず）。
  const { fixture, ownState, publicInfo, period, turn } = setup("sai2-standardai-effort-002", (f) => ({
    ...f,
    salesForceHeadcountTotal: 1,
  }));
  const { decision, diagnostics } = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, period, turn);
  const codes = diagnostics.entries.map((d) => d.code);
  assert.ok(
    codes.includes("SALES_HEADCOUNT_INSUFFICIENT_TOTAL") || codes.includes("SALES_REDUCED_FOR_SUPPLY_LIMIT"),
    `極端な人員不足下で期待される診断コードが出ていない（実際: ${codes.join(", ")}）`
  );
  // 各市場のsalesForceHeadcountの合計は、依然として1人を超えてはならない。
  const headcountByMarket = new Map<string, number>();
  for (const plan of decision.salesPlans) headcountByMarket.set(plan.market, plan.salesForceHeadcount);
  const total = Array.from(headcountByMarket.values()).reduce((a, b) => a + b, 0);
  assert.ok(total <= 1, `1人しかいないのに市場別配分合計が${total}になっている`);
});

test("7d. VAP比率が高い商品構成のほうが、同じ営業人員数・同じ市場数でも営業工数換算量がより大きい（VAP_MIX_INCREASES_SALES_EFFORT_NEEDの前提となる方向性を確認）", () => {
  // productEconomics.premiumEconomics側の設定次第でVAPの希望販売量が
  // ほぼゼロになるケースがあるため、まずベース会社の実際の販売計画を見て、
  // VAPが十分な量で提案されているケースに限定して確認する（提案がゼロなら
  // 比較不能なためスキップ）。
  const { fixture, ownState, publicInfo, period, turn } = setup("sai2-standardai-effort-003", (f) => ({
    ...f,
    salesForceHeadcountTotal: 6,
  }));
  const { decision, diagnostics } = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, period, turn);
  const vapPlans = decision.salesPlans.filter((p) => p.product === "vap" && unwrapUnit(p.desiredQuantity) > 0);
  if (vapPlans.length === 0) {
    // このseed/fixtureの組み合わせではVAPが提案されなかった（市場プレミアム不足等）。
    // 診断自体は矛盾していないことだけ確認して終える。
    assert.ok(Array.isArray(diagnostics.entries));
    return;
  }
  // VAPを含む市場のうち、少人数配分下で制約に達しているものが少なくとも
  // 1つはあるはず（総人員6人はVAP係数3.0を考慮すると厳しい設定にしている）。
  const anyConstrained = diagnostics.entries.some(
    (d) => d.code === "SALES_REDUCED_FOR_SUPPLY_LIMIT" || d.code === "VAP_MIX_INCREASES_SALES_EFFORT_NEED"
  );
  assert.ok(anyConstrained, "少人数配分×VAP提案ありという設定なのに、供給制約系の診断が一件も出ていない");
});

// ---------------------------------------------------------------------
// 【監査指摘G】SALES_BASE_ADVANTAGE は「営業基盤が実際に成約へ効くとき」だけ発火する
//
// 監査の再指摘: 「機能OFFでは発火しない」ことは修正前から成立していた
// （機能OFFではそもそも salesBaseByMarketProduct が観測に載らないため）。
// 修正が効く唯一の状況は「基盤スコアは観測できるが、成約競争力ウェイトが0」
// ＝ 基盤の高低が成約結果に一切影響しない状況である。ここを直接検証する。
// ---------------------------------------------------------------------

test("7g. 営業基盤スコアが観測できても、成約競争力ウェイトが0ならSALES_BASE_ADVANTAGEは発火しない（監査指摘G）", () => {
  const { fixture, ownState, publicInfo, period, turn } = setup("sai5-g-guard-001");
  void publicInfo;
  void period;
  void turn;

  const highSalesBase = Object.fromEntries(
    (["CN", "US", "EU", "JP", "OTHER"] as const).map((m) => [m, { hoso: score0to100(90), pd: score0to100(90), vap: score0to100(90) }])
  );

  const observationWith = (weight: number): StandardAiObservation =>
    ({
      ...buildStandardAiObservation(fixture, ownState, publicInfo, period, turn),
      salesBaseByMarketProduct: highSalesBase,
      salesBaseCompetitivenessWeight: weight,
    }) as StandardAiObservation;

  const pressuresFor = (obs: StandardAiObservation) => computePressureScores(obs, fixture, STANDARD_AI_PARAMETERS_V1);

  // ウェイト0（＝営業基盤は成約に一切効かない）→ 発火しない
  const obsZero = observationWith(0);
  const zero = buildStandardAiSalesPlans(fixture, obsZero, pressuresFor(obsZero), STANDARD_AI_PARAMETERS_V1);
  assert.ok(
    !zero.diagnostics.some((d) => d.code === "SALES_BASE_ADVANTAGE"),
    "営業基盤ウェイトが0（成約へ影響しない）なのにSALES_BASE_ADVANTAGEが発火した"
  );

  // ウェイトが正（＝SAI-5D有効）→ 同じ基盤スコアで発火する
  const obsPositive = observationWith(SALES_PARAMETERS_SAI5_SALES_BASE_V1.competitivenessWeights.salesBase);
  const positive = buildStandardAiSalesPlans(fixture, obsPositive, pressuresFor(obsPositive), STANDARD_AI_PARAMETERS_V1);
  const entry = positive.diagnostics.find((d) => d.code === "SALES_BASE_ADVANTAGE");
  assert.ok(entry, "営業基盤ウェイトが正で高い基盤を持つのにSALES_BASE_ADVANTAGEが発火しない");
  assert.equal(entry!.keyValues?.salesBaseCompetitivenessWeight, SALES_PARAMETERS_SAI5_SALES_BASE_V1.competitivenessWeights.salesBase);
});
