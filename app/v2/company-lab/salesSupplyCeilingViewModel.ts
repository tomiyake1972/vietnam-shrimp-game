// ShrimpX V2 — SALES: 「この商品はいくらまで売れるのか」の上限を画面に出す
//
// 【直す問題（テストプレイ指摘①・2026-11）】
// 販売計画の入力欄には上限が一切示されていなかった。実効加工能力の行は
// 販売計画セクションのいちばん下の合計表の中にしか無く、受注残と完成品在庫は
// 別のタブ（Inventory / INFO）にあるため、「今期この商品を何トンまで売る計画に
// してよいか」はどの画面にも出ていなかった。AIの初期提案が実効能力を超えた値を
// 入れていても気づけず、作りきれない量を提示して在庫が積み上がる。
//
// 【新しい計算を作らない】ここで足し合わせるのは、すべてエンジンが既に確定させた値
// だけである:
//   - 完成品在庫  … CompanyOwnState.finishedGoodsLots（status==="available"）
//   - 実効加工能力 … DecisionStudioViewModel.processingForecast.companyRateTable
//                   （名目能力 × 実効率。SALES / PRODUCTION と同じ値を使う）
//   - 受注残      … computeBacklogSemantics（SALES / PRODUCTION と同じ値）
//   - 販売計画    … draft.salesPlans の商品別合計（computeSalesPlanTotals と同じ）
// 単価・価格・成約確率の予測は一切しない。出すのは数量の「目安」だけであり、
// 画面側でも必ず目安であることを明記する（実際の成約量は5社の競争で決まる）。
//
// 【なぜ「目安」でしかないか】
//   - 当期の原料買付・輸入到着ぶんは実効加工能力の中に入っていない
//     （processingForecastViewModel.ts と同じ前提。原料が足りなければ能力まで作れない）
//   - 受注残の納期は契約ごとに異なり、全量が今期の納品義務とは限らない
//   - 提示した量がそのまま成約するわけではない
// したがってこのモジュールは「これ以上は構造的に作れない・納められない」という
// 上側の線だけを示す。

import type { Product } from "../../lib/v2/market/types";

/** 商品1つぶんの供給上限の目安。 */
export interface SalesSupplyCeilingRow {
  readonly product: Product;
  /** 今すぐ出荷できる完成品在庫（期首・status==="available"）。 */
  readonly finishedGoodsTons: number;
  /** 当期の実効加工能力（取得できなければ null。0で埋めない）。 */
  readonly effectiveCapacityTons: number | null;
  /** 在庫 ＋ 実効加工能力。能力が取得できないときは null。 */
  readonly supplyCeilingTons: number | null;
  /** 未履行の受注残（この商品ぶんの合計）。 */
  readonly backlogTons: number;
  /** うち今期が納期のぶん（期限切れを含む）。 */
  readonly backlogDueNowTons: number;
  /** 受注残を先に納めたあとに新規販売へ回せる量の目安。能力が不明なら null。 */
  readonly availableForNewSalesTons: number | null;
  /** 今の販売計画（この商品の全市場合計）。 */
  readonly plannedTons: number;
  /** 販売計画が supplyCeilingTons を超えているか（能力が不明なら false）。 */
  readonly exceedsSupplyCeiling: boolean;
  /** 販売計画が availableForNewSalesTons を超えているか（能力が不明なら false）。 */
  readonly exceedsAvailableForNewSales: boolean;
}

export interface SalesSupplyCeiling {
  readonly rows: readonly SalesSupplyCeilingRow[];
  /** 実効加工能力そのものを超えている商品（最も強い警告）。 */
  readonly productsOverSupplyCeiling: readonly Product[];
  /** 受注残を差し引くと足りない商品（上限内でも納品できない可能性がある）。 */
  readonly productsOverAvailableForNewSales: readonly Product[];
  /** 実効加工能力が1商品も取得できなかった（＝上限を示せない）。 */
  readonly capacityUnavailable: boolean;
}

export interface BuildSalesSupplyCeilingInput {
  /** 表示する商品の並び（draft の販売計画に現れる順）。 */
  readonly products: readonly Product[];
  /** 商品別の販売希望数量合計。computeSalesPlanTotals.productTotalTons と同じ値を渡す。 */
  readonly plannedTonsByProduct: Readonly<Partial<Record<Product, number>>>;
  /** 商品別の出荷可能な完成品在庫。 */
  readonly finishedGoodsTonsByProduct: Readonly<Partial<Record<Product, number>>>;
  /** 商品別の実効加工能力。値が無い商品は「取得不能」として扱う。 */
  readonly effectiveCapacityByProduct: Readonly<Partial<Record<Product, number>>> | undefined;
  /** 商品別の受注残（合計／今期納期ぶん）。 */
  readonly backlogByProduct: readonly {
    readonly product: Product;
    readonly totalTons: number;
    readonly dueNowTons: number;
  }[];
}

const num = (value: number | undefined): number => (value !== undefined && Number.isFinite(value) ? value : 0);

export function buildSalesSupplyCeiling(input: BuildSalesSupplyCeilingInput): SalesSupplyCeiling {
  const backlogByProduct = new Map(input.backlogByProduct.map((b) => [b.product, b]));

  const rows: SalesSupplyCeilingRow[] = input.products.map((product) => {
    const finishedGoodsTons = num(input.finishedGoodsTonsByProduct[product]);
    const rawCapacity = input.effectiveCapacityByProduct?.[product];
    const effectiveCapacityTons = rawCapacity !== undefined && Number.isFinite(rawCapacity) ? rawCapacity : null;
    const supplyCeilingTons = effectiveCapacityTons === null ? null : finishedGoodsTons + effectiveCapacityTons;
    const backlog = backlogByProduct.get(product);
    const backlogTons = num(backlog?.totalTons);
    const backlogDueNowTons = num(backlog?.dueNowTons);
    // 受注残は在庫・生産能力の中から先に納めることになるため、新規販売へ回せる
    // 量は上限から受注残ぶんを引いた残りになる（マイナスにはしない）。
    const availableForNewSalesTons = supplyCeilingTons === null ? null : Math.max(0, supplyCeilingTons - backlogTons);
    const plannedTons = num(input.plannedTonsByProduct[product]);
    return {
      product,
      finishedGoodsTons,
      effectiveCapacityTons,
      supplyCeilingTons,
      backlogTons,
      backlogDueNowTons,
      availableForNewSalesTons,
      plannedTons,
      exceedsSupplyCeiling: supplyCeilingTons !== null && plannedTons > supplyCeilingTons,
      exceedsAvailableForNewSales: availableForNewSalesTons !== null && plannedTons > availableForNewSalesTons,
    };
  });

  return {
    rows,
    productsOverSupplyCeiling: rows.filter((r) => r.exceedsSupplyCeiling).map((r) => r.product),
    productsOverAvailableForNewSales: rows.filter((r) => r.exceedsAvailableForNewSales && !r.exceedsSupplyCeiling).map((r) => r.product),
    capacityUnavailable: rows.length > 0 && rows.every((r) => r.effectiveCapacityTons === null),
  };
}
