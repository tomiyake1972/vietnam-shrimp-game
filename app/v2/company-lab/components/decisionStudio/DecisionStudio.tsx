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
import { PeriodV2 } from "../../../../lib/v2/core/period";
import { CompanyFixture, CompanyOwnState, PublicMarketInfo } from "../../../../lib/v2/companyLab";
import { CapexProjectQuarterEvent, CapexRejectedProposal } from "../../../../lib/v2/capex";
import { CompanyFinancialQuarterResult } from "../../../../lib/v2/finance/types";
import { CompanyDividendQuarterResult } from "../../../../lib/v2/finance/dividend";
import { CompanyDecisionDraft } from "../../decisionDraft";
import { buildDecisionStudioViewModel } from "../../decisionStudioViewModel";
import type { OpeningInfoViewModel, ScenarioNewsItem } from "../../play/_lib/openingInfoViewModel";
import ProcurementPlanningSection from "../procurement/ProcurementPlanningSection";
import { AreaToneLegend } from "../CollapsibleSection";
import DecisionStudioNavigation, { DecisionStudioScreenKey } from "./DecisionStudioNavigation";
import InformationScreen from "./InformationScreen";
import SalesPlanningScreen from "./SalesPlanningScreen";
import ProductionPlanningScreen from "./ProductionPlanningScreen";
import WorkforcePlanningScreen from "./WorkforcePlanningScreen";
import InvestmentPlanningScreen from "./InvestmentPlanningScreen";
import FinancePlanningScreen from "./FinancePlanningScreen";
import AuxiliaryPanel, { AiMeetingSource } from "./AuxiliaryPanel";

export interface DecisionStudioProps {
  readonly fixture: CompanyFixture;
  readonly ownState: CompanyOwnState;
  readonly draft: CompanyDecisionDraft;
  readonly onChange: (next: CompanyDecisionDraft) => void;
  readonly disabled: boolean;
  readonly period: PeriodV2;
  readonly lastQuarterCapexEvents?: readonly CapexProjectQuarterEvent[];
  readonly lastQuarterRejectedCapexProposals?: readonly CapexRejectedProposal[];
  readonly lastQuarterFinancialResult?: CompanyFinancialQuarterResult | null;
  /** 【配当Decision UI接続】直近確定四半期の配当結果（累積配当・却下理由の表示用）。 */
  readonly lastQuarterDividendResult?: CompanyDividendQuarterResult | null;
  readonly publicInfo?: PublicMarketInfo;
  readonly turn?: number;
  /** INFO画面のBS・償却資産明細・市場情報向け（PlayerScreenClient.tsxが持つ場合のみ渡す）。 */
  readonly openingInfo?: OpeningInfoViewModel;
  /**
   * INFO画面のNews向け（openingInfoを渡さない呼び出し元専用。openingInfoがあれば
   * openingInfo.scenarioNewsが優先されるため、その場合は指定不要）。
   */
  readonly scenarioNews?: readonly ScenarioNewsItem[];
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
}

export default function DecisionStudio(props: DecisionStudioProps) {
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
    lastQuarterDividendResult,
    publicInfo,
    turn,
    openingInfo,
    scenarioNews,
    labId,
    simulationRunId,
    companyName,
  } = props;

  const [activeScreen, setActiveScreen] = useState<DecisionStudioScreenKey>("info");
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

  const badgeCounts: Partial<Record<DecisionStudioScreenKey, number>> = {
    sales: vm.salesForceAllocation.isOverAllocated ? 1 : 0,
    production: vm.planning.warnings.length,
  };

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
            <span className="text-[11px] rounded px-1.5 py-0.5 bg-gray-800 text-gray-400 border border-gray-600/70">この四半期はすでに進行済みです</span>
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
            />
          )}
          {activeScreen === "production" && <ProductionPlanningScreen draft={draft} onChange={onChange} disabled={disabled} vm={vm} />}
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
              period={period}
              turn={turn}
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
              lastQuarterDividendResult={lastQuarterDividendResult}
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
