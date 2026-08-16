// ShrimpX V2 — Dynamic Scenario 1: 数値パラメータの唯一の集約地点
//
// 実装指示「数値は必ず設定ファイルへ集約し、校正前の仮置きと明記する」に対応。
// dynamicScenario1.ts / dynamicScenario1News.ts はここの値だけを参照し、
// 定義ロジック中にマジックナンバーを書かない。
//
// すべて **candidate（校正前の仮置き）**。Phase 5 benchmark で再検討する前提。
// 各値の根拠は Phase 1 監査の実測（docs/v2/design/DYNAMIC_SCENARIO_1_PHASE1_AUDIT.md）
// に基づく。

import { CountryId, DemandMarketId } from "../../market/types";
import { ProductLifecycleOverrides } from "../../market/productLifecycle";
import { ScenarioInitialStateOverrides, StructuralDemandAnchorSettings } from "../types";
import { SCENARIO_PREHISTORY_BASELINE_V1 } from "../parameters";

export const DS1_DURATION_TURNS = 32;

// ---------------------------------------------------------------------
// 1. 加工経済（買付上限 = VN_FOB × recovery − 控除額）
// ---------------------------------------------------------------------
//
// 【なぜ既定の 1.10 から 0.45 へ絞るか】Phase 1 実測で、控除額 1.10 のままでは
// 供給・コストレバーをどれだけ動かしても「T13以降の端境期に輸入が有利になる」
// 局面を一度も作れなかった（最良ケースでも国内が輸入より 7.3% 安いまま）。
// 0.45 にすると、シナリオが要求する4局面がすべて成立する:
//   T1–4 豊漁       国内 2.750 vs 輸入 3.946  → 国内が約 30% 安い
//   T7–10 ショック  国内 5.139 vs 輸入 4.247  → 輸入が約 21% 有利
//   T13+ 主漁期     国内 2.919 vs 輸入 3.480  → 国内が約 16% 安い
//   T13+ 端境期     国内 3.751 vs 輸入 3.567  → 輸入が約  5% 有利
//
// 経済的な意味は「ベトナム加工業界の競争が激しく、FOB価値のより多くが農家へ
// 渡る世界」。グローバル既定値（MARKET_PARAMETERS_V1）は変更しない。
export const DS1_PROCESSING_COST_USD_PER_KG = 0.2;
export const DS1_REQUIRED_MARGIN_USD_PER_KG = 0.25;

export const DS1_INITIAL_STATE_OVERRIDES: ScenarioInitialStateOverrides = {
  vietnamProcessingEconomics: {
    hosoEqRecoveryRatio: 1.0,
    processingExportCostUsdPerKg: DS1_PROCESSING_COST_USD_PER_KG,
    requiredMarginUsdPerKg: DS1_REQUIRED_MARGIN_USD_PER_KG,
  },
  vietnamTrailingAverageDomesticPurchaseHosoEqTons: 90000,
  initialDomesticProcurementIntentHosoEqTons: 95000,
};

// ---------------------------------------------------------------------
// 2. 構造需要アンカー
// ---------------------------------------------------------------------
//
// 1.0 = 各ターンの消費基準をシナリオの構造需要に置く（供給不足の記憶を
// 翌期の市場規模へ持ち越さない）。在庫の持ち越し・遅行価格効果・季節性・
// 購買圧力はアンカーと無関係にそのまま働くため、短期の需給変動は残る。
//
// 【販売保証ではない】アンカーが守るのは「その市場に消費需要が存在する」ことだけ。
// 5社がその需要を取れるかどうかは、産地間配分・外部供給者との競争・各社の
// 競争力が従来どおり決める。
export const DS1_STRUCTURAL_DEMAND_ANCHOR: StructuralDemandAnchorSettings = { pullStrength: 1.0 };

// ---------------------------------------------------------------------
// 3. 市場×商品ライフサイクル上書き
// ---------------------------------------------------------------------
//
// 【指示との対応】
//  JP    : VAP 加速を T7 開始（「Turn7頃 Japan VAP growth 開始」）。成熟 0.32。
//  US    : PD 加速を T9 開始（「Turn9頃から PD demand 成長」）。成熟 0.40 で中盤の主力PD市場。
//  EU    : PD 加速を T10 開始。初期 0.26（前半はHOSO比率が高い）→ 成熟 0.36。
//  OTHER : T17 に短期間（4Q）で急加速。T16 まで小規模＝「隠れた機会」。
//  CN    : 初期シェアを大幅に下げ（PD 0.12→0.05）、加速を T25 まで遅らせる。
//          これにより T24 まで CN の PD/VAP 絶対量が JP を下回る（指示 §14）。
//
// 【検算（構成比 × 市場規模）】
//   T24 PD : CN 0.0615×500k = 30.8k  <  JP 0.42×106k = 44.5k   ✓
//   T24 VAP: CN 0.0195×500k =  9.8k  <  JP 0.32×106k = 33.9k   ✓
//   T32 PD : CN 0.290 ×560k = 162k   >  JP 0.42×115k = 48k     ✓（premiumization）
//   T32 VAP: CN 0.135 ×560k =  76k   >  JP 0.32×115k = 37k     ✓
//   OTHER  : PD 0.230→0.340（T16→T20）、VAP 0.045→0.209（4.6倍）✓（隠れ成長）
//
// 健全性条件 pd.mature + vap.mature < 0.95 は全市場で充足
// （JP 0.74 / US 0.64 / EU 0.52 / OTHER 0.60 / CN 0.44）。
export const DS1_PRODUCT_LIFECYCLE_OVERRIDES: ProductLifecycleOverrides = {
  JP: {
    pd: { initialShare: 0.34, matureShare: 0.42, accelStartTurn: 6, accelDurationQuarters: 8 },
    vap: { initialShare: 0.1, matureShare: 0.32, accelStartTurn: 7, accelDurationQuarters: 10 },
  },
  US: {
    pd: { initialShare: 0.3, matureShare: 0.4, accelStartTurn: 9, accelDurationQuarters: 10 },
    vap: { initialShare: 0.06, matureShare: 0.24, accelStartTurn: 12, accelDurationQuarters: 10 },
  },
  EU: {
    pd: { initialShare: 0.26, matureShare: 0.36, accelStartTurn: 10, accelDurationQuarters: 12 },
    vap: { initialShare: 0.05, matureShare: 0.16, accelStartTurn: 14, accelDurationQuarters: 12 },
  },
  OTHER: {
    pd: { initialShare: 0.2, matureShare: 0.36, accelStartTurn: 17, accelDurationQuarters: 4 },
    vap: { initialShare: 0.03, matureShare: 0.24, accelStartTurn: 17, accelDurationQuarters: 4 },
  },
  CN: {
    pd: { initialShare: 0.05, matureShare: 0.3, baseGrowthPerQuarter: 0.0005, accelStartTurn: 25, accelDurationQuarters: 8 },
    vap: { initialShare: 0.008, matureShare: 0.14, baseGrowthPerQuarter: 0.0005, accelStartTurn: 25, accelDurationQuarters: 8 },
  },
};

// ---------------------------------------------------------------------
// 4. 市場別 構造需要トレンド（REGIONAL_DEMAND、HOSO換算トン）
// ---------------------------------------------------------------------
//
// 前史（SCENARIO_PREHISTORY_BASELINE_V1）の市場規模から出発する
// （CN 380k / US 320k / EU 260k / JP 90k / OTHER 150k）。既存5シナリオと
// 同じ前史を共有することで比較可能性を保つ。
//
// COVID期（T17–20）の落ち込みと再開ブーム（T22–25）はイベント側で表現し、
// このトレンドには入れない（トレンド＝構造、イベント＝循環、という役割分担）。
export const DS1_REGIONAL_DEMAND_KEYFRAMES: Readonly<Record<DemandMarketId, readonly (readonly [number, number])[]>> = {
  CN: [
    [1, 380000],
    [8, 420000],
    [12, 445000],
    [16, 470000],
    [20, 480000],
    [24, 500000],
    [28, 530000],
    [32, 560000],
  ],
  US: [
    [1, 320000],
    [8, 335000],
    [12, 355000],
    [16, 380000],
    [20, 385000],
    [24, 400000],
    [28, 420000],
    [32, 440000],
  ],
  EU: [
    [1, 260000],
    [8, 265000],
    [12, 275000],
    [16, 290000],
    [20, 293000],
    [24, 300000],
    [28, 312000],
    [32, 325000],
  ],
  JP: [
    [1, 90000],
    [8, 96000],
    [12, 100000],
    [16, 104000],
    [20, 105000],
    [24, 106000],
    [28, 110000],
    [32, 115000],
  ],
  OTHER: [
    [1, 150000],
    [8, 156000],
    [12, 160000],
    [16, 165000],
    [20, 185000],
    [24, 192000],
    [28, 200000],
    [32, 210000],
  ],
};

// ---------------------------------------------------------------------
// 5. 市場別 景気指数（ECONOMIC_INDEX）
// ---------------------------------------------------------------------
//
// 【重要・セマンティクス】構造需要アンカー（pullStrength=1.0）を有効にしたため、
// 毎ターンの消費は「その turn の構造需要 × 景気指数 × 季節性 × 遅行価格効果」で
// 決まる。景気指数は **前期値へ掛け続ける複利係数ではなく、その turn に適用される
// 基準状態（水準）** として読める。シナリオ作者が32ターンの世界 path を
// そのまま読める構造にするための設計。
//
// 1.000 = 中立。循環的な好不況だけをここに書き、構造成長は REGIONAL_DEMAND が持つ。
export const DS1_ECONOMIC_INDEX_KEYFRAMES: Readonly<Record<DemandMarketId, readonly (readonly [number, number])[]>> = {
  CN: [
    [1, 1.0],
    [8, 1.03],
    [15, 1.06],
    [16, 1.04],
    [21, 1.0],
    [25, 1.04],
    [32, 1.05],
  ],
  US: [
    [1, 1.0],
    [8, 1.03],
    [15, 1.05],
    [16, 1.03],
    [21, 1.0],
    [25, 1.03],
    [32, 1.04],
  ],
  EU: [
    [1, 1.0],
    [8, 1.02],
    [15, 1.04],
    [16, 1.02],
    [21, 1.0],
    [25, 1.02],
    [32, 1.03],
  ],
  JP: [
    [1, 1.0],
    [8, 1.02],
    [15, 1.03],
    [16, 1.02],
    [21, 1.0],
    [25, 1.02],
    [32, 1.03],
  ],
  OTHER: [
    [1, 1.0],
    [8, 1.02],
    [15, 1.04],
    [16, 1.03],
    [21, 1.02],
    [25, 1.03],
    [32, 1.04],
  ],
};

// ---------------------------------------------------------------------
// 6. 産地の養殖コスト指数（AQUACULTURE_COST → 価格アンカー）
// ---------------------------------------------------------------------
//
// Phase 1 実測で、VN 国内原料価格を動かす支配的レバーは供給量ではなく
// このコスト指数（価格アンカー = 初期FOB × コスト指数）であることが分かっている。
//
// VN: T1–4 で緩やかに下落（成功体験）→ T13 以降は構造的に上昇（相対的な割高化）。
//     T7 のショックはイベント側の ×1.60 が **この値に重なる**。
// EC/IN: T16 以降に規模の経済でコスト低下（global 調達の競争力改善）。
export const DS1_AQUACULTURE_COST_KEYFRAMES: Readonly<Record<CountryId, readonly (readonly [number, number])[]>> = {
  VN: [
    [1, 1.0],
    [4, 0.94],
    [5, 1.02],
    [6, 1.1],
    [12, 1.22],
    [16, 1.3],
    [20, 1.36],
    [24, 1.38],
    [32, 1.42],
  ],
  EC: [
    [1, 1.0],
    [12, 1.0],
    [16, 0.92],
    [32, 0.9],
  ],
  IN: [
    [1, 1.0],
    [12, 1.0],
    [16, 0.95],
    [32, 0.93],
  ],
  ID: [
    [1, 1.0],
    [32, 1.1],
  ],
};

// ---------------------------------------------------------------------
// 7. 産地の養殖能力（COUNTRY_CAPACITY）
// ---------------------------------------------------------------------
//
// 前史の国別供給量から既定の稼働率・生残率・生産性で逆算した基準値に対する倍率。
// Ecuador の大幅増産は T13 開始（指示 §16）。T7〜9 の VN ショックとは重ねない
// （Phase 1 実測: 輸入国の増産は世界基準価格を下げ、平均回帰・国別価格スプレッド
// 制約を通じて VN_FOB も一緒に引き下げてしまい、狙いと逆に働く）。
export const DS1_CAPACITY_MULTIPLIER_KEYFRAMES: Readonly<Record<CountryId, readonly (readonly [number, number])[]>> = {
  EC: [
    [1, 1.0],
    [12, 1.03],
    [16, 1.2],
    [20, 1.26],
    [32, 1.35],
  ],
  IN: [
    [1, 1.0],
    [12, 1.02],
    [16, 1.1],
    [32, 1.18],
  ],
  ID: [
    [1, 1.0],
    [32, 1.07],
  ],
  VN: [
    [1, 1.0],
    [8, 1.03],
    [32, 1.12],
  ],
};

/** 国別capacityの後方導出（既定の稼働率0.85・生残率0.85・生産性1.0から逆算）。 */
export function ds1BaseCapacity(country: CountryId): number {
  return SCENARIO_PREHISTORY_BASELINE_V1.countrySupplyHosoEqTons[country] / (0.85 * 0.85 * 1.0);
}

// ---------------------------------------------------------------------
// 8. ベトナムの稼働率（UTILIZATION_RATE）＝収穫の季節変動
// ---------------------------------------------------------------------
//
// 指示 §17「Vietnam domestic raw は常に高いにはしない。年間で乱高下」。
// T13 以降、四半期ごとに主漁期（Q3）と端境期（Q1）を作る。
// 端境期に国内価格が上がり、輸入が有利になる局面が生まれる。
//
// 【値域】UTILIZATION_RATE の定義域は [0, 1]。1.0 を超える値は clamp される。
export const DS1_VN_UTILIZATION_BY_QUARTER: Readonly<Record<1 | 2 | 3 | 4, number>> = {
  1: 0.62, // 端境期（最も逼迫）
  2: 0.82,
  3: 1.0, // 主漁期（最も潤沢）
  4: 0.88,
};

/** T1〜T12 の稼働率（序盤は季節変動を入れず、T1–4 の「安い国内原料」を安定して作る）。 */
export const DS1_VN_UTILIZATION_EARLY: readonly (readonly [number, number])[] = [
  [1, 0.9],
  [2, 0.92],
  [3, 0.92],
  [4, 0.92],
  [5, 0.88],
  [6, 0.85],
  [7, 0.85],
  [8, 0.85],
  [9, 0.85],
  [10, 0.85],
  [11, 0.85],
  [12, 0.85],
];

/** 季節変動を開始するターン。 */
export const DS1_SEASONALITY_START_TURN = 13;

// ---------------------------------------------------------------------
// 9. イベント強度（candidate）
// ---------------------------------------------------------------------

/**
 * T7 ベトナム原料ショック。
 * Phase 1 実測 lever J（供給 −50% + コスト×1.60）で
 * 国内 4.869 vs 最安輸入 4.233 = **輸入が約15〜21%有利**、
 * VN 取引量は 389k → 229k（−41%）。#04 承認の「20〜25%高い」水準。
 *
 * 供給 −50% は SURVIVAL_RATE と UTILIZATION_RATE の合成で作る:
 *   生残率 0.85 → 0.53（−0.32pt, ×0.624） × 稼働率 ×0.80 = ×0.50
 */
export const DS1_VN_RAW_SHOCK = {
  survivalRateDelta: -0.32,
  utilizationMultiplier: 0.8,
  aquacultureCostMultiplier: 1.6,
  startTurn: 6,
  rampUpTurns: 1, // T6 の発現強度が数学的に 0 になる（予兆Newsのみ・効果ゼロ）
  durationTurns: 3,
  recoveryTurns: 3,
} as const;

/**
 * T17 世界需要ショック（COVID-like）。#04 指示: 数量需要 −35% を第一候補、4ターン継続。
 * 構造需要アンカーにより ECONOMIC_INDEX は水準として効くため、
 * 0.65 は「その期間の需要水準が平常の65%」を直接意味する（複利にならない）。
 *
 * 価格も明確に下落させるが、数量と同率にはしない（指示）。
 * 価格下落は REGIONAL_DEMAND の縮小 → 世界需給緩和 → HOSO価格下落として現れ、
 * さらに購買圧力の低下が仕向市場価格係数を押し下げる（既存の2経路）。
 */
export const DS1_DEMAND_SHOCK = {
  economicIndexMultiplier: 0.65, // 数量 −35%
  regionalDemandMultiplier: 0.78, // 価格形成側の世界需要 −22%（数量ほどは下げない）
  startTurn: 16,
  rampUpTurns: 1, // T16 は予兆Newsのみ・効果ゼロ
  durationTurns: 3,
  recoveryTurns: 1, // T17–T20 満額、T21 で 0
} as const;

/** T22 再開ブーム。T21 は「回復シグナル」のみで効果ゼロ。 */
export const DS1_REOPENING_BOOM = {
  economicIndexMultiplier: 1.12,
  regionalDemandMultiplier: 1.12,
  startTurn: 21,
  rampUpTurns: 1,
  durationTurns: 3,
  recoveryTurns: 4,
} as const;

/** T9 消費ブーム（指示 §10「Turn8〜12 consumer boom」）。 */
export const DS1_CONSUMER_BOOM = {
  regionalDemandMultiplier: 1.06,
  economicIndexMultiplier: 1.01,
  startTurn: 7,
  rampUpTurns: 2,
  durationTurns: 6,
  recoveryTurns: 3,
} as const;

/**
 * Others の構造成長（T17〜）。主要4市場のショックと独立。
 * 指示 §19: 「大儲けではなく、他社が赤字の中で break-even〜moderate profit」。
 * 市場規模の押し上げは控えめにし、収益機会の主因は PD/VAP 構成比の急変
 * （DS1_PRODUCT_LIFECYCLE_OVERRIDES.OTHER）側に置く。
 */
export const DS1_OTHERS_RETAIL_GROWTH = {
  regionalDemandMultiplier: 1.18,
  economicIndexMultiplier: 1.06,
  startTurn: 16,
  rampUpTurns: 1,
  durationTurns: 6,
  recoveryTurns: 4,
} as const;

/**
 * China HOSO 価格スパイク（指示 §15、T13以降・年2回程度）。
 *
 * 【重要・内生性】シナリオが与えるのは **需要圧力** だけであり、価格そのものは
 * 指定しない。実際の高騰幅は、5社がその四半期に China HOSO へどれだけ供給したか、
 * 外部供給者がどれだけ埋めたか、在庫がどれだけあったかによって市場清算が決める。
 * 5社全社が殺到すれば高騰幅は小さくなり、シェア争いと利益率低下が起きる。
 *
 * #04 指示の第一候補「平常比 +25% 程度の一時的 price pressure」に対応する
 * REGIONAL_DEMAND 倍率。毎回同じ値にせず散らし、読み切られないようにする。
 * T17〜T19（需要ショック期）にはスパイクを置かない。
 */
export const DS1_CN_HOSO_SPIKES: readonly { readonly turn: number; readonly magnitude: number; readonly cause: string }[] = [
  { turn: 13, magnitude: 1.3, cause: "春節stocking" },
  { turn: 15, magnitude: 1.2, cause: "importer buying" },
  { turn: 23, magnitude: 1.3, cause: "外食再開＋在庫復元" },
  { turn: 25, magnitude: 1.3, cause: "春節stocking" },
  { turn: 27, magnitude: 1.22, cause: "産地不作による代替買付" },
  { turn: 29, magnitude: 1.28, cause: "春節stocking＋物流逼迫" },
  { turn: 31, magnitude: 1.2, cause: "domestic shortage" },
];

/** 好況期（T25以降）の一時的な原料 price spike（指示 §22）。 */
export const DS1_LATE_SUPPLY_SHOCKS = {
  indiaDisruption: { startTurn: 23, rampUpTurns: 0, durationTurns: 2, recoveryTurns: 2, exportEligibilityMultiplier: 0.85, costMultiplier: 1.1 },
  vietnamDiseaseY7: { startTurn: 26, rampUpTurns: 1, durationTurns: 2, recoveryTurns: 2, survivalRateDelta: -0.12, costMultiplier: 1.15 },
  ecuadorDiseaseY8: { startTurn: 29, rampUpTurns: 1, durationTurns: 2, recoveryTurns: 2, survivalRateDelta: -0.15, costMultiplier: 1.18 },
} as const;
