// ShrimpX V2 — #05 Standard AI費用Projection接続: tiered販売市場モデルでの
// 中立互換 cross-commit 回帰確認（感応度Runではない）。
//
// 読み取り専用。ゲームロジックを一切変更しない。
// base(f4ffc51) と feature を**同一条件**で実行し、出力JSONが1文字も違わないことを
// 確認するためだけに存在する。Run ID・source commit・生成時刻などのメタデータは
// 比較対象から除外する（run.simulationRunId / startedAt / completedAt /
// gameParameterVersion / standardAiVersion / strategyProfileVersion / scenarioVersion）。

import { createSimulationSession, advanceSimulationTurns } from "../app/lib/v2/companyLab/simulation/engine";
import { computeAllCompaniesEvaluationSnapshot } from "../app/lib/v2/companyLab/evaluation/evaluationSemantics";
import { toEvaluationHistoryRecord } from "../app/lib/v2/companyLab/evaluation/evaluationHistory";
import { createHash } from "node:crypto";

const SCENARIO_ID = "dynamic-scenario-2-v0.1";
const SALES_MODEL_ID = "tiered-v200-candidate-v1" as const;
const TURNS = 32;
const SEEDS = ["management-console-32q", "ds2-full-b"] as const;
const TIMESTAMP = "2026-01-01T00:00:00.000Z";
const COMPANIES = ["BAL", "MASS", "JPQ", "VAP", "CONSV"] as const;

/** 比較対象から外すメタデータのキー（ゲーム状態ではない）。 */
const METADATA_KEYS = new Set([
  "simulationRunId",
  "startedAt",
  "completedAt",
  "gameParameterVersion",
  "standardAiVersion",
  "strategyProfileVersion",
  "scenarioVersion",
]);

function stripMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripMetadata);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (METADATA_KEYS.has(k)) continue;
      out[k] = stripMetadata(v);
    }
    return out;
  }
  return value;
}

function runSeed(seed: string) {
  let session = createSimulationSession({
    simulationRunId: `tiered-${seed}`,
    scenarioId: SCENARIO_ID,
    seed,
    requestedTurns: TURNS,
    startedAt: TIMESTAMP,
    salesModelId: SALES_MODEL_ID,
    standardAiProfileMode: "ON",
    companyControlModes: Object.fromEntries(COMPANIES.map((c) => [c, "STANDARD_AI" as const])),
    // visionOverrides は未指定。
  });
  session = advanceSimulationTurns({ session, turns: TURNS, timestamp: TIMESTAMP });
  const state = session.state;

  // 最終評価値（Total Shareholder Value 等）。
  const evaluationHistory = state.history.map(toEvaluationHistoryRecord);
  const evaluation = computeAllCompaniesEvaluationSnapshot(evaluationHistory, [...COMPANIES], state.history.length);

  const comparable = {
    seed,
    salesModelId: state.config.salesModelId ?? null,
    standardAiProfileMode: state.config.standardAiProfileMode ?? null,
    completedTurns: state.history.length,
    // Standard AI意思決定（各Turnの決定そのもの）＋市場・生産・財務・CAPEX・配当・資金調達
    // ＋32Turn最終state を、メタデータ除去後にまるごと比較する。
    run: stripMetadata(session.run),
    state: stripMetadata(state),
    fixtures: stripMetadata(session.fixtures),
    aiTurnTraces: stripMetadata(session.aiTurnTraces),
    observedDemand: stripMetadata(session.observedDemand),
    evaluation: stripMetadata(evaluation),
  };
  const json = JSON.stringify(comparable);
  return {
    seed,
    completedTurns: state.history.length,
    salesModelId: comparable.salesModelId,
    standardAiProfileMode: comparable.standardAiProfileMode,
    comparableSha256: createHash("sha256").update(json).digest("hex"),
    comparable,
  };
}

const results = SEEDS.map(runSeed);
if (process.env.DS2_TIERED_SUMMARY === "1") {
  for (const r of results) {
    console.log(`${r.seed}\tturns=${r.completedTurns}\tsalesModel=${r.salesModelId}\tprofileMode=${r.standardAiProfileMode}\tsha256=${r.comparableSha256}`);
  }
} else {
  console.log(JSON.stringify(results, null, 2));
}
