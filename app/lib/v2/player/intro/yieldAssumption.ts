// ShrimpX V2 — PLAYER-INTRO-1 §3: 加工歩留まり100％の前提（受講者向け文言と、Engineとの照合）
//
// 【三宅さん確定方針】本ゲームは複雑さを抑えるため、エビ原料から製品への加工
// 歩留まりを省略し、HOSO・PD・VAPとも100％として数量換算する。
//
// 【Engineとの照合結果（コードから確認した事実）】
//   1. すべての契約数量・原料数量・完成品在庫・能力はHOSO換算トンで統一されている。
//      HOSO換算という単位変換の時点で頭・殻の除去による重量減少を織り込んでいるため、
//      production/yieldConversion.ts の physicalYieldRatio（hoso 1.00 / pd 0.54 /
//      vap 未定義）は**参考値専用**であり、履行・在庫・能力判定のいずれにも使われない
//      （永続フィールドにも書かれない）。
//   2. 原料HOSO換算量 → 完成品HOSO換算量の換算に実際に使われるのは
//      production/parameters.ts の saleableRecoveryRatio であり、基準値は全商品 1.00。
//      したがって通常操業では「原料1t = 製品1t」が厳密に成立する。
//   3. ただし saleableRecoveryRatio は品質事故の廃棄で 1.00 を下回りうる
//      （quality/qualityOutcome.ts: clamp(1 - discardRatio, minimumSaleableRecoveryRatio, 1)）。
//      これは加工歩留まりではなく「廃棄による真の損失」であり、下限は
//      quality/parameters.ts の minimumSaleableRecoveryRatio でフロアされる。
//
// このモジュールは文言と、照合を破らないための定数参照だけを持つ。
// Engineのパラメータも式も一切変更しない。

import { Product } from "../../market/types";
import { PRODUCTION_PARAMETERS_V1, ProductionParameters } from "../../production/parameters";
import { QUALITY_PARAMETERS_V1, QualityParameters } from "../../quality/parameters";

export const PRODUCTS_FOR_YIELD: readonly Product[] = ["hoso", "pd", "vap"];

/** 受講者向けの見出し。導入の冒頭カードで使う。 */
export const YIELD_ASSUMPTION_HEADING = "このゲームと実際のエビ事業の重要な違い";

/** 受講者向けの本文（§3の指定文をそのまま使う）。 */
export const YIELD_ASSUMPTION_BODY: readonly string[] = [
  "このゲームでは、加工歩留まりを100％として扱います。",
  "原料1tは製品1tとして数量換算し、頭・殻の除去などによる加工重量の減少は計算しません。HOSO・PD・VAPとも同じ前提です。",
  "生産数量を計画するとき、現実の歩留まりで原料必要量を割り戻さないでください。",
];

/** 受講者向けの例示（§3の指定文をそのまま使う）。 */
export const YIELD_ASSUMPTION_EXAMPLE =
  "例：PDを1,000t生産する計画は、加工歩留まりによる割増なしで原料1,000t分として考えます。" +
  "ただし、設備・人員・原料の利用可能量などの制約は別にあります。";

/** 原料調達・生産画面へ置く短い注記。 */
export const YIELD_ASSUMPTION_SHORT_NOTE =
  "加工歩留まりは100％です。原料1t＝製品1tとして数量を考えてください（現実の歩留まりで割り戻さない）。";

/**
 * 品質事故による廃棄の注記。
 * 「歩留まり100％」を言い切ったうえで、数量が減りうる唯一の経路を正直に示す。
 * 加工歩留まりの話ではないことを明示する。
 */
export function buildQualityDiscardNote(
  qualityParams: QualityParameters = QUALITY_PARAMETERS_V1
): string {
  const floorPercent = Math.round(qualityParams.qualityOutcome.minimumSaleableRecoveryRatio * 100);
  return (
    "ひとつだけ例外があります。品質事故が起きた四半期は、廃棄になった分だけ完成品の数量が減ります" +
    `（通常の操業では減りません。減る場合も生産量の${floorPercent}％までで下げ止まります）。` +
    "これは加工歩留まりではなく、事故による損失です。"
  );
}

/** 歩留まり100％の前提がEngineと一致しているか（表示前の自己点検に使う）。 */
export interface YieldAssumptionCheck {
  /** 全商品の saleableRecoveryRatio が 1.00 であること。 */
  readonly saleableRecoveryRatioIsUnityForAllProducts: boolean;
  readonly saleableRecoveryRatioByProduct: Readonly<Record<Product, number>>;
  /** 参考値専用の physicalYieldRatio（数量換算には使われない）。 */
  readonly referenceOnlyPhysicalYieldRatio: Readonly<Partial<Record<Product, number>>>;
  /** 品質事故の廃棄で下回りうる下限。 */
  readonly qualityDiscardFloorRatio: number;
}

export function checkYieldAssumption(
  productionParams: ProductionParameters = PRODUCTION_PARAMETERS_V1,
  qualityParams: QualityParameters = QUALITY_PARAMETERS_V1
): YieldAssumptionCheck {
  const byProduct = productionParams.yield.saleableRecoveryRatio;
  return {
    saleableRecoveryRatioIsUnityForAllProducts: PRODUCTS_FOR_YIELD.every((p) => byProduct[p] === 1),
    saleableRecoveryRatioByProduct: byProduct,
    referenceOnlyPhysicalYieldRatio: productionParams.yield.physicalYieldRatio,
    qualityDiscardFloorRatio: qualityParams.qualityOutcome.minimumSaleableRecoveryRatio,
  };
}
