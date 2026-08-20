// ShrimpX V2 — SAI-COMMIT-1: Deliverable Commercial Commitment の不変条件テスト
//
// 【本テストの位置づけ】SAI-COMMIT-1 の監査で「現行の Deliverability cap は妥当に
// 機能しており、production code の変更は不要（Stop Condition #7 該当）」と判定した。
// そのため本ファイルは新機能のテストではなく、**現行挙動を不変条件として固定する
// characterization test** である。以後の Phase が cap の意味を静かに壊さないための
// 回帰網であり、実装は 1 行も変更していない。
//
// 実装指示 §18 の 20 項目に対応する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDeliverableCommitment, DeliverableCommitmentInput } from "../decision/deliverableCommitment";
import { computeBindingProductionCapacityTons } from "../bindingCapacity";
import { COMMERCIAL_COMMITMENT_PARAMETERS_V1 } from "../../vision/commercialCommitment";
import { STANDARD_AI_PARAMETERS_V1 } from "../parameters";
import { ProductAmount } from "../types";

const ZERO: ProductAmount = { hoso: 0, pd: 0, vap: 0 };
const amount = (hoso: number, pd = 0, vap = 0): ProductAmount => ({ hoso, pd, vap });

/** 健全な会社の基準ケース（受注残なし・原料十分・能力十分）。 */
function baseInput(overrides: Partial<DeliverableCommitmentInput> = {}): DeliverableCommitmentInput {
  return {
    commitmentBeforeDeliverabilityTons: 10_000,
    expectedConversionRatio: 0.9,
    finishedGoodsByProduct: ZERO,
    bindingProductionCapacityTons: 10_000,
    nearTermBindingProductionCapacityTons: 10_000,
    fundableRawMaterialTons: 10_000,
    overdueBacklogByProduct: ZERO,
    healthyForwardBacklogByProduct: ZERO,
    rawMaterialLimitedByFunding: false,
    deliveryLeadTimeQuarters: 1,
    minimumMarketPresenceRatio: STANDARD_AI_PARAMETERS_V1.minDomesticPurchaseRatioOfBase,
    ...overrides,
  };
}

// --- §18-1 / §18-2: canonical backlog ledger semantics と overdue / healthy forward 分離 ---

test("COMMIT-1: 受注残は overdue と healthy forward の合算であり、両者は別々に保持される", () => {
  const r = computeDeliverableCommitment(
    baseInput({ overdueBacklogByProduct: amount(1_200), healthyForwardBacklogByProduct: amount(3_000, 500) })
  );
  assert.equal(r.overdueBacklogTons, 1_200);
  assert.equal(r.healthyForwardBacklogTons, 3_500);
  assert.equal(r.existingBacklogTons, 4_700, "existingBacklog は ledger 2 区分の合計そのもの");
});

test("COMMIT-2: overdue は allowance を削る形で効き、healthy forward は allowance 内なら罰されない", () => {
  // 納品能力 10,000・リードタイム1Q → baseAllowance 10,000
  const healthyOnly = computeDeliverableCommitment(baseInput({ healthyForwardBacklogByProduct: amount(9_000) }));
  assert.equal(healthyOnly.normalBacklogAllowanceTons, 10_000);
  assert.equal(healthyOnly.excessBacklogTons, 0, "リードタイム1Q分以内の healthy forward は excess にならない");

  const withOverdue = computeDeliverableCommitment(
    baseInput({ overdueBacklogByProduct: amount(2_000), healthyForwardBacklogByProduct: amount(9_000) })
  );
  assert.equal(withOverdue.normalBacklogAllowanceTons, 8_000, "overdue の分だけ許容水準が縮む");
  assert.equal(withOverdue.excessBacklogTons, 3_000, "11,000 − 8,000");
});

// --- §18-3 / §18-4 / §18-5: current / nearTerm physical capacity と freezingPackaging ---

test("COMMIT-3: current deliverable capacity は 完成品在庫 + min(当期能力, 資金手当て可能原料)", () => {
  const r = computeDeliverableCommitment(
    baseInput({ finishedGoodsByProduct: amount(1_500), bindingProductionCapacityTons: 8_000, fundableRawMaterialTons: 6_000 })
  );
  assert.equal(r.deliverableCapacityCurrentTons, 1_500 + 6_000, "原料が能力より少なければ原料が効く");
});

test("COMMIT-4: nearTerm deliverable capacity は納期時点の物理能力そのもの", () => {
  const r = computeDeliverableCommitment(baseInput({ nearTermBindingProductionCapacityTons: 14_000 }));
  assert.equal(r.deliverableCapacityNearTermTons, 14_000);
});

test("COMMIT-5: 物理能力SSoTは freezingPackaging を含む（CAP-1 canonical を再実装しない）", () => {
  // 冷凍・包装が最小プールのとき、それが binding capacity になる。
  const binding = computeBindingProductionCapacityTons(amount(40_000, 20_000, 10_000), 63_000, 59_850);
  assert.equal(binding, 59_850, "ライン計70,000・共通63,000より冷凍包装59,850が小さいので後者が効く");

  const r = computeDeliverableCommitment(baseInput({ nearTermBindingProductionCapacityTons: binding }));
  assert.equal(r.deliverableCapacityNearTermTons, 59_850, "cap の入力にも冷凍包装込みの値がそのまま入る");
});

// --- §18-6 / §18-7: raw funding は current にのみ効き、nearTerm へ二重適用しない ---

test("COMMIT-6: 当期の資金制約は current deliverability を確かに縮める", () => {
  const rich = computeDeliverableCommitment(baseInput({ fundableRawMaterialTons: 10_000 }));
  const poor = computeDeliverableCommitment(baseInput({ fundableRawMaterialTons: 2_000 }));
  assert.equal(rich.deliverableCapacityCurrentTons, 10_000);
  assert.equal(poor.deliverableCapacityCurrentTons, 2_000, "資金手当てできる原料が少なければ当期納品能力が落ちる");
});

test("COMMIT-7: 当期の資金制約を nearTerm へ二重適用しない（健全な会社を資金繰りの谷で潰さない）", () => {
  const poor = computeDeliverableCommitment(baseInput({ fundableRawMaterialTons: 2_000 }));
  assert.equal(
    poor.deliverableCapacityNearTermTons,
    10_000,
    "翌四半期の納品能力は当期の現金では打ち切らない（翌期は売掛回収等が入るため）"
  );
  // 資金不足は carryOverBacklog 経由という正しい経路でのみ headroom へ効く。
  const poorWithBacklog = computeDeliverableCommitment(
    baseInput({ fundableRawMaterialTons: 2_000, healthyForwardBacklogByProduct: amount(9_000) })
  );
  assert.equal(poorWithBacklog.carryOverBacklogTons, 7_000, "9,000 − current 2,000");
});

// --- §18-8 / §18-9: future capacity の扱い ---

test("COMMIT-8/9: nearTerm 能力は呼び出し側が渡す確定値のみで、本関数は将来能力を発明しない", () => {
  // 同一入力なら出力も同一（未承認CAPEX・Vision・将来借入を内部で足し込む経路が無いことの担保）。
  const input = baseInput({ nearTermBindingProductionCapacityTons: 12_000 });
  const a = computeDeliverableCommitment(input);
  const b = computeDeliverableCommitment({ ...input });
  assert.equal(a.deliverableCapacityNearTermTons, 12_000);
  assert.deepEqual(a, b);
  // current と nearTerm は別入力であり、片方を増やしてももう片方は動かない（二重加算しない）。
  const onlyNearTermUp = computeDeliverableCommitment({ ...input, nearTermBindingProductionCapacityTons: 30_000 });
  assert.equal(onlyNearTermUp.deliverableCapacityCurrentTons, a.deliverableCapacityCurrentTons);
});

// --- §18-10 / §18-11 / §18-12: backlog horizon と抑制の強さ ---

test("COMMIT-10: backlog horizon は会社規模で正規化される（固定kt閾値でない）", () => {
  const small = computeDeliverableCommitment(
    baseInput({ bindingProductionCapacityTons: 10_000, nearTermBindingProductionCapacityTons: 10_000, fundableRawMaterialTons: 10_000, healthyForwardBacklogByProduct: amount(5_000) })
  );
  const large = computeDeliverableCommitment(
    baseInput({ bindingProductionCapacityTons: 100_000, nearTermBindingProductionCapacityTons: 100_000, fundableRawMaterialTons: 100_000, healthyForwardBacklogByProduct: amount(50_000) })
  );
  assert.equal(small.backlogDeliveryHorizonQuarters, 0.5);
  assert.equal(large.backlogDeliveryHorizonQuarters, 0.5, "10kt企業の5ktと100kt企業の50ktは同じ危険度");
});

test("COMMIT-11: healthy forward だけなら cap は発動しない（過剰抑制しない）", () => {
  const r = computeDeliverableCommitment(baseInput({ healthyForwardBacklogByProduct: amount(9_000) }));
  assert.equal(r.excessBacklogTons, 0);
  assert.equal(r.applied, false, "リードタイム内の受注残だけでは新規受注を抑えない");
  assert.equal(r.finalSubmissionTargetTons, 10_000, "commitment がそのまま通る");
});

test("COMMIT-12: overdue が増えるほど commitment の抑制が単調に強まる", () => {
  const cap = (overdue: number) =>
    computeDeliverableCommitment(
      baseInput({ commitmentBeforeDeliverabilityTons: 20_000, overdueBacklogByProduct: amount(overdue), healthyForwardBacklogByProduct: amount(9_000) })
    ).finalSubmissionTargetTons;
  const c0 = cap(0), c1 = cap(2_000), c2 = cap(5_000);
  assert.ok(c0 > c1, `overdue 0 → 2,000 で抑制が強まるはず: ${c0} vs ${c1}`);
  assert.ok(c1 > c2, `overdue 2,000 → 5,000 でさらに強まるはず: ${c1} vs ${c2}`);
});

// --- §18-13: conversion の二重適用禁止 ---

test("COMMIT-13: 期待転換率は 1 回だけ使われる（提出量ベースへ戻すための除算のみ）", () => {
  const r = computeDeliverableCommitment(
    baseInput({ commitmentBeforeDeliverabilityTons: 999_999, expectedConversionRatio: 0.5, healthyForwardBacklogByProduct: amount(15_000) })
  );
  assert.equal(
    r.deliverabilityCapTons,
    r.remainingDeliverableHeadroomTons / 0.5,
    "cap = 納品余力（成約量）÷ 転換率。掛けたり二度割ったりしない"
  );
});

// --- §18-14 / §18-15 / §18-16: market presence floor と gate ---

test("COMMIT-14: 受注残が能力を大きく超えても市場から完全退出しない（最低提出量が残る）", () => {
  const r = computeDeliverableCommitment(
    baseInput({ commitmentBeforeDeliverabilityTons: 20_000, overdueBacklogByProduct: amount(50_000) })
  );
  const floor = 10_000 * STANDARD_AI_PARAMETERS_V1.minDomesticPurchaseRatioOfBase;
  assert.equal(r.remainingDeliverableHeadroomTons, floor, "納品余力は最低提示比率まで下がるが 0 にはならない");
  assert.ok(r.finalSubmissionTargetTons > 0, "提出量が 0 にならない");
});

test("COMMIT-15: 資金起因の原料不足は LIQUIDITY、そうでなければ RAW_MATERIAL へ routing される", () => {
  const liq = computeDeliverableCommitment(
    baseInput({ commitmentBeforeDeliverabilityTons: 99_999, fundableRawMaterialTons: 1_000, rawMaterialLimitedByFunding: true, nearTermBindingProductionCapacityTons: 3_000 })
  );
  assert.equal(liq.bindingDeliverabilityConstraint, "LIQUIDITY");
  const raw = computeDeliverableCommitment(
    baseInput({ commitmentBeforeDeliverabilityTons: 99_999, fundableRawMaterialTons: 1_000, rawMaterialLimitedByFunding: false, nearTermBindingProductionCapacityTons: 3_000 })
  );
  assert.equal(raw.bindingDeliverabilityConstraint, "RAW_MATERIAL");
});

test("COMMIT-16: excess backlog があるときは BACKLOG が最優先で routing される", () => {
  const r = computeDeliverableCommitment(
    baseInput({ commitmentBeforeDeliverabilityTons: 99_999, overdueBacklogByProduct: amount(6_000), healthyForwardBacklogByProduct: amount(9_000) })
  );
  assert.ok(r.excessBacklogTons > 0);
  assert.equal(r.bindingDeliverabilityConstraint, "BACKLOG");
});

// --- §18-17 / §18-18 / §18-19: 汎用性と決定論性 ---

test("COMMIT-17/18: 会社ID・シナリオIDに依存する分岐が実装に存在しない", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../decision/deliverableCommitment.ts", import.meta.url), "utf8");
  for (const id of ["MASS", "BAL", "JPQ", "CONSV", "VAP", "dynamic-scenario", "baseline-v"]) {
    assert.ok(!src.includes(`"${id}"`), `会社ID/シナリオIDのhardcodeが混入している: ${id}`);
  }
});

test("COMMIT-19: 同一入力に対して決定論的（副作用なし）", () => {
  const input = baseInput({ overdueBacklogByProduct: amount(1_234), healthyForwardBacklogByProduct: amount(5_678) });
  const a = computeDeliverableCommitment(input);
  const b = computeDeliverableCommitment(input);
  const c = computeDeliverableCommitment(input);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
});

// --- §18-20: CAP-1 physical capacity regression ---

test("COMMIT-20: CAP-1 の物理能力 SSoT は 3 プールの最小値であり続ける", () => {
  assert.equal(computeBindingProductionCapacityTons(amount(10_000, 5_000, 2_000), 30_000, 30_000), 17_000, "ライン計が最小");
  assert.equal(computeBindingProductionCapacityTons(amount(10_000, 5_000, 2_000), 12_000, 30_000), 12_000, "共通前処理が最小");
  assert.equal(computeBindingProductionCapacityTons(amount(10_000, 5_000, 2_000), 30_000, 9_000), 9_000, "冷凍包装が最小");
});

// --- 監査で確定した「cap は成長を殺す高さではない」ことの固定 ---

test("COMMIT-21: 受注残が無い会社では cap が発動せず、commitment がそのまま提出量になる", () => {
  const r = computeDeliverableCommitment(baseInput({ commitmentBeforeDeliverabilityTons: 9_000 }));
  assert.equal(r.applied, false);
  assert.equal(r.finalSubmissionTargetTons, 9_000);
  assert.equal(r.bindingDeliverabilityConstraint, "NONE");
  assert.equal(r.incrementalSubmissionReductionTons, 0);
});

test("COMMIT-22: 最低提示比率は既存 parameter を流用しており、新しいゲーム定数を作っていない", () => {
  assert.equal(
    COMMERCIAL_COMMITMENT_PARAMETERS_V1.minimumMarketPresenceRatioOfDeliverable,
    STANDARD_AI_PARAMETERS_V1.minDomesticPurchaseRatioOfBase,
    "market presence floor は minDomesticPurchaseRatioOfBase の流用であり続ける"
  );
});
