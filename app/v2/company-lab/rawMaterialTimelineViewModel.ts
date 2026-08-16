// ShrimpX V2 — Procurement Planning: Raw Material Timeline（当期・Q+1・Q+2 × source別）
//
// 【目的】「いつ使える原料が、どの調達手段から、どれだけあるか」を横に並べて見せる。
// 新しいavailabilityルールは一切作らない。既存の RawMaterialLot.status /
// availableFromPeriod / source をそのまま分類するだけの純粋関数群である
// （companyLab/openingStateSummary.ts の groupRawMaterialLotsByAvailability と
// 同じ「利用可能開始四半期」の考え方を、四半期バケット×source別へ薄く拡張したもの）。
//
// 【このVMが扱う対象範囲】既存・確定済みのRawMaterialLotだけを対象とする
// 「Confirmed / Existing」レイヤーである。当期のdraft入力（国内買付希望量・
// 輸入発注・養殖池入れ計画）はこのVMには一切混ぜない。最終UIでは
//   Confirmed / Existing（本VM）
//   Planned Procurement（draft入力。別レイヤー）
//   Expected / Uncertain（本VM内のownFarm行。下記参照）
// を別々に表示する前提であり、本VMの数値だけを見て「国内調達＝0」等と
// 誤解されない設計にすること（UI接続時の実装注意）。
//
// 【行の意味（正直な設計メモ）】
//   - carriedInventory: 既に status="available" のロット（購入元を問わない「手持ち在庫」）。確定値。
//   - domesticProcurement: source="domestic" かつ status≠"available" のロット。
//     rawMaterials/inventory.ts の createDomesticPurchaseLots は常に
//     status="available" でロットを生成する（国内買付は成約と同時に即時利用可能になり、
//     輸送中のような中間状態を持たない）ため、この行は**構造的に常に0**になる。
//     捏造せず、そのまま0として表示する（意思決定時点ではまだ当期の買付が
//     ロット化されていないため、「今回の買付計画」は draft 側の別レイヤーで見せる。
//     この0を「国内調達ができない／していない」と読ませないこと）。
//   - importArrivals: source="import" かつ status="inTransitImport"。**確定値**
//     （rawMaterials/imports.ts の receiveArrivedImports は到着期到来時に
//     status を"available"へ遷移させるだけで remainingQuantity を変更しない。
//     発注が水位法配分で満額通るかは発注時点＝ロット生成時点で既に確定済みであり、
//     ロットとして存在する数量そのものに以降の不確実性はない）。
//   - ownFarm: source="aquaculture" かつ status="growingAquaculture"。**期待値・不確定**
//     （rawMaterials/aquaculture.ts の harvestAquacultureLots は収穫時に
//     actualHarvestQuantity = originalQuantity × survivalRatio(diseasePressure) として
//     初めて確定する。diseasePressureは意思決定時点で未知の外生値のため、この行の
//     数量は「疾病影響前の期待生産量」であり確定量ではない。UIでは必ず
//     「見込み・確定ではない」旨を明示すること）。
//   - otherCommittedLots: 上記いずれにも当てはまらないが remainingQuantity>0 の
//     ロット（consumed/expiredは除く）。将来の想定外source/status組合せを
//     静かに握りつぶさないための安全網（通常は常に0。確実性は不明のため
//     certainty="unknown"とする）。
//
// 【単位】すべてHOSO換算MT。歩留まり換算は一切行わない。

import { PeriodV2 } from "../../lib/v2/core/period";
import { unwrapUnit } from "../../lib/v2/core/units";
import { periodDifferenceInQuarters } from "../../lib/v2/companyLab/openingStateSummary";
import { RawMaterialLot } from "../../lib/v2/rawMaterials/types";

/** タイムラインのバケット。beyond = Q+3以降（一括表示・参考情報）。 */
export type TimelineBucketKey = "current" | "q1" | "q2" | "beyond";

export const TIMELINE_BUCKET_KEYS: readonly TimelineBucketKey[] = ["current", "q1", "q2", "beyond"];

export type TimelineRowKey = "carriedInventory" | "domesticProcurement" | "importArrivals" | "ownFarm" | "otherCommittedLots";

/**
 * この行の数量が確定値か、まだ変動しうる見込み値かを示す。
 *   confirmed … ロットとして存在する数量が今後変わらないことが保証されている。
 *   expected  … エンジンが将来（収穫等）の時点で数量を再計算する。現在値は見込み。
 *   planned   … 当期のdraft入力そのもの（未提出・未確定）。国内買付は競争配分前、
 *     輸入発注は原産国供給上限適用前、養殖池入れは疾病圧力適用前の希望値であり、
 *     いずれも「このまま成立する」ことを保証しない（plannedProcurementViewModel.ts参照）。
 *   unknown   … 想定外分類（otherCommittedLots）で、確実性を機械的に断定できない。
 */
export type TimelineRowCertainty = "confirmed" | "expected" | "planned" | "unknown";

function safeTons(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * currentPeriodからの四半期差分を、表示用の4バケットへ丸める（超過・当期はいずれも"current"）。
 * plannedProcurementViewModel.ts（輸入のリードタイム・養殖の収穫期バケット分け）でも
 * 同じ「当期以降を4バケットに丸める」規約を使うため、ここから再利用する。
 */
export function toTimelineBucketKey(currentPeriod: PeriodV2, availableFromPeriod: PeriodV2): TimelineBucketKey {
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
  /** buildRawMaterialTimelineが返す行は TimelineRowKey、Planned層（別ファイル）はそれ以外の文字列。 */
  readonly rowKey: string;
  readonly label: string;
  readonly certainty: TimelineRowCertainty;
  readonly byBucket: Readonly<Record<TimelineBucketKey, TimelineRowBucketValue>>;
  readonly totalTons: number;
}

export interface RawMaterialTimeline {
  readonly currentPeriod: PeriodV2;
  readonly bucketLabels: Readonly<Record<TimelineBucketKey, string>>;
  readonly rows: readonly TimelineRow[];
  /** 全行合計のバケット別数量（Available This Quarter 等との突合せ用。確定・見込みを問わず合算）。 */
  readonly totalByBucket: Readonly<Record<TimelineBucketKey, number>>;
  readonly grandTotalTons: number;
  /** certainty="confirmed"の行だけの合計（バケット問わず）。 */
  readonly confirmedTotalTons: number;
  /** certainty="expected"の行だけの合計（バケット問わず）。 */
  readonly expectedTotalTons: number;
}

const ROW_LABELS: Readonly<Record<TimelineRowKey, string>> = {
  carriedInventory: "手持ち在庫（Raw Inventory carried in）",
  domesticProcurement: "国内調達・輸送中扱い（Domestic Procurement, existing lots）",
  importArrivals: "輸入・到着待ち（Import Arrivals）",
  ownFarm: "自社養殖・収穫見込み（Own Farm, expected — not confirmed）",
  otherCommittedLots: "その他確定済みロット（Other committed lots）",
};

const ROW_CERTAINTY: Readonly<Record<TimelineRowKey, TimelineRowCertainty>> = {
  carriedInventory: "confirmed",
  domesticProcurement: "confirmed",
  importArrivals: "confirmed",
  ownFarm: "expected",
  otherCommittedLots: "unknown",
};

const ROW_ORDER: readonly TimelineRowKey[] = ["carriedInventory", "domesticProcurement", "importArrivals", "ownFarm", "otherCommittedLots"];

/**
 * バケットの表示ラベル（Current Quarter/Q+1/Q+2/Q+3以降）。buildRawMaterialTimelineの
 * 戻り値（bucketLabels）と、輸入発注のPlanned行（Import Procurement Sectionの
 * Expected Arrival Quarter表示）が同じラベルを使うための単一の情報源。
 */
export const TIMELINE_BUCKET_LABELS: Readonly<Record<TimelineBucketKey, string>> = {
  current: "Current Quarter",
  q1: "Q+1",
  q2: "Q+2",
  beyond: "Q+3以降",
};

export function emptyTimelineBucketMap(): Record<TimelineBucketKey, TimelineRowBucketValue> {
  return {
    current: { bucket: "current", tons: 0, lotCount: 0 },
    q1: { bucket: "q1", tons: 0, lotCount: 0 },
    q2: { bucket: "q2", tons: 0, lotCount: 0 },
    beyond: { bucket: "beyond", tons: 0, lotCount: 0 },
  };
}

function classifyRow(lot: RawMaterialLot): TimelineRowKey | null {
  if (lot.status === "available") return "carriedInventory";
  if (lot.status === "inTransitImport") return lot.source === "import" ? "importArrivals" : "otherCommittedLots";
  if (lot.status === "growingAquaculture") return lot.source === "aquaculture" ? "ownFarm" : "otherCommittedLots";
  // consumed / expired はタイムライン（先々の供給源）としての意味を持たない。
  return null;
}

/**
 * 会社の原料ロットを、行（source/statusの分類）× バケット（当期/Q+1/Q+2/Q+3以降）で集計する。
 * groupRawMaterialLotsByAvailability と同様、remainingQuantity<=0のロットは除外する。
 *
 * 各行には certainty（confirmed/expected/unknown）が付き、養殖（ownFarm）の見込み値を
 * 確定量と同列に扱わないための情報を保持する（呼び出し側が集計を誤らないための構造）。
 */
export function buildRawMaterialTimeline(
  lots: readonly RawMaterialLot[],
  companyId: string,
  currentPeriod: PeriodV2
): RawMaterialTimeline {
  const rowMaps = new Map<TimelineRowKey, Record<TimelineBucketKey, TimelineRowBucketValue>>();
  for (const key of ROW_ORDER) rowMaps.set(key, emptyTimelineBucketMap());

  for (const lot of lots) {
    if (lot.companyId !== companyId) continue;
    const quantity = safeTons(unwrapUnit(lot.remainingQuantity));
    if (quantity <= 0) continue;
    const rowKey = classifyRow(lot);
    if (rowKey === null) continue;
    const bucketKey = toTimelineBucketKey(currentPeriod, lot.availableFromPeriod);
    const map = rowMaps.get(rowKey)!;
    map[bucketKey] = { bucket: bucketKey, tons: map[bucketKey].tons + quantity, lotCount: map[bucketKey].lotCount + 1 };
  }

  const rows: TimelineRow[] = ROW_ORDER.map((rowKey) => {
    const byBucket = rowMaps.get(rowKey)!;
    const totalTons = TIMELINE_BUCKET_KEYS.reduce((sum, b) => sum + byBucket[b].tons, 0);
    return { rowKey, label: ROW_LABELS[rowKey], certainty: ROW_CERTAINTY[rowKey], byBucket, totalTons };
  });

  const totalByBucket: Record<TimelineBucketKey, number> = { current: 0, q1: 0, q2: 0, beyond: 0 };
  for (const row of rows) {
    for (const b of TIMELINE_BUCKET_KEYS) totalByBucket[b] += row.byBucket[b].tons;
  }

  return {
    currentPeriod,
    bucketLabels: TIMELINE_BUCKET_LABELS,
    rows,
    totalByBucket,
    grandTotalTons: TIMELINE_BUCKET_KEYS.reduce((sum, b) => sum + totalByBucket[b], 0),
    confirmedTotalTons: rows.filter((r) => r.certainty === "confirmed").reduce((sum, r) => sum + r.totalTons, 0),
    expectedTotalTons: rows.filter((r) => r.certainty === "expected").reduce((sum, r) => sum + r.totalTons, 0),
  };
}
