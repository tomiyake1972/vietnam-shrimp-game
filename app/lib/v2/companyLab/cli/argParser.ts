// ShrimpX V2 — 会社経営統合テスト環境（Phase 6.2） CLI 引数解析
//
// process.argv・console・process.exitには一切触れない純粋関数のみを提供する。
// 実際の標準入出力・終了コードの扱いは scripts/v2CompanySimulate.ts（薄い
// エントリポイント）だけが担当する。シナリオID短縮形の解決はindustryLab/cli/
// scenarioAliases.tsをそのまま再利用し、重複実装しない。

import { listScenarioAliases, resolveScenarioDefinition } from "../../industryLab/cli/scenarioAliases";
import { COMPANY_LAB_COMPANY_IDS } from "../fixtures";
import { ALL_COMPANIES, CLI_OUTPUT_FORMATS, CliArgumentError, CliOutputFormat, ParsedCompanyLabCliArgs } from "./types";

const KNOWN_FLAGS = new Set(["--scenario", "--mode", "--seed", "--turns", "--format", "--company", "--help", "-h"]);

interface RawArgs {
  readonly help: boolean;
  readonly scenario?: string;
  readonly mode?: string;
  readonly seed?: string;
  readonly turns?: string;
  readonly format?: string;
  readonly company?: string;
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
  let scenario: string | undefined;
  let mode: string | undefined;
  let seed: string | undefined;
  let turns: string | undefined;
  let format: string | undefined;
  let company: string | undefined;

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
        `不明な引数です: "${argv[i]}"。使用可能な引数は --scenario, --mode, --seed, --turns, --format, --company, --help です。`
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
      case "--company":
        company = value;
        break;
      default:
        break;
    }
  }

  return { help, scenario, mode, seed, turns, format, company };
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
    throw new CliArgumentError("--turns は必須です（例: --turns 8）。");
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

function validateScenario(raw: string | undefined): string {
  if (raw === undefined || raw.trim().length === 0) {
    throw new CliArgumentError("--scenario は必須です。");
  }
  const definition = resolveScenarioDefinition(raw.trim());
  if (!definition) {
    const known = listScenarioAliases()
      .map((e) => `"${e.alias}"（正式ID: "${e.definition.scenarioId}"）`)
      .join("、");
    throw new CliArgumentError(`--scenario に一致するシナリオが見つかりません（受け取った値: "${raw}"）。利用可能なシナリオ: ${known}`);
  }
  return raw.trim();
}

function validateCompany(raw: string | undefined): string {
  const company = raw ?? ALL_COMPANIES;
  if (company === ALL_COMPANIES) return ALL_COMPANIES;
  if (!(COMPANY_LAB_COMPANY_IDS as readonly string[]).includes(company)) {
    throw new CliArgumentError(
      `--company は "${ALL_COMPANIES}"（全社比較）または ${COMPANY_LAB_COMPANY_IDS.map((c) => `"${c}"`).join(" / ")} のいずれかである必要があります（受け取った値: "${company}"）。`
    );
  }
  return company;
}

/** CLI引数を検証済みの ParsedCompanyLabCliArgs へ変換する。不正な入力は CliArgumentError を投げる。 */
export function parseCompanyLabCliArgs(argv: readonly string[]): ParsedCompanyLabCliArgs {
  const raw = tokenizeArgs(argv);

  if (raw.help) {
    return { help: true, scenario: "", mode: "canonical", seed: "", turns: 0, format: "summary", company: ALL_COMPANIES };
  }

  const scenario = validateScenario(raw.scenario);
  const mode = validateMode(raw.mode);
  if (raw.seed === undefined || raw.seed.trim().length === 0) {
    throw new CliArgumentError("--seed は必須です（例: --seed company-demo-001）。");
  }
  const turns = validateTurns(raw.turns);
  const format = validateFormat(raw.format);
  const company = validateCompany(raw.company);

  return { help: false, scenario, mode, seed: raw.seed.trim(), turns, format, company };
}

/** --help で表示する使用方法テキスト。 */
export function buildCompanyLabUsageText(): string {
  const scenarioLines = listScenarioAliases()
    .map((e) => `    ${e.alias.padEnd(28)} 正式ID: ${e.definition.scenarioId}（${e.definition.title}）`)
    .join("\n");
  const companyLines = COMPANY_LAB_COMPANY_IDS.map((c) => `    ${c}`).join("\n");

  return `ShrimpX V2 会社経営統合テスト環境 CLI（Phase 6.2）

使い方:
  npm run v2:company-simulate -- --scenario <id> --mode <canonical|variation> --seed <文字列> --turns <1以上の整数> --format <summary|json|csv> [--company <all|会社ID>]

引数:
  --scenario <id>   実行するシナリオ（必須）。短縮形または正式IDのどちらでも指定可。
  --mode <mode>     "canonical"（既定値、外生イベント固定）または "variation"（シードで揺らす）
  --seed <文字列>    乱数シード（必須）。同じ設定・同じシード・同じ意思決定なら常に同じ結果になる。
  --turns <数値>     実行ターン数（1以上。8または32を推奨）。
  --format <形式>    "summary"（既定値、人間向け）/ "json"（機械可読）/ "csv"（表計算向け）
  --company <対象>  "all"（既定値、5社比較）または特定の会社ID（個社詳細）
  --help, -h        この使用方法を表示して終了する

利用可能なシナリオ:
${scenarioLines}

利用可能な会社（テスト専用フィクスチャ。本番会社設定ではない）:
${companyLines}

例:
  npm run v2:company-simulate -- --scenario baseline --mode canonical --seed company-demo-001 --turns 8 --format summary
  npm run v2:company-simulate -- --scenario baseline --seed company-demo-001 --turns 32 --company BAL --format json > bal.json
  npm run v2:company-simulate -- --scenario baseline --seed company-demo-001 --turns 8 --format csv > result.csv
`;
}
