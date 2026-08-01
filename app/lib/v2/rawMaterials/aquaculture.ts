// ShrimpX V2 — 国内原料・輸入・養殖・原料在庫モジュール 自社養殖（Phase 5）
//
// 会社管理下の養殖能力・池入れ計画から、養殖強度・バイオセキュリティ・疾病圧力を
// 反映した収穫量を算出する。計算式は単純で説明可能なものにする（実装指示）。
//   expectedProduction = plannedStockingQuantity × (1 + intensityYieldBonusMax × intensity)
//   vulnerabilityMultiplier = 1 + intensityDiseaseVulnerabilityMax × intensity
//   biosecurityMitigation   = bioSecurityMitigationMax × bioSecurityLevel
//   effectiveDiseaseImpact  = clamp(diseasePressure × vulnerabilityMultiplier × (1 - biosecurityMitigation), 0, 1)
//   survivalRatio           = max(minSurvivalRatio, 1 - effectiveDiseaseImpact)
//   actualHarvestQuantity   = expectedProduction × survivalRatio
//
// 疾病圧力はPhase2/3のシナリオ（ScenarioTurnCountryVariables.diseasePressure）
// から外部入力できる構造とし、新しいシナリオ判定は一切重複実装しない
// （呼び出し側がシナリオから読み取った値をそのままharvestAquacultureLotsへ渡す）。
//
// 池入れの翌四半期（標準）に収穫する。養殖投資・支出の会計処理はまだ行わない
// （収穫量・取得原価は原料ロットとして在庫へ追加するだけ）。

import { nextPeriod, PeriodV2 } from "../core/period";
import { HosoEqTons, hosoEqTons, ratio, Ratio, roundHosoEqTons, roundRatio, unwrapUnit, usdPerHosoEqKg } from "../core/units";
import { AquacultureHarvestResult, AquacultureStockingPlanEntry, CompanyId, RawMaterialLot, RawMaterialsValidationError } from "./types";
import { RawMaterialsParameters } from "./parameters";
import { buildLotId } from "./inventoryIds";

const EPSILON = 1e-6;

function resolveHarvestPeriod(entry: AquacultureStockingPlanEntry): PeriodV2 {
  return entry.harvestPeriod ?? nextPeriod(entry.stockingPeriod);
}

/** 養殖強度による補正後、疾病影響前の予定生産量。 */
export function calculateExpectedProduction(entry: AquacultureStockingPlanEntry, params: RawMaterialsParameters): HosoEqTons {
  const bonus = params.aquaculture.intensityYieldBonusMax * unwrapUnit(entry.aquacultureIntensity);
  const expected = unwrapUnit(entry.plannedStockingQuantity) * (1 + bonus);
  return hosoEqTons(roundHosoEqTons(Math.max(0, expected)));
}

/** 疾病・バイオセキュリティを反映した生残率。 */
export function calculateSurvivalRatio(
  entry: Pick<AquacultureStockingPlanEntry, "aquacultureIntensity" | "bioSecurityLevel">,
  diseasePressure: Ratio,
  params: RawMaterialsParameters
): Ratio {
  const a = params.aquaculture;
  const vulnerabilityMultiplier = 1 + a.intensityDiseaseVulnerabilityMax * unwrapUnit(entry.aquacultureIntensity);
  const biosecurityMitigation = a.bioSecurityMitigationMax * unwrapUnit(entry.bioSecurityLevel);
  const rawImpact = unwrapUnit(diseasePressure) * vulnerabilityMultiplier * (1 - biosecurityMitigation);
  const effectiveDiseaseImpact = Math.min(1, Math.max(0, rawImpact));
  const survival = Math.max(a.minSurvivalRatio, 1 - effectiveDiseaseImpact);
  return ratio(roundRatio(Math.min(1, Math.max(0, survival))));
}

function assertValidStockingPlan(entry: AquacultureStockingPlanEntry): void {
  if (unwrapUnit(entry.plannedStockingQuantity) > unwrapUnit(entry.aquacultureCapacity) + EPSILON) {
    throw new RawMaterialsValidationError(
      `会社 "${entry.companyId}" の池入れ予定生産量（${unwrapUnit(entry.plannedStockingQuantity)}）が養殖能力（${unwrapUnit(entry.aquacultureCapacity)}）を超えています。`
    );
  }
}

/**
 * 池入れ計画一式から「養殖中」状態の原料ロットを生成する（この時点では
 * 疾病影響前の予定生産量を暫定の数量として保持し、実際の収穫時に
 * harvestAquacultureLotsで補正・確定する）。
 *
 * 【調達規模効果】自社養殖の単位取得原価（aquacultureUnitCostUsdPerHosoEqKg）自体は
 * 変更しない。discountRatioByCompany（会社別・自社養殖チャネルの割引率、0〜1）が
 * 指定された場合のみ、池入れ時点でロットのunitCostへ(1-discountRatio)を乗じて
 * 記録する（収穫時（harvestAquacultureLots）はロットのunitCostをそのまま引き継ぐ
 * だけなので、ここで一度確定すれば十分。未指定時は従来どおり）。
 */
export function createGrowingLots(
  entries: readonly AquacultureStockingPlanEntry[],
  params: RawMaterialsParameters,
  discountRatioByCompany?: ReadonlyMap<CompanyId, number>
): readonly RawMaterialLot[] {
  const sorted = [...entries].sort((a, b) => (a.companyId !== b.companyId ? a.companyId.localeCompare(b.companyId) : a.stockingPeriod.localeCompare(b.stockingPeriod)));

  const bySequenceKey = new Map<string, number>();
  return sorted.map((entry) => {
    assertValidStockingPlan(entry);
    const expectedProduction = calculateExpectedProduction(entry, params);
    const harvestPeriod = resolveHarvestPeriod(entry);
    const key = `${entry.companyId}::${entry.stockingPeriod}`;
    const sequence = (bySequenceKey.get(key) ?? 0) + 1;
    bySequenceKey.set(key, sequence);

    const lotId = buildLotId("aquaculture", entry.companyId, entry.stockingPeriod, "VN", sequence);
    const discountRatio = Math.max(0, Math.min(1, discountRatioByCompany?.get(entry.companyId) ?? 0));
    const unitCost = usdPerHosoEqKg(params.aquaculture.aquacultureUnitCostUsdPerHosoEqKg * (1 - discountRatio));
    return {
      lotId,
      companyId: entry.companyId,
      source: "aquaculture" as const,
      originCountry: "VN" as const,
      inboundPeriod: entry.stockingPeriod,
      originalQuantity: expectedProduction,
      remainingQuantity: expectedProduction,
      unitCost,
      availableFromPeriod: harvestPeriod,
      status: "growingAquaculture" as const,
      pendingAquacultureIntensity: entry.aquacultureIntensity,
      pendingBioSecurityLevel: entry.bioSecurityLevel,
      pendingPlannedStockingQuantity: entry.plannedStockingQuantity,
    };
  });
}

/**
 * currentPeriod時点で収穫時期（availableFromPeriod <= currentPeriod）に達した
 * "growingAquaculture" ロットを収穫する。疾病圧力（外部入力、未指定時は0）を
 * 反映して実際の収穫量へ補正し、status="available"へ遷移させる（不変更新）。
 * 生残率の再計算に必要な養殖強度・バイオセキュリティ水準は、池入れ時に
 * ロット自身へ保持しておいた値（pendingAquacultureIntensity/pendingBioSecurityLevel）
 * を使う（四半期をまたいでも別途状態を持ち回す必要がない）。
 * 収穫結果の内訳（AquacultureHarvestResult）も併せて返す。
 */
export function harvestAquacultureLots(
  lots: readonly RawMaterialLot[],
  currentPeriod: PeriodV2,
  diseasePressure: Ratio,
  params: RawMaterialsParameters
): { readonly lots: readonly RawMaterialLot[]; readonly harvestResults: readonly AquacultureHarvestResult[] } {
  const harvestResults: AquacultureHarvestResult[] = [];

  const updatedLots = lots.map((lot) => {
    if (lot.source !== "aquaculture" || lot.status !== "growingAquaculture") return lot;
    if (lot.availableFromPeriod.localeCompare(currentPeriod) > 0) return lot;
    if (lot.pendingAquacultureIntensity === undefined || lot.pendingBioSecurityLevel === undefined || lot.pendingPlannedStockingQuantity === undefined) {
      throw new RawMaterialsValidationError(`ロット "${lot.lotId}" に養殖強度・バイオセキュリティ水準の情報がありません（内部不整合）。`);
    }

    const pseudoEntry: Pick<AquacultureStockingPlanEntry, "aquacultureIntensity" | "bioSecurityLevel"> = {
      aquacultureIntensity: lot.pendingAquacultureIntensity,
      bioSecurityLevel: lot.pendingBioSecurityLevel,
    };
    const expectedProduction = lot.originalQuantity;
    const survivalRatio = calculateSurvivalRatio(pseudoEntry, diseasePressure, params);
    const actualHarvestQuantity = hosoEqTons(roundHosoEqTons(Math.max(0, unwrapUnit(expectedProduction) * unwrapUnit(survivalRatio))));

    harvestResults.push({
      companyId: lot.companyId,
      stockingPeriod: lot.inboundPeriod,
      harvestPeriod: lot.availableFromPeriod,
      plannedStockingQuantity: lot.pendingPlannedStockingQuantity,
      expectedProduction,
      diseasePressure,
      survivalRatio,
      actualHarvestQuantity,
      unitCost: lot.unitCost,
    });

    return {
      ...lot,
      originalQuantity: actualHarvestQuantity,
      remainingQuantity: actualHarvestQuantity,
      status: "available" as const,
      pendingAquacultureIntensity: undefined,
      pendingBioSecurityLevel: undefined,
      pendingPlannedStockingQuantity: undefined,
    };
  });

  return { lots: updatedLots, harvestResults };
}
