// ShrimpX V2 — AI Management Meeting: Capacity Pool / Raw Material Semantics（AMM-M2.5）
//
// 【背景・root cause】Test26系の新規BAL Turn1で、COOが「実効能力14,107.5tで天井」、
// CFOが「期限オーバー4,400tを納期内に納めるにはCAPEX・人員増が必要」と述べた。
// 14,107.5tはHOSO(6,840)+PD(5,985)+VAP(1,282.5)という商品別専用ラインの合計に
// すぎず、common preprocessing（共通前処理・25,650t）・freezing/packing（凍結包装・
// 25,650t）という、遥かに大きい別のcapacity poolが同時に存在する。
//
// 【監査結果（変更しない。既存の値をそのまま転記・単純集計するだけ）】
// app/lib/v2/production/types.ts の FactoryEffectiveCapacity は、既に
// commonProcessing/hoso/pd/vap/freezingPackagingの5つのpoolを個別に保持している。
// app/lib/v2/companyLab/aiExplanation/buildExplanationContext.ts の
// computeProductionCapacitySummary も、実は既にこの5pool（正確にはproduct合計・
// common合計・freezing合計の3群）を比較してbindingTotalTons・bindingConstraintLabel
// （"商品別実効能力"|"共通前処理"|"凍結・包装"）を正しく算出済みである
// （つまりengineの判定ロジック自体に誤りは無い）。
//
// 根本原因は、AI Meeting briefingがbindingTotalTons/bindingConstraintLabelという
// 「結論」だけを渡し、5つのpoolそれぞれの絶対量（common=25,650t・freezing=25,650t等）
// を渡していなかったことにある。そのため、COOがbindingConstraintLabel="商品別実効能力"
// という根拠を明示的に参照せず、「実効能力14,107.5t」を万能な会社全体の天井であるかの
// ように説明してしまう余地があった。本モジュールは、既存ownState.factoryCapacityを
// 単純合算するだけで5つのpoolを明示的なcapacityPoolsとして構築する（新しい能力算出
// ロジックは一切追加しない）。

export interface CapacityPools {
  /** 共通前処理（原料投入側）の実効能力合計。 */
  readonly commonProcessingTons: number;
  /** 凍結・包装処理能力（フロー）の実効能力合計。 */
  readonly freezingPackagingTons: number;
  readonly hosoTons: number;
  readonly pdTons: number;
  readonly vapTons: number;
  /** hoso+pd+vap（商品別専用ラインの合計）。会社全体の天井ではなく、あくまで商品別ラインの合計であることを明示する。 */
  readonly productLineSumTons: number;
  /** 既存ExplanationContextProductionCapacitySummary.bindingTotalTonsの転記（新しい判定はしない）。 */
  readonly bindingTons: number;
  /** 既存ExplanationContextProductionCapacitySummary.bindingConstraintLabelの転記（"商品別実効能力"|"共通前処理"|"凍結・包装"）。 */
  readonly bindingPoolLabel: string;
}

interface FactoryEffectiveLike {
  readonly effective: Readonly<Record<string, number>>;
}

/** 既存ownState.factoryCapacityの単純合算のみ。新しい能力算出ロジックは一切追加しない。 */
export function buildCapacityPools(factoryCapacity: readonly FactoryEffectiveLike[], bindingTotalTons: number, bindingConstraintLabel: string): CapacityPools {
  const commonProcessingTons = factoryCapacity.reduce((s, c) => s + (c.effective.commonProcessing ?? 0), 0);
  const freezingPackagingTons = factoryCapacity.reduce((s, c) => s + (c.effective.freezingPackaging ?? 0), 0);
  const hosoTons = factoryCapacity.reduce((s, c) => s + (c.effective.hoso ?? 0), 0);
  const pdTons = factoryCapacity.reduce((s, c) => s + (c.effective.pd ?? 0), 0);
  const vapTons = factoryCapacity.reduce((s, c) => s + (c.effective.vap ?? 0), 0);
  return {
    commonProcessingTons,
    freezingPackagingTons,
    hosoTons,
    pdTons,
    vapTons,
    productLineSumTons: hosoTons + pdTons + vapTons,
    bindingTons: bindingTotalTons,
    bindingPoolLabel: bindingConstraintLabel,
  };
}

/**
 * 実装指示§6。既存ownState.rawMaterialInventory.totalTonsを「現在（decision時点）の
 * 在庫」として明示的にラベル付けするだけ（新しい在庫計算は追加しない）。今期の
 * quarter processing中にdomestic purchase/import arrivalsが追加され得ることは、
 * この数値には含まれない別事象であることをpromptガードレール側で明示する
 * （在庫予測という新しい観測はここでは作らない）。
 */
export interface RawMaterialAvailabilityFact {
  /** decision時点（当期処理後）の在庫。ゼロの場合、今期の追加調達が無ければ生産に使える原料は無い。 */
  readonly currentOnHandTons: number;
}

export function buildRawMaterialAvailabilityFact(currentOnHandTons: number): RawMaterialAvailabilityFact {
  return { currentOnHandTons };
}
