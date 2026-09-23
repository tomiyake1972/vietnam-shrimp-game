// ShrimpX V2 — 販売計画・営業人員・成約・約定残モジュール 四半期ランナー（Phase 4）
//
// Phase3のシミュレーションランナー（app/lib/v2/industryLab/simulationRunner.ts）
// と同じ構造（initializeX / advanceX / 複数四半期テスト用ランナー）を踏襲する。
// advanceSalesQuarterは「販売計画→成約配分→契約生成」までしか行わない。
// 履行実績の適用（backlog.tsのapplyFulfillments）・四半期末状態更新
// （updateContractStatusesForQuarterEnd）は、Phase6から渡される実際の生産・
// 出荷実績をもとに呼び出し側が明示的に行う別ステップとする（自動的に生産・
// 出荷したことにはしない、という実装指示に対応）。

import { nextPeriod, PeriodV2 } from "../core/period";
import { DEMAND_MARKET_IDS, DemandMarketId, Product } from "../market/types";
import {
  CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTS,
  DestinationMarketPriceCoefficientTable,
} from "../market/destinationPricingParameters";
import { allocateMarketProduct } from "./allocation";
import { createContractsFromAllocation, resolveDueDateForPlanEntry } from "./contracts";
import { applyCrowdingLayer, CrowdingLayerResult } from "./crowdingLayer";
import { deriveTargetDemand, deriveVietnamMarketReferencePrices } from "./marketAdapter";
import { applyMarketSalesEffortCapacity } from "./marketEffort";
import { SALES_PARAMETERS_V1, SalesParameters } from "./parameters";
import { SalesQuarterInput, SalesQuarterRecord, SalesState } from "./types";
import { UsdPerHosoEqKg, usdPerHosoEqKg } from "../core/units";

/**
 * 【ENG-CROWDING-MARKDOWN-1】advanceSalesQuarter の戻り値（診断つき）。
 * Crowding 診断は **永続化しない**。この戻り値としてのみ返す
 * （sales/tieredAllocation.ts の TieredAllocationDiagnostics と同じ方針）。
 */
export interface AdvanceSalesQuarterResult {
  readonly state: SalesState;
  /** input.crowding を渡したときのみ設定される。 */
  readonly crowding?: CrowdingLayerResult;
}

const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

/** 空の販売状態を作る（契約・履歴なし）。 */
export function initializeSalesState(startPeriod: PeriodV2): SalesState {
  return {
    currentPeriod: startPeriod,
    contracts: [],
    history: [],
  };
}

/**
 * 1四半期分の「販売計画→成約配分→契約生成」を行い、新しい SalesState を返す
 * （入力stateは変更しない）。市場×商品区分の全組み合わせ（5市場×3商品=15通り）
 * について配分を計算する（該当する販売計画が無い組み合わせは対象需要0として
 * スキップする）。
 */
export function advanceSalesQuarterWithDiagnostics(
  state: SalesState,
  input: SalesQuarterInput,
  params: SalesParameters = SALES_PARAMETERS_V1,
  destinationMarketPriceCoefficients: DestinationMarketPriceCoefficientTable = CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTS
): AdvanceSalesQuarterResult {
  const period = state.currentPeriod;
  // 【Phase 8P-0A】成約配分の基準価格(basePrice)は、商品区分のみ（市場非依存）
  // だった deriveVietnamBasePrices から、商品×仕向市場ごとの参照価格
  // （deriveVietnamMarketReferencePrices）へ置き換える。中立係数（全市場係数=1.0）
  // では両者は完全に一致する（market/__tests__/destinationPricing.test.ts・
  // sales/__tests__/runner.test.ts で検証）。
  const marketReferencePrices = deriveVietnamMarketReferencePrices(input.marketResult, destinationMarketPriceCoefficients);
  const targetDemandByMarketProduct = deriveTargetDemand(input.marketResult, input.marketInput, input.marketWeights, input.marketProductMix);

  // 【SAI-2追加作業: 市場別営業配置・商品別営業工数】成約配分(allocateMarketProduct)を
  // 商品ごとに独立実行する前に、会社×市場で共有される営業人員から導かれる
  // 営業工数換算能力の制約を一括で適用する（唯一の適用箇所。allocation.ts側の
  // 既存の行単位capacity上限は、適用後の入力に対して数学的に非拘束となるため、
  // 二重適用にはならない。詳細はsales/marketEffort.tsのコメント参照）。
  const {
    adjustedPlans,
    adjustments: salesEffortAdjustments,
    capacityByCompanyMarket,
  } = applyMarketSalesEffortCapacity(input.plans, params);

  // 【ENG-CROWDING-MARKDOWN-1】Crowding 共通 market-clearing 層。
  // legacy / tiered の **前段**に置く共通層であり、どちらの allocation mode でも
  //   構造価格 → crowding clearing price → allocation
  // の順序を通る（§12）。input.crowding が未指定なら層自体を呼ばないため、
  // 既存挙動はビット単位で不変（CRWD-14）。
  //
  // 価格階層（§10 の必須順序）:
  //   1. preCrowdingStructuralPrice = marketReferencePrices（既存 SSoT。書き換えない）
  //   2. crowdingMultiplier
  //   3. postCrowdingClearingPrice = 1 × 2  ← allocation の basePrice へ渡す
  //   4. company ask = 3 + priceAdjustmentUsdPerHosoEqKg（allocation 側の既存処理）
  let crowding: CrowdingLayerResult | undefined;
  let clearingPrices: Readonly<Record<DemandMarketId, Readonly<Record<Product, number>>>> | undefined;
  if (input.crowding) {
    crowding = applyCrowdingLayer({
      period,
      policy: input.crowding.policy,
      adjustedPlans,
      existingContracts: input.crowding.existingContracts ?? state.contracts,
      physicalSupplies: input.crowding.physicalSupplies,
      preCrowdingStructuralPrices: marketReferencePrices as unknown as Readonly<
        Record<DemandMarketId, Readonly<Record<Product, number>>>
      >,
      forwardDemandProxyByMarketProduct: targetDemandByMarketProduct as unknown as Readonly<
        Record<DemandMarketId, Readonly<Record<Product, number>>>
      >,
      resolveDueDateForPlan: (entry, p) => resolveDueDateForPlanEntry(entry, p, params),
    });
    clearingPrices = crowding.clearingPrices;
  }

  const basePriceFor = (market: DemandMarketId, product: Product): UsdPerHosoEqKg =>
    clearingPrices === undefined
      ? marketReferencePrices[market][product]
      : (usdPerHosoEqKg(clearingPrices[market][product]) as UsdPerHosoEqKg);

  const combos: Array<{ market: DemandMarketId; product: Product }> = [];
  for (const market of DEMAND_MARKET_IDS) {
    for (const product of PRODUCTS) {
      combos.push({ market, product });
    }
  }

  const allocations = combos
    .filter(({ market, product }) => adjustedPlans.some((p) => p.market === market && p.product === product))
    .map(({ market, product }) =>
      allocateMarketProduct(
        market,
        product,
        period,
        adjustedPlans,
        basePriceFor(market, product),
        targetDemandByMarketProduct[market][product],
        params,
        capacityByCompanyMarket
      )
    );

  const newContracts = createContractsFromAllocation(allocations, adjustedPlans, params);

  const record: SalesQuarterRecord = { period, allocations, newContracts, salesEffortAdjustments };

  return {
    state: {
      currentPeriod: nextPeriod(period),
      contracts: [...state.contracts, ...newContracts],
      history: [...state.history, record],
    },
    crowding,
  };
}

/**
 * 既存シグネチャ互換のラッパー（SalesState だけを返す）。
 * 既存の全呼び出し側はこちらを使い続けるため、挙動は一切変わらない。
 */
export function advanceSalesQuarter(
  state: SalesState,
  input: SalesQuarterInput,
  params: SalesParameters = SALES_PARAMETERS_V1,
  destinationMarketPriceCoefficients: DestinationMarketPriceCoefficientTable = CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTS
): SalesState {
  return advanceSalesQuarterWithDiagnostics(state, input, params, destinationMarketPriceCoefficients).state;
}

/**
 * 複数四半期を再現可能に実行するテスト用ランナー。各要素が1四半期分の
 * SalesQuarterInput となる配列を、そのまま順にadvanceSalesQuarterへ渡す。
 * （履行実績の適用は含まない。テストで別途 backlog.ts の関数を呼ぶこと。）
 */
export function runSalesQuartersForTesting(
  startPeriod: PeriodV2,
  quarterInputs: readonly SalesQuarterInput[],
  params: SalesParameters = SALES_PARAMETERS_V1,
  destinationMarketPriceCoefficients: DestinationMarketPriceCoefficientTable = CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTS
): SalesState {
  let state = initializeSalesState(startPeriod);
  for (const input of quarterInputs) {
    state = advanceSalesQuarter(state, input, params, destinationMarketPriceCoefficients);
  }
  return state;
}
