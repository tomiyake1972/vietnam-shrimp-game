// ShrimpX V2 — 工場・ワーカー・生産モジュール PD/VAP供給シグナル（Phase 6）
//
// Phase3のPD/VAPプレミアム形成（market/productPremium.ts の calculateProductPremium）
// は、CountrySupplyInput.pdProcessingCapacity / vapProcessingCapacity を「当該国の
// PD/VAP加工能力（外生的なシナリオ入力）」として使う。本ファイルは、5社の
// 実際の加工能力・供給計画・供給実績を産地（国）単位に集計し、この
// pdProcessingCapacity / vapProcessingCapacity を置き換えるアダプターを提供する。
// calculateProductPremium・HOSO国際基準価格（hosoPricing.ts）のロジック自体は
// 一切変更・重複実装しない。
//
//   - PD/VAP供給増加は、他条件一定ならプレミアムを低下させる
//     （calculateProductPremium内部でglobalUtilization = demand/capacityが下がり、
//     basePremiumが縮小するため。本ファイルはcapacityの値を差し替えるのみ）。
//   - 能力があるだけで全量供給した扱いにはしない。plannedQuantity（供給計画）と
//     actualQuantity（供給実績）を明確に区別する。
//   - 原則として当期価格形成（calculateProductPremium等、当期のMarketQuarterInput）
//     にはplannedQuantityを、次期へのフィードバック（次期CountrySupplyInputの
//     ベースライン更新）にはactualQuantityを使う（useActualフラグで明示する）。
//   - 会社行動（供給シグナル）が存在しない産地は、Phase3の既存値（暫定前提）を
//     そのまま残す（preserveExistingWhenNoSignal）。
//   - HOSO国際基準価格（CountrySupplyInputの他フィールド、hosoFobPrice等）には
//     一切触れない。

import { hosoEqTons, roundHosoEqTons, unwrapUnit } from "../core/units";
import { CountryId, CountrySupplyInput, Product } from "../market/types";
import type { CompanyId } from "../sales/types";
import { PRODUCTION_PARAMETERS_V1, ProductionParameters } from "./parameters";
import { CountryProductionSupplySignal, ProductionSupplySignalInput, ProductionValidationError } from "./types";

/** 5社の供給シグナルを、会社→産地マッピングを使って産地（国）単位に集計する。 */
export function aggregateProductionSupplySignals(
  signals: readonly ProductionSupplySignalInput[],
  companyCountry: Readonly<Record<CompanyId, CountryId>>,
  product: Extract<Product, "pd" | "vap">
): readonly CountryProductionSupplySignal[] {
  const totals = new Map<CountryId, { planned: number; actual: number }>();

  for (const signal of signals) {
    if (signal.product !== product) continue;
    const country = companyCountry[signal.companyId];
    if (!country) {
      throw new ProductionValidationError(`会社 "${signal.companyId}" の産地（companyCountry）が指定されていません。`);
    }
    const entry = totals.get(country) ?? { planned: 0, actual: 0 };
    entry.planned = roundHosoEqTons(entry.planned + unwrapUnit(signal.plannedQuantity));
    entry.actual = roundHosoEqTons(entry.actual + unwrapUnit(signal.actualQuantity));
    totals.set(country, entry);
  }

  return Array.from(totals.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([country, { planned, actual }]) => ({
      country,
      product,
      plannedCapacity: hosoEqTons(Math.max(0, planned)),
      actualCapacity: hosoEqTons(Math.max(0, actual)),
    }));
}

/**
 * 集計済み供給シグナルを、MarketQuarterInput.countries（CountrySupplyInput）の
 * pdProcessingCapacity / vapProcessingCapacity へ適用した新しいレコードを返す
 * （純粋関数、入力countrySupplyは変更しない）。useActual=falseなら
 * plannedCapacity（当期価格形成用）、true なら actualCapacity（次期フィードバック用）
 * を使う。シグナルが存在しない産地は、preserveExistingWhenNoSignal=trueの場合
 * 既存値をそのまま残す。
 */
export function applySupplySignalToCountrySupply(
  countrySupply: Readonly<Record<CountryId, CountrySupplyInput>>,
  signals: readonly CountryProductionSupplySignal[],
  product: Extract<Product, "pd" | "vap">,
  useActual: boolean,
  params: ProductionParameters = PRODUCTION_PARAMETERS_V1
): Readonly<Record<CountryId, CountrySupplyInput>> {
  const signalByCountry = new Map(signals.filter((s) => s.product === product).map((s) => [s.country, s]));
  const result = {} as Record<CountryId, CountrySupplyInput>;

  for (const [countryKey, input] of Object.entries(countrySupply)) {
    const country = countryKey as CountryId;
    const signal = signalByCountry.get(country);
    if (!signal) {
      if (params.supplySignal.preserveExistingWhenNoSignal) {
        result[country] = input;
        continue;
      }
      result[country] = product === "pd" ? { ...input, pdProcessingCapacity: hosoEqTons(0) } : { ...input, vapProcessingCapacity: hosoEqTons(0) };
      continue;
    }
    const capacity = useActual ? signal.actualCapacity : signal.plannedCapacity;
    result[country] = product === "pd" ? { ...input, pdProcessingCapacity: capacity } : { ...input, vapProcessingCapacity: capacity };
  }

  return result;
}
