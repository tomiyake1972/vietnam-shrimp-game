// ShrimpX V2 — Procurement Planning: Raw Material Timeline（当期・Q+1・Q+2 × source別）
//
// 【目的】「いつ使える原料が、どの調達手段から、どれだけあるか」を横に並べて見せる。
// 新しいavailabilityルールは一切作らない。既存の RawMaterialLot.status /
// availableFromPeriod / source をそのまま分類するだけの純粋関数群である
// （companyLab/openingStateSummary.ts の groupRawMaterialLotsByAvailability と
// 同じ「利用可能開始四半期」の考え方を、四半期バケット×source別へ薄く拡張したもの）。
//
// 【行の意味（正直な設計メモ）】
//   - carriedInventory: 既に status="available" のロット（購入元を問わない「手持ち在庫」）。
//   - domesticProcurement: source="domestic" かつ status≠"available" のロット。
//     rawMaterials/inventory.ts の createDomesticPurchaseLots は常に
//     status="available" でロットを生成する（国内買付は成約と同時に即時利用可能になり、
//     輸送中のような中間状態を持たない）ため、この行は**構造的に常に0**になる。
//     捏造せず、そのまま0として表示する（意思決定時点ではまだ当期の買付が
//     ロット化されていないため、「今回の買付計画」は別枠のdraft側で見せる）。
//   - importArrivals: source="import" かつ status="inTransitImport"。
//   - ownFarm: source="aquaculture" かつ status="growingAquaculture"。
//   - otherCommittedLots: 上記いずれにも当てはまらないが remainingQuantity>0 の
//     ロット（consumed/expiredは除く）。将来の想定外source/status組合せを
//     静かに握りつぶさないための安全網（通常は常に0）。
//
// 【単位】すべてHOSO換算MT。歩留まり換算は一切行わない。

import { PeriodV2 } from "../../lib/v2/core/period";
import { unwrapUnit } from "../../lib/v2/core/units";
import { periodDifferenceInQuarters } from "../../lib/v2/companyLab/openingStateSummary";
import { RawMaterialLot } from "../../lib/v2/rawMaterials/types";

/** タイムラインのバケット。beyond = Q+3以降（一括表示・参考情報）。 */
export type TimelineBucketKey = "current" | "q1" | "q2" | "beyond";

export const TIMELINE_BUCKET_KEYS: readonly TimelineBucketKey[] = ["current", "q1", "q2", "beyond"];

function safeTons(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** currentPeriodからの四半期差分を、表示用の4バケットへ丸める（超過・当期はいずれも"current"）。 */
function toBucketKey(currentPeriod: PeriodV2, availableFromPeriod: PeriodV2): TimelineBucketKey {
  const offset = periodDifferenceInQuarters(currentPeriod, availableFromPeriod);
  if (offset <= 0) return "current";
  if (offset === 1) return "q1";
  if (offset === 2) return "q2";
  return "beyond";
}

export interface TimelineRowBucketValue {
  readonly bucket: TimelineBucketKey;
  readonly tons: number;
  readonly lotCount: number;
}

export interface TimelineRow {
  readonly rowKey: "carriedInventory" | "domesticProcurement" | "importArrivals" | "ownFarm" | "otherCommittedLots";
  readonly label: string;
  readonly byBucket: Readonly<Record<TimelineBucketKey, TimelineRowBucketValue>>;
  readonly totalTons: number;
}

export interface RawMaterialTimeline {
  readonly currentPeriod: PeriodV2;
  readonly bucketLabels: Readonly<Record<TimelineBucketKey, string>>;
  readonly rows: readonly TimelineRow[];
  /** 全行合計のバケット別数量（Available This Quarter 等との突合せ用）。 */
  readonly totalByBucket: Readonly<Record<TimelineBucketKey, number>>;
  readonly grandTotalTons: number;
}

const ROW_LABELS: Readonly<Record<TimelineRow["rowKey"], string>> = {
  carriedInventory: "手持ち在庫（Raw Inventory carried in）",
  domesticProcurement: "国内調達・輸送中扱い（Domestic Procurement）",
  importArrivals: "輸入・到着待ち（Import Arrivals）",
  ownFarm: "自社養殖・収穫待ち（Own Farm）",
  otherCommittedLots: "その他確定済みロット（Other committed lots）",
};

function emptyBucketMap(): Record<TimelineBucketKey, TimelineRowBucketValue> {
  return {
    current: { bucket: "current", tons: 0, lotCount: 0 },
    q1: { bucket: "q1", tons: 0, lotCount: 0 },
    q2: { bucket: "q2", tons: 0, lotCount: 0 },
    beyond: { bucket: "beyond", tons: 0, lotCount: 0 },
  };
}

function classifyRow(lot: RawMaterialLot): TimelineRow["rowKey"] | null {
  if (lot.status === "available") return "carriedInventory";
  if (lot.status === "inTransitImport") return lot.source === "import" ? "importArrivals" : "otherCommittedLots";
  if (lot.status === "growingAquaculture") return lot.source === "aquaculture" ? "ownFarm" : "otherCommittedLots";
  // consumed / expired はタイムライン（先々の供給源）としての意味を持たない。
  return null;
}

/**
 * 会社の原料ロットを、行（source/statusの分類）× バケット（当期/Q+1/Q+2/Q+3以降）で集計する。
 * groupRawMaterialLotsByAvailability と同様、remainingQuantity<=0のロットは除外する。
 */
export function buildRawMaterialTimeline(
  lots: readonly RawMaterialLot[],
  companyId: string,
  currentPeriod: PeriodV2
): RawMaterialTimeline {
  const rowMaps = new Map<TimelineRow["rowKey"], Record<TimelineBucketKey, TimelineRowBucketValue>>();
  const rowOrder: readonly TimelineRow["rowKey"][] = [
    "carriedInventory",
    "domesticProcurement",
    "importArrivals",
    "ownFarm",
    "otherCommittedLots",
  ];
  for (const key of rowOrder) rowMaps.set(key, emptyBucketMap());

  for (const lot of lots) {
    if (lot.companyId !== companyId) continue;
    const quantity = safeTons(unwrapUnit(lot.remainingQuantity));
    if (quantity <= 0) continue;
    const rowKey = classifyRow(lot);
    if (rowKey === null) continue;
    const bucketKey = toBucketKey(currentPeriod, lot.availableFromPeriod);
    const map = rowMaps.get(rowKey)!;
    map[bucketKey] = { bucket: bucketKey, tons: map[bucketKey].tons + quantity, lotCount: map[bucketKey].lotCount + 1 };
  }

  const rows: TimelineRow[] = rowOrder.map((rowKey) => {
    const byBucket = rowMaps.get(rowKey)!;
    const totalTons = TIMELINE_BUCKET_KEYS.reduce((sum, b) => sum + byBucket[b].tons, 0);
    return { rowKey, label: ROW_LABELS[rowKey], byBucket, totalTons };
  });

  const totalByBucket: Record<TimelineBucketKey, number> = { current: 0, q1: 0, q2: 0, beyond: 0 };
  for (const row of rows) {
    for (const b of TIMELINE_BUCKET_KEYS) totalByBucket[b] += row.byBucket[b].tons;
  }

  return {
    currentPeriod,
    bucketLabels: {
      current: "Current Quarter",
      q1: "Q+1",
      q2: "Q+2",
      beyond: "Q+3以降",
    },
    rows,
    totalByBucket,
    grandTotalTons: TIMELINE_BUCKET_KEYS.reduce((sum, b) => sum + totalByBucket[b], 0),
  };
}
