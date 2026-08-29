// ShrimpX V2 — 会社ラボ API 入力検証（Phase 8C-3A §8・Phase 8C-3B §6）
//
// フレームワーク（NextRequest等）に一切依存しない、純粋な検証関数群。
// 検証に失敗した場合は例外を投げず、判定結果（ApiValidationResult）を返す
// （呼び出し側がhandlers.ts内でHTTP 400応答へ変換する）。

import { CompanyId } from "../../../../lib/v2/sales/types";
import { COMPANY_LAB_COMPANY_IDS } from "../../../../lib/v2/companyLab/fixtures";
import { resolveScenarioDefinition } from "../../../../lib/v2/industryLab/cli/scenarioAliases";
import { SALES_MODEL_IDS, SalesModelId, isSalesModelId } from "../../../../lib/v2/sales/salesModels";

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
  readonly playerCompanyId: CompanyId;
  /**
   * 【ENG-SALES-MODEL-PERSIST-2】販売モデルの versioned ID（optional）。
   * 未指定なら従来どおり（legacy variant 解決）。allowlist 外は 400。
   */
  readonly salesModelId?: SalesModelId;
}

/**
 * 【ターン数整合性修正】scenarioIdからdurationTurns（そのシナリオで許される最大ターン数）を
 * 解決する関数型。既定実装は既存のresolveScenarioDefinition（industryLab/cli/scenarioAliases.ts。
 * companyLab runnerのfindScenarioDefinitionForCompanyLabと同じ解決源）を使い、完全ID
 * （"baseline-v0.1"）とエイリアス（"baseline"）の両方を受け付ける。未知のscenarioIdはnullを
 * 返し、その場合の詳細エラー（利用可能なシナリオ一覧付き）は従来どおりApplication Service側
 * （findScenarioDefinitionForCompanyLab）に委ねる（エラー文言の定義元を増やさない）。
 *
 * 注入可能にしてあるのは、実在の全シナリオが現在32ターンであるため、「将来の10年間＝40四半期
 * シナリオでも同じ仕組みで上限が追随する」ことをテストで検証できるようにするため（テスト専用。
 * 本番経路は常に既定実装が使われる）。
 */
export type ScenarioDurationTurnsResolver = (scenarioId: string) => number | null;

export function defaultScenarioDurationTurnsResolver(scenarioId: string): number | null {
  return resolveScenarioDefinition(scenarioId)?.durationTurns ?? null;
}

/**
 * POST /api/v2/company-labs のリクエストボディ検証。
 *
 * 【ターン数整合性修正】turnsの上限は「選択中シナリオのdurationTurns」を唯一の正として、
 * この入力検証層でも確認する（クライアント側の表示・入力制限には依存しない）。scenarioIdが
 * 解決できない場合の詳細エラーと、durationTurns上限の最終的な強制はApplication Service
 * （initializeCompanyLab）が引き続き独立に行う（多層防御。ここで拒否するのは
 * 「知っている限り確実に不正」なリクエストだけ）。
 *
 * 【Phase 8C-3B §6】playerCompanyIdは必須（省略不可）。8C-3A時点の「BAL固定・先頭会社への
 * サイレントfallback」を廃止し、既知の5社ID（COMPANY_LAB_COMPANY_IDS）のいずれかを明示的に
 * 指定しない限り400で拒否する。曖昧なデフォルト値は設けない。
 */
export function validateCreateLabRequestBody(
  body: unknown,
  resolveDurationTurns: ScenarioDurationTurnsResolver = defaultScenarioDurationTurnsResolver
): ApiValidationResult<CreateLabRequestBody> {
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
  // 【ターン数整合性修正】選択シナリオのdurationTurnsを超えるターン数はこの境界でも拒否する。
  // 32や40といった数値はハードコードせず、常にシナリオ定義のdurationTurnsを参照する。
  const durationTurns = resolveDurationTurns(b.scenarioId);
  if (durationTurns !== null && b.turns > durationTurns) {
    return fail(`turns は1〜${durationTurns}（シナリオ"${b.scenarioId}"のdurationTurns）の整数である必要があります。受け取った値: ${b.turns}`);
  }
  if (typeof b.playerCompanyId !== "string" || !(COMPANY_LAB_COMPANY_IDS as readonly string[]).includes(b.playerCompanyId)) {
    return fail(`playerCompanyId は必須で、次のいずれかである必要があります: ${COMPANY_LAB_COMPANY_IDS.join(", ")}`);
  }
  // 【ENG-SALES-MODEL-PERSIST-2】販売モデルは **allowlist の ID だけ** を受理する。
  // 任意の SalesParameters JSON は API から注入できない（registry 経由のみ）。
  // 未指定は許可（従来どおり legacy variant 解決）。未知 ID は silent fallback せず 400。
  if (b.salesModelId !== undefined && b.salesModelId !== null && !isSalesModelId(b.salesModelId)) {
    return fail(`salesModelId は次のいずれかである必要があります: ${SALES_MODEL_IDS.join(", ")}。受け取った値: ${JSON.stringify(b.salesModelId)}`);
  }
  return ok({
    ...(typeof b.labId === "string" ? { labId: b.labId } : {}),
    scenarioId: b.scenarioId,
    mode: b.mode,
    seed: b.seed,
    turns: b.turns,
    playerCompanyId: b.playerCompanyId as CompanyId,
    ...(isSalesModelId(b.salesModelId) ? { salesModelId: b.salesModelId } : {}),
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
