// ShrimpX V2 — Phase SAI-3B-1: Excel生成CLI 引数解析
//
// process.argv・console・process.exitには一切触れない純粋関数のみ
// （autoplay/cli/argParser.tsと同じ方針）。

import { ParsedSai3bCliArgs, Sai3bCliArgumentError } from "./types";

const KNOWN_FLAGS = new Set(["--input", "--output", "--help", "-h"]);

export function parseSai3bCliArgs(argv: readonly string[]): ParsedSai3bCliArgs {
  let help = false;
  const inputDirs: string[] = [];
  let outputPath: string | undefined;

  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    const eqIndex = token.startsWith("--") ? token.indexOf("=") : -1;
    const flag = eqIndex > 2 ? token.slice(0, eqIndex) : token;
    const inlineValue = eqIndex > 2 ? token.slice(eqIndex + 1) : undefined;

    if (flag === "--help" || flag === "-h") {
      help = true;
      i += 1;
      continue;
    }
    if (!KNOWN_FLAGS.has(flag)) {
      throw new Sai3bCliArgumentError(`不明な引数です: "${token}"。使用可能な引数は ${Array.from(KNOWN_FLAGS).join(", ")} です。`);
    }

    let value: string;
    if (inlineValue !== undefined) {
      value = inlineValue;
      i += 1;
    } else {
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("--") && next !== "-")) {
        throw new Sai3bCliArgumentError(`引数 "${flag}" には値が必要です。`);
      }
      value = next;
      i += 2;
    }

    if (flag === "--input") {
      if (value.trim().length === 0) throw new Sai3bCliArgumentError("--input に空の値は指定できません。");
      inputDirs.push(value.trim().replace(/\/+$/, ""));
    } else if (flag === "--output") {
      outputPath = value.trim();
    }
  }

  if (help) {
    return { help: true, inputDirs: [], outputPath: "" };
  }

  if (inputDirs.length === 0) {
    throw new Sai3bCliArgumentError("--input（SAI-3Aのrunディレクトリ）を少なくとも1つ指定してください。");
  }
  if (outputPath === undefined || outputPath.length === 0) {
    throw new Sai3bCliArgumentError("--output（生成するxlsxファイルのパス）を指定してください。");
  }
  if (!outputPath.toLowerCase().endsWith(".xlsx")) {
    throw new Sai3bCliArgumentError(`--output は.xlsx拡張子である必要があります（受け取った値: "${outputPath}"）。`);
  }

  return { help: false, inputDirs, outputPath };
}

export function buildSai3bUsageText(): string {
  return `ShrimpX V2 SAI-3B-1 Excel経営分析ブック生成CLI

使い方:
  npx tsx scripts/sai3bExcel.ts --input <SAI-3Aのrunディレクトリ> [--input <ディレクトリ2> ...] --output <出力xlsxパス>

引数:
  --input <ディレクトリ>  SAI-3Aのrunディレクトリ（manifest.json等7ファイルを含む）。複数回指定すると複数run比較ブックになる。
  --output <パス>        生成するxlsxファイルのパス（.xlsx拡張子必須）。出力先ディレクトリは自動作成される。
                         既存ファイルがある場合は上書きする（上書きした場合はその旨を標準出力に表示する）。
  --help, -h             この使用方法を表示して終了する

例（単一run）:
  npx tsx scripts/sai3bExcel.ts --input artifacts/sai3a/standard-h80-12seed-8q --output artifacts/sai3b/standard-h80.xlsx

例（80/85/90人比較）:
  npx tsx scripts/sai3bExcel.ts --input artifacts/sai3a/headcount-80-12seed-8q --input artifacts/sai3a/headcount-85-12seed-8q --input artifacts/sai3a/headcount-90-12seed-8q --output artifacts/sai3b/headcount-80-85-90-comparison.xlsx
`;
}
