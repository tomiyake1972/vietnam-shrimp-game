// ShrimpX V2 — 相談役AI  リポジトリ内文書の読み込みとchunk化
//
// 【なぜ大規模RAGを入れないか（実装指示§58）】
// docs/ 配下は現時点で 115ファイル・約2.3MB。vector DB・embedding pipeline・外部SaaSを
// 追加しなくても、見出し単位のchunk化＋軽量なキーワードスコアリングで十分に引ける規模である。
// まずこの構成で成立するかを確認し、必要になった時点で提案する（勝手に導入しない）。
//
// 【なぜ全文をpromptへ入れないか（実装指示§16）】
// 2.3MBはそのままではcontextに入らない。質問から必要なchunkだけを選んで渡す。
//
// 【Vercel上でのファイル読み取りについて】
// Next.jsのserverless関数は、実際に参照されるファイルだけをbundleへ含める（file tracing）。
// docs/ はimportされないため既定では含まれない。next.config.ts の
// outputFileTracingIncludes で明示的に含める必要がある（同ファイルのコメント参照）。
// 読み取りに失敗した場合は例外にせず「文書0件」として振る舞い、相談役AIは
// 「開発記録を参照できませんでした」と答える（捏造しない）。

import * as fs from "fs";
import * as path from "path";
import { AdvisorSourceAuthority, AdvisorSourceType } from "../sourceTags";
import { AdvisorDocumentType, classifyDocument } from "./docCatalog";

/** 1つの文書のメタデータ（実装指示§27：stale document対策として必ず保持する）。 */
export interface AdvisorDocumentMeta {
  /** リポジトリ相対パス。回答の出所表示にそのまま使う。 */
  readonly path: string;
  /** 先頭の `# ` 見出し。無ければファイル名。 */
  readonly title: string;
  readonly documentType: AdvisorDocumentType;
  readonly authority: AdvisorSourceAuthority;
  readonly sourceType: AdvisorSourceType;
  readonly classificationNote: string;
  /**
   * 文書に紐づく日付（YYYY-MM-DD）。ファイル名に日付があればそれを使う。
   * 【実測値と推定値の区別】ファイルのmtimeはgit cloneの時刻になり、文書の更新日では
   * ないため使わない。日付が判定できない場合はnullにする（推測しない）。
   */
  readonly documentDate: string | null;
  readonly byteLength: number;
}

/** 見出し単位で切り出した本文の一部。 */
export interface AdvisorDocumentChunk {
  readonly doc: AdvisorDocumentMeta;
  /** 文書内の通し番号。 */
  readonly index: number;
  /** このchunkが属する見出し（`## ...`）。冒頭部分はnull。 */
  readonly heading: string | null;
  readonly text: string;
}

/** chunk1つあたりの最大文字数。長すぎる節は分割する。 */
const MAX_CHUNK_CHARS = 1_200;

/** docs/ 配下のうち読み込む拡張子。 */
const MARKDOWN_EXT = ".md";

function resolveDocsRoot(): string {
  // process.cwd() はNext.jsのserverless実行時もプロジェクトルートを指す。
  //
  // 【ビルド時警告について（実測）】ビルド時のfile tracingは、fsによる動的な読み取り
  // （下のreaddirSync/readFileSync）を見つけると「プロジェクト全体が必要かもしれない」と
  // 判断し、この1ルートのbundleへ広くファイルを取り込む旨の警告を出す。
  // turbopackIgnoreコメントを付けても、readdirSync側が動的なため警告は消えない
  // （実測で確認済み。消えないことを確認したうえで残している）。
  // 読み取り先はprocess.cwd()直下の"docs"に限定されており、リポジトリ全体でも
  // app 9MB / docs 2.6MB と小さいため、bundleサイズ上の実害は無いと判断した。
  // 必要なファイルは next.config.ts の outputFileTracingIncludes で明示的に含めている。
  return path.join(/*turbopackIgnore: true*/ process.cwd(), "docs");
}

function extractTitle(content: string, filePath: string): string {
  for (const line of content.split("\n", 40)) {
    const m = /^#\s+(.+?)\s*$/.exec(line);
    if (m) return m[1];
  }
  return path.basename(filePath);
}

/** ファイル名に含まれる日付だけを文書日付として採用する（mtimeは使わない）。 */
function extractDocumentDate(relativePath: string): string | null {
  const m = /(\d{4}-\d{2}-\d{2})/.exec(relativePath);
  return m ? m[1] : null;
}

function listMarkdownFiles(root: string): readonly string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(MARKDOWN_EXT)) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out.sort();
}

/** markdownを見出し単位でchunkへ切る。コードフェンス内の `#` は見出しとして扱わない。 */
export function splitMarkdownIntoChunks(doc: AdvisorDocumentMeta, content: string): readonly AdvisorDocumentChunk[] {
  const chunks: AdvisorDocumentChunk[] = [];
  let heading: string | null = null;
  let buffer: string[] = [];
  let inFence = false;
  let index = 0;

  const flush = (): void => {
    const text = buffer.join("\n").trim();
    buffer = [];
    if (text.length === 0) return;
    // 長すぎる節はさらに分割する（1つのchunkがcontextを食い尽くさないように）。
    for (let start = 0; start < text.length; start += MAX_CHUNK_CHARS) {
      chunks.push({ doc, index: index++, heading, text: text.slice(start, start + MAX_CHUNK_CHARS) });
    }
  };

  for (const line of content.split("\n")) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const headingMatch = !inFence ? /^(#{1,4})\s+(.+?)\s*$/.exec(line) : null;
    if (headingMatch) {
      flush();
      heading = headingMatch[2];
      continue;
    }
    buffer.push(line);
  }
  flush();
  return chunks;
}

export interface AdvisorDocumentCorpus {
  readonly documents: readonly AdvisorDocumentMeta[];
  readonly chunks: readonly AdvisorDocumentChunk[];
  /** 読み込みに失敗した場合の理由（成功時はnull）。相談役AIへ「参照できなかった」と伝えるために使う。 */
  readonly loadError: string | null;
}

const EMPTY_CORPUS: AdvisorDocumentCorpus = { documents: [], chunks: [], loadError: null };

let cached: AdvisorDocumentCorpus | null = null;

/**
 * docs/ 配下のmarkdownを読み込み、chunk化した corpus を返す。
 * プロセス内で1回だけ読み、以降はキャッシュを返す（リクエストごとに数MBを読み直さない）。
 * 読み取りに失敗しても例外は投げず、loadError付きの空corpusを返す。
 */
export function loadDocumentCorpus(options?: { readonly forceReload?: boolean; readonly rootDir?: string }): AdvisorDocumentCorpus {
  if (!options?.forceReload && options?.rootDir === undefined && cached !== null) return cached;

  const root = options?.rootDir ?? resolveDocsRoot();
  let files: readonly string[];
  try {
    if (!fs.existsSync(root)) {
      const corpus: AdvisorDocumentCorpus = { ...EMPTY_CORPUS, loadError: `docsディレクトリが見つかりません（${root}）。` };
      if (options?.rootDir === undefined) cached = corpus;
      return corpus;
    }
    files = listMarkdownFiles(root);
  } catch (e) {
    const corpus: AdvisorDocumentCorpus = { ...EMPTY_CORPUS, loadError: e instanceof Error ? e.message : String(e) };
    if (options?.rootDir === undefined) cached = corpus;
    return corpus;
  }

  const documents: AdvisorDocumentMeta[] = [];
  const chunks: AdvisorDocumentChunk[] = [];
  const repoRoot = path.dirname(root);

  for (const file of files) {
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const relativePath = path.relative(repoRoot, file).split(path.sep).join("/");
    const classification = classifyDocument(relativePath);
    const meta: AdvisorDocumentMeta = {
      path: relativePath,
      title: extractTitle(content, file),
      documentType: classification.documentType,
      authority: classification.authority,
      sourceType: classification.sourceType,
      classificationNote: classification.note,
      documentDate: extractDocumentDate(relativePath),
      byteLength: Buffer.byteLength(content, "utf8"),
    };
    documents.push(meta);
    chunks.push(...splitMarkdownIntoChunks(meta, content));
  }

  const corpus: AdvisorDocumentCorpus = { documents, chunks, loadError: null };
  if (options?.rootDir === undefined) cached = corpus;
  return corpus;
}

/** テスト用。プロセス内キャッシュを破棄する。 */
export function resetDocumentCorpusCache(): void {
  cached = null;
}
