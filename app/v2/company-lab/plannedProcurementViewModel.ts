// ShrimpX V2 — Procurement Planning: Raw Material Timelineの「Planned」層
//
// 【目的】当期のdraft入力（国内買付希望・輸入発注・養殖池入れ計画）を、
// rawMaterialTimelineViewModel.ts のConfirmed/Expected層と同じTimelineRow形状で
// 表示できるようにする。既存のavailability/bucket分類ルール（toTimelineBucketKey）を
// そのまま再利用し、新しいバケット規則は作らない。
//
// 【この層が意味しないこと（重要）】
//   - draft.domesticPurchase.desiredQuantity は「確定した国内買付量」ではない。
//     国内原料市場は5社競争配分（rawMaterials/domesticPurchase.ts の
//     allocateDomesticPurchase）で決まるため、この画面の時点では希望量に過ぎない。
//   - draft.importOrders[].orderedQuantity も「確定した輸入量」ではない。
//     原産国別供給上限に対する水位法配分（rawMaterials/imports.ts の
//     createImportLots）で満額通らない可能性がある。
//   - draft.aquacultureStockingPlans[0].plannedStockingQuantity から求めた
//     期待生産量（calculateExpectedProduction）も、疾病圧力適用前の値であり、
//     実際の収穫量ではない。
// これらはすべて certainty="planned" として扱い、Confirmed/Expectedの合計へは
// 一切混入しない（呼び出し側でtimeline.confirmedTotalTons等と別に保持すること）。

import { PeriodV2, nextPeriod } from "../../lib/v2/core/period";
import { CountryId } from "../../lib/v2/market/types";
import {
  emptyTimelineBucketMap,
  TimelineBucketKey,
  TimelineRow,
  TIMELINE_BUCKET_KEYS,
  toTimelineBucketKey,
} from "./rawMaterialTimelineViewModel";

function safeTons(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function singleBucketRow(rowKey: string, label: string, bucket: TimelineBucketKey, tons: number): TimelineRow {
  const byBucket = emptyTimelineBucketMap();
  byBucket[bucket] = { bucket, tons, lotCount: tons > 0 ? 1 : 0 };
  return { rowKey, label, certainty: "planned", byBucket, totalTons: tons };
}

/**
 * 国内買付希望のPlanned行（常に当期バケット。国内買付は成約と同時に即時利用可能になる
 * ため、rawMaterialTimelineViewModel.ts の domesticProcurement 行と同じ「輸送中の中間
 * 状態を持たない」規約に従う。ただしこちらは競争配分**前**の希望量である点が異なる）。
 */
export function buildPlannedDomesticRow(desiredQuantityTons: number): TimelineRow {
  return singleBucketRow("domesticPlanned", "国内買付・希望量（Domestic, Planned — 競争配分前）", "current", safeTons(desiredQuantityTons));
}

export interface PlannedImportOrderInput {
  readonly originCountry: CountryId;
  readonly orderedQuantityTons: number;
  readonly leadTimeTurns: number | undefined;
}

/**
 * 輸入発注1件ぶんの到着予定バケットを求める（leadTimeTurns未入力時はstandardLeadTimeTurnsへ
 * フォールバック）。rawMaterials/imports.ts の resolveArrivalPeriod と同じ
 * 「nextPeriodをleadTimeTurns回適用する」規約をそのまま使う（新しい期日計算式ではない）。
 * buildPlannedImportRowsと、Import Procurement SectionのExpected Arrival Quarter表示
 * （数量を持たない単発の入力欄の横に出すだけの表示）の両方から呼ぶ、単一の情報源。
 */
export function resolveImportArrivalBucket(currentPeriod: PeriodV2, leadTimeTurns: number | undefined, standardLeadTimeTurns: number): TimelineBucketKey {
  const resolvedLeadTimeTurns = leadTimeTurns !== undefined && leadTimeTurns >= 1 ? Math.round(leadTimeTurns) : standardLeadTimeTurns;
  let arrivalPeriod = currentPeriod;
  for (let i = 0; i < resolvedLeadTimeTurns; i++) arrivalPeriod = nextPeriod(arrivalPeriod);
  return toTimelineBucketKey(currentPeriod, arrivalPeriod);
}

/**
 * 輸入発注のPlanned行（原産国ごとに1行。到着予定バケットはresolveImportArrivalBucketへ委譲する）。
 */
export function buildPlannedImportRows(
  orders: readonly PlannedImportOrderInput[],
  currentPeriod: PeriodV2,
  standardLeadTimeTurns: number
): readonly TimelineRow[] {
  return orders
    .filter((o) => safeTons(o.orderedQuantityTons) > 0)
    .map((o) => {
      const bucket = resolveImportArrivalBucket(currentPeriod, o.leadTimeTurns, standardLeadTimeTurns);
      return singleBucketRow(
        `importPlanned-${o.originCountry}`,
        `輸入発注・${o.originCountry}（Import, Planned — 供給上限適用前）`,
        bucket,
        safeTons(o.orderedQuantityTons)
      );
    });
}

/**
 * 養殖池入れのPlanned行（常にQ+1バケット。draftのAquacultureStockingDraftは収穫期を
 * 選択できず、rawMaterials/types.ts の AquacultureStockingPlanEntry.harvestPeriod省略時
 * 規約＝「池入れの翌四半期」に従う。expectedProductionTonsは呼び出し側が既存の
 * calculateExpectedProduction（rawMaterials/aquaculture.ts）で算出した値をそのまま渡す
 * ＝ここで歩留まり・疾病圧力の計算式を複製しない）。
 */
export function buildPlannedAquacultureRow(expectedProductionTons: number | undefined, currentPeriod: PeriodV2): TimelineRow | null {
  if (expectedProductionTons === undefined || safeTons(expectedProductionTons) <= 0) return null;
  const harvestPeriod = nextPeriod(currentPeriod);
  const bucket = toTimelineBucketKey(currentPeriod, harvestPeriod);
  return singleBucketRow(
    "aquaculturePlanned",
    "養殖池入れ・期待生産量（Aquaculture, Planned — 疾病圧力適用前）",
    bucket,
    safeTons(expectedProductionTons)
  );
}

export type PlannedProcurementSource = "domestic" | "import" | "aquaculture";

export interface PlannedProcurementBySourceEntry {
  readonly source: PlannedProcurementSource;
  readonly quantityTons: number;
  /** 3source合計に対するシェア（0〜1）。合計が0のときは0。 */
  readonly shareOfTotal: number;
}

const PLANNED_SOURCES: readonly PlannedProcurementSource[] = ["domestic", "import", "aquaculture"];

function classifyPlannedRowSource(rowKey: string): PlannedProcurementSource | null {
  if (rowKey === "domesticPlanned") return "domestic";
  if (rowKey.startsWith("importPlanned-")) return "import";
  if (rowKey === "aquaculturePlanned") return "aquaculture";
  return null;
}

/**
 * Planned行（buildPlannedDomesticRow/buildPlannedImportRows/buildPlannedAquacultureRowが
 * 返したrowKeyの命名規約をそのまま使う）を国内・輸入・養殖の3source別に集計する。
 * rowKeyの命名規約自体を複製せず、既に付与済みのrowKeyから分類するだけ。
 */
export function summarizePlannedProcurementBySource(rows: readonly TimelineRow[]): readonly PlannedProcurementBySourceEntry[] {
  const totals = new Map<PlannedProcurementSource, number>(PLANNED_SOURCES.map((s) => [s, 0]));
  for (const row of rows) {
    const source = classifyPlannedRowSource(row.rowKey);
    if (source === null) continue;
    totals.set(source, (totals.get(source) ?? 0) + row.totalTons);
  }
  const grandTotal = Array.from(totals.values()).reduce((sum, v) => sum + v, 0);
  return PLANNED_SOURCES.map((source) => {
    const quantityTons = totals.get(source) ?? 0;
    return { source, quantityTons, shareOfTotal: grandTotal > 0 ? quantityTons / grandTotal : 0 };
  });
}

export interface PlannedProcurementSummary {
  readonly rows: readonly TimelineRow[];
  readonly totalTons: number;
  readonly totalByBucket: Readonly<Record<TimelineBucketKey, number>>;
  readonly bySource: readonly PlannedProcurementBySourceEntry[];
}

/** 3種のPlanned行をまとめ、バケット別合計・source別内訳も添えて返す（表示・Auto Calc Panel双方で使う）。 */
export function buildPlannedProcurementSummary(
  domesticDesiredQuantityTons: number,
  importOrders: readonly PlannedImportOrderInput[],
  aquacultureExpectedProductionTons: number | undefined,
  currentPeriod: PeriodV2,
  standardLeadTimeTurns: number
): PlannedProcurementSummary {
  const rows: TimelineRow[] = [];
  const domesticRow = buildPlannedDomesticRow(domesticDesiredQuantityTons);
  if (domesticRow.totalTons > 0) rows.push(domesticRow);
  rows.push(...buildPlannedImportRows(importOrders, currentPeriod, standardLeadTimeTurns));
  const aquacultureRow = buildPlannedAquacultureRow(aquacultureExpectedProductionTons, currentPeriod);
  if (aquacultureRow !== null) rows.push(aquacultureRow);

  const totalByBucket: Record<TimelineBucketKey, number> = { current: 0, q1: 0, q2: 0, beyond: 0 };
  for (const row of rows) {
    for (const b of TIMELINE_BUCKET_KEYS) totalByBucket[b] += row.byBucket[b].tons;
  }
  return { rows, totalTons: rows.reduce((sum, r) => sum + r.totalTons, 0), totalByBucket, bySource: summarizePlannedProcurementBySource(rows) };
}
