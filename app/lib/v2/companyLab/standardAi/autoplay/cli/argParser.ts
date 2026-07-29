// ShrimpX V2 — Phase SAI-3A: 自動テストプレイCLI 引数解析
//
// process.argv・console・process.exitには一切触れない純粋関数のみを提供する
// （companyLab/cli/argParser.tsと同じ方針）。実際の標準入出力・終了コード・
// fs書き込みは scripts/sai3aAutoplay.ts（薄いエントリポイント）だけが担当する。
//
// seed数・クォーター数・会社数はいずれもハードコードせず、実行時に指定できる
// ようにする（三宅さんの指示§2）。

import { resolveScenarioDefinition, listScenarioAliases } from "../../../../industryLab/cli/scenarioAliases";
import { ALL_COMPANY_IDS } from "../../report/decomposeHarness";
import { STANDARD_BASELINE_CANDIDATES, SELECTED_STANDARD_BASELINE_CANDIDATE_ID } from "../../report/standardBaseline";
import { CompanyId } from "../../../../sales/types";
import { CliArgumentError, ParsedAutoplayCliArgs } from "./types";

const KNOWN_FLAGS = new Set([
  "--scenario",
  "--baseline-id",
  "--seeds",
  "--seed-count",
  "--seed-prefix",
  "--quarters",
  "--companies",
  "--headcount",
  "--out-dir",
  "--run-id",
  "--help",
  "-h",
]);

interface RawArgs {
  readonly help: boolean;
  readonly scenario?: string;
  readonly baselineId?: string;
  readonly seeds?: string;
  readonly seedCount?: string;
  readonly seedPrefix?: string;
  readonly quarters?: string;
  readonly companies?: string;
  readonly headcount?: string;
  readonly outDir?: string;
  readonly runId?: string;
}

function splitEqualsForm(token: string): readonly [string, string | undefined] {
  const eqIndex = token.indexOf("=");
  if (token.startsWith("--") && eqIndex > 2) {
    return [token.slice(0, eqIndex), token.slice(eqIndex + 1)];
  }
  return [token, undefined];
}

function tokenizeArgs(argv: readonly string[]): RawArgs {
  let help = false;
  const values: { [k: string]: string } = {};

  let i = 0;
  while (i < argv.length) {
    const [flag, inlineValue] = splitEqualsForm(argv[i]);

    if (flag === "--help" || flag === "-h") {
      help = true;
      i += 1;
      continue;
    }

    if (!KNOWN_FLAGS.has(flag)) {
      throw new CliArgumentError(
        `不明な引数です: "${argv[i]}"。使用可能な引数は ${Array.from(KNOWN_FLAGS).join(", ")} です。`
      );
    }

    let value: string;
    if (inlineValue !== undefined) {
      value = inlineValue;
      i += 1;
    } else {
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("--") && next !== "-")) {
        throw new CliArgumentError(`引数 "${flag}" には値が必要です。`);
      }
      value = next;
      i += 2;
    }
    values[flag] = value;
  }

  return {
    help,
    scenario: values["--scenario"],
    baselineId: values["--baseline-id"],
    seeds: values["--seeds"],
    seedCount: values["--seed-count"],
    seedPrefix: values["--seed-prefix"],
    quarters: values["--quarters"],
    companies: values["--companies"],
    headcount: values["--headcount"],
    outDir: values["--out-dir"],
    runId: values["--run-id"],
  };
}

function validateScenario(raw: string | undefined): string {
  const scenario = raw ?? "baseline";
  const definition = resolveScenarioDefinition(scenario);
  if (!definition) {
    const known = listScenarioAliases()
      .map((e) => `"${e.alias}"（正式ID: "${e.definition.scenarioId}"）`)
      .join("、");
    throw new CliArgumentError(`--scenario に一致するシナリオが見つかりません（受け取った値: "${scenario}"）。利用可能なシナリオ: ${known}`);
  }
  return scenario;
}

function validateBaselineId(raw: string | undefined): string {
  const baselineId = raw ?? SELECTED_STANDARD_BASELINE_CANDIDATE_ID;
  if (!STANDARD_BASELINE_CANDIDATES.some((c) => c.id === baselineId)) {
    const known = STANDARD_BASELINE_CANDIDATES.map((c) => `"${c.id}"`).join("、");
    throw new CliArgumentError(`--baseline-id に一致する標準初期条件の候補が見つかりません（受け取った値: "${baselineId}"）。利用可能な候補: ${known}`);
  }
  return baselineId;
}

function validateQuarters(raw: string | undefined): number {
  const quarters = raw ?? "8";
  if (!/^\d+$/.test(quarters.trim())) {
    throw new CliArgumentError(`--quarters は正の整数である必要があります（受け取った値: "${quarters}"）。`);
  }
  const n = Number(quarters.trim());
  if (n < 1) {
    throw new CliArgumentError(`--quarters は1以上である必要があります（受け取った値: ${n}）。`);
  }
  return n;
}

function validateCompanies(raw: string | undefined): readonly CompanyId[] {
  if (raw === undefined || raw.trim().length === 0) return ALL_COMPANY_IDS;
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (ids.length === 0) return ALL_COMPANY_IDS;
  const unknown = ids.filter((id) => !ALL_COMPANY_IDS.includes(id));
  if (unknown.length > 0) {
    throw new CliArgumentError(
      `--companies に不明な会社IDが含まれています: ${unknown.join(", ")}。利用可能な会社ID: ${ALL_COMPANY_IDS.join(", ")}`
    );
  }
  return ids;
}

function validateSeeds(raw: RawArgs): readonly string[] {
  if (raw.seeds !== undefined && raw.seeds.trim().length > 0) {
    const seeds = raw.seeds
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (seeds.length === 0) {
      throw new CliArgumentError("--seeds に有効なシードが1件も含まれていません。");
    }
    return seeds;
  }

  if (raw.seedCount !== undefined && raw.seedCount.trim().length > 0) {
    if (!/^\d+$/.test(raw.seedCount.trim())) {
      throw new CliArgumentError(`--seed-count は正の整数である必要があります（受け取った値: "${raw.seedCount}"）。`);
    }
    const count = Number(raw.seedCount.trim());
    if (count < 1) {
      throw new CliArgumentError(`--seed-count は1以上である必要があります（受け取った値: ${count}）。`);
    }
    const prefix = raw.seedPrefix ?? "sai3a";
    return Array.from({ length: count }, (_, i) => `${prefix}-${String(i + 1).padStart(3, "0")}`);
  }

  throw new CliArgumentError("--seeds（カンマ区切りの明示的なシード一覧）または --seed-count（自動生成する件数。任意で --seed-prefix と併用）のいずれかが必須です。");
}

function validateHeadcount(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  if (!/^\d+$/.test(raw.trim())) {
    throw new CliArgumentError(`--headcount は正の整数である必要があります（受け取った値: "${raw}"）。`);
  }
  const n = Number(raw.trim());
  if (n < 0) {
    throw new CliArgumentError(`--headcount は0以上である必要があります（受け取った値: ${n}）。`);
  }
  return n;
}

function defaultRunId(): string {
  // scripts/側でDate.now()由来のrunIdを明示的に渡すのが基本だが、CLI単体テストや
  // --run-id省略時のフォールバックとして、固定文字列＋実行時渡しのseed/quartersに
  // 依存しない安定値を用意する（テストの再現性のため、時刻には依存しない）。
  return "sai3a-run";
}

/** CLI引数を検証済みの ParsedAutoplayCliArgs へ変換する。不正な入力は CliArgumentError を投げる。 */
export function parseAutoplayCliArgs(argv: readonly string[]): ParsedAutoplayCliArgs {
  const raw = tokenizeArgs(argv);

  if (raw.help) {
    return {
      help: true,
      scenario: "",
      baselineId: "",
      seeds: [],
      quarters: 0,
      companyIds: [],
      outDir: "",
      runId: "",
    };
  }

  const scenario = validateScenario(raw.scenario);
  const baselineId = validateBaselineId(raw.baselineId);
  const seeds = validateSeeds(raw);
  const quarters = validateQuarters(raw.quarters);
  const companyIds = validateCompanies(raw.companies);
  const salesForceHeadcountOverride = validateHeadcount(raw.headcount);
  const outDir = raw.outDir && raw.outDir.trim().length > 0 ? raw.outDir.trim() : "artifacts/sai3a";
  const runId = raw.runId && raw.runId.trim().length > 0 ? raw.runId.trim() : defaultRunId();

  return { help: false, scenario, baselineId, seeds, quarters, companyIds, salesForceHeadcountOverride, outDir, runId };
}

/** --help で表示する使用方法テキスト。 */
export function buildAutoplayUsageText(): string {
  return `ShrimpX V2 標準AI自動テストプレイ・判断記録基盤 CLI（Phase SAI-3A）

使い方:
  npx tsx scripts/sai3aAutoplay.ts --seed-count <件数> --quarters <四半期数> [--scenario <id>] [--baseline-id <id>] [--companies <会社ID,会社ID,...>] [--headcount <人数>] [--out-dir <ディレクトリ>] [--run-id <run識別子>]

引数:
  --scenario <id>       実行するシナリオ（既定値: "baseline"）。短縮形または正式IDのどちらでも指定可。
  --baseline-id <id>    標準初期条件の候補ID（既定値: 選定済み候補。standardAi/report/standardBaseline.ts参照）。
  --seeds <s1,s2,...>   実行するseedをカンマ区切りで明示指定する。
  --seed-count <数>     seedを自動生成する件数（--seedsの代わりに指定。例: sai3a-001, sai3a-002, ...）。
  --seed-prefix <文字列> --seed-count併用時のseed名prefix（既定値: "sai3a"）。
  --quarters <数>       実行クォーター数（既定値: 8。32も指定可）。
  --companies <c1,c2,...> 対象会社ID（既定値: 5社すべて）。
  --headcount <人数>    標準営業人数を上書きする場合の値（未指定なら候補既定値のまま）。
  --out-dir <ディレクトリ> 出力先ディレクトリ（既定値: "artifacts/sai3a"）。実際の書き出し先は <out-dir>/<run-id>/ 以下。
  --run-id <run識別子>  この実行のrun ID（既定値は固定のプレースホルダー。再現可能な命名を推奨）。
  --help, -h            この使用方法を表示して終了する

例:
  npx tsx scripts/sai3aAutoplay.ts --seed-count 12 --quarters 8
  npx tsx scripts/sai3aAutoplay.ts --seeds sai3a-h85-001,sai3a-h85-002 --quarters 8 --headcount 85 --run-id headcount85-check
`;
}
