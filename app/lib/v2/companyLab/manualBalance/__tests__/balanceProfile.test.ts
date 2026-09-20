// ShrimpX V2 — BALANCE-PROFILE-1 固定スケジュール型バランスモデルのテスト
//
// 指示§14 A〜N を実測する。
// Balance Profile は「名前付きのManualBalanceSchedule」であり、
// 指数解決は従来どおり resolveManualBalanceForTurn だけが行う（第二SSoTを作らない）。

import test from "node:test";
import assert from "node:assert/strict";

import { createSimulationSession, advanceSimulationTurns, applyManualBalanceScheduleToSession } from "../../simulation/engine";
import { buildResumePayload, restoreSessionFromResumePayload } from "../../simulation/persistence/resume";
import type { SimulationSession } from "../../simulation/types";
import {
  ManualBalanceSettings,
  resolveManualBalanceForTurn,
  resolvedRawMarketPriceIndex,
  resolvedSalesPriceIndex,
  withManualBalanceContinuingApplied,
  withManualBalancePerTurnApplied,
} from "../overrides";
import {
  balanceCalibrationLogToCsv,
  balanceCalibrationLogToJson,
  buildBalanceCalibrationLog,
} from "../calibrationLog";
import {
  BALANCE_PROFILE_SPEC_VERSION,
  BalanceProfile,
  NEUTRAL_BALANCE_PROFILE_ID,
  balanceProfileFingerprint,
  balanceProfileScheduleForRun,
  buildAppliedBalanceProfileRef,
  buildBalanceProfileDocument,
  isNeutralBalanceProfile,
  isScheduleDriftedFromProfile,
  neutralBalanceProfile,
  parseBalanceProfileDocument,
  reapplyProfileScheduleFromTurn,
} from "../profile";

const TS = "2026-01-01T00:00:00.000Z";
const SCENARIO_ID = "baseline";
const SEED = "balance-profile-seed";

function settings(patch: Partial<ManualBalanceSettings> = {}): ManualBalanceSettings {
  return { dividendPayout: { kind: "unspecified" }, salesPriceIndex: undefined, rawMarketPriceIndex: undefined, ...patch };
}

/** Turn1-4 / 5-8 / 9-12 をブロックで変える、指示§9の想定どおりのProfile。 */
function blockProfile(): BalanceProfile {
  let schedule = withManualBalanceContinuingApplied(undefined, 1, settings({ salesPriceIndex: 95, rawMarketPriceIndex: 105 }), TS);
  schedule = withManualBalanceContinuingApplied(schedule, 5, settings({ salesPriceIndex: 90, rawMarketPriceIndex: 110 }), TS);
  schedule = withManualBalanceContinuingApplied(
    schedule,
    9,
    settings({ salesPriceIndex: 100, rawMarketPriceIndex: 100, dividendPayout: { kind: "specified", payoutRatio: 0.3 } }),
    TS
  );
  return {
    profileId: "bp-block",
    profileName: "Block-A",
    description: "Turn1-4 / 5-8 / 9以降でブロック切り替えするテスト用Profile",
    specVersion: BALANCE_PROFILE_SPEC_VERSION,
    createdAt: TS,
    updatedAt: TS,
    sourceScenarioId: SCENARIO_ID,
    sourceSeed: SEED,
    schedule,
  };
}

function newSession(runId: string, profile: BalanceProfile | null, turns = 12): SimulationSession {
  const schedule = balanceProfileScheduleForRun(profile);
  return createSimulationSession({
    simulationRunId: runId,
    scenarioId: SCENARIO_ID,
    seed: SEED,
    requestedTurns: turns,
    startedAt: TS,
    ...(schedule !== undefined ? { manualBalanceOverrides: schedule } : {}),
    ...(profile !== null && !isNeutralBalanceProfile(profile)
      ? { appliedBalanceProfile: buildAppliedBalanceProfileRef(profile) }
      : {}),
  });
}

/** 経済結果の比較用（Profile由来の設定そのものは経済結果ではないため除外）。 */
function comparableState(session: SimulationSession): string {
  const config = { ...session.state.config };
  delete (config as { manualBalanceOverrides?: unknown }).manualBalanceOverrides;
  return JSON.stringify({ ...session.state, config });
}

// --------------------------------------------------------------------- A / B
test("BP-A/B: Profileなし と Neutral Profile は、経済結果が完全に一致する", () => {
  const withoutProfile = advanceSimulationTurns({ session: newSession("bp-none", null, 6), turns: 6, timestamp: TS });
  const withNeutral = advanceSimulationTurns({
    session: newSession("bp-none", neutralBalanceProfile(TS), 6),
    turns: 6,
    timestamp: TS,
  });

  assert.equal(comparableState(withNeutral), comparableState(withoutProfile), "Neutral Profileが中立でない");

  // Neutralはconfigへキー自体を作らない（既存Runとビット単位で同一のconfig）。
  assert.ok(
    !Object.prototype.hasOwnProperty.call(withNeutral.state.config, "manualBalanceOverrides"),
    "NeutralなのにconfigへmanualBalanceOverridesが書き込まれている"
  );
  // Neutralでは由来情報も残さない（「Profileなし」と「不明」を混同させない）。
  assert.equal(withNeutral.run.appliedBalanceProfile, undefined);
  assert.equal(withoutProfile.run.appliedBalanceProfile, undefined);
});

// ------------------------------------------------------------------------- C
test("BP-C: Profileのscheduleが、Run開始時にmanualBalanceOverridesへsnapshotコピーされる", () => {
  const profile = blockProfile();
  const session = newSession("bp-copy", profile);

  assert.deepEqual(
    session.state.config.manualBalanceOverrides,
    profile.schedule,
    "Profileのscheduleがconfigへコピーされていない"
  );
  const ref = session.run.appliedBalanceProfile;
  assert.ok(ref !== undefined);
  assert.equal(ref.appliedBalanceProfileId, "bp-block");
  assert.equal(ref.appliedBalanceProfileName, "Block-A");
  assert.equal(ref.appliedBalanceProfileSpecVersion, BALANCE_PROFILE_SPEC_VERSION);
  assert.equal(ref.appliedBalanceProfileFingerprint, balanceProfileFingerprint(profile.schedule));
});

// ------------------------------------------------------------------------- D
test("BP-D: Run開始後にProfileを変更しても、開始済みRunのscheduleは変わらない", () => {
  const profile = blockProfile();
  const session = newSession("bp-profile-edit", profile);
  const scheduleAtStart = JSON.stringify(session.state.config.manualBalanceOverrides);

  // Profile側を「後から編集」する（新しいオブジェクトを作る＝実際の編集と同じ）。
  const editedProfile: BalanceProfile = {
    ...profile,
    profileName: "Block-A（改訂）",
    schedule: withManualBalanceContinuingApplied(profile.schedule, 2, settings({ salesPriceIndex: 50 }), TS),
    updatedAt: "2026-02-01T00:00:00.000Z",
  };
  assert.notEqual(
    balanceProfileFingerprint(editedProfile.schedule),
    balanceProfileFingerprint(profile.schedule),
    "テスト前提: Profileの編集で指紋が変わること"
  );

  // 開始済みRunのscheduleは一切変わらない（Runは以後Profileを参照しないため）。
  assert.equal(JSON.stringify(session.state.config.manualBalanceOverrides), scheduleAtStart);
  // 進めても変わらない。
  const advanced = advanceSimulationTurns({ session, turns: 2, timestamp: TS });
  assert.equal(JSON.stringify(advanced.state.config.manualBalanceOverrides), scheduleAtStart);
});

// ------------------------------------------------------------------------- E
test("BP-E: Run開始後にmanual変更しても、Profile本体は変わらない（driftとして検出できる）", () => {
  const profile = blockProfile();
  const originalScheduleJson = JSON.stringify(profile.schedule);
  const session = newSession("bp-manual-edit", profile);

  assert.equal(isScheduleDriftedFromProfile(session.run.appliedBalanceProfile, session.state.config.manualBalanceOverrides), false);

  // Run側で手修正する。
  const edited = applyManualBalanceScheduleToSession(
    session,
    withManualBalancePerTurnApplied(session.state.config.manualBalanceOverrides, 3, settings({ salesPriceIndex: 80 }), TS)
  );

  // Profile本体は不変。
  assert.equal(JSON.stringify(profile.schedule), originalScheduleJson, "Profile本体が書き換わっている");
  // driftとして検出できる。
  assert.equal(
    isScheduleDriftedFromProfile(edited.run.appliedBalanceProfile, edited.state.config.manualBalanceOverrides),
    true,
    "手修正がdriftとして検出されない"
  );
  // 由来情報（開始時のProfile）は書き換わらない。
  assert.equal(edited.run.appliedBalanceProfile?.appliedBalanceProfileName, "Block-A");
});

// ------------------------------------------------------------------- F / G / H
test("BP-F/G/H: Profileのブロックscheduleが12Turn一括実行で正しく適用され、複利化せず、優先順位も保たれる", () => {
  const profile = blockProfile();
  const session = advanceSimulationTurns({ session: newSession("bp-batch", profile), turns: 12, timestamp: TS });

  const applied = session.manualBalanceApplied;
  assert.ok(applied !== undefined && applied.length === 12, "12Turnぶんの適用記録がない");

  // F: ブロックごとに期待どおりの指数が適用されている。
  const expected = (turn: number): { sales: number; raw: number } => {
    if (turn <= 4) return { sales: 95, raw: 105 };
    if (turn <= 8) return { sales: 90, raw: 110 };
    return { sales: 100, raw: 100 };
  };
  for (const record of applied) {
    const e = expected(record.turn);
    assert.equal(record.manualSalesPriceIndex, e.sales, `turn=${record.turn} 販売指数`);
    assert.equal(record.manualRawMarketPriceIndex, e.raw, `turn=${record.turn} 原料指数`);
  }

  // G: 複利化しない（毎Turnそのターンの補正前価格に対する比率が一定）。
  for (const record of applied) {
    const ratio = record.appliedRawMarketPrice / record.preManualRawMarketPrice;
    const e = expected(record.turn);
    assert.ok(
      Math.abs(ratio - e.raw / 100) < 1e-9,
      `turn=${record.turn}: 比率が${e.raw / 100}でない（複利化の疑い）ratio=${ratio}`
    );
  }

  // Turn9以降は配当性向30%が効いている。
  assert.equal(applied[8].manualDividendPayoutRatio, 0.3);
  assert.equal(applied[0].manualDividendPayoutRatio, null);

  // H: perTurn > continuing の優先順位はProfile由来のscheduleでも維持される。
  const withPerTurn = withManualBalancePerTurnApplied(profile.schedule, 6, settings({ salesPriceIndex: 111 }), "2026-03-01T00:00:00.000Z");
  assert.equal(resolvedSalesPriceIndex(resolveManualBalanceForTurn(withPerTurn, 6)), 111, "ターン別が継続に勝たない");
  assert.equal(resolvedSalesPriceIndex(resolveManualBalanceForTurn(withPerTurn, 7)), 90, "翌Turnは継続へ戻らない");
});

// ------------------------------------------------------------------------- I
test("BP-I: Profile予定値と、manualBalanceApplied実績を区別できる", () => {
  const profile = blockProfile();
  const session = advanceSimulationTurns({ session: newSession("bp-planned-actual", profile), turns: 3, timestamp: TS });

  // 予定: Profile（およびRunへコピーされたschedule）から解決できる。
  const plannedTurn2 = resolveManualBalanceForTurn(profile.schedule, 2);
  assert.equal(resolvedSalesPriceIndex(plannedTurn2), 95);
  assert.equal(resolvedRawMarketPriceIndex(plannedTurn2), 105);

  // 実績: そのTurnに実際に適用された値（補正前後の実価格つき）。
  const actualTurn2 = session.manualBalanceApplied?.find((r) => r.turn === 2);
  assert.ok(actualTurn2 !== undefined);
  assert.equal(actualTurn2.manualSalesPriceIndex, 95);
  assert.ok(actualTurn2.preManualRawMarketPrice > 0, "実績には補正前の実価格が入る（予定値にはない情報）");
  assert.ok(actualTurn2.appliedRawMarketPrice > 0);

  // 予定にしか無い情報／実績にしか無い情報がそれぞれ存在する＝混同しない構造。
  assert.equal(session.run.appliedBalanceProfile?.appliedBalanceProfileName, "Block-A", "予定側にProfile名が残る");
});

// ------------------------------------------------------------------------- J
test("BP-J: Profileをexportしてimportすると、同一scheduleを再構成できる", () => {
  const profile = blockProfile();
  const json = JSON.stringify(buildBalanceProfileDocument(profile, TS));
  const current = {
    specVersion: BALANCE_PROFILE_SPEC_VERSION,
    scenarioId: SCENARIO_ID,
    seed: SEED,
    salesModelId: null,
    sourceCommit: "UNKNOWN",
  };

  const result = parseBalanceProfileDocument(json, current);
  assert.ok(result.ok, "書き出したProfileを取り込めない");
  assert.equal(result.conditionDifferences.length, 0, "同一条件なのに差分が報告された");
  assert.equal(
    balanceProfileFingerprint(result.profile.schedule),
    balanceProfileFingerprint(profile.schedule),
    "取り込んだscheduleの指紋が一致しない"
  );
  assert.equal(result.profile.profileName, "Block-A");
  assert.equal(result.profile.specVersion, BALANCE_PROFILE_SPEC_VERSION);
});

// ------------------------------------------------------------------------- K
test("BP-K: 作成元Scenario / seed / salesModelが異なるimportでは警告が出る（拒否はしない）", () => {
  const profile: BalanceProfile = { ...blockProfile(), sourceSalesModelId: "legacy-waterfall-v1" };
  const json = JSON.stringify(buildBalanceProfileDocument(profile, TS));

  const result = parseBalanceProfileDocument(json, {
    specVersion: BALANCE_PROFILE_SPEC_VERSION,
    scenarioId: "dynamic-scenario-1",
    seed: "other-seed",
    salesModelId: "tiered-v200-candidate-v1",
    sourceCommit: "UNKNOWN",
  });

  assert.ok(result.ok, "条件が違うだけで取り込みが拒否されている（意図的な別Scenario適用ができない）");
  const fields = result.conditionDifferences.map((d) => d.field).sort();
  assert.deepEqual(fields, ["sourceSalesModelId", "sourceScenarioId", "sourceSeed"]);

  // 壊れたファイルは拒否する（部分取り込みをしない）。
  assert.equal(parseBalanceProfileDocument("{}", { ...{
    specVersion: BALANCE_PROFILE_SPEC_VERSION, scenarioId: SCENARIO_ID, seed: SEED, salesModelId: null, sourceCommit: "UNKNOWN",
  } }).ok, false);
});

// ------------------------------------------------------------------------- L
test("BP-L: reload/resume後もProfile由来情報とactual applied履歴が残る", () => {
  const profile = blockProfile();
  const session = advanceSimulationTurns({ session: newSession("bp-resume", profile), turns: 5, timestamp: TS });

  const payload = JSON.parse(JSON.stringify(buildResumePayload(session, {}, {}))) as ReturnType<typeof buildResumePayload>;
  const restored = restoreSessionFromResumePayload(session.run, payload);

  // Profile由来情報（run metadata経由）。
  assert.deepEqual(restored.run.appliedBalanceProfile, session.run.appliedBalanceProfile, "Profile由来情報が失われた");
  // 実績履歴。
  assert.equal(restored.manualBalanceApplied?.length, 5, "適用実績が失われた");
  // scheduleも残る（再開後も同じ解決結果になる）。
  for (const turn of [1, 4, 5, 6, 9]) {
    assert.equal(
      resolvedSalesPriceIndex(resolveManualBalanceForTurn(restored.state.config.manualBalanceOverrides, turn)),
      resolvedSalesPriceIndex(resolveManualBalanceForTurn(session.state.config.manualBalanceOverrides, turn)),
      `turn=${turn}`
    );
  }

  // 再開後に進めても、Profile由来のscheduleが効き続ける。
  const advanced = advanceSimulationTurns({ session: restored, turns: 1, timestamp: TS });
  assert.equal(advanced.manualBalanceApplied?.[5].manualSalesPriceIndex, 90, "Turn6で5-8ブロックが効いていない");
});

// ------------------------------------------------------------------- 再適用
test("BP-REAPPLY: Profileの再適用は次の未実行Turn以降にだけ効き、過去Turnを変更しない", () => {
  const profile = blockProfile();
  // Run側で手修正した状態を作る。
  let schedule = profile.schedule;
  schedule = withManualBalancePerTurnApplied(schedule, 6, settings({ salesPriceIndex: 55 }), "2026-02-01T00:00:00.000Z");
  assert.equal(resolvedSalesPriceIndex(resolveManualBalanceForTurn(schedule, 6)), 55, "テスト前提: 手修正が効いていること");

  // Turn6を次の未実行Turnとして再適用する。
  const reapplied = reapplyProfileScheduleFromTurn(schedule, profile, 6, "2026-03-01T00:00:00.000Z");

  // 過去Turn（1〜5）の解決結果は手修正前と同じまま。
  for (const turn of [1, 2, 3, 4, 5]) {
    assert.equal(
      resolvedSalesPriceIndex(resolveManualBalanceForTurn(reapplied, turn)),
      resolvedSalesPriceIndex(resolveManualBalanceForTurn(profile.schedule, turn)),
      `turn=${turn} の過去Turnが変わっている`
    );
  }
  // Turn6以降はProfileの値へ戻る（手修正の55が消える）。
  assert.equal(resolvedSalesPriceIndex(resolveManualBalanceForTurn(reapplied, 6)), 90, "再適用でProfile値へ戻っていない");
  assert.equal(resolvedSalesPriceIndex(resolveManualBalanceForTurn(reapplied, 10)), 100);
});

// --------------------------------------------------------------- M / N
test("BP-M/N: 全社STANDARD_AIのまま、PLAYERを作らずにProfile適用Runを完走できる", () => {
  const profile = blockProfile();
  const session = advanceSimulationTurns({ session: newSession("bp-full", profile, 12), turns: 12, timestamp: TS });

  // PLAYERは1社も存在しない（companyControlModesを一切指定していない＝全社STANDARD_AI）。
  const modes = session.run.companyControlModes;
  if (modes !== undefined) {
    for (const [companyId, mode] of Object.entries(modes)) {
      assert.equal(mode, "STANDARD_AI", `${companyId} がPLAYERになっている`);
    }
  }

  assert.equal(session.run.completedTurns, 12, "12Turn完走していない");
  assert.equal(session.state.history.length, 12);
  // 一括実行でも全Turnぶんの実適用値が記録される。
  assert.equal(session.manualBalanceApplied?.length, 12, "一括実行で適用記録が欠けている");
  for (const record of session.manualBalanceApplied ?? []) {
    assert.ok(record.preManualRawMarketPrice > 0, `turn=${record.turn} の補正前価格が記録されていない`);
  }
});

// --------------------------------------------------------------- 指紋
test("BP-FINGERPRINT: 指紋は内容が同じなら一致し、保存時刻の違いでは変わらない", () => {
  const a = withManualBalanceContinuingApplied(undefined, 1, settings({ salesPriceIndex: 95 }), TS);
  const b = withManualBalanceContinuingApplied(undefined, 1, settings({ salesPriceIndex: 95 }), "2026-09-09T09:09:09.000Z");
  assert.equal(balanceProfileFingerprint(a), balanceProfileFingerprint(b), "recordedAtの違いで指紋が変わっている");

  const c = withManualBalanceContinuingApplied(undefined, 1, settings({ salesPriceIndex: 96 }), TS);
  assert.notEqual(balanceProfileFingerprint(a), balanceProfileFingerprint(c), "内容が違うのに指紋が同じ");

  assert.equal(balanceProfileFingerprint([]), balanceProfileFingerprint(neutralBalanceProfile(TS).schedule));
  assert.equal(neutralBalanceProfile(TS).profileId, NEUTRAL_BALANCE_PROFILE_ID);
  assert.equal(balanceProfileScheduleForRun(neutralBalanceProfile(TS)), undefined, "Neutralがscheduleを返している");
});

// --------------------------------------------------- Calibration Log (§11)
test("BP-LOG: Calibration LogにRun条件とTurn別実績が揃い、未記録Runは不明として扱われる", () => {
  const profile = blockProfile();
  const session = advanceSimulationTurns({ session: newSession("bp-log", profile, 6), turns: 6, timestamp: TS });

  const log = buildBalanceCalibrationLog(session, TS, "abc1234");
  assert.equal(log.appliedRecordsUnavailable, false);
  assert.equal(log.rows.length, 6);

  // Run条件（§11の必須項目）。
  assert.equal(log.header.runId, "bp-log");
  assert.equal(log.header.exportAppCommit, "abc1234");
  assert.equal(log.header.scenarioId, SCENARIO_ID);
  assert.equal(log.header.seed, SEED);
  assert.equal(log.header.balanceProfileName, "Block-A");
  assert.equal(log.header.balanceProfileSpecVersion, BALANCE_PROFILE_SPEC_VERSION);
  // 販売市場モデル未指定のRunでは推測で名前を埋めない。
  assert.equal(log.header.salesModelId, "(未指定)");

  // Turn別実績。
  const turn1 = log.rows[0];
  assert.equal(turn1.turn, 1);
  assert.equal(turn1.manualSalesPriceIndex, 95);
  assert.equal(turn1.manualRawMarketPriceIndex, 105);
  assert.equal(turn1.manualDividendPayoutRatio, null, "未指定は0ではなくnull");
  assert.ok(turn1.preManualRawMarketPrice > 0);
  assert.ok(Math.abs(turn1.appliedRawMarketPrice - turn1.preManualRawMarketPrice * 1.05) < 1e-9);
  assert.ok(turn1.preManualSalesReferencePriceCnHoso !== null, "販売基準価格の補正前が入っていない");
  assert.ok(turn1.appliedSalesReferencePriceCnHoso !== null);

  // CSVは行ごとにRun条件を持つ（並べ替えても条件が失われない）。
  const csv = balanceCalibrationLogToCsv(log);
  const lines = csv.split("\n");
  assert.equal(lines.length, 7, "ヘッダ1行 + 6Turn");
  assert.ok(lines[0].startsWith("runId,runName,exportAppCommit,"));
  assert.ok(lines[1].includes("bp-log"));
  assert.ok(lines[1].includes("Block-A"));
  // 未設定の配当性向は空欄（0と書かない）。
  const dividendIndex = lines[0].split(",").indexOf("manualDividendPayoutRatio");
  assert.equal(lines[1].split(",")[dividendIndex], "", "未設定の配当性向が0として出力されている");

  // JSONも同じ内容から作る。
  const parsed = JSON.parse(balanceCalibrationLogToJson(log)) as typeof log;
  assert.equal(parsed.rows.length, 6);
  assert.equal(parsed.header.balanceProfileName, "Block-A");

  // 適用記録が無いRun（この機能より前のRun相当）は「不明」として扱う。
  const legacyLike: SimulationSession = { ...session, manualBalanceApplied: undefined };
  const legacyLog = buildBalanceCalibrationLog(legacyLike, TS, "abc1234");
  assert.equal(legacyLog.appliedRecordsUnavailable, true);
  assert.equal(legacyLog.rows.length, 0, "記録が無いのに行を捏造している");
});
