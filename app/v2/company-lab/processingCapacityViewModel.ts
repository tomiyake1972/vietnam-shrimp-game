// ShrimpX V2 — 会社経営統合テスト環境 工場加工能力（現時点の能力＋現在追加中の能力）表示用データ層
//
// 「工場の現時点の加工能力」と「現在追加中（設備投資を意思決定して、これから
// 加わる能力）」を、意思決定画面とExcel Exportの両方から同一の導出で参照する
// ための唯一の表示用データ層である（capexViewModel.ts・dashboardViewModel.tsと
// 同じ「表示用データ層」の設計方針を踏襲）。
//
// 【この層が存在する理由】
//   絶対値としての「当期の加工能力」は、どこにも永続化されていない。永続化されて
//   いるのは (a) CompanyFixture.factories（ラボ作成時の静的な基礎能力）と
//   (b) CompanyLabState.capexState（投資案件ポートフォリオ）だけであり、
//   当期の実効能力は毎四半期 companyLab/runner.ts:662-663 が
//     applyCapexCapacityToFactories(fixtures.flatMap(f => f.factories), capexState, period)
//   として再導出している。したがって表示側も、独自の加算式を作るのではなく
//   runner.tsと同一のエンジン純粋関数をそのまま呼んで導出する。
//
// 【禁止事項】
//   - 能力増加の加算式・稼働開始判定・基準稼働率/設備利用可能率の適用式を、この
//     ファイルやReactコンポーネント側で独自に再実装しない（必ず
//     capex/capacityEffect.ts の applyCapexCapacityToFactories /
//     computeCapacityEffectForCompany / isCapexProjectOperationalAt と、
//     production/capacity.ts の calculateFactoryEffectiveCapacity を呼ぶ）。
//   - 案件種別ごとの能力増加量・工期・投資額をここへハードコードしない
//     （唯一の情報源はCapexParametersのテンプレートと、案件承認時に
//     スナップショットされたCapitalProject.futureCapacityEffect）。
//   - 履歴が無い項目を0で埋めない（値が存在しない場合はundefinedのまま返し、
//     表示側で「－」を出す）。
//   - 「base + added = current」のような検算をここで結論として持たない
//     （Excel側は数式で、画面側は3列並置で読者が確認できる形にする）。
//
// 【「追加中」の定義（重要）】
//   単純な status ホワイトリスト（approved / underConstruction / suspended）では
//   不足する。案件が completed になっても、
//   futureCapacityEffect.readinessQuartersAfterCompletion のぶんだけ稼働開始が
//   遅れるため、「完成したがまだ能力に反映されていない」状態が存在する。
//   プレイヤーの視点ではこれも「これから加わる能力」である。したがって唯一の
//   判定条件は「取消されておらず、かつ period 時点で
//   isCapexProjectOperationalAt が false であり、かつ能力増加量を持つ」とする。

import { nextPeriod, PeriodV2 } from "../../lib/v2/core/period";
import { HosoEqTons, unwrapUnit } from "../../lib/v2/core/units";
import { CompanyId } from "../../lib/v2/sales/types";
import { Factory, FactoryStatus } from "../../lib/v2/production/types";
import { calculateFactoryEffectiveCapacity } from "../../lib/v2/production/capacity";
import {
  CapexParameters,
  CapexState,
  CapitalProject,
  CapitalProjectType,
  CAPEX_PARAMETERS_V1,
  computeEffectiveFactories,
} from "../../lib/v2/capex";
import { computeOperationalStartPeriod, isCapexProjectOperationalAt } from "../../lib/v2/capex/capacityEffect";
import { CapexDisplayStatus, CAPEX_DISPLAY_STATUS_LABELS, computeCapexDisplayStatus, TARGET_PRODUCT_LABELS } from "./capexViewModel";

// ---------------------------------------------------------------------
// 1. 能力プールの定義（Factoryの5つの能力フィールドに1:1対応）
// ---------------------------------------------------------------------

export type CapacityPoolKey = "commonProcessing" | "hoso" | "pd" | "vap" | "freezingPackaging";

export const CAPACITY_POOL_KEYS: readonly CapacityPoolKey[] = [
  "commonProcessing",
  "hoso",
  "pd",
  "vap",
  "freezingPackaging",
];

/**
 * プール名の日本語ラベル。capexViewModel.tsのTARGET_PRODUCT_LABELS（投資案件の
 * 増強対象ラベル）と同一の語を使う（「UI内で別定義を作らない」の方針。
 * TARGET_PRODUCT_LABELSはCapitalProject.futureCapacityEffect.targetProductの
 * キーで引くが、そのキー集合はCapacityPoolKeyと完全に一致する）。
 */
export const CAPACITY_POOL_LABELS: Readonly<Record<CapacityPoolKey, string>> = {
  commonProcessing: TARGET_PRODUCT_LABELS.commonProcessing,
  hoso: TARGET_PRODUCT_LABELS.hoso,
  pd: TARGET_PRODUCT_LABELS.pd,
  vap: TARGET_PRODUCT_LABELS.vap,
  freezingPackaging: TARGET_PRODUCT_LABELS.freezingPackaging,
};

/** 能力プールの意味（HosoEqTonsという同じ単位でも、制約が掛かる段階が異なる）。 */
export const CAPACITY_POOL_DESCRIPTIONS: Readonly<Record<CapacityPoolKey, string>> = {
  commonProcessing: "原料投入時点の共通前処理（一次加工）能力の上限（原料投入HOSO換算トン/四半期）。",
  hoso: "HOSO（無頭エビ）の加工能力の上限（完成品HOSO換算トン/四半期）。",
  pd: "PD（殻剥き）の加工能力の上限（完成品HOSO換算トン/四半期）。",
  vap: "VAP（付加価値加工）の加工能力の上限（完成品HOSO換算トン/四半期）。",
  freezingPackaging: "冷凍・包装・保管の処理能力の上限（完成品HOSO換算トン/四半期）。",
};

function poolNominalTons(factory: Factory, pool: CapacityPoolKey): number {
  switch (pool) {
    case "commonProcessing":
      return unwrapUnit(factory.commonProcessingCapacity);
    case "hoso":
      return unwrapUnit(factory.hosoCapacity);
    case "pd":
      return unwrapUnit(factory.pdCapacity);
    case "vap":
      return unwrapUnit(factory.vapCapacity);
    case "freezingPackaging":
      return unwrapUnit(factory.freezingPackagingCapacity);
  }
}

function unwrapOrZero(v: HosoEqTons): number {
  return unwrapUnit(v);
}

// ---------------------------------------------------------------------
// 2. 型定義
// ---------------------------------------------------------------------

/** 1工場・1プールぶんの能力の内訳。 */
export interface CapacityPoolBreakdown {
  readonly poolKey: CapacityPoolKey;
  readonly poolLabel: string;
  /** ラボ作成時の静的な基礎名目能力（CompanyFixture.factories、トン/四半期）。 */
  readonly baseNominalTons: number;
  /** すでに稼働開始した設備投資による名目能力の増加ぶん（トン/四半期）。 */
  readonly addedByOperationalCapexTons: number;
  /** 当期の名目能力（base + added。runner.tsがエンジンへ渡す値と同一）。 */
  readonly currentNominalTons: number;
  /** 当期の実効能力（名目能力 × 基準稼働率 × 設備利用可能率。status!=="active"なら0）。 */
  readonly currentEffectiveTons: number;
}

/** 1工場ぶんの能力サマリ。 */
export interface FactoryCapacityViewModel {
  readonly factoryId: string;
  readonly companyId: CompanyId;
  readonly status: FactoryStatus;
  readonly baseUtilizationRate: number;
  readonly equipmentAvailabilityRate: number;
  /** この工場が、その会社の設備投資効果の加算先（主工場）かどうか。 */
  readonly receivesCapexCapacity: boolean;
  readonly pools: readonly CapacityPoolBreakdown[];
}

/** 「現在追加中」の設備投資案件1件ぶん（まだ当期能力へ反映されていない案件）。 */
export interface PendingCapacityProjectViewModel {
  readonly projectId: string;
  readonly projectType: CapitalProjectType;
  readonly projectTypeDisplayName: string;
  readonly displayStatus: CapexDisplayStatus;
  readonly displayStatusLabel: string;
  /** 増強される能力プール（テンプレートではなく承認時スナップショットのtargetProduct）。 */
  readonly targetPoolKey?: CapacityPoolKey;
  readonly targetPoolLabel?: string;
  /** 稼働開始後に加わる名目能力（トン/四半期）。 */
  readonly capacityIncreaseTonsPerQuarter: number;
  readonly approvedPeriod: PeriodV2;
  /** completedなら実際の完成四半期、建設中なら工期どおり進んだ場合の見積り。 */
  readonly completionPeriod?: PeriodV2;
  readonly isCompletionEstimate: boolean;
  /** completedのみ確定。建設中は完成時期が未確定なため算出しない（推測値を実績として出さない）。 */
  readonly operationalStartPeriod?: PeriodV2;
  readonly requiredConstructionQuarters: number;
  readonly elapsedConstructionQuartersWithPayment: number;
  readonly approvedBudgetUsd: number;
  readonly cumulativePaidUsd: number;
  readonly remainingScheduledPaymentUsd: number;
}

/** 1社ぶんの加工能力ビュー（当期能力＋追加中）。 */
export interface CompanyProcessingCapacityViewModel {
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  readonly factories: readonly FactoryCapacityViewModel[];
  /** 全工場合計のプール別内訳（会社が1工場のみでも同じ形で返す）。 */
  readonly companyTotals: readonly CapacityPoolBreakdown[];
  /** まだ当期能力へ反映されていない案件（能力増加を持つものだけ）。 */
  readonly pendingProjects: readonly PendingCapacityProjectViewModel[];
  /** 追加中案件のプール別合計（トン/四半期）。 */
  readonly pendingTotalsByPool: Readonly<Record<CapacityPoolKey, number>>;
}

// ---------------------------------------------------------------------
// 3. 導出
// ---------------------------------------------------------------------

function findCompanyProjects(capexState: CapexState, companyId: CompanyId): readonly CapitalProject[] {
  const entry = capexState.companies.find((c) => c.companyId === companyId);
  return entry ? entry.portfolio.projects : [];
}

function isPendingCapacityProject(project: CapitalProject, period: PeriodV2): boolean {
  if (project.status === "cancelled") return false;
  if (isCapexProjectOperationalAt(project, period)) return false;
  const effect = project.futureCapacityEffect;
  if (!effect || effect.targetProduct === undefined) return false;
  return (effect.capacityIncreaseTonsPerQuarter ?? 0) > 0;
}

/**
 * 建設中案件の完成予定四半期の見積り（capexViewModel.tsの
 * buildCapexPortfolioViewModelと同一の式: approvedPeriod + (工期 - 1)四半期）。
 * 見積りであることは isCompletionEstimate フラグで必ず区別して表示する。
 */
function estimateCompletionPeriod(approvedPeriod: PeriodV2, requiredConstructionQuarters: number): PeriodV2 {
  let result = approvedPeriod;
  for (let i = 0; i < Math.max(0, requiredConstructionQuarters - 1); i++) result = nextPeriod(result);
  return result;
}

function emptyPendingTotals(): Record<CapacityPoolKey, number> {
  return { commonProcessing: 0, hoso: 0, pd: 0, vap: 0, freezingPackaging: 0 };
}

/**
 * 1社ぶんの加工能力ビューを構築する。
 *
 * baseFactories には、その会社ぶんの CompanyFixture.factories（静的な基礎能力）を
 * そのまま渡す。当期能力は applyCapexCapacityToFactories をこの関数の中で呼んで
 * 導出するため、呼び出し側で加算済みのFactory[]を渡してはならない（二重加算に
 * なる）。
 *
 * 「稼働開始済み設備投資による増加ぶん」は、当期Factoryと基礎Factoryの同一
 * フィールドの差として求める。これは加算式の再実装ではなく、エンジンが実際に
 * 適用した結果の分解であり、「どの工場へ加算されるか（主工場のみ）」という
 * applyCapexCapacityToFactoriesの内部規則をUI側で複製しないための方法である。
 */
export function buildCompanyProcessingCapacityViewModel(input: {
  readonly companyId: CompanyId;
  readonly baseFactories: readonly Factory[];
  readonly capexState: CapexState;
  readonly period: PeriodV2;
  readonly params?: CapexParameters;
}): CompanyProcessingCapacityViewModel {
  const params = input.params ?? CAPEX_PARAMETERS_V1;
  const companyBase = input.baseFactories.filter((f) => f.companyId === input.companyId);
  // 【Test15・develop/v2統合（Required fix 2）】唯一の計算箇所
  // capex/factoryConstruction.ts computeEffectiveFactoriesを使う（applyCapexCapacityToFactories
  // だけだと、稼働開始済みの新設Factory自体がcurrentFactoriesへ一切現れず、画面の
  // 加工能力一覧から新設工場が丸ごと消えてしまう欠落があった）。
  const currentFactories = computeEffectiveFactories(companyBase, input.capexState, input.period);
  const currentById = new Map(currentFactories.map((f) => [f.factoryId, f]));

  // 【Test15・develop/v2統合（Required fix 2）】companyBaseだけでなく、稼働開始
  // 済みの新設Factory（companyBaseには存在しないfactoryId）も含めて一覧化する。
  // 新設Factoryにはbaseに相当する「加算前の値」が存在しない（新設Factory自体が
  // すでに完成済み能力そのものであるため）ため、baseNominalTons=0・全量を
  // addedByOperationalCapexTonsとして扱う（新設Factoryは既存工場の能力増強とは
  // 別枠、という設計に合わせた自然な表現）。
  const allFactoryIds = Array.from(new Set([...companyBase.map((f) => f.factoryId), ...currentFactories.map((f) => f.factoryId)]));
  const factories: FactoryCapacityViewModel[] = allFactoryIds.map((factoryId) => {
    const base = companyBase.find((f) => f.factoryId === factoryId);
    const current = currentById.get(factoryId) ?? base!;
    const effective = calculateFactoryEffectiveCapacity(current);
    const effectiveByPool: Readonly<Record<CapacityPoolKey, number>> = {
      commonProcessing: unwrapOrZero(effective.commonProcessing),
      hoso: unwrapOrZero(effective.hoso),
      pd: unwrapOrZero(effective.pd),
      vap: unwrapOrZero(effective.vap),
      freezingPackaging: unwrapOrZero(effective.freezingPackaging),
    };

    const pools: CapacityPoolBreakdown[] = CAPACITY_POOL_KEYS.map((poolKey) => {
      // 【Test15・develop/v2統合（Required fix 2）】稼働開始したばかりの新設
      // Factoryにはbase（加算前の値）が存在しない。新設Factory自体がすでに
      // 完成済み能力そのものであるため、baseNominalTonsは0とし、現在能力の
      // 全量をaddedByOperationalCapexTons（＝この四半期までに新たに加わった量）
      // として扱う。
      const baseNominalTons = base ? poolNominalTons(base, poolKey) : 0;
      const currentNominalTons = poolNominalTons(current, poolKey);
      return {
        poolKey,
        poolLabel: CAPACITY_POOL_LABELS[poolKey],
        baseNominalTons,
        addedByOperationalCapexTons: currentNominalTons - baseNominalTons,
        currentNominalTons,
        currentEffectiveTons: effectiveByPool[poolKey],
      };
    });

    return {
      factoryId: current.factoryId,
      companyId: current.companyId,
      status: current.status,
      baseUtilizationRate: unwrapUnit(current.baseUtilizationRate),
      equipmentAvailabilityRate: unwrapUnit(current.equipmentAvailabilityRate),
      receivesCapexCapacity: pools.some((p) => p.addedByOperationalCapexTons !== 0),
      pools,
    };
  });

  const companyTotals: CapacityPoolBreakdown[] = CAPACITY_POOL_KEYS.map((poolKey) => {
    let baseNominalTons = 0;
    let addedByOperationalCapexTons = 0;
    let currentNominalTons = 0;
    let currentEffectiveTons = 0;
    for (const f of factories) {
      const p = f.pools.find((x) => x.poolKey === poolKey);
      if (!p) continue;
      baseNominalTons += p.baseNominalTons;
      addedByOperationalCapexTons += p.addedByOperationalCapexTons;
      currentNominalTons += p.currentNominalTons;
      currentEffectiveTons += p.currentEffectiveTons;
    }
    return {
      poolKey,
      poolLabel: CAPACITY_POOL_LABELS[poolKey],
      baseNominalTons,
      addedByOperationalCapexTons,
      currentNominalTons,
      currentEffectiveTons,
    };
  });

  const projects = findCompanyProjects(input.capexState, input.companyId);
  const pendingTotalsByPool = emptyPendingTotals();

  const pendingProjects: PendingCapacityProjectViewModel[] = projects
    .filter((p) => isPendingCapacityProject(p, input.period))
    .map((project) => {
      const template = params.templatesByType[project.projectType];
      const effect = project.futureCapacityEffect;
      const targetPoolKey = effect?.targetProduct as CapacityPoolKey | undefined;
      const amount = effect?.capacityIncreaseTonsPerQuarter ?? 0;
      if (targetPoolKey !== undefined) pendingTotalsByPool[targetPoolKey] += amount;

      const isCompletionEstimate = project.status !== "completed" && project.status !== "cancelled";
      const completionPeriod =
        project.completedPeriod ??
        (isCompletionEstimate ? estimateCompletionPeriod(project.approvedPeriod, project.requiredConstructionQuarters) : undefined);
      const operationalStartPeriod =
        project.status === "completed" && project.completedPeriod !== undefined
          ? computeOperationalStartPeriod(project.completedPeriod, template.postCompletionReadinessQuarters)
          : undefined;

      const displayStatus = computeCapexDisplayStatus(project, input.period);

      return {
        projectId: project.projectId,
        projectType: project.projectType,
        projectTypeDisplayName: template.displayName,
        displayStatus,
        displayStatusLabel: CAPEX_DISPLAY_STATUS_LABELS[displayStatus],
        targetPoolKey,
        targetPoolLabel: targetPoolKey !== undefined ? CAPACITY_POOL_LABELS[targetPoolKey] : undefined,
        capacityIncreaseTonsPerQuarter: amount,
        approvedPeriod: project.approvedPeriod,
        completionPeriod,
        isCompletionEstimate,
        operationalStartPeriod,
        requiredConstructionQuarters: project.requiredConstructionQuarters,
        elapsedConstructionQuartersWithPayment: project.elapsedConstructionQuartersWithPayment,
        approvedBudgetUsd: project.approvedBudgetUsd,
        cumulativePaidUsd: project.cumulativePaidUsd,
        remainingScheduledPaymentUsd: Math.max(0, project.approvedBudgetUsd - project.cumulativePaidUsd),
      };
    });

  return {
    companyId: input.companyId,
    period: input.period,
    factories,
    companyTotals,
    pendingProjects,
    pendingTotalsByPool,
  };
}
