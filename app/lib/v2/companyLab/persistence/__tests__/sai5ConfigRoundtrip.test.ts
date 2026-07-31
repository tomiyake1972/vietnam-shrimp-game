// ShrimpX V2 — SAI-5 監査指摘E: config.sai5 の永続化ラウンドトリップ
//
// 【背景】validateCompanyLabConfig が scenarioId/mode/seed/turns の4つだけを
// 再構築しており、保存時に存在した sai5（SAI-5機能フラグ）を黙って捨てていた。
// その結果、SAI-5有効のセッションを保存して読み直すと機能が全OFFに戻り、
// 営業基盤・市場進化のcarry stateだけが残るという不整合が起きていた。

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCompanyLabPersistedState } from "../schema";
import { encodeCompanyLabPersistedState, decodeCompanyLabPersistedState } from "../codec";
import { CompanyLabPersistedStateV1, CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION } from "../types";
import { createCompanyLabRuntimeSnapshot } from "../snapshot";
import { runRealQuartersWithAutoPolicy, baseTestConfig, TEST_ENGINE_VERSION } from "./testHelpers";
import { Sai5FeatureFlags } from "../../types";

const TURNS = 3;

const SAI5_ALL_ON: Sai5FeatureFlags = {
  productLifecycle: true,
  salesBaseAccumulation: true,
  supplyPremiumFeedback: true,
};

function buildPersisted(sai5: Sai5FeatureFlags | undefined): CompanyLabPersistedStateV1 {
  const config = baseTestConfig({ turns: TURNS, ...(sai5 ? { sai5 } : {}) });
  const run = runRealQuartersWithAutoPolicy(config, TURNS);
  const last = run.quarters[run.quarters.length - 1];
  return {
    schemaVersion: CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION,
    engineVersion: TEST_ENGINE_VERSION,
    labId: "lab-sai5-config-roundtrip",
    config: last.stateAfter.config,
    fixtures: run.fixtures,
    playerCompanyId: run.fixtures[0].companyId,
    currentState: { runtime: createCompanyLabRuntimeSnapshot(last.stateAfter), lastProcessedTurnId: `turn-${TURNS}`, revision: TURNS },
    draft: null,
    metadata: { createdAt: "2026-07-31T00:00:00.000Z", updatedAt: "2026-07-31T00:00:00.000Z" },
  };
}

test("SAI-5E修正: config.sai5が保存→復元で失われない（機能フラグの往復）", () => {
  const persisted = buildPersisted(SAI5_ALL_ON);
  assert.deepEqual(persisted.config.sai5, SAI5_ALL_ON, "テスト前提: 保存対象のconfigにsai5が入っていない");

  const restored = decodeCompanyLabPersistedState(encodeCompanyLabPersistedState(persisted));
  assert.deepEqual(restored.config.sai5, SAI5_ALL_ON, "復元後にsai5が失われている（機能が全OFFに戻る）");
  // 状態側も一緒に復元されていること（フラグだけ・状態だけの片落ちを防ぐ）
  assert.ok(restored.currentState.runtime.salesBaseState, "営業基盤stateが復元されていない");
  assert.ok(restored.currentState.runtime.marketEvolutionState, "市場進化stateが復元されていない");
});

test("SAI-5E修正: 一部だけ有効なフラグの組み合わせもそのまま復元される", () => {
  const base = buildPersisted(SAI5_ALL_ON);
  for (const sai5 of [
    { productLifecycle: true },
    { salesBaseAccumulation: true },
    { supplyPremiumFeedback: true },
    { productLifecycle: true, supplyPremiumFeedback: true },
    { productLifecycle: true, salesBaseAccumulation: true, supplyPremiumFeedback: true, supplyPressureDefinition: "neutral_baseline" as const },
  ]) {
    const restored = decodeCompanyLabPersistedState(
      encodeCompanyLabPersistedState({ ...base, config: { ...base.config, sai5 } })
    );
    assert.deepEqual(restored.config.sai5, sai5, `フラグ組み合わせ ${JSON.stringify(sai5)} が復元されない`);
  }
});

test("SAI-5E修正: 旧スキーマ（sai5キーなし）は従来どおりundefinedで復元される（後方互換）", () => {
  const persisted = buildPersisted(undefined);
  assert.equal(persisted.config.sai5, undefined);
  const encoded = encodeCompanyLabPersistedState(persisted);
  const restored = decodeCompanyLabPersistedState(encoded);
  assert.equal(restored.config.sai5, undefined, "旧スキーマの復元でsai5が生えている");
});

test("SAI-5E修正: 不正なsai5（型違い・未知のsupplyPressureDefinition）は検証エラーになる", () => {
  const persisted = JSON.parse(encodeCompanyLabPersistedState(buildPersisted(SAI5_ALL_ON)));
  persisted.config.sai5.productLifecycle = "yes";
  assert.throws(() => validateCompanyLabPersistedState(persisted), /productLifecycle/);

  const persisted2 = JSON.parse(encodeCompanyLabPersistedState(buildPersisted(SAI5_ALL_ON)));
  persisted2.config.sai5.supplyPressureDefinition = "made_up_definition";
  assert.throws(() => validateCompanyLabPersistedState(persisted2), /supplyPressureDefinition/);
});
