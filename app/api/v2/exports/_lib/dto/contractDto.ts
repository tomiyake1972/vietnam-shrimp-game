// ShrimpX V2 — Export DTO / §2 契約ロールフォワード（期首→新規→履行→期末）
//
// 【このモジュールの位置づけ】
// exportDto.ts の設計方針（内部型をそのままspreadせず、許可フィールドを1つずつ
// 明示的に組み立てる）をそのまま引き継ぐ。exportDto.ts が本モジュールを
// import して re-export するため、利用側のimportパスは従来どおり
// `app/api/v2/exports/_lib/exportDto` のままで良い。
//
// 【データ源（すべて既存の確定履歴 CompanyLabQuarterHistoryEntry に保存済み）】
//   - 期首契約残高: entry.preProcessingStateSnapshot.contracts（SalesContract[]）
//   - 当期新規成約: entry.record.salesRecord.newContracts（SalesContract[]）
//   - 当期履行実績: entry.record.fulfillmentPlan.explicitInstructions[].quantity
//                   （契約ID単位の確定履行量。production/fulfillment.ts が算出し
//                     sales/backlog.ts の applyFulfillments へそのまま渡した値）
//   - 契約×完成品ロットの内訳: entry.record.fulfillmentPlan.usage
//   - 期末契約残高: entry.postProcessingStateSnapshot.contracts（SalesContract[]）
//
// 【再計算しない】保存済み確定値をそのまま転記するだけで、金額・差額・小計・
// 検算（期首＋新規−履行＝期末）は一切このDTOで計算しない。それらはExcel側の
// 数式（SUMIFS・差引）で組み立てる（三宅さんの指示：「保存済み確定値を再計算して
// 置き換えないでください」／xlsxスキル：「合計は数式で書きハードコードしない」）。

import { CompanyId, ContractCostSnapshot, SalesContract } from "../../../../../lib/v2/sales/types";
import { CompanyLabQuarterHistoryEntry } from "../../../../../lib/v2/companyLab/persistence/types";
import { FinishedGoodsUsageRecord } from "../../../../../lib/v2/production/types";
import { PeriodV2 } from "../../../../../lib/v2/core/period";

/** 契約時点の予想原価スナップショット（ContractCostSnapshot の許可項目）。 */
export interface ExportContractCostSnapshot {
  /** 契約時点で見込んだ原料価格（USD/HOSO換算kg）。 */
  readonly expectedRawMaterialPriceUsdPerHosoEqKg: number;
  /** 契約時点で見込んだ加工費（USD/HOSO換算kg）。 */
  readonly expectedProcessingCostUsdPerHosoEqKg: number;
  /** 受注可否判断に使った最低許容価格（USD/HOSO換算kg）。 */
  readonly minimumAcceptablePriceUsdPerHosoEqKg: number;
  /** 契約時点で見込んだ限界利益（USD/HOSO換算kg）。 */
  readonly expectedContributionMarginUsdPerHosoEqKg: number;
}

function buildExportContractCostSnapshot(snapshot: ContractCostSnapshot): ExportContractCostSnapshot {
  return {
    expectedRawMaterialPriceUsdPerHosoEqKg: snapshot.expectedRawMaterialPriceUsdPerHosoEqKg,
    expectedProcessingCostUsdPerHosoEqKg: snapshot.expectedProcessingCostUsdPerHosoEqKg,
    minimumAcceptablePriceUsdPerHosoEqKg: snapshot.minimumAcceptablePriceUsdPerHosoEqKg,
    expectedContributionMarginUsdPerHosoEqKg: snapshot.expectedContributionMarginUsdPerHosoEqKg,
  };
}

/**
 * 契約1件のロールフォワード明細。
 *
 * 期首残高・当期新規・当期履行・期末残高をすべて「保存済みの別の記録」から
 * 個別に転記しているため、Excel側で `期首 + 新規 - 履行 = 期末` を独立した
 * 検算式として組める（DTO内で差額を計算してしまうと検算にならない）。
 */
export interface ExportSalesContract {
  readonly contractId: string;
  readonly companyId: CompanyId;
  /** 需要市場（CN/US/EU/JP/OTHER）。 */
  readonly market: string;
  /** 商品区分（hoso/pd/vap）。 */
  readonly product: string;
  /** 成約四半期。 */
  readonly contractedPeriod: PeriodV2;
  /** 納期。 */
  readonly dueDate: PeriodV2;
  /** 当初契約数量（HOSO換算トン）。 */
  readonly originalQuantity: number;
  /** 成約単価（USD/HOSO換算kg）。 */
  readonly unitPrice: number;
  /**
   * 期首（当四半期処理前）の未履行数量（HOSO換算トン）。
   * 当期新規成約の契約は期首に存在しないため 0。
   */
  readonly beginningOutstandingQuantity: number;
  /**
   * 当期新規成約数量（HOSO換算トン）。salesRecord.newContracts に含まれる契約は
   * その originalQuantity をそのまま転記し、既存契約は 0。
   */
  readonly newContractedQuantity: number;
  /**
   * 当期履行数量（HOSO換算トン）。fulfillmentPlan.explicitInstructions の
   * 当該契約ID分の保存値（同一契約IDの指示は1件に集約済み）。
   */
  readonly fulfilledQuantity: number;
  /** 期末（当四半期処理後）の未履行数量（HOSO換算トン）。 */
  readonly endingOutstandingQuantity: number;
  /** 期末時点のステータス。期末スナップショットに存在しない場合のみ期首時点のステータス。 */
  readonly status: string;
  /** 期首時点のステータス（当期新規成約の契約は null）。 */
  readonly statusAtBeginning: string | null;
  /** 期首スナップショットに存在したか。 */
  readonly existsAtBeginning: boolean;
  /** 期末スナップショットに存在するか。 */
  readonly existsAtEnd: boolean;
  /** 当期新規成約か（salesRecord.newContracts に含まれるか）。 */
  readonly isNewThisQuarter: boolean;
  /** 延滞契約か（期末ステータスが overdue か）。 */
  readonly isOverdueAtEnd: boolean;
  /** 契約時点の予想原価スナップショット（保存されていない契約は null）。 */
  readonly costSnapshot: ExportContractCostSnapshot | null;
}

/** 契約×完成品ロット単位の履行内訳（FinishedGoodsUsageRecord の許可項目）。 */
export interface ExportContractFulfillmentUsage {
  readonly contractId: string;
  readonly companyId: CompanyId;
  readonly product: string;
  readonly lotId: string;
  /** この契約へ充当した数量（HOSO換算トン）。 */
  readonly quantity: number;
}

function buildExportContractFulfillmentUsage(usage: FinishedGoodsUsageRecord): ExportContractFulfillmentUsage {
  return {
    contractId: usage.contractId,
    companyId: usage.companyId,
    product: usage.product,
    lotId: usage.lotId,
    quantity: usage.quantity,
  };
}

/** 契約IDごとの当期履行量（保存済みの explicitInstructions をそのまま索引化するだけ）。 */
function indexFulfilledQuantityByContractId(entry: CompanyLabQuarterHistoryEntry): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  for (const instruction of entry.record.fulfillmentPlan.explicitInstructions) {
    // 同一契約IDは fulfillment.ts 側で既に1件へ集約されているが、将来の
    // 複数指示にも耐えるよう加算しておく（保存値の合算であり再計算ではない）。
    map.set(instruction.contractId, (map.get(instruction.contractId) ?? 0) + instruction.quantity);
  }
  return map;
}

function indexContractsById(contracts: readonly SalesContract[]): ReadonlyMap<string, SalesContract> {
  const map = new Map<string, SalesContract>();
  for (const contract of contracts) map.set(contract.contractId, contract);
  return map;
}

/**
 * 当該四半期の契約ロールフォワード明細を組み立てる。
 *
 * 期首・期末・当期新規のいずれかに登場した契約IDをすべて対象にする
 * （期首にあって期末で消えた契約、当期成約して当期中に全量履行した契約も
 * 取りこぼさない）。companyId で絞る場合は scopedCompanyId を渡す。
 */
export function buildExportSalesContractRollforward(
  entry: CompanyLabQuarterHistoryEntry,
  scopedCompanyId?: CompanyId,
): readonly ExportSalesContract[] {
  const beginning = indexContractsById(entry.preProcessingStateSnapshot.contracts);
  const ending = indexContractsById(entry.postProcessingStateSnapshot.contracts);
  const created = indexContractsById(entry.record.salesRecord.newContracts);
  const fulfilledByContractId = indexFulfilledQuantityByContractId(entry);

  const contractIds = new Set<string>([...beginning.keys(), ...created.keys(), ...ending.keys()]);

  const rows: ExportSalesContract[] = [];
  for (const contractId of contractIds) {
    // 契約の識別情報（会社・市場・商品・納期・単価）は、期末→期首→新規の順で
    // 存在するレコードから採る（同一契約IDなら識別情報は同一である）。
    const anyRecord = ending.get(contractId) ?? beginning.get(contractId) ?? created.get(contractId);
    if (!anyRecord) continue;
    if (scopedCompanyId !== undefined && anyRecord.companyId !== scopedCompanyId) continue;

    const beginningRecord = beginning.get(contractId) ?? null;
    const endingRecord = ending.get(contractId) ?? null;
    const createdRecord = created.get(contractId) ?? null;
    const statusRecord = endingRecord ?? beginningRecord ?? createdRecord;
    const costSnapshot = (endingRecord ?? createdRecord ?? beginningRecord)?.costSnapshot;

    rows.push({
      contractId: anyRecord.contractId,
      companyId: anyRecord.companyId,
      market: anyRecord.market,
      product: anyRecord.product,
      contractedPeriod: anyRecord.contractedPeriod,
      dueDate: anyRecord.dueDate,
      originalQuantity: anyRecord.originalQuantity,
      unitPrice: anyRecord.unitPrice,
      beginningOutstandingQuantity: beginningRecord ? beginningRecord.outstandingQuantity : 0,
      newContractedQuantity: createdRecord ? createdRecord.originalQuantity : 0,
      fulfilledQuantity: fulfilledByContractId.get(contractId) ?? 0,
      endingOutstandingQuantity: endingRecord ? endingRecord.outstandingQuantity : 0,
      status: statusRecord ? statusRecord.status : "",
      statusAtBeginning: beginningRecord ? beginningRecord.status : null,
      existsAtBeginning: beginningRecord !== null,
      existsAtEnd: endingRecord !== null,
      isNewThisQuarter: createdRecord !== null,
      isOverdueAtEnd: endingRecord !== null && endingRecord.status === "overdue",
      costSnapshot: costSnapshot ? buildExportContractCostSnapshot(costSnapshot) : null,
    });
  }

  // 出力順を決定的にする（同じ確定履歴から再生成して結果が一致すること＝完了条件）。
  return rows.sort((a, b) => {
    if (a.companyId !== b.companyId) return a.companyId.localeCompare(b.companyId);
    if (a.dueDate !== b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    return a.contractId.localeCompare(b.contractId);
  });
}

/** 指定会社の契約ロールフォワード明細（会社スコープAPI用）。 */
export function buildExportSalesContractsForCompany(
  entry: CompanyLabQuarterHistoryEntry,
  companyId: CompanyId,
): readonly ExportSalesContract[] {
  return buildExportSalesContractRollforward(entry, companyId);
}

/** 指定会社の契約×完成品ロット履行内訳（会社スコープAPI用。usageはcompanyIdを持つ）。 */
export function buildExportContractFulfillmentUsageForCompany(
  entry: CompanyLabQuarterHistoryEntry,
  companyId: CompanyId,
): readonly ExportContractFulfillmentUsage[] {
  return entry.record.fulfillmentPlan.usage
    .filter((u) => u.companyId === companyId)
    .map(buildExportContractFulfillmentUsage)
    .sort((a, b) => (a.contractId !== b.contractId ? a.contractId.localeCompare(b.contractId) : a.lotId.localeCompare(b.lotId)));
}

/** 全社の契約×完成品ロット履行内訳（GMフルスコープのみ）。 */
export function buildExportContractFulfillmentUsageAllCompanies(
  entry: CompanyLabQuarterHistoryEntry,
): readonly ExportContractFulfillmentUsage[] {
  return entry.record.fulfillmentPlan.usage
    .map(buildExportContractFulfillmentUsage)
    .sort((a, b) => {
      if (a.companyId !== b.companyId) return a.companyId.localeCompare(b.companyId);
      if (a.contractId !== b.contractId) return a.contractId.localeCompare(b.contractId);
      return a.lotId.localeCompare(b.lotId);
    });
}
