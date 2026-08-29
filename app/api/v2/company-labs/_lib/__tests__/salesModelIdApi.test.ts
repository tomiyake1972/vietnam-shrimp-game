// ShrimpX V2 — ENG-SALES-MODEL-PERSIST-2 §14/§21 Create API の salesModelId 受理
//
// 任意の SalesParameters JSON は API から注入できない。allowlist の enum のみ。
// 未知 ID は silent fallback せず 400。未指定は許可（従来挙動）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryCompanyLabStateRepository } from "../../../../../lib/v2/companyLab/persistence/repository";
import { createCompanyLabQuarterFlowService } from "../../../../../lib/v2/companyLab/application/companyLabQuarterFlowService";
import { CompanyLabApiDependencies } from "../dependencies";
import { handleCreateLab } from "../handlers";
import { validateCreateLabRequestBody } from "../validation";
import { SALES_PARAMETERS_TIERED_V200_CANDIDATE_V1 } from "../../../../../lib/v2/sales/parameters";

const NOW = "2026-01-01T00:00:00.000Z";

function makeDeps(): CompanyLabApiDependencies {
  const repository = createInMemoryCompanyLabStateRepository();
  const service = createCompanyLabQuarterFlowService({ repository });
  return { repository, service };
}

function body(overrides: Record<string, unknown> = {}) {
  return { scenarioId: "baseline", mode: "canonical", seed: "smid-api-001", turns: 4, playerCompanyId: "BAL", ...overrides };
}

/** 作成後に保存された config を取り出す。 */
async function createAndRead(deps: CompanyLabApiDependencies, labId: string, raw: Record<string, unknown>) {
  const res = await handleCreateLab(deps, { ...raw, labId }, NOW);
  return { res, stored: res.status === 201 ? await deps.repository.loadCurrentState(labId) : null };
}

// =====================================================================

test("SMID-API-1: salesModelId 未指定 → create 成功・config にキーを付けない", async () => {
  const deps = makeDeps();
  const { res, stored } = await createAndRead(deps, "lab-smid-1", body());
  assert.equal(res.status, 201);
  assert.equal(stored!.config.salesModelId, undefined);
  assert.ok(!("salesModelId" in (stored!.config as unknown as Record<string, unknown>)), "未指定なのにキーが付いている");
});

test("SMID-API-2: legacy-waterfall-v1 → create 成功・保存される", async () => {
  const deps = makeDeps();
  const { res, stored } = await createAndRead(deps, "lab-smid-2", body({ salesModelId: "legacy-waterfall-v1" }));
  assert.equal(res.status, 201);
  assert.equal(stored!.config.salesModelId, "legacy-waterfall-v1");
});

test("SMID-API-3: tiered-v200-candidate-v1 → create 成功・保存される", async () => {
  const deps = makeDeps();
  const { res, stored } = await createAndRead(deps, "lab-smid-3", body({ salesModelId: "tiered-v200-candidate-v1" }));
  assert.equal(res.status, 201);
  assert.equal(stored!.config.salesModelId, "tiered-v200-candidate-v1");
});

test("SMID-API-4: 未知 ID → 400 BAD_REQUEST（silent legacy fallback しない）", async () => {
  const deps = makeDeps();
  for (const bad of ["unknown-model", "tiered-v200-candidate-v2", "legacy", "", 1, true, {}]) {
    const res = await handleCreateLab(deps, { ...body({ salesModelId: bad }), labId: "lab-smid-4" }, NOW);
    assert.equal(res.status, 400, `salesModelId=${JSON.stringify(bad)} が 400 にならない`);
  }
  // 400 なので Lab は作られていない。
  await assert.rejects(() => deps.repository.loadCurrentState("lab-smid-4"));
});

test("SMID-API-5: 任意の SalesParameters JSON は API から渡せない", async () => {
  const deps = makeDeps();
  // salesParamsOverride / SalesParameters そのものを送っても、validation が
  // ホワイトリスト再構築するため CreateLabRequestBody へ入らない。
  const parsed = validateCreateLabRequestBody(
    body({ salesParamsOverride: SALES_PARAMETERS_TIERED_V200_CANDIDATE_V1, tieredMarketAllocation: { tiers: {} } })
  );
  assert.ok(parsed.ok);
  assert.ok(!("salesParamsOverride" in (parsed.value as unknown as Record<string, unknown>)));
  assert.ok(!("tieredMarketAllocation" in (parsed.value as unknown as Record<string, unknown>)));
  // 実際に create しても保存 config に入らない。
  const { stored } = await createAndRead(
    deps,
    "lab-smid-5",
    body({ salesParamsOverride: SALES_PARAMETERS_TIERED_V200_CANDIDATE_V1 })
  );
  assert.equal((stored!.config as unknown as Record<string, unknown>).salesParamsOverride, undefined);
  assert.equal(stored!.config.salesModelId, undefined);
});

test("SMID-API-6: 既存 field の validation は不変", async () => {
  const deps = makeDeps();
  // scenarioId 空
  assert.equal((await handleCreateLab(deps, body({ scenarioId: "" }), NOW)).status, 400);
  // mode 不正
  assert.equal((await handleCreateLab(deps, body({ mode: "invalid" }), NOW)).status, 400);
  // turns 0
  assert.equal((await handleCreateLab(deps, body({ turns: 0 }), NOW)).status, 400);
  // playerCompanyId 不正
  assert.equal((await handleCreateLab(deps, body({ playerCompanyId: "NOPE" }), NOW)).status, 400);
  // salesModelId を足しても既存 field の判定は変わらない
  assert.equal((await handleCreateLab(deps, body({ mode: "invalid", salesModelId: "tiered-v200-candidate-v1" }), NOW)).status, 400);
  // 正常系は 201 のまま（standardAiProfileMode の既定も維持）
  const { res, stored } = await createAndRead(deps, "lab-smid-6", body({ salesModelId: "tiered-v200-candidate-v1" }));
  assert.equal(res.status, 201);
  assert.equal(stored!.config.standardAiProfileMode, "ON");
  assert.equal(stored!.config.scenarioId, "baseline");
  assert.equal(stored!.playerCompanyId, "BAL");
});
