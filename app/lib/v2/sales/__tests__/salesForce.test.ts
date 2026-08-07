import { test } from "node:test";
import assert from "node:assert/strict";
import { salesCoverageScore, processingCapacity } from "../salesForce";
import { SALES_PARAMETERS_V1 } from "../parameters";
import { SalesValidationError } from "../types";
import { unwrapUnit } from "../../core/units";

test("headcount=0でも既存顧客ぶんのカバレッジ（baseline）が残る", () => {
  const coverage = salesCoverageScore(0, SALES_PARAMETERS_V1);
  assert.equal(coverage, SALES_PARAMETERS_V1.salesForce.baselineCoverageAtZeroHeadcount);
  assert.ok(coverage > 0);
});

test("headcount=0でも既存顧客ぶんの処理能力（baseline）が残る", () => {
  const capacity = unwrapUnit(processingCapacity(0, SALES_PARAMETERS_V1));
  assert.equal(capacity, SALES_PARAMETERS_V1.salesForce.baselineCapacityTons);
  assert.ok(capacity > 0);
});

test("カバレッジはheadcount増加とともに単調増加する", () => {
  const values = [0, 2, 5, 10, 20, 50].map((h) => salesCoverageScore(h, SALES_PARAMETERS_V1));
  for (let i = 1; i < values.length; i++) {
    assert.ok(values[i] > values[i - 1], `coverage(${[0, 2, 5, 10, 20, 50][i]}) should exceed coverage(${[0, 2, 5, 10, 20, 50][i - 1]})`);
  }
});

test("処理能力はheadcount増加とともに単調増加する", () => {
  const values = [0, 2, 5, 10, 20, 50].map((h) => unwrapUnit(processingCapacity(h, SALES_PARAMETERS_V1)));
  for (let i = 1; i < values.length; i++) {
    assert.ok(values[i] > values[i - 1]);
  }
});

test("カバレッジ・処理能力とも1を超えない／無制限に増えない（漸近的に上限へ収束する）", () => {
  const largeCoverage = salesCoverageScore(100000, SALES_PARAMETERS_V1);
  assert.ok(largeCoverage < 1);
  assert.ok(largeCoverage > 0.99);

  const largeCapacity = unwrapUnit(processingCapacity(100000, SALES_PARAMETERS_V1));
  const asymptote = SALES_PARAMETERS_V1.salesForce.baselineCapacityTons + SALES_PARAMETERS_V1.salesForce.capacityMaxIncrementTons;
  assert.ok(largeCapacity < asymptote);
  assert.ok(largeCapacity > asymptote * 0.99);
});

test("headcountの効果は逓減する（限界増分が減少していく）", () => {
  const step = 5;
  const points = [0, step, step * 2, step * 3, step * 4];
  const coverageDeltas = points.slice(1).map((h, i) => salesCoverageScore(h, SALES_PARAMETERS_V1) - salesCoverageScore(points[i], SALES_PARAMETERS_V1));
  for (let i = 1; i < coverageDeltas.length; i++) {
    assert.ok(coverageDeltas[i] < coverageDeltas[i - 1], "marginal coverage gain should shrink as headcount grows");
  }

  const capacityDeltas = points
    .slice(1)
    .map((h, i) => unwrapUnit(processingCapacity(h, SALES_PARAMETERS_V1)) - unwrapUnit(processingCapacity(points[i], SALES_PARAMETERS_V1)));
  for (let i = 1; i < capacityDeltas.length; i++) {
    assert.ok(capacityDeltas[i] < capacityDeltas[i - 1], "marginal capacity gain should shrink as headcount grows");
  }
});

// ---------------------------------------------------------------------
// 【Test15事前校正】営業増員が実運用の人数帯で報われることの回帰テスト
//
// Test14で「第1ターンに営業を20人増員しても成約増が約2,000tしかない」現象が
// 観測された。原因は capacitySaturationHeadcount=10 により、会社が実際に運用する
// 人数帯（1市場あたり2〜20人）が既に飽和域へ入っており、増員しても処理能力が
// ほとんど伸びなかったこと（限界生産性が h=18 で 61t/人＝h=2 の 18% まで低下）。
//
// 以下2本は「逓減はするが、実運用域で限界生産性が枯れきってはいけない」という
// 校正上の不変条件を固定する。旧パラメータ（k=10, M=4800）へ戻すと両方とも落ちる。
// 逓減性そのもの・漸近上限の有限性は上の既存テストが引き続き担保しており、
// ここでその2点を緩めているわけではない。
// ---------------------------------------------------------------------

test("【Test15校正】実運用の人数帯（1市場2〜20人）では限界処理能力が枯れきらない", () => {
  const marginalAt = (h: number) =>
    unwrapUnit(processingCapacity(h + 1, SALES_PARAMETERS_V1)) - unwrapUnit(processingCapacity(h, SALES_PARAMETERS_V1));

  const atLow = marginalAt(2);
  const atHigh = marginalAt(18);

  // 逓減はする（既存の設計意図を維持）。
  assert.ok(atHigh < atLow, "限界処理能力は逓減するはず");
  // ただし、運用域の端（18人）でも入口（2人）の半分は残っていること。
  // 旧パラメータ（k=10）ではこの比が約0.18まで落ち、増員が事実上無意味だった。
  assert.ok(
    atHigh / atLow >= 0.5,
    `運用人数帯で限界処理能力が枯れすぎている（h=18の限界 ${atHigh.toFixed(1)}t/人 は h=2 の ${atLow.toFixed(1)}t/人 の ${((atHigh / atLow) * 100).toFixed(0)}%）`
  );
});

test("【Test15校正】全社18人→38人（5市場へ配分）で営業処理能力の合計が1.7倍以上になる", () => {
  // Standard AIが baseline シナリオで実際に行う市場別配分（需要加重）。
  const before = [9, 3, 2, 2, 2]; // JP / CN / US / EU / OTHER = 合計18人
  const after = [19, 5, 5, 5, 4]; // 同上 = 合計38人
  assert.equal(
    before.reduce((s, h) => s + h, 0) + 20,
    after.reduce((s, h) => s + h, 0),
    "テストの前提（+20人）が崩れている"
  );

  const total = (split: readonly number[]) => split.reduce((s, h) => s + unwrapUnit(processingCapacity(h, SALES_PARAMETERS_V1)), 0);
  const ratio = total(after) / total(before);

  // 旧パラメータ（k=10, M=4800）ではこの比が1.52しかなく、+20人（人員+111%）に対して
  // 成約増が約2,000tにとどまっていた。
  assert.ok(
    ratio >= 1.7,
    `18人→38人で営業処理能力が十分に増えていない（${total(before).toFixed(0)}t → ${total(after).toFixed(0)}t、${ratio.toFixed(3)}倍）`
  );
});

test("負のheadcountや非整数はSalesValidationErrorを投げる", () => {
  assert.throws(() => salesCoverageScore(-1, SALES_PARAMETERS_V1), SalesValidationError);
  assert.throws(() => salesCoverageScore(2.5, SALES_PARAMETERS_V1), SalesValidationError);
  assert.throws(() => processingCapacity(-1, SALES_PARAMETERS_V1), SalesValidationError);
  assert.throws(() => processingCapacity(2.5, SALES_PARAMETERS_V1), SalesValidationError);
});
