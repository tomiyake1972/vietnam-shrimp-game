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
import { applyCrowdingLayer, CrowdingLayerResult, findCrowdingBucket } from "./crowdingLayer";
import { deriveTargetDemand, deriveVietnamMarketReferencePrices } from "./marketAdapter";
import { applyMarketSalesEffortCapacity } from "./marketEffort";
import { SALES_PARAMETERS_V1, SalesParameters } from "./parameters";
import {
  CompanySalesPlanEntry,
  MarketProductAllocationResult,
  SalesQuarterInput,
  SalesQuarterRecord,
  SalesState,
  SalesValidationError,
} from "./types";

/** 【X\'方式】turn 内だけで使う納期別 allocation（永続化しない）。 */
export interface DueDateBucketAllocation {
  readonly dueDate: PeriodV2;
  readonly result: MarketProductAllocationResult;
}
import { UsdPerHosoEqKg, hosoEqTons, usdPerHosoEqKg } from "../core/units";

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

  // 【ENG-CROWDING-MARKDOWN-1 / 1B・X'方式】Crowding 共通 market-clearing 層。
  // legacy / tiered の **前段**に置く共通層であり、どちらの allocation mode でも
  //   構造価格 → crowding clearing price → allocation
  // の順序を通る（§12）。input.crowding が未指定なら層自体を呼ばないため、
  // 既存挙動はビット単位で不変（CRWD-14）。
  //
  // 価格階層（§10 の必須順序）:
  //   1. preCrowdingStructuralPrice = marketReferencePrices（既存 SSoT。書き換えない）
  //   2. bucket 固有 crowdingMultiplier
  //   3. bucket 固有 postCrowdingClearingPrice  ← その bucket の allocation の basePrice
  //   4. company ask = 3 + priceAdjustmentUsdPerHosoEqKg（allocation 側の既存処理）
  let crowding: CrowdingLayerResult | undefined;
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
  }

  let allocations: readonly MarketProductAllocationResult[];
  let bucketAllocations: readonly DueDateBucketAllocation[] | undefined;

  if (crowding === undefined) {
    // --- 既存経路（Crowding OFF）。1行も変えない ---
    const combos: Array<{ market: DemandMarketId; product: Product }> = [];
    for (const market of DEMAND_MARKET_IDS) {
      for (const product of PRODUCTS) {
        combos.push({ market, product });
      }
    }
    allocations = combos
      .filter(({ market, product }) => adjustedPlans.some((p) => p.market === market && p.product === product))
      .map(({ market, product }) =>
        allocateMarketProduct(
          market,
          product,
          period,
          adjustedPlans,
          marketReferencePrices[market][product],
          targetDemandByMarketProduct[market][product],
          params,
          capacityByCompanyMarket
        )
      );
  } else {
    // --- X'方式: 市場 × 商品 × 納期 ごとに独立して既存 allocator を呼ぶ ---
    //
    // 【なぜ納期ごとに分けるか】異なる dueDate は異なる四半期の需要である。
    // CN VAP T+1 と CN VAP T+3 は同一 targetDemand を分け合う1つの需要枠ではない
    // （ENG-CROWDING-MARKDOWN-1B §1 の仕様判断）。したがって bucket ごとに
    // その納期向けの forwardDemandProxy を独立して与えてよく、
    // T+1 の混雑が T+3 の ratio / multiplier / clearing price / allocation へ
    // 影響してはならない（§2）。
    //
    // 【なぜ既存 allocator をそのまま呼べるか】allocateMarketProduct は
    // entries を market / product で絞り込むだけで納期を見ないため、
    // 「その bucket の plan だけ」を渡せば bucket 内の競争として正しく解ける。
    // legacy / tiered の分岐も allocateMarketProduct 内部にあるため、
    // Crowding 用の別実装を作る必要がない（§3）。
    const groups = new Map<string, { market: DemandMarketId; product: Product; dueDate: PeriodV2; plans: CompanySalesPlanEntry[] }>();
    for (const entry of adjustedPlans) {
      const dueDate = resolveDueDateForPlanEntry(entry, period, params);
      const key = `${entry.market}::${entry.product}::${dueDate}`;
      const g = groups.get(key);
      if (g) g.plans.push(entry);
      else groups.set(key, { market: entry.market, product: entry.product, dueDate, plans: [entry] });
    }

    // 【順序】既存経路（Crowding OFF）と同じ並び順を保つ。
    // 旧来は DEMAND_MARKET_IDS × PRODUCTS の順に allocation を作っており、
    // SalesQuarterRecord.allocations も newContracts もこの順で並ぶ。
    // 納期 bucket を挟んでも、市場 → 商品 → 納期 の順に並べれば
    // 全社同一納期のとき配列の並びまで従来と完全一致する（DUE-7 / CRWD-14）。
    const marketOrder = new Map(DEMAND_MARKET_IDS.map((m, i) => [m, i]));
    const productOrder = new Map(PRODUCTS.map((p, i) => [p, i]));
    const orderedKeys = [...groups.keys()].sort((ka, kb) => {
      const a = groups.get(ka)!;
      const b = groups.get(kb)!;
      const dm = marketOrder.get(a.market)! - marketOrder.get(b.market)!;
      if (dm !== 0) return dm;
      const dp = productOrder.get(a.product)! - productOrder.get(b.product)!;
      if (dp !== 0) return dp;
      return a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0;
    });
    bucketAllocations = orderedKeys.map((key) => {
      const g = groups.get(key)!;
      const bucket = findCrowdingBucket(crowding!, g.market, g.product, g.dueDate);
      // bucket は credibleOffers から作られるため、plan がある組には必ず存在する。
      if (!bucket) {
        throw new Error(`Crowding bucket がありません: ${g.market}/${g.product}/${g.dueDate}`);
      }
      return {
        dueDate: g.dueDate,
        result: allocateMarketProduct(
          g.market,
          g.product,
          period,
          g.plans,
          usdPerHosoEqKg(bucket.postCrowdingClearingPrice) as UsdPerHosoEqKg,
          // bucket 固有の対象需要。§1 のとおり「別四半期の需要をそれぞれ
          // 当期構造需要で近似している」という意味であり、需要の二重計上ではない。
          hosoEqTons(bucket.forwardDemandProxy),
          params,
          capacityByCompanyMarket
        ),
      };
    });

    // 契約は bucket 別 allocation から直接生成する（§4）。
    // 同一 company は market × product につき plan を1件しか持たないため、
    // 同一 turn で複数 bucket へ重複することはない（DUE-5 で固定）。
    allocations = aggregateBucketAllocationsByMarketProduct(bucketAllocations);
  }

  // 契約生成は bucket 別 allocation から行う（Crowding OFF のときは allocations そのもの）。
  const allocationsForContracts =
    bucketAllocations === undefined ? allocations : bucketAllocations.map((b) => b.result);
  const newContracts = createContractsFromAllocation(allocationsForContracts, adjustedPlans, params);

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
 * 【ENG-CROWDING-MARKDOWN-1B §5・§6】納期別 allocation を
 * market × product へ再集約する。
 *
 * 【なぜ再集約するか】SalesQuarterRecord.allocations は history 経由で永続化され、
 * dashboard / analytics / audit workbook / marketEvolution / salesBase /
 * Standard AI report・log / AI Pack / Export が「market × product につき 1 件」を
 * 前提にしている。納期別 allocation をそのまま複数保存するとこの契約が壊れるため、
 * **turn 内の一時的 internal result** にとどめ、保存時は 1 件へ戻す。
 * これにより永続 schema 変更も downstream の大量改修も不要になる。
 *
 * 【集約の式（§6）】
 *   targetDemand            = Σ bucket.targetDemand
 *   externalOptionQuantity  = Σ bucket.externalOptionQuantity
 *   companies               = 各 bucket の会社エントリをそのまま連結
 *                             （1社は market × product につき plan を1件しか
 *                               持たないため、複数 bucket へ重複しない。
 *                               したがって allocatedQuantity も askPrice も
 *                               その会社が所属する bucket の値がそのまま残る）
 *   分子（提示・成約）と分母（需要）を同じ bucket 集合で揃えるため、
 *   どちらも同じ Σ を取る。片方だけ1四半期分にする非対称は作らない（§7）。
 *
 * 【basePrice について（#04 判断を仰ぐ項目）】
 * basePrice は market × product の**ヘッダ値**であり、bucket ごとに
 * clearing price が異なる場合に一意な値が存在しない。§6 は「勝手に平均するな」と
 * しているため平均は取らず、**最も近い納期（earliest dueDate）の bucket の
 * clearing price** をヘッダとして採用する。各社の実際の提示価格は
 * CompanyAllocationEntry.askPrice に bucket 固有の値がそのまま入っており、
 * 契約単価も SalesContract 側が正本なので、この選択で失われる情報は無い。
 * ただし dashboardViewModel.ts の priceDeviationRatio
 * （= (askPrice - basePrice) / basePrice）だけは、別 bucket の会社について
 * 基準が異なる値になる。この一点は #04 の確認事項として報告する。
 */
export function aggregateBucketAllocationsByMarketProduct(
  bucketAllocations: readonly DueDateBucketAllocation[]
): readonly MarketProductAllocationResult[] {
  const groups = new Map<string, DueDateBucketAllocation[]>();
  for (const b of bucketAllocations) {
    const key = `${b.result.market}::${b.result.product}`;
    const list = groups.get(key);
    if (list) list.push(b);
    else groups.set(key, [b]);
  }

  // 入力（= 既存経路と同じ 市場 → 商品 → 納期 の順）の並びをそのまま保つ。
  // Map はキー挿入順を保持するため、ここで並べ替えない。
  return [...groups.keys()].map((key) => {
    // 納期の昇順（PeriodV2 は "YYYYQn" の昇順比較可能な文字列）。
    const buckets = [...groups.get(key)!].sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));
    const first = buckets[0].result;

    // bucket が1つだけなら、従来（1bucket）の結果と厳密に同一のオブジェクトを返す（DUE-7）。
    if (buckets.length === 1) return first;

    const companies = buckets.flatMap((b) => b.result.companies);
    const seen = new Set<string>();
    for (const c of companies) {
      if (seen.has(c.companyId)) {
        // 1社が同一 market × product の複数 bucket に現れるのは現行仕様では起こりえない。
        // 起きたなら集約が一意に定義できないので、黙って合算せず明示的に失敗させる。
        throw new SalesValidationError(
          `同一 market × product で会社が複数の納期 bucket に現れました（集約が一意に定義できません）: ` +
            `${first.market}/${first.product}/${c.companyId}`
        );
      }
      seen.add(c.companyId);
    }

    const sum = (f: (r: MarketProductAllocationResult) => number) => buckets.reduce((t, b) => t + f(b.result), 0);

    return {
      market: first.market,
      product: first.product,
      period: first.period,
      // 最も近い納期の bucket の clearing price（平均は取らない。上記コメント参照）。
      basePrice: first.basePrice,
      targetDemand: hosoEqTons(sum((r) => r.targetDemand as unknown as number)),
      companies,
      externalOptionQuantity: hosoEqTons(sum((r) => r.externalOptionQuantity as unknown as number)),
    };
  });
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
