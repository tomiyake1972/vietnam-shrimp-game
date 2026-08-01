// ShrimpX V2 — 工場・ワーカー・生産モジュール 四半期ランナー（Phase 6）
//
// Phase5のrunner.ts（app/lib/v2/rawMaterials/runner.ts）と同じ構造
// （initializeX / advanceX / 複数四半期テスト用ランナー）を踏襲する。
// advanceProductionQuarterは次を1四半期分まとめて行う。
//   生産計画の制約配分 → 原料在庫のFIFO消費・生産バッチ生成 →
//   完成品ロット生成 → 完成品の契約充当計画 → 完成品の期限切れ処理 →
//   PD/VAP供給シグナル集計 → 操業負荷指標集計
//
// 契約への実際の適用（applyFulfillments呼び出し）・完成品ロットの実消費
// （consumeFinishedGoods呼び出し）は、Phase5のconsumeRawMaterialsと同様、
// advanceProductionQuarter自身は行わない別ステップとする（呼び出し側が
// fulfillmentPlanを見て明示的に呼ぶ設計。sales/index.tsの既存コメントと
// 同じ「実際の反映は呼び出し側の責務」という規約を踏襲する）。
//
// Phase5のターン・オーケストレーター（app/lib/v2/turn/runner.ts）へは、本Phaseでは
// 接続しない（既存オーケストレーターの公開契約を書き換えない、という実装指示に
// 従う）。本ランナーはturn/を一切importしない、完全に独立したモジュールである。

import { nextPeriod, PeriodV2 } from "../core/period";
import { RawMaterialLot } from "../rawMaterials/types";
import { allocateProductionPlans } from "./allocation";
import { buildProductionBatches } from "./batches";
import { applyFinishedGoodsExpiryForQuarterEnd, createFinishedGoodsLots } from "./finishedGoods";
import { planContractFulfillment } from "./fulfillment";
import { calculateAllFactoryLoadMetrics, calculateCompanyLoadMetrics, RawMaterialLotOrigin } from "./loadMetrics";
import { PRODUCTION_PARAMETERS_V1, ProductionParameters } from "./parameters";
import { aggregateProductionSupplySignals } from "./supplySignal";
import { SalesContract } from "../sales/types";
import { Product } from "../market/types";
import {
  ProductionQuarterInput,
  ProductionQuarterRecord,
  ProductionState,
  ProductionSupplySignalInput,
} from "./types";

const SUPPLY_SIGNAL_PRODUCTS: readonly Extract<Product, "pd" | "vap">[] = ["pd", "vap"];

/** 空の生産状態を作る（完成品ロット・履歴なし）。 */
export function initializeProductionState(startPeriod: PeriodV2): ProductionState {
  return { currentPeriod: startPeriod, finishedGoodsLots: [], history: [] };
}

/**
 * 1四半期分の生産処理を行い、新しい ProductionState を返す（入力stateは変更しない）。
 * rawMaterialLots は呼び出し側（Phase5のRawMaterialsState.lots）が渡す当期時点の
 * 原料在庫であり、本関数は消費後の新しい原料ロット配列も併せて返す
 * （ProductionStateには原料在庫を持たせず、Phase5側の状態がそのまま真実の情報源
 * であり続けるようにするため）。
 */
export function advanceProductionQuarter(
  state: ProductionState,
  input: ProductionQuarterInput,
  contracts: readonly SalesContract[],
  rawMaterialLots: readonly RawMaterialLot[],
  supplySignals: readonly ProductionSupplySignalInput[] = [],
  params: ProductionParameters = PRODUCTION_PARAMETERS_V1
): { readonly state: ProductionState; readonly updatedRawMaterialLots: readonly RawMaterialLot[] } {
  const period = state.currentPeriod;

  const allocation = allocateProductionPlans(
    input.plans,
    input.factories,
    input.workerAssignments,
    rawMaterialLots,
    period,
    params,
    input.pdCoefficientOverrideByFactoryId
  );

  const { batches, updatedRawMaterialLots } = buildProductionBatches(input.plans, allocation.entries, rawMaterialLots, period, params);

  const newFinishedGoodsLots = createFinishedGoodsLots(batches, params);
  const lotsAfterProduction = [...state.finishedGoodsLots, ...newFinishedGoodsLots];

  const fulfillmentPlan = planContractFulfillment(contracts, lotsAfterProduction);

  const lotsAfterExpiry = applyFinishedGoodsExpiryForQuarterEnd(lotsAfterProduction, period);
  const expiredFinishedGoodsLots = lotsAfterExpiry.filter(
    (lot) => lot.status === "expired" && !state.finishedGoodsLots.some((prior) => prior.lotId === lot.lotId && prior.status === "expired")
  );

  const countryProductionSignals = SUPPLY_SIGNAL_PRODUCTS.flatMap((product) =>
    aggregateProductionSupplySignals(supplySignals, input.companyCountry, product)
  );

  const rawMaterialLotOrigins: RawMaterialLotOrigin[] = rawMaterialLots.map((l) => ({ lotId: l.lotId, inboundPeriod: l.inboundPeriod }));
  const factoryLoadMetrics = calculateAllFactoryLoadMetrics(input.factories, allocation.entries, batches, rawMaterialLotOrigins, period);
  const companyLoadMetrics = calculateCompanyLoadMetrics(factoryLoadMetrics, batches);

  const record: ProductionQuarterRecord = {
    period,
    allocation,
    batches,
    newFinishedGoodsLots,
    expiredFinishedGoodsLots,
    fulfillmentPlan,
    supplySignals: countryProductionSignals,
    factoryLoadMetrics,
    companyLoadMetrics,
  };

  return {
    state: {
      currentPeriod: nextPeriod(period),
      finishedGoodsLots: lotsAfterExpiry,
      history: [...state.history, record],
    },
    updatedRawMaterialLots,
  };
}

export interface ProductionQuarterTestInput {
  readonly input: ProductionQuarterInput;
  readonly contracts: readonly SalesContract[];
  readonly rawMaterialLots: readonly RawMaterialLot[];
  readonly supplySignals?: readonly ProductionSupplySignalInput[];
}

/**
 * 複数四半期を再現可能に実行するテスト用ランナー。各要素の rawMaterialLots は
 * 呼び出し側（テスト側）が前四半期の updatedRawMaterialLots を引き継いで渡す
 * 想定（Phase5のRawMaterialsStateとの結合は呼び出し側の責務のまま）。
 */
export function runProductionQuartersForTesting(
  startPeriod: PeriodV2,
  quarterInputs: readonly ProductionQuarterTestInput[],
  params: ProductionParameters = PRODUCTION_PARAMETERS_V1
): { readonly state: ProductionState; readonly finalRawMaterialLots: readonly RawMaterialLot[] } {
  let state = initializeProductionState(startPeriod);
  let finalRawMaterialLots: readonly RawMaterialLot[] = [];
  for (const { input, contracts, rawMaterialLots, supplySignals } of quarterInputs) {
    const result = advanceProductionQuarter(state, input, contracts, rawMaterialLots, supplySignals ?? [], params);
    state = result.state;
    finalRawMaterialLots = result.updatedRawMaterialLots;
  }
  return { state, finalRawMaterialLots };
}
