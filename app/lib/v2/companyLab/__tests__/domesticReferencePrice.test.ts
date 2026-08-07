// ShrimpX V2 — Turn1 国内原料参考価格と、turn1の「参考価格以上なら購入成立」ルールのテスト
//
// 【何を守るか】
//   - 参考価格が、画面用に発明した値ではなく市場エンジン（clearVietnamRawMarket）の
//     清算価格そのものであること。
//   - turn1に限り、参考価格以上を提示した会社が競争配分より先に上限まで確保できること。
//   - turn2以降はこの保証が解除され、従来どおり競争配分になること。
//   - 参考価格未満の提示は、従来どおりの競争配分（水位法）で扱われること。

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPreviousMarketContext, initializeCompanyLab } from "../runner";
import { getScenarioTurnInput } from "../../scenario/scenarioEngine";
import { toMarketQuarterInput } from "../../scenario/marketAdapter";
import { clearVietnamRawMarket } from "../../market/vietnamRawMarket";
import { MARKET_PARAMETERS_V1 } from "../../market/parameters";
import { allocateDomesticPurchase } from "../../rawMaterials/domesticPurchase";
import { RAW_MATERIALS_PARAMETERS_V1 } from "../../rawMaterials/parameters";
import { DomesticPurchasePlanEntry } from "../../rawMaterials/types";
import { PeriodV2 } from "../../core/period";
import { hosoEqTons, unwrapUnit, usdPerHosoEqKg } from "../../core/units";
import {
  DOMESTIC_PURCHASE_GUARANTEE_TURN,
  clearDomesticReferencePrice,
  computeDomesticReferencePrice,
} from "../domesticReferencePrice";

const CONFIG = { scenarioId: "baseline" as const, mode: "canonical" as const, seed: "domestic-ref-price-test", turns: 8 };

function setup() {
  const { state, fixtures } = initializeCompanyLab(CONFIG);
  return { state, fixtures };
}

test("turn1: 参考価格が取得でき、値が市場エンジンの清算価格と厳密に一致する", () => {
  const { state } = setup();
  const reference = computeDomesticReferencePrice(state, 1);
  assert.ok(reference, "turn1で参考価格が取得できる");
  assert.ok(reference!.referencePriceUsdPerHosoEqKg > 0, "参考価格が正の値である（turn1でも0にならない）");

  // 市場エンジンを直接呼んだ値と一致すること（画面用に別の式を持っていないことの確認）。
  const scenarioTurnInput = getScenarioTurnInput(state.scenarioState, 1);
  const ctx = buildPreviousMarketContext(state.scenarioState.definition, 1, scenarioTurnInput, undefined);
  const marketInput = toMarketQuarterInput(scenarioTurnInput, ctx);
  const cleared = clearVietnamRawMarket(ctx.priorHosoFobPrice.VN, marketInput.vietnamDomestic, MARKET_PARAMETERS_V1);

  assert.ok(
    Math.abs(reference!.referencePriceUsdPerHosoEqKg - unwrapUnit(cleared.price)) < 1e-9,
    `参考価格が清算価格と一致する（参考: ${reference!.referencePriceUsdPerHosoEqKg} / 清算: ${unwrapUnit(cleared.price)}）`
  );
  assert.ok(Math.abs(reference!.buyingCeilingUsdPerHosoEqKg - unwrapUnit(cleared.buyingCeiling)) < 1e-9, "買付上限が一致");
  assert.ok(
    Math.abs(reference!.farmerReservationPriceUsdPerHosoEqKg - unwrapUnit(cleared.farmerReservationPrice)) < 1e-9,
    "農家留保価格が一致"
  );
});

test("参考価格は農家留保価格以上・買付上限以下の範囲に収まる（エンジンのパラメータと整合する）", () => {
  const { state } = setup();
  const r = computeDomesticReferencePrice(state, 1)!;
  assert.ok(
    r.referencePriceUsdPerHosoEqKg >= r.farmerReservationPriceUsdPerHosoEqKg - 1e-9,
    "参考価格が農家留保価格を下回らない"
  );
  assert.ok(r.referencePriceUsdPerHosoEqKg <= r.buyingCeilingUsdPerHosoEqKg + 1e-9, "参考価格が買付上限を超えない");
});

test("保証フラグ: turn1のみ guaranteeActive=true、turn2以降はfalse（固定価格保証が解除される）", () => {
  const { state } = setup();
  assert.equal(DOMESTIC_PURCHASE_GUARANTEE_TURN, 1, "保証は導入ターン（turn1）のみ");
  assert.equal(computeDomesticReferencePrice(state, 1)!.guaranteeActive, true, "turn1は保証あり");
  for (const turn of [2, 3, 4]) {
    assert.equal(computeDomesticReferencePrice(state, turn)!.guaranteeActive, false, `turn${turn}は保証なし`);
  }
});

// ---------------------------------------------------------------------
// 配分ルール（allocateDomesticPurchase）の挙動
// ---------------------------------------------------------------------

const PERIOD = "2015Q1" as PeriodV2;

function plan(companyId: string, desiredTons: number, priceAdjustment: number): DomesticPurchasePlanEntry {
  return {
    companyId: companyId as DomesticPurchasePlanEntry["companyId"],
    desiredQuantity: hosoEqTons(desiredTons),
    priceAdjustmentUsdPerHosoEqKg: priceAdjustment,
    procurementHeadcount: 12,
    factoryCommonProcessingCapacityTons: 22_000,
  };
}

test("turn1ルール: 参考価格以上（priceAdjustment>=0）を提示した会社は、希望量を確実に購入できる", () => {
  const marketPrice = usdPerHosoEqKg(2.9);
  // 供給は全社の希望量合計より十分に多い（＝「通常条件」）。
  const supply = hosoEqTons(60_000);
  const entries = [plan("BAL", 5_000, 0), plan("MASS", 5_000, 0.1), plan("JPQ", 5_000, -0.5)];

  const withGuarantee = allocateDomesticPurchase(
    PERIOD,
    entries,
    marketPrice,
    supply,
    RAW_MATERIALS_PARAMETERS_V1,
    supply,
    marketPrice // 参考価格＝市場価格。priceAdjustment>=0 の会社が保証対象。
  );

  const bal = withGuarantee.companies.find((c) => c.companyId === "BAL")!;
  const mass = withGuarantee.companies.find((c) => c.companyId === "MASS")!;
  assert.ok(Math.abs(unwrapUnit(bal.allocatedQuantity) - 5_000) < 1, "参考価格ちょうどのBALが希望量を全量確保する");
  assert.ok(Math.abs(unwrapUnit(mass.allocatedQuantity) - 5_000) < 1, "参考価格超のMASSが希望量を全量確保する");
});

test("turn1ルール: 参考価格未満の提示は保証対象外で、保証対象が取った残りだけが競争配分へ回る", () => {
  const marketPrice = usdPerHosoEqKg(2.9);
  // 会社側の配分原資（availableSupply）は絞るが、買い占め防止シェア上限の基準
  // （shareCapReferenceSupply＝国内市場全体の供給量）は十分大きくして、
  // 「シェア上限ではなく供給量そのもので競合している」状況を作る。
  const supply = hosoEqTons(12_000);
  const shareCapReference = hosoEqTons(100_000);
  const entries = [plan("BAL", 5_000, 0), plan("MASS", 5_000, 0.1), plan("JPQ", 5_000, -0.5)];

  const result = allocateDomesticPurchase(PERIOD, entries, marketPrice, supply, RAW_MATERIALS_PARAMETERS_V1, shareCapReference, marketPrice);
  const bal = result.companies.find((c) => c.companyId === "BAL")!;
  const mass = result.companies.find((c) => c.companyId === "MASS")!;
  const jpq = result.companies.find((c) => c.companyId === "JPQ")!;

  assert.ok(Math.abs(unwrapUnit(bal.allocatedQuantity) - 5_000) < 1, "参考価格ちょうどのBALは希望量を確保");
  assert.ok(Math.abs(unwrapUnit(mass.allocatedQuantity) - 5_000) < 1, "参考価格超のMASSは希望量を確保");
  // 保証対象2社が10,000tを取り、残り2,000tだけがJPQへ回る（希望5,000tには届かない）。
  assert.ok(unwrapUnit(jpq.allocatedQuantity) < 5_000, "参考価格未満のJPQは希望量を確保できない");
  assert.ok(Math.abs(unwrapUnit(jpq.allocatedQuantity) - 2_000) < 1, "JPQへ回るのは保証対象が取った残りだけ");
});

test("turn1ルール: 保証は供給量を増やさない。供給が保証対象の合計を下回る場合は上限比で按分される", () => {
  const marketPrice = usdPerHosoEqKg(2.9);
  const supply = hosoEqTons(4_000); // 保証対象2社の希望合計10,000tを大きく下回る
  const entries = [plan("BAL", 5_000, 0), plan("MASS", 5_000, 0)];

  const result = allocateDomesticPurchase(PERIOD, entries, marketPrice, supply, RAW_MATERIALS_PARAMETERS_V1, supply, marketPrice);
  const total = result.companies.reduce((s, c) => s + unwrapUnit(c.allocatedQuantity), 0);
  assert.ok(total <= 4_000 + 1, "配分合計が供給量を超えない（物理的に存在しない原料は配分されない）");
  const bal = unwrapUnit(result.companies.find((c) => c.companyId === "BAL")!.allocatedQuantity);
  const mass = unwrapUnit(result.companies.find((c) => c.companyId === "MASS")!.allocatedQuantity);
  assert.ok(Math.abs(bal - mass) < 1, "同一条件の2社へ上限比で等しく按分される");
});

test("turn2以降（保証なし）: 同じ入力でも保証がかからず、全社が競争配分になる", () => {
  const marketPrice = usdPerHosoEqKg(2.9);
  const supply = hosoEqTons(12_000);
  const shareCapReference = hosoEqTons(100_000);
  const entries = [plan("BAL", 5_000, 0), plan("MASS", 5_000, 0.1), plan("JPQ", 5_000, -0.5)];

  // guaranteedFulfillmentBidFloor を渡さない＝turn2以降の従来経路。
  const noGuarantee = allocateDomesticPurchase(PERIOD, entries, marketPrice, supply, RAW_MATERIALS_PARAMETERS_V1, shareCapReference);
  const withGuarantee = allocateDomesticPurchase(PERIOD, entries, marketPrice, supply, RAW_MATERIALS_PARAMETERS_V1, shareCapReference, marketPrice);

  const pick = (r: typeof noGuarantee, id: string) => unwrapUnit(r.companies.find((c) => c.companyId === id)!.allocatedQuantity);

  // 保証がないturn2以降では、安値提示のJPQも競争配分に参加できるため取得量が増える。
  assert.ok(pick(noGuarantee, "JPQ") > pick(withGuarantee, "JPQ"), "保証解除により、参考価格未満の会社の配分が競争配分へ戻る");
  // 逆に、保証対象だった高値提示の2社は、保証がないと希望量を確保できなくなる。
  assert.ok(pick(noGuarantee, "BAL") < 5_000, "保証がないturn2以降ではBALも希望量を確保できるとは限らない");
  assert.ok(pick(noGuarantee, "MASS") < 5_000, "保証がないturn2以降ではMASSも希望量を確保できるとは限らない");
  // 高値提示ほど多く取れるという競争配分の性質自体は維持される。
  assert.ok(pick(noGuarantee, "MASS") > pick(noGuarantee, "JPQ"), "競争配分では高値提示のMASSが安値提示のJPQより多く取る");

  const total = noGuarantee.companies.reduce((s, c) => s + unwrapUnit(c.allocatedQuantity), 0);
  assert.ok(total <= 12_000 + 1, "保証なしでも配分合計は供給量を超えない");
});

test("後方互換: guaranteedFulfillmentBidFloor未指定の結果は、この機能の追加前と同じ競争配分のままである", () => {
  const marketPrice = usdPerHosoEqKg(2.9);
  const supply = hosoEqTons(9_000);
  const entries = [plan("BAL", 4_000, 0.05), plan("MASS", 4_000, 0), plan("JPQ", 4_000, -0.1)];

  const result = allocateDomesticPurchase(PERIOD, entries, marketPrice, supply, RAW_MATERIALS_PARAMETERS_V1, supply);
  // 水位法の性質: 全社が0より大きく配分され、合計は供給量以下、各社は希望量以下。
  for (const c of result.companies) {
    assert.ok(unwrapUnit(c.allocatedQuantity) > 0, `${c.companyId}が競争配分で0にならない`);
    assert.ok(unwrapUnit(c.allocatedQuantity) <= 4_000 + 1, `${c.companyId}の配分が希望量を超えない`);
  }
  const total = result.companies.reduce((s, c) => s + unwrapUnit(c.allocatedQuantity), 0);
  assert.ok(total <= 9_000 + 1, "配分合計が供給量を超えない");
});

test("画面用と四半期処理用の参考価格が同じ関数（clearDomesticReferencePrice）を通り、値が一致する", () => {
  const { state } = setup();
  const scenarioTurnInput = getScenarioTurnInput(state.scenarioState, 1);
  const ctx = buildPreviousMarketContext(state.scenarioState.definition, 1, scenarioTurnInput, undefined);
  const marketInput = toMarketQuarterInput(scenarioTurnInput, ctx);

  // 四半期処理側（companyLab/runner.tsと同じ呼び方）
  const runnerSide = clearDomesticReferencePrice(ctx.priorHosoFobPrice.VN, marketInput.vietnamDomestic);
  // 画面側
  const uiSide = computeDomesticReferencePrice(state, 1)!;

  assert.ok(
    Math.abs(runnerSide.referencePriceUsdPerHosoEqKg - uiSide.referencePriceUsdPerHosoEqKg) < 1e-9,
    `画面表示価格と四半期処理の判定価格が一致する（runner: ${runnerSide.referencePriceUsdPerHosoEqKg} / UI: ${uiSide.referencePriceUsdPerHosoEqKg}）`
  );
});
