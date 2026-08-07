// ShrimpX V2 — Turn1 国内原料参考価格（Test15の導入ターン向け）
//
// 【なぜ必要か】国内買付の意思決定は「市場清算価格に対する価格調整(priceAdjustment)」で
// 入力するが、ゲーム開始時点ではその基準となる清算価格がプレイヤーに一切見えなかった
// （publicInfo.vietnamDomesticPriorPrice は前四半期の実績であり、turn1では前期が
// 存在しないため 0 になる）。そのため「いくらなら買えるのか全く分からない」状態で
// 買付価格を決めることになっていた。
//
// 【新しい価格を作らないこと】ここで独自の価格を発明することは一切しない。
// 既存の市場エンジンの純粋関数 clearVietnamRawMarket() へ、既存のシナリオ定義が
// 持つturn1の入力（国内供給量・加工経済性・農家経済・初期買付意向）と、シナリオの
// prehistoryが持つベトナムHOSO FOB価格をそのまま渡して清算させ、その結果の
// 清算価格を「参考価格」として読み出すだけである。乱数は使わない
// （clearVietnamRawMarketはRandomStreamを取らない純粋関数）。
//
// 【実際の成立価格との関係】四半期処理では、国内買付の需要側（domesticProcurementIntent）が
// 各社の実際の買付計画で上書きされるため、実際の清算価格はここで算出する参考価格とは
// 一致しないことがある。参考価格はあくまで「シナリオの初期買付意向のもとでの清算価格」
// であり、turn1のプレイヤーに出発点を与えるためのものである。turn2以降は前四半期の
// 実績価格（publicInfo.vietnamDomesticPriorPrice）が使えるため、この参考価格は
// turn1の導入ターンでのみ意味を持つ。

import { UsdPerHosoEqKg, hosoEqTons, unwrapUnit } from "../core/units";
import { MARKET_PARAMETERS_V1 } from "../market/parameters";
import { clearVietnamRawMarket } from "../market/vietnamRawMarket";
import type { VietnamDomesticInput } from "../market/types";
import { getScenarioTurnInput } from "../scenario/scenarioEngine";
import { toMarketQuarterInput } from "../scenario/marketAdapter";
import type { CompanyLabState } from "./types";

/** turn1の国内原料参考価格と、その導出根拠（画面へそのまま表示できる形）。 */
export interface DomesticReferencePrice {
  /** 参考買付価格（USD/HOSO換算kg）。この価格以上を提示すればturn1は通常条件で買える。 */
  readonly referencePriceUsdPerHosoEqKg: number;
  /** 買付上限（加工業者が採算上出せる上限）。 */
  readonly buyingCeilingUsdPerHosoEqKg: number;
  /** 農家留保価格（これを下回ると取引数量そのものが減る）。 */
  readonly farmerReservationPriceUsdPerHosoEqKg: number;
  /** 当期の国内供給量（HOSO換算t）。 */
  readonly domesticSupplyHosoEqTons: number;
  /** シナリオの初期買付意向に基づく実効需要（HOSO換算t）。 */
  readonly effectiveDemandHosoEqTons: number;
  /**
   * このturnで「参考価格以上を提示すれば通常条件で必要量を購入できる」保証が
   * 有効かどうか（turn1のみtrue）。
   */
  readonly guaranteeActive: boolean;
}

/** 保証が有効なturn。導入ターンであるturn1のみ。 */
export const DOMESTIC_PURCHASE_GUARANTEE_TURN = 1;

/**
 * ベトナムHOSO FOB価格と国内原料市場入力から、参考価格（＝市場エンジンの清算価格）を
 * 求める唯一の関数。
 *
 * 【なぜ関数として切り出すか】画面表示に使う値（computeDomesticReferencePrice経由）と、
 * 四半期処理でturn1の保証判定に使う値（companyLab/runner.tsが既に構築済みの市場入力から
 * 直接呼ぶ）が、別々の式で計算されて食い違うことを構造的に防ぐため。両者は必ず
 * この関数を通る。
 */
export function clearDomesticReferencePrice(
  vietnamHosoFobPrice: UsdPerHosoEqKg,
  vietnamDomesticInput: VietnamDomesticInput
): DomesticReferencePriceCore {
  const cleared = clearVietnamRawMarket(vietnamHosoFobPrice, vietnamDomesticInput, MARKET_PARAMETERS_V1);
  return {
    referencePriceUsdPerHosoEqKg: unwrapUnit(cleared.price),
    buyingCeilingUsdPerHosoEqKg: unwrapUnit(cleared.buyingCeiling),
    farmerReservationPriceUsdPerHosoEqKg: unwrapUnit(cleared.farmerReservationPrice),
    domesticSupplyHosoEqTons: unwrapUnit(cleared.supply),
    effectiveDemandHosoEqTons: unwrapUnit(cleared.effectiveDemand),
  };
}

/** clearDomesticReferencePriceの戻り値（guaranteeActiveを除いた本体）。 */
export type DomesticReferencePriceCore = Omit<DomesticReferencePrice, "guaranteeActive">;

/**
 * 指定turnの国内原料参考価格を、既存の市場エンジンから導出する。
 *
 * 取得に失敗した場合（シナリオ定義が当該turnを持たない等）は null を返す。
 * 画面側は「－」を表示し、値を捏造しない。
 */
export function computeDomesticReferencePrice(
  state: CompanyLabState,
  turn: number,
  /**
   * シナリオのprehistory由来のベトナムHOSO FOB価格。companyLab/runner.tsの
   * buildPreviousMarketContextが返すものと同じ値だが、このモジュールがrunnerを
   * importすると循環参照になるため、呼び出し側から渡してもらう。省略された場合は
   * シナリオ定義のprehistoryから直接読む（turn1はこれで正しい値になる）。
   */
  vietnamHosoFobPriceOverride?: UsdPerHosoEqKg
): DomesticReferencePrice | null {
  try {
    const definition = state.scenarioState.definition;
    const scenarioTurnInput = getScenarioTurnInput(state.scenarioState, turn);

    // turn1ではprehistoryのFOB価格・初期買付意向がそのまま当期の市場入力になる
    // （companyLab/runner.ts の buildPreviousMarketContext と同じ規則）。
    const vnFobPrice =
      vietnamHosoFobPriceOverride ?? (definition.prehistory.priorHosoFobPriceUsdPerKg.VN as unknown as UsdPerHosoEqKg);
    const marketInput = toMarketQuarterInput(scenarioTurnInput, {
      priorHosoFobPrice: {
        EC: definition.prehistory.priorHosoFobPriceUsdPerKg.EC as unknown as UsdPerHosoEqKg,
        IN: definition.prehistory.priorHosoFobPriceUsdPerKg.IN as unknown as UsdPerHosoEqKg,
        ID: definition.prehistory.priorHosoFobPriceUsdPerKg.ID as unknown as UsdPerHosoEqKg,
        VN: vnFobPrice,
      },
      // companyLab/runner.ts の buildPreviousMarketContext が turn1 で使うのと同じ初期買付意向。
      domesticProcurementIntent: hosoEqTons(Math.max(0, definition.initialStateOverrides.initialDomesticProcurementIntentHosoEqTons)),
    });

    return {
      ...clearDomesticReferencePrice(vnFobPrice, marketInput.vietnamDomestic),
      guaranteeActive: turn === DOMESTIC_PURCHASE_GUARANTEE_TURN,
    };
  } catch {
    return null;
  }
}
