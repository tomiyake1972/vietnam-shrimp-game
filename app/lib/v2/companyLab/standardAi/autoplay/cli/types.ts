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
  /** 【SAI-4追加】5社共通の養殖能力上書き値（HOSO換算トン）。未指定なら候補既定値のまま。 */
  readonly aquacultureCapacityOverrideHosoEqTons?: number;
  /** 【SAI-4追加】trueの場合のみ経営性格プロファイル（managementProfile.ts）を適用する。 */
  readonly managementProfilesEnabled: boolean;
  /** 【SAI-5A】trueの場合のみ市場・商品志向プロファイル（orientationProfile.ts）を適用する。 */
  readonly marketProductOrientationEnabled: boolean;
  /** 【SAI-5B】trueの場合のみ異質5社preset（会社別の小幅な初期差）を適用する。 */
  readonly heterogeneousInitialConditionsEnabled: boolean;
  /** 【SAI-5C】trueの場合のみ市場別の商品ライフサイクル需要を有効化する。 */
  readonly productLifecycleEnabled: boolean;
  /** 【SAI-5D】trueの場合のみ会社×市場×商品の営業基盤蓄積を有効化する。 */
  readonly salesBaseAccumulationEnabled: boolean;
  /** 【SAI-5E】trueの場合のみ5社供給圧力→翌期プレミアムのフィードバックを有効化する。 */
  readonly supplyPremiumFeedbackEnabled: boolean;
  /** 【SAI-5F】trueの場合のみStandard AIの拡張設備投資判断を有効化する。 */
  readonly standardAiCapexEnabled: boolean;
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
