// ShrimpX V2 — シナリオ→市場モジュール アダプター（Phase 2）
//
// ScenarioTurnInput（シナリオ内部の基礎変数一式）のうち、市場モジュール
// Phase1が実際に受け取れるサブセットだけを MarketQuarterInput へ変換する
// （実装指示 §3「現行モジュールの入力型に無理に変数を追加しない」）。
// 生残率・成育中在庫・放養意欲・農家期待価格・冷凍在庫・物流能力・
// 農家の資金状態はここで意図的に落としている（シナリオ内部状態のまま）。
//
// PreviousMarketContext（前期実績のHOSO FOB価格・業界集計の国内買付意欲）は
// シナリオモジュールが内部で知り得ない値のため、呼び出し側（将来のゲーム
// エンジン）が別途保持して渡す。

import { MarketQuarterInput, CountrySupplyInput, DemandMarketInput } from "../market/types";
import { COUNTRY_IDS, DEMAND_MARKET_IDS } from "../market/types";
import { ratio, usdPerHosoEqKg } from "../core/units";
import { ScenarioTurnInput, PreviousMarketContext } from "./types";

/**
 * ScenarioTurnInputとPreviousMarketContextから、calculateMarketQuarterへ渡す
 * MarketQuarterInputを組み立てる。入力オブジェクトは一切変更しない。
 */
export function toMarketQuarterInput(
  scenarioTurnInput: ScenarioTurnInput,
  previousMarketContext: PreviousMarketContext
): MarketQuarterInput {
  const countries: Record<string, CountrySupplyInput> = {};
  for (const country of COUNTRY_IDS) {
    const c = scenarioTurnInput.countries[country];
    countries[country] = {
      production: c.production,
      exportCapacityRatio: c.exportCapacityRatio,
      aquacultureCostIndex: c.aquacultureCostIndex,
      priorAquacultureCostIndex: c.priorAquacultureCostIndex,
      qualityScore: c.qualityScore,
      reliabilityScore: c.reliabilityScore,
      pdProcessingCapacity: c.pdProcessingCapacity,
      vapProcessingCapacity: c.vapProcessingCapacity,
    };
  }

  const demandMarkets: Record<string, DemandMarketInput> = {};
  for (const market of DEMAND_MARKET_IDS) {
    const m = scenarioTurnInput.demandMarkets[market];
    demandMarkets[market] = {
      priorPeriodConsumption: m.priorPeriodConsumption,
      economicIndex: m.economicIndex,
      populationGrowthRate: m.populationGrowthRate,
    };
  }

  return {
    period: scenarioTurnInput.period,
    priorHosoFobPrice: previousMarketContext.priorHosoFobPrice,
    countries: countries as MarketQuarterInput["countries"],
    demandMarkets: demandMarkets as MarketQuarterInput["demandMarkets"],
    vietnamDomestic: {
      domesticRawSupply: scenarioTurnInput.vietnamDomesticRawSupply,
      domesticProcurementIntent: previousMarketContext.domesticProcurementIntent,
      trailingAverageDomesticPurchase: scenarioTurnInput.vietnamTrailingAverageDomesticPurchase,
      hosoYieldRatio: ratio(scenarioTurnInput.vietnamProcessingEconomics.hosoYieldRatio),
      processingExportCostUsdPerKg: usdPerHosoEqKg(scenarioTurnInput.vietnamProcessingEconomics.processingExportCostUsdPerKg),
      requiredMarginUsdPerKg: usdPerHosoEqKg(scenarioTurnInput.vietnamProcessingEconomics.requiredMarginUsdPerKg),
    },
    pdVapDemand: scenarioTurnInput.pdVapDemand,
  };
}
