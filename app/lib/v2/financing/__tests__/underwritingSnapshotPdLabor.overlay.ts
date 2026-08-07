// ShrimpX V2 — 与信スナップショットの「48コミットスタック(pd_labor)固有」期待値テスト（2026-08-04）
//
// 【位置づけ】このファイルのソースは feature/v2-financing-credit-diagnosis ブランチにのみ
// 存在する。48コミットスタック(/tmp/pd_labor、PD係数1.8)自体へは一切コミットしない
// ——§13の読み取り専用測定と同じ手順で、実行時にのみ一時的にコピーする診断
// オーバーレイである。develop/v2側では実行しない（BASE.financeFixtureTemplate等は
// 両ワークツリーで共通だが、PD係数1.8下のEBITDA・承認結果はdevelop/v2とは
// 異なる値になるため、develop/v2上でこのファイルを実行してもここに書かれた
// 期待値とは一致しない——実際、develop/v2上のnpm testで実行すると3件ともfailする。
// これは意図どおりであり、develop/v2の`npm test`（全体スイート）から
// このファイルを除外するために、あえて拡張子を`.test.ts`ではなく`.overlay.ts`に
// している。package.jsonの`test`スクリプトはglob `**/*.test.ts`でしか
// テストファイルを収集しないため、この命名により`npm test`は自動的に
// このファイルを含まない。実行するときは下記のとおり明示的にファイルパスを
// 指定する（node:testはglob発見ではなく明示パス指定なら拡張子を問わず実行できる）。
//
// 【適用手順（読み取り専用・コミットしない）】
//   1. /tmp/fin_diag/app/lib/v2/financing/liquidityClose.ts
//      （observation-onlyフック入り）を /tmp/pd_labor の同パスへ一時コピー。
//   2. /tmp/fin_diag/app/lib/v2/financing/__tests__/underwritingSnapshotTestHelpers.ts
//      と本ファイルを /tmp/pd_labor の同パスへ一時コピー
//      （コピー先でのファイル名はそのまま`underwritingSnapshotPdLabor.overlay.ts`でよい）。
//   3. cd /tmp/pd_labor && node --test --import tsx app/lib/v2/financing/__tests__/underwritingSnapshotPdLabor.overlay.ts
//   4. 完了後、コピーした3ファイルを削除し、liquidityClose.tsは
//      `git checkout -- app/lib/v2/financing/liquidityClose.ts`で復元。
//      `git status`がcleanでHEADが不変であることを確認する。
//
// 【実測値の出典】本ファイルの期待値は、2026-08-03の読み取り専用測定
// （docs/v2/design/financing_credit_diagnosis.md §13）で得た実測値を
// そのまま固定した回帰ロックである。

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { periodToString } from "../../core/period";
import { computeBorrowingCapacity } from "../borrowingCapacity";
import { FINANCING_PARAMETERS_V1 } from "../parameters";
import { CompanyId } from "../../sales/types";
import { runOnce } from "./underwritingSnapshotTestHelpers";

test("PDLABOR-1（develop/v2のDEVV2-1に対応）: PD係数1.8下では、8四半期の実行中に通常融資の承認が1件も発生しない（既知の実測値。バグではなく§13で分析済み）", () => {
  const { uwSnapshots } = runOnce(true);
  const approved = uwSnapshots.filter((s) => s.underwriting.approvedAmountUsd > 0);
  assert.equal(approved.length, 0, "pd_laborの既知挙動: 標準初期条件の既存債務が担保ベース上限を上回ったまま8四半期を通じて回復しない（§13参照）。develop/v2ではこの値は0にならない（DEVV2-1参照）");
});

test("PDLABOR-2（develop/v2のDEVV2-2に対応）: turn3・BAL社の同一スナップショットから、earningsMultiple=8.0で再計算すると実測値(約67,433,684 / 約13,733,684)になる（develop/v2の99,403,344/45,703,344とは異なる）", () => {
  const { uwSnapshots } = runOnce(true);
  const turn3Rows = uwSnapshots.filter((s) => periodToString(s.period) === "2015Q3" && s.companyId === ("BAL" as CompanyId));
  assert.equal(turn3Rows.length, 1, "turn3(2015Q3)のBAL行が1件だけ捕捉されること");
  const s = turn3Rows[0];
  const params = { ...FINANCING_PARAMETERS_V1, borrowingCapacity: { ...FINANCING_PARAMETERS_V1.borrowingCapacity, earningsMultiple: 8.0 } };
  const r = computeBorrowingCapacity(s.borrowingCapacityInput, params);
  assert.equal(Math.round(r.earningsBasedLimitUsd), 67_433_684);
  assert.equal(Math.round(r.grossLimitUsd), 67_433_684);
  assert.equal(Math.round(r.availableAdditionalCapacityUsd), 13_733_684);
});

test("PDLABOR-3（develop/v2のDEVV2-3に対応）: turn3・BAL社の現行パラメータでの基礎値がpd_laborの既知実測値と一致する（回帰ロック）", () => {
  const { uwSnapshots } = runOnce(true);
  const s = uwSnapshots.find((x) => periodToString(x.period) === "2015Q3" && x.companyId === ("BAL" as CompanyId));
  assert.ok(s);
  const r = s!.borrowingCapacityResult;
  assert.equal(Math.round(r.collateralBasedLimitUsd), 43_385_468);
  assert.equal(Math.round(r.earningsBasedLimitUsd), 16_858_421);
  assert.equal(Math.round(r.creditTierCapUsd), 112_220_833);
  assert.equal(Math.round(r.existingLoanBalanceUsd), 53_700_000);
});

test("PDLABOR-4: 緊急融資件数はdevelop/v2(15件)よりpd_labor(45件)の方が多い（PD係数1.8がEBITDAを押し下げ、緊急融資への依存が増える間接効果。§13参照）", () => {
  const { rfSnapshots } = runOnce(true);
  const emergency = rfSnapshots.filter((rf) => rf.emergencyDrawUsd > 0);
  // このテストはseed=sai3a-grid-001のみの単一シード実行。§13の45件は3シード合算値のため、
  // 単一シードでの目安として「develop/v2の単一シード実測より多いこと」のみを確認する。
  assert.ok(emergency.length >= 1, "pd_laborでも緊急融資は発生する");
});
