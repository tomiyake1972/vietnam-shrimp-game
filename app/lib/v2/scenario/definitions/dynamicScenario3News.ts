// ShrimpX V2 — Dynamic Scenario 3 の Scenario News
//
// 【方針】DS1 の 72 本をそのまま土台にし、DS3 で採用しないイベント
// （ds1-india-disruption / ds1-ec-disease-y8）に紐づく記事だけを外したうえで、
// DS3 固有の後半局面（需要ピーク警戒 → 市場軟化 → Ecuador 災害 → 価格競争 →
// Margin 悪化 → 世界価格調整 → India 災害 → 供給不安 → 正常化・再編）の記事を足す。
//
// 【未来の答えを書かない・§11】記事は「今どうなっているか」「関係者がどう見ているか」
// 「何が不確かか」までに留め、いつ・どれだけ効果が出るかは書かない。
// 内部パラメータ値・シナリオ上の重要度・効果発生ターンは決して書かない。

import { InformationRelease, StructuredFact } from "../types";
import { DS1_EVENT_IDS, DS1_NEWS_SPECS, NewsSpec, ds1CnHosoSpikeEventId } from "./dynamicScenario1News";
import { DS3_CN_HOSO_SPIKES } from "./dynamicScenario3Parameters";

export const DS3_EVENT_IDS = {
  priceDownCycle: "ds3-price-down-cycle",
  ecuadorDisaster: "ds3-ecuador-disaster",
  indiaDisaster: "ds3-india-disaster",
  vietnamDisasterCaseB: "ds3-vn-disaster-case-b",
} as const;

/**
 * DS3 が DS1 から引き継ぐイベントID。
 *
 * 【引き継がないもの】
 *  - indiaDisruption(T23) / ecuadorDiseaseY8(T30)
 *      … T29 India / T25 Ecuador の新設災害と同じ産地の二重被災になるため。
 *  - vietnamDiseaseY7(T27)
 *      … T24–28 の down-cycle と重なると原料高が販売価格を押し上げ返し、
 *        Margin squeeze（§8）が成立しなくなるため。
 * これらに紐づく DS1 の記事は DS3 では出さない（イベントの無い記事は
 * scenario/validation.ts が dangling relatedEventId として弾く）。
 */
export const DS3_RETAINED_DS1_EVENT_IDS: readonly string[] = [
  DS1_EVENT_IDS.vnRawShock,
  DS1_EVENT_IDS.consumerBoom,
  DS1_EVENT_IDS.ecuadorExpansion,
  DS1_EVENT_IDS.demandShock,
  DS1_EVENT_IDS.othersRetailGrowth,
  DS1_EVENT_IDS.reopeningBoom,
  // CN HOSO スパイクは DS3 が実際に置いた turn のものだけを引き継ぐ。
  ...DS3_CN_HOSO_SPIKES.map((s) => ds1CnHosoSpikeEventId(s.turn)),
];

const f = (key: string, label: string, value: string | number, unit?: string): StructuredFact =>
  unit !== undefined ? { key, label, value, unit } : { key, label, value };

/**
 * DS3 固有の記事。turn は availableFromTurn。
 * eventId を持つものは、その ScenarioEvent の informationReleaseIds へ紐づく。
 */
export const DS3_NEWS_SPECS: readonly NewsSpec[] = [
  {
    id: "ds3-t23-demand-peak-warning",
    turn: 23,
    eventId: DS3_EVENT_IDS.priceDownCycle,
    headline: "世界需要は高水準を維持、ただし増産ペースへの警戒感も",
    body:
      "主要消費地の引き合いは引き続き強く、業界各社は前年を上回る出荷を報告している。一方で、複数の産地で進んでいる" +
      "大型増産が今後どのタイミングで市場へ出てくるかについては、見方が分かれている。ある輸入商社の担当者は" +
      "「需要が強いのは事実だが、供給の伸びの方が速くなる局面がいずれ来る」と話す。現時点で価格は堅調に推移しており、" +
      "需給の転換点がいつになるかを断定できる材料はない。",
    facts: [f("world_demand_trend", "世界需要の基調", "高水準を維持"), f("supply_expansion", "産地の増産", "複数産地で進行中")],
    isRumor: false,
    confidence: 0.6,
    signalClass: "weak",
    scale: "major",
    market: "GLOBAL",
  },
  {
    id: "ds3-t24-market-softening",
    turn: 24,
    eventId: DS3_EVENT_IDS.priceDownCycle,
    headline: "主要市場で荷余り感、成約価格に頭打ちの兆し",
    body:
      "中国・米国の主要港で在庫の積み上がりが報告され、直近の成約では買い手が価格交渉を強めているという。" +
      "取扱量そのものは減っていないが、これまでのような売り手優位の商談は成立しにくくなってきた。" +
      "産地側の増産が本格的に効き始めたとの見方もあるが、季節要因との切り分けはまだできていない。",
    facts: [f("inventory", "主要港の在庫", "積み上がり"), f("negotiation", "商談の主導権", "買い手側へ")],
    isRumor: false,
    confidence: 0.65,
    signalClass: "weak",
    scale: "normal",
    market: "GLOBAL",
  },
  {
    id: "ds3-t24-ecuador-weather-warning",
    turn: 24,
    eventId: DS3_EVENT_IDS.ecuadorDisaster,
    headline: "エクアドル沿岸部で記録的な豪雨、養殖池への影響を懸念する声",
    body:
      "エクアドル沿岸の養殖地帯で断続的な豪雨が続いており、一部地域では池の越水や取水設備の損傷が報告されている。" +
      "現地関係者は「被害の全容はまだ把握できていない」としており、収穫や出荷にどこまで影響するかは不明である。" +
      "気象当局は今後数週間も不安定な天候が続く可能性があるとしている。",
    facts: [f("region", "対象地域", "エクアドル沿岸養殖地帯"), f("damage_scope", "被害の全容", "把握中")],
    isRumor: true,
    confidence: 0.45,
    signalClass: "weak",
    scale: "normal",
    origin: "EC",
  },
  {
    id: "ds3-t25-ecuador-disaster",
    turn: 25,
    eventId: DS3_EVENT_IDS.ecuadorDisaster,
    headline: "エクアドル養殖地帯で大規模水害、出荷の停滞と原料価格の急伸",
    body:
      "エクアドルの主要養殖地帯が広範囲で冠水し、複数の生産者が収穫の中断を余儀なくされている。" +
      "生残率の低下と池の復旧作業により、当面の供給量は平常を下回る見通しだという。" +
      "現地の買付価格は急速に上昇しており、エクアドル産に依存していた加工業者からは調達先の見直しを検討する声が出ている。" +
      "復旧の見通しについて、現地の業界団体は「季節が落ち着けば段階的に戻る」との見方を示しているが、時期は示していない。",
    facts: [
      f("event", "事象", "養殖地帯の大規模冠水"),
      f("raw_price", "現地買付価格", "急上昇"),
      f("supply", "当面の供給量", "平常を下回る見通し"),
    ],
    isRumor: false,
    confidence: 0.85,
    signalClass: "strong",
    scale: "normal",
    origin: "EC",
  },
  {
    id: "ds3-t26-price-competition",
    turn: 26,
    eventId: DS3_EVENT_IDS.priceDownCycle,
    headline: "供給拡大で販売競争が激化、原料高との板挟みに",
    body:
      "エクアドル以外の産地からの供給が増え続けており、消費地の店頭価格は下押し圧力を受けている。" +
      "一方で原料側はエクアドルの被害を受けて高止まりしており、加工業者は「売値は下がるのに買値は下がらない」" +
      "という苦しい局面に置かれている。複数の業者が、採算の取れない商談から距離を置き始めたと話している。",
    facts: [f("selling_price", "販売価格", "下押し圧力"), f("raw_cost", "原料コスト", "高止まり")],
    isRumor: false,
    confidence: 0.75,
    signalClass: "strong",
    scale: "normal",
    market: "GLOBAL",
  },
  {
    id: "ds3-t27-margin-deterioration",
    turn: 27,
    eventId: DS3_EVENT_IDS.priceDownCycle,
    headline: "加工各社の採算が悪化、出荷量は伸びても利益は伸びず",
    body:
      "主要な輸出加工業者の直近四半期は、出荷数量が前年を上回った一方で利益率の低下が目立つ結果となった。" +
      "業界関係者は「量を追うほど採算が薄くなる構図になっている」と指摘する。" +
      "在庫を厚く持った業者ほど評価損の影響を受けやすく、調達と生産の量をどう抑えるかが当面の焦点になっている。",
    facts: [f("volume", "出荷数量", "前年を上回る"), f("margin", "利益率", "低下")],
    isRumor: false,
    confidence: 0.8,
    signalClass: "strong",
    scale: "normal",
    market: "GLOBAL",
  },
  {
    id: "ds3-t28-global-price-adjustment",
    turn: 28,
    eventId: DS3_EVENT_IDS.priceDownCycle,
    headline: "世界価格は調整局面へ、数年ぶりの水準まで下落",
    body:
      "主要仕向地の成約価格は、ここ数年で最も低い水準まで下がった。需要そのものは堅調で取扱数量は高水準を保っているが、" +
      "産地の増産が需要の伸びを上回った状態が続いている。買い手は「当面は買い進む必要がない」との姿勢を強めており、" +
      "売り手側は在庫の持ち方と生産量の調整を迫られている。",
    facts: [f("price_level", "成約価格", "数年ぶりの低水準"), f("volume", "取扱数量", "高水準を維持")],
    isRumor: false,
    confidence: 0.85,
    signalClass: "strong",
    scale: "normal",
    market: "GLOBAL",
  },
  {
    id: "ds3-t28-india-weather-warning",
    turn: 28,
    eventId: DS3_EVENT_IDS.indiaDisaster,
    headline: "インド東岸でサイクロン接近、養殖・物流への影響を注視",
    body:
      "インド東岸の主要養殖地帯に強い熱帯低気圧が接近しており、地元当局は沿岸部に避難指示を出している。" +
      "収穫期と重なる地域もあり、生産者からは被害を懸念する声が上がっている。港湾の稼働にも影響が出る可能性があるが、" +
      "現時点で具体的な被害の報告はまだない。",
    facts: [f("region", "対象地域", "インド東岸養殖地帯"), f("status", "現時点の被害報告", "なし")],
    isRumor: true,
    confidence: 0.45,
    signalClass: "weak",
    scale: "normal",
    origin: "IN",
  },
  {
    id: "ds3-t29-india-disaster",
    turn: 29,
    eventId: DS3_EVENT_IDS.indiaDisaster,
    headline: "インドでサイクロン被害、出荷検査の停滞と原料価格上昇",
    body:
      "インド東岸を通過した熱帯低気圧により、養殖池の損壊と沿岸インフラの被害が広範囲で発生した。" +
      "収穫の遅れに加え、検査・通関体制の混乱で輸出可能な数量が絞られており、契約履行の遅延が出始めている。" +
      "現地の原料価格は上昇しているが、復旧作業は比較的速く進んでいるとの報告もある。",
    facts: [
      f("event", "事象", "サイクロン被害"),
      f("export", "輸出検査・通関", "停滞"),
      f("raw_price", "現地原料価格", "上昇"),
    ],
    isRumor: false,
    confidence: 0.85,
    signalClass: "strong",
    scale: "normal",
    origin: "IN",
  },
  {
    id: "ds3-t30-supply-anxiety",
    turn: 30,
    headline: "産地の相次ぐ被災で調達不安、調達先の分散を急ぐ動き",
    body:
      "エクアドルとインドで相次いだ自然災害を受け、輸入業者の間では調達先を1か国に寄せることへの警戒が強まっている。" +
      "国内原料への回帰や、被災していない産地との新規取引を模索する動きが出ている一方、" +
      "こうした切り替えには時間と費用がかかるとの指摘もある。販売価格は依然として低い水準にとどまっている。",
    facts: [f("procurement", "調達方針", "分散を模索"), f("selling_price", "販売価格", "低水準にとどまる")],
    isRumor: false,
    confidence: 0.75,
    signalClass: "strong",
    scale: "major",
    market: "GLOBAL",
  },
  {
    id: "ds3-t31-supply-normalizing",
    turn: 31,
    headline: "被災産地の供給は正常化へ、価格の戻りは限定的",
    body:
      "エクアドル・インドいずれの産地でも復旧が進み、出荷量は災害前の水準に近づきつつある。" +
      "ただし販売価格の戻りは限定的で、増産局面に入る前の高値水準には届いていない。" +
      "業界では「価格が戻る前提で規模を広げた会社ほど負担が重い」との見方が出ている。",
    facts: [f("supply", "被災産地の供給", "正常化へ"), f("price_recovery", "価格の戻り", "限定的")],
    isRumor: false,
    confidence: 0.8,
    signalClass: "strong",
    scale: "major",
    market: "GLOBAL",
  },
  {
    id: "ds3-t32-industry-restructuring",
    turn: 32,
    headline: "加工業界で再編の動き、規模と財務の差が鮮明に",
    body:
      "低い販売価格が続くなか、加工各社の業績差が広がっている。設備と調達網を厚く持ちながら財務に余力を残した会社が" +
      "取引を伸ばす一方、拡大局面で負債を重ねた会社は事業の縮小や提携を検討していると伝えられる。" +
      "業界関係者は「量そのものではなく、どの商品とどの市場で稼いでいたかが効いている」と話している。",
    facts: [f("industry", "業界の状況", "業績差の拡大"), f("driver", "差を生んだ要因", "商品構成・市場構成・財務余力")],
    isRumor: false,
    confidence: 0.8,
    signalClass: "strong",
    scale: "major",
    market: "GLOBAL",
  },
];

/** DS3 で実際に使う NewsSpec（DS1 から不採用イベントぶんを外し、DS3 固有を足す）。 */
export const DS3_ALL_NEWS_SPECS: readonly NewsSpec[] = [
  ...DS1_NEWS_SPECS.filter((s) => s.eventId === undefined || DS3_RETAINED_DS1_EVENT_IDS.includes(s.eventId)),
  ...DS3_NEWS_SPECS,
];

export const DS3_INFORMATION_RELEASES: readonly InformationRelease[] = DS3_ALL_NEWS_SPECS.map((spec) => ({
  informationId: spec.id,
  ...(spec.eventId !== undefined ? { relatedEventId: spec.eventId } : {}),
  availableFromTurn: spec.turn,
  informationLevel: "standard" as const,
  headlineTemplate: spec.headline,
  body: spec.body,
  structuredFacts: spec.facts,
  ...(spec.estimateRange !== undefined ? { estimateRange: spec.estimateRange } : {}),
  confidence: spec.confidence,
  isRumor: spec.isRumor,
}));

/** eventId → その News 一覧（ScenarioEvent.informationReleaseIds を組み立てるため）。 */
export function ds3InformationIdsForEvent(eventId: string): readonly string[] {
  return DS3_ALL_NEWS_SPECS.filter((s) => s.eventId === eventId).map((s) => s.id);
}
