// ShrimpX V2 — 会社ラボ API 入力検証（Phase 8C-3A §8）
//
// フレームワーク（NextRequest等）に一切依存しない、純粋な検証関数群。
// 検証に失敗した場合は例外を投げず、判定結果（ApiValidationResult）を返す
// （呼び出し側がhandlers.ts内でHTTP 400応答へ変換する）。

const MAX_LAB_ID_LENGTH = 200;
const MAX_TURN_ID_LENGTH = 200;
const MAX_HISTORY_LIMIT = 50;
const DEFAULT_HISTORY_LIMIT = 10;
// draft本体は「網羅グリッド」（全市場×全商品・全工場×全商品等）を含むが、5社×32ターン規模の
// Company Labでは数十KB程度に収まる想定。異常に巨大なリクエストボディ（誤操作・攻撃）を
// 早期に拒否するための緩い上限（1MB）。厳密な内容検証はbuildDecisionInputFromDraft側の
// 型変換・スマートコンストラクタ（hosoEqTons/ratio等の境界検証）に委ねる。
const MAX_DRAFT_BODY_BYTES = 1024 * 1024;

export type ApiValidationResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

function ok<T>(value: T): ApiValidationResult<T> {
  return { ok: true, value };
}

function fail<T>(message: string): ApiValidationResult<T> {
  return { ok: false, message };
}

/** labId: 空でない文字列、":"を含まない（Redisキー名前空間規約。companyLabRedisKeyGuard.tsのisValidLabIdと同じ制約）、長さ上限内。 */
export function validateLabId(value: unknown): ApiValidationResult<string> {
  if (typeof value !== "string" || value.length === 0) {
    return fail("labId は空でない文字列である必要があります。");
  }
  if (value.includes(":")) {
    return fail('labId に ":" を含めることはできません。');
  }
  if (value.length > MAX_LAB_ID_LENGTH) {
    return fail(`labId は${MAX_LAB_ID_LENGTH}文字以内である必要があります。`);
  }
  return ok(value);
}

/** サーバー生成labIdの候補として妥当かどうか（クライアント指定labIdと同じ制約を、生成直後の自己検証にも使う）。 */
export function isValidLabIdCandidate(value: string): boolean {
  return validateLabId(value).ok;
}

export interface CreateLabRequestBody {
  readonly labId?: string;
  readonly scenarioId: string;
  readonly mode: "canonical" | "variation";
  readonly seed: string;
  readonly turns: number;
}

/** POST /api/v2/company-labs のリクエストボディ検証。scenarioId自体の妥当性（実在するシナリオか・turnsがdurationTurns内か）はApplication Service（initializeCompanyLab）に委ね、ここでは形の検証のみ行う。 */
export function validateCreateLabRequestBody(body: unknown): ApiValidationResult<CreateLabRequestBody> {
  if (typeof body !== "object" || body === null) {
    return fail("リクエストボディはJSONオブジェクトである必要があります。");
  }
  const b = body as Record<string, unknown>;
  if (b.labId !== undefined) {
    const labIdResult = validateLabId(b.labId);
    if (!labIdResult.ok) return fail(labIdResult.message);
  }
  if (typeof b.scenarioId !== "string" || b.scenarioId.length === 0) {
    return fail("scenarioId は空でない文字列である必要があります。");
  }
  if (b.mode !== "canonical" && b.mode !== "variation") {
    return fail('mode は "canonical" または "variation" のいずれかである必要があります。');
  }
  if (typeof b.seed !== "string" || b.seed.length === 0) {
    return fail("seed は空でない文字列である必要があります。");
  }
  if (typeof b.turns !== "number" || !Number.isInteger(b.turns) || b.turns < 1) {
    return fail("turns は1以上の整数である必要があります。");
  }
  return ok({
    ...(typeof b.labId === "string" ? { labId: b.labId } : {}),
    scenarioId: b.scenarioId,
    mode: b.mode,
    seed: b.seed,
    turns: b.turns,
  });
}

export interface SaveDraftRequestBody {
  readonly turnId?: string;
  readonly draft: unknown;
}

/**
 * PUT .../draft のリクエストボディ検証。turnIdはクライアントが明示的に指定した場合のみ
 * 使う（省略時はhandlers.ts側で§7のturnId導出方針に従いサーバーが導出する。turnId.ts参照）。
 * 指定された場合は、サーバー導出値と一致することをhandlers.ts側で確認する（対象turn以外への
 * 誤送信をここで検出するため）。
 */
export function validateSaveDraftRequestBody(body: unknown): ApiValidationResult<SaveDraftRequestBody> {
  if (typeof body !== "object" || body === null) {
    return fail("リクエストボディはJSONオブジェクトである必要があります。");
  }
  const b = body as Record<string, unknown>;
  if (!("draft" in b) || b.draft === undefined) {
    return fail("draft フィールドが必要です。");
  }
  let bodyBytes: number;
  try {
    bodyBytes = Buffer.byteLength(JSON.stringify(b.draft), "utf8");
  } catch {
    return fail("draft をJSONとして直列化できませんでした。");
  }
  if (bodyBytes > MAX_DRAFT_BODY_BYTES) {
    return fail(`draft が大きすぎます（${bodyBytes}バイト。上限は${MAX_DRAFT_BODY_BYTES}バイトです）。`);
  }
  if (b.turnId !== undefined) {
    if (typeof b.turnId !== "string" || b.turnId.length === 0 || b.turnId.length > MAX_TURN_ID_LENGTH) {
      return fail("turnId を指定する場合は空でない文字列である必要があります。");
    }
  }
  return ok({ ...(typeof b.turnId === "string" ? { turnId: b.turnId } : {}), draft: b.draft });
}

export interface ProcessQuarterRequestBody {
  readonly turnId?: string;
}

/** POST .../process-quarter のリクエストボディ検証（turnId省略可。省略時はサーバー導出）。 */
export function validateProcessQuarterRequestBody(body: unknown): ApiValidationResult<ProcessQuarterRequestBody> {
  if (body === undefined || body === null) return ok({});
  if (typeof body !== "object") {
    return fail("リクエストボディはJSONオブジェクトである必要があります。");
  }
  const b = body as Record<string, unknown>;
  if (b.turnId !== undefined) {
    if (typeof b.turnId !== "string" || b.turnId.length === 0 || b.turnId.length > MAX_TURN_ID_LENGTH) {
      return fail("turnId を指定する場合は空でない文字列である必要があります。");
    }
    return ok({ turnId: b.turnId });
  }
  return ok({});
}

export interface HistoryQuery {
  readonly afterTurn?: number;
  readonly limit: number;
}

/** GET .../history?afterTurn=&limit= のクエリパラメータ検証。limitはMAX_HISTORY_LIMITで安全側に上限を切る（§6.6「limitに安全な上限を設ける」）。 */
export function validateHistoryQuery(searchParams: URLSearchParams): ApiValidationResult<HistoryQuery> {
  const afterTurnRaw = searchParams.get("afterTurn");
  let afterTurn: number | undefined;
  if (afterTurnRaw !== null) {
    const parsed = Number(afterTurnRaw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      return fail("afterTurn は0以上の整数である必要があります。");
    }
    afterTurn = parsed;
  }
  const limitRaw = searchParams.get("limit");
  let limit = DEFAULT_HISTORY_LIMIT;
  if (limitRaw !== null) {
    const parsed = Number(limitRaw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return fail("limit は1以上の整数である必要があります。");
    }
    limit = parsed;
  }
  if (limit > MAX_HISTORY_LIMIT) {
    return fail(`limit は${MAX_HISTORY_LIMIT}以下である必要があります（1件あたり最大約2.5MBになりうるため）。`);
  }
  return ok({ ...(afterTurn !== undefined ? { afterTurn } : {}), limit });
}

/** GET .../history/[turn] のパスパラメータ検証（正の整数turnのみ許可。companyLabRedisKeyGuardのrequireValidTurnと同じ制約）。 */
export function validateTurnParam(value: string): ApiValidationResult<number> {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return fail("turn は1以上の整数である必要があります。");
  }
  return ok(parsed);
}

export { MAX_HISTORY_LIMIT, DEFAULT_HISTORY_LIMIT, MAX_LAB_ID_LENGTH, MAX_DRAFT_BODY_BYTES };
