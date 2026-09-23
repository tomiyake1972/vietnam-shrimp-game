// ShrimpX V2 — ENG-SALES-MODEL-PERSIST-2 販売モデル registry（immutable / versioned）
//
// 【なぜ必要か】三層顧客モデル（tiered）で開始した Lab を保存して resume すると、
// 保存済み config から SalesParameters を復元できず legacy へ戻ってしまう問題があった。
// SalesParameters 全体を保存すると Redis payload が肥大し（実測 +5,206 bytes/lab）、
// API が任意の JSON を受け取ることにもなるため、**小さな versioned ID だけを保存し、
// この registry で immutable な定数へ解決する**（設計監査 ENG-SALES-MODEL-PERSIST-1 の A3 案）。
//
// 【immutable / versioned の規約（最重要）】
//   一度この registry へ入れた ID の指す SalesParameters は**今後一切書き換えない**。
//   再校正した場合は "tiered-v200-candidate-v2" のように **新しい ID を追加**し、
//   既存 ID は旧定数を指したまま残す。既存 ID を新しい parameter へ付け替えることは
//   禁止する（保存済み Run の resume 結果が後から変わってしまうため）。
//   この規約は sales/__tests__/salesModelsFrozen.test.ts の canonical snapshot が
//   機械的に守る（既存 ID の値を変えた瞬間に CI が落ちる）。
//
// 【legacy ID の扱い】"legacy-waterfall-v1" は「単一の固定 SalesParameters」ではなく
// **現行の legacy variant 解決ロジックそのもの**を指す。config.sai5 の機能フラグ
// （vapProductDevelopmentCompetitiveness / salesBaseAccumulation）に応じて
// V1 / SAI5_SALES_BASE_V1 / TEST15_VAP_CAPABILITY_V1 /
// TEST15_VAP_CAPABILITY_AND_SALES_BASE_V1 のいずれかへ解決される。
// legacy を明示指定しても SALES_PARAMETERS_V1 へ固定してしまわないこと
// （既存 Run と挙動が変わってしまう）。

import { SalesParameters, SALES_PARAMETERS_TIERED_V200_CANDIDATE_V1 } from "./parameters";
import { CROWDING_POLICY_V200_P1, CrowdingPolicy } from "./crowding";

/**
 * 保存・API 受理の対象となる販売モデル ID。
 *
 * - "legacy-waterfall-v1"       … 現行の水位法（legacy variant 解決ロジック）
 * - "tiered-v200-candidate-v1"  … 三層顧客＋全社同時配分 V2.00 calibrated candidate
 *                                 （Crowding なし。既存 Run の意味を変えないため永久に据え置く）
 * - "tiered-v200-crowding-v1"   … 上と同じ三層顧客価格モデル ＋ V2.00 正式 Crowding
 *                                 policy（CROWDING_POLICY_V200_P1）
 */
export type SalesModelId = "legacy-waterfall-v1" | "tiered-v200-candidate-v1" | "tiered-v200-crowding-v1";

export const SALES_MODEL_IDS: readonly SalesModelId[] = [
  "legacy-waterfall-v1",
  "tiered-v200-candidate-v1",
  "tiered-v200-crowding-v1",
];

/** ID が registry に存在するか（API・schema の allowlist 判定に使う）。 */
export function isSalesModelId(value: unknown): value is SalesModelId {
  return typeof value === "string" && (SALES_MODEL_IDS as readonly string[]).includes(value);
}

/** registry の1エントリ。 */
export interface SalesModelDefinition {
  readonly salesModelId: SalesModelId;
  /** 表示・ログ用の短い説明（挙動には影響しない）。 */
  readonly description: string;
  /**
   * 固定された SalesParameters。
   * undefined の場合は「固定値を持たず、config の機能フラグから legacy variant を解決する」
   * ことを意味する（"legacy-waterfall-v1" のみ）。
   * **一度公開した ID のこの値は書き換えない。**
   */
  readonly parameters?: SalesParameters;
  /**
   * 【ENG-CROWDING-MARKDOWN-3】この販売モデルが使う Crowding policy。
   * undefined は「Crowding を使わない（OFF）」を意味する。
   *
   * **一度公開した ID のこの値も書き換えない**（parameters と同じ規約）。
   * 既存 ID へ後から policy を足すと、その ID で保存済みの Run が resume 時に
   * 別の価格で走ってしまうため禁止する。Crowding を足したい場合は
   * "tiered-v200-crowding-v1" のように **新しい ID を追加**すること。
   */
  readonly crowdingPolicy?: CrowdingPolicy;
}

const SALES_MODEL_DEFINITIONS: Readonly<Record<SalesModelId, SalesModelDefinition>> = {
  "legacy-waterfall-v1": {
    salesModelId: "legacy-waterfall-v1",
    description: "水位法（legacy waterfall）。config.sai5 の機能フラグから既存の variant を解決する。",
    // parameters を持たない＝呼び出し側が legacy variant 解決ロジックへフォールバックする。
  },
  "tiered-v200-candidate-v1": {
    salesModelId: "tiered-v200-candidate-v1",
    description: "三層顧客＋全社同時配分 V2.00 calibrated candidate（15セル demandShare・anchor qualitySensitivity 校正済み）。",
    parameters: SALES_PARAMETERS_TIERED_V200_CANDIDATE_V1,
    // 【ENG-CROWDING-MARKDOWN-3】**この ID へ Crowding policy を後付けしない。**
    // 保存済み Run の salesModelId の意味が変わってしまうため（registry の immutable 規約）。
    // Crowding 付きが必要なら "tiered-v200-crowding-v1" を使う。
  },
  "tiered-v200-crowding-v1": {
    salesModelId: "tiered-v200-crowding-v1",
    description:
      "三層顧客＋全社同時配分 V2.00（candidate-v1 と同一の SalesParameters）＋ 市場集中による価格下落 P1。",
    // 販売パラメータは candidate-v1 と**同一の定数をそのまま参照**する
    // （別値を新規に作らない。三層顧客価格モデルとしての挙動は変えない）。
    parameters: SALES_PARAMETERS_TIERED_V200_CANDIDATE_V1,
    crowdingPolicy: CROWDING_POLICY_V200_P1,
  },
};

/** 未知 ID は解決時にも必ず失敗させる（silent fallback を作らない）。 */
export class UnknownSalesModelIdError extends Error {
  constructor(readonly received: unknown) {
    super(
      `未知の salesModelId です: ${JSON.stringify(received)}。` +
        `使用できるのは次のいずれかです: ${SALES_MODEL_IDS.join(", ")}。` +
        `（既定へ黙ってフォールバックせず、必ず失敗させます。）`
    );
    this.name = "UnknownSalesModelIdError";
  }
}

export function salesModelDefinitionForId(salesModelId: SalesModelId): SalesModelDefinition {
  const definition = SALES_MODEL_DEFINITIONS[salesModelId];
  if (definition === undefined) throw new UnknownSalesModelIdError(salesModelId);
  return definition;
}

/**
 * ID から固定 SalesParameters を解決する。
 * 固定値を持たないモデル（legacy）では undefined を返し、呼び出し側が
 * 既存の legacy variant 解決ロジックを使う。
 */
export function salesParametersForModelId(salesModelId: SalesModelId): SalesParameters | undefined {
  return salesModelDefinitionForId(salesModelId).parameters;
}

/**
 * 【ENG-CROWDING-MARKDOWN-3】ID から Crowding policy を解決する。
 *
 * これが V2.00 正式 P1 の SSoT である。保存されるのは salesModelId だけなので、
 * save → load → resume しても **salesModelId だけから P1 を一意に復元できる**
 * （config へ CrowdingPolicy オブジェクトを保存する必要がない）。
 *
 * undefined を返すモデル（legacy-waterfall-v1 / tiered-v200-candidate-v1）は
 * Crowding OFF であり、既存挙動がそのまま維持される。
 */
export function crowdingPolicyForModelId(salesModelId: SalesModelId): CrowdingPolicy | undefined {
  return salesModelDefinitionForId(salesModelId).crowdingPolicy;
}
