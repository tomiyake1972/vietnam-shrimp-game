// ShrimpX V2 — MANUAL-BALANCE-1 手動バランス調整の解決規則テスト
//
// 対象: manualBalance/overrides.ts の解決SSoTと検証。
// Engine接続・非複利性・回帰は manualBalanceEngine.test.ts で実測する。

import test from "node:test";
import assert from "node:assert/strict";

import {
  MANUAL_PRICE_INDEX_NEUTRAL,
  ManualBalanceSettings,
  applyManualDividendPayoutToParams,
  resolveManualBalanceForTurn,
  resolvedDividendPayoutRatio,
  resolvedRawMarketPriceIndex,
  resolvedSalesPriceIndex,
  validateManualBalanceSettings,
  withManualBalanceContinuingApplied,
  withManualBalancePerTurnApplied,
  withManualBalanceReleased,
} from "../overrides";

function settings(patch: Partial<ManualBalanceSettings> = {}): ManualBalanceSettings {
  return {
    dividendPayout: { kind: "unspecified" },
    salesPriceIndex: undefined,
    rawMarketPriceIndex: undefined,
    ...patch,
  };
}

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T01:00:00.000Z";
const T2 = "2026-01-01T02:00:00.000Z";

// ------------------------------------------------------------------ MB-1
test("MB-1: 未設定Runでは全Turnが中立（手動補正なし）として解決される", () => {
  for (const turn of [1, 5, 32]) {
    const resolved = resolveManualBalanceForTurn(undefined, turn);
    assert.equal(resolved.appliedSource.kind, "none");
    assert.equal(resolvedSalesPriceIndex(resolved), MANUAL_PRICE_INDEX_NEUTRAL);
    assert.equal(resolvedRawMarketPriceIndex(resolved), MANUAL_PRICE_INDEX_NEUTRAL);
    assert.equal(resolvedDividendPayoutRatio(resolved), null);
  }
});

// ------------------------------------------------------------------ MB-2
test("MB-2: 明示的0%と未設定が区別される（0が既定値へフォールバックしない）", () => {
  const explicitZero = withManualBalancePerTurnApplied(
    undefined,
    3,
    settings({ dividendPayout: { kind: "specified", payoutRatio: 0 } }),
    T0
  );
  const resolvedZero = resolveManualBalanceForTurn(explicitZero, 3);
  assert.equal(resolvedDividendPayoutRatio(resolvedZero), 0, "明示的0%は0として解決される");

  const unspecified = resolveManualBalanceForTurn(undefined, 3);
  assert.equal(resolvedDividendPayoutRatio(unspecified), null, "未設定はnull（既定値を使う）");

  // paramsへの適用でも両者は別挙動になる。
  const base = { dividendBasePayoutRatio: 0.15 } as const;
  assert.equal(applyManualDividendPayoutToParams(base, resolvedZero).dividendBasePayoutRatio, 0);
  assert.equal(applyManualDividendPayoutToParams(base, unspecified).dividendBasePayoutRatio, 0.15);
});

// ------------------------------------------------------------------ MB-3
test("MB-3: 手動指定値は経営性格バイアス適用後のparamsを上書きする（AI人格に改変されない）", () => {
  const schedule = withManualBalanceContinuingApplied(
    undefined,
    1,
    settings({ dividendPayout: { kind: "specified", payoutRatio: 0.2 } }),
    T0
  );
  const resolved = resolveManualBalanceForTurn(schedule, 1);
  // 経営性格バイアスで 0.15 → 0.1575 になった後のparamsを模す。
  const biased = { dividendBasePayoutRatio: 0.1575 };
  const applied = applyManualDividendPayoutToParams(biased, resolved);
  assert.equal(applied.dividendBasePayoutRatio, 0.2, "指定値がそのまま残る（バイアスが再適用されない）");
});

// ------------------------------------------------------------------ MB-4
test("MB-4: 次1ターンのみ指定は対象Turnだけに効く", () => {
  const schedule = withManualBalancePerTurnApplied(undefined, 5, settings({ salesPriceIndex: 95 }), T0);
  assert.equal(resolvedSalesPriceIndex(resolveManualBalanceForTurn(schedule, 4)), 100);
  assert.equal(resolvedSalesPriceIndex(resolveManualBalanceForTurn(schedule, 5)), 95);
  assert.equal(resolvedSalesPriceIndex(resolveManualBalanceForTurn(schedule, 6)), 100);
});

// ------------------------------------------------------------------ MB-5
test("MB-5: 継続指定は開始Turn以降ずっと効く（毎Turn同じ指数として解決される）", () => {
  const schedule = withManualBalanceContinuingApplied(undefined, 5, settings({ rawMarketPriceIndex: 95 }), T0);
  assert.equal(resolvedRawMarketPriceIndex(resolveManualBalanceForTurn(schedule, 4)), 100);
  for (const turn of [5, 6, 7, 20]) {
    assert.equal(resolvedRawMarketPriceIndex(resolveManualBalanceForTurn(schedule, turn)), 95, `turn=${turn}`);
  }
});

// ------------------------------------------------------------------ MB-6
test("MB-6: ターン別指定は継続指定より優先される", () => {
  let schedule = withManualBalanceContinuingApplied(undefined, 1, settings({ salesPriceIndex: 90 }), T0);
  schedule = withManualBalancePerTurnApplied(schedule, 3, settings({ salesPriceIndex: 110 }), T1);
  assert.equal(resolvedSalesPriceIndex(resolveManualBalanceForTurn(schedule, 2)), 90, "継続が効く");
  assert.equal(resolvedSalesPriceIndex(resolveManualBalanceForTurn(schedule, 3)), 110, "ターン別が勝つ");
  assert.equal(resolvedSalesPriceIndex(resolveManualBalanceForTurn(schedule, 4)), 90, "翌Turnは継続へ戻る");
});

// ------------------------------------------------------------------ MB-7
test("MB-7: 解除は指定Turn以降の既存設定を無効化し、解除後の新規設定は再び有効になる", () => {
  let schedule = withManualBalanceContinuingApplied(undefined, 1, settings({ salesPriceIndex: 90 }), T0);
  schedule = withManualBalanceReleased(schedule, 5, T1);
  assert.equal(resolvedSalesPriceIndex(resolveManualBalanceForTurn(schedule, 4)), 90, "解除前のTurnは影響を受けない");
  assert.equal(resolvedSalesPriceIndex(resolveManualBalanceForTurn(schedule, 5)), 100, "解除Turn以降は元のルールへ戻る");

  schedule = withManualBalanceContinuingApplied(schedule, 7, settings({ salesPriceIndex: 105 }), T2);
  assert.equal(resolvedSalesPriceIndex(resolveManualBalanceForTurn(schedule, 6)), 100, "解除は継続している");
  assert.equal(resolvedSalesPriceIndex(resolveManualBalanceForTurn(schedule, 7)), 105, "解除後の新規設定は効く");
});

// ------------------------------------------------------------------ MB-8
test("MB-8: 販売指数のみ／原料指数のみを独立に指定できる", () => {
  const salesOnly = withManualBalanceContinuingApplied(undefined, 1, settings({ salesPriceIndex: 95 }), T0);
  const r1 = resolveManualBalanceForTurn(salesOnly, 1);
  assert.equal(resolvedSalesPriceIndex(r1), 95);
  assert.equal(resolvedRawMarketPriceIndex(r1), 100, "原料は中立のまま");
  assert.equal(resolvedDividendPayoutRatio(r1), null, "配当は未設定のまま");

  const rawOnly = withManualBalanceContinuingApplied(undefined, 1, settings({ rawMarketPriceIndex: 105 }), T0);
  const r2 = resolveManualBalanceForTurn(rawOnly, 1);
  assert.equal(resolvedRawMarketPriceIndex(r2), 105);
  assert.equal(resolvedSalesPriceIndex(r2), 100, "販売は中立のまま");
});

// ------------------------------------------------------------------ MB-9
test("MB-9: 入力検証が空欄由来の0・単位間違い・範囲外を弾く", () => {
  // 0 は価格指数として不正（空欄が0として送信された場合に該当）。
  assert.ok(validateManualBalanceSettings(settings({ salesPriceIndex: 0 })).length > 0);
  // 0.95 は「95」と書くべき単位間違い。
  assert.ok(validateManualBalanceSettings(settings({ rawMarketPriceIndex: 0.95 })).length > 0);
  // 非有限。
  assert.ok(validateManualBalanceSettings(settings({ salesPriceIndex: Number.NaN })).length > 0);
  // 配当性向の範囲外（101%）。
  assert.ok(validateManualBalanceSettings(settings({ dividendPayout: { kind: "specified", payoutRatio: 1.01 } })).length > 0);

  // 正常系はエラーなし（0%配当・中立指数を含む）。
  assert.deepEqual(validateManualBalanceSettings(settings({ dividendPayout: { kind: "specified", payoutRatio: 0 } })), []);
  assert.deepEqual(validateManualBalanceSettings(settings({ salesPriceIndex: 100, rawMarketPriceIndex: 95 })), []);
});

// ------------------------------------------------------------------ MB-10
test("MB-10: 同一対象への再設定は後から記録したものが勝つ（変更履歴は残る）", () => {
  let schedule = withManualBalancePerTurnApplied(undefined, 4, settings({ salesPriceIndex: 90 }), T0);
  schedule = withManualBalancePerTurnApplied(schedule, 4, settings({ salesPriceIndex: 120 }), T1);
  assert.equal(schedule.length, 2, "履歴として両方残る");
  assert.equal(resolvedSalesPriceIndex(resolveManualBalanceForTurn(schedule, 4)), 120, "新しい方が適用される");
});
