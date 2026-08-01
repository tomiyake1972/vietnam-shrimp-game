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
import { generateStandardAiDecisionWithDiagnostics, StandardAiQuarterDiagnostics } from "../../../../lib/v2/companyLab/standardAi/policy";
import { restoreCompanyLabStateFromRuntimeSnapshot } from "../../../../lib/v2/companyLab/persistence/snapshot";
import { CompanyLabPersistedStateV1, CompanyLabDraftEnvelope } from "../../../../lib/v2/companyLab/persistence/types";
import { MarketQuarterResult } from "../../../../lib/v2/market/types";
import { ConsumerMarketQuarterRecord } from "../../../../lib/v2/market/consumerInventory";
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
  /**
   * 【Phase 8F-1】当期の消費国別・在庫循環（消費／在庫／購買）確定結果。全社共通・公開情報であり、
   * 個社の非公開計画は含まない。CompanyQuarterRecord.consumerMarketRecordsが未設定
   * （Phase 8F-1導入前の古い保存データ）の場合はundefinedのままとし、画面側は
   * 「データなし」として捏造せず表示する。
   */
  readonly consumerMarketRecords: readonly ConsumerMarketQuarterRecord[] | undefined;
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

/**
 * 前期（turn-1）ぶんの公開市場結果（市場情報パネルの前四半期比表示用）。
 * 会社別の非公開情報は一切含まない（marketResultは全社共通・公開情報）。
 * 前期が存在しない（初回四半期）・取得に失敗した場合はnullとし、画面側は
 * 前期比を「-」と表示する（0で埋めない・値を捏造しない）。
 */
export interface PlayerPreviousQuarterMarket {
  readonly turn: number;
  readonly period: string;
  readonly marketResult: MarketQuarterResult;
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
  /** 編集対象のdraft本体（未保存ならStandard AIの提案から組み立てた初期値。完了済みならnull）。 */
  readonly draft: CompanyDecisionDraft | null;
  /**
   * 【feature/v2-persist-standard-ai-proposal（Phase A）で修正】このturn開始時に
   * Standard AIが提示した原案の診断情報（判断理由コード・圧力値・当時のdecision＝
   * 「希望値」）。draftをその場で新規生成した場合はもちろん、既存の保存済みdraft
   * envelopeにaiProposalDiagnosticsが永続化されている場合も、その値をそのまま
   * 返す（＝draftを保存・リロードしてもこの値は変わらない。旧バグ「保存後の
   * リロードでAI提案が消える」の修正）。draftを編集してもこの値自体は変化しない
   * ——「AI原案」と「現在の入力」は明確に別物として扱う（指示§A-2）。
   * 提出済み／完了済みの場合、および（後方互換の再現に失敗した等の）防御的な
   * 理由でdraft自体が組み立てられない場合のみnull。
   */
  readonly aiProposalDiagnostics: StandardAiQuarterDiagnostics | null;
  readonly draftSubmittedAt: string | null;
  readonly draftUpdatedAt: string | null;
  readonly lastQuarterResult: PlayerLastQuarterResult | null;
  readonly lastQuarterCapexEvents: readonly CapexProjectQuarterEvent[] | undefined;
  readonly lastQuarterRejectedCapexProposals: readonly CapexRejectedProposal[] | undefined;
  /** 前期（turn-1）ぶんの財務・資金・設備投資（当期・前期・増減表示用）。前期が存在しなければnull。 */
  readonly previousQuarterFinancials: PlayerPreviousQuarterFinancials | null;
  /** 前期（turn-1）ぶんの公開市場結果（市場情報パネルの前四半期比表示用）。前期が存在しなければnull。 */
  readonly previousQuarterMarket: PlayerPreviousQuarterMarket | null;
  /** 履歴要約（診断用のhistory/[turn]は使わない。§6.6・§8.2）。最新10件まで。 */
  readonly recentHistory: readonly CompanyLabHistoryEntrySummaryDto[];
}

export type PlayerScreenLoadResult = { readonly kind: "ok"; readonly viewModel: PlayerScreenViewModel } | { readonly kind: "notFound" };

/** coerceDraftOrRebuildの戻り値。draftはUIへの表示・編集対象、diagnosticsはこのturnのAI原案の診断情報。 */
interface CoercedDraftResult {
  readonly draft: CompanyDecisionDraft;
  /**
   * 【feature/v2-persist-standard-ai-proposal（Phase A）で修正】このturnについて
   * Standard AIが提示した原案の診断情報。draftを新規生成した場合はその場で生成した
   * ものを、既存の保存済みdraftを返す場合は原則envelopeに永続化済みの値を、
   * そのまま返す（＝draftを保存・リロードしても値が変わらない）。
   */
  readonly diagnostics: StandardAiQuarterDiagnostics | null;
}

/** 提出済みでない既存draftが、現在のプレイヤー会社向けとして解釈可能な形かどうか（壊れていれば安全側で再生成する）。 */
function coerceDraftOrRebuild(
  envelope: CompanyLabDraftEnvelope | null,
  fixture: CompanyFixture,
  restoredState: CompanyLabState,
  publicInfo: PublicMarketInfo,
  turn: number
): CoercedDraftResult {
  if (envelope !== null && isPlausibleCompanyDecisionDraft(envelope.draft, fixture.companyId)) {
    if (envelope.aiProposalDiagnostics !== undefined) {
      // 【feature/v2-persist-standard-ai-proposal（Phase A）】このturnの最初の
      // saveDraft呼び出し時に永続化済みのAI原案・診断情報をそのまま返す。
      // Standard AIを再実行しない（指示§A-2「リロード時にAIを再実行して新しいAI案を
      // 作り直す方式は原則避ける」）。
      return { draft: envelope.draft, diagnostics: envelope.aiProposalDiagnostics };
    }
    // 【後方互換】この機能の導入前（feature/v2-persist-standard-ai-proposal以前）に
    // 保存された既存draftにはaiProposalDiagnosticsが存在しない。この場合のみ、
    // ベストエフォートでその場から再現する（ownState/publicInfoはturn開始時から
    // 変化しないため、通常は同一turn開始時に生成されたものと同じ値になるが、
    // STANDARD_AI_PARAMETERS_V1が版内で改訂された場合はドリフトし得る既知の限界。
    // 次回保存時にはsaveDraft側で新しいenvelopeとして永続化され直す）。
    const ownStateForLegacyDraft = buildCompanyOwnState(restoredState, fixture);
    const { diagnostics: legacyDiagnostics } = generateStandardAiDecisionWithDiagnostics(
      fixture,
      ownStateForLegacyDraft,
      publicInfo,
      restoredState.currentPeriod,
      turn
    );
    return { draft: envelope.draft, diagnostics: legacyDiagnostics };
  }
  // draftが無い（新しいturn）か、保存済みだが構造上解釈できない場合は、既存の仮UI
  // （page.tsx）と同じ手順でStandard AIの提案から初期値を組み立てる
  // （test/sai6-manual-observation-2026-08-01：手動観察テストのため、プレイヤー
  // 自身の会社についても「四半期実行前に確認できるStandard AIの提案」として
  // Standard AIの出力を初期表示する。プレイヤーはこれをそのまま提出することも、
  // 編集してから提出することもできる＝既存の「提出」操作が変更されるわけではない）。
  const ownState = buildCompanyOwnState(restoredState, fixture);
  const { decision: aiDecision, diagnostics } = generateStandardAiDecisionWithDiagnostics(
    fixture,
    ownState,
    publicInfo,
    restoredState.currentPeriod,
    turn
  );
  // 【Phase 8D-4】ワーカー人数の出発点は、fixtureの初期値ではなく会社状態として
  // 保持されている前期末の総人数。これを渡さないと、四半期をまたぐたびに人数が
  // 初期値へ戻るというテストプレイで見つかった不具合が再発する。
  return { draft: buildInitialDraft(fixture, aiDecision, ownState.workforceState), diagnostics };
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
  let aiProposalDiagnostics: StandardAiQuarterDiagnostics | null = null;
  if (isComplete) {
    phase = "completed";
    draft = null;
  } else if (draftEnvelope !== null && draftEnvelope.submittedAt !== null) {
    phase = "submitted";
    draft = isPlausibleCompanyDecisionDraft(draftEnvelope.draft, fixture.companyId) ? draftEnvelope.draft : null;
  } else {
    phase = "editing";
    const coerced = coerceDraftOrRebuild(draftEnvelope, fixture, restoredState, publicInfo, turn);
    draft = coerced.draft;
    aiProposalDiagnostics = coerced.diagnostics;
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
          consumerMarketRecords: latestEntry.record.consumerMarketRecords,
        }
      : null;

  // 【前期（turn-1）ぶんの財務・資金・設備投資を、当期・前期・増減表示のために取得する】
  // loadHistoryEntryは単一turn分のみの取得であり、全履歴を読むloadFullHistory
  // （診断用・数十MB規模）とは性質が異なるため、Repository契約上「通常の
  // Application Service層から使ってよい」対象（§9）。取得できない・存在しない
  // （初回四半期turn===1、または何らかの理由で前期データが欠落）場合はnullとし、
  // 値を捏造せず「データなし」として画面側で正常表示する。
  //
  // 【市場情報パネルの前四半期比についても同じ1回の取得を使い回す】前期の公開市場結果
  // （marketResult）は同じ履歴エントリに含まれているため、追加のRepositoryアクセスは
  // 発生させない（前期比のために履歴を二度読まない）。
  let previousQuarterFinancials: PlayerPreviousQuarterFinancials | null = null;
  let previousQuarterMarket: PlayerPreviousQuarterMarket | null = null;
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
      previousQuarterMarket = {
        turn: previousEntry.turn,
        period: String(previousEntry.period),
        marketResult: previousEntry.record.marketResult,
      };
    } catch {
      previousQuarterFinancials = null;
      previousQuarterMarket = null;
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
      aiProposalDiagnostics,
      draftSubmittedAt: draftEnvelope?.submittedAt ?? null,
      draftUpdatedAt: draftEnvelope?.updatedAt ?? null,
      lastQuarterResult,
      lastQuarterCapexEvents: lastQuarterCapexResult?.events,
      lastQuarterRejectedCapexProposals: lastQuarterCapexResult?.rejectedProposals,
      previousQuarterFinancials,
      previousQuarterMarket,
      recentHistory: historyPage.entries.map(toHistoryEntrySummaryDto),
    },
  };
}
