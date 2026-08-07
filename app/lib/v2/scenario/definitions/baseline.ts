// ShrimpX V2 — シナリオA: ベースライン（Phase 2、実装指示 §12-A）
//
// 世界需要が緩やかに拡大し、供給がおおむね追随する。中程度の疾病・経済変動は
// あるが長期的な危機は発生しない。他シナリオとの比較基準（B〜Eは本シナリオと
// 同じ前史・初期状態・背景トレンドを共有し、差分だけで物語を作る）。
// すべての数値はPhase2新規・要校正の仮置き。

import { ScenarioDefinition } from "../types";
import {
  SCENARIO_PREHISTORY_BASELINE_V1,
  SCENARIO_INITIAL_STATE_OVERRIDES_V1,
  SCENARIO_VARIATION_SETTINGS_STANDARD,
  STANDARD_SCENARIO_DURATION_TURNS,
} from "../parameters";
import {
  standardDemandTrends,
  standardEconomicIndexTrends,
  standardCapacityTrends,
  standardAquacultureCostTrends,
} from "./commonTrends";
import { buildEventInformationReleases } from "./informationTemplates";

const DISEASE_EVENT_ID = "baseline-disease-id-1";
const ECON_DIP_EVENT_ID = "baseline-econ-dip-1";

const diseaseInfo = buildEventInformationReleases({
  eventId: DISEASE_EVENT_ID,
  idPrefix: "baseline-disease-id-1",
  startTurn: 10,
  rumorHeadline: "インドネシアの一部養殖場で成長不良の報告",
  rumorFacts: [{ key: "region", label: "地域", value: "インドネシア" }],
  confirmedHeadline: "インドネシアで小規模な疾病発生を確認、生残率が一時的に低下",
  confirmedFacts: [
    { key: "survivalRateImpact", label: "生残率への影響", value: "-6pt程度", unit: "pt" },
    { key: "scale", label: "規模", value: "限定的" },
  ],
  confirmedEstimateRange: { low: -0.08, high: -0.04 },
  gmHeadline: "[GM専用] インドネシア小規模疾病イベント詳細",
  gmFacts: [
    { key: "survivalRateDelta", label: "生残率変化", value: -0.06 },
    { key: "durationTurns", label: "継続ターン数", value: 2 },
  ],
  postGameHeadline: "インドネシア小規模疾病イベントの実績",
  postGameTruth: [{ key: "survivalRateDeltaActual", label: "生残率変化(実績)", value: -0.06 }],
});

const econDipInfo = buildEventInformationReleases({
  eventId: ECON_DIP_EVENT_ID,
  idPrefix: "baseline-econ-dip-1",
  startTurn: 20,
  rumorHeadline: "主要輸入国で景気減速の兆し",
  rumorFacts: [{ key: "note", label: "メモ", value: "小売指標の弱含み" }],
  confirmedHeadline: "主要輸入国の景気指数が一時的に下方修正",
  confirmedFacts: [{ key: "economicIndexImpact", label: "景気指数への影響", value: "-3%程度" }],
  confirmedEstimateRange: { low: -0.05, high: -0.01 },
  gmHeadline: "[GM専用] 世界的な軽微な景気減速イベント詳細",
  gmFacts: [{ key: "economicIndexMultiplier", label: "景気指数倍率", value: 0.97 }],
  postGameHeadline: "軽微な景気減速イベントの実績",
  postGameTruth: [{ key: "economicIndexMultiplierActual", label: "景気指数倍率(実績)", value: 0.97 }],
});

export const BASELINE_SCENARIO: ScenarioDefinition = {
  scenarioId: "baseline-v0.1",
  version: "0.1.0",
  title: "ベースライン：緩やかな世界需要拡大",
  durationTurns: STANDARD_SCENARIO_DURATION_TURNS,

  publicBackground:
    "世界のエビ需要は緩やかに拡大を続けている。各生産国の供給もおおむね需要に追随しており、" +
    "大きな混乱は見られない。",
  gmDescription:
    "他の4シナリオ（エクアドル早期拡張・遅延拡張・世界的疾病危機・世界的需要ブーム）の比較基準となる" +
    "シナリオ。長期トレンドは全変数について緩やかな成長のみとし、イベントも小規模なものを2件のみ配置する。",
  postGameExplanation:
    "本シナリオでは、需要（世界5市場合計で年率2%前後）と供給（各国とも緩やかな能力増強）がおおむね" +
    "均衡して推移するよう設計した。中盤に小規模な疾病・景気変動イベントを配置し、価格が完全に" +
    "無風にならないようにしている。",

  prehistory: SCENARIO_PREHISTORY_BASELINE_V1,
  initialStateOverrides: SCENARIO_INITIAL_STATE_OVERRIDES_V1,

  longTermTrends: [
    ...standardDemandTrends("baseline"),
    ...standardEconomicIndexTrends("baseline"),
    ...standardCapacityTrends("baseline"),
    ...standardAquacultureCostTrends("baseline"),
  ],

  scheduledEvents: [
    {
      eventId: DISEASE_EVENT_ID,
      eventType: "DISEASE_OUTBREAK",
      targetCountries: ["ID"],
      targetMarkets: [],
      startTurn: 10,
      durationTurns: 2,
      rampUpTurns: 1,
      recoveryTurns: 2,
      hiddenDescription: "インドネシアの一部養殖場での小規模な疾病発生。生残率・コストへ軽微な影響。",
      effects: [
        { variable: "SURVIVAL_RATE", mode: "additivePoint", magnitude: -0.06 },
        { variable: "AQUACULTURE_COST", mode: "multiplicative", magnitude: 1.03 },
      ],
      informationReleaseIds: diseaseInfo.map((r) => r.informationId),
    },
    {
      eventId: ECON_DIP_EVENT_ID,
      eventType: "ECONOMIC_DOWNTURN",
      targetCountries: [],
      targetMarkets: ["CN", "US", "EU", "JP", "OTHER"],
      startTurn: 20,
      durationTurns: 3,
      rampUpTurns: 1,
      recoveryTurns: 3,
      hiddenDescription: "世界的な軽微な景気減速。主要市場の景気指数が一時的に下方修正される。",
      effects: [{ variable: "ECONOMIC_INDEX", mode: "multiplicative", magnitude: 0.97 }],
      informationReleaseIds: econDipInfo.map((r) => r.informationId),
    },
  ],

  informationReleases: [...diseaseInfo, ...econDipInfo],

  variationSettings: SCENARIO_VARIATION_SETTINGS_STANDARD,
};
