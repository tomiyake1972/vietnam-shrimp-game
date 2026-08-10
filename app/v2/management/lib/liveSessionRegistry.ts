// ShrimpX V2 — 32Q Management Console: ライブSessionレジストリ（Phase 8・Run Context Preservation）
//
// 【解決する問題】
// Management Console（/v2/management）と Analysis（/v2/management/analysis/...）・
// PLAYER Workspace（/v2/management/player）は別々のNext.js routeであり、
// それぞれ別のReactコンポーネントツリーとしてマウント・アンマウントされる。
// これまでSimulationSession（＝実際に進行中のCompanyLabState）は各画面の
// useStateだけに閉じ込められていたため、Analysisへ移動して戻ってくると
// 「進行中のセッション」を失い、保存済みdataset（読み取り専用の実績表）
// しか復元できず、続けてTurnボタンを押すと新しいRunが作られてしまっていた。
//
// 【この対処の範囲】
// これはNext.js App Routerの**クライアントサイド遷移**（同じタブ内でのLink
// ナビゲーション・ブラウザBack/Forward）の間だけ有効な、単純なモジュール
// シングルトンである。React state外に置くことで、別routeのコンポーネント
// ツリーがマウントし直されても値は消えない（同じJSモジュールインスタンスを
// 参照するため）。
//
// ハードリロード・新しいタブでは、通常のJSモジュール同様に消える
// （Phase 2以降の既存方針＝CompanyLabStateそのものは永続化しない、を維持）。
// その場合は保存済みdataset（読み取り専用）へフォールバックする。

import { SimulationSession, CompanyControlMode } from "../../../lib/v2/companyLab/simulation/types";
import { CompanyDecisionInput } from "../../../lib/v2/companyLab/types";
import { CompanyDecisionDraft } from "../../company-lab/decisionDraft";

export interface LiveSessionEntry {
  readonly session: SimulationSession;
  readonly companyControlModes: Readonly<Record<string, CompanyControlMode>>;
  /** そのターンぶんだけ持つ確定済みPLAYER意思決定（Turn処理後にクリアされる）。 */
  readonly confirmedPlayerDecisions: Readonly<Record<string, CompanyDecisionInput>>;
  readonly confirmedPlayerDrafts: Readonly<Record<string, CompanyDecisionDraft>>;
  /** PLAYER Workspaceで編集中の未確定下書き（会社ごと）。タブ移動・別route間の往復でも保持する。 */
  readonly pendingDrafts: Readonly<Record<string, CompanyDecisionDraft>>;
  readonly selectedCompanyId: string;
}

const registry = new Map<string, LiveSessionEntry>();
const EMPTY: Readonly<Record<string, never>> = {};

export function getLiveSession(simulationRunId: string): LiveSessionEntry | null {
  return registry.get(simulationRunId) ?? null;
}

/**
 * sessionを含む差分をマージして書き込む（Console・PLAYER Workspaceのどちらから
 * 呼ばれても、互いが持つ他方のフィールド（例: Workspaceの pendingDrafts）を
 * 上書きしない）。エントリが無ければ新規作成する。
 */
export function upsertLiveSession(simulationRunId: string, patch: Partial<LiveSessionEntry> & { readonly session: SimulationSession }): void {
  const current = registry.get(simulationRunId);
  registry.set(simulationRunId, {
    session: patch.session,
    companyControlModes: patch.companyControlModes ?? current?.companyControlModes ?? EMPTY,
    confirmedPlayerDecisions: patch.confirmedPlayerDecisions ?? current?.confirmedPlayerDecisions ?? EMPTY,
    confirmedPlayerDrafts: patch.confirmedPlayerDrafts ?? current?.confirmedPlayerDrafts ?? EMPTY,
    pendingDrafts: patch.pendingDrafts ?? current?.pendingDrafts ?? EMPTY,
    selectedCompanyId: patch.selectedCompanyId ?? current?.selectedCompanyId ?? "BAL",
  });
}

/** テスト・New Run開始時にレジストリ全体をクリアする（既存の保存済みRun自体には影響しない）。 */
export function clearLiveSessionRegistry(): void {
  registry.clear();
}
