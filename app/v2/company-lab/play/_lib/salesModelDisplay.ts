// ShrimpX V2 — UI-SALES-MODEL-SELECT-1: 販売市場モデルの表示用ラベル・説明文
//
// 【新しい計算・新しい販売モデルは作らない】ここはapp/lib/v2/sales/salesModels.ts
// （唯一のfrozen registry。ENG-SALES-MODEL-PERSIST-2）が既に持つSalesModelIdへ、
// 管理者向けの日本語ラベル・説明文を対応させるだけの表示専用モジュールである。
// registry自体・エンジンの分岐（salesParametersFor）には一切触れない。

import { SalesModelId } from "../../../../lib/v2/sales/salesModels";

/** Lab作成フォーム・Lab詳細画面の両方で共有する、唯一の表示ラベル対応表。 */
export const SALES_MODEL_DISPLAY_LABELS: Readonly<Record<SalesModelId, string>> = {
  "legacy-waterfall-v1": "従来市場モデル",
  "tiered-v200-candidate-v1": "三層顧客価格モデル V2.00候補",
};

/** Lab作成フォームの選択肢説明文（挙動には影響しない表示専用テキスト）。 */
export const SALES_MODEL_DESCRIPTIONS: Readonly<Record<SalesModelId, string>> = {
  "legacy-waterfall-v1": "現在の従来方式で市場配分を行います。",
  "tiered-v200-candidate-v1": "価格重視・標準・プレミアムの3種類の顧客を使い、価格・品質・差別化などから成約を配分します。",
};

/** Lab作成フォームでの既定選択（未指定時のAPI挙動＝legacyと一致させる）。 */
export const DEFAULT_SALES_MODEL_ID: SalesModelId = "legacy-waterfall-v1";

/**
 * 【MANAGEMENT-CONSOLE-SALES-MODEL-1】保存済みconfigのsalesModelId（未設定＝
 * この機能より前に作られたRun／従来市場モデル）から、画面へ出す日本語ラベルを返す。
 *
 * 未設定を legacy として扱う根拠は runner.ts:salesParametersFor と同一である
 * （config.salesModelId が undefined のとき tiered registry を引かず legacy variant
 * 解決へ落ちる）。ここで新しい既定値・新しい意味づけを作っていない。
 *
 * Company Lab詳細画面・Management Console・PLAYER Workspaceがすべてこの1関数を
 * 通ることで、「今どの販売市場モデルで動いているか」の表示が1箇所に定まる。
 */
export function salesModelDisplayLabelFor(salesModelId: SalesModelId | undefined): string {
  return SALES_MODEL_DISPLAY_LABELS[salesModelId ?? DEFAULT_SALES_MODEL_ID];
}
