// ShrimpX V2 — MANUAL-BALANCE-1 Engine接続の実測テスト
//
// 【方針】仮定で通さない。指数がどこへ効いたかを、確定済みのmarketResultと
// 適用記録の実測値で確認する。特に
//   ・手動設定なしのRunが既存baseと完全一致すること（回帰）
//   ・継続指数が複利にならないこと（毎Turnの補正前価格に対して1回だけ）
//   ・販売指数が原料調達チャネル（hosoPrices・buyingCeiling）を汚染しないこと
//   ・再クランプせず、制約外では監査警告が残ること
// を実測する。

import test from "node:test";
import assert from "node:assert/strict";

import { createSimulationSession, advanceSimulationTurns, applyManualBalanceScheduleToSession } from "../../simulation/engine";
import { buildResumePayload, restoreSessionFromResumePayload } from "../../simulation/persistence/resume";
import type { SimulationSession } from "../../simulation/types";
import {
  ManualBalanceSettings,
  resolveManualBalanceForTurn,
  resolvedDividendPayoutRatio,
  resolvedRawMarketPriceIndex,
  resolvedSalesPriceIndex,
  withManualBalanceContinuingApplied,
  withManualBalancePerTurnApplied,
} from "../overrides";

const SCENARIO_ID = "baseline";
const TS = "2026-01-01T00:00:00.000Z";

function settings(patch: Partial<ManualBalanceSettings> = {}): ManualBalanceSettings {
  return {
    dividendPayout: { kind: "unspecified" },
    salesPriceIndex: undefined,
    rawMarketPriceIndex: undefined,
    ...patch,
  };
}

function newSession(runId: string): SimulationSession {
  return createSimulationSession({
    simulationRunId: runId,
    scenarioId: SCENARIO_ID,
    seed: "manual-balance-seed",
    requestedTurns: 8,
    startedAt: TS,
  });
}

function runTurns(session: SimulationSession, turns: number): SimulationSession {
  return advanceSimulationTurns({ session, turns, timestamp: TS });
}

/**
 * 経済結果の比較用。設定スケジュールそのもの（config.manualBalanceOverrides）は
 * 「設定を入れたかどうか」の差であり経済結果ではないため除外する。
 * 除外するのはこの1キーだけで、history・marketResult・財務結果はすべて比較対象。
 */
function comparableState(session: SimulationSession): string {
  const configWithoutSchedule = { ...session.state.config };
  delete (configWithoutSchedule as { manualBalanceOverrides?: unknown }).manualBalanceOverrides;
  return JSON.stringify({ ...session.state, config: configWithoutSchedule });
}

// ----------------------------------------------------------------- MBE-1
test("MBE-1: 手動設定なしのRunは、この機能の導入前と同一の結果になる（回帰）", () => {
  const withoutOverride = runTurns(newSession("mb-none"), 8);

  // 明示的に中立(100/100)のスケジュールを与えたRunも、同じ結果でなければならない。
  // 「未設定」と「中立を明示」が別結果になると、既定値の扱いが壊れている。
  const neutralSchedule = withManualBalanceContinuingApplied(
    undefined,
    1,
    settings({ salesPriceIndex: 100, rawMarketPriceIndex: 100 }),
    TS
  );
  const withNeutral = runTurns(applyManualBalanceScheduleToSession(newSession("mb-none"), neutralSchedule), 8);

  // 巨大なJSONをそのままassert.equalへ渡すと失敗時の出力が数MBになるため、
  // 一致判定はboolean化してから行う（差分が出た場合は下で場所を特定する）。
  const neutralJson = comparableState(withNeutral);
  const baseJson = comparableState(withoutOverride);
  if (neutralJson !== baseJson) {
    // どのTurnのどの断面が違うのかだけを示す（全文は出さない）。
    const mismatchTurns = withoutOverride.state.history
      .map((entry, index) => ({
        turn: entry.turn,
        same: JSON.stringify(entry) === JSON.stringify(withNeutral.state.history[index]),
      }))
      .filter((r) => !r.same)
      .map((r) => r.turn);
    assert.fail(`中立指数のRunが未設定Runと一致しない（中立が中立でない）。差分Turn: ${mismatchTurns.join(",") || "history以外"}`);
  }
});

// ----------------------------------------------------------------- MBE-2
test("MBE-2: 未設定Runのconfigに手動バランスのキー自体が現れない（保存JSONが増えない）", () => {
  const session = runTurns(newSession("mb-key"), 2);
  assert.ok(
    !Object.prototype.hasOwnProperty.call(session.state.config, "manualBalanceOverrides"),
    "未設定なのにmanualBalanceOverridesキーが作られている"
  );
  const serialized = JSON.stringify(session.state.history[0].marketResult);
  assert.ok(!serialized.includes("manualRawMarketPriceIndex"), "中立なのに原料指数キーが保存結果へ現れている");
  assert.ok(!serialized.includes("manualSalesPriceIndex"), "中立なのに販売指数キーが保存結果へ現れている");
  assert.ok(!serialized.includes("preManualRawMarketPrice"), "中立なのに補正前価格キーが保存結果へ現れている");
});

// ----------------------------------------------------------------- MBE-3
test("MBE-3: 継続指数95は毎Turnの補正前価格の95%であり、複利にならない", () => {
  const schedule = withManualBalanceContinuingApplied(undefined, 1, settings({ rawMarketPriceIndex: 95 }), TS);
  const session = runTurns(applyManualBalanceScheduleToSession(newSession("mb-raw95"), schedule), 6);

  const applied = session.manualBalanceApplied;
  assert.ok(applied !== undefined && applied.length === 6, "適用記録が6Turnぶん無い");

  for (const record of applied) {
    assert.equal(record.manualRawMarketPriceIndex, 95, `turn=${record.turn}`);
    // そのTurnの補正前価格に対して厳密に95%であること。
    const expected = record.preManualRawMarketPrice * 0.95;
    assert.ok(
      Math.abs(record.appliedRawMarketPrice - expected) < 1e-9,
      `turn=${record.turn}: applied=${record.appliedRawMarketPrice} expected=${expected}`
    );
    // 複利なら applied/preManual が 0.95^n へ落ちていく。常に0.95であることを確認する。
    const ratio = record.appliedRawMarketPrice / record.preManualRawMarketPrice;
    assert.ok(Math.abs(ratio - 0.95) < 1e-9, `turn=${record.turn}: 比率が0.95でない（複利化の疑い）ratio=${ratio}`);
  }

  // 補正前価格そのものが 0.95^n で単調に潰れていないこと（前Turnの適用後価格を
  // 次Turnの基準にしていたら、preManual側が指数関数的に下がっていく）。
  const firstPre = applied[0].preManualRawMarketPrice;
  const lastPre = applied[applied.length - 1].preManualRawMarketPrice;
  assert.ok(lastPre > firstPre * Math.pow(0.95, 5), `補正前価格が複利で潰れている: ${firstPre} → ${lastPre}`);
});

// ----------------------------------------------------------------- MBE-4
test("MBE-4: 原料指数は表示だけでなく、確定済みmarketResultの成立価格そのものを変える", () => {
  const baseline = runTurns(newSession("mb-raw-base"), 3);
  const schedule = withManualBalanceContinuingApplied(undefined, 1, settings({ rawMarketPriceIndex: 80 }), TS);
  const adjusted = runTurns(applyManualBalanceScheduleToSession(newSession("mb-raw-adj"), schedule), 3);

  const basePrice = Number(baseline.state.history[0].marketResult.vietnamDomestic.price);
  const adjPrice = Number(adjusted.state.history[0].marketResult.vietnamDomestic.price);
  assert.ok(adjPrice < basePrice, `適用後価格が下がっていない: base=${basePrice} adj=${adjPrice}`);

  const vd = adjusted.state.history[0].marketResult.vietnamDomestic;
  assert.equal(vd.manualRawMarketPriceIndex, 80);
  assert.ok(vd.preManualRawMarketPrice !== undefined, "補正前価格が記録されていない");
  assert.ok(vd.appliedRawMarketPrice !== undefined, "適用後価格が記録されていない");
  // 4フィールドが1つに潰されていないこと。
  assert.notEqual(Number(vd.preManualRawMarketPrice), Number(vd.appliedRawMarketPrice));
  assert.equal(Number(vd.appliedRawMarketPrice), Number(vd.price), "priceが適用後価格になっていない");
});

// ----------------------------------------------------------------- MBE-5
test("MBE-5: 販売指数は原料調達チャネル（HOSO価格・買付上限）を汚染しない", () => {
  const baseline = runTurns(newSession("mb-sales-base"), 3);
  const schedule = withManualBalanceContinuingApplied(undefined, 1, settings({ salesPriceIndex: 80 }), TS);
  const adjusted = runTurns(applyManualBalanceScheduleToSession(newSession("mb-sales-adj"), schedule), 1);

  const baseMr = baseline.state.history[0].marketResult;
  const adjMr = adjusted.state.history[0].marketResult;

  // 販売指数はHOSO清算価格・買付上限・農家留保価格を変えない
  // （変えてしまうと「販売価格を下げたのに原料も安くなる」二重作用になる）。
  for (const country of ["VN", "EC", "IN", "ID"] as const) {
    assert.equal(
      Number(adjMr.hosoPrices[country].price),
      Number(baseMr.hosoPrices[country].price),
      `hosoPrices.${country} が販売指数で変化している`
    );
  }
  assert.equal(
    Number(adjMr.vietnamDomestic.buyingCeiling),
    Number(baseMr.vietnamDomestic.buyingCeiling),
    "buyingCeiling が販売指数で変化している"
  );
  assert.equal(
    Number(adjMr.vietnamDomestic.farmerReservationPrice),
    Number(baseMr.vietnamDomestic.farmerReservationPrice),
    "farmerReservationPrice が販売指数で変化している"
  );

  // 一方で販売基準価格そのものは 80% になっていること。
  const applied = adjusted.manualBalanceApplied;
  assert.ok(applied !== undefined && applied.length === 1);
  const record = applied[0];
  assert.equal(record.manualSalesPriceIndex, 80);
  for (const [market, byProduct] of Object.entries(record.appliedSalesReferencePrices)) {
    for (const [product, appliedPrice] of Object.entries(byProduct)) {
      const pre = record.preManualSalesReferencePrices[market][product];
      assert.ok(Math.abs(appliedPrice - pre * 0.8) < 1e-9, `${market}.${product}: applied=${appliedPrice} pre=${pre}`);
    }
  }
});

// ----------------------------------------------------------------- MBE-6
test("MBE-6: 極端な指数でも再クランプせず、制約外では監査警告が残る", () => {
  // 原料価格を大きく下げると農家留保価格を下回る領域へ入る。
  const schedule = withManualBalanceContinuingApplied(undefined, 1, settings({ rawMarketPriceIndex: 5 }), TS);
  const session = runTurns(applyManualBalanceScheduleToSession(newSession("mb-clamp"), schedule), 2);

  const applied = session.manualBalanceApplied;
  assert.ok(applied !== undefined && applied.length === 2);

  for (const record of applied) {
    // 再クランプしていない＝厳密に5%であること。
    const ratio = record.appliedRawMarketPrice / record.preManualRawMarketPrice;
    assert.ok(Math.abs(ratio - 0.05) < 1e-9, `turn=${record.turn}: 再クランプされている ratio=${ratio}`);
  }

  const warnings = applied.flatMap((r) => r.warnings);
  assert.ok(warnings.length > 0, "制約外なのに監査警告が1件も出ていない");
  assert.ok(
    warnings.some((w) => w.code === "RAW_APPLIED_PRICE_BELOW_FARMER_RESERVATION"),
    `期待した警告コードが無い: ${warnings.map((w) => w.code).join(",")}`
  );
});

// ----------------------------------------------------------------- MBE-7
test("MBE-7: 保存・再開でスケジュールと適用記録が失われない", () => {
  const schedule = withManualBalancePerTurnApplied(
    withManualBalanceContinuingApplied(undefined, 1, settings({ salesPriceIndex: 95 }), TS),
    3,
    settings({ rawMarketPriceIndex: 105 }),
    TS
  );
  const session = runTurns(applyManualBalanceScheduleToSession(newSession("mb-resume"), schedule), 4);

  const payload = JSON.parse(JSON.stringify(buildResumePayload(session, {}, {}))) as ReturnType<typeof buildResumePayload>;
  const restored = restoreSessionFromResumePayload(session.run, payload);

  // スケジュールは state.config 経由で往復し、session.config 側にも復元される。
  //
  // 【比較は解決後の挙動で行う】JSON往復では値が undefined のキーが単に消えるため
  // （{rawMarketPriceIndex: undefined} → {}）、オブジェクトの構造比較では
  // 実質同一でも差分に見える。保存・再開で守るべきなのは「各Turnに解決される値が
  // 変わらないこと」なので、そちらを実測する。
  assert.ok(restored.state.config.manualBalanceOverrides !== undefined, "state.config のスケジュールが失われた");
  assert.ok(
    restored.config.manualBalanceOverrides !== undefined,
    "session.config のスケジュールが失われた（Vision Calibrationで起きた欠落と同型）"
  );
  assert.equal(
    restored.state.config.manualBalanceOverrides?.length,
    session.state.config.manualBalanceOverrides?.length,
    "スケジュールの件数が変わった"
  );
  for (const turn of [1, 2, 3, 4, 5, 6]) {
    const before = resolveManualBalanceForTurn(session.state.config.manualBalanceOverrides, turn);
    const after = resolveManualBalanceForTurn(restored.state.config.manualBalanceOverrides, turn);
    assert.equal(resolvedSalesPriceIndex(after), resolvedSalesPriceIndex(before), `turn=${turn} 販売指数`);
    assert.equal(resolvedRawMarketPriceIndex(after), resolvedRawMarketPriceIndex(before), `turn=${turn} 原料指数`);
    assert.equal(resolvedDividendPayoutRatio(after), resolvedDividendPayoutRatio(before), `turn=${turn} 配当性向`);
    assert.equal(after.appliedSource.kind, before.appliedSource.kind, `turn=${turn} 由来`);
  }

  assert.equal(restored.manualBalanceApplied?.length, session.manualBalanceApplied?.length, "適用記録の件数が変わった");
  for (const [index, record] of (session.manualBalanceApplied ?? []).entries()) {
    const restoredRecord = restored.manualBalanceApplied?.[index];
    assert.ok(restoredRecord !== undefined, `適用記録[${index}]が失われた`);
    assert.equal(restoredRecord.turn, record.turn);
    assert.equal(restoredRecord.manualSalesPriceIndex, record.manualSalesPriceIndex);
    assert.equal(restoredRecord.manualRawMarketPriceIndex, record.manualRawMarketPriceIndex);
    assert.equal(restoredRecord.preManualRawMarketPrice, record.preManualRawMarketPrice);
    assert.equal(restoredRecord.appliedRawMarketPrice, record.appliedRawMarketPrice);
    assert.equal(restoredRecord.manualDividendPayoutRatio, record.manualDividendPayoutRatio);
  }

  // 再開後に進めても、設定が効き続ける。
  const advanced = advanceSimulationTurns({ session: restored, turns: 1, timestamp: TS });
  const applied = advanced.manualBalanceApplied;
  assert.ok(applied !== undefined && applied.length === 5, "再開後のTurnの適用記録が積まれていない");
  assert.equal(applied[4].manualSalesPriceIndex, 95, "再開後も継続設定が効いていない");
});

// ----------------------------------------------------------------- MBE-8
test("MBE-8: 適用記録は原料の4フィールドを個別に保持する（1つに潰さない）", () => {
  const schedule = withManualBalanceContinuingApplied(undefined, 1, settings({ rawMarketPriceIndex: 90 }), TS);
  const session = runTurns(applyManualBalanceScheduleToSession(newSession("mb-fields"), schedule), 1);
  const record = session.manualBalanceApplied?.[0];
  assert.ok(record !== undefined);

  // Scenario由来の捕捉指数と手動指数が別フィールドで保持されている。
  assert.equal(typeof record.scenarioRawPriceCaptureIndex, "number");
  assert.equal(typeof record.preManualRawMarketPrice, "number");
  assert.equal(record.manualRawMarketPriceIndex, 90);
  assert.equal(typeof record.appliedRawMarketPrice, "number");
  assert.notEqual(record.scenarioRawPriceCaptureIndex, record.manualRawMarketPriceIndex, "2つの指数が同一値へ潰れている");
  assert.ok(
    Math.abs(record.appliedRawMarketPrice - record.preManualRawMarketPrice * 0.9) < 1e-9,
    "補正前と適用後の関係が記録から再現できない"
  );
});

// ----------------------------------------------------------------- MBE-9
test("MBE-9: 手動配当性向がStandard AIの配当判断へ届く（Q4・既存の計算構造は不変）", () => {
  // 配当性向0%（明示的に配当しない）を指定したRunと、未設定のRunをQ4まで進めて比較する。
  const zeroSchedule = withManualBalanceContinuingApplied(
    undefined,
    1,
    settings({ dividendPayout: { kind: "specified", payoutRatio: 0 } }),
    TS
  );
  const zeroRun = runTurns(applyManualBalanceScheduleToSession(newSession("mb-div0"), zeroSchedule), 4);
  const record = zeroRun.manualBalanceApplied?.[3];
  assert.ok(record !== undefined);
  assert.equal(record.manualDividendPayoutRatio, 0, "明示的0%が記録されていない");

  // 未設定Runでは null（既定値のまま）として記録される。
  const defaultRun = runTurns(newSession("mb-div-default"), 4);
  assert.equal(defaultRun.manualBalanceApplied?.[3].manualDividendPayoutRatio, null);

  // 0%指定のQ4では配当が1社も発生しない（dividendResultsはQ4に生成される）。
  const zeroQ4 = zeroRun.state.history[3];
  const zeroDividends = zeroQ4.dividendResults ?? [];
  for (const d of zeroDividends) {
    assert.equal(d.appliedDividendUsd, 0, `${d.companyId}: 0%指定なのに配当が実行されている`);
  }

  // 【対照】既定値（0.15）のRunでは、同じQ4で実際に配当が出ている。
  // これが無いと「そもそもQ4に配当が発生しない条件だった」だけで上のassertが
  // 通ってしまい、0%指定が効いた証拠にならない。
  const defaultQ4 = defaultRun.state.history[3];
  const defaultDividends = defaultQ4.dividendResults ?? [];
  const defaultTotal = defaultDividends.reduce((sum, d) => sum + d.appliedDividendUsd, 0);
  assert.ok(
    defaultTotal > 0,
    `既定値Runでも配当が0のため、0%指定の効果を検証できていない（dividendResults=${defaultDividends.length}件）`
  );

  const zeroTotal = zeroDividends.reduce((sum, d) => sum + d.appliedDividendUsd, 0);
  assert.equal(zeroTotal, 0, `0%指定Runの配当合計が0でない: ${zeroTotal}`);
});
