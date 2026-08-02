// ShrimpX V2 — 商品別の仕向市場価格係数の時間発展（加工品市場進化 §c）
//
// 【監査で特定した構造的ブロッカー】
// market/consumerInventory.ts の deriveNextQuarterDestinationPriceCoefficients は、
//     const factor = 1 + adjustmentRatio;
//     baseValueCoefficient  = base.baseValueCoefficient  * factor;
//     pdPremiumCoefficient  = base.pdPremiumCoefficient  * factor;
//     vapPremiumCoefficient = base.vapPremiumCoefficient * factor;
// と、**3つの係数すべてへ同一の倍率**を掛けていた。このため
// 「PDプレミアムは圧縮されるがVAPプレミアムは維持・上昇する」という
// 競争軸の移動が、市場別価格の側では構造的に表現できなかった
// （docs/v2/design/processed_market_evolution_audit.md §3）。
//
// 【このモジュールの解決方法】既存の共通倍率（在庫・購買圧力由来）はそのまま
// 残したうえで、その上に **商品別の傾き（tilt）** を掛ける。
//
//     baseValueCoefficient_next  = base.base × factorCommon
//     pdPremiumCoefficient_next  = base.pd   × factorCommon × (1 + pdShiftWeight  × pdTilt_m)
//     vapPremiumCoefficient_next = base.vap  × factorCommon × (1 + vapShiftWeight × vapTilt_m)
//
// 【tilt の情報源と、二重計上を避けた理由】
// tilt は「その市場の需要構成がゲーム開始時点からどれだけその商品へ寄ったか」
// （market/productLifecycle.ts の構成比の turn1 からの変化）である。
//
//  - 世界のPD/VAP需給逼迫度（世界稼働率）は **使わない**。それは既に
//    market/productPremium.ts が utilizationMultiplier としてプレミアムへ
//    反映しており、ここで再度使うと同じ因果を二重に計上してしまう。
//  - 逆に「市場ごとの需要構成の移動」は、現在どの価格経路にも入っていない
//    唯一の未使用シグナルであり、実装指示が挙げるプレミアム要因のうち
//    「消費者の所得・物価水準」「家庭内調理の減少」「外食の厨房人件費」
//    「市場ごとのニーズ適合」を市場別に凝縮した観測量にあたる。
//
// 【時間順序】tilt は当期の構成比（当期の需要側入力）から作り、出力は
// **次四半期の**新規成約の基準価格にのみ使う。成立済み契約の単価は
// 成約時スナップショットのまま変わらない（consumerInventory.ts と同じ規約）。
//
// 【決定論】純粋関数のみ。乱数不使用。

import { DEMAND_MARKET_IDS, DemandMarketId } from "./types";
import {
  DestinationMarketPriceCoefficients,
  DestinationMarketPriceCoefficientTable,
} from "./destinationPricingParameters";
import { MarketProductMix } from "./productLifecycle";

export interface DestinationPricingEvolutionParameters {
  /**
   * PD構成比が turn1 から 1.0pt 寄ったときに、PDプレミアム係数を何倍動かすか。
   * 単位: 係数倍率の変化 ÷ 構成比pt。
   * 【初期値の意図】PDは相対的にコモディティ化しており、需要構成が寄っても
   * プレミアム係数の反応は小さい（VAPの半分以下）。
   */
  readonly pdShiftWeight: number;
  /**
   * VAP構成比が turn1 から 1.0pt 寄ったときに、VAPプレミアム係数を何倍動かすか。
   * 【初期値の意図】VAPは「その市場が本当にVAPを求めているか」で価値が大きく
   * 変わる（日本の厨房人件費・米国の家庭内調理減少など）。PDより強く反応させる。
   */
  readonly vapShiftWeight: number;
  /** 商品別tiltによる係数倍率の下限・上限（暴走防止。1.0が中立）。 */
  readonly tiltMultiplierFloor: number;
  readonly tiltMultiplierCap: number;
  /** 最終的な各係数の下限・上限（既存の固定係数に対する倍率としての範囲）。 */
  readonly coefficientMultiplierFloor: number;
  readonly coefficientMultiplierCap: number;
}

/**
 * 【加工品市場進化 v1 初期値・要校正】
 *
 * 単位・意味・範囲:
 *  - pdShiftWeight / vapShiftWeight: 無次元（係数倍率の変化 ÷ 構成比pt）。
 *    構成比の実際の移動幅は最大でも 0.20pt 程度（JP.vap 0.10→0.30）なので、
 *    vapShiftWeight=1.2 なら VAPプレミアム係数は最大 +24% 動く。
 *    pdShiftWeight=0.4 なら PD側は最大でも +7% 程度（CN.pd 0.12→0.30 で +7.2%）。
 *  - tiltMultiplier の範囲 0.85〜1.30: 需要構成の移動だけで価格が倍になったり
 *    半分になったりしないための安全域。
 *  - coefficientMultiplier の範囲 0.70〜1.45: 共通倍率（在庫・購買圧力）と
 *    商品別tiltの**合成**がこの範囲を出ないようにする最終クランプ。
 *    これが SAI-5E のプレミアム倍率フィードバックとの二重圧縮を防ぐ
 *    最後の歯止めになる（コーディネーター判断2「合成を明示的かつ有界に」）。
 */
export const DESTINATION_PRICING_EVOLUTION_PARAMETERS_V1: DestinationPricingEvolutionParameters = {
  pdShiftWeight: 0.4,
  vapShiftWeight: 1.2,
  tiltMultiplierFloor: 0.85,
  tiltMultiplierCap: 1.3,
  coefficientMultiplierFloor: 0.7,
  coefficientMultiplierCap: 1.45,
};

/** 1市場ぶんの係数発展の内訳（説明可能性のための診断構造）。 */
export interface DestinationCoefficientEvolutionBreakdown {
  readonly market: DemandMarketId;
  /** 在庫・購買圧力由来の共通倍率（従来の factor と同じ値）。 */
  readonly commonFactor: number;
  /** turn1からのPD構成比の変化（pt）。 */
  readonly pdMixShift: number;
  /** turn1からのVAP構成比の変化（pt）。 */
  readonly vapMixShift: number;
  /** PDプレミアム係数へ掛けた商品別倍率。 */
  readonly pdTiltMultiplier: number;
  /** VAPプレミアム係数へ掛けた商品別倍率。 */
  readonly vapTiltMultiplier: number;
  /** 最終クランプが実際に発動したか（発動時は合成が範囲外だったことを意味する）。 */
  readonly clampApplied: boolean;
  readonly resultingCoefficients: DestinationMarketPriceCoefficients;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * 共通倍率（既存の deriveNextQuarterDestinationPriceCoefficients が算出したもの）と
 * 当期の市場×商品構成比から、商品別に分かれた次四半期の仕向市場価格係数を作る。
 *
 * @param baseCoefficients 構造的な固定係数（destinationPricingParameters.ts）。書き換えない。
 * @param commonAdjusted   既存の共通倍率を適用済みの係数テーブル
 *                         （deriveNextQuarterDestinationPriceCoefficients の出力）。
 * @param currentMix       当期の市場×商品構成比。
 * @param initialMix       turn1 の市場×商品構成比（tiltの基準点）。
 */
export function deriveProductWiseDestinationPriceCoefficients(
  baseCoefficients: DestinationMarketPriceCoefficientTable,
  commonAdjusted: DestinationMarketPriceCoefficientTable,
  currentMix: MarketProductMix,
  initialMix: MarketProductMix,
  params: DestinationPricingEvolutionParameters = DESTINATION_PRICING_EVOLUTION_PARAMETERS_V1
): {
  readonly coefficients: DestinationMarketPriceCoefficientTable;
  readonly breakdowns: Readonly<Record<DemandMarketId, DestinationCoefficientEvolutionBreakdown>>;
} {
  const coefficients = {} as Record<DemandMarketId, DestinationMarketPriceCoefficients>;
  const breakdowns = {} as Record<DemandMarketId, DestinationCoefficientEvolutionBreakdown>;

  for (const market of DEMAND_MARKET_IDS) {
    const base = baseCoefficients[market];
    // 共通倍率は「共通適用後 ÷ 固定係数」として復元する（既存関数の出力をそのまま
    // 受け取り、同じ計算を再実装しない＝式の分岐を作らないため）。
    const commonFactor = base.baseValueCoefficient > 0 ? commonAdjusted[market].baseValueCoefficient / base.baseValueCoefficient : 1;

    const pdMixShift = currentMix[market].pd - initialMix[market].pd;
    const vapMixShift = currentMix[market].vap - initialMix[market].vap;

    const pdTiltMultiplier = clamp(1 + params.pdShiftWeight * pdMixShift, params.tiltMultiplierFloor, params.tiltMultiplierCap);
    const vapTiltMultiplier = clamp(1 + params.vapShiftWeight * vapMixShift, params.tiltMultiplierFloor, params.tiltMultiplierCap);

    const rawBaseMultiplier = commonFactor;
    const rawPdMultiplier = commonFactor * pdTiltMultiplier;
    const rawVapMultiplier = commonFactor * vapTiltMultiplier;

    const baseMultiplier = clamp(rawBaseMultiplier, params.coefficientMultiplierFloor, params.coefficientMultiplierCap);
    const pdMultiplier = clamp(rawPdMultiplier, params.coefficientMultiplierFloor, params.coefficientMultiplierCap);
    const vapMultiplier = clamp(rawVapMultiplier, params.coefficientMultiplierFloor, params.coefficientMultiplierCap);

    const clampApplied =
      Math.abs(baseMultiplier - rawBaseMultiplier) > 1e-12 ||
      Math.abs(pdMultiplier - rawPdMultiplier) > 1e-12 ||
      Math.abs(vapMultiplier - rawVapMultiplier) > 1e-12;

    const resulting: DestinationMarketPriceCoefficients = {
      baseValueCoefficient: base.baseValueCoefficient * baseMultiplier,
      pdPremiumCoefficient: base.pdPremiumCoefficient * pdMultiplier,
      vapPremiumCoefficient: base.vapPremiumCoefficient * vapMultiplier,
    };

    coefficients[market] = resulting;
    breakdowns[market] = {
      market,
      commonFactor,
      pdMixShift,
      vapMixShift,
      pdTiltMultiplier,
      vapTiltMultiplier,
      clampApplied,
      resultingCoefficients: resulting,
    };
  }

  return { coefficients, breakdowns };
}
