// ShrimpX V2 — 会社ラボ専用永続化モデル エラー型（Phase 8C-1）
//
// app/lib/v2/persistence/errors.ts・app/lib/v2/redis/errors.tsと同じ設計方針
// （用途別の明示的なエラー型、`code`プロパティで判定可能）を踏襲するが、
// 会社ラボの型・レイヤーに依存しないよう、意図的に別モジュールとして独立させる
// （既存のV1/V2 Redisキーガードの疎結合方針と同じ考え方）。

export type CompanyLabPersistenceErrorCode =
  | "PARSE_ERROR"
  | "VALIDATION_ERROR"
  | "UNSUPPORTED_VERSION"
  | "LAB_NOT_FOUND"
  | "DRAFT_NOT_FOUND"
  | "HISTORY_ENTRY_NOT_FOUND"
  | "REPOSITORY_ERROR"
  | "SERIALIZATION_ERROR";

abstract class CompanyLabPersistenceErrorBase extends Error {
  abstract readonly code: CompanyLabPersistenceErrorCode;
}

/** JSON文字列自体のparseに失敗した場合。 */
export class CompanyLabPersistedStateParseError extends CompanyLabPersistenceErrorBase {
  readonly code = "PARSE_ERROR" as const;
  constructor(message: string) {
    super(message);
    this.name = "CompanyLabPersistedStateParseError";
  }
}

/** JSONとしては読めたが、会社ラボ永続化状態として内容が不正・破損している場合。 */
export class CompanyLabPersistedStateValidationError extends CompanyLabPersistenceErrorBase {
  readonly code = "VALIDATION_ERROR" as const;
  readonly fieldPath?: string;
  constructor(message: string, fieldPath?: string) {
    super(fieldPath ? `${fieldPath}: ${message}` : message);
    this.name = "CompanyLabPersistedStateValidationError";
    this.fieldPath = fieldPath;
  }
}

/** schemaVersionが現行実装より新しい（未対応の将来バージョン）場合。 */
export class UnsupportedCompanyLabPersistedStateVersionError extends CompanyLabPersistenceErrorBase {
  readonly code = "UNSUPPORTED_VERSION" as const;
  readonly encounteredVersion: number;
  readonly supportedVersion: number;
  constructor(encounteredVersion: number, supportedVersion: number) {
    super(
      `未対応の会社ラボ永続化schemaVersionです（受け取ったバージョン: ${encounteredVersion}、対応済みの最新バージョン: ${supportedVersion}）。`
    );
    this.name = "UnsupportedCompanyLabPersistedStateVersionError";
    this.encounteredVersion = encounteredVersion;
    this.supportedVersion = supportedVersion;
  }
}

/** 指定したlabIdの会社ラボ状態が見つからない。 */
export class CompanyLabNotFoundError extends CompanyLabPersistenceErrorBase {
  readonly code = "LAB_NOT_FOUND" as const;
  readonly labId: string;
  constructor(labId: string) {
    super(`会社ラボ "${labId}" の永続化状態が見つかりません。`);
    this.name = "CompanyLabNotFoundError";
    this.labId = labId;
  }
}

/** 指定したlabIdのドラフトが見つからない。 */
export class CompanyLabDraftNotFoundError extends CompanyLabPersistenceErrorBase {
  readonly code = "DRAFT_NOT_FOUND" as const;
  readonly labId: string;
  constructor(labId: string) {
    super(`会社ラボ "${labId}" のドラフトが見つかりません。`);
    this.name = "CompanyLabDraftNotFoundError";
    this.labId = labId;
  }
}

/** 指定したlabId・turnの確定履歴エントリが見つからない。 */
export class CompanyLabHistoryEntryNotFoundError extends CompanyLabPersistenceErrorBase {
  readonly code = "HISTORY_ENTRY_NOT_FOUND" as const;
  readonly labId: string;
  readonly turn: number;
  constructor(labId: string, turn: number) {
    super(`会社ラボ "${labId}" の四半期${turn}の確定履歴が見つかりません。`);
    this.name = "CompanyLabHistoryEntryNotFoundError";
    this.labId = labId;
    this.turn = turn;
  }
}

/** Redisクライアントとの実際の入出力が失敗した場合、その他Repository層の一般的な障害。 */
export class CompanyLabRepositoryError extends CompanyLabPersistenceErrorBase {
  readonly code = "REPOSITORY_ERROR" as const;
  constructor(message: string) {
    super(message);
    this.name = "CompanyLabRepositoryError";
  }
}

/** 会社ラボ永続化状態のencode/decodeに失敗した場合。 */
export class CompanyLabSerializationError extends CompanyLabPersistenceErrorBase {
  readonly code = "SERIALIZATION_ERROR" as const;
  constructor(message: string) {
    super(message);
    this.name = "CompanyLabSerializationError";
  }
}
