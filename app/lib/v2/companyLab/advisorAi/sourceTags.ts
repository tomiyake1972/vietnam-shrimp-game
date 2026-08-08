// ShrimpX V2 — 相談役AI（Management Advisor AI）MVP  情報のsource tag / authority
//
// 【なぜ2軸に分けるか（実装指示§22・§23）】
//   sourceType  = 「その情報が何であるか」（実測値／Standard AIの観測／ゲーム内部の真値／
//                  正式仕様／開発履歴／作業資料／AIの推論／人間の入力）
//   authority   = 「その情報がどれだけ正式か」（正式版／現行実装／作業中／過去／推論）
//
// 2軸あることで、「古いmanual（FORMAL_SPEC × HISTORICAL）」と
// 「現在のコード（FORMAL_SPEC × CURRENT_IMPLEMENTATION）」が矛盾したときに、
// どちらを優先すべきかを機械的に整理できる。1軸だと両者が同じ「仕様」に潰れてしまう。

/** 情報の種類。 */
export const SOURCE_TYPES = [
  /** プレイヤー・Standard AIの双方が見られる公開情報。 */
  "PUBLIC_INFO",
  /** Standard AIが実際に観測して判断に使った値。 */
  "STANDARD_AI_OBSERVED",
  /** ゲームエンジン内部の真の値（Owner Modeでのみ露出する。プレイヤーには見えない）。 */
  "GAME_INTERNAL_TRUE",
  /** 正式仕様（GitHub上の仕様書・現行コード）。 */
  "FORMAL_SPEC",
  /** 開発履歴（development diary・phase report・設計判断メモ）。 */
  "DEVELOPMENT_HISTORY",
  /** 共同作業資料（Google Drive等。正式版ではない）。 */
  "WORKING_MATERIAL",
  /** 相談役AI自身の推論・意見。事実ではない。 */
  "AI_INFERENCE",
  /** 人間（ゲームオーナー）が会話の中で提供した情報。 */
  "HUMAN_PROVIDED",
  /**
   * 【将来用】反実仮想・将来シナリオの計算結果。MVPでは一切使わない
   * （what-ifの数値を出さないため。実装指示§29）。型としてのみ用意する。
   */
  "FUTURE_SCENARIO",
] as const;

export type AdvisorSourceType = (typeof SOURCE_TYPES)[number];

/** 情報の正式度。矛盾したときの優先順位でもある（上ほど強い）。 */
export const SOURCE_AUTHORITIES = [
  /** 現行の実装コードそのもの。実際に動いている挙動であり、最も強い。 */
  "CURRENT_IMPLEMENTATION",
  /** GitHub上の正式文書（現行仕様として維持されているもの）。 */
  "FORMAL",
  /** 作業資料・分析メモ・briefing（Google Drive等を含む）。正式版ではない。 */
  "WORKING",
  /** 過去の資料。現行仕様の説明には使わないが、経緯の説明には積極的に使う。 */
  "HISTORICAL",
  /** 相談役AIの推論。文書上の裏づけが無い。 */
  "INFERENCE",
] as const;

export type AdvisorSourceAuthority = (typeof SOURCE_AUTHORITIES)[number];

/**
 * authorityの優先順位（数値が小さいほど優先）。同一論点で複数の資料が食い違った場合に、
 * どれを「現行仕様」として提示すべきかを決めるために使う。
 * 実装指示§12の優先順位（GitHub正式文書・現行実装 > Drive作業資料 > 過去資料）に対応する。
 */
export const AUTHORITY_RANK: Readonly<Record<AdvisorSourceAuthority, number>> = {
  CURRENT_IMPLEMENTATION: 0,
  FORMAL: 1,
  WORKING: 2,
  HISTORICAL: 3,
  INFERENCE: 4,
};

export function compareAuthority(a: AdvisorSourceAuthority, b: AdvisorSourceAuthority): number {
  return AUTHORITY_RANK[a] - AUTHORITY_RANK[b];
}

export function isSourceType(value: unknown): value is AdvisorSourceType {
  return typeof value === "string" && (SOURCE_TYPES as readonly string[]).includes(value);
}

export function isSourceAuthority(value: unknown): value is AdvisorSourceAuthority {
  return typeof value === "string" && (SOURCE_AUTHORITIES as readonly string[]).includes(value);
}
