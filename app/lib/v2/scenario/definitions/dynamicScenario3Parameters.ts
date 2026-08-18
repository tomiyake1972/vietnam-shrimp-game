// ShrimpX V2 — Dynamic Scenario 3: 数値パラメータの唯一の集約地点
//
// DS3 が DS1/DS2 から変える数値をすべてここへ集める。dynamicScenario3.ts と
// dynamicScenario3News.ts はここの値だけを参照し、定義ロジック中にマジックナンバーを
// 書かない（DS1 と同じ方針）。
//
// 【DS3 の設計根拠】DS2 監査（scripts/dynamicScenario2ParameterAudit.ts）で、
// 5社の四半期販売量を実際に縛っているのは次の2段であることが実測で確定した。
//   ① submissionTargetTons ≤ attainableProfitableTons × realisticShareOfOpportunity(0.5)
//   ② commercialAmbition ≤ visionTargetScaleAtCurrentTurn（Vision は上限でもある）
// 供給者シェア上限(35%)・営業組織能力・世界需要総量は binding していなかった。
// したがって DS3 は「①を市場側で広げ、②を会社別 Vision 倍率で広げる」の2本立てで
// 規模を作る。固定トン数の販売目標は一切与えない。

import { CountryId, DemandMarketId } from "../../market/types";
import { ProductLifecycleOverrides } from "../../market/productLifecycle";
import { ScenarioVisionGrowthOverride } from "../types";

export const DS3_DURATION_TURNS = 32;

// ---------------------------------------------------------------------
// 1. 市場別 構造需要（REGIONAL_DEMAND、HOSO換算トン）
// ---------------------------------------------------------------------
//
// 【T1〜12 は DS1 と同一】指示§1「序盤は会社を育てる」「この段階から巨大市場に
// しすぎない」に従い、序盤の学習環境は DS1/DS2 とそろえる。
//
// 【T16 以降で本格拡大】attainableProfitableTons は
//   Σ(市場×商品の観測需要 × maximumSupplierShare 0.35)  ※採算の取れるセルのみ
// なので、会社が到達できる規模は市場需要にほぼ比例する。DS2 の T32 実測
// （attainableProfitableTons = 59,653 → 1社あたり上限 29,827t）に対し、
// MASS 90〜100kt 級を「到達可能」にするには、この値を約3倍まで広げる必要がある。
//
// 【市場の性格は維持】China を最大の量販市場として最も強く伸ばし（§9）、
// Japan は規模で伸ばさず品質・PD の市場として残す（§9）。US は PD/VAP、
// EU は中規模・安定という役割も維持する。
export const DS3_REGIONAL_DEMAND_KEYFRAMES: Readonly<Record<DemandMarketId, readonly (readonly [number, number])[]>> = {
  CN: [
    [1, 380000],
    [8, 420000],
    [12, 445000],
    [16, 620000],
    [20, 760000],
    [24, 1180000],
    [28, 1430000],
    [32, 1620000],
  ],
  US: [
    [1, 320000],
    [8, 335000],
    [12, 355000],
    [16, 470000],
    [20, 560000],
    [24, 760000],
    [28, 880000],
    [32, 980000],
  ],
  EU: [
    [1, 260000],
    [8, 265000],
    [12, 275000],
    [16, 350000],
    [20, 410000],
    [24, 540000],
    [28, 620000],
    [32, 690000],
  ],
  JP: [
    // 日本は規模では伸ばさない（品質・PD の市場という性格を維持。§9）。
    [1, 90000],
    [8, 96000],
    [12, 100000],
    [16, 118000],
    [20, 132000],
    [24, 168000],
    [28, 188000],
    [32, 205000],
  ],
  OTHER: [
    [1, 150000],
    [8, 156000],
    [12, 160000],
    [16, 205000],
    [20, 250000],
    [24, 330000],
    [28, 380000],
    [32, 425000],
  ],
};

// ---------------------------------------------------------------------
// 2. 産地の養殖能力（COUNTRY_CAPACITY 倍率）
// ---------------------------------------------------------------------
//
// 需要だけを伸ばすと世界が慢性的な供給不足になり、価格が上がり続けて
// §5 の down-cycle が作れない。需要拡大に見合う供給拡大を同時に置く。
//
// 【T24〜28 は供給を需要より速く伸ばす】これが §5 の販売価格 down-cycle の
// 主エンジンである（価格を直接指定する特殊ルールは作らない。ScenarioBaseVariable に
// 価格が無いのは意図的な設計であり、それを迂回しない）。
// 【T29 以降】India 災害で IN が落ち、EC も完全には戻らないため、供給超過は
// 徐々に解消するが、価格は絶頂期までは戻らない（§1「最終再編」）。
export const DS3_CAPACITY_MULTIPLIER_KEYFRAMES: Readonly<Record<CountryId, readonly (readonly [number, number])[]>> = {
  EC: [
    [1, 1.0],
    [12, 1.03],
    [16, 1.35],
    [20, 1.75],
    [24, 2.35],
    [28, 3.05],
    [32, 3.15],
  ],
  IN: [
    [1, 1.0],
    [12, 1.02],
    [16, 1.28],
    [20, 1.6],
    [24, 2.05],
    [28, 2.6],
    [32, 2.7],
  ],
  ID: [
    [1, 1.0],
    [12, 1.02],
    [16, 1.2],
    [20, 1.45],
    [24, 1.85],
    [28, 2.3],
    [32, 2.45],
  ],
  VN: [
    // ベトナムも伸ばす。5社が国内原料で大型化する余地を作るため
    // （伸ばさないと調達だけが律速になり、経営判断の幅が消える）。
    [1, 1.0],
    [8, 1.03],
    [12, 1.15],
    [16, 1.5],
    [20, 1.85],
    [24, 2.4],
    [28, 2.95],
    [32, 3.1],
  ],
};

// ---------------------------------------------------------------------
// 3. 産地の養殖コスト指数（AQUACULTURE_COST）
// ---------------------------------------------------------------------
//
// DS1 と同じ骨格。EC/IN は増産による規模の経済でコスト低下、VN は構造的に上昇。
// T25 / T29 の自然災害はイベント側の倍率がこの値に**重なる**。
export const DS3_AQUACULTURE_COST_KEYFRAMES: Readonly<Record<CountryId, readonly (readonly [number, number])[]>> = {
  // 【§8 についての重要な実測結果】ベトナムの養殖コストを T24 以降に押し上げる案は
  // 採用しない。実走で逆効果だったため（T28 の販売価格が T16比 84% → 115% へ上がり、
  // 営業利益率も 24% → 34% へ改善してしまった）。
  //
  // 根拠：この世界では国内買付上限が
  //     buyingCeiling = VN_FOB × hosoEqRecoveryRatio − (processingExportCost + requiredMargin)
  // で決まり、VN_FOB は世界価格アンカーでもある。したがって養殖コストを上げると
  // 「原料も上がるが販売価格も同じだけ上がる」ため、加工会社の粗利スプレッドは
  // 構造的にほぼ一定（DS1 設定では 0.45 USD/kg）に保たれる。原料高だけで
  // Margin squeeze を作ることはできない。
  //
  // したがって DS3 の Margin squeeze は「価格水準そのものを下げ、価格に比例しない
  // 固定費（工場・償却・人件費・金利）の重みを相対的に増やす」経路で作る。
  // VN のコスト曲線は DS1 と同じままにしておく。
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
    [24, 0.88],
    [32, 0.86],
  ],
  IN: [
    [1, 1.0],
    [12, 1.0],
    [16, 0.95],
    [24, 0.92],
    [32, 0.9],
  ],
  ID: [
    [1, 1.0],
    [32, 1.1],
  ],
};

// ---------------------------------------------------------------------
// 4. 市場×商品ライフサイクル
// ---------------------------------------------------------------------
//
// DS1 の骨格を維持しつつ、§10 に従い US の VAP を厚くする
// （VAP 特化企業が「市場が小さいから最初から負ける」状態にしない）。
// VAP には労務負荷・加工コスト・設備投資が必要なため、常に最強にはならない。
export const DS3_PRODUCT_LIFECYCLE_OVERRIDES: ProductLifecycleOverrides = {
  JP: {
    pd: { initialShare: 0.34, matureShare: 0.42, accelStartTurn: 6, accelDurationQuarters: 8 },
    vap: { initialShare: 0.1, matureShare: 0.32, accelStartTurn: 7, accelDurationQuarters: 10 },
  },
  US: {
    pd: { initialShare: 0.3, matureShare: 0.4, accelStartTurn: 9, accelDurationQuarters: 10 },
    // 【DS3・§10】成熟 0.24 → 0.30、加速も 2Q 早める。US を VAP の主戦場にする。
    vap: { initialShare: 0.06, matureShare: 0.3, accelStartTurn: 10, accelDurationQuarters: 10 },
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
// 5. 会社別 Vision 成長軌道の上書き（DS3 限定）
// ---------------------------------------------------------------------
//
// 【固定トン数目標ではない】ここで与えるのは倍率と成長意欲だけで、販売量の
// 目標値ではない。各社の成長軌道の形（referenceGrowthPath の凸型）はそのまま
// 保たれ、水準だけがスケールする。実際にどこまで伸びるかは、市場機会・採算・
// 生産能力・資金・競争が従来どおり決める。
//
// 【会社差を潰さない・§4】全社を同じ上限へ引き上げない。既定 Vision の Q32 目標
// （MASS 80,000 / BAL 34,000 / JPQ 30,000 / CONSV 27,000 / VAP 17,000 t/四半期）に
// 対して会社ごとに異なる倍率をかけ、性格の順序関係を保つ。
//
// 【VAP 社について】既定 Vision は growthAmbition "LOW"・
// willingnessToBuildFactories "LOW"（「大きさでは勝たない」）で、そのままでは
// 高付加価値市場が広がっても規模がついてこない。DS3 では US VAP 市場を厚くした
// 分だけ成長を許す必要があるため、成長意欲を MEDIUM へ引き上げる。
// ただし「量で勝つ会社」にはしない（倍率は他社より高いが、絶対水準は最小のまま）。
export const DS3_VISION_GROWTH_OVERRIDES: Readonly<Record<string, ScenarioVisionGrowthOverride>> = {
  MASS: { scaleMultiplier: 1.25, growthAmbition: "HIGH", willingnessToBuildFactories: "HIGH" },
  BAL: { scaleMultiplier: 1.85, growthAmbition: "HIGH", willingnessToBuildFactories: "HIGH" },
  JPQ: { scaleMultiplier: 1.75, growthAmbition: "HIGH", willingnessToBuildFactories: "HIGH" },
  VAP: { scaleMultiplier: 2.9, growthAmbition: "MEDIUM", willingnessToBuildFactories: "MEDIUM" },
  CONSV: { scaleMultiplier: 1.8, growthAmbition: "MEDIUM", willingnessToBuildFactories: "MEDIUM" },
};

// ---------------------------------------------------------------------
// 6. T24〜28 販売価格 Down Cycle
// ---------------------------------------------------------------------
//
// 【価格を直接指定しない】ScenarioBaseVariable に価格は存在せず、これは
// 「シナリオは価格を決めない」という設計上の制約である（scenario/types.ts 冒頭）。
// DS3 もこれを迂回しない。down-cycle は
//   ・価格形成側の世界需要（REGIONAL_DEMAND）を段階的に緩める
//   ・同時に産地の稼働率（UTILIZATION_RATE）を引き上げて供給を増やす
// という需給バランスの操作だけで作る。数量需要（ECONOMIC_INDEX）は下げないため、
// 「Volume は大きいが Margin が悪化する」状態になる（§5）。
//
// startTurn=23 / rampUpTurns=1 により T23 は発現強度 0（News だけが出る先読み点）。
export const DS3_PRICE_DOWN_CYCLE = {
  startTurn: 23,
  rampUpTurns: 1,
  // 【§13】T30–32 で「景気が戻って全員大儲け」にしないため、down-cycle は最後まで
  // 解除しない（durationTurns を残り全ターンに伸ばし、recoveryTurns を 0 にする）。
  // 供給ショックの方は個別イベントとして正常化するが、価格水準は戻らない。
  durationTurns: 9,
  recoveryTurns: 0,
  /**
   * 価格形成側の世界需要を緩める（数量そのものは ECONOMIC_INDEX 側で維持する）。
   * 【校正】初回実走で 0.78 / 1.16 は T28 = T16比 84% と下げすぎだったため緩めた
   * （狙いは暴落ではなく Margin pressure。§5 の第一候補は T16比 100% 前後）。
   */
  regionalDemandMultiplier: 0.9,
  /** 産地稼働率を引き上げて供給超過を作る（down-cycle の主エンジン）。 */
  utilizationMultiplier: 1.08,
} as const;

/** §5 の感度比較（T28 実現販売価格の T16 比）。第一候補は 100%。 */
export const DS3_DOWN_CYCLE_SENSITIVITY = {
  /** T16比 約105%（緩い） */
  mild: { regionalDemandMultiplier: 0.95, utilizationMultiplier: 1.04 },
  /** T16比 約100%（第一候補＝DS3_PRICE_DOWN_CYCLE と同値） */
  base: { regionalDemandMultiplier: 0.9, utilizationMultiplier: 1.08 },
  /** T16比 約95%（強い） */
  strong: { regionalDemandMultiplier: 0.85, utilizationMultiplier: 1.12 },
} as const;

// ---------------------------------------------------------------------
// 7. Supply Shock（T25 Ecuador / T29 India）
// ---------------------------------------------------------------------
//
// 【DS3 では DS1 後期イベントを整理する】DS1 の india-disruption(T23) と
// ec-disease-y8(T30) は、ここで新設する T25 Ecuador / T29 India と同じ産地の
// 二重被災になるため DS3 では採用しない（DS1/DS2 の定義自体は変更しない）。
//
// 【Ecuador T25・自然災害】洪水・異常気象による養殖地域被害。
// 原料コストを一時的に押し上げ、生残率と稼働率も落とす。数ターンで正常化する。
export const DS3_ECUADOR_DISASTER = {
  startTurn: 24,
  rampUpTurns: 1, // T24 は News のみ・効果ゼロ
  durationTurns: 3, // T25〜T27 満額
  recoveryTurns: 3, // T30 頃までに正常化
  aquacultureCostMultiplier: 1.35,
  survivalRateDelta: -0.14,
  utilizationMultiplier: 0.88,
} as const;

/** §6 の感度比較（Ecuador 原料コスト倍率）。第一候補は +35%。 */
export const DS3_ECUADOR_COST_SENSITIVITY = { low: 1.25, base: 1.35, high: 1.45 } as const;

// 【India T29・自然災害】Ecuador とは影響経路と回復速度を変える。
// コスト上昇に加えて輸出適格率が落ち（通関・品質検査の停滞）、供給の「出口」が
// 細る。回復は Ecuador より速い（durationTurns 2 / recoveryTurns 2）。
export const DS3_INDIA_DISASTER = {
  startTurn: 28,
  rampUpTurns: 1, // T28 は News のみ・効果ゼロ
  durationTurns: 2, // T29〜T30 満額
  recoveryTurns: 2,
  aquacultureCostMultiplier: 1.35,
  exportEligibilityMultiplier: 0.82,
  survivalRateDelta: -0.08,
} as const;

/** §6 の感度比較（India 原料コスト倍率）。第一候補は +35%。 */
export const DS3_INDIA_COST_SENSITIVITY = { low: 1.25, base: 1.35, high: 1.45 } as const;

// 【Case B のみ・T31 Vietnam】§7。第一候補は Case A（= これを置かない）。
export const DS3_VIETNAM_DISASTER_CASE_B = {
  startTurn: 30,
  rampUpTurns: 1,
  durationTurns: 2,
  recoveryTurns: 2,
  survivalRateDelta: -0.12,
  aquacultureCostMultiplier: 1.2,
} as const;

// ---------------------------------------------------------------------
// 8. China HOSO の一時的な需要圧力
// ---------------------------------------------------------------------
//
// DS1 と同じ思想（需要圧力だけを与え、価格は市場清算に委ねる）。
// ただし T24〜28 の down-cycle 期間中は置かない。ここでスパイクを重ねると
// 価格が跳ね返り、Margin squeeze（§8）が成立しなくなるため。
export const DS3_CN_HOSO_SPIKES: readonly { readonly turn: number; readonly magnitude: number; readonly cause: string }[] = [
  { turn: 13, magnitude: 1.3, cause: "春節stocking" },
  { turn: 15, magnitude: 1.2, cause: "importer buying" },
  { turn: 22, magnitude: 1.28, cause: "外食再開＋在庫復元" },
  { turn: 23, magnitude: 1.22, cause: "内需回復による買付集中" },
  { turn: 31, magnitude: 1.18, cause: "供給正常化局面での在庫復元" },
];
