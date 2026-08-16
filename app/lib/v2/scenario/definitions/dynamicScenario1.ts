// ShrimpX V2 — Dynamic Scenario 1（32ターン・動的シナリオ）
//
// 【このシナリオの目的】
// 同じ戦略を続けるだけでは最適にならない世界を32ターンにわたって作る。
//   Phase A (T1–8)  成長・国内原料安・第一次原料ショック
//   Phase B (T9–16) 消費ブーム・商品差別化・global調達への転換
//   Phase C (T17–24) 世界需要ショック・隠れた機会・再開ブーム
//   Phase D (T25–32) 拡大・China premiumization・業界再編
//
// 【3層の役割分担（この設計で最も重要な原則）】
//   Layer A シナリオ  : 世界の潮流と長期構造（景気・地域別構造需要・商品構成・
//                       産地の増産と疾病・外生ショック）
//   Layer B 市場エンジン: 実現価格・成約量・実現需要・外部供給者との競争・
//                       需給バランス・在庫圧力・市場清算
//   Layer C 5社の競争  : どの市場へ供給が集中するか・誰がシェアを取るか・
//                       誰が価格競争に巻き込まれるか・原料の買付圧力
//
// シナリオは **販売価格も成約量も固定しない**。与えるのは需要圧力・供給圧力・
// 産地競争力までであり、実際の価格とシェアは5社の行動を含めて市場が決める。
// 例: China HOSO の高騰は「需要圧力」として与えるだけなので、5社全社が殺到すれば
// 高騰幅は縮み、シェア争いと利益率低下が起きる。逆張りが報われる余地も残る。
// シナリオ側から「HOSO戦略ボーナス」のような直接の報酬は一切与えない。
//
// 【プレイヤーに終了ターンを知らせない】T32 を終わりとして示唆する News・効果は
// 置かない。「残りターンが少ないから長期投資を止める」という発想を世界側から
// 誘発しない（研修では途中終了しうる）。

import { CountryId, DemandMarketId } from "../../market/types";
import { LongTermTrend, ScenarioDefinition, ScenarioEvent, ScenarioEffect } from "../types";
import { SCENARIO_PREHISTORY_BASELINE_V1 } from "../parameters";
import { countryTrend, marketTrend, kf } from "./trendHelpers";
import {
  DS1_AQUACULTURE_COST_KEYFRAMES,
  DS1_CAPACITY_MULTIPLIER_KEYFRAMES,
  DS1_CN_HOSO_SPIKES,
  DS1_CONSUMER_BOOM,
  DS1_DEMAND_SHOCK,
  DS1_DURATION_TURNS,
  DS1_ECONOMIC_INDEX_KEYFRAMES,
  DS1_INITIAL_STATE_OVERRIDES,
  DS1_LATE_SUPPLY_SHOCKS,
  DS1_OTHERS_RETAIL_GROWTH,
  DS1_PRODUCT_LIFECYCLE_OVERRIDES,
  DS1_REGIONAL_DEMAND_KEYFRAMES,
  DS1_REOPENING_BOOM,
  DS1_SEASONALITY_START_TURN,
  DS1_STRUCTURAL_DEMAND_ANCHOR,
  DS1_VN_RAW_SHOCK,
  DS1_VN_UTILIZATION_BY_QUARTER,
  DS1_VN_UTILIZATION_EARLY,
  ds1BaseCapacity,
} from "./dynamicScenario1Parameters";
import { DS1_EVENT_IDS, DS1_INFORMATION_RELEASES, ds1CnHosoSpikeEventId, ds1InformationIdsForEvent } from "./dynamicScenario1News";

const COUNTRIES: readonly CountryId[] = ["EC", "IN", "ID", "VN"];
const MARKETS: readonly DemandMarketId[] = ["CN", "US", "EU", "JP", "OTHER"];
const ALL_MARKETS: readonly DemandMarketId[] = MARKETS;
/** 需要ショックの対象は主要4市場のみ。Others は「隠れた機会」として外す（指示 §19）。 */
const MAJOR_MARKETS: readonly DemandMarketId[] = ["CN", "US", "EU", "JP"];

// ---------------------------------------------------------------------
// 長期トレンド
// ---------------------------------------------------------------------

/** 市場別の構造需要（REGIONAL_DEMAND）。循環はイベント側、構造はここ。 */
function regionalDemandTrends(): LongTermTrend[] {
  return MARKETS.map((m) =>
    marketTrend(
      `ds1-demand-${m}`,
      "REGIONAL_DEMAND",
      m,
      DS1_REGIONAL_DEMAND_KEYFRAMES[m].map(([turn, value]) => kf(turn, value))
    )
  );
}

/** 市場別の景気指数。構造需要アンカーにより「その turn の水準」として読める。 */
function economicIndexTrends(): LongTermTrend[] {
  return MARKETS.map((m) =>
    marketTrend(
      `ds1-econ-${m}`,
      "ECONOMIC_INDEX",
      m,
      DS1_ECONOMIC_INDEX_KEYFRAMES[m].map(([turn, value]) => kf(turn, value))
    )
  );
}

/** 産地別の養殖コスト指数。VN国内原料価格を動かす支配的レバー（価格アンカー）。 */
function aquacultureCostTrends(): LongTermTrend[] {
  return COUNTRIES.map((c) =>
    countryTrend(
      `ds1-cost-${c}`,
      "AQUACULTURE_COST",
      c,
      DS1_AQUACULTURE_COST_KEYFRAMES[c].map(([turn, value]) => kf(turn, value))
    )
  );
}

/** 産地別の養殖能力。Ecuador の大幅増産は T13 開始（T7〜9 の VN ショックとは重ねない）。 */
function capacityTrends(): LongTermTrend[] {
  return COUNTRIES.map((c) => {
    const base = ds1BaseCapacity(c);
    return countryTrend(
      `ds1-capacity-${c}`,
      "COUNTRY_CAPACITY",
      c,
      DS1_CAPACITY_MULTIPLIER_KEYFRAMES[c].map(([turn, multiplier]) => kf(turn, base * multiplier))
    );
  });
}

/**
 * ベトナムの稼働率＝収穫の季節変動（指示 §17）。
 * T1〜12 は季節変動を入れず、序盤の「安い国内原料」を安定させる。
 * T13 以降は四半期ごとに主漁期（Q3）と端境期（Q1）を作り、
 * 「安いターンに買い、高いターンは輸入へ逃げる」という調達タイミング判断を生む。
 * step 補間なので、ターン境界で値が切り替わる（なだらかにしない＝季節の断続性）。
 */
function vietnamUtilizationTrend(): LongTermTrend {
  const keyframes = [
    ...DS1_VN_UTILIZATION_EARLY.map(([turn, value]) => kf(turn, value)),
    ...Array.from({ length: DS1_DURATION_TURNS - DS1_SEASONALITY_START_TURN + 1 }, (_, i) => {
      const turn = DS1_SEASONALITY_START_TURN + i;
      const quarter = (((turn - 1) % 4) + 1) as 1 | 2 | 3 | 4;
      return kf(turn, DS1_VN_UTILIZATION_BY_QUARTER[quarter]);
    }),
  ];
  return countryTrend("ds1-vn-utilization", "UTILIZATION_RATE", "VN", keyframes, "step");
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
    informationReleaseIds: ds1InformationIdsForEvent(eventId),
  };
}

function scheduledEvents(): ScenarioEvent[] {
  const events: ScenarioEvent[] = [
    // --- T7–10: ベトナム原料ショック ---
    // startTurn=6 / rampUpTurns=1 により、T6 の発現強度は数学的に 0 になる。
    // 「News は出るが効果はまだゼロ」という先読み判断点をこれで作る。
    event(DS1_EVENT_IDS.vnRawShock, "DISEASE_OUTBREAK", {
      countries: ["VN"],
      startTurn: DS1_VN_RAW_SHOCK.startTurn,
      rampUpTurns: DS1_VN_RAW_SHOCK.rampUpTurns,
      durationTurns: DS1_VN_RAW_SHOCK.durationTurns,
      recoveryTurns: DS1_VN_RAW_SHOCK.recoveryTurns,
      hiddenDescription:
        "ベトナム南部の疾病拡大。生残率低下と稼働率低下で供給が約半減し、養殖コスト指数の上昇が" +
        "価格アンカーを押し上げる。国内原料価格が輸入着地コストを上回り、固定売価の受注残を持つ" +
        "会社にマージン崩壊が起きる。調達未達も同時に発生する（取引量が約4割減る）。",
      effects: [
        { variable: "SURVIVAL_RATE", mode: "additivePoint", magnitude: DS1_VN_RAW_SHOCK.survivalRateDelta },
        { variable: "UTILIZATION_RATE", mode: "multiplicative", magnitude: DS1_VN_RAW_SHOCK.utilizationMultiplier },
        { variable: "AQUACULTURE_COST", mode: "multiplicative", magnitude: DS1_VN_RAW_SHOCK.aquacultureCostMultiplier },
      ],
    }),

    // --- T8–15: 消費ブーム（T7〜9 で失敗した会社にも復活の余地を与える期間） ---
    event(DS1_EVENT_IDS.consumerBoom, "ECONOMIC_BOOM", {
      markets: ALL_MARKETS,
      startTurn: DS1_CONSUMER_BOOM.startTurn,
      rampUpTurns: DS1_CONSUMER_BOOM.rampUpTurns,
      durationTurns: DS1_CONSUMER_BOOM.durationTurns,
      recoveryTurns: DS1_CONSUMER_BOOM.recoveryTurns,
      hiddenDescription: "US/EU/CN/JP を中心とした消費拡大。供給側はまだ大増産させず、stable〜slightly tight を保つ。",
      effects: [
        { variable: "REGIONAL_DEMAND", mode: "multiplicative", magnitude: DS1_CONSUMER_BOOM.regionalDemandMultiplier },
        { variable: "ECONOMIC_INDEX", mode: "multiplicative", magnitude: DS1_CONSUMER_BOOM.economicIndexMultiplier },
      ],
    }),

    // --- T13–: エクアドル中心の global 増産 ---
    // 能力の本体は capacityTrends 側。ここは稼働・コスト面の上乗せと News の紐づけ。
    // T7〜9 の VN ショックとは意図的に重ねない（重ねると世界基準価格が下がり、
    // 平均回帰と国別価格スプレッド制約を通じて VN_FOB まで引き下げてしまう）。
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

    // --- T17–20: 世界需要ショック（COVID-like） ---
    // startTurn=16 / rampUpTurns=1 → T16 は効果ゼロ（予兆Newsのみ）、T17〜T20 満額、T21 で 0。
    // 対象は主要4市場のみ。Others は外し、「主要市場が崩れる中で Others だけ崩れない」
    // という差分をプレイヤーに発見させる。
    event(DS1_EVENT_IDS.demandShock, "DEMAND_SHOCK", {
      markets: MAJOR_MARKETS,
      startTurn: DS1_DEMAND_SHOCK.startTurn,
      rampUpTurns: DS1_DEMAND_SHOCK.rampUpTurns,
      durationTurns: DS1_DEMAND_SHOCK.durationTurns,
      recoveryTurns: DS1_DEMAND_SHOCK.recoveryTurns,
      hiddenDescription:
        "外食を中心とした世界的な需要急減。数量を約35%、価格形成側の世界需要を約22%押し下げる" +
        "（数量と価格を同率では下げない）。全社が苦しくなる外生ショックだが、被害差は現金・負債・" +
        "市場分散・Others exposure・在庫・要員の柔軟性・工場構成によって変わる。自動破綻はさせない。",
      effects: [
        { variable: "ECONOMIC_INDEX", mode: "multiplicative", magnitude: DS1_DEMAND_SHOCK.economicIndexMultiplier },
        { variable: "REGIONAL_DEMAND", mode: "multiplicative", magnitude: DS1_DEMAND_SHOCK.regionalDemandMultiplier },
      ],
    }),

    // --- T17–23: Others の構造成長（隠れた機会） ---
    // 市場規模の押し上げは控えめにし、収益機会の主因は PD/VAP 構成比の急変
    // （productLifecycleOverrides.OTHER）側に置く。大儲けではなく
    // 「他社が赤字の中で break-even〜moderate profit」を狙う。
    event(DS1_EVENT_IDS.othersRetailGrowth, "DEMAND_SHOCK", {
      markets: ["OTHER"],
      startTurn: DS1_OTHERS_RETAIL_GROWTH.startTurn,
      rampUpTurns: DS1_OTHERS_RETAIL_GROWTH.rampUpTurns,
      durationTurns: DS1_OTHERS_RETAIL_GROWTH.durationTurns,
      recoveryTurns: DS1_OTHERS_RETAIL_GROWTH.recoveryTurns,
      hiddenDescription:
        "家庭用冷凍水産食品・小売・中東・オセアニア・アジア都市部の伸長。News にはヒントのみを置き、" +
        "数字は答えとして書かない。Others に営業を残していた会社・PD/VAP 能力のある会社が危機を切り抜ける。",
      effects: [
        { variable: "REGIONAL_DEMAND", mode: "multiplicative", magnitude: DS1_OTHERS_RETAIL_GROWTH.regionalDemandMultiplier },
        { variable: "ECONOMIC_INDEX", mode: "multiplicative", magnitude: DS1_OTHERS_RETAIL_GROWTH.economicIndexMultiplier },
      ],
    }),

    // --- T22–25: 再開ブーム ---
    // startTurn=21 / rampUpTurns=1 → T21 は「回復シグナル」の News のみで効果ゼロ。
    // T22 を見越して先に準備した会社が報われる。
    event(DS1_EVENT_IDS.reopeningBoom, "ECONOMIC_BOOM", {
      markets: ALL_MARKETS,
      startTurn: DS1_REOPENING_BOOM.startTurn,
      rampUpTurns: DS1_REOPENING_BOOM.rampUpTurns,
      durationTurns: DS1_REOPENING_BOOM.durationTurns,
      recoveryTurns: DS1_REOPENING_BOOM.recoveryTurns,
      hiddenDescription:
        "世界需要の急回復。供給側（能力トレンド）は意図的に動かさないため demand > supply response となり、" +
        "COVID 期に能力を維持した会社が大きく稼ぐ。縮小した会社は生存できたがブームを取り切れない。",
      effects: [
        { variable: "ECONOMIC_INDEX", mode: "multiplicative", magnitude: DS1_REOPENING_BOOM.economicIndexMultiplier },
        { variable: "REGIONAL_DEMAND", mode: "multiplicative", magnitude: DS1_REOPENING_BOOM.regionalDemandMultiplier },
      ],
    }),

    // --- 好況期の一時的な原料 price spike（指示 §22） ---
    event(DS1_EVENT_IDS.indiaDisruption, "LOGISTICS_DISRUPTION", {
      countries: ["IN"],
      startTurn: DS1_LATE_SUPPLY_SHOCKS.indiaDisruption.startTurn,
      rampUpTurns: DS1_LATE_SUPPLY_SHOCKS.indiaDisruption.rampUpTurns,
      durationTurns: DS1_LATE_SUPPLY_SHOCKS.indiaDisruption.durationTurns,
      recoveryTurns: DS1_LATE_SUPPLY_SHOCKS.indiaDisruption.recoveryTurns,
      hiddenDescription: "インドの輸出通関遅延。輸出適格率の低下とコスト上昇で、輸入調達に依存した会社に調達リスクが出る。",
      effects: [
        { variable: "EXPORT_ELIGIBILITY_RATE", mode: "multiplicative", magnitude: DS1_LATE_SUPPLY_SHOCKS.indiaDisruption.exportEligibilityMultiplier },
        { variable: "AQUACULTURE_COST", mode: "multiplicative", magnitude: DS1_LATE_SUPPLY_SHOCKS.indiaDisruption.costMultiplier },
      ],
    }),
    event(DS1_EVENT_IDS.vietnamDiseaseY7, "DISEASE_OUTBREAK", {
      countries: ["VN"],
      startTurn: DS1_LATE_SUPPLY_SHOCKS.vietnamDiseaseY7.startTurn,
      rampUpTurns: DS1_LATE_SUPPLY_SHOCKS.vietnamDiseaseY7.rampUpTurns,
      durationTurns: DS1_LATE_SUPPLY_SHOCKS.vietnamDiseaseY7.durationTurns,
      recoveryTurns: DS1_LATE_SUPPLY_SHOCKS.vietnamDiseaseY7.recoveryTurns,
      hiddenDescription: "好況下の一時的なベトナム疾病。T7 ほど致命的ではないが、原料高で採算が圧迫される。",
      effects: [
        { variable: "SURVIVAL_RATE", mode: "additivePoint", magnitude: DS1_LATE_SUPPLY_SHOCKS.vietnamDiseaseY7.survivalRateDelta },
        { variable: "AQUACULTURE_COST", mode: "multiplicative", magnitude: DS1_LATE_SUPPLY_SHOCKS.vietnamDiseaseY7.costMultiplier },
      ],
    }),
    event(DS1_EVENT_IDS.ecuadorDiseaseY8, "DISEASE_OUTBREAK", {
      countries: ["EC"],
      startTurn: DS1_LATE_SUPPLY_SHOCKS.ecuadorDiseaseY8.startTurn,
      rampUpTurns: DS1_LATE_SUPPLY_SHOCKS.ecuadorDiseaseY8.rampUpTurns,
      durationTurns: DS1_LATE_SUPPLY_SHOCKS.ecuadorDiseaseY8.durationTurns,
      recoveryTurns: DS1_LATE_SUPPLY_SHOCKS.ecuadorDiseaseY8.recoveryTurns,
      hiddenDescription: "エクアドル疾病。輸入調達へ全面的に移行した会社に調達先再分散を迫る。",
      effects: [
        { variable: "SURVIVAL_RATE", mode: "additivePoint", magnitude: DS1_LATE_SUPPLY_SHOCKS.ecuadorDiseaseY8.survivalRateDelta },
        { variable: "AQUACULTURE_COST", mode: "multiplicative", magnitude: DS1_LATE_SUPPLY_SHOCKS.ecuadorDiseaseY8.costMultiplier },
      ],
    }),
  ];

  // --- China HOSO の一時的な需要圧力（年2回程度、T13以降） ---
  // 【内生性】ここで与えるのは需要圧力だけで、価格は指定しない。実際の高騰幅は
  // 5社がその四半期に China HOSO へどれだけ供給したか・外部供給者がどれだけ
  // 埋めたか・在庫がどれだけあったかを踏まえて市場清算が決める。
  // 5社全社が殺到すれば高騰幅は縮み、シェア争いと利益率低下が起きる。
  for (const spike of DS1_CN_HOSO_SPIKES) {
    events.push(
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

export const DYNAMIC_SCENARIO_1: ScenarioDefinition = {
  scenarioId: "dynamic-scenario-1-v0.1",
  version: "0.1.0",
  title: "動的シナリオ1：8年間の構造変化",
  durationTurns: DS1_DURATION_TURNS,

  publicBackground:
    "世界のエビ需要は拡大を続けているが、その中身は年々変わっていく。産地の作柄・疾病・増産、" +
    "消費地の景気と食べ方の変化、物流と貿易の事情が、四半期ごとに需給と価格を動かす。" +
    "同じやり方を続けるだけでは、いずれ通用しなくなる。",

  gmDescription:
    "32ターンを通じて『同じ戦略を続けるだけでは最適にならない世界』を作る動的シナリオ。" +
    "Phase A(T1–8) 成長と第一次原料ショック / Phase B(T9–16) 消費ブームと global 調達への転換 / " +
    "Phase C(T17–24) 世界需要ショックと隠れた機会・再開ブーム / Phase D(T25–32) 拡大と中国の高付加価値化。" +
    "\n\n" +
    "【3層の役割分担】シナリオは世界の潮流と長期構造だけを決める。実現価格・成約量・シェアは" +
    "市場エンジンと5社の競争が決める。China HOSO の高騰も Japan VAP の成長も、シナリオが与えるのは" +
    "需要圧力・構造需要までで、5社が殺到すれば供給過剰で自分たちの利益を悪化させる余地を残してある。" +
    "シナリオ側からの戦略ボーナスは一切与えていない。" +
    "\n\n" +
    "【他シナリオとの差分】(1) 加工経済の控除額を 1.10→0.45 に絞り、国内原料価格を VN FOB に強く連動" +
    "させる（これが無いと T13 以降の『端境期は輸入有利』が成立しない）。(2) 市場×商品の普及曲線を" +
    "上書きし、日本VAP・米国PD・欧州PD転換・Others の隠れ成長・中国の T25 以降の高付加価値化を作る。" +
    "(3) 構造需要アンカーを有効にし、過去の供給不足で市場構造が消滅しないようにする。" +
    "\n\n" +
    "【プレイヤーに終了ターンを知らせない】T32 を終わりとして示唆する News・効果は置いていない。",

  postGameExplanation:
    "本シナリオは4つの局面で異なる経営課題を要求するよう設計した。" +
    "序盤（T1–4）は国内原料が安く、営業を増やして作れば儲かる。ここで受注残を積む判断が後に効く。" +
    "T6 に3件の予兆ニュースが出て、T7 からベトナムの疾病で国内原料が輸入着地コストを上回る" +
    "（供給が約半減し、取引量も約4割減る）。固定売価の受注残を抱えたままだとマージンが崩壊し、" +
    "T6 で輸入へ切り替えた会社は被害を軽減できた。" +
    "T9 以降の消費ブームで立て直しの機会があり、T13 からのエクアドル増産と" +
    "ベトナムの季節変動により、調達を国内一本から global へ広げる必要が生じる。" +
    "T16 の予兆に続く T17–20 の世界需要ショックでは主要4市場の需要が大きく落ちるが、" +
    "Others の家庭用・小売需要だけは伸びており、そこに営業と PD/VAP 能力を残していた会社は" +
    "赤字を回避できた。T21 の回復シグナルを読んで準備した会社が T22 からの再開ブームを取り、" +
    "T25 以降は中国の高付加価値化が最大の成長機会になる。" +
    "\n\n" +
    "価格・シェア・収益は、シナリオが決めたのではなく、この世界の中で5社が何をしたかで決まっている。",

  prehistory: SCENARIO_PREHISTORY_BASELINE_V1,
  initialStateOverrides: DS1_INITIAL_STATE_OVERRIDES,

  longTermTrends: [
    ...regionalDemandTrends(),
    ...economicIndexTrends(),
    ...aquacultureCostTrends(),
    ...capacityTrends(),
    vietnamUtilizationTrend(),
  ],

  scheduledEvents: scheduledEvents(),
  informationReleases: DS1_INFORMATION_RELEASES,

  // 研修・benchmark の再現性を最優先するため canonical のみ許可する。
  variationSettings: { allowedModes: ["canonical"], defaultMode: "canonical" },

  productLifecycleOverrides: DS1_PRODUCT_LIFECYCLE_OVERRIDES,
  structuralDemandAnchor: DS1_STRUCTURAL_DEMAND_ANCHOR,
};
