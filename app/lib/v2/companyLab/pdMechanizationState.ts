// ShrimpX V2 — 会社×工場のPD稼働率・PD省人化投資の状態（Test15新設）
//
// 【このモジュールが存在する理由】
//   PD省人化投資（capex/pdMechanization.ts）の効果は「前四半期に確定した、その
//   Factory固有のPD稼働率」を必要とする。しかしPD稼働率という値自体は、
//   production/*のどこにも永続化された状態として保持されていない
//   （factoryLoadMetrics.laborUtilizationRateは会社全体・労働側の指標であり、
//   商品別・工場単位のPD稼働率とは別物）。そこでworkforce.ts（Worker総人数）と
//   同じ「ターンをまたいで明示的に保持するcompanyLab層の状態」パターンで、
//   Factory単位のPD稼働率だけを新設する。
//
// 【タイミング規約（quality/salesBaseと同じ規約）】
//   当四半期の生産処理が終わった後にこの状態を更新し、次四半期の生産処理の
//   直前に「前四半期末までの値」を読んでPD省人化投資の効果（実効PD係数）を
//   算出する。今期の実績を今期の効果算出へ遡及させることは構造上あり得ない
//   （呼び出し順序がrunner.ts側でそう強制されている。§使い方参照）。
//
// 【疎表現・決定論】salesBase.tsと同じく、値を持つFactoryだけをentriesに保持する
// 疎配列。存在しないfactoryIdはinitialPdUtilizationRatio（新規ゲーム・移行直後・
// そのFactoryでPD生産実績が一度も無い場合の既定値）とみなす。
// entriesはfactoryId昇順にソートして保持し、反復順・保存順の非決定性を持ち込まない。

import { unwrapUnit } from "../core/units";
import { CompanyId } from "../sales/types";
import { Factory, ProductionBatch } from "../production/types";
import { calculateFactoryEffectiveCapacity } from "../production/capacity";
import { PeriodV2, toYearQuarter } from "../core/period";
import { computeOperationalStartPeriod, isCapexProjectOperationalAt } from "../capex/capacityEffect";
import { CapexState, CapitalProject } from "../capex/types";
import {
  computeAdoptionRampProgress,
  computeEffectivePdCoefficient,
  computeFactoryPdUtilization,
  computeMechanizationLevel,
  PD_MECHANIZATION_PARAMETERS_V1,
  PdMechanizationParameters,
} from "../capex/pdMechanization";

// ---------------------------------------------------------------------
// 1. 状態（ターンをまたいで保持する）
// ---------------------------------------------------------------------

export interface FactoryPdUtilizationEntry {
  readonly factoryId: string;
  readonly companyId: CompanyId;
  /** 直近に確定した四半期のPD稼働率（[0,1]）。「前四半期末までの値」として次期の算出にのみ使う。 */
  readonly previousQuarterPdUtilization: number;
}

export interface PdMechanizationState {
  readonly entries: readonly FactoryPdUtilizationEntry[];
}

/** ラボ作成時の初期状態（疎配列・空。全Factoryが暗黙にinitialPdUtilizationRatio扱いになる）。 */
export function buildInitialPdMechanizationState(): PdMechanizationState {
  return { entries: [] };
}

/**
 * 指定Factoryの「前四半期末までのPD稼働率」を取得する。エントリが無い場合
 * （新規ゲーム・移行直後・そのFactoryでPD生産実績が一度も無い場合。Task2の
 * 新設Factoryが初めてPDを生産する四半期を含む）はinitialPdUtilizationRatioを
 * 返す（今期の実績を代用しない）。
 */
export function findPreviousQuarterPdUtilization(
  state: PdMechanizationState | undefined,
  factoryId: string,
  params: PdMechanizationParameters = PD_MECHANIZATION_PARAMETERS_V1
): number {
  const entry = state?.entries.find((e) => e.factoryId === factoryId);
  return entry ? entry.previousQuarterPdUtilization : params.initialPdUtilizationRatio;
}

// ---------------------------------------------------------------------
// 2. 当四半期のPD稼働率算出（生産処理後、確定した実績から）
// ---------------------------------------------------------------------

/**
 * 当四半期の実績（factories・batches）から、Factory単位のPD稼働率を算出する。
 *
 * 【単位の一貫性（重要）】分子はProductionBatch.finishedGoodsQuantity（歩留まり
 * 適用後・販売可能ベースの完成品HOSO換算量、production/batches.ts
 * buildProductionBatches参照）、分母はcalculateFactoryEffectiveCapacity(factory).pd
 * （production/capacity.tsのコメントどおり「完成品HOSO換算量」の上限）。
 * いずれも歩留まり適用後（post-yield）の同じ意味の量であり、原料投入側
 * （rawMaterialConsumedTotal、歩留まり適用前）を分子に使うと数値が不当に小さくなる
 * （processingLoss>0のとき、pre-yield量はpost-yield量より必ず大きいため）。
 */
export function computeCurrentQuarterPdUtilizationByFactory(
  factories: readonly Factory[],
  batches: readonly ProductionBatch[],
  params: PdMechanizationParameters = PD_MECHANIZATION_PARAMETERS_V1
): ReadonlyMap<string, number> {
  const result = new Map<string, number>();
  for (const factory of factories) {
    const pdFinishedGoodsQuantity = batches
      .filter((b) => b.factoryId === factory.factoryId && b.product === "pd")
      .reduce((sum, b) => sum + unwrapUnit(b.finishedGoodsQuantity), 0);
    const pdEffectiveCapacity = unwrapUnit(calculateFactoryEffectiveCapacity(factory).pd);
    result.set(factory.factoryId, computeFactoryPdUtilization(pdFinishedGoodsQuantity, pdEffectiveCapacity, params));
  }
  return result;
}

/**
 * 当四半期に確定したPD稼働率から、次四半期へ繰り越す状態を作る。
 * 当四半期にPD稼働率を算出できなかったFactory（例: 生産計画に一切含まれて
 * いない）は、前四半期までの値をそのまま据え置く（0へリセットしない。
 * 「今期データが無い＝稼働率0」と早合点しない）。
 */
export function deriveNextPdMechanizationState(
  previous: PdMechanizationState | undefined,
  factories: readonly Factory[],
  currentQuarterUtilizationByFactoryId: ReadonlyMap<string, number>
): PdMechanizationState {
  const prevByFactoryId = new Map((previous?.entries ?? []).map((e) => [e.factoryId, e]));
  const entries: FactoryPdUtilizationEntry[] = factories
    .map((f) => {
      const current = currentQuarterUtilizationByFactoryId.get(f.factoryId);
      const prev = prevByFactoryId.get(f.factoryId);
      const value = current !== undefined ? current : (prev?.previousQuarterPdUtilization ?? PD_MECHANIZATION_PARAMETERS_V1.initialPdUtilizationRatio);
      return { factoryId: f.factoryId, companyId: f.companyId, previousQuarterPdUtilization: value };
    })
    .sort((a, b) => (a.factoryId < b.factoryId ? -1 : a.factoryId > b.factoryId ? 1 : 0));
  return { entries };
}

// ---------------------------------------------------------------------
// 3. 実効PD係数の上書きマップ（当四半期の生産処理へ渡す入力）
// ---------------------------------------------------------------------

/**
 * 【重要・タイミング】この関数へ渡すpdMechanizationStateは、必ず「前四半期末までの
 * PD稼働率」（＝当四半期の生産処理を実行する前の時点のstate）でなければならない。
 * capexStateも同様に「前四半期末までの設備投資状態」（当四半期のcloseQuarterWithCapex
 * 呼び出しより前）を使う。runner.tsは既存のworkforceState等と同じ順序規約
 * （前期末状態→当期生産→当期クローズ→次期状態）に従ってこの関数を呼ぶ。
 *
 * 稼働開始済み（isCapexProjectOperationalAt）のpdMechanization案件だけを対象に、
 * targetFactoryIdごとの実効PD係数を算出する。同じFactoryを対象とする案件は
 * 高々1件（承認時のゲートで保証済み。projectLifecycle.ts参照）だが、万一複数
 * 存在する場合は最後に処理したものが勝つ（決定論性のためprojectId昇順で処理する）。
 */
export function buildPdCoefficientOverridesByFactory(
  capexState: CapexState,
  pdMechanizationState: PdMechanizationState | undefined,
  period: PeriodV2,
  params: PdMechanizationParameters = PD_MECHANIZATION_PARAMETERS_V1
): ReadonlyMap<string, number> {
  const statusByFactory = buildPdMechanizationStatusByFactory(capexState, pdMechanizationState, period, params);
  const result = new Map<string, number>();
  for (const [factoryId, status] of statusByFactory) {
    result.set(factoryId, status.effectivePdCoefficient);
  }
  return result;
}

/**
 * 【PD省人化・唯一の正典経路】factoryId → 機械化レベル（0〜1）の対応表。
 *
 * 生産エンジン（production/labor.ts allocateWorkersToPlans）・必要人員の見積り
 * （companyLab/workforce.ts）・意思決定画面・Standard AI・Excelは、いずれも
 * **実効係数ではなくこの「レベル」を受け渡す**。レベルから商品別の実効係数への
 * 写像は production/labor.ts の resolveLaborIntensityCoefficient 1箇所だけが行う。
 *
 * 【なぜ係数ではなくレベルを配るのか】機械化の効果はPDだけでなくVAPにも
 * （前工程の殻剥き共通化ぶんだけ）及ぶため、「PDの実効係数」という1つの数値では
 * 表現しきれない。レベルを配れば、商品ごとの効き方の違いは正典の写像関数の中に
 * 一元的に閉じ込められ、呼び出し側が商品別の分岐を書く必要が無くなる。
 */
export function buildMechanizationLevelsByFactory(
  capexState: CapexState,
  pdMechanizationState: PdMechanizationState | undefined,
  period: PeriodV2,
  params: PdMechanizationParameters = PD_MECHANIZATION_PARAMETERS_V1
): ReadonlyMap<string, number> {
  const statusByFactory = buildPdMechanizationStatusByFactory(capexState, pdMechanizationState, period, params);
  const result = new Map<string, number>();
  for (const [factoryId, status] of statusByFactory) {
    result.set(factoryId, status.mechanizationLevel);
  }
  return result;
}

/** 1工場ぶんのPD省人化投資の状況（UI表示・buildPdCoefficientOverridesByFactoryの両方が使う唯一の計算経路）。 */
export interface PdMechanizationStatus {
  readonly mechanizationLevel: number;
  readonly effectivePdCoefficient: number;
}

/**
 * 【Test15新設・UI表示用】稼働開始済みのpdMechanization案件について、
 * targetFactoryIdごとの機械化レベル・実効PD係数の両方を返す（buildPdCoefficientOverridesByFactory
 * が係数だけを使うのに対し、UI側は「現在のmechanizationLevel」もそのまま表示したいための
 * 追加公開。計算経路自体は完全に同一・重複実装しない）。
 */
export function buildPdMechanizationStatusByFactory(
  capexState: CapexState,
  pdMechanizationState: PdMechanizationState | undefined,
  period: PeriodV2,
  params: PdMechanizationParameters = PD_MECHANIZATION_PARAMETERS_V1
): ReadonlyMap<string, PdMechanizationStatus> {
  const result = new Map<string, PdMechanizationStatus>();
  const allProjects: CapitalProject[] = capexState.companies.flatMap((c) => c.portfolio.projects);
  const mechanizationProjects = allProjects
    .filter((p) => p.projectType === "pdMechanization" && p.targetFactoryId !== undefined)
    .slice()
    .sort((a, b) => (a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0));

  for (const project of mechanizationProjects) {
    if (!isCapexProjectOperationalAt(project, period)) continue;
    const factoryId = project.targetFactoryId!;
    const readiness = project.futureCapacityEffect?.readinessQuartersAfterCompletion ?? 0;
    const operationalStart = computeOperationalStartPeriod(project.completedPeriod!, readiness);
    const quartersSinceActivation = quartersBetweenLocal(operationalStart, period);
    const rampProgress = computeAdoptionRampProgress(quartersSinceActivation, params);
    const previousQuarterPdUtilization = findPreviousQuarterPdUtilization(pdMechanizationState, factoryId, params);
    const mechanizationLevel = computeMechanizationLevel(rampProgress, previousQuarterPdUtilization);
    const effectivePdCoefficient = computeEffectivePdCoefficient(mechanizationLevel, params);
    result.set(factoryId, { mechanizationLevel, effectivePdCoefficient });
  }
  return result;
}

// 期間演算（capex/capacityEffect.ts等と同じローカル実装パターンを踏襲。共通ユーティリティへ抽出しない既存の慣例に従う）。
function quartersBetweenLocal(from: PeriodV2, to: PeriodV2): number {
  const a = toYearQuarter(from);
  const b = toYearQuarter(to);
  return (b.year * 4 + b.quarter) - (a.year * 4 + a.quarter);
}
