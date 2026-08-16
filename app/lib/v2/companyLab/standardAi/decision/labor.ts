// ShrimpX V2 — Phase SAI-1: 標準経営AI基盤 労働ドメイン（正社員増減・臨時・残業）
//
// 【基本方針（実装指示 §労働）】
//   - 一時的な不足（前期は逼迫していなかったが今期だけ必要人数が現有を上回る）は
//     残業・臨時ワーカーで対応し、正社員は増やさない。
//   - 持続的な不足（前期も労働稼働率が高水準で、今期も不足が続く）は正社員採用を
//     検討する（ただし一気に埋めず、1四半期で埋める比率をdampingで制限し、
//     一度の需要変動で採用しすぎない）。
//   - 持続的な過剰（前期も稼働率が低水準で、今期も余剰が続く）は正社員を緩やかに
//     縮小する。一時的な余剰では人数を変えない（四半期ごとの雇用・解雇の往復を防ぐ）。
//   - 「持続的」の判定は、CompanyDecisionProviderが受け取れる情報（今期の生産計画・
//     前期末までの実績生産量）だけで完結する2四半期分のヒステリシス近似であり、
//     複雑な予測モデルは組み込まない（実装指示どおり）。
//
// 【設計変更履歴・SAI-1開発中に見つけた不具合】当初はFactoryLoadMetrics.
// laborUtilizationRate（前期の会社全体の労働稼働率）を持続性判定に使っていたが、
// この指標は「実際に配属されたワーカーに対する稼働率」であり、そもそも配属され
// なかった余剰人員（遊休労務費として全額costOfSalesに計上される）を分母に含まない
// ため、常に1.0近辺に張り付き、持続的な人員過剰を検出できなかった（32ターン検証で
// 発見。idleLaborCostが常用人件費の6割前後に達しても縮小されない不具合の原因）。
// 現在は、前期実績生産量（observation.lastQuarterActualProductionByProduct、
// CompanyOwnStateが正当に開示する自社実績情報）から前期時点の必要人数を逆算し、
// 現在の必要人数と比較する、より直接的な2時点比較へ置き換えた。

import { ratio, unwrapUnit } from "../../../core/units";
import { CompanyProductionPlanEntry, WorkerAssignment } from "../../../production/types";
import { Product } from "../../../market/types";
import { computeRequiredRegularHeadcount } from "../../workforce";
import { CompanyFixture } from "../../types";
import { StandardAiParameters, STANDARD_AI_PARAMETERS_V1 } from "../parameters";
import { PressureScores } from "../pressures";
import { StandardAiObservation, zeroProductAmount } from "../types";
import { StandardAiDiagnosticEntry } from "../reasonCodes";
import { safeNonNegativeInt, safeRatio } from "../normalize";

const EPSILON = 1e-6;
const SHORTAGE_MARGIN_RATIO = 0.05;
const EXCESS_MARGIN_RATIO = 0.1;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export interface LaborPlanResult {
  readonly workerAssignments: readonly WorkerAssignment[];
  readonly diagnostics: readonly StandardAiDiagnosticEntry[];
}

export function buildStandardAiWorkerAssignments(
  fixture: CompanyFixture,
  observation: StandardAiObservation,
  pressures: PressureScores,
  productionPlans: readonly CompanyProductionPlanEntry[],
  params: StandardAiParameters = STANDARD_AI_PARAMETERS_V1
): LaborPlanResult {
  const diagnostics: StandardAiDiagnosticEntry[] = [];
  const assignments: WorkerAssignment[] = [];

  const capacityTotals = observation.totalCapacityByProduct;
  const hadPriorQuarterProduction = Object.keys(observation.lastQuarterActualProductionByProduct).length > 0;

  // 【Standard AI Factory Activation・Phase FA-1新設・監査で発見した既存ギャップ】
  // fixture.workerBaseline は静的fixture由来であり、稼働開始した新設Factory
  // （newFactoryConstruction完成後にcomputeEffectiveFactories経由でobservation.
  // factoriesへ現れるFactory）を一切含まない。この関数は従来fixture.workerBaseline
  // だけを走査していたため、新設Factoryには**常に**WorkerAssignmentが1件も
  // 生成されず（regularHeadcount=0のまま放置）、設備（capacity）はcapex効果で
  // 自動的にランプしても、それを動かす労働力が構造的に一切配属されない、という
  // 「工場を建てても戦力化されない」の主要因の1つだった（指示§11・§39
  // underactivation監査）。新設Factoryぶんの合成baseline（skillは同一会社の
  // 既存Factoryの平均skillByProductを流用、無ければ1.0=フルスキル。新しい
  // skill-rampモデルは作らない）を作り、既存Factoryのbaselineと結合して走査する。
  const existingFactoryIds = new Set(fixture.workerBaseline.map((b) => b.factoryId));
  const existingSkillSamples = observation.factories.filter((f) => existingFactoryIds.has(f.factoryId));
  const fallbackSkillByProduct: Record<Product, number> = { hoso: 1, pd: 1, vap: 1 };
  if (existingSkillSamples.length > 0) {
    for (const product of ["hoso", "pd", "vap"] as const) {
      const samples = existingSkillSamples.map((f) => f.skillByProduct[product]).filter((v) => Number.isFinite(v) && v > 0);
      if (samples.length > 0) fallbackSkillByProduct[product] = samples.reduce((s, v) => s + v, 0) / samples.length;
    }
  }
  // 【FA-1監査専用ablation】factoryActivationLaborFixEnabled===falseのときだけ、
  // 修正前の挙動（新設Factoryぶんbaseline合成を一切行わない）を再現する。
  const newFactoryBaselines: readonly Pick<WorkerAssignment, "factoryId" | "companyId" | "regularHeadcount" | "skills" | "attendanceRate">[] =
    params.factoryActivationLaborFixEnabled === false
      ? []
      : observation.factories
          .filter((f) => !existingFactoryIds.has(f.factoryId))
          .map((f) => ({
            factoryId: f.factoryId,
            companyId: fixture.companyId,
            regularHeadcount: 0,
            skills: (["hoso", "pd", "vap"] as const).map((product) => ({ product, skillLevel: ratio(fallbackSkillByProduct[product]) })),
            attendanceRate: ratio(0.95),
          }));
  if (newFactoryBaselines.length > 0) {
    diagnostics.push({
      code: "FACTORY_ACTIVATION_LABOR_BASELINE_SYNTHESIZED",
      domain: "labor",
      companyId: fixture.companyId,
      severity: "info",
      keyValues: { newFactoryCount: newFactoryBaselines.length },
      message: `新設Factory ${newFactoryBaselines.map((b) => b.factoryId).join(", ")} ぶんの労働baselineを合成した（同社既存Factoryの平均skillを流用、regularHeadcount=0から開始）。`,
    });
  }

  for (const baseline of [...fixture.workerBaseline, ...newFactoryBaselines]) {
    const factoryObs = observation.factories.find((f) => f.factoryId === baseline.factoryId);
    const currentRegular = factoryObs?.currentRegularHeadcount ?? baseline.regularHeadcount;
    const skillByProduct = factoryObs?.skillByProduct ?? zeroProductAmount();
    const attendanceRate = factoryObs?.attendanceRate ?? unwrapUnit(baseline.attendanceRate);

    const quantityByProduct = zeroProductAmount();
    for (const plan of productionPlans) {
      if (plan.factoryId !== baseline.factoryId) continue;
      quantityByProduct[plan.product] += unwrapUnit(plan.desiredQuantity);
    }

    const required = computeRequiredRegularHeadcount({
      quantityByProduct,
      skillByProduct,
      attendanceRate,
      appliedOvertimeRate: 0,
      temporaryHeadcount: 0,
    });
    const requiredRegular = required.requiredRegularHeadcount;

    // 前期時点の必要人数（この工場の商品別能力シェアで前期実績生産量を按分した近似値）。
    // production.tsの工場按分と同じ考え方（能力比按分）を使い、独自の推定方式を増やさない。
    const lastQuarterFactoryQuantityByProduct = zeroProductAmount();
    if (factoryObs) {
      for (const product of ["hoso", "pd", "vap"] as const) {
        const companyCapacity = capacityTotals[product];
        const share = companyCapacity > EPSILON ? factoryObs.capacityByProduct[product] / companyCapacity : 0;
        lastQuarterFactoryQuantityByProduct[product] = (observation.lastQuarterActualProductionByProduct[product] ?? 0) * share;
      }
    }
    const requiredLastQuarter = computeRequiredRegularHeadcount({
      quantityByProduct: lastQuarterFactoryQuantityByProduct,
      skillByProduct,
      attendanceRate,
      appliedOvertimeRate: 0,
      temporaryHeadcount: 0,
    }).requiredRegularHeadcount;

    const isShortage = requiredRegular > currentRegular * (1 + SHORTAGE_MARGIN_RATIO);
    const isExcess = requiredRegular < currentRegular * (1 - EXCESS_MARGIN_RATIO);
    // 【Standard AI Factory Activation・Phase FA-1・監査で発見した既存デッドロック】
    // currentRegular=0（稼働開始したばかりの新設Factory等、比較対象となる「前四半期の
    // この工場の実績」が存在しない）の場合、sustainedShortageの通常判定
    // （前期も必要人数が現有を上回っていたか）は恒久的にfalseのまま
    // （requiredLastQuarterもcurrentRegular×shareで按分され、稼働開始前は
    // このFactoryの能力シェアが0だったため、常に0>0=falseになる）。結果、
    // 一時的不足（残業・臨時ワーカー）の対応ロジックへ回るが、そちらも
    // temporaryHeadcountを「現有正社員数×比率」で計算するため、currentRegular=0の
    // ままでは臨時ワーカーも常に0人になり、正社員・臨時ワーカーいずれも
    // 永久に増えないデッドロックが生じていた（新設Factoryが完成後も
    // 恒久的に無人のまま、という指示§39 underactivation監査で最も重大な
    // ケースに相当）。currentRegular<=0かつ需要（isShortage）がある場合は、
    // 比較対象となる前期実績が無いこと自体を「初回配属」の根拠とみなし、
    // sustained扱いにして正社員を直接配置する（既存のdampingは適用したまま。
    // 一括フル配置はしない）。
    const isBootstrapFromZero = currentRegular <= EPSILON && isShortage;
    const sustainedShortage =
      params.factoryActivationLaborFixEnabled !== false && isBootstrapFromZero
        ? true
        : isShortage && hadPriorQuarterProduction && requiredLastQuarter > currentRegular * (1 + SHORTAGE_MARGIN_RATIO);
    const sustainedExcess = isExcess && hadPriorQuarterProduction && requiredLastQuarter < currentRegular * (1 - EXCESS_MARGIN_RATIO);

    let newRegular = currentRegular;
    if (sustainedShortage) {
      newRegular = safeNonNegativeInt(currentRegular + params.regularHeadcountAdjustmentDamping * (requiredRegular - currentRegular));
      diagnostics.push({
        code: "HIRING_FOR_SUSTAINED_SHORTAGE",
        domain: "labor",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: { currentRegular, requiredRegular, newRegular },
        message: `工場${baseline.factoryId}: 持続的な人員不足のため常用ワーカーを${currentRegular}人→${newRegular}人へ段階的に増員する。`,
      });
    } else if (sustainedExcess) {
      newRegular = safeNonNegativeInt(currentRegular + params.regularHeadcountAdjustmentDamping * (requiredRegular - currentRegular));
      diagnostics.push({
        code: "HEADCOUNT_REDUCED_FOR_SUSTAINED_EXCESS",
        domain: "labor",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: { currentRegular, requiredRegular, newRegular },
        message: `工場${baseline.factoryId}: 持続的な人員過剰のため常用ワーカーを${currentRegular}人→${newRegular}人へ段階的に縮小する。`,
      });
    }

    const gapRatio = clamp01((requiredRegular - newRegular) / Math.max(EPSILON, newRegular));
    const temporaryHeadcount = isShortage ? safeNonNegativeInt(newRegular * params.maxTemporaryRatioForTransientShortage * gapRatio) : 0;
    const overtimeRate = isShortage ? safeRatio(params.maxOvertimeRateForTransientShortage * gapRatio) : safeRatio(0);

    if (isShortage && !sustainedShortage) {
      diagnostics.push({
        code: "OVERTIME_TEMP_FOR_TRANSIENT_SHORTAGE",
        domain: "labor",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: { requiredRegular, currentRegular: newRegular, temporaryHeadcount, overtimeRate },
        message: `工場${baseline.factoryId}: 一時的な人員不足のため、正社員は増やさず残業・臨時ワーカーで対応する。`,
      });
    }
    if (isShortage) {
      diagnostics.push({
        code: "WORKER_CAPACITY_SHORTAGE",
        domain: "labor",
        companyId: fixture.companyId,
        severity: "warning",
        keyValues: { requiredRegular, currentRegular: newRegular },
        message: `工場${baseline.factoryId}: 必要常用人数が現有人数を上回っている。`,
      });
    }

    assignments.push({
      factoryId: baseline.factoryId,
      companyId: fixture.companyId,
      regularHeadcount: newRegular,
      temporaryHeadcount,
      skills: baseline.skills,
      overtimeRate,
      attendanceRate: baseline.attendanceRate,
    });
  }

  return { workerAssignments: assignments, diagnostics };
}
