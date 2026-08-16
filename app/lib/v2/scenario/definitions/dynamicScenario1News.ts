// ShrimpX V2 — Dynamic Scenario 1: News（Turn 1〜32 の事前定義・記事本文つき）
//
// 【News の役割】プレイヤーが先読みするための外部世界の情報。答えではない。
// 読んだプレイヤーが「これは重要かもしれない」「これは単なる業界話題かもしれない」
// 「複数の記事を合わせると何か起きそうだ」と考えられる材料であること。
//
// 【厳守する規約】
//  1. 内部parameter値を直接書かない。定量は estimateRange の「幅」まで。
//     倍率・シェア・accelStartTurn 等は gm / postGameTruth レベルにのみ置く。
//  2. News と effect 開始ターンを必ず同期する（下表 DS1_NEWS_EFFECT_SYNC で機械検証）。
//  3. Leading Indicator が出るターンは、対応する effect の発現強度が 0 であること。
//  4. **他社（5社）の意思決定・シェア等の競争情報は書かない。** News は外部世界の
//     情報であり、競争情報は既存の market report 側の責務。
//  5. 答えを書かない。需要増と同時に「他産地からの出荷増加観測」等、
//     他社も来る可能性を残す書き方にする。
//  6. **全記事が重要signalではない。** background / noise を意図的に混ぜ、
//     「ニュースを読めば毎回すぐ答えが分かる」状態を避ける。
//     noise は完全な作り話ではなく「現実の業界ならありそうだが、
//     このシナリオの大きな効果には直接つながらない情報」とする。
//
// 【時間軸の分類（重要度ではない）】
//   Current    : isRumor=false, confidence 0.80–0.95, effect開始と同一ターン
//   Leading    : isRumor=true,  confidence 0.30–0.45, effect開始の1〜4ターン前
//   Structural : isRumor=false, relatedEventId なし（トレンド由来の構造変化）
//
// 【内部分類（signalClass / scale）はプレイヤーへ出さない】
//   レビュー・テスト用のメタデータであり、InformationRelease へは含めない。
//   画面に signalStrength / scenarioRelevance / futureEffectTurn の類は一切出ない。

import { CountryId, DemandMarketId, Product } from "../../market/types";
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

// ---------------------------------------------------------------------
// 記事の内部メタデータ（レビュー用。プレイヤーへは出さない）
// ---------------------------------------------------------------------

/**
 * シナリオ上の信号強度。**プレイヤー画面には決して出さない。**
 *  - strong     : 実際のシナリオ変化にかなり近い予兆・確報
 *  - weak       : 本当に関係するが影響が小さい、または時期が不確実
 *  - background : 世界観として自然だが、大きなシナリオ効果には直接つながらない
 */
export type NewsSignalClass = "strong" | "weak" | "background";

/** 記事の分量クラス（執筆基準。プレイヤーへは出さない）。 */
export type NewsScale = "major" | "normal" | "background";

export interface NewsSpec {
  readonly id: string;
  readonly turn: number;
  readonly headline: string;
  readonly body: string;
  readonly facts: readonly StructuredFact[];
  readonly isRumor: boolean;
  readonly confidence: number;
  readonly eventId?: string;
  readonly estimateRange?: { readonly low: number; readonly high: number; readonly unit?: string };
  /** 以下はレビュー用メタデータ。InformationRelease へは含めない。 */
  readonly signalClass: NewsSignalClass;
  readonly scale: NewsScale;
  readonly market?: DemandMarketId | "GLOBAL";
  readonly product?: Product | "ALL";
  readonly origin?: CountryId;
}

const f = (key: string, label: string, value: string | number, unit?: string): StructuredFact =>
  unit !== undefined ? { key, label, value, unit } : { key, label, value };

// ---------------------------------------------------------------------
// Phase A: T1–8 成長・国内原料安・第一次原料ショック
// ---------------------------------------------------------------------

const PHASE_A: readonly NewsSpec[] = [
  {
    id: "ds1-t1-open",
    turn: 1,
    headline: "世界のエビ需給は安定、ベトナム産地の作柄は良好",
    body:
      "主要産地の生産状況を集計した業界団体の四半期報告によると、世界のエビ供給は前年並みの水準で推移している。" +
      "ベトナムでは南部を中心に池入れが順調に進み、複数の現地集荷業者が「今期の作柄は平年を上回る」と話す。" +
      "エクアドル・インドの出荷も安定しており、国際相場に大きな波乱要因は見当たらない。" +
      "需要側では中国・米国が引き続き最大の輸入国で、欧州・日本がこれに続く構図が続いている。" +
      "輸入商社の担当者は「当面は落ち着いた商いが続くのではないか」との見方を示した。",
    facts: [f("region", "地域", "ベトナム"), f("condition", "作柄", "良好"), f("balance", "世界需給", "安定")],
    isRumor: false,
    confidence: 0.9,
    signalClass: "background",
    scale: "normal",
    market: "GLOBAL",
    origin: "VN",
  },
  {
    id: "ds1-t1-statistics",
    turn: 1,
    headline: "水産統計、冷凍エビの世界流通量は緩やかな増加基調",
    body:
      "国際水産統計をまとめた民間調査機関の年次資料が公表された。冷凍エビの世界流通量は" +
      "この数年、緩やかな増加基調が続いているという。人口増と中間所得層の拡大が背景にあるとされ、" +
      "同機関は「大きな構造変化は見られないが、地域ごとの伸び方には差がある」と指摘している。" +
      "資料は有償公開されており、詳細な内訳は購読者向けとなっている。",
    facts: [f("source", "出所", "民間調査機関の年次資料"), f("trend", "流通量", "緩やかな増加")],
    isRumor: false,
    confidence: 0.7,
    signalClass: "background",
    scale: "background",
    market: "GLOBAL",
  },
  {
    id: "ds1-t2-harvest",
    turn: 2,
    headline: "メコンデルタで収穫が順調に進み、国内集荷価格は軟調",
    body:
      "メコンデルタ各省で収穫が本格化し、集荷場への持ち込み量が増えている。現地の集荷業者によれば、" +
      "今期は池の回転が良く、サイズの揃いも悪くないという。持ち込み増を受けて国内の集荷価格は前四半期から" +
      "やや軟調に推移しており、加工各社にとっては原料手当てをしやすい環境が続いている。" +
      "一方で、複数の業者が「この水準が長く続くとは限らない」と慎重な見方も示しており、" +
      "先行きについては見方が分かれている。",
    facts: [f("region", "地域", "メコンデルタ"), f("direction", "集荷価格", "軟調"), f("volume", "持ち込み量", "増加")],
    isRumor: false,
    confidence: 0.85,
    signalClass: "weak",
    scale: "normal",
    origin: "VN",
  },
  {
    id: "ds1-t2-coldchain",
    turn: 2,
    headline: "南部主要港で冷凍コンテナ電源設備の増設工事が完了",
    body:
      "ベトナム南部の主要港湾で進められていた冷凍コンテナ用電源設備の増設工事が完了した。" +
      "リーファープラグの口数が増え、ピーク期の待機時間短縮が見込まれる。" +
      "港湾当局は「輸出貨物の増加に備えた計画的な投資」と説明している。" +
      "輸出業者からは「繁忙期の積み残しが減れば助かる」との声が聞かれた。",
    facts: [f("region", "地域", "ベトナム南部"), f("topic", "話題", "港湾設備")],
    isRumor: false,
    confidence: 0.85,
    signalClass: "background",
    scale: "background",
    origin: "VN",
  },
  {
    id: "ds1-t3-margin",
    turn: 3,
    headline: "国内原料は前年比で下落、加工各社の採算が改善",
    body:
      "ベトナム国内の原料エビ価格は前年同期を下回る水準で推移している。加工各社にとっては" +
      "仕入価格の低下が採算改善につながっており、業界関係者からは「久しぶりに動きやすい」との声も出ている。" +
      "輸入原料については、運賃・関税を含めた着地コストが国内調達を大きく上回る状態が続いており、" +
      "現時点で積極的に切り替える動きは限定的だ。複数の加工業者は「わざわざ高い原料を買う理由がない」と話す。" +
      "ただし相場は季節や作柄で動くため、調達先を一つに固定することのリスクを指摘する声もある。",
    facts: [f("direction", "国内原料価格", "下落"), f("comparison", "輸入着地コスト", "国内を上回る")],
    isRumor: false,
    confidence: 0.85,
    signalClass: "weak",
    scale: "normal",
    origin: "VN",
  },
  {
    id: "ds1-t3-expo",
    turn: 3,
    headline: "国際水産見本市が開幕、加工機器と冷凍技術の出展が目立つ",
    body:
      "毎年恒例の国際水産見本市が開幕した。今年は加工機器メーカーと冷凍技術関連の出展が目立ち、" +
      "自動選別・脱皮機の省人化提案が来場者の関心を集めている。主催者によると来場者数は前年並み。" +
      "商談は例年どおり活発だが、大型契約の成約報告は現時点では出ていない。" +
      "会期中にはサステナビリティ関連のセミナーも複数開かれる予定。",
    facts: [f("topic", "話題", "見本市"), f("focus", "注目分野", "加工機器・冷凍技術")],
    isRumor: false,
    confidence: 0.8,
    signalClass: "background",
    scale: "background",
    market: "GLOBAL",
  },
  {
    id: "ds1-t4-importer-stock",
    turn: 4,
    headline: "主要輸入国の在庫は低水準、輸入業者の引き合いが強まる",
    body:
      "中国・米国・欧州・日本の主要輸入国で、冷凍エビの流通在庫が例年より低い水準にあるとの見方が広がっている。" +
      "複数の輸入商社が「手当てを遅らせすぎた」と話しており、足元では引き合いが強まりつつある。" +
      "小売・外食からの発注も底堅く、輸入業者の間では在庫復元の動きが出始めた。" +
      "ただし各社の在庫水準には差があり、業界全体としてどの程度の買い需要が積み上がるかは見通しにくい。" +
      "産地側では「まだ相場に明確な影響は出ていない」との受け止めが多い。",
    facts: [f("markets", "対象市場", "中国・米国・欧州・日本"), f("inventory", "在庫水準", "低い"), f("direction", "引き合い", "強まる")],
    isRumor: true,
    confidence: 0.4,
    eventId: DS1_EVENT_IDS.consumerBoom,
    signalClass: "weak",
    scale: "normal",
    market: "GLOBAL",
  },
  {
    id: "ds1-t4-packaging",
    turn: 4,
    headline: "包装資材メーカー、冷凍水産向けの新素材トレーを発表",
    body:
      "包装資材メーカー各社が、冷凍水産品向けの新しいトレー素材を相次いで発表している。" +
      "リサイクル比率を高めながら耐寒性を確保したのが特徴で、小売の環境対応要求に応えるものだという。" +
      "採用が広がれば包装コストにわずかな影響が出る可能性があるが、" +
      "現時点では試験導入の段階にとどまっている。",
    facts: [f("topic", "話題", "包装資材")],
    isRumor: false,
    confidence: 0.8,
    signalClass: "background",
    scale: "background",
    market: "GLOBAL",
  },
  {
    id: "ds1-t5-utilization",
    turn: 5,
    headline: "加工各社の稼働率が上昇、能力の逼迫を指摘する声",
    body:
      "ベトナムの加工各社で工場稼働率が上昇している。受注の積み上がりを受けたもので、" +
      "一部の工場では残業対応が常態化しつつあるという。業界団体の担当者は" +
      "「受注が増えること自体は良いが、能力の余裕がなくなると納期対応が難しくなる」と指摘する。" +
      "設備増強を検討する動きも出ているが、投資の判断には数年先の需要見通しが必要となるため、" +
      "各社とも慎重に見極めている段階だ。",
    facts: [f("direction", "稼働率", "上昇"), f("issue", "論点", "能力の余裕")],
    isRumor: false,
    confidence: 0.8,
    signalClass: "weak",
    scale: "normal",
    origin: "VN",
  },
  {
    id: "ds1-t5-currency",
    turn: 5,
    headline: "為替の変動幅が縮小、輸出採算への影響は限定的との見方",
    body:
      "主要通貨の変動幅が足元で縮小している。輸出比率の高い水産加工業にとって為替は採算を左右する要因だが、" +
      "現時点では「影響は限定的」との見方が多い。金融機関のアナリストは" +
      "「当面は大きな変動材料が見当たらない」とコメントしている。" +
      "ただし中長期的には各国の金利動向次第で局面が変わりうるとの指摘もある。",
    facts: [f("topic", "話題", "為替")],
    isRumor: false,
    confidence: 0.7,
    signalClass: "background",
    scale: "background",
    market: "GLOBAL",
  },

  // ---- T6: 最初の先読み判断点。3件の予兆 + noise 1件 ----
  {
    id: "ds1-t6-disease-rumor",
    turn: 6,
    headline: "メコンデルタの一部養殖地域で疾病発生の報告",
    body:
      "メコンデルタの一部養殖地域で、成長不良と斃死の報告が出ている。現時点で確認されているのは限られた地域で、" +
      "被害の全体像は把握されていない。現地の集荷業者の間では「来期の集荷量が細るのではないか」と懸念する声が出ているが、" +
      "地方当局は「調査中であり、現段階で断定的なことは言えない」としている。" +
      "国内の集荷価格に今のところ大きな変化はなく、依然として輸入原料より安い水準にある。" +
      "一方で、一部の加工業者はリスクに備えてインド・エクアドル産の見積取得を始めたという。" +
      "業界関係者からは「疾病は広がることもあれば収まることもある。今の段階で調達方針を大きく変えるのは早いのではないか」" +
      "という慎重な意見も聞かれ、対応は分かれている。",
    facts: [
      f("region", "地域", "メコンデルタ一部"),
      f("status", "確度", "未確認の報告"),
      f("current", "現在の国内相場", "大きな変化なし"),
    ],
    isRumor: true,
    confidence: 0.35,
    eventId: DS1_EVENT_IDS.vnRawShock,
    signalClass: "strong",
    scale: "major",
    origin: "VN",
  },
  {
    id: "ds1-t6-cn-buying",
    turn: 6,
    headline: "中国バイヤーによるベトナム原料の買付が増加しているとの観測",
    body:
      "複数の現地関係者によると、中国のバイヤーがベトナム産の原料エビの買付を増やしているという。" +
      "従来から一定量の取引はあったが、足元では引き合いの頻度が上がっているとの証言が複数の集荷場から出ている。" +
      "背景については「単なる季節的な手当て」との見方と「先行きの供給を警戒した動き」との見方があり、はっきりしない。" +
      "国内の加工業者にとっては、同じ原料をめぐる買い手が増えることを意味する。",
    facts: [f("buyer", "買い手", "中国バイヤー"), f("direction", "買付", "増加"), f("status", "確度", "現地関係者の証言")],
    isRumor: true,
    confidence: 0.35,
    eventId: DS1_EVENT_IDS.vnRawShock,
    signalClass: "strong",
    scale: "normal",
    origin: "VN",
  },
  {
    id: "ds1-t6-collection",
    turn: 6,
    headline: "集荷量の不足を懸念する声、産地価格に上昇圧力との見方も",
    body:
      "一部の集荷業者から、今後の集荷量が計画を下回る可能性を指摘する声が出ている。" +
      "池の状態にばらつきがあり、想定通りのサイズまで育つか読みにくいという事情があるようだ。" +
      "産地価格への影響について、業界関係者の見方は「多少の上昇は避けられない」から" +
      "「収穫が進めば落ち着く」まで幅がある。現時点で確度の高い数字は出ていない。",
    facts: [f("direction", "集荷量", "不足懸念"), f("outlook", "産地価格", "見方が分かれる")],
    isRumor: true,
    confidence: 0.3,
    eventId: DS1_EVENT_IDS.vnRawShock,
    estimateRange: { low: 0.05, high: 0.3 },
    signalClass: "strong",
    scale: "normal",
    origin: "VN",
  },
  {
    id: "ds1-t6-certification",
    turn: 6,
    headline: "養殖認証の取得件数が増加、欧州小売の要求水準が引き上げ",
    body:
      "国際的な養殖認証の取得件数が各産地で増えている。背景には欧州の小売チェーンが" +
      "調達基準を段階的に引き上げていることがあり、認証がないと棚を確保しにくくなりつつあるという。" +
      "認証機関の担当者は「取得コストは小規模事業者には重いが、長期的には取引の前提になる」と話す。" +
      "産地側では、認証取得を進める農場と様子見の農場に分かれている。",
    facts: [f("topic", "話題", "養殖認証"), f("market", "背景", "欧州小売の調達基準")],
    isRumor: false,
    confidence: 0.8,
    signalClass: "background",
    scale: "background",
    market: "EU",
  },

  // ---- T7: 原料ショック発生 ----
  {
    id: "ds1-t7-shock",
    turn: 7,
    headline: "ベトナム南部で疾病が拡大、集荷価格が急騰",
    body:
      "ベトナム南部の養殖地域で疾病の影響が広がり、収穫量の落ち込みが鮮明になった。" +
      "先月まで限定的とみられていた被害は複数の省に及び、集荷場への持ち込み量は大幅に減少している。" +
      "需給の逼迫を受けて国内の集荷価格は急騰し、加工各社の買付上限を試す水準まで上昇した。" +
      "業界関係者によると、原料が確保できずに稼働を落とす工場が出ているという。" +
      "既に固定価格で受注を積み上げていた加工業者は、上昇した原料costを販売価格へ転嫁できず、採算の悪化に直面している。" +
      "調達を輸入へ切り替える動きも出ているが、発注から到着までには時間がかかるため、当期の生産には間に合わない。" +
      "複数の商社は「インド・エクアドル産の引き合いが急増している」と話しており、産地間の力関係が短期間で変化しつつある。" +
      "疾病の収束時期については見通しが立っていない。",
    facts: [
      f("region", "地域", "ベトナム南部"),
      f("direction", "集荷価格", "急騰"),
      f("supply", "供給", "大幅減"),
      f("impact", "加工業", "稼働低下・採算悪化"),
    ],
    isRumor: false,
    confidence: 0.9,
    eventId: DS1_EVENT_IDS.vnRawShock,
    estimateRange: { low: 0.3, high: 0.6 },
    signalClass: "strong",
    scale: "major",
    origin: "VN",
  },
  {
    id: "ds1-t7-freight",
    turn: 7,
    headline: "アジア発の海上運賃、主要航路で小幅な上昇",
    body:
      "アジア発の海上コンテナ運賃が主要航路で小幅に上昇している。船社の需給調整に加え、" +
      "一部航路で船腹が絞られていることが背景とされる。冷凍貨物のリーファー枠は" +
      "現時点で確保に大きな支障は出ていないが、荷主からは「繁忙期に向けて早めに手当てしたい」との声が出ている。" +
      "運賃の水準は歴史的にみれば依然として落ち着いた範囲内にある。",
    facts: [f("topic", "話題", "海上運賃"), f("direction", "運賃", "小幅上昇")],
    isRumor: false,
    confidence: 0.8,
    signalClass: "background",
    scale: "background",
    market: "GLOBAL",
  },
  {
    id: "ds1-t8-import-switch",
    turn: 8,
    headline: "原料高が続き、加工各社は輸入原料への切替を進める",
    body:
      "ベトナム国内の原料高が続くなか、加工各社が輸入原料の手当てを本格化させている。" +
      "インド・エクアドル産は運賃と関税を含めても国内調達より割安な水準になっており、" +
      "商社によると引き合いは前四半期から大きく増えた。ただし輸入にはリードタイムがあり、" +
      "発注してもすぐには工場へ届かない。国内の集荷量は依然として低調で、" +
      "業界関係者は「回復には数四半期かかるのではないか」と話す。" +
      "一方で、輸入比率を高めた場合の為替・品質・納期のリスクを指摘する声もある。",
    facts: [f("origin", "代替産地", "インド・エクアドル"), f("issue", "留意点", "リードタイム")],
    isRumor: false,
    confidence: 0.85,
    eventId: DS1_EVENT_IDS.vnRawShock,
    signalClass: "strong",
    scale: "normal",
    origin: "VN",
  },
  {
    id: "ds1-t8-consumption",
    turn: 8,
    headline: "主要市場の消費は堅調、輸入業者の在庫復元意欲が強い",
    body:
      "産地の供給が細るなかでも、消費地の販売は堅調を維持している。中国・米国・欧州・日本のいずれでも" +
      "小売の荷動きは悪くなく、輸入業者の在庫復元意欲は強い。輸入商社の担当者は" +
      "「原料高でも売り先は確保できている」と話す。もっとも仕入価格の上昇分をどこまで販売価格へ" +
      "反映できるかは市場ごとに事情が異なり、各社の対応は割れている。",
    facts: [f("markets", "対象市場", "中国・米国・欧州・日本"), f("direction", "消費", "堅調")],
    isRumor: true,
    confidence: 0.45,
    eventId: DS1_EVENT_IDS.consumerBoom,
    signalClass: "weak",
    scale: "normal",
    market: "GLOBAL",
  },
];

// ---------------------------------------------------------------------
// Phase B: T9–16 消費ブーム・商品差別化・global調達
// ---------------------------------------------------------------------

const PHASE_B: readonly NewsSpec[] = [
  {
    id: "ds1-t9-us-pd",
    turn: 9,
    headline: "米国で加工エビ（PD）の需要が拡大、小売の取扱品目が増加",
    body:
      "米国の小売各社で、殻をむいた加工エビ（PD）の取扱品目が増えている。" +
      "調理の手間を省ける商品への支持が強く、冷凍売場での構成比が着実に上がっているという。" +
      "外食チェーンでも下処理済み原料の採用が広がっており、業界関係者は" +
      "「殻付きから加工品への流れは一時的なものではない」と見る。" +
      "輸入業者からは、PD対応の加工能力を持つ産地への発注を増やす動きが出ている。" +
      "一方、殻付きの需要が消えたわけではなく、価格帯によって棲み分けが進むとの見方が一般的だ。",
    facts: [f("market", "市場", "米国"), f("product", "商品", "PD"), f("channel", "販路", "小売・外食")],
    isRumor: false,
    confidence: 0.75,
    signalClass: "strong",
    scale: "normal",
    market: "US",
    product: "pd",
  },
  {
    id: "ds1-t9-boom",
    turn: 9,
    headline: "主要輸入国の需要が想定を上回るペースで拡大していることを確認",
    body:
      "業界団体が集計した四半期の輸入統計で、主要輸入国の需要が事前の想定を上回るペースで" +
      "拡大していることが確認された。中国・米国・欧州・日本のいずれでも前年同期を上回っており、" +
      "その他地域も底堅い。産地側の供給が一部で細っていることもあり、需給は締まった状態が続いている。" +
      "輸入商社は「当面は売り手優位の商いが続くのではないか」と話す。",
    facts: [f("markets", "対象市場", "中国・米国・欧州・日本・その他"), f("direction", "需要", "拡大")],
    isRumor: false,
    confidence: 0.85,
    eventId: DS1_EVENT_IDS.consumerBoom,
    signalClass: "strong",
    scale: "normal",
    market: "GLOBAL",
  },
  {
    id: "ds1-t10-eu-pd",
    turn: 10,
    headline: "欧州小売でむき身製品の取扱いが増加、殻付き中心の構成に変化",
    body:
      "欧州の小売チェーンで、むき身製品の取扱いが増えている。従来この市場は殻付きの構成比が高く、" +
      "調理を前提とした売り方が主流だったが、簡便性を求める購買層の広がりを受けて品揃えが変わりつつある。" +
      "外食向けでも下処理済み原料の採用が進んでおり、輸入業者は「産地に求める加工度が上がってきた」と話す。" +
      "ただし欧州は市場ごとの食文化の差が大きく、変化の速さには国によってばらつきがあるとの指摘もある。",
    facts: [f("market", "市場", "欧州"), f("shift", "構成", "殻付き中心からむき身へ"), f("channel", "販路", "小売・外食")],
    isRumor: false,
    confidence: 0.75,
    signalClass: "strong",
    scale: "normal",
    market: "EU",
    product: "pd",
  },
  {
    id: "ds1-t10-conference",
    turn: 10,
    headline: "養殖学会で疾病対策の研究発表、実用化には時間との見方",
    body:
      "アジア各国の研究者が集まる養殖関連の学会が開かれ、疾病対策に関する複数の研究発表があった。" +
      "種苗の選抜や飼育密度の管理による発症リスク低減が報告されたが、現場での実用化には" +
      "検証期間が必要との見方が大勢を占めた。参加した業界関係者は" +
      "「すぐに効く話ではないが、方向としては期待できる」と話している。",
    facts: [f("topic", "話題", "養殖学会"), f("focus", "テーマ", "疾病対策研究")],
    isRumor: false,
    confidence: 0.75,
    signalClass: "background",
    scale: "background",
    market: "GLOBAL",
  },
  {
    id: "ds1-t11-recovery",
    turn: 11,
    headline: "ベトナムの池入れが回復、集荷量は持ち直しへ",
    body:
      "ベトナムの養殖地域で池入れが回復し、集荷量が持ち直しつつある。疾病の影響を受けた地域でも" +
      "消毒と池の空け期間を経て再開する動きが広がった。集荷場への持ち込み量は前四半期を上回り、" +
      "産地価格は高値から緩やかに下がり始めている。もっとも水準は疾病前を上回っており、" +
      "加工業者からは「元に戻ったとは言えない」との声が多い。" +
      "輸入原料との価格差も縮まってきており、調達構成をどうするかは各社の判断が分かれる局面に入った。",
    facts: [f("region", "地域", "ベトナム"), f("direction", "集荷量", "回復"), f("direction2", "産地価格", "高値から低下")],
    isRumor: false,
    confidence: 0.85,
    eventId: DS1_EVENT_IDS.vnRawShock,
    signalClass: "strong",
    scale: "normal",
    origin: "VN",
  },
  {
    id: "ds1-t11-jp-vap",
    turn: 11,
    headline: "日本で調理済み・味付け製品の販売が伸びているとの小売報告",
    body:
      "日本の小売各社の販売データで、調理済み・味付けタイプの冷凍エビ製品が伸びている。" +
      "共働き世帯の増加を背景に、解凍して盛り付けるだけの商品や、フライ・惣菜向けの半製品が支持されているという。" +
      "バイヤーは「単価は高いが回転が良い」と話す。日本市場はもともと品質・鮮度への要求が厳しく、" +
      "納入には安定した衛生管理と検査体制が求められる。産地側では、対応できる工場が限られるとの指摘もある。",
    facts: [f("market", "市場", "日本"), f("product", "商品", "調理済み・味付け"), f("requirement", "要求", "品質・衛生管理")],
    isRumor: false,
    confidence: 0.7,
    signalClass: "strong",
    scale: "normal",
    market: "JP",
    product: "vap",
  },
  {
    id: "ds1-t12-ecuador-rumor",
    turn: 12,
    headline: "エクアドルで大規模な養殖池拡張が進行しているとの報",
    body:
      "エクアドルの主要生産地域で、養殖池の拡張が大規模に進んでいるとの情報が複数の商社から寄せられている。" +
      "衛星画像を分析した調査会社の資料でも、沿岸部の池面積が数年前と比べて明確に増えているという。" +
      "同国は広い池で低密度に育てる方式が主流で、単位面積あたりの生産性は高くないものの、" +
      "面積の拡大が続けば供給量への影響は無視できないとの見方がある。" +
      "現時点で国際相場に目立った変化は出ていない。関係者の間では、" +
      "拡張分が実際の出荷として市場に出てくるまでにどれくらいかかるかについて見方が分かれている。",
    facts: [f("country", "産地", "エクアドル"), f("direction", "養殖池面積", "拡張"), f("status", "確度", "商社情報・衛星画像分析")],
    isRumor: true,
    confidence: 0.4,
    eventId: DS1_EVENT_IDS.ecuadorExpansion,
    signalClass: "strong",
    scale: "major",
    origin: "EC",
  },
  {
    id: "ds1-t12-jp-retail",
    turn: 12,
    headline: "日本の量販店、冷凍水産の売場を再編する動き",
    body:
      "日本の量販店で冷凍水産売場の再編が進んでいる。単品の冷凍原料を減らし、" +
      "調理済み・半調理の構成比を高める店舗が増えているという。バイヤーは" +
      "「売場面積は変えずに回転を上げたい」と説明する。" +
      "水産以外のカテゴリとの棚の取り合いもあり、各社の方針には差がある。",
    facts: [f("market", "市場", "日本"), f("channel", "販路", "量販店")],
    isRumor: false,
    confidence: 0.75,
    signalClass: "weak",
    scale: "background",
    market: "JP",
  },
  {
    id: "ds1-t13-vn-lean",
    turn: 13,
    headline: "ベトナムは端境期入り、集荷量が細り産地価格は強含み",
    body:
      "ベトナムの養殖は端境期に入り、集荷場への持ち込み量が季節的に細っている。" +
      "産地価格は強含みで推移しており、加工各社の原料手当てはやや難しくなってきた。" +
      "この時期の需給の締まりは例年みられる動きだが、集荷業者からは" +
      "「今年は前年より水準が高い」との指摘も出ている。輸入原料との価格差は縮小しており、" +
      "調達をどう組み合わせるかで各社の対応が分かれている。",
    facts: [f("region", "地域", "ベトナム"), f("season", "時期", "端境期"), f("direction", "産地価格", "強含み")],
    isRumor: false,
    confidence: 0.85,
    signalClass: "strong",
    scale: "normal",
    origin: "VN",
  },
  {
    id: "ds1-cn-spike-t13",
    turn: 13,
    headline: "中国の輸入業者が春節向け在庫の積み増しを開始、一方で複数産地から中国向け出荷増加の観測",
    body:
      "中国の輸入業者が春節需要を見込んだ在庫の積み増しを始めた。卸売市場の関係者によると、" +
      "殻付きエビを中心に引き合いが強まっており、大口の商談が増えているという。" +
      "中国は年間を通じて殻付きの消費量が大きく、この時期の手当てが年間の商いを左右する。" +
      "一方で、複数の産地から中国向け出荷が増えているとの観測もあり、" +
      "供給側の動きによっては相場の上昇幅が限られる可能性も指摘されている。",
    facts: [f("market", "市場", "中国"), f("product", "商品", "殻付き"), f("cause", "背景", "春節向けの在庫積み増し"), f("counterpoint", "他産地の動き", "中国向け出荷増加の観測")],
    isRumor: false,
    confidence: 0.8,
    eventId: ds1CnHosoSpikeEventId(13),
    signalClass: "strong",
    scale: "normal",
    market: "CN",
    product: "hoso",
  },
  {
    id: "ds1-t14-ecuador",
    turn: 14,
    headline: "エクアドル産の輸出量が前年比で大幅増、国際相場に下押し圧力",
    body:
      "エクアドルの輸出統計で、冷凍エビの輸出量が前年同期を大きく上回った。" +
      "数年にわたり進められてきた養殖池の拡張が実際の出荷として市場に出てきた形だ。" +
      "同国産の供給増は国際相場に下押し圧力として働いており、輸入業者からは" +
      "「調達の選択肢が増えた」との声が聞かれる。産地間の価格差は縮小しつつあり、" +
      "従来ベトナム産を中心に組み立ててきた買い手にとっては調達構成を見直す契機になりうる。" +
      "ただし規格・サイズの品揃えや納期の安定性は産地ごとに事情が異なり、" +
      "単純に安いほうへ切り替えられるわけではないとの指摘もある。" +
      "業界団体は「拡張の勢いがいつまで続くかは注視が必要」としている。",
    facts: [f("country", "産地", "エクアドル"), f("direction", "輸出量", "大幅増"), f("impact", "国際相場", "下押し圧力")],
    isRumor: false,
    confidence: 0.8,
    eventId: DS1_EVENT_IDS.ecuadorExpansion,
    signalClass: "strong",
    scale: "major",
    origin: "EC",
  },
  {
    id: "ds1-t14-feed",
    turn: 14,
    headline: "配合飼料価格は横ばい圏、穀物相場の落ち着きを反映",
    body:
      "養殖用配合飼料の価格が横ばい圏で推移している。原料となる穀物・魚粉の国際相場が" +
      "落ち着いていることが背景にある。飼料メーカーは「当面は大きな改定は考えていない」としている。" +
      "養殖コストに占める飼料の比重は大きく、価格が安定していることは生産者にとって好材料だ。",
    facts: [f("topic", "話題", "配合飼料"), f("direction", "価格", "横ばい")],
    isRumor: false,
    confidence: 0.8,
    signalClass: "background",
    scale: "background",
    market: "GLOBAL",
  },
  {
    id: "ds1-t15-vn-peak",
    turn: 15,
    headline: "ベトナムは主漁期に入り、集荷価格は下落",
    body:
      "ベトナムの養殖が主漁期を迎え、集荷場への持ち込み量が大きく増えた。産地価格は前四半期から下落し、" +
      "加工各社にとっては原料を確保しやすい局面になっている。集荷業者は" +
      "「この時期は例年通り。数か月もすればまた細る」と話しており、" +
      "季節的な振れとして受け止められている。輸入原料との価格差は再び開いており、" +
      "手当ての時期をどう選ぶかが各社の調達コストを左右しそうだ。",
    facts: [f("region", "地域", "ベトナム"), f("season", "時期", "主漁期"), f("direction", "集荷価格", "下落")],
    isRumor: false,
    confidence: 0.85,
    signalClass: "strong",
    scale: "normal",
    origin: "VN",
  },
  {
    id: "ds1-cn-spike-t15",
    turn: 15,
    headline: "中国の輸入業者による買付が活発化、一方で複数産地から中国向け出荷増加の観測",
    body:
      "中国の輸入業者による買付が活発化している。夏場の消費期を控えた手当てとみられ、" +
      "沿海部の卸売市場では殻付きエビの取扱量が増えている。相場は堅調に推移しているが、" +
      "複数の産地から中国向け出荷が増えているとの観測もあり、需給の締まり具合は読みにくい。" +
      "現地の卸売業者は「量は出ているが、値段は思ったほど上がっていない」と話している。",
    facts: [f("market", "市場", "中国"), f("product", "商品", "殻付き"), f("cause", "背景", "輸入業者の買付活発化"), f("counterpoint", "他産地の動き", "中国向け出荷増加の観測")],
    isRumor: false,
    confidence: 0.8,
    eventId: ds1CnHosoSpikeEventId(15),
    signalClass: "strong",
    scale: "normal",
    market: "CN",
    product: "hoso",
  },
  {
    id: "ds1-t16-relative-cost",
    turn: 16,
    headline: "産地間のコスト差が拡大、ベトナム産の相対的な割高感を指摘する声",
    body:
      "産地ごとの生産コストの差が広がっている。エクアドルは池の拡張と規模の効果でコストを下げており、" +
      "インドも輸出競争力を高めている。一方ベトナムは疾病対策の負担や飼料・人件費の上昇で" +
      "コストが上向いており、業界関係者からは「相対的な割高感が出てきた」との指摘が出ている。" +
      "輸入業者は産地を組み合わせた調達に軸足を移しつつあり、" +
      "単一産地に依存した調達構成の見直しを進める動きが広がっている。",
    facts: [f("comparison", "比較", "ベトナム vs 他産地"), f("direction", "コスト差", "拡大")],
    isRumor: false,
    confidence: 0.75,
    signalClass: "strong",
    scale: "normal",
    market: "GLOBAL",
  },
  {
    id: "ds1-t16-foodservice-warning",
    turn: 16,
    headline: "外食向け出荷にかげりとの指摘、複数市場で予約が伸び悩む",
    body:
      "外食向けの冷凍水産品の出荷に、かげりを指摘する声が出ている。複数の市場で" +
      "レストランの予約件数が伸び悩んでいるとの報告があり、業務用卸からは" +
      "「発注のペースが落ちている」との証言も聞かれる。" +
      "一部の都市では大型イベントの中止・延期が相次いでおり、宴会需要への影響を懸念する向きもある。" +
      "ただし小売向けの荷動きは今のところ大きく崩れておらず、業界全体としての基調判断は分かれている。" +
      "輸入業者の中には、新規の手当てを一旦絞って様子を見る動きも出始めた。" +
      "業界団体の担当者は「季節的な調整の範囲内かもしれないし、そうでないかもしれない。" +
      "もう少しデータを見たい」と述べるにとどめている。産地側では、受注の先行きを" +
      "どう織り込むかで生産計画の立て方が変わってくるとの声も聞かれる。",
    facts: [f("channel", "販路", "外食"), f("direction", "動向", "弱含み"), f("status", "確度", "業務用卸の証言")],
    isRumor: true,
    confidence: 0.35,
    eventId: DS1_EVENT_IDS.demandShock,
    estimateRange: { low: -0.4, high: -0.1 },
    signalClass: "strong",
    scale: "major",
    market: "GLOBAL",
  },
  {
    id: "ds1-t16-importer-caution",
    turn: 16,
    headline: "一部の輸入商社が新規契約に慎重姿勢、在庫回転を優先",
    body:
      "一部の輸入商社が新規契約の締結に慎重な姿勢を見せている。手元在庫の回転を優先し、" +
      "先物の手当てを控える動きだという。担当者は「特別な理由があるわけではなく、" +
      "在庫水準を平常に戻す過程」と説明する。ただし同様の動きが複数社で見られることから、" +
      "産地側では受注の伸びが鈍化する可能性を意識する声も出ている。",
    facts: [f("actor", "主体", "輸入商社"), f("direction", "新規契約", "慎重")],
    isRumor: true,
    confidence: 0.3,
    signalClass: "weak",
    scale: "normal",
    market: "GLOBAL",
  },
];

// ---------------------------------------------------------------------
// Phase C: T17–24 世界需要ショック・隠れた機会・再開ブーム
// ---------------------------------------------------------------------

const PHASE_C: readonly NewsSpec[] = [
  {
    id: "ds1-t17-shock",
    turn: 17,
    headline: "主要市場で外食需要が急減、新規契約の獲得が困難に",
    body:
      "中国・日本・米国・欧州の主要市場で外食需要が急速に落ち込んでいる。" +
      "レストランの客足が大きく減り、業務用卸の発注は前四半期から大幅に縮小した。" +
      "冷凍エビの新規契約は成立しにくくなっており、産地側では商談が流れる事例が相次いでいる。" +
      "販売価格にも下押し圧力がかかっており、輸入業者は「買い手優位に転じた」と話す。" +
      "各社の手元在庫は膨らみつつあり、在庫評価と資金繰りへの影響を懸念する声が強まっている。" +
      "工場の稼働をどこまで落とすか、人員をどう維持するかという判断を迫られる加工業者も出てきた。" +
      "業界団体は「先行きの見通しを立てるのが難しい局面」としており、回復の時期については" +
      "現時点で確度の高い見方は示されていない。",
    facts: [
      f("markets", "対象市場", "中国・日本・米国・欧州"),
      f("direction", "需要", "急減"),
      f("direction2", "販売価格", "下落"),
      f("impact", "在庫", "積み上がり"),
    ],
    isRumor: false,
    confidence: 0.9,
    eventId: DS1_EVENT_IDS.demandShock,
    estimateRange: { low: -0.45, high: -0.25 },
    signalClass: "strong",
    scale: "major",
    market: "GLOBAL",
  },
  {
    id: "ds1-t17-others-hint",
    turn: 17,
    headline: "外食が低迷する一方、家庭用冷凍水産食品の販売は拡大",
    body:
      "外食向けが大きく落ち込むなかで、家庭用の冷凍水産食品は販売を伸ばしている。" +
      "小売各社によると、自宅で調理する機会が増えたことを背景に、" +
      "解凍してすぐ使える商品や、味付け済みの惣菜型商品の動きが良いという。" +
      "販路や地域によって伸び方には差があり、全体像はまだつかみにくい。" +
      "業務用に軸足を置いてきた加工業者からは「販路の構成を見直す必要があるかもしれない」との声も出ている。",
    facts: [f("channel", "販路", "家庭用・小売"), f("direction", "販売", "拡大"), f("status", "確度", "小売各社の報告")],
    isRumor: true,
    confidence: 0.4,
    eventId: DS1_EVENT_IDS.othersRetailGrowth,
    signalClass: "strong",
    scale: "normal",
    market: "OTHER",
  },
  {
    id: "ds1-t17-warehouse",
    turn: 17,
    headline: "冷蔵倉庫の稼働率が上昇、保管枠の確保に動く荷主も",
    body:
      "主要港周辺の冷蔵倉庫で稼働率が上昇している。荷動きの鈍化で在庫の滞留が増えたためで、" +
      "一部の地域では保管枠の確保が難しくなりつつあるという。倉庫会社は" +
      "「季節的な要因もあり、直ちに逼迫するわけではない」と説明している。" +
      "保管費の負担増を懸念する荷主からは、在庫水準を見直す動きも出ている。",
    facts: [f("topic", "話題", "冷蔵倉庫"), f("direction", "稼働率", "上昇")],
    isRumor: false,
    confidence: 0.8,
    signalClass: "background",
    scale: "background",
    market: "GLOBAL",
  },
  {
    id: "ds1-t18-destocking",
    turn: 18,
    headline: "輸入業者が在庫調整に動き、新規成約は低調",
    body:
      "主要市場の輸入業者が在庫調整を本格化させている。積み上がった在庫を優先的に販売する方針で、" +
      "産地への新規発注は絞られた状態が続く。商社の担当者は「価格を下げても引き合いが戻らない」と話す。" +
      "産地側では受注残の消化が進む一方、新規の商談が細っており、" +
      "生産計画の見直しを迫られる加工業者が増えている。" +
      "資金繰りへの影響を懸念し、金融機関との調整に入る動きも出始めた。",
    facts: [f("direction", "在庫", "調整局面"), f("direction2", "新規成約", "低調")],
    isRumor: false,
    confidence: 0.85,
    eventId: DS1_EVENT_IDS.demandShock,
    signalClass: "strong",
    scale: "normal",
    market: "GLOBAL",
  },
  {
    id: "ds1-t18-middleeast",
    turn: 18,
    headline: "中東の小売チェーンで家庭用冷凍水産品の販売が増加",
    body:
      "中東地域の小売チェーンで、家庭用の冷凍水産品の販売が伸びている。" +
      "現代的な業態の店舗が都市部で増えていることが背景にあり、冷凍売場の面積を広げる店も出てきた。" +
      "現地のバイヤーは「調理の手間が少ない商品が支持されている」と話す。" +
      "この地域は市場ごとの規模が小さく統計の整備も進んでいないため、" +
      "全体としてどの程度の量になるのかは把握しづらい。",
    facts: [f("region", "地域", "中東"), f("channel", "販路", "小売"), f("direction", "販売", "増加")],
    isRumor: false,
    confidence: 0.7,
    eventId: DS1_EVENT_IDS.othersRetailGrowth,
    signalClass: "weak",
    scale: "normal",
    market: "OTHER",
  },
  {
    id: "ds1-t19-restructuring",
    turn: 19,
    headline: "稼働率低下で加工各社は減産・人員調整へ",
    body:
      "需要の落ち込みが続くなか、加工各社が減産と人員の調整に踏み切っている。" +
      "残業の取りやめや臨時要員の削減が中心だが、一部ではラインの一時停止に踏み込む工場も出た。" +
      "業界団体は「固定費の重い設備を抱えたままでは持たない」と現状を説明する。" +
      "一方で、能力を落としすぎると需要が戻ったときに対応できなくなるとの懸念もあり、" +
      "どこまで縮小するかの判断は各社で分かれている。",
    facts: [f("direction", "稼働率", "低下"), f("action", "対応", "減産・人員調整")],
    isRumor: false,
    confidence: 0.85,
    eventId: DS1_EVENT_IDS.demandShock,
    signalClass: "strong",
    scale: "normal",
    origin: "VN",
  },
  {
    id: "ds1-t19-oceania",
    turn: 19,
    headline: "豪州・東南アジア都市部で簡便調理型シーフードの販売が堅調",
    body:
      "豪州や東南アジアの都市部で、簡便調理型のシーフード製品の販売が堅調に推移している。" +
      "共働き世帯や単身世帯の増加を背景に、電子レンジやフライパンで仕上げられる商品が支持されているという。" +
      "現地の小売関係者は「以前は輸入品の品揃えが限られていたが、選べるようになってきた」と話す。" +
      "地域ごとに流通構造が異なるため、供給側から見た全体像はつかみにくい。",
    facts: [f("region", "地域", "豪州・東南アジア都市部"), f("product", "商品", "簡便調理型"), f("direction", "販売", "堅調")],
    isRumor: false,
    confidence: 0.7,
    eventId: DS1_EVENT_IDS.othersRetailGrowth,
    signalClass: "weak",
    scale: "normal",
    market: "OTHER",
  },
  {
    id: "ds1-t20-others-retail",
    turn: 20,
    headline: "小売向け・アジア都市部の販売は堅調との報告、中東・オセアニアでも取扱いが増加",
    body:
      "外食が低迷を続けるなかで、小売向けの販売は各地域で底堅く推移している。" +
      "アジアの都市部に加え、中東・オセアニアでも冷凍水産品の取扱いが増えており、" +
      "現地の小売チェーンは品揃えを広げる動きを見せている。特に下処理済み・味付け済みの" +
      "商品カテゴリの伸びが目立つという。これらの市場は個々の規模が大きくないため" +
      "統計上は目立ちにくいが、合計するとまとまった量になるとの見方も出ている。" +
      "商社の担当者は「業務用が戻るまでの受け皿になっている」と話す。",
    facts: [f("region", "地域", "中東・オセアニア・アジア都市部"), f("channel", "販路", "小売"), f("product", "商品", "下処理済み・味付け済み")],
    isRumor: false,
    confidence: 0.7,
    eventId: DS1_EVENT_IDS.othersRetailGrowth,
    signalClass: "strong",
    scale: "normal",
    market: "OTHER",
  },
  {
    id: "ds1-t20-reopening-early",
    turn: 20,
    headline: "一部地域で外食の客足が下げ止まったとの声、業界団体は回復時期を慎重に見る",
    body:
      "一部の地域で、外食の客足が下げ止まりつつあるとの声が出始めた。業務用卸のなかには" +
      "「最悪期は過ぎたのではないか」と話す向きもある。ただし観測は地域や業態によってまちまちで、" +
      "業界団体は「全体としての回復を語るには早い」と慎重な姿勢を崩していない。" +
      "輸入業者の多くは依然として在庫水準を低く保っており、新規手当ての動きは限定的だ。",
    facts: [f("channel", "販路", "外食"), f("status", "確度", "一部地域の観測"), f("assessment", "業界団体", "慎重")],
    isRumor: true,
    confidence: 0.3,
    eventId: DS1_EVENT_IDS.reopeningBoom,
    signalClass: "weak",
    scale: "normal",
    market: "GLOBAL",
  },
  {
    id: "ds1-t20-expo-online",
    turn: 20,
    headline: "国際水産見本市はオンライン開催に、商談件数は例年を下回る",
    body:
      "毎年開かれてきた国際水産見本市が、今年はオンライン形式での開催となった。" +
      "主催者によると参加登録数は一定数を確保したものの、商談件数は例年を下回っている。" +
      "対面での試食・品質確認ができないことが商談の成立を難しくしているとの指摘がある。" +
      "参加した商社からは「来年は現地開催に戻ってほしい」との声が聞かれた。",
    facts: [f("topic", "話題", "見本市"), f("format", "形式", "オンライン開催")],
    isRumor: false,
    confidence: 0.85,
    signalClass: "background",
    scale: "background",
    market: "GLOBAL",
  },

  // ---- T21: 回復シグナル3件（効果はまだゼロ） ----
  {
    id: "ds1-t21-reopening",
    turn: 21,
    headline: "レストランの営業再開の動きが広がる",
    body:
      "各地でレストランの営業再開の動きが広がっている。営業時間や席数の制限が段階的に緩められ、" +
      "予約件数が回復しつつあるとの報告が複数の市場から寄せられている。外食チェーンのなかには" +
      "休止していた店舗の再開を決めるところも出てきた。" +
      "業務用卸は「発注の問い合わせが増えてきた」と話すが、実際の出荷にどの程度つながるかは" +
      "まだ見えていない。産地側では、受注が戻ったときに供給できる体制が整っているかどうかが" +
      "問われることになる。",
    facts: [f("channel", "販路", "外食"), f("direction", "動向", "再開"), f("status", "確度", "複数市場の報告")],
    isRumor: true,
    confidence: 0.4,
    eventId: DS1_EVENT_IDS.reopeningBoom,
    signalClass: "strong",
    scale: "normal",
    market: "GLOBAL",
  },
  {
    id: "ds1-t21-restocking",
    turn: 21,
    headline: "輸入業者が在庫の復元を開始したとの観測",
    body:
      "主要市場の輸入業者が在庫の復元に動き始めたとの観測が出ている。" +
      "在庫調整を進めた結果、手元の水準が平常時を下回った企業が増えているためだ。" +
      "商社の担当者は「安く買えるうちに戻しておきたいという心理が働いている」と話す。" +
      "ただし各社の判断はばらついており、様子見を続ける企業も少なくない。" +
      "産地側の供給余力は、この数四半期の減産で以前より小さくなっている。",
    facts: [f("direction", "在庫", "復元開始"), f("status", "確度", "観測"), f("note", "供給余力", "減産により縮小")],
    isRumor: true,
    confidence: 0.4,
    eventId: DS1_EVENT_IDS.reopeningBoom,
    signalClass: "strong",
    scale: "normal",
    market: "GLOBAL",
  },
  {
    id: "ds1-t21-easing",
    turn: 21,
    headline: "各国で移動・営業の制限緩和が進む",
    body:
      "各国で移動と営業に関する制限の緩和が進んでいる。国境をまたぐ往来の再開や" +
      "イベントの開催制限の解除が段階的に行われており、消費環境は改善の方向にある。" +
      "小売・外食の関係者からは「客足の戻りを実感している」との声が出始めた。" +
      "一方、緩和のペースは地域によって差があり、全市場で同時に需要が戻るとは限らないとの見方もある。",
    facts: [f("policy", "政策", "制限緩和"), f("note", "地域差", "緩和ペースに差")],
    isRumor: true,
    confidence: 0.35,
    eventId: DS1_EVENT_IDS.reopeningBoom,
    signalClass: "strong",
    scale: "normal",
    market: "GLOBAL",
  },

  {
    id: "ds1-t22-boom",
    turn: 22,
    headline: "世界需要が急回復、供給が追いつかず相場は上昇",
    body:
      "主要市場の需要が急速に回復している。外食の営業が本格的に戻り、" +
      "小売の販売も好調を維持していることから、輸入業者の発注が一斉に増えた。" +
      "産地側は前四半期までの減産で供給余力を落としており、需要の戻りに追いついていない。" +
      "需給の逼迫を受けて相場は上昇し、商談は売り手優位の状態に転じた。" +
      "商社の担当者は「今から手配しても間に合わない案件が出ている」と話す。" +
      "生産能力と人員を維持してきた加工業者には受注が集中する一方、" +
      "縮小を進めた企業は引き合いに応えきれていない。" +
      "この局面がどれくらい続くかについては見方が分かれており、" +
      "産地の増産が本格化すれば需給は緩むとの指摘もある。",
    facts: [
      f("direction", "需要", "急回復"),
      f("direction2", "相場", "上昇"),
      f("balance", "需給", "供給が追いつかない"),
    ],
    isRumor: false,
    confidence: 0.9,
    eventId: DS1_EVENT_IDS.reopeningBoom,
    estimateRange: { low: 0.1, high: 0.35 },
    signalClass: "strong",
    scale: "major",
    market: "GLOBAL",
  },
  {
    id: "ds1-t22-freight-up",
    turn: 22,
    headline: "海上運賃が上昇、リーファー枠の確保が難しく",
    body:
      "荷動きの急回復を受けて海上運賃が上昇している。冷凍貨物のリーファー枠は主要航路で" +
      "取り合いになっており、希望の便に載せられない事例が出ているという。" +
      "船社は配船の見直しを進めているが、需要の戻りが急なため対応が追いついていない。" +
      "荷主からは「運賃よりも枠が取れるかどうかが問題」との声が聞かれる。",
    facts: [f("topic", "話題", "海上運賃"), f("direction", "運賃", "上昇"), f("issue", "課題", "リーファー枠の確保")],
    isRumor: false,
    confidence: 0.85,
    signalClass: "weak",
    scale: "background",
    market: "GLOBAL",
  },
  {
    id: "ds1-t23-india",
    turn: 23,
    headline: "インドで輸出通関の遅延、出荷が滞る",
    body:
      "インドの主要港で輸出通関の遅延が発生し、冷凍エビの出荷が滞っている。" +
      "検査体制の見直しに伴う手続きの変更が背景とされ、書類の再提出を求められる事例が相次いでいるという。" +
      "輸出業者は「解消の見通しは立っていない」と話す。" +
      "インド産の供給が一時的に細ることで、他産地への引き合いが強まる可能性がある。" +
      "需要が回復している局面での供給支障だけに、買い手側は代替の確保を急いでいる。",
    facts: [f("country", "産地", "インド"), f("direction", "輸出", "遅延"), f("cause", "背景", "通関手続きの変更")],
    isRumor: false,
    confidence: 0.85,
    eventId: DS1_EVENT_IDS.indiaDisruption,
    signalClass: "strong",
    scale: "normal",
    origin: "IN",
  },
  {
    id: "ds1-cn-spike-t23",
    turn: 23,
    headline: "中国で外食再開と在庫復元が重なり買付が急増、一方で複数産地から中国向け出荷増加の観測",
    body:
      "中国で外食の営業再開と輸入業者の在庫復元が重なり、殻付きエビの買付が急増している。" +
      "沿海部の卸売市場では取扱量が大きく伸び、大口の商談が続いているという。" +
      "現地の関係者は「これほど急に戻るとは思っていなかった」と話す。" +
      "一方、複数の産地から中国向け出荷が増えているとの観測もあり、" +
      "供給側の動きによっては相場の上昇が抑えられる可能性も指摘されている。",
    facts: [f("market", "市場", "中国"), f("product", "商品", "殻付き"), f("cause", "背景", "外食再開と在庫復元"), f("counterpoint", "他産地の動き", "中国向け出荷増加の観測")],
    isRumor: false,
    confidence: 0.8,
    eventId: ds1CnHosoSpikeEventId(23),
    signalClass: "strong",
    scale: "normal",
    market: "CN",
    product: "hoso",
  },
  {
    id: "ds1-t24-jp-premium",
    turn: 24,
    headline: "日本のプレミアム市場も回復、高付加価値品の引き合いが強い",
    body:
      "日本市場で高付加価値品の引き合いが強まっている。外食の回復に加えて、" +
      "小売でも調理済み・味付け済みの商品が好調を維持しており、" +
      "百貨店・高質スーパーの売場でも取扱いが広がっている。" +
      "バイヤーは「価格よりも品質と安定供給を重視する」と話しており、" +
      "衛生管理と検査体制を備えた工場への発注が集中する傾向にある。" +
      "産地側では、対応できる加工能力を持つかどうかで受注の差が出始めている。",
    facts: [f("market", "市場", "日本"), f("product", "商品", "高付加価値品"), f("requirement", "要求", "品質・安定供給")],
    isRumor: false,
    confidence: 0.8,
    signalClass: "strong",
    scale: "normal",
    market: "JP",
    product: "vap",
  },
  {
    id: "ds1-t24-cn-premium-hint",
    turn: 24,
    headline: "中国都市部で調理済み・むき身製品の取扱いが増え始めたとの小売調査",
    body:
      "中国の都市部を対象とした小売調査で、調理済み・むき身タイプの冷凍水産品の" +
      "取扱店舗数が増え始めていることが分かった。従来この市場は殻付きの消費量が圧倒的に大きく、" +
      "加工度の高い商品は限られた層のものだったが、中間所得層の拡大と現代的な小売業態の普及を背景に" +
      "変化の兆しが出ているという。調査を実施した機関は「まだ全体から見れば小さい」と断りつつ、" +
      "「都市部に限れば伸び率は無視できない」と指摘している。" +
      "食品の安全性への関心の高まりから、ブランド化された商品への支持も強まっているようだ。",
    facts: [f("market", "市場", "中国"), f("channel", "販路", "都市部小売"), f("status", "確度", "小売調査"), f("note", "規模", "全体から見れば小さい")],
    isRumor: true,
    confidence: 0.4,
    signalClass: "strong",
    scale: "major",
    market: "CN",
  },
  {
    id: "ds1-t24-cn-middleclass",
    turn: 24,
    headline: "中国の中間所得層拡大に関する報告書、食品支出の構成変化を指摘",
    body:
      "調査機関がまとめた報告書によると、中国の中間所得層は都市部を中心に拡大を続けている。" +
      "食品支出に占める加工品・冷凍食品の比率が上がっており、" +
      "「価格よりも品質と利便性を重視する購買層が厚みを増している」と分析している。" +
      "報告書は水産物に限定したものではないが、業界関係者の間では" +
      "「棚の構成が変わっていく前触れかもしれない」との受け止めもある。",
    facts: [f("market", "市場", "中国"), f("topic", "話題", "中間所得層の拡大")],
    isRumor: false,
    confidence: 0.7,
    signalClass: "weak",
    scale: "normal",
    market: "CN",
  },
];

// ---------------------------------------------------------------------
// Phase D: T25–32 拡大・China premiumization・業界再編
// ---------------------------------------------------------------------

const PHASE_D: readonly NewsSpec[] = [
  {
    id: "ds1-t25-cn-premium",
    turn: 25,
    headline: "中国都市部で調理済み・むき身製品の消費が拡大",
    body:
      "中国の都市部で、調理済み・むき身タイプの冷凍水産品の消費が拡大している。" +
      "量販店・コンビニエンスストアの冷凍売場が広がり、単身世帯や共働き世帯を中心に" +
      "手軽に使える商品への支持が定着してきた。食品の安全性に対する関心が高いことから、" +
      "産地と製造工程が明示されたブランド商品が選ばれる傾向が強い。" +
      "従来この市場は殻付きの取引量が圧倒的で、加工度の高い商品は限定的だったが、" +
      "構成の変化が数字に表れ始めている。輸入業者は「求められる加工度が上がってきた」と話す。" +
      "産地側では、加工能力と品質管理の体制を備えた工場に商談が集まりつつある。" +
      "もっとも殻付きの需要が減ったわけではなく、当面は両方の商いが並存するとの見方が一般的だ。",
    facts: [f("market", "市場", "中国"), f("product", "商品", "調理済み・むき身"), f("channel", "販路", "量販店・コンビニ"), f("driver", "要因", "利便性・食品安全への関心")],
    isRumor: false,
    confidence: 0.8,
    signalClass: "strong",
    scale: "major",
    market: "CN",
  },
  {
    id: "ds1-cn-spike-t25",
    turn: 25,
    headline: "春節向けの在庫積み増しが本格化、一方で複数産地から中国向け出荷増加の観測",
    body:
      "中国で春節需要を見込んだ在庫の積み増しが本格化している。殻付きエビを中心に" +
      "大口の引き合いが続いており、卸売市場の取扱量は前四半期を上回った。" +
      "現地の輸入業者は「今年は早めに動いている先が多い」と話す。" +
      "ただし複数の産地から中国向け出荷が増えているとの観測もあり、" +
      "手当てが集中すれば相場の上昇は限定的にとどまる可能性がある。",
    facts: [f("market", "市場", "中国"), f("product", "商品", "殻付き"), f("cause", "背景", "春節向けの在庫積み増し"), f("counterpoint", "他産地の動き", "中国向け出荷増加の観測")],
    isRumor: false,
    confidence: 0.8,
    eventId: ds1CnHosoSpikeEventId(25),
    signalClass: "strong",
    scale: "normal",
    market: "CN",
    product: "hoso",
  },
  {
    id: "ds1-t26-cn-retail",
    turn: 26,
    headline: "中国の量販店でエビ加工品の売場が拡大",
    body:
      "中国の量販店で、エビ加工品の売場面積が広がっている。" +
      "従来は鮮魚・冷凍原料が中心だった売場に、下処理済みや味付け済みの商品が並ぶようになった。" +
      "小売側は「回転が良く、粗利も取りやすい」と説明する。" +
      "供給側では、こうした商品を安定して供給できる産地・工場が限られることから、" +
      "取引先の選定が進んでいるという。",
    facts: [f("market", "市場", "中国"), f("channel", "販路", "量販店"), f("direction", "売場", "拡大")],
    isRumor: false,
    confidence: 0.75,
    signalClass: "strong",
    scale: "normal",
    market: "CN",
  },
  {
    id: "ds1-t26-vn-warning",
    turn: 26,
    headline: "ベトナム一部地域の池で成長のばらつきが出ているとの現地報告",
    body:
      "ベトナムの一部養殖地域で、池ごとに成長のばらつきが出ているとの報告が現地から寄せられている。" +
      "水温の推移が例年と異なることが影響しているとの見方があるが、原因は特定されていない。" +
      "現時点で斃死の増加は限定的で、集荷量への影響も表面化していない。" +
      "集荷業者は「様子を見ている段階」と話しており、産地価格に目立った動きは出ていない。" +
      "一部の農家は次の池入れを慎重に判断しているという。",
    facts: [f("region", "地域", "ベトナム一部"), f("status", "確度", "未確認の現地報告"), f("current", "集荷量への影響", "表面化していない")],
    isRumor: true,
    confidence: 0.3,
    eventId: DS1_EVENT_IDS.vietnamDiseaseY7,
    signalClass: "weak",
    scale: "normal",
    origin: "VN",
  },
  {
    id: "ds1-t26-automation",
    turn: 26,
    headline: "加工ラインの自動化投資が各国で進む、人手不足が背景",
    body:
      "水産加工の現場で自動化投資が進んでいる。人手の確保が難しくなっていることが背景にあり、" +
      "選別・計量・包装の工程を中心に機器の導入が広がっているという。" +
      "設備メーカーは「引き合いは堅調」と話す。ただし脱皮など手作業に依存する工程は残っており、" +
      "全面的な自動化には至っていない。投資回収には数年を要するため、判断は企業規模によって分かれている。",
    facts: [f("topic", "話題", "加工自動化"), f("cause", "背景", "人手不足")],
    isRumor: false,
    confidence: 0.8,
    signalClass: "background",
    scale: "background",
    market: "GLOBAL",
  },
  {
    id: "ds1-t27-vn-disease",
    turn: 27,
    headline: "ベトナムの一部地域で疾病、集荷価格が上昇",
    body:
      "ベトナムの一部養殖地域で疾病の発生が確認され、収穫量が落ち込んでいる。" +
      "先の四半期に報告されていた成長のばらつきが、疾病によるものだったことが明らかになった形だ。" +
      "被害の範囲は数年前の大規模な発生時ほどではないとみられるが、" +
      "集荷量の減少を受けて産地価格は上昇している。" +
      "加工業者は原料costの上昇分をどう扱うか判断を迫られており、" +
      "輸入原料への振り替えを検討する動きも出ている。" +
      "需要が堅調な局面での供給支障だけに、影響は限定的とは言い切れないとの見方もある。",
    facts: [f("region", "地域", "ベトナム一部"), f("direction", "集荷価格", "上昇"), f("scale", "被害範囲", "過去の大規模発生時ほどではない")],
    isRumor: false,
    confidence: 0.85,
    eventId: DS1_EVENT_IDS.vietnamDiseaseY7,
    signalClass: "strong",
    scale: "normal",
    origin: "VN",
  },
  {
    id: "ds1-cn-spike-t27",
    turn: 27,
    headline: "産地の不作を受け中国が代替産地からの買付を強める、一方で複数産地から中国向け出荷増加の観測",
    body:
      "一部産地の不作を受けて、中国の輸入業者が代替産地からの買付を強めている。" +
      "確保を優先する動きから引き合いが広がり、殻付きエビの相場は堅調に推移している。" +
      "現地の卸売業者は「量を揃えるのが難しくなってきた」と話す。" +
      "もっとも複数の産地から中国向け出荷が増えているとの観測もあり、" +
      "供給の組み替えが進めば相場の上昇は抑えられる可能性がある。",
    facts: [f("market", "市場", "中国"), f("product", "商品", "殻付き"), f("cause", "背景", "産地不作による代替買付"), f("counterpoint", "他産地の動き", "中国向け出荷増加の観測")],
    isRumor: false,
    confidence: 0.8,
    eventId: ds1CnHosoSpikeEventId(27),
    signalClass: "strong",
    scale: "normal",
    market: "CN",
    product: "hoso",
  },
  {
    id: "ds1-t28-cost-pressure",
    turn: 28,
    headline: "原料高で加工各社の採算は圧迫、調達先の見直しが進む",
    body:
      "原料価格の上昇が続き、加工各社の採算が圧迫されている。" +
      "販売は堅調だが、仕入れの上昇分を販売価格へ転嫁しきれていない企業が多い。" +
      "調達先の見直しを進める動きが広がっており、複数の産地を組み合わせる調達構成が主流になりつつある。" +
      "業界関係者は「一つの産地に頼る時代ではなくなった」と話す。" +
      "一方、産地ごとに規格・納期・品質の事情が異なるため、切り替えには手間と時間がかかるとの指摘もある。",
    facts: [f("direction", "採算", "悪化"), f("action", "対応", "調達先の見直し")],
    isRumor: false,
    confidence: 0.8,
    eventId: DS1_EVENT_IDS.vietnamDiseaseY7,
    signalClass: "strong",
    scale: "normal",
    origin: "VN",
  },
  {
    id: "ds1-t28-consolidation",
    turn: 28,
    headline: "業界再編の観測、中堅加工業者の統合を巡る話題",
    body:
      "水産加工業界で再編を巡る話題が出ている。設備投資の負担と原料調達力の差から" +
      "中堅企業の統合が進むのではないかとの見方があり、金融機関の関係者からも" +
      "「規模の差が競争力の差になりつつある」との指摘が聞かれる。" +
      "現時点で具体的な案件が公表されているわけではなく、あくまで観測の段階にとどまる。",
    facts: [f("topic", "話題", "業界再編"), f("status", "確度", "観測")],
    isRumor: true,
    confidence: 0.3,
    signalClass: "background",
    scale: "background",
    market: "GLOBAL",
  },
  {
    id: "ds1-t29-ec-warning",
    turn: 29,
    headline: "エクアドルで生育不良の報告、次期の出荷減を懸念する声",
    body:
      "エクアドルの一部生産地域で、生育不良の報告が出ている。" +
      "沿岸部の水温と塩分濃度が例年と異なる推移を見せていることが影響しているとの見方があるが、" +
      "確認は取れていない。現地の輸出業者は「今の出荷には影響していない」としつつ、" +
      "次期の出荷量については慎重な見方を示している。" +
      "同国は近年の増産で国際供給の重要な部分を担っており、" +
      "動向を注視する買い手が増えている。",
    facts: [f("country", "産地", "エクアドル"), f("status", "確度", "未確認の報告"), f("current", "現在の出荷", "影響なし")],
    isRumor: true,
    confidence: 0.35,
    eventId: DS1_EVENT_IDS.ecuadorDiseaseY8,
    signalClass: "weak",
    scale: "normal",
    origin: "EC",
  },
  {
    id: "ds1-cn-spike-t29",
    turn: 29,
    headline: "春節向け手当てと物流の逼迫が重なる、一方で複数産地から中国向け出荷増加の観測",
    body:
      "中国で春節向けの手当てが進むなか、物流の逼迫が重なっている。" +
      "リーファーコンテナの枠が取りにくく、着荷の遅れを見込んで早めに発注する動きが出ているという。" +
      "殻付きエビの相場は上昇基調にあり、卸売市場の関係者は「需要と物流の両方が効いている」と話す。" +
      "複数の産地から中国向け出荷が増えているとの観測もあるため、" +
      "供給が揃えば上昇は一服する可能性もある。",
    facts: [f("market", "市場", "中国"), f("product", "商品", "殻付き"), f("cause", "背景", "春節向け手当てと物流逼迫"), f("counterpoint", "他産地の動き", "中国向け出荷増加の観測")],
    isRumor: false,
    confidence: 0.8,
    eventId: ds1CnHosoSpikeEventId(29),
    signalClass: "strong",
    scale: "normal",
    market: "CN",
    product: "hoso",
  },
  {
    id: "ds1-t30-ec-disease",
    turn: 30,
    headline: "エクアドルで疾病が広がり、輸出量が減少",
    body:
      "エクアドルの生産地域で疾病が広がり、輸出量が減少している。" +
      "先の四半期に報告されていた生育不良は疾病によるものと確認され、被害は複数の地域に及んだ。" +
      "同国は近年の池拡張で国際供給の中核を担ってきただけに、出荷の減少は国際相場に影響を与えている。" +
      "輸入業者は代替産地の確保を急いでおり、インド・ベトナム産への引き合いが強まっているという。" +
      "商社の担当者は「エクアドル一本で組んでいた買い手は苦しい」と話す。" +
      "回復の時期については、池の空け期間と再放養のサイクルを考えると" +
      "短期間では戻らないとの見方が大勢を占めている。" +
      "調達先を分散していた企業とそうでない企業とで、対応力の差が表れる局面となった。",
    facts: [f("country", "産地", "エクアドル"), f("direction", "輸出量", "減少"), f("impact", "買い手", "代替産地の確保を急ぐ")],
    isRumor: false,
    confidence: 0.9,
    eventId: DS1_EVENT_IDS.ecuadorDiseaseY8,
    signalClass: "strong",
    scale: "major",
    origin: "EC",
  },
  {
    id: "ds1-t30-insurance",
    turn: 30,
    headline: "養殖保険の引き合いが増加、保険料率の見直しも",
    body:
      "疾病リスクの高まりを受けて、養殖保険の引き合いが増えている。" +
      "保険会社は支払い実績を踏まえた料率の見直しを進めており、地域によっては引き上げも検討されているという。" +
      "生産者からは「掛け金の負担が重い」との声が出ているが、" +
      "取引先から加入を求められるケースも増えているようだ。" +
      "保険の設計は地域ごとの事情に左右されるため、普及の度合いには差がある。",
    facts: [f("topic", "話題", "養殖保険"), f("direction", "引き合い", "増加")],
    isRumor: false,
    confidence: 0.8,
    signalClass: "background",
    scale: "background",
    market: "GLOBAL",
  },
  {
    id: "ds1-t31-supply-tight",
    turn: 31,
    headline: "エクアドル減産の影響が国際相場へ波及、産地間の供給余力に差",
    body:
      "エクアドルの減産の影響が国際相場に波及している。同国産の出荷が細ったことで" +
      "需給が締まり、他産地の価格にも上昇圧力がかかった。" +
      "産地ごとの供給余力には差があり、増産余地のある地域へ引き合いが集中している。" +
      "輸入業者は「どの産地から、どの規格を、いつ確保するかで仕入コストがかなり違ってくる」と話す。" +
      "需要側は堅調を維持しており、当面は締まった商いが続くとの見方が多い。",
    facts: [f("direction", "国際相場", "上昇"), f("note", "産地", "供給余力に差")],
    isRumor: false,
    confidence: 0.85,
    eventId: DS1_EVENT_IDS.ecuadorDiseaseY8,
    signalClass: "strong",
    scale: "normal",
    market: "GLOBAL",
  },
  {
    id: "ds1-cn-spike-t31",
    turn: 31,
    headline: "中国国内の供給不足で相場が上昇、一方で複数産地から中国向け出荷増加の観測",
    body:
      "中国国内の供給不足を背景に、殻付きエビの相場が上昇している。" +
      "国内産の水揚げが伸び悩むなか、輸入への依存度が高まっているという。" +
      "卸売市場の関係者は「思ったより在庫が薄い」と話す。" +
      "季節的な水揚げの端境期に当たることも重なり、当面は輸入頼みの商いが続きそうだ。" +
      "一方で複数の産地から中国向け出荷が増えているとの観測もあり、" +
      "着荷が進めば需給は落ち着くとの見方もある。",
    facts: [f("market", "市場", "中国"), f("product", "商品", "殻付き"), f("cause", "背景", "国内供給の不足"), f("counterpoint", "他産地の動き", "中国向け出荷増加の観測")],
    isRumor: false,
    confidence: 0.8,
    eventId: ds1CnHosoSpikeEventId(31),
    signalClass: "strong",
    scale: "normal",
    market: "CN",
    product: "hoso",
  },
  {
    id: "ds1-t32-outlook",
    turn: 32,
    headline: "世界需要は拡大基調を維持、産地の再編が進むとの見方",
    body:
      "業界団体の四半期報告によると、世界のエビ需要は拡大基調を維持している。" +
      "市場ごとに求められる加工度は変わってきており、殻付き中心の商いから" +
      "加工品を含む幅広い品揃えへと構成が移りつつある。" +
      "供給側では疾病リスクとコスト競争力の差から産地の再編が進むとの見方があり、" +
      "調達先を複数持つことの重要性を指摘する声が増えている。" +
      "報告は「今後も地域ごとに異なる速度で変化が進む」としており、" +
      "市場と商品の組み合わせをどう選ぶかが引き続き問われる。",
    facts: [f("direction", "世界需要", "拡大基調"), f("trend", "商品構成", "加工度の上昇"), f("trend2", "供給", "産地再編の見方")],
    isRumor: false,
    confidence: 0.75,
    signalClass: "background",
    scale: "normal",
    market: "GLOBAL",
  },
  {
    id: "ds1-t32-consumption-stats",
    turn: 32,
    headline: "冷凍水産物の一人当たり消費、地域差が拡大との統計",
    body:
      "調査機関が公表した統計によると、冷凍水産物の一人当たり消費量は地域による差が広がっている。" +
      "都市化の進展と小売業態の変化が影響しているとみられ、" +
      "同じ地域内でも都市部と地方で傾向が分かれるという。" +
      "統計の対象は水産物全般で、エビに限定した内訳は公表されていない。",
    facts: [f("topic", "話題", "消費統計"), f("finding", "傾向", "地域差の拡大")],
    isRumor: false,
    confidence: 0.7,
    signalClass: "background",
    scale: "background",
    market: "GLOBAL",
  },
];

/** Turn 1〜32 の全記事（レビュー用メタデータつき）。 */
export const DS1_NEWS_SPECS: readonly NewsSpec[] = [...PHASE_A, ...PHASE_B, ...PHASE_C, ...PHASE_D];

/**
 * プレイヤー向け News（standard レベル）。
 * すべて availableFromTurn = その turn。過去の News も蓄積して読める
 * （informationEngine が availableFromTurn <= turn で絞る）。
 *
 * **signalClass / scale / market / product / origin は含めない。**
 * プレイヤーは見出しと本文から自分で重要度を判断する。
 */
export const DS1_INFORMATION_RELEASES: readonly InformationRelease[] = DS1_NEWS_SPECS.map((spec) => ({
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
export function ds1InformationIdsForEvent(eventId: string): readonly string[] {
  return DS1_NEWS_SPECS.filter((s) => s.eventId === eventId).map((s) => s.id);
}

/** CN HOSO スパイクの記事が、パラメータ側の全スパイクを漏れなく覆っているかの検証用。 */
export const DS1_CN_HOSO_SPIKE_TURNS: readonly number[] = DS1_CN_HOSO_SPIKES.map((s) => s.turn);

/**
 * News と effect 開始ターンの同期宣言。テストがこの表と実際のイベント定義を
 * 突き合わせ、Leading Indicator のターンで発現強度が 0 であることを検証する。
 */
export const DS1_NEWS_EFFECT_SYNC: readonly NewsEffectSync[] = [
  // 先読み判断点 — News は出るが effect はまだゼロ
  { informationId: "ds1-t4-importer-stock", eventId: DS1_EVENT_IDS.consumerBoom, newsTurn: 4, effectStartTurn: 8, leadQuarters: 4 },
  { informationId: "ds1-t6-disease-rumor", eventId: DS1_EVENT_IDS.vnRawShock, newsTurn: 6, effectStartTurn: 7, leadQuarters: 1 },
  { informationId: "ds1-t6-cn-buying", eventId: DS1_EVENT_IDS.vnRawShock, newsTurn: 6, effectStartTurn: 7, leadQuarters: 1 },
  { informationId: "ds1-t6-collection", eventId: DS1_EVENT_IDS.vnRawShock, newsTurn: 6, effectStartTurn: 7, leadQuarters: 1 },
  { informationId: "ds1-t12-ecuador-rumor", eventId: DS1_EVENT_IDS.ecuadorExpansion, newsTurn: 12, effectStartTurn: 13, leadQuarters: 1 },
  { informationId: "ds1-t16-foodservice-warning", eventId: DS1_EVENT_IDS.demandShock, newsTurn: 16, effectStartTurn: 17, leadQuarters: 1 },
  { informationId: "ds1-t20-reopening-early", eventId: DS1_EVENT_IDS.reopeningBoom, newsTurn: 20, effectStartTurn: 22, leadQuarters: 2 },
  { informationId: "ds1-t21-reopening", eventId: DS1_EVENT_IDS.reopeningBoom, newsTurn: 21, effectStartTurn: 22, leadQuarters: 1 },
  { informationId: "ds1-t21-restocking", eventId: DS1_EVENT_IDS.reopeningBoom, newsTurn: 21, effectStartTurn: 22, leadQuarters: 1 },
  { informationId: "ds1-t21-easing", eventId: DS1_EVENT_IDS.reopeningBoom, newsTurn: 21, effectStartTurn: 22, leadQuarters: 1 },
  { informationId: "ds1-t26-vn-warning", eventId: DS1_EVENT_IDS.vietnamDiseaseY7, newsTurn: 26, effectStartTurn: 27, leadQuarters: 1 },
  { informationId: "ds1-t29-ec-warning", eventId: DS1_EVENT_IDS.ecuadorDiseaseY8, newsTurn: 29, effectStartTurn: 30, leadQuarters: 1 },
  // 事象と同時に出る確報
  { informationId: "ds1-t7-shock", eventId: DS1_EVENT_IDS.vnRawShock, newsTurn: 7, effectStartTurn: 7, leadQuarters: 0 },
  { informationId: "ds1-t17-shock", eventId: DS1_EVENT_IDS.demandShock, newsTurn: 17, effectStartTurn: 17, leadQuarters: 0 },
  { informationId: "ds1-t17-others-hint", eventId: DS1_EVENT_IDS.othersRetailGrowth, newsTurn: 17, effectStartTurn: 17, leadQuarters: 0 },
  { informationId: "ds1-t22-boom", eventId: DS1_EVENT_IDS.reopeningBoom, newsTurn: 22, effectStartTurn: 22, leadQuarters: 0 },
  { informationId: "ds1-t23-india", eventId: DS1_EVENT_IDS.indiaDisruption, newsTurn: 23, effectStartTurn: 23, leadQuarters: 0 },
  { informationId: "ds1-t27-vn-disease", eventId: DS1_EVENT_IDS.vietnamDiseaseY7, newsTurn: 27, effectStartTurn: 27, leadQuarters: 0 },
  { informationId: "ds1-t30-ec-disease", eventId: DS1_EVENT_IDS.ecuadorDiseaseY8, newsTurn: 30, effectStartTurn: 30, leadQuarters: 0 },
];
