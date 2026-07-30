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
import { createContractsFromAllocation } from "./contracts";
import { deriveTargetDemand, deriveVietnamMarketReferencePrices } from "./marketAdapter";
import { applyMarketSalesEffortCapacity } from "./marketEffort";
import { SALES_PARAMETERS_V1, SalesParameters } from "./parameters";
import { SalesQuarterInput, SalesQuarterRecord, SalesState } from "./types";

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
export function advanceSalesQuarter(
  state: SalesState,
  input: SalesQuarterInput,
  params: SalesParameters = SALES_PARAMETERS_V1,
  destinationMarketPriceCoefficients: DestinationMarketPriceCoefficientTable = CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTS
): SalesState {
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
  const { adjustedPlans, adjustments: salesEffortAdjustments } = applyMarketSalesEffortCapacity(input.plans, params);

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
        marketReferencePrices[market][product],
        targetDemandByMarketProduct[market][product],
        params
      )
    );

  const newContracts = createContractsFromAllocation(allocations, adjustedPlans, params);

  const record: SalesQuarterRecord = { period, allocations, newContracts, salesEffortAdjustments };

  return {
    currentPeriod: nextPeriod(period),
    contracts: [...state.contracts, ...newContracts],
    history: [...state.history, record],
  };
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
