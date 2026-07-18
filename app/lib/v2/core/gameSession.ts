// ShrimpX V2 — GameSession 最小骨格（Phase 0B）
//
// 業務モジュール（市場価格・営業・輸入・養殖・投資・財務等）を先取りせず、
// Phase 0時点で確定しているフィールドだけを型として定義する。
// industryState / companyState は any を使わず、「まだ何も定義されていない」
// ことを明示するPhase0プレースホルダ型として表現し、将来の拡張境界とする。

import { SCHEMA_VERSION_V2, ENGINE_VERSION_V2, BALANCE_VERSION_V2 } from "./version";
import { PeriodV2 } from "./period";
import { TurnPhase, initialTurnState } from "./turnPhase";
import { ScheduledEffectQueue, emptyScheduledEffectQueue } from "./scheduledEffects";

export class GameSessionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GameSessionValidationError";
  }
}

// ---------------------------------------------------------------------
// Phase 0 プレースホルダ型: IndustryState / CompanyState の拡張境界。
// 具体的な業務フィールド（市場信頼度・品質状態・生産方針・契約等）は
// 後続Phaseでこれらの型を置き換える形で追加する。any は使用しない。
// ---------------------------------------------------------------------

/** 業界全体状態の未実装プレースホルダ（Phase 0時点では中身を持たない）。 */
export interface IndustryStatePhase0 {
  readonly _phase0Placeholder: true;
}

export function createIndustryStatePhase0(): IndustryStatePhase0 {
  return { _phase0Placeholder: true };
}

/** 1社分の企業状態の未実装プレースホルダ（Phase 0時点では識別子のみ保持）。 */
export interface CompanyStatePhase0 {
  readonly companyId: string;
  readonly _phase0Placeholder: true;
}

export function createCompanyStatePhase0(companyId: string): CompanyStatePhase0 {
  return { companyId, _phase0Placeholder: true };
}

/**
 * ScheduledEffectのペイロード境界。将来、営業/輸入/養殖/投資等の具象ペイロード型の
 * 判別可能なunion（kindで判別）に置き換える。Phase 0では具体的なkindは定義しない。
 */
export interface UnimplementedEffectPayload {
  readonly kind: string;
  readonly [key: string]: unknown;
}

// ---------------------------------------------------------------------
// GameSessionV2 本体
// ---------------------------------------------------------------------

export interface GameSessionV2 {
  readonly schemaVersion: typeof SCHEMA_VERSION_V2;
  readonly engineVersion: string;
  readonly balanceVersion: string;
  readonly gameCode: string;
  readonly currentPeriod: PeriodV2;
  readonly currentTurnPhase: TurnPhase;
  readonly randomSeed: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** 参加企業/プレイヤーのID一覧。 */
  readonly companyIds: readonly string[];
  /** 遅延効果キュー（営業/輸入/養殖/投資等が将来登録する）。 */
  readonly scheduledEffects: ScheduledEffectQueue<UnimplementedEffectPayload>;
  /** 現在のcurrentPeriod内で処理済みのTurnPhase一覧（二重実行検知の補助記録）。 */
  readonly processedPhasesThisPeriod: readonly TurnPhase[];
  /** 業界全体状態。Phase 0では未実装プレースホルダ。 */
  readonly industryState: IndustryStatePhase0;
  /** 企業ID毎の状態。Phase 0では未実装プレースホルダ。 */
  readonly companyStates: Readonly<Record<string, CompanyStatePhase0>>;
}

function assertNonEmptyString(v: unknown, label: string): asserts v is string {
  if (typeof v !== "string" || v.length === 0) {
    throw new GameSessionValidationError(`${label} は空でない文字列である必要があります。受け取った値: ${JSON.stringify(v)}`);
  }
}

/**
 * V2 GameSessionの初期状態を作る純粋関数。
 * createdAt/updatedAtは呼び出し側から渡す（Date.now()等への暗黙依存を避け、
 * テストで固定タイムスタンプを注入できるようにするため）。
 */
export function createInitialGameSessionV2(params: {
  gameCode: string;
  initialPeriod: PeriodV2;
  randomSeed: string;
  companyIds: readonly string[];
  now: string;
}): GameSessionV2 {
  assertNonEmptyString(params.gameCode, "gameCode");
  assertNonEmptyString(params.randomSeed, "randomSeed");
  assertNonEmptyString(params.now, "now");
  if (params.companyIds.length === 0) {
    throw new GameSessionValidationError("companyIds は1件以上必要です。");
  }

  const turnState = initialTurnState(params.initialPeriod);
  const companyStates: Record<string, CompanyStatePhase0> = {};
  for (const id of params.companyIds) {
    companyStates[id] = createCompanyStatePhase0(id);
  }

  return {
    schemaVersion: SCHEMA_VERSION_V2,
    engineVersion: ENGINE_VERSION_V2,
    balanceVersion: BALANCE_VERSION_V2,
    gameCode: params.gameCode,
    currentPeriod: turnState.period,
    currentTurnPhase: turnState.phase,
    randomSeed: params.randomSeed,
    createdAt: params.now,
    updatedAt: params.now,
    companyIds: [...params.companyIds],
    scheduledEffects: emptyScheduledEffectQueue<UnimplementedEffectPayload>(),
    processedPhasesThisPeriod: [],
    industryState: createIndustryStatePhase0(),
    companyStates,
  };
}
