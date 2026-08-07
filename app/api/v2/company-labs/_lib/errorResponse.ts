// ShrimpX V2 — 会社ラボ API ドメインエラー → HTTP応答変換（Phase 8C-3A §8）
//
// domain/application層（persistence/errors.ts・companyLab/types.tsのCompanyLabError）の
// 例外を、一貫したHTTP statusとJSONエラー形式（{ error: { code, message } }）へ変換する。
// 内部snapshot・Redis key・lock token・環境変数・スタックトレースは応答へ一切含めない
// （エラーメッセージ自体は各エラークラスのconstructorで生成された、ユーザー向けの
// 日本語文であり、内部実装詳細を含まないことをpersistence/errors.ts側で確認済み）。
//
// フレームワーク（NextResponse）に依存しない、純粋な {status, body} を返す関数として
// 実装する（route.ts側でNextResponse.json(body, {status})へ変換する）。

import {
  CompanyLabAlreadyExistsError,
  CompanyLabCompletedError,
  CompanyLabDraftAlreadySubmittedError,
  CompanyLabDraftConflictError,
  CompanyLabDraftNotFoundError,
  CompanyLabDraftNotSubmittedError,
  CompanyLabDraftTurnMismatchError,
  CompanyLabHistoryEntryNotFoundError,
  CompanyLabIntegrityError,
  CompanyLabLockConflictError,
  CompanyLabLockUnavailableError,
  CompanyLabNotFoundError,
  CompanyLabPersistedStateParseError,
  CompanyLabPersistedStateValidationError,
  CompanyLabQuarterProcessingError,
  CompanyLabRepositoryError,
  CompanyLabRevisionConflictError,
  CompanyLabSerializationError,
  CompanyLabTurnConflictError,
  UnsupportedCompanyLabPersistedStateVersionError,
} from "../../../../lib/v2/companyLab/persistence/errors";
import { CompanyLabError } from "../../../../lib/v2/companyLab/types";
import { CompanyLabRedisKeyGuardError } from "../../../../lib/v2/redis/companyLabRedisKeyGuard";

export interface ApiErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

export interface ApiErrorResponse {
  readonly status: number;
  readonly body: ApiErrorBody;
}

function respond(status: number, code: string, message: string): ApiErrorResponse {
  return { status, body: { error: { code, message } } };
}

const GENERIC_INTERNAL_MESSAGE = "サーバー内部でエラーが発生しました。時間をおいて再度お試しください。";

/**
 * 指示§8の対応表:
 *   入力不正 → 400 / Lab Not Found → 404 / Already Exists → 409 /
 *   Draft未提出・turn不一致 → 409 / Revision競合 → 409 / Turn競合 → 409 /
 *   Lock競合・処理中 → 409または423 / 完了済み → 409 / 予期しない内部エラー → 500
 *
 * ロックについては、まだ処理を開始できていない（他処理が処理中）場合は423
 * （Locked）、処理を開始した後にコミット時点で競合が判明した場合は409
 * （Conflict）と使い分ける。四半期処理エンジンの失敗（QUARTER_PROCESSING_FAILED）は
 * 「リクエスト自体は受理できたが、提出された意思決定の内容で処理を完了できなかった」
 * ことを表すため、opaqueな500ではなく422（Unprocessable Entity）とする。
 */
export function mapDomainErrorToHttp(e: unknown): ApiErrorResponse {
  if (e instanceof CompanyLabNotFoundError) return respond(404, "LAB_NOT_FOUND", e.message);
  if (e instanceof CompanyLabHistoryEntryNotFoundError) return respond(404, "HISTORY_ENTRY_NOT_FOUND", e.message);

  if (e instanceof CompanyLabAlreadyExistsError) return respond(409, "LAB_ALREADY_EXISTS", e.message);
  if (e instanceof CompanyLabCompletedError) return respond(409, "LAB_COMPLETED", e.message);
  if (e instanceof CompanyLabDraftNotFoundError) return respond(409, "DRAFT_NOT_FOUND", e.message);
  if (e instanceof CompanyLabDraftNotSubmittedError) return respond(409, "DRAFT_NOT_SUBMITTED", e.message);
  if (e instanceof CompanyLabDraftAlreadySubmittedError) return respond(409, "DRAFT_ALREADY_SUBMITTED", e.message);
  if (e instanceof CompanyLabDraftConflictError) return respond(409, "DRAFT_CONFLICT", e.message);
  if (e instanceof CompanyLabDraftTurnMismatchError) return respond(409, "DRAFT_TURN_MISMATCH", e.message);
  if (e instanceof CompanyLabRevisionConflictError) return respond(409, "REVISION_CONFLICT", e.message);
  if (e instanceof CompanyLabTurnConflictError) return respond(409, "TURN_CONFLICT", e.message);
  if (e instanceof CompanyLabLockConflictError) return respond(409, "LOCK_CONFLICT", e.message);

  if (e instanceof CompanyLabLockUnavailableError) return respond(423, "LOCK_UNAVAILABLE", e.message);

  if (e instanceof CompanyLabQuarterProcessingError) return respond(422, "QUARTER_PROCESSING_FAILED", e.message);

  if (e instanceof CompanyLabError) return respond(400, "INVALID_REQUEST", e.message);

  // 以下は「内部の整合性違反・保存データ破損・Redis入出力失敗・(de)serialization失敗」等、
  // ユーザー入力では起こり得ない・ユーザーが直接修正できない種類の失敗であり、
  // 内部詳細を応答へ出さず一律500の定型メッセージにする（メッセージにRedis key・
  // スタックトレース等が含まれないことは各エラークラスのmessage自体で保証されているが、
  // 念のため外部応答では定型文に差し替え、サーバーログ側にのみ詳細を残す想定）。
  if (
    e instanceof CompanyLabIntegrityError ||
    e instanceof CompanyLabRepositoryError ||
    e instanceof CompanyLabSerializationError ||
    e instanceof CompanyLabPersistedStateParseError ||
    e instanceof CompanyLabPersistedStateValidationError ||
    e instanceof UnsupportedCompanyLabPersistedStateVersionError ||
    e instanceof CompanyLabRedisKeyGuardError
  ) {
    return respond(500, "INTERNAL_ERROR", GENERIC_INTERNAL_MESSAGE);
  }

  return respond(500, "INTERNAL_ERROR", GENERIC_INTERNAL_MESSAGE);
}
