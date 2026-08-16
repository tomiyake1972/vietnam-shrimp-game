// ShrimpX V2 — Management Console Vision Calibration（vision/overrides.ts）の単体テスト
//
// 指示§43の VISION-CAL-1〜12 にそのまま対応させる。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveCompanyVision,
  defaultCompanyVisionAtTurn,
  withCompanyVisionOverrideApplied,
  withCompanyVisionOverrideReset,
  activeCompanyVisionOverrideEntry,
  isVisionTargetScaleInValidRange,
  VISION_TARGET_SCALE_MIN_TONS_PER_QUARTER,
  VISION_TARGET_SCALE_MAX_TONS_PER_QUARTER,
  CompanyLabVisionOverrides,
} from "../overrides";
import { computeForwardCapacityGap, ForwardCapacityGapInput } from "../../standardAi/forwardCapacityGap";
import { captureStrategy } from "../../simulation/aiPack/capture";
import { StandardAiQuarterDiagnostics } from "../../standardAi/policy";
import { initializeCompanyLab, buildCompanyOwnState, buildPublicMarketInfo } from "../../runner";
import { generateStandardAiDecisionWithDiagnostics } from "../../standardAi/policy";
import { buildResumePayload, restoreSessionFromResumePayload } from "../../simulation/persistence/resume";
import { createSimulationSession, applyVisionOverrideToSession, advanceSimulationTurn } from "../../simulation/engine";
import { CompanyLabConfig } from "../../types";
import { CAPEX_PARAMETERS_V1 } from "../../../capex/parameters";

// ---------------------------------------------------------------------
// VISION-CAL-1: MASS default target = 80k
// ---------------------------------------------------------------------
test("VISION-CAL-1: MASSの既定Vision目標は80,000t/期である", () => {
  const v = defaultCompanyVisionAtTurn("MASS", 1);
  assert.ok(v);
  assert.equal(v.targetScaleTonsPerQuarterAtQ32, 80000);
});

// ---------------------------------------------------------------------
// VISION-CAL-2: Run override changes MASS to 60k
// ---------------------------------------------------------------------
test("VISION-CAL-2: Run overrideでMASSを60,000tへ変更すると、resolveCompanyVisionは60,000tを返す", () => {
  const overrides: CompanyLabVisionOverrides = {
    MASS: [{ effectiveFromTurn: 1, targetScaleTonsPerQuarterAtQ32: 60000, source: "MANUAL_OVERRIDE" }],
  };
  const v = resolveCompanyVision("MASS", 5, overrides);
  assert.ok(v);
  assert.equal(v.targetScaleTonsPerQuarterAtQ32, 60000);
});

// ---------------------------------------------------------------------
// VISION-CAL-3: another Run remains 80k default
// ---------------------------------------------------------------------
test("VISION-CAL-3: あるRunのoverrideは別のRun（overrides未指定）のVisionへ影響しない", () => {
  const overridesForRunA: CompanyLabVisionOverrides = {
    MASS: [{ effectiveFromTurn: 1, targetScaleTonsPerQuarterAtQ32: 60000, source: "MANUAL_OVERRIDE" }],
  };
  const runAVision = resolveCompanyVision("MASS", 1, overridesForRunA);
  const runBVision = resolveCompanyVision("MASS", 1, undefined);
  assert.equal(runAVision?.targetScaleTonsPerQuarterAtQ32, 60000);
  assert.equal(runBVision?.targetScaleTonsPerQuarterAtQ32, 80000);
});

// ---------------------------------------------------------------------
// VISION-CAL-4: override persists reload
// ---------------------------------------------------------------------
test("VISION-CAL-4: Vision overrideはbuildResumePayload→restoreSessionFromResumePayloadを経ても保持される", () => {
  const startedAt = "2020-01-01T00:00:00.000Z";
  const session = createSimulationSession({
    simulationRunId: "vision-cal-4",
    scenarioId: "baseline",
    seed: "vision-cal-4-seed",
    requestedTurns: 2,
    startedAt,
  });
  const withOverride = applyVisionOverrideToSession(session, "MASS", {
    effectiveFromTurn: 1,
    targetScaleTonsPerQuarterAtQ32: 55000,
    source: "MANUAL_OVERRIDE",
  });
  const advanced = advanceSimulationTurn(withOverride, "2020-01-02T00:00:00.000Z");
  assert.ok(advanced.advanced, advanced.error ?? "advance failed");
  const resumePayload = buildResumePayload(advanced.session, {}, {});
  const restored = restoreSessionFromResumePayload(advanced.session.run, resumePayload);
  const visionAfterRestore = resolveCompanyVision("MASS", 2, restored.state.config.visionOverrides);
  assert.equal(visionAfterRestore?.targetScaleTonsPerQuarterAtQ32, 55000);
});

// ---------------------------------------------------------------------
// VISION-CAL-5: effectiveFromTurn prevents retroactive history rewrite
// ---------------------------------------------------------------------
test("VISION-CAL-5: effectiveFromTurnより前のTurnはoverride適用前のVisionのままになる（過去の書き換えをしない）", () => {
  const overrides: CompanyLabVisionOverrides = {
    MASS: [{ effectiveFromTurn: 10, targetScaleTonsPerQuarterAtQ32: 60000, source: "MANUAL_OVERRIDE" }],
  };
  const beforeOverride = resolveCompanyVision("MASS", 5, overrides);
  const atOverride = resolveCompanyVision("MASS", 10, overrides);
  const afterOverride = resolveCompanyVision("MASS", 20, overrides);
  assert.equal(beforeOverride?.targetScaleTonsPerQuarterAtQ32, 80000, "override前のTurnはdefaultのまま");
  assert.equal(atOverride?.targetScaleTonsPerQuarterAtQ32, 60000);
  assert.equal(afterOverride?.targetScaleTonsPerQuarterAtQ32, 60000);
});

// ---------------------------------------------------------------------
// VISION-CAL-6: Standard AI reads override
// ---------------------------------------------------------------------
function baseConfig(overrides: Partial<CompanyLabConfig> = {}): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed: "vision-cal-standardai", turns: 8, ...overrides };
}

function setupMass(overrides: Partial<CompanyLabConfig> = {}) {
  const { state, fixtures } = initializeCompanyLab(baseConfig(overrides));
  const fixture = fixtures.find((f) => f.companyId === "MASS")!;
  const ownState = buildCompanyOwnState(state, fixture);
  const publicInfo = buildPublicMarketInfo(state);
  return { fixture, ownState, publicInfo, period: state.currentPeriod, turn: 1 };
}

test("VISION-CAL-6: Standard AI（generateStandardAiDecisionWithDiagnostics）はvisionOverridesを実際に読む", () => {
  const { fixture, ownState, publicInfo, period, turn } = setupMass();
  const overrides: CompanyLabVisionOverrides = {
    MASS: [{ effectiveFromTurn: 1, targetScaleTonsPerQuarterAtQ32: 60000, source: "MANUAL_OVERRIDE" }],
  };
  const withoutOverride = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, period, turn);
  const withOverride = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, period, turn, undefined, undefined, overrides);
  assert.equal(withoutOverride.diagnostics.vision?.targetScaleTonsPerQuarterAtQ32, 80000);
  assert.equal(withOverride.diagnostics.vision?.targetScaleTonsPerQuarterAtQ32, 60000);
});

// ---------------------------------------------------------------------
// VISION-CAL-7 / VISION-CAL-9: Strategic Outlook / Analysis Pack が override を捕捉する
// （どちらも同じcaptureStrategy(diagnostics)経由でPackStrategy.visionを読むため、
//   1本のテストで両方を確認する）。
// ---------------------------------------------------------------------
test("VISION-CAL-7/9: captureStrategyが返すPackStrategy.visionは、override適用時にsource=MANUAL_OVERRIDEを記録する（Strategic Outlook・Analysis Packが読む値そのもの）", () => {
  const { fixture, ownState, publicInfo, period, turn } = setupMass();
  const overrides: CompanyLabVisionOverrides = {
    MASS: [{ effectiveFromTurn: 1, targetScaleTonsPerQuarterAtQ32: 60000, strategicPosture: "VALUE_FIRST", source: "MANUAL_OVERRIDE" }],
  };
  const { diagnostics } = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, period, turn, undefined, undefined, overrides);
  const packStrategy = captureStrategy(diagnostics as StandardAiQuarterDiagnostics);
  assert.ok(packStrategy.vision);
  assert.equal(packStrategy.vision.targetScaleTonsPerQuarterAtQ32, 60000);
  assert.equal(packStrategy.vision.source, "MANUAL_OVERRIDE");
  assert.equal(packStrategy.vision.strategicPosture, "VALUE_FIRST");
});

test("VISION-CAL-7/9(default): overrideが無ければPackStrategy.vision.sourceはDEFAULTになる", () => {
  const { fixture, ownState, publicInfo, period, turn } = setupMass();
  const { diagnostics } = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, period, turn);
  const packStrategy = captureStrategy(diagnostics as StandardAiQuarterDiagnostics);
  assert.ok(packStrategy.vision);
  assert.equal(packStrategy.vision.source, "DEFAULT");
});

// ---------------------------------------------------------------------
// VISION-CAL-8: Forward Capacity Gap reads override
// ---------------------------------------------------------------------
test("VISION-CAL-8: computeForwardCapacityGapは、渡されたVision（override適用済みでも良い）のtargetScaleをそのまま使う", () => {
  const visionLow = { ...defaultCompanyVisionAtTurn("MASS", 1)!, referenceGrowthPath: [] };
  const visionHigh = resolveCompanyVision("MASS", 1, { MASS: [{ effectiveFromTurn: 1, targetScaleTonsPerQuarterAtQ32: 120000, source: "MANUAL_OVERRIDE" }] })!;
  const base: Omit<ForwardCapacityGapInput, "vision"> = {
    turn: 12,
    currentSustainableScaleTons: 20000,
    marketGrowthEvidence: { recentOwnContractGrowthRatio: null, observedMarketGrowthRatio: null },
    capexParams: CAPEX_PARAMETERS_V1,
  };
  const gapLow = computeForwardCapacityGap({ ...base, vision: visionLow });
  const gapHigh = computeForwardCapacityGap({ ...base, vision: visionHigh });
  assert.ok(
    gapHigh.visionReferenceScaleAtCompletion >= gapLow.visionReferenceScaleAtCompletion,
    "高いVision targetのほうが、Forward Capacity Gap計算に使うvision参照規模も高いか同じであるべき"
  );
});

// ---------------------------------------------------------------------
// VISION-CAL-10: Reset to Default works
// ---------------------------------------------------------------------
test("VISION-CAL-10: withCompanyVisionOverrideResetでoverrideを取り除くと、既定Visionへ戻る", () => {
  let overrides: CompanyLabVisionOverrides = {
    MASS: [{ effectiveFromTurn: 1, targetScaleTonsPerQuarterAtQ32: 60000, source: "MANUAL_OVERRIDE" }],
  };
  assert.equal(resolveCompanyVision("MASS", 5, overrides)?.targetScaleTonsPerQuarterAtQ32, 60000);
  overrides = withCompanyVisionOverrideReset(overrides, "MASS");
  assert.equal(resolveCompanyVision("MASS", 5, overrides)?.targetScaleTonsPerQuarterAtQ32, 80000);
  assert.equal(activeCompanyVisionOverrideEntry(overrides, "MASS", 5), null);
});

test("VISION-CAL-10b: withCompanyVisionOverrideAppliedは既存overridesを書き換えず、新しいオブジェクトを返す", () => {
  const before: CompanyLabVisionOverrides = {};
  const after = withCompanyVisionOverrideApplied(before, "MASS", { effectiveFromTurn: 1, targetScaleTonsPerQuarterAtQ32: 60000, source: "MANUAL_OVERRIDE" });
  assert.deepEqual(before, {});
  assert.equal(after.MASS?.[0]?.targetScaleTonsPerQuarterAtQ32, 60000);
});

// ---------------------------------------------------------------------
// VISION-CAL-11: PLAYER company decision is not auto-changed by Vision
// ---------------------------------------------------------------------
test("VISION-CAL-11: PLAYER会社の提出済み意思決定は、visionOverridesが設定されていてもそのまま使われる（Visionが自動的に上書きしない）", () => {
  const startedAt = "2020-01-01T00:00:00.000Z";
  const session = createSimulationSession({
    simulationRunId: "vision-cal-11",
    scenarioId: "baseline",
    seed: "vision-cal-11-seed",
    requestedTurns: 1,
    startedAt,
    visionOverrides: { MASS: [{ effectiveFromTurn: 1, targetScaleTonsPerQuarterAtQ32: 120000, source: "MANUAL_OVERRIDE" }] },
  });
  const massFixture = session.fixtures.find((f) => f.companyId === "MASS")!;
  const ownState = buildCompanyOwnState(session.state, massFixture);
  const publicInfo = buildPublicMarketInfo(session.state);
  const playerDecision = generateStandardAiDecisionWithDiagnostics(massFixture, ownState, publicInfo, session.state.currentPeriod, 1).decision;
  const outcome = advanceSimulationTurn(session, "2020-01-02T00:00:00.000Z", { MASS: playerDecision });
  assert.ok(outcome.advanced, outcome.error ?? "advance failed");
  const record = outcome.session.state.history[outcome.session.state.history.length - 1];
  const massDecisionInHistory = record.decisions.find((d) => d.companyId === "MASS");
  assert.ok(massDecisionInHistory);
  // 【捏造しない比較】engineは既知の理由（監査指摘I: salesBaseScoreの正典上書き等）で
  // 提出値の一部フィールドを正規化するため、深い完全一致ではなく「PLAYERが提出した
  // capexDecision（新規プロジェクト提案・resume/cancel要求）がVisionによって
  // 差し替えられていないか」で確認する。Visionが自動的に工場提案を注入していれば
  // ここが提出値と食い違うはずである。
  assert.deepEqual(massDecisionInHistory.capexDecision, playerDecision.capexDecision, "PLAYERが提出したcapexDecisionがVisionによって差し替えられている");
  assert.deepEqual(massDecisionInHistory.productionPlans, playerDecision.productionPlans, "PLAYERが提出したproductionPlansがVisionによって差し替えられている");
});

// ---------------------------------------------------------------------
// VISION-CAL-12: unit is t/quarter
// ---------------------------------------------------------------------
test("VISION-CAL-12: Vision target scaleはt/quarter（四半期あたり）単位で、min/maxもその前提で妥当な範囲である", () => {
  assert.equal(VISION_TARGET_SCALE_MIN_TONS_PER_QUARTER, 10000);
  assert.equal(VISION_TARGET_SCALE_MAX_TONS_PER_QUARTER, 150000);
  assert.ok(isVisionTargetScaleInValidRange(80000));
  assert.ok(!isVisionTargetScaleInValidRange(9999), "下限未満は無効");
  assert.ok(!isVisionTargetScaleInValidRange(150001), "上限超過は無効");
  assert.ok(!isVisionTargetScaleInValidRange(12345.5), "整数以外は無効");
});
