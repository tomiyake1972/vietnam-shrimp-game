// ShrimpX V2 — 会社経営統合テスト環境（Phase 6.2） パラメータ差し替え
//
// Phase5（rawMaterials/parameters.ts）のRAW_MATERIALS_PARAMETERS_V1は、
// industryLabの小規模テスト会社（調達処理能力の上限が概ね数千トン/四半期）を
// 前提に校正された暫定値である。company-labの5社フィクスチャは、シナリオの
// 国全体スケール（国内原料供給450,000トン/四半期規模）と整合させるため、
// 生産能力・養殖能力・初期原料在庫を約100倍にスケールアップして構築している
// （fixtures.ts参照）。
//
// RAW_MATERIALS_PARAMETERS_V1をそのまま使うと、調達処理能力の上限
// （baselineCapacityTons + capacityMaxIncrementTons ≒ 3,750トン/社）が
// 常に最も厳しい制約として先に効いてしまい、各社のdesiredQuantity
// （国内買付希望量、フィクスチャのスケールでは1万〜数万トン/四半期）を
// 増減させても「有効買付意向」（calculateEffectivePurchaseIntent）が
// 変化しない、という会社経営統合環境として不適切な挙動になる
// （受入条件「国内買付希望量の増加で国内原料価格が上がる」を満たせない）。
//
// そのため、company-lab専用に「調達処理能力」だけをフィクスチャと同じ
// 約100倍のスケールへ差し替えたRawMaterialsParametersを用意する。
// Phase5の計算式（calculateEffectivePurchaseIntent等）自体は一切変更せず、
// 既存のRAW_MATERIALS_PARAMETERS_V1・industryLabの挙動にも一切影響しない
// （新しい定数オブジェクトを追加するだけで、既存エクスポートは変更しない）。
//
// 「基準供給量に対する最大価格影響シェア」（maximumPriceInfluenceShare）は
// 据え置く。これによりシナリオの国内供給規模（referenceSupply）に対する
// 1社あたりの価格影響上限（=referenceSupply×0.35）は既存のまま保たれ、
// 調達処理能力の上限だけが「常に先に効いてしまう無意味な制約」でなくなる。

import { RAW_MATERIALS_PARAMETERS_V1, RawMaterialsParameters } from "../rawMaterials/parameters";

const FIXTURE_SCALE_FACTOR = 100;

export const COMPANY_LAB_RAW_MATERIALS_PARAMETERS: RawMaterialsParameters = {
  ...RAW_MATERIALS_PARAMETERS_V1,
  parametersVersion: "raw-materials-v0.1::company-lab-v1",
  domesticPurchase: {
    ...RAW_MATERIALS_PARAMETERS_V1.domesticPurchase,
    baselineCapacityTons: RAW_MATERIALS_PARAMETERS_V1.domesticPurchase.baselineCapacityTons * FIXTURE_SCALE_FACTOR,
    capacityMaxIncrementTons: RAW_MATERIALS_PARAMETERS_V1.domesticPurchase.capacityMaxIncrementTons * FIXTURE_SCALE_FACTOR,
  },
};
