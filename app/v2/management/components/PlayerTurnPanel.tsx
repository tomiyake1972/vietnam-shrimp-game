"use client";

// ShrimpX V2 — 32Q Management Console: Manual Override（Phase 7）
// PLAYER会社の当該ターン意思決定パネル。
//
// 【別の意思決定エンジンを作らない】ここで使っているのは通常プレイと**まったく同じ**
// DecisionEditor コンポーネント・buildInitialDraft・buildDecisionInputFromDraft である。
// 通常プレイ（app/v2/company-lab/play/[labId]）はサーバー保存された Lab（Redis）を経由するが、
// Management Console の Simulation Run はブラウザ内メモリの CompanyLabState だけを持つ
// （Phase 2以降の設計どおり、途中状態は永続化しない）ため、ここでは同じコンポーネントを
// その場の session.state から直接組み立てて埋め込む。エンジンへ渡す最終的な
// CompanyDecisionInput は、通常プレイと同じ buildDecisionInputFromDraft 一箇所だけで作る。

import { useMemo, useState } from "react";
import DecisionEditor from "../../company-lab/components/DecisionEditor";
import { buildDecisionInputFromDraft, buildInitialDraft, CompanyDecisionDraft } from "../../company-lab/decisionDraft";
import { extractCompanyCapexResult, extractCompanyFinancialResult } from "../../company-lab/play/_lib/financialViewSelectors";
import { buildCompanyOwnState, buildPublicMarketInfo } from "../../../lib/v2/companyLab/runner";
import { generateStandardAiDecision } from "../../../lib/v2/companyLab/standardAi/policy";
import { CompanyDecisionInput } from "../../../lib/v2/companyLab/types";
import { SimulationSession } from "../../../lib/v2/companyLab/simulation/types";

interface Props {
  readonly session: SimulationSession;
  readonly companyId: string;
  /** 既に確定済みの下書き（一度確定したあと、再度開いて確認・修正する場合）。 */
  readonly initialDraft?: CompanyDecisionDraft;
  readonly onConfirm: (companyId: string, decision: CompanyDecisionInput, draft: CompanyDecisionDraft) => void;
  readonly onClose: () => void;
}

/**
 * PLAYER会社1社ぶんの当期意思決定パネル。
 * 通常プレイの PlayerScreenClient と同じ構成（DecisionEditor＋確定ボタン）を、
 * Management Console のその場のセッションから直接組み立てる。
 */
export function PlayerTurnPanel({ session, companyId, initialDraft, onConfirm, onClose }: Props) {
  const fixture = session.fixtures.find((f) => f.companyId === companyId);
  const turn = session.state.scenarioState.currentTurn;

  const { ownState, aiDecision, publicInfo } = useMemo(() => {
    if (!fixture) return { ownState: null, aiDecision: null, publicInfo: null };
    const publicInfo = buildPublicMarketInfo(session.state);
    const ownState = buildCompanyOwnState(session.state, fixture);
    const aiDecision = generateStandardAiDecision(fixture, ownState, publicInfo, session.state.currentPeriod, turn);
    return { ownState, aiDecision, publicInfo };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.state, fixture?.companyId]);

  const [draft, setDraft] = useState<CompanyDecisionDraft | null>(
    initialDraft ?? (fixture && ownState && aiDecision ? buildInitialDraft(fixture, aiDecision, ownState.workforceState, ownState.effectiveFactories) : null)
  );

  if (!fixture || !ownState || !aiDecision || !draft || !publicInfo) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3">
        <div className="w-full max-w-md rounded-lg border border-slate-700 bg-slate-900 p-4 text-sm text-slate-300">
          会社が見つかりません。
          <button type="button" onClick={onClose} className="mt-3 block rounded border border-slate-600 px-3 py-1.5 text-sm hover:bg-slate-800">
            閉じる
          </button>
        </div>
      </div>
    );
  }

  const lastRecord = session.state.history[session.state.history.length - 1] ?? null;
  const lastQuarterCapexResult = lastRecord ? extractCompanyCapexResult(lastRecord, companyId) : null;
  const lastQuarterFinancialResult = lastRecord ? extractCompanyFinancialResult(lastRecord, companyId) : null;

  const handleConfirm = () => {
    const decision = buildDecisionInputFromDraft(draft, fixture, session.state.currentPeriod);
    onConfirm(companyId, decision, draft);
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/70 p-2 sm:p-4" data-testid="player-turn-panel">
      <div className="mx-auto max-w-5xl rounded-lg border border-slate-700 bg-slate-950 p-3 sm:p-4">
        {/* 【§34】別Runを操作していないことが分かるように、常に会社・ターン・シナリオ・Run IDを出す。 */}
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-sky-800 bg-sky-950/40 px-3 py-2">
          <div className="text-sm">
            <p className="font-semibold text-sky-200" data-testid="player-turn-panel-heading">
              {fixture.displayName}（{companyId}）の意思決定 — Turn {turn}
            </p>
            <p className="mt-0.5 text-[11px] text-slate-400">
              Scenario: {session.run.scenarioId} / Seed: {session.run.seed} / Run ID: {session.run.simulationRunId}
            </p>
          </div>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={onClose}
              data-testid="player-turn-panel-close"
              className="rounded border border-slate-600 px-3 py-1.5 text-xs hover:bg-slate-800"
            >
              閉じてConsoleへ戻る
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              data-testid="player-turn-panel-confirm"
              className="rounded bg-emerald-700 px-3 py-1.5 text-xs font-semibold hover:bg-emerald-600"
            >
              この内容で意思決定を確定してConsoleへ戻る
            </button>
          </div>
        </div>

        <DecisionEditor
          fixture={fixture}
          ownState={ownState}
          draft={draft}
          onChange={setDraft}
          disabled={false}
          period={session.state.currentPeriod}
          lastQuarterCapexEvents={lastQuarterCapexResult?.events}
          lastQuarterRejectedCapexProposals={lastQuarterCapexResult?.rejectedProposals}
          lastQuarterFinancialResult={lastQuarterFinancialResult}
        />

        <div className="mt-3 flex justify-end gap-1.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-slate-600 px-3 py-1.5 text-sm hover:bg-slate-800"
          >
            閉じてConsoleへ戻る
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            data-testid="player-turn-panel-confirm-bottom"
            className="rounded bg-emerald-700 px-4 py-1.5 text-sm font-semibold hover:bg-emerald-600"
          >
            この内容で意思決定を確定してConsoleへ戻る
          </button>
        </div>
      </div>
    </div>
  );
}
