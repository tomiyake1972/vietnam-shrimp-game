// ShrimpX V2 — 2026-08-04 Business Scale Profile 診断モジュール（診断専用）
//
// 【目的】Standard AIが毎期Sales/Production/Procurement/Labor/Finance/Capexを
// 個別に決める前段として、「この会社は現在どの程度の事業規模を支えられる会社
// なのか」を、Sales/Production/Labor/RawMaterial/Financeの5軸で構造化して見せる。
//
// 【重要な非目標】Business Scale = min(5軸) のような単一値へは絶対に潰さない
// （三宅さんの指示。Phase C「価格が高い＝営業を増やす価値が高い、と同義にしない」
// と同じ精神を、事業規模診断にも適用する）。本モジュールが出すのは「現在の会社の
// 体力の構造化された見え方」までであり、「Growthを選ぶべき」等の評価・意思決定は
// 一切行わない（Scenario評価・Mission/Vision接続は将来のモジュールの責務）。
//
// 【診断専用・本番未接続】decision/*.ts のいずれからも本モジュールをimportしない。
// 本番Standard AIのsales/production/procurement/labor/financing/capex決定は
// 一切変更していない（テストで構造的に確認する）。
//
// 【既存ロジックの再利用（新しい能力式・労務式・需要式は作らない）】
//   - production/labor.ts requiredHeadcountForQuantity（既存の逆算関数そのもの）
//   - shadowSalesAllocation.ts buildShadowSalesAllocationComparison（既存のvolume-oriented
//     shadow。営業人員の飽和特性そのままの「今の人員で達成できる上限」として転用）
//   - financialCapacity.ts buildStandardAiFinancialCapacity（既存の現金橋渡し計算。
//     規模→現金という向きの既存関数へ、二分探索の純粋関数ラッパーを1枚被せるだけ）
//   - observation.totalEffectiveCapacityByProduct / totalEffectiveCommonProcessingCapacity /
//     totalEffectiveFreezingPackagingCapacity（能力認識監査Phase 3で確定した実効値）
//   - observation.rawMaterialAvailable / rawMaterialCertainInboundThisPeriod /
//     vietnamDomesticPriorMarket.unsoldSupply（既存observation、新しい原料ルールは作らない）

import { Product } from "../../../market/types";
import { requiredHeadcountForQuantity } from "../../../production/labor";
import { PRODUCTION_PARAMETERS_V1 } from "../../../production/parameters";
import { ProductAmount, StandardAiObservation, sumProductAmount, zeroProductAmount } from "../types";
import { PressureScores } from "../pressures";
import { CompanySalesPlanEntry } from "../../../sales/types";
import { buildShadowSalesAllocationComparison } from "./shadowSalesAllocation";
import { StandardAiUnitEconomicsResult } from "./forwardUnitEconomics";
import {
  buildStandardAiFinancialCapacity,
  StandardAiFinancialCapacityPlanInput,
  zeroFinancialCapacityPlan,
} from "./financialCapacity";

const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

export type BusinessScaleAxis = "sales" | "production" | "labor" | "rawMaterial" | "finance";

export type ScaleConfidence = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

/**
 * 制約の時間軸。新しいリードタイム規則は発明せず、既存のゲームルールから
 * そのまま読み取れる区分だけを使う（labor.ts の regularHeadcountAdjustmentDamping、
 * sales.ts の営業人員調整、capex/parameters.ts の standardConstructionQuarters +
 * postCompletionReadinessQuarters）。
 */
export type ConstraintFlexibility =
  | "HARD_CURRENT_PERIOD"
  | "ADJUSTABLE_NEXT_PERIOD"
  | "EXPANDABLE_WITH_CAPEX"
  | "EXPANDABLE_WITH_FINANCING"
  | "UNCERTAIN";

export interface ExpansionOption {
  readonly flexibility: ConstraintFlexibility;
  /** 既存ルールから取得できる場合のみ数値。取得できない場合はnull（憶測しない）。 */
  readonly leadTimeQuarters: number | null;
  readonly description: string;
}

/** 1軸ぶんの、事業規模診断結果。 */
export interface SupportedScaleEstimate {
  readonly axis: BusinessScaleAxis;
  /** 合理的に求められる場合のみ数値。求められない場合は必ずnull（勝手な推計で埋めない）。 */
  readonly supportedScaleTons: number | null;
  readonly confidence: ScaleConfidence;
  readonly limitingReason: string;
  readonly constraintFlexibility: ConstraintFlexibility;
  readonly expansionOptions: readonly ExpansionOption[];
  /** どのobservation/診断から算定したかの由来。 */
  readonly source: string;
  readonly dataQuality: {
    readonly note: string;
    readonly knownGaps: readonly string[];
  };
}

/** Sales軸専用の詳細分解（三宅さんの指示§3: 営業容量ベースの上限と、需要ベースの上限を混同しない）。 */
export interface SalesSupportedScaleDetail {
  /** 現在の営業人員数を、Shadow Allocation（volume-oriented）で最適配分した場合の上限トン数。
   *  営業人員の飽和特性のみに基づく上限であり、需要規模には一切依存しない。 */
  readonly salesForceSupportedScaleTons: number;
  /** 会社全体の商品別理論上限（decision/sales.tsのdesiredByProduct、診断専用の理論値）と
   *  salesForceSupportedScaleTonsのうち小さい方。「現在の観測情報だけで言える上限」であり、
   *  真の市場需要ではない（三宅さんの指示: desiredByProductを需要として扱わない）。 */
  readonly currentObservableCeilingTons: number;
  /** 市場別絶対需要は観測構造上存在しないため常にnull（Phase F-4で確定分類済み）。 */
  readonly demandSupportedScaleTons: null;
  /** true固定。「需要に上限があるかどうか自体が分からない」ことを明示するフラグ。 */
  readonly demandCeilingUnknown: true;
}

/** Production軸専用の詳細分解（三宅さんの指示§4: 商品別能力単純合計ではなく、共有ボトルネックを反映）。 */
export interface ProductionSupportedScaleDetail {
  /** 参考情報用の名目能力合計（supported scaleには使わない）。 */
  readonly nominalCapacityTonsByProduct: ProductAmount;
  /** supported scale算定に使った商品ミックス前提（比率、合計1）。 */
  readonly productMixAssumption: ProductAmount;
  /** 商品ミックス前提のもとで、共通前処理・凍結包装・商品別専用ラインの
   *  いずれか最も厳しい制約から導いた、実際に同時に効くsupported scale。 */
  readonly sharedBottleneckSupportedScaleTons: number;
  /** どの制約が現在bindingか（"commonProcessing" | "freezingPackaging" | Product）。 */
  readonly bindingConstraint: "commonProcessing" | "freezingPackaging" | Product;
  readonly mixSensitivityNote: string;
}

/** RawMaterial軸専用の詳細分解（三宅さんの指示§6: 市場全体の余剰と会社固有調達能力を分離）。 */
/**
 * 【2026-08-04修正】三宅さんの指摘: ShrimpXは原料在庫を大量に持つ会社ではなく、
 * 毎期市場から購入して加工する運転資金型ビジネスモデルである。したがって
 * 「期首在庫＋当期確実な入荷」だけをRaw-supported scaleとして使うと、正常な
 * 会社でも毎期0近辺になり、「保守的な推計」ではなく「Business Scaleの意味と
 * ずれた」誤解を招く。「分からない」（companyPurchasableScaleTons=unknown）と
 * 「0tしかできない」は明確に区別する。
 */
export interface RawMaterialSupportedScaleDetail {
  /** 期首在庫＋当期確実な入荷（既存observationの値をそのまま合算。新しい調達ルールは
   *  作らない）。これは「今すぐ手元にある確実な量」であり、Raw-supported scale
   *  そのものではない（会社は毎期新規購入で追加調達するため）。 */
  readonly securedRawScaleTons: number;
  /** 他4軸（sales/production/labor/finance）のうち最も厳しい制約の規模に対して、
   *  securedRawScaleTonsだけでは足りない差分（=今期あと何トン調達できれば
   *  他の制約と同水準まで到達するか）。他4軸がいずれもnull（算定不能）ならnull。 */
  readonly procurementNeededScaleTons: number | null;
  /** 市場全体（会社を問わない）の前期公開清算結果からみた、原料調達環境の状態。
   *  既存のvietnamDomesticPriorMarket.unsoldSupplyをそのまま参照する軽量な信号
   *  （situationDiagnosis.tsのDOMESTIC_MARKET_PUBLIC_SURPLUS/TIGHT判定とは
   *  独立した、本モジュール専用の単純化版。新しい市場ルールは作っていない）。
   *  turn1等で前期市場結果が無い場合はUNKNOWN。 */
  readonly publicMarketAvailabilityState: "SURPLUS" | "TIGHT" | "UNKNOWN";
  /** 会社固有の国内購入可能上限。恒常的にnull（観測に存在しないため憶測しない。
   *  「市場に10万t余っているから自社が14,000t買える」という推論は禁止）。 */
  readonly companyPurchasableScaleTons: null;
}

/** Finance軸専用の詳細分解（三宅さんの指示§7: cash negativeとbelow-target-bufferを区別）。 */
export interface FinanceSupportedScaleDetail {
  /** 目標最低現金バッファを割らない範囲で支えられる事業規模（トン、二分探索）。 */
  readonly supportedScaleTonsWithinTargetBuffer: number;
  /** 現金そのものがマイナスにならない範囲で支えられる事業規模（トン、二分探索。
   *  supportedScaleTonsWithinTargetBufferより大きいか等しいはず）。 */
  readonly supportedScaleTonsBeforeCashNegative: number;
  /** 追加借入可能額。未配線（Phase F-9で分類済みの配線ギャップ）ならnull（近似しない）。 */
  readonly availableBorrowingHeadroomUsd: number | null;
  /** 二分探索に使った商品ミックス・調達前提（結果は前提依存であることを明示）。 */
  readonly assumptionNote: string;
}

export interface BusinessScaleProfile {
  readonly companyId: string;
  readonly period: string;
  readonly axes: readonly SupportedScaleEstimate[];
  readonly salesDetail: SalesSupportedScaleDetail;
  readonly productionDetail: ProductionSupportedScaleDetail;
  readonly rawMaterialDetail: RawMaterialSupportedScaleDetail;
  readonly financeDetail: FinanceSupportedScaleDetail;
}

// ---------------------------------------------------------------------
// Sales-supported scale
// ---------------------------------------------------------------------

function buildSalesSupportedScale(
  observation: StandardAiObservation,
  unitEconomics: StandardAiUnitEconomicsResult,
  currentSalesPlans: readonly CompanySalesPlanEntry[],
  desiredByProduct: ProductAmount
): { estimate: SupportedScaleEstimate; detail: SalesSupportedScaleDetail } {
  const shadow = buildShadowSalesAllocationComparison(observation, unitEconomics, desiredByProduct, currentSalesPlans);
  const salesForceSupportedScaleTons = shadow.volumeOriented.marketSummaries.reduce(
    (sum, m) => sum + m.shadowRealisticSalesTons,
    0
  );
  const desiredTotal = sumProductAmount(desiredByProduct);
  const currentObservableCeilingTons = Math.min(salesForceSupportedScaleTons, desiredTotal);

  const detail: SalesSupportedScaleDetail = {
    salesForceSupportedScaleTons,
    currentObservableCeilingTons,
    demandSupportedScaleTons: null,
    demandCeilingUnknown: true,
  };

  const estimate: SupportedScaleEstimate = {
    axis: "sales",
    // 【確信度を落とす】現在の観測情報だけで言える上限はcurrentObservableCeilingTonsだが、
    // これは真の市場需要ではないため、confidenceをMEDIUMに留める（HIGHにしない）。
    supportedScaleTons: currentObservableCeilingTons,
    confidence: "MEDIUM",
    limitingReason:
      "営業人員の飽和特性（Shadow Allocation, volume-oriented）と会社全体の商品別理論上限(desiredByProduct)の" +
      "小さい方。市場別絶対需要が観測構造上存在しないため（Phase F-4で確定分類）、真の需要上限ではない。",
    constraintFlexibility: "ADJUSTABLE_NEXT_PERIOD",
    expansionOptions: [
      {
        flexibility: "ADJUSTABLE_NEXT_PERIOD",
        leadTimeQuarters: 1,
        description: "営業人員の追加採用（既存のregularHeadcountAdjustmentDamping相当の漸進的調整）。",
      },
      {
        flexibility: "UNCERTAIN",
        leadTimeQuarters: null,
        description: "市場別絶対需要が観測不能なため、需要側の拡張余地自体が不明（#04確認事項）。",
      },
    ],
    source: "shadowSalesAllocation.ts(volume-oriented) + decision/sales.ts(desiredByProduct)",
    dataQuality: {
      note: "desiredByProductは診断専用の理論上限であり需要ではない。市場別絶対需要は観測構造上存在しない。",
      knownGaps: ["market absolute demand not observable (Phase F-4: engine computes it but does not expose it)"],
    },
  };

  return { estimate, detail };
}

// ---------------------------------------------------------------------
// Production-supported scale
// ---------------------------------------------------------------------

function buildProductionSupportedScale(
  observation: StandardAiObservation,
  productMixAssumption: ProductAmount
): { estimate: SupportedScaleEstimate; detail: ProductionSupportedScaleDetail } {
  const mixTotal = sumProductAmount(productMixAssumption);
  const mix: ProductAmount =
    mixTotal > 1e-9
      ? {
          hoso: productMixAssumption.hoso / mixTotal,
          pd: productMixAssumption.pd / mixTotal,
          vap: productMixAssumption.vap / mixTotal,
        }
      : { hoso: 1 / 3, pd: 1 / 3, vap: 1 / 3 };

  const candidates: { key: "commonProcessing" | "freezingPackaging" | Product; scaleTons: number }[] = [];
  candidates.push({ key: "commonProcessing", scaleTons: observation.totalEffectiveCommonProcessingCapacity });
  candidates.push({ key: "freezingPackaging", scaleTons: observation.totalEffectiveFreezingPackagingCapacity });
  for (const p of PRODUCTS) {
    if (mix[p] > 1e-9) {
      candidates.push({ key: p, scaleTons: observation.totalEffectiveCapacityByProduct[p] / mix[p] });
    }
  }
  const binding = candidates.reduce((min, c) => (c.scaleTons < min.scaleTons ? c : min));

  const detail: ProductionSupportedScaleDetail = {
    nominalCapacityTonsByProduct: observation.totalCapacityByProduct,
    productMixAssumption: mix,
    sharedBottleneckSupportedScaleTons: binding.scaleTons,
    bindingConstraint: binding.key,
    mixSensitivityNote:
      "この上限は指定した商品ミックス前提のもとでのみ成立する。ミックスが変わればsupported scaleも変わる" +
      "（例: HOSO比率を下げればHOSO専用ラインの制約は緩むが、他の商品専用ラインが新たにbindingになりうる）。",
  };

  const estimate: SupportedScaleEstimate = {
    axis: "production",
    supportedScaleTons: binding.scaleTons,
    confidence: "HIGH",
    limitingReason: `商品ミックス前提のもとで、${binding.key}の実効能力が最も厳しい制約（他の専用ライン・共有プールより先にbindingになる）。`,
    constraintFlexibility: "EXPANDABLE_WITH_CAPEX",
    expansionOptions: [
      {
        flexibility: "EXPANDABLE_WITH_CAPEX",
        leadTimeQuarters: null,
        description:
          "capex/parameters.tsの各テンプレート（standardConstructionQuarters + postCompletionReadinessQuarters）に" +
          "応じて拡張可能。具体的な四半期数は対象テンプレートにより異なる（HOSO/PD/VAP専用ライン・共通前処理・凍結包装で個別）。",
      },
    ],
    source: "observation.totalEffectiveCapacityByProduct / totalEffectiveCommonProcessingCapacity / totalEffectiveFreezingPackagingCapacity（実効値）",
    dataQuality: {
      note: "名目能力(totalCapacityByProduct)はsupported scaleに使っていない（実効値のみ使用）。",
      knownGaps: [],
    },
  };

  return { estimate, detail };
}

// ---------------------------------------------------------------------
// Labor-supported scale
// ---------------------------------------------------------------------

function buildLaborSupportedScale(
  observation: StandardAiObservation,
  productMixAssumption: ProductAmount
): SupportedScaleEstimate {
  const mixTotal = sumProductAmount(productMixAssumption);
  const mix: ProductAmount =
    mixTotal > 1e-9
      ? {
          hoso: productMixAssumption.hoso / mixTotal,
          pd: productMixAssumption.pd / mixTotal,
          vap: productMixAssumption.vap / mixTotal,
        }
      : { hoso: 1 / 3, pd: 1 / 3, vap: 1 / 3 };

  // 【既存の逆算関数をそのまま使う】requiredHeadcountForQuantity(1トン, ...)で
  // 「1トンあたり必要な正社員人数」を商品ごとに求め、ミックス前提のもとでの
  // 加重合計で会社全体の正社員人数から逆算する。新しい労務式は作っていない。
  let weightedHeadcountPerTon = 0;
  let missingSkillCount = 0;
  for (const factory of observation.factories) {
    for (const p of PRODUCTS) {
      if (mix[p] <= 1e-9) continue;
      const headcountPerTon = requiredHeadcountForQuantity(
        1,
        PRODUCTION_PARAMETERS_V1.labor.regularEfficiencyPerHeadTons,
        factory.attendanceRate,
        factory.skillByProduct[p],
        0
      );
      if (headcountPerTon <= 0) {
        missingSkillCount += 1;
        continue;
      }
      weightedHeadcountPerTon += mix[p] * headcountPerTon;
    }
  }

  const totalRegularHeadcount = observation.regularHeadcountTotal;
  const supportedScaleTons =
    weightedHeadcountPerTon > 0 ? totalRegularHeadcount / weightedHeadcountPerTon : 0;

  return {
    axis: "labor",
    supportedScaleTons,
    confidence: missingSkillCount > 0 ? "LOW" : "HIGH",
    limitingReason:
      "現行V2の正式Worker式（production/labor.ts、regularEfficiencyPerHeadTons×attendanceRate×skillLevel）を" +
      "そのまま使用。ゲームルール上の上限であり、Workerパラメータの現実性（#04 pending、VAPの労務集約度が" +
      "過小評価の可能性）とは別の話として扱う。",
    constraintFlexibility: "ADJUSTABLE_NEXT_PERIOD",
    expansionOptions: [
      {
        flexibility: "ADJUSTABLE_NEXT_PERIOD",
        leadTimeQuarters: 1,
        description: "正社員採用（regularHeadcountAdjustmentDamping相当の漸進的調整）。臨時ワーカー・残業は当期内でも一部拡張可能。",
      },
    ],
    source: "production/labor.ts requiredHeadcountForQuantity + observation.factories[].skillByProduct/attendanceRate",
    dataQuality: {
      note:
        "ゲームルール上のLabor-supported scale（=現行V2 Worker式による値）。VAPの必要人数がWorker Model比較" +
        "文書（WORKER_MODEL_COMPARISON_FOR_04.md）で指摘した現実性の疑問（#04 pending）とは別軸の値であり、混同しない。",
      knownGaps: missingSkillCount > 0 ? ["skillLevel=0 for one or more products; supported scale may be underestimated for that product"] : [],
    },
  };
}

// ---------------------------------------------------------------------
// Raw-material-supported scale
// ---------------------------------------------------------------------

function buildRawMaterialSupportedScale(
  observation: StandardAiObservation,
  /** 他4軸（sales/production/labor/finance）のうち最も厳しい制約の規模。
   *  procurementNeededScaleTonsの算定にのみ使用する（診断専用の参考値であり、
   *  この値自体をRaw軸のsupportedScaleTonsとして扱わない）。 */
  otherAxesMinScaleTons: number | null
): { estimate: SupportedScaleEstimate; detail: RawMaterialSupportedScaleDetail } {
  const securedRawScaleTons = observation.rawMaterialAvailable + observation.rawMaterialCertainInboundThisPeriod;
  const priorMarket = observation.vietnamDomesticPriorMarket;
  const publicMarketAvailabilityState: RawMaterialSupportedScaleDetail["publicMarketAvailabilityState"] =
    priorMarket === undefined ? "UNKNOWN" : priorMarket.unsoldSupply > 0 ? "SURPLUS" : "TIGHT";
  const procurementNeededScaleTons =
    otherAxesMinScaleTons === null ? null : Math.max(0, otherAxesMinScaleTons - securedRawScaleTons);

  const detail: RawMaterialSupportedScaleDetail = {
    securedRawScaleTons,
    procurementNeededScaleTons,
    publicMarketAvailabilityState,
    companyPurchasableScaleTons: null,
  };

  const estimate: SupportedScaleEstimate = {
    axis: "rawMaterial",
    // 【2026-08-04修正】「分からない」と「0tしかできない」を区別する。会社固有の
    // 購入可能上限が観測不能である以上、Raw軸の真のsupported scaleは算定不能
    // （null）とし、securedRawScaleTons（手元の確実な量）をそのままsupportedScaleTonsに
    // 転記しない。これにより、Raw軸がBusiness Scale Profileのbinding軸判定
    // （他モジュールのbindingAxesOf等、supportedScaleTons!==nullのみを対象とする）
    // から自動的に除外される（「毎期新規購入するビジネスモデル」で正常な会社が
    // 常にRawをbinding扱いされる、という誤解を防ぐ）。
    supportedScaleTons: null,
    confidence: "UNKNOWN",
    limitingReason:
      "会社固有の国内追加購入可能量が観測構造上不明であり、Raw-supported scaleそのものを算定できない。" +
      `手元の確実な原料量はsecuredRawScaleTons=${securedRawScaleTons.toFixed(1)}tだが、これは` +
      "「毎期新規購入で追加調達する」運転資金型ビジネスモデルにおける下限に過ぎず、真の上限ではない。",
    constraintFlexibility: "UNCERTAIN",
    expansionOptions: [
      {
        flexibility: "UNCERTAIN",
        leadTimeQuarters: null,
        description:
          "国内追加購入・輸入追加発注は理論上可能だが、会社固有の購入可能上限が観測されていないため、" +
          "拡張余地の大きさを診断できない（#04確認事項）。",
      },
    ],
    source: "observation.rawMaterialAvailable / rawMaterialCertainInboundThisPeriod / vietnamDomesticPriorMarket.unsoldSupply",
    dataQuality: {
      note: "会社固有の国内購入可能上限は恒常的にnull（憶測しない）。Raw軸のsupportedScaleTonsも" +
        "同じ理由でnull（0tではない）。",
      knownGaps: ["company-specific domestic raw material purchase cap not observable"],
    },
  };

  return { estimate, detail };
}

// ---------------------------------------------------------------------
// Finance-supported scale
// ---------------------------------------------------------------------

function buildFinanceSupportedScale(
  observation: StandardAiObservation,
  pressures: PressureScores,
  productMixAssumption: ProductAmount,
  domesticRawShareOfProduction: number
): { estimate: SupportedScaleEstimate; detail: FinanceSupportedScaleDetail } {
  const mixTotal = sumProductAmount(productMixAssumption);
  const mix: ProductAmount =
    mixTotal > 1e-9
      ? {
          hoso: productMixAssumption.hoso / mixTotal,
          pd: productMixAssumption.pd / mixTotal,
          vap: productMixAssumption.vap / mixTotal,
        }
      : { hoso: 1 / 3, pd: 1 / 3, vap: 1 / 3 };

  function planForScale(totalTons: number): StandardAiFinancialCapacityPlanInput {
    return {
      ...zeroFinancialCapacityPlan(),
      productionByProductTons: { hoso: totalTons * mix.hoso, pd: totalTons * mix.pd, vap: totalTons * mix.vap },
      totalSalesTonsThisQuarter: totalTons,
      domesticProcurementTons: totalTons * domesticRawShareOfProduction,
      importProcurementTons: 0,
    };
  }

  // 【既存関数への二分探索ラッパー】buildStandardAiFinancialCapacityは「規模→現金結果」を
  // 返す既存の純関数。新しい財務ルールは作らず、逆方向（現金制約→支えられる規模）を
  // 二分探索で求めるだけ。
  function maxScaleWhere(predicate: (totalTons: number) => boolean): number {
    let lo = 0;
    let hi = 200_000; // 十分に大きい上限（本ゲームの規模感に対して桁違いに大きい安全上限）
    if (!predicate(0)) return 0;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (predicate(mid)) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  const supportedScaleTonsWithinTargetBuffer = maxScaleWhere((tons) => {
    const r = buildStandardAiFinancialCapacity(observation, pressures, planForScale(tons));
    return r.quarterLevelLiquidityHeadroomUsd >= 0;
  });
  const supportedScaleTonsBeforeCashNegative = maxScaleWhere((tons) => {
    const r = buildStandardAiFinancialCapacity(observation, pressures, planForScale(tons));
    return r.projectedCashAfterPlannedFinancingUsd >= 0;
  });

  const detail: FinanceSupportedScaleDetail = {
    supportedScaleTonsWithinTargetBuffer,
    supportedScaleTonsBeforeCashNegative,
    availableBorrowingHeadroomUsd: observation.availableBorrowingHeadroomUsd ?? null,
    assumptionNote:
      `productMix=${JSON.stringify(mix)}, domesticRawShareOfProduction=${domesticRawShareOfProduction}, ` +
      "capex/新規借入/任意期限前返済は0と仮定（Base条件）。前提が変わればこの数値も変わる。",
  };

  const estimate: SupportedScaleEstimate = {
    axis: "finance",
    // 【cash negativeとbelow-target-bufferを区別】supportedScaleにはより保守的な
    // (target bufferを割らない)方の値を採用し、cash-negativeまでの値は別途detailへ保持する。
    supportedScaleTons: supportedScaleTonsWithinTargetBuffer,
    confidence: "MEDIUM",
    limitingReason:
      "目標最低現金バッファを割らない範囲での事業規模（二分探索）。現金そのものがマイナスになる規模" +
      `（${supportedScaleTonsBeforeCashNegative.toFixed(0)}t）とは区別している。前提（商品ミックス・` +
      "調達構成）に依存するため、他のScenarioでは変わりうる。",
    constraintFlexibility: "EXPANDABLE_WITH_FINANCING",
    expansionOptions: [
      {
        flexibility: "EXPANDABLE_WITH_FINANCING",
        leadTimeQuarters: observation.availableBorrowingHeadroomUsd != null ? 0 : null,
        description:
          observation.availableBorrowingHeadroomUsd != null
            ? "追加借入可能額が観測されている場合はその範囲で即時拡張可能。"
            : "追加借入可能額は未配線（Phase F-9で分類済み: 配線のみで解決可能、新財務ルール不要）のためnull。",
      },
    ],
    source: "diagnosis/financialCapacity.ts buildStandardAiFinancialCapacity（二分探索ラッパー）",
    dataQuality: {
      note: "cash-negativeとbelow-target-bufferを明確に区別している。",
      knownGaps: observation.availableBorrowingHeadroomUsd == null ? ["available borrowing headroom not wired to observation"] : [],
    },
  };

  return { estimate, detail };
}

// ---------------------------------------------------------------------
// 集約（単一値へは潰さない）
// ---------------------------------------------------------------------

export interface BuildBusinessScaleProfileInput {
  readonly observation: StandardAiObservation;
  readonly pressures: PressureScores;
  readonly unitEconomics: StandardAiUnitEconomicsResult;
  readonly currentSalesPlans: readonly CompanySalesPlanEntry[];
  readonly desiredByProduct: ProductAmount;
  /** Production/Labor/Finance軸の算定に使う商品ミックス前提。省略時は
   *  currentSalesPlansから実現数量ベースの比率を推定する。 */
  readonly productMixAssumption?: ProductAmount;
  /** Finance軸の二分探索に使う、生産量に対する国内原料調達量の比率（0〜1）。省略時0.9。 */
  readonly domesticRawShareOfProduction?: number;
}

function inferProductMix(currentSalesPlans: readonly CompanySalesPlanEntry[]): ProductAmount {
  const totals = zeroProductAmount();
  for (const p of currentSalesPlans) {
    totals[p.product] += Math.max(0, p.desiredQuantity as unknown as number);
  }
  const sum = sumProductAmount(totals);
  if (sum <= 1e-9) return { hoso: 1 / 3, pd: 1 / 3, vap: 1 / 3 };
  return { hoso: totals.hoso / sum, pd: totals.pd / sum, vap: totals.vap / sum };
}

export function buildBusinessScaleProfile(input: BuildBusinessScaleProfileInput): BusinessScaleProfile {
  const { observation, pressures, unitEconomics, currentSalesPlans, desiredByProduct } = input;
  const productMixAssumption = input.productMixAssumption ?? inferProductMix(currentSalesPlans);
  const domesticRawShareOfProduction = input.domesticRawShareOfProduction ?? 0.9;

  const sales = buildSalesSupportedScale(observation, unitEconomics, currentSalesPlans, desiredByProduct);
  const production = buildProductionSupportedScale(observation, productMixAssumption);
  const labor = buildLaborSupportedScale(observation, productMixAssumption);
  const finance = buildFinanceSupportedScale(observation, pressures, productMixAssumption, domesticRawShareOfProduction);

  // 【procurementNeededScaleTons算定用】Raw以外の4軸のうち、算定可能な値の最小値。
  // 1軸でも算定できていればそれを使う（全軸nullの場合のみnull）。
  const otherKnownScales = [sales.estimate.supportedScaleTons, production.estimate.supportedScaleTons, labor.supportedScaleTons, finance.estimate.supportedScaleTons].filter(
    (v): v is number => v !== null
  );
  const otherAxesMinScaleTons = otherKnownScales.length > 0 ? Math.min(...otherKnownScales) : null;
  const rawMaterial = buildRawMaterialSupportedScale(observation, otherAxesMinScaleTons);

  return {
    companyId: observation.companyId,
    period: String(observation.period),
    // 【単一値へ潰さない】5軸をここでmin()等へ合成しない。呼び出し側が個別に参照する。
    axes: [sales.estimate, production.estimate, labor, rawMaterial.estimate, finance.estimate],
    salesDetail: sales.detail,
    productionDetail: production.detail,
    rawMaterialDetail: rawMaterial.detail,
    financeDetail: finance.detail,
  };
}
