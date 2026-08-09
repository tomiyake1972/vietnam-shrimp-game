// ShrimpX V2 — Unserved Profitable Opportunity（Phase 6・2026-08-09新設）
//
// 【この概念が必要な理由】
// 「工場の稼働率がまだ75%だから新工場は不要」という判断だけでは、
//
//   ・そもそも売りにいっていないから稼働率が低い
//   ・売りたいのに営業人員が足りない
//   ・売りたいのに生産能力が足りない
//
// を区別できない。新工場を建てるべきなのは3番目だけである。
//
// そこで「取りたかったが取れなかった量」を明示的に持ち、**その原因を分解する**。
//
// 【絶対規約】
//  1. 分解は正式に導出できる範囲のみ。合計が合わない残りは OTHER へ入れ、
//     それらしい原因を割り振らない。
//  2. 生産能力が原因の分だけが新工場の根拠になりうる。労働・原料・営業が
//     原因の分は、工場を建てても解決しない。

const EPSILON = 1e-6;

/** 成長を止めた要因。表示・投資判断の両方でこの区分をそのまま使う。 */
export type GrowthConstraint =
  | "SALES_CAPACITY"
  | "PRODUCTION_CAPACITY"
  | "LABOR"
  | "RAW_MATERIAL"
  | "INVENTORY_POLICY"
  | "OTHER"
  | "NONE";

export interface UnservedOpportunityInput {
  /** 今期取りたかった規模（Commercial Ambition）。 */
  readonly commercialAmbitionTons: number;
  /** 営業工数制約を適用する前の希望販売量（在庫上乗せ後）。 */
  readonly desiredBeforeEffortTons: number;
  /** 営業工数制約を適用した後の販売計画合計（＝実際に提出した量）。 */
  readonly submittedSalesTons: number;
  /** 当期の実効生産能力（商品別ライン合計と共通前処理の小さい方）。 */
  readonly bindingProductionCapacityTons: number;
  /** 在庫過剰で Commercial Ambition を据え置いたか。 */
  readonly heldByInventory: boolean;
  /**
   * 生産側の不足を説明する観測上の要因（situationDiagnosis 由来）。
   * **推測しない** — 診断が労働不足・原料供給制約を名指ししたときだけ true。
   * true のとき、生産能力起因として数えた量をその要因へ移す
   * （工場を建てても解決しない不足を、新工場の根拠にしないため）。
   */
  readonly laborIsBindingConstraint: boolean;
  readonly rawMaterialIsBindingConstraint: boolean;
}

export interface UnservedOpportunity {
  /** 取りたかったが取れなかった採算つき機会の合計。 */
  readonly unservedProfitableTons: number;
  /** 営業能力が理由の分。 */
  readonly blockedBySalesCapacityTons: number;
  /** 生産能力が理由の分。**新工場の根拠になりうるのはここだけ。** */
  readonly blockedByProductionCapacityTons: number;
  readonly blockedByLaborTons: number;
  readonly blockedByRawMaterialTons: number;
  readonly blockedByInventoryPolicyTons: number;
  /** 上記のどれにも正式に割り当てられなかった残り（推測で割り振らない）。 */
  readonly otherTons: number;
  /** 最も大きい阻害要因。 */
  readonly primaryConstraint: GrowthConstraint;
}

/**
 * 未充足の採算つき機会を求め、原因を分解する（純粋関数）。
 * 入力はすべて当期・前期までの確定値であり、未来の値は含まれない。
 */
export function computeUnservedOpportunity(input: UnservedOpportunityInput): UnservedOpportunity {
  const unserved = Math.max(0, input.commercialAmbitionTons - input.submittedSalesTons);

  // 【重複計上しない】志の規模から順に、上流の制約から差し引いていく滝（waterfall）で
  // 分解する。同じトン数を2つの要因が同時に説明することはない。

  // 1. 在庫方針: 在庫過剰を理由に、そもそも規模拡大を見送った分。
  const afterInventory = input.heldByInventory
    ? Math.min(input.commercialAmbitionTons, input.desiredBeforeEffortTons)
    : input.commercialAmbitionTons;
  const blockedByInventoryPolicyTons = Math.max(0, input.commercialAmbitionTons - afterInventory);

  // 2. 供給能力: 物理的に作れない分（志が実効生産能力を超えている分）。
  const afterProduction = Math.min(afterInventory, input.bindingProductionCapacityTons);
  const supplyBlockedTons = Math.max(0, afterInventory - afterProduction);

  // 【§20】不足の主因が労働・原料と診断されているなら、工場を建てても解決しない。
  // その場合は生産能力ではなくその要因へ計上する（新工場の根拠にしない）。
  const blockedByLaborTons = input.laborIsBindingConstraint ? supplyBlockedTons : 0;
  const blockedByRawMaterialTons =
    !input.laborIsBindingConstraint && input.rawMaterialIsBindingConstraint ? supplyBlockedTons : 0;
  const blockedByProductionCapacityTons =
    input.laborIsBindingConstraint || input.rawMaterialIsBindingConstraint ? 0 : supplyBlockedTons;

  // 3. 営業能力: 作れる範囲まで来たのに、営業工数で削られた分。
  const blockedBySalesCapacityTons = Math.max(0, Math.min(afterProduction, input.desiredBeforeEffortTons) - input.submittedSalesTons);

  const attributed =
    blockedByInventoryPolicyTons + supplyBlockedTons + blockedBySalesCapacityTons;
  const otherTons = Math.max(0, unserved - attributed);

  const candidates: readonly { readonly constraint: GrowthConstraint; readonly tons: number }[] = [
    { constraint: "PRODUCTION_CAPACITY", tons: blockedByProductionCapacityTons },
    { constraint: "SALES_CAPACITY", tons: blockedBySalesCapacityTons },
    { constraint: "LABOR", tons: blockedByLaborTons },
    { constraint: "RAW_MATERIAL", tons: blockedByRawMaterialTons },
    { constraint: "INVENTORY_POLICY", tons: blockedByInventoryPolicyTons },
    { constraint: "OTHER", tons: otherTons },
  ];
  const top = candidates.reduce((a, b) => (b.tons > a.tons ? b : a));

  return {
    unservedProfitableTons: unserved,
    blockedBySalesCapacityTons,
    blockedByProductionCapacityTons,
    blockedByLaborTons,
    blockedByRawMaterialTons,
    blockedByInventoryPolicyTons,
    otherTons,
    primaryConstraint: unserved <= EPSILON || top.tons <= EPSILON ? "NONE" : top.constraint,
  };
}
