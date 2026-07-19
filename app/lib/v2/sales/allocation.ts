// ShrimpX V2 — 販売計画・営業人員・成約・約定残モジュール 成約配分（Phase 4）
//
// 市場×商品区分ごとに、5社の販売提案を同時に評価し、成約量を配分する。
// 使用するアルゴリズムは「水位法（water-filling）」: 各参加者（5社＋外部選択肢）に
// 競争力ウェイトを与え、対象需要という固定の予算をウェイト比例で仮配分し、
// 上限（販売希望量・処理能力・対象需要×最大供給者シェア・承認済み取引枠）を
// 超える参加者はその上限で打ち切って予算から除外し、残った予算を「まだ上限に
// 達していない参加者」だけで再度ウェイト比例配分し直す……という手順を、
// 誰も打ち切られなくなるまで繰り返す。
//
// この方式は次の実装指示の要件をすべて構造的に満たす:
//   - 全社合計成約量（＋外部選択肢）は対象需要（＝配分予算の総額）を超えない
//   - 各社成約量は上限（min(販売希望量, 処理能力, 対象需要×最大供給者シェア,
//     承認済み取引枠)）を超えない（安値による過剰受注の防止）
//   - 入力順に依存しない（配列の合計・比較はすべて順序非依存の演算のみで構成）
//   - 上限に達した会社の未配分需要は、まだ達していない会社へ自動的に再配分される
//   - 5社以外の外部選択肢（他産地供給者・非購入）も1参加者として競争する

import { HosoEqTons, UsdPerHosoEqKg, hosoEqTons, roundHosoEqTons, unwrapUnit, usdPerHosoEqKg } from "../core/units";
import { processingCapacity, salesCoverageScore } from "./salesForce";
import { SalesParameters } from "./parameters";
import { CompanyAllocationEntry, CompanySalesPlanEntry, MarketProductAllocationResult, SalesValidationError } from "./types";
import { DemandMarketId, Product } from "../market/types";
import { PeriodV2 } from "../core/period";

const EXTERNAL_OPTION_ID = "__external_option__";
const EPSILON = 1e-6;

function assertValidAskPrice(askPrice: number, basePrice: number, params: SalesParameters, companyId: string): void {
  if (!Number.isFinite(askPrice) || askPrice <= 0) {
    throw new SalesValidationError(`会社 "${companyId}" の提示価格が不正です（0より大きい有限数である必要があります）。受け取った値: ${askPrice}`);
  }
  const minPrice = basePrice * params.minAskPriceRatioOfBase;
  const maxPrice = basePrice * params.maxAskPriceRatioOfBase;
  if (askPrice < minPrice - EPSILON || askPrice > maxPrice + EPSILON) {
    throw new SalesValidationError(
      `会社 "${companyId}" の提示価格 ${askPrice} が許容範囲外です（基準価格 ${basePrice} の ${params.minAskPriceRatioOfBase}〜${params.maxAskPriceRatioOfBase} 倍である必要があります）。`
    );
  }
}

/** 価格競争力（basePriceからの乖離。安いほど1超、高いほど1未満に近づく）。 */
function priceScore(askPrice: number, basePrice: number, params: SalesParameters): number {
  const deviation = (askPrice - basePrice) / basePrice;
  return Math.exp(-params.priceSensitivity * deviation);
}

/** 5社それぞれの合成競争力ウェイトを計算する（0〜1程度のスケール）。 */
export function computeCompetitivenessWeight(
  entry: CompanySalesPlanEntry,
  askPrice: UsdPerHosoEqKg,
  basePrice: UsdPerHosoEqKg,
  coverageScore: number,
  params: SalesParameters
): number {
  const w = params.competitivenessWeights;
  const rawPriceScore = priceScore(unwrapUnit(askPrice), unwrapUnit(basePrice), params);
  // 安値による過剰受注（値下げすればするほど際限なく成約力が伸びる「抜け道」）を防ぐため、
  // priceScoreの結果に下限・上限を設ける（【暫定値・要校正】parameters.ts参照）。
  const clampedPriceScore = Math.min(params.maximumPriceCompetitiveness, Math.max(params.minimumPriceCompetitiveness, rawPriceScore));
  const priceContribution = clampedPriceScore / params.maximumPriceCompetitiveness;

  const relationship = (entry.customerRelationship !== undefined ? unwrapUnit(entry.customerRelationship) : unwrapUnit(params.neutralScore)) / 100;
  const quality = (entry.qualityReputation !== undefined ? unwrapUnit(entry.qualityReputation) : unwrapUnit(params.neutralScore)) / 100;
  const reliability =
    (entry.deliveryReliability !== undefined ? unwrapUnit(entry.deliveryReliability) : unwrapUnit(params.neutralScore)) / 100;

  return (
    w.price * priceContribution +
    w.coverage * coverageScore +
    w.relationship * relationship +
    w.quality * quality +
    w.deliveryReliability * reliability
  );
}

/**
 * 1社あたりの最大供給者シェア（対象需要に対する比率）を返す。
 * 現段階ではSalesParameters.maximumSupplierShareを固定で返すのみだが、将来
 * 顧客関係・供給実績・納期信頼性に応じて会社別に変化させる拡張ポイントとして
 * 独立した関数にしている（現段階ではその動的計算は未実装）。
 */
function maximumSupplierShareFor(entry: CompanySalesPlanEntry, params: SalesParameters): number {
  void entry;
  return params.maximumSupplierShare;
}

interface WaterFillParticipant {
  readonly id: string;
  readonly weight: number;
  readonly cap: number;
}

interface WaterFillResult {
  readonly allocated: ReadonlyMap<string, number>;
}

/**
 * 水位法による配分。参加者ごとの重みに比例して予算(totalBudget)を配分しつつ、
 * 各参加者のcapを超えないよう、超過分を毎ラウンド未飽和の参加者へ再配分する。
 * 入力配列の順序には一切依存しない（合計・比較はすべて順序非依存の演算）。
 */
function waterFillAllocate(participants: readonly WaterFillParticipant[], totalBudget: number): WaterFillResult {
  const allocated = new Map<string, number>(participants.map((p) => [p.id, 0]));
  const active = new Set(participants.filter((p) => p.cap > EPSILON).map((p) => p.id));

  let budget = totalBudget;
  let safety = 0;
  const safetyLimit = participants.length + 5;

  while (budget > EPSILON && active.size > 0 && safety < safetyLimit) {
    safety += 1;
    const activeParticipants = participants.filter((p) => active.has(p.id));
    const totalWeight = activeParticipants.reduce((sum, p) => sum + Math.max(0, p.weight), 0);
    if (totalWeight <= EPSILON) break;

    const overflowing = activeParticipants.filter((p) => {
      const tentativeShare = budget * (Math.max(0, p.weight) / totalWeight);
      const room = p.cap - (allocated.get(p.id) ?? 0);
      return tentativeShare > room + EPSILON;
    });

    if (overflowing.length === 0) {
      for (const p of activeParticipants) {
        const share = budget * (Math.max(0, p.weight) / totalWeight);
        allocated.set(p.id, (allocated.get(p.id) ?? 0) + share);
      }
      budget = 0;
      break;
    }

    for (const p of overflowing) {
      const room = p.cap - (allocated.get(p.id) ?? 0);
      allocated.set(p.id, (allocated.get(p.id) ?? 0) + room);
      budget -= room;
      active.delete(p.id);
    }
  }

  return { allocated };
}

/**
 * 市場×商品区分ごとの成約配分を計算する。5社の入力配列の順序には一切依存しない
 * （内部でcompanyId順にソートしてから処理する）。
 */
export function allocateMarketProduct(
  market: DemandMarketId,
  product: Product,
  period: PeriodV2,
  entries: readonly CompanySalesPlanEntry[],
  basePrice: UsdPerHosoEqKg,
  targetDemand: HosoEqTons,
  params: SalesParameters
): MarketProductAllocationResult {
  const relevant = entries.filter((e) => e.market === market && e.product === product);
  const sorted = [...relevant].sort((a, b) => a.companyId.localeCompare(b.companyId));

  const seen = new Set<string>();
  for (const e of sorted) {
    if (seen.has(e.companyId)) {
      throw new SalesValidationError(`会社 "${e.companyId}" の market="${market}" product="${product}" 販売計画が重複しています。`);
    }
    seen.add(e.companyId);
  }

  const prepared = sorted.map((entry) => {
    const rawAskPrice = unwrapUnit(basePrice) + entry.priceAdjustmentUsdPerHosoEqKg;
    // 提示価格の妥当性検証は、UsdPerHosoEqKgスマートコンストラクタ（0以上のみ）に
    // 到達する前に行う。そうしないと、範囲外価格が0未満の場合に一般的な
    // UnitValidationErrorが先に投げられてしまい、Phase4固有の分かりやすい
    // SalesValidationErrorメッセージ（許容範囲・会社ID付き）を返せなくなるため。
    assertValidAskPrice(rawAskPrice, unwrapUnit(basePrice), params, entry.companyId);
    const askPrice = usdPerHosoEqKg(rawAskPrice);

    const coverage = salesCoverageScore(entry.salesForceHeadcount, params);
    const capacity = processingCapacity(entry.salesForceHeadcount, params);
    const weight = computeCompetitivenessWeight(entry, askPrice, basePrice, coverage, params);
    // 個社成約上限 = min(販売希望量, 処理能力, 対象需要×最大供給者シェア, 承認済み取引枠[未指定ならInfinity])。
    // 極端な安値・大量の営業人員・大量の販売希望量を同時に満たしても、1社が対象需要を
    // 独占できないようにする（安売りによる過剰受注の防止）。
    const shareCap = unwrapUnit(targetDemand) * maximumSupplierShareFor(entry, params);
    const approvedCap = entry.approvedAllocationCap !== undefined ? unwrapUnit(entry.approvedAllocationCap) : Number.POSITIVE_INFINITY;
    const cap = Math.min(unwrapUnit(entry.desiredQuantity), unwrapUnit(capacity), shareCap, approvedCap);

    return { entry, askPrice, coverage, capacity, weight, cap };
  });

  const participants: WaterFillParticipant[] = [
    ...prepared.map((p) => ({ id: p.entry.companyId, weight: p.weight, cap: p.cap })),
    { id: EXTERNAL_OPTION_ID, weight: params.externalOptionWeight, cap: Number.POSITIVE_INFINITY },
  ];

  const { allocated } = waterFillAllocate(participants, unwrapUnit(targetDemand));

  const companies: CompanyAllocationEntry[] = prepared.map((p) => ({
    companyId: p.entry.companyId,
    askPrice: p.askPrice,
    coverageScore: p.coverage,
    processingCapacity: p.capacity,
    competitivenessWeight: p.weight,
    allocatedQuantity: hosoEqTons(roundHosoEqTons(Math.max(0, allocated.get(p.entry.companyId) ?? 0))),
  }));

  const externalOptionQuantity = hosoEqTons(roundHosoEqTons(Math.max(0, allocated.get(EXTERNAL_OPTION_ID) ?? 0)));

  return {
    market,
    product,
    period,
    basePrice,
    targetDemand,
    companies,
    externalOptionQuantity,
  };
}
