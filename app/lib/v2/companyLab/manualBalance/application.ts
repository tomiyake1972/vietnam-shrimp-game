// ShrimpX V2 — 手動バランス調整の「適用記録」
//
// 【このファイルの責務】そのTurnに何が適用され、補正前後がいくらだったかを
// Runへ保存するための記録型。
//
// 【適用の算術はここに書かない】指数を価格へ掛ける算術と制約外警告の判定は
// market/manualPriceIndex.ts が唯一のSSoTである（販売側・原料側の双方から
// 同じ関数を通すことで「片方だけ複利になっていた」種の事故を防ぐ）。
// このファイルはその結果を記録形式へ整えるだけで、再計算はしない。

import type { ManualPriceIndexAuditWarning } from "../../market/manualPriceIndex";

/** 監査警告にTurnを添えた保存形式。 */
export interface ManualBalanceAuditWarning extends ManualPriceIndexAuditWarning {
  readonly turn: number;
}

/**
 * そのTurnに実際に適用された手動設定の記録（Runへ保存する単位）。
 *
 * 【保存値・実装指示の明示要件】原料は4フィールドを個別に保持し、1つに潰さない。
 * 販売も補正前／指数／適用後を区別して保持する。
 */
export interface ManualBalanceAppliedRecord {
  readonly turn: number;
  /** 適用値を決めたエントリの種別（"none" なら手動補正なし）。 */
  readonly appliedSourceKind: "none" | "perTurn" | "continuing";

  // --- 原料市場価格（4フィールドを個別保持） ---
  /** Scenario/DS2由来の捕捉指数（市場清算の内側で効く。手動指数とは別物）。 */
  readonly scenarioRawPriceCaptureIndex: number;
  /** 通常の市場清算が確定させた、手動補正前の価格。 */
  readonly preManualRawMarketPrice: number;
  /** 適用した手動原料市場価格指数（100が中立）。 */
  readonly manualRawMarketPriceIndex: number;
  /** 手動指数適用後の価格（再クランプしていない値）。当Turnの新規調達はこれを使う。 */
  readonly appliedRawMarketPrice: number;

  // --- 販売市場価格 ---
  /** 適用した手動販売市場価格指数（100が中立）。 */
  readonly manualSalesPriceIndex: number;
  /** 補正前の販売基準価格（市場ID → 商品 → USD/HOSO換算kg）。 */
  readonly preManualSalesReferencePrices: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** 適用後の販売基準価格（同上）。 */
  readonly appliedSalesReferencePrices: Readonly<Record<string, Readonly<Record<string, number>>>>;

  // --- 配当性向 ---
  /**
   * そのTurnにStandard AIへ渡した配当性向。
   * null は「手動指定なし（既定値＋経営性格バイアスのまま）」。
   * 0 は「明示的に0%を指定した（配当しない）」であり、null とは意味が異なる。
   */
  readonly manualDividendPayoutRatio: number | null;

  readonly warnings: readonly ManualBalanceAuditWarning[];
}

export type { ManualPriceIndexAuditWarning };
