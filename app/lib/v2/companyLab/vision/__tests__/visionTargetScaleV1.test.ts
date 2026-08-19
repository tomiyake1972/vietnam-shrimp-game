// ShrimpX V2 — SAI-VISION-1: 正式Vision値（Q32 target scale）の固定
//
// 夜間 sensitivity（docs/v2/SAI_VISION1_SENSITIVITY.md）の Case A1 を正式採用したもの。
// **変更したのは BAL / JPQ / CONSV の targetScaleTonsPerQuarterAtQ32 と
// referenceGrowthPath だけ**であり、MASS / VAP・growthAmbition・
// willingnessToBuildFactories・financialRiskTolerance・strategicPosture・
// desiredProductEvolution・emphasisProducts はいずれも変更していない。

import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultVisionDocumentFor } from "../defaults";
import { CompanyVision } from "../types";

function vision(companyId: string): CompanyVision {
  const doc = defaultVisionDocumentFor(companyId);
  assert.ok(doc, `${companyId} の Vision が見つからない`);
  return doc!.visions[0];
}

test("VIS1-1: 正式採用したQ32 target scale（BAL / JPQ / CONSV）", () => {
  assert.equal(vision("BAL").targetScaleTonsPerQuarterAtQ32, 60000);
  assert.equal(vision("JPQ").targetScaleTonsPerQuarterAtQ32, 50000);
  assert.equal(vision("CONSV").targetScaleTonsPerQuarterAtQ32, 45000);
});

test("VIS1-2: MASS / VAP のQ32 target scaleは変更していない", () => {
  assert.equal(vision("MASS").targetScaleTonsPerQuarterAtQ32, 80000);
  assert.equal(vision("VAP").targetScaleTonsPerQuarterAtQ32, 17000);
});

test("VIS1-3: growthAmbition は全社現行維持", () => {
  assert.equal(vision("MASS").growthAmbition, "HIGH");
  assert.equal(vision("BAL").growthAmbition, "HIGH");
  assert.equal(vision("JPQ").growthAmbition, "HIGH");
  assert.equal(vision("CONSV").growthAmbition, "MEDIUM");
  assert.equal(vision("VAP").growthAmbition, "LOW");
});

test("VIS1-4: willingnessToBuildFactories は全社現行維持", () => {
  assert.equal(vision("MASS").willingnessToBuildFactories, "HIGH");
  assert.equal(vision("BAL").willingnessToBuildFactories, "HIGH");
  assert.equal(vision("JPQ").willingnessToBuildFactories, "MEDIUM");
  assert.equal(vision("CONSV").willingnessToBuildFactories, "MEDIUM");
  assert.equal(vision("VAP").willingnessToBuildFactories, "LOW");
});

test("VIS1-5: strategicPosture / financialRiskTolerance / desiredProductEvolution は全社現行維持", () => {
  const expected: Record<string, [string, string, string]> = {
    MASS: ["AGGRESSIVE_EARLY_CAPACITY", "HIGH", "HOSO_SCALE"],
    BAL: ["AGGRESSIVE_EARLY_CAPACITY", "MEDIUM", "INTEGRATED"],
    JPQ: ["DEMAND_CONFIRMED", "MEDIUM", "PD_SCALE"],
    CONSV: ["DEMAND_CONFIRMED", "LOW", "INTEGRATED"],
    VAP: ["VALUE_FIRST", "MEDIUM", "VAP_VALUE"],
  };
  for (const [companyId, [posture, risk, evolution]] of Object.entries(expected)) {
    const v = vision(companyId);
    assert.equal(v.strategicPosture, posture, `${companyId} strategicPosture`);
    assert.equal(v.financialRiskTolerance, risk, `${companyId} financialRiskTolerance`);
    assert.equal(v.desiredProductEvolution, evolution, `${companyId} desiredProductEvolution`);
  }
});

test("VIS1-6: referenceGrowthPath は開始規模を保ちQ32目標まで単調増加（Case A1と同一の線形軌道）", () => {
  const expected: Record<string, readonly number[]> = {
    BAL: [16000, 25935, 37290, 48645, 60000],
    JPQ: [16000, 23677, 32452, 41226, 50000],
    CONSV: [15000, 21774, 29516, 37258, 45000],
  };
  for (const [companyId, points] of Object.entries(expected)) {
    const path = vision(companyId).referenceGrowthPath;
    assert.deepEqual(
      path.map((w) => w.scaleTonsPerQuarter),
      points,
      `${companyId} referenceGrowthPath`
    );
    assert.deepEqual(
      path.map((w) => w.turn),
      [1, 8, 16, 24, 32],
      `${companyId} waypoint turns`
    );
    // 開始規模は変更していない（＝会社の出発点は動かしていない）。
    assert.equal(path[0].scaleTonsPerQuarter, points[0]);
    for (let i = 1; i < path.length; i++) {
      assert.ok(path[i].scaleTonsPerQuarter > path[i - 1].scaleTonsPerQuarter, `${companyId} は単調増加であるべき`);
    }
    assert.equal(path[path.length - 1].scaleTonsPerQuarter, vision(companyId).targetScaleTonsPerQuarterAtQ32);
  }
});

test("VIS1-7: MASS / VAP の referenceGrowthPath も変更していない", () => {
  assert.deepEqual(
    vision("MASS").referenceGrowthPath.map((w) => w.scaleTonsPerQuarter),
    [18000, 22000, 32000, 52000, 80000]
  );
  assert.deepEqual(
    vision("VAP").referenceGrowthPath.map((w) => w.scaleTonsPerQuarter),
    [14000, 14500, 15500, 16300, 17000]
  );
});

test("VIS1-8: deterministic（同じ会社IDを何度引いても同一）", () => {
  for (const companyId of ["MASS", "BAL", "JPQ", "CONSV", "VAP"]) {
    assert.deepEqual(vision(companyId), vision(companyId));
  }
});
