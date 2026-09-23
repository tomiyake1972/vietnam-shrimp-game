// ShrimpX V2 — 会社 × 商品 の物理供給スナップショット
// （ENG-CROWDING-MARKDOWN-1 Phase 1 / physical ATP proxy = CURRENT_COMMITTED_SUPPLY_PROXY_V1）
//
// 【このモジュールの責務】
// sales の Crowding 層が使う「信頼可能な物理供給」を、**既存の authoritative な
// capacity helper を再利用するだけ**で構築する。
//
// 【絶対にやらないこと】
//  - advanceProductionQuarter を sales pricing のために再実行しない
//    （第二 production simulator を作らない）。
//  - 生産ロジックの大規模複製をしない。ここにあるのは min / clip だけである。
//  - 将来まだ決定していない production plan、将来買うかもしれない spot raw material、
//    将来増員するかもしれない worker、将来完成する未確定 CAPEX 能力を足さない。
//  - 「現在能力 × 残Turn数」を商品別に独立使用しない。
//  - shared capacity（共通前処理・冷凍包装・労務・原料）を商品間で二重利用しない。
//
// 【安全側 proxy であること】
// 当期に決定済みの production plan を、既存 capacity 関数から得られる上限で
// clip したものだけを「確定済み供給」とみなす。したがって長期納期の ATP は
// 実際の将来能力より保守的に小さくなる。これは #04 が明示的に許容した方針であり、
// 取り込めていない要素は limitations として診断へ出す。

import { PeriodV2 } from "../core/period";
import { unwrapUnit } from "../core/units";
import { Product } from "../market/types";
import { calculateFactoryEffectiveCapacity } from "../production/capacity";
import { calculateLaborCapacityFromAssignedHeadcount } from "../production/labor";
import { PRODUCTION_PARAMETERS_V1, ProductionParameters } from "../production/parameters";
import type { CompanyProductionPlanEntry, Factory, FinishedGoodsLot, WorkerAssignment } from "../production/types";
import type { RawMaterialLot } from "../rawMaterials/types";
import type { CompanyProductPhysicalSupply } from "../sales/credibleOffer";
import { PHYSICAL_ATP_METHOD_V1 } from "../sales/crowding";

const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

/**
 * この proxy が取り込んでいない要素（§「diagnosticsへ明示する」）。
 * ここに書いてあるものは **意図的に安全側へ倒している**。
 */
export const PHYSICAL_ATP_PROXY_LIMITATIONS: readonly string[] = [
  "当期に決定済みの production plan のみを確定供給とみなし、将来Turnの未決定生産を一切加算しない（長期納期ほど保守的に小さくなる）。",
  "dueDate までに到着・収穫が確定している import / aquaculture ロットは、当期の原料可用量へは加算しない。それらを完成品へ変えるには未決定の将来生産が必要になるため、加算すると「将来まだ決定していない production plan」を含めることと等価になる。",
  "将来買うかもしれない spot 原料・将来の増員・未確定 CAPEX 能力を含めない。",
  "共通前処理能力は歩留まりを使わず「完成品換算量 <= 共通前処理能力」という安全側の不等式で clip する（歩留まり <= 1 のため過大評価にならない）。",
  "冷蔵能力（coldStorage）・工場スペース（factorySpace）による制約は本 proxy では未適用（より厳しい制約が存在しうるため、ATP は上振れしない方向にのみ誤差が残らないよう、今後の version で追加する）。",
];

/** 1社分の入力（すべて既存 state / decision から取れる値）。 */
export interface CompanyPhysicalSupplyInput {
  readonly companyId: string;
  /** lifecycle 適用済みの「今使える Factory[]」（capex/factoryConstruction.ts computeEffectiveFactories の結果）。 */
  readonly effectiveFactories: readonly Factory[];
  /** 当期に決定済みの生産計画。 */
  readonly productionPlans: readonly CompanyProductionPlanEntry[];
  /** 当期のワーカー配置。 */
  readonly workerAssignments: readonly WorkerAssignment[];
  /** 手持ち完成品ロット。 */
  readonly finishedGoodsLots: readonly FinishedGoodsLot[];
  /** 手持ち原料ロット。 */
  readonly rawMaterialLots: readonly RawMaterialLot[];
}

function qty(x: unknown): number {
  return Math.max(0, unwrapUnit(x as never) as unknown as number);
}

/** 当期時点で実際に使用可能な原料残量（輸送中・養殖中は含めない）。 */
function availableRawMaterialTons(lots: readonly RawMaterialLot[], period: PeriodV2): number {
  let total = 0;
  for (const lot of lots) {
    if (lot.status !== "available") continue;
    if (lot.availableFromPeriod > period) continue;
    if (lot.expiryPeriod !== undefined && lot.expiryPeriod < period) continue;
    total += qty(lot.remainingQuantity);
  }
  return total;
}

/**
 * 1社分の 会社 × 商品 物理供給スナップショットを作る。
 *
 * clip の順序（すべて既存の authoritative な値との min のみ。再シミュレーションなし）:
 *   1. 当期決定済み production plan を商品別に集計          … P_p
 *   2. 商品ライン能力で clip                                  … P_p <= Σ effective[product]
 *   3. 労務能力で clip（工場×商品の既存関数をそのまま使用）   … P_p <= Σ labor[factory][product]
 *   4. 共通前処理能力（shared）で Σ_p を clip
 *   5. 冷凍包装能力（shared）で Σ_p を clip
 *   6. 当期利用可能な原料残量（shared）で Σ_p を clip
 * 4〜6 は **商品間で共有される**ため、Σ_p に対して一度だけ効かせる
 * （商品ごとに独立に全量使えるという二重利用を構造的に作らない）。
 * 共有 clip は商品別の比例縮小で決定論的に配分する。
 */
export function buildCompanyPhysicalSupplies(
  input: CompanyPhysicalSupplyInput,
  period: PeriodV2,
  params: ProductionParameters = PRODUCTION_PARAMETERS_V1
): readonly CompanyProductPhysicalSupply[] {
  const activeFactoryIds = new Set(input.effectiveFactories.map((f) => f.factoryId));
  const capacities = input.effectiveFactories.map((f) => ({ factory: f, cap: calculateFactoryEffectiveCapacity(f) }));

  // --- 1. 当期決定済み production plan を商品別に集計（有効 Factory 分のみ） ---
  // MOTHBALLED / SOLD 等で effectiveFactories に含まれない工場の計画は、
  // その工場の能力が 0 であることと整合させるため、ここで落とす（CRWD-9）。
  const plannedByProduct = new Map<Product, number>();
  for (const plan of input.productionPlans) {
    if (plan.companyId !== input.companyId) continue;
    if (!activeFactoryIds.has(plan.factoryId)) continue;
    plannedByProduct.set(plan.product, (plannedByProduct.get(plan.product) ?? 0) + qty(plan.desiredQuantity));
  }

  // --- 2. 商品ライン能力 ---
  const lineCapByProduct = new Map<Product, number>();
  for (const product of PRODUCTS) {
    let total = 0;
    for (const { cap } of capacities) total += qty(cap[product]);
    lineCapByProduct.set(product, total);
  }

  // --- 3. 労務能力（既存の純粋関数をそのまま呼ぶ。生産配分の再現はしない） ---
  const assignmentByFactory = new Map<string, WorkerAssignment>();
  for (const a of input.workerAssignments) {
    if (a.companyId !== input.companyId) continue;
    assignmentByFactory.set(a.factoryId, a);
  }
  const laborCapByProduct = new Map<Product, number>();
  for (const product of PRODUCTS) {
    let total = 0;
    for (const { factory, cap } of capacities) {
      const a = assignmentByFactory.get(factory.factoryId);
      if (!a) continue;
      const skill = a.skills.find((s) => s.product === product);
      total += Math.max(
        0,
        calculateLaborCapacityFromAssignedHeadcount(
          a.regularHeadcount,
          a.temporaryHeadcount,
          unwrapUnit(a.attendanceRate),
          skill ? unwrapUnit(skill.skillLevel) : 0,
          unwrapUnit(a.overtimeRate),
          qty(cap[product]),
          params,
          product
        )
      );
    }
    laborCapByProduct.set(product, total);
  }

  // 商品別 clip（2・3）。
  const clippedByProduct = new Map<Product, number>();
  for (const product of PRODUCTS) {
    const planned = plannedByProduct.get(product) ?? 0;
    const clipped = Math.min(planned, lineCapByProduct.get(product) ?? 0, laborCapByProduct.get(product) ?? 0);
    clippedByProduct.set(product, Math.max(0, clipped));
  }

  // --- 4〜6. 共有制約（商品間で二重利用させない） ---
  let sharedCap = Number.POSITIVE_INFINITY;
  let commonProcessing = 0;
  let freezingPackaging = 0;
  for (const { cap } of capacities) {
    commonProcessing += qty(cap.commonProcessing);
    freezingPackaging += qty(cap.freezingPackaging);
  }
  sharedCap = Math.min(sharedCap, commonProcessing, freezingPackaging);
  sharedCap = Math.min(sharedCap, availableRawMaterialTons(input.rawMaterialLots, period));

  const totalClipped = PRODUCTS.reduce((s, p) => s + (clippedByProduct.get(p) ?? 0), 0);
  const sharedScale = totalClipped > 0 && Number.isFinite(sharedCap) ? Math.min(1, sharedCap / totalClipped) : 1;

  // --- 手持ち完成品在庫 ---
  const onHandByProduct = new Map<Product, number>();
  for (const lot of input.finishedGoodsLots) {
    if (lot.companyId !== input.companyId) continue;
    onHandByProduct.set(lot.product, (onHandByProduct.get(lot.product) ?? 0) + qty(lot.remainingQuantity));
  }

  return PRODUCTS.map((product) => ({
    companyId: input.companyId,
    product,
    onHandFinishedGoods: onHandByProduct.get(product) ?? 0,
    conservativeCommittedSupply: (clippedByProduct.get(product) ?? 0) * sharedScale,
    method: PHYSICAL_ATP_METHOD_V1,
    limitations: PHYSICAL_ATP_PROXY_LIMITATIONS,
  }));
}

/** 複数社ぶんをまとめて構築する（決定論のため companyId でソートして返す）。 */
export function buildPhysicalSupplies(
  inputs: readonly CompanyPhysicalSupplyInput[],
  period: PeriodV2,
  params: ProductionParameters = PRODUCTION_PARAMETERS_V1
): readonly CompanyProductPhysicalSupply[] {
  return [...inputs]
    .sort((a, b) => a.companyId.localeCompare(b.companyId))
    .flatMap((i) => buildCompanyPhysicalSupplies(i, period, params));
}
