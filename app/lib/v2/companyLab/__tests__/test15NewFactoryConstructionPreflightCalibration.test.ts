// ShrimpX V2 — Test15前 新工場建設プリフライト校正（Phase6）の回帰テスト。
// scripts/test15NewFactoryConstructionPreflightCalibration.tsの主要ロジックが
// 実エンジンを正しく通し、共有デフォルトパラメータへ一切書き込まないことを確認する。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ENVIRONMENTS,
  runCase,
  runFullStudy,
  toCsv,
  type EnvironmentResult,
} from "../../../../../scripts/test15NewFactoryConstructionPreflightCalibration";
import { PRODUCTION_PARAMETERS_V1 } from "../../production/parameters";
import { CAPEX_PARAMETERS_V1 } from "../../capex/parameters";
import { FINANCE_PARAMETERS_V1 } from "../../finance/parameters";

test("NFPC-1（offケース）: 新設Factory提案なしのケースはnewFactoryIdを一切持たず、新設Factory関連メトリクスは常にnull/false", () => {
  const rows = runCase({
    environment: ENVIRONMENTS[0],
    caseType: "off",
    seed: "test15-newfactory-seed-1",
    horizonQuarters: 6,
    diagnosticCashGrantUsd: 0,
  });
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.equal(r.newFactoryId, null);
    assert.equal(r.newFactoryOperational, false);
    assert.equal(r.newFactoryEquipUtilizationRate, null);
    assert.equal(r.newFactoryProducedTons, null);
  }
});

test("NFPC-2（on-unstaffedケース）: 提案するとnewFactoryIdが割り当てられ、稼働開始しても手動配置なしではワーカー0人・生産0のまま", () => {
  const rows = runCase({
    environment: ENVIRONMENTS[0],
    caseType: "on-unstaffed",
    seed: "test15-newfactory-seed-1",
    horizonQuarters: 8,
    diagnosticCashGrantUsd: 80_000_000,
  });
  const withId = rows.filter((r) => r.newFactoryId !== null);
  assert.ok(withId.length > 0, "newFactoryConstruction提案後、newFactoryIdが一度も割り当てられなかった");
  const operationalRows = rows.filter((r) => r.newFactoryOperational);
  assert.ok(operationalRows.length > 0, "8四半期以内に新設Factoryが稼働開始しなかった（テスト条件の見直しが必要）");
  for (const r of operationalRows) {
    assert.equal(r.newFactoryRegularHeadcount, 0, "on-unstaffedケースなのに新設Factoryへワーカーが配置されている");
    assert.equal(r.newFactoryProducedTons, 0, "on-unstaffedケースなのに新設Factoryで生産が発生している");
  }
});

test("NFPC-3（on-staffedケース）: 稼働開始後に手動配置したワーカー人数どおりの数値がrowへ記録され、実際に生産が発生する", () => {
  const rows = runCase({
    environment: ENVIRONMENTS[0],
    caseType: "on-staffed",
    seed: "test15-newfactory-seed-1",
    horizonQuarters: 8,
    diagnosticCashGrantUsd: 400_000_000,
  });
  const operationalRows = rows.filter((r) => r.newFactoryOperational);
  assert.ok(operationalRows.length > 0);
  // 【自然な1四半期のラグ】稼働開始した、まさにその四半期の意思決定は、その四半期の
  // 開始時点（前四半期末のeffectiveFactories）を基準に組み立てるため、稼働開始後
  // 最初の四半期はまだ手動配置が反映されない（人間プレイヤーがDecisionEditorで
  // 稼働開始を確認してから入力するのと同じ制約）。稼働開始2四半期目以降は必ず
  // 期待どおりの常用人数が入る。
  const operationalRowsAfterFirst = operationalRows.slice(1);
  assert.ok(operationalRowsAfterFirst.length > 0, "稼働開始後の四半期数が足りず、手動配置反映後の四半期を検証できない");
  for (const r of operationalRowsAfterFirst) {
    assert.equal(r.newFactoryRegularHeadcount, 1500, "on-staffedケースの新設Factory常用人数が期待値(1,500人)と一致しない");
  }
  const producedAny = operationalRowsAfterFirst.some((r) => (r.newFactoryProducedTons ?? 0) > 0);
  assert.ok(producedAny, "on-staffedケースで、稼働開始後に一度も新設Factoryで生産が発生しなかった");
});

test("NFPC-4（環境ごとの需要・輸入倍率スケーリング）: 倍率が大きい環境ほど需要圧力と供給不足圧力が強くなる（意図どおりの環境構築）", () => {
  // 【観測点を変更した理由（2026-08-09・Test16）】
  // 旧命題は「倍率が大きい環境ほど会社全体の設備稼働率が高い」だった。しかし
  // 設備稼働率（＝実生産量 ÷ 共通前処理能力）は原料制約・商品構成・営業・資金・
  // capacity mix の合成結果であり、需要倍率だけで単調になる保証がない。
  // 実測でも 環境1=0.255 / 環境2=0.319 / 環境3=0.296 と非単調だった。
  //
  // このテストが本来守りたいのは「環境の強弱が意図どおり構築されていること」、
  // すなわち倍率の上昇が**需要圧力**と**供給不足圧力**を強めることである。
  // そこで倍率が直接効く指標へ観測点を移す。環境倍率をテスト通過のために
  // 再校正することはしない。
  //
  //   販売希望量        … applyDemandAndImportMultiplier が直接スケールする値（需要圧力）
  //   設備不足トン数    … その需要に対して設備が応えられなかった量（供給不足圧力）
  const horizonQuarters = 6;
  const byEnv = ENVIRONMENTS.map((env) => {
    const rows = runCase({ environment: env, caseType: "off", seed: "test15-newfactory-seed-1", horizonQuarters, diagnosticCashGrantUsd: 0 });
    const avg = (pick: (r: (typeof rows)[number]) => number) => rows.reduce((s, r) => s + pick(r), 0) / rows.length;
    return {
      demandPressure: avg((r) => r.salesDesiredQuantityTons),
      equipmentShortfall: avg((r) => r.companyEquipmentShortfallTons),
    };
  });

  // (1) 需要圧力: 倍率どおりに強くなる。
  assert.ok(byEnv[0].demandPressure < byEnv[1].demandPressure, "環境1(需要不足)の需要圧力が環境2(均衡)以上になっている");
  assert.ok(byEnv[1].demandPressure < byEnv[2].demandPressure, "環境2(均衡)の需要圧力が環境3(能力制約)以上になっている");

  // (2) 供給不足圧力: 需要が強い環境ほど設備が応えられない量が増える。
  assert.ok(byEnv[0].equipmentShortfall < byEnv[1].equipmentShortfall, "環境1(需要不足)の設備不足が環境2(均衡)以上になっている");
  assert.ok(byEnv[1].equipmentShortfall < byEnv[2].equipmentShortfall, "環境2(均衡)の設備不足が環境3(能力制約)以上になっている");
});

test("NFPC-5（共有デフォルトパラメータの不変性）: 診断用シナリオ構築（需要・輸入倍率スケーリング、現金付与、新設Factoryへの手動ワーカー・生産計画注入）を経ても、PRODUCTION_PARAMETERS_V1・CAPEX_PARAMETERS_V1・FINANCE_PARAMETERS_V1は一切変更されない", () => {
  const productionSnapshot = JSON.stringify(PRODUCTION_PARAMETERS_V1);
  const capexSnapshot = JSON.stringify(CAPEX_PARAMETERS_V1);
  const financeSnapshot = JSON.stringify(FINANCE_PARAMETERS_V1);

  runCase({ environment: ENVIRONMENTS[2], caseType: "on-staffed", seed: "test15-newfactory-seed-1", horizonQuarters: 6, diagnosticCashGrantUsd: 400_000_000 });

  assert.equal(JSON.stringify(PRODUCTION_PARAMETERS_V1), productionSnapshot, "PRODUCTION_PARAMETERS_V1が診断スクリプト実行後に変化した");
  assert.equal(JSON.stringify(CAPEX_PARAMETERS_V1), capexSnapshot, "CAPEX_PARAMETERS_V1が診断スクリプト実行後に変化した");
  assert.equal(JSON.stringify(FINANCE_PARAMETERS_V1), financeSnapshot, "FINANCE_PARAMETERS_V1が診断スクリプト実行後に変化した");
});

test("NFPC-6（CSV出力）: toCsvはヘッダー1行＋各行1レコードを出力する", () => {
  const rows = runCase({ environment: ENVIRONMENTS[0], caseType: "off", seed: "test15-newfactory-seed-1", horizonQuarters: 4, diagnosticCashGrantUsd: 0 });
  const csv = toCsv(rows);
  const lines = csv.split("\n");
  assert.equal(lines.length, rows.length + 1);
  assert.ok(lines[0].startsWith("environment,caseType,seed"));
});

test("NFPC-7（runFullStudy統合実行）: 3環境×3ケースぶんの結果が揃い、each環境で新設Factoryが遅くとも8四半期以内に稼働開始する", { timeout: 120_000 }, () => {
  const results: readonly EnvironmentResult[] = runFullStudy();
  assert.equal(results.length, ENVIRONMENTS.length);
  for (const r of results) {
    assert.ok(r.rowsOff.length > 0);
    assert.ok(r.rowsOnUnstaffed.length > 0);
    assert.ok(r.rowsOnStaffed.length > 0);
    const opRow = r.rowsOnStaffed.find((row) => row.newFactoryOperational);
    assert.ok(opRow, `${r.environment.id}: on-staffedケースで新設Factoryが稼働開始しなかった`);
    assert.ok(opRow!.quarter <= 8, `${r.environment.id}: 新設Factoryの稼働開始が想定より遅い（${opRow!.quarter}四半期目）`);
  }
});
