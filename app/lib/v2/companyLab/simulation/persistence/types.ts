// ShrimpX V2 — 32Q Management Console Phase 2/9: Simulation Run の永続化モデル
//
// 【何を保存するか】
//   (1) SimulationRun メタデータ（再現に必要な条件一式）
//   (2) 確定済み実績から導いた analytics dataset（long-format の事実表）
//   (3) 【Phase 9・Save/Resume】resumePayload（optional） — 続きからプレイできる
//       ようにするための、その時点の完全な CompanyLabState 等。
//
// 【quadratic 増大を避ける、という元の設計意図は維持している】
// 会社ラボ本体（persistence/types.ts の CompanyLabRuntimeSnapshot）が
// 「history を絶対にスナップショットへ含めない」という設計で保存量の二次関数的
// 増大を防いでいるのは、**ターンごとに**スナップショットを重ねて保存する場合の
// 話である。Simulation Run の保存は「1本のRunにつき、常に最新1個の状態で
// 上書き保存する」（ターンごとに別レコードを積み増さない）ため、resumePayload
// を含めても保存量は turns に対して線形（O(turns)）のままであり、
// 二次関数的増大（O(turns²)）には該当しない。CompanyLabState は branded
// unit型を含めすべて JSON.stringify/JSON.parse を素通しできるプレーンな
// データであり（core/units.ts参照）、特別なシリアライズは不要。
//
// 【既存 turn history を利用する】
// dataset は CompanyQuarterRecord（＝会社ラボが既に持っている確定履歴）から
// 取り出した値だけで構成される。analytics 用に新しい記録を engine へ足したのは、
// Standard AI が既に計算していた診断値と、そのターンに公開されていた観測需要
// （どちらも記録に残らず消えてしまう値）に限る。

import { SimulationAnalyticsDataset } from "../analytics/types";
import { CapacitySnapshot, CompanyControlMode, PackCompanyTurnCapture, SimulationRun } from "../types";
import { PackWorldTurn } from "../aiPack/types";
import { CompanyDecisionInput, CompanyFixture, CompanyLabState } from "../../types";
import { SimulationAiTurnTrace } from "../analytics/aiTrace";
import { ObservedDemandSnapshot } from "../analytics/dataset";
import { CompanyLabRuntimeSnapshot } from "../../persistence/types";

/**
 * 保存スキーマ版。
 *
 * 【取り違え注意】以下とは別物である。
 *   - CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION（会社ラボ本体の保存スキーマ）
 *   - SCHEMA_VERSION_V2 / CURRENT_PERSISTED_GAME_STATE_VERSION（本番ゲーム）
 *
 * バージョン履歴:
 *   v1 … Phase 2A 初版。
 *   v2 … AI Analysis Pack 用の per-turn capture（packCapture）を追加。
 *        **追加的変更のみでマイグレーション不要**（会社ラボ本体と同じ方針）。
 *        v1 のデータには packCapture が無いため undefined として復元し、
 *        Pack 生成側は該当セクションを NOT_RECORDED として扱う（推測で埋めない）。
 *   v3 … 【Phase 9・Save/Resume】resumePayload を追加。同じく追加的変更のみで
 *        マイグレーション不要。v1/v2 のデータには resumePayload が無いため
 *        undefined のまま扱う（＝続きからプレイできない「閲覧専用」の Run として
 *        明示する。architectureはPart Aの§4参照）。
 */
export const CURRENT_SIMULATION_RUN_PERSISTED_VERSION = 3;

/** 保存される Simulation Run 1本ぶん。 */
export interface StoredSimulationRun {
  readonly schemaVersion: number;
  readonly run: SimulationRun;
  readonly dataset: SimulationAnalyticsDataset;
  /**
   * 【schemaVersion 2】AI Analysis Pack 用の per-turn capture。
   * 確定履歴に残らない導出値（期首・期末状態、工場スペース、投資案件、
   * TRUE/OBSERVABLE を分けた世界記録）だけを持つ。
   * v1 の保存データには存在しないため optional。
   */
  readonly packCapture?: SimulationPackCapture;
  /**
   * 【schemaVersion 3・Phase 9】続きからプレイするために必要な完全な状態。
   * 存在しない場合（v1/v2の保存データ、またはSetup画面を経由しない古い呼び出し元）は
   * 「閲覧専用（VIEW_ONLY）」として扱う。Q1からの再構築や、別Runの暗黙生成はしない。
   */
  readonly resumePayload?: SimulationResumePayload;
  /** metadata（ゲーム判断には使わない）。 */
  readonly savedAt: string;
}

/** 実行中に拾った、Pack 用の追加記録。 */
export interface SimulationPackCapture {
  readonly companyTurns: readonly PackCompanyTurnCapture[];
  readonly worldTurns: readonly PackWorldTurn[];
}

/**
 * 【Phase 9・Save/Resume】保存済みRunから「続きからプレイする」ために
 * 必要な完全な状態。SimulationSessionのうち、run（メタデータ、別途保存済み）と
 * config（run.scenarioId/seed/requestedTurnsから再構築できる）、
 * packCompanyTurns/packWorldTurns（packCaptureとして既に別途保存済み、
 * 同じ型でそのまま流用する）を除いた残り全部。
 *
 * CompanyLabStateは会社ラボが確定させた実際の状態そのもの（history込み）であり、
 * 別の計算ロジック・別の状態表現を新設していない。branded unit型はただの
 * numberなのでJSON往復で失われる情報は無い（core/units.ts参照）。
 */
export interface SimulationResumePayload {
  readonly state: CompanyLabState;
  readonly fixtures: readonly CompanyFixture[];
  /** 【Phase 7・Manual Override】保存時点で有効だった会社別経営モード。 */
  readonly companyControlModes: Readonly<Record<string, CompanyControlMode>>;
  /**
   * 【Phase 7・Manual Override】保存時点で確定済みだった、まだエンジンへ渡していない
   * PLAYER意思決定（＝WAITING_FOR_PLAYERの状態そのものを再現するために必要）。
   * 未確定の下書き（draft）はここに含めない（指示§8: 今回は必須ではない）。
   */
  readonly confirmedPlayerDecisions: Readonly<Record<string, CompanyDecisionInput>>;
  readonly aiTurnTraces: readonly SimulationAiTurnTrace[];
  readonly observedDemand: readonly ObservedDemandSnapshot[];
  readonly salesHeadcountByTurn: readonly { readonly turn: number; readonly companyId: string; readonly headcount: number }[];
  readonly capacityByTurn: readonly CapacitySnapshot[];
  /**
   * 【Phase 9・PLAYER Databook】SimulationSession.latestQuarterPreProcessingSnapshot
   * をそのまま保存する（PLAYER Company Databookの期首欄用）。v3で新設したフィールドの
   * ため、v3より前の保存物を読んだ場合はこのフィールド自体が存在しない
   * （そのRunのDatabookは期首欄なしで組み立てるか、後方互換の扱いをする）。
   */
  readonly latestQuarterPreProcessingSnapshot: CompanyLabRuntimeSnapshot | null;
}

/**
 * 一覧表示用の要約。
 * Run selector は dataset 本体を読まずにこれだけで描ける
 * （32Q ぶんの事実表を一覧のたびに全件読まないため）。
 */
export interface SimulationRunSummary {
  readonly simulationRunId: string;
  readonly scenarioId: string;
  readonly seed: string;
  readonly requestedTurns: number;
  readonly completedTurns: number;
  readonly stopReason: SimulationRun["stopReason"];
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly savedAt: string;
  readonly gameParameterVersion: string;
  readonly standardAiVersion: string;
  /** 【Phase 8・Game Setup】Setup画面で任意入力されたRun名。未入力ならundefined。 */
  readonly runName?: string;
  /**
   * 【Phase 8・Run History】保存時点でPLAYERとして操作されていた会社。
   * この項目を持たない旧形式のsummary（localStorageキャッシュ等）との後方互換のためoptional。
   * 未設定は「記録なし」であり、必ずしも「PLAYER無し」を意味しない
   * （読み手は `?? []` で扱い、空配列と未設定を区別する必要が無い表示にする）。
   */
  readonly playerCompanyIds?: readonly string[];
  /**
   * 【Phase 9・Save/Resume】このRunに resumePayload があるか（＝続きからプレイできるか）。
   * この項目を持たない旧形式のsummaryはfalse相当（VIEW_ONLY）として扱ってよい
   * （旧schemaのRunにresumePayloadが存在しないのは事実であり、捏造ではない）。
   */
  readonly hasResumePayload?: boolean;
}

export function toSimulationRunSummary(stored: StoredSimulationRun): SimulationRunSummary {
  return {
    simulationRunId: stored.run.simulationRunId,
    scenarioId: stored.run.scenarioId,
    seed: stored.run.seed,
    requestedTurns: stored.run.requestedTurns,
    completedTurns: stored.run.completedTurns,
    stopReason: stored.run.stopReason,
    startedAt: stored.run.startedAt,
    completedAt: stored.run.completedAt,
    savedAt: stored.savedAt,
    gameParameterVersion: stored.run.gameParameterVersion,
    standardAiVersion: stored.run.standardAiVersion,
    runName: stored.run.runName,
    playerCompanyIds: Object.entries(stored.run.companyControlModes ?? {})
      .filter(([, mode]) => mode === "PLAYER")
      .map(([companyId]) => companyId),
    hasResumePayload: stored.resumePayload !== undefined,
  };
}

/**
 * 保存済みデータの受け入れ判定。
 * **現行より新しい版だけを拒否する**（会社ラボ本体の
 * validateCompanyLabPersistedState と同じ方針。追加的変更は読み込めるようにする）。
 */
export function isReadableSimulationRunSchema(schemaVersion: unknown): boolean {
  return typeof schemaVersion === "number" && Number.isInteger(schemaVersion) && schemaVersion >= 1 && schemaVersion <= CURRENT_SIMULATION_RUN_PERSISTED_VERSION;
}
