// ShrimpX V2 — Analysis Dataset / AI Analysis Pack Turn25停止BLOCKER修正: staleness guardのテスト
//
// 【このテスト群が守る因果】
// 実stagingで、Console/Company Databookは正しくTurn31を表示している一方、AI Analysis
// Pack ZIPの実データがTurn25までしか無いという不整合を確認した。原因調査の結果、
// Analysis画面（useAnalysisRun）がマウント時に1回だけ保存済みRunを読み込み、以後
// reload()を誰も呼ばないため、Consoleでプレイが進んだ後もstaleなまま握り続け得ること、
// かつExportPackButtonがそのstale propを無条件で信頼してexportしていたことを特定した。
//
// この修正の核心は2つ:
//   (1) exportのたびに必ず最新を再取得する（ExportPackButton.tsx参照）。
//   (2) それでもdataset/packCaptureがRun自体のcompletedTurnsに追いついていない場合
//       （原因を問わず検知できる最後の防衛線）は、findStalenessが明示的なエラーを返し、
//       黙って古いデータでZIPを出力しない。
// ここでは(2)のfindStalenessを直接テストする（(1)はコンポーネントのuseCallback内の
// 1行の変更であり、component testのセットアップコストに見合わないため、ロジックの
// 本体であるfindStalenessへ集約する）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { findStaleness } from "../ExportPackButton";
import { StoredSimulationRun } from "../../../../lib/v2/companyLab/simulation/persistence/types";

function fakeStored(overrides: {
  readonly completedTurns: number;
  readonly datasetTurns: readonly number[];
  readonly packTurns?: readonly number[];
  readonly hasPackCapture?: boolean;
}): StoredSimulationRun {
  const hasPackCapture = overrides.hasPackCapture ?? true;
  return {
    schemaVersion: 5,
    run: {
      simulationRunId: "run-1",
      scenarioId: "baseline",
      scenarioVersion: "v1",
      seed: "seed",
      gameParameterVersion: "v1",
      standardAiVersion: "v1",
      strategyProfileVersion: "v1",
      startingTurn: 1,
      requestedTurns: 32,
      completedTurns: overrides.completedTurns,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: null,
      stopReason: "running",
      errorMessage: null,
      failedAtTurn: null,
    } as StoredSimulationRun["run"],
    dataset: { turns: overrides.datasetTurns } as StoredSimulationRun["dataset"],
    packCapture: hasPackCapture
      ? ({ companyTurns: (overrides.packTurns ?? overrides.datasetTurns).map((turn) => ({ turn })), worldTurns: [] } as unknown as StoredSimulationRun["packCapture"])
      : undefined,
    savedAt: "2026-01-01T00:00:00.000Z",
    persistenceRevision: 1,
  };
}

// ANALYSIS-B10 相当: 今回の実stagingでの再現（Run31 / dataset25 / pack25）
test("ANALYSIS-B10: Turn31 exact regression — Run31・dataset25・pack25はstaleとして検知される", () => {
  const stored = fakeStored({ completedTurns: 31, datasetTurns: Array.from({ length: 25 }, (_, i) => i + 1), packTurns: Array.from({ length: 25 }, (_, i) => i + 1) });
  const error = findStaleness(stored);
  assert.ok(error, "Run31/dataset25の不整合が検知されなかった");
  assert.match(error!, /Turn25/);
  assert.match(error!, /Turn31/);
});

// ANALYSIS-B1: Run31 / dataset25 mismatch検知（packは31あるケース）
test("ANALYSIS-B1: dataset だけがRunより遅れている場合も検知される", () => {
  const stored = fakeStored({ completedTurns: 31, datasetTurns: Array.from({ length: 25 }, (_, i) => i + 1), packTurns: Array.from({ length: 31 }, (_, i) => i + 1) });
  const error = findStaleness(stored);
  assert.ok(error);
  assert.match(error!, /Analysis Dataset/);
});

// ANALYSIS-B2: pack だけがRunより遅れている場合も検知される（export拒否）
test("ANALYSIS-B2: dataset31 / pack25 は pack側の遅れとして検知され、exportを拒否する", () => {
  const stored = fakeStored({ completedTurns: 31, datasetTurns: Array.from({ length: 31 }, (_, i) => i + 1), packTurns: Array.from({ length: 25 }, (_, i) => i + 1) });
  const error = findStaleness(stored);
  assert.ok(error);
  assert.match(error!, /AI Analysis Pack Capture/);
});

// ANALYSIS-B9: revision mismatch的な状況の一種として、正常系（全て一致）ではエラーが出ないことを確認。
test("ANALYSIS-B9相当: Run31 / dataset31 / pack31（すべて一致）ならstaleとして検知されない", () => {
  const stored = fakeStored({ completedTurns: 31, datasetTurns: Array.from({ length: 31 }, (_, i) => i + 1) });
  assert.equal(findStaleness(stored), null);
});

// packCaptureが元々無い（旧形式・VIEW_ONLY相当）Runでは、pack側のstale判定をしない
// （packCapture無し自体は既存のNOT_RECORDED方針で扱われるべきで、本ガードの対象外）。
test("packCaptureが存在しないRunでは、pack側のstale判定をスキップする（datasetのみ判定）", () => {
  const stored = fakeStored({ completedTurns: 31, datasetTurns: Array.from({ length: 31 }, (_, i) => i + 1), hasPackCapture: false });
  assert.equal(findStaleness(stored), null);
});

// 境界値: datasetの最大turnがちょうどcompletedTurnsと一致する場合は正常（>=は許容、<だけ検知）。
test("dataset/packの最大turnがcompletedTurnsとちょうど一致する場合はstaleとみなさない", () => {
  const stored = fakeStored({ completedTurns: 5, datasetTurns: [1, 2, 3, 4, 5] });
  assert.equal(findStaleness(stored), null);
});

// completedTurns=0（まだ1ターンも進んでいないRun）では、空datasetでもstaleとみなさない。
test("completedTurns=0の新規Runでは、空datasetでもstaleとみなさない", () => {
  const stored = fakeStored({ completedTurns: 0, datasetTurns: [], packTurns: [] });
  assert.equal(findStaleness(stored), null);
});
