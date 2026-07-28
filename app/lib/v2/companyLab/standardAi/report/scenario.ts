// ShrimpX V2 — Phase SAI-1.5: シナリオ・外部環境レポート抽出
//
// 【方針】シナリオ定義（app/lib/v2/scenario/definitions/*.ts）のイベント表を
// レポート側で二重に書き写さない。実際にその四半期・そのseedでエンジンが
// 使った「実効値」（record.marketInput・record.marketResult）だけを読み取って
// 出力する。これにより、シナリオ側の変更・seedのjitterがあってもレポートが
// 自動的に追随し、記述と実態がズレない。
//
// 【未実装の明示】自然災害（疫病と独立の事象として）・為替（FX）は、調査の結果
// app/lib/v2 のどこにも実装が見つからなかった（ScenarioBaseVariableの一覧・
// grep結果で確認済み）。これらは値を作らず、generate.ts側のnotesで
// 「未実装」と明記する。

import { CompanyLabConfig, CompanyLabResult } from "../../types";
import { DemandMarketId, DEMAND_MARKET_IDS } from "../../../market/types";
import { ScenarioQuarterRow } from "./types";

export function extractScenarioRows(runLabel: string, config: CompanyLabConfig, result: CompanyLabResult): ScenarioQuarterRow[] {
  const rows: ScenarioQuarterRow[] = [];
  const REFERENCE_WORLD_CONSUMPTION_TONS = 400_000; // runner.ts内の同名定数と同じ考え方の近似値（レポート表示専用、意思決定には使わない）
  for (const record of result.history) {
    const mi = record.marketInput;
    const mr = record.marketResult;

    const economicIndexByMarket = {} as Record<DemandMarketId, number>;
    const priorPeriodConsumptionByMarket = {} as Record<DemandMarketId, number>;
    let worldDemandNumerator = 0;
    for (const market of DEMAND_MARKET_IDS) {
      const d = mi.demandMarkets[market];
      economicIndexByMarket[market] = d.economicIndex;
      priorPeriodConsumptionByMarket[market] = unwrap(d.priorPeriodConsumption);
      worldDemandNumerator += unwrap(d.priorPeriodConsumption) * d.economicIndex;
    }

    const aquacultureCostIndexByCountry: Record<string, number> = {};
    const countryProductionByCountry: Record<string, number> = {};
    const countryQualityScoreByCountry: Record<string, number> = {};
    const countryReliabilityScoreByCountry: Record<string, number> = {};
    for (const [country, c] of Object.entries(mi.countries)) {
      aquacultureCostIndexByCountry[country] = c.aquacultureCostIndex;
      countryProductionByCountry[country] = unwrap(c.production);
      countryQualityScoreByCountry[country] = unwrap(c.qualityScore);
      countryReliabilityScoreByCountry[country] = unwrap(c.reliabilityScore);
    }

    rows.push({
      runLabel,
      turn: record.turn,
      period: record.period,
      scenarioId: config.scenarioId,
      mode: config.mode,
      eventTiming: config.mode === "canonical" ? "fixed_schedule" : "seed_jittered",
      worldDemandIndexApprox: worldDemandNumerator / REFERENCE_WORLD_CONSUMPTION_TONS,
      economicIndexByMarket,
      priorPeriodConsumptionByMarket,
      aquacultureCostIndexByCountry,
      countryProductionByCountry,
      countryQualityScoreByCountry,
      countryReliabilityScoreByCountry,
      vietnamDomesticRawSupplyTons: unwrap(mi.vietnamDomestic.domesticRawSupply),
      vietnamDomesticProcurementIntentTons: unwrap(mi.vietnamDomestic.domesticProcurementIntent),
      priceDriverCodes: mr.globalDrivers,
    });
  }
  return rows;
}

function unwrap(v: { valueOf(): number } | number): number {
  return typeof v === "number" ? v : (v as unknown as number);
}

/** 未実装カテゴリの注記一覧（generate.ts が最終レポートへそのまま転記する）。 */
export const SCENARIO_UNIMPLEMENTED_NOTES: readonly string[] = [
  "自然災害（疫病と独立した事象としての地震・台風等）: 未実装。scenario/types.tsのScenarioBaseVariableおよびscenario/definitions/配下に該当する変数・イベントは存在しない。",
  "為替（FX・exchangeRate）: 未実装。app/lib/v2全体を検索してもfx/exchangeRate/CURRENCYに該当する実装は見つからなかった（全価格・金額はUSD建てで統一）。",
  "疫病（disease）: 実装あり。scenario/definitions/globalDiseaseCrisis.tsが生残率・コスト・輸出適格率・供給信頼性へ作用する国別イベントとして定義。canonicalモードでは固定スケジュール、variationモードでは開始・持続・規模がseedからjitterする。",
  "品質事故リスク: 実装あり（疾病イベントとは別モジュール）。quality/majorIncident.tsが会社×工場×商品×四半期ごとに、seed由来の乱数で発生有無・重大度を決定する（会社ラボ側の意思決定からは操作不能）。",
];
