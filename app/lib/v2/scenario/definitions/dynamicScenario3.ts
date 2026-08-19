// ShrimpX V2 — Dynamic Scenario 3（成長・マージン圧迫・供給ショック）
//
// 【DS1 / DS2 との関係】DS2（＝DS1 の世界 ＋ MASS 初期借入 40M）を土台に、
// world 側だけを組み替える。DS1・DS2 の定義ファイルは一切変更していないので、
// 両シナリオは比較用としてそのまま残る。
//
// 【32ターンの流れ】
//   T1–8   成長の基礎（DS1 と同一。ここは巨大市場にしない）
//   T9–16  本格成長（世界需要の拡大が始まり、設備投資の意味が出る）
//   T17–21 世界需要ショックと Others の隠れた機会（DS1 と同じ思想）
//   T22–23 再開ブームと大型化（「これから伸びそうだ」と読める状態にする）
//   T24–28 販売価格 Down Cycle（供給超過。数量は高いまま Margin が圧迫される）
//   T25–27 Ecuador 自然災害（原料高がここに重なる）
//   T29–30 India 自然災害（別経路・速い回復）
//   T30–32 供給正常化。ただし販売価格は絶頂期までは戻さない
//
// 【価格を直接指定しない】ScenarioBaseVariable に価格は存在せず、これは
// 「シナリオは価格を決めない」という設計上の制約である（scenario/types.ts 冒頭）。
// DS3 の down-cycle も、需要圧力と供給圧力を動かすだけで作っている。
//
// 【規模の作り方】DS2 監査で、会社規模を縛っているのは
//   ① submissionTargetTons ≤ attainableProfitableTons × 0.5
//   ② commercialAmbition ≤ Vision の参考規模
// の2段だと分かっている。①は市場需要（この世界の広さ）、②は会社別 Vision 倍率で
// 広げる。どちらも「◯◯トン売れ」という固定目標ではなく、上限を広げるだけである。

import { CountryId, DemandMarketId } from "../../market/types";
import { LongTermTrend, ScenarioDefinition, ScenarioEvent, ScenarioEffect } from "../types";
import { countryTrend, marketTrend, kf } from "./trendHelpers";
import { DYNAMIC_SCENARIO_2 } from "./dynamicScenario2";
import {
  DS1_CONSUMER_BOOM,
  DS1_DEMAND_SHOCK,
  DS1_ECONOMIC_INDEX_KEYFRAMES,
  DS1_OTHERS_RETAIL_GROWTH,
  DS1_REOPENING_BOOM,
  DS1_SEASONALITY_START_TURN,
  DS1_VAP_PROCESSING_CAPACITY_KEYFRAMES,
  DS1_VN_RAW_SHOCK,
  DS1_VN_UTILIZATION_BY_QUARTER,
  DS1_VN_UTILIZATION_EARLY,
  ds1BaseCapacity,
} from "./dynamicScenario1Parameters";
import { DS1_EVENT_IDS, ds1CnHosoSpikeEventId } from "./dynamicScenario1News";
import {
  DS3_AQUACULTURE_COST_KEYFRAMES,
  DS3_CAPACITY_MULTIPLIER_KEYFRAMES,
  DS3_CN_HOSO_SPIKES,
  DS3_DURATION_TURNS,
  DS3_ECUADOR_DISASTER,
  DS3_INDIA_DISASTER,
  DS3_PRICE_DOWN_CYCLE,
  DS3_PRODUCT_LIFECYCLE_OVERRIDES,
  DS3_REGIONAL_DEMAND_KEYFRAMES,
  DS3_SALES_ORGANIZATION_CAPACITY,
  DS3_VISION_GROWTH_OVERRIDES,
} from "./dynamicScenario3Parameters";
import { DS3_EVENT_IDS, DS3_INFORMATION_RELEASES, ds3InformationIdsForEvent } from "./dynamicScenario3News";

const COUNTRIES: readonly CountryId[] = ["EC", "IN", "ID", "VN"];
const MARKETS: readonly DemandMarketId[] = ["CN", "US", "EU", "JP", "OTHER"];
/** 需要ショックの対象は主要4市場のみ。Others は「隠れた機会」として外す（DS1 と同じ）。 */
const MAJOR_MARKETS: readonly DemandMarketId[] = ["CN", "US", "EU", "JP"];

// ---------------------------------------------------------------------
// 長期トレンド
// ---------------------------------------------------------------------

function regionalDemandTrends(): LongTermTrend[] {
  return MARKETS.map((m) =>
    marketTrend(`ds3-demand-${m}`, "REGIONAL_DEMAND", m, DS3_REGIONAL_DEMAND_KEYFRAMES[m].map(([turn, value]) => kf(turn, value)))
  );
}

/** 景気指数は DS1 と同一。循環の形を変えず、構造需要（市場規模）だけを DS3 で広げる。 */
function economicIndexTrends(): LongTermTrend[] {
  return MARKETS.map((m) =>
    marketTrend(`ds3-econ-${m}`, "ECONOMIC_INDEX", m, DS1_ECONOMIC_INDEX_KEYFRAMES[m].map(([turn, value]) => kf(turn, value)))
  );
}

function aquacultureCostTrends(): LongTermTrend[] {
  return COUNTRIES.map((c) =>
    countryTrend(`ds3-cost-${c}`, "AQUACULTURE_COST", c, DS3_AQUACULTURE_COST_KEYFRAMES[c].map(([turn, value]) => kf(turn, value)))
  );
}

function capacityTrends(): LongTermTrend[] {
  return COUNTRIES.map((c) => {
    const base = ds1BaseCapacity(c);
    return countryTrend(
      `ds3-capacity-${c}`,
      "COUNTRY_CAPACITY",
      c,
      DS3_CAPACITY_MULTIPLIER_KEYFRAMES[c].map(([turn, multiplier]) => kf(turn, base * multiplier))
    );
  });
}

/** 産地別 VAP 加工能力は DS1 と同じ考え方（VN は5社の保有設備で置き換わるので宣言しない）。 */
function vapProcessingCapacityTrends(): LongTermTrend[] {
  return (["EC", "IN", "ID"] as const).map((c) =>
    countryTrend(
      `ds3-vap-capacity-${c}`,
      "VAP_PROCESSING_CAPACITY",
      c,
      DS1_VAP_PROCESSING_CAPACITY_KEYFRAMES[c].map(([turn, value]) => kf(turn, value))
    )
  );
}

/** ベトナムの季節変動。DS1 と同一（調達タイミング判断はそのまま残す）。 */
function vietnamUtilizationTrend(): LongTermTrend {
  const keyframes = [
    ...DS1_VN_UTILIZATION_EARLY.map(([turn, value]) => kf(turn, value)),
    ...Array.from({ length: DS3_DURATION_TURNS - DS1_SEASONALITY_START_TURN + 1 }, (_, i) => {
      const turn = DS1_SEASONALITY_START_TURN + i;
      const quarter = (((turn - 1) % 4) + 1) as 1 | 2 | 3 | 4;
      return kf(turn, DS1_VN_UTILIZATION_BY_QUARTER[quarter]);
    }),
  ];
  return countryTrend("ds3-vn-utilization", "UTILIZATION_RATE", "VN", keyframes, "step");
}

// ---------------------------------------------------------------------
// イベント
// ---------------------------------------------------------------------

function event(
  eventId: string,
  eventType: ScenarioEvent["eventType"],
  spec: {
    readonly countries?: readonly CountryId[];
    readonly markets?: readonly DemandMarketId[];
    readonly startTurn: number;
    readonly rampUpTurns: number;
    readonly durationTurns: number;
    readonly recoveryTurns: number;
    readonly hiddenDescription: string;
    readonly effects: readonly ScenarioEffect[];
  }
): ScenarioEvent {
  return {
    eventId,
    eventType,
    targetCountries: spec.countries ?? [],
    targetMarkets: spec.markets ?? [],
    startTurn: spec.startTurn,
    durationTurns: spec.durationTurns,
    rampUpTurns: spec.rampUpTurns,
    recoveryTurns: spec.recoveryTurns,
    hiddenDescription: spec.hiddenDescription,
    effects: spec.effects,
    informationReleaseIds: ds3InformationIdsForEvent(eventId),
  };
}

/**
 * DS3 のイベント一覧。
 *
 * 【DS1 から引き継ぐもの】T7 VN原料ショック / 消費ブーム / EC・IN 増産 /
 * T17-20 世界需要ショック / Others の構造成長 / T22 再開ブーム。
 * これらは DS1 の定数をそのまま使うため、序盤〜中盤の学習体験は変わらない。
 *
 * 【DS3 で採用しないもの】ds1-india-disruption(T23) と ds1-ec-disease-y8(T30)。
 * T25 Ecuador / T29 India の新設イベントと同じ産地の二重被災になるため。
 * ds1-vn-disease-y7 も、T24-28 の down-cycle と重なると原料高が販売価格を
 * 押し上げ返して Margin squeeze（§8）が成立しなくなるため採用しない。
 * DS1/DS2 側の定義には一切触れていない。
 */
function scheduledEvents(): ScenarioEvent[] {
  const events: ScenarioEvent[] = [
    event(DS1_EVENT_IDS.vnRawShock, "DISEASE_OUTBREAK", {
      countries: ["VN"],
      startTurn: DS1_VN_RAW_SHOCK.startTurn,
      rampUpTurns: DS1_VN_RAW_SHOCK.rampUpTurns,
      durationTurns: DS1_VN_RAW_SHOCK.durationTurns,
      recoveryTurns: DS1_VN_RAW_SHOCK.recoveryTurns,
      hiddenDescription:
        "ベトナム南部の疾病拡大。生残率低下と稼働率低下で供給が約半減し、養殖コスト指数の上昇が価格アンカーを押し上げる。",
      effects: [
        { variable: "SURVIVAL_RATE", mode: "additivePoint", magnitude: DS1_VN_RAW_SHOCK.survivalRateDelta },
        { variable: "UTILIZATION_RATE", mode: "multiplicative", magnitude: DS1_VN_RAW_SHOCK.utilizationMultiplier },
        { variable: "AQUACULTURE_COST", mode: "multiplicative", magnitude: DS1_VN_RAW_SHOCK.aquacultureCostMultiplier },
      ],
    }),

    event(DS1_EVENT_IDS.consumerBoom, "ECONOMIC_BOOM", {
      markets: MARKETS,
      startTurn: DS1_CONSUMER_BOOM.startTurn,
      rampUpTurns: DS1_CONSUMER_BOOM.rampUpTurns,
      durationTurns: DS1_CONSUMER_BOOM.durationTurns,
      recoveryTurns: DS1_CONSUMER_BOOM.recoveryTurns,
      hiddenDescription: "US/EU/CN/JP を中心とした消費拡大。",
      effects: [
        { variable: "REGIONAL_DEMAND", mode: "multiplicative", magnitude: DS1_CONSUMER_BOOM.regionalDemandMultiplier },
        { variable: "ECONOMIC_INDEX", mode: "multiplicative", magnitude: DS1_CONSUMER_BOOM.economicIndexMultiplier },
      ],
    }),

    event(DS1_EVENT_IDS.ecuadorExpansion, "CAPACITY_EXPANSION", {
      countries: ["EC", "IN"],
      startTurn: 12,
      rampUpTurns: 1,
      durationTurns: 16,
      recoveryTurns: 0,
      hiddenDescription: "エクアドル・インドの増産が軌道に乗り、稼働率とコスト競争力が改善する。global 調達への転換圧力。",
      effects: [
        { variable: "UTILIZATION_RATE", mode: "multiplicative", magnitude: 1.05 },
        { variable: "AQUACULTURE_COST", mode: "multiplicative", magnitude: 0.97 },
      ],
    }),

    event(DS1_EVENT_IDS.demandShock, "DEMAND_SHOCK", {
      markets: MAJOR_MARKETS,
      startTurn: DS1_DEMAND_SHOCK.startTurn,
      rampUpTurns: DS1_DEMAND_SHOCK.rampUpTurns,
      durationTurns: DS1_DEMAND_SHOCK.durationTurns,
      recoveryTurns: DS1_DEMAND_SHOCK.recoveryTurns,
      hiddenDescription: "外食を中心とした世界的な需要急減。Others は対象外。",
      effects: [
        { variable: "ECONOMIC_INDEX", mode: "multiplicative", magnitude: DS1_DEMAND_SHOCK.economicIndexMultiplier },
        { variable: "REGIONAL_DEMAND", mode: "multiplicative", magnitude: DS1_DEMAND_SHOCK.regionalDemandMultiplier },
      ],
    }),

    event(DS1_EVENT_IDS.othersRetailGrowth, "DEMAND_SHOCK", {
      markets: ["OTHER"],
      startTurn: DS1_OTHERS_RETAIL_GROWTH.startTurn,
      rampUpTurns: DS1_OTHERS_RETAIL_GROWTH.rampUpTurns,
      durationTurns: DS1_OTHERS_RETAIL_GROWTH.durationTurns,
      recoveryTurns: DS1_OTHERS_RETAIL_GROWTH.recoveryTurns,
      hiddenDescription: "家庭用冷凍水産食品・小売の伸長。主要市場のショック期でも Others だけは伸びる。",
      effects: [
        { variable: "REGIONAL_DEMAND", mode: "multiplicative", magnitude: DS1_OTHERS_RETAIL_GROWTH.regionalDemandMultiplier },
        { variable: "ECONOMIC_INDEX", mode: "multiplicative", magnitude: DS1_OTHERS_RETAIL_GROWTH.economicIndexMultiplier },
      ],
    }),

    event(DS1_EVENT_IDS.reopeningBoom, "ECONOMIC_BOOM", {
      markets: MARKETS,
      startTurn: DS1_REOPENING_BOOM.startTurn,
      rampUpTurns: DS1_REOPENING_BOOM.rampUpTurns,
      durationTurns: DS1_REOPENING_BOOM.durationTurns,
      recoveryTurns: DS1_REOPENING_BOOM.recoveryTurns,
      hiddenDescription: "世界需要の急回復。能力を維持した会社が大きく稼ぐ。",
      effects: [
        { variable: "ECONOMIC_INDEX", mode: "multiplicative", magnitude: DS1_REOPENING_BOOM.economicIndexMultiplier },
        { variable: "REGIONAL_DEMAND", mode: "multiplicative", magnitude: DS1_REOPENING_BOOM.regionalDemandMultiplier },
      ],
    }),

    // --- T24–28: 販売価格 Down Cycle（DS3 の中核） ---
    // 価格形成側の世界需要を緩めつつ、産地稼働率を引き上げて供給超過を作る。
    // 数量側（ECONOMIC_INDEX）は下げないので「Volume は高いまま Margin が痩せる」。
    event(DS3_EVENT_IDS.priceDownCycle, "ECONOMIC_DOWNTURN", {
      markets: MARKETS,
      countries: COUNTRIES,
      startTurn: DS3_PRICE_DOWN_CYCLE.startTurn,
      rampUpTurns: DS3_PRICE_DOWN_CYCLE.rampUpTurns,
      durationTurns: DS3_PRICE_DOWN_CYCLE.durationTurns,
      recoveryTurns: DS3_PRICE_DOWN_CYCLE.recoveryTurns,
      hiddenDescription:
        "産地の増産が需要の伸びを追い越し、世界的な供給超過に入る。数量需要は落とさず、価格形成側の需要圧力だけを" +
        "緩めることで『量は売れるが値段が取れない』局面を作る。T25 Ecuador / T29 India の原料高がここに重なり、" +
        "販売価格低下 × 原料高の Margin squeeze になる。",
      effects: [
        { variable: "REGIONAL_DEMAND", mode: "multiplicative", magnitude: DS3_PRICE_DOWN_CYCLE.regionalDemandMultiplier },
        { variable: "UTILIZATION_RATE", mode: "multiplicative", magnitude: DS3_PRICE_DOWN_CYCLE.utilizationMultiplier },
      ],
    }),

    // --- T25–27: Ecuador 自然災害 ---
    event(DS3_EVENT_IDS.ecuadorDisaster, "ABNORMAL_WEATHER", {
      countries: ["EC"],
      startTurn: DS3_ECUADOR_DISASTER.startTurn,
      rampUpTurns: DS3_ECUADOR_DISASTER.rampUpTurns,
      durationTurns: DS3_ECUADOR_DISASTER.durationTurns,
      recoveryTurns: DS3_ECUADOR_DISASTER.recoveryTurns,
      hiddenDescription:
        "エクアドル沿岸養殖地帯の大規模水害。生残率・稼働率の低下と養殖コスト指数の上昇が同時に起き、" +
        "エクアドル産に依存した調達をしていた会社ほど原料costが跳ねる。恒久的な変化ではなく数ターンで正常化する。",
      effects: [
        { variable: "AQUACULTURE_COST", mode: "multiplicative", magnitude: DS3_ECUADOR_DISASTER.aquacultureCostMultiplier },
        { variable: "SURVIVAL_RATE", mode: "additivePoint", magnitude: DS3_ECUADOR_DISASTER.survivalRateDelta },
        { variable: "UTILIZATION_RATE", mode: "multiplicative", magnitude: DS3_ECUADOR_DISASTER.utilizationMultiplier },
      ],
    }),

    // --- T29–30: India 自然災害（Ecuador とは経路と回復速度を変える） ---
    event(DS3_EVENT_IDS.indiaDisaster, "ABNORMAL_WEATHER", {
      countries: ["IN"],
      startTurn: DS3_INDIA_DISASTER.startTurn,
      rampUpTurns: DS3_INDIA_DISASTER.rampUpTurns,
      durationTurns: DS3_INDIA_DISASTER.durationTurns,
      recoveryTurns: DS3_INDIA_DISASTER.recoveryTurns,
      hiddenDescription:
        "インド東岸のサイクロン被害。Ecuador と違い、供給量そのものより『輸出の出口』（検査・通関＝輸出適格率）が" +
        "強く細るため、輸入契約の履行遅延という形で効く。復旧は Ecuador より速い。",
      effects: [
        { variable: "AQUACULTURE_COST", mode: "multiplicative", magnitude: DS3_INDIA_DISASTER.aquacultureCostMultiplier },
        { variable: "EXPORT_ELIGIBILITY_RATE", mode: "multiplicative", magnitude: DS3_INDIA_DISASTER.exportEligibilityMultiplier },
        { variable: "SURVIVAL_RATE", mode: "additivePoint", magnitude: DS3_INDIA_DISASTER.survivalRateDelta },
      ],
    }),
  ];

  // --- China HOSO の一時的な需要圧力（価格そのものは市場清算に委ねる） ---
  for (const spike of DS3_CN_HOSO_SPIKES) {
    events.push(
      // DS1 と同じ eventId 体系を使い、その turn の DS1 記事をそのまま活かす。
      event(ds1CnHosoSpikeEventId(spike.turn), "DEMAND_SHOCK", {
        markets: ["CN"],
        startTurn: spike.turn,
        rampUpTurns: 0,
        durationTurns: 1,
        recoveryTurns: 1,
        hiddenDescription: `中国の一時的な買付集中（${spike.cause}）。HOSO需要圧力のみを与え、価格そのものは市場清算に委ねる。`,
        effects: [{ variable: "REGIONAL_DEMAND", mode: "multiplicative", magnitude: spike.magnitude }],
      })
    );
  }

  return events;
}

// ---------------------------------------------------------------------
// シナリオ定義
// ---------------------------------------------------------------------

export const DYNAMIC_SCENARIO_3: ScenarioDefinition = {
  ...DYNAMIC_SCENARIO_2,

  scenarioId: "dynamic-scenario-3-v0.1",
  version: "0.1.0",
  title: "Dynamic Scenario 3 — Growth, Margin Squeeze & Supply Shocks（動的シナリオ3：成長・マージン圧迫・供給ショック）",
  durationTurns: DS3_DURATION_TURNS,

  publicBackground:
    "世界のエビ需要は拡大を続けており、産地の増産もそれを追いかけている。市場が大きくなるほど会社も大きくできるが、" +
    "大きくなった会社は、需給が緩んだときの値下がりと、産地で起きる出来事の影響も、それだけ大きく受けることになる。",

  gmDescription:
    "会社を大型化させたうえで、後半に『販売価格の下落 × 原料の供給ショック』を当てる32ターンシナリオ。" +
    "T1–8 成長の基礎 / T9–16 本格成長 / T17–21 世界需要ショックと Others の機会 / T22–23 再開ブームと大型化 / " +
    "T24–28 販売価格 Down Cycle / T25 Ecuador 自然災害 / T29 India 自然災害 / T30–32 供給正常化と業界再編。" +
    "\n\n" +
    "【DS1/DS2 との差分】(1) T16 以降の市場規模を大きく広げ、会社が到達できる規模の上限" +
    "（attainableProfitableTons）を引き上げた。(2) 会社別 Vision の成長軌道に倍率をかけ、" +
    "会社ごとに異なる成長余地を与えた（固定の販売目標は与えていない）。" +
    "(3) T24–28 に供給超過による販売価格の down-cycle を置いた。" +
    "(4) DS1 の India 通関障害(T23)・Ecuador 疾病(T30)・Vietnam 疾病(T27) は採用せず、" +
    "T25 Ecuador 自然災害・T29 India 自然災害へ置き換えた。" +
    "\n\n" +
    "【価格は与えていない】このシナリオも販売価格を直接指定していない。down-cycle は" +
    "需要圧力と産地稼働率だけで作っており、実際の価格・シェア・利益は市場と5社の競争が決める。",

  postGameExplanation:
    "前半（T1–16）は DS1/DS2 と同じ世界で、成長と第一次原料ショックを扱う。T17–20 の世界需要ショックを越えると、" +
    "T22 以降は市場が本格的に拡大し、設備・調達網・営業を広げた会社が大きくなれる。" +
    "T23 には『これからさらに伸びそうだ』と読める材料が揃うが、その裏で産地の増産は需要の伸びを追い越しつつあった。" +
    "T24 から供給超過で販売価格が下がり始め、T25 の Ecuador 水害、T29 の India サイクロンが原料高を重ねる。" +
    "販売数量は高いまま、利益率だけが痩せていくのがこの局面である。" +
    "\n\n" +
    "ここで効いたのは量そのものではなく、どの商品・どの市場で稼いでいたか、調達先を分散していたか、" +
    "拡大局面でどれだけ負債を積んだか、そして手元資金をどう残したかだった。",

  longTermTrends: [
    ...regionalDemandTrends(),
    ...economicIndexTrends(),
    ...aquacultureCostTrends(),
    ...capacityTrends(),
    ...vapProcessingCapacityTrends(),
    vietnamUtilizationTrend(),
  ],

  scheduledEvents: scheduledEvents(),
  informationReleases: DS3_INFORMATION_RELEASES,

  productLifecycleOverrides: DS3_PRODUCT_LIFECYCLE_OVERRIDES,

  // 【DS3 限定】会社別の成長余地。固定トン数の販売目標ではなく、Vision の軌道の倍率。
  visionGrowthOverrides: DS3_VISION_GROWTH_OVERRIDES,

  // 【§1・方針変更後】会社別の営業組織能力上限。DS2 では規模を動かさなかったが
  // （その手前で機会上限が binding していたため）、DS3 で市場を広げた結果
  // SALES_CAPACITY が主要制約になったため会社差つきで宣言する。
  // BAL だけ宣言していない理由は dynamicScenario3Parameters.ts のコメント参照。
  salesOrganizationCapacityOverride: DS3_SALES_ORGANIZATION_CAPACITY,
};
