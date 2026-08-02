// ShrimpX V2 — ベトナムの加工優位 → 加工品需要の獲得（加工品市場進化 §d）のテスト
//
// DCA-1〜DCA-6。監査§4で「実装がまったく存在しない」と判定した経路の検証。
// 原料供給シェアと加工品供給シェアを分離し、加工能力が大きい産地がPD/VAP需要を
// より多く獲得する。ただし「ベトナムだから儲かる」にはしない
// （＝広がるのは対象需要の上限だけで、個社の成約は既存の各制約を通る）。

import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveTargetDemand,
  describeProcessingAdvantage,
  PROCESSING_ADVANTAGE_OPTIONS_V1,
} from "../marketAdapter";
import { allocateMarketProduct } from "../allocation";
import { SALES_PARAMETERS_V1 } from "../parameters";
import { CompanySalesPlanEntry } from "../types";
import { initializeScenario, getScenarioTurnInput } from "../../scenario/scenarioEngine";
import { toMarketQuarterInput } from "../../scenario/marketAdapter";
import { BASELINE_SCENARIO } from "../../scenario/definitions";
import { PreviousMarketContext } from "../../scenario/types";
import { calculateMarketQuarter } from "../../market";
import { MARKET_PARAMETERS_V1 } from "../../market/parameters";
import { createRandomStream } from "../../core/random";
import { COUNTRY_IDS, DEMAND_MARKET_IDS, MarketQuarterInput } from "../../market/types";
import { hosoEqTons, unwrapUnit, usdPerHosoEqKg } from "../../core/units";
import { period } from "../../core/period";
import { applyLifecycleDemandToMarketInput, computeMarketProductMix } from "../../market/productLifecycle";
import {
  applyProcessingCapacityEvolutionToMarketInput,
  computeProcessingCapacityRatios,
} from "../../market/processingCapacityEvolution";

function previousMarketContext(): PreviousMarketContext {
  const priorHosoFobPrice = {} as Record<string, ReturnType<typeof usdPerHosoEqKg>>;
  for (const c of COUNTRY_IDS) priorHosoFobPrice[c] = usdPerHosoEqKg(5.0);
  return {
    priorHosoFobPrice: priorHosoFobPrice as PreviousMarketContext["priorHosoFobPrice"],
    domesticProcurementIntent: hosoEqTons(40000),
  };
}

/** 加工能力進化ON（§a）＋ライフサイクルON で、指定turnの市場入力・結果を作る。 */
function buildQuarter(turn: number) {
  const state = initializeScenario(BASELINE_SCENARIO, "canonical", "processing-advantage-test");
  const base = toMarketQuarterInput(getScenarioTurnInput(state, turn), previousMarketContext());
  const mix = computeMarketProductMix(turn);
  const input: MarketQuarterInput = applyProcessingCapacityEvolutionToMarketInput(
    applyLifecycleDemandToMarketInput(base, mix),
    computeProcessingCapacityRatios(turn)
  );
  const result = calculateMarketQuarter(input, MARKET_PARAMETERS_V1, createRandomStream(`processing-advantage-${turn}`));
  return { input, result, mix };
}

function totalByProduct(
  targetDemand: ReturnType<typeof deriveTargetDemand>
): Record<"hoso" | "pd" | "vap", number> {
  const totals = { hoso: 0, pd: 0, vap: 0 };
  for (const market of DEMAND_MARKET_IDS) {
    for (const product of ["hoso", "pd", "vap"] as const) totals[product] += unwrapUnit(targetDemand[market][product]);
  }
  return totals;
}

test("DCA-1: 設定を渡さなければ従来の計算とビット単位で一致する（後方互換）", () => {
  for (const turn of [1, 16, 32]) {
    const { input, result, mix } = buildQuarter(turn);
    const legacy = deriveTargetDemand(result, input, undefined, mix);
    const explicitZero = deriveTargetDemand(result, input, undefined, mix, {
      ...PROCESSING_ADVANTAGE_OPTIONS_V1,
      advantageExponent: 0,
    });
    assert.deepEqual(explicitZero, legacy, `turn=${turn}: advantageExponent=0 は従来と同一であるべき`);
  }
});

test("DCA-2: 総量保存 — 加工優位を有効にしてもベトナムの獲得需要の合計は変わらない", () => {
  for (const turn of [1, 8, 16, 24, 32]) {
    const { input, result, mix } = buildQuarter(turn);
    const before = totalByProduct(deriveTargetDemand(result, input, undefined, mix));
    const after = totalByProduct(deriveTargetDemand(result, input, undefined, mix, PROCESSING_ADVANTAGE_OPTIONS_V1));
    const sum = (t: Record<string, number>) => t.hoso + t.pd + t.vap;
    assert.ok(
      Math.abs(sum(after) - sum(before)) < Math.max(1e-6, sum(before) * 1e-9),
      `turn=${turn}: 合計が変わっている（${sum(before)} → ${sum(after)}）`
    );
  }
});

test("DCA-3: 【監査§4の解消】序盤はベトナムがPD/VAP需要を世界平均より多く獲得する", () => {
  const { input, result, mix } = buildQuarter(1);
  const before = totalByProduct(deriveTargetDemand(result, input, undefined, mix));
  const after = totalByProduct(deriveTargetDemand(result, input, undefined, mix, PROCESSING_ADVANTAGE_OPTIONS_V1));

  assert.ok(after.pd > before.pd, `序盤のPD対象需要が増えるべき（${before.pd} → ${after.pd}）`);
  assert.ok(after.vap > before.vap, `序盤のVAP対象需要が増えるべき（${before.vap} → ${after.vap}）`);
  // 総量保存の裏返しとして、未加工HOSOの対象需要は減る（＝加工へ回る）。
  assert.ok(after.hoso < before.hoso, `未加工HOSOの対象需要は減るべき（${before.hoso} → ${after.hoso}）`);
});

test("DCA-4: 原料シェアと加工品シェアが分離されている（エクアドルは原料が多くても加工品は獲れない）", () => {
  const { input, result } = buildQuarter(1);
  const breakdown = describeProcessingAdvantage(result, input)!;

  // ベトナムの原料シェアは18%前後（worldInfluenceWeight由来）にとどまる一方、
  // PD/VAPの加工能力シェアはそれを大きく上回る。
  assert.ok(breakdown.rawShare > 0 && breakdown.rawShare < 0.35, `原料シェアは3割未満のはず（実測 ${breakdown.rawShare}）`);
  assert.ok(
    breakdown.pdProcessingShare > breakdown.rawShare,
    `PD加工能力シェア(${breakdown.pdProcessingShare})は原料シェア(${breakdown.rawShare})より大きいはず`
  );
  assert.ok(
    breakdown.vapProcessingShare > breakdown.pdProcessingShare,
    `VAP加工能力シェア(${breakdown.vapProcessingShare})はPDよりさらに大きいはず（VAP参入が最も遅いため）`
  );
  assert.ok(breakdown.pdTilt > 1 && breakdown.vapTilt > breakdown.pdTilt, "傾きはVAP > PD > 1 の順");

  // エクアドルの原料生産はベトナムより大きいのに、PD加工能力は小さい。
  assert.ok(
    unwrapUnit(input.countries.EC.production) > unwrapUnit(input.countries.VN.production),
    "ECの原料生産量はVNより大きい（前提の確認）"
  );
  assert.ok(
    unwrapUnit(input.countries.EC.pdProcessingCapacity) < unwrapUnit(input.countries.VN.pdProcessingCapacity),
    "ECのPD加工能力はVNより小さい（原料と加工品の分離）"
  );
});

test("DCA-5: 【必須要件】対象需要が広がっても、能力の無い会社は何も得しない", () => {
  // 対象需要を2倍にしても、販売希望量・営業処理能力が小さい会社の成約量は変わらない
  // （個社成約上限 = min(販売希望量, 営業処理能力, 対象需要×最大供給者シェア, 承認枠)）。
  const quarter = period(2026, 1);
  const weakCompany = (companyId: string, desired: number, headcount: number): CompanySalesPlanEntry =>
    ({
      companyId,
      market: "JP",
      product: "pd",
      desiredQuantity: hosoEqTons(desired),
      priceAdjustmentUsdPerHosoEqKg: 0,
      salesForceHeadcount: headcount,
    }) as CompanySalesPlanEntry;

  const entries = [
    weakCompany("NOCAP", 50, 0), // 原料も設備も無く、販売希望量が50tしかない会社
    weakCompany("MID", 2000, 8),
    weakCompany("BIG", 4000, 20),
  ];

  const small = allocateMarketProduct("JP", "pd", quarter, entries, usdPerHosoEqKg(5.0), hosoEqTons(5000), SALES_PARAMETERS_V1);
  const doubled = allocateMarketProduct("JP", "pd", quarter, entries, usdPerHosoEqKg(5.0), hosoEqTons(10000), SALES_PARAMETERS_V1);

  const noCapSmall = unwrapUnit(small.companies.find((c) => c.companyId === "NOCAP")!.allocatedQuantity);
  const noCapDoubled = unwrapUnit(doubled.companies.find((c) => c.companyId === "NOCAP")!.allocatedQuantity);
  assert.equal(noCapSmall, 50, "販売希望量50tの会社は対象需要5000tでも50tしか成約しない");
  assert.equal(noCapDoubled, 50, "対象需要を2倍にしても、能力の無い会社の成約量は増えない");

  // 営業人員0人の会社は処理能力200tで頭打ちになるため、希望量を増やしても伸びない。
  const zeroHeadcount = allocateMarketProduct(
    "JP",
    "pd",
    quarter,
    [weakCompany("NOSALES", 5000, 0), weakCompany("MID", 2000, 8)],
    usdPerHosoEqKg(5.0),
    hosoEqTons(10000),
    SALES_PARAMETERS_V1
  );
  assert.ok(
    unwrapUnit(zeroHeadcount.companies.find((c) => c.companyId === "NOSALES")!.allocatedQuantity) <= 200,
    "営業人員0人の会社は処理能力（200t）を超えて成約できない"
  );
});

test("DCA-6: 終盤に他産地の加工能力が追いつくと、ベトナムの加工優位は縮小する", () => {
  const earlyBreakdown = describeProcessingAdvantage(buildQuarter(1).input && buildQuarter(1).result, buildQuarter(1).input)!;
  const lateBreakdown = describeProcessingAdvantage(buildQuarter(32).result, buildQuarter(32).input)!;

  assert.ok(
    lateBreakdown.pdProcessingShare < earlyBreakdown.pdProcessingShare,
    `終盤はVNのPD加工能力シェアが低下する（${earlyBreakdown.pdProcessingShare} → ${lateBreakdown.pdProcessingShare}）`
  );
  assert.ok(
    lateBreakdown.pdTilt < earlyBreakdown.pdTilt,
    `終盤はPDの獲得傾きが縮小する（${earlyBreakdown.pdTilt} → ${lateBreakdown.pdTilt}）`
  );
  // VAPの優位は終盤も残る（＝競争軸がVAPへ移る）。
  assert.ok(lateBreakdown.vapTilt > lateBreakdown.pdTilt, "終盤もVAPの獲得傾きはPDより大きい");
});
