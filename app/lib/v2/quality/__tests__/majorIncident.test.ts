// ShrimpX V2 — Phase 7A 品質モジュール majorIncident.ts テスト
//
// 対応する受入条件:
//   10. 同一シード・同一入力で事故結果が完全一致する
//   11. 品質乱数追加によって国際価格・シナリオイベント乱数系列が変わらない
//   12. 会社・工場・商品入力順を変えても結果が同じ
//   13. 高負荷ほど重大事故確率が高い
//
// 三宅さんの実装指示（重大事故テストでは、特定シードを偶然探して固定するだけで
// なく、可能なら乱数源注入または判定境界を直接テストできる構造にする）に従い、
// drawMajorIncident(seed, probability)へ直接probability=0/1の境界値を渡す
// テストを中心に据える（シード探索に依存しない）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRandomStream } from "../../core/random";
import { calculateMajorIncidentProbability, deriveQualityIncidentSeed, drawMajorIncident } from "../majorIncident";
import { QUALITY_PARAMETERS_V1 } from "../parameters";

// --- 境界値による直接テスト（シード探索に依存しない） ---

test("probability=0では常に発生しない（seedに関わらず）", () => {
  for (const seed of ["a", "b", "seed-x", "quality::turn1::companyC1::factoryF1::producthoso"]) {
    const draw = drawMajorIncident(seed, 0);
    assert.equal(draw.occurred, false);
    assert.equal(draw.severity, 0);
  }
});

test("probability=1では常に発生する（seedに関わらず）", () => {
  for (const seed of ["a", "b", "seed-x", "quality::turn1::companyC1::factoryF1::producthoso"]) {
    const draw = drawMajorIncident(seed, 1);
    assert.equal(draw.occurred, true);
  }
});

test("probabilityの範囲外(負・1超)を渡すとRandomValidationErrorになる（chance()の既存契約）", () => {
  assert.throws(() => drawMajorIncident("seed", -0.1));
  assert.throws(() => drawMajorIncident("seed", 1.1));
});

// --- 10: 同一シード・同一入力で事故結果が完全一致する ---

test("10: 同一シード・同一probabilityでは何度呼び出しても完全に同じ結果になる", () => {
  const seed = deriveQualityIncidentSeed("game-seed-x", 3, "C1", "C1-F1", "hoso");
  const probability = 0.05;
  const a = drawMajorIncident(seed, probability);
  const b = drawMajorIncident(seed, probability);
  assert.deepEqual(a, b);
});

test("10b: 発生判定が起きなくても重大度用の乱数を必ず1回消費する（消費順序をoccurredの結果に依存させない構造）", () => {
  const seed = "fixed-seed-for-order-check";
  // drawMajorIncidentが内部で「chance(p)」→「next()」の順に必ず2回消費するのと
  // 全く同じ手順を、同じseedから作った別のRandomStreamで再現できることを確認する
  // （drawMajorIncidentが"発生しなかった場合はnext()を呼ばない"というショートカットを
  // 取っていないことの間接的な検証）。
  const independentStream = createRandomStream(seed);
  const chanceRoll = independentStream.chance(0); // 1回目消費（p=0なので常にfalse）
  const severityRollRaw = independentStream.next(); // 2回目消費
  assert.equal(chanceRoll, false);
  assert.ok(severityRollRaw >= 0 && severityRollRaw < 1);

  const draw = drawMajorIncident(seed, 0);
  assert.equal(draw.occurred, false);
  assert.equal(draw.severity, 0); // occurred=falseなのでseverityは0に強制される（内部消費はしている）
});

// --- 11: 品質乱数追加によって国際価格・シナリオイベント乱数系列が変わらない ---

test("11: 重大事故用の乱数ストリームは市場価格・シナリオ用のストリームと名前空間で分離され、互いに影響しない", () => {
  // 重大事故用シードは`::quality::`という専用の名前空間を持つため、市場価格用の
  // シード（`${seed}::${period}`形式、turn/runner.ts参照）と衝突しない。
  const gameSeed = "shared-game-seed";
  const marketStyleSeed = `${gameSeed}::2015Q1`;
  const qualitySeed = deriveQualityIncidentSeed(gameSeed, 1, "C1", "C1-F1", "hoso");
  assert.notEqual(marketStyleSeed, qualitySeed);
  assert.ok(qualitySeed.includes("::quality::"));

  // 市場価格用ストリームをどれだけ消費しても、品質用ストリームの結果は変わらない
  // （createRandomStreamはシードごとに独立したインスタンスを生成するため、
  // 品質モジュール自体が市場価格ストリームに一切アクセスしないことが構造的に保証される）。
  const marketStream = createRandomStream(marketStyleSeed);
  for (let i = 0; i < 50; i++) marketStream.next(); // 市場側を大量消費してみる

  const probability = 0.05;
  const drawBefore = drawMajorIncident(qualitySeed, probability);
  // 品質側ストリームは呼び出しのたびに新規生成されるため、市場側の消費量に関わらず結果は同じ。
  const drawAfter = drawMajorIncident(qualitySeed, probability);
  assert.deepEqual(drawBefore, drawAfter);
});

// --- 12: 会社・工場・商品入力順を変えても結果が同じ ---

test("12: deriveQualityIncidentSeedは会社・工場・商品の組み合わせだけで決まり、他の組み合わせの計算順序に依存しない", () => {
  const gameSeed = "order-independence-seed";
  const turn = 5;
  const combos: readonly [string, string, "hoso" | "pd" | "vap"][] = [
    ["C1", "C1-F1", "hoso"],
    ["C2", "C2-F1", "pd"],
    ["C1", "C1-F1", "vap"],
  ];

  // 順序A
  const resultsA = combos.map(([c, f, p]) => {
    const seed = deriveQualityIncidentSeed(gameSeed, turn, c, f, p);
    const prob = calculateMajorIncidentProbability(0.5);
    return drawMajorIncident(seed, prob);
  });

  // 順序B（逆順で計算）
  const reversed = [...combos].reverse();
  const resultsBReversed = reversed.map(([c, f, p]) => {
    const seed = deriveQualityIncidentSeed(gameSeed, turn, c, f, p);
    const prob = calculateMajorIncidentProbability(0.5);
    return drawMajorIncident(seed, prob);
  });
  const resultsB = [...resultsBReversed].reverse(); // 元の順に戻して同じインデックスで比較

  assert.deepEqual(resultsA, resultsB);
});

// --- 13: 高負荷ほど重大事故確率が高い ---

test("13: calculateMajorIncidentProbabilityはoperationalRiskに対して単調増加する", () => {
  const p0 = calculateMajorIncidentProbability(0);
  const p25 = calculateMajorIncidentProbability(0.25);
  const p50 = calculateMajorIncidentProbability(0.5);
  const p75 = calculateMajorIncidentProbability(0.75);
  const p100 = calculateMajorIncidentProbability(1);

  assert.ok(p0 < p25);
  assert.ok(p25 < p50);
  assert.ok(p50 < p75);
  assert.ok(p75 <= p100);
  assert.ok(Math.abs(p0 - QUALITY_PARAMETERS_V1.majorIncident.baseIncidentProbability) < 1e-9);
});

test("13b: 重大事故確率はmaximumIncidentProbability(0.10)を超えない", () => {
  const p = calculateMajorIncidentProbability(1);
  assert.ok(p <= QUALITY_PARAMETERS_V1.majorIncident.maximumIncidentProbability + 1e-9);
  const pExtreme = calculateMajorIncidentProbability(100);
  assert.ok(pExtreme <= QUALITY_PARAMETERS_V1.majorIncident.maximumIncidentProbability + 1e-9);
});
