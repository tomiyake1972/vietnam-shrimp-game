// ShrimpX V2 — Phase SAI-3A: 自動テストプレイCLI 共通型
//
// companyLab/cli/types.ts・industryLab/cli/types.tsと同じ方針（CLIごとに
// 専用のCliArgumentErrorを持つ既存慣習を踏襲）。経済ロジックに関する新しい型は
// 追加せず、既存のCompanyId・StandardBaselineCandidateをそのまま利用する。

import { CompanyId } from "../../../../sales/types";

export class CliArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliArgumentError";
  }
}

export interface ParsedAutoplayCliArgs {
  readonly help: boolean;
  readonly scenario: string;
  readonly baselineId: string;
  readonly seeds: readonly string[];
  readonly quarters: number;
  readonly companyIds: readonly CompanyId[];
  readonly salesForceHeadcountOverride?: number;
  readonly outDir: string;
  readonly runId: string;
}

export interface AutoplayCliInvocationResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  /** exitCode===0の場合のみ設定される、実際に書き出すべきファイル内容一式
   *  （ファイル名 -> 内容の文字列）。fs書き込み自体はscripts/側が行う。 */
  readonly files?: Readonly<Record<string, string>>;
  /** exitCode===0の場合のみ設定される、書き出し先ディレクトリ（<outDir>/<runId>）。 */
  readonly outputDir?: string;
}
