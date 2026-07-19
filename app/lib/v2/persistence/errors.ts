// ShrimpX V2 — 永続化状態・シリアライズ契約 エラー型（Phase 5.6）
//
// 用途別に明示的なエラー型を用意する。すべて`code`プロパティで種別を判定
// できるようにし、`instanceof`でも`error.code`でも判定できる（呼び出し側が
// Redis層等でエラー種別ごとに異なるHTTPステータス・リトライ方針を選べるように
// するため）。メッセージには可能な範囲で不正なフィールドパスを含める
// （例: `rawMaterialLots[2].remainingQuantity は originalQuantity を超えては
// なりません`）。

export type PersistenceErrorCode =
  | "PARSE_ERROR"
  | "VALIDATION_ERROR"
  | "UNSUPPORTED_VERSION"
  | "TRANSITION_ERROR";

abstract class PersistenceErrorBase extends Error {
  abstract readonly code: PersistenceErrorCode;
  constructor(message: string) {
    super(message);
  }
}

/** JSON文字列自体のparseに失敗した場合、またはtop-levelがオブジェクトでない場合。 */
export class PersistedStateParseError extends PersistenceErrorBase {
  readonly code = "PARSE_ERROR" as const;
  constructor(message: string) {
    super(message);
    this.name = "PersistedStateParseError";
  }
}

/** JSONとしては読めたが、PersistedGameStateV2として内容が不正・破損している場合。 */
export class PersistedStateValidationError extends PersistenceErrorBase {
  readonly code = "VALIDATION_ERROR" as const;
  /** 不正だったフィールドへのパス（例: "rawMaterialLots[2].remainingQuantity"）。 */
  readonly fieldPath?: string;
  constructor(message: string, fieldPath?: string) {
    super(fieldPath ? `${fieldPath}: ${message}` : message);
    this.name = "PersistedStateValidationError";
    this.fieldPath = fieldPath;
  }
}

/**
 * schemaVersionが現行実装より新しい（未対応の将来バージョン）場合。
 * 「欠落したバージョン」「不正なバージョン（非整数・0以下等）」は
 * PersistedStateValidationError（内容の不正）として扱い、本エラーとは区別する。
 */
export class UnsupportedPersistedStateVersionError extends PersistenceErrorBase {
  readonly code = "UNSUPPORTED_VERSION" as const;
  readonly encounteredVersion: number;
  readonly supportedVersion: number;
  constructor(encounteredVersion: number, supportedVersion: number) {
    super(
      `未対応のschemaVersionです（受け取ったバージョン: ${encounteredVersion}、対応済みの最新バージョン: ${supportedVersion}）。このバージョンに対応したマイグレーション実装が必要です。`
    );
    this.name = "UnsupportedPersistedStateVersionError";
    this.encounteredVersion = encounteredVersion;
    this.supportedVersion = supportedVersion;
  }
}

/**
 * ターン完了後の状態更新・TurnOrchestratorInputの再構築（hydration）時の
 * 組み合わせ誤り（period不一致・turnExecutionId再適用等）。
 */
export class PersistedStateTransitionError extends PersistenceErrorBase {
  readonly code = "TRANSITION_ERROR" as const;
  constructor(message: string) {
    super(message);
    this.name = "PersistedStateTransitionError";
  }
}
