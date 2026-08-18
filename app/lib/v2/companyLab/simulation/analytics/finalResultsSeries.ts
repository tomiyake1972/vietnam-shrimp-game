// ShrimpX V2 — Game End / Final Results（END-3）: Dividend・TSV系列ヘルパー
//
// 【新しい計算をしない】ここでは配当額・TSVのいずれも再計算しない。
// Dividendは既存の確定実績（CompanyQuarterRecord.dividendResults[].appliedDividendUsd）を
// そのまま取り出すだけ。TSVは既存のevaluation service
// （computeCompanyEvaluationSnapshot、唯一のsource of truth）をTurnごとに
// 呼び出すだけで、UI独自の計算式は一切持たない。
//
// 【Game End Turnまで動的に描画する】gameEndTurnは呼び出し側が渡す実際のGame
// End Turnであり、ここでは32Turn等の特定Turn数を一切前提としない。

import { CompanyFixture, CompanyQuarterRecord } from "../../types";
import { computeCompanyEvaluationSnapshot } from "../../evaluation/evaluationSemantics";
import { COMPANY_COLORS } from "../series";

export interface FinalResultsCompanySeries {
  readonly companyId: string;
  readonly displayName: string;
  readonly color: string;
  readonly points: readonly { readonly turn: number; readonly value: number | null }[];
}

function turnsUpTo(gameEndTurn: number): readonly number[] {
  return Array.from({ length: Math.max(0, gameEndTurn) }, (_, i) => i + 1);
}

/** Turnごとの実配当額（appliedDividendUsd）を確定実績からそのまま取り出す。 */
export function buildDividendSeries(
  history: readonly CompanyQuarterRecord[],
  fixtures: readonly CompanyFixture[],
  gameEndTurn: number
): readonly FinalResultsCompanySeries[] {
  const turns = turnsUpTo(gameEndTurn);
  const byTurn = new Map<number, CompanyQuarterRecord>(history.map((r) => [r.turn, r]));
  return fixtures.map((f) => ({
    companyId: f.companyId,
    displayName: f.displayName,
    color: COMPANY_COLORS[f.companyId] ?? "#64748b",
    points: turns.map((turn) => {
      const record = byTurn.get(turn);
      const result = record?.dividendResults?.find((d) => d.companyId === f.companyId) ?? null;
      return { turn, value: result ? result.appliedDividendUsd : null };
    }),
  }));
}

/** Turnごとの Total Shareholder Value を、既存evaluation serviceをTurnごとに呼んで並べる。 */
export function buildTsvSeries(
  history: readonly CompanyQuarterRecord[],
  fixtures: readonly CompanyFixture[],
  gameEndTurn: number
): readonly FinalResultsCompanySeries[] {
  const turns = turnsUpTo(gameEndTurn);
  const recordedTurns = new Set(history.map((r) => r.turn));
  return fixtures.map((f) => ({
    companyId: f.companyId,
    displayName: f.displayName,
    color: COMPANY_COLORS[f.companyId] ?? "#64748b",
    points: turns.map((turn) => {
      if (!recordedTurns.has(turn)) return { turn, value: null };
      const snapshot = computeCompanyEvaluationSnapshot(history, f.companyId, turn);
      return { turn, value: snapshot.totalShareholderValueUsd };
    }),
  }));
}
