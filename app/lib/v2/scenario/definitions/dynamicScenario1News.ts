// ShrimpX V2 — Dynamic Scenario 1: News（Turn 1〜32 の事前定義）
//
// 【News の役割】プレイヤーが先読みするための外部世界の情報。答えではない。
//
// 【厳守する規約】
//  1. 内部parameter値を直接書かない。定量情報は estimateRange の「幅」まで。
//     倍率・シェア・accelStartTurn 等は gm / postGameTruth レベルにのみ置く。
//  2. News と effect 開始ターンを必ず同期する（下表 EFFECT_SYNC で機械検証）。
//  3. Leading Indicator が出るターンは、対応する effect の発現強度が 0 であること。
//  4. **他社（5社）の意思決定・シェア等の競争情報は書かない。** News は外部世界の
//     情報であり、競争情報は既存の market report 側の責務。
//  5. 「〜が儲かるので買え」という答えを書かない。需要増と同時に
//     「他産地からの出荷増加観測」等、他社も来る可能性を残す書き方にする。
//
// News type と既存フィールドの対応:
//   Leading Indicator : isRumor=true,  confidence 0.30–0.45, effect開始の1〜2ターン前
//   Current Event     : isRumor=false, confidence 0.80–0.95, effect開始と同一ターン
//   Structural Trend  : isRumor=false, relatedEventId なし（trend由来）

import { InformationRelease, StructuredFact } from "../types";
import { DS1_CN_HOSO_SPIKES } from "./dynamicScenario1Parameters";

export const DS1_EVENT_IDS = {
  vnRawShock: "ds1-vn-raw-shock",
  consumerBoom: "ds1-consumer-boom",
  ecuadorExpansion: "ds1-ecuador-expansion",
  demandShock: "ds1-covid-demand-shock",
  othersRetailGrowth: "ds1-others-retail-growth",
  reopeningBoom: "ds1-reopening-boom",
  indiaDisruption: "ds1-india-disruption",
  vietnamDiseaseY7: "ds1-vn-disease-y7",
  ecuadorDiseaseY8: "ds1-ec-disease-y8",
} as const;

export function ds1CnHosoSpikeEventId(turn: number): string {
  return `ds1-cn-hoso-spike-t${turn}`;
}

// ---------------------------------------------------------------------
// News → effect の同期表（テストが機械的に検証する唯一の正典）
// ---------------------------------------------------------------------

/**
 * 「この News はこの effect の何ターン前に出る」という宣言。
 * `leadQuarters > 0` の News が出るターンでは、対応イベントの発現強度が
 * 厳密に 0 でなければならない（＝まだ何も起きていないのに読める予兆）。
 */
export interface NewsEffectSync {
  readonly informationId: string;
  readonly eventId: string;
  readonly newsTurn: number;
  readonly effectStartTurn: number;
  readonly leadQuarters: number;
}

const f = (key: string, label: string, value: string | number, unit?: string): StructuredFact =>
  unit !== undefined ? { key, label, value, unit } : { key, label, value };

interface NewsSpec {
  readonly id: string;
  readonly turn: number;
  readonly headline: string;
  readonly facts: readonly StructuredFact[];
  readonly isRumor: boolean;
  readonly confidence: number;
  readonly eventId?: string;
  readonly estimateRange?: { readonly low: number; readonly high: number; readonly unit?: string };
}

/**
 * Turn 1〜32 の News 一覧。全ターンに最低1件、要所に2〜3件。
 * `eventId` を持つものはイベント由来（Current / Leading）、持たないものは
 * 構造トレンド由来（Structural Trend）。
 */
const NEWS_SPECS: readonly NewsSpec[] = [
  // ---- Phase A: T1–8 成長・国内原料安・第一次原料ショック ----
  { id: "ds1-t1-open", turn: 1, headline: "世界のエビ需給は安定、ベトナム産地の作柄は良好", facts: [f("region", "地域", "ベトナム"), f("condition", "作柄", "良好")], isRumor: false, confidence: 0.9 },
  { id: "ds1-t2-harvest", turn: 2, headline: "メコンデルタで収穫が順調に進み、国内集荷価格は軟調", facts: [f("region", "地域", "メコンデルタ"), f("direction", "集荷価格", "軟調")], isRumor: false, confidence: 0.85 },
  { id: "ds1-t3-margin", turn: 3, headline: "国内原料は前年比で下落、加工各社の採算が改善", facts: [f("direction", "国内原料価格", "下落")], isRumor: false, confidence: 0.85 },
  { id: "ds1-t4-importer-stock", turn: 4, headline: "主要輸入国の在庫は低水準、輸入業者の引き合いが強まる", facts: [f("markets", "対象市場", "CN/US/EU/JP"), f("inventory", "在庫水準", "低い")], isRumor: true, confidence: 0.4, eventId: DS1_EVENT_IDS.consumerBoom },
  { id: "ds1-t5-utilization", turn: 5, headline: "加工各社の稼働率が上昇、能力の逼迫を指摘する声", facts: [f("direction", "稼働率", "上昇")], isRumor: false, confidence: 0.8 },

  // T6: 3件の予兆。この turn の effect 強度は 0（rampUpTurns=1 による）。
  { id: "ds1-t6-disease-rumor", turn: 6, headline: "メコンデルタの一部養殖場で疾病の報告", facts: [f("region", "地域", "メコンデルタ"), f("status", "確度", "未確認の報告")], isRumor: true, confidence: 0.35, eventId: DS1_EVENT_IDS.vnRawShock },
  { id: "ds1-t6-cn-buying", turn: 6, headline: "中国バイヤーによるベトナム原料の買付が増加しているとの観測", facts: [f("buyer", "買い手", "中国バイヤー"), f("direction", "買付", "増加")], isRumor: true, confidence: 0.35, eventId: DS1_EVENT_IDS.vnRawShock },
  { id: "ds1-t6-collection", turn: 6, headline: "集荷量の不足を懸念する声、産地価格に上昇圧力との見方", facts: [f("direction", "集荷量", "不足懸念")], isRumor: true, confidence: 0.3, eventId: DS1_EVENT_IDS.vnRawShock, estimateRange: { low: 0.05, high: 0.3 } },

  // T7: shock 開始（Current Event）
  { id: "ds1-t7-shock", turn: 7, headline: "ベトナム南部で疾病が拡大、集荷価格が急騰", facts: [f("region", "地域", "ベトナム南部"), f("direction", "集荷価格", "急騰"), f("supply", "供給", "大幅減")], isRumor: false, confidence: 0.9, eventId: DS1_EVENT_IDS.vnRawShock, estimateRange: { low: 0.3, high: 0.6 } },
  { id: "ds1-t8-import-switch", turn: 8, headline: "原料高が続き、加工各社は輸入原料への切替を進める", facts: [f("origin", "代替産地", "インド・エクアドル")], isRumor: false, confidence: 0.85, eventId: DS1_EVENT_IDS.vnRawShock },
  { id: "ds1-t8-consumption", turn: 8, headline: "主要市場の消費は堅調、輸入業者の在庫復元意欲が強い", facts: [f("markets", "対象市場", "CN/US/EU/JP")], isRumor: true, confidence: 0.45, eventId: DS1_EVENT_IDS.consumerBoom },

  // ---- Phase B: T9–16 消費ブーム・商品差別化・global調達 ----
  { id: "ds1-t9-us-pd", turn: 9, headline: "米国で加工エビ（PD）の需要が拡大、小売の取扱品目が増加", facts: [f("market", "市場", "米国"), f("product", "商品", "PD")], isRumor: false, confidence: 0.75 },
  { id: "ds1-t9-boom", turn: 9, headline: "主要輸入国の需要が想定を上回るペースで拡大していることを確認", facts: [f("markets", "対象市場", "CN/US/EU/JP/その他")], isRumor: false, confidence: 0.85, eventId: DS1_EVENT_IDS.consumerBoom },
  { id: "ds1-t10-eu-pd", turn: 10, headline: "欧州小売でむき身製品の取扱いが増加、殻付き中心の構成に変化", facts: [f("market", "市場", "欧州"), f("shift", "構成", "HOSO→PD")], isRumor: false, confidence: 0.75 },
  { id: "ds1-t11-recovery", turn: 11, headline: "ベトナムの池入れが回復、集荷量は持ち直しへ", facts: [f("region", "地域", "ベトナム"), f("direction", "集荷量", "回復")], isRumor: false, confidence: 0.85, eventId: DS1_EVENT_IDS.vnRawShock },
  { id: "ds1-t11-jp-vap", turn: 11, headline: "日本で調理済み・味付け製品の販売が伸びているとの小売報告", facts: [f("market", "市場", "日本"), f("product", "商品", "VAP")], isRumor: false, confidence: 0.7 },

  // T12: Ecuador 拡張の予兆（effect は T13 から）
  { id: "ds1-t12-ecuador-rumor", turn: 12, headline: "エクアドルで大規模な養殖池拡張が進行しているとの報", facts: [f("country", "産地", "エクアドル"), f("direction", "生産能力", "拡張")], isRumor: true, confidence: 0.4, eventId: DS1_EVENT_IDS.ecuadorExpansion },

  { id: "ds1-t13-vn-lean", turn: 13, headline: "ベトナムは端境期入り、集荷量が細り産地価格は強含み", facts: [f("region", "地域", "ベトナム"), f("season", "時期", "端境期")], isRumor: false, confidence: 0.85 },
  { id: "ds1-t14-ecuador", turn: 14, headline: "エクアドル産の輸出量が前年比で大幅増、国際相場に下押し圧力", facts: [f("country", "産地", "エクアドル"), f("direction", "輸出量", "増加")], isRumor: false, confidence: 0.8, eventId: DS1_EVENT_IDS.ecuadorExpansion },
  { id: "ds1-t15-vn-peak", turn: 15, headline: "ベトナムは主漁期に入り、集荷価格は下落", facts: [f("region", "地域", "ベトナム"), f("season", "時期", "主漁期"), f("direction", "集荷価格", "下落")], isRumor: false, confidence: 0.85 },
  { id: "ds1-t16-relative-cost", turn: 16, headline: "産地間のコスト差が拡大、ベトナム産の相対的な割高感を指摘する声", facts: [f("comparison", "比較", "ベトナム vs 他産地")], isRumor: false, confidence: 0.75 },

  // T16: 需要ショックの予兆（effect は T17 から。この turn の強度は 0）
  { id: "ds1-t16-foodservice-warning", turn: 16, headline: "外食向け出荷にかげりとの指摘、複数市場で予約が伸び悩む", facts: [f("channel", "販路", "外食"), f("direction", "動向", "弱含み")], isRumor: true, confidence: 0.35, eventId: DS1_EVENT_IDS.demandShock, estimateRange: { low: -0.4, high: -0.1 } },

  // ---- Phase C: T17–24 需要ショック・隠れ機会・再開ブーム ----
  { id: "ds1-t17-shock", turn: 17, headline: "主要市場で外食需要が急減、新規契約の獲得が困難に", facts: [f("markets", "対象市場", "中国・日本・米国・欧州"), f("direction", "需要", "急減"), f("direction2", "販売価格", "下落")], isRumor: false, confidence: 0.9, eventId: DS1_EVENT_IDS.demandShock, estimateRange: { low: -0.45, high: -0.25 } },
  { id: "ds1-t17-others-hint", turn: 17, headline: "外食が低迷する一方、家庭用冷凍水産食品の販売は拡大", facts: [f("channel", "販路", "家庭用・小売")], isRumor: true, confidence: 0.4, eventId: DS1_EVENT_IDS.othersRetailGrowth },
  { id: "ds1-t18-destocking", turn: 18, headline: "輸入業者が在庫調整に動き、新規成約は低調", facts: [f("direction", "在庫", "調整局面")], isRumor: false, confidence: 0.85, eventId: DS1_EVENT_IDS.demandShock },
  { id: "ds1-t19-restructuring", turn: 19, headline: "稼働率低下で加工各社は減産・人員調整へ", facts: [f("direction", "稼働率", "低下")], isRumor: false, confidence: 0.85, eventId: DS1_EVENT_IDS.demandShock },
  { id: "ds1-t20-others-retail", turn: 20, headline: "小売向け・アジア都市部の販売は堅調との報告、中東・オセアニアでも取扱いが増加", facts: [f("region", "地域", "中東・オセアニア・アジア都市部"), f("channel", "販路", "小売")], isRumor: false, confidence: 0.7, eventId: DS1_EVENT_IDS.othersRetailGrowth },

  // T21: 回復シグナル3件（effect は T22 から。この turn の強度は 0）
  { id: "ds1-t21-reopening", turn: 21, headline: "レストランの営業再開の動きが広がる", facts: [f("channel", "販路", "外食"), f("direction", "動向", "再開")], isRumor: true, confidence: 0.4, eventId: DS1_EVENT_IDS.reopeningBoom },
  { id: "ds1-t21-restocking", turn: 21, headline: "輸入業者が在庫の復元を開始したとの観測", facts: [f("direction", "在庫", "復元開始")], isRumor: true, confidence: 0.4, eventId: DS1_EVENT_IDS.reopeningBoom },
  { id: "ds1-t21-easing", turn: 21, headline: "各国で移動・営業の制限緩和が進む", facts: [f("policy", "政策", "制限緩和")], isRumor: true, confidence: 0.35, eventId: DS1_EVENT_IDS.reopeningBoom },

  { id: "ds1-t22-boom", turn: 22, headline: "世界需要が急回復、供給が追いつかず相場は上昇", facts: [f("direction", "需要", "急回復"), f("direction2", "相場", "上昇")], isRumor: false, confidence: 0.9, eventId: DS1_EVENT_IDS.reopeningBoom, estimateRange: { low: 0.1, high: 0.35 } },
  { id: "ds1-t23-india", turn: 23, headline: "インドで輸出通関の遅延、出荷が滞る", facts: [f("country", "産地", "インド"), f("direction", "輸出", "遅延")], isRumor: false, confidence: 0.85, eventId: DS1_EVENT_IDS.indiaDisruption },
  { id: "ds1-t24-jp-premium", turn: 24, headline: "日本のプレミアム市場も回復、高付加価値品の引き合いが強い", facts: [f("market", "市場", "日本"), f("product", "商品", "VAP")], isRumor: false, confidence: 0.8 },
  // T24: China premiumization の予兆（effect は T25 から）
  { id: "ds1-t24-cn-premium-hint", turn: 24, headline: "中国都市部で調理済み・むき身製品の取扱いが増え始めたとの小売調査", facts: [f("market", "市場", "中国"), f("channel", "販路", "都市部小売")], isRumor: true, confidence: 0.4 },

  // ---- Phase D: T25–32 拡大・China premiumization・業界再編 ----
  { id: "ds1-t25-cn-premium", turn: 25, headline: "中国都市部で調理済み・むき身製品の消費が拡大", facts: [f("market", "市場", "中国"), f("product", "商品", "PD/VAP")], isRumor: false, confidence: 0.8 },
  { id: "ds1-t26-cn-retail", turn: 26, headline: "中国の量販店でエビ加工品の売場が拡大", facts: [f("market", "市場", "中国"), f("channel", "販路", "量販店")], isRumor: false, confidence: 0.75 },
  { id: "ds1-t27-vn-disease", turn: 27, headline: "ベトナムの一部地域で疾病、集荷価格が上昇", facts: [f("region", "地域", "ベトナム"), f("direction", "集荷価格", "上昇")], isRumor: false, confidence: 0.85, eventId: DS1_EVENT_IDS.vietnamDiseaseY7 },
  { id: "ds1-t28-cost-pressure", turn: 28, headline: "原料高で加工各社の採算は圧迫、調達先の見直しが進む", facts: [f("direction", "採算", "悪化")], isRumor: false, confidence: 0.8, eventId: DS1_EVENT_IDS.vietnamDiseaseY7 },
  { id: "ds1-t29-ec-warning", turn: 29, headline: "エクアドルで生育不良の報告、次期の出荷減を懸念する声", facts: [f("country", "産地", "エクアドル"), f("status", "確度", "未確認の報告")], isRumor: true, confidence: 0.35, eventId: DS1_EVENT_IDS.ecuadorDiseaseY8 },
  { id: "ds1-t30-ec-disease", turn: 30, headline: "エクアドルで疾病が広がり、輸出量が減少", facts: [f("country", "産地", "エクアドル"), f("direction", "輸出量", "減少")], isRumor: false, confidence: 0.9, eventId: DS1_EVENT_IDS.ecuadorDiseaseY8 },
  { id: "ds1-t31-supply-tight", turn: 31, headline: "エクアドル減産の影響が国際相場へ波及、産地間の供給余力に差", facts: [f("direction", "国際相場", "上昇")], isRumor: false, confidence: 0.85, eventId: DS1_EVENT_IDS.ecuadorDiseaseY8 },
  // T32 は「終了」を示唆しない。継続を示す内容にする（プレイヤーに終了ターンを知らせない）。
  { id: "ds1-t32-outlook", turn: 32, headline: "世界需要は拡大基調を維持、産地の再編が進むとの見方", facts: [f("direction", "世界需要", "拡大基調")], isRumor: false, confidence: 0.75 },
];

/**
 * China HOSO スパイクの News。
 * 需要増と同時に「複数産地から中国向け出荷増加の観測」を必ず併記し、
 * 「行けば儲かる」ではなく「他社も来る可能性がある」と読める形にする（指示 §13）。
 */
function cnHosoSpikeNews(): readonly NewsSpec[] {
  return DS1_CN_HOSO_SPIKES.map((spike) => ({
    id: `ds1-cn-spike-t${spike.turn}`,
    turn: spike.turn,
    headline: `中国の輸入業者が${spike.cause}で買付を強める。一方、複数産地から中国向け出荷増加の観測もある`,
    facts: [f("market", "市場", "中国"), f("product", "商品", "HOSO"), f("cause", "背景", spike.cause), f("counterpoint", "他産地の動き", "中国向け出荷増加の観測")],
    isRumor: false,
    confidence: 0.8,
    eventId: ds1CnHosoSpikeEventId(spike.turn),
  }));
}

const ALL_SPECS: readonly NewsSpec[] = [...NEWS_SPECS, ...cnHosoSpikeNews()];

/**
 * プレイヤー向け News（standard レベル）。
 * すべて availableFromTurn = その turn。過去の News も蓄積して読める
 * （informationEngine が availableFromTurn <= turn で絞る）。
 */
export const DS1_INFORMATION_RELEASES: readonly InformationRelease[] = ALL_SPECS.map((spec) => ({
  informationId: spec.id,
  ...(spec.eventId !== undefined ? { relatedEventId: spec.eventId } : {}),
  availableFromTurn: spec.turn,
  informationLevel: "standard" as const,
  headlineTemplate: spec.headline,
  structuredFacts: spec.facts,
  ...(spec.estimateRange !== undefined ? { estimateRange: spec.estimateRange } : {}),
  confidence: spec.confidence,
  isRumor: spec.isRumor,
}));

/** eventId → その News 一覧（ScenarioEvent.informationReleaseIds を組み立てるため）。 */
export function ds1InformationIdsForEvent(eventId: string): readonly string[] {
  return ALL_SPECS.filter((s) => s.eventId === eventId).map((s) => s.id);
}

/**
 * News と effect 開始ターンの同期宣言。テストがこの表と実際のイベント定義を
 * 突き合わせ、Leading Indicator のターンで発現強度が 0 であることを検証する。
 */
export const DS1_NEWS_EFFECT_SYNC: readonly NewsEffectSync[] = [
  // 3つの「先読み判断点」— News は出るが effect はまだゼロ
  { informationId: "ds1-t6-disease-rumor", eventId: DS1_EVENT_IDS.vnRawShock, newsTurn: 6, effectStartTurn: 7, leadQuarters: 1 },
  { informationId: "ds1-t6-cn-buying", eventId: DS1_EVENT_IDS.vnRawShock, newsTurn: 6, effectStartTurn: 7, leadQuarters: 1 },
  { informationId: "ds1-t6-collection", eventId: DS1_EVENT_IDS.vnRawShock, newsTurn: 6, effectStartTurn: 7, leadQuarters: 1 },
  { informationId: "ds1-t16-foodservice-warning", eventId: DS1_EVENT_IDS.demandShock, newsTurn: 16, effectStartTurn: 17, leadQuarters: 1 },
  { informationId: "ds1-t21-reopening", eventId: DS1_EVENT_IDS.reopeningBoom, newsTurn: 21, effectStartTurn: 22, leadQuarters: 1 },
  { informationId: "ds1-t21-restocking", eventId: DS1_EVENT_IDS.reopeningBoom, newsTurn: 21, effectStartTurn: 22, leadQuarters: 1 },
  { informationId: "ds1-t21-easing", eventId: DS1_EVENT_IDS.reopeningBoom, newsTurn: 21, effectStartTurn: 22, leadQuarters: 1 },
  // 事象と同時に出る確報
  { informationId: "ds1-t7-shock", eventId: DS1_EVENT_IDS.vnRawShock, newsTurn: 7, effectStartTurn: 7, leadQuarters: 0 },
  { informationId: "ds1-t17-shock", eventId: DS1_EVENT_IDS.demandShock, newsTurn: 17, effectStartTurn: 17, leadQuarters: 0 },
  { informationId: "ds1-t22-boom", eventId: DS1_EVENT_IDS.reopeningBoom, newsTurn: 22, effectStartTurn: 22, leadQuarters: 0 },
  { informationId: "ds1-t30-ec-disease", eventId: DS1_EVENT_IDS.ecuadorDiseaseY8, newsTurn: 30, effectStartTurn: 30, leadQuarters: 0 },
];
