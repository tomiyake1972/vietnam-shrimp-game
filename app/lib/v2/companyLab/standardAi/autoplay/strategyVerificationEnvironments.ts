// ShrimpX V2 — 商品戦略プロファイル検証用「環境」（市場条件）定義
//
// 【目的】Task 27の商品戦略プロファイル（standardAi/strategyProfile.ts の
// BALANCED / HOSO_SCALE / PD_AUTOMATION / VAP_DIFFERENTIATION）が、それぞれの
// 狙いどおりの市場環境（HOSO追い風・PD追い風・VAP追い風）で最も好成績を
// 収めるかを、後続タスクの32ターン・シミュレーションで検証できるようにする
// ための、4つの市場条件（環境）シナリオ定義。
//
// 【重要な設計方針】
// 1. 既存の長期シナリオ・イベントモジュール（app/lib/v2/scenario/）をそのまま
//    再利用する。新しい「市場条件」の型・パイプラインは作らない
//    （ScenarioDefinition / LongTermTrend / commonTrends.ts のビルダーヘルパーを
//    そのまま使う。globalDemandBoom.ts 等、既存の代表シナリオと全く同じ
//    パターンで「ベースラインを土台に、需要・供給トレンドの差分だけを
//    上書きする」）。
// 2. app/lib/v2/scenario/definitions/index.ts の ALL_SCENARIO_DEFINITIONS
//    （実装指示 §12の「代表5シナリオ」）には追加しない。
//    industryLab/cli/__tests__/scenarioAliases.test.ts が
//    `ALL_SCENARIO_DEFINITIONS.length === 5` を固定で検証しており、この4環境は
//    その「代表5シナリオ」とは別カテゴリ（companyLab商品戦略プロファイル検証
//    専用）のため、既存の代表シナリオ一覧を汚染しない。代わりに
//    companyLab/runner.ts の findScenarioDefinitionForCompanyLab() 側に、
//    resolveScenarioDefinition() で見つからない場合のフォールバックとして
//    本ファイルの resolveStrategyVerificationEnvironment() を追加する
//    （既存のscenarioId解決を一切変更せず、後方互換）。
// 3. market/productPremium.ts は一切変更しない。VAP/PD市場全体プレミアムは
//    同ファイルの calculateProductPremium() が、(a) 呼び出し側から渡される
//    「需要」（capacityDemand.demand。シナリオの REGIONAL_DEMAND 長期トレンド→
//    ScenarioTurnInput.pdVapDemand 経由の外生入力）と (b) 呼び出し側が
//    ScenarioTurnCountryVariables.pdProcessingCapacity /
//    vapProcessingCapacity（シナリオの PD_PROCESSING_CAPACITY /
//    VAP_PROCESSING_CAPACITY 長期トレンドという外生入力。既定では
//    production に対する比率（0.3 / 0.1）で自動導出されるが、シナリオが
//    明示的なLongTermTrendを与えればそちらが優先される
//    — scenarioEngine.ts computeCountryVariables 参照）の需給比から
//    世界稼働率→ベースプレミアム倍率を算出する。したがって「VAPプレミアムを
//    引き上げる」には、productPremium.ts 内部の数式やパラメータを一切
//    触らずとも、シナリオ側でVAP処理能力の伸びを需要成長より意図的に
//    遅くする（＝需給を逼迫させる）だけで実現できる。本ファイルの
//    VAP_TAILWIND・PD_TAILWIND はこの外生レバーだけを使う。
// 4. app/lib/v2/companyLab/decision/*.ts・policy.ts は一切変更しない。
//    本ファイルはシナリオ入力データのみを定義する。
//
// 【4環境の位置づけ】
//   NORMAL         — ベースラインそのもの（差分ゼロ）。他3環境と比較する基準。
//   HOSO_TAILWIND  — バルクHOSO輸出（特に中国向け）需要が強く伸び、かつ世界
//                    HOSO原料供給の伸びが抑制される。原料調達を大量に確保
//                    できる規模・関係性優位（procurementScaleState.ts）が
//                    効きやすい環境。
//   PD_TAILWIND    — 品質・安定供給に敏感な需要が全市場で底堅く伸びる一方、
//                    世界のPD処理能力の伸びがその需要成長に追いつかない
//                    （＝PD稼働率が高止まりしPDプレミアムを押し上げる）。
//                    さらにベースラインの疾病・景気減速イベントを外し、
//                    価格変動を抑えることで「安定生産者に報いる」環境を表す。
//    VAP_TAILWIND  — 高付加価値・小売直結市場（US/EU/JP中心）のVAP需要が
//                    強く伸びる一方、世界のVAP処理能力の伸びがその需要成長に
//                    追いつかない（＝VAP稼働率が高止まりしVAP市場全体
//                    プレミアムを押し上げる）。VAP差別化戦略
//                    （companyRealizedVapPremiumRatio等）が効きやすい環境。
//
// すべての数値は本ファイル新規・要校正の仮置き（他シナリオ同様、Phase2の
// 「実データ照合は未実施」という前提を引き継ぐ）。

import { CountryId, DemandMarketId } from "../../../market/types";
import { LongTermTrend, ScenarioDefinition } from "../../../scenario/types";
import {
  SCENARIO_ENGINE_PARAMETERS_V1,
  SCENARIO_INITIAL_STATE_OVERRIDES_V1,
  SCENARIO_PREHISTORY_BASELINE_V1,
  SCENARIO_VARIATION_SETTINGS_STANDARD,
  STANDARD_SCENARIO_DURATION_TURNS,
} from "../../../scenario/parameters";
import {
  COUNTRY_IDS,
  DEFAULT_CAPACITY_GROWTH_RATIO,
  DEFAULT_DEMAND_GROWTH_RATIO,
  standardAquacultureCostTrends,
  standardCapacityTrends,
  standardDemandTrends,
  standardEconomicIndexTrends,
} from "../../../scenario/definitions/commonTrends";
import { countryTrend, kf } from "../../../scenario/definitions/trendHelpers";
import { BASELINE_SCENARIO } from "../../../scenario/definitions/baseline";

// ---------------------------------------------------------------------
// 環境ID
// ---------------------------------------------------------------------

export type StrategyVerificationEnvironmentId = "NORMAL" | "HOSO_TAILWIND" | "PD_TAILWIND" | "VAP_TAILWIND";

export const STRATEGY_VERIFICATION_ENVIRONMENT_IDS: readonly StrategyVerificationEnvironmentId[] = [
  "NORMAL",
  "HOSO_TAILWIND",
  "PD_TAILWIND",
  "VAP_TAILWIND",
];

// ---------------------------------------------------------------------
// 共通ヘルパー
// ---------------------------------------------------------------------

/**
 * PD/VAP処理能力トレンドの既定フォールバック（production比率）を、シナリオ
 * 前史のturn1供給量から近似したもの。scenarioEngine.tsのcomputeCountryVariables
 * が使う実際のフォールバック式（productionRaw * ratio）と同じ考え方を、
 * シナリオ定義側で「ほぼ横ばい（需要成長に対して意図的に遅い伸び）」の明示
 * トレンドを作るための起点としてだけ使う（productPremium.tsは変更しない）。
 */
function approxTurn1Production(country: CountryId): number {
  return SCENARIO_PREHISTORY_BASELINE_V1.countrySupplyHosoEqTons[country];
}

/**
 * PD_PROCESSING_CAPACITY / VAP_PROCESSING_CAPACITY を、需要成長よりも明確に
 * 遅い伸び（ほぼ横ばい）で明示指定する。既定フォールバック（productionに連動
 * して伸び続ける）を上書きすることで、対象製品の世界稼働率を高止まりさせ、
 * calculateProductPremium() のutilizationMultiplierを押し上げる
 * （productPremium.ts自体は無改変の外生入力レバー）。
 */
function tightProcessingCapacityTrends(
  idPrefix: string,
  variable: "PD_PROCESSING_CAPACITY" | "VAP_PROCESSING_CAPACITY",
  ratioOfProduction: number,
  endGrowthRatio: number
): LongTermTrend[] {
  return COUNTRY_IDS.map((c) => {
    const start = approxTurn1Production(c) * ratioOfProduction;
    return countryTrend(`${idPrefix}-${variable.toLowerCase()}-${c}`, variable, c, [
      kf(1, start),
      kf(STANDARD_SCENARIO_DURATION_TURNS, start * endGrowthRatio),
    ]);
  });
}

// ---------------------------------------------------------------------
// NORMAL — ベースラインそのもの（差分ゼロ）
// ---------------------------------------------------------------------

/**
 * ベースラインシナリオ（BASELINE_SCENARIO）の長期トレンド・イベント・前史・
 * 初期状態をそのまま参照する（同一オブジェクト参照）。scenarioIdとテキスト
 * 説明のみを検証環境向けに差し替える。これにより
 * getScenarioTurnInput()が返す数値パラメータはベースラインとビット単位で
 * 一致する（テストで検証）。
 */
export const STRATEGY_VERIFICATION_NORMAL_ENVIRONMENT: ScenarioDefinition = {
  ...BASELINE_SCENARIO,
  scenarioId: "strategy-verification-normal-v0.1",
  title: "商品戦略プロファイル検証：NORMAL（無風・ベースライン同一）",
  publicBackground: BASELINE_SCENARIO.publicBackground,
  gmDescription:
    "商品戦略プロファイル検証専用のNORMAL環境。BASELINE_SCENARIOの長期トレンド・" +
    "イベント・前史・初期状態を無改変でそのまま使う（差分ゼロ）。HOSO_TAILWIND / " +
    "PD_TAILWIND / VAP_TAILWIND と比較する際の基準環境。",
  postGameExplanation: BASELINE_SCENARIO.postGameExplanation,
};

// ---------------------------------------------------------------------
// HOSO_TAILWIND — バルクHOSO需要増 + 世界HOSO供給の伸び抑制
// ---------------------------------------------------------------------

/**
 * 中国（最大のバルクHOSO輸出先）とOTHER（その他バルク輸出市場）の需要成長率を
 * ベースラインより大きく引き上げる。US/EU/JPはベースライン据え置き
 * （HOSO_SCALE戦略が主戦場とする市場だけを動かす）。
 */
const HOSO_TAILWIND_DEMAND_GROWTH_RATIO: Readonly<Record<DemandMarketId, number>> = {
  ...DEFAULT_DEMAND_GROWTH_RATIO,
  CN: 1.55, // ベースライン1.21 → +34pt。中国向けバルクHOSO輸出需要の顕著な拡大。
  OTHER: 1.35, // ベースライン1.17 → +18pt。その他バルク輸出市場も追随。
};

/**
 * 4か国とも、HOSO原料供給（養殖能力）の伸びをベースラインの半分弱に抑える。
 * 供給が需要ほど伸びないため原料調達がタイトになり、大量購入・関係性構築に
 * よる価格優位（procurementScaleState.ts、トレーリング4クォーター購買量→
 * 価格割引・関係スコア）を持つ会社ほど原料を確保しやすくなる。
 */
const HOSO_TAILWIND_CAPACITY_GROWTH_RATIO: Readonly<Record<CountryId, number>> = {
  EC: 1.05, // ベースライン1.10 → 伸び幅を半減
  IN: 1.04, // ベースライン1.08
  ID: 1.035, // ベースライン1.07
  VN: 1.045, // ベースライン1.09
};

export const STRATEGY_VERIFICATION_HOSO_TAILWIND_ENVIRONMENT: ScenarioDefinition = {
  scenarioId: "strategy-verification-hoso-tailwind-v0.1",
  version: "0.1.0",
  title: "商品戦略プロファイル検証：HOSO_TAILWIND（バルクHOSO追い風）",
  durationTurns: STANDARD_SCENARIO_DURATION_TURNS,

  publicBackground:
    "中国向けを中心にバルクHOSO輸出需要が力強く拡大する一方、世界の養殖能力の伸びは" +
    "緩やかにとどまり、原料調達がタイト化していく。",
  gmDescription:
    "商品戦略プロファイル検証専用のHOSO_TAILWIND環境。前史・PD/VAP処理能力・景気指数・" +
    "養殖コストトレンドはBASELINE_SCENARIOと共有し、(1) CN/OTHERの地域別潜在需要成長率を" +
    "引き上げ、(2) 4か国の養殖能力（COUNTRY_CAPACITY）成長率をベースラインの半分弱に" +
    "抑制する、という2つの差分だけを与える。PD_PROCESSING_CAPACITY/" +
    "VAP_PROCESSING_CAPACITYは明示トレンドを与えず既定フォールバック（production比率）" +
    "のままとし、PD/VAPプレミアムへの影響を意図的に中立に保つ（HOSO_SCALE戦略の" +
    "効果だけを切り分けるため）。",
  postGameExplanation:
    "中国+OTHERのバルク需要拡大（8年でCN×1.55・OTHER×1.35、ベースラインCN×1.21・" +
    "OTHER×1.17）と、4か国供給能力の伸び抑制（ベースライン比おおむね半分弱）を組み合わせ、" +
    "HOSO原料調達の逼迫度をベースラインより高める設計とした。procurementScaleState.tsの" +
    "大量購買・関係性による価格優位が、この環境下でより大きな差になることを想定している。",

  prehistory: SCENARIO_PREHISTORY_BASELINE_V1,
  initialStateOverrides: SCENARIO_INITIAL_STATE_OVERRIDES_V1,

  longTermTrends: [
    ...standardDemandTrends("strategy-hoso-tailwind", HOSO_TAILWIND_DEMAND_GROWTH_RATIO),
    ...standardEconomicIndexTrends("strategy-hoso-tailwind"),
    ...standardCapacityTrends("strategy-hoso-tailwind", [], HOSO_TAILWIND_CAPACITY_GROWTH_RATIO),
    ...standardAquacultureCostTrends("strategy-hoso-tailwind"),
  ],

  scheduledEvents: [],
  informationReleases: [],

  variationSettings: SCENARIO_VARIATION_SETTINGS_STANDARD,
};

// ---------------------------------------------------------------------
// PD_TAILWIND — 品質・安定供給志向の底堅い需要 + PD処理能力逼迫 + 低ボラティリティ
// ---------------------------------------------------------------------

/**
 * 全5市場で、ベースラインよりやや強い（ただしHOSO_TAILWINDほど極端ではない）
 * 底堅い需要成長。「品質・信頼性に敏感な需要が着実に伸びる」という物語を表す。
 */
const PD_TAILWIND_DEMAND_GROWTH_RATIO: Readonly<Record<DemandMarketId, number>> = {
  CN: 1.28, // ベースライン1.21
  US: 1.15, // ベースライン1.11
  EU: 1.09, // ベースライン1.06
  JP: 1.05, // ベースライン1.02
  OTHER: 1.22, // ベースライン1.17
};

/**
 * PD処理能力は、既定フォールバック（productionに連動し続けて伸びる）ではなく、
 * ほぼ横ばい（8年で+5%のみ）に明示固定する。PD需要側は上記のとおり着実に
 * 伸びるため、世界PD稼働率が高止まりし、calculateProductPremium()の
 * utilizationMultiplierを通じてPDプレミアムが押し上げられる
 * （PD自動化(pdMechanizationEffect.ts)による省人化コスト優位が、稼働率の高い
 * ＝需要が旺盛な環境でより効いてくることを想定）。
 */
const PD_TAILWIND_PD_CAPACITY_TRENDS: LongTermTrend[] = tightProcessingCapacityTrends(
  "strategy-pd-tailwind",
  "PD_PROCESSING_CAPACITY",
  SCENARIO_ENGINE_PARAMETERS_V1.defaultPdCapacityRatioOfProduction,
  1.05
);

/**
 * ベトナム・インドネシアの品質評価（QUALITY_SCORE）を緩やかに引き上げる。
 * 「品質・安定供給に敏感な需要が、品質に優れる産地を選好する」という
 * 物語を表す（productPremium.tsのqualityAdjustmentRatio経由でPD/VAP双方の
 * プレミアムに反映されるが、VAP処理能力は本環境では据え置きのため、PD側の
 * 稼働率逼迫と合わせて相対的にPDへの追い風が大きくなる）。
 */
const PD_TAILWIND_QUALITY_SCORE_TRENDS: LongTermTrend[] = (["VN", "ID"] as const).map((c) =>
  countryTrend(`strategy-pd-tailwind-quality-${c}`, "QUALITY_SCORE", c, [
    kf(1, SCENARIO_ENGINE_PARAMETERS_V1.defaultQualityScore),
    kf(STANDARD_SCENARIO_DURATION_TURNS, SCENARIO_ENGINE_PARAMETERS_V1.defaultQualityScore + 12),
  ])
);

export const STRATEGY_VERIFICATION_PD_TAILWIND_ENVIRONMENT: ScenarioDefinition = {
  scenarioId: "strategy-verification-pd-tailwind-v0.1",
  version: "0.1.0",
  title: "商品戦略プロファイル検証：PD_TAILWIND（品質・安定供給追い風）",
  durationTurns: STANDARD_SCENARIO_DURATION_TURNS,

  publicBackground:
    "品質・安定供給への感度が高い需要が全市場で着実に拡大する一方、世界のPD処理能力の" +
    "伸びはそれに追いつかず、PD向けの需給が引き締まっていく。大規模な疾病・景気ショックは" +
    "発生しない、比較的穏やかな相場環境。",
  gmDescription:
    "商品戦略プロファイル検証専用のPD_TAILWIND環境。前史・VAP処理能力・養殖能力・" +
    "養殖コストトレンドはBASELINE_SCENARIOと共有し、(1) 全5市場の地域別潜在需要成長率を" +
    "ベースラインよりやや強めに（ただしHOSO_TAILWINDのような偏りなく全市場均等に）引き上げ、" +
    "(2) PD_PROCESSING_CAPACITYを明示トレンドでほぼ横ばいに固定してPD稼働率を高止まりさせ、" +
    "(3) VN/IDのQUALITY_SCOREを緩やかに引き上げ、(4) ベースラインの疾病・景気減速イベントを" +
    "一切配置しない（価格変動を抑え、安定生産者に報いる環境を表す）、という4つの差分を与える。" +
    "VAP_PROCESSING_CAPACITYは明示トレンドを与えず既定フォールバックのままとし、VAP" +
    "プレミアムへの影響を意図的に中立に保つ（PD_AUTOMATION戦略の効果だけを切り分けるため）。",
  postGameExplanation:
    "需要は全市場均等にベースラインよりやや強め（8年でCN×1.28〜OTHER×1.22、ベースライン比" +
    "+3〜7pt程度）に伸ばしつつ、PD処理能力の伸びを+5%（ほぼ横ばい）に抑えることで、PD稼働率が" +
    "ベースラインより高い水準で推移するよう設計した。加えてベースラインに配置されていた" +
    "小規模イベント（インドネシア疾病・世界景気減速）を除外し、価格の予見可能性を高めている。" +
    "pdMechanizationEffect.tsによる省人化コスト優位とPD市場プレミアムの両方が効きやすい" +
    "環境になることを想定している。",

  prehistory: SCENARIO_PREHISTORY_BASELINE_V1,
  initialStateOverrides: SCENARIO_INITIAL_STATE_OVERRIDES_V1,

  longTermTrends: [
    ...standardDemandTrends("strategy-pd-tailwind", PD_TAILWIND_DEMAND_GROWTH_RATIO),
    ...standardEconomicIndexTrends("strategy-pd-tailwind"),
    ...standardCapacityTrends("strategy-pd-tailwind", [], DEFAULT_CAPACITY_GROWTH_RATIO),
    ...standardAquacultureCostTrends("strategy-pd-tailwind"),
    ...PD_TAILWIND_PD_CAPACITY_TRENDS,
    ...PD_TAILWIND_QUALITY_SCORE_TRENDS,
  ],

  scheduledEvents: [],
  informationReleases: [],

  variationSettings: SCENARIO_VARIATION_SETTINGS_STANDARD,
};

// ---------------------------------------------------------------------
// VAP_TAILWIND — 高付加価値市場のVAP需要増 + VAP処理能力逼迫
// ---------------------------------------------------------------------

/**
 * US/EU/JP（小売直結・高付加価値志向の強い市場）とCNの需要成長率をベースライン
 * より大きく引き上げる。OTHERはベースライン据え置き。
 */
const VAP_TAILWIND_DEMAND_GROWTH_RATIO: Readonly<Record<DemandMarketId, number>> = {
  ...DEFAULT_DEMAND_GROWTH_RATIO,
  CN: 1.30, // ベースライン1.21
  US: 1.35, // ベースライン1.11 → +24pt
  EU: 1.30, // ベースライン1.06 → +24pt
  JP: 1.20, // ベースライン1.02 → +18pt
};

/**
 * VAP処理能力は、既定フォールバック（productionに連動して伸び続ける）ではなく、
 * ほぼ横ばい（8年で+2%のみ）に明示固定する。VAP需要側は上記のとおり大きく
 * 伸びるため、世界VAP稼働率が高止まりし、calculateProductPremium()の
 * utilizationMultiplierを通じて市場全体のVAPプレミアムが押し上げられる
 * （market/productPremium.ts自体は無改変。VAP差別化戦略が上乗せする会社別
 * 実現プレミアム比率(calculateCompanyRealizedVapPremiumRatio)は、この市場全体
 * プレミアムに対する掛け目として効くため、本環境で絶対的な効果が大きくなる）。
 */
const VAP_TAILWIND_VAP_CAPACITY_TRENDS: LongTermTrend[] = tightProcessingCapacityTrends(
  "strategy-vap-tailwind",
  "VAP_PROCESSING_CAPACITY",
  SCENARIO_ENGINE_PARAMETERS_V1.defaultVapCapacityRatioOfProduction,
  1.02
);

export const STRATEGY_VERIFICATION_VAP_TAILWIND_ENVIRONMENT: ScenarioDefinition = {
  scenarioId: "strategy-verification-vap-tailwind-v0.1",
  version: "0.1.0",
  title: "商品戦略プロファイル検証：VAP_TAILWIND（高付加価値需要追い風）",
  durationTurns: STANDARD_SCENARIO_DURATION_TURNS,

  publicBackground:
    "米国・EU・日本を中心に、高付加価値・小売直結需要が力強く拡大する。世界のVAP処理能力の" +
    "伸びはそれに追いつかず、VAP向けの需給が引き締まっていく。",
  gmDescription:
    "商品戦略プロファイル検証専用のVAP_TAILWIND環境。前史・PD処理能力・養殖能力・" +
    "養殖コストトレンドはBASELINE_SCENARIOと共有し、(1) US/EU/JP/CNの地域別潜在需要成長率を" +
    "引き上げ、(2) VAP_PROCESSING_CAPACITYを明示トレンドでほぼ横ばいに固定してVAP稼働率を" +
    "高止まりさせる、という2つの差分だけを与える。PD_PROCESSING_CAPACITYは明示トレンドを" +
    "与えず既定フォールバックのままとし、PDプレミアムへの影響を意図的に中立に保つ" +
    "（VAP_DIFFERENTIATION戦略の効果だけを切り分けるため）。",
  postGameExplanation:
    "US/EU/JPの高付加価値需要拡大（8年でUS×1.35・EU×1.30・JP×1.20、ベースラインUS×1.11・" +
    "EU×1.06・JP×1.02）とCNの上乗せ（×1.30）に、VAP処理能力の伸び抑制（+2%のみ、既定" +
    "フォールバックはproductionに連動してさらに伸び続ける）を組み合わせ、世界VAP稼働率と" +
    "市場全体VAPプレミアムをベースラインより高める設計とした。productDevelopmentState.ts /" +
    " premiumPolicy.ts の会社別VAP差別化投資が、この環境下でより大きな利益差になることを" +
    "想定している。",

  prehistory: SCENARIO_PREHISTORY_BASELINE_V1,
  initialStateOverrides: SCENARIO_INITIAL_STATE_OVERRIDES_V1,

  longTermTrends: [
    ...standardDemandTrends("strategy-vap-tailwind", VAP_TAILWIND_DEMAND_GROWTH_RATIO),
    ...standardEconomicIndexTrends("strategy-vap-tailwind"),
    ...standardCapacityTrends("strategy-vap-tailwind", [], DEFAULT_CAPACITY_GROWTH_RATIO),
    ...standardAquacultureCostTrends("strategy-vap-tailwind"),
    ...VAP_TAILWIND_VAP_CAPACITY_TRENDS,
  ],

  scheduledEvents: [],
  informationReleases: [],

  variationSettings: SCENARIO_VARIATION_SETTINGS_STANDARD,
};

// ---------------------------------------------------------------------
// レジストリ・解決関数
// ---------------------------------------------------------------------

export const STRATEGY_VERIFICATION_ENVIRONMENTS: Readonly<
  Record<StrategyVerificationEnvironmentId, ScenarioDefinition>
> = {
  NORMAL: STRATEGY_VERIFICATION_NORMAL_ENVIRONMENT,
  HOSO_TAILWIND: STRATEGY_VERIFICATION_HOSO_TAILWIND_ENVIRONMENT,
  PD_TAILWIND: STRATEGY_VERIFICATION_PD_TAILWIND_ENVIRONMENT,
  VAP_TAILWIND: STRATEGY_VERIFICATION_VAP_TAILWIND_ENVIRONMENT,
};

const ALL_STRATEGY_VERIFICATION_ENVIRONMENTS: readonly ScenarioDefinition[] =
  STRATEGY_VERIFICATION_ENVIRONMENT_IDS.map((id) => STRATEGY_VERIFICATION_ENVIRONMENTS[id]);

/**
 * scenarioId（完全一致）から検証環境のScenarioDefinitionを解決する。
 * ALL_SCENARIO_DEFINITIONS（代表5シナリオ）には含まれないため、
 * industryLab側のresolveScenarioDefinition()では解決できない。
 * companyLab/runner.ts の findScenarioDefinitionForCompanyLab() が、
 * 既存の解決に失敗した場合のフォールバックとしてこれを呼ぶ。
 */
export function resolveStrategyVerificationEnvironment(scenarioId: string): ScenarioDefinition | undefined {
  return ALL_STRATEGY_VERIFICATION_ENVIRONMENTS.find((d) => d.scenarioId === scenarioId);
}
