// ShrimpX V2 — Phase 6C: Commercial Commitment / 過剰提出修正 / 営業能力SSoT テスト
//
// 【固定すること】
//   Ambition ≠ Submitted ≠ Contracts ≠ Production という**分離そのもの**と、
//   §4「旧ロジックの再現」＝ 生産が提出量へ1:1で追随していた事実。
//   ゲームバランスの数値そのものは固定しない（校正中のため）。

import test from "node:test";
import assert from "node:assert/strict";

import {
  COMMERCIAL_COMMITMENT_PARAMETERS_V1,
  CommercialCommitmentInput,
  computeCommercialCommitment,
} from "../commercialCommitment";
import { observeContractConversion } from "../../standardAi/commercialHistory";
import { deriveNextCommercialHistoryState, commercialHistoryForCompany } from "../../commercialHistoryState";
import { buildCurrentPeriodDeliveryDemand } from "../../standardAi/diagnosis/currentPeriodDeliveryDemand";
import { computeBasicCurrentPeriodProductionRequirement } from "../../standardAi/diagnosis/productionRequirement";
import { StandardAiObservation, ProductAmount } from "../../standardAi/types";
import { period } from "../../../core/period";
import { hosoEqTons, usdPerHosoEqKg } from "../../../core/units";
import { SalesContract } from "../../../sales/types";
import { CompanyDecisionInput } from "../../types";

const P = COMMERCIAL_COMMITMENT_PARAMETERS_V1;

function amount(hoso: number, pd = 0, vap = 0): ProductAmount {
  return { hoso, pd, vap };
}

function baseInput(overrides: Partial<CommercialCommitmentInput> = {}): CommercialCommitmentInput {
  return {
    ambition: null,
    capacityAnchorTons: 16_000,
    attainableProfitableTons: 200_000,
    observedConversionRatio: null,
    observedQuarters: 0,
    salesCapacityTons: null,
    backlogTons: 0,
    finishedGoodsTons: 0,
    ...overrides,
  };
}

/** 生産必要量の計算に必要な最小限の観測（他フィールドは参照されない）。 */
function observationWith(backlog: ProductAmount): StandardAiObservation {
  return { outstandingContractByProduct: backlog } as unknown as StandardAiObservation;
}

// ---------------------------------------------------------------------
// CC-1 / CC-2: Ambition ≠ Submitted ≠ Contracts を許容する
// ---------------------------------------------------------------------

test("CC-1: Commercial Ambition と提出量は別の量でよい（志のまま提出しない）", () => {
  const held = computeCommercialCommitment(baseInput({ observedConversionRatio: 0.6, observedQuarters: 4 }));
  assert.notEqual(held.submissionTargetTons, held.caps.ambitionTons, "志と提出目標が同一値に固定されていない");
  // 成約率が低いと分かっていても、志の1.25倍を超えて提出しない。
  assert.ok(held.submissionTargetTons <= held.caps.ambitionTons * P.maximumStretchOverAmbition + 1e-6);
  // かつ、志より少なくは取りに行かない（成長を止めない）。
  assert.ok(held.submissionTargetTons >= held.caps.ambitionTons - 1e-6);
});

test("CC-2: 提出 > 成約 は正常な状態として許容する（転換率100%を目標にしない）", () => {
  // 目標帯そのものが100%未満であることを固定する（#05 §8）。
  assert.ok(P.targetConversionCeiling < 1, "目標転換率の上限が100%未満であること");
  assert.ok(P.targetConversionFloor >= 0.7 && P.targetConversionFloor < P.targetConversionCeiling);
  // 履歴が無い状態でも、提出＝成約の前提は置かない。
  const fresh = computeCommercialCommitment(baseInput());
  assert.ok(fresh.expectedConversionRatio < 1, "履歴が無くても成約率100%を前提にしない");
});

// ---------------------------------------------------------------------
// CC-3: 転換率が下がると次期の提出が調整される
// ---------------------------------------------------------------------

test("CC-3: 直近の成約率が下がるほど、期待成約率が下がり提出の逆算が働く", () => {
  const ratios = [0.95, 0.8, 0.6, 0.4];
  let previousExpected = Infinity;
  for (const ratio of ratios) {
    const state = computeCommercialCommitment(baseInput({ observedConversionRatio: ratio, observedQuarters: 4 }));
    assert.ok(state.expectedConversionRatio < previousExpected, `成約率 ${ratio} で期待成約率が下がること`);
    assert.ok(state.expectedConversionRatio >= P.minimumUsableConversion - 1e-9, "下限で打ち切る");
    previousExpected = state.expectedConversionRatio;
  }
});

test("CC-3b: 成約率が極端に低くても提出量は発散しない（上乗せ上限で頭打ち）", () => {
  const state = computeCommercialCommitment(baseInput({ observedConversionRatio: 0.01, observedQuarters: 4 }));
  assert.equal(state.limiter, "STRETCH_LIMIT");
  assert.ok(state.stretchOverAmbition <= P.maximumStretchOverAmbition + 1e-9);
});

test("CC-3c: 成約率が低い状態が続くと過剰提出リスクとして検出される", () => {
  assert.equal(computeCommercialCommitment(baseInput({ observedConversionRatio: 0.59, observedQuarters: 4 })).overSubmissionRisk, true);
  assert.equal(computeCommercialCommitment(baseInput({ observedConversionRatio: 0.95, observedQuarters: 4 })).overSubmissionRisk, false);
  assert.equal(computeCommercialCommitment(baseInput()).overSubmissionRisk, false, "履歴が無ければリスク判定もしない");
});

// ---------------------------------------------------------------------
// CC-4 / CC-5: 在庫の扱い（生産は抑えるが、販売は抑えない）
// ---------------------------------------------------------------------

test("CC-4: 完成品在庫が多いと生産必要量は減る（在庫は生産を抑える理由である）", () => {
  const demand = amount(10_000);
  const inventoryTarget = amount(2_000);
  const low = computeBasicCurrentPeriodProductionRequirement(demand, inventoryTarget, amount(1_000));
  const high = computeBasicCurrentPeriodProductionRequirement(demand, inventoryTarget, amount(8_000));
  assert.ok(high.hoso < low.hoso, "在庫が多いほど生産必要量が小さい");
  assert.equal(high.hoso, 10_000 + 2_000 - 8_000);
  // 在庫が需要＋目標を上回っても負の生産にはならない。
  assert.equal(computeBasicCurrentPeriodProductionRequirement(demand, inventoryTarget, amount(50_000)).hoso, 0);
});

test("CC-5: 完成品在庫が多くても、市場へ取りに行く量（提出目標）は減らさない", () => {
  const withoutStock = computeCommercialCommitment(baseInput({ finishedGoodsTons: 0 }));
  const withStock = computeCommercialCommitment(baseInput({ finishedGoodsTons: 50_000 }));
  assert.equal(withStock.submissionTargetTons, withoutStock.submissionTargetTons, "在庫は提出量を下げる理由にしない（#05 §12）");
});

// ---------------------------------------------------------------------
// CC-6 / CC-7: 生産は提出量へ盲目的に追随しない・確定受注残は優先
// ---------------------------------------------------------------------

test("CC-6【§4 旧ロジックの再現】期待成約率1.0では、生産の需要側が提出量へ1:1で追随する", () => {
  // Phase 6B の Case C で実測された状態を数値で固定する:
  //   提出 24,420t / 成約 14,425t / 転換率59% / 完成品在庫 約15,000t
  const submitted = amount(24_420);
  const backlog = amount(0);

  // --- 旧ロジック（期待成約率を掛けない＝暗黙の1.0） ---
  const legacy = buildCurrentPeriodDeliveryDemand("BAL", observationWith(backlog), submitted);
  assert.equal(legacy.deliveryDemand.byProduct.hoso, 24_420, "旧ロジックは提出量をそのまま当期納品需要にしていた");

  // --- 新ロジック（実測された転換率59%を織り込む） ---
  const fixed = buildCurrentPeriodDeliveryDemand("BAL", observationWith(backlog), submitted, 0.59);
  assert.ok(Math.abs(fixed.deliveryDemand.byProduct.hoso - 24_420 * 0.59) < 1e-6);

  // 差分がそのまま「作ったのに売れない量」であり、在庫3倍・利益−61%の原因だった。
  const overProduction = legacy.deliveryDemand.byProduct.hoso - fixed.deliveryDemand.byProduct.hoso;
  assert.ok(overProduction > 9_000, `1四半期あたり約1万トンの過剰生産が生じていた（実測 ${Math.round(overProduction)}t）`);
});

test("CC-7: 確定した受注残には期待成約率を掛けない（確率で割り引く対象ではない）", () => {
  const result = buildCurrentPeriodDeliveryDemand("BAL", observationWith(amount(5_000)), amount(10_000), 0.6);
  assert.ok(Math.abs(result.deliveryDemand.byProduct.hoso - (5_000 + 10_000 * 0.6)) < 1e-6);
  // 受注残だけの会社は、期待成約率がいくつでも生産需要が変わらない。
  const onlyBacklog06 = buildCurrentPeriodDeliveryDemand("BAL", observationWith(amount(5_000)), amount(0), 0.6);
  const onlyBacklog10 = buildCurrentPeriodDeliveryDemand("BAL", observationWith(amount(5_000)), amount(0), 1);
  assert.equal(onlyBacklog06.deliveryDemand.byProduct.hoso, onlyBacklog10.deliveryDemand.byProduct.hoso);
});

test("CC-7b: 生産の需要側は、確定需要中心か期待成約分を含むかを理由コードで区別する", () => {
  const backlogHeavy = buildCurrentPeriodDeliveryDemand("BAL", observationWith(amount(9_000)), amount(1_000), 0.6);
  assert.ok(backlogHeavy.diagnostics.some((d) => d.code === "PRODUCTION_LIMITED_TO_CONFIRMED_DEMAND"));
  const speculative = buildCurrentPeriodDeliveryDemand("BAL", observationWith(amount(1_000)), amount(9_000), 0.9);
  assert.ok(speculative.diagnostics.some((d) => d.code === "PRODUCTION_INCLUDES_EXPECTED_CONVERSION"));
});

test("CC-7c: 生産に使う期待成約率と、提出量に使う期待成約率は別の値である", () => {
  // 提出側は目標帯（75〜90%）へ引き寄せるが、生産側は観測値そのものを使う。
  const state = computeCommercialCommitment(baseInput({ observedConversionRatio: 1, observedQuarters: 4 }));
  assert.equal(state.productionExpectedConversionRatio, 1, "実際にほぼ全量成約している会社の生産を過小に見積もらない");
  assert.ok(state.expectedConversionRatio < 1, "提出量の逆算には目標帯を使う");
  // 観測が無ければ生産側は 1.0（＝従来と同一挙動）。
  assert.equal(computeCommercialCommitment(baseInput()).productionExpectedConversionRatio, 1);
  // 観測が極端に低くても生産を止めない（下限で打ち切る）。
  const collapsed = computeCommercialCommitment(baseInput({ observedConversionRatio: 0.05, observedQuarters: 4 }));
  assert.equal(collapsed.productionExpectedConversionRatio, P.productionExpectedConversionFloor);
});

// ---------------------------------------------------------------------
// CC-8: 上限要因の識別（営業能力・市場機会）
// ---------------------------------------------------------------------

test("CC-8: 営業能力・市場機会は提出量の上限要因として働き、どれが効いたか記録される", () => {
  const capacityBound = computeCommercialCommitment(baseInput({ salesCapacityTons: 5_000 }));
  assert.equal(capacityBound.limiter, "SALES_CAPACITY");
  assert.equal(capacityBound.submissionTargetTons, 5_000);

  const opportunityBound = computeCommercialCommitment(baseInput({ attainableProfitableTons: 8_000 }));
  assert.equal(opportunityBound.limiter, "MARKET_OPPORTUNITY");
  assert.equal(opportunityBound.submissionTargetTons, 8_000 * P.realisticShareOfOpportunity);

  // 営業能力は「必ず成約する量」ではなく上限要因の一つである（#05 §9）。
  const unconstrained = computeCommercialCommitment(baseInput({ salesCapacityTons: 10_000_000 }));
  assert.notEqual(unconstrained.limiter, "SALES_CAPACITY");
});

// ---------------------------------------------------------------------
// CC-9: 転換率の観測（自社の履歴 × 自社の契約台帳）
// ---------------------------------------------------------------------

function contract(companyId: string, contractedPeriod: ReturnType<typeof period>, tons: number): SalesContract {
  return {
    contractId: `${companyId}-${contractedPeriod}-${tons}`,
    companyId,
    market: "CN",
    product: "hoso",
    contractedPeriod,
    dueDate: contractedPeriod,
    originalQuantity: hosoEqTons(tons),
    outstandingQuantity: hosoEqTons(0),
    unitPrice: usdPerHosoEqKg(10),
    status: "fulfilled",
  };
}

function decision(companyId: string, tons: number): CompanyDecisionInput {
  return {
    companyId,
    salesPlans: [
      {
        companyId,
        market: "CN",
        product: "hoso",
        desiredQuantity: hosoEqTons(tons),
        priceAdjustmentUsdPerHosoEqKg: 0,
        salesForceHeadcount: 20,
      },
    ],
  } as unknown as CompanyDecisionInput;
}

test("CC-9: 直近4四半期の「提出 → 成約」転換率を、自社の履歴と契約台帳から観測する", () => {
  let state = deriveNextCommercialHistoryState(undefined, [decision("BAL", 20_000)], period(2026, 1), 1);
  state = deriveNextCommercialHistoryState(state, [decision("BAL", 20_000)], period(2026, 2), 2);
  const contracts = [contract("BAL", period(2026, 1), 14_000), contract("BAL", period(2026, 2), 14_000)];

  const observed = observeContractConversion({ records: commercialHistoryForCompany(state, "BAL") }, contracts, 3);
  assert.equal(observed.observedQuarters, 2);
  assert.equal(observed.submittedTons, 40_000);
  assert.equal(observed.contractedTons, 28_000);
  assert.ok(Math.abs((observed.conversionRatio ?? 0) - 0.7) < 1e-9);
  assert.ok(Math.abs((observed.conversionRatioByMarket.get("CN") ?? 0) - 0.7) < 1e-9);
});

test("CC-9b: 履歴が無ければ転換率は null（1.0 と読み替えない）", () => {
  const observed = observeContractConversion({ records: [] }, [], 1);
  assert.equal(observed.conversionRatio, null);
  assert.equal(observed.observedQuarters, 0);
});

test("CC-9c: 当期以降の記録は転換率の観測に使わない（未来を見ない）", () => {
  const state = deriveNextCommercialHistoryState(undefined, [decision("BAL", 20_000)], period(2026, 1), 1);
  const observed = observeContractConversion({ records: commercialHistoryForCompany(state, "BAL") }, [], 1);
  assert.equal(observed.observedQuarters, 0, "turn1 の判断時点で turn1 の記録は使えない");
});

// ---------------------------------------------------------------------
// CC-10: 履歴 carry state の性質（決定論・冪等・移行互換）
// ---------------------------------------------------------------------

test("CC-10: 履歴 carry state は決定論的・冪等であり、保持件数で打ち切られる", () => {
  let state = deriveNextCommercialHistoryState(undefined, [decision("BAL", 100)], period(2026, 1), 1);
  // 同一ターンの再処理では二重追記しない（冪等）。
  state = deriveNextCommercialHistoryState(state, [decision("BAL", 100)], period(2026, 1), 1);
  assert.equal(commercialHistoryForCompany(state, "BAL").length, 1);

  for (let turn = 2; turn <= 12; turn++) {
    const q = ((turn - 1) % 4) + 1;
    state = deriveNextCommercialHistoryState(state, [decision("BAL", 100)], period(2026 + Math.floor((turn - 1) / 4), q), turn);
  }
  assert.equal(commercialHistoryForCompany(state, "BAL").length, 6, "保持件数（6四半期）で打ち切る");
  assert.equal(commercialHistoryForCompany(state, "BAL")[5].turn, 12, "最新が末尾");

  // 会社の並び順は入力順に依存しない。
  const a = deriveNextCommercialHistoryState(undefined, [decision("VAP", 1), decision("BAL", 2)], period(2026, 1), 1);
  const b = deriveNextCommercialHistoryState(undefined, [decision("BAL", 2), decision("VAP", 1)], period(2026, 1), 1);
  assert.deepEqual(
    a.companies.map((c) => c.companyId),
    b.companies.map((c) => c.companyId)
  );
});

test("CC-10b: 履歴を持たない旧ラボ状態でも壊れない（学習しないだけ）", () => {
  assert.deepEqual(commercialHistoryForCompany(undefined, "BAL"), []);
  const commitment = computeCommercialCommitment(
    baseInput({ observedConversionRatio: null, observedQuarters: 0, capacityAnchorTons: 12_000 })
  );
  assert.ok(commitment.submissionTargetTons > 0);
  assert.equal(commitment.productionExpectedConversionRatio, 1, "旧ラボでは従来どおり提出量ベースで生産する");
});

// ---------------------------------------------------------------------
// CC-11: 決定論
// ---------------------------------------------------------------------

test("CC-11: 同一入力に対して常に同一の Commercial Commitment を返す", () => {
  const input = baseInput({ observedConversionRatio: 0.62, observedQuarters: 4, salesCapacityTons: 30_000, finishedGoodsTons: 4_000 });
  const first = computeCommercialCommitment(input);
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(computeCommercialCommitment(input), first);
  }
});
