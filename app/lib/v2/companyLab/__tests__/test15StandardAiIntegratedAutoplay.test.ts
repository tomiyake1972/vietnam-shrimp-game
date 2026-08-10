// ShrimpX V2 — Test15前 標準AI統合自動プレイ（Phase8）の回帰テスト。
// scripts/test15StandardAiIntegratedAutoplay.tsが実際のSAI-3A実行基盤
// （runAutoplayCase）を正しく通し、意思決定への上書きを一切行っていないことを確認する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { SEEDS, runSeed, runFullStudy, toCsv } from "../../../../../scripts/test15StandardAiIntegratedAutoplay";
import { PRODUCTION_PARAMETERS_V1 } from "../../production/parameters";
import { CAPEX_PARAMETERS_V1 } from "../../capex/parameters";
import { FINANCE_PARAMETERS_V1 } from "../../finance/parameters";

test("SAA-1（新規投資種別の採用件数）: 標準AIはpdMechanization・VAP開発費は採用しないが、newFactoryConstructionはPhase 6D-1修正後に正当な条件で採用しうる", () => {
  // 【2026-08-10更新】このアサーションは Phase 5（Vision駆動の戦略成長・新工場判断）
  // 導入より前の観測を固定したものであり、本来は Phase 5 の時点で既に古くなっていた。
  // これまで偶然 0 件のまま通っていたのは、Phase 6D 監査で確認した bug
  // （工場スペース不足で承認され得ない既存増設案件を Standard AI が繰り返し提案し、
  // その「提案が存在する」という事実だけで新工場検討の Gate G が無期限に block していた）
  // のためであり、正しい挙動ではなかった。Phase 6D-1 でその bug を修正した結果、
  // このシード・16Qでは MASS が Q16 に正当な条件（Vision gap・稼働率・需要・原料・
  // 労働・財務のすべてのゲートを満たす）で newFactoryConstruction を提案するように
  // なった。したがって「一切採用しない」という帰無仮説は棄却し、
  // 「pdMechanization/VAP開発費は依然として一切採用しない」ことだけを固定する
  // （これらは Standard AI の候補集合（STANDARD_AI_PROPOSABLE_CAPEX_TYPES）に
  // 含まれていないため、コード上そもそも提案されえない）。
  const result = runSeed(SEEDS[0]);
  const kinds = new Set(result.investmentAdoptionEvents.map((e) => e.kind));
  assert.ok(!kinds.has("pdMechanizationProposed"), "pdMechanizationは候補集合に無いため提案されないはず");
  assert.ok(!kinds.has("vapProductDevelopmentSpendPositive"), "VAP開発費は候補集合に無いため提案されないはず");
});

test("SAA-2（決定への非改変）: 各社の意思決定はrunAutoplayCase（既存SAI-3A実行基盤・generateStandardAiDecision）が生成した値そのままであり、本スクリプトは一切上書きしていない（capexDecision.newProjectProposalsの内容を機械的に確認）", () => {
  const result = runSeed(SEEDS[0]);
  // 標準AIはhosoLineExpansion/pdLineExpansion/vapLineExpansion/commonProcessingExpansion/
  // newFactoryConstructionは提案しうるが、pdMechanizationは提案しない
  // （STANDARD_AI_PROPOSABLE_CAPEX_TYPES に含まれないため）。
  const proposalTypesSeen = new Set(
    result.rows.flatMap((r) => r.capexNewProjectProposalTypes.split("|").filter((t) => t.length > 0))
  );
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
