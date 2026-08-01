// ShrimpX V2 — 国内原料・輸入・養殖・原料在庫モジュール 国内原料買付（Phase 5）
//
// 5社の国内買付計画を集計してPhase3（ベトナム国内未凍結原料市場）へ渡す
// アダプターと、Phase3が清算した価格・供給量を5社へ配分する純粋関数を提供する。
//
// 処理順（実装指示 §3 のとおり）:
//   各社買付計画 → 希望量集計 → Phase3国内原料価格（呼び出し側の責務） →
//   国内供給量を5社へ配分 → 各社原料在庫へ追加（inventory.ts）
//
// 国際HOSO基準価格は一切変更しない。会社行動が影響するのは、
// domesticProcurementIntent経由でのベトナム国内原料価格のみ（Phase1/3の
// 計算式自体は変更・再実装しない）。
//
// --- 「有効買付意向」による価格操作の防止（暫定値・要校正） ---
// aggregateDomesticPurchaseIntentは、各社のdesiredQuantityをそのまま合計しない。
// 実際には買えない・調達できない希望量だけを申告して国内価格（延いては競合他社の
// 取得原価）を際限なく押し上げる抜け道を防ぐため、各社の希望量を
// 「実際に買える量の目安」（調達処理能力・承認済み買付枠・基準供給量に対する
// 最大価格影響シェア）で信認上限を掛けたうえで合計する
// （calculateEffectivePurchaseIntent参照）。

import { HosoEqTons, UsdPerHosoEqKg, hosoEqTons, roundHosoEqTons, unwrapUnit, usdPerHosoEqKg } from "../core/units";
import { PeriodV2 } from "../core/period";
import { MarketQuarterInput } from "../market/types";
import {
  CompanyDomesticPurchaseAllocationEntry,
  DomesticPurchaseAllocationResult,
  DomesticPurchasePlanEntry,
  RawMaterialsValidationError,
} from "./types";
import { RAW_MATERIALS_PARAMETERS_V1, RawMaterialsParameters } from "./parameters";
import { waterFillAllocate } from "./waterFill";

const EPSILON = 1e-6;

function assertNonNegativeIntegerHeadcount(headcount: number): void {
  if (!Number.isInteger(headcount) || headcount < 0) {
    throw new RawMaterialsValidationError(`procurementHeadcount は0以上の整数である必要があります。受け取った値: ${headcount}`);
  }
}

/**
 * 調達人員数から調達処理能力（HOSO換算トン、逓減曲線）を導出する。
 * 【Phase 6.3（実装指示 §6）】factoryCommonProcessingCapacityTons（会社の工場共通
 * 原料処理能力）が指定された場合は工場能力連動方式を使う:
 *   調達能力 = 工場能力 × (基準比率 + 増分比率 × 人員/(人員+飽和人数))
 * 一律倍率補正を廃止し、工場能力と調達人員の双方を反映する。未指定時は従来の
 * 絶対値カーブ（industryLabの小規模テスト会社向け）へフォールバックする。
 */
export function procurementCapacity(
  headcount: number,
  params: RawMaterialsParameters,
  factoryCommonProcessingCapacityTons?: number
): HosoEqTons {
  assertNonNegativeIntegerHeadcount(headcount);
  if (factoryCommonProcessingCapacityTons !== undefined) {
    if (!Number.isFinite(factoryCommonProcessingCapacityTons) || factoryCommonProcessingCapacityTons < 0) {
      throw new RawMaterialsValidationError(
        `factoryCommonProcessingCapacityTons は0以上の有限数である必要があります。受け取った値: ${factoryCommonProcessingCapacityTons}`
      );
    }
    const fl = params.domesticPurchase.capacityFactoryLinked;
    const growthRatio = headcount / (headcount + fl.saturationHeadcount);
    const ratio = fl.baseRatioAtZeroHeadcount + fl.ratioMaxIncrement * growthRatio;
    return hosoEqTons(roundHosoEqTons(factoryCommonProcessingCapacityTons * ratio));
  }
  const { baselineCapacityTons, capacityMaxIncrementTons, capacitySaturationHeadcount } = params.domesticPurchase;
  const growth = headcount / (headcount + capacitySaturationHeadcount);
  return hosoEqTons(roundHosoEqTons(baselineCapacityTons + capacityMaxIncrementTons * growth));
}

/**
 * 1社の「有効買付意向」（国内価格形成へ渡す買付意向として認める上限付き数量）を
 * 算出する。実際には買えない・調達できない希望量だけを申告して国内価格を
 * 際限なく押し上げる抜け道を防ぐため、次の最小値とする。
 *   - desiredQuantity（国内買付希望量）
 *   - procurementCapacity（調達人員・調達カバレッジによる処理能力）
 *   - approvedPurchaseCap（未指定時はInfinity）
 *   - referenceSupply × maximumPriceInfluenceShare（基準国内供給量×最大価格影響シェア）
 */
export function calculateEffectivePurchaseIntent(
  entry: DomesticPurchasePlanEntry,
  referenceSupply: HosoEqTons,
  params: RawMaterialsParameters
): HosoEqTons {
  const capacity = procurementCapacity(entry.procurementHeadcount, params, entry.factoryCommonProcessingCapacityTons);
  const shareCap = unwrapUnit(referenceSupply) * params.domesticPurchase.maximumPriceInfluenceShare;
  const approvedCap = entry.approvedPurchaseCap !== undefined ? unwrapUnit(entry.approvedPurchaseCap) : Number.POSITIVE_INFINITY;
  const capped = Math.min(unwrapUnit(entry.desiredQuantity), unwrapUnit(capacity), shareCap, approvedCap);
  return hosoEqTons(roundHosoEqTons(Math.max(0, capped)));
}

/**
 * 5社それぞれの「有効買付意向」（calculateEffectivePurchaseIntent）を合計する
 * （意思決定支援の積み上げではあるが、各社の申告値をそのまま信用せず、実際に
 * 買える量の目安で信認上限を掛けたうえでの合計。新規の価格・需給計算式自体は
 * 追加しない）。Phase1の`VietnamDomesticInput.domesticProcurementIntent`
 * （業界集計値として1フィールドで受け取る設計）へそのまま渡せる形。
 *
 * referenceSupplyには、当期のベトナム国内原料の基準供給量
 * （`MarketQuarterInput.vietnamDomestic.domesticRawSupply`等、価格計算前に
 * 既知の値）を渡す。これは収穫量ベースの外生値であり、価格計算の結果に
 * 依存しないため、循環参照は生じない。
 */
export function aggregateDomesticPurchaseIntent(
  plans: readonly DomesticPurchasePlanEntry[],
  referenceSupply: HosoEqTons,
  params: RawMaterialsParameters = RAW_MATERIALS_PARAMETERS_V1
): HosoEqTons {
  const total = plans.reduce((sum, p) => sum + unwrapUnit(calculateEffectivePurchaseIntent(p, referenceSupply, params)), 0);
  return hosoEqTons(roundHosoEqTons(Math.max(0, total)));
}

/**
 * MarketQuarterInputのvietnamDomestic.domesticProcurementIntentを、5社の
 * 実際の買付希望量集計値で置き換えた新しいMarketQuarterInputを返す（不変更新、
 * Phase1/3の計算式自体は一切変更しない）。
 *
 * 会社行動がない場合（画面・API未接続の単体テスト等）は、この関数を呼ばなければ
 * Phase3（industryLab）が使用している暫定買付量（trailingAverage×仮置き比率）が
 * そのまま残る。会社行動がある統合ゲームでは、この関数でPhase5の実際の希望量に
 * 置き換えてからcalculateMarketQuarterへ渡す。
 */
export function applyDomesticPurchaseIntentOverride(
  marketInput: MarketQuarterInput,
  aggregatedIntent: HosoEqTons
): MarketQuarterInput {
  return {
    ...marketInput,
    vietnamDomestic: {
      ...marketInput.vietnamDomestic,
      domesticProcurementIntent: aggregatedIntent,
    },
  };
}

function assertValidBidPrice(bidPrice: number, marketPrice: number, params: RawMaterialsParameters, companyId: string): void {
  if (!Number.isFinite(bidPrice) || bidPrice <= 0) {
    throw new RawMaterialsValidationError(`会社 "${companyId}" の提示買付価格が不正です（0より大きい有限数である必要があります）。受け取った値: ${bidPrice}`);
  }
  const p = params.domesticPurchase;
  const minPrice = marketPrice * p.minBidPriceRatioOfMarket;
  const maxPrice = marketPrice * p.maxBidPriceRatioOfMarket;
  if (bidPrice < minPrice - EPSILON || bidPrice > maxPrice + EPSILON) {
    throw new RawMaterialsValidationError(
      `会社 "${companyId}" の提示買付価格 ${bidPrice} が許容範囲外です（国内原料価格 ${marketPrice} の ${p.minBidPriceRatioOfMarket}〜${p.maxBidPriceRatioOfMarket} 倍である必要があります）。`
    );
  }
}

/** 調達人員数から調達カバレッジ（0〜1）を導出する。Phase4のsalesCoverageScoreと同じ形。 */
export function procurementCoverageScore(headcount: number, params: RawMaterialsParameters): number {
  assertNonNegativeIntegerHeadcount(headcount);
  const { baselineCoverageAtZeroHeadcount, coverageSaturationHeadcount } = params.domesticPurchase;
  const growth = headcount / (headcount + coverageSaturationHeadcount);
  return baselineCoverageAtZeroHeadcount + (1 - baselineCoverageAtZeroHeadcount) * growth;
}

/** 提示買付価格の競争力（上限付き飽和型。法外な高値でも全量独占を防ぐ）。 */
function buyerPriceScore(bidPrice: number, marketPrice: number, params: RawMaterialsParameters): number {
  const deviation = (bidPrice - marketPrice) / marketPrice;
  return Math.exp(params.domesticPurchase.purchasePriceSensitivity * deviation);
}

/**
 * 5社それぞれの合成競争力ウェイトを計算する（0〜1程度のスケール）。
 *
 * 【調達規模効果】procurementRelationshipScore（会社×国内買付チャネルの調達規模
 * ストックから算出される関係スコア、0〜100）は、entry.farmerRelationship（売り手＝
 * 養殖業者側の関係、意思決定側からの外部入力）とは別の観測系列（買い手側の
 * 継続調達実績というエンジン内で確定するストック）であり、二重加算防止のため
 * 独立したウェイト（competitivenessWeights.procurementRelationship）で加点する。
 * 未指定時は中立値（params.neutralScore）を使うため、機能OFF・procurementScaleState
 * 未接続の呼び出しでは常に一定の加点となり、既存の相対順位・既存テストの結果へ
 * 影響しない。
 */
export function computeBuyerCompetitivenessWeight(
  entry: DomesticPurchasePlanEntry,
  bidPrice: UsdPerHosoEqKg,
  marketPrice: UsdPerHosoEqKg,
  coverageScore: number,
  params: RawMaterialsParameters,
  procurementRelationshipScore?: number
): number {
  const p = params.domesticPurchase;
  const w = p.competitivenessWeights;
  const rawPriceScore = buyerPriceScore(unwrapUnit(bidPrice), unwrapUnit(marketPrice), params);
  const clampedPriceScore = Math.min(p.maximumBuyerPriceCompetitiveness, Math.max(p.minimumBuyerPriceCompetitiveness, rawPriceScore));
  const priceContribution = clampedPriceScore / p.maximumBuyerPriceCompetitiveness;

  const relationship = (entry.farmerRelationship !== undefined ? unwrapUnit(entry.farmerRelationship) : unwrapUnit(p.neutralScore)) / 100;
  const reliability = (entry.paymentReliability !== undefined ? unwrapUnit(entry.paymentReliability) : unwrapUnit(p.neutralScore)) / 100;
  const procurementRelationship = (procurementRelationshipScore !== undefined ? procurementRelationshipScore : unwrapUnit(p.neutralScore)) / 100;

  return (
    w.price * priceContribution +
    w.coverage * coverageScore +
    w.farmerRelationship * relationship +
    w.paymentReliability * reliability +
    w.procurementRelationship * procurementRelationship
  );
}

/**
 * 1社あたりの最大買付シェア（対象供給に対する比率）を返す。将来、養殖業者との
 * 関係・実績に応じて会社別に変化させる拡張ポイントとして独立した関数にしている
 * （現段階ではその動的計算は未実装。Phase4のmaximumSupplierShareForと対称）。
 */
function maximumBuyerShareFor(entry: DomesticPurchasePlanEntry, params: RawMaterialsParameters): number {
  void entry;
  return params.domesticPurchase.maximumBuyerShare;
}

/**
 * Phase3が清算した国内原料価格・供給量を、5社の買付計画に基づいて配分する。
 * 入力配列の順序には一切依存しない（内部でcompanyId順にソートしてから処理する）。
 */
export function allocateDomesticPurchase(
  period: PeriodV2,
  entries: readonly DomesticPurchasePlanEntry[],
  marketPrice: UsdPerHosoEqKg,
  availableSupply: HosoEqTons,
  params: RawMaterialsParameters,
  // 【Phase 6.3】maximumBuyerShareの基準供給量。未指定時はavailableSupply（後方互換）。
  // 外部加工業者需要の導入後、availableSupplyは「会社側の配分原資」に縮小されるため、
  // 市場全体に対する買い占め防止上限の基準は別引数で渡せるようにする。
  shareCapReferenceSupply: HosoEqTons = availableSupply,
  // 【調達規模効果】会社別の国内買付チャネル関係スコア（0〜100、未指定=中立値50相当）。
  procurementRelationshipScoreByCompany?: ReadonlyMap<string, number>
): DomesticPurchaseAllocationResult {
  const sorted = [...entries].sort((a, b) => a.companyId.localeCompare(b.companyId));

  const seen = new Set<string>();
  for (const e of sorted) {
    if (seen.has(e.companyId)) {
      throw new RawMaterialsValidationError(`会社 "${e.companyId}" の国内買付計画が重複しています。`);
    }
    seen.add(e.companyId);
  }

  const prepared = sorted.map((entry) => {
    const rawBidPrice = unwrapUnit(marketPrice) + entry.priceAdjustmentUsdPerHosoEqKg;
    // 提示価格の妥当性検証は、UsdPerHosoEqKgスマートコンストラクタ（0以上のみ）に
    // 到達する前に行う（Phase4allocation.tsと同じ理由：分かりやすいエラーメッセージのため）。
    assertValidBidPrice(rawBidPrice, unwrapUnit(marketPrice), params, entry.companyId);
    const bidPrice = usdPerHosoEqKg(rawBidPrice);

    const coverage = procurementCoverageScore(entry.procurementHeadcount, params);
    const capacity = procurementCapacity(entry.procurementHeadcount, params, entry.factoryCommonProcessingCapacityTons);
    const procurementRelationshipScore = procurementRelationshipScoreByCompany?.get(entry.companyId);
    const weight = computeBuyerCompetitivenessWeight(entry, bidPrice, marketPrice, coverage, params, procurementRelationshipScore);

    const shareCap = unwrapUnit(shareCapReferenceSupply) * maximumBuyerShareFor(entry, params);
    const approvedCap = entry.approvedPurchaseCap !== undefined ? unwrapUnit(entry.approvedPurchaseCap) : Number.POSITIVE_INFINITY;
    // 調達処理能力（procurementHeadcountに基づく実務上の上限）も個社配分上限へ反映する。
    // 調達人員がゼロ・少数の会社は、希望量だけを大きくしても実配分量が増えない。
    const cap = Math.min(unwrapUnit(entry.desiredQuantity), unwrapUnit(capacity), shareCap, approvedCap);

    return { entry, bidPrice, coverage, weight, cap };
  });

  const participants = prepared.map((p) => ({ id: p.entry.companyId, weight: p.weight, cap: p.cap }));
  const { allocated } = waterFillAllocate(participants, unwrapUnit(availableSupply));

  const companies: CompanyDomesticPurchaseAllocationEntry[] = prepared.map((p) => ({
    companyId: p.entry.companyId,
    bidPrice: p.bidPrice,
    coverageScore: p.coverage,
    competitivenessWeight: p.weight,
    allocatedQuantity: hosoEqTons(roundHosoEqTons(Math.max(0, allocated.get(p.entry.companyId) ?? 0))),
  }));

  const totalAllocated = companies.reduce((sum, c) => sum + unwrapUnit(c.allocatedQuantity), 0);
  const unallocatedSupply = hosoEqTons(roundHosoEqTons(Math.max(0, unwrapUnit(availableSupply) - totalAllocated)));

  return {
    period,
    marketPrice,
    availableSupply,
    companies,
    unallocatedSupply,
  };
}
