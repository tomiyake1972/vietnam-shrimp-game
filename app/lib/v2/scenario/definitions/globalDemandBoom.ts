// ShrimpX V2 — シナリオE: 世界的需要ブーム（Phase 2、実装指示 §12-E）
//
// 米国・中国・EU・日本の需要が複数年にわたり拡大する。レストラン・小売・
// 輸入業者の在庫意欲が強く、価格上昇が将来の放養・能力投資を誘発しうる
// （フィードバック接続点。実装指示 §11）。後半にかけて各国供給が緩やかに
// 追いついていく。本シナリオは需要側の基礎変数（地域別潜在需要・景気指数）と
// 供給側の能力トレンドだけを操作し、価格は一切決定しない（実装指示 §2）。

import { CountryId } from "../../market/types";
import { ScenarioDefinition } from "../types";
import {
  SCENARIO_PREHISTORY_BASELINE_V1,
  SCENARIO_INITIAL_STATE_OVERRIDES_V1,
  SCENARIO_VARIATION_SETTINGS_STANDARD,
  STANDARD_SCENARIO_DURATION_TURNS,
} from "../parameters";
import {
  standardDemandTrends,
  standardAquacultureCostTrends,
  backSolvedCapacityApprox,
  DEFAULT_DEMAND_GROWTH_RATIO,
} from "./commonTrends";
import { countryTrend, marketTrend, kf } from "./trendHelpers";
import { buildEventInformationReleases } from "./informationTemplates";

const BOOM_COUNTRY_IDS: readonly CountryId[] = ["EC", "IN", "ID", "VN"];

/** 中国・米国・EU・日本の需要成長率をベースラインより大きく引き上げる。 */
const BOOM_DEMAND_GROWTH_RATIO = {
  ...DEFAULT_DEMAND_GROWTH_RATIO,
  CN: 1.45,
  US: 1.35,
  EU: 1.25,
  JP: 1.15,
};

/** CN/US/EU/JPの景気指数をベースラインより強めに引き上げる（OTHERはベースライン相当）。 */
function boomEconomicIndexTrends() {
  const boosted = (["CN", "US", "EU", "JP"] as const).map((m) =>
    marketTrend(`global-boom-econ-${m}`, "ECONOMIC_INDEX", m, [kf(1, 1.0), kf(16, 1.06), kf(STANDARD_SCENARIO_DURATION_TURNS, 1.08)])
  );
  const other = marketTrend("global-boom-econ-OTHER", "ECONOMIC_INDEX", "OTHER", [
    kf(1, 1.0),
    kf(16, 1.02),
    kf(STANDARD_SCENARIO_DURATION_TURNS, 1.03),
  ]);
  return [...boosted, other];
}

/**
 * 供給側は前半ほぼ横ばい、turn20以降に加速して追いつく
 * （実装指示 §12-E「供給は後半で追いつく可能性がある」）。
 */
function lateCatchUpCapacityTrends() {
  return BOOM_COUNTRY_IDS.map((c) => {
    const start = backSolvedCapacityApprox(c);
    return countryTrend(`global-boom-capacity-${c}`, "COUNTRY_CAPACITY", c, [
      kf(1, start),
      kf(16, start * 1.03),
      kf(20, start * 1.06),
      kf(STANDARD_SCENARIO_DURATION_TURNS, start * 1.28),
    ]);
  });
}

const DEMAND_SHOCK_EVENT_ID = "global-boom-demand-shock";

const demandShockInfo = buildEventInformationReleases({
  eventId: DEMAND_SHOCK_EVENT_ID,
  idPrefix: DEMAND_SHOCK_EVENT_ID,
  startTurn: 4,
  rumorHeadline: "主要輸入国で外食・小売需要が急拡大との観測",
  rumorFacts: [{ key: "markets", label: "対象市場", value: "CN/US/EU/JP" }],
  confirmedHeadline: "主要輸入国の需要が想定を上回るペースで拡大していることを確認",
  confirmedFacts: [{ key: "demandImpact", label: "需要への影響", value: "+10%程度（対象4市場）" }],
  confirmedEstimateRange: { low: 0.05, high: 0.15 },
  gmHeadline: "[GM専用] 世界的需要ブーム詳細",
  gmFacts: [{ key: "regionalDemandMultiplier", label: "地域別潜在需要倍率", value: 1.1 }],
  postGameHeadline: "世界的需要ブームの実績",
  postGameTruth: [{ key: "regionalDemandMultiplierActual", label: "地域別潜在需要倍率(実績)", value: 1.1 }],
});

export const GLOBAL_DEMAND_BOOM_SCENARIO: ScenarioDefinition = {
  scenarioId: "global-demand-boom-v0.1",
  version: "0.1.0",
  title: "世界的需要ブーム",
  durationTurns: STANDARD_SCENARIO_DURATION_TURNS,

  publicBackground:
    "中国・米国・EU・日本で外食・小売・輸入業者の在庫需要が複数年にわたり強く拡大する。供給は" +
    "当初追いつかないが、後半にかけて各国の増産investment・稼働率引き上げにより緩やかに追いついていく。",
  gmDescription:
    "ベースラインと前史・養殖コストトレンドを共有し、(1) CN/US/EU/JPの地域別潜在需要成長率を引き上げ、" +
    "(2) 同4市場の景気指数トレンドを強め、(3) turn4開始・turn24終了の需要拡大イベントを重ね、" +
    "(4) 4か国の供給能力をturn20以降に加速するトレンドへ差し替える。価格上昇を受けた将来の放養意欲・" +
    "能力投資という因果は、本Phaseでは ScenarioTurnFeedback.externalProducerResponses の記録のみに" +
    "とどめ、次期供給への自動反映は未実装（実装指示 §11、将来モジュールの接続点）。",
  postGameExplanation:
    "需要側は4市場合計で当初想定よりかなり強い成長（CN+45%・US+35%・EU+25%・JP+15%、8年間）となる" +
    "よう設計した。供給側はturn20まではベースライン並みの緩やかな伸びにとどめ、turn20以降に加速する" +
    "トレンドへ切り替えることで、「需要が先行し、供給が後半で追いつく」という物語上の要求を満たしている。",

  prehistory: SCENARIO_PREHISTORY_BASELINE_V1,
  initialStateOverrides: SCENARIO_INITIAL_STATE_OVERRIDES_V1,

  longTermTrends: [
    ...standardDemandTrends("global-boom", BOOM_DEMAND_GROWTH_RATIO),
    ...boomEconomicIndexTrends(),
    ...lateCatchUpCapacityTrends(),
    ...standardAquacultureCostTrends("global-boom"),
  ],

  scheduledEvents: [
    {
      eventId: DEMAND_SHOCK_EVENT_ID,
      eventType: "DEMAND_SHOCK",
      targetCountries: [],
      targetMarkets: ["CN", "US", "EU", "JP"],
      startTurn: 4,
      durationTurns: 20,
      rampUpTurns: 4,
      recoveryTurns: 4,
      hiddenDescription: "主要4市場での需要急拡大。地域別潜在需要を押し上げる（トレンドに重ねて適用）。",
      effects: [{ variable: "REGIONAL_DEMAND", mode: "multiplicative", magnitude: 1.1 }],
      informationReleaseIds: demandShockInfo.map((r) => r.informationId),
    },
  ],

  informationReleases: demandShockInfo,

  variationSettings: SCENARIO_VARIATION_SETTINGS_STANDARD,
};
