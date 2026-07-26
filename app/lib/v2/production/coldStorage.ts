// ShrimpX V2 — 冷凍・冷蔵保管能力（ストック）モジュール（Phase 8D-5新設）
//
// 【このモジュールが存在する理由】
//   Phase 8D以前、工場の能力は Factory.freezingPackagingCapacity という1つの
//   フィールドだけで表現され、画面・Excel上では「冷凍能力」「冷凍・保管能力」と
//   表記されていた。しかし生産エンジン（production/allocation.ts 段階3）が実際に
//   使っているのは「当四半期に凍結・包装できる数量の上限」＝**フロー**であり、
//   「同時に何トン保管できるか」＝**ストック**ではない。この2つが同じ名前で
//   呼ばれていたため、プレイヤーは投資判断の対象を取り違えるおそれがあった。
//
//   そこで Phase 8D-5 では次のように整理する。
//
//     凍結・包装処理能力   Factory.freezingPackagingCapacity   HOSO換算t／四半期（フロー）
//     冷凍・冷蔵保管能力   Factory.coldStorageCapacity         同時保管可能HOSO換算t（ストック）
//
// 【エンジン未接続であることの明示（最重要）】
//   保管能力を上限として次のような処理を行うロジックは、現時点のエンジンに
//   **一切存在しない**（Phase 8D-5の実装指示どおり、今回は追加しない）:
//     - 期末在庫の自動廃棄
//     - 入庫拒否
//     - 外部倉庫への自動振替
//     - 強制的な販売
//     - 保管超過による品質事故
//   本モジュールは「状態・使用量・空き容量・投資案件・警告表示」までを担い、
//   強制制約は未接続である。この事実は COLD_STORAGE_ENGINE_CONNECTION_NOTE として
//   文字列で提供し、画面・Excelの両方が同じ文言を必ず表示する。
//
// 【禁止事項】
//   - 生産エンジンの上限として coldStorageCapacity を使わない
//     （上限は引き続き freezingPackagingCapacity に接続する）。
//   - 保管超過を理由に数量を勝手に減らさない。
//   - 在庫が無い場合に使用量を0以外の値で埋めない。

import { hosoEqTons, HosoEqTons, unwrapUnit } from "../core/units";
import { Product } from "../market/types";
import { CompanyId } from "../sales/types";
import { Factory, FinishedGoodsLot } from "./types";

// ---------------------------------------------------------------------
// 1. パラメータ（1箇所へ集約。散在させない）
// ---------------------------------------------------------------------

export interface ColdStorageParameters {
  readonly parametersVersion: string;
  /**
   * Factory.coldStorageCapacity が未設定（Phase 8D以前に作成されたラボ）のときに、
   * 凍結・包装処理能力（トン/四半期）から保管能力（同時保管可能トン）を導出する係数。
   *
   * 0.5 は「四半期の凍結・包装処理量のおよそ半期分を同時に保管できる」という
   * 想定（暫定値・要校正）。既存5社の期末完成品在庫水準が凍結・包装能力の
   * 数%〜十数%で推移していたため、通常運転では逼迫せず、大量の作り置きや
   * 販売不振で在庫が積み上がったときに初めて警告が出る水準を狙っている。
   */
  readonly defaultStorageToFlowRatio: number;
  /** この使用率を超えたら「逼迫」警告を出す（0〜1）。 */
  readonly tightUtilizationThreshold: number;
}

export const COLD_STORAGE_PARAMETERS_V1: ColdStorageParameters = {
  parametersVersion: "coldStorage-v0.1",
  defaultStorageToFlowRatio: 0.5,
  tightUtilizationThreshold: 0.85,
};

/** 画面・Excelが必ず併記する、エンジン未接続であることの説明文。 */
export const COLD_STORAGE_ENGINE_CONNECTION_NOTE =
  "冷凍・冷蔵保管能力は、現時点では状態と空き容量の表示までが実装されています。" +
  "保管能力を超えた場合に入庫を拒否する・期末在庫を自動廃棄する・外部倉庫へ振替える・強制的に販売する、" +
  "といった強制的な制約はエンジンへ未接続です。生産量の上限として働くのは「凍結・包装処理能力」（トン／四半期）のほうです。";

/** 凍結・包装処理能力（フロー）と冷凍・冷蔵保管能力（ストック）の違いの説明文。 */
export const FREEZING_VS_STORAGE_EXPLANATION_TEXT =
  "「凍結・包装処理能力」は、その四半期に凍結・包装できる数量の上限（トン／四半期）です。生産量の上限として実際に働きます。" +
  "「冷凍・冷蔵保管能力」は、同時に保管しておける在庫の量（トン）です。四半期あたりの処理量ではありません。";

// ---------------------------------------------------------------------
// 2. 保管能力の解決（未設定なら決定論的に導出。既存データとの後方互換）
// ---------------------------------------------------------------------

/**
 * Factory.coldStorageCapacity が未設定のときの既定値（トン）。
 * 凍結・包装処理能力から係数で決定論的に導出するため、同じfixtureからは常に
 * 同じ値になる（永続化しなくても再現できる＝派生値を過剰に保存しない方針）。
 */
export function deriveDefaultColdStorageCapacityTons(
  factory: Factory,
  params: ColdStorageParameters = COLD_STORAGE_PARAMETERS_V1
): number {
  const flow = unwrapUnit(factory.freezingPackagingCapacity);
  const derived = flow * params.defaultStorageToFlowRatio;
  return Number.isFinite(derived) && derived > 0 ? derived : 0;
}

/** 工場の冷凍・冷蔵保管能力（トン）。明示値があればそれを、なければ既定値を返す。 */
export function resolveFactoryColdStorageCapacityTons(
  factory: Factory,
  params: ColdStorageParameters = COLD_STORAGE_PARAMETERS_V1
): number {
  if (factory.coldStorageCapacity !== undefined) {
    const explicit = unwrapUnit(factory.coldStorageCapacity);
    if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  }
  return deriveDefaultColdStorageCapacityTons(factory, params);
}

/** 工場の冷凍・冷蔵保管能力（ブランド型）。Factoryを組み立て直すときに使う。 */
export function resolveFactoryColdStorageCapacity(
  factory: Factory,
  params: ColdStorageParameters = COLD_STORAGE_PARAMETERS_V1
): HosoEqTons {
  return hosoEqTons(resolveFactoryColdStorageCapacityTons(factory, params));
}

// ---------------------------------------------------------------------
// 3. 保管使用量（完成品在庫）
// ---------------------------------------------------------------------

/**
 * 現在の保管使用量（トン）。冷凍・冷蔵保管庫に置かれているのは完成品在庫であり、
 * 原料（生・活け・輸送中）は対象に含めない（原料在庫は買付・輸入・養殖の各段階に
 * あり、完成品保管庫とは別の場所という整理）。期限切れ・充当済みロットは残数量が
 * 0であるため、status==="available" のロットの残数量だけを合計すれば足りるが、
 * 「残数量がある期限切れロット」を取りこぼさないよう残数量ベースで合計する。
 */
export function computeColdStorageUsageTons(lots: readonly FinishedGoodsLot[]): number {
  let total = 0;
  for (const lot of lots) {
    if (lot.status === "expired") continue;
    const remaining = unwrapUnit(lot.remainingQuantity);
    if (Number.isFinite(remaining) && remaining > 0) total += remaining;
  }
  return total;
}

/** 商品別の保管使用量（トン）。 */
export function computeColdStorageUsageByProduct(lots: readonly FinishedGoodsLot[]): Readonly<Partial<Record<Product, number>>> {
  const byProduct: Partial<Record<Product, number>> = {};
  for (const lot of lots) {
    if (lot.status === "expired") continue;
    const remaining = unwrapUnit(lot.remainingQuantity);
    if (!Number.isFinite(remaining) || remaining <= 0) continue;
    byProduct[lot.product] = (byProduct[lot.product] ?? 0) + remaining;
  }
  return byProduct;
}

// ---------------------------------------------------------------------
// 4. 1社ぶんの保管状態
// ---------------------------------------------------------------------

export interface CompanyColdStorageState {
  readonly companyId: CompanyId;
  /** 現在の冷凍・冷蔵保管能力（全工場合計、トン）。 */
  readonly totalCapacityTons: number;
  /** 現在の保管使用量（完成品在庫の残数量合計、トン）。 */
  readonly usedTons: number;
  /** 空き保管容量（トン。負にはしない）。 */
  readonly freeTons: number;
  /** 使用率（能力が0のときはundefined。0で埋めない）。 */
  readonly utilizationRate: number | undefined;
  /** 建設中・完成準備中の投資が稼働開始したあとの保管能力（トン）。 */
  readonly capacityAfterPendingInvestmentsTons: number;
  /** 建設中・完成準備中の投資による保管能力の増加ぶん（トン）。 */
  readonly pendingAdditionTons: number;
  /** 商品別の使用量（トン）。 */
  readonly usedByProduct: Readonly<Partial<Record<Product, number>>>;
  /** 使用量が能力を超えている見込みか（超過していても、エンジンは何も強制しない）。 */
  readonly isOverCapacity: boolean;
  /** 使用率が逼迫しきい値を超えているか。 */
  readonly isTight: boolean;
  /** 超過量（トン。超過していなければ0）。 */
  readonly overCapacityTons: number;
  /** エンジン未接続であることの説明（画面・Excel共通文言）。 */
  readonly engineConnectionNote: string;
}

export interface BuildCompanyColdStorageStateInput {
  readonly companyId: CompanyId;
  /** 当期の実効Factory（applyCapexCapacityToFactories 適用後のもの）。 */
  readonly currentFactories: readonly Factory[];
  readonly finishedGoodsLots: readonly FinishedGoodsLot[];
  /** 建設中・完成準備中の案件による保管能力の増加見込み（トン）。無ければ0。 */
  readonly pendingColdStorageAdditionTons?: number;
  readonly params?: ColdStorageParameters;
}

export function buildCompanyColdStorageState(input: BuildCompanyColdStorageStateInput): CompanyColdStorageState {
  const params = input.params ?? COLD_STORAGE_PARAMETERS_V1;
  const factories = input.currentFactories.filter((f) => f.companyId === input.companyId);
  const lots = input.finishedGoodsLots.filter((l) => l.companyId === input.companyId);

  const totalCapacityTons = factories.reduce((sum, f) => sum + resolveFactoryColdStorageCapacityTons(f, params), 0);
  const usedTons = computeColdStorageUsageTons(lots);
  const freeTons = Math.max(0, totalCapacityTons - usedTons);
  const overCapacityTons = Math.max(0, usedTons - totalCapacityTons);
  const pendingAdditionTons = Math.max(0, input.pendingColdStorageAdditionTons ?? 0);

  return {
    companyId: input.companyId,
    totalCapacityTons,
    usedTons,
    freeTons,
    utilizationRate: totalCapacityTons > 0 ? usedTons / totalCapacityTons : undefined,
    capacityAfterPendingInvestmentsTons: totalCapacityTons + pendingAdditionTons,
    pendingAdditionTons,
    usedByProduct: computeColdStorageUsageByProduct(lots),
    isOverCapacity: overCapacityTons > 0,
    isTight: totalCapacityTons > 0 && usedTons / totalCapacityTons >= params.tightUtilizationThreshold,
    overCapacityTons,
    engineConnectionNote: COLD_STORAGE_ENGINE_CONNECTION_NOTE,
  };
}
