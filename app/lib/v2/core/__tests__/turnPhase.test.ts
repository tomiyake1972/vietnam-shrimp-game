import { test } from "node:test";
import assert from "node:assert/strict";
import { period } from "../period";
import {
  initialTurnState,
  advanceTurnPhase,
  assertLegalTurnPhaseTransition,
  TURN_PHASE_ORDER,
} from "../turnPhase";

// テスト14: 通常のフェーズ遷移
test("P0からP1へ、P1からP2へ...の通常遷移は許可される", () => {
  const p = period(2020, 1);
  let state = initialTurnState(p);
  for (let i = 1; i < TURN_PHASE_ORDER.length; i++) {
    const next = advanceTurnPhase(state);
    assert.equal(next.phase, TURN_PHASE_ORDER[i]);
    assert.equal(next.period, p); // P8以前はperiodが変わらない
    assert.doesNotThrow(() => assertLegalTurnPhaseTransition(state, next));
    state = next;
  }
});

// テスト15: フェーズのスキップ・後退・二重実行の拒否
test("フェーズのスキップ（P0からP2へ）は拒否される", () => {
  const p = period(2020, 1);
  const p0 = initialTurnState(p);
  const skippedToP2 = { period: p, phase: "P2_STRATEGY" as const };
  assert.throws(() => assertLegalTurnPhaseTransition(p0, skippedToP2));
});

test("フェーズの後退（P1からP0へ）は拒否される", () => {
  const p = period(2020, 1);
  const p1 = { period: p, phase: "P1_MARKET" as const };
  const backToP0 = { period: p, phase: "P0_OPEN" as const };
  assert.throws(() => assertLegalTurnPhaseTransition(p1, backToP0));
});

test("同一フェーズへの二重実行は拒否される", () => {
  const p = period(2020, 1);
  const p1 = { period: p, phase: "P1_MARKET" as const };
  assert.throws(() => assertLegalTurnPhaseTransition(p1, p1));
});

// テスト16: P8から次期のP0への遷移
test("P8_CLOSEから次のPeriodのP0_OPENへ遷移する", () => {
  const p = period(2020, 4);
  const p8 = { period: p, phase: "P8_CLOSE" as const };
  const next = advanceTurnPhase(p8);
  assert.equal(next.period, period(2021, 1));
  assert.equal(next.phase, "P0_OPEN");
  assert.doesNotThrow(() => assertLegalTurnPhaseTransition(p8, next));
});

test("P8_CLOSEから同じPeriodのP0_OPENへの遷移（period据え置き）は拒否される", () => {
  const p = period(2020, 1);
  const p8 = { period: p, phase: "P8_CLOSE" as const };
  const wrongNext = { period: p, phase: "P0_OPEN" as const };
  assert.throws(() => assertLegalTurnPhaseTransition(p8, wrongNext));
});
