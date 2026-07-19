// ShrimpX V2 — 業界シミュレーション CLI（差分） 共通型
//
// CLIの引数解析・出力整形・実行結果は、すべてこのファイルの型を経由する。
// 経済ロジック・シナリオ内容に関する新しい型は一切追加していない
// （既存の IndustrySimulationConfig / IndustrySimulationResult /
// ScenarioComparisonResult をそのまま利用する）。

export class CliArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliArgumentError";
  }
}

export type CliOutputFormat = "summary" | "json" | "csv";

export const CLI_OUTPUT_FORMATS: readonly CliOutputFormat[] = ["summary", "json", "csv"];

export interface ParsedCliArgs {
  readonly help: boolean;
  readonly scenario: string;
  readonly mode: "canonical" | "variation";
  readonly seed: string;
  readonly turns: number;
  readonly format: CliOutputFormat;
  /** 比較対象シナリオ（--compare）。指定が無ければundefined（単独実行）。 */
  readonly compareScenario: string | undefined;
}

/**
 * CLIプロセス全体の実行結果。標準出力・標準エラー出力・終了コードを
 * 値として返すだけの純粋な戻り値にすることで、実際に process.stdout へ
 * 書き込む・process.exitするのは scripts/v2Simulate.ts の薄いエントリ
 * ポイントだけにし、CLIのロジック自体は副作用なしでテストできるようにする。
 */
export interface CliInvocationResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}
