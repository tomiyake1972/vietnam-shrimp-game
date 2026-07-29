// ShrimpX V2 — Phase SAI-1: 標準経営AI基盤 圧力スコア
//
// 実装指示が要求する「巨大なif/elseにしない」構造化のため、意思決定に影響する
// 主要な状態を、独立に評価できる名前つきの圧力・スコアへ切り出す。ここでの
// スコアは0〜1（または一部、上限を設けない比率）の粗い指標であり、SAI-1では
// 精密な重み最適化は行わない（実装指示どおり、後から1箇所で調整できることを
// 優先する）。

import { DemandMarketId } from "../../market/types";
import { CompanyFixture } from "../types";
import { estimateTargetMinimumCashUsd, StandardAiParameters, STANDARD_AI_PARAMETERS_V1 } from "./parameters";
import { ProductAmount, StandardAiObservation, sumProductAmount } from "./types";

export interface PressureScores {
  /** 未履行契約の総量 / 四半期あたり生産能力スケールの2倍。1に近いほど履行圧力が高い。 */
  readonly contractFulfillmentPressure: number;
  /** 商品別の完成品在庫 / 目標在庫。1が目標水準、1を超えると過剰。 */
  readonly finishedGoodsExcessRatioByProduct: ProductAmount;
  /** 原料在庫ポジション（在庫＋パイプライン半分換算）。 */
  readonly rawMaterialInventoryPosition: number;
  /** 現金圧力。0=バッファ十分、1=バッファを大きく下回る。 */
  readonly cashPressure: number;
  /** 借入圧力。0=健全、1以上=会社規模に対し過大な借入。 */
  readonly borrowingPressure: number;
  /** 前期の会社全体の設備稼働率（未知の場合は中立値0.7）。 */
  readonly equipmentUtilizationLastQuarter: number;
  readonly hadPriorQuarterUtilization: boolean;
  /** 前期の会社全体の労働稼働率（未知の場合は中立値0.7）。 */
  readonly laborUtilizationLastQuarter: number;
  /** 市場を前期実績の参照価格合計の降順に並べたもの（未知ならDEMAND_MARKET_IDS既定順）。 */
  readonly marketPriceRanking: readonly DemandMarketId[];
  /** 会社規模連動の最低現金バッファ（USD）。 */
  readonly targetMinimumCashUsd: number;
  /** 想定原料価格（USD/HOSO換算kg、前期実績が無ければ既定値）。 */
  readonly expectedRawPriceUsdPerKg: number;
}

const EPSILON = 1e-6;
const NEUTRAL_UTILIZATION = 0.7;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function computePressureScores(
  observation: StandardAiObservation,
  fixture: CompanyFixture,
  params: StandardAiParameters = STANDARD_AI_PARAMETERS_V1
): PressureScores {
  const totalCapacityScale = sumProductAmount(observation.totalCapacityByProduct);
  const outstandingTotal = sumProductAmount(observation.outstandingContractByProduct);
  const contractFulfillmentPressure = clamp01(outstandingTotal / Math.max(EPSILON, totalCapacityScale * 2));

  const expectedRawPriceUsdPerKg = observation.vietnamDomesticPriorPrice ?? params.defaultExpectedRawPriceUsdPerKg;

  // 目標在庫は「前期実績生産量（未知ならフィクスチャ能力×典型稼働率）」を基準に、
  // 目標四半期数を掛けて算出する（当期の生産計画とは循環参照させない一次近似）。
  const referenceProductionByProduct: ProductAmount = {
    hoso: observation.lastQuarterActualProductionByProduct.hoso ?? observation.totalCapacityByProduct.hoso * params.typicalUtilizationForCashEstimate,
    pd: observation.lastQuarterActualProductionByProduct.pd ?? observation.totalCapacityByProduct.pd * params.typicalUtilizationForCashEstimate,
    vap: observation.lastQuarterActualProductionByProduct.vap ?? observation.totalCapacityByProduct.vap * params.typicalUtilizationForCashEstimate,
  };
  const finishedGoodsExcessRatioByProduct: ProductAmount = {
    hoso: observation.finishedGoodsByProduct.hoso / Math.max(EPSILON, referenceProductionByProduct.hoso * params.finishedGoodsTargetQuarters),
    pd: observation.finishedGoodsByProduct.pd / Math.max(EPSILON, referenceProductionByProduct.pd * params.finishedGoodsTargetQuarters),
    vap: observation.finishedGoodsByProduct.vap / Math.max(EPSILON, referenceProductionByProduct.vap * params.finishedGoodsTargetQuarters),
  };

  const rawMaterialInventoryPosition = observation.rawMaterialAvailable + observation.rawMaterialPipeline * 0.5;

  const targetMinimumCashUsd = estimateTargetMinimumCashUsd(fixture, expectedRawPriceUsdPerKg, params);
  const cashPressure = clamp01(1 - observation.cashUsd / Math.max(EPSILON, targetMinimumCashUsd));

  const scaleForBorrowing = targetMinimumCashUsd / Math.max(EPSILON, params.cashBufferQuarters);
  const borrowingPressure = clamp01(observation.existingLoanBalanceUsd / Math.max(EPSILON, scaleForBorrowing * params.capexMaxLoanToSizeRatio));

  const hadPriorQuarterUtilization = observation.lastQuarterEquipmentUtilizationRate !== undefined;
  const equipmentUtilizationLastQuarter = observation.lastQuarterEquipmentUtilizationRate ?? NEUTRAL_UTILIZATION;
  const laborUtilizationLastQuarter = observation.lastQuarterLaborUtilizationRate ?? NEUTRAL_UTILIZATION;

  const marketPriceRanking = [...observation.markets]
    .sort((a, b) => {
      const priceA = a.referencePriceByProduct ? sumProductAmount(a.referencePriceByProduct) : -1;
      const priceB = b.referencePriceByProduct ? sumProductAmount(b.referencePriceByProduct) : -1;
      return priceB - priceA;
    })
    .map((m) => m.market);

  return {
    contractFulfillmentPressure,
    finishedGoodsExcessRatioByProduct,
    rawMaterialInventoryPosition,
    cashPressure,
    borrowingPressure,
    equipmentUtilizationLastQuarter,
    hadPriorQuarterUtilization,
    laborUtilizationLastQuarter,
    marketPriceRanking,
    targetMinimumCashUsd,
    expectedRawPriceUsdPerKg,
  };
}
