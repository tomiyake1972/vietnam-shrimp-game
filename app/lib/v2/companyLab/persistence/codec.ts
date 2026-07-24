// ShrimpX V2 — 会社ラボ専用永続化モデル encode/decode（Phase 8C-1）
//
// CompanyLabPersistedStateV1 ⇄ JSON文字列 の変換。app/lib/v2/persistence/codec.tsは
// 全リーフフィールドを固定キー順序のDTOへ手書きで変換しているが、本モジュールは
// 会社ラボの型がPhase1〜8Bの10以上のドメインモジュールを再帰的に埋め込んでおり、
// 同水準の手書きDTO変換を行うと本Phaseの主目的（保存モデル・Repository・原子コミット
// 基盤）に不釣り合いな量のコードになるため、素のJSON.stringify/JSON.parseを
// 採用する（意図的な設計判断。schema.tsの§検証範囲コメントと同じ理由）。
//
// 【この判断の妥当性】
//   - ブランド型（HosoEqTons等）は実行時はただのnumberであり、JSON.stringifyは
//     そのままnumberとして出力する（core/units.ts冒頭コメントの設計意図どおり）。
//   - PeriodV2は実行時はただのstringであり、同様にそのまま出力される。
//   - decode側は必ずschema.tsのvalidateCompanyLabPersistedStateを経由し、
//     ブランド型の復元は必ずスマートコンストラクタ（hosoEqTons()等）を経由する
//     （`as`だけの型キャストで済ませない。既存persistence/codec.tsと同じ方針）。
//   - キー順序の決定性（同じ内容なら常に同じ文字列になること）は、本モジュールの
//     用途（Redisへの保存・読み出し）では要求されない。要求されるのは
//     「保存した内容が完全に復元できること」であり、JSON.stringifyの
//     オブジェクトプロパティ挿入順序への依存はその要件に影響しない。

import { CompanyLabPersistedStateV1 } from "./types";
import { CompanyLabPersistedStateParseError } from "./errors";
import { validateCompanyLabPersistedState } from "./schema";

/** CompanyLabPersistedStateV1をJSON文字列へ変換する（純粋関数、入力を変更しない）。 */
export function encodeCompanyLabPersistedState(state: CompanyLabPersistedStateV1): string {
  return JSON.stringify(state);
}

/**
 * JSON文字列をCompanyLabPersistedStateV1へ変換する。JSON.parseに失敗した場合は
 * CompanyLabPersistedStateParseErrorを投げる。parse成功後は必ず
 * validateCompanyLabPersistedStateでランタイム検証する。
 */
export function decodeCompanyLabPersistedState(serialized: string): CompanyLabPersistedStateV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (e) {
    throw new CompanyLabPersistedStateParseError(`JSONとして解析できません: ${e instanceof Error ? e.message : String(e)}`);
  }
  return validateCompanyLabPersistedState(parsed);
}

/**
 * KVストアから読み出した「保存済みの値」をCompanyLabPersistedStateV1へ変換する。
 * @upstash/redisはJSON文字列を自動でdeserializeして返すことがあるため、文字列・
 * 既にパース済みの値の両方を受け付け、いずれの経路でも必ずランタイム検証を通す
 * （app/lib/v2/persistence/codec.tsのdecodePersistedGameStateFromStoredと同じ設計）。
 */
export function decodeCompanyLabPersistedStateFromStored(raw: unknown): CompanyLabPersistedStateV1 {
  if (typeof raw === "string") {
    return decodeCompanyLabPersistedState(raw);
  }
  return validateCompanyLabPersistedState(raw);
}
