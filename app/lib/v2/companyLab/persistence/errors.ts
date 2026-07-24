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
  | "SERIALIZATION_ERROR"
  // --- Phase 8C-2で追加（Application Service・Repository契約統一） ---
  | "LAB_ALREADY_EXISTS"
  | "LAB_COMPLETED"
  | "DRAFT_NOT_SUBMITTED"
  | "DRAFT_ALREADY_SUBMITTED"
  | "DRAFT_CONFLICT"
  | "DRAFT_TURN_MISMATCH"
  | "LOCK_UNAVAILABLE"
  | "LOCK_CONFLICT"
  | "REVISION_CONFLICT"
  | "TURN_CONFLICT"
  | "INTEGRITY_ERROR"
  | "QUARTER_PROCESSING_FAILED";

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

// ---------------------------------------------------------------------
// Phase 8C-2で追加されたエラー型（Application Service・Repository契約統一）
// ---------------------------------------------------------------------

/** 既に存在するlabIdでラボを作成しようとした場合（上書き禁止。Phase 8C-2指示§3.1）。 */
export class CompanyLabAlreadyExistsError extends CompanyLabPersistenceErrorBase {
  readonly code = "LAB_ALREADY_EXISTS" as const;
  readonly labId: string;
  constructor(labId: string) {
    super(`会社ラボ "${labId}" は既に存在します。既存ラボの上書き作成は許可されていません。`);
    this.name = "CompanyLabAlreadyExistsError";
    this.labId = labId;
  }
}

/** 完了済み（isComplete=true）のラボをさらに進めようとした場合（Phase 8C-2指示§10）。 */
export class CompanyLabCompletedError extends CompanyLabPersistenceErrorBase {
  readonly code = "LAB_COMPLETED" as const;
  readonly labId: string;
  constructor(labId: string) {
    super(`会社ラボ "${labId}" はシナリオの最終四半期まで処理済みです。これ以上四半期を進めることはできません。`);
    this.name = "CompanyLabCompletedError";
    this.labId = labId;
  }
}

/** ドラフトが存在するが正式提出されていない（submittedAt=null）状態で四半期処理を要求された場合。 */
export class CompanyLabDraftNotSubmittedError extends CompanyLabPersistenceErrorBase {
  readonly code = "DRAFT_NOT_SUBMITTED" as const;
  readonly labId: string;
  constructor(labId: string) {
    super(`会社ラボ "${labId}" のドラフトはまだ正式提出されていません。四半期処理には提出済みドラフトが必要です。`);
    this.name = "CompanyLabDraftNotSubmittedError";
    this.labId = labId;
  }
}

/** 正式提出済みドラフトを編集（上書き保存）しようとした場合（提出後の編集防止。Phase 8C-1指示§3-2の8C-2持ち越し分）。 */
export class CompanyLabDraftAlreadySubmittedError extends CompanyLabPersistenceErrorBase {
  readonly code = "DRAFT_ALREADY_SUBMITTED" as const;
  readonly labId: string;
  constructor(labId: string) {
    super(`会社ラボ "${labId}" のドラフトは既に正式提出済みです。提出後のドラフト編集は許可されていません。`);
    this.name = "CompanyLabDraftAlreadySubmittedError";
    this.labId = labId;
  }
}

/**
 * 提出済みだが未処理の別turnのドラフトが既に存在する状態で、異なるturnIdのドラフトを
 * 保存しようとした場合（Phase 8C-3A、Fable監査Minor-1対応）。turnIdが一致する場合の
 * 「提出後編集」はCompanyLabDraftAlreadySubmittedErrorが担い、本エラーは「turnIdが
 * 異なる」場合専用（＝提出済みドラフトを、対象外turnの新しいドラフトで静かに
 * 上書きすることを防ぐ）。
 */
export class CompanyLabDraftConflictError extends CompanyLabPersistenceErrorBase {
  readonly code = "DRAFT_CONFLICT" as const;
  readonly labId: string;
  readonly submittedTurnId: string;
  readonly requestedTurnId: string;
  constructor(labId: string, submittedTurnId: string, requestedTurnId: string) {
    super(
      `会社ラボ "${labId}" には既にturnId(${submittedTurnId})の提出済みドラフトが存在するため、` +
        `turnId(${requestedTurnId})の新しいドラフトを保存できません。提出済みドラフトの四半期処理を先に完了してください。`
    );
    this.name = "CompanyLabDraftConflictError";
    this.labId = labId;
    this.submittedTurnId = submittedTurnId;
    this.requestedTurnId = requestedTurnId;
  }
}

/** ドラフトのturnIdが処理要求のturnIdと一致しない場合。 */
export class CompanyLabDraftTurnMismatchError extends CompanyLabPersistenceErrorBase {
  readonly code = "DRAFT_TURN_MISMATCH" as const;
  readonly labId: string;
  readonly requestedTurnId: string;
  readonly actualTurnId: string;
  constructor(labId: string, requestedTurnId: string, actualTurnId: string) {
    super(`会社ラボ "${labId}" のドラフトのturnId(${actualTurnId})が、処理要求のturnId(${requestedTurnId})と一致しません。`);
    this.name = "CompanyLabDraftTurnMismatchError";
    this.labId = labId;
    this.requestedTurnId = requestedTurnId;
    this.actualTurnId = actualTurnId;
  }
}

/** 四半期処理ロックが他の処理に取得されており、取得できなかった場合。 */
export class CompanyLabLockUnavailableError extends CompanyLabPersistenceErrorBase {
  readonly code = "LOCK_UNAVAILABLE" as const;
  readonly labId: string;
  constructor(labId: string) {
    super(`会社ラボ "${labId}" の四半期処理ロックを取得できませんでした（別の処理が進行中の可能性があります）。`);
    this.name = "CompanyLabLockUnavailableError";
    this.labId = labId;
  }
}

/** 原子コミット時点でロックトークンが一致しなかった場合（TTL切れ・他処理による取得等）。 */
export class CompanyLabLockConflictError extends CompanyLabPersistenceErrorBase {
  readonly code = "LOCK_CONFLICT" as const;
  readonly labId: string;
  constructor(labId: string) {
    super(
      `会社ラボ "${labId}" の原子コミット時点でロックトークンが一致しませんでした` +
        `（処理中にロックTTLが切れたか、別の処理がロックを取得した可能性があります）。確定状態は変更されていません。`
    );
    this.name = "CompanyLabLockConflictError";
    this.labId = labId;
  }
}

/** 原子コミット時点でrevisionが一致しなかった場合（楽観的排他制御の競合）。 */
export class CompanyLabRevisionConflictError extends CompanyLabPersistenceErrorBase {
  readonly code = "REVISION_CONFLICT" as const;
  readonly labId: string;
  readonly expectedRevision: number;
  readonly actualRevision: number;
  constructor(labId: string, expectedRevision: number, actualRevision: number) {
    super(
      `会社ラボ "${labId}" のrevisionが競合しました（期待: ${expectedRevision}、実際: ${actualRevision}）。` +
        `別の処理が先に状態を進めています。確定状態は変更されていません。`
    );
    this.name = "CompanyLabRevisionConflictError";
    this.labId = labId;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

/** 同じturnに対して異なるturnIdの履歴が既に確定している場合（同一四半期の二重処理防止）。 */
export class CompanyLabTurnConflictError extends CompanyLabPersistenceErrorBase {
  readonly code = "TURN_CONFLICT" as const;
  readonly labId: string;
  readonly turn: number;
  readonly existingTurnId: string;
  constructor(labId: string, turn: number, existingTurnId: string) {
    super(
      `会社ラボ "${labId}" の四半期${turn}は、既に別のturnId(${existingTurnId})で確定済みです。` +
        `同一四半期を異なるturnIdで二重に処理することはできません。`
    );
    this.name = "CompanyLabTurnConflictError";
    this.labId = labId;
    this.turn = turn;
    this.existingTurnId = existingTurnId;
  }
}

/** 保存されているcurrent・履歴・indexの間に矛盾が検出された場合（本来起きてはならない整合性違反）。 */
export class CompanyLabIntegrityError extends CompanyLabPersistenceErrorBase {
  readonly code = "INTEGRITY_ERROR" as const;
  readonly labId: string;
  constructor(labId: string, message: string) {
    super(`会社ラボ "${labId}" の保存状態に整合性違反が検出されました: ${message}`);
    this.name = "CompanyLabIntegrityError";
    this.labId = labId;
  }
}

/** 四半期処理エンジン（advanceCompanyLabQuarter等）の実行が失敗した場合（コミット前。確定状態は変更されない）。 */
export class CompanyLabQuarterProcessingError extends CompanyLabPersistenceErrorBase {
  readonly code = "QUARTER_PROCESSING_FAILED" as const;
  readonly labId: string;
  constructor(labId: string, message: string) {
    super(`会社ラボ "${labId}" の四半期処理に失敗しました（確定状態は変更されていません）: ${message}`);
    this.name = "CompanyLabQuarterProcessingError";
    this.labId = labId;
  }
}
