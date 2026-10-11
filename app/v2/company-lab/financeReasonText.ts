// ShrimpX V2 — 財務の判定理由を、プレイヤーが読める文へ直す表示専用の変換
//
// 【UI-CLARITY-2 D3】実機プレイテストで、翌ターンに出る理由が
//   「信用区分C・借入余力枠停止（binding: collateralBased）により…」
//   「配当額(5000000.00)が分配可能利益(1260000.00)を超えています。」
// のように、内部名と生の数値のまま出ていた。
//
// 【engineの文字列は変えない】これらの理由文は engine（financing/bankUnderwriting.ts・
// finance/dividend.ts）が作り、Runの結果として保存される記録そのものである。
// 記録を書き換えると過去Runとの比較ができなくなるため、engine側は触らず、
// 画面へ出す直前にこの関数で読める形へ直す。新しい判定・新しい数値は作らない。

import { borrowingConstraintLabel } from "./borrowingCapacityGuide";

/** 1,234,567 形式のドル表記（小数は四捨五入。表示専用）。 */
function formatUsdPlain(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

/**
 * 理由文の中の内部名・生の数値を読める形へ置き換える。
 * 該当する箇所が無ければ元の文字列をそのまま返す（未知の理由を握りつぶさない）。
 */
export function humanizeFinanceReason(reason: string): string {
  let out = reason;

  // 「binding: <制約id>」→「効いている制約: <日本語>」
  out = out.replace(/binding:\s*([A-Za-z][A-Za-z0-9_]*)/g, (_match, id: string) => `効いている制約: ${borrowingConstraintLabel(id)}`);

  // 「残り1234567USD」→「残り$1,234,567」
  out = out.replace(/(-?\d+(?:\.\d+)?)USD/g, (_match, num: string) => formatUsdPlain(Number(num)));

  // 「配当額(5000000.00)」のように括弧で囲まれた生の金額→桁区切りのドル表記
  out = out.replace(/\((-?\d+\.\d{2})\)/g, (_match, num: string) => `（${formatUsdPlain(Number(num))}）`);

  return out;
}

/** 配列版（承認理由の箇条書き用）。 */
export function humanizeFinanceReasons(reasons: readonly string[]): readonly string[] {
  return reasons.map(humanizeFinanceReason);
}
