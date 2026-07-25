// ShrimpX V2 — 会社経営統合テスト環境 設備投資意思決定UI・案件一覧（Phase 8B-3）表示用データ層
//
// app/lib/v2/capex/（Phase 8B-2A〜8B-2C）が既に実装済みの設備投資エンジン（案件
// テンプレート・案件ライフサイクル・稼働開始判定・能力増加・固定保守費・
// コンポーネント別減価償却）を一切再実装せず、その純粋関数・パラメータだけを
// 読み取って画面表示用に整形する層である（dashboardViewModel.tsと同じ「表示用
// データ層」の設計方針を踏襲）。
//
// 【禁止事項（実装指示§13より）】
//   - 案件種別ごとの投資額・工期・支払比率・能力増加量・保守費率・建物/機械比率・
//     耐用年数をこのファイル以外（Reactコンポーネント側）へハードコードしない。
//   - 稼働開始判定・減価償却計算式をここで独自に再実装しない
//     （必ずcapex/capacityEffect.ts・capex/depreciation.tsの既存純粋関数を呼ぶ）。
//
// 【新規案件候補のプレビュー値の算出方針】
//   まだ承認されていない候補（CapitalProjectとして実在しない）の投資後の
//   減価償却・保守費・稼働開始四半期を、テンプレート値から独自の計算式で
//   算出するのではなく、「今この候補が提案され、以後すべての分割払いが
//   予定どおり成功したと仮定した場合の completed な CapitalProject」を
//   buildHypotheticalOperatingProjectで構築し、それを実際の
//   computeOperationalStartPeriod・computeCapexComponentDepreciationUsd・
//   computeCapexMaintenanceCostUsdへそのまま渡すことで、エンジンの計算式を
//   一切複製せずに「エンジンが実際に計算したのと同じ値」を得る
//   （実装指示§6「既存の純粋関数、またはUIから安全に呼び出せる共通プレビュー
//   関数を使うこと」を、既存関数の直接呼び出しという最も強い形で満たす）。
//   支払スケジュール金額・完成予定四半期の見積りだけは、既存関数が存在しない
//   ためこのファイルで新規に算出するが、唯一の情報源は
//   CAPEX_PARAMETERS_V1（テンプレートのpaymentRatios・standardConstructionQuarters）
//   であり、案件固有の値を一切ハードコードしない。

import { nextPeriod, PeriodV2 } from "../../lib/v2/core/period";
import { CompanyId } from "../../lib/v2/sales/types";
import {
  CAPITAL_PROJECT_TYPES,
  CapexParameters,
  CapexProjectTemplate,
  CapitalProject,
  CapitalProjectType,
  CAPEX_PARAMETERS_V1,
  CapexProjectQuarterEvent,
} from "../../lib/v2/capex";
import { computeCapexComponentDepreciationUsd } from "../../lib/v2/capex/depreciation";
import {
  computeCapexMaintenanceCostUsd,
  computeOperationalStartPeriod,
  isCapexProjectOperationalAt,
} from "../../lib/v2/capex/capacityEffect";

// ---------------------------------------------------------------------
// 0. 期間演算（capex/capacityEffect.ts等と同じローカル実装パターンを踏襲）
// ---------------------------------------------------------------------

function addQuarters(p: PeriodV2, quarters: number): PeriodV2 {
  let result = p;
  for (let i = 0; i < quarters; i++) result = nextPeriod(result);
  return result;
}

// ---------------------------------------------------------------------
// 1. 表示用の日本語ラベル（テンプレート・エンジンの値そのものではなく、
//    UI文言としてこのファイルが持つのが適切な定数）
// ---------------------------------------------------------------------

export const TARGET_PRODUCT_LABELS: Record<string, string> = {
  hoso: "HOSO加工能力",
  pd: "PD加工能力",
  vap: "VAP加工能力",
  commonProcessing: "共通前処理能力",
  freezingPackaging: "冷凍・保管能力",
};

/** 案件種別ごとの短い説明文（テンプレートにdescriptionフィールドが無いため、UI文言としてここで持つ）。 */
const CAPEX_PROJECT_DESCRIPTIONS: Readonly<Record<CapitalProjectType, string>> = {
  hosoLineExpansion: "HOSO（無頭エビ）の加工ラインを増設し、HOSO生産能力を高めます。",
  pdLineExpansion: "PD（殻剥き）加工ラインを増設し、PD生産能力を高めます。",
  vapLineExpansion: "VAP（付加価値加工）ラインを増設し、VAP生産能力を高めます。",
  coldStorageExpansion: "冷凍・冷蔵保管庫を増設し、完成品の保管・出荷能力を高めます。",
  qualityControlEquipment: "品質検査・計測機器を導入します。生産能力は増加しません。",
  environmentalEquipment: "排水処理等の環境対応設備を導入します。生産能力は増加しません。",
  commonProcessingExpansion: "HOSO/PD/VAP共通の前処理（一次加工）能力を増設します。",
};

export type CapexDisplayStatus = "planned" | "underConstruction" | "suspended" | "completedPreparing" | "operating" | "cancelled";

export const CAPEX_DISPLAY_STATUS_LABELS: Readonly<Record<CapexDisplayStatus, string>> = {
  planned: "計画中",
  underConstruction: "建設中",
  suspended: "支払保留中",
  completedPreparing: "完成・操業準備中",
  operating: "稼働中",
  cancelled: "取消",
};

/**
 * CapitalProject.status（エンジン内部の6状態）と、稼働開始判定（completedPeriodと
 * operationalStartPeriodの差）から、実装指示§7が要求する表示用ステータスへ変換する。
 * completedPeriodとoperationalStartPeriodは異なるため、「完成」と「稼働」を
 * 同一状態として表示しない（isCapexProjectOperationalAtの判定をそのまま使う）。
 */
export function computeCapexDisplayStatus(project: CapitalProject, period: PeriodV2): CapexDisplayStatus {
  switch (project.status) {
    case "proposed":
    case "approved":
      return "planned";
    case "underConstruction":
      return "underConstruction";
    case "suspended":
      return "suspended";
    case "cancelled":
      return "cancelled";
    case "completed":
      return isCapexProjectOperationalAt(project, period) ? "operating" : "completedPreparing";
  }
}

// ---------------------------------------------------------------------
// 2. 新規案件候補（テンプレートから導出する、まだ承認されていない候補の表示・
//    プレビュー情報）
// ---------------------------------------------------------------------

/**
 * 候補1件ぶんのプレビュー用の「仮想の完成済みCapitalProject」を構築する。
 * すべての分割払いが予定どおり成功した（着工=提案四半期、完成=提案四半期+
 * (標準工期-1)四半期後）という前提の仮想案件であり、実際に登録・永続化は
 * しない（プレビュー計算のためだけにその場で作る使い捨てオブジェクト）。
 * companyId・projectIdはプレビュー専用のダミー値（表示にもエンジンにも影響しない）。
 */
function buildHypotheticalOperatingProject(
  projectType: CapitalProjectType,
  budgetUsd: number,
  submissionPeriod: PeriodV2,
  params: CapexParameters
): CapitalProject {
  const template = params.templatesByType[projectType];
  const paymentSchedule = template.paymentRatios.map((plannedRatio, stageIndex) => ({ stageIndex, plannedRatio }));
  const completedPeriod = addQuarters(submissionPeriod, template.standardConstructionQuarters - 1);
  const previewCompanyId: CompanyId = "__preview__";
  return {
    projectId: "__preview__",
    companyId: previewCompanyId,
    projectType,
    approvedBudgetUsd: budgetUsd,
    paymentSchedule,
    completedPaymentStagesCount: paymentSchedule.length,
    cumulativePaidUsd: budgetUsd,
    elapsedConstructionQuartersWithPayment: template.standardConstructionQuarters,
    requiredConstructionQuarters: template.standardConstructionQuarters,
    status: "completed",
    proposedPeriod: submissionPeriod,
    approvedPeriod: submissionPeriod,
    constructionStartedPeriod: submissionPeriod,
    completedPeriod,
    capitalizedAmountUsd: budgetUsd,
    priority: 1,
    futureCapacityEffect: template.futureCapacityEffect,
    lastDiagnosticReasons: [],
  };
}

export interface CapexCandidateViewModel {
  readonly projectType: CapitalProjectType;
  readonly displayName: string;
  readonly description: string;
  readonly totalInvestmentUsd: number;
  readonly constructionQuarters: number;
  /** 四半期ごとの予定支払額（USD、合計はtotalInvestmentUsdに一致）。 */
  readonly paymentScheduleUsd: readonly number[];
  /** 今提案した場合に今四半期に予定される支払額（paymentScheduleUsd[0]）。 */
  readonly thisQuarterExpectedPaymentUsd: number;
  readonly capacityIncreaseTonsPerQuarter: number;
  readonly targetProductLabel?: string;
  readonly readinessQuartersAfterCompletion: number;
  /** 今提案し、以後の分割払いがすべて予定どおり成功した場合の完成予定四半期（見積り）。 */
  readonly expectedCompletionPeriod: PeriodV2;
  /** 同上の前提での稼働開始予定四半期（見積り、computeOperationalStartPeriodをそのまま使用）。 */
  readonly expectedOperationalStartPeriod: PeriodV2;
  readonly quarterlyMaintenanceCostUsd: number;
  readonly buildingRatio: number;
  readonly machineryRatio: number;
  readonly buildingUsefulLifeQuarters: number;
  readonly machineryUsefulLifeQuarters: number;
  readonly quarterlyBuildingDepreciationUsd: number;
  readonly quarterlyMachineryDepreciationUsd: number;
  readonly quarterlyTotalDepreciationUsd: number;
}

/**
 * 1案件種別ぶんの候補プレビューを構築する。減価償却・保守費・稼働開始四半期は
 * すべて実際のエンジン純粋関数（buildHypotheticalOperatingProject経由）から
 * 得た値であり、この関数内で独自に計算式を再実装している箇所はない。
 */
export function buildCapexCandidateViewModel(
  projectType: CapitalProjectType,
  submissionPeriod: PeriodV2,
  params: CapexParameters = CAPEX_PARAMETERS_V1,
  requestedBudgetUsd?: number
): CapexCandidateViewModel {
  const template: CapexProjectTemplate = params.templatesByType[projectType];
  const budget = requestedBudgetUsd !== undefined && Number.isFinite(requestedBudgetUsd) && requestedBudgetUsd > 0 ? requestedBudgetUsd : template.standardBudgetUsd;
  const paymentScheduleUsd = template.paymentRatios.map((r) => r * budget);

  const hypo = buildHypotheticalOperatingProject(projectType, budget, submissionPeriod, params);
  const opStart = computeOperationalStartPeriod(hypo.completedPeriod as PeriodV2, template.postCompletionReadinessQuarters);
  const dep = computeCapexComponentDepreciationUsd([hypo], params, opStart);
  const maint = computeCapexMaintenanceCostUsd([hypo], params, opStart);

  return {
    projectType,
    displayName: template.displayName,
    description: CAPEX_PROJECT_DESCRIPTIONS[projectType],
    totalInvestmentUsd: budget,
    constructionQuarters: template.standardConstructionQuarters,
    paymentScheduleUsd,
    thisQuarterExpectedPaymentUsd: paymentScheduleUsd[0] ?? 0,
    capacityIncreaseTonsPerQuarter: template.futureCapacityEffect.capacityIncreaseTonsPerQuarter ?? 0,
    targetProductLabel: template.futureCapacityEffect.targetProduct ? TARGET_PRODUCT_LABELS[template.futureCapacityEffect.targetProduct] : undefined,
    readinessQuartersAfterCompletion: template.postCompletionReadinessQuarters,
    expectedCompletionPeriod: hypo.completedPeriod as PeriodV2,
    expectedOperationalStartPeriod: opStart,
    quarterlyMaintenanceCostUsd: maint,
    buildingRatio: template.buildingRatio,
    machineryRatio: template.machineryRatio,
    buildingUsefulLifeQuarters: params.componentUsefulLifeQuarters.building,
    machineryUsefulLifeQuarters: params.componentUsefulLifeQuarters.machinery,
    quarterlyBuildingDepreciationUsd: dep.buildingUsd,
    quarterlyMachineryDepreciationUsd: dep.machineryUsd,
    quarterlyTotalDepreciationUsd: dep.totalUsd,
  };
}

/** 実装指示§4「7種類すべてを表示する」ぶんの候補一覧（CAPITAL_PROJECT_TYPES順）。 */
export function buildAllCapexCandidateViewModels(
  submissionPeriod: PeriodV2,
  params: CapexParameters = CAPEX_PARAMETERS_V1
): readonly CapexCandidateViewModel[] {
  return CAPITAL_PROJECT_TYPES.map((t) => buildCapexCandidateViewModel(t, submissionPeriod, params));
}

// ---------------------------------------------------------------------
// 3. 既存の投資案件ポートフォリオ一覧（実際にCapitalProjectとして存在する案件）
// ---------------------------------------------------------------------

export interface CapexPortfolioRowViewModel {
  readonly projectId: string;
  readonly projectType: CapitalProjectType;
  readonly projectTypeDisplayName: string;
  readonly displayStatus: CapexDisplayStatus;
  readonly displayStatusLabel: string;
  readonly totalInvestmentUsd: number;
  readonly approvedPeriod: PeriodV2;
  /** completed案件は実際のcompletedPeriod、それ以外は見積り（工期どおり進んだ場合）。 */
  readonly completionPeriod?: PeriodV2;
  readonly isCompletionEstimate: boolean;
  /** completed案件のみ（isCapexProjectOperationalAtの起点と同一のcomputeOperationalStartPeriod）。 */
  readonly operationalStartPeriod?: PeriodV2;
  readonly cumulativePaidUsd: number;
  readonly remainingScheduledPaymentUsd: number;
  /** 今期支払が成功すれば発生する予定額（次の未払stageの予定額。実際に支払えるかは資金繰り次第）。 */
  readonly nextScheduledPaymentUsd: number;
  /** 直近確定四半期の実際の支払実績（CapexProjectQuarterEventがあれば）。 */
  readonly lastActualPaymentUsd?: number;
  /** 建設進捗（0〜1）。完成・取消後はundefined（進捗表示は建設中のみの説明情報 — 実装指示§8）。 */
  readonly constructionProgressRatio?: number;
  readonly isCapacityReflected: boolean;
  readonly capacityIncreaseTonsPerQuarter: number;
  readonly targetProductLabel?: string;
  readonly quarterlyMaintenanceCostUsd: number;
  readonly quarterlyDepreciationUsd: number;
  readonly quarterlyBuildingDepreciationUsd: number;
  readonly quarterlyMachineryDepreciationUsd: number;
  /** cumulativePaidUsd===0かつ完成/取消済みでない案件のみ（projectLifecycle.applyCancelRequestの実際の許可条件と同一）。 */
  readonly cancellable: boolean;
}

/**
 * 1社の実際の投資案件ポートフォリオを、画面表示用に整形する。減価償却・保守費・
 * 稼働開始判定は、各案件を単独の配列として既存のcomputeCapexComponentDepreciationUsd・
 * computeCapexMaintenanceCostUsdへそのまま渡すことで得る（複数案件を集計する
 * ロジック自体は既存関数が担っており、ここでは1件ずつ同じ関数を呼ぶだけ）。
 *
 * lastQuarterEventsByProjectId: 直近確定四半期のCapexQuarterResult.events
 * （companyId一致ぶん）をprojectIdでインデックスしたもの。まだ1四半期も進んでいない
 * 場合はundefinedのままでよい（実装指示§7の「今期支払額」は参考情報であり、
 * 無ければ表示しないだけで画面は壊れない）。
 */
export function buildCapexPortfolioViewModel(
  projects: readonly CapitalProject[],
  params: CapexParameters,
  period: PeriodV2,
  lastQuarterEventsByProjectId?: ReadonlyMap<string, CapexProjectQuarterEvent>
): readonly CapexPortfolioRowViewModel[] {
  return projects.map((project) => {
    const template = params.templatesByType[project.projectType];
    const displayStatus = computeCapexDisplayStatus(project, period);
    const isCompletionEstimate = project.status !== "completed" && project.status !== "cancelled";
    const completionPeriod = project.completedPeriod ?? (isCompletionEstimate ? addQuarters(project.approvedPeriod, project.requiredConstructionQuarters - 1) : undefined);
    const operationalStartPeriod =
      project.status === "completed" && project.completedPeriod !== undefined
        ? computeOperationalStartPeriod(project.completedPeriod, template.postCompletionReadinessQuarters)
        : undefined;

    const remainingScheduledPaymentUsd = Math.max(0, project.approvedBudgetUsd - project.cumulativePaidUsd);
    const nextStage = project.paymentSchedule[project.completedPaymentStagesCount];
    const nextScheduledPaymentUsd =
      (project.status === "approved" || project.status === "underConstruction" || project.status === "suspended") && nextStage
        ? project.approvedBudgetUsd * nextStage.plannedRatio
        : 0;

    const constructionProgressRatio =
      project.status === "approved" || project.status === "underConstruction" || project.status === "suspended"
        ? Math.min(1, project.elapsedConstructionQuartersWithPayment / project.requiredConstructionQuarters)
        : undefined;

    const isCapacityReflected = isCapexProjectOperationalAt(project, period);
    const dep = computeCapexComponentDepreciationUsd([project], params, period);
    const maint = computeCapexMaintenanceCostUsd([project], params, period);

    const lastEvent = lastQuarterEventsByProjectId?.get(project.projectId);

    return {
      projectId: project.projectId,
      projectType: project.projectType,
      projectTypeDisplayName: template.displayName,
      displayStatus,
      displayStatusLabel: CAPEX_DISPLAY_STATUS_LABELS[displayStatus],
      totalInvestmentUsd: project.approvedBudgetUsd,
      approvedPeriod: project.approvedPeriod,
      completionPeriod,
      isCompletionEstimate,
      operationalStartPeriod,
      cumulativePaidUsd: project.cumulativePaidUsd,
      remainingScheduledPaymentUsd,
      nextScheduledPaymentUsd,
      lastActualPaymentUsd: lastEvent?.paymentSucceededUsd,
      constructionProgressRatio,
      isCapacityReflected,
      capacityIncreaseTonsPerQuarter: isCapacityReflected ? template.futureCapacityEffect.capacityIncreaseTonsPerQuarter ?? 0 : 0,
      targetProductLabel: template.futureCapacityEffect.targetProduct ? TARGET_PRODUCT_LABELS[template.futureCapacityEffect.targetProduct] : undefined,
      quarterlyMaintenanceCostUsd: maint,
      quarterlyDepreciationUsd: dep.totalUsd,
      quarterlyBuildingDepreciationUsd: dep.buildingUsd,
      quarterlyMachineryDepreciationUsd: dep.machineryUsd,
      cancellable: project.status !== "completed" && project.status !== "cancelled" && project.cumulativePaidUsd === 0,
    };
  });
}

// ---------------------------------------------------------------------
// 4. 建設進捗の説明文（実装指示§8「4四半期中2四半期経過・進捗50%」のような表示）
// ---------------------------------------------------------------------

export function formatConstructionProgressLabel(row: CapexPortfolioRowViewModel, project: Pick<CapitalProject, "elapsedConstructionQuartersWithPayment" | "requiredConstructionQuarters">): string {
  if (row.constructionProgressRatio === undefined) return "—";
  const pct = Math.round(row.constructionProgressRatio * 1000) / 10;
  return `${project.requiredConstructionQuarters}四半期の工期中 ${project.elapsedConstructionQuartersWithPayment}四半期経過（進捗 ${pct}%）`;
}

// ---------------------------------------------------------------------
// 5. プレイヤー向け説明文（実装指示§10）
// ---------------------------------------------------------------------

export const CAPEX_EXPLANATION_TEXT =
  "設備投資は、将来の生産・保管・品質対応の能力を高めます。ただし、工事期間中から現金の支出が始まり、" +
  "稼働開始後は固定保守費と減価償却費が発生します。能力の増加や費用の発生は、完成した四半期そのものではなく、" +
  "その翌四半期以降（稼働開始四半期）から反映されます。";

export const CAPEX_EXPLANATION_DETAIL_TEXT =
  "取得原価は建物・構築物区分と機械・設備区分に分けて償却します。建物部分は長期（最長25年=100四半期）に" +
  "わたって少しずつ償却され、機械・設備部分はより短期間（最長10年=40四半期）で償却を終えます。" +
  "機械部分の償却が終わった後も、建物部分の償却は独立して続きます。";

/** 案件の重複登録に関する、ドラフト側のソフト警告（エンジン側に重複禁止のルールは無いため、あくまでUI側の注意喚起）。 */
export function isDuplicateProjectTypeInDraft(
  existingProposals: readonly { readonly projectType: CapitalProjectType }[],
  projectType: CapitalProjectType
): boolean {
  return existingProposals.some((p) => p.projectType === projectType);
}
