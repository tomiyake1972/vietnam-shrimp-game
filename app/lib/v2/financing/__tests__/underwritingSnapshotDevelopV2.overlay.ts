// ShrimpX V2 — 与信スナップショットの「develop/v2固有」期待値テスト（2026-08-04）
//
// 【位置づけ】ここに含めるのは、develop/v2の現行fixture・パラメータ下でのみ
// 成立する具体的な数値（承認件数・EBITDA金額等）を主張するテスト。
// 48コミットスタック(pd_labor、PD係数1.8)では異なる実測値になるため、
// pd_labor向けの等価テストは underwritingSnapshotPdLabor.overlay.ts に分離している
// （旧underwritingSnapshotRealPath.test.tsのSNAP-8・SNAP-11がこの分離前の形で、
// pd_laborでは実際にfailしていた）。
//
// 【Test15統合branchでの拡張子変更（.test.ts → .overlay.ts）】
// このファイルはdevelop/v2固有の実測値を固定する回帰ロックであり、その意味は
// 「develop/v2ではこの値になる」ことそのものにある。Test15統合branchでは
// 営業処理能力曲線の再校正（capacityMaxIncrementTons=24000 /
// capacitySaturationHeadcount=70）と商品別労働集約度（HOSO:PD:VAP=1.0:1.2:3.0）
// により会社の財務トラジェクトリが変わるため、DEVV2-2・DEVV2-3の金額は
// develop/v2とは一致しなくなる。
//
// ここで統合branchの実測値へ書き換えてしまうと「develop/v2固有の値を固定する」
// というテストの意味自体が失われるため、期待値は一切変更していない。かわりに、
// 既にある underwritingSnapshotPdLabor.overlay.ts と同じ方式で、拡張子を
// `.test.ts` から `.overlay.ts` へ変えて既定のtest glob（package.jsonの
// `test`スクリプトは `**/*.test.ts` でしか収集しない）から外している。
// node:testはglob発見ではなく明示パス指定なら拡張子を問わず実行できるため、
// develop/v2ワークツリー上では従来どおり検証できる。
//
// なお、ブランチに依存しない不変条件（observation-only性・決定性・再計算一致・
// ロールフォワード整合など10件）は underwritingSnapshotInvariants.test.ts 側に
// あり、そちらは統合branchでも通常のtest globで実行され続ける。
//
// 【実行方法】develop/v2ワークツリーでのみ実行する:
//   cd <develop/v2 worktree> && node --test --import tsx app/lib/v2/financing/__tests__/underwritingSnapshotDevelopV2.overlay.ts

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { periodToString } from "../../core/period";
import { computeBorrowingCapacity } from "../borrowingCapacity";
import { FINANCING_PARAMETERS_V1 } from "../parameters";
import { CompanyId } from "../../sales/types";
import { runOnce } from "./underwritingSnapshotTestHelpers";

test("DEVV2-1（旧SNAP-8）: develop/v2の標準初期条件下では、8四半期の実行中に少なくとも1件は通常融資が承認される", () => {
  const { uwSnapshots } = runOnce(true);
  const approved = uwSnapshots.filter((s) => s.underwriting.approvedAmountUsd > 0);
  assert.ok(approved.length > 0, "develop/v2の既知挙動: standard baseline実行中に少なくとも1件は通常融資が承認される（pd_laborでは0件になる。§13参照）");
  // 参考実測値（seed=sai3a-grid-001のみ）: 承認44件/申請105件、緊急融資15件。
});

test("DEVV2-2（旧SNAP-11）: turn3・BAL社の同一スナップショットから、earningsMultiple=8.0で再計算すると三宅さんの手計算(約99.403344M / 約45.703344M)と一致する", () => {
  const { uwSnapshots } = runOnce(true);
  const turn3Rows = uwSnapshots.filter((s) => periodToString(s.period) === "2015Q3" && s.companyId === ("BAL" as CompanyId));
  assert.equal(turn3Rows.length, 1, "turn3(2015Q3)のBAL行が1件だけ捕捉されること");
  const s = turn3Rows[0];
  const params = { ...FINANCING_PARAMETERS_V1, borrowingCapacity: { ...FINANCING_PARAMETERS_V1.borrowingCapacity, earningsMultiple: 8.0 } };
  const r = computeBorrowingCapacity(s.borrowingCapacityInput, params);
  assert.equal(Math.round(r.earningsBasedLimitUsd), 99_403_344);
  assert.equal(Math.round(r.grossLimitUsd), 99_403_344);
  assert.equal(Math.round(r.availableAdditionalCapacityUsd), 45_703_344);
});

test("DEVV2-3: turn3・BAL社の現行パラメータでの基礎値がdevelop/v2の既知実測値と一致する（回帰ロック）", () => {
  const { uwSnapshots } = runOnce(true);
  const s = uwSnapshots.find((x) => periodToString(x.period) === "2015Q3" && x.companyId === ("BAL" as CompanyId));
  assert.ok(s);
  const r = s!.borrowingCapacityResult;
  assert.equal(Math.round(r.collateralBasedLimitUsd), 44_707_642);
  assert.equal(Math.round(r.earningsBasedLimitUsd), 24_850_836);
  assert.equal(Math.round(r.creditTierCapUsd), 118_460_917);
  assert.equal(Math.round(r.existingLoanBalanceUsd), 53_700_000);
});
