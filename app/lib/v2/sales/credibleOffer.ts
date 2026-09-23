// ShrimpX V2 — 信頼可能提示量（credible offer）と physical ATP proxy
// （ENG-CROWDING-MARKDOWN-1 Phase 1）
//
// 【このモジュールの責務】
// Crowding の分子へ入れてよい「信頼可能提示量」を算出する。
// Player/AI の desiredQuantity をそのまま分子へ使うと、希望量を巨大化するだけで
// 他社の市場価格を下げられてしまう（FAKE CAPACITY）。それを構造的に防ぐ。
//
//   credibleOffer_i = min(
//     desiredAfterSalesEffort_i,
//     commercialApprovedCap_i,
//     physicalAtpShare_i
//   )
//
// 【physical ATP proxy（#04 確定方針・V2.00 Phase 1）】
//   physicalAtpCap
//     = onHandFinishedGoods
//     + conservativeCommittedSupply
//     - existingBacklogDueByDueDate
//
// conservativeCommittedSupply に含めてよいのは、呼び出し側が
// 「既に決定済み」として確定させた供給だけである（companyLab 側で構築する）。
// 含めてはいけないもの:
//   - 将来まだ決定していない production plan
//   - 将来買うかもしれない spot raw material
//   - 将来増員するかもしれない worker
//   - 将来完成する未確定 CAPEX 能力
//   - 「現在能力 × 残Turn数」を商品別に独立使用する計算
//   - shared capacity の二重利用
//
// 【将来 ATP を増やさない】dueDate が遠いほど未決定の将来生産を推測して
// credible supply を増やしてはならない。したがって Phase 1 では、長期納期の ATP が
// 実際の将来能力より保守的に小さくなることを許容する。この制約は
// physicalAtpMethod（PHYSICAL_ATP_METHOD_V1）と診断の limitations に明示する。
//
// 【第二 production simulator を作らない】本モジュールは生産ロジックを再実行しない。
// 呼び出し側が既存の authoritative capacity helper から得た値を渡すだけである。

import { PeriodV2 } from "../core/period";
import { DemandMarketId, Product } from "../market/types";
import { CompanyId } from "./types";

/** credibleOffer を決めた拘束要因。 */
export type CredibleOfferBindingReason =
  /** 希望提示量（営業工数適用後）がそのまま通った。 */
  | "DESIRED"
  /** physical ATP（在庫＋確定供給−受注残）で削られた。 */
  | "PHYSICAL_ATP"
  /** 商業的な承認枠（approvedAllocationCap）で削られた。 */
  | "COMMERCIAL_APPROVED_CAP";

/**
 * 会社 × 商品 の物理供給スナップショット。
 * **sales モジュールはこれを計算しない**（生産・在庫・原料の正本を持たないため）。
 * companyLab 側が既存の authoritative helper から構築して渡す。
 */
export interface CompanyProductPhysicalSupply {
  readonly companyId: CompanyId;
  readonly product: Product;
  /** 手持ち完成品在庫（この商品、HOSO換算トン）。 */
  readonly onHandFinishedGoods: number;
  /**
   * 安全側に確定済みとみなせる当期供給。
   * 呼び出し側で shared capacity（共通前処理・冷凍包装・労務・原料）による
   * clip を済ませた後の値を渡すこと。
   */
  readonly conservativeCommittedSupply: number;
  /** 算出方式の識別子（診断へそのまま出す）。 */
  readonly method: string;
  /** この proxy が取り込めていない要素（診断・報告用）。 */
  readonly limitations: readonly string[];
}

/** 1社 × 1商品 × 1納期 の physical supply pool。 */
export interface PhysicalSupplyPool {
  readonly companyId: CompanyId;
  readonly product: Product;
  readonly dueDate: PeriodV2;
  readonly onHandFinishedGoods: number;
  readonly conservativeCommittedSupply: number;
  readonly existingBacklogDueByDueDate: number;
  /** max(0, onHand + committed - backlog)。 */
  readonly physicalAtpCap: number;
  readonly method: string;
  readonly limitations: readonly string[];
}

/**
 * physical ATP pool を1つ作る。
 * backlog は「その納期までに納めなければならない既存契約の未履行量」であり、
 * 同じ供給を新規提示へ二重に使わせないために差し引く（CRWD-11）。
 */
export function buildPhysicalSupplyPool(args: {
  readonly supply: CompanyProductPhysicalSupply;
  readonly dueDate: PeriodV2;
  readonly existingBacklogDueByDueDate: number;
}): PhysicalSupplyPool {
  const onHand = Math.max(0, args.supply.onHandFinishedGoods);
  const committed = Math.max(0, args.supply.conservativeCommittedSupply);
  const backlog = Math.max(0, args.existingBacklogDueByDueDate);
  return {
    companyId: args.supply.companyId,
    product: args.supply.product,
    dueDate: args.dueDate,
    onHandFinishedGoods: onHand,
    conservativeCommittedSupply: committed,
    existingBacklogDueByDueDate: backlog,
    physicalAtpCap: Math.max(0, onHand + committed - backlog),
    method: args.supply.method,
    limitations: args.supply.limitations,
  };
}

/** 1社が1つの 市場 × 商品 × 納期 へ出す希望提示（営業工数適用後）。 */
export interface DesiredOfferEntry {
  readonly companyId: CompanyId;
  readonly market: DemandMarketId;
  readonly product: Product;
  readonly dueDate: PeriodV2;
  /** 営業工数適用後の希望提示量。 */
  readonly desiredAfterSalesEffort: number;
  /** 商業的な承認枠。未指定は +Infinity（現行 Engine と同じ意味）。 */
  readonly commercialApprovedCap: number;
}

/** 解決済みの信頼可能提示量（1社 × 1市場 × 1商品 × 1納期）。 */
export interface ResolvedCredibleOffer {
  readonly companyId: CompanyId;
  readonly market: DemandMarketId;
  readonly product: Product;
  readonly dueDate: PeriodV2;
  readonly desiredAfterSalesEffort: number;
  readonly commercialApprovedCap: number;
  /** この市場へ按分された physical pool の取り分。 */
  readonly physicalAtpShare: number;
  readonly credibleOffer: number;
  readonly bindingReason: CredibleOfferBindingReason;
}

/**
 * Crowding ON なのに信頼可能な physical cap を作れなかったことを表す例外。
 * **desiredQuantity への silent fallback は禁止**（§7）。
 */
export class CredibleOfferResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredibleOfferResolutionError";
  }
}

/**
 * 同一 会社 × 商品 × 納期 の physical pool を、複数市場の希望提示へ
 * **決定論的に按分**して credible offer を解決する。
 *
 * 【二重利用の防止（§複数market offer間の二重利用防止）】
 * CN VAP / JP VAP / EU VAP へ同じ完成品・同じ生産量をそれぞれ全量利用可能と
 * してはならない。会社 × 商品 × 納期 につき pool を1つだけ作り、
 * 各市場への credible offer の合計がその pool を超えないようにする。
 *
 * 【按分方法（第一候補をそのまま採用）】
 * 各市場の「営業工数適用後 desired offer」に比例して pool を按分する。
 * 希望合計が pool 以下なら按分は不要（各市場は希望どおり）。
 * 余った capacity の再配分は行わない（既存 allocation semantics との整合を
 * 監査せずに複雑な再配分アルゴリズムを足さない、という #04 指示に従う）。
 *
 * 按分後に commercial approved cap と desired を min で重ねる。
 * sales capacity・product/market eligibility 等の既存 cap は、この後段の
 * 既存 allocator（allocation.ts / tieredAllocation.ts）がそのまま適用する。
 */
export function resolveCredibleOffersForPool(
  pool: PhysicalSupplyPool,
  entries: readonly DesiredOfferEntry[]
): readonly ResolvedCredibleOffer[] {
  // 決定論のため市場 ID で安定ソートする。
  const sorted = [...entries].sort((a, b) => a.market.localeCompare(b.market));
  for (const e of sorted) {
    if (e.companyId !== pool.companyId || e.product !== pool.product || e.dueDate !== pool.dueDate) {
      throw new CredibleOfferResolutionError(
        `pool と entry の 会社/商品/納期 が一致しません: pool=${pool.companyId}/${pool.product}/${pool.dueDate} ` +
          `entry=${e.companyId}/${e.product}/${e.dueDate}`
      );
    }
    if (!Number.isFinite(e.desiredAfterSalesEffort) || e.desiredAfterSalesEffort < 0) {
      throw new CredibleOfferResolutionError(
        `desiredAfterSalesEffort は 0 以上の有限値である必要があります: ${e.desiredAfterSalesEffort}`
      );
    }
  }
  if (!Number.isFinite(pool.physicalAtpCap) || pool.physicalAtpCap < 0) {
    throw new CredibleOfferResolutionError(
      `physicalAtpCap は 0 以上の有限値である必要があります（desiredQuantity への fallback はしない）: ` +
        `${pool.companyId}/${pool.product}/${pool.dueDate} = ${pool.physicalAtpCap}`
    );
  }

  const totalDesired = sorted.reduce((s, e) => s + e.desiredAfterSalesEffort, 0);

  return sorted.map((e) => {
    // 希望合計が pool 以下なら按分せずそのまま。超える場合のみ希望比で按分する。
    const physicalAtpShare =
      totalDesired <= 0
        ? 0
        : totalDesired <= pool.physicalAtpCap
          ? e.desiredAfterSalesEffort
          : pool.physicalAtpCap * (e.desiredAfterSalesEffort / totalDesired);

    const credibleOffer = Math.min(e.desiredAfterSalesEffort, e.commercialApprovedCap, physicalAtpShare);

    // 拘束要因の判定。同値のときは「より外側の制約」を優先して報告しない
    // （physical > commercial > desired の順で厳しい方を記録する）。
    let bindingReason: CredibleOfferBindingReason = "DESIRED";
    if (physicalAtpShare <= credibleOffer && physicalAtpShare < e.desiredAfterSalesEffort) {
      bindingReason = "PHYSICAL_ATP";
    } else if (e.commercialApprovedCap <= credibleOffer && e.commercialApprovedCap < e.desiredAfterSalesEffort) {
      bindingReason = "COMMERCIAL_APPROVED_CAP";
    }

    return {
      companyId: e.companyId,
      market: e.market,
      product: e.product,
      dueDate: e.dueDate,
      desiredAfterSalesEffort: e.desiredAfterSalesEffort,
      commercialApprovedCap: e.commercialApprovedCap,
      physicalAtpShare,
      credibleOffer: Math.max(0, credibleOffer),
      bindingReason,
    };
  });
}

/** 会社 × 商品 × 納期 のキー（pool の同一性判定に使う）。 */
export function physicalSupplyPoolKey(companyId: CompanyId, product: Product, dueDate: PeriodV2): string {
  return `${companyId}::${product}::${dueDate}`;
}
