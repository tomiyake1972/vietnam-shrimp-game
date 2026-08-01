// ShrimpX V2 — 商品戦略プロファイル（companyLab検証専用・2026-08-01新規）
//
// 【目的】managementProfile.ts（経営性格）・orientationProfile.ts（市場・商品志向）
// と同じ設計原則で、「会社がどの商品戦略（規模/自動化/差別化）を追求するか」という
// もう1層の会社別バイアスを表現する。標準AIの判断ロジック（policy.ts・
// decision/*.ts）は一切変更せず、会社IDに応じて差し替えるStandardAiParameters
// インスタンスをこのファイルが生成するだけである（managementProfile.tsの
// 冒頭コメント§1・§6の設計方針をそのまま踏襲）。
//
// 【本番非活性・companyLab検証専用】本ファイル自体・STRATEGY_PROFILE_BY_COMPANY_ID
// は、standardAi/orientationProfile.ts の createSai5ParamsResolver に
// strategyProfileEnabled オプションとして追加接続されるだけであり、そのオプションを
// 明示的にtrueで渡さない限り一切参照されない（未指定=false相当なら既存の
// 全出力・全テストへの影響ゼロ）。
//
// 【会社IDによる分岐の集約】会社IDに応じた分岐は、本ファイルの
// STRATEGY_PROFILE_BY_COMPANY_ID という一か所の対応表だけに存在する。
//
// 【capex・投資額の追加提案は別ファイル】能力不足を検知して実際にcapex提案・
// 商品開発投資額を組み立てる処理は、本ファイルの責務外（本ファイルはあくまで
// StandardAiParametersへのバイアスのみを扱う）。実際の提案組み立ては
// companyLab/strategyProfileCapexOverlay.ts・companyLab/strategyProfileInvestmentOverlay.ts
// が担い、そちらは会社が「そのcapex/投資を必要とする戦略プロファイルか」の判定に
// 本ファイルのSTRATEGY_PROFILE_BY_COMPANY_ID・resolveStrategyProfileを再利用する。

import { StandardAiParameters, STANDARD_AI_PARAMETERS_V1 } from "./parameters";
import { CompanyId } from "../../sales/types";
import { Product } from "../../market/types";
import { AppliedManagementBiasItem, MAX_BIAS_RATIO } from "./managementProfile";

/** 商品戦略プロファイルの識別子。4種類固定。 */
export type StrategyProfileId = "BALANCED" | "HOSO_SCALE" | "PD_AUTOMATION" | "VAP_DIFFERENTIATION";

/** capex overlay（companyLab/strategyProfileCapexOverlay.ts）が追加提案してよい
 *  設備投資案件種別のフラグ。プロファイルが要求しない種別は一切提案しない。 */
export interface StrategyProfileCapexOverlayFlags {
  /** PD専用機械化投資（pdMechanization）を追加提案してよいか。 */
  readonly pdMechanization: boolean;
  /** 品質管理設備（qualityControlEquipment）を追加提案してよいか。 */
  readonly qualityControlEquipment: boolean;
}

/** investment overlay（companyLab/strategyProfileInvestmentOverlay.ts）が
 *  四半期ごとの実額投資を計算してよいチャネルのフラグ。 */
export interface StrategyProfileInvestmentOverlayFlags {
  /** VAP商品開発投資（productDevelopmentState.ts）への実額投入を行ってよいか。 */
  readonly vapProductDevelopment: boolean;
}

/**
 * 商品戦略プロファイル1件の定義。managementProfile.tsと同じ「比率バイアス
 * （基準値×(1+ratio)）」「絶対値バイアス（0基準への加算）」の2種類の表現方法を
 * 踏襲する。値の意味・許容範囲はTYPICAL_BIAS_RATIO/MAX_BIAS_RATIOを参照
 * （managementProfile.tsと同じ定数をそのまま再利用し、二重定義しない）。
 */
export interface StrategyProfile {
  readonly id: StrategyProfileId;
  readonly label: string;
  readonly description: string;

  // --- 比率バイアス（基準値 × (1 + ratio)）。0 = バイアスなし。 ---
  /** 販売積極性（salesUtilizationTarget）。規模戦略が能力を積極的に売り切りに行く度合い。 */
  readonly salesAggressivenessRatio: number;
  /** 値引き許容度（maxDiscountRatioForExcessStock）。規模戦略は在庫を抱える余裕があるため
   *  値引きへ頼らない＝負の値を想定。 */
  readonly discountToleranceRatio: number;
  /** 調達構成の輸入依存度（importMixRatio）。安定的な大量調達チャネルの併用度合い。 */
  readonly importRelianceRatio: number;
  /** 商品別志向倍率への追加バイアス（productOrientationMultipliers[product]、既定1.0からの比率）。
   *  orientationProfile.ts（SAI-5A）が既に設定した値の上へさらに小幅に重ねる
   *  （未設定なら1.0を基準値として扱う。orientationProfile.tsのNEUTRAL値と同じ規約）。 */
  readonly productOrientationBiasRatioByProduct: Readonly<Partial<Record<Product, number>>>;
  /** 設備投資しきい値バイアス（capexShortfallThresholdBiasByProduct[product]、絶対値加算）。
   *  正の値＝そのぶんしきい値を下げ、増設判断を早める。 */
  readonly capexShortfallThresholdBiasByProductAbsolute: Readonly<Partial<Record<Product, number>>>;
  /** 高付加価値(PD/VAP)受注選好への絶対値加算（valueAddedOrderFactorBoost）。 */
  readonly valueAddedPreferenceAbsolute: number;

  /** このプロファイルが要求するcapex overlay種別（既定は両方false）。 */
  readonly capexOverlay: StrategyProfileCapexOverlayFlags;
  /** このプロファイルが要求するinvestment overlayチャネル（既定は全false）。 */
  readonly investmentOverlay: StrategyProfileInvestmentOverlayFlags;
}

const VALUE_ADDED_PREFERENCE_REFERENCE_SCALE = 1.0;
const CAPEX_SHORTFALL_BIAS_REFERENCE_SCALE = STANDARD_AI_PARAMETERS_V1.capexCurrentShortfallRatioThreshold;
const PRODUCT_ORIENTATION_BIAS_REFERENCE_SCALE = 1.0;

function assertWithinRatioBound(field: string, ratio: number): void {
  if (Math.abs(ratio) > MAX_BIAS_RATIO + 1e-9) {
    throw new Error(
      `[strategyProfile] ${field}のバイアス比率(${ratio})が許容範囲(±${MAX_BIAS_RATIO})を超えています。実装指示（小幅なプロファイル差）違反のため修正してください。`
    );
  }
}

function assertWithinAbsoluteBound(field: string, absoluteDelta: number, referenceScale: number): void {
  const ratioEquivalent = absoluteDelta / referenceScale;
  if (Math.abs(ratioEquivalent) > MAX_BIAS_RATIO + 1e-9) {
    throw new Error(
      `[strategyProfile] ${field}の絶対値バイアス(${absoluteDelta})が参照基準(${referenceScale})に対して` +
        `許容範囲(±${MAX_BIAS_RATIO}相当)を超えています。`
    );
  }
}

const NO_CAPEX_OVERLAY: StrategyProfileCapexOverlayFlags = { pdMechanization: false, qualityControlEquipment: false };
const NO_INVESTMENT_OVERLAY: StrategyProfileInvestmentOverlayFlags = { vapProductDevelopment: false };

const ZERO_PROFILE_BIASES: Omit<StrategyProfile, "id" | "label" | "description" | "capexOverlay" | "investmentOverlay"> = {
  salesAggressivenessRatio: 0,
  discountToleranceRatio: 0,
  importRelianceRatio: 0,
  productOrientationBiasRatioByProduct: {},
  capexShortfallThresholdBiasByProductAbsolute: {},
  valueAddedPreferenceAbsolute: 0,
};

/**
 * 4プロファイルの定義一覧（一か所に集約。managementProfile.ts/orientationProfile.ts
 * と同じ設計原則）。
 */
export const STRATEGY_PROFILES: Readonly<Record<StrategyProfileId, StrategyProfile>> = {
  // 中立プロファイル。strategyProfilesEnabled有効時でも、STANDARD_AI_PARAMETERS_V1と
  // 完全に同一の判断になることを自動テストで保証する。
  BALANCED: {
    id: "BALANCED",
    label: "バランス型（商品戦略バイアスなし）",
    description: "商品戦略プロファイルによるバイアスなし。STANDARD_AI_PARAMETERS_V1（および他レイヤーの結果）をそのまま使用する。",
    ...ZERO_PROFILE_BIASES,
    capexOverlay: NO_CAPEX_OVERLAY,
    investmentOverlay: NO_INVESTMENT_OVERLAY,
  },
  // HOSO規模戦略。稼働率・大量安定調達を志向し、在庫を抱える余裕があるため
  // 値引きには頼らない。既存の調達規模効果（procurementScaleState.ts、
  // trailing-4四半期の調達量→割引・関係スコア）がすでに「継続的な大量調達」の
  // 蓄積効果を担うため、ここでは新規の$投資チャネルは作らず、行動の重み付けだけを
  // HOSO規模の維持・拡大へ寄せる。
  HOSO_SCALE: {
    id: "HOSO_SCALE",
    label: "HOSO規模戦略型",
    description:
      "HOSOの稼働率・大量安定調達を重視する商品戦略。販売積極性・輸入依存度をやや高め（+5%）、" +
      "値引き許容度をやや低め（-5%、在庫を抱える余裕がある分、値引きに頼らない）、" +
      "HOSO商品志向倍率を+5%、HOSO設備投資しきい値をわずかに前倒しする。" +
      "既存の調達規模効果（procurementScaleState.ts）が継続的な大量調達の蓄積を担うため、" +
      "新規の$投資チャネルは追加しない（investment overlayは常に無効）。",
    ...ZERO_PROFILE_BIASES,
    salesAggressivenessRatio: 0.05,
    discountToleranceRatio: -0.05,
    importRelianceRatio: 0.05,
    productOrientationBiasRatioByProduct: { hoso: 0.05 },
    capexShortfallThresholdBiasByProductAbsolute: { hoso: 0.03 },
    capexOverlay: NO_CAPEX_OVERLAY,
    investmentOverlay: NO_INVESTMENT_OVERLAY,
  },
  // PD自動化戦略。PD商品志向・PD設備投資判断の前倒しに加え、既存のdecision/capex.tsが
  // 一切提案しないpdMechanization案件を、companyLab/strategyProfileCapexOverlay.tsが
  // 別枠で追加提案する（PD専用の省人化投資）。HOSO/VAPへの能力・志向ブーストは
  // 一切与えない。
  // 【2026-08-01調整】当初のproductOrientationBiasRatioByProduct.pd=0.05は、
  // 4環境×6seed×32Qの実測検証で、唯一実効していたバイアス項目（capex overlay・
  // capexShortfallThresholdBiasByProductAbsoluteはいずれも会社全体設備稼働率が
  // 32Q・全環境を通じてしきい値0.92に遠く届かず不発）であり、単独でJPQに
  // 全環境フラットな+$2.7-3.0Mの優位（NORMALで6seed中5seed首位）をもたらして
  // いたことが判明した。原因はPDの基準単価あたり貢献利益がHOSOより構造的に
  // 高いこと（実測: 基準ケースでHOSO ~$658/t・PD ~$1,356/t）で、志向バイアスに
  // よる生産構成のPDシフトが、環境（タイルウィンド）に関係なく一律の利益押上げ
  // として効いてしまうため。0.05→0.03へ縮小し、NORMALでの一律優位を弱める一方、
  // strategyProfileCapexOverlay.tsのトリガー訂正（PD固有稼働率ベースに変更）に
  // より、需要が伸びた四半期・環境でのみ間欠的に発火するpdMechanization効果の
  // 相対的な寄与を高め、環境非依存の一律優位から環境連動の優位へ比重を移す。
  PD_AUTOMATION: {
    id: "PD_AUTOMATION",
    label: "PD自動化戦略型",
    description:
      "PDの省人化・自動化投資を重視する商品戦略。PD商品志向倍率を+3%（2026-08-01調整、" +
      "旧+5%から縮小）、PD設備投資しきい値を前倒し（+8%相当）し、既存Standard AIが" +
      "提案しないpdMechanization案件をcapex overlay経由で追加提案する" +
      "（トリガーはPD固有の前期稼働率、2026-08-01訂正）。HOSO・VAPへの志向・能力" +
      "バイアスは一切与えない。",
    ...ZERO_PROFILE_BIASES,
    productOrientationBiasRatioByProduct: { pd: 0.015 },
    capexShortfallThresholdBiasByProductAbsolute: { pd: 0.08 },
    capexOverlay: { pdMechanization: true, qualityControlEquipment: false },
    investmentOverlay: NO_INVESTMENT_OVERLAY,
  },
  // VAP差別化戦略。VAP商品志向・高付加価値受注選好に加え、既存Standard AIが
  // 提案しないqualityControlEquipment案件をcapex overlay経由で追加提案し、
  // productDevelopmentState.ts（VAP商品開発力）へ実額のR&D投資をinvestment overlay
  // 経由で供給する（premiumPolicy.tsのVAP能力係数メカニズムに実際の蓄積材料を
  // 与えるため）。
  // 【2026-08-01調整】4環境×6seed×32Qの実測検証で、VAP_DIFFERENTIATION(VAP社)が
  // 4環境すべてで環境平均を下回る（特に自社タイルウィンドのVAP_TAILWINDを含む）
  // という逆転が確認された。投資overlayの固定コストが効果の薄いメカニズムに
  // 費やされていたことに加え（investmentOverlay側の調整コメント参照）、
  // productOrientationBiasRatioByProduct.vapが他戦略（PD_AUTOMATION）と同じ+5%に
  // 据え置かれていたが、VAPの基準単価あたり貢献利益はHOSO/PDよりさらに高い
  // （実測: 基準ケースでHOSO ~$658/t・PD ~$1,356/t・VAP ~$2,805-4,143/t）ため、
  // 同じ+5%のシフトでも他戦略よりも金額的な押上げ効果が小さく出ていた
  // （production/labor.tsの営業工数制約・完成品在庫制約により、VAPは元々
  // HOSO/PDほど大きく生産量を積み増せない）。投資overlayのコスト縮小と
  // 合わせ、志向バイアスを+7%へ引き上げ、投資の重荷を減らしつつ実効性のある
  // （生産構成シフトによる）押上げの比重を高める。
  VAP_DIFFERENTIATION: {
    id: "VAP_DIFFERENTIATION",
    label: "VAP差別化戦略型",
    description:
      "VAPの差別化（品質・商品開発）を重視する商品戦略。VAP商品志向倍率を+7%（2026-08-01調整、" +
      "旧+5%から引き上げ）、高付加価値受注選好を+0.05、既存Standard AIが提案しない" +
      "qualityControlEquipment案件をcapex overlay経由で追加提案し（トリガーはVAP固有の" +
      "前期稼働率、2026-08-01訂正）、productDevelopmentState.ts（VAP商品開発力）へ" +
      "実額のR&D投資をinvestment overlay経由で供給する（投資額は2026-08-01調整で" +
      "標準予算の0.5倍へ縮小、strategyProfileInvestmentOverlay.ts参照）。",
    ...ZERO_PROFILE_BIASES,
    productOrientationBiasRatioByProduct: { vap: 0.07 },
    valueAddedPreferenceAbsolute: 0.05,
    capexOverlay: { pdMechanization: false, qualityControlEquipment: true },
    investmentOverlay: { vapProductDevelopment: true },
  },
};

/**
 * 会社ID→商品戦略プロファイルの対応表（会社IDによる分岐はここだけ）。
 * 【検証ハーネス専用】4環境シミュレーション検証で必要な組み合わせのみを
 * カバーする（5社全員を独自の戦略プロファイルへ割り当てる必要はない）。
 * BAL=中立基準、MASS=HOSO規模型、JPQ=PD自動化型（会社IDラベルの意味上の
 * 由来は引き継がない。単なるラベル再利用。managementProfile.tsのJPQ扱いと
 * 同じ方針）、VAP=VAP差別化型（会社IDラベルの意味と一致）、CONSV=中立基準
 * （本検証タスクでは専用の戦略プロファイルを割り当てない）。
 */
export const STRATEGY_PROFILE_BY_COMPANY_ID: Readonly<Record<string, StrategyProfileId>> = {
  BAL: "BALANCED",
  MASS: "HOSO_SCALE",
  JPQ: "PD_AUTOMATION",
  VAP: "VAP_DIFFERENTIATION",
  CONSV: "BALANCED",
};

/**
 * プロファイルの比率/絶対値バイアスを、指定した基準パラメータ(base)に適用し、
 * 派生StandardAiParametersと、適用したバイアス項目一覧を返す（純粋関数・決定論）。
 */
export function deriveStrategyProfileParameters(
  base: StandardAiParameters,
  profile: StrategyProfile
): {
  readonly params: StandardAiParameters;
  readonly appliedBiasItems: readonly AppliedManagementBiasItem[];
} {
  const appliedBiasItems: AppliedManagementBiasItem[] = [];

  const applyRatio = (field: string, meaning: string, baseValue: number, ratio: number): number => {
    assertWithinRatioBound(field, ratio);
    const biasedValue = baseValue * (1 + ratio);
    if (ratio !== 0) {
      appliedBiasItems.push({ field, meaning, baseValue, biasedValue, ratio });
    }
    return biasedValue;
  };

  const applyAbsolute = (field: string, meaning: string, baseValue: number, absoluteDelta: number, referenceScale: number): number => {
    assertWithinAbsoluteBound(field, absoluteDelta, referenceScale);
    const biasedValue = baseValue + absoluteDelta;
    if (absoluteDelta !== 0) {
      appliedBiasItems.push({ field, meaning, baseValue, biasedValue, absoluteDelta });
    }
    return biasedValue;
  };

  const salesUtilizationTarget = applyRatio(
    "salesUtilizationTarget",
    "販売積極性（商品戦略プロファイル）",
    base.salesUtilizationTarget,
    profile.salesAggressivenessRatio
  );
  const maxDiscountRatioForExcessStock = applyRatio(
    "maxDiscountRatioForExcessStock",
    "値引き許容度（商品戦略プロファイル）",
    base.maxDiscountRatioForExcessStock,
    profile.discountToleranceRatio
  );
  const importMixRatio = applyRatio(
    "importMixRatio",
    "調達構成の輸入依存度（商品戦略プロファイル）",
    base.importMixRatio,
    profile.importRelianceRatio
  );
  const valueAddedOrderFactorBoost = applyAbsolute(
    "valueAddedOrderFactorBoost",
    "高付加価値(PD/VAP)受注選好（商品戦略プロファイル）",
    base.valueAddedOrderFactorBoost,
    profile.valueAddedPreferenceAbsolute,
    VALUE_ADDED_PREFERENCE_REFERENCE_SCALE
  );

  // 【重要】managementProfile.tsと同じ規約: バイアスが0の商品は、baseの
  // 該当キーを一切書き換えない（{}のままにする）。0を明示的に書き込むと
  // BALANCEDでも構造的に基準値と異なるオブジェクトになり、deepEqual保証が崩れる。
  const products: readonly Product[] = ["hoso", "pd", "vap"];

  const productOrientationMultipliers: Partial<Record<Product, number>> = { ...base.productOrientationMultipliers };
  for (const product of products) {
    const ratio = profile.productOrientationBiasRatioByProduct[product] ?? 0;
    if (ratio === 0) continue;
    const baseValue = base.productOrientationMultipliers[product] ?? PRODUCT_ORIENTATION_BIAS_REFERENCE_SCALE;
    productOrientationMultipliers[product] = applyRatio(`productOrientationMultipliers.${product}`, "商品志向（商品戦略プロファイル追加バイアス）", baseValue, ratio);
  }

  const capexShortfallThresholdBiasByProduct: Partial<Record<Product, number>> = { ...base.capexShortfallThresholdBiasByProduct };
  for (const product of products) {
    const absoluteDelta = profile.capexShortfallThresholdBiasByProductAbsolute[product] ?? 0;
    if (absoluteDelta === 0) continue;
    const baseProductBias = base.capexShortfallThresholdBiasByProduct[product] ?? 0;
    capexShortfallThresholdBiasByProduct[product] = applyAbsolute(
      `capexShortfallThresholdBiasByProduct.${product}`,
      "設備投資判断の前倒し度合い（商品戦略プロファイル）",
      baseProductBias,
      absoluteDelta,
      CAPEX_SHORTFALL_BIAS_REFERENCE_SCALE
    );
  }

  const params: StandardAiParameters = {
    ...base,
    salesUtilizationTarget,
    maxDiscountRatioForExcessStock,
    importMixRatio,
    valueAddedOrderFactorBoost,
    productOrientationMultipliers,
    capexShortfallThresholdBiasByProduct,
  };

  return { params, appliedBiasItems };
}

/** 会社IDから商品戦略プロファイルを解決する（未知IDはBALANCEDへフォールバック）。 */
export function resolveStrategyProfile(companyId: CompanyId): StrategyProfile {
  const id = STRATEGY_PROFILE_BY_COMPANY_ID[companyId] ?? "BALANCED";
  return STRATEGY_PROFILES[id];
}

/**
 * 会社IDから、商品戦略プロファイル適用後のStandardAiParametersを直接解決する
 * ヘルパー（他レイヤーと合成する場合はbaseへ前段の結果を渡すこと）。
 */
export function resolveStrategyProfileParameters(
  companyId: CompanyId,
  base: StandardAiParameters = STANDARD_AI_PARAMETERS_V1
): {
  readonly profileId: StrategyProfileId;
  readonly profile: StrategyProfile;
  readonly params: StandardAiParameters;
  readonly appliedBiasItems: readonly AppliedManagementBiasItem[];
} {
  const profile = resolveStrategyProfile(companyId);
  const { params, appliedBiasItems } = deriveStrategyProfileParameters(base, profile);
  return { profileId: profile.id, profile, params, appliedBiasItems };
}
