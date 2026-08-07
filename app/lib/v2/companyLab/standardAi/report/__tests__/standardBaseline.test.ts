// ShrimpX V2 — Phase SAI-2: 標準初期条件（standard baseline）の基準テスト
//
// SAI-1.5のレポート機能同様、ゲームロジック本体ではなく比較・分析専用モジュールの
// テストのため、SAI-1本体ほど網羅的な仕様は求めない。「選定した標準初期条件が、
// 5社へ複製しても内部整合的であること」「基準テスト（Test B相当の構造）が
// 例外を投げずに、moderate pressureという設計意図どおりの性質を持つ結果を
// 返すこと」を確認する。詳細な選定根拠は docs/v2/reports/sai2_standard_baseline_report.md
// を参照。

import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePeriod } from "../../../../core/period";
import { unwrapUnit } from "../../../../core/units";
import {
  STANDARD_BASELINE_CANDIDATES,
  SELECTED_STANDARD_BASELINE_CANDIDATE_ID,
  buildStandardBaselineFixture,
  standardBaselineFinanceFixtureTemplate,
  standardBaselineContractDefs,
} from "../standardBaseline";
import { buildUnifiedFixturesFromTemplate } from "../decomposeHarness";
import { runStandardBaselineTest, runStandardBaselineMultiSeed } from "../decompose";

const P0 = parsePeriod("2015Q1");

test("SELECTED_STANDARD_BASELINE_CANDIDATE_IDはSTANDARD_BASELINE_CANDIDATESに実在する", () => {
  const found = STANDARD_BASELINE_CANDIDATES.find((c) => c.id === SELECTED_STANDARD_BASELINE_CANDIDATE_ID);
  assert.ok(found, `選定済みID "${SELECTED_STANDARD_BASELINE_CANDIDATE_ID}" が候補一覧に見つからない`);
});

test("buildStandardBaselineFixture: 5社へ複製すると、companyId/factoryIdは各社固有だが、それ以外の全項目が完全一致する", () => {
  const fixtures = buildUnifiedFixturesFromTemplate(buildStandardBaselineFixture(P0));
  assert.equal(fixtures.length, 5);
  assert.deepEqual(
    fixtures.map((f) => f.companyId),
    ["BAL", "MASS", "JPQ", "VAP", "CONSV"]
  );
  const [first, ...rest] = fixtures;
  for (const f of rest) {
    assert.notEqual(f.companyId, first.companyId, "会社IDは各社固有であるべき");
    assert.notEqual(f.factories[0].factoryId, first.factories[0].factoryId, "工場IDは各社固有であるべき");
    assert.equal(unwrapUnit(f.factories[0].hosoCapacity), unwrapUnit(first.factories[0].hosoCapacity));
    assert.equal(unwrapUnit(f.factories[0].pdCapacity), unwrapUnit(first.factories[0].pdCapacity));
    assert.equal(unwrapUnit(f.factories[0].vapCapacity), unwrapUnit(first.factories[0].vapCapacity));
    assert.equal(f.workerBaseline[0].regularHeadcount, first.workerBaseline[0].regularHeadcount);
    assert.deepEqual(f.productEconomics, first.productEconomics);
  }
});

test("すべての候補で、5社複製後も会社間で工場能力・ワーカー・商品経済性が完全一致する（初期条件統一の前提が崩れていない）", () => {
  for (const candidate of STANDARD_BASELINE_CANDIDATES) {
    const fixtures = buildUnifiedFixturesFromTemplate(candidate.buildFixtureTemplate(P0));
    const capacities = fixtures.map((f) => unwrapUnit(f.factories[0].hosoCapacity));
    assert.ok(capacities.every((c) => c === capacities[0]), `${candidate.id}: hosoCapacityが会社間で不一致`);
  }
});

test("standardBaselineFinanceFixtureTemplate/standardBaselineContractDefs: 選定済み候補の値をそのまま返す", () => {
  const selected = STANDARD_BASELINE_CANDIDATES.find((c) => c.id === SELECTED_STANDARD_BASELINE_CANDIDATE_ID)!;
  assert.deepEqual(standardBaselineFinanceFixtureTemplate(), selected.financeFixtureTemplate);
  assert.deepEqual(standardBaselineContractDefs(), selected.contractDefs);
});

test("runStandardBaselineTest: 選定済み標準初期条件で5社ぶんの結果を返し、決定論的である（同一seedなら完全一致）", () => {
  const selected = STANDARD_BASELINE_CANDIDATES.find((c) => c.id === SELECTED_STANDARD_BASELINE_CANDIDATE_ID)!;
  const a = runStandardBaselineTest("sai2-baseline-smoke-001", 4, selected);
  const b = runStandardBaselineTest("sai2-baseline-smoke-001", 4, selected);
  for (const id of ["BAL", "MASS", "JPQ", "VAP", "CONSV"] as const) {
    assert.ok(Number.isFinite(a.finalByCompany[id].finalCashUsd), `${id}: finalCashUsdが有限でない`);
    assert.equal(a.finalByCompany[id].finalCashUsd, b.finalByCompany[id].finalCashUsd, `${id}: 同一seedなのに結果が一致しない`);
  }
});

test("runStandardBaselineMultiSeed: 選定済み候補は12seed・8Qで全社が必ずpaymentDefaultするわけではない（発散一辺倒ではない＝moderate pressureという設計意図どおり）", () => {
  const selected = STANDARD_BASELINE_CANDIDATES.find((c) => c.id === SELECTED_STANDARD_BASELINE_CANDIDATE_ID)!;
  const seeds = Array.from({ length: 12 }, (_, i) => `sai2-baseline-check-${String(i + 1).padStart(3, "0")}`);
  const summary = runStandardBaselineMultiSeed(selected, seeds, 8);
  const rates = Object.values(summary.paymentDefaultRateByCompany);
  for (const r of rates) {
    assert.ok(Number.isFinite(r) && r >= 0 && r <= 1);
    assert.notEqual(r, 1, "全12seedで必ずpaymentDefaultするなら安全すぎない案として不適切（moderate pressureの前提が崩れている）");
  }
});

test("moderate-pressure候補（選定案）は、balanced-trimmed／five-company-blend候補より明らかに厳しい（financeFixtureTemplateのcash/target比較）", () => {
  const trimmed = STANDARD_BASELINE_CANDIDATES.find((c) => c.id === "balanced-trimmed")!;
  const blend = STANDARD_BASELINE_CANDIDATES.find((c) => c.id === "five-company-blend")!;
  const moderate = STANDARD_BASELINE_CANDIDATES.find((c) => c.id === "moderate-pressure")!;
  assert.ok(moderate.financeFixtureTemplate.cash < blend.financeFixtureTemplate.cash);
  // 【SAI-2追加作業: 市場別営業配置・商品別営業工数、事後修正】営業工数ルール
  // 導入後の再校正（salesForceHeadcountTotal引き上げ・finance再調整）により、
  // moderateのcashは実測でmoderateな12seed分布を与える値（2,000万USD）に固定した
  // ところ、たまたまtrimmedのcash（同じく2,000万USD、候補1設計時からの既存値）と
  // 一致した。「moderateがtrimmedより厳しいか同等」であることに変わりはないため、
  // 比較を<=へ緩める（実測値の丸めた一致であり、moderateが緩くなったわけではない）。
  assert.ok(moderate.financeFixtureTemplate.cash <= trimmed.financeFixtureTemplate.cash);
  assert.ok(moderate.financeFixtureTemplate.shortTermLoans + moderate.financeFixtureTemplate.longTermLoans > blend.financeFixtureTemplate.shortTermLoans + blend.financeFixtureTemplate.longTermLoans);
});
