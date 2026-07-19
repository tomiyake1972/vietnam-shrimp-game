// ShrimpX V2 — シナリオB: エクアドル早期拡張（Phase 2、実装指示 §12-B）
//
// Year2頃から、エクアドルの養殖能力・生産性が複数年にわたり段階的に拡大する。
// 放養・収穫・輸出可能量が段階的に増加し、世界HOSO価格・アジア勢への
// 下押し圧力は市場モジュール側の需給清算で自然に生じる（本シナリオ側は
// 価格へ一切触れない。実装指示 §2）。ベースラインと前史・背景トレンドを
// 共有し、エクアドルの能力トレンド＋段階的な稼働率・輸出適格率イベントだけを
// 追加している（実装指示 §12「BとCの初期条件はできる限り揃える」）。

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
  backSolvedCapacityApprox,
} from "./commonTrends";
import { countryTrend, kf } from "./trendHelpers";
import { buildEventInformationReleases } from "./informationTemplates";

const ecStart = backSolvedCapacityApprox("EC");

/** エクアドルの能力トレンド：Year2(turn5)まで横ばい、以降段階的に拡大しturn32で+45%。 */
const EC_CAPACITY_TREND = countryTrend("ec-early-capacity-EC", "COUNTRY_CAPACITY", "EC", [
  kf(1, ecStart),
  kf(5, ecStart),
  kf(12, ecStart * 1.15),
  kf(20, ecStart * 1.3),
  kf(STANDARD_SCENARIO_DURATION_TURNS, ecStart * 1.45),
]);

const STAGE1_EVENT_ID = "ec-early-expansion-stage1";
const STAGE2_EVENT_ID = "ec-early-expansion-stage2";
const STAGE3_EVENT_ID = "ec-early-expansion-stage3";

const stage1Info = buildEventInformationReleases({
  eventId: STAGE1_EVENT_ID,
  idPrefix: "ec-early-expansion-stage1",
  startTurn: 5,
  rumorHeadline: "エクアドルの大手養殖業者が増産投資を検討との観測",
  rumorFacts: [{ key: "country", label: "国", value: "エクアドル" }],
  confirmedHeadline: "エクアドルで養殖能力拡張計画が始動、稼働率が段階的に上昇へ",
  confirmedFacts: [
    { key: "utilizationImpact", label: "稼働率への影響", value: "+3pt程度（段階1）", unit: "pt" },
  ],
  confirmedEstimateRange: { low: 0.01, high: 0.05 },
  gmHeadline: "[GM専用] エクアドル早期拡張 第1段階詳細",
  gmFacts: [
    { key: "utilizationRateDelta", label: "稼働率変化", value: 0.03 },
    { key: "startTurn", label: "開始ターン", value: 5 },
  ],
  postGameHeadline: "エクアドル早期拡張 第1段階の実績",
  postGameTruth: [{ key: "utilizationRateDeltaActual", label: "稼働率変化(実績)", value: 0.03 }],
});

const stage2Info = buildEventInformationReleases({
  eventId: STAGE2_EVENT_ID,
  idPrefix: "ec-early-expansion-stage2",
  startTurn: 12,
  rumorHeadline: "エクアドルで追加の増産投資が進行中との報道",
  rumorFacts: [{ key: "country", label: "国", value: "エクアドル" }],
  confirmedHeadline: "エクアドルの養殖能力拡張が第2段階へ、供給量がさらに増加",
  confirmedFacts: [{ key: "utilizationImpact", label: "稼働率への影響", value: "+3pt程度（段階2、累積）", unit: "pt" }],
  confirmedEstimateRange: { low: 0.01, high: 0.05 },
  gmHeadline: "[GM専用] エクアドル早期拡張 第2段階詳細",
  gmFacts: [
    { key: "utilizationRateDelta", label: "稼働率変化", value: 0.03 },
    { key: "startTurn", label: "開始ターン", value: 12 },
  ],
  postGameHeadline: "エクアドル早期拡張 第2段階の実績",
  postGameTruth: [{ key: "utilizationRateDeltaActual", label: "稼働率変化(実績)", value: 0.03 }],
});

const stage3Info = buildEventInformationReleases({
  eventId: STAGE3_EVENT_ID,
  idPrefix: "ec-early-expansion-stage3",
  startTurn: 20,
  rumorHeadline: "エクアドルの拡張投資が最終段階に入るとの観測",
  rumorFacts: [{ key: "country", label: "国", value: "エクアドル" }],
  confirmedHeadline: "エクアドルの養殖能力拡張が第3段階へ、世界供給に占める比率が上昇",
  confirmedFacts: [{ key: "utilizationImpact", label: "稼働率への影響", value: "+3pt程度（段階3、累積）", unit: "pt" }],
  confirmedEstimateRange: { low: 0.01, high: 0.05 },
  gmHeadline: "[GM専用] エクアドル早期拡張 第3段階詳細",
  gmFacts: [
    { key: "utilizationRateDelta", label: "稼働率変化", value: 0.03 },
    { key: "startTurn", label: "開始ターン", value: 20 },
  ],
  postGameHeadline: "エクアドル早期拡張 第3段階の実績",
  postGameTruth: [{ key: "utilizationRateDeltaActual", label: "稼働率変化(実績)", value: 0.03 }],
});

export const ECUADOR_EARLY_EXPANSION_SCENARIO: ScenarioDefinition = {
  scenarioId: "ecuador-early-expansion-v0.1",
  version: "0.1.0",
  title: "エクアドル早期拡張",
  durationTurns: STANDARD_SCENARIO_DURATION_TURNS,

  publicBackground:
    "エクアドルの養殖業界が、Year2頃から複数年にわたり段階的に能力・稼働率を引き上げていく。",
  gmDescription:
    "ベースラインと前史・背景トレンド（需要成長・景気指数・他国の能力成長・養殖コストインフレ）を" +
    "共有し、エクアドルの能力トレンドと3段階の稼働率引き上げイベントだけを追加している。単発の" +
    "ショックではなく、turn5→12→20にかけて段階的に効果が積み上がる設計（実装指示 §12-B）。" +
    "エクアドルの供給拡大が世界HOSO価格・アジア勢（IN/ID/VN）へ与える下押し圧力は、本シナリオ側が" +
    "決めるのではなく、市場モジュールの需給清算が結果として生成する。",
  postGameExplanation:
    "エクアドルの養殖能力は8年間で約+45%まで拡大し、稼働率も3段階でそれぞれ+3ptずつ（合計+9pt程度）" +
    "引き上げられるよう設計した。エクアドルの供給量が増える一方、他国の供給トレンドはベースラインと" +
    "同一に保っており、シナリオ側は他国の供給を一切減らしていない。",

  prehistory: SCENARIO_PREHISTORY_BASELINE_V1,
  initialStateOverrides: SCENARIO_INITIAL_STATE_OVERRIDES_V1,

  longTermTrends: [
    ...standardDemandTrends("ec-early"),
    ...standardEconomicIndexTrends("ec-early"),
    ...standardCapacityTrends("ec-early", ["EC"]),
    EC_CAPACITY_TREND,
    ...standardAquacultureCostTrends("ec-early"),
  ],

  scheduledEvents: [
    {
      eventId: STAGE1_EVENT_ID,
      eventType: "CAPACITY_EXPANSION",
      targetCountries: ["EC"],
      targetMarkets: [],
      startTurn: 5,
      durationTurns: 27,
      rampUpTurns: 3,
      recoveryTurns: 0,
      hiddenDescription: "エクアドル能力拡張 第1段階。稼働率を段階的に+3pt引き上げる（回復なし、恒久的な水準変化）。",
      effects: [{ variable: "UTILIZATION_RATE", mode: "additivePoint", magnitude: 0.03 }],
      informationReleaseIds: stage1Info.map((r) => r.informationId),
    },
    {
      eventId: STAGE2_EVENT_ID,
      eventType: "CAPACITY_EXPANSION",
      targetCountries: ["EC"],
      targetMarkets: [],
      startTurn: 12,
      durationTurns: 20,
      rampUpTurns: 3,
      recoveryTurns: 0,
      hiddenDescription: "エクアドル能力拡張 第2段階。稼働率をさらに+3pt引き上げる。",
      effects: [{ variable: "UTILIZATION_RATE", mode: "additivePoint", magnitude: 0.03 }],
      informationReleaseIds: stage2Info.map((r) => r.informationId),
    },
    {
      eventId: STAGE3_EVENT_ID,
      eventType: "CAPACITY_EXPANSION",
      targetCountries: ["EC"],
      targetMarkets: [],
      startTurn: 20,
      durationTurns: 12,
      rampUpTurns: 3,
      recoveryTurns: 0,
      hiddenDescription: "エクアドル能力拡張 第3段階。稼働率をさらに+3pt引き上げる。",
      effects: [{ variable: "UTILIZATION_RATE", mode: "additivePoint", magnitude: 0.03 }],
      informationReleaseIds: stage3Info.map((r) => r.informationId),
    },
  ],

  informationReleases: [...stage1Info, ...stage2Info, ...stage3Info],

  variationSettings: SCENARIO_VARIATION_SETTINGS_STANDARD,
};
