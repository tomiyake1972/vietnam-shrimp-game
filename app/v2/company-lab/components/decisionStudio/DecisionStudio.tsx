// ShrimpX V2 — Decision Studio（意思決定編集の統合画面）
//
// 旧DecisionEditor.tsxが1ファイルに縦積みしていた7領域の意思決定
// （INFO・SALES・PRODUCTION・WORKER・PROCUREMENT・INVESTMENT・FINANCE）を、
// 上部Navigationで自由に切り替えられる画面群へ再構成する。ウィザードではない
// （Sales→Production→Salesのように自由に往復できる）。
//
// 【1つのDraft】画面を分割しても、SalesドラフトやProductionドラフトのような
// 別stateへは一切分離しない。draft/onChangeは常にこのcomponentの外側
// （呼び出し元：page.tsx / PlayerScreenClient.tsx / PlayerWorkspace.tsx）が
// 保持する唯一のCompanyDecisionDraftをそのまま全画面で共有する。タブ切替は
// ローカルなactiveScreenのuseStateだけが変わり、draftには一切触れない。
//
// 【計算しない】画面横断で使う派生値（能力・処理見込み・投資計画等）は
// decisionStudioViewModel.tsのbuildDecisionStudioViewModelへ委譲し、ここでは
// 1回だけ呼び出して各画面へsliceを配る。新しい計算式はこのファイルにもない。
//
// 【AI Management Meeting将来対応】MainDecisionAreaの幅は固定せず、
// 相対クラス（max-w-*・flex-1等）のみを使う。AI Meeting側パネルは
// AuxiliaryPanel.tsxとして右側に追加される（本ファイルはその表示/非表示の
// トグル状態だけを持ち、AI prompt・会話state・role定義には一切関与しない）。

import { useMemo, useState } from "react";
import { unwrapUnit } from "../../../../lib/v2/core/units";
import { PeriodV2 } from "../../../../lib/v2/core/period";
import { CompanyFixture, CompanyOwnState, PublicMarketInfo } from "../../../../lib/v2/companyLab";
import { CapexProjectQuarterEvent, CapexRejectedProposal } from "../../../../lib/v2/capex";
import { CompanyFinancialQuarterResult } from "../../../../lib/v2/finance/types";
import { FinancingQuarterResult } from "../../../../lib/v2/financing/types";
import { CompanyDividendQuarterResult } from "../../../../lib/v2/finance/dividend";
import { Product } from "../../../../lib/v2/market/types";
import { MarketProductBasePriceReference } from "../../../../lib/v2/sales/marketBasePriceReference";
import { CompanyDecisionDraft } from "../../decisionDraft";
import { buildDecisionStudioViewModel } from "../../decisionStudioViewModel";
import { planningWarningsFor } from "../../investmentPlanningViewModel";
import InitialDraftAdjustmentNotice from "./InitialDraftAdjustmentNotice";
import type { InitialDraftAdjustment } from "../../initialDraftFeasibility";
import type { OpeningInfoViewModel, ScenarioNewsItem } from "../../play/_lib/openingInfoViewModel";
import type { CompetitorNewsItem } from "../../../../lib/v2/companyLab/competitorNews";
import ProcurementPlanningSection from "../procurement/ProcurementPlanningSection";
import { AreaToneLegend } from "../CollapsibleSection";
import { AiInitialProposalNote, DecisionAreaHeading } from "../FieldAnnotations";
import DecisionStudioNavigation, { DecisionStudioScreenKey } from "./DecisionStudioNavigation";
import InformationScreen from "./InformationScreen";
import { computeBacklogSemantics } from "../../../../lib/v2/companyLab/aiManagementMeeting/backlogSemantics";
import { toYearQuarter } from "../../../../lib/v2/core/period";
import SalesPlanningScreen from "./SalesPlanningScreen";
import ProductionPlanningScreen from "./ProductionPlanningScreen";
import WorkforcePlanningScreen from "./WorkforcePlanningScreen";
import InvestmentPlanningScreen from "./InvestmentPlanningScreen";
import FinancePlanningScreen from "./FinancePlanningScreen";
import { AnnualDividendGuidance } from "../../../../lib/v2/finance/annualDividendGuidance";
import AuxiliaryPanel, { AiMeetingSource } from "./AuxiliaryPanel";
import type { StandardAiCostProjection } from "../../../../lib/v2/companyLab/standardAi/costProjection";

export interface DecisionStudioProps {
  readonly fixture: CompanyFixture;
  readonly ownState: CompanyOwnState;
  readonly draft: CompanyDecisionDraft;
  readonly onChange: (next: CompanyDecisionDraft) => void;
  readonly disabled: boolean;
  /**
   * 【テストプレイ指摘⑨・2026-11】disabled のときに出すバッジの文言。
   * 省略時は従来どおり「この四半期はすでに進行済みです」。参加者画面は
   * 提出直後（GMがまだTurnを進めていない状態）でも disabled になるため、
   * 事実に合う理由をここで渡せるようにする。
   */
  readonly disabledNotice?: string;
  /**
   * 【テストプレイ指摘①の続き・2026-11】初期値を実行可能な範囲へ
   * 丸めた記録（initialDraftFeasibility.ts の結果）。省略時・空のときは何も出さない。
   */
  readonly initialDraftAdjustments?: readonly InitialDraftAdjustment[];
  readonly period: PeriodV2;
  readonly lastQuarterCapexEvents?: readonly CapexProjectQuarterEvent[];
  readonly lastQuarterRejectedCapexProposals?: readonly CapexRejectedProposal[];
  readonly lastQuarterFinancialResult?: CompanyFinancialQuarterResult | null;
  /**
   * 【INT-1 §2B】前Turnの借入審査・緊急融資の確定記録。
   * 既存の FinancingQuarterResult をそのまま渡す（新しい計算はしない）。
   * 記録が無いRunでは undefined/null のまま渡し、画面側が「未取得」と表示する。
   */
  readonly lastQuarterFinancingResult?: FinancingQuarterResult | null;
  /** 【配当Decision UI接続】直近確定四半期の配当結果（累積配当・却下理由の表示用）。 */
  readonly lastQuarterDividendResult?: CompanyDividendQuarterResult | null;
  /**
   * 【D1 §8】年度中の配当参考表示（FINANCE画面）。管理者がバランス調整で配当性向を
   * 明示指定している場合に、Q4決算直後の自動精算と年初来実績ベース参考額を出す。
   * 渡さない呼び出し元（Company Lab経路）では何も表示されず、既存画面と同一。
   */
  readonly annualDividendGuidance?: AnnualDividendGuidance | null;
  /**
   * 【SALES基準価格参考表示・セキュリティ修正】直近確定四半期の市場×商品別「基準価格」だけの
   * 最小DTO（他社askPrice等は含まない。app/lib/v2/sales/marketBasePriceReference.ts参照）。
   */
  readonly lastQuarterSalesAllocations?: readonly MarketProductBasePriceReference[];
  readonly publicInfo?: PublicMarketInfo;
  readonly turn?: number;
  /**
   * 【管理会計是正・Player費用表示接続】当Turnの費用前提（PROCUREMENT画面の
   * Pre-Financing Liquidity 表示専用）。当Turnの値だけを持ち、将来Turnの
   * 指数曲線・将来費用値は含まない。省略時は中立値＝本変更前と同一表示。
   */
  readonly costProjection?: StandardAiCostProjection;
  /** INFO画面のBS・償却資産明細・市場情報向け（PlayerScreenClient.tsxが持つ場合のみ渡す）。 */
  readonly openingInfo?: OpeningInfoViewModel;
  /**
   * INFO画面のNews向け（openingInfoを渡さない呼び出し元専用。openingInfoがあれば
   * openingInfo.scenarioNewsが優先されるため、その場合は指定不要）。
   */
  readonly scenarioNews?: readonly ScenarioNewsItem[];
  /**
   * 【PUBLIC-COMPETITOR-2】前Turnの競合ニュース。INFOタブのニュース一覧へ
   * 「競合動向」カテゴリとして混ぜる。無ければカテゴリ自体を出さない。
   */
  readonly competitorNews?: readonly CompetitorNewsItem[];
  /**
   * AI Management Meeting panel接続用（Company Lab 経路。companyIdはfixture.companyIdを使う）。
   * labId・simulationRunId のどちらも無い場合は、AuxiliaryPanelのトグル自体を表示しない
   * （backendへ接続できないため）。
   */
  readonly labId?: string;
  /**
   * AI Management Meeting panel接続用（Management Console の Simulation Run 経路）。
   * PLAYER Company Workspace は Redis 上の Lab を持たないため labId ではなくこちらを渡す。
   * 会議の中身はどちらの経路でも同じ実装（aiManagementMeeting/session.ts）を通る。
   */
  readonly simulationRunId?: string;
  readonly companyName?: string;
  /**
   * 【UI-TRIAL-1 §5】表示する画面を外から指定する（controlled）。
   * 最終確認画面の「修正する」から該当の入力画面へ戻すために使う。
   * 省略時は従来どおりこのcomponentが内部stateで持つ（既存の呼び出し元は無変更で動く）。
   */
  readonly activeScreen?: DecisionStudioScreenKey;
  readonly onActiveScreenChange?: (screen: DecisionStudioScreenKey) => void;
}

export default function DecisionStudio(props: DecisionStudioProps) {
  const {
    fixture,
    ownState,
    draft,
    onChange,
    disabled,
    disabledNotice,
    initialDraftAdjustments,
    period,
    lastQuarterCapexEvents,
    lastQuarterRejectedCapexProposals,
    lastQuarterFinancialResult,
    lastQuarterFinancingResult,
    lastQuarterDividendResult,
    lastQuarterSalesAllocations,
    publicInfo,
    turn,
    costProjection,
    openingInfo,
    scenarioNews,
    competitorNews,
    labId,
    simulationRunId,
    companyName,
    annualDividendGuidance,
    activeScreen: activeScreenProp,
    onActiveScreenChange,
  } = props;

  // controlled（外から指定）と uncontrolled（従来）の両方を受ける。
  const [internalActiveScreen, setInternalActiveScreen] = useState<DecisionStudioScreenKey>("info");
  const activeScreen = activeScreenProp ?? internalActiveScreen;
  const setActiveScreen = (screen: DecisionStudioScreenKey): void => {
    if (activeScreenProp === undefined) setInternalActiveScreen(screen);
    onActiveScreenChange?.(screen);
  };
  const [auxiliaryPanelOpen, setAuxiliaryPanelOpen] = useState(false);

  // どちらの経路でAI会議へ繋ぐか。両方未指定なら会議の入口自体を出さない。
  // 【入力欄のたびに画面が勝手にスクロールする不具合の修正】useMemoを外すと、
  // Sales等どの入力欄を編集してもDecisionStudioが再renderされるたびにこのobjectが
  // 新しい参照として作られ、AuxiliaryPanel.tsxの「会話復元」useEffect（source自体を
  // 依存配列に持つ）が毎回再実行されてしまっていた。再実行のたびに会話一覧を
  // 再取得してmessages stateを（内容が同じでも）新しい配列として置き換え、それが
  // 「messages変化時に会話欄の末尾へscrollIntoViewする」別のuseEffectを連鎖的に
  // 誘発し、入力のたびに画面がスクロールする原因になっていた。labId・
  // simulationRunIdの値が変わらない限り同じobject参照を保つことで、この連鎖を止める。
  const aiMeetingSource: AiMeetingSource | null = useMemo(
    () => (labId !== undefined ? { kind: "companyLab", labId } : simulationRunId !== undefined ? { kind: "simulationRun", simulationRunId } : null),
    [labId, simulationRunId]
  );

  const vm = buildDecisionStudioViewModel({
    fixture,
    ownState,
    draft,
    period,
    lastQuarterCapexEvents,
    lastQuarterFinancialResult,
  });

  // 【UI-CLARITY-2 D4】警告は読むべき画面ごとに数える。以前は投資の話まで
  // PRODUCTION の件数に入っており、「生産で1件」と出るのに生産では直せなかった。
  const badgeCounts: Partial<Record<DecisionStudioScreenKey, number>> = {
    sales: vm.salesForceAllocation.isOverAllocated ? 1 : 0,
    production: planningWarningsFor(vm.planning.warnings, "production").length,
    investment: planningWarningsFor(vm.planning.warnings, "investment").length,
  };

  /**
   * 【INT-1 §2A】商品別受注残を意思決定画面で参照できるようにする。
   *
   * 集計は既存SSoT（aiManagementMeeting/backlogSemantics.ts の computeBacklogSemantics）を
   * そのまま呼ぶ。SalesContract.dueDate と outstandingQuantity だけから
   * Healthy Forward / Due This Turn / Overdue を分離し status まで確定する関数であり、
   * ここで新しい集計・しきい値・警告を作らない。
   * ownState.contracts は自社の契約のみ（情報境界は既存のまま）。
   * SALES と PRODUCTION の両画面へ同じ値を渡し、表示のズレを構造的に防ぐ。
   */
  const backlogSemantics = useMemo(() => {
    const yq = toYearQuarter(period);
    return computeBacklogSemantics(ownState.contracts, ownState.companyId, yq.year, yq.quarter);
  }, [ownState.contracts, ownState.companyId, period]);

  /**
   * 【テストプレイ指摘④・2026-10-29】販売画面で「販売希望数量 vs 実効加工能力」を
   * 並べて見せるための値。vm が既に計算済みの実効率テーブルから商品別の実効能力を
   * 読み出すだけで、ここでは何も計算し直さない（能力プールの hoso / pd / vap のみ。
   * commonProcessing・freezingPackaging は商品別ではないので対象外）。
   */
  const effectiveCapacityByProduct: Readonly<Partial<Record<Product, number>>> = Object.fromEntries(
    vm.processingForecast.companyRateTable.rows
      .filter((row): row is typeof row & { poolKey: Product } => row.poolKey === "hoso" || row.poolKey === "pd" || row.poolKey === "vap")
      .map((row) => [row.poolKey, row.effectiveTons])
  );

  /**
   * 【テストプレイ指摘①・2026-11】商品別の出荷可能な完成品在庫。
   * SALES 画面の供給上限の目安にだけ使う。ownState の確定ロットを
   * status==="available" で絞って足すだけで、評価・単価計算はしない
   * （decisionContext.ts の finishedGoodsTonsByProduct と同じ絞り込み）。
   */
  const finishedGoodsTonsByProduct = useMemo<Readonly<Partial<Record<Product, number>>>>(
    () =>
      ownState.finishedGoodsLots.reduce<Partial<Record<Product, number>>>((acc, lot) => {
        if (lot.status !== "available") return acc;
        acc[lot.product] = (acc[lot.product] ?? 0) + unwrapUnit(lot.remainingQuantity);
        return acc;
      }, {}),
    [ownState.finishedGoodsLots]
  );

  return (
    <div className="flex flex-wrap gap-3" data-testid="decision-studio">
      {/* MainDecisionArea — 固定幅にしない（flex-1）。AuxiliaryPanelが開いてもレイアウトが崩れない。 */}
      <div className="min-w-0 flex-1 space-y-2">
        {/* ヘッダー: SHRIMP X / Company / Turn / DRAFT */}
        <div className="flex flex-wrap items-center gap-2 bg-gray-900/70 rounded-lg px-3 py-2" data-testid="decision-studio-header">
          <span className="text-sm font-bold text-gray-100">SHRIMP X</span>
          <span className="text-gray-600">/</span>
          <span className="text-xs text-gray-300">{companyName ?? fixture.companyId}</span>
          <span className="text-gray-600">/</span>
          <span className="text-xs text-gray-300">{turn !== undefined ? `Turn ${turn}` : period}</span>
          <span className="text-gray-600">/</span>
          {disabled ? (
            /* 【テストプレイ指摘⑨・2026-11】disabled の理由は呼び出し元によって違う。
               参加者画面は「提出済み・GMの進行待ち」であって、「すでに進行済み」ではない。
               渡されない場合は従来どおりの文言を使う（GM側の挙動を変えない）。 */
            <span
              className="text-[11px] rounded px-1.5 py-0.5 bg-gray-800 text-gray-400 border border-gray-600/70"
              data-testid="decision-studio-disabled-notice"
            >
              {disabledNotice ?? "この四半期はすでに進行済みです"}
            </span>
          ) : (
            <span className="text-[11px] rounded px-1.5 py-0.5 bg-sky-900/70 text-sky-200 border border-sky-700/70">DRAFT・未提出</span>
          )}
          {aiMeetingSource !== null && (
            <button
              type="button"
              onClick={() => setAuxiliaryPanelOpen((v) => !v)}
              data-testid="decision-studio-toggle-ai-meeting"
              className="ml-auto text-[11px] px-2 py-1 rounded bg-indigo-900/70 border border-indigo-600/70 text-indigo-100 hover:bg-indigo-800/70"
            >
              {auxiliaryPanelOpen ? "AI Management Meeting を閉じる" : "AI Management Meeting を開く"}
            </button>
          )}
        </div>

        {/* 【UI-TRIAL-1 §4】「どこを入力するか」を画面の先頭で一度だけ明示する。
            対象Turn／四半期も併記し、計画と実績の混同を防ぐ。
            disabled（すでに進行済みの四半期）のときは入力の案内を出さない。 */}
        {!disabled && (
          <>
            <DecisionAreaHeading turnLabel={turn !== undefined ? `Turn ${turn}（${period}）` : `${period}`} testId="decision-studio-decision-heading" />
            <AiInitialProposalNote testId="decision-studio-ai-initial-note" />
          </>
        )}

        {/* 【テストプレイ指摘①の続き・2026-11】初期値を書き換えたときは、
            どのタブを開いていても気づけるよう画面先頭に出す。 */}
        {!disabled && initialDraftAdjustments !== undefined ? (
          <InitialDraftAdjustmentNotice adjustments={initialDraftAdjustments} />
        ) : null}

        <AreaToneLegend />

        <DecisionStudioNavigation active={activeScreen} onSelect={setActiveScreen} badgeCounts={badgeCounts} />

        <div className="pt-2">
          {activeScreen === "info" && (
            <InformationScreen
              fixture={fixture}
              ownState={ownState}
              turn={turn}
              publicInfo={publicInfo}
              openingInfo={openingInfo}
              scenarioNews={scenarioNews}
              competitorNews={competitorNews}
            />
          )}
          {activeScreen === "sales" && (
            <SalesPlanningScreen
              draft={draft}
              onChange={onChange}
              disabled={disabled}
              currentSalesForceHeadcount={vm.currentSalesForceHeadcount}
              salesForceAllocation={vm.salesForceAllocation}
              salesForceHiring={vm.salesForceHiring}
              salesForceHireLimit={vm.salesForceHireLimit}
              lastQuarterSalesAllocations={lastQuarterSalesAllocations}
              backlogSemantics={backlogSemantics}
              effectiveCapacityByProduct={effectiveCapacityByProduct}
              finishedGoodsTonsByProduct={finishedGoodsTonsByProduct}
            />
          )}
          {activeScreen === "production" && (
            <ProductionPlanningScreen draft={draft} onChange={onChange} disabled={disabled} vm={vm} backlogSemantics={backlogSemantics} />
          )}
          {activeScreen === "worker" && <WorkforcePlanningScreen draft={draft} onChange={onChange} disabled={disabled} vm={vm} />}
          {activeScreen === "procurement" && (
            <ProcurementPlanningSection
              fixture={fixture}
              ownState={ownState}
              draft={draft}
              onChange={onChange}
              disabled={disabled}
              period={period}
              publicInfo={publicInfo}
              turn={turn}
              costProjection={costProjection}
              /* 【テストプレイ指摘③・2026-11】国内原料価格の表示が画面ごとに違っていた。
                 PROCUREMENT が「未確定」とだけ言っていたのを、INFO タブと同じ開始時の
                 参考価格を指し示せるようにする（値は openingInfo の確定値をそのまま渡すだけ）。 */
              domesticOpeningReferencePriceUsdPerHosoEqKg={openingInfo?.domesticReferencePrice?.referencePriceUsdPerHosoEqKg}
            />
          )}
          {activeScreen === "investment" && (
            <InvestmentPlanningScreen
              fixture={fixture}
              ownState={ownState}
              draft={draft}
              onChange={onChange}
              disabled={disabled}
              vm={vm}
              lastQuarterRejectedCapexProposals={lastQuarterRejectedCapexProposals}
            />
          )}
          {activeScreen === "finance" && (
            <FinancePlanningScreen
              draft={draft}
              onChange={onChange}
              disabled={disabled}
              vm={vm}
              lastQuarterFinancialResult={lastQuarterFinancialResult}
              lastQuarterFinancingResult={lastQuarterFinancingResult}
              lastQuarterDividendResult={lastQuarterDividendResult}
              annualDividendGuidance={annualDividendGuidance}
              turn={turn}
            />
          )}
        </div>
      </div>

      {/* AuxiliaryPanel — AI Management Meeting。デスクトップでは右側に横並び、開いていない/接続先未指定なら何もレンダリングしない。 */}
      {aiMeetingSource !== null && auxiliaryPanelOpen && (
        <AuxiliaryPanel source={aiMeetingSource} companyId={fixture.companyId} turn={turn} onClose={() => setAuxiliaryPanelOpen(false)} />
      )}
    </div>
  );
}
