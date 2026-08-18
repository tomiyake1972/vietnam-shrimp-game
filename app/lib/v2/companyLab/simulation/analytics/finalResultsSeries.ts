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
//
// 【入力はevaluationHistory（Final Results履歴修正）】
// 以前はここへ session.state.history をそのまま渡していた。state.history は
// resume時に直近 ROLLING_RESUME_HISTORY_WINDOW(=4) Turnへ間引かれるため、
// reload後は (a) Turn1〜28がnullになり、(b) Game End TurnのTSVも「直近4Turnぶんの
// 配当しか含まないDividend Value」で計算されてしまう、という2つの不整合が
// 同時に起きていた（どちらも同一原因）。呼び出し側は
// evaluation/evaluationHistory.ts の resolveEvaluationHistory を通した
// 全Turnぶんの履歴を渡すこと。

import { CompanyFixture } from "../../types";
import { EvaluationHistoryRecord } from "../../evaluation/evaluationHistory";
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

/**
 * Turnごとの実配当額（appliedDividendUsd）を確定実績からそのまま取り出す。
 *
 * 【0 と null の使い分け（指示§7）】そのTurnの記録が存在するなら、配当していない
 * Turnは 0 とする（「配当しなかった」という事実であり、欠測ではない）。
 * null は記録そのものが存在しないTurnだけに使う。
 *
 * 【TSVのDividend Valueと混同しない（指示§8）】ここが返すのは「そのTurnに実際に
 * 支払った額」であり、TSVが使う「過去配当全体の15%複利評価額」ではない。
 */
export function buildDividendSeries(
  history: readonly EvaluationHistoryRecord[],
  fixtures: readonly CompanyFixture[],
  gameEndTurn: number
): readonly FinalResultsCompanySeries[] {
  const turns = turnsUpTo(gameEndTurn);
  const byTurn = new Map<number, EvaluationHistoryRecord>(history.map((r) => [r.turn, r]));
  return fixtures.map((f) => ({
    companyId: f.companyId,
    displayName: f.displayName,
    color: COMPANY_COLORS[f.companyId] ?? "#64748b",
    points: turns.map((turn) => {
      const record = byTurn.get(turn);
      if (!record) return { turn, value: null };
      const result = record.dividendResults?.find((d) => d.companyId === f.companyId) ?? null;
      return { turn, value: result ? result.appliedDividendUsd : 0 };
    }),
  }));
}

/**
 * Turnごとの Total Shareholder Value を、既存evaluation serviceをTurnごとに呼んで並べる。
 *
 * 【asOfTurn semantics / future leakage禁止（指示§11）】各Turn t の値は
 * computeCompanyEvaluationSnapshot(history, companyId, t) がそのまま返す値であり、
 * 同関数が内部で history を turn <= t へ絞る（scopedHistory）。したがって
 * Turn t の値に t+1 以降のデータが混入する余地は構造的に存在しない。
 *
 * 【正常化CFの3Turn lookbackと混同しない（指示§10）】履歴自体を直近3Turnへ
 * 絞るのではない。評価に渡すのは常にTurn1〜tの全履歴であり、
 * 「直近3Turn平均」はEnterprise Valueの正常化CF計算の中だけの話である。
 */
export function buildTsvSeries(
  history: readonly EvaluationHistoryRecord[],
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
