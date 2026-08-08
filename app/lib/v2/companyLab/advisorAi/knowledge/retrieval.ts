// ShrimpX V2 — 相談役AI  Knowledge Retrieval層（実装指示§16・§38）
//
// 【責務分離の目的】相談役AIへ開発文書全文を毎回promptへ入れない。質問に応じて
// 必要なchunkだけを取り出す。MVPでは内部関数だが、後からtool-based retrieval
// （Claudeがツールとして呼ぶ形）へ移行できるよう、次の5つの責務に分けてある。
//
//   searchDevelopmentDocs(query)     … 横断検索（種別を絞らない）
//   getFormalSpecification(topic)    … 現行仕様として使ってよい文書だけ
//   getDevelopmentRationale(topic)   … 「なぜこうしたか」（日誌・設計文書・報告）
//   getRecentDesignDecision(topic)   … 直近の設計判断（日付の新しい順）
//   getTestPlayAnalysis(topic)       … テストプレイ・実測分析
//
// 【スコアリングについて（大規模RAGを導入しない理由：実装指示§58）】
// 日本語の形態素解析器も埋め込みモデルも使わない。日本語はCJK文字のbigram、
// 英数字は単語単位に分割し、chunk内の出現回数で単純にスコアリングする。
// これはBM25の簡略版であり、依存関係を1つも増やさずに済む。
// 「なぜ歩留まりを簡略化したのか」のような具体語を含む質問には十分に機能する。

import { AdvisorDocumentChunk, AdvisorDocumentCorpus, loadDocumentCorpus } from "./docStore";
import { loadSourceCodeCorpus } from "./sourceCodeStore";
import { AdvisorDocumentType, isUsableAsCurrentSpecification } from "./docCatalog";
import { AUTHORITY_RANK } from "../sourceTags";

export interface RetrievedExcerpt {
  readonly path: string;
  readonly title: string;
  readonly heading: string | null;
  readonly documentType: AdvisorDocumentType;
  readonly authority: string;
  readonly sourceType: string;
  readonly documentDate: string | null;
  readonly text: string;
  /** スコア。相談役AIへは渡さない（順位付けの内部値）。デバッグ・テスト用。 */
  readonly score: number;
}

export interface RetrievalResult {
  readonly excerpts: readonly RetrievedExcerpt[];
  /** 検索に失敗した／文書を読めなかった場合の理由。成功時はnull。 */
  readonly unavailableReason: string | null;
  /** 実際に検索対象となった文書数（0なら「参照できなかった」と伝える）。 */
  readonly searchedDocumentCount: number;
}

export interface RetrievalOptions {
  readonly limit?: number;
  /** 対象とする文書種別。未指定なら全種別。 */
  readonly documentTypes?: readonly AdvisorDocumentType[];
  /**
   * 古い資料（authority=HISTORICAL、旧manual・パラメータ仕様書等）を含めるか。
   * 既定false。現行仕様の説明に古い資料を使わないための既定値である（実装指示§27）。
   * 過去経緯を聞かれた場合のみtrueにする。
   */
  readonly includeHistorical?: boolean;
  /** 日付の新しい順を優先するか（getRecentDesignDecision用）。 */
  readonly preferRecent?: boolean;
  /** テスト用のcorpus差し替え。 */
  readonly corpus?: AdvisorDocumentCorpus;
}

const DEFAULT_LIMIT = 6;

/** 検索に使わない一般語（日本語・英語）。これらだけで一致しても意味が無い。 */
const STOP_TOKENS = new Set([
  "して", "する", "した", "され", "この", "その", "あの", "どの", "こと", "もの", "ため", "など", "ます", "です",
  "the", "and", "for", "are", "was", "with", "that", "this", "from", "have", "has",
]);

/**
 * 検索用トークンへ分解する。
 * ・CJK（漢字・ひらがな・カタカナ）は連続部分を取り出して2文字bigramへ
 * ・英数字は3文字以上の単語をそのまま（小文字化）
 */
export function tokenize(text: string): readonly string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();

  for (const m of lower.matchAll(/[a-z0-9_][a-z0-9_.-]{2,}/g)) {
    if (!STOP_TOKENS.has(m[0])) tokens.push(m[0]);
  }
  for (const m of text.matchAll(/[぀-ヿ㐀-鿿ｦ-ﾟ]{2,}/g)) {
    const run = m[0];
    for (let i = 0; i + 2 <= run.length; i++) {
      const bigram = run.slice(i, i + 2);
      if (!STOP_TOKENS.has(bigram)) tokens.push(bigram);
    }
  }
  return tokens;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    count++;
    from = at + needle.length;
  }
  return count;
}

function scoreChunk(chunk: AdvisorDocumentChunk, queryTokens: readonly string[], uniqueTokens: readonly string[]): number {
  const haystack = `${chunk.heading ?? ""}\n${chunk.text}`.toLowerCase();
  const titleHaystack = `${chunk.doc.title}\n${chunk.doc.path}`.toLowerCase();

  let score = 0;
  let matchedTokenCount = 0;
  for (const token of uniqueTokens) {
    const inBody = countOccurrences(haystack, token);
    const inTitle = countOccurrences(titleHaystack, token);
    if (inBody === 0 && inTitle === 0) continue;
    matchedTokenCount++;
    // 出現回数の効きを対数的にして、同じ語の連呼で順位が決まらないようにする。
    score += Math.log1p(inBody) + inTitle * 1.5;
  }
  if (matchedTokenCount === 0) return 0;

  // 一致したトークンの「種類」が多いほど、質問全体を捉えている可能性が高い。
  score *= 1 + matchedTokenCount / Math.max(1, uniqueTokens.length);
  // authorityが高い（正式に近い）文書を優先する。
  score *= 1.3 - 0.1 * AUTHORITY_RANK[chunk.doc.authority];
  void queryTokens;
  return score;
}

function compareByDateDesc(a: RetrievedExcerpt, b: RetrievedExcerpt): number {
  const av = a.documentDate ?? "";
  const bv = b.documentDate ?? "";
  if (av === bv) return b.score - a.score;
  return bv.localeCompare(av);
}

/**
 * 横断検索（実装指示§16 searchDevelopmentDocs）。
 * 文書を読めなかった場合も例外を投げず、unavailableReason付きで空の結果を返す。
 */
export function searchDevelopmentDocs(query: string, options: RetrievalOptions = {}): RetrievalResult {
  const corpus = options.corpus ?? loadDocumentCorpus();
  if (corpus.loadError !== null) {
    return { excerpts: [], unavailableReason: `開発文書を読み込めませんでした: ${corpus.loadError}`, searchedDocumentCount: 0 };
  }
  if (corpus.documents.length === 0) {
    return { excerpts: [], unavailableReason: "参照可能な開発文書が1件もありません。", searchedDocumentCount: 0 };
  }

  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    return { excerpts: [], unavailableReason: null, searchedDocumentCount: corpus.documents.length };
  }
  const uniqueTokens = [...new Set(queryTokens)];

  const typeFilter = options.documentTypes ? new Set(options.documentTypes) : null;
  const includeHistorical = options.includeHistorical ?? false;

  const scored: RetrievedExcerpt[] = [];
  for (const chunk of corpus.chunks) {
    if (typeFilter && !typeFilter.has(chunk.doc.documentType)) continue;
    // 【stale document対策】既定では古い資料を除外する。
    if (!includeHistorical && chunk.doc.authority === "HISTORICAL") continue;
    const score = scoreChunk(chunk, queryTokens, uniqueTokens);
    if (score <= 0) continue;
    scored.push({
      path: chunk.doc.path,
      title: chunk.doc.title,
      heading: chunk.heading,
      documentType: chunk.doc.documentType,
      authority: chunk.doc.authority,
      sourceType: chunk.doc.sourceType,
      documentDate: chunk.doc.documentDate,
      text: chunk.text,
      score,
    });
  }

  scored.sort(options.preferRecent ? compareByDateDesc : (a, b) => b.score - a.score);

  // 同じ文書ばかりで埋まらないよう、1文書あたり最大2chunkに制限する。
  const perDoc = new Map<string, number>();
  const limited: RetrievedExcerpt[] = [];
  const limit = options.limit ?? DEFAULT_LIMIT;
  for (const excerpt of scored) {
    const used = perDoc.get(excerpt.path) ?? 0;
    if (used >= 2) continue;
    perDoc.set(excerpt.path, used + 1);
    limited.push(excerpt);
    if (limited.length >= limit) break;
  }

  return { excerpts: limited, unavailableReason: null, searchedDocumentCount: corpus.documents.length };
}

/**
 * 現行仕様として提示してよい文書だけを引く（実装指示§12・§16）。
 * 古いmanual・パラメータ仕様書（authority=HISTORICAL）は構造的に除外される。
 */
export function getFormalSpecification(topic: string, options: RetrievalOptions = {}): RetrievalResult {
  const result = searchDevelopmentDocs(topic, {
    ...options,
    includeHistorical: false,
    documentTypes: options.documentTypes ?? ["ARCHITECTURE_SPEC", "DESIGN_DOC", "OPERATIONS", "PHASE_REPORT"],
  });
  // 二重防御: 万一HISTORICALが混ざっても現行仕様としては返さない。
  return {
    ...result,
    excerpts: result.excerpts.filter((e) =>
      isUsableAsCurrentSpecification({ authority: e.authority as never, documentType: e.documentType, sourceType: e.sourceType as never, note: "" })
    ),
  };
}

/** 「なぜこの仕様にしたのか」の根拠を引く（実装指示§16・§19・§44）。 */
export function getDevelopmentRationale(topic: string, options: RetrievalOptions = {}): RetrievalResult {
  return searchDevelopmentDocs(topic, {
    ...options,
    // 経緯の説明なので古い資料も対象にしてよい（現行仕様の説明には使わない）。
    includeHistorical: options.includeHistorical ?? true,
    documentTypes: options.documentTypes ?? ["DEVELOPMENT_DIARY", "DESIGN_DOC", "PHASE_REPORT", "TESTPLAY_ANALYSIS", "KNOWLEDGE_BASE"],
  });
}

/** 直近の設計判断を、日付の新しい順で引く（実装指示§16）。 */
export function getRecentDesignDecision(topic: string, options: RetrievalOptions = {}): RetrievalResult {
  return searchDevelopmentDocs(topic, {
    ...options,
    preferRecent: true,
    includeHistorical: false,
    documentTypes: options.documentTypes ?? ["DEVELOPMENT_DIARY", "DESIGN_DOC", "PHASE_REPORT"],
  });
}

/**
 * 現行実装のソースコードを引く（品質強化Batch 1・§9〜§11）。
 *
 * 【docs検索と同じスコアリングを使う】corpusを差し替えるだけで、検索アルゴリズム・
 * 依存関係は1つも増やしていない。
 *
 * 【既定limitが小さい理由（§10）】コードは1件が長く、情報密度もdocsと違う。
 * promptへ入る量を構造的に絞るため既定3件（最大でも約3.6KB）にしてある。
 */
export function getCurrentImplementation(topic: string, options: RetrievalOptions = {}): RetrievalResult {
  const corpus = options.corpus ?? loadSourceCodeCorpus();
  return searchDevelopmentDocs(topic, {
    ...options,
    limit: options.limit ?? 3,
    // ソースは全てauthority=CURRENT_IMPLEMENTATIONであり、HISTORICAL除外の影響を受けない。
    includeHistorical: true,
    documentTypes: undefined,
    corpus,
  });
}

/** テストプレイ・実測分析を引く（実装指示§16）。 */
export function getTestPlayAnalysis(topic: string, options: RetrievalOptions = {}): RetrievalResult {
  return searchDevelopmentDocs(topic, {
    ...options,
    includeHistorical: options.includeHistorical ?? true,
    documentTypes: options.documentTypes ?? ["TESTPLAY_ANALYSIS", "PHASE_REPORT", "DESIGN_DOC"],
  });
}
