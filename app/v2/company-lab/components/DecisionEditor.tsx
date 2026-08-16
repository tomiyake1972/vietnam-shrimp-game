// ShrimpX V2 — 会社経営統合テスト環境（Phase 6.2） 意思決定編集パネル
//
// プレイヤー操作会社1社ぶんの当期意思決定（販売計画・国内原料買付・輸入・養殖・
// 生産計画・ワーカー配置）を編集する。初期値は generateAutoPolicyDecision の
// 出力（decisionDraft.tsのbuildInitialDraftで網羅グリッドへ変換したもの）。
// 数量・人数の負値・NaNは入力時点で0へ丸める（ハードエラー防止）。能力・在庫・
// 未履行残高などの参考情報を隣に表示し、明らかな入力ミス（過大な希望量等）は
// 警告表示のみ行い、送信はブロックしない（ソフト警告）。計算ロジックは
// 一切持たない（表示・編集のみ）。

import { score0to100, unwrapUnit } from "../../../lib/v2/core/units";
import { PeriodV2 } from "../../../lib/v2/core/period";
import { CompanyFixture, CompanyOwnState, PublicMarketInfo } from "../../../lib/v2/companyLab";
import { CAPEX_PARAMETERS_V1, CapexProjectQuarterEvent, CapexRejectedProposal } from "../../../lib/v2/capex";
import { formatHosoEqTons } from "../../../lib/v2/industryLab/ui/formatters";
import { computeSalesPlanTotals } from "../salesPlanTotals";
import {
  buildDecisionInputFromDraft,
  CompanyDecisionDraft,
  resetAllSalesForceHeadcountToZero,
  summarizeSalesForceAllocation,
  summarizeSalesForceHiring,
  syncMarketSalesForceHeadcount,
  VAP_PRODUCT_DEVELOPMENT_SPEND_TIER_OPTIONS_USD,
} from "../decisionDraft";
import {
  addCapexCancelRequestToDraft,
  addCapexProposalToDraft,
  isDuplicateProjectTypeInDraft,
  isNewFactoryConstructionBlockedByCap,
  isPdMechanizationBlockedForFactory,
  newFactoryConstructionCapBlockedReason,
  removeCapexCancelRequestFromDraft,
  removeCapexProposalFromDraft,
  setVapProductDevelopmentSpendInDraft,
} from "../capexDraftActions";
import { buildAllCapexCandidateViewModels, buildCapexPortfolioViewModel, CAPEX_EXPLANATION_DETAIL_TEXT, CAPEX_EXPLANATION_TEXT } from "../capexViewModel";
import { countProspectiveFactories, MAX_FACTORIES_PER_COMPANY } from "../../../lib/v2/capex/factoryConstruction";
import {
  PD_MECHANIZATION_PARAMETERS_V1,
  formatReductionRatioAtFullMaturityLabel,
} from "../../../lib/v2/capex/pdMechanization";
import { buildPdMechanizationStatusByFactory } from "../../../lib/v2/companyLab/pdMechanizationState";
import { effectiveEfficiencyPerHeadTons, requiredHeadcountForQuantity } from "../../../lib/v2/production/labor";
import { PRODUCTION_PARAMETERS_V1 } from "../../../lib/v2/production/parameters";
import {
  PRODUCT_DEVELOPMENT_PARAMETERS_V1,
  updateProductDevelopmentState,
} from "../../../lib/v2/companyLab/productDevelopmentState";
import { useState } from "react";
import { buildCompanyProcessingCapacityViewModel, CapacityPoolKey } from "../processingCapacityViewModel";
import { buildCompanyProcessingForecast } from "../processingForecastViewModel";
import { buildCompanyInvestmentPlanningViewModel } from "../investmentPlanningViewModel";
import { applyHeadcountChange, WORKFORCE_EXPLANATION_TEXT } from "../../../lib/v2/companyLab/workforce";
import { computeMaxSalesHiresPerQuarter } from "../../../lib/v2/companyLab/salesForceHiring";
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
import { INFO_TABLE_HEAD_CLASS, INFO_TABLE_ROW_CLASS, INFO_VALUE_CLASS, INPUT_CONTROL_CLASS, NO_VALUE_TEXT } from "./panelStyles";
import { NumberCell, PriceAdjustmentCell } from "./InputCells";
import ProcurementPlanningSection from "./procurement/ProcurementPlanningSection";

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
  /**
   * 【Procurement Planning情報ブロック・Step 4】公開市場情報（国内原料参考価格・
   * 前四半期の産地国別価格・国内基準供給量）。Procurement Pricing Summary /
   * Procurement Capacity Summary / Pre-Financing Liquidity Panel が使う。
   * 省略時はそれぞれ「－」表示となり、値を捏造しない（呼び出し元がpublicInfoを
   * まだ持たない画面でも既存機能を壊さないための任意化）。
   */
  readonly publicInfo?: PublicMarketInfo;
  /**
   * 【Procurement Planning情報ブロック・Step 4】当期turn番号。Pre-Financing
   * Liquidity Panel（buildStandardAiObservation経由）でのみ使う。省略時は
   * 同panelを「表示できません」扱いにする。
   */
  readonly turn?: number;
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
    publicInfo,
    turn,
  } = props;

  // --- 【Phase 8G §1】営業人員配分の集計。「配分済み/配分可能/未配分（or 超過）」の
  // 常時表示と、提出前の警告・全0リセットに使う唯一の情報源（合計判定ロジックを
  // ここと validateSalesForceHeadcountBudget で二重実装しない）。
  // 【営業人員の追加採用・forward-port】配分可能人数は静的なfixtureの基準値
  // ではなく、前期末までに確定した会社状態（ownState.salesForceHiringState.
  // headcount）を使う。増員後はこちらが増えるため、静的な基準値のままでは
  // 翌四半期以降も配分可能数が増えたことが画面に反映されない。
  const currentSalesForceHeadcount = ownState.salesForceHiringState.headcount;
  const salesForceAllocation = summarizeSalesForceAllocation(draft.salesPlans, currentSalesForceHeadcount);
  // --- 【営業人員の追加採用・減員・forward-port（続き）】営業人員の増減プレビュー
  // （現在の営業人員＋今回の採用予定−今回の減員予定、退職金見積り、同時入力
  // 禁止の判定を含む）。
  const salesForceHiring = summarizeSalesForceHiring(currentSalesForceHeadcount, draft.salesForceHireCount ?? 0, draft.salesForceLayoffCount ?? 0);
  // 増員上限はゲーム共通ルール（Standard AI・四半期処理の検証と同一の関数）。
  const salesForceHireLimit = computeMaxSalesHiresPerQuarter(salesForceHiring.currentHeadcount);

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

  // --- 【Test15新設】新工場建設（4工場上限のブロック判定） ---
  const newFactoryConstructionBlocked = isNewFactoryConstructionBlockedByCap(draft, fixture.factories.length, ownState.capexState.portfolio.projects);
  const newFactoryConstructionDraftPendingCount = draft.capexDecision.newProjectProposals.filter((p) => p.projectType === "newFactoryConstruction").length;
  const investmentCardExtraBlockedReason = (projectType: (typeof capexCandidates)[number]["projectType"]): string | undefined => {
    if (projectType !== "newFactoryConstruction") return undefined;
    return newFactoryConstructionBlocked
      ? newFactoryConstructionCapBlockedReason(fixture.factories.length, ownState.capexState.portfolio.projects, newFactoryConstructionDraftPendingCount)
      : undefined;
  };
  const prospectiveFactoryCount = countProspectiveFactories(fixture.factories.length, ownState.capexState.portfolio.projects) + newFactoryConstructionDraftPendingCount;

  // --- 【Test15新設】PD省人化投資（工場単位の対象選択・状況表示） ---
  // buildPdMechanizationStatusByFactoryは複数会社ぶんのcapexState/pdMechanizationStateを
  // 受け取る前提の関数だが、この画面は自社ぶんのownStateしか持たないため、既存の
  // capacityViewModel等と同じ「{ companies: [ownState.capexState] }」パターンで自社
  // 1社ぶんだけを渡す。pdMechanizationStateも同様に、ownState.pdUtilizationByFactory
  // （runner.ts buildCompanyOwnStateが公開済みの自社工場別・前四半期PD稼働率）から
  // 自社ぶんのPdMechanizationStateを組み立て直す（計算式自体は一切再実装せず、
  // 既存の純粋関数へそのまま渡すだけ）。
  const ownPdMechanizationStateForStatus = {
    entries: ownState.pdUtilizationByFactory.map((e) => ({
      factoryId: e.factoryId,
      companyId: fixture.companyId,
      previousQuarterPdUtilization: e.previousQuarterPdUtilization,
    })),
  };
  const pdMechanizationStatusByFactory = buildPdMechanizationStatusByFactory(
    { companies: [ownState.capexState] },
    ownPdMechanizationStateForStatus,
    period,
    PD_MECHANIZATION_PARAMETERS_V1
  );
  // 【Test15・develop/v2統合（Required fix 2）】PD省人化投資の対象工場選択肢は
  // ownState.effectiveFactories（稼働開始済みの新設Factoryを含む）を基準にする。
  // fixture.factoriesの静的一覧のままだと、新設Factoryが稼働開始しても対象として
  // 選択できない欠落があった。
  const [pdMechanizationTargetFactoryId, setPdMechanizationTargetFactoryId] = useState<string>(ownState.effectiveFactories[0]?.factoryId ?? "");
  const pdMechanizationBlockedForSelectedFactory =
    pdMechanizationTargetFactoryId !== "" && isPdMechanizationBlockedForFactory(draft, ownState.capexState.portfolio.projects, pdMechanizationTargetFactoryId);
  const pdMechanizationExistingProjectForFactory = (factoryId: string) =>
    ownState.capexState.portfolio.projects.find(
      (p) => p.projectType === "pdMechanization" && p.targetFactoryId === factoryId && p.status !== "cancelled"
    );

  // 【複数工場CAPEX Targeting修正】common processing/freezing・packaging/HOSO・PD・VAP line等
  // （newFactoryConstruction・pdMechanization以外）の投資カードが対象とするFactory。
  // pdMechanizationと同じくeffectiveFactories（稼働開始済み新設Factoryを含む）を基準にする。
  // 単一Factory企業ではselectorを出さず、この値がそのままその唯一のFactoryになる（§8）。
  const [factorySpecificTargetFactoryId, setFactorySpecificTargetFactoryId] = useState<string>(ownState.effectiveFactories[0]?.factoryId ?? "");
  const hasMultipleFactories = ownState.effectiveFactories.length > 1;

  // 【develop/v2統合・Required fix 5】投資金額・支払スケジュール・想定稼働開始時期・
  // 減価償却費・保守費（すべてcapex/parameters.tsのpdMechanizationテンプレート・
  // componentUsefulLifeQuartersを唯一の情報源とし、この画面で別の数値を作らない）。
  const pdMechanizationTemplate = CAPEX_PARAMETERS_V1.templatesByType.pdMechanization;
  const pdMechanizationConstructionQuarters = pdMechanizationTemplate.paymentRatios.length;
  const pdMechanizationReadinessQuarters = pdMechanizationTemplate.postCompletionReadinessQuarters;
  const pdMechanizationQuartersUntilActivation = pdMechanizationConstructionQuarters + pdMechanizationReadinessQuarters;
  const pdMechanizationQuarterlyMaintenanceUsd = pdMechanizationTemplate.standardBudgetUsd * pdMechanizationTemplate.maintenanceRatePerQuarter;
  const pdMechanizationQuarterlyDepreciationUsd =
    (pdMechanizationTemplate.standardBudgetUsd * pdMechanizationTemplate.buildingRatio) / CAPEX_PARAMETERS_V1.componentUsefulLifeQuarters.building +
    (pdMechanizationTemplate.standardBudgetUsd * pdMechanizationTemplate.machineryRatio) / CAPEX_PARAMETERS_V1.componentUsefulLifeQuarters.machinery;

  /**
   * 【develop/v2統合・Required fix 5】対象工場の「実際の現在の生産計画」（draft.
   * productionPlansのpd行）から、完全習熟後（実効PD係数がフロア1.0に到達した
   * 場合）に必要になる常用ワーカー人数の削減見込みを算出する。抽象的な一般値では
   * なく、この工場の当四半期時点の入力そのものから逆算する（production/labor.ts
   * のrequiredHeadcountForQuantity・effectiveEfficiencyPerHeadTonsを唯一の
   * 情報源とし、別の逆算式をこの画面で作らない）。
   */
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

  // --- 【Test15新設】VAP商品開発費（4段階選択・現在スコア・次四半期見込み） ---
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

        {/* 【Phase 8D-2】投資カード（再設計版）。【Test15】pdMechanizationは対象工場の選択が
            必須のため、この一覧からは除外し、下の専用セクションでのみ追加できる。 */}
        <div className="space-y-1.5">
          <h4 className="text-xs font-semibold text-gray-300">投資案件候補（{capexCandidates.length - 1}種類。PD省人化投資は下の専用セクションから）</h4>
          {newFactoryConstructionBlocked && (
            <div className="bg-amber-950/40 border border-amber-700/50 rounded px-2 py-1 text-[11px] text-amber-200">
              {newFactoryConstructionCapBlockedReason(fixture.factories.length, ownState.capexState.portfolio.projects, newFactoryConstructionDraftPendingCount)}
              （現在・進行中・今期提案 合計 {prospectiveFactoryCount} / 上限 {MAX_FACTORIES_PER_COMPANY}工場）
            </div>
          )}
          {/* 【複数工場CAPEX Targeting修正・§7/§8】2工場以上ある場合だけ対象工場selectorを表示する。
              1工場のみの会社では表示せず、その唯一のFactoryへ自動的に適用される（従来操作を変えない）。
              新工場建設（newFactoryConstruction）はこのselectorの対象外（対象Factoryを新設する案件のため）。 */}
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

          {/* 【develop/v2統合・Required fix 5】投資金額・支払スケジュール・想定稼働開始時期・
              減価償却費・保守費・削減見込み人数（対象工場の実際の生産計画から算出）。 */}
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
                "対象工場の当四半期のpd生産計画希望量が0のため、削減見込み人数を算出できません（生産計画セクションでpdの希望量を入力すると表示されます）。"
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
        {/* 【develop/v2統合・Required fix 5】上で選択したdraft.vapProductDevelopmentSpendUsd
            （唯一の情報源。会計計上・キャッシュフロー・スコア更新のすべてが同じこの値を
            参照する。companyLab/runner.ts・finance/quarterClose.ts参照）が、そのまま
            当四半期のSG&A・営業キャッシュフロー・現金へ計上される正確な金額であることを
            明示する。 */}
        <div className="text-[11px] text-gray-400 bg-gray-950/40 border border-gray-700/50 rounded px-2 py-1" data-testid="vap-spend-cashflow-note">
          上で選択した金額（${draft.vapProductDevelopmentSpendUsd.toLocaleString("en-US")}）が、そのまま当四半期のSG&A（販管費）へ全額費用化され、
          同額が当四半期の営業キャッシュフロー・現金の支出となります（資産計上・減価償却はありません）。この金額はVAP商品開発スコアの更新にも
          使われる唯一の情報源であり、画面上に別の金額が存在することはありません。
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
                      warn={row.desiredQuantity > currentSalesForceHeadcount * 500}
                      testId={`sales-plan-desired-quantity-${row.market}-${row.product}`}
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

        {/* 【指示1〜9・11】販売希望数量の商品別・市場別・全体合計。
            新しいゲーム計算ロジックは持たず、上の draft.salesPlans を
            computeSalesPlanTotals() で単純に足し上げるだけの pure derived
            value（別stateに二重保持しない・draftが変わるたびに再計算される）。 */}
        {(() => {
          const totals = computeSalesPlanTotals(draft.salesPlans);
          return (
            <div className="mt-3" data-testid="sales-plan-totals">
              {/* 【指示4・10】全体合計は横スクロールの外（mobileでもスクロール無しで見える位置）に、
                  商品別・市場別合計より少し目立たせて置く。 */}
              <div className="mb-2 flex items-center justify-between rounded-lg border border-sky-700/60 bg-sky-950/30 px-3 py-2">
                <span className="text-xs font-semibold text-sky-200">販売希望数量 合計</span>
                <span className="text-base font-bold tabular-nums text-sky-100" data-testid="sales-plan-grand-total">
                  {formatHosoEqTons(totals.grandTotalTons)}
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-xs text-gray-300" data-testid="sales-plan-totals-table">
                  <thead>
                    <tr className={INFO_TABLE_HEAD_CLASS}>
                      <th className="pr-3 py-1">市場＼商品</th>
                      {totals.products.map((product) => (
                        <th key={product} className="pr-3 py-1 text-right uppercase">
                          {product}
                        </th>
                      ))}
                      <th className="pr-3 py-1 text-right font-semibold">市場合計</th>
                    </tr>
                  </thead>
                  <tbody>
                    {totals.markets.map((market) => (
                      <tr key={market} className="border-t border-gray-700/60">
                        <td className="pr-3 py-1">{market}</td>
                        {totals.products.map((product) => (
                          <td
                            key={product}
                            className="pr-3 py-1 text-right tabular-nums"
                            data-testid={`sales-plan-cell-${market}-${product}`}
                          >
                            {formatHosoEqTons(totals.cellTons(market, product))}
                          </td>
                        ))}
                        <td className="pr-3 py-1 text-right font-semibold tabular-nums" data-testid={`sales-plan-market-total-${market}`}>
                          {formatHosoEqTons(totals.marketTotalTons(market))}
                        </td>
                      </tr>
                    ))}
                    <tr className="border-t border-gray-600 font-semibold">
                      <td className="pr-3 py-1">商品合計</td>
                      {totals.products.map((product) => (
                        <td key={product} className="pr-3 py-1 text-right tabular-nums" data-testid={`sales-plan-product-total-${product}`}>
                          {formatHosoEqTons(totals.productTotalTons(product))}
                        </td>
                      ))}
                      <td className="pr-3 py-1 text-right tabular-nums text-sky-200" data-testid="sales-plan-grand-total-cell">
                        {formatHosoEqTons(totals.grandTotalTons)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          );
        })()}
      </CollapsibleSection>

      {/* 【営業人員の追加採用・減員・forward-port（続き）】当期に決定した採用・
          減員はいずれも当期の配分可能人数には加算・減算されない（配分可能
          人数は上のsalesForceAllocation.availableTotalと同じ値のまま）。
          四半期確定時に採用・減員が成立し、次の四半期の開始時点から配分可能
          人数へ反映される（app/lib/v2/companyLab/salesForceHiring.ts参照）。
          採用と減員は同一四半期に同時入力できない（下の警告・提出ボタンの
          無効化で防止する）。 */}
      <CollapsibleSection
        title="営業人員の追加採用・減員"
        tone="input"
        testId="sales-force-hiring-section"
        summaryRight={
          salesForceHiring.plannedHireCount > 0
            ? `今回 採用予定 ${salesForceHiring.plannedHireCount}人 → 次期見込み ${salesForceHiring.nextQuarterHeadcount}人`
            : salesForceHiring.plannedLayoffCount > 0
              ? `今回 減員予定 ${salesForceHiring.plannedLayoffCount}人 → 次期見込み ${salesForceHiring.nextQuarterHeadcount}人`
              : `現在の営業人員 ${salesForceHiring.currentHeadcount}人`
        }
      >
        <div className="space-y-2">
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs text-gray-300">
              <tbody>
                <tr className="border-t border-gray-700/60">
                  <td className="pr-3 py-1 text-gray-400">現在の営業人員</td>
                  <td className="pr-3 py-1" data-testid="sales-force-hiring-current-headcount">
                    {salesForceHiring.currentHeadcount}人
                  </td>
                </tr>
                <tr className="border-t border-gray-700/60">
                  <td className="pr-3 py-1 text-gray-400">当期に配分可能</td>
                  <td className="pr-3 py-1">{salesForceHiring.currentHeadcount}人</td>
                </tr>
                {/* 【営業組織の増員速度制約・ゲーム共通ルール】上限値はStandard AIと
                    同じ salesForceHiring.ts の関数から取る（UI側で式を再実装しない）。
                    単に「最大+N」ではなく、なぜ上限があるのかが分かる文言にする。 */}
                <tr className="border-t border-gray-700/60">
                  <td className="pr-3 py-1 text-gray-400">営業人員採用数（今回の採用予定）</td>
                  <td className="pr-3 py-1">
                    <NumberCell
                      value={draft.salesForceHireCount ?? 0}
                      disabled={disabled}
                      onChange={(n) => onChange({ ...draft, salesForceHireCount: Math.round(Math.max(0, n)) })}
                    />
                    <div className="mt-0.5 text-[10px] text-gray-500" data-testid="sales-hire-ramp-limit">
                      営業組織の受入能力上、今期の増員上限は {salesForceHireLimit}人です
                      （現在{salesForceHiring.currentHeadcount}人の30%、最低3人）。
                      一度に増やしすぎると顧客の引継ぎ・育成・商談情報の共有が追いつきません。
                    </div>
                    {(draft.salesForceHireCount ?? 0) > salesForceHireLimit && (
                      <div className="mt-0.5 text-[10px] text-amber-300" data-testid="sales-hire-ramp-exceeded">
                        上限を超えています。このままでは四半期処理でエラーになります。
                      </div>
                    )}
                  </td>
                </tr>
                <tr className="border-t border-gray-700/60">
                  <td className="pr-3 py-1 text-gray-400">営業人員減員数（今回の減員予定）</td>
                  <td className="pr-3 py-1">
                    <NumberCell
                      value={draft.salesForceLayoffCount ?? 0}
                      disabled={disabled}
                      onChange={(n) => onChange({ ...draft, salesForceLayoffCount: Math.round(Math.max(0, n)) })}
                    />
                  </td>
                </tr>
                <tr className="border-t border-gray-700/60">
                  <td className="pr-3 py-1 text-gray-400">次期の営業人員見込み</td>
                  <td className="pr-3 py-1" data-testid="sales-force-hiring-next-quarter-headcount">
                    {salesForceHiring.nextQuarterHeadcount}人
                  </td>
                </tr>
                <tr className="border-t border-gray-700/60">
                  <td className="pr-3 py-1 text-gray-400">採用・減員の反映時期</td>
                  <td className="pr-3 py-1">次の四半期から</td>
                </tr>
                {salesForceHiring.plannedLayoffCount > 0 && (
                  <tr className="border-t border-gray-700/60">
                    <td className="pr-3 py-1 text-gray-400">今回発生する退職金（当期一括）</td>
                    <td className="pr-3 py-1" data-testid="sales-force-hiring-severance-cost">
                      {formatUsd(salesForceHiring.severanceCostUsd)}
                      {salesForceHiring.effectiveLayoffCount < salesForceHiring.plannedLayoffCount && (
                        <span className="ml-1 text-amber-400">
                          （現在の営業人員{salesForceHiring.currentHeadcount}人が上限のため、実際の減員は
                          {salesForceHiring.effectiveLayoffCount}人）
                        </span>
                      )}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-gray-400">
            今期採用した営業人員は、教育・引継ぎ期間を経て、次の四半期から営業活動に参加します。
            今期減員を決定した営業人員は、当期は引き続き配置・給与の対象のままで、次の四半期から
            配分可能人数が減ります（退職金は減員を決定した当期に一括で発生します）。
          </p>
          {salesForceHiring.hasMutualExclusionConflict && (
            <p className="text-[11px] text-red-400" data-testid="sales-force-hiring-conflict-warning" role="alert">
              営業人員の採用と減員を同一四半期に同時入力することはできません。いずれか一方を0にしてください
              （この内容のままでは提出できません）。
            </p>
          )}
        </div>
      </CollapsibleSection>

      {/* 【Step 5】Procurement Planning（国内原料買付・輸入・養殖の入力＋自動計算を
          統合した意思決定画面）。計算式・入力ロジックはすべてProcurementPlanningSection
          およびその子componentが呼ぶ既存view-model層が持つ。DecisionEditor.tsxはここでは
          何も計算しない。 */}
      <ProcurementPlanningSection
        fixture={fixture}
        ownState={ownState}
        draft={draft}
        onChange={onChange}
        disabled={disabled}
        period={period}
        publicInfo={publicInfo}
        turn={turn}
      />

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
