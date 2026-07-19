// ShrimpX V2 — シナリオD: 世界的疾病危機（Phase 2、実装指示 §12-D）
//
// 複数の生産国が時期をずらして疾病に見舞われる。生残率低下・コスト上昇・
// 放養量減少・供給不足の連鎖が生じ、収束後も緩やかにしか回復しない
// （一時的な価格スパイクにとどまらない長期的影響）。効果はすべて基礎変数
// （生残率・養殖コスト・放養量・輸出適格率・供給信頼性）にのみ作用し、
// 価格は一切決定しない（実装指示 §2）。

import { CountryId } from "../../market/types";
import { ScenarioDefinition, ScenarioEvent } from "../types";
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
import { buildEventInformationReleases, EventInformationTemplateInput } from "./informationTemplates";

/**
 * 疾病イベント1件分の定義。実装指示 §7で示された例（インド・生残率-18%・
 * 養殖コスト+8%・次期放養量-10%・輸出適格率-4%・供給信頼性-6ポイント）と
 * 同じ効果量を4か国それぞれに時期をずらして適用する。recoveryTurnsは例より
 * 長め（8ターン=2年）に設定し、「一時的な価格スパイクにとどまらない長期的
 * 影響」（実装指示 §12-D）を満たす。
 */
function diseaseEvent(country: CountryId, startTurn: number, idPrefix: string): {
  event: ScenarioEvent;
  info: ReturnType<typeof buildEventInformationReleases>;
} {
  const eventId = `${idPrefix}-disease-${country}`;
  const templateInput: EventInformationTemplateInput = {
    eventId,
    idPrefix: eventId,
    startTurn,
    rumorHeadline: `${country}の養殖場で異常な斃死報告`,
    rumorFacts: [{ key: "country", label: "国", value: country }],
    confirmedHeadline: `${country}で疾病の大規模発生を確認、生残率が大幅に低下`,
    confirmedFacts: [
      { key: "survivalRateImpact", label: "生残率への影響", value: "-18pt程度", unit: "pt" },
      { key: "aquacultureCostImpact", label: "養殖コストへの影響", value: "+8%程度" },
    ],
    confirmedEstimateRange: { low: -0.22, high: -0.14 },
    gmHeadline: `[GM専用] ${country} 疾病危機詳細`,
    gmFacts: [
      { key: "survivalRateDelta", label: "生残率変化", value: -0.18 },
      { key: "aquacultureCostMultiplier", label: "養殖コスト倍率", value: 1.08 },
      { key: "stockingVolumeMultiplier", label: "放養量倍率", value: 0.9 },
      { key: "exportEligibilityDelta", label: "輸出適格率変化", value: -0.04 },
      { key: "supplyReliabilityDelta", label: "供給信頼性変化", value: -6 },
    ],
    postGameHeadline: `${country} 疾病危機の実績`,
    postGameTruth: [{ key: "survivalRateDeltaActual", label: "生残率変化(実績)", value: -0.18 }],
  };
  const info = buildEventInformationReleases(templateInput);

  const event: ScenarioEvent = {
    eventId,
    eventType: "DISEASE_OUTBREAK",
    targetCountries: [country],
    targetMarkets: [],
    startTurn,
    durationTurns: 3,
    rampUpTurns: 1,
    recoveryTurns: 8,
    hiddenDescription: `${country}での大規模な疾病発生。生残率・コスト・放養量・輸出適格率・供給信頼性に` +
      "強い悪影響を与え、収束後も緩やかにしか回復しない。",
    effects: [
      { variable: "SURVIVAL_RATE", mode: "additivePoint", magnitude: -0.18 },
      { variable: "AQUACULTURE_COST", mode: "multiplicative", magnitude: 1.08 },
      { variable: "STOCKING_VOLUME", mode: "multiplicative", magnitude: 0.9 },
      { variable: "EXPORT_ELIGIBILITY_RATE", mode: "additivePoint", magnitude: -0.04 },
      { variable: "SUPPLY_RELIABILITY", mode: "additivePoint", magnitude: -6 },
    ],
    informationReleaseIds: info.map((r) => r.informationId),
  };

  return { event, info };
}

const ID_PREFIX = "global-disease";
const ecOutbreak = diseaseEvent("EC", 6, ID_PREFIX);
const inOutbreak = diseaseEvent("IN", 10, ID_PREFIX);
const vnOutbreak = diseaseEvent("VN", 14, ID_PREFIX);
const idOutbreak = diseaseEvent("ID", 18, ID_PREFIX);

const OUTBREAKS = [ecOutbreak, inOutbreak, vnOutbreak, idOutbreak];

export const GLOBAL_DISEASE_CRISIS_SCENARIO: ScenarioDefinition = {
  scenarioId: "global-disease-crisis-v0.1",
  version: "0.1.0",
  title: "世界的疾病危機",
  durationTurns: STANDARD_SCENARIO_DURATION_TURNS,

  publicBackground:
    "エクアドル・インド・ベトナム・インドネシアの主要生産国が、時期をずらして疾病の大規模発生に" +
    "見舞われる。世界の供給が段階的に縮小していく。",
  gmDescription:
    "ベースラインと前史・背景トレンド（能力・需要・コストの緩やかな成長）を共有し、4件の疾病イベント" +
    "（EC:turn6, IN:turn10, VN:turn14, ID:turn18）だけを追加する。各イベントは実装指示 §7の例と同じ" +
    "効果量（生残率-18pt・養殖コスト+8%・放養量-10%・輸出適格率-4pt・供給信頼性-6pt）を持つが、" +
    "recoveryTurnsを8ターン（2年）と長めに設定し、収束後も緩やかにしか回復しない長期的影響を表現する。" +
    "価格には一切触れず、供給側の基礎変数だけを悪化させる。",
  postGameExplanation:
    "4か国が時期をずらして疾病に見舞われることで、世界供給が段階的かつ累積的に縮小する設計とした。" +
    "各イベントの回復期間を8ターンと長めに取ることで、最後の発生（ID, turn18）の影響がシナリオ終盤まで" +
    "残り、単発の価格スパイクではなく持続的な供給不足として現れることを意図している。",

  prehistory: SCENARIO_PREHISTORY_BASELINE_V1,
  initialStateOverrides: SCENARIO_INITIAL_STATE_OVERRIDES_V1,

  longTermTrends: [
    ...standardDemandTrends(ID_PREFIX),
    ...standardEconomicIndexTrends(ID_PREFIX),
    ...standardCapacityTrends(ID_PREFIX),
    ...standardAquacultureCostTrends(ID_PREFIX),
  ],

  scheduledEvents: OUTBREAKS.map((o) => o.event),
  informationReleases: OUTBREAKS.flatMap((o) => o.info),

  variationSettings: SCENARIO_VARIATION_SETTINGS_STANDARD,
};
