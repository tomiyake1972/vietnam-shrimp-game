#!/usr/bin/env -S npx tsx
// ShrimpX V2 — Phase SAI-3B-1: Excel経営分析ブック生成CLI 実行エントリポイント
//
// app/lib/v2/companyLab/standardAi/sai3b/cli/runCli.ts（process.argv・console・
// 実ファイルシステムに触れない）を呼び出す薄いエントリポイント。実際のファイル
// 読み込み（--inputで指定されたSAI-3Aのrunディレクトリ）・xlsx書き出し・
// 標準出力・終了コードはここだけが担当する（scripts/sai3aAutoplay.tsと同じ方針）。
//
// 生成されたxlsxはGit管理対象にしない（.gitignoreでartifacts/sai3b/を除外済み）。

import * as fs from "node:fs";
import * as path from "node:path";
import { runSai3bExcelCli } from "../app/lib/v2/companyLab/standardAi/sai3b/cli";

function readFile(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

async function main() {
  const result = await runSai3bExcelCli(process.argv.slice(2), { readFile }, { generatedAtIso: new Date().toISOString() });

  if (result.exitCode === 0 && result.xlsxBuffer && result.outputPath) {
    const absoluteOutputPath = path.resolve(process.cwd(), result.outputPath);
    const alreadyExisted = fs.existsSync(absoluteOutputPath);
    fs.mkdirSync(path.dirname(absoluteOutputPath), { recursive: true });
    fs.writeFileSync(absoluteOutputPath, result.xlsxBuffer);
    if (alreadyExisted) {
      process.stdout.write(`(既存ファイルを上書きしました: ${absoluteOutputPath})\n`);
    }
  }

  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);

  process.exit(result.exitCode);
}

main();
