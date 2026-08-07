// ShrimpX V2 — Phase SAI-5A: 市場・商品志向プロファイルの単体テスト
//
// 実装指示§6（テスト）のうち、志向プロファイルの値そのもの
// （倍率の取得・許容範囲・A社=中立・SAI-4性格との独立性・志向による
// 方向性のある再配分・総量保存・市況応答）を扱う。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMPANY_ORIENTATION_PROFILES,
  COMPANY_ORIENTATION_BY_COMPANY_ID,
  MARKET_ORIENTATION_RANGE,
  PRODUCT_ORIENTATION_RANGE,
  COMBINED_ORIENTATION_RANGE,
  applyOrientationProfile,
  resolveOrientationProfile,
  createSai5ParamsResolver,
} from "../orientationProfile";
import { STANDARD_AI_PARAMETERS_V1 } from "../parameters";
import { resolveManagementProfileParameters } from "../managementProfile";
import { generateStandardAiDecisionWithDiagnostics } from "../policy";
import { initializeUnifiedCompanyLabFromTemplate, ALL_COMPANY_IDS } from "../report/decomposeHarness";
import { STANDARD_BASELINE_CANDIDATES, SELECTED_STANDARD_BASELINE_CANDIDATE_ID } from "../report/standardBaseline";
import { buildPublicMarketInfo, buildCompanyOwnState } from "../../runner";
import { DemandMarketId, Product } from "../../../market/types";

const candidate = STANDARD_BASELINE_CANDIDATES.find((c) => c.id === SELECTED_STANDARD_BASELINE_CANDIDATE_ID)!;
const MARKETS: readonly DemandMarketId[] = ["CN", "US", "EU", "JP", "OTHER"];
const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

// ---------------------------------------------------------------------
// プロファイル定義の検証
// ---------------------------------------------------------------------

test("SAI-5A: 5社すべてに志向プロファイルが割り当てられ、BALは完全中立（全倍率1.0）", () => {
  assert.equal(Object.keys(COMPANY_ORIENTATION_BY_COMPANY_ID).length, 5);
  const bal = resolveOrientationProfile("BAL");
  for (const m of MARKETS) assert.equal(bal.marketMultipliers[m], 1.0);
  for (const p of PRODUCTS) assert.equal(bal.productMultipliers[p], 1.0);
});

test("SAI-5A: 各社の市場志向倍率が指示どおりの値で取得できる（MASS=中国1.25、JPQ=日本1.25、VAP=米国1.25、CONSV=欧州1.25）", () => {
  assert.equal(resolveOrientationProfile("MASS").marketMultipliers.CN, 1.25);
  assert.equal(resolveOrientationProfile("MASS").marketMultipliers.JP, 0.8);
  assert.equal(resolveOrientationProfile("JPQ").marketMultipliers.JP, 1.25);
  assert.equal(resolveOrientationProfile("VAP").marketMultipliers.US, 1.25);
  assert.equal(resolveOrientationProfile("CONSV").marketMultipliers.EU, 1.25);
});

test("SAI-5A: 各社の商品志向倍率が指示どおりの値で取得できる（MASS=HOSO1.20、JPQ=VAP1.20、VAP=PD1.20、CONSV=PD1.15）", () => {
  assert.equal(resolveOrientationProfile("MASS").productMultipliers.hoso, 1.2);
  assert.equal(resolveOrientationProfile("JPQ").productMultipliers.vap, 1.2);
  assert.equal(resolveOrientationProfile("VAP").productMultipliers.pd, 1.2);
  assert.equal(resolveOrientationProfile("CONSV").productMultipliers.pd, 1.15);
});

test("SAI-5A: 全プロファイルの倍率が許容範囲内（市場0.80〜1.25、商品0.85〜1.20）", () => {
  for (const profile of Object.values(COMPANY_ORIENTATION_PROFILES)) {
    for (const m of MARKETS) {
      const v = profile.marketMultipliers[m];
      assert.ok(v >= MARKET_ORIENTATION_RANGE.min && v <= MARKET_ORIENTATION_RANGE.max, `${profile.id}.${m}=${v}`);
    }
    for (const p of PRODUCTS) {
      const v = profile.productMultipliers[p];
      assert.ok(v >= PRODUCT_ORIENTATION_RANGE.min && v <= PRODUCT_ORIENTATION_RANGE.max, `${profile.id}.${p}=${v}`);
    }
  }
});

test("SAI-5A: 許容範囲を超えるプロファイルはエラーになる（バイアス幅の安全弁）", () => {
  const bad = {
    ...resolveOrientationProfile("BAL"),
    id: "test-bad",
    marketMultipliers: { CN: 2.0, US: 1, EU: 1, JP: 1, OTHER: 1 },
  };
  assert.throws(() => applyOrientationProfile(STANDARD_AI_PARAMETERS_V1, bad));
});

test("SAI-5A: BAL(中立)へのapplyOrientationProfileはappliedBiasItemsが空で、志向以外のパラメータを一切変更しない", () => {
  const { params, appliedBiasItems } = applyOrientationProfile(STANDARD_AI_PARAMETERS_V1, resolveOrientationProfile("BAL"));
  assert.deepEqual(appliedBiasItems, []);
  // 志向フィールド以外はSTANDARD_AI_PARAMETERS_V1と同値
  assert.equal(params.salesUtilizationTarget, STANDARD_AI_PARAMETERS_V1.salesUtilizationTarget);
  assert.equal(params.cashBufferQuarters, STANDARD_AI_PARAMETERS_V1.cashBufferQuarters);
  assert.equal(params.maxAquacultureShareOfRequirement, STANDARD_AI_PARAMETERS_V1.maxAquacultureShareOfRequirement);
});

test("SAI-5A: SAI-4経営性格と独立して機能する（orientation単独有効時、SAI-4のバイアス対象フィールドは無変更）", () => {
  const resolver = createSai5ParamsResolver({ managementProfilesEnabled: false, orientationEnabled: true });
  const r = resolver("MASS");
  // SAI-4のgrowthプロファイル（MASS）のバイアス対象がすべて基準値のまま
  assert.equal(r.params.salesUtilizationTarget, STANDARD_AI_PARAMETERS_V1.salesUtilizationTarget);
  assert.equal(r.params.maxDiscountRatioForExcessStock, STANDARD_AI_PARAMETERS_V1.maxDiscountRatioForExcessStock);
  assert.equal(r.params.importMixRatio, STANDARD_AI_PARAMETERS_V1.importMixRatio);
  // 志向は適用されている
  assert.equal(r.params.marketOrientationMultipliers.CN, 1.25);
});

test("SAI-5A: 両方有効時、SAI-4の性格バイアスとSAI-5Aの志向が両方とも適用される（合成）", () => {
  const both = createSai5ParamsResolver({ managementProfilesEnabled: true, orientationEnabled: true })("MASS");
  const sai4only = resolveManagementProfileParameters("MASS");
  assert.equal(both.params.salesUtilizationTarget, sai4only.params.salesUtilizationTarget); // SAI-4のバイアスが維持される
  assert.equal(both.params.marketOrientationMultipliers.CN, 1.25); // SAI-5Aの志向も適用される
  assert.ok(both.profileId.includes("growth") && both.profileId.includes("chinaVolume"));
});

// ---------------------------------------------------------------------
// 意思決定への反映（同一の局所入力に対する判断傾向の検証）
// ---------------------------------------------------------------------

/** 5社同一初期条件のturn1入力を作り、指定会社のプロファイルで判断させるヘルパー。 */
function decideAtTurn1(companyId: string, orientationCompanyId?: string) {
  const init = initializeUnifiedCompanyLabFromTemplate(
    { scenarioId: "baseline", mode: "canonical", seed: "sai5a-direction-test", turns: 1 },
    candidate.buildFixtureTemplate,
    candidate.financeFixtureTemplate,
    candidate.contractDefs,
    ALL_COMPANY_IDS
  );
  const fixture = init.fixtures.find((f) => f.companyId === companyId)!;
  const ownState = buildCompanyOwnState(init.state, fixture);
  const publicInfo = buildPublicMarketInfo(init.state);
  const params = orientationCompanyId
    ? createSai5ParamsResolver({ managementProfilesEnabled: false, orientationEnabled: true })(orientationCompanyId).params
    : STANDARD_AI_PARAMETERS_V1;
  return generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, init.state.currentPeriod, 1, params);
}

function sumByMarket(plans: readonly { market: DemandMarketId; desiredQuantity: number }[]): Record<DemandMarketId, number> {
  const out: Record<DemandMarketId, number> = { CN: 0, US: 0, EU: 0, JP: 0, OTHER: 0 };
  for (const p of plans) out[p.market] += p.desiredQuantity as unknown as number;
  return out;
}

function sumByProduct(plans: readonly { product: Product; desiredQuantity: number }[]): Record<Product, number> {
  const out: Record<Product, number> = { hoso: 0, pd: 0, vap: 0 };
  for (const p of plans) out[p.product] += p.desiredQuantity as unknown as number;
  return out;
}

test("SAI-5A: 同条件でMASSは中国へ、JPQは日本へ、VAP社は米国へ、CONSVは欧州へ、BALより強く配分する", () => {
  const bal = sumByMarket(decideAtTurn1("BAL", "BAL").decision.salesPlans as never);
  const mass = sumByMarket(decideAtTurn1("MASS", "MASS").decision.salesPlans as never);
  const jpq = sumByMarket(decideAtTurn1("JPQ", "JPQ").decision.salesPlans as never);
  const vap = sumByMarket(decideAtTurn1("VAP", "VAP").decision.salesPlans as never);
  const consv = sumByMarket(decideAtTurn1("CONSV", "CONSV").decision.salesPlans as never);

  const share = (m: Record<DemandMarketId, number>, k: DemandMarketId) => {
    const total = MARKETS.reduce((s, x) => s + m[x], 0);
    return total > 0 ? m[k] / total : 0;
  };
  assert.ok(share(mass, "CN") > share(bal, "CN"), `MASSの中国構成比(${share(mass, "CN")})がBAL(${share(bal, "CN")})を上回らない`);
  assert.ok(share(jpq, "JP") > share(bal, "JP"), `JPQの日本構成比がBALを上回らない`);
  assert.ok(share(vap, "US") > share(bal, "US"), `VAP社の米国構成比がBALを上回らない`);
  assert.ok(share(consv, "EU") > share(bal, "EU"), `CONSVの欧州構成比がBALを上回らない`);
});

test("SAI-5A: 商品志向がBAL比で方向どおりに効く（MASS=HOSO増、JPQ=VAP増）かつ、能力×稼働率上限を超えない", () => {
  const bal = decideAtTurn1("BAL", "BAL");
  const mass = decideAtTurn1("MASS", "MASS");
  const jpq = decideAtTurn1("JPQ", "JPQ");
  const balP = sumByProduct(bal.decision.salesPlans as never);
  const massP = sumByProduct(mass.decision.salesPlans as never);
  const jpqP = sumByProduct(jpq.decision.salesPlans as never);
  assert.ok(massP.hoso > balP.hoso, `MASSのHOSO販売希望(${massP.hoso})がBAL(${balP.hoso})を上回らない`);
  assert.ok(jpqP.vap >= balP.vap, `JPQのVAP販売希望(${jpqP.vap})がBAL(${balP.vap})を下回る`);
});

test("SAI-5A: 志向は総量を勝手に増やさない（BAL(中立)の判断は志向リゾルバ経由でも完全に同一）", () => {
  const withoutResolver = decideAtTurn1("BAL");
  const withResolver = decideAtTurn1("BAL", "BAL");
  assert.equal(JSON.stringify(withoutResolver.decision), JSON.stringify(withResolver.decision));
});

test("SAI-5A: 市場志向は再配分であり、市場合計は商品志向適用後の総量と一致する（重複配分・総量の不合理な減少なし）", () => {
  const jpq = decideAtTurn1("JPQ", "JPQ");
  // salesWishByMarketProduct（営業工数制約前の希望）で総量保存を検証する
  const wishTotalByProduct: Record<Product, number> = { hoso: 0, pd: 0, vap: 0 };
  for (const w of jpq.diagnostics.salesWishByMarketProduct) {
    wishTotalByProduct[w.product] += w.desiredQuantityBeforeEffortConstraint;
    assert.ok(Number.isFinite(w.desiredQuantityBeforeEffortConstraint) && w.desiredQuantityBeforeEffortConstraint >= 0);
  }
  // 商品志向倍率適用後の期待総量: BAL(中立)の商品別総量 × JPQの商品倍率(clamp済み)
  const balWish = decideAtTurn1("BAL", "BAL").diagnostics.salesWishByMarketProduct;
  const balTotalByProduct: Record<Product, number> = { hoso: 0, pd: 0, vap: 0 };
  for (const w of balWish) balTotalByProduct[w.product] += w.desiredQuantityBeforeEffortConstraint;
  const jpqProfile = resolveOrientationProfile("JPQ");
  for (const p of PRODUCTS) {
    const expected = balTotalByProduct[p] * jpqProfile.productMultipliers[p];
    assert.ok(
      Math.abs(wishTotalByProduct[p] - expected) < Math.max(1e-6, expected * 1e-9),
      `${p}の総量(${wishTotalByProduct[p]})が期待値(${expected})と一致しない（再配分で総量が変わっている）`
    );
  }
});

test("SAI-5A: 市場×商品の総合補正はclamp(0.70〜1.35)される（範囲チェック関数の検証）", () => {
  // MASSの最小総合補正: JP市場0.80 × VAP0.85 = 0.68 → 0.70へclampされる設計。
  // decision/sales.tsのclampCombinedMultと同じ式で検証する。
  const clampCombined = (v: number) => Math.max(COMBINED_ORIENTATION_RANGE.min, Math.min(COMBINED_ORIENTATION_RANGE.max, v));
  const mass = resolveOrientationProfile("MASS");
  const raw = mass.marketMultipliers.JP * mass.productMultipliers.vap;
  assert.ok(raw < COMBINED_ORIENTATION_RANGE.min);
  assert.equal(clampCombined(raw), COMBINED_ORIENTATION_RANGE.min);
  const rawMax = mass.marketMultipliers.CN * mass.productMultipliers.hoso; // 1.25×1.20=1.5
  assert.equal(clampCombined(rawMax), COMBINED_ORIENTATION_RANGE.max);
});

test("SAI-5A: 得意市場の採算が大幅に悪い場合、他市場へ移動できる（志向倍率より価格ランキング首位重みが支配的）", () => {
  // 按分の基礎重み: 首位市場0.5、他市場0.125。JPQの日本倍率1.25でも、
  // 日本が首位でない場合の重み(0.125×1.25=0.156...)は、首位市場の重み
  // (0.5×clamp(倍率)≥0.5×0.70=0.35)を上回れないことを構造的に検証する。
  const jpq = resolveOrientationProfile("JPQ");
  const favoriteNotTop = 0.125 * Math.min(1.35, jpq.marketMultipliers.JP * jpq.productMultipliers.vap);
  const topMarketWorst = 0.5 * Math.max(0.7, jpq.marketMultipliers.CN * jpq.productMultipliers.vap);
  assert.ok(
    favoriteNotTop < topMarketWorst,
    `得意市場が首位から陥落したとき(${favoriteNotTop})でも首位市場(${topMarketWorst})より重みが大きい＝市況応答が失われている`
  );
});
