// ShrimpX V2 — 営業人員の追加採用 状態管理（Phase 8G §2）の単体テスト
//
// salesForceHiring.tsの純粋関数群を、runner.ts経由の統合テストとは別に
// 単体で検証する。workforce.ts相当のテストが存在しないのに倣い、ここでは
// 「今期採用は今期使えない」「二重加算しない」「旧データは0人扱い」という
// Phase 8G §2の核心的な状態遷移規則そのものを、fixtureに依存せず確認する。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildInitialSalesForceHiringState,
  deriveNextSalesForceHiringState,
  findCompanySalesForceHeadcount,
  isSalesForceHiringStateEmpty,
  SalesForceHiringState,
} from "../salesForceHiring";
import { initializeCompanyLab } from "../runner";
import { CompanyLabConfig } from "../types";

function baseConfig(overrides: Partial<CompanyLabConfig> = {}): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed: "sales-hiring-unit-001", turns: 1, ...overrides };
}

const { fixtures } = initializeCompanyLab(baseConfig());

test("buildInitialSalesForceHiringState: 各社の初期人数がfixture.salesForceHeadcountTotalと一致する", () => {
  const state = buildInitialSalesForceHiringState(fixtures);
  assert.equal(state.companies.length, fixtures.length);
  for (const f of fixtures) {
    assert.equal(findCompanySalesForceHeadcount(state, f.companyId), f.salesForceHeadcountTotal);
  }
});

test("findCompanySalesForceHeadcount: 存在しない会社IDにはundefinedを返す（0で埋めない）", () => {
  const state = buildInitialSalesForceHiringState(fixtures);
  assert.equal(findCompanySalesForceHeadcount(state, "NOT-A-REAL-COMPANY" as never), undefined);
  assert.equal(findCompanySalesForceHeadcount(undefined, fixtures[0].companyId), undefined);
});

test("isSalesForceHiringStateEmpty: undefinedまたは会社0件はtrue、会社が1社以上ならfalse", () => {
  assert.equal(isSalesForceHiringStateEmpty(undefined), true);
  assert.equal(isSalesForceHiringStateEmpty({ companies: [] }), true);
  assert.equal(isSalesForceHiringStateEmpty(buildInitialSalesForceHiringState(fixtures)), false);
});

test("deriveNextSalesForceHiringState: 採用0人なら人数は変化しない", () => {
  const state0 = buildInitialSalesForceHiringState(fixtures);
  const state1 = deriveNextSalesForceHiringState(state0, fixtures, new Map());
  for (const f of fixtures) {
    assert.equal(findCompanySalesForceHeadcount(state1, f.companyId), f.salesForceHeadcountTotal);
  }
});

test("deriveNextSalesForceHiringState: 採用人数ぶんだけ次期人数が増える（ユーザー提示例: BAL 18人→採用6人→次期24人）", () => {
  const bal = fixtures.find((f) => f.companyId === "BAL")!;
  assert.equal(bal.salesForceHeadcountTotal, 18, "この例はBALの基準人数18人を前提にしている");

  const state0 = buildInitialSalesForceHiringState(fixtures);
  const state1 = deriveNextSalesForceHiringState(state0, fixtures, new Map([[bal.companyId, 6]]));
  assert.equal(findCompanySalesForceHeadcount(state1, bal.companyId), 24);

  // 他社は採用決定が無いので変化しない。
  for (const f of fixtures) {
    if (f.companyId === bal.companyId) continue;
    assert.equal(findCompanySalesForceHeadcount(state1, f.companyId), f.salesForceHeadcountTotal);
  }
});

test("deriveNextSalesForceHiringState: 複数四半期にわたって採用数が正しく積み上がる（二重加算しないことの確認）", () => {
  const bal = fixtures.find((f) => f.companyId === "BAL")!;
  let state: SalesForceHiringState = buildInitialSalesForceHiringState(fixtures);

  state = deriveNextSalesForceHiringState(state, fixtures, new Map([[bal.companyId, 6]]));
  assert.equal(findCompanySalesForceHeadcount(state, bal.companyId), 24);

  // 同じ意思決定オブジェクトを再度渡しても（＝再実行を模した呼び出しではなく、
  // 次の四半期の新しい意思決定として）、前期の状態を起点に加算されるだけで
  // 前期分の6人がもう一度加算されることはない。
  state = deriveNextSalesForceHiringState(state, fixtures, new Map([[bal.companyId, 3]]));
  assert.equal(findCompanySalesForceHeadcount(state, bal.companyId), 27);

  // 採用0人の四半期を挟んでも人数は保持される。
  state = deriveNextSalesForceHiringState(state, fixtures, new Map());
  assert.equal(findCompanySalesForceHeadcount(state, bal.companyId), 27);
});

test("deriveNextSalesForceHiringState: 負数・NaN・Infinityの採用人数は0として扱われる（人数を負にしない）", () => {
  const bal = fixtures.find((f) => f.companyId === "BAL")!;
  const state0 = buildInitialSalesForceHiringState(fixtures);

  for (const invalid of [-5, NaN, -Infinity]) {
    const state1 = deriveNextSalesForceHiringState(state0, fixtures, new Map([[bal.companyId, invalid]]));
    assert.equal(findCompanySalesForceHeadcount(state1, bal.companyId), bal.salesForceHeadcountTotal, `invalid=${invalid}`);
  }
});

test("deriveNextSalesForceHiringState: 小数の採用人数は四捨五入される", () => {
  const bal = fixtures.find((f) => f.companyId === "BAL")!;
  const state0 = buildInitialSalesForceHiringState(fixtures);
  const state1 = deriveNextSalesForceHiringState(state0, fixtures, new Map([[bal.companyId, 2.6]]));
  assert.equal(findCompanySalesForceHeadcount(state1, bal.companyId), bal.salesForceHeadcountTotal + 3);
});

test("deriveNextSalesForceHiringState: 前期状態に存在しない会社は、fixtureの基準人数を起点にフォールバックする（旧保存データ・空状態からの復帰）", () => {
  const emptyState: SalesForceHiringState = { companies: [] };
  const bal = fixtures.find((f) => f.companyId === "BAL")!;
  const state1 = deriveNextSalesForceHiringState(emptyState, fixtures, new Map([[bal.companyId, 4]]));
  assert.equal(findCompanySalesForceHeadcount(state1, bal.companyId), bal.salesForceHeadcountTotal + 4);
  // 採用決定が無い他社も、fixtureの基準人数へ正しくフォールバックする（0人にはならない）。
  for (const f of fixtures) {
    if (f.companyId === bal.companyId) continue;
    assert.equal(findCompanySalesForceHeadcount(state1, f.companyId), f.salesForceHeadcountTotal);
  }
});
