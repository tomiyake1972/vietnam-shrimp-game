// ShrimpX V2 — Simulation Run ID の生成（Console / Setup 共通）
//
// **同じロジックを2箇所に書き写さない。** Console と Setup のどちらから
// 新しいRunを始めても、同じ関数でIDを作る。

/** Redisキーへ使うため、コロン以外の記号が入らないよう ISO 文字列を整形する。 */
export function newRunId(seed: string, startedAt: string): string {
  return `run-${seed}-${startedAt.replace(/[^0-9A-Za-z]/g, "")}`;
}
