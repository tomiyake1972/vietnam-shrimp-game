// ShrimpX V2 — Procurement Planning: 生産計画と原料需給の関係（画面上段）
//
// 【この層がやること】
//   (A) Production Raw Requirement — 当期の生産計画を実行するために要る原料量
//   (B) Future Contract Obligations — 既存契約から見た将来の納品義務
//   (C) Available This Quarter — 当期に確実に使える原料（＝既に確定しているロットのみ）
// を、既存のstate・既存のpure functionから読み出して並べるだけの純粋関数群。
//
// 【新しいゲーム計算式を作らない】
//   - 必要原料量は「生産計画の単純合計」である。これはUIが決めた規約ではなく、
//     Standard AI 本体（standardAi/policy.ts）が
//       requiredRawMaterial = productionPlans.reduce((s, p) => s + desiredQuantity, 0)
//     として調達判断に渡しているのと**同一の式**である（歩留まり1.0基準）。
//   - 数量はすべてHOSO換算MT。PD÷0.54・VAP÷0.90 等の物理歩留まり換算は行わない。
//     production/yieldConversion.ts（参考情報専用・非永続）はこの層から一切呼ばない。
//   - 「当期に使える原料」の判定は、新しいavailabilityルールを作らず、既存の
//     RawMaterialLot.status と availableFromPeriod の分類をそのまま使う
//     （standardAi/observation.ts の availableRawMaterialQuantity /
//     certainInboundImportQuantityThisPeriod と同じ読み方）。
//
// 【(A) と (B) を絶対に足さないこと】
//   生産計画は受注残・納期を見たうえで作られる。したがって (B) を (A) へ加算すると
//   同じ納品義務を二重に数えることになる。(B) はTimeline横の参考情報として、
//   「先々の納品義務がどの四半期にどれだけあるか」を示すためだけに使う。

import { PeriodV2 } from "../../lib/v2/core/period";
import { unwrapUnit } from "../../lib/v2/core/units";
import { Product } from "../../lib/v2/market/types";
import { periodDifferenceInQuarters, periodLabel } from "../../lib/v2/companyLab/openingStateSummary";
import { summarizeRawMaterialRequirements } from "../../lib/v2/rawMaterials/requirements";
import { RawMaterialLot } from "../../lib/v2/rawMaterials/types";
import { SalesContract } from "../../lib/v2/sales/types";

export const PROCUREMENT_PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

/** undefined/null/NaN/負値を0として扱う（表示にNaNを出さないための唯一の場所）。 */
function safeTons(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

// ---------------------------------------------------------------------
// (A) Production Raw Requirement — 当期の生産計画を実行するための必要原料
// ---------------------------------------------------------------------

/**
 * 生産計画1行ぶんの、商品と希望数量だけを見る最小限の構造型。
 * ドラフト行（ProductionPlanDraftRow、プレーンnumber）とエンジン入力
 * （CompanyProductionPlanEntry、HosoEqTonsブランド型）のどちらでもそのまま渡せる。
 */
export interface ProductionPlanQuantityRow {
  readonly product: Product;
  readonly desiredQuantity: number;
}

export interface ProductionRawRequirement {
  /** 商品別の計画生産量（HOSO換算MT）。 */
  readonly plannedProductionByProduct: Readonly<Record<Product, number>>;
  /** 計画生産量の合計（HOSO換算MT）。 */
  readonly plannedProductionTotalTons: number;
  /**
   * 必要原料量（HOSO換算MT）。plannedProductionTotalTons と**常に同一の値**である
   * （歩留まり換算を挟まないことを、別フィールドとして明示するために持つ）。
   */
  readonly requiredRawMaterialTons: number;
}

/**
 * 生産計画（工場×商品の行）から、商品別・合計の計画生産量と必要原料量を求める。
 * 工場をまたいで同じ商品の行が複数あっても単純に合算する。
 */
export function buildProductionRawRequirement(rows: readonly ProductionPlanQuantityRow[]): ProductionRawRequirement {
  const plannedProductionByProduct: Record<Product, number> = { hoso: 0, pd: 0, vap: 0 };
  for (const row of rows) {
    plannedProductionByProduct[row.product] += safeTons(row.desiredQuantity);
  }
  const plannedProductionTotalTons = PROCUREMENT_PRODUCTS.reduce((sum, p) => sum + plannedProductionByProduct[p], 0);
  return {
    plannedProductionByProduct,
    plannedProductionTotalTons,
    // HOSO換算MTのまま、歩留まり換算を一切挟まない（HOSO+PD+VAPの単純合計）。
    requiredRawMaterialTons: plannedProductionTotalTons,
  };
}

// ---------------------------------------------------------------------
// (C) Available This Quarter — 当期に確実に使える原料
// ---------------------------------------------------------------------

export interface AvailableRawMaterialThisQuarter {
  /** 既に使用可能な在庫（status="available"）。 */
  readonly carriedInventoryTons: number;
  /** 当期に到着する輸送中輸入原料（status="inTransitImport" かつ到着予定が当期以前）。 */
  readonly arrivingImportTons: number;
  /** 当期に収穫される養殖分（status="growingAquaculture" かつ収穫予定が当期以前）。 */
  readonly harvestingAquacultureTons: number;
  /** 上記3つの合計＝当期に確実に使える原料。 */
  readonly totalTons: number;
  /**
   * 当期より後にしか使えないパイプライン（輸送中・養殖中の残り）。
   * totalTonsには含めない（当期の生産には使えないため）。
   */
  readonly pipelineBeyondThisQuarterTons: number;
}

/**
 * 当期に確実に使える原料量を、既存のロットstatus・availableFromPeriodだけから求める。
 *
 * 【当期の国内買付を含めない理由】国内買付は5社競争配分（rawMaterials/
 * domesticPurchase.ts の allocateDomesticPurchase）の結果で決まるため、
 * 意思決定時点では確定していない。ここに混ぜると「確実に使える量」の意味が壊れる。
 * 計画中の国内買付は Timeline 側で「計画（未確定）」として別枠に表示する。
 */
export function buildAvailableRawMaterialThisQuarter(
  lots: readonly RawMaterialLot[],
  companyId: string,
  currentPeriod: PeriodV2
): AvailableRawMaterialThisQuarter {
  let carriedInventoryTons = 0;
  let arrivingImportTons = 0;
  let harvestingAquacultureTons = 0;
  let pipelineBeyondThisQuarterTons = 0;

  for (const lot of lots) {
    if (lot.companyId !== companyId) continue;
    const quantity = safeTons(unwrapUnit(lot.remainingQuantity));
    if (quantity <= 0) continue;
    // 当期以前に使えるようになるか（負のオフセット＝既に到着済み扱い）。
    const isDueByNow = periodDifferenceInQuarters(currentPeriod, lot.availableFromPeriod) <= 0;

    if (lot.status === "available") {
      carriedInventoryTons += quantity;
    } else if (lot.status === "inTransitImport") {
      if (isDueByNow) arrivingImportTons += quantity;
      else pipelineBeyondThisQuarterTons += quantity;
    } else if (lot.status === "growingAquaculture") {
      if (isDueByNow) harvestingAquacultureTons += quantity;
      else pipelineBeyondThisQuarterTons += quantity;
    }
    // consumed / expired は当期の供給源ではないため無視する。
  }

  return {
    carriedInventoryTons,
    arrivingImportTons,
    harvestingAquacultureTons,
    totalTons: carriedInventoryTons + arrivingImportTons + harvestingAquacultureTons,
    pipelineBeyondThisQuarterTons,
  };
}

// ---------------------------------------------------------------------
// 画面上段のまとめ（Planned Production / Required Raw / Available / Shortage）
// ---------------------------------------------------------------------

export interface ProcurementRequirementViewModel {
  readonly requirement: ProductionRawRequirement;
  readonly available: AvailableRawMaterialThisQuarter;
  /** available.totalTons − requirement.requiredRawMaterialTons（負なら不足）。 */
  readonly balanceTons: number;
  /** 不足量（正の数。不足していなければ0）。 */
  readonly shortageTons: number;
  /** 余剰量（正の数。余剰でなければ0）。 */
  readonly surplusTons: number;
  readonly isShortage: boolean;
  /**
   * 必要原料量に対する充足率（available / required）。
   * 必要量が0のときは undefined（0除算の結果を捏造しない）。
   */
  readonly coverageRatio: number | undefined;
}

export interface BuildProcurementRequirementInput {
  readonly productionPlanRows: readonly ProductionPlanQuantityRow[];
  readonly rawMaterialLots: readonly RawMaterialLot[];
  readonly companyId: string;
  readonly currentPeriod: PeriodV2;
}

export function buildProcurementRequirementViewModel(input: BuildProcurementRequirementInput): ProcurementRequirementViewModel {
  const requirement = buildProductionRawRequirement(input.productionPlanRows);
  const available = buildAvailableRawMaterialThisQuarter(input.rawMaterialLots, input.companyId, input.currentPeriod);
  const balanceTons = available.totalTons - requirement.requiredRawMaterialTons;
  return {
    requirement,
    available,
    balanceTons,
    shortageTons: balanceTons < 0 ? -balanceTons : 0,
    surplusTons: balanceTons > 0 ? balanceTons : 0,
    isShortage: balanceTons < 0,
    coverageRatio: requirement.requiredRawMaterialTons > 0 ? available.totalTons / requirement.requiredRawMaterialTons : undefined,
  };
}

// ---------------------------------------------------------------------
// (B) Future Contract Obligations — 既存契約から見た将来の納品義務
// ---------------------------------------------------------------------

export interface FutureContractObligationEntry {
  readonly dueDate: PeriodV2;
  readonly dueDateLabel: string;
  /** currentPeriod からのオフセット（0=当期、1=Q+1、負=納期超過）。 */
  readonly quarterOffset: number;
  /** この納期の商品別未履行数量（HOSO換算MT）。 */
  readonly byProduct: Readonly<Record<Product, number>>;
  readonly totalTons: number;
  /** 納期が当期より前＝既に納期超過。 */
  readonly isOverdue: boolean;
}

export interface FutureContractObligations {
  /** 納期の昇順（納期超過ぶんが先頭）。 */
  readonly entries: readonly FutureContractObligationEntry[];
  readonly totalTons: number;
  readonly overdueTons: number;
}

/**
 * 既存契約の未履行数量を納期別に集計する。
 *
 * 集計そのものはエンジンの既存関数 summarizeRawMaterialRequirements
 * （rawMaterials/requirements.ts。四半期処理でも同じ関数が使われ、
 * CompanyQuarterRecord.rawMaterialRequirements として記録される）に委ね、
 * ここでは会社の絞り込みと納期別の並べ替え・ラベル付けだけを行う。
 *
 * 【重要】この値は「将来の納品義務」であり、当期の必要原料量（(A)）ではない。
 * 生産計画は受注残を見たうえで作られるため、(A) へ加算してはならない。
 */
export function buildFutureContractObligations(
  contracts: readonly SalesContract[],
  companyId: string,
  currentPeriod: PeriodV2
): FutureContractObligations {
  const ownContracts = contracts.filter((c) => c.companyId === companyId);
  const requirementEntries = summarizeRawMaterialRequirements(ownContracts);

  const byDueDate = new Map<PeriodV2, Record<Product, number>>();
  for (const entry of requirementEntries) {
    const bucket = byDueDate.get(entry.dueDate) ?? { hoso: 0, pd: 0, vap: 0 };
    bucket[entry.product] += safeTons(unwrapUnit(entry.requiredQuantity));
    byDueDate.set(entry.dueDate, bucket);
  }

  const entries: FutureContractObligationEntry[] = [...byDueDate.entries()]
    .map(([dueDate, byProduct]) => {
      const quarterOffset = periodDifferenceInQuarters(currentPeriod, dueDate);
      return {
        dueDate,
        dueDateLabel: periodLabel(dueDate),
        quarterOffset,
        byProduct,
        totalTons: PROCUREMENT_PRODUCTS.reduce((sum, p) => sum + byProduct[p], 0),
        isOverdue: quarterOffset < 0,
      };
    })
    .sort((a, b) => a.quarterOffset - b.quarterOffset);

  return {
    entries,
    totalTons: entries.reduce((sum, e) => sum + e.totalTons, 0),
    overdueTons: entries.filter((e) => e.isOverdue).reduce((sum, e) => sum + e.totalTons, 0),
  };
}
