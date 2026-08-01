// ShrimpX V2 — 財務モジュール 会社ラボ実績アダプター（Phase 8A）
//
// 会社ラボの1四半期処理（advanceCompanyLabQuarter）が既に算出した実績データから、
// 財務決算（closeFinancialQuarter）への入力（CompanyQuarterBusinessActuals）を
// 抽出する。ここで行ってよいのは「抽出・フィルタ・金額換算（money.ts経由）」だけで、
// 販売量・生産量・廃棄量・価格の再計算は一切行わない。
//
// 依存方向: finance → production/rawMaterials/sales/quality（既存Phaseの型のみ）。
// companyLabの型には依存しない（companyLab側がfinanceを呼び出すため、循環を避ける）。

import { PeriodV2 } from "../core/period";
import { unwrapUnit } from "../core/units";
import { BatchQualityAdjustment } from "../quality/types";
import { RawMaterialLot } from "../rawMaterials/types";
import { CompanyId, SalesContract } from "../sales/types";
import { FinishedGoodsLot, FinishedGoodsUsageRecord, ProductionAllocationEntry, ProductionBatch, WorkerAssignment } from "../production/types";
import { amountFromTonsAndUnitPrice } from "./money";
import { rawMaterialInventoryValueUsd } from "./initialState";
import {
  CompanyQuarterBusinessActuals,
  ContractTermActual,
  FulfillmentUsageActual,
  ProductionBatchActual,
  resolveLaborAllocationMode,
} from "./quarterClose";
import { FinanceValidationError } from "./types";

/** アダプターへの入力（会社ラボの1四半期処理内で入手可能な実績データの参照一式）。 */
export interface CompanyActualsSource {
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  /** 当期の契約×完成品ロットの使用内訳（fulfillmentPlan.usage。全社ぶんでよい）。 */
  readonly usage: readonly FinishedGoodsUsageRecord[];
  /** 当期末時点の全契約（turnResult.contracts。履行に使われた契約の条件参照用）。 */
  readonly contracts: readonly SalesContract[];
  /** 当期の品質調整後バッチ（record.batches）。 */
  readonly adjustedBatches: readonly ProductionBatch[];
  /**
   * 【商品別実労務配分（feature/v2-labor-cost-allocation-bridge）】
   * 当期の生産配分結果（productionRecord.allocation.entries、全社ぶんでよい）。
   * companyId+factoryId+productで対応するadjustedBatchesの各要素へ、実配分常用/臨時ワーカー
   * 人数・適用残業率を結合するために使う。省略時（undefined）は既存呼び出し元との後方互換のため、
   * ProductionBatchActualの労務3項目を一切付与せず、finance層は従来の数量シェア按分へ
   * フォールバックする。
   */
  readonly productionAllocationEntries?: readonly ProductionAllocationEntry[];
  /** 当期の品質調整結果（record.qualityAdjustments）。 */
  readonly qualityAdjustments: readonly BatchQualityAdjustment[];
  /** 当期の新規完成品ロット（品質情報つき）。 */
  readonly newFinishedGoodsLots: readonly FinishedGoodsLot[];
  /** 原料ロットの全量（turnResult.lots。消費済み含む。調達源泉の参照用）。 */
  readonly allRawMaterialLotsAfterTurn: readonly RawMaterialLot[];
  readonly newImportLots: readonly RawMaterialLot[];
  readonly harvestedLots: readonly RawMaterialLot[];
  /** 期首の原料ロット（state.rawMaterialLots）。 */
  readonly rawMaterialLotsAtStart: readonly RawMaterialLot[];
  /** 期末の原料ロット（生産消費適用後のupdatedRawMaterialLots）。 */
  readonly rawMaterialLotsAtEnd: readonly RawMaterialLot[];
  /**
   * 契約充当消費の適用前（品質調整後・当四半期の期限切れ処理より前）の完成品ロット
   * （companyLab/runner.tsのlotsAfterProduction）。実消費差分の算出に使う。
   *
   * 【fix/v2-procurement-mix-after-emergency-maturity】期限切れ処理は当四半期の
   * 契約充当消費より後に適用する（quarterClose = 「当四半期分の消費が終わった後、
   * 未使用のまま残った在庫だけが期限切れになる」という順序）。そのため
   * ここは期限切れ処理"後"ではなく"前"のスナップショットになる。
   */
  readonly finishedGoodsLotsBeforeConsumption: readonly FinishedGoodsLot[];
  /** 期末の完成品ロット（契約充当消費後）。 */
  readonly finishedGoodsLotsAtEnd: readonly FinishedGoodsLot[];
  /** 当社の当期ワーカー配置（decisions.workerAssignments）。 */
  readonly workerAssignments: readonly WorkerAssignment[];
  /** 当社の適用残業率（companyLoadMetrics.overtimeRate。生産がない場合は0）。 */
  readonly appliedOvertimeRate: number;
  readonly activeFactoryCount: number;
  readonly salesForceHeadcount: number;
  /**
   * 【営業人員の減員・退職金・forward-port続き】当期に実際に減員される営業人員数
   * （前期末人数で頭打ち済み、companyLab/salesForceHiring.ts
   * computeEffectiveSalesForceLayoffCount参照）。1人あたり四半期給与2四半期分の
   * 退職金を当期に一度だけ費用・支出計上するための人数。省略時（undefined）は
   * 既存呼び出し元との後方互換のため0として扱う。
   */
  readonly salesForceSeveranceCount?: number;
  readonly procurementHeadcount: number;
}

/** ロット一覧の金額合計（Σ 残数量×取得単価×1,000）。 */
function lotsValueUsd(lots: readonly RawMaterialLot[], companyId: CompanyId): number {
  let total = 0;
  for (const lot of lots) {
    if (lot.companyId !== companyId) continue;
    total += amountFromTonsAndUnitPrice(lot.remainingQuantity, lot.unitCost) as number;
  }
  return total;
}

export function buildCompanyQuarterBusinessActuals(src: CompanyActualsSource): CompanyQuarterBusinessActuals {
  const { companyId, period } = src;

  // --- 履行実績と契約条件 ---
  const companyUsage = src.usage.filter((u) => u.companyId === companyId);
  const fulfillmentUsage: FulfillmentUsageActual[] = companyUsage.map((u) => ({
    contractId: u.contractId,
    lotId: u.lotId,
    product: u.product,
    quantityTons: unwrapUnit(u.quantity),
  }));
  const usedContractIds = new Set(companyUsage.map((u) => u.contractId));
  const contractTerms: ContractTermActual[] = src.contracts
    .filter((c) => usedContractIds.has(c.contractId))
    .map((c) => ({
      contractId: c.contractId,
      market: c.market,
      product: c.product,
      unitPriceUsdPerKg: unwrapUnit(c.unitPrice),
    }));

  // --- 原料ロットの調達源泉参照（消費エントリのlotId → source） ---
  const rawLotById = new Map<string, RawMaterialLot>();
  for (const lot of src.rawMaterialLotsAtStart) rawLotById.set(lot.lotId, lot);
  for (const lot of src.allRawMaterialLotsAfterTurn) rawLotById.set(lot.lotId, lot);
  for (const lot of src.rawMaterialLotsAtEnd) rawLotById.set(lot.lotId, lot);

  // --- 生産バッチ実績（品質調整・原料原価・完成品ロット対応） ---
  const adjustmentByBatchId = new Map(src.qualityAdjustments.map((a) => [a.batchId, a]));
  const lotByFactoryProduct = new Map<string, FinishedGoodsLot>();
  for (const lot of src.newFinishedGoodsLots) {
    if (lot.companyId !== companyId) continue;
    lotByFactoryProduct.set(`${lot.factoryId}::${lot.product}`, lot);
  }

  // --- 【商品別実労務配分】productionAllocationEntriesを当社ぶんへ絞り込み、factoryId::product
  // をキーとする参照テーブルを作る。現行の意思決定仕様では1社1商品につき生産計画は1件のみのため
  // このキーは一意になるはずだが、将来複数工場・複数計画対応が入った場合に黙って先頭要素を使う
  // ことのないよう、重複キーは明示的にエラーとする。
  const laborEntryByFactoryProduct = new Map<string, ProductionAllocationEntry>();
  if (src.productionAllocationEntries !== undefined) {
    for (const e of src.productionAllocationEntries) {
      if (e.companyId !== companyId) continue;
      const key = `${e.factoryId}::${e.product}`;
      if (laborEntryByFactoryProduct.has(key)) {
        throw new FinanceValidationError(
          `会社 ${companyId} の生産配分エントリに factoryId+product の重複があります（${key}）。1社1商品につき生産計画は1件である前提が崩れています。`
        );
      }
      laborEntryByFactoryProduct.set(key, e);
    }
  }

  // 【商品別実労務配分】productionAllocationEntriesを結合する場合、adjustedBatches側に
  // factoryId+productが重複するバッチが2件以上あると、両方が同じlaborEntryByFactoryProduct
  // の1エントリを参照してしまい、同じ実配属人数が2バッチぶん二重に計上される
  // （resolveLaborAllocationMode/computeProductionCostingの合計配属人数が水増しされ、
  // 商品別配分シェアの分母が狂う）。現行の意思決定仕様では1社1商品につき生産バッチは
  // 1件のみのはずだが、これも将来の複数工場・複数計画対応や上流の不具合に備え、
  // 労務データを結合する経路でのみ明示的に検出する。
  if (src.productionAllocationEntries !== undefined) {
    const seenBatchKeys = new Set<string>();
    for (const b of src.adjustedBatches) {
      if (b.companyId !== companyId) continue;
      const key = `${b.factoryId}::${b.product}`;
      if (seenBatchKeys.has(key)) {
        throw new FinanceValidationError(
          `会社 ${companyId} の生産バッチに factoryId+product の重複があります（${key}）。1社1商品につき生産バッチは1件である前提が崩れており、同じ生産配分エントリの実労務データが複数バッチへ二重に結合されてしまいます。`
        );
      }
      seenBatchKeys.add(key);
    }
  }

  const batches: ProductionBatchActual[] = src.adjustedBatches
    .filter((b) => b.companyId === companyId)
    .map((b) => {
      const adjustment = adjustmentByBatchId.get(b.batchId);
      const adjustedTons = unwrapUnit(b.finishedGoodsQuantity);
      const originalTons = adjustment ? unwrapUnit(adjustment.originalFinishedGoodsQuantity) : adjustedTons;
      const discardTons = adjustment ? unwrapUnit(adjustment.discardQuantity) : 0;
      const reworkTons = adjustment ? unwrapUnit(adjustment.reworkQuantity) : 0;
      const downgradeTons = adjustment ? unwrapUnit(adjustment.downgradeQuantity) : 0;

      let domestic = 0;
      let imported = 0;
      let aquaculture = 0;
      for (const consumption of b.rawMaterialConsumed) {
        const amount = amountFromTonsAndUnitPrice(consumption.quantity, consumption.unitCost) as number;
        const lot = rawLotById.get(consumption.lotId);
        if (!lot) {
          throw new FinanceValidationError(`生産バッチの消費原料ロットが見つかりません: ${consumption.lotId}（batch ${b.batchId}）`);
        }
        if (lot.source === "domestic") domestic += amount;
        else if (lot.source === "import") imported += amount;
        else aquaculture += amount;
      }
      const rawMaterialCostUsd = domestic + imported + aquaculture;

      const lot = lotByFactoryProduct.get(`${b.factoryId}::${b.product}`);
      const downgradeRatio =
        lot?.qualityInfo?.downgradeRatio !== undefined
          ? unwrapUnit(lot.qualityInfo.downgradeRatio)
          : adjustedTons > 1e-9
            ? downgradeTons / adjustedTons
            : 0;

      // 【商品別実労務配分】productionAllocationEntriesが渡されている場合のみ、対応する
      // labor情報（実配分常用/臨時ワーカー人数・適用残業率）を結合する。省略時は3項目とも
      // 付与せず、finance層側のフォールバック（従来の数量シェア按分）に委ねる。
      let laborFields: Pick<ProductionBatchActual, "assignedRegularHeadcount" | "assignedTemporaryHeadcount" | "appliedOvertimeRate"> = {};
      if (src.productionAllocationEntries !== undefined) {
        const key = `${b.factoryId}::${b.product}`;
        const entry = laborEntryByFactoryProduct.get(key);
        if (!entry) {
          throw new FinanceValidationError(
            `生産バッチ ${b.batchId}（${key}）に対応する生産配分エントリ（productionAllocationEntries）が見つかりません。productionRecord.allocation.entriesをそのまま渡してください。`
          );
        }
        laborFields = {
          assignedRegularHeadcount: entry.labor.assignedRegularHeadcount,
          assignedTemporaryHeadcount: entry.labor.assignedTemporaryHeadcount,
          appliedOvertimeRate: unwrapUnit(entry.labor.appliedOvertimeRate),
        };
      }

      return {
        batchId: b.batchId,
        factoryId: b.factoryId,
        product: b.product,
        originalTons,
        adjustedTons,
        discardTons,
        reworkTons,
        downgradeTons,
        rawMaterialCostUsd,
        rawMaterialCostBySourceUsd: { domestic, imported, aquaculture },
        lotId: lot?.lotId,
        downgradeRatio,
        ...laborFields,
      };
    });

  // 【商品別実労務配分】組み立てた labor 3項目（assignedRegularHeadcount等）が
  // 「全バッチで3つとも揃っているか、3つとも無いか」の一貫した状態であることを、
  // ここで検証しておく（quarterClose.ts側の会計計算がこのデータを使う前に、アダプター
  // 自身の組み立てミスを早期に検出するため。resolveLaborAllocationModeは純粋関数で
  // 副作用を持たず、ここでの呼び出しはvalidationのみが目的。戻り値のmodeはまだ
  // 会計計算には使われない）。
  resolveLaborAllocationMode(batches);

  // --- 当期の原料購買（実ロット準拠） ---
  // 初期フィクスチャの原料ロットはsource="domestic"・inboundPeriod=開始四半期で
  // 作られるため、「当期の新規購入」判定はinboundPeriodだけでは不十分。期首時点で
  // 既に存在していたロットを除外し、当期に新規発生したロットだけを仕入として認識する
  // （期首在庫と仕入の二重計上を構造的に防ぐ）。
  const lotIdsAtStart = new Set(src.rawMaterialLotsAtStart.map((lot) => lot.lotId));
  const newDomesticLots = src.allRawMaterialLotsAfterTurn.filter(
    (lot) => lot.companyId === companyId && lot.source === "domestic" && lot.inboundPeriod === period && !lotIdsAtStart.has(lot.lotId)
  );
  const domesticPurchasesUsd = newDomesticLots.reduce(
    (s, lot) => s + (amountFromTonsAndUnitPrice(lot.originalQuantity, lot.unitCost) as number),
    0
  );
  const importOrdersUsd = src.newImportLots
    .filter((lot) => lot.companyId === companyId)
    .reduce((s, lot) => s + (amountFromTonsAndUnitPrice(lot.originalQuantity, lot.unitCost) as number), 0);
  const aquacultureHarvestUsd = lotsValueUsd(
    src.harvestedLots.filter((lot) => lot.companyId === companyId),
    companyId
  );

  // --- 労務 ---
  const companyAssignments = src.workerAssignments.filter((w) => w.companyId === companyId);
  const regularHeadcount = companyAssignments.reduce((s, w) => s + w.regularHeadcount, 0);
  const temporaryHeadcount = companyAssignments.reduce((s, w) => s + w.temporaryHeadcount, 0);

  return {
    companyId,
    period,
    fulfillmentUsage,
    contractTerms,
    batches,
    regularHeadcount,
    temporaryHeadcount,
    appliedOvertimeRate: src.appliedOvertimeRate,
    activeFactoryCount: src.activeFactoryCount,
    salesForceHeadcount: src.salesForceHeadcount,
    salesForceSeveranceCount: src.salesForceSeveranceCount ?? 0,
    procurementHeadcount: src.procurementHeadcount,
    domesticPurchasesUsd,
    importOrdersUsd,
    aquacultureHarvestUsd,
    rawMaterialInventoryBeginUsd: rawMaterialInventoryValueUsd(src.rawMaterialLotsAtStart, companyId),
    rawMaterialInventoryEndUsd: rawMaterialInventoryValueUsd(src.rawMaterialLotsAtEnd, companyId),
    lotConsumption: buildLotConsumption(src, companyId),
    finishedGoodsRemainingByLot: src.finishedGoodsLotsAtEnd
      .filter((lot) => lot.companyId === companyId)
      .map((lot) => ({
        lotId: lot.lotId,
        remainingQuantityTons: unwrapUnit(lot.remainingQuantity),
        expired: lot.status === "expired",
      })),
  };
}

/**
 * 完成品ロット別の実消費数量（契約充当消費の適用前後の実ロット残数量の差分）。
 * fulfillmentPlan.usageのロット割付は計画時点のもので、期限切れ処理・
 * 会社×商品単位の集約FIFO消費により、実際にどのロットから引き当てられたかとは
 * ロット単位でずれうる。COGSの原価流出は必ずこの実差分に基づいて認識する。
 */
function buildLotConsumption(src: CompanyActualsSource, companyId: CompanyId): readonly { lotId: string; quantityTons: number }[] {
  const afterById = new Map(src.finishedGoodsLotsAtEnd.filter((l) => l.companyId === companyId).map((l) => [l.lotId, l]));
  const result: { lotId: string; quantityTons: number }[] = [];
  for (const before of src.finishedGoodsLotsBeforeConsumption) {
    if (before.companyId !== companyId) continue;
    if (before.status === "expired") continue; // 期限切れロットは消費対象外（在庫廃棄損として別途認識）
    const after = afterById.get(before.lotId);
    const beforeQty = unwrapUnit(before.remainingQuantity);
    const afterQty = after ? unwrapUnit(after.remainingQuantity) : 0;
    const consumed = beforeQty - afterQty;
    if (consumed > 1e-9) {
      result.push({ lotId: before.lotId, quantityTons: consumed });
    }
  }
  return result;
}
