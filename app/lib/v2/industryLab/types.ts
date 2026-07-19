// ShrimpX V2 — 業界シミュレーション・テスト環境（Phase 3） 共通型
//
// シナリオモジュール（Phase2）と市場モジュール（Phase1）を接続する
// シミュレーションランナーの入出力型。既存のScenarioTurnInput・
// MarketQuarterInput・MarketQuarterResult・InformationReleaseをそのまま
// 再利用し、重複する型は定義しない（実装指示 §4）。

import { CountryId, DemandMarketId, MarketQuarterInput, MarketQuarterResult } from "../market/types";
import {
  ScenarioDefinition,
  ScenarioMode,
  ScenarioState,
  ScenarioTurnInput,
  ScenarioEventType,
  ScenarioEffect,
  InformationRelease,
  InformationLevel,
} from "../scenario/types";
import { IndustryLabAssumptions } from "./assumptions";

export class IndustrySimulationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndustrySimulationError";
  }
}

export interface IndustrySimulationConfig {
  readonly scenarioId: string;
  readonly mode: ScenarioMode;
  readonly seed: string;
  /** 実行するターン数（1〜シナリオのdurationTurns）。 */
  readonly turns: number;
  readonly assumptions?: IndustryLabAssumptions;
}

/** イベントの現在の発現段階（実装指示 §7の発現曲線に対応するUI向け分類）。 */
export type ScenarioEventPhase = "beforeStart" | "rampUp" | "active" | "recovering" | "ended";

/** ある四半期における1イベントの状態（GM向け内部説明を含む。実装指示 §7）。 */
export interface ActiveScenarioEvent {
  readonly eventId: string;
  readonly eventType: ScenarioEventType;
  readonly targetCountries: readonly CountryId[];
  readonly targetMarkets: readonly DemandMarketId[];
  /** モードに応じて解決された（Variationならジッター適用後の）開始ターン。 */
  readonly resolvedStartTurn: number;
  readonly phase: ScenarioEventPhase;
  /** 0〜1。0=無効、1=満額。 */
  readonly intensity: number;
  readonly effects: readonly ScenarioEffect[];
  readonly hiddenDescription: string;
}

/** 情報公開レベルのうち、本テスト環境が画面で切り替え可能にする4段階（postGameは対象外）。 */
export type DisplayInformationLevel = Exclude<InformationLevel, "postGame">;

export interface IndustryQuarterRecord {
  readonly turn: number;
  readonly periodLabel: string;

  readonly scenarioTurnInput: ScenarioTurnInput;
  readonly marketInput: MarketQuarterInput;
  readonly marketResult: MarketQuarterResult;

  readonly activeEvents: readonly ActiveScenarioEvent[];
  readonly publicInformation: readonly InformationRelease[];
  readonly standardInformation: readonly InformationRelease[];
  readonly advancedInformation: readonly InformationRelease[];
  readonly gmInformation: readonly InformationRelease[];
}

export interface IndustrySimulationState {
  readonly config: IndustrySimulationConfig;
  readonly scenarioDefinition: ScenarioDefinition;
  readonly scenarioState: ScenarioState;
  readonly quarters: readonly IndustryQuarterRecord[];
  /** config.turns 分の四半期を生成し終えたか（あるいはシナリオ自体の最終ターンに到達したか）。 */
  readonly isComplete: boolean;
}

export interface IndustrySimulationResult {
  readonly config: IndustrySimulationConfig;
  readonly quarters: readonly IndustryQuarterRecord[];
}
