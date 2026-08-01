// ShrimpX V2 — Standard AI経営説明レポートAPI ハンドラー本体（MVP）
//
// フレームワーク（NextRequest/NextResponse）に依存しない純粋な非同期関数群
// （既存の app/api/v2/company-labs/_lib/handlers.ts と同じ設計方針）。
//
// 【状態の取得元】この機能は「プレイヤー画面が既に見ている範囲」しか扱わない
// （実装指示の制約）。app/v2/company-lab/play/_lib/viewModel.ts の
// loadPlayerScreenViewModel をそのまま再利用し、fixture・ownState・publicInfo・
// currentTurn・playerCompanyId をそこから取得する。二重の状態読み込み経路は作らない。
//
// 【対応範囲の限定（実装指示からの逸脱点）】loadPlayerScreenViewModel は
// プレイヤー会社1社ぶんの状態しか返さない（他社の非公開情報を返す経路がそもそも
// 存在しない）ため、本APIも companyId はプレイヤー会社と一致する場合のみ対応する。
// また、この会社ラボの永続化状態は「現在のturn」の情報のみを保持し、過去turnの
// 完全な状態（fixture/ownState/publicInfo）を再構築する経路は用意されていないため、
// turnパラメータも現在のturnと一致する場合のみ対応する。それ以外は404として扱う。
//
// 【diagnosticsの取得】loadPlayerScreenViewModelはeditingフェーズかつ未保存の場合のみ
// aiProposalDiagnosticsを設定する。submitted/completedフェーズの場合は、viewModelが
// 既に返しているfixture/ownState/publicInfo/period/turn（＝プレイヤー画面が見ている
// のと全く同じ入力）に対して、SAI-1のエントリポイントである
// generateStandardAiDecisionWithDiagnosticsをもう一度呼ぶだけ（純粋関数の再呼び出し。
// 新しい状態読み込み経路ではない）。

import {
  loadPlayerScreenViewModel,
  PlayerScreenViewModel,
} from "../../../../../../../../../../v2/company-lab/play/_lib/viewModel";
import { generateStandardAiDecisionWithDiagnostics, StandardAiQuarterDiagnostics } from "../../../../../../../../../../lib/v2/companyLab/standardAi/policy";
import { buildExplanationContext, ExplanationContext } from "../../../../../../../../../../lib/v2/companyLab/aiExplanation/buildExplanationContext";
import { buildExplanationCacheKey, computeContextHash, loadCachedReport, saveReport, StoredExplanationReport } from "../../../../../../../../../../lib/v2/companyLab/aiExplanation/reportCache";
import {
  AnthropicMessagesClient,
  generateManagementReport,
} from "../../../../../../../../../../lib/v2/companyLab/aiExplanation/claudeClient";
import { AiExplanationApiDependencies } from "./dependencies";

export type AiExplanationApiResult = { readonly status: number; readonly body: unknown };

function notFound(message: string): AiExplanationApiResult {
  return { status: 404, body: { error: { code: "NOT_FOUND", message } } };
}

function badRequest(message: string): AiExplanationApiResult {
  return { status: 400, body: { error: { code: "INVALID_REQUEST", message } } };
}

interface ResolvedRequestContext {
  readonly viewModel: PlayerScreenViewModel;
  readonly diagnostics: StandardAiQuarterDiagnostics;
  readonly context: ExplanationContext;
  readonly contextHash: string;
  readonly cacheKey: string;
}

type ResolveResult = { readonly kind: "ok"; readonly value: ResolvedRequestContext } | { readonly kind: "error"; readonly result: AiExplanationApiResult };

/** viewModel取得〜ExplanationContext・キャッシュキー組み立てまでの共通処理（GET/POST共用）。 */
async function resolveRequestContext(
  deps: AiExplanationApiDependencies,
  labId: string,
  companyId: string,
  turnParam: string
): Promise<ResolveResult> {
  const loaded = await loadPlayerScreenViewModel(deps, labId);
  if (loaded.kind === "notFound") {
    return { kind: "error", result: notFound(`会社ラボ "${labId}" が見つかりません。`) };
  }
  const viewModel = loaded.viewModel;

  if (viewModel.playerCompanyId !== companyId) {
    // 【実装指示からの逸脱点】このMVPはプレイヤー会社1社ぶんの状態しか取得できない
    // （viewModel自体がそれ以外の会社の非公開情報を持たない）。
    return {
      kind: "error",
      result: notFound(`会社 "${companyId}" は、この会社ラボのAI経営説明機能の対象外です（プレイヤー会社のみ対応）。`),
    };
  }

  const turn = Number(turnParam);
  if (!Number.isInteger(turn) || turn < 1) {
    return { kind: "error", result: badRequest("turn は1以上の整数である必要があります。") };
  }
  if (turn !== viewModel.currentTurn) {
    return {
      kind: "error",
      result: notFound(`この会社ラボの現在のturnは${viewModel.currentTurn}です。turn ${turn}の状態は保持されていません。`),
    };
  }

  const diagnostics: StandardAiQuarterDiagnostics =
    viewModel.aiProposalDiagnostics ??
    generateStandardAiDecisionWithDiagnostics(viewModel.fixture, viewModel.ownState, viewModel.publicInfo, viewModel.period, viewModel.currentTurn).diagnostics;

  const context = buildExplanationContext({
    labId: viewModel.labId,
    companyId: viewModel.playerCompanyId,
    turn: viewModel.currentTurn,
    period: viewModel.period,
    scenarioId: viewModel.scenarioId,
    fixture: viewModel.fixture,
    ownState: viewModel.ownState,
    publicInfo: viewModel.publicInfo,
    diagnostics,
  });

  const contextHash = computeContextHash(context);
  const cacheKey = buildExplanationCacheKey({
    labId: viewModel.labId,
    companyId: viewModel.playerCompanyId,
    turn: viewModel.currentTurn,
    promptVersion: context.identity.promptVersion,
    contextSchemaVersion: context.identity.contextSchemaVersion,
    contextHash,
  });

  return { kind: "ok", value: { viewModel, diagnostics, context, contextHash, cacheKey } };
}

/**
 * POST: キャッシュ済みレポートがあればそれを返し（Claudeを呼び直さない）、
 * 無ければ生成して結果（成功・失敗のいずれも）をキャッシュへ保存してから返す。
 *
 * anthropicClient はテスト用のモック注入口（省略時は claudeClient.ts が
 * ANTHROPIC_API_KEY から実クライアントを組み立てる）。
 */
export async function handlePostAiExplanation(
  deps: AiExplanationApiDependencies,
  labId: string,
  companyId: string,
  turnParam: string,
  now: string,
  anthropicClient?: AnthropicMessagesClient
): Promise<AiExplanationApiResult> {
  const logPrefix = `[ai-explanation handlePost] lab=${labId} company=${companyId} turn=${turnParam}`;
  console.log(`${logPrefix} 開始`);

  const resolved = await resolveRequestContext(deps, labId, companyId, turnParam);
  if (resolved.kind === "error") {
    console.log(`${logPrefix} resolveRequestContextでエラー応答 status=${resolved.result.status}`);
    return resolved.result;
  }
  const { context, cacheKey } = resolved.value;
  console.log(`${logPrefix} context構築完了 cacheKey=${cacheKey} diagnosticEntries=${context.standardAi.diagnosticEntries.length}`);

  // 【キャッシュ読み取り失敗への耐性】タイムアウト等でキャッシュ参照自体が失敗しても、
  // 「キャッシュミス」として扱い、Claude生成へフォールバックする（キャッシュ層の不調で
  // レポート生成全体が止まらないようにする）。
  let cached: StoredExplanationReport | null = null;
  try {
    cached = await loadCachedReport(deps.redisClient, cacheKey);
  } catch (e) {
    console.error(`${logPrefix} キャッシュ参照に失敗（キャッシュミス扱いで続行）:`, e instanceof Error ? e.message : String(e));
  }
  // 【2026-08-01・result="failure"の既存キャッシュはヒットとして扱わない】このコード自身は
  // 今後失敗結果を新たに保存しなくなったが、それより前に保存された失敗結果（TTLなしで
  // 無期限にRedisに残っている）は、このデプロイ後も残ったまま。実際に2026-08-01 08:00 UTC
  // 台のschema_mismatch失敗が、この修正を含むデプロイ後（09:47〜09:51 UTC）でも
  // 「キャッシュヒットのため応答（Claude呼び出しなし）」としてそのまま返り続けることを
  // Vercelランタイムログで確認した。「新たに書かない」だけでは既存の不良データを
  // 治せないため、読み取り側でも result==="failure" のキャッシュはヒットとして
  // 扱わない（キャッシュミスとして無条件にClaudeを呼び直す）よう変更する。
  if (cached !== null && cached.result === "failure") {
    console.log(`${logPrefix} キャッシュに失敗結果が残っていましたが、ヒットとして扱わずClaudeを呼び直します category=${cached.errorCategory}`);
    cached = null;
  }
  if (cached !== null) {
    console.log(`${logPrefix} キャッシュヒットのため応答（Claude呼び出しなし）`);
    return { status: 200, body: { cached: true, cacheKey, ...cached } };
  }
  console.log(`${logPrefix} キャッシュミス。Claude呼び出しを開始します`);

  const generated = await generateManagementReport(context, anthropicClient);
  console.log(`${logPrefix} Claude呼び出し完了 ok=${generated.ok}${generated.ok ? "" : ` category=${generated.errorCategory}`}`);

  const stored: StoredExplanationReport = generated.ok
    ? {
        generatedAt: now,
        result: "success",
        report: generated.report,
        model: generated.usage.model,
        promptVersion: context.identity.promptVersion,
        contextSchemaVersion: context.identity.contextSchemaVersion,
        contextHash: resolved.value.contextHash,
      }
    : {
        generatedAt: now,
        result: "failure",
        errorCategory: generated.errorCategory,
        model: context.identity.model,
        promptVersion: context.identity.promptVersion,
        contextSchemaVersion: context.identity.contextSchemaVersion,
        contextHash: resolved.value.contextHash,
      };

  // 【2026-08-01・失敗結果は永続キャッシュしない】従来は成功・失敗いずれの結果も
  // 同じcacheKey（labId:companyId:turn:promptVersion:contextSchemaVersion:contextHash）で
  // 無期限にRedisへ保存していた。しかしcontextHashはStandard AIの提案・診断・自社状態・
  // 公開市場情報だけで決まり、Claude呼び出しの一時的な不調（invalid_json/schema_mismatch/
  // 空応答等）では変化しない。そのため一度でも失敗すると、同一turn・同一状態のままでは
  // 何度リロードしても同じcacheKeyの「失敗」が永久にヒットし続け、コード側の不具合修正後や
  // Claude側の一時的な不調が解消した後でも再試行する手段が無かった（この不具合そのものが
  // Zodスキーマ不一致調査を妨げていた）。失敗結果はレスポンスとしてはそのまま返すが、
  // Redisへは保存しない（＝次回のリクエストで無条件に再度Claudeを呼び直せるようにする）。
  // 成功結果のキャッシュ（「保存済みレポートの再表示ではAPIを再呼び出ししない」という
  // 既存の要件）はそのまま維持する。
  if (generated.ok) {
    try {
      await saveReport(deps.redisClient, cacheKey, stored);
      console.log(`${logPrefix} キャッシュ保存完了`);
    } catch (e) {
      // 【キャッシュ書き込み失敗への耐性】保存に失敗しても、生成済みの成功結果は
      // このリクエストの応答としては返す（次回リクエスト時にまた生成し直すだけであり、
      // UIをブロックする理由にはならない）。
      console.error(`${logPrefix} キャッシュ保存に失敗（結果はそのまま返します）:`, e instanceof Error ? e.message : String(e));
    }
  } else {
    console.log(`${logPrefix} 失敗結果はキャッシュへ保存しません(次回リクエストで再試行可能にするため) category=${generated.errorCategory}`);
  }

  // 失敗時もHTTP自体は200で「構造化された失敗」を返す（呼び出し側が例外ではなく
  // 分岐でフォールバック表示できるようにするため。実装指示「API失敗時も
  // 構造化された（例外を投げない）応答を返す」に対応）。
  console.log(`${logPrefix} 応答を返します result=${stored.result}`);
  return { status: 200, body: { cached: false, cacheKey, ...stored } };
}

/** GET: 読み取り専用。現在のturn・現在のExplanationContextに対応するキャッシュ済みレポートがあれば返す。副作用なし。 */
export async function handleGetAiExplanation(
  deps: AiExplanationApiDependencies,
  labId: string,
  companyId: string,
  turnParam: string
): Promise<AiExplanationApiResult> {
  const logPrefix = `[ai-explanation handleGet] lab=${labId} company=${companyId} turn=${turnParam}`;
  console.log(`${logPrefix} 開始`);

  const resolved = await resolveRequestContext(deps, labId, companyId, turnParam);
  if (resolved.kind === "error") {
    console.log(`${logPrefix} resolveRequestContextでエラー応答 status=${resolved.result.status}`);
    return resolved.result;
  }
  const { cacheKey } = resolved.value;

  let cached: StoredExplanationReport | null = null;
  try {
    cached = await loadCachedReport(deps.redisClient, cacheKey);
  } catch (e) {
    console.error(`${logPrefix} キャッシュ参照に失敗（未生成として応答）:`, e instanceof Error ? e.message : String(e));
  }
  // 【2026-08-01・result="failure"の既存キャッシュは「生成済み」として返さない】POST側と
  // 同じ理由で、GET（読み取り専用・副作用なし）でも失敗結果は「まだ生成されていない」
  // 扱いにする。呼び出し元がGET結果を「保存済みの正しいレポート」と誤認しないようにする。
  if (cached !== null && cached.result === "failure") {
    console.log(`${logPrefix} キャッシュに失敗結果が残っていましたが、生成済みとしては扱いません category=${cached.errorCategory}`);
    cached = null;
  }
  if (cached === null) {
    console.log(`${logPrefix} キャッシュなし`);
    return notFound("この四半期のAI経営説明レポートはまだ生成されていません。");
  }
  console.log(`${logPrefix} キャッシュヒット`);
  return { status: 200, body: { cached: true, cacheKey, ...cached } };
}
