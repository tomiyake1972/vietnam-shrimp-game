// ShrimpX V2 — 長期シナリオ・イベントモジュール パラメータ定義（Phase 2）
//
// 実装指示 §12・§17「数値は必ず設定ファイルへ集約し、校正前の仮置きと明記する」
// に対応する唯一の集約ファイル。scenarioEngine.ts・definitions/*.ts はここに
// 定義された値のみを参照し、ロジック中にマジックナンバーを直接書かない。
//
// 「Phase2新規・要校正」はすべて、実データ・仕様書に具体的数値の記載がなく、
// 本実装のために暫定的に置いた値である。バランス調整フェーズでの再検討を前提とする。

import { CountryId, DemandMarketId } from "../market/types";
import {
  ScenarioPrehistory,
  ScenarioInitialStateOverrides,
  ScenarioVariationSettings,
} from "./types";

// ---------------------------------------------------------------------
// エンジンのフォールバック既定値
// ---------------------------------------------------------------------
//
// シナリオ定義が特定の(変数, 対象)に対して明示的なLongTermTrendを
// 持たない場合にscenarioEngine.tsが使う既定値。すべてPhase2新規・要校正。

export interface ScenarioEngineParameters {
  readonly parametersVersion: string;

  /** 能力稼働率の既定値（放養能力に対する実際の放養・収穫の比率）。 */
  readonly defaultUtilizationRate: number;
  /** 生残率の既定値。 */
  readonly defaultSurvivalRate: number;
  /** 養殖生産性倍率の既定値（1.0=基準）。 */
  readonly defaultProductivity: number;
  /** 輸出適格率の既定値。 */
  readonly defaultExportEligibilityRate: number;
  /** 品質評価の既定値（Score0to100）。 */
  readonly defaultQualityScore: number;
  /** 供給信頼性評価の既定値（Score0to100）。 */
  readonly defaultReliabilityScore: number;
  /** 疾病圧力の既定値（0=平常時）。 */
  readonly defaultDiseasePressure: number;
  /** 物流能力比率の既定値（1.0=制約なし）。 */
  readonly defaultLogisticsCapacityRatio: number;
  /** 貿易規制強度の既定値（0=規制なし）。 */
  readonly defaultTradeRestrictionSeverity: number;
  /** 景気指数の既定値（1.0=横ばい）。 */
  readonly defaultEconomicIndex: number;
  /** 消費成長率の既定値（0=横ばい）。 */
  readonly defaultConsumptionGrowthRate: number;
  /** feedEnergyLaborCostトレンドが無い場合の乗数既定値（1.0=補正なし）。 */
  readonly defaultFeedEnergyLaborCostMultiplier: number;

  /** PD加工能力トレンドが無い場合、production に対する比率で導出する既定値。 */
  readonly defaultPdCapacityRatioOfProduction: number;
  /** VAP加工能力トレンドが無い場合、production に対する比率で導出する既定値。 */
  readonly defaultVapCapacityRatioOfProduction: number;

  /**
   * 世界のPD/VAP需要を「地域別潜在需要（REGIONAL_DEMAND）合計」から
   * 導出するための比率。専用のPD/VAP需要という基礎変数は実装指示の
   * 18項目一覧に含まれていないため、既存の REGIONAL_DEMAND から按分する
   * 簡略化（Phase2新規・要校正。docs/v2/SCENARIO_EVENT_ARCHITECTURE_v0.1.md参照）。
   */
  readonly pdDemandShareOfTotalConsumption: number;
  readonly vapDemandShareOfTotalConsumption: number;

  /** vietnamTrailingAverageDomesticPurchase算出に使う直近ターン数。 */
  readonly domesticPurchaseTrailingWindowTurns: number;
}

export const SCENARIO_ENGINE_PARAMETERS_V1: ScenarioEngineParameters = {
  parametersVersion: "scenario-engine-params-v0.1",

  defaultUtilizationRate: 0.85,
  defaultSurvivalRate: 0.85,
  defaultProductivity: 1.0,
  defaultExportEligibilityRate: 0.9,
  defaultQualityScore: 60,
  defaultReliabilityScore: 60,
  defaultDiseasePressure: 0,
  defaultLogisticsCapacityRatio: 1.0,
  defaultTradeRestrictionSeverity: 0,
  defaultEconomicIndex: 1.0,
  defaultConsumptionGrowthRate: 0,
  defaultFeedEnergyLaborCostMultiplier: 1.0,

  defaultPdCapacityRatioOfProduction: 0.3,
  defaultVapCapacityRatioOfProduction: 0.1,

  pdDemandShareOfTotalConsumption: 0.28,
  vapDemandShareOfTotalConsumption: 0.12,

  domesticPurchaseTrailingWindowTurns: 4,
};

// ---------------------------------------------------------------------
// 5シナリオ共通の前史・初期状態（実装指示 §12「Bとcの初期条件はできる限り
// 揃える」を、全シナリオで前史を共有することにより自然に満たす）。
// 数値はすべてPhase2新規・要校正の仮置き（実データ照合は未実施）。
// ---------------------------------------------------------------------

const COUNTRY_IDS: readonly CountryId[] = ["EC", "IN", "ID", "VN"];
const DEMAND_MARKET_IDS: readonly DemandMarketId[] = ["CN", "US", "EU", "JP", "OTHER"];

function recordFor<T>(ids: readonly string[], values: Record<string, T>): Readonly<Record<string, T>> {
  const out: Record<string, T> = {};
  for (const id of ids) out[id] = values[id];
  return out;
}

/** 2015年基準・市場価格形成モジュールの初期HOSO FOB価格（parameters.ts）と整合させた前史価格。 */
export const SCENARIO_PREHISTORY_BASELINE_V1: ScenarioPrehistory = {
  lengthYears: 3,

  priorHosoFobPriceUsdPerKg: recordFor(COUNTRY_IDS, {
    EC: 4.7,
    IN: 5.25,
    ID: 5.45,
    VN: 5.6,
  }) as Readonly<Record<CountryId, number>>,

  priorVietnamDomesticPriceUsdPerKg: 4.9,

  priorWorldDemandTrendNote:
    "2012〜2014年（前史期間）は世界需要が年率2〜3%で緩やかに拡大。中国・米国が牽引し、" +
    "日欧はほぼ横ばい。定性的なメモであり、定量データは priorMarketConsumptionHosoEqTons を参照。",

  priorMarketConsumptionHosoEqTons: recordFor(DEMAND_MARKET_IDS, {
    CN: 380000,
    US: 320000,
    EU: 260000,
    JP: 90000,
    OTHER: 150000,
  }) as Readonly<Record<DemandMarketId, number>>,

  countryAquacultureCostIndex: recordFor(COUNTRY_IDS, {
    EC: 1.0,
    IN: 1.0,
    ID: 1.0,
    VN: 1.0,
  }) as Readonly<Record<CountryId, number>>,

  countrySupplyHosoEqTons: recordFor(COUNTRY_IDS, {
    EC: 550000,
    IN: 650000,
    ID: 350000,
    VN: 450000,
  }) as Readonly<Record<CountryId, number>>,

  growingInventoryHosoEqTons: recordFor(COUNTRY_IDS, {
    EC: 120000,
    IN: 140000,
    ID: 80000,
    VN: 100000,
  }) as Readonly<Record<CountryId, number>>,

  frozenInventoryHosoEqTons: recordFor(COUNTRY_IDS, {
    EC: 40000,
    IN: 45000,
    ID: 25000,
    VN: 35000,
  }) as Readonly<Record<CountryId, number>>,

  farmerExpectedPriceUsdPerKg: recordFor(COUNTRY_IDS, {
    EC: 4.5,
    IN: 5.0,
    ID: 5.2,
    VN: 5.3,
  }) as Readonly<Record<CountryId, number>>,

  carriedOverEvents: [],
};

export const SCENARIO_INITIAL_STATE_OVERRIDES_V1: ScenarioInitialStateOverrides = {
  vietnamProcessingEconomics: {
    // Phase 6.3修正: 旧hosoYieldRatio=0.62（HLSO相当の物理歩留まり）は買付上限の
    // HOSO換算計算に物理重量換算を混入させていたため、HOSO換算上の真の回収率
    // （通常操業基準1.00）へ是正した。
    hosoEqRecoveryRatio: 1.0,
    processingExportCostUsdPerKg: 0.85,
    requiredMarginUsdPerKg: 0.25,
  },
  vietnamTrailingAverageDomesticPurchaseHosoEqTons: 90000,
  initialDomesticProcurementIntentHosoEqTons: 95000,
};

export const SCENARIO_VARIATION_SETTINGS_STANDARD: ScenarioVariationSettings = {
  allowedModes: ["canonical", "variation"],
  defaultMode: "canonical",
};

/** 標準シナリオ長（8年・32ターン）。実装指示 §12。 */
export const STANDARD_SCENARIO_DURATION_TURNS = 32;
