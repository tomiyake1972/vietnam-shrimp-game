// ShrimpX V2 — Phase SAI-5A: 会社別の市場・商品志向プロファイル
//
// 【目的】5社に「どの市場を重視するか」「どの商品を重視するか」という事業上の
// 個性を持たせる。SAI-4の経営性格（ManagementProfile: リスク許容度・財務
// 安全性・成長性）とは**別レイヤーの独立した属性**であり、型・設定・計算を
// 意図的に分離する（例: VAP社 = SAI-4の経営性格 × 米国志向 × PD/VAP志向）。
//
// 【勝敗を固定しない】ここで定義するのは意思決定の重み付けであり、特定会社へ
// 売上・利益を直接付与する補正は一切含まない。志向は既存Standard AIの
// 経済合理性（需要・価格・予想利益率・在庫・販売可能量）の評価へ乗算される
// 魅力度補正であって、hard constraint（資金・需要・在庫・生産能力・品質・
// 安全ガード）を上書きしない。
//
// 【会社IDによる分岐の集約】会社IDに応じた分岐は本ファイルの
// COMPANY_ORIENTATION_BY_COMPANY_ID だけに存在する（SAI-4の
// MANAGEMENT_PROFILE_BY_COMPANY_ID と同じ設計原則）。
//
// 【許容範囲（実装指示§3）】
//   市場志向倍率: 0.80〜1.25 / 商品志向倍率: 0.85〜1.20 /
//   市場×商品の総合補正: 0.70〜1.35（適用側 decision/sales.ts でclamp）
// 範囲外のプロファイルは実行時エラー（バイアス幅の安全弁、SAI-4と同方式）。

import { DemandMarketId, Product } from "../../market/types";
import { CompanyId } from "../../sales/types";
import { StandardAiParameters, STANDARD_AI_PARAMETERS_V1 } from "./parameters";
import { AppliedManagementBiasItem, resolveManagementProfileParameters } from "./managementProfile";
import { resolveStrategyProfileParameters } from "./strategyProfile";
import { StandardAiParamsResolution } from "./policy";

/** 市場志向倍率の許容範囲（実装指示§3）。 */
export const MARKET_ORIENTATION_RANGE = { min: 0.8, max: 1.25 } as const;
/** 商品志向倍率の許容範囲（実装指示§3）。 */
export const PRODUCT_ORIENTATION_RANGE = { min: 0.85, max: 1.2 } as const;
/** 市場×商品の総合補正の許容範囲（適用側でclamp。実装指示§3）。 */
export const COMBINED_ORIENTATION_RANGE = { min: 0.7, max: 1.35 } as const;

/**
 * 1社ぶんの市場・商品志向プロファイル。
 * ManagementProfile（経営性格）とは独立した属性として保持する。
 */
export interface CompanyOrientationProfile {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** 市場志向倍率（0.80〜1.25）。1.0=中立。 */
  readonly marketMultipliers: Readonly<Record<DemandMarketId, number>>;
  /** 商品志向倍率（0.85〜1.20）。1.0=中立。 */
  readonly productMultipliers: Readonly<Record<Product, number>>;
  /** 成長トレンド応答度（0〜1）: 公開ライフサイクルトレンドが正のとき、
   *  PD/VAP設備投資の入口しきい値をどの程度前倒しするか（SAI-5F）。 */
  readonly growthTrendResponsiveness: number;
  /** 過剰供給リトリート感度（0〜1）: 公開供給圧力が高いとき、PD/VAP設備
   *  投資をどの程度強く見送るか（SAI-5F。高い=慎重/逆張り、低い=追随）。 */
  readonly oversupplyRetreatSensitivity: number;
}

const NEUTRAL_MARKET_MULTIPLIERS: Readonly<Record<DemandMarketId, number>> = {
  CN: 1.0,
  US: 1.0,
  EU: 1.0,
  JP: 1.0,
  OTHER: 1.0,
};

const NEUTRAL_PRODUCT_MULTIPLIERS: Readonly<Record<Product, number>> = {
  hoso: 1.0,
  pd: 1.0,
  vap: 1.0,
};

/**
 * 5社の志向プロファイル定義（一箇所集約）。初期試験値は受入済みSAI-5A指示の
 * 倍率表をそのまま採用（BAL=総合バランス型、MASS=中国・大量販売型、
 * JPQ=日本・品質重視型、VAP=米国・加工品型、CONSV=欧州主力の市場対応型）。
 * 勝敗を作るための会社別隠し補正は存在しない（全て0.80〜1.25 / 0.85〜1.20の
 * 小幅な魅力度補正のみ）。
 */
export const COMPANY_ORIENTATION_PROFILES: Readonly<Record<string, CompanyOrientationProfile>> = {
  balancedGeneralist: {
    id: "balancedGeneralist",
    label: "総合・バランス型（BAL）",
    description: "市場・商品を過度に集中させない。現在採算と将来成長の両方を見る。設備投資は中立的。",
    marketMultipliers: NEUTRAL_MARKET_MULTIPLIERS,
    productMultipliers: NEUTRAL_PRODUCT_MULTIPLIERS,
    growthTrendResponsiveness: 0.5,
    oversupplyRetreatSensitivity: 0.5,
  },
  chinaVolume: {
    id: "chinaVolume",
    label: "中国・大量販売型（MASS）",
    description: "HOSOおよび大市場（中国）志向。稼働率と規模を優先し、高加工品への投資は利益機会が明確な場合に追随する。",
    marketMultipliers: { CN: 1.25, US: 0.85, EU: 0.85, JP: 0.8, OTHER: 1.1 },
    productMultipliers: { hoso: 1.2, pd: 0.95, vap: 0.85 },
    growthTrendResponsiveness: 0.3,
    oversupplyRetreatSensitivity: 0.4,
  },
  japanQuality: {
    id: "japanQuality",
    label: "日本・品質重視型（JPQ）",
    description: "日本のPD・VAPを早期から重視。小さい市場でも営業基盤を先行形成し、無理な量的拡大は避ける。",
    marketMultipliers: { CN: 0.8, US: 0.8, EU: 0.9, JP: 1.25, OTHER: 0.9 },
    productMultipliers: { hoso: 0.85, pd: 0.95, vap: 1.2 },
    growthTrendResponsiveness: 0.7,
    oversupplyRetreatSensitivity: 0.6,
  },
  usProcessedGrowth: {
    id: "usProcessedGrowth",
    label: "米国・加工品型（VAP）",
    description: "米国など先行市場のVAP/PDを重視。成長予測に対して積極的に設備投資し、供給過熱局面でも一定期間はVAP能力を維持する。",
    marketMultipliers: { CN: 0.85, US: 1.25, EU: 1.0, JP: 0.95, OTHER: 0.95 },
    productMultipliers: { hoso: 0.85, pd: 1.2, vap: 1.1 },
    growthTrendResponsiveness: 0.9,
    oversupplyRetreatSensitivity: 0.2,
  },
  europePdConservative: {
    id: "europePdConservative",
    label: "欧州主力・保守的PD/HOSO型（CONSV）",
    description: "欧州を主力とし、PD能力を維持しやすい。VAPブームへの追随は遅く、VAP供給過剰時に相対的に恩恵を受け得る。",
    marketMultipliers: { CN: 0.95, US: 1.0, EU: 1.25, JP: 0.85, OTHER: 0.95 },
    productMultipliers: { hoso: 0.95, pd: 1.15, vap: 1.05 },
    growthTrendResponsiveness: 0.2,
    oversupplyRetreatSensitivity: 0.9,
  },
};

/**
 * 会社ID→志向プロファイルの対応表（会社IDによる分岐はここだけ）。
 * 未知の会社IDはbalancedGeneralist（中立）へフォールバックする。
 */
export const COMPANY_ORIENTATION_BY_COMPANY_ID: Readonly<Record<CompanyId, string>> = {
  BAL: "balancedGeneralist",
  MASS: "chinaVolume",
  JPQ: "japanQuality",
  VAP: "usProcessedGrowth",
  CONSV: "europePdConservative",
};

function assertOrientationWithinRange(profile: CompanyOrientationProfile): void {
  for (const [market, m] of Object.entries(profile.marketMultipliers)) {
    if (m < MARKET_ORIENTATION_RANGE.min - 1e-9 || m > MARKET_ORIENTATION_RANGE.max + 1e-9) {
      throw new Error(
        `[orientationProfile] ${profile.id}の市場志向倍率(${market}=${m})が許容範囲` +
          `(${MARKET_ORIENTATION_RANGE.min}〜${MARKET_ORIENTATION_RANGE.max})を超えています。`
      );
    }
  }
  for (const [product, m] of Object.entries(profile.productMultipliers)) {
    if (m < PRODUCT_ORIENTATION_RANGE.min - 1e-9 || m > PRODUCT_ORIENTATION_RANGE.max + 1e-9) {
      throw new Error(
        `[orientationProfile] ${profile.id}の商品志向倍率(${product}=${m})が許容範囲` +
          `(${PRODUCT_ORIENTATION_RANGE.min}〜${PRODUCT_ORIENTATION_RANGE.max})を超えています。`
      );
    }
  }
  for (const g of [profile.growthTrendResponsiveness, profile.oversupplyRetreatSensitivity]) {
    if (g < 0 || g > 1) {
      throw new Error(`[orientationProfile] ${profile.id}の戦略特性(${g})は0〜1である必要があります。`);
    }
  }
}

/** 志向プロファイルをStandardAiParametersへ適用する（純粋関数・決定論的）。 */
export function applyOrientationProfile(
  base: StandardAiParameters,
  profile: CompanyOrientationProfile
): {
  readonly params: StandardAiParameters;
  readonly appliedBiasItems: readonly AppliedManagementBiasItem[];
} {
  assertOrientationWithinRange(profile);
  const appliedBiasItems: AppliedManagementBiasItem[] = [];
  for (const [market, m] of Object.entries(profile.marketMultipliers)) {
    if (m !== 1.0) {
      appliedBiasItems.push({
        field: `marketOrientationMultipliers.${market}`,
        meaning: "市場志向（市場別の魅力度補正）",
        baseValue: 1.0,
        biasedValue: m,
        ratio: m - 1.0,
      });
    }
  }
  for (const [product, m] of Object.entries(profile.productMultipliers)) {
    if (m !== 1.0) {
      appliedBiasItems.push({
        field: `productOrientationMultipliers.${product}`,
        meaning: "商品志向（商品別の魅力度補正）",
        baseValue: 1.0,
        biasedValue: m,
        ratio: m - 1.0,
      });
    }
  }

  const params: StandardAiParameters = {
    ...base,
    marketOrientationMultipliers: profile.marketMultipliers,
    productOrientationMultipliers: profile.productMultipliers,
    growthTrendResponsiveness: profile.growthTrendResponsiveness,
    oversupplyRetreatSensitivity: profile.oversupplyRetreatSensitivity,
  };
  return { params, appliedBiasItems };
}

/** 会社IDから志向プロファイルを解決する（未知IDは中立へフォールバック）。 */
export function resolveOrientationProfile(companyId: CompanyId): CompanyOrientationProfile {
  const id = COMPANY_ORIENTATION_BY_COMPANY_ID[companyId] ?? "balancedGeneralist";
  return COMPANY_ORIENTATION_PROFILES[id];
}

/**
 * SAI-4経営性格プロファイルとSAI-5A志向プロファイルを合成したリゾルバを作る。
 * policy.ts の createStandardAiProvider({ resolveParams }) にそのまま渡せる。
 * - managementProfiles=false / orientation=false の組み合わせで、それぞれの
 *   レイヤーを独立にON/OFFできる（§13EのA/B比較用）。両方falseのリゾルバは
 *   作れない（その場合はresolveParams自体を渡さない=完全な従来経路）。
 * - 適用順: SAI-4性格バイアス→SAI-5A志向→商品戦略プロファイル（strategyProfile.ts）。
 *   志向・商品戦略プロファイルはそれぞれSAI-4が触らない専用フィールド／志向とは
 *   別の追加フィールドだけを書き換えるため、順序による相互作用は限定的
 *   （productOrientationMultipliersだけはSAI-5A確定値の上へ商品戦略プロファイルが
 *   小幅に重ねる。strategyProfile.tsのderiveStrategyProfileParametersを参照）。
 */
export function createSai5ParamsResolver(options: {
  readonly managementProfilesEnabled: boolean;
  readonly orientationEnabled: boolean;
  /** 【SAI-5F】Standard AIの拡張設備投資判断（decision/capex.ts）の有効化。 */
  readonly aiCapexEnabled?: boolean;
  /**
   * 【商品戦略プロファイル・companyLab検証専用】trueの場合のみ、会社IDに応じた
   * 商品戦略プロファイル（strategyProfile.ts）による小幅なStandardAiParameters
   * バイアスを4層目として適用する。未指定(false相当)なら従来どおり
   * （既存の全出力・全テストへの影響ゼロ）。
   */
  readonly strategyProfileEnabled?: boolean;
}): (companyId: CompanyId) => StandardAiParamsResolution {
  return (companyId: CompanyId) => {
    let params: StandardAiParameters = STANDARD_AI_PARAMETERS_V1;
    let profileId = "none";
    const appliedBiasItems: AppliedManagementBiasItem[] = [];

    if (options.managementProfilesEnabled) {
      const m = resolveManagementProfileParameters(companyId, params);
      params = m.params;
      profileId = m.profileId;
      appliedBiasItems.push(...m.appliedBiasItems);
    }
    if (options.orientationEnabled) {
      const profile = resolveOrientationProfile(companyId);
      const o = applyOrientationProfile(params, profile);
      params = o.params;
      profileId = options.managementProfilesEnabled ? `${profileId}+${profile.id}` : profile.id;
      appliedBiasItems.push(...o.appliedBiasItems);
    }
    if (options.aiCapexEnabled) {
      params = { ...params, standardAiCapexExtensionsEnabled: true };
    }
    if (options.strategyProfileEnabled) {
      const s = resolveStrategyProfileParameters(companyId, params);
      params = s.params;
      profileId = profileId === "none" ? s.profileId : `${profileId}+${s.profileId}`;
      appliedBiasItems.push(...s.appliedBiasItems);
    }
    return { params, profileId, appliedBiasItems };
  };
}
