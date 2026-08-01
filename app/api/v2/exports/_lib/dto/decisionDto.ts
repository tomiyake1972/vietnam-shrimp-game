// ShrimpX V2 — Export DTO / §6 意思決定情報（会社スコープ／GMスコープ）
//
// 【データ源（すべて既存の確定履歴に保存済み）】
//   - プレイヤー提出         → entry.playerSubmission（CompanyDecisionInput）
//   - 全社の提出意思決定     → entry.record.decisions（readonly CompanyDecisionInput[]、5社ぶん）
//   - 他社の意思決定         → entry.otherCompaniesDecisions
//   - 全社の処理結果・警告   → entry.record.globalReasonCodes（会社別警告は
//                              companySummaries[].reasonCodes、財務結果は §2 のDTO）
//
// 【スコープ隔離（三宅さんの指示 §6、最重要）】
//   会社スコープ（プレイヤー向け）: 対象会社1社ぶんの提出意思決定のみ。他社の
//   非公開意思決定を一切混入させない。globalReasonCodes も対象会社ぶんへ絞り込む。
//   GMスコープ: 全5社の提出意思決定・他社意思決定・全社の警告を収録する。
//   会社スコープ用の関数は buildExportCompanyDecision*、GMスコープ専用の関数は
//   buildExportAllCompaniesDecisions で、名前で区別できるようにしている。
//
// 【AI提案との差（§6の3項目め）】
//   【feature/v2-persist-standard-ai-proposal（Phase A）で更新】
//   CompanyLabQuarterHistoryEntry.aiProposal / diffFromAiProposal は、以前は型のみ
//   先行定義され実際には一切代入されていなかった（companyLabQuarterFlowService.ts
//   の processQuarter が、提出済みdraft envelopeに永続化されたaiProposalDiagnostics
//   から実際に計算するようになった）。したがって、この機能の導入後に確定した
//   履歴エントリでは、原則として値が入っている。
//   ただし、導入前に保存された既存draftがそのまま提出・確定した履歴エントリ
//   （後方互換ケース）では、依然としてundefinedのままである。この場合のみ、
//   本DTOは推測値を実績として作らず（三宅さんの指示 §9）、aiProposal /
//   diffFromAiProposal を null とし、aiProposalUnavailableReason に理由を
//   明示して出力する。
//
// 【許可フィールドの明示的組み立て】内部型 CompanyDecisionInput をそのまま
// spreadせず、8つの意思決定領域をフィールドごとに列挙する。
// salesPlans は §3 の ExportSalesPlanEntry、domesticPurchasePlan は §5 の
// ExportDomesticPurchasePlan を再利用する（一方向importのみ・循環なし）。

import { CompanyId } from "../../../../../lib/v2/sales/types";
import {
  CompanyDecisionInput,
  CompanyReasonEntry,
} from "../../../../../lib/v2/companyLab/types";
import { CompanyLabQuarterHistoryEntry, DecisionDiffSummary } from "../../../../../lib/v2/companyLab/persistence/types";
import {
  AquacultureStockingPlanEntry,
  ImportOrderInput,
} from "../../../../../lib/v2/rawMaterials/types";
import {
  CompanyProductionPlanEntry,
  WorkerAssignment,
  WorkerSkillEntry,
} from "../../../../../lib/v2/production/types";
import { FinancingRequestInput } from "../../../../../lib/v2/financing/types";
import {
  CapexCancelRequestInput,
  CapexDecisionInput,
  CapexProjectProposalInput,
  CapexResumeRequestInput,
} from "../../../../../lib/v2/capex/types";
import { PeriodV2 } from "../../../../../lib/v2/core/period";
import { ExportSalesPlanEntry, buildExportSalesPlanEntry } from "./salesDto";
import { ExportDomesticPurchasePlan, buildExportDomesticPurchasePlan } from "./operationsDto";

/** aiProposal / diffFromAiProposal が出力できない理由の定型文（§9の報告義務に対応）。 */
export const AI_PROPOSAL_UNAVAILABLE_REASON =
  "feature/v2-persist-standard-ai-proposal導入前に保存されたdraftがそのまま提出・確定した" +
  "履歴エントリのため、turn開始時のStandard AI原案（aiProposalDiagnostics）が保存されておらず、" +
  "aiProposal / diffFromAiProposalが未保存（undefined）である。推測値を実績として補完しないため null を返す。";

// ---------------------------------------------------------------------
// 輸入発注
// ---------------------------------------------------------------------

/** 輸入原料の発注（ImportOrderInput の許可項目）。 */
export interface ExportImportOrder {
  readonly companyId: CompanyId;
  readonly originCountry: string;
  /** 発注量（HOSO換算トン）。 */
  readonly orderedQuantity: number;
  readonly orderedPeriod: PeriodV2;
  /** 発注から到着までのターン数（未指定なら null＝標準リードタイム）。 */
  readonly leadTimeTurns: number | null;
  /** 最大許容着地価格（USD/HOSO換算kg、未指定なら null＝上限なし）。 */
  readonly maxLandedPriceUsdPerHosoEqKg: number | null;
}

function buildExportImportOrder(order: ImportOrderInput): ExportImportOrder {
  return {
    companyId: order.companyId,
    originCountry: order.originCountry,
    orderedQuantity: order.orderedQuantity,
    orderedPeriod: order.orderedPeriod,
    leadTimeTurns: order.leadTimeTurns ?? null,
    maxLandedPriceUsdPerHosoEqKg: order.maxLandedPriceUsdPerHosoEqKg ?? null,
  };
}

// ---------------------------------------------------------------------
// 養殖池入れ計画
// ---------------------------------------------------------------------

/** 自社養殖の池入れ計画（AquacultureStockingPlanEntry の許可項目）。 */
export interface ExportAquacultureStockingPlan {
  readonly companyId: CompanyId;
  /** 会社別養殖能力（HOSO換算トン/四半期）。 */
  readonly aquacultureCapacity: number;
  /** 池入れ予定生産量（養殖強度補正前、HOSO換算トン）。 */
  readonly plannedStockingQuantity: number;
  /** 養殖強度（0〜1）。 */
  readonly aquacultureIntensity: number;
  /** バイオセキュリティ水準（0〜1）。 */
  readonly bioSecurityLevel: number;
  readonly stockingPeriod: PeriodV2;
  /** 予定収穫四半期（未指定なら null＝池入れの翌四半期）。 */
  readonly harvestPeriod: PeriodV2 | null;
}

function buildExportAquacultureStockingPlan(plan: AquacultureStockingPlanEntry): ExportAquacultureStockingPlan {
  return {
    companyId: plan.companyId,
    aquacultureCapacity: plan.aquacultureCapacity,
    plannedStockingQuantity: plan.plannedStockingQuantity,
    aquacultureIntensity: plan.aquacultureIntensity,
    bioSecurityLevel: plan.bioSecurityLevel,
    stockingPeriod: plan.stockingPeriod,
    harvestPeriod: plan.harvestPeriod ?? null,
  };
}

// ---------------------------------------------------------------------
// 生産計画
// ---------------------------------------------------------------------

/** 生産計画（CompanyProductionPlanEntry の許可項目。rawMaterialLotSelectorは平坦化）。 */
export interface ExportProductionPlanEntry {
  readonly companyId: CompanyId;
  readonly factoryId: string;
  readonly product: string;
  /** 生産希望量（HOSO換算トン）。 */
  readonly desiredQuantity: number;
  /** 生産優先順位（小さいほど優先）。 */
  readonly priority: number;
  /** この生産計画に適用する残業率の上書き（未指定なら null＝ワーカー配置側の残業率）。 */
  readonly overtimeRateOverride: number | null;
  /** 使用原料ロットの調達源条件（未指定なら null＝FIFO全ロット対象）。 */
  readonly rawMaterialLotSelectorSource: string | null;
  /** 使用原料ロットの原産国条件（未指定なら null＝FIFO全ロット対象）。 */
  readonly rawMaterialLotSelectorOriginCountry: string | null;
  /** 最大許容原料消費量（HOSO換算トン、未指定なら null）。 */
  readonly maxRawMaterialConsumption: number | null;
}

function buildExportProductionPlanEntry(plan: CompanyProductionPlanEntry): ExportProductionPlanEntry {
  return {
    companyId: plan.companyId,
    factoryId: plan.factoryId,
    product: plan.product,
    desiredQuantity: plan.desiredQuantity,
    priority: plan.priority,
    overtimeRateOverride: plan.overtimeRateOverride ?? null,
    rawMaterialLotSelectorSource: plan.rawMaterialLotSelector?.source ?? null,
    rawMaterialLotSelectorOriginCountry: plan.rawMaterialLotSelector?.originCountry ?? null,
    maxRawMaterialConsumption: plan.maxRawMaterialConsumption ?? null,
  };
}

// ---------------------------------------------------------------------
// ワーカー配置
// ---------------------------------------------------------------------

/** 商品別技能水準（WorkerSkillEntry の許可項目）。 */
export interface ExportWorkerSkill {
  readonly product: string;
  /** 技能水準（0〜1）。 */
  readonly skillLevel: number;
}

function buildExportWorkerSkill(skill: WorkerSkillEntry): ExportWorkerSkill {
  return { product: skill.product, skillLevel: skill.skillLevel };
}

/** 1工場ぶんのワーカー配置（WorkerAssignment の許可項目）。 */
export interface ExportWorkerAssignment {
  readonly factoryId: string;
  readonly companyId: CompanyId;
  readonly regularHeadcount: number;
  readonly temporaryHeadcount: number;
  readonly skills: readonly ExportWorkerSkill[];
  /** 残業率（0以上）。 */
  readonly overtimeRate: number;
  /** 稼働可能率（0〜1、1が全員出勤）。 */
  readonly attendanceRate: number;
  /** ワーカーの状態（未指定なら null＝"active"相当）。 */
  readonly lifecycleStatus: string | null;
}

function buildExportWorkerAssignment(assignment: WorkerAssignment): ExportWorkerAssignment {
  return {
    factoryId: assignment.factoryId,
    companyId: assignment.companyId,
    regularHeadcount: assignment.regularHeadcount,
    temporaryHeadcount: assignment.temporaryHeadcount,
    skills: assignment.skills.map(buildExportWorkerSkill).sort((a, b) => a.product.localeCompare(b.product)),
    overtimeRate: assignment.overtimeRate,
    attendanceRate: assignment.attendanceRate,
    lifecycleStatus: assignment.lifecycleStatus ?? null,
  };
}

// ---------------------------------------------------------------------
// 資金調達希望
// ---------------------------------------------------------------------

/** 当期の資金調達希望（FinancingRequestInput の許可項目）。 */
export interface ExportFinancingRequest {
  /** 希望借入額（USD）。 */
  readonly desiredAmountUsd: number;
  readonly desiredLoanType: string;
  readonly desiredTermQuarters: number;
  readonly desiredRepaymentMethod: string;
  /** 任意の期限前返済希望額（USD）。 */
  readonly desiredPrepaymentUsd: number;
  readonly emergencyAcceptable: boolean;
}

function buildExportFinancingRequest(request: FinancingRequestInput): ExportFinancingRequest {
  return {
    desiredAmountUsd: request.desiredAmountUsd,
    desiredLoanType: request.desiredLoanType,
    desiredTermQuarters: request.desiredTermQuarters,
    desiredRepaymentMethod: request.desiredRepaymentMethod,
    desiredPrepaymentUsd: request.desiredPrepaymentUsd,
    emergencyAcceptable: request.emergencyAcceptable,
  };
}

// ---------------------------------------------------------------------
// 設備投資の意思決定
// ---------------------------------------------------------------------

/** 新規設備投資案件の提案（CapexProjectProposalInput の許可項目）。 */
export interface ExportCapexProposal {
  readonly projectType: string;
  /** 希望投資額（USD、未指定なら null＝テンプレートの標準投資額）。 */
  readonly requestedBudgetUsd: number | null;
  /** 優先順位（未指定なら null＝提案順の連番）。 */
  readonly priority: number | null;
}

function buildExportCapexProposal(proposal: CapexProjectProposalInput): ExportCapexProposal {
  return {
    projectType: proposal.projectType,
    requestedBudgetUsd: proposal.requestedBudgetUsd ?? null,
    priority: proposal.priority ?? null,
  };
}

/** 当期の設備投資に関する意思決定（CapexDecisionInput の許可項目）。 */
export interface ExportCapexDecision {
  readonly companyId: CompanyId;
  readonly newProjectProposals: readonly ExportCapexProposal[];
  /** 取消希望の案件ID一覧。 */
  readonly cancelProjectIds: readonly string[];
  /** 再開希望の案件ID一覧。 */
  readonly resumeProjectIds: readonly string[];
}

function projectId(request: CapexCancelRequestInput | CapexResumeRequestInput): string {
  return request.projectId;
}

function buildExportCapexDecision(decision: CapexDecisionInput): ExportCapexDecision {
  return {
    companyId: decision.companyId,
    newProjectProposals: decision.newProjectProposals.map(buildExportCapexProposal),
    cancelProjectIds: decision.cancelRequests.map(projectId).sort((a, b) => a.localeCompare(b)),
    resumeProjectIds: decision.resumeRequests.map(projectId).sort((a, b) => a.localeCompare(b)),
  };
}

// ---------------------------------------------------------------------
// 意思決定1社ぶん
// ---------------------------------------------------------------------

/**
 * 1社・1四半期ぶんの提出意思決定（CompanyDecisionInput の許可項目、全8領域）。
 * 会社スコープでは対象会社1件のみ、GMスコープでは全5社ぶんを出力する。
 */
export interface ExportCompanyDecision {
  readonly companyId: CompanyId;
  readonly salesPlans: readonly ExportSalesPlanEntry[];
  readonly domesticPurchasePlan: ExportDomesticPurchasePlan;
  readonly importOrders: readonly ExportImportOrder[];
  readonly aquacultureStockingPlans: readonly ExportAquacultureStockingPlan[];
  readonly productionPlans: readonly ExportProductionPlanEntry[];
  readonly workerAssignments: readonly ExportWorkerAssignment[];
  readonly financingRequest: ExportFinancingRequest;
  readonly capexDecision: ExportCapexDecision;
}

export function buildExportCompanyDecision(decision: CompanyDecisionInput): ExportCompanyDecision {
  return {
    companyId: decision.companyId,
    salesPlans: decision.salesPlans
      .map(buildExportSalesPlanEntry)
      .sort((a, b) => (a.market !== b.market ? a.market.localeCompare(b.market) : a.product.localeCompare(b.product))),
    domesticPurchasePlan: buildExportDomesticPurchasePlan(decision.domesticPurchasePlan),
    importOrders: decision.importOrders
      .map(buildExportImportOrder)
      .sort((a, b) => a.originCountry.localeCompare(b.originCountry)),
    aquacultureStockingPlans: decision.aquacultureStockingPlans
      .map(buildExportAquacultureStockingPlan)
      .sort((a, b) => a.stockingPeriod.localeCompare(b.stockingPeriod)),
    productionPlans: decision.productionPlans
      .map(buildExportProductionPlanEntry)
      .sort((a, b) =>
        a.factoryId !== b.factoryId ? a.factoryId.localeCompare(b.factoryId) : a.product.localeCompare(b.product),
      ),
    workerAssignments: decision.workerAssignments
      .map(buildExportWorkerAssignment)
      .sort((a, b) => a.factoryId.localeCompare(b.factoryId)),
    financingRequest: buildExportFinancingRequest(decision.financingRequest),
    capexDecision: buildExportCapexDecision(decision.capexDecision),
  };
}

// ---------------------------------------------------------------------
// 警告・理由コード
// ---------------------------------------------------------------------

/** 全社横断の理由コード1件（CompanyReasonEntry の許可項目）。 */
export interface ExportReasonEntry {
  readonly code: string;
  readonly companyId: CompanyId;
  readonly message: string;
}

function buildExportReasonEntry(entry: CompanyReasonEntry): ExportReasonEntry {
  return { code: entry.code, companyId: entry.companyId, message: entry.message };
}

/**
 * 当期の理由コード（警告）。会社スコープでは対象会社ぶんのみへ絞り込む。
 * 元配列の順序（発生順）は情報を持つため保持し、会社スコープでも並べ替えない。
 */
export function buildExportGlobalReasonCodes(
  entry: CompanyLabQuarterHistoryEntry,
  scopedCompanyId?: CompanyId,
): readonly ExportReasonEntry[] {
  const rows =
    scopedCompanyId === undefined
      ? entry.record.globalReasonCodes
      : entry.record.globalReasonCodes.filter((r) => r.companyId === scopedCompanyId);
  return rows.map(buildExportReasonEntry);
}

// ---------------------------------------------------------------------
// 会社スコープ／GMスコープの意思決定情報
// ---------------------------------------------------------------------

/**
 * 会社スコープの意思決定情報。対象会社1社ぶんの提出意思決定のみを持ち、
 * 他社の非公開意思決定を一切含まない（三宅さんの指示 §6）。
 */
export interface ExportCompanyDecisionInfo {
  /** この会社がラボのプレイヤー会社かどうか（entry.playerSubmission.companyId との一致）。 */
  readonly isPlayerCompany: boolean;
  /** 対象会社の提出意思決定。確定履歴に該当会社の意思決定が無い場合のみ null。 */
  readonly submission: ExportCompanyDecision | null;
  /** 対象会社へのAI提案。未保存のため常に null（理由は aiProposalUnavailableReason）。 */
  readonly aiProposal: ExportCompanyDecision | null;
  /** 提出とAI提案の差分要約。AI提案が未保存（後方互換ケース）の場合のみnull。 */
  readonly diffFromAiProposal: DecisionDiffSummary | null;
  /** aiProposal / diffFromAiProposal が null である理由。保存済みなら null。 */
  readonly aiProposalUnavailableReason: string | null;
  /** 対象会社ぶんの当期警告（理由コード）。 */
  readonly reasonCodes: readonly ExportReasonEntry[];
}

export function buildExportCompanyDecisionInfo(
  entry: CompanyLabQuarterHistoryEntry,
  companyId: CompanyId,
): ExportCompanyDecisionInfo {
  const decision = entry.record.decisions.find((d) => d.companyId === companyId) ?? null;
  const aiProposal = entry.aiProposal && entry.aiProposal.companyId === companyId ? entry.aiProposal : null;
  return {
    isPlayerCompany: entry.playerSubmission.companyId === companyId,
    submission: decision ? buildExportCompanyDecision(decision) : null,
    aiProposal: aiProposal ? buildExportCompanyDecision(aiProposal) : null,
    diffFromAiProposal: aiProposal ? entry.diffFromAiProposal ?? null : null,
    aiProposalUnavailableReason: aiProposal ? null : AI_PROPOSAL_UNAVAILABLE_REASON,
    reasonCodes: buildExportGlobalReasonCodes(entry, companyId),
  };
}

/**
 * GMスコープの意思決定情報。全5社の提出意思決定・他社意思決定・全社の警告を
 * 収録する。GMフルスコープからのみ呼び出してよい（会社別Exportからは呼ばない）。
 */
export interface ExportAllCompaniesDecisionInfo {
  readonly playerCompanyId: CompanyId;
  /** 全社の提出意思決定（companyId昇順）。 */
  readonly submissions: readonly ExportCompanyDecision[];
  /** プレイヤー会社の提出意思決定（entry.playerSubmission）。 */
  readonly playerSubmission: ExportCompanyDecision;
  /** プレイヤー会社以外の意思決定（entry.otherCompaniesDecisions、companyId昇順）。 */
  readonly otherCompaniesDecisions: readonly ExportCompanyDecision[];
  /** 各社のAI提案（未保存のため空配列。理由は aiProposalUnavailableReason）。 */
  readonly aiProposals: readonly ExportCompanyDecision[];
  /** プレイヤー会社ぶんの提出とAI提案の差分要約。AI提案が未保存（後方互換ケース）の場合のみnull。 */
  readonly diffFromAiProposal: DecisionDiffSummary | null;
  readonly aiProposalUnavailableReason: string | null;
  /** 全社の当期警告（理由コード、発生順）。 */
  readonly reasonCodes: readonly ExportReasonEntry[];
}

export function buildExportAllCompaniesDecisionInfo(
  entry: CompanyLabQuarterHistoryEntry,
): ExportAllCompaniesDecisionInfo {
  const aiProposal = entry.aiProposal ?? null;
  return {
    playerCompanyId: entry.playerSubmission.companyId,
    submissions: entry.record.decisions
      .map(buildExportCompanyDecision)
      .sort((a, b) => a.companyId.localeCompare(b.companyId)),
    playerSubmission: buildExportCompanyDecision(entry.playerSubmission),
    otherCompaniesDecisions: entry.otherCompaniesDecisions
      .map(buildExportCompanyDecision)
      .sort((a, b) => a.companyId.localeCompare(b.companyId)),
    aiProposals: aiProposal ? [buildExportCompanyDecision(aiProposal)] : [],
    diffFromAiProposal: aiProposal ? entry.diffFromAiProposal ?? null : null,
    aiProposalUnavailableReason: aiProposal ? null : AI_PROPOSAL_UNAVAILABLE_REASON,
    reasonCodes: buildExportGlobalReasonCodes(entry),
  };
}
