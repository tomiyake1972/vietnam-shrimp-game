// ShrimpX V2 — 相談役AI  文書カタログ（path → 文書種別・authority の決定論的分類）
//
// 【設計方針（実装指示§12・§14・§18・§23・§27）】
// どの文書が「正式仕様」でどれが「作業資料」かを、AIに推測させない。
// リポジトリ上のパスから決定論的に分類する。分類規則をこの1ファイルに集約することで、
// 「古いmanualを現行仕様として使ってしまう」事故を構造的に防ぐ。
//
// 【GitHubをformal authorityとする根拠（実装指示§12）】
// このカタログが対象にするのは、このリポジトリ（GitHub）にcommitされている
// docs/ 配下のmarkdownだけである。Google Drive等の外部資料は、この経路では
// 一切読み込まれない（詳細はdriveWorkingMaterials.tsのコメントを参照）。

import { AdvisorSourceAuthority, AdvisorSourceType } from "../sourceTags";

/** 文書の種別。retrieval側で「どの質問にどの種別を引くか」を決めるために使う。 */
export type AdvisorDocumentType =
  /** アーキテクチャ仕様書（*_ARCHITECTURE_v*.md 等）。現行仕様の説明に使う。 */
  | "ARCHITECTURE_SPEC"
  /** 設計文書（docs/v2/design、Standard AI設計文書）。設計意図の説明に使う。 */
  | "DESIGN_DOC"
  /** 開発日誌。なぜその仕様になったのかの一次情報。 */
  | "DEVELOPMENT_DIARY"
  /** フェーズ完了報告・受入報告。 */
  | "PHASE_REPORT"
  /** テストプレイ分析・実測レポート。 */
  | "TESTPLAY_ANALYSIS"
  /** ゲームマニュアル・パラメータ仕様書（古い版を含みうる）。 */
  | "MANUAL_OR_PARAMETERS"
  /** 引き継ぎ書・開発ログ（knowledge base）。 */
  | "KNOWLEDGE_BASE"
  /** 運用・環境まわり。 */
  | "OPERATIONS"
  /** 上記のいずれでもないもの。 */
  | "OTHER";

export interface DocumentClassification {
  readonly documentType: AdvisorDocumentType;
  readonly authority: AdvisorSourceAuthority;
  readonly sourceType: AdvisorSourceType;
  /** この分類をなぜそう決めたかの一言。UI・ログでの説明に使う。 */
  readonly note: string;
}

interface CatalogRule {
  readonly test: (relativePath: string) => boolean;
  readonly classification: DocumentClassification;
}

const CATALOG_RULES: readonly CatalogRule[] = [
  {
    // 開発日誌。「なぜこの仕様にしたのか」「過去に何が問題で変更したのか」の一次情報。
    test: (p) => /(^|\/)development_diary_\d{4}-\d{2}-\d{2}\.md$/.test(p),
    classification: {
      documentType: "DEVELOPMENT_DIARY",
      authority: "FORMAL",
      sourceType: "DEVELOPMENT_HISTORY",
      note: "GitHub上の開発日誌。設計判断の経緯を示す一次情報。",
    },
  },
  {
    // アーキテクチャ仕様書。現行仕様の説明の中心。
    test: (p) => /_ARCHITECTURE_v[\d.]+\.md$/i.test(p) || /^docs\/v2\/[A-Z0-9_]+_v[\d.]+\.md$/.test(p),
    classification: {
      documentType: "ARCHITECTURE_SPEC",
      authority: "FORMAL",
      sourceType: "FORMAL_SPEC",
      note: "GitHub上の正式アーキテクチャ仕様書。",
    },
  },
  {
    // ゲームマニュアル・パラメータ仕様書。古い版を含みうるため HISTORICAL 扱いにする。
    // 【重要】現行仕様の説明には使わない（実装指示§15）。過去経緯には使ってよい。
    test: (p) => /ShrimpX_02_ゲームマニュアル\.md$/.test(p) || /ShrimpX_03_パラメータ仕様書\.md$/.test(p),
    classification: {
      documentType: "MANUAL_OR_PARAMETERS",
      authority: "HISTORICAL",
      sourceType: "FORMAL_SPEC",
      note: "マニュアル／パラメータ仕様書。古い仕様を含む可能性があるため、現行仕様の根拠には使わない。",
    },
  },
  {
    test: (p) => /^docs\/kb\//.test(p),
    classification: {
      documentType: "KNOWLEDGE_BASE",
      authority: "HISTORICAL",
      sourceType: "DEVELOPMENT_HISTORY",
      note: "引き継ぎ書・開発ログ。経緯の説明に使う（現行仕様の根拠にはしない）。",
    },
  },
  {
    test: (p) => /^docs\/v2\/testplay\//.test(p) || /testplay|test_?play|TEST1[0-9]_/i.test(p),
    classification: {
      documentType: "TESTPLAY_ANALYSIS",
      authority: "WORKING",
      sourceType: "DEVELOPMENT_HISTORY",
      note: "テストプレイ・実測分析。設計変更の根拠として引用されることが多い作業資料。",
    },
  },
  {
    test: (p) => /(^|\/)(phase\w*|.*_completion_report|.*acceptance.*|handover_).*\.md$/i.test(p),
    classification: {
      documentType: "PHASE_REPORT",
      authority: "FORMAL",
      sourceType: "DEVELOPMENT_HISTORY",
      note: "フェーズ完了・受入報告。その時点で何が確定したかを示す。",
    },
  },
  {
    test: (p) => /^docs\/v2\/design\//.test(p) || /^docs\/standard_ai\//.test(p) || /^docs\/v2\/reports\//.test(p),
    classification: {
      documentType: "DESIGN_DOC",
      authority: "FORMAL",
      sourceType: "DEVELOPMENT_HISTORY",
      note: "GitHub上の設計文書・分析レポート。設計意図の説明に使う。",
    },
  },
  {
    test: (p) => /^docs\/(staging_|game_design_principles)/.test(p),
    classification: {
      documentType: "OPERATIONS",
      authority: "FORMAL",
      sourceType: "FORMAL_SPEC",
      note: "運用・設計原則に関する正式文書。",
    },
  },
];

const FALLBACK: DocumentClassification = {
  documentType: "OTHER",
  authority: "WORKING",
  sourceType: "DEVELOPMENT_HISTORY",
  note: "分類規則に一致しなかった文書。作業資料として扱う（現行仕様の根拠にはしない）。",
};

/**
 * リポジトリ相対パスから文書を分類する。純粋関数・決定論的。
 * 先に一致した規則を採用する（規則の並び順が優先順位）。
 */
export function classifyDocument(relativePath: string): DocumentClassification {
  for (const rule of CATALOG_RULES) {
    if (rule.test(relativePath)) return rule.classification;
  }
  return FALLBACK;
}

/**
 * 「現行仕様の根拠として使ってよい文書か」。
 * HISTORICAL（古いmanual等）は false になる。過去経緯の説明には別途使ってよい
 * （retrieval側で includeHistorical を指定する）。
 */
export function isUsableAsCurrentSpecification(classification: DocumentClassification): boolean {
  return classification.authority === "FORMAL" || classification.authority === "CURRENT_IMPLEMENTATION";
}
