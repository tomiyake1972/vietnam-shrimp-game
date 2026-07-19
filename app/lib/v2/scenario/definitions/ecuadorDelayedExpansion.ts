// ShrimpX V2 — シナリオC: エクアドル遅延拡張（Phase 2、実装指示 §12-C）
//
// シナリオBとできる限り同じ初期条件（前史・背景トレンド・エクアドルの最終的な
// 能力拡張幅+45%）を共有しつつ、疾病・資金・物流上の制約により拡張がYear6〜7
// まで遅れる。Bとの比較（同じ最終到達点に、異なる経路でたどり着く）ができる
// よう設計している。

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

/**
 * エクアドルの能力トレンド：Year6(turn24)までごく緩やかにしか伸びず、
 * Year7(turn28)以降に急速に立ち上がりturn32でBと同じ+45%へ到達する。
 */
const EC_CAPACITY_TREND = countryTrend("ec-delay-capacity-EC", "COUNTRY_CAPACITY", "EC", [
  kf(1, ecStart),
  kf(5, ecStart),
  kf(16, ecStart * 1.02),
  kf(24, ecStart * 1.05),
  kf(28, ecStart * 1.25),
  kf(STANDARD_SCENARIO_DURATION_TURNS, ecStart * 1.45),
]);

const FINANCE_DELAY_EVENT_ID = "ec-delay-finance-constraint";
const DISEASE_SETBACK_EVENT_ID = "ec-delay-disease-setback";
const LOGISTICS_DELAY_EVENT_ID = "ec-delay-logistics-constraint";

const financeInfo = buildEventInformationReleases({
  eventId: FINANCE_DELAY_EVENT_ID,
  idPrefix: "ec-delay-finance-constraint",
  startTurn: 6,
  rumorHeadline: "エクアドルの大手養殖業者が資金調達難との観測",
  rumorFacts: [{ key: "country", label: "国", value: "エクアドル" }],
  confirmedHeadline: "エクアドルで拡張投資の資金調達が難航、稼働率・コストに影響",
  confirmedFacts: [{ key: "utilizationImpact", label: "稼働率への影響", value: "-2pt程度", unit: "pt" }],
  confirmedEstimateRange: { low: -0.04, high: -0.01 },
  gmHeadline: "[GM専用] エクアドル資金制約詳細",
  gmFacts: [
    { key: "utilizationRateDelta", label: "稼働率変化", value: -0.02 },
    { key: "aquacultureCostMultiplier", label: "養殖コスト倍率", value: 1.04 },
  ],
  postGameHeadline: "エクアドル資金制約の実績",
  postGameTruth: [{ key: "utilizationRateDeltaActual", label: "稼働率変化(実績)", value: -0.02 }],
});

const diseaseInfo = buildEventInformationReleases({
  eventId: DISEASE_SETBACK_EVENT_ID,
  idPrefix: "ec-delay-disease-setback",
  startTurn: 14,
  rumorHeadline: "エクアドルの一部養殖場で疾病発生の兆候",
  rumorFacts: [{ key: "country", label: "国", value: "エクアドル" }],
  confirmedHeadline: "エクアドルで疾病による一時的な生残率低下を確認、拡張計画にも遅延",
  confirmedFacts: [{ key: "survivalRateImpact", label: "生残率への影響", value: "-5pt程度", unit: "pt" }],
  confirmedEstimateRange: { low: -0.08, high: -0.02 },
  gmHeadline: "[GM専用] エクアドル疾病セットバック詳細",
  gmFacts: [{ key: "survivalRateDelta", label: "生残率変化", value: -0.05 }],
  postGameHeadline: "エクアドル疾病セットバックの実績",
  postGameTruth: [{ key: "survivalRateDeltaActual", label: "生残率変化(実績)", value: -0.05 }],
});

const logisticsInfo = buildEventInformationReleases({
  eventId: LOGISTICS_DELAY_EVENT_ID,
  idPrefix: "ec-delay-logistics-constraint",
  startTurn: 18,
  rumorHeadline: "エクアドルで輸送インフラの制約が拡張計画に影響との観測",
  rumorFacts: [{ key: "country", label: "国", value: "エクアドル" }],
  confirmedHeadline: "エクアドルの物流能力制約が拡張投資の稼働開始をさらに遅らせる",
  confirmedFacts: [{ key: "utilizationImpact", label: "稼働率への影響", value: "-1.5pt程度", unit: "pt" }],
  confirmedEstimateRange: { low: -0.03, high: -0.005 },
  gmHeadline: "[GM専用] エクアドル物流制約詳細",
  gmFacts: [{ key: "utilizationRateDelta", label: "稼働率変化", value: -0.015 }],
  postGameHeadline: "エクアドル物流制約の実績",
  postGameTruth: [{ key: "utilizationRateDeltaActual", label: "稼働率変化(実績)", value: -0.015 }],
});

export const ECUADOR_DELAYED_EXPANSION_SCENARIO: ScenarioDefinition = {
  scenarioId: "ecuador-delayed-expansion-v0.1",
  version: "0.1.0",
  title: "エクアドル遅延拡張",
  durationTurns: STANDARD_SCENARIO_DURATION_TURNS,

  publicBackground:
    "エクアドルの養殖業界は拡張の意欲を見せているが、資金調達・疾病・物流の制約が重なり、" +
    "大規模な供給拡大はYear6〜7まで実現しない。",
  gmDescription:
    "シナリオBと同じ前史・背景トレンド・エクアドルの最終到達能力（+45%）を共有する。異なるのは" +
    "経路のみ：turn6の資金制約、turn14の疾病セットバック、turn18の物流制約により、turn24頃までは" +
    "能力がほぼ横ばいにとどまり、turn28以降に急速に立ち上がる（実装指示 §12-C「Bと比較可能に」）。",
  postGameExplanation:
    "エクアドルの最終的な能力拡張幅（8年で約+45%）はシナリオBと同一だが、拡張の実現時期が" +
    "4年ほど遅れている。turn6〜24の期間は3つの制約イベント（資金・疾病・物流）が重なり、" +
    "稼働率・生残率への軽微な下押しが累積する設計とした。",

  prehistory: SCENARIO_PREHISTORY_BASELINE_V1,
  initialStateOverrides: SCENARIO_INITIAL_STATE_OVERRIDES_V1,

  longTermTrends: [
    ...standardDemandTrends("ec-delay"),
    ...standardEconomicIndexTrends("ec-delay"),
    ...standardCapacityTrends("ec-delay", ["EC"]),
    EC_CAPACITY_TREND,
    ...standardAquacultureCostTrends("ec-delay"),
  ],

  scheduledEvents: [
    {
      eventId: FINANCE_DELAY_EVENT_ID,
      eventType: "CAPACITY_DELAY",
      targetCountries: ["EC"],
      targetMarkets: [],
      startTurn: 6,
      durationTurns: 18,
      rampUpTurns: 2,
      recoveryTurns: 0,
      hiddenDescription: "エクアドルの拡張投資に対する資金調達難。稼働率をわずかに下押しし、コストを上げる。",
      effects: [
        { variable: "UTILIZATION_RATE", mode: "additivePoint", magnitude: -0.02 },
        { variable: "AQUACULTURE_COST", mode: "multiplicative", magnitude: 1.04 },
      ],
      informationReleaseIds: financeInfo.map((r) => r.informationId),
    },
    {
      eventId: DISEASE_SETBACK_EVENT_ID,
      eventType: "DISEASE_OUTBREAK",
      targetCountries: ["EC"],
      targetMarkets: [],
      startTurn: 14,
      durationTurns: 4,
      rampUpTurns: 1,
      recoveryTurns: 3,
      hiddenDescription: "エクアドルでの一時的な疾病発生。拡張計画をさらに遅らせる一因となる。",
      effects: [{ variable: "SURVIVAL_RATE", mode: "additivePoint", magnitude: -0.05 }],
      informationReleaseIds: diseaseInfo.map((r) => r.informationId),
    },
    {
      eventId: LOGISTICS_DELAY_EVENT_ID,
      eventType: "LOGISTICS_DISRUPTION",
      targetCountries: ["EC"],
      targetMarkets: [],
      startTurn: 18,
      durationTurns: 6,
      rampUpTurns: 2,
      recoveryTurns: 2,
      hiddenDescription: "エクアドルの輸送インフラ制約。拡張投資の稼働開始をさらに遅らせる。",
      effects: [{ variable: "UTILIZATION_RATE", mode: "additivePoint", magnitude: -0.015 }],
      informationReleaseIds: logisticsInfo.map((r) => r.informationId),
    },
  ],

  informationReleases: [...financeInfo, ...diseaseInfo, ...logisticsInfo],

  variationSettings: SCENARIO_VARIATION_SETTINGS_STANDARD,
};
