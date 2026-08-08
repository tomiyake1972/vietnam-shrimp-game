// ShrimpX V2 — 相談役AI  現行実装コードの読み込みとchunk化（品質強化Batch 1・§9〜§11）
//
// 【なぜ必要か（§9）】
// 相談役AIの sourcePolicy は「情報源の優先順位: (1) 現行実装コード / 正式文書」と宣言して
// いるが、MVPでは実際にはコードを一切参照していなかった。つまり最上位の情報源が
// 空のまま「現行実装では〜」と語れる状態だった。これは根拠追跡可能性
// （§0の優先順位3）とハルシネーション耐性（同4）の両方にとって最大の穴である。
// 「今の実装はどうなっているのか」に答えられるようにするには、コードを引けるようにする必要がある。
//
// 【方式の選択：Option A（軽量MVP）を採用した理由（§11）】
//   ・vector DB / embedding pipeline / 外部SaaS / 大規模indexing infrastructureは追加しない。
//   ・docs/ 用に既に動いているキーワードスコアリング（retrieval.ts）をそのまま再利用する。
//     新しい検索アルゴリズムも新しい依存関係も1つも増えない。
//   ・対象は「ゲームの仕組みを定義しているエンジン層」だけに限定する（下のWHITELIST）。
//     UI・テスト・スクリプト・APIルートは対象外。約1.3MB / 約110ファイルであり、
//     docs/(2.3MB) より小さい。プロセス内に1度だけ読み込む点もdocs/と同じ。
//
// 【Claudeへ送る量（§10「コード全文を大量送信しない」）】
// 送るのは検索でヒットした上位chunkだけであり、既定で最大3件・1件1,200文字。
// つまり1回の質問でpromptへ入るコードは概ね4KB以下に構造的に制限されている。
// ファイル全文・ディレクトリ全体を送る経路は存在しない。
//
// 【Vercel上での可用性】
// .ts のソースはビルド後のFunctionには含まれない。next.config.ts の
// outputFileTracingIncludes で明示的に含めている。含まれていない環境では
// 読み込みが0件になり、相談役AIは「実装コードを参照できませんでした」と答える
// （黙って推測で埋めることはしない）。

import * as fs from "fs";
import * as path from "path";
import { AdvisorDocumentChunk, AdvisorDocumentMeta } from "./docStore";

/**
 * 検索対象にするディレクトリ（リポジトリルート相対）。
 * 【意図的に狭くしている】ゲームの仕組み＝「何が起きるか」を決めている層だけを入れる。
 * UI(app/v2)・API route・テスト・CLIは、仕様の質問の答えにはならないため入れない。
 */
export const SOURCE_CODE_WHITELIST: readonly string[] = [
  "app/lib/v2/sales",
  "app/lib/v2/production",
  "app/lib/v2/rawMaterials",
  "app/lib/v2/finance",
  "app/lib/v2/financing",
  "app/lib/v2/capex",
  "app/lib/v2/market",
  "app/lib/v2/quality",
  "app/lib/v2/turn",
  "app/lib/v2/companyLab/standardAi",
];

/** 除外するパス断片。テスト・fixtureは仕様の根拠にならず、検索結果を汚す。 */
const EXCLUDED_FRAGMENTS: readonly string[] = ["__tests__", ".test.", "/cli/", "/scripts/"];

const SOURCE_EXT = ".ts";

/** 1 chunkあたりの最大文字数。docs側（1,200）と揃える。 */
const MAX_CHUNK_CHARS = 1_200;

/** corpus全体の安全上限。想定外にファイルが増えてもメモリを食い潰さないための歯止め。 */
const MAX_TOTAL_BYTES = 4_000_000;

function isExcluded(relativePath: string): boolean {
  return EXCLUDED_FRAGMENTS.some((f) => relativePath.includes(f));
}

function listSourceFiles(repoRoot: string, whitelist: readonly string[]): readonly string[] {
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
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(SOURCE_EXT)) out.push(full);
    }
  };
  for (const rel of whitelist) walk(path.join(repoRoot, rel));
  return out.sort();
}

/** 宣言の開始行かどうか（インデント0の宣言だけを境界とみなす）。 */
const DECLARATION_RE = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+([A-Za-z0-9_$]+)/;

/**
 * TypeScriptを「トップレベル宣言」単位でchunkへ切る。
 * 構文解析はしない（パーサ依存を増やさない）。インデント0の宣言行を境界にするだけである。
 *
 * 【直前のコメントを宣言に付ける理由】このリポジトリのコードは、設計意図・単位・
 * 禁止事項を日本語のブロックコメントで宣言の直前に書く規約になっている。
 * コメントを切り離すと「なぜそうなっているか」が失われ、相談役AIが引く価値が大きく下がる。
 * したがって宣言直前の連続コメント行は、次のchunk側へ含める。
 */
export function splitSourceIntoChunks(doc: AdvisorDocumentMeta, content: string): readonly AdvisorDocumentChunk[] {
  const chunks: AdvisorDocumentChunk[] = [];
  const lines = content.split("\n");
  let buffer: string[] = [];
  let heading: string | null = null;
  let index = 0;

  const flush = (nextHeading: string | null): void => {
    const text = buffer.join("\n").trim();
    buffer = [];
    if (text.length > 0) {
      for (let start = 0; start < text.length; start += MAX_CHUNK_CHARS) {
        chunks.push({ doc, index: index++, heading, text: text.slice(start, start + MAX_CHUNK_CHARS) });
      }
    }
    heading = nextHeading;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = DECLARATION_RE.exec(line);
    if (m && buffer.length > 0) {
      // 直前の連続コメント行を、この宣言側（次のchunk）へ移す。
      const carried: string[] = [];
      while (buffer.length > 0) {
        const last = buffer[buffer.length - 1];
        if (/^\s*(\/\/|\/\*|\*)/.test(last) || last.trim() === "") carried.unshift(buffer.pop()!);
        else break;
      }
      flush(m[1]);
      buffer = carried;
    } else if (m) {
      heading = m[1];
    }
    buffer.push(line);
  }
  flush(null);
  return chunks;
}

export interface SourceCodeCorpus {
  readonly documents: readonly AdvisorDocumentMeta[];
  readonly chunks: readonly AdvisorDocumentChunk[];
  readonly loadError: string | null;
}

const EMPTY: SourceCodeCorpus = { documents: [], chunks: [], loadError: null };

let cached: SourceCodeCorpus | null = null;

/**
 * whitelistのソースを読み込み、chunk化したcorpusを返す。
 * プロセス内で1回だけ読み、以降はキャッシュを返す。
 * 読み取りに失敗しても例外は投げず、loadError付きの空corpusを返す
 * （相談役AIは「実装コードを参照できませんでした」と答える）。
 */
export function loadSourceCodeCorpus(options?: { readonly forceReload?: boolean; readonly rootDir?: string }): SourceCodeCorpus {
  if (!options?.forceReload && options?.rootDir === undefined && cached !== null) return cached;

  const repoRoot = options?.rootDir ?? process.cwd();
  let files: readonly string[];
  try {
    files = listSourceFiles(repoRoot, SOURCE_CODE_WHITELIST);
  } catch (e) {
    const corpus: SourceCodeCorpus = { ...EMPTY, loadError: e instanceof Error ? e.message : String(e) };
    if (options?.rootDir === undefined) cached = corpus;
    return corpus;
  }

  if (files.length === 0) {
    const corpus: SourceCodeCorpus = {
      ...EMPTY,
      loadError: "現行実装のソースを読み込めませんでした（デプロイに含まれていない可能性があります）。",
    };
    if (options?.rootDir === undefined) cached = corpus;
    return corpus;
  }

  const documents: AdvisorDocumentMeta[] = [];
  const chunks: AdvisorDocumentChunk[] = [];
  let totalBytes = 0;

  for (const file of files) {
    const relativePath = path.relative(repoRoot, file).split(path.sep).join("/");
    if (isExcluded(relativePath)) continue;
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const byteLength = Buffer.byteLength(content, "utf8");
    totalBytes += byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) break;

    const meta: AdvisorDocumentMeta = {
      path: relativePath,
      title: relativePath,
      documentType: "SOURCE_CODE",
      // 【最上位のauthority】sourcePolicyが定める「現行実装コード」そのものである。
      authority: "CURRENT_IMPLEMENTATION",
      sourceType: "FORMAL_SPEC",
      classificationNote: "現行実装のソースコード（whitelistディレクトリ内）。",
      // 【日付を付けない】ファイルのmtimeはgit cloneの時刻であり更新日ではない。
      // コードは常に「現在の実装」なので日付という概念を持たせない（推測しない）。
      documentDate: null,
      byteLength,
    };
    documents.push(meta);
    chunks.push(...splitSourceIntoChunks(meta, content));
  }

  const corpus: SourceCodeCorpus = { documents, chunks, loadError: null };
  if (options?.rootDir === undefined) cached = corpus;
  return corpus;
}

/** テスト用。プロセス内キャッシュを破棄する。 */
export function resetSourceCodeCorpusCache(): void {
  cached = null;
}
