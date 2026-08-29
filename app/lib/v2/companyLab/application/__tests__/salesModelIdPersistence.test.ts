// ShrimpX V2 — ENG-SALES-MODEL-PERSIST-2 §15/§19 salesModelId の永続化
//
// production 相当の経路（create → encode → decode/schema validation → restore）で検証する。
// in-memory repository だけでは validateCompanyLabConfig を通らないため、必ず codec を通す。

import { test } from "node:test";
import assert from "node:assert/strict";
import { CompanyId } from "../../../sales/types";
import { CompanyLabConfig } from "../../types";
import { createInMemoryCompanyLabStateRepository } from "../../persistence/repository";
import { encodeCompanyLabPersistedState, decodeCompanyLabPersistedState } from "../../persistence/codec";
import { restoreCompanyLabStateFromRuntimeSnapshot } from "../../persistence/snapshot";
import { CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION, CompanyLabPersistedStateV1 } from "../../persistence/types";
import { createCompanyLabQuarterFlowService } from "../companyLabQuarterFlowService";

const PLAYER_COMPANY_ID = "BAL" as CompanyId;
const NOW = "2026-01-01T00:00:00.000Z";

async function createAndRoundTrip(labId: string, raw: CompanyLabConfig) {
  const repository = createInMemoryCompanyLabStateRepository();
  const service = createCompanyLabQuarterFlowService({ repository });
  const { stored } = await service.createLab({ labId, config: raw, playerCompanyId: PLAYER_COMPANY_ID, now: NOW });
  const json = encodeCompanyLabPersistedState(stored);
  const decoded = decodeCompanyLabPersistedState(json);
  const restored = restoreCompanyLabStateFromRuntimeSnapshot(decoded.config, decoded.currentState.runtime, []);
  return { stored, json, decoded, restored };
}

const cfg = (scenarioId: string, extra: Partial<CompanyLabConfig> = {}): CompanyLabConfig =>
  ({ scenarioId, mode: "canonical", seed: "smid-persist", turns: 32, ...extra }) as CompanyLabConfig;

// =====================================================================

test("SMID-PERSIST-1: field なし → field なしのまま復元（既存 saved run 相当）", async () => {
  const { stored, decoded, restored } = await createAndRoundTrip("lab-sp-1", cfg("baseline"));
  assert.equal(stored.config.salesModelId, undefined);
  assert.equal(decoded.config.salesModelId, undefined);
  assert.equal(restored.config.salesModelId, undefined);
  assert.ok(!("salesModelId" in (restored.config as unknown as Record<string, unknown>)), "キーが増えている（自動 field 追加は禁止）");
});

test("SMID-PERSIST-2: legacy-waterfall-v1 → そのまま復元", async () => {
  const { stored, decoded, restored } = await createAndRoundTrip("lab-sp-2", cfg("baseline", { salesModelId: "legacy-waterfall-v1" }));
  assert.equal(stored.config.salesModelId, "legacy-waterfall-v1");
  assert.equal(decoded.config.salesModelId, "legacy-waterfall-v1");
  assert.equal(restored.config.salesModelId, "legacy-waterfall-v1");
});

test("SMID-PERSIST-3: tiered-v200-candidate-v1 → そのまま復元", async () => {
  const { stored, decoded, restored } = await createAndRoundTrip("lab-sp-3", cfg("baseline", { salesModelId: "tiered-v200-candidate-v1" }));
  assert.equal(stored.config.salesModelId, "tiered-v200-candidate-v1");
  assert.equal(decoded.config.salesModelId, "tiered-v200-candidate-v1");
  assert.equal(restored.config.salesModelId, "tiered-v200-candidate-v1");
});

test("SMID-PERSIST-4: 未知 ID 入りの stored JSON は decode 失敗（silent fallback しない）", async () => {
  const { stored } = await createAndRoundTrip("lab-sp-4", cfg("baseline"));
  for (const bad of ["tiered-v200-candidate-v2", "unknown", "", 1, true]) {
    const tampered = JSON.parse(JSON.stringify(stored)) as CompanyLabPersistedStateV1;
    (tampered.config as unknown as Record<string, unknown>).salesModelId = bad;
    assert.throws(() => decodeCompanyLabPersistedState(JSON.stringify(tampered)), `salesModelId=${JSON.stringify(bad)} が decode 失敗にならない`);
  }
  // null は「値なし」として扱い、従来挙動（legacy）へ落ちる（旧データの互換）。
  const withNull = JSON.parse(JSON.stringify(stored)) as CompanyLabPersistedStateV1;
  (withNull.config as unknown as Record<string, unknown>).salesModelId = null;
  assert.equal(decodeCompanyLabPersistedState(JSON.stringify(withNull)).config.salesModelId, undefined);
});

test("SMID-PERSIST-5: schemaVersion は変わらない（bump なし・migration なし）", async () => {
  const a = await createAndRoundTrip("lab-sp-5a", cfg("baseline"));
  const b = await createAndRoundTrip("lab-sp-5b", cfg("baseline", { salesModelId: "tiered-v200-candidate-v1" }));
  assert.equal(a.stored.schemaVersion, CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION);
  assert.equal(b.stored.schemaVersion, CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION);
  assert.equal(a.decoded.schemaVersion, b.decoded.schemaVersion);
  assert.equal(CURRENT_COMPANY_LAB_PERSISTED_STATE_VERSION, 8);
});

test("SMID-PERSIST-6: effective sai5（Scenario requiredCapabilities）と salesModelId が両立", async () => {
  const { restored } = await createAndRoundTrip("lab-sp-6", cfg("dynamic-scenario-1", { salesModelId: "tiered-v200-candidate-v1" }));
  // effective config fix（ENG-COMPANYLAB-EFFECTIVE-CONFIG-PERSIST-1）が生きていること
  assert.equal(restored.config.sai5?.productLifecycle, true);
  assert.equal(restored.config.sai5?.supplyPremiumFeedback, true);
  assert.equal(restored.config.sai5?.salesBaseAccumulation, true);
  // 同時に salesModelId も保持される
  assert.equal(restored.config.salesModelId, "tiered-v200-candidate-v1");
});

test("SMID-PERSIST-7: payload 増加量（実測・数十bytes 程度であること）", async () => {
  const none = await createAndRoundTrip("lab-sp-7a", cfg("baseline"));
  const legacy = await createAndRoundTrip("lab-sp-7b", cfg("baseline", { salesModelId: "legacy-waterfall-v1" }));
  const tiered = await createAndRoundTrip("lab-sp-7c", cfg("baseline", { salesModelId: "tiered-v200-candidate-v1" }));
  const deltaLegacy = legacy.json.length - none.json.length;
  const deltaTiered = tiered.json.length - none.json.length;
  assert.ok(deltaLegacy > 0 && deltaLegacy < 200, `legacy の増加量が想定外: ${deltaLegacy} bytes`);
  assert.ok(deltaTiered > 0 && deltaTiered < 200, `tiered の増加量が想定外: ${deltaTiered} bytes`);
  // SalesParameters 全体を保存する設計（+5KB級）になっていないことの回帰ガード。
  assert.ok(deltaTiered < 1000, `SalesParameters 全体が保存されている疑い: ${deltaTiered} bytes`);
});
