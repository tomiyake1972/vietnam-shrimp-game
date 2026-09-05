// ShrimpX V2 — MANAGEMENT-CONSOLE-SALES-MODEL-1
//
// Management Console（Setup画面）から選んだ販売市場モデル（salesModelId）が、
// Run作成 → SimulationSession → resumePayload → resume → quarter processing の
// 実配分パラメータまで、途中で落ちずに到達することを実測で確かめる。
//
// 【新しい販売ロジックを作っていない】ここで検証しているのは既存の
// sales/salesModels.ts（immutable registry。唯一のSSoT）と、
// companyLab/runner.ts:salesParametersFor の既存の優先順位だけである。

import test from "node:test";
import assert from "node:assert/strict";

import {
  advanceSimulationTurn,
  applyVisionOverrideToSession,
  createSimulationSession,
} from "../engine";
import { CreateSimulationSessionInput } from "../engine";
import { buildResumePayload, restoreSessionFromResumePayload } from "../persistence/resume";
import { CURRENT_SIMULATION_RUN_PERSISTED_VERSION } from "../persistence/types";
import {
  SALES_MODEL_IDS,
  UnknownSalesModelIdError,
  salesParametersForModelId,
} from "../../../sales/salesModels";
import { CompanyLabConfig } from "../../types";
import { MarketProductAllocationResult } from "../../../sales/types";
import { simulationRunIndexKeyV2, simulationRunManifestKeyV2, simulationRunSummaryKeyV2 } from "../../../redis/simulationRunRedisKeys";
import { salesModelIdForNextRun } from "../../../../../v2/management/lib/nextRunSalesModel";

const TIERED = "tiered-v200-candidate-v1" as const;
const LEGACY = "legacy-waterfall-v1" as const;

function baseInput(overrides?: Partial<CreateSimulationSessionInput>): CreateSimulationSessionInput {
  return {
    simulationRunId: "mc-sales-test",
    scenarioId: "baseline",
    seed: "mc-sales-seed",
    requestedTurns: 2,
    startedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------- MC-SALES-1
test("MC-SALES-1: salesModelIdを選ばない（従来市場モデル）Runのconfigは、この機能導入前と同一（キー自体が存在しない）", () => {
  const session = createSimulationSession(baseInput());
  assert.equal("salesModelId" in session.config, false);
  assert.equal("salesModelId" in session.state.config, false);
  assert.equal(session.state.config.salesModelId, undefined);
});

test("MC-SALES-1b: 明示的にlegacyを渡した場合はconfigへ入るが、salesParametersForModelIdは固定値を返さない（legacy variant解決へ落ちる）", () => {
  const session = createSimulationSession(baseInput({ salesModelId: LEGACY }));
  assert.equal(session.state.config.salesModelId, LEGACY);
  assert.equal(salesParametersForModelId(LEGACY), undefined);
});

// ---------------------------------------------------------------- MC-SALES-2
test("MC-SALES-2: tieredを選ぶとsalesModelIdがsession.config・state.config・resumePayloadすべてに保存される", () => {
  const session = createSimulationSession(baseInput({ salesModelId: TIERED }));
  assert.equal(session.config.salesModelId, TIERED);
  assert.equal(session.state.config.salesModelId, TIERED);

  const payload = buildResumePayload(session, { BAL: "PLAYER" }, {});
  assert.equal(payload.state.config.salesModelId, TIERED);

  // JSON往復（Redisへ実際に保存される形）でも落ちない。
  const roundTripped = JSON.parse(JSON.stringify(payload)) as typeof payload;
  assert.equal(roundTripped.state.config.salesModelId, TIERED);
});

// ---------------------------------------------------------------- MC-SALES-3
test("MC-SALES-3: tieredを選んだRunのquarter processingが実際にtiered配分パラメータを使う", () => {
  const tieredParams = salesParametersForModelId(TIERED);
  assert.notEqual(tieredParams, undefined);
  assert.equal(tieredParams!.marketAllocationMode, "tieredSimultaneousAllocation");

  // エンジンを実際に1ターン回し、legacyとtieredで成約結果が変わることを実測する
  // （「UIに表示しただけ」ではないことの証明）。
  const legacyOutcome = advanceSimulationTurn(createSimulationSession(baseInput()), "2026-01-01T01:00:00.000Z");
  const tieredOutcome = advanceSimulationTurn(
    createSimulationSession(baseInput({ salesModelId: TIERED })),
    "2026-01-01T01:00:00.000Z"
  );
  assert.equal(legacyOutcome.error, null);
  assert.equal(tieredOutcome.error, null);
  assert.equal(legacyOutcome.advanced, true);
  assert.equal(tieredOutcome.advanced, true);

  const legacyRecord = legacyOutcome.session.state.history.at(-1);
  const tieredRecord = tieredOutcome.session.state.history.at(-1);
  assert.notEqual(legacyRecord, undefined);
  assert.notEqual(tieredRecord, undefined);
  assert.notDeepEqual(
    JSON.stringify(legacyRecord!.salesRecord.allocations),
    JSON.stringify(tieredRecord!.salesRecord.allocations),
    "tiered選択が実配分へ到達していれば、同一seed・同一意思決定でも配分結果は一致しない"
  );
});

// ---------------------------------------------------------------- MC-SALES-4
test("MC-SALES-4: resume後もtieredが維持される（session.config・state.configの両方）", () => {
  const session = createSimulationSession(baseInput({ salesModelId: TIERED }));
  const payload = JSON.parse(JSON.stringify(buildResumePayload(session, {}, {}))) as ReturnType<typeof buildResumePayload>;
  const restored = restoreSessionFromResumePayload(session.run, payload);
  assert.equal(restored.config.salesModelId, TIERED);
  assert.equal(restored.state.config.salesModelId, TIERED);

  // resume後に進めたターンもtieredのまま（=途中でlegacyへ戻らない）。
  const outcome = advanceSimulationTurn(restored, "2026-01-01T02:00:00.000Z");
  assert.equal(outcome.error, null);
  assert.equal(outcome.session.state.config.salesModelId, TIERED);
});

// ---------------------------------------------------------------- MC-SALES-5
test("MC-SALES-5: salesModelIdを持たない既存保存Runはlegacyとしてresumeされる（キーを捏造しない）", () => {
  const session = createSimulationSession(baseInput());
  const payload = JSON.parse(JSON.stringify(buildResumePayload(session, {}, {}))) as ReturnType<typeof buildResumePayload>;
  assert.equal("salesModelId" in payload.state.config, false);

  const restored = restoreSessionFromResumePayload(session.run, payload);
  assert.equal("salesModelId" in restored.config, false);
  assert.equal(restored.state.config.salesModelId, undefined);
});

// ---------------------------------------------------------------- MC-SALES-6
test("MC-SALES-6: PLAYER会社とStandard AI会社は同じ販売市場モデルを共有する（会社別salesModelIdは存在しない）", () => {
  const session = createSimulationSession(baseInput({ salesModelId: TIERED, companyControlModes: { BAL: "PLAYER" } }));
  // salesModelIdはRun単位のconfigに1つだけ。会社別に分かれる場所が無い。
  assert.equal(session.state.config.salesModelId, TIERED);

  // PLAYER会社の意思決定を差し替えても、その会社の成約はlegacyではなくtieredの
  // 配分結果になる（＝会社ごとに別モデルへ分岐していない）。
  const aiOnly = advanceSimulationTurn(session, "2026-01-01T01:00:00.000Z");
  assert.equal(aiOnly.error, null);
  const legacySame = advanceSimulationTurn(
    createSimulationSession(baseInput({ companyControlModes: { BAL: "PLAYER" } })),
    "2026-01-01T01:00:00.000Z"
  );
  assert.equal(legacySame.error, null);

  const allocationsForBal = (record: { readonly salesRecord: { readonly allocations: readonly MarketProductAllocationResult[] } }) =>
    record.salesRecord.allocations.map((a) => a.companies.filter((c) => c.companyId === "BAL"));
  const playerAllocTiered = allocationsForBal(aiOnly.session.state.history.at(-1)!);
  const playerAllocLegacy = allocationsForBal(legacySame.session.state.history.at(-1)!);
  assert.ok(playerAllocTiered.length > 0);
  assert.notEqual(
    JSON.stringify(playerAllocTiered),
    JSON.stringify(playerAllocLegacy),
    "PLAYER会社もStandard AI会社と同じtiered市場モデルの下で成約している"
  );
});

// ---------------------------------------------------------------- MC-SALES-7
test("MC-SALES-7: Run開始後にsalesModelIdは変更されない（ターン進行・Vision編集を通しても不変）", () => {
  let session = createSimulationSession(baseInput({ salesModelId: TIERED }));
  const outcome = advanceSimulationTurn(session, "2026-01-01T01:00:00.000Z");
  assert.equal(outcome.error, null);
  session = outcome.session;
  assert.equal(session.state.config.salesModelId, TIERED);

  const afterVisionEdit = applyVisionOverrideToSession(session, "BAL", {
    effectiveFromTurn: 2,
    targetScaleTonsPerQuarterAtQ32: 5000,
    strategicPosture: "DEMAND_CONFIRMED",
    source: "MANUAL_OVERRIDE",
  });
  assert.equal(afterVisionEdit.config.salesModelId, TIERED);
  assert.equal(afterVisionEdit.state.config.salesModelId, TIERED);
});

// ---------------------------------------------------------------- MC-SALES-8
test("MC-SALES-8: 未知のsalesModelIdはsilent fallbackせず失敗する", () => {
  assert.throws(() => salesParametersForModelId("tiered-v999-does-not-exist" as never), UnknownSalesModelIdError);

  // Run全体（Standard AI意思決定込みのターン処理）でも、黙ってlegacyへ落ちずに
  // そのターンが失敗する（advanced=false・UnknownSalesModelIdError）。
  const session = createSimulationSession(baseInput());
  const brokenConfig = { ...session.state.config, salesModelId: "tiered-v999-does-not-exist" } as unknown as CompanyLabConfig;
  const broken = { ...session, state: { ...session.state, config: brokenConfig } };
  const outcome = advanceSimulationTurn(broken, "2026-01-01T01:00:00.000Z");
  assert.equal(outcome.advanced, false, "未知IDのときに黙ってlegacyで進んではならない");
  assert.ok(outcome.error instanceof UnknownSalesModelIdError);
});

// ---------------------------------------------------------------- MC-SALES-9
test("MC-SALES-9: Redis schemaVersion・キー体系は変更していない", () => {
  assert.equal(CURRENT_SIMULATION_RUN_PERSISTED_VERSION, 5);
  assert.equal(simulationRunIndexKeyV2("staging"), "staging:v2:simulationRun:index");
  assert.equal(simulationRunManifestKeyV2("staging", "run-1"), "staging:v2:simulationRun:run-1");
  assert.equal(simulationRunSummaryKeyV2("staging", "run-1"), "staging:v2:simulationRun:run-1:summary");
  assert.equal(simulationRunIndexKeyV2("production"), "v2:simulationRun:index");
});

// --------------------------------------------------------------- MC-SALES-10
test("MC-SALES-10: baseline / dynamic-scenario-1 / dynamic-scenario-2 のlegacy Runに回帰差が無い", () => {
  for (const scenarioId of ["baseline", "dynamic-scenario-1", "dynamic-scenario-2"]) {
    const session = createSimulationSession(baseInput({ scenarioId, simulationRunId: `mc-${scenarioId}` }));
    // configにsalesModelIdキー自体が現れない＝保存JSONもこの機能導入前と同一。
    assert.equal("salesModelId" in session.state.config, false, scenarioId);
    const outcome = advanceSimulationTurn(session, "2026-01-01T01:00:00.000Z");
    assert.equal(outcome.error, null, scenarioId);
    assert.equal(outcome.advanced, true, scenarioId);
    assert.equal("salesModelId" in outcome.session.state.config, false, scenarioId);
  }
});

test("MC-SALES-registry: Setup画面の選択肢はregistryのSALES_MODEL_IDSそのもの（別のIDリストを新設していない）", () => {
  assert.deepEqual([...SALES_MODEL_IDS], [LEGACY, TIERED]);
});

// =====================================================================
// MANAGEMENT-CONSOLE-SALES-MODEL-1B
// Management Console 内で新しいRunを作る経路（ManagementConsole.tsx の createFresh。
// Reset ボタン／シナリオ・seedを変えて開始）で、現在のRunの販売市場モデルを
// 引き継ぐことを確かめる。
//
// createFresh は「新しいRunのsalesModelIdをどう決めるか」を純粋関数
// salesModelIdForNextRun（app/v2/management/lib/nextRunSalesModel.ts）へ委譲し、
// その戻り値をそのまま createSimulationSession へ渡す。ここではその純粋関数と、
// 渡した先の createSimulationSession までを一続きで検証する。
// =====================================================================

/** createFresh（ManagementConsole.tsx）と同じ手順で次のRunを作る。 */
function createFreshLikeConsole(
  currentSession: ReturnType<typeof createSimulationSession> | null,
  next: { readonly scenarioId: string; readonly seed: string }
): ReturnType<typeof createSimulationSession> {
  return createSimulationSession({
    simulationRunId: `mc-fresh-${next.scenarioId}-${next.seed}`,
    scenarioId: next.scenarioId,
    seed: next.seed,
    requestedTurns: 2,
    startedAt: "2026-01-02T00:00:00.000Z",
    salesModelId: salesModelIdForNextRun(currentSession),
  });
}

test("MC-SALES-11: tiered Run → Console内で新しく始める → tieredが維持される", () => {
  const current = createSimulationSession(baseInput({ salesModelId: TIERED }));
  const fresh = createFreshLikeConsole(current, { scenarioId: "baseline", seed: "mc-sales-seed" });
  assert.equal(fresh.config.salesModelId, TIERED);
  assert.equal(fresh.state.config.salesModelId, TIERED);
  // 実配分パラメータまで到達している（表示だけの引き継ぎではない）。
  assert.equal(salesParametersForModelId(fresh.state.config.salesModelId!)!.marketAllocationMode, "tieredSimultaneousAllocation");
});

test("MC-SALES-12: legacy Run（明示legacy） → 新しく始める → legacyが維持される", () => {
  const current = createSimulationSession(baseInput({ salesModelId: LEGACY }));
  const fresh = createFreshLikeConsole(current, { scenarioId: "baseline", seed: "mc-sales-seed" });
  assert.equal(fresh.state.config.salesModelId, LEGACY);
  // registryは固定値を持たないため、従来どおりlegacy variant解決へ落ちる。
  assert.equal(salesParametersForModelId(LEGACY), undefined);
});

test("MC-SALES-13: salesModelIdなし既存Run → 新しく始める → legacy semantics（キー自体が無い）", () => {
  const current = createSimulationSession(baseInput());
  assert.equal("salesModelId" in current.state.config, false);
  const fresh = createFreshLikeConsole(current, { scenarioId: "baseline", seed: "mc-sales-seed" });
  assert.equal("salesModelId" in fresh.config, false);
  assert.equal("salesModelId" in fresh.state.config, false);

  // 現在のRunが無い（起動直後の空セッション）・閲覧専用Run（session===null）でも同じ。
  assert.equal(salesModelIdForNextRun(null), undefined);
  assert.equal(salesModelIdForNextRun(undefined), undefined);
  const blank = createFreshLikeConsole(null, { scenarioId: "baseline", seed: "mc-sales-seed" });
  assert.equal("salesModelId" in blank.state.config, false);
});

test("MC-SALES-14: シナリオを変えて新しく始めてもsalesModelIdが維持される", () => {
  const current = createSimulationSession(baseInput({ salesModelId: TIERED }));
  for (const scenarioId of ["dynamic-scenario-1", "dynamic-scenario-2", "global-demand-boom"]) {
    const fresh = createFreshLikeConsole(current, { scenarioId, seed: "mc-sales-seed" });
    assert.equal(fresh.state.config.scenarioId, scenarioId);
    assert.equal(fresh.state.config.salesModelId, TIERED, scenarioId);
    // legacyのRunからシナリオを変えた場合は、legacyのまま（勝手にtieredにならない）。
    const legacyFresh = createFreshLikeConsole(createSimulationSession(baseInput()), { scenarioId, seed: "mc-sales-seed" });
    assert.equal("salesModelId" in legacyFresh.state.config, false, scenarioId);
  }
});

test("MC-SALES-15: seedを変えて新しく始めてもsalesModelIdが維持される", () => {
  const current = createSimulationSession(baseInput({ salesModelId: TIERED }));
  const fresh = createFreshLikeConsole(current, { scenarioId: "baseline", seed: "another-seed" });
  assert.equal(fresh.state.config.seed, "another-seed");
  assert.equal(fresh.state.config.salesModelId, TIERED);

  // 新しく始めたRunを実際に1ターン回しても tiered のまま（引き継ぎがエンジンまで届く）。
  const outcome = advanceSimulationTurn(fresh, "2026-01-02T01:00:00.000Z");
  assert.equal(outcome.error, null);
  assert.equal(outcome.advanced, true);
  assert.equal(outcome.session.state.config.salesModelId, TIERED);
});
