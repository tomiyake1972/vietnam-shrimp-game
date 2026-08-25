// ShrimpX V2 — Decision Studio: INVESTMENT（設備投資・PD省人化投資・VAP商品開発費）
//
// 旧DecisionEditor.tsxの「設備投資」「VAP商品開発」CollapsibleSectionをそのまま移設。
// 新しい投資計算式・新しい上限式は一切作らない（DecisionStudioViewModel経由の
// buildCompanyInvestmentPlanningViewModel等の出力・既存純粋関数をそのまま使うだけ）。

import { useState } from "react";
import { score0to100, unwrapUnit } from "../../../../lib/v2/core/units";
import { PeriodV2 } from "../../../../lib/v2/core/period";
import { CompanyFixture, CompanyOwnState } from "../../../../lib/v2/companyLab";
import { CAPEX_PARAMETERS_V1, CapexRejectedProposal } from "../../../../lib/v2/capex";
import { MAX_FACTORIES_PER_COMPANY } from "../../../../lib/v2/capex/factoryConstruction";
import { FactoryLifecycleDecisionType, FactoryLifecycleState } from "../../../../lib/v2/capex/factoryLifecycle";
import { PD_MECHANIZATION_PARAMETERS_V1, formatReductionRatioAtFullMaturityLabel } from "../../../../lib/v2/capex/pdMechanization";
import { effectiveEfficiencyPerHeadTons, requiredHeadcountForQuantity } from "../../../../lib/v2/production/labor";
import { PRODUCTION_PARAMETERS_V1 } from "../../../../lib/v2/production/parameters";
import { PRODUCT_DEVELOPMENT_PARAMETERS_V1, updateProductDevelopmentState } from "../../../../lib/v2/companyLab/productDevelopmentState";
import {
  addCapexCancelRequestToDraft,
  addCapexProposalToDraft,
  isDuplicateProjectTypeInDraft,
  isPdMechanizationBlockedForFactory,
  removeCapexCancelRequestFromDraft,
  removeCapexProposalFromDraft,
  setVapProductDevelopmentSpendInDraft,
} from "../../capexDraftActions";
import { CAPEX_EXPLANATION_DETAIL_TEXT, CAPEX_EXPLANATION_TEXT } from "../../capexViewModel";
import { CompanyDecisionDraft, VAP_PRODUCT_DEVELOPMENT_SPEND_TIER_OPTIONS_USD } from "../../decisionDraft";
import { DecisionStudioViewModel } from "../../decisionStudioViewModel";
import { findFactoryLifecycleDecisionInDraft, setFactoryLifecycleDecisionInDraft } from "../../factoryLifecycleDraftActions";
import { buildFactoryOperationsViewModel, FactoryOperationsRow } from "../../factoryOperationsViewModel";
import CapexDraftList from "../CapexDraftList";
import CapexPortfolioList from "../CapexPortfolioList";
import CollapsibleSection from "../CollapsibleSection";
import FactorySpacePanel from "../FactorySpacePanel";
import InvestmentCardList from "../InvestmentCardList";
import { INFO_TABLE_HEAD_CLASS, INFO_TABLE_ROW_CLASS, INPUT_CONTROL_CLASS, NO_VALUE_TEXT } from "../panelStyles";

interface InvestmentPlanningScreenProps {
  readonly fixture: CompanyFixture;
  readonly ownState: CompanyOwnState;
  readonly draft: CompanyDecisionDraft;
  readonly onChange: (next: CompanyDecisionDraft) => void;
  readonly disabled: boolean;
  readonly vm: DecisionStudioViewModel;
  readonly period: PeriodV2;
  readonly turn?: number;
  readonly lastQuarterRejectedCapexProposals?: readonly CapexRejectedProposal[];
}

const FACTORY_LIFECYCLE_STATUS_LABELS: Readonly<Record<FactoryLifecycleState, string>> = {
  OPERATING: "稼働中",
  MOTHBALLED: "休止中",
  SALE_PENDING: "売却手続き中",
  SOLD: "売却済み",
};

const FACTORY_LIFECYCLE_STATUS_BADGE_CLASS: Readonly<Record<FactoryLifecycleState, string>> = {
  OPERATING: "bg-emerald-900/60 text-emerald-300",
  MOTHBALLED: "bg-gray-800 text-gray-300",
  SALE_PENDING: "bg-amber-900/60 text-amber-300",
  SOLD: "bg-gray-800 text-gray-500",
};

const FACTORY_LIFECYCLE_ACTION_LABELS: Readonly<Record<FactoryLifecycleDecisionType, string>> = {
  MOTHBALL_FACTORY: "この工場を休止する",
  REACTIVATE_FACTORY: "この工場を再稼働する",
  SELL_FACTORY: "この工場の売却手続きを始める",
};

function formatUsd(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

/** 【実装指示§11】選択中のLifecycle Decision種別ごとの確認文言（平易な日本語・固定文）。 */
function buildFactoryLifecycleConfirmationLines(type: FactoryLifecycleDecisionType, row: FactoryOperationsRow, effectiveTurn: number, completionTurn: number): readonly string[] {
  if (type === "MOTHBALL_FACTORY") {
    return [
      `この工場はTurn ${effectiveTurn}から生産能力が0になります。`,
      "工場を休止してもWorkerは自動的には減りません。",
      "Worker人数はWORKERタブで別途判断してください。",
      "既存の受注契約は消えません。",
      `休止中は四半期あたり約${formatUsd(row.mothballCarryingCostUsdPerQuarter)}の維持費が発生します。`,
      `再稼働には別途${formatUsd(row.reactivationCostUsd)}の費用がかかります。`,
    ];
  }
  if (type === "REACTIVATE_FACTORY") {
    return [
      `再稼働費用${formatUsd(row.reactivationCostUsd)}が当Turnに発生します。`,
      `生産能力が戻るのはTurn ${effectiveTurn}からです。`,
      "Workerは自動的に採用・増員されません。",
    ];
  }
  return [
    `Turn ${effectiveTurn}からこの工場の生産能力は0になります。`,
    "既存の受注契約は消えません。",
    `売却完了まで2TurnのLifecycle timingがあります（Turn ${effectiveTurn}で操業停止 → Turn ${completionTurn}で売却完了）。`,
    `売却完了時（Turn ${completionTurn}）に見込代金 約${formatUsd(row.estimatedSaleProceedsUsd)}・見込${row.estimatedDisposalGainLossUsd >= 0 ? "売却益" : "売却損"} 約${formatUsd(Math.abs(row.estimatedDisposalGainLossUsd))}が会計へ反映されます（既存Engine算出値。実際の完了時点の帳簿価額により変動しうる見込値です）。`,
    "売却は完了後に元へ戻せません。",
  ];
}

export default function InvestmentPlanningScreen({ fixture, ownState, draft, onChange, disabled, vm, period, turn, lastQuarterRejectedCapexProposals }: InvestmentPlanningScreenProps) {
  const {
    planning,
    capexCandidates,
    capexPortfolioRows,
    capexCandidateBudgetByType,
    capexDraftThisQuarterPaymentUsd,
    currentCashUsd,
    newFactoryConstructionBlocked,
    investmentCardExtraBlockedReason,
    prospectiveFactoryCount,
    pdMechanizationStatusByFactory,
  } = vm;

  const [pdMechanizationTargetFactoryId, setPdMechanizationTargetFactoryId] = useState<string>(ownState.effectiveFactories[0]?.factoryId ?? "");
  const pdMechanizationBlockedForSelectedFactory =
    pdMechanizationTargetFactoryId !== "" && isPdMechanizationBlockedForFactory(draft, ownState.capexState.portfolio.projects, pdMechanizationTargetFactoryId);
  const pdMechanizationExistingProjectForFactory = (factoryId: string) =>
    ownState.capexState.portfolio.projects.find((p) => p.projectType === "pdMechanization" && p.targetFactoryId === factoryId && p.status !== "cancelled");

  const [factorySpecificTargetFactoryId, setFactorySpecificTargetFactoryId] = useState<string>(ownState.effectiveFactories[0]?.factoryId ?? "");
  const hasMultipleFactories = ownState.effectiveFactories.length > 1;

  // 【Player工場操作Phase 1新設】表示専用ViewModel（新しい計算式は持たない。既存Engine
  // SSoTが算出済みの値を組み立てるだけ）。turnが渡っていない呼び出し元では、Turn番号を
  // 使う表示ができないためセクション自体を出さない（安全側）。
  const factoryOperationsVm = turn !== undefined ? buildFactoryOperationsViewModel(fixture, ownState, period, turn) : null;

  const pdMechanizationTemplate = CAPEX_PARAMETERS_V1.templatesByType.pdMechanization;
  const pdMechanizationConstructionQuarters = pdMechanizationTemplate.paymentRatios.length;
  const pdMechanizationReadinessQuarters = pdMechanizationTemplate.postCompletionReadinessQuarters;
  const pdMechanizationQuartersUntilActivation = pdMechanizationConstructionQuarters + pdMechanizationReadinessQuarters;
  const pdMechanizationQuarterlyMaintenanceUsd = pdMechanizationTemplate.standardBudgetUsd * pdMechanizationTemplate.maintenanceRatePerQuarter;
  const pdMechanizationQuarterlyDepreciationUsd =
    (pdMechanizationTemplate.standardBudgetUsd * pdMechanizationTemplate.buildingRatio) / CAPEX_PARAMETERS_V1.componentUsefulLifeQuarters.building +
    (pdMechanizationTemplate.standardBudgetUsd * pdMechanizationTemplate.machineryRatio) / CAPEX_PARAMETERS_V1.componentUsefulLifeQuarters.machinery;

  const estimateWorkerReductionForFactory = (
    factoryId: string
  ): { readonly requiredBefore: number; readonly requiredAfterFullMaturity: number; readonly reduction: number } | undefined => {
    const productionRow = draft.productionPlans.find((p) => p.factoryId === factoryId && p.product === "pd");
    const workerRow = draft.workerAssignments.find((w) => w.factoryId === factoryId);
    if (!productionRow || !workerRow || productionRow.desiredQuantity <= 0) return undefined;
    const skillEntry = workerRow.skills.find((s) => s.product === "pd");
    const skillLevel = skillEntry ? unwrapUnit(skillEntry.skillLevel) : 0;
    const efficiencyBefore = effectiveEfficiencyPerHeadTons(PRODUCTION_PARAMETERS_V1.labor.regularEfficiencyPerHeadTons, "pd", PRODUCTION_PARAMETERS_V1);
    const efficiencyAfterFullMaturity = effectiveEfficiencyPerHeadTons(
      PRODUCTION_PARAMETERS_V1.labor.regularEfficiencyPerHeadTons,
      "pd",
      PRODUCTION_PARAMETERS_V1,
      PD_MECHANIZATION_PARAMETERS_V1.floorCoefficient
    );
    const requiredBefore = requiredHeadcountForQuantity(productionRow.desiredQuantity, efficiencyBefore, workerRow.attendanceRate, skillLevel, workerRow.overtimeRate);
    const requiredAfterFullMaturity = requiredHeadcountForQuantity(
      productionRow.desiredQuantity,
      efficiencyAfterFullMaturity,
      workerRow.attendanceRate,
      skillLevel,
      workerRow.overtimeRate
    );
    return { requiredBefore, requiredAfterFullMaturity, reduction: Math.max(0, requiredBefore - requiredAfterFullMaturity) };
  };
  const pdMechanizationWorkerReductionEstimate = estimateWorkerReductionForFactory(pdMechanizationTargetFactoryId);

  const currentVapProductDevelopmentScore = ownState.vapProductDevelopmentScore;
  const nextQuarterVapProductDevelopmentScorePreview = (spendUsd: number): number => {
    const spendByCompanyId = new Map([[fixture.companyId, spendUsd]]);
    const previewState = updateProductDevelopmentState(
      { entries: [{ companyId: fixture.companyId, score: score0to100(currentVapProductDevelopmentScore) }] },
      spendByCompanyId,
      [fixture.companyId]
    );
    const entry = previewState.entries.find((e) => e.companyId === fixture.companyId);
    return entry ? unwrapUnit(entry.score) : PRODUCT_DEVELOPMENT_PARAMETERS_V1.neutralScore;
  };

  return (
    <div className="space-y-3" data-testid="decision-studio-investment-screen">
      {/* 【Phase 8B-3】設備投資 */}
      <CollapsibleSection title="設備投資" tone="input" description={CAPEX_EXPLANATION_TEXT} testId="capex-section">
        <details className="mt-1">
          <summary className="text-[11px] text-teal-400 hover:text-teal-300 cursor-pointer">建物・機械の償却期間の違いについて</summary>
          <p className="text-[11px] text-gray-400 mt-1">{CAPEX_EXPLANATION_DETAIL_TEXT}</p>
        </details>

        {lastQuarterRejectedCapexProposals && lastQuarterRejectedCapexProposals.length > 0 && (
          <div className="bg-amber-950/40 border border-amber-700/50 rounded-lg px-3 py-2 space-y-1">
            <div className="text-[11px] font-semibold text-amber-300">
              前四半期、承認されなかった新規投資案件があります（{lastQuarterRejectedCapexProposals.length}件）
            </div>
            <ul className="space-y-0.5">
              {lastQuarterRejectedCapexProposals.map((r, idx) => (
                <li key={idx} className="text-[11px] text-amber-200">
                  {CAPEX_PARAMETERS_V1.templatesByType[r.projectType].displayName}: {r.reasons.join(" ")}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* 【Phase 8D-3】工場スペース（投資判断の物理的な制約） */}
        <div className="space-y-1.5">
          <h4 className="text-xs font-semibold text-gray-300">工場スペース</h4>
          <FactorySpacePanel state={planning.factorySpace} />
        </div>

        {/* 【Phase 8D-2】投資カード（再設計版）。【Test15】pdMechanizationは対象工場の選択が
            必須のため、この一覧からは除外し、下の専用セクションでのみ追加できる。 */}
        <div className="space-y-1.5">
          <h4 className="text-xs font-semibold text-gray-300">投資案件候補（{capexCandidates.length - 1}種類。PD省人化投資は下の専用セクションから）</h4>
          {newFactoryConstructionBlocked && (
            <div className="bg-amber-950/40 border border-amber-700/50 rounded px-2 py-1 text-[11px] text-amber-200">
              {investmentCardExtraBlockedReason("newFactoryConstruction")}
              （現在・進行中・今期提案 合計 {prospectiveFactoryCount} / 上限 {MAX_FACTORIES_PER_COMPANY}工場）
            </div>
          )}
          {hasMultipleFactories && (
            <label className="flex flex-wrap items-center gap-2 text-xs text-gray-300" data-testid="capex-target-factory-selector">
              対象工場（新工場建設を除く）
              <select
                value={factorySpecificTargetFactoryId}
                disabled={disabled}
                onChange={(e) => setFactorySpecificTargetFactoryId(e.target.value)}
                className={INPUT_CONTROL_CLASS}
              >
                {ownState.effectiveFactories.map((f) => (
                  <option key={f.factoryId} value={f.factoryId}>
                    {f.factoryId}
                  </option>
                ))}
              </select>
            </label>
          )}
          <InvestmentCardList
            cards={planning.investmentCards.filter((c) => c.projectType !== "pdMechanization")}
            currentCashUsd={currentCashUsd}
            draftPaymentThisQuarterUsd={capexDraftThisQuarterPaymentUsd}
            isDuplicate={(projectType) => isDuplicateProjectTypeInDraft(draft, projectType)}
            onAdd={(projectType, targetFactoryId) => onChange(addCapexProposalToDraft(draft, projectType, targetFactoryId))}
            targetFactoryId={hasMultipleFactories ? factorySpecificTargetFactoryId : undefined}
            extraBlockedReasonByType={investmentCardExtraBlockedReason}
            disabled={disabled}
          />
        </div>

        {/* 【Test15新設】PD省人化投資（工場単位の対象選択・状況表示専用セクション） */}
        <div className="space-y-1.5 bg-gray-900/40 border border-gray-700/60 rounded-lg px-3 py-2" data-testid="pd-mechanization-section">
          <h4 className="text-xs font-semibold text-gray-300">PD省人化投資（対象工場を選択）</h4>
          <p className="text-[11px] text-gray-400">
            特定の工場を対象に、PD（殻剥き）工程の労働集約度係数だけを引き下げます（基準1.2 → フロア1.0。PD生産能力そのものは増えません。
            HOSO/VAPには一切影響しません）。効果は稼働開始後の習熟期間と、対象工場の前四半期PD稼働率に応じて段階的に発現します
            （稼働率が低い工場では、機械化しても実際の削減効果はほとんど発現しません）。
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs text-gray-300">
              対象工場
              <select
                value={pdMechanizationTargetFactoryId}
                disabled={disabled}
                onChange={(e) => setPdMechanizationTargetFactoryId(e.target.value)}
                className={INPUT_CONTROL_CLASS}
              >
                {ownState.effectiveFactories.map((f) => (
                  <option key={f.factoryId} value={f.factoryId}>
                    {f.factoryId}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={disabled || pdMechanizationTargetFactoryId === "" || pdMechanizationBlockedForSelectedFactory}
              onClick={() => onChange(addCapexProposalToDraft(draft, "pdMechanization", pdMechanizationTargetFactoryId))}
              className="text-[11px] px-2 py-1 rounded bg-sky-900/70 border border-sky-500/70 text-sky-50 hover:bg-sky-800/70 disabled:opacity-50 disabled:bg-gray-800 disabled:border-gray-600 disabled:text-gray-400"
            >
              この工場でPD省人化投資をドラフトへ追加
            </button>
          </div>
          {pdMechanizationBlockedForSelectedFactory && (
            <div className="bg-amber-950/40 border border-amber-700/50 rounded px-2 py-1 text-[11px] text-amber-200">
              この工場にはすでに進行中（または今期ドラフト内で提案済み）のPD省人化投資案件があります。工場ごとに同時に1件までです。
            </div>
          )}

          <div className="bg-gray-950/40 border border-gray-700/50 rounded px-2 py-1.5 text-[11px] text-gray-300 space-y-0.5" data-testid="pd-mechanization-investment-info">
            <div>
              投資金額: <span className="text-gray-100 font-semibold">${pdMechanizationTemplate.standardBudgetUsd.toLocaleString("en-US")}</span>
              　支払スケジュール: <span className="text-gray-100">{pdMechanizationTemplate.paymentRatios.map((r) => `${(r * 100).toFixed(0)}%`).join(" / ")}</span>
              （{pdMechanizationConstructionQuarters}四半期に分割）
            </div>
            <div>
              想定稼働開始時期: 提案から<span className="text-gray-100 font-semibold">{pdMechanizationQuartersUntilActivation}四半期後</span>
              （分割払い{pdMechanizationConstructionQuarters}四半期＋竣工後の操業準備期間{pdMechanizationReadinessQuarters}四半期）
            </div>
            <div>
              稼働開始後の四半期あたり費用: 減価償却費 <span className="text-gray-100 font-semibold">${Math.round(pdMechanizationQuarterlyDepreciationUsd).toLocaleString("en-US")}</span>
              　保守費 <span className="text-gray-100 font-semibold">${Math.round(pdMechanizationQuarterlyMaintenanceUsd).toLocaleString("en-US")}</span>
            </div>
            <div>
              {pdMechanizationTargetFactoryId === "" ? (
                "対象工場を選択してください。"
              ) : pdMechanizationWorkerReductionEstimate ? (
                <>
                  完全習熟後の必要常用Worker人数見込み（対象工場・当四半期のpd生産計画希望量ベース）: 現在
                  <span className="text-gray-100 font-semibold"> {Math.ceil(pdMechanizationWorkerReductionEstimate.requiredBefore).toLocaleString("en-US")}人</span>
                  {" → "}
                  完全習熟後
                  <span className="text-gray-100 font-semibold"> {Math.ceil(pdMechanizationWorkerReductionEstimate.requiredAfterFullMaturity).toLocaleString("en-US")}人</span>
                  （
                  <span className="text-teal-300 font-semibold">約{Math.floor(pdMechanizationWorkerReductionEstimate.reduction).toLocaleString("en-US")}人削減見込み</span>
                  ）
                </>
              ) : (
                "対象工場の当四半期のpd生産計画希望量が0のため、削減見込み人数を算出できません（PRODUCTIONタブでpdの希望量を入力すると表示されます）。"
              )}
            </div>
          </div>

          <div className="overflow-x-auto mt-2">
            <table className="min-w-full text-xs text-gray-300">
              <thead>
                <tr className={INFO_TABLE_HEAD_CLASS}>
                  <th className="pr-3 py-1">工場</th>
                  <th className="pr-3 py-1">前四半期PD稼働率</th>
                  <th className="pr-3 py-1">進行中案件</th>
                  <th className="pr-3 py-1">現在のmechanizationLevel</th>
                  <th className="pr-3 py-1">現在の実効PD係数（基準1.2）</th>
                  <th className="pr-3 py-1">削減率</th>
                </tr>
              </thead>
              <tbody>
                {ownState.effectiveFactories.map((f) => {
                  const utilization =
                    ownState.pdUtilizationByFactory.find((e) => e.factoryId === f.factoryId)?.previousQuarterPdUtilization ??
                    PD_MECHANIZATION_PARAMETERS_V1.initialPdUtilizationRatio;
                  const status = pdMechanizationStatusByFactory.get(f.factoryId);
                  const project = pdMechanizationExistingProjectForFactory(f.factoryId);
                  const isLowUtilization = utilization < 0.3;
                  return (
                    <tr key={f.factoryId} className={INFO_TABLE_ROW_CLASS}>
                      <td className="pr-3 py-1">{f.factoryId}</td>
                      <td className={`pr-3 py-1 ${isLowUtilization ? "text-amber-300" : ""}`}>
                        {(utilization * 100).toFixed(1)}%{isLowUtilization && "（低稼働率のため効果が小さくなります）"}
                      </td>
                      <td className="pr-3 py-1">{project ? `${project.projectId}（${project.status}）` : NO_VALUE_TEXT}</td>
                      <td className="pr-3 py-1">{status ? `${(status.mechanizationLevel * 100).toFixed(1)}%` : NO_VALUE_TEXT}</td>
                      <td className="pr-3 py-1">{status ? status.effectivePdCoefficient.toFixed(3) : `${PD_MECHANIZATION_PARAMETERS_V1.baseCoefficient.toFixed(3)}（未稼働）`}</td>
                      <td className="pr-3 py-1">
                        {status
                          ? `${((1 - status.effectivePdCoefficient / PD_MECHANIZATION_PARAMETERS_V1.baseCoefficient) * 100).toFixed(2)}%`
                          : `最大 ${formatReductionRatioAtFullMaturityLabel()}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="space-y-1.5">
          <h4 className="text-xs font-semibold text-gray-300">今期の設備投資ドラフト（提出内容の確認）</h4>
          <CapexDraftList
            newProjectProposals={draft.capexDecision.newProjectProposals}
            cancelRequestProjectIds={draft.capexDecision.cancelRequests.map((c) => c.projectId)}
            displayNameByType={(projectType) => CAPEX_PARAMETERS_V1.templatesByType[projectType].displayName}
            budgetByType={capexCandidateBudgetByType}
            onRemoveProposal={(index) => onChange(removeCapexProposalFromDraft(draft, index))}
            onRemoveCancelRequest={(projectId) => onChange(removeCapexCancelRequestFromDraft(draft, projectId))}
            disabled={disabled}
          />
        </div>

        <div className="space-y-1.5">
          <h4 className="text-xs font-semibold text-gray-300">投資案件ポートフォリオ（この会社の全案件）</h4>
          <CapexPortfolioList
            rows={capexPortfolioRows}
            cancelRequestedProjectIds={new Set(draft.capexDecision.cancelRequests.map((c) => c.projectId))}
            onRequestCancel={(projectId) => onChange(addCapexCancelRequestToDraft(draft, projectId))}
            onUndoCancelRequest={(projectId) => onChange(removeCapexCancelRequestFromDraft(draft, projectId))}
            disabled={disabled}
          />
        </div>
      </CollapsibleSection>

      {/* 【Player工場操作Phase 1新設】工場の休止・再稼働・売却。当期生産量の調整ではなく
          将来のFactory asset / capacity / fixed costを変える経営意思決定のため、
          PRODUCTIONタブではなくここに置く。既存Factory Lifecycle Engine
          （capex/factoryLifecycle.ts・capex/factoryDisposal.ts・capex/factoryAssetProjection.ts）
          が算出済みの値をそのまま表示するだけで、新しい計算式はここに一切持たない。 */}
      {factoryOperationsVm && (
        <CollapsibleSection title="工場操作（休止・再稼働・売却）" tone="input" testId="factory-operations-section">
          <div className="bg-amber-950/40 border border-amber-700/50 rounded px-2 py-1.5 text-[11px] text-amber-200" data-testid="factory-operations-worker-warning">
            工場を休止・売却してもWorker人数は自動では減りません。必要に応じてWORKERタブで人数を見直してください。
          </div>
          <p className="text-[11px] text-gray-400">
            金額・能力は既存Engineの算出値をそのまま表示しており、この画面では再計算しません。SOLD（売却済み）の工場はこの一覧には表示されません。
          </p>

          <div className="space-y-2">
            {factoryOperationsVm.rows.map((row) => {
              const capacityRow = vm.capacityViewModel.factories.find((f) => f.factoryId === row.factoryId);
              const commonProcessingTons = capacityRow?.pools.find((p) => p.poolKey === "commonProcessing")?.currentEffectiveTons;
              const pendingDecision = findFactoryLifecycleDecisionInDraft(draft, row.factoryId);
              const effectiveTurn = turn !== undefined ? turn + 1 : undefined;
              const completionTurn = turn !== undefined ? turn + 2 : undefined;

              return (
                <div
                  key={row.factoryId}
                  className="rounded-lg border border-gray-700/60 bg-gray-900/40 px-3 py-2 space-y-1.5"
                  data-testid={`factory-operations-row-${row.factoryId}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold text-gray-100">{row.factoryId}</span>
                    <span
                      className={`text-[11px] rounded px-1.5 py-0.5 ${FACTORY_LIFECYCLE_STATUS_BADGE_CLASS[row.lifecycleStatus]}`}
                      data-testid={`factory-operations-status-${row.factoryId}`}
                    >
                      {FACTORY_LIFECYCLE_STATUS_LABELS[row.lifecycleStatus]}
                    </span>
                    {row.lifecycleStatus === "SALE_PENDING" && row.saleCompletionTurn !== null && (
                      <span className="text-[11px] text-amber-300">売却完了予定：Turn {row.saleCompletionTurn}</span>
                    )}
                    {row.hasActiveCapexProject && <span className="text-[11px] text-gray-400">未完了の設備投資案件があるため売却できません</span>}
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-0.5 text-[11px] text-gray-300">
                    <div>
                      現在使用可能な生産能力（前処理）: <span className="text-gray-100">{commonProcessingTons !== undefined ? `${commonProcessingTons.toLocaleString("en-US")} t/四半期` : NO_VALUE_TEXT}</span>
                    </div>
                    <div>
                      工場別帳簿価額: <span className="text-gray-100">{formatUsd(row.netBookValueUsd)}</span>
                    </div>
                    <div>
                      休止中の四半期費用: <span className="text-gray-100">{formatUsd(row.mothballCarryingCostUsdPerQuarter)}</span>
                    </div>
                    <div>
                      再稼働費: <span className="text-gray-100">{formatUsd(row.reactivationCostUsd)}</span>
                    </div>
                    <div>
                      売却した場合の見込代金: <span className="text-gray-100">{formatUsd(row.estimatedSaleProceedsUsd)}</span>
                    </div>
                    <div>
                      見込売却損益: <span className={row.estimatedDisposalGainLossUsd >= 0 ? "text-emerald-300" : "text-rose-300"}>{formatUsd(row.estimatedDisposalGainLossUsd)}</span>
                    </div>
                  </div>

                  {row.availableActions.length > 0 && !pendingDecision && (
                    <div className="flex flex-wrap gap-1.5">
                      {row.availableActions.map((type) => (
                        <button
                          key={type}
                          type="button"
                          disabled={disabled}
                          onClick={() => onChange(setFactoryLifecycleDecisionInDraft(draft, row.factoryId, type))}
                          data-testid={`factory-operations-action-${row.factoryId}-${type}`}
                          className="text-[11px] px-2 py-1 rounded bg-sky-900/70 border border-sky-500/70 text-sky-50 hover:bg-sky-800/70 disabled:opacity-50 disabled:bg-gray-800 disabled:border-gray-600 disabled:text-gray-400"
                        >
                          {FACTORY_LIFECYCLE_ACTION_LABELS[type]}
                        </button>
                      ))}
                    </div>
                  )}

                  {pendingDecision && effectiveTurn !== undefined && completionTurn !== undefined && (
                    <div
                      className="bg-sky-950/40 border border-sky-700/50 rounded px-2 py-1.5 space-y-1"
                      data-testid={`factory-operations-confirmation-${row.factoryId}`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-[11px] font-semibold text-sky-200">選択中: {FACTORY_LIFECYCLE_ACTION_LABELS[pendingDecision.type]}</span>
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() => onChange(setFactoryLifecycleDecisionInDraft(draft, row.factoryId, null))}
                          data-testid={`factory-operations-undo-${row.factoryId}`}
                          className="text-[11px] px-2 py-0.5 rounded border border-gray-600 text-gray-300 hover:bg-gray-800"
                        >
                          選択を取り消す
                        </button>
                      </div>
                      <ul className="list-disc list-inside space-y-0.5">
                        {buildFactoryLifecycleConfirmationLines(pendingDecision.type, row, effectiveTurn, completionTurn).map((line, idx) => (
                          <li key={idx} className="text-[11px] text-sky-100">
                            {line}
                          </li>
                        ))}
                      </ul>
                      <p className="text-[11px] text-gray-400">
                        既存受注契約は残ります。能力低下により納期遅延が発生する可能性があります。
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </CollapsibleSection>
      )}

      {/* 【Test15新設】VAP商品開発費 */}
      <CollapsibleSection
        title="VAP商品開発"
        tone="input"
        testId="vap-product-development-section"
        summaryRight={`現在スコア ${currentVapProductDevelopmentScore.toFixed(1)} / 100`}
      >
        <p className="text-[11px] text-gray-400">
          VAP商品開発スコアは、成約競争力（vapCapability）へのみ接続します（市場価格観測等の他の共有データは書き換えません）。
          $0を選択した場合でも、毎四半期一定割合で中立値50へ向かって減衰します（投資を止めると徐々にスコアが下がります）。
        </p>
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1 text-xs text-gray-300">
            今四半期のVAP商品開発費
            <select
              value={draft.vapProductDevelopmentSpendUsd}
              disabled={disabled}
              onChange={(e) => onChange(setVapProductDevelopmentSpendInDraft(draft, Number(e.target.value)))}
              className={INPUT_CONTROL_CLASS}
            >
              {VAP_PRODUCT_DEVELOPMENT_SPEND_TIER_OPTIONS_USD.map((tier) => (
                <option key={tier} value={tier}>
                  {tier === 0 ? "$0（投資しない）" : `$${tier.toLocaleString("en-US")}`}
                </option>
              ))}
            </select>
          </label>
          <div className="text-xs text-gray-300">
            現在のスコア: <span className="text-gray-100 font-semibold">{currentVapProductDevelopmentScore.toFixed(1)}</span> / 100
          </div>
          <div className="text-xs text-gray-300">
            この選択のまま四半期を進めた場合の次四半期末スコア見込み:{" "}
            <span className="text-teal-300 font-semibold">{nextQuarterVapProductDevelopmentScorePreview(draft.vapProductDevelopmentSpendUsd).toFixed(1)}</span> / 100
          </div>
        </div>
        {draft.vapProductDevelopmentSpendUsd === 0 && (
          <div className="text-[11px] text-amber-300">$0を選択しています。投資を行わない四半期も、スコアは中立値50へ向けて減衰します。</div>
        )}
        <div className="text-[11px] text-gray-400 bg-gray-950/40 border border-gray-700/50 rounded px-2 py-1" data-testid="vap-spend-cashflow-note">
          上で選択した金額（${draft.vapProductDevelopmentSpendUsd.toLocaleString("en-US")}）が、そのまま当四半期のSG&A（販管費）へ全額費用化され、
          同額が当四半期の営業キャッシュフロー・現金の支出となります（資産計上・減価償却はありません）。この金額はVAP商品開発スコアの更新にも
          使われる唯一の情報源であり、画面上に別の金額が存在することはありません。
        </div>
      </CollapsibleSection>
    </div>
  );
}
