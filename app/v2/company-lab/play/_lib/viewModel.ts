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
import { CapexProjectQuarterEvent, CapexRejectedProposal } from "../../../../lib/v2/capex";
import { CompanyLabApiDependencies } from "../../../../api/v2/company-labs/_lib/dependencies";
import { toHistoryEntrySummaryDto, CompanyLabHistoryEntrySummaryDto } from "../../../../api/v2/company-labs/_lib/responseDto";
import { isPlausibleCompanyDecisionDraft } from "../../../../api/v2/company-labs/_lib/decisionsProvider";

export type PlayerScreenPhase = "editing" | "submitted" | "completed";

export interface PlayerLastQuarterResult {
  readonly turn: number;
  readonly turnId: string;
  readonly processedAt: string;
  readonly marketResult: MarketQuarterResult;
  readonly globalReasonCodes: readonly CompanyReasonEntry[];
  readonly playerSummary: CompanyQuarterSummary | null;
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

  const lastQuarterResult: PlayerLastQuarterResult | null =
    latestEntry !== null
      ? {
          turn: latestEntry.turn,
          turnId: latestEntry.turnId,
          processedAt: latestEntry.processedAt,
          marketResult: latestEntry.record.marketResult,
          globalReasonCodes: latestEntry.record.globalReasonCodes,
          playerSummary: latestEntry.record.companySummaries.find((s) => s.companyId === stored.playerCompanyId) ?? null,
        }
      : null;

  const lastQuarterCapexResult = latestEntry?.record.capexResults.find((r) => r.companyId === stored.playerCompanyId);

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
      recentHistory: historyPage.entries.map(toHistoryEntrySummaryDto),
    },
  };
}
