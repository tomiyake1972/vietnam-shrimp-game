// ShrimpX V2 — 工場・ワーカー・生産モジュール 有効労働能力（Phase 6、Phase 6.1で共有プール化）
//
// 【Phase 6.1修正】常用・臨時ワーカーは、1工場・1WorkerAssignmentにつき有限の
// 共有プールとして扱う。同じ人数を複数商品（HOSO/PD/VAP）へ重複して割り当てる
// ことはできない。商品別の生産計画が同じ工場の労働力を取り合う場合は、
// allocation.tsの他の制約（原料・設備）と同じ優先順位階層＋水位法
// （priorityAllocation.ts、rawMaterials/waterFill.tsの水位法をそのまま再利用）で
// 決定論的に配分する。常用ワーカーと臨時ワーカーは、それぞれ独立した予算として
// 別々に数量保存する（同じ人を常用・臨時の両方としてカウントすることはない。
// WorkerAssignment自体が両者を別フィールドで管理しているため）。
//
// 有効労働能力は、配分された人数・技能水準・稼働可能率・残業から算出する。
//   - 人員増加の効果は設備能力を超えない（factoryCapacityの対応する能力プールで
//     クリップする）。
//   - 残業には設定可能な上限（parameters.labor.overtimeRateCap）を設ける。
//   - 臨時ワーカーは即時利用できるが、常用ワーカーより基準効率
//     （regularEfficiencyPerHeadTons > temporaryEfficiencyPerHeadTons）を低くする。
//   - ワーカーが0人（あるいは対象商品のスキルが0）であれば、設備能力があっても
//     有効労働能力は0となる（＝生産できない。laborShortageとして表面化する）。
// 人件費（USD）は本Phaseでは一切算出しない（記録すべき数量・労働量のみを出力する）。

import { hosoEqTons, ratio, roundHosoEqTons, roundRatio, unwrapUnit } from "../core/units";
import { Product } from "../market/types";
import { allocateByPriorityTiers, PriorityAllocationItem } from "./priorityAllocation";
import { PRODUCTION_PARAMETERS_V1, ProductionParameters } from "./parameters";
import { FactoryEffectiveCapacity, FactoryWorkerAllocationSummary, WorkerAllocationEntry, WorkerAssignment } from "./types";

function skillLevelFor(assignment: WorkerAssignment, product: Product): number {
  const entry = assignment.skills.find((s) => s.product === product);
  return entry ? unwrapUnit(entry.skillLevel) : 0;
}

function capacityPoolFor(factoryCapacity: FactoryEffectiveCapacity, product: Product): number {
  if (product === "hoso") return unwrapUnit(factoryCapacity.hoso);
  if (product === "pd") return unwrapUnit(factoryCapacity.pd);
  return unwrapUnit(factoryCapacity.vap);
}

/**
 * 【Test15新設】商品別の労働集約度係数の唯一の情報源（parameters.ts）を返す。
 * production/labor.ts・companyLab/workforce.ts・意思決定画面・Standard AIは、
 * 商品別の1人あたり生産力を求める際に必ずこの関数（またはこれを内部で使う
 * effectiveEfficiencyPerHeadTons）を経由し、係数を個別にハードコードしない。
 */
export function laborIntensityCoefficientFor(product: Product, params: ProductionParameters = PRODUCTION_PARAMETERS_V1): number {
  const coefficient = params.labor.laborIntensityCoefficient[product];
  return Number.isFinite(coefficient) && coefficient > 0 ? coefficient : 1;
}

/**
 * 【Test15新設】商品別労働集約度を織り込んだ、1人あたりの実効生産力
 * （baseEfficiencyPerHeadTons ÷ 労働集約度係数）。
 * HOSO=1.0を基準に、PD・VAPは同じ人数でより少ない量しか処理できない
 * （＝同じ数量を処理するのにより多くの人手を要する）ことをこの一箇所だけで表現する。
 * calculateLaborCapacityFromAssignedHeadcount・requiredHeadcountForQuantityの
 * 呼び出し側は、いずれもこの関数を通した実効効率を渡す。
 */
export function effectiveEfficiencyPerHeadTons(
  baseEfficiencyPerHeadTons: number,
  product: Product,
  params: ProductionParameters = PRODUCTION_PARAMETERS_V1,
  // 【Test15新設・PD省人化投資】工場単位で係数そのものを上書きしたい場合に使う
  // （companyLab/pdMechanizationState.tsが、稼働中のPD省人化投資案件から算出した
  // その工場だけの実効PD係数をここへ渡す）。省略時はparams.labor.laborIntensityCoefficient
  // をそのまま使う（既存挙動）。0以下・非有限値は無視する（防御的）。
  coefficientOverride?: number
): number {
  const coefficient =
    coefficientOverride !== undefined && Number.isFinite(coefficientOverride) && coefficientOverride > 0
      ? coefficientOverride
      : laborIntensityCoefficientFor(product, params);
  return baseEfficiencyPerHeadTons / coefficient;
}

/**
 * 配分された常用・臨時ワーカー人数から、1商品ぶんの有効労働能力を算出する
 * （純粋な計算式のみを担う低レベル関数。ワーカーの奪い合い解決は
 * allocateWorkersToPlansが行う）。
 */
export function calculateLaborCapacityFromAssignedHeadcount(
  assignedRegularHeadcount: number,
  assignedTemporaryHeadcount: number,
  attendanceRate: number,
  skillLevel: number,
  appliedOvertimeRate: number,
  factoryCapacityForProduct: number,
  params: ProductionParameters = PRODUCTION_PARAMETERS_V1,
  // 【Test15新設】省略時はHOSO扱い（laborIntensityCoefficient.hoso=1.0のため
  // 既存の呼び出し元・既存テストの挙動は変わらない）。商品が分かっている
  // 呼び出し元は必ず対象商品を渡すこと。
  product: Product = "hoso",
  // 【Test15新設・PD省人化投資】productが"pd"のときだけ意味を持つ、工場単位の
  // 実効PD係数の上書き（省略時は通常のlaborIntensityCoefficientをそのまま使う）。
  coefficientOverride?: number
): number {
  const overtimeMultiplier = 1 + appliedOvertimeRate * params.labor.overtimeEfficiencyFactor;
  const regularEfficiency = effectiveEfficiencyPerHeadTons(params.labor.regularEfficiencyPerHeadTons, product, params, coefficientOverride);
  const temporaryEfficiency = effectiveEfficiencyPerHeadTons(params.labor.temporaryEfficiencyPerHeadTons, product, params, coefficientOverride);
  const raw =
    (assignedRegularHeadcount * regularEfficiency + assignedTemporaryHeadcount * temporaryEfficiency) * attendanceRate * skillLevel * overtimeMultiplier;
  return Math.min(Math.max(0, raw), Math.max(0, factoryCapacityForProduct));
}

/**
 * 【Phase 8D-4】ある数量を1人あたり効率だけで満たすために必要な人数。
 *
 * これは calculateLaborCapacityFromAssignedHeadcount の逆算であり、
 * allocateWorkersToPlans の内部（headcountDemandFor）と、意思決定画面が表示する
 * 「必要Worker人数」の**両方がこの1つの関数を共有する**。UI側に別の逆算式を
 * 作らないことで、「画面では足りると出たのに実際は足りない」という食い違いを
 * 構造的に防ぐ。
 *
 * 分母（1人あたり効率 × 出勤率 × 技能 × 残業係数）が0以下のときは、
 * どれだけ人を増やしても生産できないため 0 を返す（無限大を返さない）。
 */
export function requiredHeadcountForQuantity(
  quantity: number,
  efficiencyPerHead: number,
  attendanceRate: number,
  skillLevel: number,
  appliedOvertimeRate: number,
  params: ProductionParameters = PRODUCTION_PARAMETERS_V1
): number {
  const overtimeMultiplier = 1 + appliedOvertimeRate * params.labor.overtimeEfficiencyFactor;
  const denom = efficiencyPerHead * attendanceRate * skillLevel * overtimeMultiplier;
  if (!(denom > 0)) return 0;
  const required = quantity / denom;
  return Number.isFinite(required) && required > 0 ? required : 0;
}

export interface WorkerDemandItem {
  readonly id: string;
  readonly factoryId: string;
  readonly companyId: string;
  readonly product: Product;
  readonly priority: number;
  /** この生産計画が、労働制約以外の各段階を経て到達した候補量（完成品HosoEqTons）。 */
  readonly candidateQuantity: number;
  /** 省略時はassignment.overtimeRateを使う。 */
  readonly overtimeRateOverride?: number;
}

/**
 * 複数の生産計画が同一工場の常用・臨時ワーカープールを取り合う配分を解決する。
 * 常用・臨時それぞれについて、各計画の「その人数種別だけで候補量を満たすために
 * 必要な人数」を重み・capとした優先順位階層配分（allocateByPriorityTiers）を、
 * 工場の実際の配置人数（WorkerAssignment.regularHeadcount /
 * .temporaryHeadcount）を予算として行う。これにより、1工場内で商品別配分人数の
 * 合計が配置人数を超えることはなく、同じワーカーが複数商品で重複計上されることもない。
 */
export function allocateWorkersToPlans(
  demands: readonly WorkerDemandItem[],
  assignments: readonly WorkerAssignment[],
  factoryCapacities: ReadonlyMap<string, FactoryEffectiveCapacity>,
  params: ProductionParameters = PRODUCTION_PARAMETERS_V1,
  // 【Test15新設・PD省人化投資】factoryId→そのFactoryの実効PD係数の上書き。
  // PD以外の商品（HOSO/VAP）のdemandには一切影響しない（headcountDemandFor内で
  // d.product==="pd"の場合にのみ参照する）。省略時は既存挙動と完全に同じ。
  pdCoefficientOverrideByFactoryId?: ReadonlyMap<string, number>
): { readonly entries: readonly WorkerAllocationEntry[]; readonly factorySummaries: readonly FactoryWorkerAllocationSummary[] } {
  // 工場ごとにグループ化して解決するため、結果は一旦demand.id別に記録し、
  // 最後に入力demandsと同じ順序へ復元する（呼び出し側がdemands[i]と
  // entries[i]をインデックスで対応付けられるようにするため。demandsが複数工場に
  // またがって入り乱れている場合、工場グループ順に積むだけでは入力順と一致しない
  // ため、idキーのMapを経由して明示的に入力順へ復元する）。
  const entryById = new Map<string, WorkerAllocationEntry>();
  const factorySummaries: FactoryWorkerAllocationSummary[] = [];

  const factoryIds = Array.from(new Set(demands.map((d) => d.factoryId)));

  for (const factoryId of factoryIds) {
    const factoryDemands = demands.filter((d) => d.factoryId === factoryId);
    const companyId = factoryDemands[0].companyId;
    const assignment = assignments.find((a) => a.factoryId === factoryId && a.companyId === companyId);
    const factoryCapacity = factoryCapacities.get(factoryId);

    const regularHeadcount = assignment?.regularHeadcount ?? 0;
    const temporaryHeadcount = assignment?.temporaryHeadcount ?? 0;
    const attendanceRate = assignment ? unwrapUnit(assignment.attendanceRate) : 0;

    const overtimeCap = params.labor.overtimeRateCap;
    const appliedOvertimeByDemand = new Map<string, number>();
    const skillByDemand = new Map<string, number>();
    for (const d of factoryDemands) {
      const requested = d.overtimeRateOverride ?? (assignment ? unwrapUnit(assignment.overtimeRate) : 0);
      appliedOvertimeByDemand.set(d.id, Math.min(Math.max(0, requested), overtimeCap));
      skillByDemand.set(d.id, assignment ? skillLevelFor(assignment, d.product) : 0);
    }

    // 各計画が「常用ワーカーのみ」「臨時ワーカーのみ」で候補量を満たすために
    // 必要な人数を、水位法配分の重み・capとして使う。
    // 【Phase 8D-4】逆算式は requiredHeadcountForQuantity に一元化した。
    // 意思決定画面の「必要Worker人数」も同じ関数を呼ぶ。
    // 【Test15・PD省人化投資】このFactoryの実効PD係数の上書き（未設定なら通常のまま）。
    const pdCoefficientOverride = pdCoefficientOverrideByFactoryId?.get(factoryId);

    function headcountDemandFor(d: (typeof factoryDemands)[number], baseEfficiencyPerHead: number): number {
      // 【Test15】商品別の労働集約度係数を織り込んだ実効効率で逆算する。
      // PD省人化投資の効果はd.product==="pd"のときだけ適用される（HOSO/VAPは無関係）。
      const efficiencyPerHead = effectiveEfficiencyPerHeadTons(
        baseEfficiencyPerHead,
        d.product,
        params,
        d.product === "pd" ? pdCoefficientOverride : undefined
      );
      return requiredHeadcountForQuantity(
        d.candidateQuantity,
        efficiencyPerHead,
        attendanceRate,
        skillByDemand.get(d.id) ?? 0,
        appliedOvertimeByDemand.get(d.id) ?? 0,
        params
      );
    }

    const regularItems: PriorityAllocationItem[] = factoryDemands.map((d) => ({
      id: d.id,
      priority: d.priority,
      desired: headcountDemandFor(d, params.labor.regularEfficiencyPerHeadTons),
    }));
    const temporaryItems: PriorityAllocationItem[] = factoryDemands.map((d) => ({
      id: d.id,
      priority: d.priority,
      desired: headcountDemandFor(d, params.labor.temporaryEfficiencyPerHeadTons),
    }));

    const assignedRegular = allocateByPriorityTiers(regularItems, regularHeadcount);
    const assignedTemporary = allocateByPriorityTiers(temporaryItems, temporaryHeadcount);

    let totalAssignedRegular = 0;
    let totalAssignedTemporary = 0;

    for (const d of factoryDemands) {
      const regular = assignedRegular.get(d.id) ?? 0;
      const temporary = assignedTemporary.get(d.id) ?? 0;
      totalAssignedRegular += regular;
      totalAssignedTemporary += temporary;

      const capacityPool = factoryCapacity ? capacityPoolFor(factoryCapacity, d.product) : 0;
      const laborCapacity = calculateLaborCapacityFromAssignedHeadcount(
        regular,
        temporary,
        attendanceRate,
        skillByDemand.get(d.id) ?? 0,
        appliedOvertimeByDemand.get(d.id) ?? 0,
        capacityPool,
        params,
        d.product,
        d.product === "pd" ? pdCoefficientOverride : undefined
      );

      entryById.set(d.id, {
        factoryId: d.factoryId,
        companyId: d.companyId,
        product: d.product,
        assignedRegularHeadcount: Math.round(regular * 1e6) / 1e6,
        assignedTemporaryHeadcount: Math.round(temporary * 1e6) / 1e6,
        appliedOvertimeRate: ratio(roundRatio(appliedOvertimeByDemand.get(d.id) ?? 0)),
        laborCapacity: hosoEqTons(roundHosoEqTons(laborCapacity)),
      });
    }

    factorySummaries.push({
      factoryId,
      companyId,
      unassignedRegularHeadcount: Math.max(0, Math.round((regularHeadcount - totalAssignedRegular) * 1e6) / 1e6),
      unassignedTemporaryHeadcount: Math.max(0, Math.round((temporaryHeadcount - totalAssignedTemporary) * 1e6) / 1e6),
    });
  }

  // 入力demandsと同じ順序へ復元して返す（呼び出し側の位置対応の前提を保証する）。
  const entries = demands.map((d) => entryById.get(d.id)!);
  return { entries, factorySummaries };
}
