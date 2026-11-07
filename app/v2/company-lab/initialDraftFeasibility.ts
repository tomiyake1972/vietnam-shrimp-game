// ShrimpX V2 — 人が編集する画面の「初期入力」を実行可能な範囲へ収める
//
// 【直す問題（テストプレイ指摘①の続き・2026-11）】
// 入力欄の初期値はStandard AIの提案をそのまま入れている。Standard AI の販売提示は
// 「名目（設備）能力 × salesUtilizationTarget」を供給側のアンカーにしており、
// 実効能力・製品在庫・受注残を見ていない（standardAi/decision/sales.ts）。
// 研修では初期値をそのまま、あるいは少し触って提出することが多いため、
// 「超えています」という警告だけでは足りず、何トンに下げればよいかも分からない。
//
// 【やること・やらないこと】
//   やる  : 人が編集する画面の初期値（ドラフト）だけを、実行可能な上限へ丸める。
//   やらない: Standard AI（競合4社）の意思決定は一切変えない。この関数は
//            generateStandardAiDecision の戻り値ではなくドラフトにだけ作用し、
//            エンジンへ渡る提出値は人が確定したものだけである。したがって
//            競合の行動・ゲームバランス・保存形式は変わらない。
//
// 【上限の定義（三宅さん指示・2026-11）】
//   販売希望量（商品別の合計）  ≤ 実効加工能力 ＋ 製品在庫 − 受注残
//   国内買付の希望量            ≤ 生産計画の合計 − 当期に使える原料
//                                （手持ち ＋ 当期到着の輸入 ＋ 当期収穫の養殖）
//
// 【新しい計算式を作らない】上限の材料はすべて既存の確定値・既存の純粋関数から読む。
//   実効加工能力 … production/capacity.ts の calculateFactoryEffectiveCapacity
//   製品在庫     … CompanyOwnState.finishedGoodsLots（status==="available"）
//   受注残       … CompanyOwnState.contracts の outstandingQuantity
//   使える原料   … procurementRequirementViewModel.ts の
//                  buildAvailableRawMaterialThisQuarter（totalIncludingExpectedTons）
//   生産計画     … ドラフトの productionPlans の単純合計（Standard AI の
//                  requiredRawMaterial と同じ式）
//
// 【生産計画は丸めない】指示の範囲は販売希望量と国内買付の2つである。生産計画を
// 下げないため、「作った量 − 売れた量」で製品在庫が積み上がること自体はこの丸めでは
// 解消しない（SALES画面の供給上限の表で見えるようにしてある）。

import { unwrapUnit } from "../../lib/v2/core/units";
import type { PeriodV2 } from "../../lib/v2/core/period";
import type { Product } from "../../lib/v2/market/types";
import type { CompanyOwnState } from "../../lib/v2/companyLab";
import { calculateFactoryEffectiveCapacity } from "../../lib/v2/production/capacity";
import type { CompanyDecisionDraft } from "./decisionDraft";
import { buildAvailableRawMaterialThisQuarter } from "./procurementRequirementViewModel";

/** 初期値を丸めたときの、1件ぶんの記録（画面で「何をどう変えたか」を出すため）。 */
export interface InitialDraftAdjustment {
  readonly field: "salesPlan" | "domesticPurchase";
  /** 販売希望量のときだけ入る。 */
  readonly product?: Product;
  /** 画面に出す項目名。 */
  readonly label: string;
  /** AIの提案値（丸める前）。 */
  readonly proposedTons: number;
  /** 丸めた後の値。 */
  readonly adjustedTons: number;
  /** その上限がどう決まったか（画面にそのまま出す）。 */
  readonly reason: string;
}

export interface InitialDraftFeasibilityResult {
  readonly draft: CompanyDecisionDraft;
  readonly adjustments: readonly InitialDraftAdjustment[];
  /** 商品別の販売可能量（上限）。画面の列にそのまま出す。 */
  readonly salesCeilingByProduct: Readonly<Partial<Record<Product, number>>>;
  /** 国内買付の上限（生産計画 − 当期に使える原料）。 */
  readonly domesticPurchaseCeilingTons: number;
}

const SALES_PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

const safe = (value: number | undefined): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/**
 * 商品別の実効加工能力（HOSO換算t/四半期）。
 * processingForecastViewModel の companyRateTable と同じ値を同じ関数から得る
 * （あちらはドラフトを要するため、能力だけが欲しいここでは工場一覧から直接読む）。
 */
export function computeEffectiveCapacityByProduct(
  factories: readonly Parameters<typeof calculateFactoryEffectiveCapacity>[0][]
): Readonly<Record<Product, number>> {
  let hoso = 0;
  let pd = 0;
  let vap = 0;
  for (const factory of factories) {
    const effective = calculateFactoryEffectiveCapacity(factory);
    hoso += unwrapUnit(effective.hoso);
    pd += unwrapUnit(effective.pd);
    vap += unwrapUnit(effective.vap);
  }
  return { hoso, pd, vap };
}

/** 商品別の出荷可能な製品在庫（status==="available"）。 */
export function computeAvailableFinishedGoodsByProduct(ownState: CompanyOwnState): Readonly<Partial<Record<Product, number>>> {
  return ownState.finishedGoodsLots.reduce<Partial<Record<Product, number>>>((acc, lot) => {
    if (lot.companyId !== ownState.companyId) return acc;
    if (lot.status !== "available") return acc;
    acc[lot.product] = (acc[lot.product] ?? 0) + safe(unwrapUnit(lot.remainingQuantity));
    return acc;
  }, {});
}

/** 商品別の未履行受注残。 */
export function computeBacklogByProduct(ownState: CompanyOwnState): Readonly<Partial<Record<Product, number>>> {
  return ownState.contracts.reduce<Partial<Record<Product, number>>>((acc, contract) => {
    if (contract.companyId !== ownState.companyId) return acc;
    const quantity = safe(unwrapUnit(contract.outstandingQuantity));
    if (quantity <= 0) return acc;
    acc[contract.product] = (acc[contract.product] ?? 0) + quantity;
    return acc;
  }, {});
}

/**
 * 商品別の販売可能量（上限）＝ 実効加工能力 ＋ 製品在庫 − 受注残（0未満にしない）。
 * SALES画面の列表示とこの丸めが同じ値を使うよう、導出はこの1箇所だけで行う。
 */
export function computeSalesCeilingByProduct(
  ownState: CompanyOwnState
): Readonly<Record<Product, number>> {
  const capacity = computeEffectiveCapacityByProduct(ownState.effectiveFactories);
  const finishedGoods = computeAvailableFinishedGoodsByProduct(ownState);
  const backlog = computeBacklogByProduct(ownState);
  const ceiling = { hoso: 0, pd: 0, vap: 0 } as Record<Product, number>;
  for (const product of SALES_PRODUCTS) {
    ceiling[product] = Math.max(0, capacity[product] + safe(finishedGoods[product]) - safe(backlog[product]));
  }
  return ceiling;
}

/**
 * 合計が cap 以下になるよう、各行を比例で縮める。
 * 端数は「切り捨て → 余りを小数部が大きい行へ1tずつ配る」で、合計を floor(cap) に合わせる
 * （行ごとに切り捨てるだけだと合計が上限より無駄に小さくなるため）。
 */
function scaleRowsToCap(values: readonly number[], cap: number): readonly number[] {
  const total = values.reduce((sum, v) => sum + v, 0);
  if (total <= cap) return values;
  const target = Math.max(0, Math.floor(cap));
  if (total <= 0 || target <= 0) return values.map(() => 0);
  const scaled = values.map((v) => (v * target) / total);
  const floored = scaled.map((v) => Math.floor(v));
  let remainder = target - floored.reduce((sum, v) => sum + v, 0);
  const order = scaled
    .map((v, index) => ({ index, fraction: v - Math.floor(v) }))
    .sort((a, b) => b.fraction - a.fraction);
  const result = [...floored];
  for (const entry of order) {
    if (remainder <= 0) break;
    result[entry.index] += 1;
    remainder -= 1;
  }
  return result;
}

const PRODUCT_LABEL: Readonly<Record<Product, string>> = { hoso: "HOSO", pd: "PD", vap: "VAP" };

/**
 * 人が編集する画面の初期ドラフトを、実行可能な範囲へ丸める。
 * 丸めなかった場合（既に範囲内）は draft をそのまま返し、adjustments は空になる。
 */
export function applyInitialDraftFeasibility(input: {
  readonly draft: CompanyDecisionDraft;
  readonly ownState: CompanyOwnState;
  readonly period: PeriodV2;
}): InitialDraftFeasibilityResult {
  const { ownState, period } = input;
  const salesCeilingByProduct = computeSalesCeilingByProduct(ownState);
  const capacity = computeEffectiveCapacityByProduct(ownState.effectiveFactories);
  const finishedGoods = computeAvailableFinishedGoodsByProduct(ownState);
  const backlog = computeBacklogByProduct(ownState);

  const adjustments: InitialDraftAdjustment[] = [];

  // --- 販売希望量：商品ごとに合計を上限へ収める（市場間は比例配分のまま） ---
  let salesPlans = input.draft.salesPlans;
  for (const product of SALES_PRODUCTS) {
    const indexes = salesPlans.map((row, index) => ({ row, index })).filter((e) => e.row.product === product);
    if (indexes.length === 0) continue;
    const values = indexes.map((e) => safe(e.row.desiredQuantity));
    const total = values.reduce((sum, v) => sum + v, 0);
    const cap = salesCeilingByProduct[product];
    if (total <= cap) continue;
    const next = scaleRowsToCap(values, cap);
    const updated = [...salesPlans];
    indexes.forEach((e, i) => {
      updated[e.index] = { ...e.row, desiredQuantity: next[i] };
    });
    salesPlans = updated;
    adjustments.push({
      field: "salesPlan",
      product,
      label: `${PRODUCT_LABEL[product]} の販売希望量（全市場の合計）`,
      proposedTons: total,
      adjustedTons: next.reduce((sum, v) => sum + v, 0),
      reason:
        `販売可能量の上限 ${Math.floor(cap).toLocaleString("en-US")} トン` +
        `（実効加工能力 ${Math.round(capacity[product]).toLocaleString("en-US")} ＋ 製品在庫 ${Math.round(safe(finishedGoods[product])).toLocaleString("en-US")}` +
        ` − 受注残 ${Math.round(safe(backlog[product])).toLocaleString("en-US")}）を超えていました。市場ごとの比率は変えずに縮めています。`,
    });
  }

  // --- 国内買付：生産計画 − 当期に使える原料 を上限にする ---
  const plannedProductionTotalTons = input.draft.productionPlans.reduce((sum, row) => sum + safe(row.desiredQuantity), 0);
  const available = buildAvailableRawMaterialThisQuarter(ownState.rawMaterialLots, ownState.companyId, period);
  const domesticPurchaseCeilingTons = Math.max(0, plannedProductionTotalTons - available.totalIncludingExpectedTons);
  let domesticPurchase = input.draft.domesticPurchase;
  const proposedDomestic = safe(domesticPurchase.desiredQuantity);
  if (proposedDomestic > domesticPurchaseCeilingTons) {
    const adjusted = Math.floor(domesticPurchaseCeilingTons);
    domesticPurchase = { ...domesticPurchase, desiredQuantity: adjusted };
    adjustments.push({
      field: "domesticPurchase",
      label: "国内買付の希望量",
      proposedTons: proposedDomestic,
      adjustedTons: adjusted,
      reason:
        `買い足す必要がある量の上限 ${adjusted.toLocaleString("en-US")} トン` +
        `（生産計画 ${Math.round(plannedProductionTotalTons).toLocaleString("en-US")} − 当期に使える原料 ${Math.round(available.totalIncludingExpectedTons).toLocaleString("en-US")}` +
        `：手持ち ${Math.round(available.carriedInventoryTons).toLocaleString("en-US")} ＋ 当期到着の輸入 ${Math.round(available.confirmedImportArrivalTons).toLocaleString("en-US")}` +
        ` ＋ 当期収穫の養殖 ${Math.round(available.expectedAquacultureHarvestTons).toLocaleString("en-US")}）を超えていました。`,
    });
  }

  const draft =
    adjustments.length === 0 ? input.draft : { ...input.draft, salesPlans, domesticPurchase };

  return { draft, adjustments, salesCeilingByProduct, domesticPurchaseCeilingTons };
}
