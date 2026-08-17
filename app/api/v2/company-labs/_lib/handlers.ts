// ShrimpX V2 — 会社ラボ API ハンドラー本体（Phase 8C-3A）
//
// フレームワーク（NextRequest/NextResponse）に一切依存しない、純粋な非同期関数群。
// 各関数は { repository, service } という依存関係（テストではin-memory Repository、
// 本番ではdependencies.tsが組み立てたRedis Repositoryを渡す）と、route.ts側で
// 既にJSONパース・パスパラメータ抽出まで済ませたプレーンな入力を受け取り、
// { status, body } を返す。route.ts側はこれをNextResponse.json(body, {status})へ
// 変換するだけの薄いアダプターに徹する（指示§11「route handlerへ依存関係を注入し、
// 実Upstash認証情報なしでもAPIの主要経路を検証できるようにする」の実現方法）。
//
// 並行処理の安全性はPhase 8C-2のRedis lock・Lua原子コミットに委ね、ここでは
// 「先に読んで確認したから安全」という疑似CASを一切行わない（指示§10）。
// ここで行う事前の読み取り（loadCurrentState等）は、turnIdの決定論的導出や
// 分かりやすいエラー分類のためのものであり、その後のservice呼び出し
// （saveDraft/submitDraft/processQuarter）が改めて正規の検証・原子コミットを行う。

import { randomUUID } from "crypto";
import { CompanyLabApiDependencies } from "./dependencies";
import { ApiErrorResponse, mapDomainErrorToHttp } from "./errorResponse";
import {
  validateCreateLabRequestBody,
  validateHistoryQuery,
  validateLabId,
  validateProcessQuarterRequestBody,
  validateSaveDraftRequestBody,
  validateTurnParam,
} from "./validation";
import { resolveInFlightTurnId, resolveNewDraftTurnId } from "./turnId";
import { generateUniqueLabId } from "./labIdGenerator";
import { buildApiDecisionsProvider } from "./decisionsProvider";
import { toDraftSummaryDto, toHistoryEntrySummaryDto, toLabStateDto, toLabSummaryDto } from "./responseDto";
import { DEFAULT_PROCESSING_LOCK_TTL_MS } from "../../../../lib/v2/companyLab/application/companyLabQuarterFlowService";
import { DEFAULT_RUNTIME_STANDARD_AI_PROFILE_MODE } from "../../../../lib/v2/companyLab/standardAi/orientationProfile";

export type ApiResult = ApiErrorResponse | { readonly status: number; readonly body: unknown };

function badRequest(message: string): ApiResult {
  return { status: 400, body: { error: { code: "INVALID_REQUEST", message } } };
}

// ---------------------------------------------------------------------
// POST /api/v2/company-labs — ラボ作成（§6.1）
// ---------------------------------------------------------------------

export async function handleCreateLab(deps: CompanyLabApiDependencies, rawBody: unknown, now: string): Promise<ApiResult> {
  const bodyResult = validateCreateLabRequestBody(rawBody);
  if (!bodyResult.ok) return badRequest(bodyResult.message);
  const { scenarioId, mode, seed, turns, playerCompanyId } = bodyResult.value;

  let labId: string;
  if (bodyResult.value.labId !== undefined) {
    labId = bodyResult.value.labId;
  } else {
    try {
      labId = await generateUniqueLabId(deps.repository);
    } catch (e) {
      return { status: 500, body: { error: { code: "INTERNAL_ERROR", message: e instanceof Error ? e.message : String(e) } } };
    }
  }

  try {
    // 【Phase 8C-3B】playerCompanyIdはvalidation.tsで既知の5社IDであることを検証済み。
    // Application Service層（createLab）がさらにfixturesとの整合性を防御的に確認する。
    // 【Phase SAI-5B】新規Labの既定は DEFAULT_RUNTIME_STANDARD_AI_PROFILE_MODE（="ON"）。
    // 会社別ManagementProfile/CompanyOrientationProfileを実ゲームのCompany Labでも
    // 有効にするため、作成時にconfigへ明示的に書き込む（保存済みLabは書き換えない＝
    // 既存Labの挙動は変わらない）。Standard AIへ実際に渡す経路は decisionsProvider.ts。
    const result = await deps.service.createLab({
      labId,
      config: { scenarioId, mode, seed, turns, standardAiProfileMode: DEFAULT_RUNTIME_STANDARD_AI_PROFILE_MODE },
      playerCompanyId,
      now,
    });
    return { status: 201, body: { lab: toLabSummaryDto(result.stored) } };
  } catch (e) {
    return mapDomainErrorToHttp(e);
  }
}

// ---------------------------------------------------------------------
// GET /api/v2/company-labs — ラボ一覧（§6.2）
// ---------------------------------------------------------------------

export async function handleListLabs(deps: CompanyLabApiDependencies): Promise<ApiResult> {
  const labIds = await deps.repository.listLabs();
  const labs = [];
  for (const labId of labIds) {
    try {
      const stored = await deps.repository.loadCurrentState(labId);
      labs.push(toLabSummaryDto(stored));
    } catch {
      // listLabs()とloadCurrentState()は別々のRedis読み取りであり、理論上の競合
      // （一覧取得直後に対象が読めなくなる等）に対して一覧応答全体を失敗させない。
      // 8C-2のRepository契約上、createLab成功後にlabs一覧へ追加されたlabIdの
      // currentが読めなくなることは通常操作では起きないため、防御的な扱いにとどめる。
    }
  }
  return { status: 200, body: { labs } };
}

// ---------------------------------------------------------------------
// GET /api/v2/company-labs/[labId] — ラボ状態取得（§6.2）
// ---------------------------------------------------------------------

export async function handleGetLabState(deps: CompanyLabApiDependencies, labId: string): Promise<ApiResult> {
  const labIdResult = validateLabId(labId);
  if (!labIdResult.ok) return badRequest(labIdResult.message);
  try {
    const stored = await deps.repository.loadCurrentState(labId);
    const draft = await deps.repository.loadDraft(labId);
    return { status: 200, body: { lab: toLabStateDto(stored, draft) } };
  } catch (e) {
    return mapDomainErrorToHttp(e);
  }
}

// ---------------------------------------------------------------------
// PUT /api/v2/company-labs/[labId]/draft — ドラフト保存（§6.3）
// ---------------------------------------------------------------------

export async function handleSaveDraft(deps: CompanyLabApiDependencies, labId: string, rawBody: unknown, now: string): Promise<ApiResult> {
  const labIdResult = validateLabId(labId);
  if (!labIdResult.ok) return badRequest(labIdResult.message);
  const bodyResult = validateSaveDraftRequestBody(rawBody);
  if (!bodyResult.ok) return badRequest(bodyResult.message);

  let currentTurn: number;
  let existingDraftTurnId: string | null;
  try {
    const stored = await deps.repository.loadCurrentState(labId);
    currentTurn = stored.currentState.runtime.scenarioState.currentTurn;
    const existingDraft = await deps.repository.loadDraft(labId);
    existingDraftTurnId = existingDraft?.turnId ?? null;
  } catch (e) {
    return mapDomainErrorToHttp(e);
  }
  // saveDraftは「これから提出する対象」を指す。既存の（未提出/提出済みの）draftが
  // あればそれを継続編集対象とし、無ければ現在のturnから新規導出する
  // （turnId.ts、resolveNewDraftTurnIdのコメント参照）。
  const derivedTurnId = resolveNewDraftTurnId({ currentTurn, existingDraftTurnId });

  // クライアントが明示的にturnIdを指定した場合、サーバー導出値と一致しなければ
  // 対象turn外への誤送信として拒否する（指示§6.3、turnId不一致の明示的な検出）。
  if (bodyResult.value.turnId !== undefined && bodyResult.value.turnId !== derivedTurnId) {
    return {
      status: 409,
      body: {
        error: {
          code: "TURN_MISMATCH",
          message: `指定されたturnId(${bodyResult.value.turnId})は、現在処理対象のturn(${derivedTurnId})と一致しません。`,
        },
      },
    };
  }

  try {
    // 異なるturnIdの提出済みdraftによる静かな上書き防止は、Application Service層
    // （companyLabQuarterFlowService.ts の saveDraft、Fable監査Minor-1対応）が
    // CompanyLabDraftConflictErrorとして構造的に保証する。ここでの重複判定は行わない。
    const envelope = await deps.service.saveDraft({ labId, turnId: derivedTurnId, draftBody: bodyResult.value.draft, now });
    return { status: 200, body: { draft: toDraftSummaryDto(envelope) } };
  } catch (e) {
    return mapDomainErrorToHttp(e);
  }
}

// ---------------------------------------------------------------------
// POST /api/v2/company-labs/[labId]/draft/submit — ドラフト提出（§6.4）
// ---------------------------------------------------------------------

export async function handleSubmitDraft(deps: CompanyLabApiDependencies, labId: string, now: string): Promise<ApiResult> {
  const labIdResult = validateLabId(labId);
  if (!labIdResult.ok) return badRequest(labIdResult.message);

  let currentTurn: number;
  let existingDraftTurnId: string | null;
  let lastProcessedTurnId: string | null;
  try {
    const stored = await deps.repository.loadCurrentState(labId);
    currentTurn = stored.currentState.runtime.scenarioState.currentTurn;
    lastProcessedTurnId = stored.currentState.lastProcessedTurnId ?? null;
    const existingDraft = await deps.repository.loadDraft(labId);
    existingDraftTurnId = existingDraft?.turnId ?? null;
  } catch (e) {
    return mapDomainErrorToHttp(e);
  }
  // submitDraftは提出・処理系の操作なので、draft不在時は直近確定turnId
  // （応答消失後の再送を正しく冪等判定へ導くため）を優先して解決する
  // （turnId.ts、resolveInFlightTurnIdのコメント参照）。
  const derivedTurnId = resolveInFlightTurnId({ currentTurn, draftTurnId: existingDraftTurnId, lastProcessedTurnId });

  try {
    // 完了済みラボの拒否はApplication Service層（submitDraft、Fable監査Minor-2対応）が行う。
    const envelope = await deps.service.submitDraft({ labId, turnId: derivedTurnId, now });
    return { status: 200, body: { draft: toDraftSummaryDto(envelope) } };
  } catch (e) {
    return mapDomainErrorToHttp(e);
  }
}

// ---------------------------------------------------------------------
// POST /api/v2/company-labs/[labId]/draft/withdraw — 提出取り消し（Phase 8G）
//
// 【背景】提出済みドラフトで四半期処理が失敗した場合（例：営業人員の配分合計が
// 実在人数を超えているエラー）、既存の実装では「提出済みドラフトの編集禁止」
// （CompanyLabDraftAlreadySubmittedError）により、プレイヤーが入力を修正して
// 再提出する経路が存在しなかった（Test13で実際に発生した詰み状態）。本ハンドラーは
// submitDraftの逆操作として、ドラフト本体を変更せずsubmittedAtだけをnullへ戻す。
// ---------------------------------------------------------------------

export async function handleWithdrawDraft(deps: CompanyLabApiDependencies, labId: string, now: string): Promise<ApiResult> {
  const labIdResult = validateLabId(labId);
  if (!labIdResult.ok) return badRequest(labIdResult.message);

  let currentTurn: number;
  let existingDraftTurnId: string | null;
  let lastProcessedTurnId: string | null;
  try {
    const stored = await deps.repository.loadCurrentState(labId);
    currentTurn = stored.currentState.runtime.scenarioState.currentTurn;
    lastProcessedTurnId = stored.currentState.lastProcessedTurnId ?? null;
    const existingDraft = await deps.repository.loadDraft(labId);
    existingDraftTurnId = existingDraft?.turnId ?? null;
  } catch (e) {
    return mapDomainErrorToHttp(e);
  }
  // submitDraftと同じ導出（提出・取り消しは対になる操作であり、対象turnIdの
  // 決定方法を分けない）。
  const derivedTurnId = resolveInFlightTurnId({ currentTurn, draftTurnId: existingDraftTurnId, lastProcessedTurnId });

  try {
    const envelope = await deps.service.withdrawDraft({ labId, turnId: derivedTurnId, now });
    return { status: 200, body: { draft: toDraftSummaryDto(envelope) } };
  } catch (e) {
    return mapDomainErrorToHttp(e);
  }
}

// ---------------------------------------------------------------------
// POST /api/v2/company-labs/[labId]/process-quarter — 四半期処理（§6.5）
// ---------------------------------------------------------------------

export async function handleProcessQuarter(deps: CompanyLabApiDependencies, labId: string, rawBody: unknown, now: string): Promise<ApiResult> {
  const labIdResult = validateLabId(labId);
  if (!labIdResult.ok) return badRequest(labIdResult.message);
  const bodyResult = validateProcessQuarterRequestBody(rawBody);
  if (!bodyResult.ok) return badRequest(bodyResult.message);

  let currentTurn: number;
  let existingDraftTurnId: string | null;
  let lastProcessedTurnId: string | null;
  try {
    const stored = await deps.repository.loadCurrentState(labId);
    currentTurn = stored.currentState.runtime.scenarioState.currentTurn;
    lastProcessedTurnId = stored.currentState.lastProcessedTurnId ?? null;
    const existingDraft = await deps.repository.loadDraft(labId);
    existingDraftTurnId = existingDraft?.turnId ?? null;
  } catch (e) {
    return mapDomainErrorToHttp(e);
  }
  // 【冪等性の要】コミット成功後は draft が原子的に削除され currentTurn が
  // 次へ進むため、単純にcurrentTurnから再導出すると「応答が失われて再送された」
  // ケースで別turn（次の未draft turn）を指してしまい、DRAFT_NOT_FOUNDへ
  // 誤って倒れる（実装中にhandlers.test.tsで実際に検出した設計不備。
  // turnId.tsのコメント・resolveInFlightTurnId参照）。draft存在時はそのturnId、
  // draft不在時は直近確定turnIdを優先することで、再送を正しく
  // Application Service層のalreadyProcessed判定へ到達させる。
  const derivedTurnId = resolveInFlightTurnId({ currentTurn, draftTurnId: existingDraftTurnId, lastProcessedTurnId });

  if (bodyResult.value.turnId !== undefined && bodyResult.value.turnId !== derivedTurnId) {
    return {
      status: 409,
      body: {
        error: {
          code: "TURN_MISMATCH",
          message: `指定されたturnId(${bodyResult.value.turnId})は、現在処理対象のturn(${derivedTurnId})と一致しません。`,
        },
      },
    };
  }

  try {
    // lockTokenはリクエスト（試行）ごとに新規生成する。turnIdによる冪等性
    // （§6.1・processQuarter内部の判定）は、リクエストごとに異なるlockTokenを
    // 使っても損なわれない（同一turnIdの再試行は、ロック取得より前に冪等判定
    // されるため。companyLabQuarterFlowService.ts step 2参照）。
    // 【Phase 8C-3B】playerCompanyIdはここでは一切指定しない。Application Service
    // 層がラボ作成時に保存されたstored.playerCompanyIdを唯一の正として使う
    // （8C-3A時点のBAL固定/先頭会社fallbackを廃止。指示§6「処理requestごとに
    // 別会社へ差し替えられない」）。
    const result = await deps.service.processQuarter({
      labId,
      turnId: derivedTurnId,
      lockToken: randomUUID(),
      now,
      lockTtlMilliseconds: DEFAULT_PROCESSING_LOCK_TTL_MS,
      decisionsProvider: buildApiDecisionsProvider(labId),
    });
    // §6.5「冪等再試行時にalreadyProcessedを正常応答として返す」: statusが
    // "alreadyProcessed"でも200（エラーではない）で返す。
    return {
      status: 200,
      body: {
        status: result.status,
        revision: result.revision,
        turn: result.historyEntry.turn,
        turnId: result.historyEntry.turnId,
        processedAt: result.historyEntry.processedAt,
      },
    };
  } catch (e) {
    return mapDomainErrorToHttp(e);
  }
}

// ---------------------------------------------------------------------
// GET /api/v2/company-labs/[labId]/history — 履歴ページング取得（§6.6）
// ---------------------------------------------------------------------

export async function handleGetHistoryPage(deps: CompanyLabApiDependencies, labId: string, searchParams: URLSearchParams): Promise<ApiResult> {
  const labIdResult = validateLabId(labId);
  if (!labIdResult.ok) return badRequest(labIdResult.message);
  const queryResult = validateHistoryQuery(searchParams);
  if (!queryResult.ok) return badRequest(queryResult.message);

  try {
    // loadFullHistoryは使わず、必ずloadHistoryPage（カーソル方式）を使う
    // （指示§6.6・8C-2指示§9。1件あたり最大約2.5MBになりうる履歴を無制限に
    // 返さないため）。
    const page = await deps.repository.loadHistoryPage(labId, queryResult.value);
    return {
      status: 200,
      body: { entries: page.entries.map(toHistoryEntrySummaryDto), nextAfterTurn: page.nextAfterTurn },
    };
  } catch (e) {
    return mapDomainErrorToHttp(e);
  }
}

// ---------------------------------------------------------------------
// GET /api/v2/company-labs/[labId]/history/[turn] — 単一履歴エントリ全体取得（診断用。§6.6）
// ---------------------------------------------------------------------

export async function handleGetHistoryEntry(deps: CompanyLabApiDependencies, labId: string, turnParam: string): Promise<ApiResult> {
  const labIdResult = validateLabId(labId);
  if (!labIdResult.ok) return badRequest(labIdResult.message);
  const turnResult = validateTurnParam(turnParam);
  if (!turnResult.ok) return badRequest(turnResult.message);

  try {
    // 【診断用途専用】このエンドポイントだけがCompanyLabQuarterHistoryEntry全体
    // （pre/postProcessingStateSnapshot・record含む、1件あたり最大約2.5MB）を返す。
    // 通常の一覧・状態取得（handleListLabs/handleGetLabState/handleGetHistoryPage）は
    // 要約DTOしか返さず、この巨大なペイロードとは経路を分離する（指示§6.2・§6.6）。
    const entry = await deps.repository.loadHistoryEntry(labId, turnResult.value);
    return { status: 200, body: { entry } };
  } catch (e) {
    return mapDomainErrorToHttp(e);
  }
}
