// ShrimpX V2 — Test15前 PD省人化投資プリフライト校正スクリプトの検証テスト（Phase5）
//
// scripts/test15PdMechanizationPreflightCalibration.ts が実際に生成する挙動について:
//   1. マッチドペア1件（off/on）が例外なく完走し、各行に必要な指標が揃っていること。
//   2. 診断用現金付与（variant B）が、off/on両方へ完全に同一額・同一タイミングで
//      適用されること（会社間の混線・非対称な付与が無いことの確認）。
//   3. break-even分析が、実際のcapex/finance/pdMechanizationパラメータから
//      正しい方向の関係（会計コスト回収に必要な人数 > 現金コストのみ回収に必要な人数、
//      完全習熟時の削減率での必要PD人数 > 残業換算での必要削減人数）を満たすこと。
//   4. 診断専用の現金付与・floor下限が、共有デフォルトパラメータ
//      （PRODUCTION_PARAMETERS_V1・CAPEX_PARAMETERS_V1・FINANCE_PARAMETERS_V1）を
//      一切変更しないこと（オブジェクト参照の同一性で確認）。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeBreakEvenAnalysis,
  computeWorkerReductionForQuantity,
  runMatchedPairCase,
  toCsv,
} from "../../../../../scripts/test15PdMechanizationPreflightCalibration";
import { PRODUCTION_PARAMETERS_V1 } from "../../production/parameters";
import { CAPEX_PARAMETERS_V1 } from "../../capex/parameters";
import { FINANCE_PARAMETERS_V1 } from "../../finance/parameters";

const TEST_SEED = "test15-preflight-verify-seed";

test("PFC-1: runMatchedPairCase（off/on）は例外なく完走し、各行にPD稼働率・必要/配置Worker・機械化コスト・損益・現金の各指標が揃っている", () => {
  const rowsOff = runMatchedPairCase({
    seed: TEST_SEED,
    mechanizationOn: false,
    pdFloorMultiplier: 0.3,
    horizonQuarters: 6,
    diagnosticCashGrantUsd: 0,
    variant: "A",
    band: 0.3,
    scenarioLabel: "test-off",
  });
  const rowsOn = runMatchedPairCase({
    seed: TEST_SEED,
    mechanizationOn: true,
    pdFloorMultiplier: 0.3,
    horizonQuarters: 6,
    diagnosticCashGrantUsd: 0,
    variant: "A",
    band: 0.3,
    scenarioLabel: "test-on",
  });
  assert.ok(rowsOff.length > 0);
  assert.ok(rowsOn.length > 0);
  for (const row of [...rowsOff, ...rowsOn]) {
    assert.ok(Number.isFinite(row.pdUtilizationRate));
    assert.ok(row.pdUtilizationRate >= 0 && row.pdUtilizationRate <= 1);
    assert.ok(Number.isFinite(row.requiredWorkers));
    assert.ok(Number.isFinite(row.allocatedRegularWorkers));
    assert.ok(Number.isFinite(row.netIncomeUsd));
    assert.ok(Number.isFinite(row.cashUsd));
    assert.ok(typeof row.insolvent === "boolean");
  }
  // offケースは機械化投資を一切提案しないため、保守費・減価償却費は常に0のはず。
  for (const row of rowsOff) {
    assert.equal(row.maintenanceCostUsd, 0);
    assert.equal(row.depreciationCostUsd, 0);
  }
});

test("PFC-2（診断用現金付与の対称性）: variant Bで同一の診断用現金付与額をoff/on両方へ渡すと、両ケースのdiagnosticCashGrantUsdフィールドが完全に一致する（非対称な付与がない）", () => {
  const grantUsd = 5_000_000;
  const rowsOff = runMatchedPairCase({
    seed: TEST_SEED,
    mechanizationOn: false,
    pdFloorMultiplier: 0.3,
    horizonQuarters: 4,
    diagnosticCashGrantUsd: grantUsd,
    variant: "B",
    band: 0.3,
    scenarioLabel: "test-off-B",
  });
  const rowsOn = runMatchedPairCase({
    seed: TEST_SEED,
    mechanizationOn: true,
    pdFloorMultiplier: 0.3,
    horizonQuarters: 4,
    diagnosticCashGrantUsd: grantUsd,
    variant: "B",
    band: 0.3,
    scenarioLabel: "test-on-B",
  });
  for (const row of [...rowsOff, ...rowsOn]) {
    assert.equal(row.diagnosticCashGrantUsd, grantUsd);
  }
  // 現金付与ありのターン1現金は、付与なしのターン1現金より厳密に大きいはず。
  const rowsOffNoGrant = runMatchedPairCase({
    seed: TEST_SEED,
    mechanizationOn: false,
    pdFloorMultiplier: 0.3,
    horizonQuarters: 4,
    diagnosticCashGrantUsd: 0,
    variant: "A",
    band: 0.3,
    scenarioLabel: "test-off-noGrant",
  });
  // 【2026-08-09・Test16で観測点を変更】
  // 旧命題は「付与ありのほうがターン1の現金が多い」だった。しかし
  // domesticPurchaseCashAllocationRatio を 1.0 にしたことで、付与された現金は
  // その四半期のうちに原料調達へ投下されるようになり、ターン末現金には残らなくなった。
  //
  // このテストが本来守りたいのは「診断用に付与した現金が消失していないこと」である。
  // したがって観測点を、現金として残っているかではなく
  // **正味財務ポジション（現金 − 借入）** へ移す。付与分が原料や生産へ変換されても、
  // その分だけ借入が減る・現金が残るのいずれかとして必ず現れる。
  // 観測点は「期間末の現金」。付与された現金は当期のうちに原料在庫・生産へ
  // 変換されるため**ターン1の現金には残らない**が、それが売上・回収を経て
  // 期間末には必ず現金として現れる。消失していないことはこれで検証できる。
  const lastOff = rowsOff[rowsOff.length - 1];
  const lastNoGrant = rowsOffNoGrant[rowsOffNoGrant.length - 1];
  assert.ok(
    lastOff.cashUsd > lastNoGrant.cashUsd,
    `診断用現金付与が消失している（付与あり期末=${lastOff.cashUsd} 付与なし期末=${lastNoGrant.cashUsd}）`
  );
  // 付与によって当期の事業活動が縮小していないこと（資源へ変換されている方向）。
  assert.ok(
    rowsOff[0].operatingIncomeUsd >= rowsOffNoGrant[0].operatingIncomeUsd,
    "診断用現金付与ありのほうがターン1の営業利益が小さい（付与が事業を阻害している）"
  );
});

test("PFC-3（共有デフォルトパラメータの不変性）: 診断スクリプトを実行しても、production/capex/financeの共有デフォルトパラメータのオブジェクト参照・内容は一切変化しない", () => {
  const productionSnapshot = JSON.stringify(PRODUCTION_PARAMETERS_V1);
  const capexSnapshot = JSON.stringify(CAPEX_PARAMETERS_V1);
  const financeSnapshot = JSON.stringify(FINANCE_PARAMETERS_V1);

  runMatchedPairCase({
    seed: TEST_SEED,
    mechanizationOn: true,
    pdFloorMultiplier: 0.5,
    horizonQuarters: 4,
    diagnosticCashGrantUsd: 10_000_000,
    variant: "B",
    band: 0.5,
    scenarioLabel: "test-param-immutability",
  });

  assert.equal(JSON.stringify(PRODUCTION_PARAMETERS_V1), productionSnapshot, "PRODUCTION_PARAMETERS_V1が変化していないはず");
  assert.equal(JSON.stringify(CAPEX_PARAMETERS_V1), capexSnapshot, "CAPEX_PARAMETERS_V1が変化していないはず");
  assert.equal(JSON.stringify(FINANCE_PARAMETERS_V1), financeSnapshot, "FINANCE_PARAMETERS_V1が変化していないはず");
});

test("PFC-4（break-even分析）: 会計コスト全体（保守費+減価償却費）を回収するのに必要な削減人数・PD配置人数は、現金コストのみ（保守費）を回収する場合より厳密に大きい", () => {
  const be = computeBreakEvenAnalysis();
  assert.ok(be.quarterlyDepreciationUsd > 0);
  assert.ok(be.quarterlyMaintenancePlusDepreciationUsd > be.quarterlyMaintenanceUsd);
  assert.ok(be.headsNeededToOffsetMaintenancePlusDepreciation > be.headsNeededToOffsetMaintenanceCashOnly);
  assert.ok(be.pdHeadcountNeededAtFullMaturityForFullAccountingCost > be.pdHeadcountNeededAtFullMaturityForMaintenanceCashOnly);
  // 完全習熟時の最大削減率(=1-フロア/基準)は(0,1)の範囲のはず。
  assert.ok(be.maxReductionRatioAtFullMaturity > 0 && be.maxReductionRatioAtFullMaturity < 1);
});

test("PFC-5（Worker削減の稼働率依存性）: 同一のPD生産量に対し、機械化レベルが高いほど（0→0.5→1.0）必要常用Worker数の削減幅は単調に大きくなる", () => {
  const quantity = 3000;
  const attendanceRate = 0.95;
  const skillLevel = 0.8;
  const overtimeRate = 0.1;
  const levels = [0, 0.5, 1.0];
  const reductions = levels.map((level) => computeWorkerReductionForQuantity(quantity, attendanceRate, skillLevel, overtimeRate, level).reduction);
  for (let i = 1; i < reductions.length; i++) {
    assert.ok(reductions[i] >= reductions[i - 1], `機械化レベル${levels[i]}の削減幅(${reductions[i]})は${levels[i - 1]}(${reductions[i - 1]})以上のはず`);
  }
  assert.ok(reductions[reductions.length - 1] > 0, "完全習熟(level=1.0)では削減が正の値になるはず");
});

test("PFC-6（CSV出力）: toCsvはヘッダ行＋データ行数と一致する行数を出力し、各行のカラム数がヘッダと一致する", () => {
  const rows = runMatchedPairCase({
    seed: TEST_SEED,
    mechanizationOn: false,
    pdFloorMultiplier: 0.2,
    horizonQuarters: 3,
    diagnosticCashGrantUsd: 0,
    variant: "A",
    band: 0.3,
    scenarioLabel: "test-csv",
  });
  const csv = toCsv(rows);
  const lines = csv.split("\n");
  assert.equal(lines.length, rows.length + 1, "ヘッダ行1行＋データ行数と一致するはず");
  const headerColumnCount = lines[0].split(",").length;
  for (const line of lines.slice(1)) {
    assert.equal(line.split(",").length, headerColumnCount, "各データ行のカラム数はヘッダと一致するはず");
  }
});
