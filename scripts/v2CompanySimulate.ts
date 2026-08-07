#!/usr/bin/env -S npx tsx
// ShrimpX V2 — 会社経営統合テスト環境（Phase 6.2） CLI 実行エントリポイント
//
// `npm run v2:company-simulate -- <args>` から呼び出される薄いエントリ
// ポイント。引数解析・計算・出力整形はすべて
// app/lib/v2/companyLab/cli/runCli.ts（副作用なしの純粋関数）が行い、
// ここでは実際の標準出力・標準エラー出力への書き込みとプロセスの終了
// コードだけを担当する。
//
// Redis・API Route・生成AIには一切依存しない（画面 /v2/company-lab と同じ制約）。

import { runCompanyLabCli } from "../app/lib/v2/companyLab/cli";

const { stdout, stderr, exitCode } = runCompanyLabCli(process.argv.slice(2));

if (stdout.length > 0) {
  process.stdout.write(stdout);
}
if (stderr.length > 0) {
  process.stderr.write(stderr);
}

process.exit(exitCode);
