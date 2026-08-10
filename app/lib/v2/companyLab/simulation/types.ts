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
