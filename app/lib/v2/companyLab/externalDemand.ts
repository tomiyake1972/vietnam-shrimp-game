// ShrimpX V2 — 会社経営統合テスト環境（Phase 6.3） 外部加工業者需要
//
// 実装指示 §5: 5社の買付意向だけでベトナム国全体の加工需要を置き換えない。
//   国内価格形成用総買付意向 = 外部加工業者需要 + 5社の信認済み買付意向
//
// 5社はベトナム加工業界の20〜30%、外部加工業者が70〜80%を占める暫定設定から
// 開始する。外部需要は固定数量ではなく、次の要因に反応する決定論的な純粋関数
// として実装する（乱数不使用）:
//   - 世界需要・景気: worldDemandIndex（需要市場の前期消費×景気指数の合計を
//     基準値で割った指数）に比例して増減する。
//   - 国内供給・疾病: 供給減少（疾病等）は国内原料価格の上昇として現れ、
//     前期国内価格が基準価格を上回るほど外部需要が減る（価格弾力性チャネル。
//     需給の自己安定化にも寄与する）。
//
// これはPhase 9のAI会社でも本番の業界モデルでもなく、companyLabテスト環境の
// 交換可能な暫定集計モデルである（数値はすべて要校正の暫定値）。

import { HosoEqTons, hosoEqTons, roundHosoEqTons } from "../core/units";

export interface ExternalProcessorDemandAssumptions {
  /**
   * 基準となるベトナム国内原料供給量（HOSO換算トン/四半期）。シナリオbaselineの
   * 国全体供給（約450,000トン/四半期）を基準とする。外部需要の絶対水準の
   * アンカーであり、当期供給そのものには連動させない（供給減少の効果は価格
   * チャネル経由で表現し、需要と供給が機械的に比例して価格反応が消えることを
   * 防ぐ）。
   */
  readonly referenceDomesticSupplyTons: number;
  /** 外部加工業者需要の基準シェア（基準供給量に対する比率）。 */
  readonly baseShareOfReferenceSupply: number;
  /** 前期国内原料価格に対する需要の価格弾力性（正の値。価格高→需要減）。 */
  readonly priceElasticity: number;
  /** 価格弾力性の基準価格（USD/HOSO換算kg）。 */
  readonly referencePriceUsdPerHosoEqKg: number;
  /** 世界需要指数に対する弾力性（正の値。世界需要増→外部需要増）。 */
  readonly worldDemandElasticity: number;
  /** 需要シェアのクランプ範囲（基準供給量に対する比率）。 */
  readonly minShareOfReferenceSupply: number;
  readonly maxShareOfReferenceSupply: number;
}

export interface ExternalProcessorDemandInput {
  /** 前期のベトナム国内原料価格（USD/HOSO換算kg）。turn 1等で未知の場合はundefined。 */
  readonly priorVietnamDomesticPrice?: number;
  /**
   * 世界需要指数（1.0=基準）。需要市場の前期消費×景気指数の合計を基準値で
   * 割った値等、呼び出し側が決定論的に算出して渡す。未指定時は1.0。
   */
  readonly worldDemandIndex?: number;
}

/**
 * 外部加工業者の国内買付意向（業界集計値、HOSO換算トン/四半期）を算出する。
 * turn/runner.tsのDomesticPurchaseIntentSource.externalIntentへ渡す。
 */
export function calculateExternalProcessorIntent(
  input: ExternalProcessorDemandInput,
  assumptions: ExternalProcessorDemandAssumptions
): HosoEqTons {
  const priceFactor =
    input.priorVietnamDomesticPrice !== undefined && input.priorVietnamDomesticPrice > 0
      ? 1 -
        assumptions.priceElasticity *
          ((input.priorVietnamDomesticPrice - assumptions.referencePriceUsdPerHosoEqKg) /
            assumptions.referencePriceUsdPerHosoEqKg)
      : 1;
  const worldFactor = 1 + assumptions.worldDemandElasticity * ((input.worldDemandIndex ?? 1) - 1);

  const share = Math.min(
    assumptions.maxShareOfReferenceSupply,
    Math.max(assumptions.minShareOfReferenceSupply, assumptions.baseShareOfReferenceSupply * priceFactor * worldFactor)
  );
  return hosoEqTons(roundHosoEqTons(Math.max(0, share * assumptions.referenceDomesticSupplyTons)));
}
