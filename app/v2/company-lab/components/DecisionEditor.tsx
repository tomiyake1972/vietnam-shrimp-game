// ShrimpX V2 — 会社経営統合テスト環境（Phase 6.2） 意思決定編集パネル
//
// プレイヤー操作会社1社ぶんの当期意思決定（販売計画・国内原料買付・輸入・養殖・
// 生産計画・ワーカー配置）を編集する。初期値は generateAutoPolicyDecision の
// 出力（decisionDraft.tsのbuildInitialDraftで網羅グリッドへ変換したもの）。
// 数量・人数の負値・NaNは入力時点で0へ丸める（ハードエラー防止）。能力・在庫・
// 未履行残高などの参考情報を隣に表示し、明らかな入力ミス（過大な希望量等）は
// 警告表示のみ行い、送信はブロックしない（ソフト警告）。計算ロジックは
// 一切持たない（表示・編集のみ）。

import { unwrapUnit } from "../../../lib/v2/core/units";
import { PeriodV2 } from "../../../lib/v2/core/period";
import { CompanyFixture, CompanyOwnState } from "../../../lib/v2/companyLab";
import { CAPEX_PARAMETERS_V1, CapexProjectQuarterEvent, CapexRejectedProposal } from "../../../lib/v2/capex";
import { formatHosoEqTons } from "../../../lib/v2/industryLab/ui/formatters";
import {
  buildDecisionInputFromDraft,
  CompanyDecisionDraft,
  resetAllSalesForceHeadcountToZero,
  summarizeSalesForceAllocation,
  syncMarketSalesForceHeadcount,
} from "../decisionDraft";
import {
  addCapexCancelRequestToDraft,
  addCapexProposalToDraft,
  isDuplicateProjectTypeInDraft,
  removeCapexCancelRequestFromDraft,
  removeCapexProposalFromDraft,
} from "../capexDraftActions";
import { buildAllCapexCandidateViewModels, buildCapexPortfolioViewModel, CAPEX_EXPLANATION_DETAIL_TEXT, CAPEX_EXPLANATION_TEXT } from "../capexViewModel";
import { buildCompanyProcessingCapacityViewModel, CapacityPoolKey } from "../processingCapacityViewModel";
import { buildCompanyProcessingForecast } from "../processingForecastViewModel";
import { buildCompanyInvestmentPlanningViewModel } from "../investmentPlanningViewModel";
import { applyHeadcountChange, WORKFORCE_EXPLANATION_TEXT } from "../../../lib/v2/companyLab/workforce";
import { CompanyFinancialQuarterResult } from "../../../lib/v2/finance/types";
import CapacityEffectiveRatePanel from "./CapacityEffectiveRatePanel";
import ProcessingForecastPanel from "./ProcessingForecastPanel";
import CapexDraftList from "./CapexDraftList";
import CapexPortfolioList from "./CapexPortfolioList";
import CollapsibleSection, { AreaToneLegend } from "./CollapsibleSection";
import ColdStoragePanel from "./ColdStoragePanel";
import FactorySpacePanel from "./FactorySpacePanel";
import InvestmentCardList from "./InvestmentCardList";
import PlanningWarningsPanel from "./PlanningWarningsPanel";
import ProcessingCapacityPanel from "./ProcessingCapacityPanel";
import WorkforcePanel from "./WorkforcePanel";
import { INFO_TABLE_HEAD_CLASS, INFO_TABLE_ROW_CLASS, INFO_VALUE_CLASS, INPUT_CONTROL_CLASS, INPUT_CONTROL_WARN_CLASS, NO_VALUE_TEXT } from "./panelStyles";

interface DecisionEditorProps {
  readonly fixture: CompanyFixture;
  readonly ownState: CompanyOwnState;
  readonly draft: CompanyDecisionDraft;
  readonly onChange: (next: CompanyDecisionDraft) => void;
  readonly disabled: boolean;
  /** 【Phase 8B-3】設備投資セクション用の当四半期（プレビュー・稼働開始判定の基準）。 */
  readonly period: PeriodV2;
  /** 【Phase 8B-3】直近確定四半期の設備投資イベント（今期の実際の支払額表示用、参考情報）。未実行なら省略可。 */
  readonly lastQuarterCapexEvents?: readonly CapexProjectQuarterEvent[];
  /**
   * 【Phase 8B-3補足確認】直近確定四半期に却下された新規投資案件（同時進行中案件数の
   * 上限超過・資金繰り理由等）。エンジンは例外を投げず、理由つきで却下結果を返す設計
   * （CapexQuarterResult.rejectedProposals）のため、画面が落ちることはないが、これまで
   * 何も表示していなかった（発見された不具合。今回の補足確認で追加）。
   */
  readonly lastQuarterRejectedCapexProposals?: readonly CapexRejectedProposal[];
  /**
   * 【Phase 8D-2】直近確定四半期のプレイヤー会社ぶんの財務結果。
   * 投資回収の「1トンあたり限界利益」を実績から求めるためだけに使う。
   * 無ければ（初回四半期など）回収年数は「算定対象外」と表示される。
   */
  readonly lastQuarterFinancialResult?: CompanyFinancialQuarterResult | null;
}

const LOAN_TYPE_LABELS: Record<CompanyDecisionDraft["financingRequest"]["desiredLoanType"], string> = {
  workingCapital: "運転資金",
  termLoan: "設備・長期資金",
  emergency: "緊急融資",
};

const REPAYMENT_METHOD_LABELS: Record<CompanyDecisionDraft["financingRequest"]["desiredRepaymentMethod"], string> = {
  bulletAtMaturity: "満期一括",
  equalPrincipal: "元金均等",
};

function formatUsd(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function toSafeNumber(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function toSafeRatioNumber(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function NumberCell(props: { readonly value: number; readonly onChange: (n: number) => void; readonly disabled: boolean; readonly step?: number; readonly warn?: boolean }) {
  return (
    <input
      type="number"
      min={0}
      step={props.step ?? 1}
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => props.onChange(toSafeNumber(e.target.value))}
      className={`w-24 ${INPUT_CONTROL_CLASS} ${props.warn ? INPUT_CONTROL_WARN_CLASS : ""}`}
    />
  );
}

function RatioCell(props: { readonly value: number; readonly onChange: (n: number) => void; readonly disabled: boolean }) {
  return (
    <input
      type="number"
      min={0}
      max={1}
      step={0.05}
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => props.onChange(toSafeRatioNumber(e.target.value))}
      className={`w-20 ${INPUT_CONTROL_CLASS}`}
    />
  );
}

function PriceAdjustmentCell(props: { readonly value: number; readonly onChange: (n: number) => void; readonly disabled: boolean }) {
  return (
    <input
      type="number"
      step={0.01}
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => {
        const n = Number(e.target.value);
        props.onChange(Number.isFinite(n) ? n : 0);
      }}
      className={`w-24 ${INPUT_CONTROL_CLASS}`}
    />
  );
}

export default function DecisionEditor(props: DecisionEditorProps) {
  const {
    fixture,
    ownState,
    draft,
    onChange,
    disabled,
    period,
    lastQuarterCapexEvents,
    lastQuarterRejectedCapexProposals,
    lastQuarterFinancialResult,
  } = props;

  // --- 【Phase 8G】営業人員配分の集計。「配分済み/配分可能/未配分（or 超過）」の
  // 常時表示と、提出前の警告・全0リセットに使う唯一の情報源（合計判定ロジックを
  // ここと validateSalesForceHeadcountBudget で二重実装しない）。
  const salesForceAllocation = summarizeSalesForceAllocation(draft.salesPlans, fixture.salesForceHeadcountTotal);

  const rawMaterialInventory = ownState.rawMaterialLots
    .filter((l) => l.status === "available")
    .reduce((sum, l) => sum + unwrapUnit(l.remainingQuantity), 0);
  const outstandingBacklog = ownState.contracts
    .filter((c) => c.status === "open" || c.status === "partiallyFulfilled" || c.status === "overdue")
    .reduce((sum, c) => sum + unwrapUnit(c.outstandingQuantity), 0);

  // --- 加工能力（現時点の能力＋現在追加中）---
  // 生産計画セクションの「商品別能力」は、以前はfixture.factoriesの静的値だけを
  // 表示していたため、完成・稼働開始済みの設備投資による増加ぶんが画面に出ず、
  // エンジンが実際に上限として使う能力と食い違っていた（発見された不具合）。
  // processingCapacityViewModelはrunner.tsと同一の導出を行うため、以後は画面と
  // エンジンで同じ値を見ることになる。
  const capacityViewModel = buildCompanyProcessingCapacityViewModel({
    companyId: fixture.companyId,
    baseFactories: fixture.factories,
    capexState: { companies: [ownState.capexState] },
    period,
    params: CAPEX_PARAMETERS_V1,
  });
  const currentCapacityTons = (factoryId: string, pool: CapacityPoolKey): number | undefined => {
    const factory = capacityViewModel.factories.find((f) => f.factoryId === factoryId);
    return factory?.pools.find((p) => p.poolKey === pool)?.currentNominalTons;
  };
  const pendingCapacityTotalTons = Object.values(capacityViewModel.pendingTotalsByPool).reduce((sum, n) => sum + n, 0);

  // --- 現在の入力に基づく処理見込み（優先度を変えると即時に更新される）---
  // 【重要】ここでUI用の簡易計算は行わない。draftを既存の buildDecisionInputFromDraft で
  // エンジン入力へ変換し、その生産計画・ワーカー配置をそのまま
  // buildCompanyProcessingForecast（内部で allocateProductionPlans を呼ぶ純粋関数）へ渡す。
  // レンダーのたびに再計算されるため、優先度・希望量の入力変更が即座に反映される。
  const decisionInputForForecast = buildDecisionInputFromDraft(draft, fixture, period);
  const processingForecast = buildCompanyProcessingForecast({
    companyId: fixture.companyId,
    baseFactories: fixture.factories,
    capexState: { companies: [ownState.capexState] },
    period,
    productionPlans: decisionInputForForecast.productionPlans,
    workerAssignments: decisionInputForForecast.workerAssignments,
    rawMaterialLots: ownState.rawMaterialLots,
  });

  // --- 【Phase 8D-1】設備投資・Worker・工場スペース・保管・投資採算の共通view-model ---
  // 【重要】この1つの関数呼び出しが、能力・処理見込み・必要Worker・スペース・保管・
  // 投資カード・警告のすべての数字の出どころである。画面側では一切再計算しない。
  const planning = buildCompanyInvestmentPlanningViewModel({
    companyId: fixture.companyId,
    baseFactories: fixture.factories,
    capexState: { companies: [ownState.capexState] },
    period,
    productionPlans: decisionInputForForecast.productionPlans,
    workerAssignments: decisionInputForForecast.workerAssignments,
    workforceState: ownState.workforceState,
    rawMaterialLots: ownState.rawMaterialLots,
    finishedGoodsLots: ownState.finishedGoodsLots,
    lastQuarterFinancialResult,
    capexParams: CAPEX_PARAMETERS_V1,
  });
  const workforceRows = planning.workforceRows;
  const freezingPackagingPool = capacityViewModel.companyTotals.find((p) => p.poolKey === "freezingPackaging");
  const plannedFreezingProcessingTons = planning.forecast.rows.reduce((sum, r) => sum + r.forecastProcessedTons, 0);
  const coldStorageTemplate = CAPEX_PARAMETERS_V1.templatesByType.coldStorageExpansion;
  const coldStorageTonsPerProject = coldStorageTemplate.futureCapacityEffect.capacityIncreaseTonsPerQuarter ?? 0;
  const coldStorageInvestmentUsdPerTon =
    coldStorageTonsPerProject > 0 ? coldStorageTemplate.standardBudgetUsd / coldStorageTonsPerProject : undefined;

  // --- 【Phase 8B-3】設備投資セクション用の派生値 ---
  const capexCandidates = buildAllCapexCandidateViewModels(period, CAPEX_PARAMETERS_V1);
  const lastQuarterCapexEventsByProjectId = new Map((lastQuarterCapexEvents ?? []).map((e) => [e.projectId, e]));
  const capexPortfolioRows = buildCapexPortfolioViewModel(
    ownState.capexState.portfolio.projects,
    CAPEX_PARAMETERS_V1,
    period,
    lastQuarterCapexEventsByProjectId
  );
  const capexCandidateBudgetByType = (projectType: (typeof capexCandidates)[number]["projectType"], requestedBudgetUsd: number | undefined) =>
    requestedBudgetUsd ?? CAPEX_PARAMETERS_V1.templatesByType[projectType].standardBudgetUsd;
  const capexDraftThisQuarterPaymentUsd = draft.capexDecision.newProjectProposals.reduce((sum, p) => {
    const template = CAPEX_PARAMETERS_V1.templatesByType[p.projectType];
    const budget = capexCandidateBudgetByType(p.projectType, p.requestedBudgetUsd);
    return sum + budget * (template.paymentRatios[0] ?? 0);
  }, 0);
  const currentCashUsd = ownState.financeState.cash as number;

  // --- 【営業人員バジェット修正と合わせて発見・対応】資金調達セクション用の派生値 ---
  const existingLoans = ownState.financingState.loanPortfolio.loans.filter((l) => l.status !== "closed");
  const existingLoanBalanceUsd = existingLoans.reduce((sum, l) => sum + l.currentPrincipalUsd, 0);
  const accruedInterestPayableUsd = ownState.financingState.accruedInterestPayableUsd;

  return (
    <div className="space-y-3">
      <div className="space-y-2 bg-gray-900/60 rounded-lg px-3 py-2">
        <AreaToneLegend />
        <div className="text-xs text-gray-400">
          参考情報: 原料在庫（利用可能） {formatHosoEqTons(rawMaterialInventory)} / 未履行契約残高 {formatHosoEqTons(outstandingBacklog)}
          {disabled && <span className="ml-2 text-amber-400">この四半期はすでに進行済みです。編集内容は次の四半期に反映されます。</span>}
        </div>
      </div>

      {/* 【Phase 8D】現在の入力に対する警告（不足量と理由を文章でも示す） */}
      <CollapsibleSection
        title="現在の入力に対する警告"
        tone="info"
        testId="planning-warnings-section"
        summaryRight={planning.warnings.length > 0 ? `${planning.warnings.length}件` : "なし"}
      >
        <PlanningWarningsPanel warnings={planning.warnings} />
        <details className="mt-2">
          <summary className="text-[11px] text-teal-400 hover:text-teal-300 cursor-pointer">
            生産計画 → 必要能力 → 必要Worker → 必要スペース → 不足 → 投資 のつながり
          </summary>
          <ol className="mt-1 space-y-0.5">
            {planning.chainExplanationSteps.map((s, i) => (
              <li key={i} className="text-[11px] text-gray-400">
                {s}
              </li>
            ))}
          </ol>
        </details>
      </CollapsibleSection>

      {/* 【Phase 8D-5】凍結・包装処理能力（フロー）と冷凍・冷蔵保管能力（ストック） */}
      <CollapsibleSection
        title="凍結・包装処理能力（フロー）と冷凍・冷蔵保管能力（ストック）"
        tone="info"
        testId="cold-storage-section"
        summaryRight={
          planning.coldStorage.utilizationRate !== undefined
            ? `保管使用率 ${(planning.coldStorage.utilizationRate * 100).toFixed(1)}%`
            : undefined
        }
      >
        <ColdStoragePanel
          state={planning.coldStorage}
          freezingPackagingPool={freezingPackagingPool}
          plannedProcessingTons={plannedFreezingProcessingTons}
          investmentUsdPerStorageTon={coldStorageInvestmentUsdPerTon}
          explanationText={planning.freezingVsStorageExplanation}
        />
      </CollapsibleSection>

      {/* 工場加工能力（現時点＋現在追加中） */}
      <CollapsibleSection
        title="工場の加工能力（現時点・現在追加中）"
        tone="info"
        testId="processing-capacity-section"
        summaryRight={
          pendingCapacityTotalTons > 0
            ? `現在追加中 合計 +${formatHosoEqTons(pendingCapacityTotalTons)} t/四半期`
            : "現在追加中の能力なし"
        }
      >
        <ProcessingCapacityPanel viewModel={capacityViewModel} />
        <div className="mt-4 space-y-4">
          <CapacityEffectiveRatePanel table={processingForecast.companyRateTable} title="名目能力 → 実効能力の計算（会社合計・トン/四半期）" />
          {processingForecast.factoryRateTables.length > 1 &&
            processingForecast.factoryRateTables.map((table) => (
              <CapacityEffectiveRatePanel key={table.factoryId ?? "company"} table={table} title={`名目能力 → 実効能力の計算（${table.factoryId}）`} />
            ))}
        </div>
      </CollapsibleSection>

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

        {/* 【Phase 8D-2】投資カード（再設計版） */}
        <div className="space-y-1.5">
          <h4 className="text-xs font-semibold text-gray-300">投資案件候補（{capexCandidates.length}種類）</h4>
          <InvestmentCardList
            cards={planning.investmentCards}
            currentCashUsd={currentCashUsd}
            draftPaymentThisQuarterUsd={capexDraftThisQuarterPaymentUsd}
            isDuplicate={(projectType) => isDuplicateProjectTypeInDraft(draft, projectType)}
            onAdd={(projectType) => onChange(addCapexProposalToDraft(draft, projectType))}
            disabled={disabled}
          />
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

      {/* 販売計画 */}
      <CollapsibleSection
        title="販売計画（市場×商品）"
        tone="input"
        testId="sales-plan-section"
        summaryRight={
          salesForceAllocation.isOverAllocated
            ? `営業人員 ${salesForceAllocation.overBy}人超過`
            : `営業人員 配分済み ${salesForceAllocation.assignedTotal}人 / 配分可能 ${salesForceAllocation.availableTotal}人`
        }
      >
        <div
          data-testid="sales-force-allocation-summary"
          className={`flex flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2 text-xs ${
            salesForceAllocation.isOverAllocated
              ? "bg-rose-950/50 border border-rose-700/60 text-rose-200"
              : "bg-gray-900/60 border border-gray-700/60 text-gray-300"
          }`}
        >
          <span>
            {salesForceAllocation.isOverAllocated
              ? `配分済み ${salesForceAllocation.assignedTotal}人 / 配分可能 ${salesForceAllocation.availableTotal}人 / ${salesForceAllocation.overBy}人超過 — 現在の人員数に収まるように再編集してください。`
              : `配分済み ${salesForceAllocation.assignedTotal}人 / 配分可能 ${salesForceAllocation.availableTotal}人 / 未配分 ${salesForceAllocation.remaining}人`}
          </span>
          <button
            type="button"
            onClick={() => onChange(resetAllSalesForceHeadcountToZero(draft))}
            disabled={disabled}
            className="bg-gray-700 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed text-gray-100 rounded-md px-2 py-1 text-[11px] whitespace-nowrap"
          >
            営業配分をすべて0に戻す
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs text-gray-300">
            <thead>
              <tr className={INFO_TABLE_HEAD_CLASS}>
                <th className="pr-3 py-1">市場</th>
                <th className="pr-3 py-1">商品</th>
                <th className="pr-3 py-1">販売希望量(t)</th>
                <th className="pr-3 py-1">価格調整($/kg)</th>
                <th className="pr-3 py-1">営業人員</th>
              </tr>
            </thead>
            <tbody>
              {draft.salesPlans.map((row, idx) => (
                <tr key={`${row.market}-${row.product}`} className="border-t border-gray-700/60">
                  <td className="pr-3 py-1">{row.market}</td>
                  <td className="pr-3 py-1 uppercase">{row.product}</td>
                  <td className="pr-3 py-1">
                    <NumberCell
                      value={row.desiredQuantity}
                      disabled={disabled}
                      warn={row.desiredQuantity > fixture.salesForceHeadcountTotal * 500}
                      onChange={(n) => {
                        const next = [...draft.salesPlans];
                        next[idx] = { ...row, desiredQuantity: n };
                        onChange({ ...draft, salesPlans: next });
                      }}
                    />
                  </td>
                  <td className="pr-3 py-1">
                    <PriceAdjustmentCell
                      value={row.priceAdjustmentUsdPerHosoEqKg}
                      disabled={disabled}
                      onChange={(n) => {
                        const next = [...draft.salesPlans];
                        next[idx] = { ...row, priceAdjustmentUsdPerHosoEqKg: n };
                        onChange({ ...draft, salesPlans: next });
                      }}
                    />
                  </td>
                  <td className="pr-3 py-1">
                    <NumberCell
                      value={row.salesForceHeadcount}
                      disabled={disabled}
                      warn={salesForceAllocation.isOverAllocated}
                      onChange={(n) => {
                        // 【SAI-2追加作業: 市場別営業配置】営業人員は市場単位で共有される
                        // （同一市場のHOSO/PD/VAP行は必ず同じ人数を持つ必要がある）ため、
                        // このセルの編集は同じ市場の全商品行へ同期する。
                        onChange(syncMarketSalesForceHeadcount(draft, row.market, Math.round(n)));
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CollapsibleSection>

      {/* 国内原料買付 */}
      <CollapsibleSection title="国内原料買付" tone="input" testId="domestic-purchase-section">
        <div className="flex flex-wrap gap-4 text-xs text-gray-300">
          <label className="flex flex-col gap-1">
            買付希望量(t)
            <NumberCell
              value={draft.domesticPurchase.desiredQuantity}
              disabled={disabled}
              warn={draft.domesticPurchase.desiredQuantity > 20000}
              onChange={(n) => onChange({ ...draft, domesticPurchase: { ...draft.domesticPurchase, desiredQuantity: n } })}
            />
          </label>
          <label className="flex flex-col gap-1">
            価格調整($/kg)
            <PriceAdjustmentCell
              value={draft.domesticPurchase.priceAdjustmentUsdPerHosoEqKg}
              disabled={disabled}
              onChange={(n) => onChange({ ...draft, domesticPurchase: { ...draft.domesticPurchase, priceAdjustmentUsdPerHosoEqKg: n } })}
            />
          </label>
          <label className="flex flex-col gap-1">
            調達人員
            <NumberCell
              value={draft.domesticPurchase.procurementHeadcount}
              disabled={disabled}
              onChange={(n) => onChange({ ...draft, domesticPurchase: { ...draft.domesticPurchase, procurementHeadcount: Math.round(n) } })}
            />
          </label>
        </div>
      </CollapsibleSection>

      {/* 輸入 */}
      <CollapsibleSection title="輸入（原産国別）" tone="input" testId="import-section">
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs text-gray-300">
            <thead>
              <tr className={INFO_TABLE_HEAD_CLASS}>
                <th className="pr-3 py-1">原産国</th>
                <th className="pr-3 py-1">発注量(t)</th>
                <th className="pr-3 py-1">リードタイム(ターン)</th>
              </tr>
            </thead>
            <tbody>
              {draft.importOrders.map((row, idx) => (
                <tr key={row.originCountry} className="border-t border-gray-700/60">
                  <td className="pr-3 py-1">{row.originCountry}</td>
                  <td className="pr-3 py-1">
                    <NumberCell
                      value={row.orderedQuantity}
                      disabled={disabled}
                      onChange={(n) => {
                        const next = [...draft.importOrders];
                        next[idx] = { ...row, orderedQuantity: n };
                        onChange({ ...draft, importOrders: next });
                      }}
                    />
                  </td>
                  <td className="pr-3 py-1">
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={row.leadTimeTurns ?? ""}
                      disabled={disabled}
                      placeholder="標準"
                      onChange={(e) => {
                        const raw = e.target.value;
                        const next = [...draft.importOrders];
                        next[idx] = { ...row, leadTimeTurns: raw === "" ? undefined : Math.max(1, Math.round(Number(raw) || 1)) };
                        onChange({ ...draft, importOrders: next });
                      }}
                      className={`w-20 ${INPUT_CONTROL_CLASS}`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CollapsibleSection>

      {/* 養殖 */}
      {draft.aquacultureStockingPlans.length > 0 && (
        <CollapsibleSection
          title="養殖"
          tone="input"
          testId="aquaculture-section"
          summaryRight={`自社養殖能力上限 ${formatHosoEqTons(fixture.aquacultureCapacity)}`}
        >
          <div className="flex flex-wrap gap-4 text-xs text-gray-300">
            <label className="flex flex-col gap-1">
              池入れ予定量(t)
              <NumberCell
                value={draft.aquacultureStockingPlans[0].plannedStockingQuantity}
                disabled={disabled}
                warn={draft.aquacultureStockingPlans[0].plannedStockingQuantity > unwrapUnit(fixture.aquacultureCapacity)}
                onChange={(n) =>
                  onChange({
                    ...draft,
                    aquacultureStockingPlans: [{ ...draft.aquacultureStockingPlans[0], plannedStockingQuantity: n }],
                  })
                }
              />
            </label>
            <label className="flex flex-col gap-1">
              養殖強度(0〜1)
              <RatioCell
                value={draft.aquacultureStockingPlans[0].aquacultureIntensity}
                disabled={disabled}
                onChange={(n) =>
                  onChange({
                    ...draft,
                    aquacultureStockingPlans: [{ ...draft.aquacultureStockingPlans[0], aquacultureIntensity: n }],
                  })
                }
              />
            </label>
            <label className="flex flex-col gap-1">
              バイオセキュリティ(0〜1)
              <RatioCell
                value={draft.aquacultureStockingPlans[0].bioSecurityLevel}
                disabled={disabled}
                onChange={(n) =>
                  onChange({
                    ...draft,
                    aquacultureStockingPlans: [{ ...draft.aquacultureStockingPlans[0], bioSecurityLevel: n }],
                  })
                }
              />
            </label>
          </div>
        </CollapsibleSection>
      )}

      {/* 生産計画 */}
      <CollapsibleSection
        title="生産計画（工場×商品）"
        tone="input"
        testId="production-plan-section"
        description="「商品別能力」は、稼働開始済みの設備投資による増加ぶんを含んだ現時点の名目能力です（工場の加工能力セクションの内訳と同じ値）。"
      >
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs text-gray-300">
            <thead>
              <tr className={INFO_TABLE_HEAD_CLASS}>
                <th className="pr-3 py-1">工場</th>
                <th className="pr-3 py-1">商品</th>
                <th className="pr-3 py-1">商品別能力(t)</th>
                <th className="pr-3 py-1">生産希望量(t)</th>
                <th className="pr-3 py-1">優先度(小=優先)</th>
              </tr>
            </thead>
            <tbody>
              {draft.productionPlans.map((row, idx) => {
                const capacityNum = currentCapacityTons(row.factoryId, row.product as CapacityPoolKey);
                return (
                  <tr key={`${row.factoryId}-${row.product}`} className={INFO_TABLE_ROW_CLASS}>
                    <td className="pr-3 py-1">{row.factoryId}</td>
                    <td className="pr-3 py-1 uppercase">{row.product}</td>
                    <td className={`pr-3 py-1 ${INFO_VALUE_CLASS}`}>{capacityNum !== undefined ? formatHosoEqTons(capacityNum) : NO_VALUE_TEXT}</td>
                    <td className="pr-3 py-1">
                      <NumberCell
                        value={row.desiredQuantity}
                        disabled={disabled}
                        warn={capacityNum !== undefined && row.desiredQuantity > capacityNum * 1.5}
                        onChange={(n) => {
                          const next = [...draft.productionPlans];
                          next[idx] = { ...row, desiredQuantity: n };
                          onChange({ ...draft, productionPlans: next });
                        }}
                      />
                    </td>
                    <td className="pr-3 py-1">
                      <NumberCell
                        value={row.priority}
                        disabled={disabled}
                        onChange={(n) => {
                          const next = [...draft.productionPlans];
                          next[idx] = { ...row, priority: Math.round(n) };
                          onChange({ ...draft, productionPlans: next });
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="mt-4 bg-gray-900/50 border border-gray-700/60 rounded-lg px-3 py-2">
          <ProcessingForecastPanel forecast={processingForecast} />
        </div>
      </CollapsibleSection>

      {/* 【Phase 8D-4】Worker増減 */}
      <CollapsibleSection
        title="Worker（工場作業者）の増減"
        tone="input"
        testId="worker-assignment-section"
        description={WORKFORCE_EXPLANATION_TEXT}
        summaryRight={
          workforceRows.length > 0
            ? `変更後 合計 ${workforceRows.reduce((s, r) => s + r.headcountAfter, 0).toLocaleString("en-US")}人 / 四半期人件費 ${formatUsd(
                workforceRows.reduce((s, r) => s + r.costAfter.totalCostUsd, 0)
              )}`
            : undefined
        }
      >
        <WorkforcePanel
          rows={workforceRows}
          disabled={disabled}
          onChangeHeadcountDelta={(factoryId, delta) => {
            const idx = draft.workerAssignments.findIndex((w) => w.factoryId === factoryId);
            if (idx < 0) return;
            const row = draft.workerAssignments[idx];
            const before = row.regularHeadcountBefore ?? row.regularHeadcount;
            const next = [...draft.workerAssignments];
            next[idx] = {
              ...row,
              regularHeadcountBefore: before,
              regularHeadcountChange: delta,
              // 総人数（＝エンジンへ渡す絶対人数）は増減差分と同時に更新する。
              // 逆算式は applyHeadcountChange に一元化し、画面側で別計算をしない。
              regularHeadcount: applyHeadcountChange(before, delta),
            };
            onChange({ ...draft, workerAssignments: next });
          }}
          onChangeTemporaryHeadcount={(factoryId, value) => {
            const idx = draft.workerAssignments.findIndex((w) => w.factoryId === factoryId);
            if (idx < 0) return;
            const next = [...draft.workerAssignments];
            next[idx] = { ...next[idx], temporaryHeadcount: Math.round(value) };
            onChange({ ...draft, workerAssignments: next });
          }}
          onChangeOvertimeRate={(factoryId, value) => {
            const idx = draft.workerAssignments.findIndex((w) => w.factoryId === factoryId);
            if (idx < 0) return;
            const next = [...draft.workerAssignments];
            next[idx] = { ...next[idx], overtimeRate: value };
            onChange({ ...draft, workerAssignments: next });
          }}
        />
      </CollapsibleSection>

      {/* 【営業人員バジェット修正と合わせて発見・対応】資金調達（追加借入・任意期限前返済） */}
      <CollapsibleSection
        title="資金調達（借入・返済）"
        tone="input"
        testId="financing-section"
        summaryRight={`既存借入残高合計 ${formatUsd(existingLoanBalanceUsd)}`}
      >
        <div className="text-xs text-gray-400">
          既存借入残高合計 {formatUsd(existingLoanBalanceUsd)}
          {accruedInterestPayableUsd > 0 && <span className="ml-2">未払利息 {formatUsd(accruedInterestPayableUsd)}</span>}
        </div>
        {existingLoans.length > 0 && (
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs text-gray-300">
              <thead>
                <tr className={INFO_TABLE_HEAD_CLASS}>
                  <th className="pr-3 py-1">借入ID</th>
                  <th className="pr-3 py-1">種別</th>
                  <th className="pr-3 py-1">残高</th>
                  <th className="pr-3 py-1">年率</th>
                  <th className="pr-3 py-1">返済方式</th>
                  <th className="pr-3 py-1">満期</th>
                </tr>
              </thead>
              <tbody>
                {existingLoans.map((loan) => (
                  <tr key={loan.loanId} className={INFO_TABLE_ROW_CLASS}>
                    <td className="pr-3 py-1">{loan.loanId}</td>
                    <td className="pr-3 py-1">{LOAN_TYPE_LABELS[loan.loanType]}</td>
                    <td className="pr-3 py-1">{formatUsd(loan.currentPrincipalUsd)}</td>
                    <td className="pr-3 py-1">{(loan.annualInterestRate * 100).toFixed(2)}%</td>
                    <td className="pr-3 py-1">{REPAYMENT_METHOD_LABELS[loan.repaymentMethod]}</td>
                    <td className="pr-3 py-1">{loan.maturityPeriod}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex flex-wrap gap-4 text-xs text-gray-300">
          <label className="flex flex-col gap-1">
            追加希望借入額(USD)
            <NumberCell
              value={draft.financingRequest.desiredAmountUsd}
              disabled={disabled}
              step={100000}
              onChange={(n) => onChange({ ...draft, financingRequest: { ...draft.financingRequest, desiredAmountUsd: n } })}
            />
          </label>
          <label className="flex flex-col gap-1">
            借入種別
            <select
              value={draft.financingRequest.desiredLoanType}
              disabled={disabled}
              onChange={(e) =>
                onChange({ ...draft, financingRequest: { ...draft.financingRequest, desiredLoanType: e.target.value as CompanyDecisionDraft["financingRequest"]["desiredLoanType"] } })
              }
              className={INPUT_CONTROL_CLASS}
            >
              <option value="workingCapital">運転資金</option>
              <option value="termLoan">設備・長期資金</option>
              <option value="emergency">緊急融資</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            希望期間(四半期)
            <NumberCell
              value={draft.financingRequest.desiredTermQuarters}
              disabled={disabled}
              onChange={(n) => onChange({ ...draft, financingRequest: { ...draft.financingRequest, desiredTermQuarters: Math.max(1, Math.round(n)) } })}
            />
          </label>
          <label className="flex flex-col gap-1">
            返済方式
            <select
              value={draft.financingRequest.desiredRepaymentMethod}
              disabled={disabled}
              onChange={(e) =>
                onChange({
                  ...draft,
                  financingRequest: { ...draft.financingRequest, desiredRepaymentMethod: e.target.value as CompanyDecisionDraft["financingRequest"]["desiredRepaymentMethod"] },
                })
              }
              className={INPUT_CONTROL_CLASS}
            >
              <option value="bulletAtMaturity">満期一括</option>
              <option value="equalPrincipal">元金均等</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            任意期限前返済希望額(USD)
            <NumberCell
              value={draft.financingRequest.desiredPrepaymentUsd}
              disabled={disabled}
              step={100000}
              warn={draft.financingRequest.desiredPrepaymentUsd > existingLoanBalanceUsd}
              onChange={(n) => onChange({ ...draft, financingRequest: { ...draft.financingRequest, desiredPrepaymentUsd: n } })}
            />
          </label>
          <label className="flex flex-col gap-1 justify-end">
            <span className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={draft.financingRequest.emergencyAcceptable}
                disabled={disabled}
                onChange={(e) => onChange({ ...draft, financingRequest: { ...draft.financingRequest, emergencyAcceptable: e.target.checked } })}
                className="accent-sky-500"
              />
              緊急融資も許容する
            </span>
          </label>
        </div>
      </CollapsibleSection>
    </div>
  );
}
