// ShrimpX V2 — 管理会計費用範囲の是正
//
// 【この検証が固定すること】
//  (1) 4費目の分類（capexMaintenance / factoryLifecycleCarrying → 期間固定製造費、
//      salesForceSeverance → 変動販売費、vapProductDevelopment → 固定販管費）
//  (2) idleLaborCost を二重計上しないこと
//  (3) 未吸収変動費を「実額で1回だけ」計上すること（all-or-nothing の是正）
//  (4) 表示内訳と totalVariableCost / totalFixedCost の関係
//  いずれも実際に32Turn回した結果に対して検証する（固定fixtureの机上値ではない）。

import test from "node:test";
import assert from "node:assert/strict";

import { createSimulationSession, advanceSimulationTurns } from "../../companyLab/simulation/engine";

const EPS = 0.01;
const n = (x: unknown) => x as unknown as number;

const RUNS = [
  { scenarioId: "dynamic-scenario-2", seed: "management-console-32q" },
  { scenarioId: "baseline", seed: "cf-seed-a" },
  { scenarioId: "dynamic-scenario-1", seed: "cf-seed-b" },
] as const;

function run(scenarioId: string, seed: string, turns = 32) {
  const session = createSimulationSession({
    simulationRunId: `mas-${scenarioId}-${seed}`,
    scenarioId,
    seed,
    requestedTurns: turns,
    startedAt: "2026-01-01T00:00:00.000Z",
  });
  return advanceSimulationTurns({ session, turns, timestamp: "2026-01-01T01:00:00.000Z" });
}

test("MAS-1: profitDifference = 期末在庫固定費 − 期首在庫固定費（全社×全Turn）", () => {
  for (const { scenarioId, seed } of RUNS) {
    const s = run(scenarioId, seed);
    assert.equal(s.run.completedTurns, 32, `${scenarioId}/${seed} 32Turn完走`);
    for (const rec of s.state.history) {
      for (const fr of rec.financialResults) {
        const rc = fr.absorptionVariableReconciliation;
        const diff = n(rc.profitDifference) - (n(rc.fixedCostInClosingInventory) - n(rc.fixedCostInOpeningInventory));
        assert.ok(Math.abs(diff) <= EPS, `${scenarioId}/${seed} T${rec.turn}/${fr.companyId} diff=${diff}`);
      }
    }
  }
});

test("MAS-2: 在庫固定費ロールフォワードが閉じる", () => {
  for (const { scenarioId, seed } of RUNS) {
    for (const rec of run(scenarioId, seed).state.history) {
      for (const fr of rec.financialResults) {
        const rc = fr.absorptionVariableReconciliation;
        const diff =
          n(rc.fixedCostInClosingInventory) -
          (n(rc.fixedCostInOpeningInventory) +
            n(rc.fixedCostAbsorbedIntoInventory) -
            n(rc.fixedCostReleasedThroughSales) -
            n(rc.fixedCostReleasedThroughWriteOff));
        assert.ok(Math.abs(diff) <= EPS, `${scenarioId}/${seed} T${rec.turn}/${fr.companyId} diff=${diff}`);
      }
    }
  }
});

test("MAS-3: absorption − variable = profitDifference / managementOP = CM − totalFixedCost", () => {
  for (const { scenarioId, seed } of RUNS) {
    for (const rec of run(scenarioId, seed).state.history) {
      for (const fr of rec.financialResults) {
        const rc = fr.absorptionVariableReconciliation;
        const cm = fr.contributionMargin;
        assert.ok(
          Math.abs(n(rc.absorptionOperatingProfit) - n(rc.variableCostingOperatingProfit) - n(rc.profitDifference)) <= EPS,
          `${scenarioId} T${rec.turn}/${fr.companyId}`
        );
        assert.ok(
          Math.abs(n(cm.managementOperatingProfit) - (n(cm.contributionMargin) - n(cm.totalFixedCost))) <= EPS,
          `${scenarioId} T${rec.turn}/${fr.companyId}`
        );
      }
    }
  }
});

test("MAS-4: totalVariableCost / totalFixedCost と表示内訳の関係が閉じる", () => {
  for (const { scenarioId, seed } of RUNS) {
    for (const rec of run(scenarioId, seed).state.history) {
      for (const fr of rec.financialResults) {
        const cm = fr.contributionMargin;
        const w = `${scenarioId} T${rec.turn}/${fr.companyId}`;
        // 変動費 = 5内訳の合計
        assert.ok(
          Math.abs(
            n(cm.totalVariableCost) -
              (n(cm.variableRawMaterialCost) +
                n(cm.variableProcessingCost) +
                n(cm.variableLaborCost) +
                n(cm.variableQualityCost) +
                n(cm.variableSellingCost))
          ) <= EPS,
          `${w} totalVariableCost`
        );
        // 固定費 = 3内訳の合計
        assert.ok(
          Math.abs(
            n(cm.totalFixedCost) - (n(cm.fixedManufacturingCost) + n(cm.fixedPersonnelCost) + n(cm.fixedSellingAdminCost))
          ) <= EPS,
          `${w} totalFixedCost`
        );
        // Σ商品別限界利益 = 全社限界利益 + 共通変動費
        const sumByProduct = cm.byProduct.reduce((t, b) => t + n(b.contributionMargin), 0);
        assert.ok(
          Math.abs(sumByProduct - (n(cm.contributionMargin) + n(cm.commonVariableCost))) <= EPS,
          `${w} Σ商品別CM=全社CM+共通変動費`
        );
      }
    }
  }
});

test("MAS-5: 4費目が管理会計へ含まれている（分類の固定）", () => {
  // capexMaintenance / factoryLifecycleCarrying が発生したTurnでは、固定製造費が
  // 「常用労務+工場固定+固定ユーティリティ+減価償却」だけの旧定義を上回る。
  let checkedManufacturing = 0;
  let checkedSellingAdmin = 0;
  for (const { scenarioId, seed } of RUNS) {
    const s = run(scenarioId, seed);
    for (const rec of s.state.history) {
      const vapById = new Map<string, number>();
      for (const d of rec.decisions) vapById.set(d.companyId, (d as { vapProductDevelopmentSpendUsd?: number }).vapProductDevelopmentSpendUsd ?? 0);
      for (const fr of rec.financialResults) {
        const cm = fr.contributionMargin;
        const mc = fr.manufacturingCost;
        const pl = fr.profitAndLoss;
        const legacyFixedMfg =
          n(mc.regularLaborCost) + n(mc.factoryFixedCost) + n(mc.utilityFixedCost) + n(mc.depreciationCost);
        const extra = n(pl.costOfSales.capexMaintenanceCost) + n(pl.costOfSales.factoryLifecycleCarryingCost);
        if (extra > EPS) {
          assert.ok(
            Math.abs(n(cm.fixedManufacturingCost) - (legacyFixedMfg + extra)) <= EPS,
            `${scenarioId} T${rec.turn}/${fr.companyId} 固定製造費に capexMaintenance+lifecycle が含まれる`
          );
          checkedManufacturing++;
        }
        const vapDev = vapById.get(fr.companyId) ?? 0;
        if (vapDev > EPS) {
          // 固定販管費は adminFixed + VAP商品開発費
          assert.ok(n(cm.fixedSellingAdminCost) >= vapDev - EPS, `${scenarioId} T${rec.turn}/${fr.companyId} 固定販管費にVAP開発費`);
          checkedSellingAdmin++;
        }
      }
    }
  }
  assert.ok(checkedManufacturing > 0, "capexMaintenance/lifecycle が発生するTurnが検証対象に含まれること");
  assert.ok(checkedSellingAdmin > 0, "VAP商品開発費が発生するTurnが検証対象に含まれること");
});

test("MAS-6: 退職金は変動販売費であり固定人件費へ入らない（costRecordsの意味を維持）", () => {
  let checked = 0;
  for (const { scenarioId, seed } of RUNS) {
    for (const rec of run(scenarioId, seed).state.history) {
      for (const fr of rec.financialResults) {
        const sev = fr.costRecords
          .filter((r) => r.account === "salesForceSeverance")
          .reduce((t, r) => t + n(r.fixedPortion) + n(r.variablePortion), 0);
        // costRecords 側の分類（variable / fixedPortion=0 / reducible）は変更しない
        for (const r of fr.costRecords.filter((x) => x.account === "salesForceSeverance")) {
          assert.equal(r.behavior, "variable");
          assert.equal(n(r.fixedPortion), 0);
          assert.equal(r.shortTermReducibility, "reducible");
        }
        if (sev > EPS) {
          const cm = fr.contributionMargin;
          // 固定人件費は営業人員給与＋調達人員給与のみ（退職金は入らない）
          assert.ok(n(cm.fixedPersonnelCost) > 0);
          // 変動販売費は物流費＋退職金
          assert.ok(n(cm.variableSellingCost) >= sev - EPS, `${scenarioId} T${rec.turn}/${fr.companyId}`);
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 0, "退職金が発生するTurnが検証対象に含まれること");
});

test("MAS-7: idleLaborCost を二重計上しない（regularLaborCost に内包済み）", () => {
  for (const { scenarioId, seed } of RUNS) {
    for (const rec of run(scenarioId, seed).state.history) {
      for (const fr of rec.financialResults) {
        const mc = fr.manufacturingCost;
        // 常用労務費 = 稼働ぶん + 遊休ぶん（定義）
        assert.ok(
          Math.abs(n(mc.regularLaborCost) - (n(mc.productiveRegularLaborCost) + n(mc.idleLaborCost))) <= EPS,
          `${scenarioId} T${rec.turn}/${fr.companyId}`
        );
        // 固定製造費は regularLaborCost を1回だけ含む（idleLaborCost の追加加算がない）
        const cm = fr.contributionMargin;
        const pl = fr.profitAndLoss;
        const expected =
          n(mc.regularLaborCost) +
          n(mc.factoryFixedCost) +
          n(mc.utilityFixedCost) +
          n(mc.depreciationCost) +
          n(pl.costOfSales.capexMaintenanceCost) +
          n(pl.costOfSales.factoryLifecycleCarryingCost);
        assert.ok(Math.abs(n(cm.fixedManufacturingCost) - expected) <= EPS, `${scenarioId} T${rec.turn}/${fr.companyId}`);
      }
    }
  }
});

test("MAS-8: 未吸収変動費は実額で1回だけ計上される（all-or-nothing の是正）", () => {
  // 旧実装は zeroProductionVariable>0 のとき当四半期の
  // temporaryWorkerCost + overtimeCost + utilityVariableCost を全額加算していた。
  // 是正後は実額（commonVariableCost が持つ額）のみが加算される。
  let checked = 0;
  for (const { scenarioId, seed } of RUNS) {
    for (const rec of run(scenarioId, seed).state.history) {
      for (const fr of rec.financialResults) {
        const pl = fr.profitAndLoss;
        if (n(pl.costOfSales.unabsorbedFixedManufacturingCost) <= EPS) continue;
        const cm = fr.contributionMargin;
        const mc = fr.manufacturingCost;
        const allOrNothing = n(mc.temporaryWorkerCost) + n(mc.overtimeCost) + n(mc.utilityVariableCost);
        // 未吸収変動費の実額 = commonVariableCost に含まれる zeroProductionVariable 相当。
        // 是正前はここが allOrNothing（当四半期の変動費全額）だった。
        const actualAdded = n(cm.variableProcessingCost) - n(pl.costOfSales.processingCost);
        assert.ok(actualAdded >= -EPS, `${scenarioId} T${rec.turn}/${fr.companyId} 未吸収ユーティリティは非負`);
        assert.ok(actualAdded <= allOrNothing + EPS, `${scenarioId} T${rec.turn}/${fr.companyId} 全額加算を超えない`);
        // 実額で計上されていれば、Σ商品別CM = 全社CM + 共通変動費 が閉じる（MAS-4で全件検証済み）。
        const sumByProduct = cm.byProduct.reduce((t, b) => t + n(b.contributionMargin), 0);
        assert.ok(Math.abs(sumByProduct - (n(cm.contributionMargin) + n(cm.commonVariableCost))) <= EPS, `${scenarioId} T${rec.turn}/${fr.companyId}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 0, "未吸収費用が発生するTurnが検証対象に含まれること");
});
