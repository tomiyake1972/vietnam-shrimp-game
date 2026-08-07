// ShrimpX V2 — 営業人員の追加採用・減員 状態管理テスト（forward-port。減員・退職金は続き作業）
//
// app/lib/v2/companyLab/salesForceHiring.ts の純粋関数（会社ラボ状態への
// 加算・減算・初期化ロジック）を検証する。UI・runner.ts統合側の検証は
// runner.test.ts・decisionDraft.test.tsへ分離する。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildInitialSalesForceHiringState,
  computeEffectiveSalesForceLayoffCount,
  deriveNextSalesForceHiringState,
  isSalesForceHiringStateEmpty,
} from "../salesForceHiring";
import { CompanyFixture } from "../types";

/** 検証に必要な最小限のフィールドだけを持つ最小フィクスチャ（会社ID・営業人員基準値のみ）。 */
function minimalFixture(companyId: string, salesForceHeadcountTotal: number): CompanyFixture {
  return { companyId, salesForceHeadcountTotal } as unknown as CompanyFixture;
}

/** テスト用の意思決定マップを1社ぶんだけ作る簡易ヘルパー（採用数・減員数を指定）。 */
function decisionMap(companyId: string, hireCount: number, layoffCount: number): Map<string, { hireCount: number; layoffCount: number }> {
  return new Map([[companyId, { hireCount, layoffCount }]]);
}

test("buildInitialSalesForceHiringState: fixtureのsalesForceHeadcountTotalをそのまま初期人数とする", () => {
  const fixtures = [minimalFixture("BAL", 18), minimalFixture("HUE", 22)];
  const state = buildInitialSalesForceHiringState(fixtures);
  assert.deepEqual(
    state.companies.map((c) => ({ companyId: c.companyId, headcount: c.headcount })),
    [
      { companyId: "BAL", headcount: 18 },
      { companyId: "HUE", headcount: 22 },
    ]
  );
});

test("buildInitialSalesForceHiringState: 負値・小数のsalesForceHeadcountTotalは0以上の整数へ丸める", () => {
  const fixtures = [minimalFixture("NEG", -5), minimalFixture("DEC", 17.6)];
  const state = buildInitialSalesForceHiringState(fixtures);
  assert.equal(state.companies.find((c) => c.companyId === "NEG")?.headcount, 0);
  assert.equal(state.companies.find((c) => c.companyId === "DEC")?.headcount, 18);
});

test("isSalesForceHiringStateEmpty: undefined・会社0件はtrue、会社が1件以上あればfalse", () => {
  assert.equal(isSalesForceHiringStateEmpty(undefined), true);
  assert.equal(isSalesForceHiringStateEmpty({ companies: [] }), true);
  assert.equal(isSalesForceHiringStateEmpty({ companies: [{ companyId: "BAL", headcount: 18 }] }), false);
});

// ---------------------------------------------------------------------
// 採用（既存挙動、layoffCount:0を追加して回帰確認）
// ---------------------------------------------------------------------

test("deriveNextSalesForceHiringState: 入力値0（採用・減員なし）なら人数は変わらない", () => {
  const fixtures = [minimalFixture("BAL", 18)];
  const previous = buildInitialSalesForceHiringState(fixtures);
  const next = deriveNextSalesForceHiringState(previous, fixtures, decisionMap("BAL", 0, 0));
  assert.equal(next.companies[0].headcount, 18);
});

test("deriveNextSalesForceHiringState: 正の整数の採用人数を前期末人数へ加算する（ユーザー提示例: BAL 18人→採用6人→次期24人）", () => {
  const fixtures = [minimalFixture("BAL", 18)];
  const previous = buildInitialSalesForceHiringState(fixtures);
  const next = deriveNextSalesForceHiringState(previous, fixtures, decisionMap("BAL", 6, 0));
  assert.equal(next.companies[0].headcount, 24);
});

test("deriveNextSalesForceHiringState: 負数の採用人数は0として扱う", () => {
  const fixtures = [minimalFixture("BAL", 18)];
  const previous = buildInitialSalesForceHiringState(fixtures);
  const next = deriveNextSalesForceHiringState(previous, fixtures, decisionMap("BAL", -3, 0));
  assert.equal(next.companies[0].headcount, 18);
});

test("deriveNextSalesForceHiringState: 小数の採用人数は四捨五入する", () => {
  const fixtures = [minimalFixture("BAL", 18)];
  const previous = buildInitialSalesForceHiringState(fixtures);
  const next = deriveNextSalesForceHiringState(previous, fixtures, decisionMap("BAL", 6.4, 0));
  assert.equal(next.companies[0].headcount, 24); // 18 + round(6.4) = 18 + 6 = 24

  const next2 = deriveNextSalesForceHiringState(previous, fixtures, decisionMap("BAL", 6.6, 0));
  assert.equal(next2.companies[0].headcount, 25); // 18 + round(6.6) = 18 + 7 = 25
});

test("deriveNextSalesForceHiringState: NaN・Infinityの採用人数は0として扱う（異常値でも例外を投げない）", () => {
  const fixtures = [minimalFixture("BAL", 18)];
  const previous = buildInitialSalesForceHiringState(fixtures);
  const nextNaN = deriveNextSalesForceHiringState(previous, fixtures, decisionMap("BAL", NaN, 0));
  assert.equal(nextNaN.companies[0].headcount, 18);
  const nextInfinity = deriveNextSalesForceHiringState(previous, fixtures, decisionMap("BAL", Infinity, 0));
  assert.equal(nextInfinity.companies[0].headcount, 18);
});

test("deriveNextSalesForceHiringState: 異常に大きな採用人数でも例外を投げず、そのまま加算する（上限は意図的に設けていない）", () => {
  const fixtures = [minimalFixture("BAL", 18)];
  const previous = buildInitialSalesForceHiringState(fixtures);
  const next = deriveNextSalesForceHiringState(previous, fixtures, decisionMap("BAL", 1_000_000, 0));
  assert.equal(next.companies[0].headcount, 1_000_018);
});

test("deriveNextSalesForceHiringState: 意思決定が指定されていない会社は0人採用・0人減員として扱う（Map.get()がundefinedの場合）", () => {
  const fixtures = [minimalFixture("BAL", 18)];
  const previous = buildInitialSalesForceHiringState(fixtures);
  const next = deriveNextSalesForceHiringState(previous, fixtures, new Map());
  assert.equal(next.companies[0].headcount, 18);
});

test("deriveNextSalesForceHiringState: 前期の状態に存在しない会社（旧保存データからの復元等）はfixtureの基準人数からフォールバックする", () => {
  const fixtures = [minimalFixture("BAL", 18), minimalFixture("NEW", 10)];
  const previous = buildInitialSalesForceHiringState([fixtures[0]]); // NEW社ぶんが欠けた状態を模す
  const next = deriveNextSalesForceHiringState(previous, fixtures, decisionMap("NEW", 4, 0));
  const newCompany = next.companies.find((c) => c.companyId === "NEW");
  assert.equal(newCompany?.headcount, 14, "10（fixture基準）+4（採用）=14");
});

// ---------------------------------------------------------------------
// 減員（今回新規追加）
// ---------------------------------------------------------------------

test("computeEffectiveSalesForceLayoffCount: 前期末人数以下の減員数はそのまま実効人数になる", () => {
  assert.equal(computeEffectiveSalesForceLayoffCount(18, 6), 6);
});

test("computeEffectiveSalesForceLayoffCount: 前期末人数を超える減員数は前期末人数で頭打ちする（0人未満にはできない）", () => {
  assert.equal(computeEffectiveSalesForceLayoffCount(18, 30), 18);
});

test("computeEffectiveSalesForceLayoffCount: 負数・小数・NaN・Infinityの減員数は安全に丸める", () => {
  assert.equal(computeEffectiveSalesForceLayoffCount(18, -3), 0);
  assert.equal(computeEffectiveSalesForceLayoffCount(18, 6.6), 7);
  assert.equal(computeEffectiveSalesForceLayoffCount(18, NaN), 0);
  assert.equal(computeEffectiveSalesForceLayoffCount(18, Infinity), 0, "NaN・Infinityは既存のhire側と同じ丸め方針で0として扱う（頭打ちの対象にすらならない）");
});

test("deriveNextSalesForceHiringState: 正の整数の減員人数を前期末人数から減算する（18人→減員6人→次期12人）", () => {
  const fixtures = [minimalFixture("BAL", 18)];
  const previous = buildInitialSalesForceHiringState(fixtures);
  const next = deriveNextSalesForceHiringState(previous, fixtures, decisionMap("BAL", 0, 6));
  assert.equal(next.companies[0].headcount, 12);
});

test("deriveNextSalesForceHiringState: 営業人員は0人まで減らせるが0人未満にはできない（前期末人数を超える減員は0人で頭打ち）", () => {
  const fixtures = [minimalFixture("BAL", 18)];
  const previous = buildInitialSalesForceHiringState(fixtures);
  const next = deriveNextSalesForceHiringState(previous, fixtures, decisionMap("BAL", 0, 30));
  assert.equal(next.companies[0].headcount, 0);
});

test("deriveNextSalesForceHiringState: 営業人員を0人まで正確に減らせる（境界値）", () => {
  const fixtures = [minimalFixture("BAL", 18)];
  const previous = buildInitialSalesForceHiringState(fixtures);
  const next = deriveNextSalesForceHiringState(previous, fixtures, decisionMap("BAL", 0, 18));
  assert.equal(next.companies[0].headcount, 0);
});

test("deriveNextSalesForceHiringState: 複数四半期にわたって採用・減員が正しく累積する（18→24→18→0）", () => {
  const fixtures = [minimalFixture("BAL", 18)];
  let state = buildInitialSalesForceHiringState(fixtures);
  assert.equal(state.companies[0].headcount, 18);

  state = deriveNextSalesForceHiringState(state, fixtures, decisionMap("BAL", 6, 0));
  assert.equal(state.companies[0].headcount, 24, "1四半期目: 採用6人 18+6=24");

  state = deriveNextSalesForceHiringState(state, fixtures, decisionMap("BAL", 0, 6));
  assert.equal(state.companies[0].headcount, 18, "2四半期目: 減員6人 24-6=18");

  state = deriveNextSalesForceHiringState(state, fixtures, decisionMap("BAL", 0, 100));
  assert.equal(state.companies[0].headcount, 0, "3四半期目: 過大な減員は0人で頭打ち");
});
