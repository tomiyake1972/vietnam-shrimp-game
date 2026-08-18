// ShrimpX V2 — Final Results履歴修正: 評価専用の軽量履歴（EvaluationHistoryRecord）
//
// 【なぜ必要か（root cause）】
// resumePayload.state.history は保存量を抑えるため直近
// ROLLING_RESUME_HISTORY_WINDOW(=4) Turnだけへ間引かれる（resume.ts）。
// この間引き自体は「次Turnのsimulation継続に必要なのは直近数Turnだけ」という
// 監査に基づく正しい設計であり、変更しない。
//
// しかし Final Results の TSV / 配当推移は「Turn1からGame End Turnまでの全履歴」を
// 必要とする。reload（resume）後の session.state.history は直近4Turnしか無いため、
//   ・Turn1〜28がnullになる
//   ・Turn32のTSVが、直近4Turnぶんの配当しか含まないDividend Valueで計算される
// という2つの不整合が同時に発生していた（どちらも同一原因）。
//
// Analysis dataset は既に同じ問題を priorAnalyticsDataset（resume時点までの完全な
// datasetを持ち回してマージする）で解決している。本モジュールは評価（TSV）について
// まったく同じ方式を取る。
//
// 【新しい計算をしない】ここが持つのは CompanyQuarterRecord のうち
// evaluationSemantics.ts が実際に読むフィールドだけを写した射影である。
// TSVの式・DCF・15%複利・正常化CFのlookbackはすべて evaluationSemantics.ts が
// 唯一のSSoTであり、本モジュールは値を一切加工しない。
//
// 【なぜ全Turnぶん持っても肥大しないか】CompanyQuarterRecord本体は市場・生産・
// 契約・バッチ・診断まで含む巨大な記録だが、評価が読むのは
// financialResults / financingResults / companySummaries / dividendResults の
// 4フィールドだけである。会社数×Turn数ぶんの財務諸表のみとなり、
// state.history全件を保存へ戻すのとは規模が違う（§8の設計意図を壊さない）。

import { CompanyQuarterRecord } from "../types";

/**
 * evaluationSemantics.ts が実際に読むフィールドだけを持つ、評価専用の履歴レコード。
 *
 * 【構造的部分型】各フィールドは本物の型（CompanyFinancialQuarterResult等）の
 * 部分集合として宣言してあるため、CompanyQuarterRecord[] は従来どおりそのまま
 * 評価関数へ渡せる（既存呼び出し元は無変更）。branded unit型（Usd / トン）は
 * ただのnumberなので、numberとして受けても情報は失われない。
 *
 * 【なぜ「参照するフィールドだけ」なのか】CompanyFinancialQuarterResult本体は
 * 原価内訳・品質損失・コスト記録・管理会計まで含むため、全Turnぶん保存すると
 * resumePayloadがVercel Functionsのbody上限（約4.5MB）を超えてserver保存が
 * 拒否される（PERSIST-B-COMPACT-6が守っている制約）。評価に必要な十数個の
 * スカラーだけへ射影することで、全Turn保持してもサイズはほぼ増えない。
 */
export interface EvaluationHistoryRecord {
  readonly turn: number;
  readonly financialResults: readonly {
    readonly companyId: string;
    readonly profitAndLoss: { readonly operatingProfit: number; readonly netRevenue: number };
    readonly balanceSheet: { readonly cash: number; readonly shortTermLoans: number; readonly longTermLoans: number };
    readonly cashFlow: { readonly operatingCashFlow: number };
  }[];
  readonly financingResults: readonly {
    readonly companyId: string;
    readonly financialHealth: { readonly primary: string };
  }[];
  readonly companySummaries: readonly {
    readonly companyId: string;
    readonly fulfilledQuantity: number;
  }[];
  readonly dividendResults?: readonly {
    readonly companyId: string;
    readonly appliedDividendUsd: number;
    readonly cumulativeDividendUsd: number;
    readonly cumulativeWeightedDividendValueUsd: number;
  }[];
}

/**
 * 確定済みのCompanyQuarterRecordから、評価に必要なスカラーだけを写す。
 * 値の加工・再計算は一切しない（そのままコピーするだけ）。
 */
export function toEvaluationHistoryRecord(record: CompanyQuarterRecord): EvaluationHistoryRecord {
  return {
    turn: record.turn,
    financialResults: record.financialResults.map((f) => ({
      companyId: f.companyId,
      profitAndLoss: { operatingProfit: Number(f.profitAndLoss.operatingProfit), netRevenue: Number(f.profitAndLoss.netRevenue) },
      balanceSheet: {
        cash: Number(f.balanceSheet.cash),
        shortTermLoans: Number(f.balanceSheet.shortTermLoans),
        longTermLoans: Number(f.balanceSheet.longTermLoans),
      },
      cashFlow: { operatingCashFlow: Number(f.cashFlow.operatingCashFlow) },
    })),
    financingResults: record.financingResults.map((f) => ({
      companyId: f.companyId,
      financialHealth: { primary: f.financialHealth.primary },
    })),
    companySummaries: record.companySummaries.map((s) => ({
      companyId: s.companyId,
      fulfilledQuantity: Number(s.fulfilledQuantity),
    })),
    dividendResults: record.dividendResults?.map((d) => ({
      companyId: d.companyId,
      appliedDividendUsd: d.appliedDividendUsd,
      cumulativeDividendUsd: d.cumulativeDividendUsd,
      cumulativeWeightedDividendValueUsd: d.cumulativeWeightedDividendValueUsd,
    })),
  };
}

/**
 * 既存の評価履歴へ、新しく確定したTurnぶんをマージする（純粋関数）。
 * 同一Turnが両方にある場合は後から確定した側（next）を採用し、turn昇順で返す。
 * resume直後は prior にTurn1〜Nが、next（＝間引かれた state.history）に直近数Turnが
 * 入るため、両者をこのマージで1本に戻す。
 */
export function mergeEvaluationHistory(
  prior: readonly EvaluationHistoryRecord[] | undefined,
  next: readonly EvaluationHistoryRecord[]
): readonly EvaluationHistoryRecord[] {
  const byTurn = new Map<number, EvaluationHistoryRecord>();
  for (const record of prior ?? []) byTurn.set(record.turn, record);
  for (const record of next) byTurn.set(record.turn, record);
  return [...byTurn.values()].sort((a, b) => a.turn - b.turn);
}

/**
 * 評価に使う履歴を決める唯一の入口。
 *
 * evaluationHistory（全Turn）があればそれを使い、無い場合（本機能より前に保存された
 * 既存Run、または評価履歴を持たない呼び出し元）は state.history へフォールバックする。
 * フォールバック時の挙動はこれまでとまったく同じであり、既存Runを壊さない。
 */
export function resolveEvaluationHistory(input: {
  readonly evaluationHistory?: readonly EvaluationHistoryRecord[];
  readonly stateHistory: readonly CompanyQuarterRecord[];
}): readonly EvaluationHistoryRecord[] {
  const { evaluationHistory, stateHistory } = input;
  const fromState = stateHistory.map(toEvaluationHistoryRecord);
  if (!evaluationHistory || evaluationHistory.length === 0) return fromState;
  return mergeEvaluationHistory(evaluationHistory, fromState);
}
