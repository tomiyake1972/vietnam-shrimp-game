#!/usr/bin/env -S npx tsx
// ShrimpX V2 — 業界シミュレーション CLI（差分） 実行エントリポイント
//
// `npm run v2:simulate -- <args>` から呼び出される薄いエントリポイント。
// 引数解析・計算・出力整形はすべて app/lib/v2/industryLab/cli/runCli.ts
// （副作用なしの純粋関数）が行い、ここでは実際の標準出力・標準エラー出力
// への書き込みとプロセスの終了コードだけを担当する。
//
// Redis・API Route・生成AIには一切依存しない（Phase 3画面と同じ制約）。

import { runCli } from "../app/lib/v2/industryLab/cli";

const { stdout, stderr, exitCode } = runCli(process.argv.slice(2));

if (stdout.length > 0) {
  process.stdout.write(stdout);
}
if (stderr.length > 0) {
  process.stderr.write(stderr);
}

process.exit(exitCode);
