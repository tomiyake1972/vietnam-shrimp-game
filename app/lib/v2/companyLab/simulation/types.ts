// ShrimpX V2 — 32Q Management Console: Simulation Run の型（Phase 1）
//
// 【このモジュールの位置づけ】
// Game Owner が 32Q（8年）を手動で高速に回すための実行単位を表す。
// **ゲームの計算そのものは一切ここに無い。** 通常ゲームと同じ
// initializeCompanyLab / buildCompanyOwnState / generateStandardAiDecisionWithDiagnostics /
// advanceCompanyLabQuarter を呼ぶだけで、fast-run 専用の簡易ロジックは作らない。

import { CompanyLabConfig, CompanyLabState, CompanyFixture } from "../types";
import type { PackCommercialGrowth, PackSalesOrganization } from "./aiPack/types";
import type { SimulationAiTurnTrace } from "./analytics/aiTrace";
import type { ObservedDemandSnapshot } from "./analytics/dataset";
import type { PackCapitalProject, PackCompanyStateSnapshot, PackStrategy, PackWorldTurn } from "./aiPack/types";
import type { CompanyLabRuntimeSnapshot } from "../persistence/types";
import type { SimulationAnalyticsDataset } from "./analytics/types";
import type { CompanyEvaluationSnapshot } from "../evaluation/evaluationSemantics";
import type { EvaluationHistoryRecord } from "../evaluation/evaluationHistory";

/** 標準の32Q（8年）。Management Console の既定実行長。 */
export const MANAGEMENT_CONSOLE_STANDARD_TURNS = 32;

/**
 * 実行が終わった理由。
 * 「途中で止めた」と「最後まで走った」と「失敗した」を混同しないために必ず記録する。
 */
export type SimulationStopReason =
  /** 要求ターン数を最後まで処理した。 */
  | "completed"
  /** Game Owner が STOP を押した（完了済みターンは保存済み）。 */
  | "stopped_by_user"
  /** ターン処理が例外で失敗した（失敗したターンは完了扱いにしない）。 */
  | "error"
  /** シナリオ側の上限（durationTurns）に到達した。 */
  | "scenario_end"
  /**
   * 【Phase 7・Manual Override】PLAYER会社の当該ターン意思決定が未確定のため停止した。
   * ERROR扱いにはしない（Player decision確定後にresume可能）。
   */
  | "waiting_for_player"
  /** まだ実行中。 */
  | "running";

/**
 * 【Phase 7・Manual Override】会社ごとの経営モード。
 * STANDARD_AI = 従来どおり Standard AI が意思決定する。
 * PLAYER = ユーザーが既存の通常プレイ意思決定画面（DecisionEditor）で操作する。
 */
export type CompanyControlMode = "STANDARD_AI" | "PLAYER";

/** 由来（誰の意思決定が実際にエンジンへ渡されたか）。AI Analysis Pack の識別用。 */
export type DecisionOwner = "STANDARD_AI" | "PLAYER";

/**
 * 32Qテストを再現するためのメタデータ。
 *
 * 【再現性】simulationRunId 以外のすべてが同じなら、同じ結果になる
 * （engine.ts が Date.now()・Math.random() をゲーム判断へ混ぜないため）。
 * startedAt / completedAt は metadata であり、判断には使わない。
 */
export interface SimulationRun {
  readonly simulationRunId: string;
  readonly scenarioId: string;
  readonly scenarioVersion: string;
  readonly seed: string;
  readonly gameParameterVersion: string;
  readonly standardAiVersion: string;
  readonly strategyProfileVersion: string;
  /** 実行開始時点のターン番号（新規作成なら1）。 */
  readonly startingTurn: number;
  /** 要求されたターン数（1 / 4 / 32 等）。 */
  readonly requestedTurns: number;
  /** 実際に処理を完了したターン数。失敗したターンは含めない。 */
  readonly completedTurns: number;
  /** metadata（判断には使わない）。 */
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly stopReason: SimulationStopReason;
  /** stopReason==="error" のときの原因。 */
  readonly errorMessage: string | null;
  /** 失敗したターン番号（成功扱いにしない）。 */
  readonly failedAtTurn: number | null;
  /**
   * 【Phase 7・Manual Override】この run で現在有効な会社別経営モード（記録用）。
   * 未設定（旧run・schema）は全社 STANDARD_AI 相当として扱う（捏造しない＝存在しないなら省略）。
   */
  readonly companyControlModes?: Readonly<Record<string, CompanyControlMode>>;
  /** 【Phase 8・Game Setup】Setup画面で任意入力できるRun名・メモ。未入力ならundefined。 */
  readonly runName?: string;
  /**
   * 【Game End / Final Results・END-1】Game Masterが任意Turnでゲームを終了した日時
   * （metadata。判断には使わない）。未設定＝ゲームはまだ進行中（ACTIVE）。
   * 設定済み＝ゲームは終了済み（FINISHED）で、以後Turn進行・Decision変更は拒否する
   * （既存のstopReason/completedAtとは別概念。あちらは「要求ターン数を使い切った」を表し、
   * こちらは「任意Turnで公式に終了を確定した」を表す）。
   */
  readonly gameEndedAt?: string | null;
  /** ゲームを終了した時点のTurn番号（Final Resultsの基準Turn）。gameEndedAtとセットで設定する。 */
  readonly gameEndTurn?: number | null;
  /**
   * 【指示§4】ゲーム終了時点で確定した公式Final Snapshot。既存のevaluation service
   * （computeAllCompaniesEvaluationSnapshot、唯一のsource of truth）が返す結果を
   * そのまま保存するだけで、UI側で新しい計算式は持たない。Final Results表示は
   * 将来のmodel/DCF/WACC変更が既に終了したゲームの公式結果を遡及して変えないよう、
   * 可能な限りこの保存済みsnapshotを優先して使う。
   */
  readonly finalEvaluationSnapshot?: readonly CompanyEvaluationSnapshot[] | null;
}

/** 実行中のセッション（状態 + fixtures + run メタデータ）。 */
export interface SimulationSession {
  readonly run: SimulationRun;
  readonly state: CompanyLabState;
  readonly fixtures: readonly CompanyFixture[];
  readonly config: CompanyLabConfig;
  /**
   * 【Phase 2】各ターンで Standard AI が実際に持っていた値（6段階トレース用）。
   * Standard AI が意思決定の過程で**既に計算している**値を抜き出して保持するだけであり、
   * 新しい logging system・追加の推論は存在しない。診断オブジェクト全体ではなく
   * 表示に使う項目だけを持つ（32Q×5社で保存量が膨らまないようにするため）。
   */
  readonly aiTurnTraces: readonly SimulationAiTurnTrace[];
  /**
   * 【Phase 2】各ターンで実際に公開されていた観測需要（2四半期遅行）。
   * TRUE WORLD（salesRecord.allocations の targetDemand）と混同しないよう、
   * 別系列として記録する。
   */
  readonly observedDemand: readonly ObservedDemandSnapshot[];
  /**
   * 【Phase 2】各ターンで**配分可能だった**会社別営業人員数（当期処理前の値）。
   * salesForceHiringState は「現在値」しか持たず四半期記録にも残らないため、
   * ターンごとの値はここで拾わないと後から復元できない（会社数ぶんのスカラーのみ）。
   * 採用・減員は次の四半期から反映されるため、当期の市場別配置と突き合わせるには
   * 当期処理前の値でなければならない。
   */
  readonly salesHeadcountByTurn: readonly { readonly turn: number; readonly companyId: string; readonly headcount: number }[];
  /**
   * 【Phase 2】各ターン終了時点の会社別実効能力。
   * 能力は fixtures と capexState から導出される値であり四半期記録に残らないため、
   * 保存済み Simulation Run から画面を復元するにはターンごとに拾っておく必要がある。
   * 計算は既存の唯一の情報源（computeEffectiveFactories / calculateFactoryEffectiveCapacity）
   * をそのまま通す（analytics 用の独自計算を作らない）。
   */
  readonly capacityByTurn: readonly CapacitySnapshot[];
  /**
   * 【AI Analysis Pack】各ターンの期首・期末の会社状態と、期末の設備投資案件。
   * 導出値（実効能力・工場スペース・借入残高等）は確定履歴に残らないため、
   * 実行中に拾わないと後から復元できない。会社数×ターン数ぶんの小さな
   * スカラー集合であり、CompanyLabState を丸ごと複製するものではない。
   */
  readonly packCompanyTurns: readonly PackCompanyTurnCapture[];
  /** 【AI Analysis Pack】TRUE WORLD と OBSERVABLE を分けた世界のターン記録。 */
  readonly packWorldTurns: readonly PackWorldTurn[];
  /**
   * 【Phase 9・PLAYER Databook】直近に確定したターンの「処理直前」のランタイム状態。
   * 通常ゲームの CompanyLabQuarterHistoryEntry.preProcessingStateSnapshot と同じ形。
   * Databook出力の期首欄（契約・原料ロット・完成品在庫の期首残高）はここから作る
   * （期末側は現在の session.state から createCompanyLabRuntimeSnapshot で作れるが、
   * 期首側は「1つ前のターンの終わり」の状態であり、session.state だけからは
   * 復元できないため、直近1ターンぶんだけ別途保持する。履歴を積み増すものではない
   * ＝quadratic増大にはならない）。まだ1ターンも処理していないRunはnull。
   */
  readonly latestQuarterPreProcessingSnapshot: CompanyLabRuntimeSnapshot | null;
  /**
   * 【Save/Resume 長期永続化・鮮度整合】resumePayload保存量を抑えるため、
   * resumePayload.state.history は直近の rolling window だけへ間引いて保存する
   * （resume.ts の buildResumePayload / ROLLING_RESUME_HISTORY_WINDOW参照）。
   * そのままではreload後、buildDatasetFromSessionがwindow分の履歴からしか
   * datasetを再計算できず、reload以前のturnぶんのAnalysis事実が失われてしまう
   * （resume snapshotの軽量化とAnalysis履歴の欠落防止は別問題であり混同しない）。
   * このフィールドは「resume時点で既に保存されていた完全なdataset」を保持し、
   * buildDatasetFromSessionが以後の新しいターンぶんとマージする土台として使う
   * （dataset.ts の mergeAnalyticsDatasets参照）。新規Runでは未設定。
   */
  readonly priorAnalyticsDataset?: SimulationAnalyticsDataset;
  /**
   * 【Final Results履歴修正】Turn1からGame End Turnまでの、評価（TSV / 配当）専用の
   * 軽量履歴。priorAnalyticsDatasetとまったく同じ理由で存在する。
   *
   * resumePayload.state.history は ROLLING_RESUME_HISTORY_WINDOW(=4) Turnへ間引かれる
   * ため、reload後はそのままではTurn1〜28の評価ができず、さらにTurn32のTSVも
   * 「直近4Turnぶんの配当しか含まないDividend Value」で計算されてしまう。
   * このフィールドは間引かれず全Turnぶん保持され、Final Resultsの
   * TSV推移・配当推移の唯一の入力になる（評価式自体は
   * evaluation/evaluationSemantics.ts が引き続きSSoT）。
   *
   * 本機能より前に保存された既存Runには存在しないためoptional。
   * その場合は従来どおり state.history へフォールバックする（挙動不変）。
   */
  readonly evaluationHistory?: readonly EvaluationHistoryRecord[];
}

/** 1ターン・1社ぶんの期首／期末スナップショットと期末の投資案件。 */
export interface PackCompanyTurnCapture {
  readonly turn: number;
  readonly companyId: string;
  readonly beginningState: PackCompanyStateSnapshot;
  readonly endingState: PackCompanyStateSnapshot;
  readonly capitalProjects: readonly PackCapitalProject[];
  /** 【2026-08-09新設】その四半期の Vision・戦略ギャップ・新工場判断。 */
  readonly strategy: PackStrategy;
  /** 【Phase 6C】Vision → Ambition → Commitment → Contracts → Production の因果。 */
  readonly commercialGrowth: PackCommercialGrowth;
  /** 【Phase 6C】営業組織の状態（人が足りないのか、増やしたくないのか）。 */
  readonly salesOrganization: PackSalesOrganization;
  /** 【Phase 7・Manual Override】この四半期・この会社の意思決定が実際に誰由来だったか。 */
  readonly decisionOwner: DecisionOwner;
}

/** 1ターン・1社ぶんの実効能力（HOSO換算トン/四半期）。 */
export interface CapacitySnapshot {
  readonly turn: number;
  readonly companyId: string;
  readonly hoso: number;
  readonly pd: number;
  readonly vap: number;
  readonly commonProcessing: number;
}

/** 1ターン進めた結果。 */
export interface SimulationTurnOutcome {
  readonly session: SimulationSession;
  /** このターンが実際に処理されたか（false ならシナリオ終端や失敗）。 */
  readonly advanced: boolean;
  readonly error: Error | null;
}
