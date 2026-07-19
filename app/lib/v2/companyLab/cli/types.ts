// ShrimpX V2 — 会社経営統合テスト環境（Phase 6.2） CLI 共通型
//
// industryLab/cli/types.tsと同じ方針。経済ロジック・シナリオ内容に関する
// 新しい型は一切追加せず、既存の CompanyLabConfig / CompanyLabResult /
// CompanyQuarterSummary をそのまま利用する。

export class CliArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliArgumentError";
  }
}

export type CliOutputFormat = "summary" | "json" | "csv";

export const CLI_OUTPUT_FORMATS: readonly CliOutputFormat[] = ["summary", "json", "csv"];

/** --company の特殊値。全社比較表示を意味する。 */
export const ALL_COMPANIES = "all" as const;

export interface ParsedCompanyLabCliArgs {
  readonly help: boolean;
  readonly scenario: string;
  readonly mode: "canonical" | "variation";
  readonly seed: string;
  readonly turns: number;
  readonly format: CliOutputFormat;
  /** 表示対象会社（"all" または fixtures.ts のCompanyId。指定が無ければ"all"）。 */
  readonly company: string;
}

/**
 * CLIプロセス全体の実行結果。標準出力・標準エラー出力・終了コードを
 * 値として返すだけの純粋な戻り値にすることで、実際に process.stdout へ
 * 書き込む・process.exitするのは scripts/v2CompanySimulate.ts の薄い
 * エントリポイントだけにし、CLIのロジック自体は副作用なしでテストできる。
 */
export interface CliInvocationResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}
