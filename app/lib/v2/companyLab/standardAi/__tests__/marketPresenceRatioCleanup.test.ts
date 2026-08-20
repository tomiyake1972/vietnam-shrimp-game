// ShrimpX V2 — SAI-VISION-1 tech debt cleanup 受入: minimumMarketPresenceRatio の参照先移動
//
// 3B-3では market presence floor に、調達の最低確保比
// StandardAiParameters.minDomesticPurchaseRatioOfBase を domain を跨いで流用していた。
// sales側の意味を持つ CommercialCommitmentParameters.minimumMarketPresenceRatioOfDeliverable へ
// 参照先だけを移す。**値は完全に同一（0.2）で、経済挙動は1ビットも変えない。**

import { test } from "node:test";
import assert from "node:assert/strict";
import { COMMERCIAL_COMMITMENT_PARAMETERS_V1 } from "../../vision/commercialCommitment";
import { STANDARD_AI_PARAMETERS_V1 } from "../parameters";
import { computeDeliverableCommitment, DeliverableCommitmentInput } from "../decision/deliverableCommitment";
import { ProductAmount } from "../types";
import { advanceSimulationTurn, createSimulationSession } from "../../simulation/engine";
import { buildCompanyOwnState, buildPublicMarketInfo } from "../../runner";
import { generateStandardAiDecisionWithDiagnostics } from "../policy";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function amount(hoso = 0, pd = 0, vap = 0): ProductAmount {
  return { hoso, pd, vap };
}

test("MPR-1: 新parameterの値は流用元と完全に同一（0.2）", () => {
  assert.equal(
    COMMERCIAL_COMMITMENT_PARAMETERS_V1.minimumMarketPresenceRatioOfDeliverable,
    STANDARD_AI_PARAMETERS_V1.minDomesticPurchaseRatioOfBase,
    "参照先移動で値が変わってはいけない"
  );
  assert.equal(COMMERCIAL_COMMITMENT_PARAMETERS_V1.minimumMarketPresenceRatioOfDeliverable, 0.2);
});

test("MPR-2: 新旧どちらの値を渡してもDeliverable Commitmentの結果がbit-identical", () => {
  const base: DeliverableCommitmentInput = {
    commitmentBeforeDeliverabilityTons: 20000,
    expectedConversionRatio: 0.8,
    finishedGoodsByProduct: amount(0, 0, 0),
    bindingProductionCapacityTons: 8000,
    nearTermBindingProductionCapacityTons: 8000,
    fundableRawMaterialTons: 60000,
    overdueBacklogByProduct: amount(30000),
    healthyForwardBacklogByProduct: amount(30000),
    rawMaterialLimitedByFunding: false,
    deliveryLeadTimeQuarters: 1,
    minimumMarketPresenceRatio: STANDARD_AI_PARAMETERS_V1.minDomesticPurchaseRatioOfBase,
  };
  const withOld = computeDeliverableCommitment(base);
  const withNew = computeDeliverableCommitment({
    ...base,
    minimumMarketPresenceRatio: COMMERCIAL_COMMITMENT_PARAMETERS_V1.minimumMarketPresenceRatioOfDeliverable,
  });
  assert.deepEqual(withNew, withOld);
  // floorが実際に効いている局面であることも確認する（無意味な一致ではない）。
  assert.ok(withNew.applied);
  assert.ok(withNew.remainingDeliverableHeadroomTons > 0);
});

test("MPR-3: policy.ts は新parameterを参照している（旧参照が残っていない）", () => {
  const src = readFileSync(join(__dirname, "../policy.ts"), "utf8");
  assert.ok(
    src.includes("minimumMarketPresenceRatio: COMMERCIAL_COMMITMENT_PARAMETERS_V1.minimumMarketPresenceRatioOfDeliverable"),
    "policy.ts が新parameterを参照していない"
  );
  assert.equal(
    src.includes("minimumMarketPresenceRatio: params.minDomesticPurchaseRatioOfBase"),
    false,
    "調達parameterへの旧参照が残っている"
  );
});

test("MPR-4: 実runでDeliverable Commitmentの数値が変化しない（baseline 12Turn）", () => {
  const AT = "2026-01-01T00:00:00.000Z";
  let session = createSimulationSession({
    simulationRunId: "mpr-bit-identical",
    scenarioId: "baseline",
    seed: "management-console-32q",
    requestedTurns: 32,
    startedAt: AT,
  });
  for (let i = 0; i < 12; i++) {
    for (const fixture of session.fixtures) {
      const ownState = buildCompanyOwnState(session.state, fixture);
      const publicInfo = buildPublicMarketInfo(session.state);
      const result = generateStandardAiDecisionWithDiagnostics(
        fixture,
        ownState,
        publicInfo,
        session.state.currentPeriod,
        session.state.scenarioState.currentTurn
      );
      const dc = result.diagnostics?.deliverableCommitment;
      assert.ok(dc, "Deliverable Commitment が評価されていない");
      // 同じ入力を新旧どちらの定数で評価しても一致することを、実runの値で確認する。
      const recomputedWithOld = computeDeliverableCommitment({
        commitmentBeforeDeliverabilityTons: dc.commitmentBeforeDeliverabilityTons,
        expectedConversionRatio:
          dc.remainingDeliverableHeadroomTons > 0 ? dc.remainingDeliverableHeadroomTons / dc.deliverabilityCapTons : 1,
        finishedGoodsByProduct: amount(0, 0, 0),
        bindingProductionCapacityTons: dc.deliverableCapacityCurrentTons,
        nearTermBindingProductionCapacityTons: dc.deliverableCapacityNearTermTons,
        fundableRawMaterialTons: Number.MAX_SAFE_INTEGER,
        overdueBacklogByProduct: amount(dc.overdueBacklogTons),
        healthyForwardBacklogByProduct: amount(dc.healthyForwardBacklogTons),
        rawMaterialLimitedByFunding: false,
        deliveryLeadTimeQuarters: 1,
        minimumMarketPresenceRatio: STANDARD_AI_PARAMETERS_V1.minDomesticPurchaseRatioOfBase,
      });
      const recomputedWithNew = computeDeliverableCommitment({
        commitmentBeforeDeliverabilityTons: dc.commitmentBeforeDeliverabilityTons,
        expectedConversionRatio:
          dc.remainingDeliverableHeadroomTons > 0 ? dc.remainingDeliverableHeadroomTons / dc.deliverabilityCapTons : 1,
        finishedGoodsByProduct: amount(0, 0, 0),
        bindingProductionCapacityTons: dc.deliverableCapacityCurrentTons,
        nearTermBindingProductionCapacityTons: dc.deliverableCapacityNearTermTons,
        fundableRawMaterialTons: Number.MAX_SAFE_INTEGER,
        overdueBacklogByProduct: amount(dc.overdueBacklogTons),
        healthyForwardBacklogByProduct: amount(dc.healthyForwardBacklogTons),
        rawMaterialLimitedByFunding: false,
        deliveryLeadTimeQuarters: 1,
        minimumMarketPresenceRatio: COMMERCIAL_COMMITMENT_PARAMETERS_V1.minimumMarketPresenceRatioOfDeliverable,
      });
      assert.deepEqual(recomputedWithNew, recomputedWithOld);
    }
    const outcome = advanceSimulationTurn(session, AT);
    assert.ok(outcome.advanced);
    session = outcome.session;
  }
});
