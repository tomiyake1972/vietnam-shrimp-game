// ShrimpX V2 — Company Lab / Test15 期初情報ビューモデルのテスト
//
// turn1（四半期処理を1度も行っていない状態）でも、BS・償却資産明細・市場情報が
// 必ず値を持つこと、およびそれらの値が実際のゲーム状態・エンジンパラメータと
// 一致することを検証する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../../../../lib/v2/companyLab/runner";
import { getScenarioTurnInput } from "../../../../../lib/v2/scenario/scenarioEngine";
import { DEMAND_MARKET_IDS } from "../../../../../lib/v2/market/types";
import { MARKET_PARAMETERS_V1 } from "../../../../../lib/v2/market/parameters";
import { PRODUCT_LIFECYCLE_PARAMETERS_V1 } from "../../../../../lib/v2/market/productLifecycle";
import { SALES_PARAMETERS_V1 } from "../../../../../lib/v2/sales/parameters";
import { FINANCE_PARAMETERS_V1 } from "../../../../../lib/v2/finance/parameters";
import { unwrapUnit } from "../../../../../lib/v2/core/units";
import { buildDepreciableAssets, buildOpeningBalanceSheet, buildOpeningMarketInfo } from "../openingInfoViewModel";

const CONFIG = { scenarioId: "baseline" as const, mode: "canonical" as const, seed: "opening-info-test-001", turns: 8 };

function setupTurn1() {
  const { state, fixtures } = initializeCompanyLab(CONFIG);
  const fixture = fixtures.find((f) => f.companyId === "BAL")!;
  const ownState = buildCompanyOwnState(state, fixture);
  const publicInfo = buildPublicMarketInfo(state);
  return { state, fixtures, fixture, ownState, publicInfo };
}

test("期初BS: turn1（四半期処理前）でもBSが組み立てられ、貸借が一致する", () => {
  const { ownState } = setupTurn1();
  const bs = buildOpeningBalanceSheet(ownState);

  assert.ok(bs.assets.length > 0, "資産の行がある");
  assert.ok(bs.liabilities.length > 0, "負債の行がある");
  assert.ok(bs.equity.length > 0, "純資産の行がある");
  assert.ok(bs.totalAssets > 0, "turn1でも総資産が0より大きい");
  // 貸借一致（財務エンジンと同じ許容誤差を使う）。
  assert.ok(
    Math.abs(bs.balanceDifference) <= FINANCE_PARAMETERS_V1.epsilonUsd,
    `貸借差額が許容誤差内であること（実際: ${bs.balanceDifference}）`
  );
});

test("期初BS: 各項目の値が CompanyFinanceState と一致する", () => {
  const { ownState } = setupTurn1();
  const bs = buildOpeningBalanceSheet(ownState);
  const f = ownState.financeState;

  const valueOf = (label: string): number | undefined =>
    [...bs.assets, ...bs.liabilities, ...bs.equity].find((r) => r.label.startsWith(label))?.value;

  assert.equal(valueOf("現金"), Number(f.cash), "現金がgame stateと一致");
  assert.equal(valueOf("その他流動資産"), Number(f.otherCurrentAssets), "その他流動資産が一致");
  assert.equal(valueOf("固定資産 取得原価"), Number(f.fixedAssetsGross), "固定資産取得原価が一致");
  assert.equal(valueOf("短期借入金"), Number(f.shortTermLoans), "短期借入金が一致");
  assert.equal(valueOf("長期借入金"), Number(f.longTermLoans), "長期借入金が一致");
  assert.equal(valueOf("その他負債"), Number(f.otherLiabilities), "その他負債が一致");
  assert.equal(valueOf("資本金"), Number(f.capitalStock), "資本金が一致");
  assert.equal(valueOf("利益剰余金"), Number(f.retainedEarnings), "利益剰余金が一致");
  assert.equal(
    valueOf("売掛金"),
    f.receivables.reduce((s, r) => s + Number(r.amount), 0),
    "売掛金が売掛レコード合計と一致"
  );
  assert.equal(bs.totalEquity, Number(f.capitalStock) + Number(f.retainedEarnings), "純資産合計が一致");
});

test("期初BS: D/Eは有利子負債÷純資産。純資産が0以下ならundefined（Infinityにしない）", () => {
  const { ownState } = setupTurn1();
  const bs = buildOpeningBalanceSheet(ownState);
  const f = ownState.financeState;
  const expected = (Number(f.shortTermLoans) + Number(f.longTermLoans)) / bs.totalEquity;
  assert.ok(bs.debtEquityRatio !== undefined, "純資産が正なのでD/Eが算出される");
  assert.ok(Math.abs(bs.debtEquityRatio! - expected) < 1e-9, "D/Eが有利子負債÷純資産と一致");

  const zeroEquityState = {
    ...ownState,
    financeState: { ...f, capitalStock: 0 as never, retainedEarnings: 0 as never },
  };
  const zeroBs = buildOpeningBalanceSheet(zeroEquityState);
  assert.equal(zeroBs.debtEquityRatio, undefined, "純資産0のときD/Eはundefined（Infinityを表示しない）");
});

test("償却資産明細: turn1でも行が出て、簿価合計がBSの固定資産純額＋建設中勘定と論理整合する", () => {
  const { ownState } = setupTurn1();
  const assets = buildDepreciableAssets(ownState, 1);
  const bs = buildOpeningBalanceSheet(ownState);

  assert.ok(assets.rows.length >= 2, "少なくとも建物・機械の2区分が出る");
  assert.ok(
    Math.abs(assets.reconciliationDifference) <= FINANCE_PARAMETERS_V1.epsilonUsd,
    `明細の簿価合計とBS側が一致すること（差額: ${assets.reconciliationDifference}）`
  );
  const fixedAssetsNet = bs.assets.find((r) => r.label.startsWith("固定資産 純額"))!.value!;
  const cip = bs.assets.find((r) => r.label.startsWith("建設中勘定"))!.value!;
  assert.ok(
    Math.abs(assets.balanceSheetFixedAssetsNetPlusCip - (fixedAssetsNet + cip)) <= FINANCE_PARAMETERS_V1.epsilonUsd,
    "BS側の参照値が固定資産純額＋建設中勘定と一致"
  );
});

test("償却資産明細: 建物・機械の按分と残存年数が finance/parameters.ts と一致する", () => {
  const { ownState } = setupTurn1();
  const assets = buildDepreciableAssets(ownState, 1);
  const cfg = FINANCE_PARAMETERS_V1.finance.existingAssetDepreciation;
  const gross = Number(ownState.financeState.fixedAssetsGross);

  const building = assets.rows.find((r) => r.category.startsWith("建物"))!;
  const machinery = assets.rows.find((r) => r.category.startsWith("機械"))!;

  assert.ok(Math.abs(building.grossBookValue! - gross * cfg.buildingOpeningRatio) < 1e-6, "建物の取得原価按分がパラメータと一致");
  assert.ok(Math.abs(machinery.grossBookValue! - gross * cfg.machineryOpeningRatio) < 1e-6, "機械の取得原価按分がパラメータと一致");
  assert.equal(building.remainingLifeQuarters, cfg.buildingRemainingLifeQuartersAtGameStart, "turn1の建物残存年数が初期値と一致");
  assert.equal(machinery.remainingLifeQuarters, cfg.machineryRemainingLifeQuartersAtGameStart, "turn1の機械残存年数が初期値と一致");
  assert.equal(building.status, "稼働中");
  assert.equal(machinery.status, "稼働中");
});

test("期初市場情報: turn1でも原料・販売市場の情報が出て、値がエンジンのパラメータと一致する", () => {
  const { state, publicInfo } = setupTurn1();

  const priorByMarket: Record<string, { priorPeriodConsumption: number; economicIndex: number; populationGrowthRate: number }> = {};
  const scenarioTurnInput = getScenarioTurnInput(state.scenarioState, 1);
  for (const market of DEMAND_MARKET_IDS) {
    const m = scenarioTurnInput.demandMarkets[market];
    priorByMarket[market] = {
      priorPeriodConsumption: unwrapUnit(m.priorPeriodConsumption),
      economicIndex: m.economicIndex,
      populationGrowthRate: m.populationGrowthRate,
    };
  }

  const info = buildOpeningMarketInfo(publicInfo.vietnamDomesticPriorPrice, priorByMarket);

  // --- 原料市場 ---
  assert.equal(info.rawMaterial.vietnamDomesticPriorPrice, publicInfo.vietnamDomesticPriorPrice, "国内原料価格がpublicInfoと一致");
  const farmer = MARKET_PARAMETERS_V1.vietnamDomestic.farmerEconomicsDefaults;
  assert.equal(info.rawMaterial.farmerReservationPrice.farmingCost, farmer.farmingCostUsdPerHosoEqKg, "養殖原価がパラメータと一致");
  assert.ok(
    Math.abs(
      info.rawMaterial.farmerReservationPrice.total -
        (farmer.farmingCostUsdPerHosoEqKg + farmer.diseaseRiskAllowanceUsdPerHosoEqKg + farmer.minimumFarmerMarginUsdPerHosoEqKg)
    ) < 1e-9,
    "留保価格合計が構成要素の和と一致"
  );
  assert.deepEqual(
    info.rawMaterial.initialHosoFobPriceByCountry,
    MARKET_PARAMETERS_V1.initialHosoFobPriceUsdPerKg,
    "産地FOB初期価格がパラメータと一致"
  );

  // --- 販売市場 ---
  assert.equal(info.salesMarkets.length, DEMAND_MARKET_IDS.length, "5市場すべてが出る");
  for (const row of info.salesMarkets) {
    const lc = PRODUCT_LIFECYCLE_PARAMETERS_V1.byMarket[row.market];
    assert.equal(row.initialShareByProduct.pd, lc.pd.initialShare, `${row.market}のPD初期構成比が一致`);
    assert.equal(row.initialShareByProduct.vap, lc.vap.initialShare, `${row.market}のVAP初期構成比が一致`);
    assert.equal(row.matureShareByProduct.pd, lc.pd.matureShare, `${row.market}のPD成熟構成比が一致`);
    assert.ok(
      Math.abs(row.initialShareByProduct.hoso + row.initialShareByProduct.pd + row.initialShareByProduct.vap - 1) < 1e-9,
      `${row.market}の初期構成比の合計が1`
    );
    assert.ok(row.priorPeriodConsumption !== undefined && row.priorPeriodConsumption > 0, `${row.market}の前期消費量が取得できる`);
    assert.ok(row.displayName.length > 0 && row.characteristics.length > 0, `${row.market}の表示名・市場特性がある`);
  }

  // --- 需要ウェイト・営業工数 ---
  assert.deepEqual(info.competitivenessWeights, { ...SALES_PARAMETERS_V1.competitivenessWeights }, "需要ウェイトがsales/parameters.tsと一致");
  assert.equal(info.maximumSupplierShare, SALES_PARAMETERS_V1.maximumSupplierShare, "最大成約シェアが一致");
  assert.equal(info.externalOptionWeight, SALES_PARAMETERS_V1.externalOptionWeight, "外部選択肢ウェイトが一致");
  assert.deepEqual(info.salesEffortCoefficients, { ...SALES_PARAMETERS_V1.salesEffortCoefficients }, "営業工数係数が一致");

  // --- 参考価格 ---
  const premium = MARKET_PARAMETERS_V1.pdVapPremium;
  assert.ok(info.referencePriceByProduct.hoso > 0, "HOSO参考価格が正の値");
  assert.ok(
    Math.abs(info.referencePriceByProduct.pd - info.referencePriceByProduct.hoso * (1 + premium.pdBasePremiumRatio)) < 1e-9,
    "PD参考価格がHOSO×(1+PDプレミアム率)と一致"
  );
  assert.ok(
    Math.abs(info.referencePriceByProduct.vap - info.referencePriceByProduct.hoso * (1 + premium.vapBasePremiumRatio)) < 1e-9,
    "VAP参考価格がHOSO×(1+VAPプレミアム率)と一致"
  );
});

test("期初市場情報: シナリオ由来の値が取れない場合でも例外を投げず、該当項目だけundefinedになる（0で埋めない）", () => {
  const { publicInfo } = setupTurn1();
  const info = buildOpeningMarketInfo(publicInfo.vietnamDomesticPriorPrice);
  assert.equal(info.salesMarkets.length, DEMAND_MARKET_IDS.length, "市場行自体は必ず出る");
  for (const row of info.salesMarkets) {
    assert.equal(row.priorPeriodConsumption, undefined, "前期消費量はundefined（0で埋めない）");
    assert.equal(row.economicIndex, undefined, "景気指数はundefined");
    // パラメータ由来の情報は取得元が別なので必ず出る。
    assert.ok(row.initialShareByProduct.pd >= 0, "商品構成比はパラメータ由来なので必ず出る");
  }
});
