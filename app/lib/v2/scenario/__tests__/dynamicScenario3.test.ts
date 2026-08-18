// ShrimpX V2 — Dynamic Scenario 3 の定義テスト
//
// DS3 が「DS1/DS2 を壊さずに」新設されていること、および指示で要求された
// 局面（T24–28 down-cycle / T25 Ecuador / T29 India / News / Vision override）が
// 定義として実在することを固定する。数値の妥当性（実走結果）は
// scripts/dynamicScenario3Benchmark.ts の測定で別途確認する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { DYNAMIC_SCENARIO_1 } from "../definitions/dynamicScenario1";
import { DYNAMIC_SCENARIO_2 } from "../definitions/dynamicScenario2";
import { DYNAMIC_SCENARIO_3 } from "../definitions/dynamicScenario3";
import { DS1_EVENT_IDS } from "../definitions/dynamicScenario1News";
import { DS3_EVENT_IDS } from "../definitions/dynamicScenario3News";
import {
  DS3_ECUADOR_DISASTER,
  DS3_INDIA_DISASTER,
  DS3_PRICE_DOWN_CYCLE,
  DS3_VISION_GROWTH_OVERRIDES,
} from "../definitions/dynamicScenario3Parameters";
import { ALL_SCENARIO_DEFINITIONS } from "../definitions";
import { assertValidScenarioDefinition } from "../validation";
import { defaultVisionDocumentFor } from "../../companyLab/vision/defaults";
import { resolveCompanyVision } from "../../companyLab/vision/overrides";

const COMPANIES = ["BAL", "MASS", "JPQ", "VAP", "CONSV"] as const;
const eventOf = (id: string) => DYNAMIC_SCENARIO_3.scheduledEvents.find((e) => e.eventId === id);

test("DS3-1: scenarioId / 表示名 / 期間が指示どおりで、シナリオ定義の検証を通る", () => {
  assert.equal(DYNAMIC_SCENARIO_3.scenarioId, "dynamic-scenario-3-v0.1");
  assert.ok(DYNAMIC_SCENARIO_3.title.includes("Dynamic Scenario 3"));
  assert.ok(DYNAMIC_SCENARIO_3.title.includes("Growth, Margin Squeeze & Supply Shocks"));
  assert.ok(DYNAMIC_SCENARIO_3.title.includes("成長・マージン圧迫・供給ショック"));
  assert.equal(DYNAMIC_SCENARIO_3.durationTurns, 32);
  assertValidScenarioDefinition(DYNAMIC_SCENARIO_3);
});

test("DS3-2: Management Console のシナリオ選択肢に DS3 が含まれ、DS1/DS2 も残っている", () => {
  const ids = ALL_SCENARIO_DEFINITIONS.map((d) => d.scenarioId);
  assert.ok(ids.includes("dynamic-scenario-3-v0.1"), "DS3が選択肢に無い");
  assert.ok(ids.includes("dynamic-scenario-1-v0.1"), "DS1が消えている");
  assert.ok(ids.includes("dynamic-scenario-2-v0.1"), "DS2が消えている");
});

test("DS3-3: DS1 / DS2 は DS3 の新機構をひとつも宣言していない（既存シナリオ不変の担保）", () => {
  for (const definition of [DYNAMIC_SCENARIO_1, DYNAMIC_SCENARIO_2]) {
    assert.equal(definition.visionGrowthOverrides, undefined, `${definition.scenarioId} visionGrowthOverrides`);
    assert.equal(definition.salesOrganizationCapacityOverride, undefined, `${definition.scenarioId} salesOrganizationCapacityOverride`);
  }
});

test("DS3-4: §15 のとおり DS3 自身も営業能力上限の上書きは宣言しない", () => {
  assert.equal(DYNAMIC_SCENARIO_3.salesOrganizationCapacityOverride, undefined);
});

test("DS3-5: T24〜28 の販売価格 down-cycle イベントが存在し、T23 は効果ゼロ（Newsのみの先読み点）", () => {
  const e = eventOf(DS3_EVENT_IDS.priceDownCycle);
  assert.ok(e, "down-cycle イベントが無い");
  // startTurn=23 / rampUpTurns=1 → T23 の発現強度は数学的に 0。
  assert.equal(e!.startTurn, 23);
  assert.equal(e!.rampUpTurns, 1);
  // 数量需要（ECONOMIC_INDEX）は下げない＝「Volume は高いまま Margin が痩せる」。
  const variables = e!.effects.map((x) => x.variable);
  assert.ok(variables.includes("REGIONAL_DEMAND"), "価格形成側の需要を緩めていない");
  assert.ok(variables.includes("UTILIZATION_RATE"), "供給側を増やしていない");
  assert.ok(!variables.includes("ECONOMIC_INDEX"), "数量需要を落としてはいけない（暴落にしない）");
  // §13: T32 まで解除しない（景気が戻って全員大儲けにしない）。
  assert.equal(DS3_PRICE_DOWN_CYCLE.recoveryTurns, 0);
  assert.ok(DS3_PRICE_DOWN_CYCLE.startTurn + DS3_PRICE_DOWN_CYCLE.rampUpTurns + DS3_PRICE_DOWN_CYCLE.durationTurns - 1 >= 32);
});

test("DS3-6: T25 Ecuador 自然災害が存在し、一時的（回復あり）で恒久変化ではない", () => {
  const e = eventOf(DS3_EVENT_IDS.ecuadorDisaster);
  assert.ok(e, "Ecuador 災害イベントが無い");
  assert.deepEqual(e!.targetCountries, ["EC"]);
  assert.equal(e!.eventType, "ABNORMAL_WEATHER");
  // startTurn=24 / rampUp=1 → 満額は T25 から。
  assert.equal(e!.startTurn, 24);
  assert.equal(e!.rampUpTurns, 1);
  assert.ok(e!.recoveryTurns > 0, "恒久上昇にしてはいけない（数ターンで正常化する）");
  const cost = e!.effects.find((x) => x.variable === "AQUACULTURE_COST");
  assert.ok(cost, "原料コストへの効果が無い");
  assert.equal(cost!.magnitude, DS3_ECUADOR_DISASTER.aquacultureCostMultiplier);
  assert.ok(cost!.magnitude >= 1.25 && cost!.magnitude <= 1.45, "感度レンジ +25〜+45% の内側であること");
});

test("DS3-7: T29 India 自然災害が存在し、Ecuador とは影響経路と回復速度が異なる", () => {
  const e = eventOf(DS3_EVENT_IDS.indiaDisaster);
  const ec = eventOf(DS3_EVENT_IDS.ecuadorDisaster);
  assert.ok(e && ec);
  assert.deepEqual(e!.targetCountries, ["IN"]);
  assert.equal(e!.startTurn, 28);
  assert.equal(e!.rampUpTurns, 1); // 満額は T29 から
  assert.ok(e!.recoveryTurns > 0, "一時的なショックであること");
  // 経路の差：India だけが輸出適格率（検査・通関）に効く。
  assert.ok(e!.effects.some((x) => x.variable === "EXPORT_ELIGIBILITY_RATE"), "Indiaは輸出適格率へ効くべき");
  assert.ok(!ec!.effects.some((x) => x.variable === "EXPORT_ELIGIBILITY_RATE"), "Ecuadorは輸出適格率へは効かせない");
  // 回復速度の差：India の方が速い。
  assert.ok(e!.recoveryTurns < ec!.recoveryTurns, "Indiaの回復はEcuadorより速いこと");
  assert.equal(e!.effects.find((x) => x.variable === "AQUACULTURE_COST")!.magnitude, DS3_INDIA_DISASTER.aquacultureCostMultiplier);
});

test("DS3-8: DS1 の India 通関障害・Ecuador 疾病・Vietnam 疾病は DS3 では採用していない（二重被災の回避）", () => {
  for (const removed of [DS1_EVENT_IDS.indiaDisruption, DS1_EVENT_IDS.ecuadorDiseaseY8, DS1_EVENT_IDS.vietnamDiseaseY7]) {
    assert.equal(eventOf(removed), undefined, `${removed} は DS3 では採用しない`);
  }
  // DS1/DS2 側には依然として存在する（定義を変更していないことの確認）。
  for (const definition of [DYNAMIC_SCENARIO_1, DYNAMIC_SCENARIO_2]) {
    for (const kept of [DS1_EVENT_IDS.indiaDisruption, DS1_EVENT_IDS.ecuadorDiseaseY8, DS1_EVENT_IDS.vietnamDiseaseY7]) {
      assert.ok(definition.scheduledEvents.some((e) => e.eventId === kept), `${definition.scenarioId} から ${kept} が消えている`);
    }
  }
});

test("DS3-9: 早期局面（T7原料ショック・消費ブーム・T17需要ショック・T22再開ブーム）は DS1 から引き継いでいる", () => {
  for (const kept of [
    DS1_EVENT_IDS.vnRawShock,
    DS1_EVENT_IDS.consumerBoom,
    DS1_EVENT_IDS.ecuadorExpansion,
    DS1_EVENT_IDS.demandShock,
    DS1_EVENT_IDS.othersRetailGrowth,
    DS1_EVENT_IDS.reopeningBoom,
  ]) {
    assert.ok(eventOf(kept), `${kept} が DS3 に無い`);
  }
});

test("DS3-10: News が §11 の最低要件（T23〜T32）を満たし、未来の答えを予告していない", () => {
  const releases = DYNAMIC_SCENARIO_3.informationReleases ?? [];
  for (const turn of [23, 24, 25, 26, 27, 28, 29, 30, 31, 32]) {
    assert.ok(releases.some((r) => r.availableFromTurn === turn), `T${turn} の News が無い`);
  }
  // 「次Turnで◯%上がります」のような予告をしない（数値予告の禁止）。
  for (const r of releases) {
    const text = `${r.headlineTemplate} ${r.body ?? ""}`;
    assert.ok(!/次Turn|来期は必ず|%上昇します|%下落します/.test(text), `未来を予告する記事がある: ${r.informationId}`);
  }
  // 参照先の無い relatedEventId が無いこと（validation でも弾かれるが明示的に固定する）。
  const eventIds = new Set(DYNAMIC_SCENARIO_3.scheduledEvents.map((e) => e.eventId));
  for (const r of releases) {
    if (r.relatedEventId !== undefined) assert.ok(eventIds.has(r.relatedEventId), `dangling relatedEventId: ${r.informationId}`);
  }
});

test("DS3-11: Vision 成長上書きは会社別に異なり、固定トン数目標ではなく倍率で与えられている", () => {
  // 全社を同じ上限へ引き上げていない（§4）。
  const multipliers = COMPANIES.map((c) => DS3_VISION_GROWTH_OVERRIDES[c]?.scaleMultiplier);
  assert.equal(new Set(multipliers).size, COMPANIES.length, "会社ごとに異なる倍率であること");
  for (const c of COMPANIES) {
    const o = DS3_VISION_GROWTH_OVERRIDES[c];
    assert.ok(o, `${c} の上書きが無い`);
    assert.ok((o.scaleMultiplier ?? 1) > 1, `${c} は成長余地を広げる向きであること`);
  }

  // 上書き後の Q32 参考規模が、指示§2 の会社別レンジと整合していること。
  // （販売量そのものを固定するのではなく、Vision の上限をレンジに合わせて置く）
  const q32 = (c: string) => {
    const base = defaultVisionDocumentFor(c)!.visions[0].targetScaleTonsPerQuarterAtQ32;
    return base * (DS3_VISION_GROWTH_OVERRIDES[c]!.scaleMultiplier ?? 1);
  };
  const bands: Readonly<Record<string, readonly [number, number]>> = {
    MASS: [90000, 100000],
    BAL: [55000, 65000],
    JPQ: [45000, 55000],
    VAP: [45000, 55000],
    CONSV: [45000, 50000],
  };
  for (const c of COMPANIES) {
    const [lo, hi] = bands[c];
    assert.ok(q32(c) >= lo && q32(c) <= hi, `${c} のQ32参考規模 ${Math.round(q32(c))} が §2 レンジ ${lo}〜${hi} の外`);
  }
  // MASS が最大規模の会社であり続ける（volume growth の性格を保つ）。
  const ordered = [...COMPANIES].sort((a, b) => q32(b) - q32(a));
  assert.equal(ordered[0], "MASS", "MASS が最大規模の会社であり続けること");
});

test("DS3-12: resolveCompanyVision が DS3 の上書きを適用し、未指定なら既定 Vision のまま（DS1/DS2 不変）", () => {
  for (const companyId of COMPANIES) {
    const base = resolveCompanyVision(companyId, 32);
    const withOverride = resolveCompanyVision(companyId, 32, undefined, DYNAMIC_SCENARIO_3.visionGrowthOverrides);
    assert.ok(base && withOverride);
    const multiplier = DS3_VISION_GROWTH_OVERRIDES[companyId]!.scaleMultiplier!;
    assert.ok(
      Math.abs(withOverride!.targetScaleTonsPerQuarterAtQ32 - base!.targetScaleTonsPerQuarterAtQ32 * multiplier) < 1e-6,
      `${companyId} のQ32目標が倍率どおりでない`
    );
    // 軌道の形（waypoint 数）は保たれる＝固定トン数へ置き換えていない。
    assert.equal(withOverride!.referenceGrowthPath.length, base!.referenceGrowthPath.length);
    // 上書きを渡さなければ既定のまま。
    assert.equal(resolveCompanyVision(companyId, 32)!.targetScaleTonsPerQuarterAtQ32, base!.targetScaleTonsPerQuarterAtQ32);
  }
});

test("DS3-13: DS3 は DS2 の初期財務条件（MASS 借入 40M）を引き継いでいる", () => {
  assert.deepEqual(DYNAMIC_SCENARIO_3.initialCompanyDebtUsd, DYNAMIC_SCENARIO_2.initialCompanyDebtUsd);
});
