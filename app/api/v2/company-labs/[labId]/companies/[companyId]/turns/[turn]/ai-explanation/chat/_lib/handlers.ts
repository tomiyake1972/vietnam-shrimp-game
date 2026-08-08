// ShrimpX V2 — 「Standard AIに質問する」対話機能（Phase 1 MVP） APIハンドラー本体
//
// 【既存Explanation APIとの共通化（実装指示§11）】状態の読み込み・ExplanationContextの
// 組み立て・turn/companyIdの妥当性判定は、親ディレクトリの handlers.ts の
// resolveRequestContext をそのまま再利用する（重複実装しない）。認証・依存関係も
// 親の withApiContext / dependencies をそのまま使う。
// one-shot explanation と interactive Q&A は役割が違うため、エンドポイントだけ分ける。
//
// 【この機能が絶対にしないこと】
//   - Standard AIのdecisionを書き換えない（このハンドラーはdecisionを読むだけで返さない）。
//   - Standard AIを再計算して別の値を作らない（resolveRequestContextが返す
//     diagnostics.decision をそのまま説明対象にする）。
//   - what-if / 反実仮想の計算をしない。

import { CompanyLabRedisClient } from "../../../../../../../../../../../lib/v2/redis/companyLabTypes";
import { AiExplanationApiDependencies } from "../../_lib/dependencies";
import { AiExplanationApiResult, resolveRequestContext } from "../../_lib/handlers";
import {
  buildStandardAiChatContext,
  computeChatContextHash,
} from "../../../../../../../../../../../lib/v2/companyLab/aiExplanation/chat/chatContext";
import { AnthropicMessagesClient } from "../../../../../../../../../../../lib/v2/companyLab/aiExplanation/claudeClient";
import {
  CHAT_MAX_HISTORY_TURNS,
  CHAT_MAX_QUESTION_LENGTH,
  ChatHistoryTurn,
  generateStandardAiChatAnswer,
  getChatModelConfig,
} from "../../../../../../../../../../../lib/v2/companyLab/aiExplanation/chat/chatClient";
import {
  appendHumanChallengeRecord,
  buildHumanChallengeRecord,
} from "../../../../../../../../../../../lib/v2/companyLab/aiExplanation/chat/challengeLog";

function badRequest(message: string): AiExplanationApiResult {
  return { status: 400, body: { error: { code: "INVALID_REQUEST", message } } };
}

export interface AiExplanationChatRequestBody {
  readonly question?: unknown;
  readonly history?: unknown;
  /**
   * 【Context固定（実装指示§10）】クライアントが最初の質問時に受け取ったcontextHash。
   * 現在のstateから算出したhashと一致しない場合は、チャット途中でゲームstateが
   * 変わったことを意味するため、別状態を混ぜずに409で明示的に知らせる。
   * 省略可（最初の質問時はまだ持っていない）。
   */
  readonly expectedContextHash?: unknown;
}

/** リクエストbodyの検証。自由文だが、長さ・件数・型は厳格に制限する（§13・§22）。 */
function parseBody(body: unknown): { readonly ok: true; readonly question: string; readonly history: readonly ChatHistoryTurn[]; readonly expectedContextHash: string | null } | { readonly ok: false; readonly result: AiExplanationApiResult } {
  if (body === null || typeof body !== "object") {
    return { ok: false, result: badRequest("リクエストボディが不正です。") };
  }
  const b = body as AiExplanationChatRequestBody;

  if (typeof b.question !== "string") {
    return { ok: false, result: badRequest("question は文字列である必要があります。") };
  }
  const question = b.question.trim();
  if (question.length === 0) {
    return { ok: false, result: badRequest("質問を入力してください。") };
  }
  if (question.length > CHAT_MAX_QUESTION_LENGTH) {
    return { ok: false, result: badRequest(`質問は${CHAT_MAX_QUESTION_LENGTH}文字以内で入力してください。`) };
  }

  const history: ChatHistoryTurn[] = [];
  if (b.history !== undefined) {
    if (!Array.isArray(b.history)) {
      return { ok: false, result: badRequest("history は配列である必要があります。") };
    }
    for (const item of b.history) {
      if (item === null || typeof item !== "object") continue;
      const h = item as { question?: unknown; answerConclusion?: unknown };
      if (typeof h.question !== "string" || typeof h.answerConclusion !== "string") continue;
      history.push({
        question: h.question.slice(0, CHAT_MAX_QUESTION_LENGTH),
        answerConclusion: h.answerConclusion.slice(0, CHAT_MAX_QUESTION_LENGTH),
      });
    }
  }

  const expectedContextHash = typeof b.expectedContextHash === "string" ? b.expectedContextHash : null;

  // 【履歴上限（§9）】直近CHAT_MAX_HISTORY_TURNS往復だけを保持する。
  return { ok: true, question, history: history.slice(-CHAT_MAX_HISTORY_TURNS), expectedContextHash };
}

/**
 * POST: 指定Turnのstandard AI判断について、1件の質問へ回答する。
 * 失敗しても例外を投げず、必ず構造化された結果を返す（Explanation層と同じ方針）。
 */
export async function handlePostAiExplanationChat(
  deps: AiExplanationApiDependencies,
  labId: string,
  companyId: string,
  turnParam: string,
  body: unknown,
  now: string,
  anthropicClient?: AnthropicMessagesClient
): Promise<AiExplanationApiResult> {
  const logPrefix = `[ai-explanation-chat handlePost] lab=${labId} company=${companyId} turn=${turnParam}`;

  const parsed = parseBody(body);
  if (!parsed.ok) return parsed.result;

  const resolved = await resolveRequestContext(deps, labId, companyId, turnParam);
  if (resolved.kind === "error") {
    console.log(`${logPrefix} resolveRequestContextでエラー応答 status=${resolved.result.status}`);
    return resolved.result;
  }

  const chatContext = buildStandardAiChatContext(resolved.value.context, resolved.value.diagnostics);
  const contextHash = computeChatContextHash(chatContext);

  // 【Context固定（§10・§24-12）】チャット途中でstateが変わった場合、前Turn・別stateの
  // contextで回答してしまわないよう、ここで明示的に検出して拒否する。
  if (parsed.expectedContextHash !== null && parsed.expectedContextHash !== contextHash) {
    console.log(`${logPrefix} contextHash不一致のため拒否（stateが変化しました）`);
    return {
      status: 409,
      body: {
        error: {
          code: "CONTEXT_CHANGED",
          message: "ゲームの状態が変化したため、この会話は続けられません。画面を再読み込みしてから質問し直してください。",
        },
        contextHash,
      },
    };
  }

  const generated = await generateStandardAiChatAnswer(
    { context: chatContext, question: parsed.question, history: parsed.history, contextHash },
    anthropicClient
  );

  // 【Human Challenge Log（§18・§19）】成功・失敗いずれも記録する（失敗も改善の材料）。
  // 保存の成否は回答に影響させない。
  await recordChallengeSafely(deps.redisClient, {
    labId: resolved.value.viewModel.labId,
    companyId: resolved.value.viewModel.playerCompanyId,
    turn: resolved.value.viewModel.currentTurn,
    contextHash,
    chatPromptVersion: chatContext.chatPromptVersion,
    chatContextSchemaVersion: chatContext.chatContextSchemaVersion,
    model: getChatModelConfig().model,
    question: parsed.question,
    answer: generated.ok ? generated.answer : null,
    errorCategory: generated.ok ? null : generated.errorCategory,
    timestamp: now,
  });

  if (!generated.ok) {
    console.log(`${logPrefix} 失敗として応答 category=${generated.errorCategory}`);
    // HTTP自体は200で「構造化された失敗」を返す（UIが例外ではなく分岐で扱えるようにする）。
    return { status: 200, body: { result: "failure", errorCategory: generated.errorCategory, contextHash } };
  }

  return {
    status: 200,
    body: {
      result: "success",
      answer: generated.answer,
      contextHash,
      chatPromptVersion: chatContext.chatPromptVersion,
      model: generated.usage.model,
      generatedAt: now,
    },
  };
}

async function recordChallengeSafely(
  redisClient: CompanyLabRedisClient,
  input: Parameters<typeof buildHumanChallengeRecord>[0]
): Promise<void> {
  try {
    await appendHumanChallengeRecord(redisClient, buildHumanChallengeRecord(input));
  } catch (e) {
    // appendHumanChallengeRecord自体が例外を投げない設計だが、多重防御としてここでも捕捉する。
    console.error("[ai-explanation-chat] challenge log記録で予期しない例外:", e instanceof Error ? e.message : String(e));
  }
}
