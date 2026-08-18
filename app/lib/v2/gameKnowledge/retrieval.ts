// ShrimpX V2 — Shared Game Knowledge Registry: 検索（実装指示§27・§28・§29・§34）
//
// 【MVPではEmbedding/RAGを使わない】keywords / domain / question intent による
// 決定論的な軽量検索にする。同じ質問には常に同じ知識が返る（再現性・監査性）。
//
// 【token予算】1質問あたり Top N（既定6件）まで。全文Manualは絶対に入れない。

import { GAME_KNOWLEDGE_ENTRIES } from "./entries";
import { buildDynamicValueMap, DEFAULT_GAME_KNOWLEDGE_PARAMETERS, GameKnowledgeParameterSources, resolveText } from "./dynamicValues";
import { KnowledgeDomain, KnowledgeEntry, KnowledgeRetrievalResult, KnowledgeRole, QuestionIntent, ResolvedKnowledgeEntry } from "./types";

/** 実装指示§34。1質問あたりに注入する知識の既定上限。 */
export const DEFAULT_KNOWLEDGE_TOP_N = 6;

/** 実装指示§27。roleごとに主担当となるdomain。 */
const ROLE_DOMAINS: Readonly<Record<KnowledgeRole, readonly KnowledgeDomain[]>> = {
  COMMERCIAL: ["SALES", "CONTRACT", "QUALITY_TRUST"],
  COO: ["PRODUCTION", "LABOR", "CAPACITY", "PROCUREMENT", "CAPEX"],
  CFO: ["FINANCE", "CAPEX"],
  // CEOは全domainを横断できる（要約役のため）。
  CEO: ["SALES", "LABOR", "PRODUCTION", "CAPACITY", "PROCUREMENT", "CONTRACT", "FINANCE", "CAPEX", "QUALITY_TRUST", "STANDARD_AI"],
};

/**
 * 質問意図の分類（実装指示§29）。
 * ルールを問う語・現況を問う語の両方があればMIXED。
 */
const RULE_MARKERS = [
  "ルール", "仕組み", "どう決ま", "どうやって決", "定義", "とは", "何ですか", "なんですか", "いつ", "どれくらい", "どのくらい", "何人", "何トン",
  "一人当たり", "1人当たり", "計算", "式", "リードタイム", "タイミング", "why", "how", "what is", "rule", "formula", "definition", "when",
];
const STATE_MARKERS = [
  "当社", "うち", "今期", "現在", "いま", "今の", "先期", "前期", "実績", "今Turn", "このturn", "我々", "自社",
  "current", "this quarter", "our ", "now",
];
const STRATEGY_MARKERS = ["すべき", "べきか", "どうする", "戦略", "提案", "おすすめ", "方針", "判断", "should", "strategy", "recommend"];

function containsAny(text: string, markers: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return markers.some((m) => lower.includes(m.toLowerCase()));
}

export function classifyQuestionIntent(question: string): QuestionIntent {
  const rule = containsAny(question, RULE_MARKERS);
  const state = containsAny(question, STATE_MARKERS);
  const strategy = containsAny(question, STRATEGY_MARKERS);
  if (rule && state) return "MIXED";
  if (rule) return "GAME_RULE";
  if (strategy) return "STRATEGY";
  if (state) return "CURRENT_STATE";
  // どのマーカーも無い短い質問は、ルール説明を添えても害が無いためMIXED扱いにする。
  return "MIXED";
}

/** キーワード一致数に、title一致・domain名一致のボーナスを加えた素朴なスコア。 */
function scoreEntry(entry: KnowledgeEntry, question: string): number {
  const lower = question.toLowerCase();
  let score = 0;
  for (const keyword of entry.keywords) {
    if (lower.includes(keyword.toLowerCase())) score += keyword.length >= 4 ? 3 : 2;
  }
  if (lower.includes(entry.title.toLowerCase())) score += 5;
  return score;
}

/**
 * 【M2.8.1 RC-1の修正】roleは「除外条件」ではなく「順位付けの選好」。
 *
 * M2.8では role を hard AND filter にしていたため、たとえば
 * 「営業1人当たり何トン？」をCFOが受けると SALES domain が丸ごと除外され、
 * 注入知識が **0件** になっていた（実測: Q1[CFO] ids=[]）。
 * 知識ゼロで回答させた結果、Claudeがbriefingの売上÷営業人数という
 * 存在しないルールを逆算した。ゲームルールの正しさはroleに依存しないため、
 * roleは加点のみに使い、最良一致entryを落とさない。
 */
function roleBonus(entry: KnowledgeEntry, role: KnowledgeRole | undefined): number {
  if (!role) return 0;
  let bonus = 0;
  if (ROLE_DOMAINS[role].includes(entry.domain)) bonus += 4;
  if (entry.appliesToRoles.includes(role)) bonus += 2;
  return bonus;
}

export interface RetrieveKnowledgeInput {
  readonly question: string;
  /** 指定するとそのroleの担当domainのみへ絞る（実装指示§27）。 */
  readonly role?: KnowledgeRole;
  /** 明示的にdomainを絞りたい場合。 */
  readonly domains?: readonly KnowledgeDomain[];
  readonly topN?: number;
  readonly parameters?: GameKnowledgeParameterSources;
}

/** 動的値を解決して ResolvedKnowledgeEntry にする。 */
export function resolveKnowledgeEntry(entry: KnowledgeEntry, parameters: GameKnowledgeParameterSources = DEFAULT_GAME_KNOWLEDGE_PARAMETERS): ResolvedKnowledgeEntry {
  const valueMap = buildDynamicValueMap(parameters);
  const explanation = resolveText(entry.explanation, valueMap, entry.dynamicValues);
  const summary = resolveText(entry.summary, valueMap, entry.dynamicValues);
  return {
    ...entry,
    summary: summary.text,
    explanation: explanation.text,
    resolvedValues: { ...summary.used, ...explanation.used },
  };
}

/**
 * 実装指示§28。質問文から関連する知識をdeterministicに引く。
 * マッチが1件も無い場合は空を返す（無関係な知識で埋めない＝§31の「捏造しない」）。
 */
export function getGameKnowledgeForQuestion(input: RetrieveKnowledgeInput): KnowledgeRetrievalResult {
  const { question, role, domains, topN = DEFAULT_KNOWLEDGE_TOP_N, parameters = DEFAULT_GAME_KNOWLEDGE_PARAMETERS } = input;
  const intent = classifyQuestionIntent(question);

  // domainsの明示指定だけをhard filterとして残す（他Agentからのdomain限定取得用）。
  // roleはhard filterにしない（上記 roleBonus のコメント参照＝M2.8.1 RC-1）。
  const candidates = GAME_KNOWLEDGE_ENTRIES.filter((entry) => {
    if (domains && !domains.includes(entry.domain)) return false;
    return true;
  });

  const scored = candidates
    // キーワード一致が無いentryにrole加点だけで浮上させない（無関係知識で埋めない＝§31）。
    .map((entry) => ({ entry, keywordScore: scoreEntry(entry, question) }))
    .filter((s) => s.keywordScore > 0)
    .map((s) => ({ entry: s.entry, score: s.keywordScore + roleBonus(s.entry, role) }))
    // 同点は id 昇順で決定論的に並べる。
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.entry.id.localeCompare(b.entry.id)));

  const selected = scored.slice(0, topN);
  return {
    intent,
    entries: selected.map((s) => resolveKnowledgeEntry(s.entry, parameters)),
    truncatedCount: Math.max(0, scored.length - selected.length),
  };
}

/** 実装指示§35。domain指定での取得（他Agentからの再利用用）。 */
export function getGameKnowledgeByDomain(
  domain: KnowledgeDomain,
  parameters: GameKnowledgeParameterSources = DEFAULT_GAME_KNOWLEDGE_PARAMETERS
): readonly ResolvedKnowledgeEntry[] {
  return GAME_KNOWLEDGE_ENTRIES.filter((e) => e.domain === domain).map((e) => resolveKnowledgeEntry(e, parameters));
}

/** id指定での取得（structured responseのknowledgeUsedIds検証等に使う）。 */
export function getGameKnowledgeById(id: string, parameters: GameKnowledgeParameterSources = DEFAULT_GAME_KNOWLEDGE_PARAMETERS): ResolvedKnowledgeEntry | null {
  const entry = GAME_KNOWLEDGE_ENTRIES.find((e) => e.id === id);
  return entry ? resolveKnowledgeEntry(entry, parameters) : null;
}

/**
 * プロンプトへ載せるcompactな文字列（実装指示§34）。
 * 全文Manualを入れない代わりに、id / title / explanation / warnings だけを並べる。
 */
export function formatKnowledgeForPrompt(entries: readonly ResolvedKnowledgeEntry[]): string {
  if (entries.length === 0) return "";
  return entries
    .map((entry) => {
      const warnings = entry.semanticWarnings?.length ? `\n  注意: ${entry.semanticWarnings.join(" / ")}` : "";
      return `- [${entry.id}] ${entry.title}\n  ${entry.explanation.split("\n").join("\n  ")}${warnings}\n  （出所: ${entry.sourceReference}）`;
    })
    .join("\n");
}
