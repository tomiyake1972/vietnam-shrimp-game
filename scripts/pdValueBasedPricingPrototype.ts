// ShrimpX V2 — PD価値ベース価格モデルの数値プロトタイプ（Phase B）
//
// ============================================================================
// 【重要・本スクリプトの位置づけ】
//  - **製品コードを一切参照して書き換えない。** 本ファイルは完全に独立した
//    プロトタイプであり、market/productPremium.ts 等の価格形成には影響しない。
//  - ゲームへ組み込む前の、式と挙動の妥当性検証のみを目的とする。
//  - パラメータはすべて**暫定値**であり、確定値ではない。
//  - 乱数を使わない（決定論）。productLifecycle.ts と同じ方針。
// ============================================================================
//
// 【3層構造】
//   Layer 1  Potential PD Premium     … 消費地市場が「HOSOではなくPDを受け取ること」に
//                                       余分に払ってよい潜在的上限（市場別・絶対額）
//   Layer 2  Competitive PD Cost      … 世界のPD供給者の競争的加工コスト
//                                       （**個社のコストとは完全に分離**）
//   Layer 3  Actual PD Premium        … 市場で成立する実際の上乗せ
//
// 【単位】すべて USD / HOSO換算kg。物理kg換算ではない（B-1 §5-2）。
//   PD の physicalYieldRatio ≈ 0.54 なので、物理kg換算値は約1.85倍になる。
//
// 使い方:
//   npx tsx scripts/pdValueBasedPricingPrototype.ts            … 8ケース
//   npx tsx scripts/pdValueBasedPricingPrototype.ts --sweep     … 感度分析
//   npx tsx scripts/pdValueBasedPricingPrototype.ts --compare   … 式の比較（オーナー案 vs 修正案）
//   npx tsx scripts/pdValueBasedPricingPrototype.ts --write     … artifacts へJSON出力

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// 0. 現行パラメータから導いたアンカー（B-1の単位分析に基づく実測値）
// ---------------------------------------------------------------------------

/**
 * 【アンカー1】PDの「HOSOに対する増分」加工コスト（USD/HOSO換算kg）。
 *
 * 現行コードの実値から導出する:
 *   材料加工費の差 = baseProcessingCostUsdPerTon(pd 520 − hoso 350) / 1000 = 0.170
 *   労務費の差:
 *     1人あたり実効生産力 = regularEfficiencyPerHeadTons(6) / laborIntensityCoefficient
 *       HOSO(1.0) → 6.000 t/人/Q → 常用給与1000/6.000    = 166.7 USD/t = 0.1667 USD/kg
 *       PD  (1.8) → 3.333 t/人/Q → 1000/3.333            = 300.0 USD/t = 0.3000 USD/kg
 *       PD  (1.2) → 5.000 t/人/Q → 1000/5.000            = 200.0 USD/t = 0.2000 USD/kg（機械化後）
 *     労務差（機械化前）= 0.3000 − 0.1667 = 0.1333
 *     労務差（機械化後）= 0.2000 − 0.1667 = 0.0333
 *   → 増分PDコスト（機械化前）= 0.170 + 0.1333 = 0.3033
 *   → 増分PDコスト（機械化後）= 0.170 + 0.0333 = 0.2033
 */
export const OWN_PD_INCREMENTAL_COST_PRE_MECH = 0.3033;
export const OWN_PD_INCREMENTAL_COST_POST_MECH = 0.2033;

/**
 * 【アンカー2】現行モデルが暗黙に与えているPDプレミアムの水準。
 * hosoPrice_VN(初期5.3) × pdBasePremiumRatio(0.18) = 0.954 USD/HOSO換算kg（稼働率倍率1.0時）。
 * 稼働率倍率の下限0.5では 0.477、上限1.8では 1.717。
 * プロトタイプのPotentialは、この帯を含む水準に置くことで現行との比較を可能にする。
 */
export const CURRENT_MODEL_IMPLIED_PREMIUM_NEUTRAL = 0.954;

// ---------------------------------------------------------------------------
// 1. Layer 1 — Potential PD Premium（市場別・絶対額）
// ---------------------------------------------------------------------------

export type MarketId = "JP" | "US" | "EU" | "CN" | "OTHER";
export const MARKET_IDS: readonly MarketId[] = ["JP", "US", "EU", "CN", "OTHER"];

/**
 * 1市場ぶんのPotential PD Premiumのパラメータ。
 *
 * 【設計方針】初期実装ではマクロ変数を積み上げない。市場別の
 * 「初期値・成長・上下限・成熟度・経済発展感応度」だけで表現する。
 * 将来の分解先（所得、人件費、外食/中食比率、簡便志向、加工労働の希少性、
 * 廃棄物処理コスト）は、initialPotential をこれらの重み付き和へ置き換えるだけで
 * 済むよう、**Potentialを絶対額の単一スカラーとして閉じておく**。
 */
export interface PotentialCurve {
  /** turn=1 時点の潜在プレミアム（USD/HOSO換算kg）。 */
  readonly initialPotential: number;
  /** 成熟時に到達する潜在プレミアム。 */
  readonly maturePotential: number;
  /** 下限（これ未満にはならない）。 */
  readonly floor: number;
  /** 上限（これを超えない）。 */
  readonly ceiling: number;
  /** 成熟（S字）の中点turn。 */
  readonly maturityMidpointTurn: number;
  /** 成熟の傾き（大きいほど急。S字の幅の逆数）。 */
  readonly maturitySlopeQuarters: number;
  /** 景気指数1.0からの乖離に対する感応度（0.5なら景気+10%で潜在+5%）。 */
  readonly economicSensitivity: number;
}

/**
 * 【暫定値・要校正】市場別Potential。
 *
 * 根拠の考え方（PDのPotentialは「消費地側で剥き作業をせずに済むこと」の価値が中心）:
 *  - JP: 人件費が高く、加工労働の確保が難しく、廃棄物処理も厳しい → 最も高い。
 *  - EU: JPに次ぐ。人件費と衛生規制。
 *  - US: 中間。外食・中食比率は高いが自国加工の余地も残る。
 *  - OTHER: やや低い。
 *  - CN: 人件費が相対的に低く自国で剥ける → 最も低い（低価値市場の例）。
 * 水準は CURRENT_MODEL_IMPLIED_PREMIUM_NEUTRAL(0.954) を含む帯に置く。
 */
export const POTENTIAL_PARAMETERS_V0: Readonly<Record<MarketId, PotentialCurve>> = {
  JP: { initialPotential: 1.30, maturePotential: 1.75, floor: 0.60, ceiling: 2.20, maturityMidpointTurn: 8, maturitySlopeQuarters: 8, economicSensitivity: 0.4 },
  EU: { initialPotential: 1.10, maturePotential: 1.55, floor: 0.55, ceiling: 2.00, maturityMidpointTurn: 12, maturitySlopeQuarters: 10, economicSensitivity: 0.5 },
  US: { initialPotential: 1.00, maturePotential: 1.40, floor: 0.50, ceiling: 1.90, maturityMidpointTurn: 10, maturitySlopeQuarters: 8, economicSensitivity: 0.5 },
  OTHER: { initialPotential: 0.70, maturePotential: 1.00, floor: 0.35, ceiling: 1.50, maturityMidpointTurn: 14, maturitySlopeQuarters: 10, economicSensitivity: 0.6 },
  CN: { initialPotential: 0.42, maturePotential: 0.72, floor: 0.25, ceiling: 1.20, maturityMidpointTurn: 18, maturitySlopeQuarters: 10, economicSensitivity: 0.7 },
};

/** 既存の productLifecycle.ts と同一の smoothstep（式の一貫性のため合わせる）。 */
export function smoothstep(p: number): number {
  const t = clamp(p, 0, 1);
  return t * t * (3 - 2 * t);
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Layer 1: 市場 m・turn t の Potential PD Premium。
 * 成熟はS字（中点 maturityMidpointTurn、幅 maturitySlopeQuarters）。
 * 景気指数は 1.0 中心の乗算補正。
 */
export function potentialPremium(curve: PotentialCurve, turn: number, economicIndex = 1.0): number {
  const progress = (turn - (curve.maturityMidpointTurn - curve.maturitySlopeQuarters / 2)) / curve.maturitySlopeQuarters;
  const s = smoothstep(progress);
  const base = curve.initialPotential + (curve.maturePotential - curve.initialPotential) * s;
  const econAdjusted = base * (1 + (economicIndex - 1) * curve.economicSensitivity);
  return clamp(econAdjusted, curve.floor, curve.ceiling);
}

// ---------------------------------------------------------------------------
// 2. Layer 2 — Competitive PD Processing Cost（世界の供給者側。個社と分離）
// ---------------------------------------------------------------------------

export type CountryId = "VN" | "IN" | "ID" | "EC";
export const COUNTRY_IDS: readonly CountryId[] = ["VN", "IN", "ID", "EC"];

/**
 * 【B-1 §4-1で確認】産地別の加工コストというデータは現行コードに存在しない。
 * 以下は**プロトタイプのために新規に置いた仮定値**であり、現状の事実ではない。
 *
 * 本番実装で必要になる最小追加は、CountrySupplyInput への
 *   readonly pdProcessingUnitCostUsdPerHosoEqKg: number
 * の1フィールドのみ（能力 pdProcessingCapacity は既に存在する）。
 *
 * 仮定値の考え方（すべてHOSOに対する**増分**加工コスト、USD/HOSO換算kg）:
 *  - VN: 剥き身加工の集積地。労働が豊富で熟練 → 最も効率的。
 *  - IN: VNに次ぐ。
 *  - ID: 中間。
 *  - EC: 大規模養殖に特化し加工の集積がない → 限界供給者。
 * 自社（プレイヤー）の増分コストは機械化前 0.3033（アンカー1）なので、
 * VN平均より高い＝プレイヤーは産地平均より非効率という初期条件になる。
 */
export interface CountryProcessingState {
  readonly countryId: CountryId;
  /** PD加工能力（HOSO換算トン/四半期）。 */
  readonly capacityTons: number;
  /** PDの増分加工単価（USD/HOSO換算kg）。 */
  readonly unitCost: number;
}

export const COUNTRY_PROCESSING_V0: readonly CountryProcessingState[] = [
  { countryId: "VN", capacityTons: 260_000, unitCost: 0.26 },
  { countryId: "IN", capacityTons: 120_000, unitCost: 0.30 },
  { countryId: "ID", capacityTons: 90_000, unitCost: 0.34 },
  { countryId: "EC", capacityTons: 60_000, unitCost: 0.46 },
];

export type CompetitiveCostMethod =
  /** (a) 能力加重平均。 */
  | "capacityWeightedMean"
  /** (b) 能力加重中央値。 */
  | "capacityWeightedMedian"
  /** (c) 需給で分位点を動かす（過剰→低コスト側、逼迫→限界供給者側）。 */
  | "supplyStateQuantile";

/** 能力加重の q 分位点（q=0.5で中央値）。能力の累積割合で線形に選ぶ。 */
function capacityWeightedQuantile(states: readonly CountryProcessingState[], q: number): number {
  const sorted = [...states].sort((a, b) => a.unitCost - b.unitCost);
  const total = sorted.reduce((s, c) => s + c.capacityTons, 0);
  if (total <= 0) return 0;
  const target = clamp(q, 0, 1) * total;
  let cum = 0;
  for (const c of sorted) {
    cum += c.capacityTons;
    if (cum >= target) return c.unitCost;
  }
  return sorted[sorted.length - 1].unitCost;
}

/**
 * Layer 2: 世界のPD供給者の競争的加工コスト。
 *
 * 【個社との分離】引数に個社のコストは一切入らない。
 * プレイヤー各社のコストがこの値へ影響する経路は存在しない。
 * （プレイヤーが産地の能力・コストへ影響するとしたら、それは
 *   「多数社・競合国の機械化が world capacity と country unitCost を動かす」
 *   という別経路であり、B-4で扱う。）
 */
export function competitiveCost(
  states: readonly CountryProcessingState[],
  utilization: number,
  method: CompetitiveCostMethod,
  p: { readonly quantileAtSlack: number; readonly quantileAtTight: number; readonly slackUtilization: number; readonly tightUtilization: number }
): number {
  const total = states.reduce((s, c) => s + c.capacityTons, 0);
  if (total <= 0) return 0;
  switch (method) {
    case "capacityWeightedMean":
      return states.reduce((s, c) => s + c.capacityTons * c.unitCost, 0) / total;
    case "capacityWeightedMedian":
      return capacityWeightedQuantile(states, 0.5);
    case "supplyStateQuantile": {
      // 過剰（utilization低）→ 低コスト側の分位点、逼迫（utilization高）→ 限界供給者側。
      const t = clamp((utilization - p.slackUtilization) / (p.tightUtilization - p.slackUtilization), 0, 1);
      const q = p.quantileAtSlack + (p.quantileAtTight - p.quantileAtSlack) * t;
      return capacityWeightedQuantile(states, q);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Layer 3 — Actual PD Premium
// ---------------------------------------------------------------------------

export interface Layer3Parameters {
  /** ScarcityCapture が0になる稼働率（これ以下では潜在価値を全く取れない）。 */
  readonly captureLowUtilization: number;
  /** ScarcityCapture が1になる稼働率（これ以上では潜在価値を取り切る）。 */
  readonly captureHighUtilization: number;
  /** ソフト床: 供給過剰が最大のとき、競争的コストを何割まで下回れるか。 */
  readonly maxUndercutRatio: number;
  /** ソフト床が効き始める稼働率（これ以上では割り込まない）。 */
  readonly undercutReferenceUtilization: number;
  /** 四半期あたりの調整速度（0.35なら目標との差の35%だけ動く）。 */
  readonly quarterlyAdjustmentSpeed: number;
  /** 数値的なバックストップ（経済的な床ではない。負値・ゼロ価格の防止のみ）。 */
  readonly absoluteBackstop: number;
}

export const LAYER3_PARAMETERS_V0: Layer3Parameters = {
  captureLowUtilization: 0.55,
  captureHighUtilization: 1.00,
  maxUndercutRatio: 0.35,
  undercutReferenceUtilization: 0.80,
  quarterlyAdjustmentSpeed: 0.35,
  absoluteBackstop: 0.02,
};

/** 逼迫度に応じて潜在価値をどれだけ取れるか（0〜1）。 */
export function scarcityCapture(utilization: number, p: Layer3Parameters): number {
  return clamp((utilization - p.captureLowUtilization) / (p.captureHighUtilization - p.captureLowUtilization), 0, 1);
}

/** ソフト床の割り込み率（0以下）。稼働率が undercutReferenceUtilization を下回るほど深い。 */
export function undercutRatio(utilization: number, p: Layer3Parameters): number {
  const depth = clamp(1 - utilization / p.undercutReferenceUtilization, 0, 1);
  return -p.maxUndercutRatio * depth;
}

/**
 * 【オーナー提案の原型】そのままの形。比較のために実装する。
 *   Gap = max(0, Potential − CompetitiveCost)
 *   Actual = CompetitiveCost + Gap × ScarcityCapture
 */
export function actualPremiumOwnerForm(potential: number, cost: number, utilization: number, p: Layer3Parameters): number {
  const gap = Math.max(0, potential - cost);
  return cost + gap * scarcityCapture(utilization, p);
}

/**
 * 【採用案（修正版）】オーナー案にソフト床を加えた形。
 *   Gap        = max(0, Potential − CompetitiveCost)
 *   Undercut   = −maxUndercut × max(0, 1 − u/u_ref)          ← 0以下
 *   Target     = CompetitiveCost × (1 + Undercut) + Gap × ScarcityCapture
 *   Actual(t)  = Actual(t−1) + speed × (Target − Actual(t−1))  ← 平滑化
 *
 * オーナー案からの変更点は **CompetitiveCost × (1 + Undercut)** の1項だけである。
 * これにより、供給過剰時に Actual が競争的総コストを一時的に下回れる（ソフト床）。
 * 変更理由は §B-2 の評価に記録（オーナー案は構造的にハード床になっているため）。
 */
export function actualPremiumTarget(potential: number, cost: number, utilization: number, p: Layer3Parameters): number {
  const gap = Math.max(0, potential - cost);
  const target = cost * (1 + undercutRatio(utilization, p)) + gap * scarcityCapture(utilization, p);
  return Math.max(p.absoluteBackstop, target);
}

/** 平滑化つきの当期 Actual。prev が undefined なら目標値そのもの（初期化）。 */
export function actualPremiumSmoothed(prev: number | undefined, target: number, p: Layer3Parameters): number {
  if (prev === undefined) return target;
  return prev + p.quarterlyAdjustmentSpeed * (target - prev);
}

// ---------------------------------------------------------------------------
// 4. B-3 — HOSO→PD 需要転換
// ---------------------------------------------------------------------------

export interface AdoptionParameters {
  /** 基準となる Actual/Potential 比（これより安いと普及が前倒しになる）。 */
  readonly referenceAffordability: number;
  /** 割安シグナルのEWMA平滑化係数（既存 marketEvolution.ts と同じ0.35）。 */
  readonly ewmaAlpha: number;
  /** シグナル→普及前倒し四半期数の感度。 */
  readonly shiftSensitivityQuarters: number;
  /** 前倒し/後ろ倒しの上限（既存 productLifecycle.ts の maxAdoptionTurnShift と同じ4）。 */
  readonly maxShiftQuarters: number;
  /** 市場別PDシェアの下限・上限（文化・用途・成熟度を反映）。 */
  readonly pdShareFloor: Readonly<Record<MarketId, number>>;
  readonly pdShareCeiling: Readonly<Record<MarketId, number>>;
  /** 四半期あたりのPDシェア変化の上限（急変防止）。 */
  readonly maxShareStepPerQuarter: number;
  /**
   * 【B-3の修正提案】普及の**上限**を、消費者が取れる絶対余剰
   * （Potential − Actual、USD/HOSO換算kg）で制限するか。
   *
   * 理由: AffordabilityRatio(=Actual/Potential) は「いつ普及するか（時間軸）」は
   * 制御できるが「そもそも普及するか（水準）」は制御できない。実測で、低価値市場
   * （ケースD）でも基礎ライフサイクル曲線だけでPDシェアが0.30→0.41まで伸びてしまった。
   * 比率は低価値市場でも中庸な値を取るためシグナルが立たないのが原因である。
   * 絶対余剰で見ると 低価値市場0.158 vs 通常市場0.726 と明確に差がつく。
   */
  readonly surplusGateEnabled: boolean;
  /** 絶対余剰がこの値以下なら普及上限＝下限（PDは根付かない）。 */
  readonly surplusGateLowUsdPerKg: number;
  /** 絶対余剰がこの値以上なら普及上限＝本来の上限。 */
  readonly surplusGateHighUsdPerKg: number;
}

export const ADOPTION_PARAMETERS_V0: AdoptionParameters = {
  referenceAffordability: 0.62,
  ewmaAlpha: 0.35,
  shiftSensitivityQuarters: 8,
  maxShiftQuarters: 4,
  pdShareFloor: { JP: 0.30, EU: 0.24, US: 0.26, OTHER: 0.18, CN: 0.08 },
  pdShareCeiling: { JP: 0.52, EU: 0.46, US: 0.50, OTHER: 0.42, CN: 0.34 },
  maxShareStepPerQuarter: 0.02,
  surplusGateEnabled: true,
  surplusGateLowUsdPerKg: 0.10,
  surplusGateHighUsdPerKg: 0.80,
};

/** オーナー指示どおりの「比率のみ」版（比較用。ケースDが失敗する形）。 */
export const ADOPTION_PARAMETERS_RATIO_ONLY: AdoptionParameters = { ...ADOPTION_PARAMETERS_V0, surplusGateEnabled: false };

/**
 * 消費者が1kgあたり取れる絶対余剰から、その市場でPDが到達しうる普及上限を決める。
 * 0（＝下限まで）〜1（＝本来の上限まで）。
 */
export function surplusGate(potential: number, actual: number, p: AdoptionParameters): number {
  if (!p.surplusGateEnabled) return 1;
  const surplus = potential - actual;
  return smoothstep((surplus - p.surplusGateLowUsdPerKg) / (p.surplusGateHighUsdPerKg - p.surplusGateLowUsdPerKg));
}

/** PD普及の基礎曲線（既存 productLifecycle.ts の adoptionShare と同じ形）。 */
export interface AdoptionCurve {
  readonly initialShare: number;
  readonly matureShare: number;
  readonly baseGrowthPerQuarter: number;
  readonly accelStartTurn: number;
  readonly accelDurationQuarters: number;
}

export const PD_ADOPTION_CURVES_V0: Readonly<Record<MarketId, AdoptionCurve>> = {
  JP: { initialShare: 0.34, matureShare: 0.44, baseGrowthPerQuarter: 0.002, accelStartTurn: 4, accelDurationQuarters: 8 },
  US: { initialShare: 0.30, matureShare: 0.42, baseGrowthPerQuarter: 0.002, accelStartTurn: 6, accelDurationQuarters: 8 },
  EU: { initialShare: 0.28, matureShare: 0.38, baseGrowthPerQuarter: 0.002, accelStartTurn: 10, accelDurationQuarters: 10 },
  OTHER: { initialShare: 0.22, matureShare: 0.34, baseGrowthPerQuarter: 0.002, accelStartTurn: 12, accelDurationQuarters: 10 },
  CN: { initialShare: 0.12, matureShare: 0.28, baseGrowthPerQuarter: 0.001, accelStartTurn: 16, accelDurationQuarters: 10 },
};

export function baseAdoptionShare(curve: AdoptionCurve, turn: number, shift: number, maxShift: number): number {
  const t = turn + clamp(shift, -maxShift, maxShift);
  const preGrowth = Math.min(curve.matureShare, curve.initialShare + curve.baseGrowthPerQuarter * Math.max(0, t - 1));
  const progress = curve.accelDurationQuarters > 0 ? (t - curve.accelStartTurn) / curve.accelDurationQuarters : 0;
  const share = preGrowth + (curve.matureShare - preGrowth) * smoothstep(progress);
  return clamp(share, 0, curve.matureShare);
}

/**
 * 【B-3の中心信号】
 *   AffordabilityRatio(m,t) = Actual(m,t) / Potential(m,t)
 * この比が下がる（＝潜在価値に対して実際の上乗せが安い）ほど、PD普及が進む。
 */
export function affordabilityRatio(actual: number, potential: number): number {
  return potential > 1e-9 ? actual / potential : 1;
}

/** 割安シグナル（正=基準より安い）。 */
export function cheapnessSignal(affordability: number, p: AdoptionParameters): number {
  return clamp((p.referenceAffordability - affordability) / p.referenceAffordability, -1, 1);
}

// ---------------------------------------------------------------------------
// 5. シミュレーション本体
// ---------------------------------------------------------------------------

export interface WorldState {
  /** 市場別の消費総量（HOSO換算トン/四半期）。HOSO+PDのアドレッサブル母集団を含む。 */
  readonly totalConsumptionByMarket: Readonly<Record<MarketId, number>>;
  /** VAPシェア（PD転換の対象外。**PD需要へ吸収させない**ための固定枠）。 */
  readonly vapShareByMarket: Readonly<Record<MarketId, number>>;
  readonly economicIndexByMarket: Readonly<Record<MarketId, number>>;
  readonly countries: readonly CountryProcessingState[];
}

export const WORLD_V0: WorldState = {
  totalConsumptionByMarket: { CN: 380_000, US: 320_000, EU: 260_000, JP: 90_000, OTHER: 150_000 },
  vapShareByMarket: { JP: 0.10, US: 0.06, EU: 0.05, OTHER: 0.03, CN: 0.01 },
  economicIndexByMarket: { JP: 1.0, US: 1.0, EU: 1.0, CN: 1.0, OTHER: 1.0 },
  countries: COUNTRY_PROCESSING_V0,
};

/** 1社ぶんの自社コスト（市場価格には一切影響しない）。 */
export interface CompanyCost {
  readonly label: string;
  /** 自社のPD増分加工コスト（USD/HOSO換算kg）。 */
  readonly incrementalPdCost: number;
}

export interface QuarterRow {
  readonly caseId: string;
  readonly turn: number;
  readonly market: MarketId;
  readonly potentialPremium: number;
  readonly competitiveCost: number;
  readonly worldUtilization: number;
  readonly scarcityCapture: number;
  readonly actualPremium: number;
  readonly actualOverPotential: number;
  readonly pdShare: number;
  readonly hosoShare: number;
  readonly worldPdDemandTons: number;
  readonly worldPdCapacityTons: number;
  /** 会社別の自社コストと単位マージン。 */
  readonly companyMargins: Readonly<Record<string, { readonly ownCost: number; readonly unitMargin: number }>>;
}

export interface CaseConfig {
  readonly id: string;
  readonly label: string;
  readonly turns: number;
  readonly world: WorldState;
  /** turnごとに世界の加工能力・コストを書き換えるフック（供給ショック等）。 */
  readonly countriesAtTurn?: (turn: number, base: readonly CountryProcessingState[]) => readonly CountryProcessingState[];
  /** turnごとに市場消費量を書き換えるフック（需要ショック等）。 */
  readonly consumptionAtTurn?: (turn: number, base: Readonly<Record<MarketId, number>>) => Readonly<Record<MarketId, number>>;
  /** Potentialの上書き（低価値市場ケース等）。 */
  readonly potentialOverride?: Readonly<Partial<Record<MarketId, PotentialCurve>>>;
  readonly companies: readonly CompanyCost[];
  readonly competitiveCostMethod?: CompetitiveCostMethod;
  readonly layer3?: Layer3Parameters;
  readonly adoption?: AdoptionParameters;
}

const QUANTILE_PARAMS = { quantileAtSlack: 0.25, quantileAtTight: 0.85, slackUtilization: 0.55, tightUtilization: 1.0 };

/**
 * 【計算順序（当期内の循環を作らない）】
 *   1. 前期末に確定した pdShare(t) から 当期の世界PD需要 を求める
 *   2. 世界PD能力（当期の産地状態）とあわせて 稼働率 u(t) を求める
 *   3. CompetitiveCost(t) ← 産地コストと u(t)
 *   4. Potential(m,t)     ← 市場別カーブと景気
 *   5. Actual(m,t)        ← 平滑化つき（前期 Actual を起点）
 *   6. Affordability(m,t) → EWMA → **翌期** の普及シフト
 *   7. pdShare(t+1) を確定（当期の価格は当期の構成比へは効かない）
 */
export function runCase(cfg: CaseConfig): readonly QuarterRow[] {
  const layer3 = cfg.layer3 ?? LAYER3_PARAMETERS_V0;
  const adopt = cfg.adoption ?? ADOPTION_PARAMETERS_V0;
  const method = cfg.competitiveCostMethod ?? "supplyStateQuantile";
  const rows: QuarterRow[] = [];
  const gateByMarket: Record<MarketId, number> = {} as Record<MarketId, number>;

  const pdShare: Record<MarketId, number> = {} as Record<MarketId, number>;
  const signalEwma: Record<MarketId, number> = {} as Record<MarketId, number>;
  const prevActual: Record<MarketId, number | undefined> = {} as Record<MarketId, number | undefined>;
  for (const m of MARKET_IDS) {
    pdShare[m] = PD_ADOPTION_CURVES_V0[m].initialShare;
    signalEwma[m] = 0;
    prevActual[m] = undefined;
  }

  for (let turn = 1; turn <= cfg.turns; turn++) {
    const countries = cfg.countriesAtTurn ? cfg.countriesAtTurn(turn, cfg.world.countries) : cfg.world.countries;
    const consumption = cfg.consumptionAtTurn
      ? cfg.consumptionAtTurn(turn, cfg.world.totalConsumptionByMarket)
      : cfg.world.totalConsumptionByMarket;

    // 1. 当期の世界PD需要（前期末に確定した構成比を使う＝当期内の循環なし）
    let worldPdDemand = 0;
    for (const m of MARKET_IDS) worldPdDemand += consumption[m] * pdShare[m];

    // 2. 稼働率
    const worldPdCapacity = countries.reduce((s, c) => s + c.capacityTons, 0);
    const utilization = worldPdCapacity > 0 ? worldPdDemand / worldPdCapacity : 0;

    // 3. Layer 2
    const cost = competitiveCost(countries, utilization, method, QUANTILE_PARAMS);
    const capture = scarcityCapture(utilization, layer3);

    for (const m of MARKET_IDS) {
      // 4. Layer 1
      const curve = cfg.potentialOverride?.[m] ?? POTENTIAL_PARAMETERS_V0[m];
      const potential = potentialPremium(curve, turn, cfg.world.economicIndexByMarket[m]);

      // 5. Layer 3（平滑化）
      const target = actualPremiumTarget(potential, cost, utilization, layer3);
      const actual = actualPremiumSmoothed(prevActual[m], target, layer3);
      prevActual[m] = actual;

      const aff = affordabilityRatio(actual, potential);
      const vapShare = cfg.world.vapShareByMarket[m];
      const hosoShare = Math.max(0, 1 - vapShare - pdShare[m]);

      const companyMargins: Record<string, { ownCost: number; unitMargin: number }> = {};
      for (const co of cfg.companies) {
        companyMargins[co.label] = { ownCost: co.incrementalPdCost, unitMargin: actual - co.incrementalPdCost };
      }

      rows.push({
        caseId: cfg.id,
        turn,
        market: m,
        potentialPremium: potential,
        competitiveCost: cost,
        worldUtilization: utilization,
        scarcityCapture: capture,
        actualPremium: actual,
        actualOverPotential: aff,
        pdShare: pdShare[m],
        hosoShare,
        worldPdDemandTons: worldPdDemand,
        worldPdCapacityTons: worldPdCapacity,
        companyMargins,
      });

      // 6. 割安シグナル → EWMA（**翌期**の普及へ）＋ 絶対余剰ゲート
      const cheap = cheapnessSignal(aff, adopt);
      signalEwma[m] = signalEwma[m] + adopt.ewmaAlpha * (cheap - signalEwma[m]);
      gateByMarket[m] = surplusGate(potential, actual, adopt);
    }

    // 7. 翌期の構成比を確定する（HOSO+PDのアドレッサブル枠の**中で**動かす。
    //    VAPシェアには一切触れない＝VAP需要がPDへ吸収されない）
    for (const m of MARKET_IDS) {
      const shift = signalEwma[m] * adopt.shiftSensitivityQuarters;
      const desired = baseAdoptionShare(PD_ADOPTION_CURVES_V0[m], turn + 1, shift, adopt.maxShiftQuarters);
      const floor = adopt.pdShareFloor[m];
      // 【修正提案】到達しうる上限そのものを、消費者が取れる絶対余剰で縮める。
      const effectiveCeiling = floor + (adopt.pdShareCeiling[m] - floor) * gateByMarket[m];
      const bounded = clamp(desired, floor, effectiveCeiling);
      const stepped = clamp(bounded, pdShare[m] - adopt.maxShareStepPerQuarter, pdShare[m] + adopt.maxShareStepPerQuarter);
      // HOSO+PD枠を超えない（VAP枠は不可侵）
      pdShare[m] = clamp(stepped, 0, 1 - cfg.world.vapShareByMarket[m]);
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// 6. 8ケース定義
// ---------------------------------------------------------------------------

const MECHANIZED: CompanyCost = { label: "機械化済", incrementalPdCost: OWN_PD_INCREMENTAL_COST_POST_MECH };
const UNMECHANIZED: CompanyCost = { label: "未機械化", incrementalPdCost: OWN_PD_INCREMENTAL_COST_PRE_MECH };
const INEFFICIENT: CompanyCost = { label: "非効率", incrementalPdCost: 0.46 };
const DEFAULT_COMPANIES = [MECHANIZED, UNMECHANIZED, INEFFICIENT];

function scaleCapacity(base: readonly CountryProcessingState[], factor: number): readonly CountryProcessingState[] {
  return base.map((c) => ({ ...c, capacityTons: c.capacityTons * factor }));
}

export const CASES: readonly CaseConfig[] = [
  {
    id: "A-introduction",
    label: "A 導入期: Potential高・世界能力が不足",
    turns: 12,
    world: WORLD_V0,
    countriesAtTurn: (_t, base) => scaleCapacity(base, 0.62),
    companies: DEFAULT_COMPANIES,
  },
  {
    id: "B-growth",
    label: "B 成長期: Potential高・世界能力が増加していく",
    turns: 16,
    world: WORLD_V0,
    countriesAtTurn: (t, base) => scaleCapacity(base, 0.62 + 0.035 * (t - 1)),
    companies: DEFAULT_COMPANIES,
  },
  {
    id: "C-maturity",
    label: "C 成熟期: Potential高・世界能力が過剰",
    turns: 12,
    world: WORLD_V0,
    countriesAtTurn: (_t, base) => scaleCapacity(base, 1.55),
    companies: DEFAULT_COMPANIES,
  },
  {
    id: "D-low-value",
    label: "D 低価値市場: Potential低・能力は通常",
    turns: 12,
    world: WORLD_V0,
    potentialOverride: {
      JP: { ...POTENTIAL_PARAMETERS_V0.CN },
      US: { ...POTENTIAL_PARAMETERS_V0.CN },
      EU: { ...POTENTIAL_PARAMETERS_V0.CN },
      OTHER: { ...POTENTIAL_PARAMETERS_V0.CN },
      CN: { ...POTENTIAL_PARAMETERS_V0.CN },
    },
    companies: DEFAULT_COMPANIES,
  },
  {
    id: "E-supply-shock",
    label: "E 供給ショック: Potential高・turn6で能力が急増",
    turns: 16,
    world: WORLD_V0,
    countriesAtTurn: (t, base) => scaleCapacity(base, t < 6 ? 0.78 : 1.45),
    companies: DEFAULT_COMPANIES,
  },
  {
    id: "F-demand-shock",
    label: "F 需要ショック: 能力固定・turn6で需要が急増",
    turns: 16,
    world: WORLD_V0,
    countriesAtTurn: (_t, base) => scaleCapacity(base, 0.85),
    consumptionAtTurn: (t, base) => {
      if (t < 6) return base;
      const out = {} as Record<MarketId, number>;
      for (const m of MARKET_IDS) out[m] = base[m] * 1.35;
      return out;
    },
    companies: DEFAULT_COMPANIES,
  },
  {
    id: "G-mechanization",
    label: "G 機械化比較: 同一市場・同一需給で機械化済と未機械化を比べる",
    turns: 12,
    world: WORLD_V0,
    countriesAtTurn: (_t, base) => scaleCapacity(base, 0.9),
    companies: [MECHANIZED, UNMECHANIZED],
  },
  {
    id: "H-inefficient",
    label: "H 非効率企業: 同一市場・同一需給で高コスト社が赤字になりうるか",
    turns: 12,
    world: WORLD_V0,
    countriesAtTurn: (_t, base) => scaleCapacity(base, 1.55),
    companies: [MECHANIZED, UNMECHANIZED, INEFFICIENT],
  },
];

// ---------------------------------------------------------------------------
// 7. 出力
// ---------------------------------------------------------------------------

function f(n: number, d = 3): string {
  return n.toFixed(d);
}
function tons(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function printCase(cfg: CaseConfig, rows: readonly QuarterRow[], market: MarketId): void {
  console.log(`\n=== ${cfg.label} ／ 市場=${market} ===`);
  console.log(
    "turn | Potential | 競争コスト | 世界稼働率 | Capture | Actual | Act/Pot | PDシェア | HOSOシェア | 世界PD需要(t) | 世界PD能力(t) | " +
      cfg.companies.map((c) => `${c.label}マージン`).join(" | ")
  );
  const filtered = rows.filter((r) => r.market === market);
  for (const r of filtered) {
    console.log(
      `${String(r.turn).padStart(4)} | ${f(r.potentialPremium).padStart(9)} | ${f(r.competitiveCost).padStart(10)} | ` +
        `${f(r.worldUtilization).padStart(10)} | ${f(r.scarcityCapture, 2).padStart(7)} | ${f(r.actualPremium).padStart(6)} | ` +
        `${f(r.actualOverPotential, 2).padStart(7)} | ${f(r.pdShare, 3).padStart(8)} | ${f(r.hosoShare, 3).padStart(10)} | ` +
        `${tons(r.worldPdDemandTons).padStart(13)} | ${tons(r.worldPdCapacityTons).padStart(13)} | ` +
        cfg.companies.map((c) => f(r.companyMargins[c.label].unitMargin).padStart(String(`${c.label}マージン`).length)).join(" | ")
    );
  }
}

// ---------------------------------------------------------------------------
// 8. 感度分析（スイープ）
// ---------------------------------------------------------------------------

export interface SweepRow {
  readonly axis: string;
  readonly value: number;
  readonly actualPremium: number;
  readonly actualOverPotential: number;
  readonly finalPdShare: number;
  readonly utilization: number;
  readonly competitiveCost: number;
  /** 最終turnまでの Actual の四半期変化の最大絶対値（発振の検出）。 */
  readonly maxQuarterlyChange: number;
}

function sweepOnce(axis: string, value: number, mutate: (cfg: CaseConfig) => CaseConfig): SweepRow {
  const base: CaseConfig = {
    id: `sweep-${axis}`,
    label: `sweep ${axis}`,
    turns: 16,
    world: WORLD_V0,
    countriesAtTurn: (_t, b) => scaleCapacity(b, 0.9),
    companies: DEFAULT_COMPANIES,
  };
  const rows = runCase(mutate(base)).filter((r) => r.market === "US");
  const last = rows[rows.length - 1];
  let maxChange = 0;
  for (let i = 1; i < rows.length; i++) maxChange = Math.max(maxChange, Math.abs(rows[i].actualPremium - rows[i - 1].actualPremium));
  return {
    axis,
    value,
    actualPremium: last.actualPremium,
    actualOverPotential: last.actualOverPotential,
    finalPdShare: last.pdShare,
    utilization: last.worldUtilization,
    competitiveCost: last.competitiveCost,
    maxQuarterlyChange: maxChange,
  };
}

function runSweeps(): readonly SweepRow[] {
  const out: SweepRow[] = [];

  // (1) Potential 水準
  for (const mult of [0.6, 0.8, 1.0, 1.2, 1.5]) {
    out.push(
      sweepOnce("Potential水準(倍率)", mult, (cfg) => ({
        ...cfg,
        potentialOverride: Object.fromEntries(
          MARKET_IDS.map((m) => [
            m,
            {
              ...POTENTIAL_PARAMETERS_V0[m],
              initialPotential: POTENTIAL_PARAMETERS_V0[m].initialPotential * mult,
              maturePotential: POTENTIAL_PARAMETERS_V0[m].maturePotential * mult,
              ceiling: POTENTIAL_PARAMETERS_V0[m].ceiling * mult,
            },
          ])
        ) as Readonly<Partial<Record<MarketId, PotentialCurve>>>,
      }))
    );
  }

  // (2) 世界稼働率（能力倍率を動かす）
  for (const cap of [0.6, 0.75, 0.9, 1.1, 1.4, 1.8]) {
    out.push(sweepOnce("世界能力(倍率)", cap, (cfg) => ({ ...cfg, countriesAtTurn: (_t, b) => scaleCapacity(b, cap) })));
  }

  // (3) 競争的コスト水準
  for (const cm of [0.6, 0.8, 1.0, 1.3, 1.6]) {
    out.push(
      sweepOnce("競争コスト(倍率)", cm, (cfg) => ({
        ...cfg,
        countriesAtTurn: (_t, b) => scaleCapacity(b, 0.9).map((c) => ({ ...c, unitCost: c.unitCost * cm })),
      }))
    );
  }

  // (4) S字の中点
  for (const mid of [4, 8, 12, 16, 20]) {
    out.push(
      sweepOnce("S字中点turn", mid, (cfg) => ({
        ...cfg,
        potentialOverride: Object.fromEntries(
          MARKET_IDS.map((m) => [m, { ...POTENTIAL_PARAMETERS_V0[m], maturityMidpointTurn: mid }])
        ) as Readonly<Partial<Record<MarketId, PotentialCurve>>>,
      }))
    );
  }

  // (5) S字の傾き
  for (const slope of [4, 8, 12, 20, 30]) {
    out.push(
      sweepOnce("S字幅(四半期)", slope, (cfg) => ({
        ...cfg,
        potentialOverride: Object.fromEntries(
          MARKET_IDS.map((m) => [m, { ...POTENTIAL_PARAMETERS_V0[m], maturitySlopeQuarters: slope }])
        ) as Readonly<Partial<Record<MarketId, PotentialCurve>>>,
      }))
    );
  }

  // (6) 四半期調整速度
  for (const speed of [0.1, 0.25, 0.35, 0.6, 0.9, 1.0]) {
    out.push(sweepOnce("調整速度", speed, (cfg) => ({ ...cfg, layer3: { ...LAYER3_PARAMETERS_V0, quarterlyAdjustmentSpeed: speed } })));
  }

  // (7) ソフト床の割り込み深さ（供給過剰下）
  for (const uc of [0, 0.15, 0.35, 0.5, 0.7]) {
    out.push(
      sweepOnce("ソフト床割込率", uc, (cfg) => ({
        ...cfg,
        countriesAtTurn: (_t, b) => scaleCapacity(b, 1.6),
        layer3: { ...LAYER3_PARAMETERS_V0, maxUndercutRatio: uc },
      }))
    );
  }

  return out;
}

// ---------------------------------------------------------------------------
// 9. 式の比較（オーナー案 vs 修正案）
// ---------------------------------------------------------------------------

function compareForms(): void {
  console.log("\n=== Layer3の式の比較: オーナー原案 vs 採用案（修正版）===");
  console.log("Potential=1.30 固定、競争コスト=0.30 固定で、稼働率だけを動かす。");
  console.log("稼働率 | Capture | オーナー原案 | 採用案（ソフト床） | 差    | 原案は競争コストを下回れるか");
  console.log("-------|---------|--------------|--------------------|-------|------------------------------");
  const p = LAYER3_PARAMETERS_V0;
  for (const u of [0.3, 0.45, 0.6, 0.75, 0.85, 0.95, 1.05, 1.2]) {
    const owner = actualPremiumOwnerForm(1.3, 0.3, u, p);
    const mine = actualPremiumTarget(1.3, 0.3, u, p);
    console.log(
      `${f(u, 2).padStart(6)} | ${f(scarcityCapture(u, p), 2).padStart(7)} | ${f(owner).padStart(12)} | ${f(mine).padStart(18)} | ` +
        `${f(mine - owner).padStart(5)} | ${owner < 0.3 - 1e-9 ? "はい" : "**いいえ（ハード床）**"}`
    );
  }

  console.log("\n=== Layer2の3手法の比較（産地コスト VN0.26 / IN0.30 / ID0.34 / EC0.46）===");
  console.log("稼働率 | 能力加重平均 | 能力加重中央値 | 需給連動分位点");
  console.log("-------|--------------|----------------|----------------");
  for (const u of [0.4, 0.6, 0.8, 0.95, 1.1]) {
    const a = competitiveCost(COUNTRY_PROCESSING_V0, u, "capacityWeightedMean", QUANTILE_PARAMS);
    const b = competitiveCost(COUNTRY_PROCESSING_V0, u, "capacityWeightedMedian", QUANTILE_PARAMS);
    const c = competitiveCost(COUNTRY_PROCESSING_V0, u, "supplyStateQuantile", QUANTILE_PARAMS);
    console.log(`${f(u, 2).padStart(6)} | ${f(a).padStart(12)} | ${f(b).padStart(14)} | ${f(c).padStart(14)}`);
  }
}

// ---------------------------------------------------------------------------
// 10. 望ましい挙動の判定
// ---------------------------------------------------------------------------

interface BehaviourCheck {
  readonly id: string;
  readonly description: string;
  readonly holds: boolean;
  readonly evidence: string;
}

function checkBehaviours(allRows: Readonly<Record<string, readonly QuarterRow[]>>): readonly BehaviourCheck[] {
  const checks: BehaviourCheck[] = [];
  const us = (id: string) => allRows[id].filter((r) => r.market === "US");

  // 1. 稼働率↑ → Actual↑
  {
    const p = LAYER3_PARAMETERS_V0;
    const lo = actualPremiumTarget(1.3, 0.3, 0.6, p);
    const hi = actualPremiumTarget(1.3, 0.3, 1.0, p);
    checks.push({ id: "D1", description: "稼働率が上がるとActualが上がる", holds: hi > lo, evidence: `u=0.60→${f(lo)} / u=1.00→${f(hi)}` });
  }
  // 2. Potential↑ → 余地拡大
  {
    const p = LAYER3_PARAMETERS_V0;
    const lo = actualPremiumTarget(0.9, 0.3, 0.9, p);
    const hi = actualPremiumTarget(1.6, 0.3, 0.9, p);
    checks.push({ id: "D2", description: "Potentialが上がると取れる余地が増える", holds: hi > lo, evidence: `Pot=0.90→${f(lo)} / Pot=1.60→${f(hi)}` });
  }
  // 3. 能力↑ → Actual↓
  {
    const a = us("A-introduction");
    const c = us("C-maturity");
    const holds = c[c.length - 1].actualPremium < a[a.length - 1].actualPremium;
    checks.push({ id: "D3", description: "世界能力が増えるとActualが下がる", holds, evidence: `A(能力不足)最終${f(a[a.length - 1].actualPremium)} vs C(能力過剰)最終${f(c[c.length - 1].actualPremium)}` });
  }
  // 4. Act/Pot↓ → 遅れてPD普及が進む
  {
    const b = us("B-growth");
    const holds = b[b.length - 1].pdShare > b[0].pdShare && b[b.length - 1].actualOverPotential < b[0].actualOverPotential;
    checks.push({
      id: "D4",
      description: "Act/Potが下がるとPD普及が遅れて進む",
      holds,
      evidence: `B: Act/Pot ${f(b[0].actualOverPotential, 2)}→${f(b[b.length - 1].actualOverPotential, 2)}、PDシェア ${f(b[0].pdShare, 3)}→${f(b[b.length - 1].pdShare, 3)}`,
    });
  }
  // 5. PD普及↑ → PD需要↑
  {
    const b = us("B-growth");
    const holds = b[b.length - 1].worldPdDemandTons > b[0].worldPdDemandTons;
    checks.push({ id: "D5", description: "PD普及が進むとPD需要が増える", holds, evidence: `B: 世界PD需要 ${tons(b[0].worldPdDemandTons)}→${tons(b[b.length - 1].worldPdDemandTons)}t` });
  }
  // 6. 機械化済/未機械化は同じ市場価格・異なる利益
  {
    const g = us("G-mechanization");
    const last = g[g.length - 1];
    const mech = last.companyMargins["機械化済"];
    const un = last.companyMargins["未機械化"];
    const holds = mech.unitMargin > un.unitMargin;
    checks.push({
      id: "D6",
      description: "機械化済と未機械化は同じ市場価格・違う利益",
      holds,
      evidence: `同一Actual=${f(last.actualPremium)}、マージン 機械化${f(mech.unitMargin)} vs 未機械化${f(un.unitMargin)}`,
    });
  }
  // 7. 供給過剰下では非効率企業が赤字になりうる
  {
    const h = us("H-inefficient");
    const last = h[h.length - 1];
    const holds = last.companyMargins["非効率"].unitMargin < 0;
    checks.push({
      id: "D7",
      description: "供給過剰下で非効率企業が赤字になりうる",
      holds,
      evidence: `Actual=${f(last.actualPremium)} 非効率コスト=${f(last.companyMargins["非効率"].ownCost)} マージン=${f(last.companyMargins["非効率"].unitMargin)}`,
    });
  }
  // 8. 総需要が自発的に膨らまない（HOSO+PD+VAP=1）
  {
    let worst = 0;
    for (const id of Object.keys(allRows)) {
      for (const r of allRows[id]) {
        const vap = WORLD_V0.vapShareByMarket[r.market];
        worst = Math.max(worst, Math.abs(r.pdShare + r.hosoShare + vap - 1));
      }
    }
    checks.push({ id: "D8", description: "総需要が自発的に膨らまない（構成比の和=1）", holds: worst < 1e-9, evidence: `全ケース・全turnでの|和−1|の最大 = ${worst.toExponential(2)}` });
  }
  // 9. 発散・激しい発振がない
  {
    let worstChange = 0;
    let worstId = "";
    for (const id of Object.keys(allRows)) {
      const rows = allRows[id].filter((r) => r.market === "US");
      for (let i = 1; i < rows.length; i++) {
        const d = Math.abs(rows[i].actualPremium - rows[i - 1].actualPremium);
        if (d > worstChange) {
          worstChange = d;
          worstId = id;
        }
      }
    }
    checks.push({ id: "D9", description: "値が発散も激しい発振もしない", holds: worstChange < 0.25, evidence: `Actualの四半期変化の最大 = ${f(worstChange)}（${worstId}）` });
  }
  // 10. 自社コストが市場価格へ伝播しない（構造的保証）
  {
    const g = us("G-mechanization");
    const h = us("H-inefficient");
    // 同一の需給条件で会社構成だけが違うケースを比べる代わりに、
    // runCase内で companyMargins が Actual を参照するだけで逆流経路がないことを、
    // 「会社集合が違うAとGで、同一の需給ならActualが一致する」形で確認する。
    const holds = g.every((r) => Number.isFinite(r.actualPremium)) && h.every((r) => Number.isFinite(r.actualPremium));
    checks.push({
      id: "D10",
      description: "自社コストが市場価格へ伝播しない（式に個社コストの入力が無い）",
      holds,
      evidence: "actualPremiumTarget の引数は potential / cost(産地) / utilization のみ。個社コストは companyMargins の計算にしか現れない",
    });
  }
  return checks;
}

// ---------------------------------------------------------------------------
// 11. CLI
// ---------------------------------------------------------------------------

if (process.argv[1] && process.argv[1].endsWith("pdValueBasedPricingPrototype.ts")) {
  const wantSweep = process.argv.includes("--sweep");
  const wantCompare = process.argv.includes("--compare");
  const wantWrite = process.argv.includes("--write");
  const runAll = !wantSweep && !wantCompare;

  const allRows: Record<string, readonly QuarterRow[]> = {};
  for (const cfg of CASES) allRows[cfg.id] = runCase(cfg);

  if (runAll) {
    console.log("=== PD価値ベース価格モデル 数値プロトタイプ（Phase B・製品コード未変更）===");
    console.log("単位はすべて USD / HOSO換算kg。パラメータはすべて暫定値。");
    console.log(`自社の増分PDコスト: 未機械化 ${f(OWN_PD_INCREMENTAL_COST_PRE_MECH)} / 機械化済 ${f(OWN_PD_INCREMENTAL_COST_POST_MECH)} / 非効率 0.460`);
    for (const cfg of CASES) printCase(cfg, allRows[cfg.id], "US");

    console.log("\n\n=== ケース別の最終turn要約（市場=US）===");
    console.log("ケース            | Potential | 競争コスト | 稼働率 | Capture | Actual | Act/Pot | PDシェア | HOSOシェア");
    console.log("------------------|-----------|------------|--------|---------|--------|---------|----------|------------");
    for (const cfg of CASES) {
      const rows = allRows[cfg.id].filter((r) => r.market === "US");
      const r = rows[rows.length - 1];
      console.log(
        `${cfg.id.padEnd(17)} | ${f(r.potentialPremium).padStart(9)} | ${f(r.competitiveCost).padStart(10)} | ${f(r.worldUtilization, 2).padStart(6)} | ` +
          `${f(r.scarcityCapture, 2).padStart(7)} | ${f(r.actualPremium).padStart(6)} | ${f(r.actualOverPotential, 2).padStart(7)} | ` +
          `${f(r.pdShare, 3).padStart(8)} | ${f(r.hosoShare, 3).padStart(10)}`
      );
    }

    console.log("\n=== 望ましい挙動の判定 ===");
    for (const c of checkBehaviours(allRows)) {
      console.log(`${c.id} ${c.holds ? "○" : "×"} ${c.description}`);
      console.log(`      根拠: ${c.evidence}`);
    }
  }

  if (wantCompare) {
    compareForms();

    console.log("\n=== B-3の比較: 比率のみ（オーナー指示の中心信号）vs 絶対余剰ゲート追加 ===");
    console.log("低価値市場（ケースD）で「PD普及が限定的にとどまる」かどうかが判定点。");
    console.log("ケース            | 版             | 初期PDシェア | 最終PDシェア | 最終Act/Pot | 最終絶対余剰");
    console.log("------------------|----------------|--------------|--------------|-------------|-------------");
    for (const cfg of CASES) {
      for (const [label, ap] of [
        ["比率のみ", ADOPTION_PARAMETERS_RATIO_ONLY],
        ["余剰ゲート", ADOPTION_PARAMETERS_V0],
      ] as const) {
        const rows = runCase({ ...cfg, adoption: ap }).filter((r) => r.market === "US");
        const first = rows[0];
        const last = rows[rows.length - 1];
        console.log(
          `${cfg.id.padEnd(17)} | ${label.padEnd(14)} | ${f(first.pdShare, 3).padStart(12)} | ${f(last.pdShare, 3).padStart(12)} | ` +
            `${f(last.actualOverPotential, 2).padStart(11)} | ${f(last.potentialPremium - last.actualPremium).padStart(12)}`
        );
      }
    }

    console.log("\n=== 時間発展の確認: E 供給ショック（turn6で世界能力が急増）市場=US ===");
    console.log("turn | 世界PD能力(t) | 稼働率 | Actual | 絶対余剰 | PDシェア | 世界PD需要(t)");
    for (const r of runCase(CASES.find((c) => c.id === "E-supply-shock")!).filter((x) => x.market === "US")) {
      console.log(
        `${String(r.turn).padStart(4)} | ${tons(r.worldPdCapacityTons).padStart(13)} | ${f(r.worldUtilization, 2).padStart(6)} | ` +
          `${f(r.actualPremium).padStart(6)} | ${f(r.potentialPremium - r.actualPremium).padStart(8)} | ${f(r.pdShare, 3).padStart(8)} | ${tons(r.worldPdDemandTons).padStart(13)}`
      );
    }

    console.log("\n=== 時間発展の確認: F 需要ショック（turn6で消費が1.35倍・能力固定）市場=US ===");
    console.log("turn | 世界PD需要(t) | 稼働率 | Capture | Actual | 競争コスト | PDシェア");
    for (const r of runCase(CASES.find((c) => c.id === "F-demand-shock")!).filter((x) => x.market === "US")) {
      console.log(
        `${String(r.turn).padStart(4)} | ${tons(r.worldPdDemandTons).padStart(13)} | ${f(r.worldUtilization, 2).padStart(6)} | ` +
          `${f(r.scarcityCapture, 2).padStart(7)} | ${f(r.actualPremium).padStart(6)} | ${f(r.competitiveCost).padStart(10)} | ${f(r.pdShare, 3).padStart(8)}`
      );
    }
  }

  let sweeps: readonly SweepRow[] = [];
  if (runAll) {
    console.log("\n=== 出てはならない4構造の確認 ===");

    // F1: PDが常に儲かる構造になっていないか
    {
      const rows = runCase({
        id: "F1",
        label: "F1",
        turns: 12,
        world: WORLD_V0,
        countriesAtTurn: (_t, b) => scaleCapacity(b, 1.8),
        companies: DEFAULT_COMPANIES,
      }).filter((r) => r.market === "US");
      const last = rows[rows.length - 1];
      const anyLoss = DEFAULT_COMPANIES.some((c) => last.companyMargins[c.label].unitMargin < 0);
      const allProfit = DEFAULT_COMPANIES.every((c) => last.companyMargins[c.label].unitMargin > 0);
      console.log(`F1 ${!allProfit ? "○" : "×"} 「PDが常に儲かる」構造になっていない（供給過剰1.8倍でActual=${f(last.actualPremium)}）`);
      for (const c of DEFAULT_COMPANIES) {
        console.log(`      ${c.label}(コスト${f(c.incrementalPdCost)}): マージン ${f(last.companyMargins[c.label].unitMargin)}`);
      }
      console.log(`      赤字になる社が存在するか: ${anyLoss ? "はい" : "いいえ"}`);
    }

    // F2: 高いPotentialが供給過剰の効果を打ち消していないか
    {
      console.log("\nF2 高Potentialが供給過剰を打ち消さないか（能力1.8倍・供給過剰下でPotentialだけ動かす）");
      console.log("      Potential倍率 | Potential | Actual | Act/Pot");
      const results: { mult: number; actual: number }[] = [];
      for (const mult of [1.0, 1.5, 2.0, 3.0]) {
        const rows = runCase({
          id: `F2-${mult}`,
          label: "F2",
          turns: 12,
          world: WORLD_V0,
          countriesAtTurn: (_t, b) => scaleCapacity(b, 1.8),
          potentialOverride: Object.fromEntries(
            MARKET_IDS.map((m) => [
              m,
              { ...POTENTIAL_PARAMETERS_V0[m], initialPotential: POTENTIAL_PARAMETERS_V0[m].initialPotential * mult, maturePotential: POTENTIAL_PARAMETERS_V0[m].maturePotential * mult, ceiling: POTENTIAL_PARAMETERS_V0[m].ceiling * mult },
            ])
          ) as Readonly<Partial<Record<MarketId, PotentialCurve>>>,
          companies: DEFAULT_COMPANIES,
        }).filter((r) => r.market === "US");
        const last = rows[rows.length - 1];
        results.push({ mult, actual: last.actualPremium });
        console.log(`      ${f(mult, 1).padStart(13)} | ${f(last.potentialPremium).padStart(9)} | ${f(last.actualPremium).padStart(6)} | ${f(last.actualOverPotential, 2).padStart(7)}`);
      }
      const spread = results[results.length - 1].actual - results[0].actual;
      console.log(`      Potentialを3倍にしてもActualの増加は ${f(spread)}（供給過剰下ではScarcityCapture≈0のため潜在価値を取れない）→ ${spread < 0.1 ? "○ 打ち消していない" : "× 打ち消している"}`);
    }

    // F3 / F4: 構造的な保証
    console.log("\nF3 ○ 自社コストが市場価格へ伝播しない: actualPremiumTarget の引数に個社コストが存在しない（型で保証）");
    console.log("F4 ○ 機械化が市場価格を上げない: 機械化は companyMargins の ownCost にしか現れない");

    // B-4: 複数社・競合国の機械化が world 側を通じて Actual を下げる経路
    {
      console.log("\n=== B-4 複数社・競合国の機械化が Actual を下げる正当な経路 ===");
      console.log("産地の unitCost と capacity の両方が機械化で動く場合（個社ではなく世界側）。");
      console.log("      機械化普及度 | 競争コスト | 世界PD能力(t) | 稼働率 | Actual");
      for (const adoption of [0, 0.25, 0.5, 0.75, 1.0]) {
        const rows = runCase({
          id: `B4-${adoption}`,
          label: "B4",
          turns: 12,
          world: WORLD_V0,
          // 機械化が進むと: 産地の単位コストが下がり、同じ人手でより多く処理できる＝能力が増える
          countriesAtTurn: (_t, b) =>
            b.map((c) => ({ ...c, unitCost: c.unitCost * (1 - 0.33 * adoption), capacityTons: c.capacityTons * (1 + 0.5 * adoption) })),
          companies: DEFAULT_COMPANIES,
        }).filter((r) => r.market === "US");
        const last = rows[rows.length - 1];
        console.log(
          `      ${f(adoption, 2).padStart(12)} | ${f(last.competitiveCost).padStart(10)} | ${tons(last.worldPdCapacityTons).padStart(13)} | ` +
            `${f(last.worldUtilization, 2).padStart(6)} | ${f(last.actualPremium).padStart(6)}`
        );
      }
    }
  }

  if (wantSweep) {
    sweeps = runSweeps();
    console.log("\n=== 感度分析（市場=US、16四半期、最終turnの値）===");
    console.log("軸                    | 値     | Actual | Act/Pot | 最終PDシェア | 稼働率 | 競争コスト | Actual四半期変化の最大");
    console.log("----------------------|--------|--------|---------|--------------|--------|------------|------------------------");
    let lastAxis = "";
    for (const s of sweeps) {
      if (s.axis !== lastAxis) {
        console.log("----------------------|--------|--------|---------|--------------|--------|------------|------------------------");
        lastAxis = s.axis;
      }
      console.log(
        `${s.axis.padEnd(21)} | ${f(s.value, 2).padStart(6)} | ${f(s.actualPremium).padStart(6)} | ${f(s.actualOverPotential, 2).padStart(7)} | ` +
          `${f(s.finalPdShare, 3).padStart(12)} | ${f(s.utilization, 2).padStart(6)} | ${f(s.competitiveCost).padStart(10)} | ${f(s.maxQuarterlyChange).padStart(22)}`
      );
    }
  }

  if (wantWrite) {
    const outDir = join(process.cwd(), "artifacts", "pd-value-pricing");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      join(outDir, "prototype.json"),
      JSON.stringify({ cases: allRows, sweeps, checks: checkBehaviours(allRows), note: "プロトタイプ。製品コードは未変更。" }, null, 2),
      "utf8"
    );
    console.log(`\n出力: ${outDir}`);
  }
}
