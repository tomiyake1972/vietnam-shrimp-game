// ShrimpX V2 — 手動価格指数の適用（純粋関数・市場レイヤ）
//
// 【このファイルの責務】Management Console の手動バランス調整で指定された
// 価格指数を、確定済みの市場価格へ**1回だけ**掛ける算術と、その結果が既存の
// 市場制約の外側へ出たことを示す監査警告の判定。
//
// 【市場レイヤに置く理由】market/index.ts と market/destinationPricing.ts の
// 双方から使う。適用の算術が2か所に分かれると「販売側だけ複利になっていた」
// 種の事故が起きるため、指数の意味（100が中立）と掛け方をこの1ファイルに集約する。
// companyLab 側（設定の解決・保存）はこのファイルを import する（逆向きはしない）。
//
// 【複利化しない構造】適用関数は「そのTurnの補正前価格」と「そのTurnの指数」しか
// 引数に取れない。前Turnの適用後価格を渡す口が無いため、継続指数95は
// 毎Turn独立に「そのTurnの通常計算価格 × 0.95」となり、0.95^n にはならない。

/** 手動価格指数の中立値。100 = 補正なし。 */
export const MANUAL_PRICE_INDEX_NEUTRAL = 100;

/**
 * 適用後価格が既存の市場制約の外側に出たことを示す監査警告。
 * 【値は上書きしない】指定倍率を厳密に保つため再クランプはせず、警告だけを残す。
 */
export interface ManualPriceIndexAuditWarning {
  readonly code: "RAW_APPLIED_PRICE_BELOW_FARMER_RESERVATION" | "RAW_APPLIED_PRICE_ABOVE_BUYING_CEILING";
  /** 画面へそのまま出せる日本語の説明。 */
  readonly message: string;
  /** 監査用の実測値。 */
  readonly keyValues: Readonly<Record<string, number>>;
}

/**
 * 確定済みの価格へ手動指数を1回だけ掛ける。
 *
 * 指数が中立(100)のときは `value * (100 / 100)` = `value * 1` となり、
 * IEEE754上も元の値と厳密に同値（既存挙動とビット単位で一致する）。
 */
export function applyManualPriceIndex(preManualPrice: number, manualPriceIndex: number): number {
  return preManualPrice * (manualPriceIndex / MANUAL_PRICE_INDEX_NEUTRAL);
}

/**
 * 原料市場価格へ手動指数を適用した結果が、既存の市場制約
 * （農家留保価格・買付上限）の外側に出ていないかを判定する。
 *
 * 中立時は判定そのものを行わない（既存の市場清算が制約内を保証しているため、
 * 警告が出る余地が無い）。
 */
export function detectManualRawPriceWarnings(input: {
  readonly preManualRawMarketPrice: number;
  readonly manualRawMarketPriceIndex: number;
  readonly appliedRawMarketPrice: number;
  readonly farmerReservationPrice: number;
  readonly buyingCeiling: number;
}): readonly ManualPriceIndexAuditWarning[] {
  const {
    preManualRawMarketPrice,
    manualRawMarketPriceIndex,
    appliedRawMarketPrice,
    farmerReservationPrice,
    buyingCeiling,
  } = input;

  if (manualRawMarketPriceIndex === MANUAL_PRICE_INDEX_NEUTRAL) return [];

  const warnings: ManualPriceIndexAuditWarning[] = [];
  if (appliedRawMarketPrice < farmerReservationPrice) {
    warnings.push({
      code: "RAW_APPLIED_PRICE_BELOW_FARMER_RESERVATION",
      message:
        `手動原料市場価格指数${manualRawMarketPriceIndex}の適用後価格が農家留保価格を下回りました。` +
        `指定倍率を厳密に保つため再クランプしていません（通常の市場計算では到達しない水準です）。`,
      keyValues: { appliedRawMarketPrice, farmerReservationPrice, preManualRawMarketPrice, manualRawMarketPriceIndex },
    });
  }
  if (appliedRawMarketPrice > buyingCeiling) {
    warnings.push({
      code: "RAW_APPLIED_PRICE_ABOVE_BUYING_CEILING",
      message:
        `手動原料市場価格指数${manualRawMarketPriceIndex}の適用後価格が買付上限を上回りました。` +
        `指定倍率を厳密に保つため再クランプしていません（加工採算が成立しない水準です）。`,
      keyValues: { appliedRawMarketPrice, buyingCeiling, preManualRawMarketPrice, manualRawMarketPriceIndex },
    });
  }
  return warnings;
}

/** 指数として受け付けられる値か（有限かつ正）。 */
export function isUsableManualPriceIndex(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}
