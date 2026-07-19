// ShrimpX V2 — 業界シミュレーション・テスト環境（Phase 3） シナリオ比較
//
// 2つのIndustrySimulationResult（どちらもシミュレーションエンジンがすでに
// 計算した結果）を四半期ごとに並べて差分を取るだけの純粋関数。価格・需給の
// 計算をUI側で再実装しない（実装指示 §9）。同じシナリオ・同じシードで
// 実行した2つの結果を比較すれば、差分は必ずゼロになる。

import { CountryId, COUNTRY_IDS } from "../../market/types";
import { unwrapUnit } from "../../core/units";
import { ActiveScenarioEvent, IndustrySimulationError, IndustrySimulationResult } from "../types";

export interface ScenarioComparisonQuarter {
  readonly turn: number;
  readonly periodLabelA: string;
  readonly periodLabelB: string;
  /** B - A（USD/HOSO換算kg）。国別。 */
  readonly hosoPriceDiff: Readonly<Record<CountryId, number>>;
  readonly vietnamDomesticPriceDiff: number;
  readonly worldSupplyDiff: number;
  readonly worldDemandDiff: number;
  readonly pdPremiumDiff: number;
  readonly vapPremiumDiff: number;
}

export interface ScenarioEventDiffSummary {
  /** シナリオAだけに登場したイベント（シミュレーション期間内に一度でも発現したもの）。 */
  readonly onlyInA: readonly ActiveScenarioEvent[];
  /** シナリオBだけに登場したイベント。 */
  readonly onlyInB: readonly ActiveScenarioEvent[];
}

export interface ScenarioComparisonResult {
  readonly quarters: readonly ScenarioComparisonQuarter[];
  readonly eventDiff: ScenarioEventDiffSummary;
}

function collectEventsById(result: IndustrySimulationResult): ReadonlyMap<string, ActiveScenarioEvent> {
  const map = new Map<string, ActiveScenarioEvent>();
  for (const quarter of result.quarters) {
    for (const event of quarter.activeEvents) {
      if (!map.has(event.eventId)) map.set(event.eventId, event);
    }
  }
  return map;
}

function buildEventDiff(a: IndustrySimulationResult, b: IndustrySimulationResult): ScenarioEventDiffSummary {
  const eventsA = collectEventsById(a);
  const eventsB = collectEventsById(b);
  return {
    onlyInA: Array.from(eventsA.values()).filter((e) => !eventsB.has(e.eventId)),
    onlyInB: Array.from(eventsB.values()).filter((e) => !eventsA.has(e.eventId)),
  };
}

/**
 * 2つのシミュレーション結果を四半期ごとに比較する。ターン数（quartersの件数）が
 * 一致していない場合は比較できないため例外を投げる（実装指示 §9「同じターン数で
 * 比較できるようにする」というUI側の前提を、ここでも構造的に強制する）。
 */
export function compareIndustrySimulations(
  a: IndustrySimulationResult,
  b: IndustrySimulationResult
): ScenarioComparisonResult {
  if (a.quarters.length !== b.quarters.length) {
    throw new IndustrySimulationError(
      `比較する2つのシミュレーション結果のターン数が一致しません（A: ${a.quarters.length}件, B: ${b.quarters.length}件）。同じturnsで実行してください。`
    );
  }

  const quarters: ScenarioComparisonQuarter[] = a.quarters.map((qa, index) => {
    const qb = b.quarters[index];
    if (qa.turn !== qb.turn) {
      throw new IndustrySimulationError(
        `比較する2つのシミュレーション結果のturnが一致しません（index=${index}: A.turn=${qa.turn}, B.turn=${qb.turn}）。`
      );
    }

    const hosoPriceDiff = {} as Record<CountryId, number>;
    for (const c of COUNTRY_IDS) {
      hosoPriceDiff[c] = unwrapUnit(qb.marketResult.hosoPrices[c].price) - unwrapUnit(qa.marketResult.hosoPrices[c].price);
    }

    return {
      turn: qa.turn,
      periodLabelA: qa.periodLabel,
      periodLabelB: qb.periodLabel,
      hosoPriceDiff,
      vietnamDomesticPriceDiff:
        unwrapUnit(qb.marketResult.vietnamDomestic.price) - unwrapUnit(qa.marketResult.vietnamDomestic.price),
      worldSupplyDiff: unwrapUnit(qb.marketResult.worldSupply) - unwrapUnit(qa.marketResult.worldSupply),
      worldDemandDiff: unwrapUnit(qb.marketResult.worldDemand) - unwrapUnit(qa.marketResult.worldDemand),
      pdPremiumDiff: unwrapUnit(qb.marketResult.pdPremium.basePremium) - unwrapUnit(qa.marketResult.pdPremium.basePremium),
      vapPremiumDiff: unwrapUnit(qb.marketResult.vapPremium.basePremium) - unwrapUnit(qa.marketResult.vapPremium.basePremium),
    };
  });

  return { quarters, eventDiff: buildEventDiff(a, b) };
}
