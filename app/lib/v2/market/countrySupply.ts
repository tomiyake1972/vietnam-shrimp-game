// ShrimpX V2 — 国別養殖・供給（Phase 1）
//
// 市場価格形成モジュール仕様書 v0.2 §5「国別養殖コストモデル」・§7「国別供給
// モデル」に対応。Phase1では放養コホート・生残率の内部シミュレーションまでは
// 実装せず、当期の生産量（収穫量）・輸出可能比率・養殖コスト指数は呼び出し側
// からの入力として受け取る（§7.2の完全な収穫量計算式は将来のPhase・養殖
// モジュールの責務。docs/v2/MARKET_PRICING_ARCHITECTURE_v0.1.md 参照）。

import { HosoEqTons, hosoEqTons, unwrapUnit } from "../core/units";
import { CountryId, CountrySupplyInput } from "./types";
import { assertFinite, safeDivide } from "./validation";

/**
 * 輸出可能なHOSO換算供給量。
 * HOSO換算供給ᵢ,ₜ = 生産量 × 輸出可能比率
 * （仕様書§7.2の式から、Phase1では期首在庫・繰越在庫の項を持たないため
 * その部分を省略した単純化版。docsに明記する。）
 */
export function calculateExportableSupply(input: CountrySupplyInput): HosoEqTons {
  const production = unwrapUnit(input.production);
  const ratio = unwrapUnit(input.exportCapacityRatio);
  return hosoEqTons(production * ratio);
}

/**
 * 養殖コスト指数の変化率（当期/前期 - 1）。
 * 仕様書§5.1「Cᵢ,ₜ = Cᵢ,ₜ₋₁ × (1 + Σ wₖ × ΔCostDriverₖ,ₜ)」のうち、
 * Phase1では個別コストドライバーへの分解は行わず、呼び出し側が既に集計した
 * aquacultureCostIndex（基準期=1.0の相対値）の期間変化率のみを用いる。
 */
export function calculateCostPressure(input: CountrySupplyInput): number {
  assertFinite(input.aquacultureCostIndex, "aquacultureCostIndex");
  assertFinite(input.priorAquacultureCostIndex, "priorAquacultureCostIndex");
  if (input.aquacultureCostIndex <= 0 || input.priorAquacultureCostIndex <= 0) {
    throw new RangeError("aquacultureCostIndex / priorAquacultureCostIndex は正の値である必要があります。");
  }
  return safeDivide(input.aquacultureCostIndex - input.priorAquacultureCostIndex, input.priorAquacultureCostIndex);
}

export interface CountrySupplySummary {
  readonly country: CountryId;
  readonly exportableSupply: HosoEqTons;
  readonly costPressure: number;
}

/** 4か国分の輸出可能供給量・コスト変化率をまとめて算出する。入力を変更しない。 */
export function summarizeCountrySupply(
  countries: Readonly<Record<CountryId, CountrySupplyInput>>,
  countryIds: readonly CountryId[]
): Readonly<Record<CountryId, CountrySupplySummary>> {
  const result = {} as Record<CountryId, CountrySupplySummary>;
  for (const country of countryIds) {
    const input = countries[country];
    result[country] = {
      country,
      exportableSupply: calculateExportableSupply(input),
      costPressure: calculateCostPressure(input),
    };
  }
  return result;
}
