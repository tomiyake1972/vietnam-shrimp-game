// ShrimpX V2 — 財務モジュール 初期財務状態テスト（Phase 8A）
//
// 対応する実装範囲項目: 3. 初期財務状態（資産 = 負債 + 純資産、5社の差別化、
// 原料在庫の初期金額が実ロットと一致すること）

import { test } from "node:test";
import assert from "node:assert/strict";
import { period } from "../../core/period";
import { hosoEqTons, usdPerHosoEqKg } from "../../core/units";
import { RawMaterialLot } from "../../rawMaterials/types";
import { buildCompanyFixtures } from "../../companyLab/fixtures";
import { INITIAL_FINANCE_FIXTURES_V1, buildInitialCompanyFinanceState, rawMaterialInventoryValueUsd } from "../initialState";
import { FinanceValidationError } from "../types";

const P1 = period(2015, 1);
const EPS = 0.01;

test("受入確認I-1: 5社すべての初期財務状態で 資産 = 負債 + 純資産 が厳密に成立する", () => {
  const fixtures = buildCompanyFixtures(P1);
  for (const f of fixtures) {
    const s = buildInitialCompanyFinanceState(f.companyId, f.initialRawMaterialLots, P1);
    const rmValue = rawMaterialInventoryValueUsd(f.initialRawMaterialLots, f.companyId);
    const arValue = s.receivables.reduce((sum, r) => sum + (r.amount as number), 0);
    const assets = (s.cash as number) + arValue + rmValue + (s.otherCurrentAssets as number) + ((s.fixedAssetsGross as number) - (s.accumulatedDepreciation as number));
    const liabilities = (s.shortTermLoans as number) + (s.longTermLoans as number) + (s.otherLiabilities as number);
    const equity = (s.capitalStock as number) + (s.retainedEarnings as number);
    assert.ok(Math.abs(assets - (liabilities + equity)) < EPS, `${f.companyId}: 資産${assets} ≠ 負債${liabilities}+純資産${equity}`);
  }
});

test("受入確認I-2: 初期原料在庫の金額は、フィクスチャの実ロット（数量×取得単価×1,000）から算出される", () => {
  const lots: RawMaterialLot[] = [
    {
      lotId: "T1",
      companyId: "BAL",
      source: "domestic",
      originCountry: "VN",
      inboundPeriod: P1,
      originalQuantity: hosoEqTons(100),
      remainingQuantity: hosoEqTons(100),
      unitCost: usdPerHosoEqKg(3.5),
      availableFromPeriod: P1,
      status: "available",
    },
  ];
  assert.equal(rawMaterialInventoryValueUsd(lots, "BAL"), 100 * 1000 * 3.5);
  // 他社のロットは含めない
  assert.equal(rawMaterialInventoryValueUsd(lots, "MASS"), 0);
});

test("受入確認I-3: 養殖中（growingAquaculture）ロットは初期在庫金額に含めない（収穫時一括認識の会計方針）", () => {
  const lots: RawMaterialLot[] = [
    {
      lotId: "G1",
      companyId: "BAL",
      source: "aquaculture",
      originCountry: "VN",
      inboundPeriod: P1,
      originalQuantity: hosoEqTons(100),
      remainingQuantity: hosoEqTons(100),
      unitCost: usdPerHosoEqKg(3.2),
      availableFromPeriod: P1,
      status: "growingAquaculture",
    },
  ];
  assert.equal(rawMaterialInventoryValueUsd(lots, "BAL"), 0);
});

test("受入確認I-4: 5社の初期財務状態はアーキタイプと整合する差を持つ（CONSVは最小借入・MASSは最大固定資産と借入）", () => {
  const byId = new Map(INITIAL_FINANCE_FIXTURES_V1.map((f) => [f.companyId, f]));
  const loans = (id: string) => byId.get(id)!.shortTermLoans + byId.get(id)!.longTermLoans;
  assert.ok(loans("CONSV") < loans("BAL"));
  assert.ok(loans("CONSV") < loans("MASS"));
  assert.ok(byId.get("MASS")!.fixedAssetsGross > byId.get("BAL")!.fixedAssetsGross);
  assert.equal(byId.get("CONSV")!.shortTermLoans, 0);
});

test("受入確認I-5: 未定義の会社IDはFinanceValidationErrorとして拒否される", () => {
  assert.throws(() => buildInitialCompanyFinanceState("UNKNOWN", [], P1), FinanceValidationError);
});

test("受入確認I-6: 初期売掛金は開始四半期に回収予定として構築される（コールドスタート回避の継続企業前提）", () => {
  const fixtures = buildCompanyFixtures(P1);
  const s = buildInitialCompanyFinanceState("BAL", fixtures.find((f) => f.companyId === "BAL")!.initialRawMaterialLots, P1);
  assert.equal(s.receivables.length, 1);
  assert.equal(s.receivables[0].dueSettlementPeriod, P1);
  assert.equal(s.receivables[0].sourceRef, "initial:pre-game-sales");
});
