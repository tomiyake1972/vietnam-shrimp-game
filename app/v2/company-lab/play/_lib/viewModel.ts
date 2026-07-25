// ShrimpX V2 — Company Lab プレイヤー画面（Phase 8C-3B） サーバー専用ビューモデル
//
// Server Component（page.tsx）だけが呼ぶ、フレームワーク非依存の純粋な非同期関数群。
// ここで初めて「巨大な内部状態（currentState.runtime・履歴エントリ全体）を読み、
// 画面表示に必要な最小限（プレイヤー会社1社ぶんのownState・公開市場情報・軽量な
// 履歴要約）だけに絞り込んでクライアント（React Server Componentのpropsとして
// ブラウザへ送られるツリー）へ渡す」という、指示§8.2「巨大なsnapshotを通常画面で
// 取得・表示しない」の実際の絞り込み地点になる。
//
// 【turn 2以降の復元についての重要事項】stored.currentState.runtime
// （CompanyLabRuntimeSnapshot）は、それ単体ではbuildCompanyOwnState/
// buildPublicMarketInfoへ渡せる完全なCompanyLabStateではない。turn 2以降は
// 直近確定履歴のrecordを注入して復元しないと、前四半期の市場価格・工場負荷等が
// シナリオのprehistory値へ静かにフォールバックしてしまう（Phase 8C-2 companyLab
// QuarterFlowService.tsのprocessQuarter内の復元ロジックと全く同じ理由・同じ手順。
// 重複実装せず、restoreCompanyLabStateFromRuntimeSnapshotをそのまま再利用する）。

import { CompanyDecisionDraft, buildInitialDraft } from "../../decisionDraft";
import { CompanyFixture, CompanyLabState, CompanyOwnState, CompanyQuarterSummary, CompanyReasonEntry, PublicMarketInfo } from "../../../../lib/v2/companyLab/types";
import { buildCompanyOwnState, buildPublicMarketInfo } from "../../../../lib/v2/companyLab/runner";
import { generateAutoPolicyDecision } from "../../../../lib/v2/companyLab/autoPolicy";
import { restoreCompanyLabStateFromRuntimeSnapshot } from "../../../../lib/v2/companyLab/persistence/snapshot";
import { CompanyLabPersistedStateV1, CompanyLabDraftEnvelope } from "../../../../lib/v2/companyLab/persistence/types";
import { MarketQuarterResult } from "../../../../lib/v2/market/types";
import { CapexProjectQuarterEvent, CapexQuarterResult, CapexRejectedProposal } from "../../../../lib/v2/capex";
import { CompanyFinancialQuarterResult } from "../../../../lib/v2/finance/types";
import { FinancingQuarterResult } from "../../../../lib/v2/financing/types";
import { CompanyLabApiDependencies } from "../../../../api/v2/company-labs/_lib/dependencies";
import { toHistoryEntrySummaryDto, CompanyLabHistoryEntrySummaryDto } from "../../../../api/v2/company-labs/_lib/responseDto";
import { isPlausibleCompanyDecisionDraft } from "../../../../api/v2/company-labs/_lib/decisionsProvider";
import { extractCompanyCapexResult, extractCompanyFinancialResult, extractCompanyFinancingResult } from "./financialViewSelectors";

export type PlayerScreenPhase = "editing" | "submitted" | "completed";

export interface PlayerLastQuarterResult {
  readonly turn: number;
  readonly turnId: string;
  readonly period: string;
  readonly processedAt: string;
  readonly marketResult: MarketQuarterResult;
  readonly globalReasonCodes: readonly CompanyReasonEntry[];
  readonly playerSummary: CompanyQuarterSummary | null;
  /**
   * 【Phase 8C-3C想定・財務表示追加】当期のプレイヤー会社ぶんのPL/BS/CF結果。
   * finance/quarterClose.tsが既に計算・永続化済みの値をcompanyIdで抽出するだけで、
   * ここでは一切再計算しない。該当データがなければnull（=「未作成」として画面側で表示）。
   */
  readonly financialResult: CompanyFinancialQuarterResult | null;
  /** 当期のプレイヤー会社ぶんの資金繰り結果（信用スコア・借入審査・延滞等）。抽出のみ、再計算なし。 */
  readonly financingResult: FinancingQuarterResult | null;
  /** 当期のプレイヤー会社ぶんの設備投資結果（全体。既存のlastQuarterCapexEvents等はDecisionEditor向けに従来通り残す）。 */
  readonly capexResult: CapexQuarterResult | null;
}

/**
 * 前期（turn-1）ぶんの、財務・資金・設備投資の比較用データ。
 * 【当期・前期・増減表示のための最小限のデータ】重い内部snapshotは一切含めず、
 * companyId抽出後のPL/BS/CF・資金繰り・設備投資結果だけをクライアントへ渡す。
 * 初回四半期（turn===1）や取得に失敗した場合はnull（画面側は「データなし」として
 * 正常表示する。捏造しない）。
 */
export interface PlayerPreviousQuarterFinancials {
  readonly turn: number;
  readonly period: string;
  readonly financialResult: CompanyFinancialQuarterResult | null;
  readonly financingResult: FinancingQuarterResult | null;
  readonly capexResult: CapexQuarterResult | null;
}

export interface PlayerScreenViewModel {
  readonly labId: string;
  readonly playerCompanyId: string;
  readonly playerDisplayName: string;
  readonly scenarioId: string;
  readonly mode: string;
  readonly totalTurns: number;
  readonly currentTurn: number;
  readonly revision: number;
  readonly isComplete: boolean;
  readonly phase: PlayerScreenPhase;
  readonly fixture: CompanyFixture;
  readonly ownState: CompanyOwnState;
  readonly publicInfo: PublicMarketInfo;
  readonly period: CompanyLabState["currentPeriod"];
  /** 編集対象のdraft本体（未保存なら自動方針から組み立てた初期値。完了済みならnull）。 */
  readonly draft: CompanyDecisionDraft | null;
  readonly draftSubmittedAt: string | null;
  readonly draftUpdatedAt: string | null;
  readonly lastQuarterResult: PlayerLastQuarterResult | null;
  readonly lastQuarterCapexEvents: readonly CapexProjectQuarterEvent[] | undefined;
  readonly lastQuarterRejectedCapexProposals: readonly CapexRejectedProposal[] | undefined;
  /** 前期（turn-1）ぶんの財務・資金・設備投資（当期・前期・増減表示用）。前期が存在しなければnull。 */
  readonly previousQuarterFinancials: PlayerPreviousQuarterFinancials | null;
  /** 履歴要約（診断用のhistory/[turn]は使わない。§6.6・§8.2）。最新10件まで。 */
  readonly recentHistory: readonly CompanyLabHistoryEntrySummaryDto[];
}

export type PlayerScreenLoadResult = { readonly kind: "ok"; readonly viewModel: PlayerScreenViewModel } | { readonly kind: "notFound" };

/** 提出済みでない既存draftが、現在のプレイヤー会社向けとして解釈可能な形かどうか（壊れていれば安全側で再生成する）。 */
function coerceDraftOrRebuild(
  envelope: CompanyLabDraftEnvelope | null,
  fixture: CompanyFixture,
  restoredState: CompanyLabState,
  publicInfo: PublicMarketInfo,
  turn: number
): CompanyDecisionDraft {
  if (envelope !== null && isPlausibleCompanyDecisionDraft(envelope.draft, fixture.companyId)) {
    return envelope.draft;
  }
  // draftが無い（新しいturn）か、保存済みだが構造上解釈できない場合は、既存の仮UI
  // （page.tsx）と同じ手順で自動方針の出力から初期値を組み立てる。
  const ownState = buildCompanyOwnState(restoredState, fixture);
  const autoDecision = generateAutoPolicyDecision(fixture, ownState, publicInfo, restoredState.currentPeriod, turn);
  return buildInitialDraft(fixture, autoDecision);
}

export async function loadPlayerScreenViewModel(deps: CompanyLabApiDependencies, labId: string): Promise<PlayerScreenLoadResult> {
  let stored: CompanyLabPersistedStateV1;
  try {
    stored = await deps.repository.loadCurrentState(labId);
  } catch {
    return { kind: "notFound" };
  }

  const fixture = stored.fixtures.find((f) => f.companyId === stored.playerCompanyId);
  if (!fixture) {
    // createLab側でplayerCompanyIdがfixturesに含まれることを保証済みのため、通常到達しない
    // （保存データの破損等、防御的なケース）。画面へは「見つからない」として扱う。
    return { kind: "notFound" };
  }

  const [draftEnvelope, latestEntry] = await Promise.all([deps.repository.loadDraft(labId), deps.repository.loadLatestHistoryEntry(labId)]);

  // 【重要】turn 2以降の直近履歴注入。processQuarterの復元ロジックと同じ手順。
  const historyRecords = latestEntry !== null ? [latestEntry.record] : [];
  const restoredState = restoreCompanyLabStateFromRuntimeSnapshot(stored.config, stored.currentState.runtime, historyRecords);
  const turn = restoredState.scenarioState.currentTurn;

  const ownState = buildCompanyOwnState(restoredState, fixture);
  const publicInfo = buildPublicMarketInfo(restoredState);
  const isComplete = restoredState.isComplete;

  let phase: PlayerScreenPhase;
  let draft: CompanyDecisionDraft | null;
  if (isComplete) {
    phase = "completed";
    draft = null;
  } else if (draftEnvelope !== null && draftEnvelope.submittedAt !== null) {
    phase = "submitted";
    draft = isPlausibleCompanyDecisionDraft(draftEnvelope.draft, fixture.companyId) ? draftEnvelope.draft : null;
  } else {
    phase = "editing";
    draft = coerceDraftOrRebuild(draftEnvelope, fixture, restoredState, publicInfo, turn);
  }

  const lastQuarterCapexResult = latestEntry !== null ? extractCompanyCapexResult(latestEntry.record, stored.playerCompanyId) : null;

  const lastQuarterResult: PlayerLastQuarterResult | null =
    latestEntry !== null
      ? {
          turn: latestEntry.turn,
          turnId: latestEntry.turnId,
          period: String(latestEntry.record.period),
          processedAt: latestEntry.processedAt,
          marketResult: latestEntry.record.marketResult,
          globalReasonCodes: latestEntry.record.globalReasonCodes,
          playerSummary: latestEntry.record.companySummaries.find((s) => s.companyId === stored.playerCompanyId) ?? null,
          financialResult: extractCompanyFinancialResult(latestEntry.record, stored.playerCompanyId),
          financingResult: extractCompanyFinancingResult(latestEntry.record, stored.playerCompanyId),
          capexResult: lastQuarterCapexResult,
        }
      : null;

  // 【前期（turn-1）ぶんの財務・資金・設備投資を、当期・前期・増減表示のために取得する】
  // loadHistoryEntryは単一turn分のみの取得であり、全履歴を読むloadFullHistory
  // （診断用・数十MB規模）とは性質が異なるため、Repository契約上「通常の
  // Application Service層から使ってよい」対象（§9）。取得できない・存在しない
  // （初回四半期turn===1、または何らかの理由で前期データが欠落）場合はnullとし、
  // 値を捏造せず「データなし」として画面側で正常表示する。
  let previousQuarterFinancials: PlayerPreviousQuarterFinancials | null = null;
  if (latestEntry !== null && latestEntry.turn > 1) {
    try {
      const previousEntry = await deps.repository.loadHistoryEntry(labId, latestEntry.turn - 1);
      previousQuarterFinancials = {
        turn: previousEntry.turn,
        period: String(previousEntry.period),
        financialResult: extractCompanyFinancialResult(previousEntry.record, stored.playerCompanyId),
        financingResult: extractCompanyFinancingResult(previousEntry.record, stored.playerCompanyId),
        capexResult: extractCompanyCapexResult(previousEntry.record, stored.playerCompanyId),
      };
    } catch {
      previousQuarterFinancials = null;
    }
  }

  const historyPage = await deps.repository.loadHistoryPage(labId, { limit: 10 });

  return {
    kind: "ok",
    viewModel: {
      labId: stored.labId,
      playerCompanyId: stored.playerCompanyId,
      playerDisplayName: fixture.displayName,
      scenarioId: stored.config.scenarioId,
      mode: stored.config.mode,
      totalTurns: stored.config.turns,
      currentTurn: turn,
      revision: stored.currentState.revision,
      isComplete,
      phase,
      fixture,
      ownState,
      publicInfo,
      period: restoredState.currentPeriod,
      draft,
      draftSubmittedAt: draftEnvelope?.submittedAt ?? null,
      draftUpdatedAt: draftEnvelope?.updatedAt ?? null,
      lastQuarterResult,
      lastQuarterCapexEvents: lastQuarterCapexResult?.events,
      lastQuarterRejectedCapexProposals: lastQuarterCapexResult?.rejectedProposals,
      previousQuarterFinancials,
      recentHistory: historyPage.entries.map(toHistoryEntrySummaryDto),
    },
  };
}
