// ShrimpX V2 — 業界シミュレーション CLI（差分） 引数解析
//
// process.argv・console・process.exitには一切触れない純粋関数のみを提供する。
// 実際の標準入出力・終了コードの扱いは scripts/v2Simulate.ts（薄いエントリ
// ポイント）だけが担当する。

import { CLI_OUTPUT_FORMATS, CliArgumentError, CliOutputFormat, ParsedCliArgs } from "./types";
import { listScenarioAliases, resolveScenarioDefinition } from "./scenarioAliases";

const KNOWN_FLAGS = new Set([
  "--scenario",
  "--mode",
  "--seed",
  "--turns",
  "--format",
  "--compare",
  "--help",
  "-h",
]);

interface RawArgs {
  readonly help: boolean;
  readonly scenario?: string;
  readonly mode?: string;
  readonly seed?: string;
  readonly turns?: string;
  readonly format?: string;
  readonly compare?: string;
}

function splitEqualsForm(token: string): readonly [string, string | undefined] {
  const eqIndex = token.indexOf("=");
  if (token.startsWith("--") && eqIndex > 2) {
    return [token.slice(0, eqIndex), token.slice(eqIndex + 1)];
  }
  return [token, undefined];
}

/** argvをKNOWN_FLAGSのみからなるRawArgsへ分解する（値の意味付け・検証はまだ行わない）。 */
function tokenizeArgs(argv: readonly string[]): RawArgs {
  let help = false;
  let scenario: string | undefined;
  let mode: string | undefined;
  let seed: string | undefined;
  let turns: string | undefined;
  let format: string | undefined;
  let compare: string | undefined;

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
        `不明な引数です: "${argv[i]}"。使用可能な引数は --scenario, --mode, --seed, --turns, --format, --compare, --help です。`
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

    switch (flag) {
      case "--scenario":
        scenario = value;
        break;
      case "--mode":
        mode = value;
        break;
      case "--seed":
        seed = value;
        break;
      case "--turns":
        turns = value;
        break;
      case "--format":
        format = value;
        break;
      case "--compare":
        compare = value;
        break;
      default:
        break;
    }
  }

  return { help, scenario, mode, seed, turns, format, compare };
}

function validateMode(raw: string | undefined): "canonical" | "variation" {
  const mode = raw ?? "canonical";
  if (mode !== "canonical" && mode !== "variation") {
    throw new CliArgumentError(`--mode は "canonical" または "variation" である必要があります（受け取った値: "${mode}"）。`);
  }
  return mode;
}

function validateFormat(raw: string | undefined): CliOutputFormat {
  const format = raw ?? "summary";
  if (!(CLI_OUTPUT_FORMATS as readonly string[]).includes(format)) {
    throw new CliArgumentError(
      `--format は ${CLI_OUTPUT_FORMATS.map((f) => `"${f}"`).join(" / ")} のいずれかである必要があります（受け取った値: "${format}"）。`
    );
  }
  return format as CliOutputFormat;
}

function validateTurns(raw: string | undefined): number {
  if (raw === undefined || raw.trim().length === 0) {
    throw new CliArgumentError("--turns は必須です（例: --turns 32）。");
  }
  if (!/^-?\d+$/.test(raw.trim())) {
    throw new CliArgumentError(`--turns は整数である必要があります（受け取った値: "${raw}"）。`);
  }
  const turns = Number(raw.trim());
  if (turns < 1) {
    throw new CliArgumentError(`--turns は1以上である必要があります（受け取った値: ${turns}）。`);
  }
  return turns;
}

function validateScenario(raw: string | undefined, flagLabel: string) {
  if (raw === undefined || raw.trim().length === 0) {
    throw new CliArgumentError(`${flagLabel} は必須です。`);
  }
  const definition = resolveScenarioDefinition(raw.trim());
  if (!definition) {
    const known = listScenarioAliases()
      .map((e) => `"${e.alias}"（正式ID: "${e.definition.scenarioId}"）`)
      .join("、");
    throw new CliArgumentError(`${flagLabel} に一致するシナリオが見つかりません（受け取った値: "${raw}"）。利用可能なシナリオ: ${known}`);
  }
  return raw.trim();
}

/** CLI引数を検証済みの ParsedCliArgs へ変換する。不正な入力は CliArgumentError を投げる。 */
export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const raw = tokenizeArgs(argv);

  if (raw.help) {
    return {
      help: true,
      scenario: "",
      mode: "canonical",
      seed: "",
      turns: 0,
      format: "summary",
      compareScenario: undefined,
    };
  }

  const scenario = validateScenario(raw.scenario, "--scenario");
  const mode = validateMode(raw.mode);
  if (raw.seed === undefined || raw.seed.trim().length === 0) {
    throw new CliArgumentError("--seed は必須です（例: --seed demo-001）。");
  }
  const turns = validateTurns(raw.turns);
  const format = validateFormat(raw.format);
  const compareScenario = raw.compare !== undefined ? validateScenario(raw.compare, "--compare") : undefined;

  return {
    help: false,
    scenario,
    mode,
    seed: raw.seed.trim(),
    turns,
    format,
    compareScenario,
  };
}

/** --help で表示する使用方法テキスト。 */
export function buildUsageText(): string {
  const scenarioLines = listScenarioAliases()
    .map((e) => `    ${e.alias.padEnd(28)} 正式ID: ${e.definition.scenarioId}（${e.definition.title}）`)
    .join("\n");

  return `ShrimpX V2 業界シミュレーション CLI

使い方:
  npm run v2:simulate -- --scenario <id> --mode <canonical|variation> --seed <文字列> --turns <1以上の整数> --format <summary|json|csv> [--compare <id>]

引数:
  --scenario <id>   実行するシナリオ（必須）。短縮形または正式IDのどちらでも指定可。
  --mode <mode>     "canonical"（既定値、外生イベント固定）または "variation"（シードで揺らす）
  --seed <文字列>    乱数シード（必須）。同じ設定・同じシードなら常に同じ結果になる。
  --turns <数値>     実行ターン数（1以上、シナリオのdurationTurns以下。必須）
  --format <形式>    "summary"（既定値、人間向け）/ "json"（機械可読）/ "csv"（表計算向け）
  --compare <id>    指定すると、同じmode/seed/turnsで別シナリオも実行し差分を出力する
  --help, -h        この使用方法を表示して終了する

利用可能なシナリオ:
${scenarioLines}

例:
  npm run v2:simulate -- --scenario baseline --mode canonical --seed demo-001 --turns 32 --format summary
  npm run v2:simulate -- --scenario baseline --seed demo-001 --turns 32 --format json > result.json
  npm run v2:simulate -- --scenario baseline --seed demo-001 --turns 32 --compare global-disease-crisis --format csv
`;
}
