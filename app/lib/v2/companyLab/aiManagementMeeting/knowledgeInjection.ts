// ShrimpX V2 — AI Management Meeting × Game Knowledge Registry の接続（Phase M2.8）
//
// 【この薄い層の役割】company-labs経路（api/.../ai-meeting/messages/_lib/handlers.ts）と
// simulation-runs経路（aiManagementMeeting/session.ts、CURRENT PLAYTESTのPlayer
// Workspaceが通る側）の**両方**が、まったく同じ手順でGame Knowledgeを引けるようにする。
// 片方だけがRegistryを使う状態を構造的に作らない（実装指示§41）。
//
// 【Registry本体はドメイン層】検索・動的値解決・目安計算はすべて
// app/lib/v2/gameKnowledge/ にあり、AI Meeting固有のものは何も入っていない
// （実装指示§26。ChatSense等からも同じ関数で再利用できる）。

import {
  DEFAULT_KNOWLEDGE_TOP_N,
  estimateSalesCapacity,
  estimateWorkerRequirement,
  getGameKnowledgeForQuestion,
  KnowledgeRole,
  QuestionIntent,
  ResolvedKnowledgeEntry,
} from "../../gameKnowledge";
import { GameKnowledgeForPrompt } from "./prompt";
import { Product } from "../../market/types";

/** routingHint.primary（"CFO" 等）をKnowledgeRoleへ写す。未知はCEO（全domain可）扱い。 */
export function toKnowledgeRole(speaker: string | null | undefined): KnowledgeRole {
  const upper = String(speaker ?? "").toUpperCase();
  if (upper === "CFO" || upper === "COO" || upper === "CEO") return upper;
  if (upper.startsWith("COMMERCIAL")) return "COMMERCIAL";
  return "CEO";
}

export interface MeetingKnowledgeInjection {
  readonly gameKnowledge: readonly GameKnowledgeForPrompt[];
  readonly gameKnowledgeEstimates: unknown;
  readonly questionIntent: QuestionIntent;
  /** 監査・テスト用（実際に注入したid）。 */
  readonly injectedIds: readonly string[];
  readonly truncatedCount: number;
}

function toPromptEntry(entry: ResolvedKnowledgeEntry): GameKnowledgeForPrompt {
  return {
    id: entry.id,
    domain: entry.domain,
    title: entry.title,
    explanation: entry.explanation,
    semanticWarnings: entry.semanticWarnings,
    sourceReference: entry.sourceReference,
  };
}

/** 質問文から「N人」「Nトン」等の数量を拾う（全角数字・カンマ・単位表記に対応）。 */
function extractNumbers(question: string, unitPattern: RegExp): number[] {
  const normalized = question.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/,/g, "");
  const found: number[] = [];
  for (const match of normalized.matchAll(unitPattern)) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > 0) found.push(value);
  }
  return found;
}

const HEADCOUNT_PATTERN = /(\d+(?:\.\d+)?)\s*(?:人|名|persons?|people|headcount)/gi;
const TONS_PATTERN = /(\d+(?:\.\d+)?)\s*(?:t\b|トン|tons?)/gi;

function detectProduct(question: string): Product | null {
  const lower = question.toLowerCase();
  if (lower.includes("vap")) return "vap";
  if (lower.includes("pd")) return "pd";
  if (lower.includes("hoso")) return "hoso";
  return null;
}

/**
 * 実装指示§8・§10。質問に具体的な数量が含まれる場合だけ、engineの関数で
 * deterministicに目安を計算して同梱する（Claudeに暗算させない）。
 * 該当しない質問ではnullを返し、余計なtokenを使わない。
 */
function buildEstimates(question: string): unknown {
  const estimates: Record<string, unknown> = {};

  // 「営業60人なら何トン？」型
  const headcounts = extractNumbers(question, HEADCOUNT_PATTERN);
  const mentionsSales = /営業|sales/i.test(question);
  if (mentionsSales && headcounts.length > 0) {
    estimates.salesCapacityByHeadcount = headcounts.slice(0, 2).map((h) => estimateSalesCapacity(h));
  }

  // 「PD 1,000tに何人？」型（Workerの必要人数）
  const tons = extractNumbers(question, TONS_PATTERN);
  const mentionsWorker = /worker|ワーカー|作業員|人員|何人|生産/i.test(question);
  const product = detectProduct(question);
  if (mentionsWorker && !mentionsSales && tons.length > 0) {
    const products: Product[] = product ? [product] : ["hoso", "pd", "vap"];
    estimates.workerRequirement = tons.slice(0, 1).flatMap((t) => products.map((p) => estimateWorkerRequirement(t, p)));
  }

  return Object.keys(estimates).length > 0 ? estimates : null;
}

/**
 * プレイヤーの質問から、この応答に必要なGame Knowledgeとdeterministicな目安を組み立てる。
 * 例外を投げない（Knowledge層の失敗でAI Meeting自体を落とさない）。
 */
export function buildMeetingKnowledgeInjection(input: {
  readonly playerMessage: string;
  /** routingHintのprimary speaker。role relevance filteringに使う（実装指示§27）。 */
  readonly primarySpeaker?: string | null;
  readonly topN?: number;
}): MeetingKnowledgeInjection {
  const empty: MeetingKnowledgeInjection = {
    gameKnowledge: [],
    gameKnowledgeEstimates: null,
    questionIntent: "MIXED",
    injectedIds: [],
    truncatedCount: 0,
  };
  try {
    const role = toKnowledgeRole(input.primarySpeaker);
    const retrieval = getGameKnowledgeForQuestion({
      question: input.playerMessage,
      role,
      topN: input.topN ?? DEFAULT_KNOWLEDGE_TOP_N,
    });
    return {
      gameKnowledge: retrieval.entries.map(toPromptEntry),
      gameKnowledgeEstimates: buildEstimates(input.playerMessage),
      questionIntent: retrieval.intent,
      injectedIds: retrieval.entries.map((e) => e.id),
      truncatedCount: retrieval.truncatedCount,
    };
  } catch {
    return empty;
  }
}
