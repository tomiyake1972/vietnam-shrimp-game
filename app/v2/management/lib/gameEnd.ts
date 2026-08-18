// ShrimpX V2 — Game End / Final Results（END-1）
//
// 【新しい評価ロジックを作らない】TSV / EV / DCF / Dividend Valueの計算式は
// ここでは一切再実装しない。既存のevaluation service
// （app/lib/v2/companyLab/evaluation/evaluationSemantics.ts、唯一のsource of truth）
// が返すCompanyEvaluationSnapshotを、そのままFinal Snapshotとして保存するだけ。
//
// 【任意Turnで終了できる】ここでは特定のTurn数（32等）を一切前提としない。
// 呼び出し側が渡した「今のTurn」をそのままgameEndTurnとして確定する。

import {
  CompanyEvaluationSnapshot,
  computeAllCompaniesEvaluationSnapshot,
  rankCompaniesByTotalShareholderValue,
} from "../../../lib/v2/companyLab/evaluation/evaluationSemantics";
import { resolveEvaluationHistory } from "../../../lib/v2/companyLab/evaluation/evaluationHistory";
import { SimulationRun, SimulationSession } from "../../../lib/v2/companyLab/simulation/types";

/**
 * 直近まで確定した最終Turn番号。
 *
 * 【scenarioState.currentTurnを使わない理由】currentTurnは「次に処理するTurn」
 * （まだ結果が存在しないTurn）を指しており、Nターン処理し終えた直後は
 * completedTurns=Nに対しcurrentTurn=N+1になる（engine.tsのadvanceSimulationTurn
 * 参照）。Game End Turnとして画面に出す・Final Snapshotのターン軸に使う番号は、
 * 「実際に確定した最後のTurn」でなければならないため、completedTurns（＝
 * 「最後まで処理し終えたターン数」と定義済み）を使う。
 */
export function lastCompletedTurn(session: SimulationSession): number {
  return session.run.completedTurns;
}

/**
 * 直近確定Turn時点の5社Evaluation Snapshotを計算する（既存関数の呼び出しのみ・新しい計算はしない）。
 *
 * 【Final Results履歴修正】入力は state.history ではなく評価専用の全Turn履歴にする。
 * state.history はresume時に直近数Turnへ間引かれるため、reload後にGame Endを押すと
 * Dividend Valueが「直近数Turnぶんの配当」しか含まない過小評価になっていた。
 * これはTurn別TSV履歴の不整合とまったく同じ原因であり、両者が常に同じ入力
 * （resolveEvaluationHistory）を見ることで、
 * 「history[gameEndTurn].TSV === finalEvaluationSnapshot.TSV」が構造的に保証される（§12）。
 */
export function computeFinalEvaluationSnapshot(session: SimulationSession): readonly CompanyEvaluationSnapshot[] {
  const companyIds = session.fixtures.map((f) => f.companyId);
  const history = resolveEvaluationHistory({ evaluationHistory: session.evaluationHistory, stateHistory: session.state.history });
  return computeAllCompaniesEvaluationSnapshot(history, companyIds, lastCompletedTurn(session));
}

/** ゲームを終了した状態のSimulationRunを構築する（既存フィールドは一切変更しない・追加フィールドのみ設定）。 */
export function buildGameEndedRun(
  run: SimulationRun,
  gameEndTurn: number,
  finishedAt: string,
  snapshot: readonly CompanyEvaluationSnapshot[]
): SimulationRun {
  return {
    ...run,
    gameEndedAt: finishedAt,
    gameEndTurn,
    finalEvaluationSnapshot: snapshot,
  };
}

/** このRunが既に終了しているか（server-side mutation lock・client-side分岐の両方で使う唯一の判定）。 */
export function isGameFinished(run: SimulationRun | null | undefined): boolean {
  return Boolean(run?.gameEndedAt);
}

/** TSV降順ランキング（既存rankCompaniesByTotalShareholderValueをそのまま呼ぶだけ）。 */
export function rankFinalSnapshot(snapshot: readonly CompanyEvaluationSnapshot[]): readonly CompanyEvaluationSnapshot[] {
  return rankCompaniesByTotalShareholderValue(snapshot);
}
