// ShrimpX V2 — 加工品市場進化（processed market evolution）характerization テスト
//
// 【目的】PD/VAPを中長期戦略の中心に据える市場進化の実装に着手する前に、
// 「需要・価格・営業能力制約」の**現在の挙動**を数値で固定する。以後の
// ラウンドで機構を変更したとき、どの数値がどれだけ動いたかを差分で確認できる
// ようにするための基準点であり、「この値が正しい」ことを主張するテストではない
// （characterization test / golden master）。
//
// 【対象（監査9項目のうち数値で固定できるもの）】
//   1. 市場別需要と世界需要（scenario→market/globalDemand）
//   2. HOSO/PD/VAPの構成比（market/productLifecycle、SAI-5C。既定OFF）
//   3. PD/VAPプレミアムと仕向市場別参照価格（market/productPremium・destinationPricing）
//   4. ベトナムが獲得する対象需要（sales/marketAdapter.deriveTargetDemand）
//   5. 営業人員→処理能力→営業工数縮小係数（sales/salesForce・marketEffort）
//   6. VAP能力スコア→成約配分（sales/allocation、Test15のvapCapabilityウェイト）
//
// 【決定論】シナリオはbaseline・canonical・固定seed、乱数ストリームもturnごとに
// 固定文字列から生成する。したがって同じコードからは常に同じ数値が出る。
//
// 【許容誤差】浮動小数の丸め差だけを吸収する狭い許容（相対1e-6）を使う。
// 実装を変えれば必ず失敗する（それが目的）。

import test from "node:test";
import assert from "node:assert/strict";

import { initializeScenario, getScenarioTurnInput } from "../../scenario/scenarioEngine";
import { toMarketQuarterInput } from "../../scenario/marketAdapter";
import { BASELINE_SCENARIO } from "../../scenario/definitions";
import { PreviousMarketContext } from "../../scenario/types";
import { calculateMarketQuarter } from "../index";
import { MARKET_PARAMETERS_V1 } from "../parameters";
import { createRandomStream } from "../../core/random";
import { COUNTRY_IDS, DEMAND_MARKET_IDS, DemandMarketId, MarketQuarterInput, Product } from "../types";
import { hosoEqTons, score0to100, unwrapUnit, usdPerHosoEqKg } from "../../core/units";
import { period } from "../../core/period";
import { applyLifecycleDemandToMarketInput, computeMarketProductMix } from "../productLifecycle";
import { deriveTargetDemand, deriveVietnamMarketReferencePrices } from "../../sales/marketAdapter";
import { computeMarketSalesEffort } from "../../sales/marketEffort";
import { processingCapacity } from "../../sales/salesForce";
import { SALES_PARAMETERS_TEST15_VAP_CAPABILITY_V1, SALES_PARAMETERS_V1 } from "../../sales/parameters";
import { allocateMarketProduct } from "../../sales/allocation";
import { CompanySalesPlanEntry } from "../../sales/types";

const REL_TOLERANCE = 1e-6;

function assertClose(actual: number, expected: number, label: string): void {
  const tolerance = Math.max(Math.abs(expected) * REL_TOLERANCE, 1e-9);
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: 現在値 ${actual} が基準値 ${expected} から動いています（許容 ±${tolerance}）。` +
      `意図した変更であれば、この基準値を更新したうえで何が動いたかをレポートへ記録してください。`
  );
}

function previousMarketContext(): PreviousMarketContext {
  const priorHosoFobPrice = {} as Record<string, ReturnType<typeof usdPerHosoEqKg>>;
  for (const c of COUNTRY_IDS) priorHosoFobPrice[c] = usdPerHosoEqKg(5.0);
  return {
    priorHosoFobPrice: priorHosoFobPrice as PreviousMarketContext["priorHosoFobPrice"],
    domesticProcurementIntent: hosoEqTons(40000),
  };
}

/**
 * 指定turnの市場結果を、ライフサイクル（SAI-5C）ON/OFFの両方で再現する共通ハーネス。
 * companyLab/runner.ts と同じ順序（市場入力→ライフサイクル適用→calculateMarketQuarter
 * →参照価格→対象需要）で呼び出すが、会社の意思決定は含まない（市場側のみを固定する）。
 */
function runMarketQuarter(turn: number, lifecycleEnabled: boolean) {
  const state = initializeScenario(BASELINE_SCENARIO, "canonical", "processed-market-evolution-characterization");
  const turnInput = getScenarioTurnInput(state, turn);
  const baseInput = toMarketQuarterInput(turnInput, previousMarketContext());
  const mix = computeMarketProductMix(turn);
  const input: MarketQuarterInput = lifecycleEnabled ? applyLifecycleDemandToMarketInput(baseInput, mix) : baseInput;
  const result = calculateMarketQuarter(input, MARKET_PARAMETERS_V1, createRandomStream(`processed-market-evolution-${turn}`));
  const referencePrices = deriveVietnamMarketReferencePrices(result);
  const targetDemand = deriveTargetDemand(result, input, undefined, lifecycleEnabled ? mix : undefined);
  return { input, result, referencePrices, targetDemand, mix };
}

// ---------------------------------------------------------------------
// 1. 世界需要・ベトナム獲得需要（現行の基準点）
// ---------------------------------------------------------------------

/** turn → { worldDemand, vnAllocatedDemand }。ライフサイクルは総需要を変えないため共通。 */
const EXPECTED_WORLD_AND_VN_DEMAND: Readonly<Record<number, { readonly worldDemand: number; readonly vnAllocatedDemand: number }>> = {
  1: { worldDemand: 1_200_000, vnAllocatedDemand: 216_000 },
  8: { worldDemand: 1_247_187.617204301, vnAllocatedDemand: 224_493.77109677417 },
  16: { worldDemand: 1_301_931.2903225806, vnAllocatedDemand: 234_347.6322580645 },
  24: { worldDemand: 1_309_577.9911290323, vnAllocatedDemand: 235_724.0384032258 },
  32: { worldDemand: 1_398_637, vnAllocatedDemand: 251_754.66 },
};

test("CHAR-1: 世界需要とベトナム獲得需要（baseline、turn1/8/16/24/32）が現行値で固定されている", () => {
  for (const [turnKey, expected] of Object.entries(EXPECTED_WORLD_AND_VN_DEMAND)) {
    const turn = Number(turnKey);
    for (const lifecycleEnabled of [false, true]) {
      const { result } = runMarketQuarter(turn, lifecycleEnabled);
      assertClose(unwrapUnit(result.worldDemand), expected.worldDemand, `turn=${turn} lifecycle=${lifecycleEnabled} worldDemand`);
      assertClose(
        unwrapUnit(result.hosoPrices.VN.allocatedDemand),
        expected.vnAllocatedDemand,
        `turn=${turn} lifecycle=${lifecycleEnabled} VN.allocatedDemand`
      );
    }
  }
});

test("CHAR-2: ライフサイクルON/OFFで市場全体需要は一切変わらない（構成比のみを扱う設計の不変条件）", () => {
  for (const turn of [1, 8, 16, 24, 32]) {
    const off = runMarketQuarter(turn, false);
    const on = runMarketQuarter(turn, true);
    assertClose(unwrapUnit(on.result.worldDemand), unwrapUnit(off.result.worldDemand), `turn=${turn} worldDemand`);
    // 対象需要の総和（5市場×3商品）も総需要保存が成り立つ。
    const sum = (t: ReturnType<typeof runMarketQuarter>["targetDemand"]) =>
      DEMAND_MARKET_IDS.reduce(
        (acc, m) => acc + (["hoso", "pd", "vap"] as const).reduce((s, p) => s + unwrapUnit(t[m][p]), 0),
        0
      );
    assertClose(sum(on.targetDemand), sum(off.targetDemand), `turn=${turn} targetDemand総和`);
  }
});

// ---------------------------------------------------------------------
// 2. HOSO/PD/VAP構成比（SAI-5C productLifecycle。既定OFFだが基準を固定する）
// ---------------------------------------------------------------------

const EXPECTED_MIX: Readonly<Record<number, Readonly<Record<DemandMarketId, readonly [number, number, number]>>>> = {
  // [hoso, pd, vap]
  1: {
    JP: [0.56, 0.34, 0.1],
    US: [0.64, 0.3, 0.06],
    EU: [0.67, 0.28, 0.05],
    OTHER: [0.75, 0.22, 0.03],
    CN: [0.87, 0.12, 0.01],
  },
  16: {
    JP: [0.3, 0.4, 0.3],
    US: [0.36, 0.38, 0.26],
    EU: [0.5310400000000001, 0.32944, 0.13952],
    OTHER: [0.6539599999999999, 0.2676, 0.07844000000000001],
    CN: [0.8475, 0.135, 0.0175],
  },
  32: {
    JP: [0.3, 0.4, 0.3],
    US: [0.36, 0.38, 0.26],
    EU: [0.48, 0.34, 0.18],
    OTHER: [0.56, 0.3, 0.14],
    CN: [0.6, 0.3, 0.1],
  },
};

test("CHAR-3: 市場別商品構成比（productLifecycle）が現行のS字カーブ値で固定されている", () => {
  for (const [turnKey, expectedByMarket] of Object.entries(EXPECTED_MIX)) {
    const turn = Number(turnKey);
    const mix = computeMarketProductMix(turn);
    for (const market of DEMAND_MARKET_IDS) {
      const [hoso, pd, vap] = expectedByMarket[market];
      assertClose(mix[market].hoso, hoso, `turn=${turn} ${market}.hoso`);
      assertClose(mix[market].pd, pd, `turn=${turn} ${market}.pd`);
      assertClose(mix[market].vap, vap, `turn=${turn} ${market}.vap`);
      assertClose(mix[market].hoso + mix[market].pd + mix[market].vap, 1, `turn=${turn} ${market} 行和`);
    }
  }
});

// ---------------------------------------------------------------------
// 3. PD/VAPプレミアムと世界稼働率
// ---------------------------------------------------------------------

/** turn → lifecycleフラグ → { vnHoso, vnPd, vnVap, pdUtilization, vapUtilization }。 */
const EXPECTED_VN_PRICES: Readonly<
  Record<number, Readonly<Record<"off" | "on", { readonly hoso: number; readonly pd: number; readonly vap: number; readonly pdUtil: number; readonly vapUtil: number }>>>
> = {
  1: {
    off: { hoso: 4.1404, pd: 4.837, vap: 6.305, pdUtil: 0.56, vapUtil: 0.72 },
    on: { hoso: 4.1404, pd: 4.7794, vap: 5.4442, pdUtil: 0.4633333333333333, vapUtil: 0.2475 },
  },
  16: {
    off: { hoso: 4.3388, pd: 5.0762, vap: 6.6363, pdUtil: 0.5718581604211831, vapUtil: 0.7352462062558065 },
    on: { hoso: 4.3388, pd: 5.0713, vap: 6.8114, pdUtil: 0.5640552988541344, vapUtil: 0.8269751749767728 },
  },
  32: {
    off: { hoso: 4.6981, pd: 5.5044, vap: 7.2167, pdUtil: 0.5835052179251076, vapUtil: 0.750220994475138 },
    on: { hoso: 4.6981, pd: 5.583, vap: 7.9505, pdUtil: 0.6998004910988337, vapUtil: 1.1052025782688764 },
  },
};

test("CHAR-4: VN基準価格（HOSO/PD/VAP）とPD/VAP世界稼働率が現行値で固定されている", () => {
  for (const [turnKey, byFlag] of Object.entries(EXPECTED_VN_PRICES)) {
    const turn = Number(turnKey);
    for (const [flagKey, expected] of Object.entries(byFlag)) {
      const lifecycleEnabled = flagKey === "on";
      const { result } = runMarketQuarter(turn, lifecycleEnabled);
      const label = `turn=${turn} lifecycle=${flagKey}`;
      // 価格は小数第4位で丸めた基準値と比較する（丸め幅を明示した緩い許容）。
      const round4 = (x: number) => Math.round(x * 10000) / 10000;
      assert.equal(round4(unwrapUnit(result.hosoPrices.VN.price)), expected.hoso, `${label} VN HOSO価格`);
      assert.equal(round4(unwrapUnit(result.pdPremium.byCountry.VN.finalPrice)), expected.pd, `${label} VN PD価格`);
      assert.equal(round4(unwrapUnit(result.vapPremium.byCountry.VN.finalPrice)), expected.vap, `${label} VN VAP価格`);
      assertClose(result.pdPremium.globalUtilization, expected.pdUtil, `${label} PD世界稼働率`);
      assertClose(result.vapPremium.globalUtilization, expected.vapUtil, `${label} VAP世界稼働率`);
    }
  }
});

test("CHAR-5: 【既定OFF時の構造的性質】加工能力進化なしではPD世界稼働率は終盤にかけて下がらない", () => {
  // 【重要・更新履歴】このテストは監査時点で「現状こうなっている（＝意図と逆）」
  // 性質を固定したものだった。加工品市場進化 §a（market/processingCapacityEvolution.ts）
  // により、config.marketEvolution.originProcessingCapacity を有効にした場合は
  // この性質が**反転する**（PD稼働率が終盤に低下しプレミアムが圧縮される）。
  // それは processingCapacityEvolution.test.ts の PCE-7 が検証している。
  // 本テストは「フラグOFF＝既存Test15ラボの挙動は一切変わっていない」ことの
  // 回帰テストとして意味が変わったため、そのまま残す。
  // 意図する物語では「後半に他産地がPD加工へ参入 → PD供給増 → プレーンPDの
  // プレミアムが圧縮される」。現行実装では各国のPD加工能力が生産量の固定比率
  // （scenario/parameters.ts defaultPdCapacityRatioOfProduction=0.3）でしかなく、
  // 産地別の参入タイミングという概念が無いため、PD稼働率＝PDプレミアムは
  // 終盤にかけて**上昇**する。この性質を明示的に固定し、将来の実装で
  // 反転したことを検知できるようにする。
  const early = runMarketQuarter(1, true).result.pdPremium.globalUtilization;
  const late = runMarketQuarter(32, true).result.pdPremium.globalUtilization;
  assert.ok(late > early, `現行実装ではPD世界稼働率が終盤に上昇するはず（turn1=${early} turn32=${late}）`);
  assertClose(early, 0.4633333333333333, "turn1 PD世界稼働率");
  assertClose(late, 0.6998004910988337, "turn32 PD世界稼働率");
});

test("CHAR-6: 【既定OFF時の構造的性質】4産地のPD/VAP加工能力は生産量の同一固定比率（産地別加工優位なし）", () => {
  // 【更新履歴】CHAR-5と同様、加工能力進化を有効にした場合は産地別に分かれる
  // （PCE-4が検証）。本テストはフラグOFF時の後方互換の回帰テストとして残す。
  // ベトナムのPD/VAP加工優位（序盤の投資準備期の前提）は、現在の市場モジュール
  // には入力として存在しない。scenario側の PD_PROCESSING_CAPACITY トレンドは
  // 型としては用意されているが、どのシナリオ定義もこれを設定していない。
  for (const turn of [1, 16, 32]) {
    const { input } = runMarketQuarter(turn, true);
    for (const country of COUNTRY_IDS) {
      const production = unwrapUnit(input.countries[country].production);
      assertClose(
        unwrapUnit(input.countries[country].pdProcessingCapacity) / production,
        0.3,
        `turn=${turn} ${country} PD能力/生産量`
      );
      assertClose(
        unwrapUnit(input.countries[country].vapProcessingCapacity) / production,
        0.1,
        `turn=${turn} ${country} VAP能力/生産量`
      );
    }
  }
});

// ---------------------------------------------------------------------
// 4. 仕向市場別参照価格（Phase 8P-0A destinationPricing）
// ---------------------------------------------------------------------

const EXPECTED_REFERENCE_PRICES_TURN32_LIFECYCLE_ON: Readonly<Record<DemandMarketId, readonly [number, number, number]>> = {
  // [hoso, pd, vap]（小数第4位で丸めた値）
  CN: [4.6591, 5.4905, 7.5329],
  US: [4.7061, 5.6002, 8.051],
  EU: [4.7535, 5.7013, 8.4243],
  JP: [4.777, 5.7472, 8.6291],
  OTHER: [4.6356, 5.4761, 7.564],
};

test("CHAR-7: 仕向市場別参照価格（JPのVAPが最高、CNのVAPが最低）が現行値で固定されている", () => {
  const { referencePrices } = runMarketQuarter(32, true);
  const round4 = (x: number) => Math.round(x * 10000) / 10000;
  for (const market of DEMAND_MARKET_IDS) {
    const [hoso, pd, vap] = EXPECTED_REFERENCE_PRICES_TURN32_LIFECYCLE_ON[market];
    assert.equal(round4(unwrapUnit(referencePrices[market].hoso)), hoso, `${market} hoso参照価格`);
    assert.equal(round4(unwrapUnit(referencePrices[market].pd)), pd, `${market} pd参照価格`);
    assert.equal(round4(unwrapUnit(referencePrices[market].vap)), vap, `${market} vap参照価格`);
  }
  // 市場差別化の方向（JP > EU > US > OTHER > CN、VAP）が保たれていること。
  const vapOf = (m: DemandMarketId) => unwrapUnit(referencePrices[m].vap);
  assert.ok(vapOf("JP") > vapOf("EU"), "JPのVAP参照価格はEUより高い");
  assert.ok(vapOf("EU") > vapOf("US"), "EUのVAP参照価格はUSより高い");
  assert.ok(vapOf("US") > vapOf("OTHER"), "USのVAP参照価格はOTHERより高い");
  assert.ok(vapOf("OTHER") > vapOf("CN"), "OTHERのVAP参照価格はCNより高い");
});

// ---------------------------------------------------------------------
// 5. ベトナムの市場×商品別対象需要
// ---------------------------------------------------------------------

const EXPECTED_TARGET_DEMAND_TURN32: Readonly<
  Record<"off" | "on", Readonly<Record<DemandMarketId, readonly [number, number, number]>>>
> = {
  off: {
    CN: [52141.32, 23173.92, 9931.68],
    US: [40279.68, 17902.08, 7672.32],
    EU: [31253.04, 13890.24, 5952.96],
    JP: [10410.12, 4626.72, 1982.88],
    OTHER: [19901.7, 8845.2, 3790.8],
  },
  on: {
    CN: [51148.152, 25574.076, 8524.692],
    US: [23707.4688, 25024.5504, 17122.0608],
    EU: [24526.1952, 17372.7216, 9197.3232],
    JP: [5105.916, 6807.888, 5105.916],
    OTHER: [18221.112, 9761.31, 4555.278],
  },
};

test("CHAR-8: 市場×商品別の対象需要（turn32）が現行値で固定されている", () => {
  for (const flagKey of ["off", "on"] as const) {
    const { targetDemand } = runMarketQuarter(32, flagKey === "on");
    for (const market of DEMAND_MARKET_IDS) {
      const [hoso, pd, vap] = EXPECTED_TARGET_DEMAND_TURN32[flagKey][market];
      assertClose(unwrapUnit(targetDemand[market].hoso), hoso, `lifecycle=${flagKey} ${market}.hoso対象需要`);
      assertClose(unwrapUnit(targetDemand[market].pd), pd, `lifecycle=${flagKey} ${market}.pd対象需要`);
      assertClose(unwrapUnit(targetDemand[market].vap), vap, `lifecycle=${flagKey} ${market}.vap対象需要`);
    }
  }
});

// ---------------------------------------------------------------------
// 6. 営業人員 → 処理能力 → 営業工数縮小係数（今回の再設計対象）
// ---------------------------------------------------------------------

const EXPECTED_PROCESSING_CAPACITY: readonly (readonly [number, number])[] = [
  [0, 200],
  [2, 1000],
  [5, 1800],
  [8, 2333.33],
  [10, 2600],
  [15, 3080],
  [20, 3400],
  [30, 3800],
  [50, 4200],
];

test("CHAR-9: 営業人員→処理能力曲線（Michaelis-Menten、上限5000t漸近）が現行値で固定されている", () => {
  for (const [headcount, expected] of EXPECTED_PROCESSING_CAPACITY) {
    assertClose(unwrapUnit(processingCapacity(headcount, SALES_PARAMETERS_V1)), expected, `processingCapacity(${headcount})`);
  }
  // 漸近上限は baselineCapacityTons + capacityMaxIncrementTons = 5000t/市場・四半期。
  assertClose(
    SALES_PARAMETERS_V1.salesForce.baselineCapacityTons + SALES_PARAMETERS_V1.salesForce.capacityMaxIncrementTons,
    5000,
    "1市場あたり処理能力の漸近上限"
  );
});

const EXPECTED_EFFORT_CASES: readonly {
  readonly headcount: number;
  readonly desired: Readonly<Record<Product, number>>;
  readonly effort: number;
  readonly scaleFactor: number;
}[] = [
  { headcount: 8, desired: { hoso: 2000, pd: 1000, vap: 200 }, effort: 3800, scaleFactor: 0.6140342105263158 },
  { headcount: 8, desired: { hoso: 2000, pd: 1000, vap: 1000 }, effort: 6200, scaleFactor: 0.3763435483870968 },
  { headcount: 20, desired: { hoso: 4000, pd: 3000, vap: 1500 }, effort: 12100, scaleFactor: 0.28099173553719006 },
  { headcount: 5, desired: { hoso: 500, pd: 300, vap: 100 }, effort: 1160, scaleFactor: 1 },
];

test("CHAR-10: 営業工数換算（HOSO1.0/PD1.2/VAP3.0）と能力超過時の比例縮小係数が現行値で固定されている", () => {
  for (const c of EXPECTED_EFFORT_CASES) {
    const result = computeMarketSalesEffort(c.headcount, c.desired, SALES_PARAMETERS_V1);
    assertClose(result.desiredEffortWeightedQuantity, c.effort, `h=${c.headcount} 営業工数換算数量`);
    assertClose(result.scaleFactor, c.scaleFactor, `h=${c.headcount} scaleFactor`);
    // 縮小は全商品へ同一係数で掛かる（商品別の優先付けは現状存在しない）。
    for (const p of ["hoso", "pd", "vap"] as const) {
      assertClose(result.adjustedQuantityByProduct[p], c.desired[p] * c.scaleFactor, `h=${c.headcount} ${p} 縮小後数量`);
    }
  }
});

test("CHAR-11: 【現行の構造的性質】VAP係数3.0により、VAP比率を上げるほど市場全体の販売可能量が急減する", () => {
  // Phase7のプリフライト校正で特定した「VAP投資が販売へ変換されない」構造の中核。
  const headcount = 10;
  const allHoso = computeMarketSalesEffort(headcount, { hoso: 3000, pd: 0, vap: 0 }, SALES_PARAMETERS_V1);
  const allVap = computeMarketSalesEffort(headcount, { hoso: 0, pd: 0, vap: 3000 }, SALES_PARAMETERS_V1);
  assertClose(allHoso.scaleFactor, 2600 / 3000, "全HOSOのscaleFactor");
  assertClose(allVap.scaleFactor, 2600 / 9000, "全VAPのscaleFactor");
  // 同じ営業人員で成立する数量は、VAPのみの場合HOSOのみの場合のちょうど1/3。
  assertClose(allVap.adjustedQuantityByProduct.vap / allHoso.adjustedQuantityByProduct.hoso, 1 / 3, "VAP/HOSOの成立数量比");
});

// ---------------------------------------------------------------------
// 7. VAP能力スコア → 成約配分（Test15のvapCapabilityウェイト）
// ---------------------------------------------------------------------

function vapPlanEntry(companyId: string, vapCapabilityScore: number, priceAdjustment = 0): CompanySalesPlanEntry {
  return {
    companyId: companyId as CompanySalesPlanEntry["companyId"],
    market: "JP",
    product: "vap",
    desiredQuantity: hosoEqTons(1500),
    priceAdjustmentUsdPerHosoEqKg: priceAdjustment,
    salesForceHeadcount: 8,
    vapCapabilityScore: score0to100(vapCapabilityScore),
  } as CompanySalesPlanEntry;
}

test("CHAR-12: VAP能力スコアの成約配分への効き（現行ウェイト0.08）が現行値で固定されている", () => {
  const entries = [
    vapPlanEntry("BAL", 50),
    vapPlanEntry("CONSV", 50),
    vapPlanEntry("JPQ", 70, 0.2),
    vapPlanEntry("MASS", 40, -0.2),
    vapPlanEntry("VAP", 90),
  ];
  const quarter = period(2026, 1);

  const neutral = allocateMarketProduct("JP", "vap", quarter, entries, usdPerHosoEqKg(6.0), hosoEqTons(5000), SALES_PARAMETERS_V1);
  const withVapWeight = allocateMarketProduct(
    "JP",
    "vap",
    quarter,
    entries,
    usdPerHosoEqKg(6.0),
    hosoEqTons(5000),
    SALES_PARAMETERS_TEST15_VAP_CAPABILITY_V1
  );

  const allocOf = (r: typeof neutral, id: string) => unwrapUnit(r.companies.find((c) => c.companyId === id)!.allocatedQuantity);

  // ウェイト0（既定V1）ではVAP能力スコアの差が成約量に一切効かない。
  assertClose(allocOf(neutral, "BAL"), 891.32, "V1 BAL成約量");
  assertClose(allocOf(neutral, "VAP"), 891.32, "V1 VAP社成約量");
  assert.equal(allocOf(neutral, "BAL"), allocOf(neutral, "VAP"), "V1ではスコア50と90で成約量が同じ");

  // ウェイト0.08（Test15既定ON相当）でも、スコア50→90の差は成約量+4%程度にとどまる。
  assertClose(allocOf(withVapWeight, "BAL"), 879.45, "Test15 BAL成約量");
  assertClose(allocOf(withVapWeight, "VAP"), 928.63, "Test15 VAP社成約量");
  const uplift = allocOf(withVapWeight, "VAP") / allocOf(withVapWeight, "BAL") - 1;
  assert.ok(uplift > 0, "スコア90はスコア50より多く成約する");
  assert.ok(uplift < 0.06, `スコア50→90の成約量押し上げは現状6%未満（実測 ${(uplift * 100).toFixed(2)}%）`);
});
