// ShrimpX V2 — ENG-COMPANYLAB-EFFECTIVE-CONFIG-PERSIST-1
//
// 【修正前の欠陥】createLab が initializeCompanyLab の解決した effective config
// （＝ScenarioDefinition.requiredCapabilities をマージ済みの state.config）ではなく、
// 呼び出し側の raw な input.config を保存していた。そのため DS1 / DS2 のように
// シナリオが機能を宣言している場合、保存済み config には sai5 が入らず、
// resume 時（restoreCompanyLabStateFromRuntimeSnapshot は保存済み config を
// そのまま state.config に使う）にシナリオが要求した機能が失われていた。
//
// 【このテストが固定すること】
//   - 宣言を持たないシナリオ（baseline）では保存内容が変わらないこと
//   - DS1 / DS2 では requiredCapabilities が保存され、production 相当の
//     codec 経路（encode → decode/validate → restore）を通しても保持されること
//   - 明示指定と requiredCapabilities の merge 規約（有効化のみ・無効化しない）が
//     initialize 直後と resume 後で一致すること
//   - 既存 config field（standardAiProfileMode 等）が欠落しないこと
//
// 【非目標】既に欠落したまま保存されている既存 Run の補修（migration・Redis 書き換え・
// resume 時の自動補完）は行わない。ECP-8 はその「現状の挙動」を記録するだけで、
// 補完を実装しない証拠でもある。

import { test } from "node:test";
import assert from "node:assert/strict";
import { CompanyId } from "../../../sales/types";
import { CompanyLabConfig } from "../../types";
import { initializeCompanyLab } from "../../runner";
import { createInMemoryCompanyLabStateRepository } from "../../persistence/repository";
import { encodeCompanyLabPersistedState, decodeCompanyLabPersistedState } from "../../persistence/codec";
import { restoreCompanyLabStateFromRuntimeSnapshot } from "../../persistence/snapshot";
import { createCompanyLabQuarterFlowService } from "../companyLabQuarterFlowService";
import { ALL_SCENARIO_DEFINITIONS } from "../../../scenario/definitions";
import { CompanyLabPersistedStateV1 } from "../../persistence/types";

const PLAYER_COMPANY_ID = "BAL" as CompanyId;
const NOW = "2026-01-01T00:00:00.000Z";

function rawConfig(scenarioId: string, extra: Partial<CompanyLabConfig> = {}): CompanyLabConfig {
  return { scenarioId, mode: "canonical", seed: "ecp-001", turns: 32, ...extra } as CompanyLabConfig;
}

/** createLab → encode → decode/validate → restore という production 相当の往復。 */
async function createAndRoundTrip(labId: string, raw: CompanyLabConfig) {
  const repository = createInMemoryCompanyLabStateRepository();
  const service = createCompanyLabQuarterFlowService({ repository });
  const { stored } = await service.createLab({ labId, config: raw, playerCompanyId: PLAYER_COMPANY_ID, now: NOW });
  // 【§7】in-memory repository はオブジェクト参照を保持するため validateCompanyLabConfig を
  // 通らない。必ず codec を明示的に通して production と同じ schema validation path を使う。
  const decoded: CompanyLabPersistedStateV1 = decodeCompanyLabPersistedState(encodeCompanyLabPersistedState(stored));
  const restored = restoreCompanyLabStateFromRuntimeSnapshot(decoded.config, decoded.currentState.runtime, []);
  const initialized = initializeCompanyLab(raw);
  return { stored, decoded, restored, effective: initialized.state.config };
}

function requiredCapabilitiesOf(scenarioId: string) {
  return ALL_SCENARIO_DEFINITIONS.find((d) => d.scenarioId === scenarioId || d.scenarioId.startsWith(`${scenarioId}-`))?.requiredCapabilities;
}

// =====================================================================

test("ECP-1: baseline（requiredCapabilities 宣言なし）は保存結果が変わらない", async () => {
  assert.equal(requiredCapabilitiesOf("baseline"), undefined, "baseline が宣言を持つようになったらこのテストの前提が崩れる");
  const raw = rawConfig("baseline");
  const { stored, decoded, restored, effective } = await createAndRoundTrip("lab-ecp-1", raw);
  // 宣言が無いので effectiveConfig === config（恒等変換）。保存内容は raw と同一。
  assert.deepEqual(effective, raw);
  assert.deepEqual(stored.config, raw);
  assert.deepEqual(decoded.config, raw);
  assert.deepEqual(restored.config, raw);
  assert.equal((restored.config as CompanyLabConfig).sai5, undefined);
});

test("ECP-2: DS1 は raw に sai5 未指定でも effective config へ requiredCapabilities が入る", () => {
  const required = requiredCapabilitiesOf("dynamic-scenario-1");
  assert.ok(required, "DS1 の requiredCapabilities が見つからない");
  const raw = rawConfig("dynamic-scenario-1");
  assert.equal(raw.sai5, undefined);
  const { state } = initializeCompanyLab(raw);
  assert.equal(state.config.sai5?.productLifecycle, true);
  assert.equal(state.config.sai5?.supplyPremiumFeedback, true);
  assert.equal(state.config.sai5?.salesBaseAccumulation, true);
});

test("ECP-3: DS1 は create → serialize → decode → restore 後も3機能が保持される", async () => {
  const { stored, decoded, restored } = await createAndRoundTrip("lab-ecp-3", rawConfig("dynamic-scenario-1"));
  for (const label of ["stored", "decoded", "restored"] as const) {
    const cfg = ({ stored: stored.config, decoded: decoded.config, restored: restored.config } as const)[label] as CompanyLabConfig;
    assert.equal(cfg.sai5?.productLifecycle, true, `${label}: productLifecycle`);
    assert.equal(cfg.sai5?.supplyPremiumFeedback, true, `${label}: supplyPremiumFeedback`);
    assert.equal(cfg.sai5?.salesBaseAccumulation, true, `${label}: salesBaseAccumulation`);
  }
});

test("ECP-4: DS2 についても Scenario 継承分を含む effective config が保存される", async () => {
  const required = requiredCapabilitiesOf("dynamic-scenario-2");
  assert.ok(required, "DS2 の requiredCapabilities が見つからない");
  const { restored, effective } = await createAndRoundTrip("lab-ecp-4", rawConfig("dynamic-scenario-2"));
  assert.deepEqual(restored.config.sai5, effective.sai5);
  assert.equal(restored.config.sai5?.productLifecycle, true);
  assert.equal(restored.config.sai5?.supplyPremiumFeedback, true);
  assert.equal(restored.config.sai5?.salesBaseAccumulation, true);
});

test("ECP-5: 明示指定と requiredCapabilities の merge 規約が initialize 直後と resume 後で一致", async () => {
  // 明示 true は保持され、宣言分は足される（有効化のみ・無効化はしない）。
  const explicit = rawConfig("dynamic-scenario-1", {
    sai5: { productLifecycle: true, supplyPressureDefinition: "completed_supply" },
  } as Partial<CompanyLabConfig>);
  const a = await createAndRoundTrip("lab-ecp-5a", explicit);
  assert.deepEqual(a.restored.config.sai5, a.effective.sai5);
  assert.equal(a.restored.config.sai5?.supplyPressureDefinition, "completed_supply", "明示指定した非boolean項目が落ちている");
  assert.equal(a.restored.config.sai5?.salesBaseAccumulation, true, "宣言分が足されていない");

  // 呼び出し側が false を明示した項目を、シナリオ宣言が true へ書き換えないこと
  // （applyScenarioRequiredCapabilities の「無効化はできない／有効化は足す」規約の確認）。
  const withFalse = rawConfig("dynamic-scenario-1", { sai5: { salesBaseAccumulation: false } } as Partial<CompanyLabConfig>);
  const b = await createAndRoundTrip("lab-ecp-5b", withFalse);
  assert.deepEqual(b.restored.config.sai5, b.effective.sai5, "resume 後の merge 結果が initialize 直後と食い違う");
});

test("ECP-6: standardAiProfileMode 等の既存 config field が欠落しない", async () => {
  const raw = rawConfig("dynamic-scenario-1", { standardAiProfileMode: "ON" } as Partial<CompanyLabConfig>);
  const { restored } = await createAndRoundTrip("lab-ecp-6", raw);
  assert.equal(restored.config.standardAiProfileMode, "ON");
  assert.equal(restored.config.scenarioId, "dynamic-scenario-1");
  assert.equal(restored.config.mode, "canonical");
  assert.equal(restored.config.seed, "ecp-001");
  assert.equal(restored.config.turns, 32);
  assert.equal(restored.config.sai5?.salesBaseAccumulation, true);
});

test("ECP-7: schema 挙動（未知 field の扱い・schemaVersion）は変更していない", async () => {
  const { stored, decoded } = await createAndRoundTrip("lab-ecp-7", rawConfig("dynamic-scenario-1"));
  // schemaVersion は保存側の定数のまま。bump していない。
  assert.equal(decoded.schemaVersion, stored.schemaVersion);
  // validateCompanyLabConfig は従来どおりホワイトリスト再構築。未知 field は
  // 例外にせず落とす（この挙動は本修正で変えていない）。
  const withUnknown = JSON.parse(JSON.stringify(stored)) as Record<string, unknown> & { config: Record<string, unknown> };
  withUnknown.config = { ...withUnknown.config, someUnknownField: "x" };
  const decodedUnknown = decodeCompanyLabPersistedState(JSON.stringify(withUnknown));
  assert.equal((decodedUnknown.config as unknown as Record<string, unknown>).someUnknownField, undefined);
  assert.equal(decodedUnknown.config.sai5?.salesBaseAccumulation, true);
});

test("ECP-8: 既存 saved run（sai5 欠落）は自動補完せず、そのまま legacy 挙動で復元される", async () => {
  // 修正前に保存された Run を模して、config から sai5 を取り除いた payload を作る。
  const { stored } = await createAndRoundTrip("lab-ecp-8", rawConfig("dynamic-scenario-1"));
  const legacyPayload = JSON.parse(JSON.stringify(stored)) as CompanyLabPersistedStateV1;
  delete (legacyPayload.config as { sai5?: unknown }).sai5;
  const decoded = decodeCompanyLabPersistedState(JSON.stringify(legacyPayload));
  const restored = restoreCompanyLabStateFromRuntimeSnapshot(decoded.config, decoded.currentState.runtime, []);
  // 【非目標の明示】シナリオ宣言からの再補完は行わない。欠落したままで復元される。
  assert.equal(restored.config.sai5, undefined, "旧 Run に対して自動補完が入ってしまっている（本Phaseでは実装禁止）");
  // 参考: 同じ raw から initialize し直せば宣言分は復元できる（＝補修は可能だが今回はしない）。
  assert.equal(initializeCompanyLab(decoded.config).state.config.sai5?.salesBaseAccumulation, true);
});
