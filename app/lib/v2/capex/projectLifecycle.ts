// ShrimpX V2 — 設備投資モジュール 案件ライフサイクル（Phase 8B-2A）
//
// 提案評価（承認/拒否）・取消/再開要求の適用・分割支払の優先順位付けと
// 全額支払という、案件1件・1四半期ぶんの状態遷移を扱う純粋関数群。
// 四半期全体のオーケストレーション（現金配分の起点計算・finance/への
// CapexAdjustment組み立て）はcapexClose.tsが行う。

import { PeriodV2 } from "../core/period";
import { CompanyId } from "../sales/types";
import { CapexParameters, CapexProjectTemplate } from "./parameters";
import {
  CapexCancelRequestInput,
  CapexProjectProposalInput,
  CapexProjectQuarterEvent,
  CapexRejectedProposal,
  CapexResumeRequestInput,
  CapexValidationError,
  CapitalProject,
  CapitalProjectPortfolio,
} from "./types";

const EPSILON_RATIO = 1e-6;

// ---------------------------------------------------------------------
// 1. 新規提案の評価（承認/拒否）
// ---------------------------------------------------------------------

export interface ProposalApprovalGate {
  /** 銀行の通常融資引受が停止している状態（financing/のborrowingCapacity.underwritingFrozen）。 */
  readonly borrowingCapacityFrozen: boolean;
  /** 支払不能・債務超過等の重大な資金繰り状態（前期末までの分類。financing/のFinancialHealthStatus由来）。 */
  readonly severelyDistressed: boolean;
}

/**
 * 【Phase 8D-3】工場スペースによる承認ゲート。
 * 呼び出し側（capexClose.ts）が、提案を1件評価するたびに残枠を減らしながら渡すことで、
 * 同一四半期に複数案件を提案した場合の重複承認（＝スペースの二重予約）を防ぐ。
 * 省略された場合はスペース判定を行わない（Phase 8D以前の呼び出し元との後方互換）。
 */
export interface ProposalSpaceGate {
  /** この案件が必要とするスペース（スペース単位）。 */
  readonly requiredSpaceUnits: number;
  /** この案件を評価する時点で残っているスペース（スペース単位）。 */
  readonly remainingSpaceUnits: number;
  /** 工場スペース総量（拒否理由の説明文に使う）。 */
  readonly totalSpaceUnits: number;
  /** 面積比較の許容誤差。 */
  readonly epsilonSpaceUnits: number;
}

/** スペース不足による拒否理由の文言（画面のプレビュー警告と同じ言い回しにする）。 */
export function formatSpaceShortageReason(gate: ProposalSpaceGate): string {
  const shortage = gate.requiredSpaceUnits - gate.remainingSpaceUnits;
  return (
    `工場スペースが不足しているため新規承認を見送り。` +
    `必要スペース ${Math.round(gate.requiredSpaceUnits)} / 空き ${Math.round(Math.max(0, gate.remainingSpaceUnits))}` +
    `（総量 ${Math.round(gate.totalSpaceUnits)}、不足 ${Math.round(Math.max(0, shortage))} スペース単位）。`
  );
}

/**
 * 【Test15新設】新工場建設（newFactoryConstruction）専用の工場数上限ゲート。
 * 呼び出し側（capexClose.ts）が、この提案を承認すると会社の工場数（既存工場＋
 * 取消以外のnewFactoryConstruction案件）が上限を超えるかどうかを事前に判定して渡す。
 * newFactoryConstruction以外の提案には一切関係しない（gate自体を渡さなければ判定しない）。
 */
export interface ProposalFactoryCountGate {
  /** この提案を承認すると工場数が上限を超えるか（capex/factoryConstruction.tsのwouldExceedMaxFactoriesの結果）。 */
  readonly wouldExceedMax: boolean;
  /** 拒否理由の説明文に使う上限値。 */
  readonly maxFactoriesPerCompany: number;
}

/**
 * 【Test15新設】pdMechanization（PD省人化投資）専用の工場単位ゲート。
 * 「1つのFactoryには同時に1件のPD省人化投資しか進行できない」を判定する。
 * 呼び出し側（capexClose.ts）が、その会社の現在の案件一覧（同一四半期内で
 * すでに承認した分を含む）を渡す。
 */
export interface ProposalFactoryMechanizationGate {
  /** すでに同じFactoryを対象とする、取消・完成以外（＝進行中）のpdMechanization案件が存在するか。 */
  readonly hasActiveProjectForSameFactory: boolean;
}

/** 特定Factoryに、進行中（approved/underConstruction/suspended）のpdMechanization案件が既に存在するか判定する。 */
export function hasActivePdMechanizationProjectForFactory(portfolio: readonly CapitalProject[], targetFactoryId: string): boolean {
  return portfolio.some((p) => p.projectType === "pdMechanization" && p.targetFactoryId === targetFactoryId && isActiveStatus(p.status));
}

/**
 * 1件の新規提案を評価する。承認条件（実装指示§12。会社IDでの特殊扱いは
 * 一切行わない。財務・信用診断だけで判定する）:
 *   - 銀行引受停止・重大資金繰り不安（前期末までの情報のみ）の会社は新規承認しない。
 *   - 同時進行中案件数（approved/underConstruction/suspended）が上限に達していれば承認しない。
 *   - 要求予算が指定されている場合は有限の正数であること。
 * 承認された場合はstatus="approved"のCapitalProjectを返す（着工自体は
 * capexClose.tsの支払処理が担う）。拒否の場合は理由つきでCapexRejectedProposalを返す。
 * ここでは構造的な誤用（存在しないprojectType等）以外は一切例外を投げない
 * （会社の資金繰り・信用状態による拒否はここでは通常の業務上の判断であり、
 * 例外ではない。docs/v2/CAPITAL_INVESTMENT_ARCHITECTURE_v0.1.md §エラー処理方針参照）。
 */
export function evaluateProposal(
  companyId: CompanyId,
  proposal: CapexProjectProposalInput,
  currentActiveProjectCount: number,
  gate: ProposalApprovalGate,
  params: CapexParameters,
  period: PeriodV2,
  projectId: string,
  priority: number,
  spaceGate?: ProposalSpaceGate,
  factoryCountGate?: ProposalFactoryCountGate,
  mechanizationGate?: ProposalFactoryMechanizationGate
): { readonly approved: CapitalProject } | { readonly rejected: CapexRejectedProposal } {
  const template: CapexProjectTemplate | undefined = params.templatesByType[proposal.projectType];
  if (!template) {
    throw new CapexValidationError(`未知の投資案件種別です: ${proposal.projectType}`);
  }
  const requestedBudgetUsd = proposal.requestedBudgetUsd ?? template.standardBudgetUsd;

  const reasons: string[] = [];
  if (gate.severelyDistressed) {
    reasons.push("重大な資金繰り状態（支払不能・債務超過等）のため新規承認を見送り。");
  }
  if (gate.borrowingCapacityFrozen) {
    reasons.push("銀行の通常融資引受が停止しているため新規承認を見送り。");
  }
  if (currentActiveProjectCount >= params.maxConcurrentActiveProjectsPerCompany) {
    reasons.push(`同時進行中案件数が上限(${params.maxConcurrentActiveProjectsPerCompany})に達しているため新規承認を見送り。`);
  }
  if (!Number.isFinite(requestedBudgetUsd) || requestedBudgetUsd <= 0) {
    reasons.push(`要求予算が不正です（有限の正数である必要があります。受け取った値: ${requestedBudgetUsd}）。`);
  }
  // 【Phase 8D-3】工場スペース不足は「不可能な案件を正常な案件として確定しない」ための
  // 承認拒否である。例外ではなく理由つきの拒否として返す（既存の資金繰り・案件数上限と
  // 同じ扱い。docs/v2/CAPITAL_INVESTMENT_ARCHITECTURE_v0.1.md §エラー処理方針）。
  if (spaceGate !== undefined && spaceGate.requiredSpaceUnits > spaceGate.remainingSpaceUnits + spaceGate.epsilonSpaceUnits) {
    reasons.push(formatSpaceShortageReason(spaceGate));
  }
  // 【Test15新設】新工場建設のみ、1社あたり最大工場数の上限（既存工場＋取消以外の
  // newFactoryConstruction案件の合計、capex/factoryConstruction.ts参照）で拒否する。
  if (factoryCountGate !== undefined && factoryCountGate.wouldExceedMax) {
    reasons.push(`工場数が上限(${factoryCountGate.maxFactoriesPerCompany})に達しているため、新工場建設の新規承認を見送り。`);
  }
  // 【Test15新設】pdMechanizationはtargetFactoryIdが必須（工場単位の投資のため）。
  if (proposal.projectType === "pdMechanization" && !proposal.targetFactoryId) {
    reasons.push("PD省人化投資は対象Factory（targetFactoryId）の指定が必須です。");
  }
  // 【Test15新設】同一Factoryに進行中のpdMechanization案件が既にある場合は拒否する
  // （1工場につき同時に1件まで）。
  if (proposal.projectType === "pdMechanization" && mechanizationGate?.hasActiveProjectForSameFactory) {
    reasons.push(`工場"${proposal.targetFactoryId}"には既に進行中のPD省人化投資があるため、新規承認を見送り。`);
  }

  if (reasons.length > 0) {
    return { rejected: { projectType: proposal.projectType, requestedBudgetUsd, reasons } };
  }

  const paymentSchedule = template.paymentRatios.map((plannedRatio, stageIndex) => ({ stageIndex, plannedRatio }));
  const ratioSum = paymentSchedule.reduce((s, st) => s + st.plannedRatio, 0);
  if (Math.abs(ratioSum - 1) > EPSILON_RATIO) {
    // テンプレート定義自体の不整合（要求入力の問題ではない）。実装バグとして構造的に拒否する。
    throw new CapexValidationError(`投資案件テンプレート"${proposal.projectType}"の支払比率合計が1.0ではありません（${ratioSum}）。`);
  }

  const approved: CapitalProject = {
    projectId,
    companyId,
    projectType: proposal.projectType,
    approvedBudgetUsd: requestedBudgetUsd,
    paymentSchedule,
    completedPaymentStagesCount: 0,
    cumulativePaidUsd: 0,
    elapsedConstructionQuartersWithPayment: 0,
    requiredConstructionQuarters: template.standardConstructionQuarters,
    status: "approved",
    proposedPeriod: period,
    approvedPeriod: period,
    priority: proposal.priority ?? priority,
    ...(template.futureCapacityEffect !== undefined ? { futureCapacityEffect: template.futureCapacityEffect } : {}),
    // 【Test15新設】newFactoryConstruction案件のみ、新設Factory合成用の情報を
    // 承認時にテンプレートからスナップショットする（他の案件種別は常にundefined）。
    ...(template.newFactoryEffect !== undefined ? { newFactoryEffect: template.newFactoryEffect } : {}),
    // 【Test15新設】pdMechanization等、特定Factoryを対象とする案件のtargetFactoryIdを
    // 承認時にスナップショットする。
    ...(proposal.targetFactoryId !== undefined ? { targetFactoryId: proposal.targetFactoryId } : {}),
    lastDiagnosticReasons: ["承認され、着工待ち（当四半期の支払処理で初回支払を試行する）。"],
  };
  return { approved };
}

// ---------------------------------------------------------------------
// 2. 取消・再開要求の適用
// ---------------------------------------------------------------------

/**
 * 取消要求を適用する。存在しない案件ID・完成/取消済み案件・支払済み
 * （cumulativePaidUsd>0）の案件への取消要求は、いずれも呼び出し側の構造的な
 * 誤用としてCapexValidationErrorを投げる（実装指示§10「支払済みの案件の取消は
 * 拒否する」。会社の資金繰り状態による通常の業務判断ではないため、業務上の
 * 拒否として理由つきで返す対象にはしない）。
 */
export function applyCancelRequest(portfolio: readonly CapitalProject[], request: CapexCancelRequestInput, period: PeriodV2): CapitalProject[] {
  const idx = portfolio.findIndex((p) => p.projectId === request.projectId);
  if (idx < 0) {
    throw new CapexValidationError(`取消要求の対象案件が見つかりません: ${request.projectId}`);
  }
  const project = portfolio[idx];
  if (project.status === "completed" || project.status === "cancelled") {
    throw new CapexValidationError(`案件"${request.projectId}"はすでに${project.status === "completed" ? "完成" : "取消"}済みで、取消できません。`);
  }
  if (project.cumulativePaidUsd > 0) {
    throw new CapexValidationError(`案件"${request.projectId}"は支払済み（累計${project.cumulativePaidUsd}USD）のため取消できません。`);
  }
  const next = [...portfolio];
  next[idx] = {
    ...project,
    status: "cancelled",
    cancelledPeriod: period,
    lastDiagnosticReasons: ["会社の要求により取消（支払実績なしのため取消可）。"],
  };
  return next;
}

/**
 * 再開要求を適用する。suspended以外の案件への再開要求は構造的な誤用として
 * CapexValidationErrorを投げる。再開要求自体は「当四半期の支払対象に含める」
 * という指示にすぎず、支払が実際に成功するかは現金配分の結果次第
 * （capexClose.tsの支払処理）。本関数はstatusを変更しない
 * （支払処理が成功時にunderConstructionへ遷移させる）。
 */
export function validateResumeRequest(portfolio: readonly CapitalProject[], request: CapexResumeRequestInput): CapitalProject {
  const project = portfolio.find((p) => p.projectId === request.projectId);
  if (!project) {
    throw new CapexValidationError(`再開要求の対象案件が見つかりません: ${request.projectId}`);
  }
  if (project.status !== "suspended") {
    throw new CapexValidationError(`案件"${request.projectId}"はsuspended状態ではないため（現在: ${project.status}）、再開要求は不正です。`);
  }
  return project;
}

// ---------------------------------------------------------------------
// 3. 支払優先順位付け（実装指示§15）
// ---------------------------------------------------------------------

/**
 * 当四半期の支払対象になりうる案件を優先順位つきで並べる。
 *   tier0: underConstruction（着工済み、次回分割払いを自動的に試行）
 *   tier1: suspended かつ 当四半期の再開要求あり（再開試行）
 *   tier2: approved（未着工、初回支払を自動的に試行。承認四半期が古い順）
 * suspendedのうち再開要求のない案件はこの四半期の支払対象に含めない
 * （実装指示§15「会社が明示的に再開を希望した場合のみ再試行」）。
 * tie-break: 承認四半期昇順 → priority昇順 → projectId昇順（配列順序への非依存）。
 */
export function buildPaymentQueue(portfolio: readonly CapitalProject[], resumeProjectIds: ReadonlySet<string>): CapitalProject[] {
  const tierOf = (p: CapitalProject): number => {
    if (p.status === "underConstruction") return 0;
    if (p.status === "suspended" && resumeProjectIds.has(p.projectId)) return 1;
    if (p.status === "approved") return 2;
    return 99;
  };
  return portfolio
    .filter((p) => tierOf(p) < 99)
    .sort((a, b) => {
      const ta = tierOf(a);
      const tb = tierOf(b);
      if (ta !== tb) return ta - tb;
      if (a.approvedPeriod !== b.approvedPeriod) return a.approvedPeriod < b.approvedPeriod ? -1 : 1;
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0;
    });
}

// ---------------------------------------------------------------------
// 4. 1件の分割支払試行（全額支払のみ、一部支払は無い）
// ---------------------------------------------------------------------

export interface PaymentAttemptResult {
  readonly updatedProject: CapitalProject;
  readonly event: CapexProjectQuarterEvent;
  readonly cashSpentUsd: number;
  readonly completedTransferUsd: number;
}

/**
 * 1件の案件の当四半期分割払いを試行する。remainingCashUsd以下なら全額支払し
 * 進捗を進める（一部支払は無い。実装指示§16「all-or-nothing」）。支払えない
 * 場合は状態を変更せず（approvedのまま／underConstructionならsuspendedへ）、
 * 診断理由を記録する。
 */
export function attemptPayment(project: CapitalProject, remainingCashUsd: number, period: PeriodV2, params: CapexParameters): PaymentAttemptResult {
  const statusBefore = project.status;
  const stageIndex = project.completedPaymentStagesCount;
  const stage = project.paymentSchedule[stageIndex];
  if (!stage) {
    // 全stage支払済みなのに支払キューに入っている＝呼び出し側のバグ。構造的エラー。
    throw new CapexValidationError(`案件"${project.projectId}"はすでに全分割払いが完了しています（支払対象に含めるのは呼び出し側の誤りです）。`);
  }
  const amountUsd = project.approvedBudgetUsd * stage.plannedRatio;

  if (remainingCashUsd + params.epsilonUsd < amountUsd) {
    const reason = `資金不足のため当四半期の分割払いを見送り（必要 ${amountUsd.toFixed(0)}USD、利用可能 ${Math.max(0, remainingCashUsd).toFixed(0)}USD）。`;
    const statusAfter: CapitalProject["status"] = statusBefore === "underConstruction" ? "suspended" : statusBefore;
    const updatedProject: CapitalProject = { ...project, status: statusAfter, lastDiagnosticReasons: [reason] };
    return {
      updatedProject,
      event: {
        projectId: project.projectId,
        projectType: project.projectType,
        statusBefore,
        statusAfter,
        paymentAttempted: true,
        paymentSucceededUsd: 0,
        reasons: [reason],
      },
      cashSpentUsd: 0,
      completedTransferUsd: 0,
    };
  }

  const completedPaymentStagesCount = project.completedPaymentStagesCount + 1;
  const cumulativePaidUsd = project.cumulativePaidUsd + amountUsd;
  const elapsedConstructionQuartersWithPayment = project.elapsedConstructionQuartersWithPayment + 1;
  const allStagesPaid = completedPaymentStagesCount >= project.paymentSchedule.length;
  const budgetFullyPaid = Math.abs(cumulativePaidUsd - project.approvedBudgetUsd) <= params.epsilonUsd;
  const constructionPeriodReached = elapsedConstructionQuartersWithPayment >= project.requiredConstructionQuarters;
  const completesThisQuarter = allStagesPaid && budgetFullyPaid && constructionPeriodReached;

  const reason = completesThisQuarter
    ? `最終分割払い(${amountUsd.toFixed(0)}USD)完了。固定資産へ振替え完成。`
    : `分割払い${completedPaymentStagesCount}/${project.paymentSchedule.length}回目(${amountUsd.toFixed(0)}USD)完了。`;

  const updatedProject: CapitalProject = {
    ...project,
    completedPaymentStagesCount,
    cumulativePaidUsd,
    elapsedConstructionQuartersWithPayment,
    status: completesThisQuarter ? "completed" : "underConstruction",
    constructionStartedPeriod: project.constructionStartedPeriod ?? period,
    ...(completesThisQuarter ? { completedPeriod: period, capitalizedAmountUsd: cumulativePaidUsd } : {}),
    lastDiagnosticReasons: [reason],
  };

  return {
    updatedProject,
    event: {
      projectId: project.projectId,
      projectType: project.projectType,
      statusBefore,
      statusAfter: updatedProject.status,
      paymentAttempted: true,
      paymentSucceededUsd: amountUsd,
      reasons: [reason],
    },
    cashSpentUsd: amountUsd,
    completedTransferUsd: completesThisQuarter ? cumulativePaidUsd : 0,
  };
}

/** アクティブ状態（同時進行中案件数の上限判定に使う。実装指示§12）。 */
export function isActiveStatus(status: CapitalProject["status"]): boolean {
  return status === "approved" || status === "underConstruction" || status === "suspended";
}

export function replaceProject(portfolio: readonly CapitalProject[], updated: CapitalProject): CapitalProject[] {
  return portfolio.map((p) => (p.projectId === updated.projectId ? updated : p));
}

export function findPortfolioForCompany(state: CapitalProjectPortfolio | undefined, companyId: CompanyId): CapitalProjectPortfolio {
  return state ?? { companyId, projects: [] };
}
