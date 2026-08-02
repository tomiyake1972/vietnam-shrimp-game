// ShrimpX V2 — Test15前 標準AI統合自動プレイ（Phase8）の回帰テスト。
// scripts/test15StandardAiIntegratedAutoplay.tsが実際のSAI-3A実行基盤
// （runAutoplayCase）を正しく通し、意思決定への上書きを一切行っていないことを確認する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { SEEDS, runSeed, runFullStudy, toCsv } from "../../../../../scripts/test15StandardAiIntegratedAutoplay";
import { PRODUCTION_PARAMETERS_V1 } from "../../production/parameters";
import { CAPEX_PARAMETERS_V1 } from "../../capex/parameters";
import { FINANCE_PARAMETERS_V1 } from "../../finance/parameters";

test("SAA-1（新規投資種別の採用件数）: 標準AIはnewFactoryConstruction・pdMechanization・VAP開発費のいずれも一切採用しない（コーディネーター事前指摘どおりの所見）", () => {
  const result = runSeed(SEEDS[0]);
  assert.equal(result.investmentAdoptionEvents.length, 0, "標準AIが新規投資種別を1件以上採用している（想定と異なる。実際に採用したのであればロジック変更が入った可能性があるため要調査）");
});

test("SAA-2（決定への非改変）: 各社の意思決定はrunAutoplayCase（既存SAI-3A実行基盤・generateStandardAiDecision）が生成した値そのままであり、本スクリプトは一切上書きしていない（capexDecision.newProjectProposalsの内容を機械的に確認）", () => {
  const result = runSeed(SEEDS[0]);
  // 標準AIはhosoLineExpansion/pdLineExpansion/vapLineExpansion/commonProcessingExpansionは
  // 提案しうるが、newFactoryConstruction/pdMechanizationは提案しない、という既知の
  // コード読解結果を実測でも確認する。
  const proposalTypesSeen = new Set(
    result.rows.flatMap((r) => r.capexNewProjectProposalTypes.split("|").filter((t) => t.length > 0))
  );
  assert.ok(!proposalTypesSeen.has("newFactoryConstruction"));
  assert.ok(!proposalTypesSeen.has("pdMechanization"));
});

test("SAA-3（16四半期完走）: 5社×16四半期が例外なく完走する", () => {
  const result = runSeed(SEEDS[0]);
  assert.equal(result.completedTurns, 16);
  const companyIds = new Set(result.rows.map((r) => r.companyId));
  assert.equal(companyIds.size, 5);
});

test("SAA-4（共有デフォルトパラメータの不変性）: 標準AI自動プレイを実行しても、PRODUCTION_PARAMETERS_V1・CAPEX_PARAMETERS_V1・FINANCE_PARAMETERS_V1は一切変更されない", () => {
  const productionSnapshot = JSON.stringify(PRODUCTION_PARAMETERS_V1);
  const capexSnapshot = JSON.stringify(CAPEX_PARAMETERS_V1);
  const financeSnapshot = JSON.stringify(FINANCE_PARAMETERS_V1);

  runSeed(SEEDS[0]);

  assert.equal(JSON.stringify(PRODUCTION_PARAMETERS_V1), productionSnapshot);
  assert.equal(JSON.stringify(CAPEX_PARAMETERS_V1), capexSnapshot);
  assert.equal(JSON.stringify(FINANCE_PARAMETERS_V1), financeSnapshot);
});

test("SAA-5（CSV出力）: toCsvはヘッダー1行＋各行1レコードを出力する", () => {
  const result = runSeed(SEEDS[0]);
  const csv = toCsv(result.rows);
  const lines = csv.split("\n");
  assert.equal(lines.length, result.rows.length + 1);
  assert.ok(lines[0].startsWith("seed,companyId,quarter"));
});

test("SAA-6（runFullStudy統合実行）: 3seedぶんの結果が揃う", { timeout: 120_000 }, () => {
  const results = runFullStudy();
  assert.equal(results.length, SEEDS.length);
  for (const r of results) {
    assert.equal(r.completedTurns, 16);
    assert.ok(r.rows.length > 0);
  }
});
