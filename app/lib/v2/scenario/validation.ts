// ShrimpX V2 — シナリオ定義バリデーション（Phase 2）
//
// ScenarioDefinitionを実行前に検証する純粋関数。例外を投げず、
// ScenarioValidationResult（valid + errors配列）として結果を返す
// （initializeScenarioは内部でこれを呼び、不正な場合にのみ例外化する）。

import { COUNTRY_IDS, DEMAND_MARKET_IDS, CountryId, DemandMarketId } from "../market/types";
import { PRODUCT_LIFECYCLE_PARAMETERS_V1, resolveProductLifecycleParameters } from "../market/productLifecycle";
import { assertSortedKeyframes } from "./interpolation";
import { ScenarioDefinition, ScenarioEvent, ScenarioValidationResult, ScenarioValidationError } from "./types";

const MIN_DURATION_TURNS = 20;
const MAX_DURATION_TURNS = 40;

function isCountryId(v: string): v is CountryId {
  return (COUNTRY_IDS as readonly string[]).includes(v);
}
function isMarketId(v: string): v is DemandMarketId {
  return (DEMAND_MARKET_IDS as readonly string[]).includes(v);
}

function checkDuplicateIds(ids: readonly string[], label: string, errors: string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) errors.push(`${label} のIDが重複しています: ${id}`);
    seen.add(id);
  }
}

function checkEvent(event: ScenarioEvent, scenarioDurationTurns: number, errors: string[]): void {
  const label = `event(${event.eventId})`;
  if (!Number.isInteger(event.startTurn) || event.startTurn < 1) {
    errors.push(`${label}: startTurn は1以上の整数である必要があります。受け取った値: ${event.startTurn}`);
  }
  if (!Number.isInteger(event.durationTurns) || event.durationTurns < 1) {
    errors.push(`${label}: durationTurns は1以上の整数である必要があります。受け取った値: ${event.durationTurns}`);
  }
  if (!Number.isInteger(event.rampUpTurns) || event.rampUpTurns < 0) {
    errors.push(`${label}: rampUpTurns は0以上の整数である必要があります。受け取った値: ${event.rampUpTurns}`);
  }
  if (!Number.isInteger(event.recoveryTurns) || event.recoveryTurns < 0) {
    errors.push(`${label}: recoveryTurns は0以上の整数である必要があります。受け取った値: ${event.recoveryTurns}`);
  }
  if (event.startTurn > scenarioDurationTurns) {
    errors.push(`${label}: startTurn(${event.startTurn}) がシナリオ全体の durationTurns(${scenarioDurationTurns}) を超えています。`);
  }

  for (const c of event.targetCountries) {
    if (!isCountryId(c)) errors.push(`${label}: targetCountries に不正な国コードがあります: ${c}`);
  }
  for (const m of event.targetMarkets) {
    if (!isMarketId(m)) errors.push(`${label}: targetMarkets に不正な市場コードがあります: ${m}`);
  }

  if (event.effects.length === 0) {
    errors.push(`${label}: effects が空です。`);
  }
  for (const effect of event.effects) {
    if (effect.mode === "multiplicative" && !(effect.magnitude > 0)) {
      errors.push(`${label}: multiplicative効果のmagnitudeは正の数である必要があります。受け取った値: ${effect.magnitude}`);
    }
    if (!Number.isFinite(effect.magnitude)) {
      errors.push(`${label}: 効果のmagnitudeが有限数ではありません: ${effect.magnitude}`);
    }
  }

  const range = event.variationRange;
  if (range) {
    if (range.startTurnJitter !== undefined && range.startTurnJitter < 0) {
      errors.push(`${label}: variationRange.startTurnJitter は0以上である必要があります。`);
    }
    if (range.durationJitterTurns !== undefined && range.durationJitterTurns < 0) {
      errors.push(`${label}: variationRange.durationJitterTurns は0以上である必要があります。`);
    }
    if (range.recoveryJitterTurns !== undefined && range.recoveryJitterTurns < 0) {
      errors.push(`${label}: variationRange.recoveryJitterTurns は0以上である必要があります。`);
    }
    if (
      range.magnitudeJitterRatio !== undefined &&
      (range.magnitudeJitterRatio < 0 || range.magnitudeJitterRatio >= 1)
    ) {
      errors.push(`${label}: variationRange.magnitudeJitterRatio は [0,1) の範囲である必要があります。受け取った値: ${range.magnitudeJitterRatio}`);
    }
  }
}

/**
 * ScenarioDefinitionを検証し、結果を返す（例外は投げない）。
 * 入力のdefinitionは変更しない。
 */
export function validateScenarioDefinition(definition: ScenarioDefinition): ScenarioValidationResult {
  const errors: string[] = [];

  // 期間
  if (
    !Number.isInteger(definition.durationTurns) ||
    definition.durationTurns < MIN_DURATION_TURNS ||
    definition.durationTurns > MAX_DURATION_TURNS
  ) {
    errors.push(
      `durationTurns は${MIN_DURATION_TURNS}〜${MAX_DURATION_TURNS}の整数である必要があります。受け取った値: ${definition.durationTurns}`
    );
  }

  // ID重複
  checkDuplicateIds(definition.scheduledEvents.map((e) => e.eventId), "scheduledEvents", errors);
  checkDuplicateIds(definition.informationReleases.map((r) => r.informationId), "informationReleases", errors);
  checkDuplicateIds(definition.longTermTrends.map((t) => t.trendId), "longTermTrends", errors);

  // イベント個別
  for (const event of definition.scheduledEvents) {
    checkEvent(event, definition.durationTurns, errors);
  }

  const eventIds = new Set(definition.scheduledEvents.map((e) => e.eventId));
  const informationIds = new Set(definition.informationReleases.map((r) => r.informationId));

  // イベント → 情報リリースの参照整合性
  for (const event of definition.scheduledEvents) {
    for (const infoId of event.informationReleaseIds) {
      if (!informationIds.has(infoId)) {
        errors.push(`event(${event.eventId}): 存在しないinformationReleaseIdを参照しています: ${infoId}`);
      }
    }
  }

  // 情報リリース個別
  for (const release of definition.informationReleases) {
    if (release.relatedEventId !== undefined && !eventIds.has(release.relatedEventId)) {
      errors.push(`informationRelease(${release.informationId}): 存在しないrelatedEventIdを参照しています: ${release.relatedEventId}`);
    }
    if (release.revisionOf !== undefined && !informationIds.has(release.revisionOf)) {
      errors.push(`informationRelease(${release.informationId}): 存在しないrevisionOfを参照しています: ${release.revisionOf}`);
    }
    if (!Number.isInteger(release.availableFromTurn) || release.availableFromTurn < 1) {
      errors.push(`informationRelease(${release.informationId}): availableFromTurn は1以上の整数である必要があります。`);
    }
    if (release.estimateRange && release.estimateRange.low > release.estimateRange.high) {
      errors.push(
        `informationRelease(${release.informationId}): estimateRangeのlow(${release.estimateRange.low})がhigh(${release.estimateRange.high})を上回っています。`
      );
    }
    if (release.confidence !== undefined && (release.confidence < 0 || release.confidence > 1)) {
      errors.push(`informationRelease(${release.informationId}): confidence は[0,1]の範囲である必要があります。`);
    }
  }

  // 長期トレンド
  for (const trend of definition.longTermTrends) {
    try {
      assertSortedKeyframes(trend.keyframes, `trend(${trend.trendId})`);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
    if (trend.scope.kind === "country" && !isCountryId(trend.scope.countryId)) {
      errors.push(`trend(${trend.trendId}): scope.countryId が不正です: ${trend.scope.countryId}`);
    }
    if (trend.scope.kind === "market" && !isMarketId(trend.scope.marketId)) {
      errors.push(`trend(${trend.trendId}): scope.marketId が不正です: ${trend.scope.marketId}`);
    }
  }

  // 前史・初期状態の非負検証
  for (const c of COUNTRY_IDS) {
    if (definition.prehistory.priorHosoFobPriceUsdPerKg[c] <= 0) {
      errors.push(`prehistory.priorHosoFobPriceUsdPerKg[${c}] は正の値である必要があります。`);
    }
    if (definition.prehistory.countryAquacultureCostIndex[c] <= 0) {
      errors.push(`prehistory.countryAquacultureCostIndex[${c}] は正の値である必要があります。`);
    }
    if (definition.prehistory.countrySupplyHosoEqTons[c] < 0) {
      errors.push(`prehistory.countrySupplyHosoEqTons[${c}] は0以上である必要があります。`);
    }
    if (definition.prehistory.growingInventoryHosoEqTons[c] < 0) {
      errors.push(`prehistory.growingInventoryHosoEqTons[${c}] は0以上である必要があります。`);
    }
    if (definition.prehistory.frozenInventoryHosoEqTons[c] < 0) {
      errors.push(`prehistory.frozenInventoryHosoEqTons[${c}] は0以上である必要があります。`);
    }
    if (definition.prehistory.farmerExpectedPriceUsdPerKg[c] <= 0) {
      errors.push(`prehistory.farmerExpectedPriceUsdPerKg[${c}] は正の値である必要があります。`);
    }
  }
  for (const m of DEMAND_MARKET_IDS) {
    if (definition.prehistory.priorMarketConsumptionHosoEqTons[m] < 0) {
      errors.push(`prehistory.priorMarketConsumptionHosoEqTons[${m}] は0以上である必要があります。`);
    }
  }
  if (definition.prehistory.priorVietnamDomesticPriceUsdPerKg <= 0) {
    errors.push(`prehistory.priorVietnamDomesticPriceUsdPerKg は正の値である必要があります。`);
  }
  if (definition.prehistory.lengthYears < 2 || definition.prehistory.lengthYears > 4) {
    errors.push(`prehistory.lengthYears は2〜4の範囲である必要があります。受け取った値: ${definition.prehistory.lengthYears}`);
  }

  const econ = definition.initialStateOverrides.vietnamProcessingEconomics;
  if (econ.hosoEqRecoveryRatio <= 0 || econ.hosoEqRecoveryRatio > 1) {
    errors.push(`initialStateOverrides.vietnamProcessingEconomics.hosoEqRecoveryRatio は(0,1]の範囲である必要があります。`);
  }
  if (econ.processingExportCostUsdPerKg < 0) {
    errors.push(`initialStateOverrides.vietnamProcessingEconomics.processingExportCostUsdPerKg は0以上である必要があります。`);
  }
  if (econ.requiredMarginUsdPerKg < 0) {
    errors.push(`initialStateOverrides.vietnamProcessingEconomics.requiredMarginUsdPerKg は0以上である必要があります。`);
  }
  const farmerEcon = definition.initialStateOverrides.vietnamFarmerEconomics;
  if (farmerEcon) {
    if (farmerEcon.farmingCostUsdPerHosoEqKg < 0 || farmerEcon.diseaseRiskAllowanceUsdPerHosoEqKg < 0 || farmerEcon.minimumFarmerMarginUsdPerHosoEqKg < 0) {
      errors.push(`initialStateOverrides.vietnamFarmerEconomics の各構成要素は0以上である必要があります。`);
    }
  }
  if (definition.initialStateOverrides.vietnamTrailingAverageDomesticPurchaseHosoEqTons < 0) {
    errors.push(`initialStateOverrides.vietnamTrailingAverageDomesticPurchaseHosoEqTons は0以上である必要があります。`);
  }
  if (definition.initialStateOverrides.initialDomesticProcurementIntentHosoEqTons < 0) {
    errors.push(`initialStateOverrides.initialDomesticProcurementIntentHosoEqTons は0以上である必要があります。`);
  }

  // 市場×商品ライフサイクル上書き（解決後のパラメータが市場モジュールの健全性
  // 条件を満たすかを、市場モジュール自身の検証関数で確認する。検証規則を
  // シナリオ側へ二重定義しない）。
  if (definition.productLifecycleOverrides !== undefined) {
    try {
      resolveProductLifecycleParameters(PRODUCT_LIFECYCLE_PARAMETERS_V1, definition.productLifecycleOverrides);
    } catch (e) {
      errors.push(`productLifecycleOverrides: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 構造需要アンカー
  const anchor = definition.structuralDemandAnchor;
  if (anchor !== undefined) {
    if (!Number.isFinite(anchor.pullStrength) || anchor.pullStrength < 0 || anchor.pullStrength > 1) {
      errors.push(
        `structuralDemandAnchor.pullStrength は[0,1]の範囲である必要があります。受け取った値: ${anchor.pullStrength}`
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

/** validateScenarioDefinitionの結果が不正な場合に例外化するヘルパー。 */
export function assertValidScenarioDefinition(definition: ScenarioDefinition): void {
  const result = validateScenarioDefinition(definition);
  if (!result.valid) {
    throw new ScenarioValidationError(
      `ScenarioDefinition(${definition.scenarioId}) の検証に失敗しました:\n- ${result.errors.join("\n- ")}`
    );
  }
}
