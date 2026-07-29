#!/usr/bin/env -S npx tsx
// ShrimpX V2 — Phase SAI-3A: 標準AI自動テストプレイ・判断記録基盤 CLI 実行エントリポイント
//
// `npx tsx scripts/sai3aAutoplay.ts -- <args>` から呼び出される薄いエントリ
// ポイント。引数解析・実行・出力整形はすべて
// app/lib/v2/companyLab/standardAi/autoplay/cli/runCli.ts（副作用なしの純粋関数）が
// 行い、ここでは実際のファイル書き出し・標準出力・終了コードだけを担当する
// （companyLab/cli/の既存script.tsと同じ方針）。
//
// 大量の実行生成物（artifacts/sai3a/以下）はGit管理対象にしない
// （.gitignoreで除外済み）。

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { runAutoplayCli } from "../app/lib/v2/companyLab/standardAi/autoplay/cli";

function currentGitCommitId(): string | undefined {
  try {
    return execSync("git rev-parse HEAD", { cwd: __dirname, encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

const { stdout, stderr, exitCode, files, outputDir } = runAutoplayCli(process.argv.slice(2), {
  executedAtIso: new Date().toISOString(),
  appCommitId: currentGitCommitId(),
});

if (exitCode === 0 && files && outputDir) {
  const absoluteOutDir = path.resolve(process.cwd(), outputDir);
  fs.mkdirSync(absoluteOutDir, { recursive: true });
  for (const [fileName, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(absoluteOutDir, fileName), content, "utf8");
  }
}

if (stdout.length > 0) {
  process.stdout.write(stdout);
}
if (stderr.length > 0) {
  process.stderr.write(stderr);
}

process.exit(exitCode);
