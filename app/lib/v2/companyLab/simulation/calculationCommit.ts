// ShrimpX V2 — Run Calculation Commit Identity（BALANCE-PROFILE-1 受入前修正）
//
// 【何を解決するか】感応度試験の再現には「そのRunのどのTurnを、どのcommitで計算したか」
// が要る。Export時点で process.env.NEXT_PUBLIC_SOURCE_COMMIT を読むと、それは
// 「いま動いているアプリのcommit」でしかない。
//
//   commit A で Turn1-16 を計算
//   → deploy更新
//   → commit B で同じRunをresumeして Turn17-32 を計算
//   → commit C 上で後からExport
//
// という経路で、Export時点のenvを使うと Run全体が commit C で計算されたことになってしまう。
// そこで「アプリ現在版」と「Run実計算版」を型のうえで分離し、計算に使ったcommitを
// Turn区間つきでRunへ積み上げる。
//
// 【ゲーム計算は一切変えない】ここで扱うのは再現性metadataだけである。
// 意思決定・価格・会計のいずれにも influence しない。
//
// 【推測しない】履歴を持たない古いRunについて、現在アプリのcommitから過去の計算commitを
// 推定してはならない。そのようなTurnは "UNKNOWN" のままにする。

/** 計算commitが判明していないことを表す値（捏造した値を入れない）。 */
export const UNKNOWN_SOURCE_COMMIT = "UNKNOWN";

/**
 * 「このTurn以降を、このcommitで計算した」という区間記録。
 * effectiveFromTurn は昇順に積まれ、過去entryは上書きしない。
 */
export interface CalculationCommitEntry {
  readonly effectiveFromTurn: number;
  readonly sourceCommit: string;
}

export type CalculationCommitHistory = readonly CalculationCommitEntry[];

/**
 * いま動いているアプリのsource commit。
 *
 * 【名前に注意】これは "app" 側の版であり、過去Runの計算commitではない。
 * 過去Turnの計算commitを知りたいときは必ず
 * resolveCalculationCommitForTurn（＝Runに保存された履歴）を使う。
 */
export function resolveCurrentAppSourceCommit(): string {
  return process.env.NEXT_PUBLIC_SOURCE_COMMIT || UNKNOWN_SOURCE_COMMIT;
}

/**
 * 直近（最大のeffectiveFromTurn）の記録commitを返す。履歴が無ければ null。
 * 「同じcommitなら重複追加しない」判定に使う。
 */
export function latestRecordedCommit(history: CalculationCommitHistory | undefined): string | null {
  if (!history || history.length === 0) return null;
  return history.reduce((latest, entry) => (entry.effectiveFromTurn > latest.effectiveFromTurn ? entry : latest)).sourceCommit;
}

/**
 * 必要なときだけ新しい区間を足した履歴を返す（純粋関数）。
 *
 * 【同じcommitなら足さない】直近の記録と同一なら履歴をそのまま返す
 * （resumeのたびに同じ値が積み上がるのを防ぐ）。
 * 【過去entryを上書きしない】常に末尾へ追加するだけで、既存の区間は書き換えない。
 */
export function withCalculationCommitRecorded(
  history: CalculationCommitHistory | undefined,
  effectiveFromTurn: number,
  sourceCommit: string
): CalculationCommitHistory {
  const current = history ?? [];
  if (latestRecordedCommit(current) === sourceCommit) return current;
  return [...current, { effectiveFromTurn, sourceCommit }];
}

/**
 * 指定Turnを計算したcommitを返す。
 *
 * 履歴が無い／そのTurnを覆う区間が無い（この機能より前に計算されたTurn）場合は
 * UNKNOWN_SOURCE_COMMIT を返す。現在アプリのcommitで埋めない。
 */
export function resolveCalculationCommitForTurn(
  history: CalculationCommitHistory | undefined,
  turn: number
): string {
  if (!history || history.length === 0) return UNKNOWN_SOURCE_COMMIT;
  const applicable = history.filter((entry) => entry.effectiveFromTurn <= turn);
  if (applicable.length === 0) return UNKNOWN_SOURCE_COMMIT;
  return applicable.reduce((latest, entry) => (entry.effectiveFromTurn > latest.effectiveFromTurn ? entry : latest)).sourceCommit;
}

/**
 * そのRunが単一commitだけで計算されたか。
 * 【単一値へ潰さないため】複数commitにまたがる場合、Export側は1つの
 * sourceCommit へまとめず、Turnごとの値を出す必要がある。
 */
export function isSingleCalculationCommit(history: CalculationCommitHistory | undefined): boolean {
  if (!history || history.length === 0) return false;
  return new Set(history.map((entry) => entry.sourceCommit)).size === 1;
}
