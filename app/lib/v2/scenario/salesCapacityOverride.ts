// ShrimpX V2 — シナリオ別の会社営業組織能力の上書き（Dynamic Scenario 3）
//
// 【なぜ要るか】DS2 監査で、5社の四半期販売量を実際に縛っているのは市場規模でも
// 供給者シェア上限（35%）でもなく、会社営業組織能力の曲線
//   capacity(h) = 1,000 + 95,000 × h/(h+190)   （漸近上限 96,000 営業工数t/四半期）
// であることが確定した。実測（DS2 seed=ds2-audit, T32）では
//   BAL/MASS/JPQ/CONSV の「AI希望販売量」と「実配分」が 29,827t で完全一致し、
//   供給者シェア上限は一度も binding していなかった（CN HOSO は上限23,898に対し11,542）。
// より大きな企業規模を扱うシナリオでは、この曲線自体を引き上げる以外に道がない。
//
// 【グローバル既定を変えない】ここはシナリオ定義が宣言したときだけ効く。
// 宣言の無いシナリオ（baseline / DS1 / DS2 / 既存の全ベンチマーク）では
// **同一オブジェクト参照をそのまま返す**ため、挙動はビット単位で不変。
//
// 【営業工数係数は触らない】salesEffortCoefficients（HOSO 1.0 / PD 1.2 / VAP 3.0）は
// 商品ごとの営業の重さという世界共通の性質なので、シナリオからは変更できない。

import { SalesParameters } from "../sales/parameters";
import { SALES_CAPACITY_MODEL_COMPANY_ORGANIZATION_V1 } from "../sales/salesCapacityModel";
import { ScenarioDefinition } from "./types";

/**
 * シナリオ定義の salesOrganizationCapacityOverride を SalesParameters へ適用する。
 * 未宣言なら base をそのまま（同一参照で）返す。
 */
export function applyScenarioSalesCapacityOverride(base: SalesParameters, definition: ScenarioDefinition): SalesParameters {
  const override = definition.salesOrganizationCapacityOverride;
  if (override === undefined) return base;

  // 上書きの土台は、その SalesParameters が既に持つモデル（無ければ正式モデル）。
  // kind は変えない（perMarket のシナリオを勝手に companyWide にしない）。
  const model = base.salesCapacityModel ?? SALES_CAPACITY_MODEL_COMPANY_ORGANIZATION_V1;
  return {
    ...base,
    salesCapacityModel: {
      ...model,
      ...(override.companyBaselineCapacityTons === undefined ? {} : { companyBaselineCapacityTons: override.companyBaselineCapacityTons }),
      ...(override.companyCapacityMaxIncrementTons === undefined
        ? {}
        : { companyCapacityMaxIncrementTons: override.companyCapacityMaxIncrementTons }),
      ...(override.companyCapacitySaturationHeadcount === undefined
        ? {}
        : { companyCapacitySaturationHeadcount: override.companyCapacitySaturationHeadcount }),
    },
  };
}
