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

import { HosoEqTons, UsdPerHosoEqKg, hosoEqTons, roundHosoEqTons, unwrapUnit, usdPerHosoEqKg } from "../core/units";
import { PeriodV2 } from "../core/period";
import { MarketQuarterInput } from "../market/types";
import {
  CompanyDomesticPurchaseAllocationEntry,
  DomesticPurchaseAllocationResult,
  DomesticPurchasePlanEntry,
  RawMaterialsValidationError,
} from "./types";
import { RawMaterialsParameters } from "./parameters";
import { waterFillAllocate } from "./waterFill";

const EPSILON = 1e-6;

/**
 * 5社の国内買付希望量を単純合計する（意思決定支援の積み上げのみ。新規経済
 * ロジックは追加しない）。Phase1の`VietnamDomesticInput.domesticProcurementIntent`
 * （業界集計値として1フィールドで受け取る設計）へそのまま渡せる形。
 */
export function aggregateDomesticPurchaseIntent(plans: readonly DomesticPurchasePlanEntry[]): HosoEqTons {
  const total = plans.reduce((sum, p) => sum + unwrapUnit(p.desiredQuantity), 0);
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
  if (!Number.isInteger(headcount) || headcount < 0) {
    throw new RawMaterialsValidationError(`procurementHeadcount は0以上の整数である必要があります。受け取った値: ${headcount}`);
  }
  const { baselineCoverageAtZeroHeadcount, coverageSaturationHeadcount } = params.domesticPurchase;
  const growth = headcount / (headcount + coverageSaturationHeadcount);
  return baselineCoverageAtZeroHeadcount + (1 - baselineCoverageAtZeroHeadcount) * growth;
}

/** 提示買付価格の競争力（上限付き飽和型。法外な高値でも全量独占を防ぐ）。 */
function buyerPriceScore(bidPrice: number, marketPrice: number, params: RawMaterialsParameters): number {
  const deviation = (bidPrice - marketPrice) / marketPrice;
  return Math.exp(params.domesticPurchase.purchasePriceSensitivity * deviation);
}

/** 5社それぞれの合成競争力ウェイトを計算する（0〜1程度のスケール）。 */
export function computeBuyerCompetitivenessWeight(
  entry: DomesticPurchasePlanEntry,
  bidPrice: UsdPerHosoEqKg,
  marketPrice: UsdPerHosoEqKg,
  coverageScore: number,
  params: RawMaterialsParameters
): number {
  const p = params.domesticPurchase;
  const w = p.competitivenessWeights;
  const rawPriceScore = buyerPriceScore(unwrapUnit(bidPrice), unwrapUnit(marketPrice), params);
  const clampedPriceScore = Math.min(p.maximumBuyerPriceCompetitiveness, Math.max(p.minimumBuyerPriceCompetitiveness, rawPriceScore));
  const priceContribution = clampedPriceScore / p.maximumBuyerPriceCompetitiveness;

  const relationship = (entry.farmerRelationship !== undefined ? unwrapUnit(entry.farmerRelationship) : unwrapUnit(p.neutralScore)) / 100;
  const reliability = (entry.paymentReliability !== undefined ? unwrapUnit(entry.paymentReliability) : unwrapUnit(p.neutralScore)) / 100;

  return w.price * priceContribution + w.coverage * coverageScore + w.farmerRelationship * relationship + w.paymentReliability * reliability;
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
  params: RawMaterialsParameters
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
    const weight = computeBuyerCompetitivenessWeight(entry, bidPrice, marketPrice, coverage, params);

    const shareCap = unwrapUnit(availableSupply) * maximumBuyerShareFor(entry, params);
    const approvedCap = entry.approvedPurchaseCap !== undefined ? unwrapUnit(entry.approvedPurchaseCap) : Number.POSITIVE_INFINITY;
    const cap = Math.min(unwrapUnit(entry.desiredQuantity), shareCap, approvedCap);

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
