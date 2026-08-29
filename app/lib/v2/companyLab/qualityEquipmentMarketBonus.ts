// ShrimpX V2 — TIERED-MKT-P1D 品質管理設備の「市場評価」直接ボーナス（tiered専用）
//
// 【この効果の位置づけ・二重計上防止】
// 品質管理設備（qualityControlEquipment）は既に
//   設備 → operationalRisk の乗算的低減（capex/qualityControlEquipmentEffect.ts）
//       → 不適合率・重大事故確率の低下
//       → 既存の Quality Score（生産量加重平均＋非対称EWMA）の改善
// という **間接・確率的** な経路を持つ。この経路は一切変更・弱化しない。
//
// ここで追加するのは、それとは別の
//   「設備を保有していること自体が、顧客・認証・品質保証体制の観点から
//     市場で受ける決定論的な直接評価」
// であり、**同じ risk multiplier を再利用しない**（rampProgress だけを共有する）。
// 効果量は full effect で +4 qualityReputation point（company×product 上限）。
//
// 【legacy 隔離】この関数の出力は、SalesParameters.marketAllocationMode が
// "tieredSimultaneousAllocation" のときにだけ companyLab/runner.ts が販売計画へ
// 適用する。legacyWaterfall では呼ばれないため、既存 Scenario（DS1/DS2/DS3）の
// 挙動はビット単位で不変。
//
// 【永続 state を書かない】company state の qualityReputation / qualityState は
// 一切書き換えない。当四半期の Sales Engine 入力（turnInput.salesPlans）に対する
// 上書きだけを行うため、保存schema・Redis・migration は不要。

import { PeriodV2 } from "../core/period";
import { score0to100, unwrapUnit } from "../core/units";
import { CompanySalesPlanEntry } from "../sales/types";
import { Product } from "../market/types";
import { Factory } from "../production/types";
import { CapexState } from "../capex/types";
import { QualityParameters, QUALITY_PARAMETERS_V1 } from "../quality/parameters";
import { resolveQualityEquipmentStatusByFactory } from "./qualityControlEquipmentState";

/**
 * full ramp・全能力カバー時の qualityReputation 加点（point）。
 * company×product ごとの上限でもある（複数設備でもこれを超えない）。
 */
export const EQUIPMENT_QUALITY_BONUS_FULL_EFFECT_POINTS = 4;

/** company×product キー（Map のキー規約）。 */
export function equipmentQualityBonusKey(companyId: string, product: Product): string {
  return `${companyId}::${product}`;
}

function productCapacityOf(factory: Factory, product: Product): number {
  switch (product) {
    case "hoso":
      return Number(factory.hosoCapacity);
    case "pd":
      return Number(factory.pdCapacity);
    case "vap":
      return Number(factory.vapCapacity);
  }
}

const PRODUCTS_LOCAL: readonly Product[] = ["hoso", "pd", "vap"];

/**
 * company×product ごとの品質管理設備 直接ボーナス（0〜4 point）を求める純粋関数。
 *
 *   factoryProductCoverage      = そのFactoryの当該product実効能力 / 会社の当該product実効能力合計
 *   factoryBonus                = 4 × rampFactor × factoryProductCoverage
 *   companyProductEquipmentBonus= min(4, Σ factoryBonus)
 *
 * rampFactor は既存の品質管理設備ランプ（quality/parameters.ts の
 * qualityControlEquipment.rampQuarters、既定2Q の線形ランプ）をそのまま使う。
 * 新しい ramp clock は作らない。建設中（IN_PROGRESS）は rampProgress=0 なので 0。
 *
 * 【factories の前提】呼び出し側が computeEffectiveFactories を通した「当四半期の
 * 実効Factory[]」を渡すこと（能力加算・新設・lifecycle 反映済み）。
 * 休止・売却予定（status !== "active"）のFactoryは、生産にも市場評価にも寄与しない
 * ものとして分母・分子の双方から除外する。
 *
 * 【capexState の前提】buildQualityEquipmentRiskMultiplierByFactory と同じく
 * 「前四半期末までのcapex状態」を渡すこと（先読み禁止）。
 */
export function computeEquipmentQualityBonusByCompanyProduct(
  capexState: CapexState,
  factories: readonly Factory[],
  period: PeriodV2,
  params: QualityParameters = QUALITY_PARAMETERS_V1
): ReadonlyMap<string, number> {
  const statusByFactory = resolveQualityEquipmentStatusByFactory(capexState, factories, period, params);
  const active = factories.filter((f) => f.status === "active");

  const result = new Map<string, number>();
  const companyIds = [...new Set(active.map((f) => f.companyId))].sort();
  for (const companyId of companyIds) {
    const own = active.filter((f) => f.companyId === companyId);
    for (const product of PRODUCTS_LOCAL) {
      const total = own.reduce((s, f) => s + productCapacityOf(f, product), 0);
      if (!(total > 0)) continue; // 当該productの実効能力が無い会社は対象外（0除算もしない）。
      let bonus = 0;
      for (const factory of own) {
        const ramp = statusByFactory.get(factory.factoryId)?.equipmentRampProgress ?? 0;
        if (!(ramp > 0)) continue;
        const coverage = productCapacityOf(factory, product) / total;
        bonus += EQUIPMENT_QUALITY_BONUS_FULL_EFFECT_POINTS * ramp * coverage;
      }
      if (bonus > 0) result.set(equipmentQualityBonusKey(companyId, product), Math.min(EQUIPMENT_QUALITY_BONUS_FULL_EFFECT_POINTS, bonus));
    }
  }
  return result;
}

/**
 * 品質管理設備の直接ボーナスを、当四半期の Sales Engine 入力（販売計画）の
 * qualityReputation へ加算した新しい配列を返す。
 *
 * 【legacy 隔離】呼び出し側（companyLab/runner.ts）が tiered mode のときにだけ呼ぶ。
 * 【永続化しない】decisions（保存対象）は変更せず、Engine へ渡す配列だけを作る。
 * 【clamp】qualityReputation は 0〜100 スケール。加算後も 0〜100 に収める。
 * 【未接続は埋めない】qualityReputation が未設定の entry には加算しない
 *  （未取得の値を 50 で埋めてからボーナスを乗せる、という捏造をしない）。
 */
export function applyEquipmentQualityBonusToSalesPlans(
  plans: readonly CompanySalesPlanEntry[],
  bonusByCompanyProduct: ReadonlyMap<string, number>
): CompanySalesPlanEntry[] {
  if (bonusByCompanyProduct.size === 0) return [...plans];
  return plans.map((plan) => {
    const bonus = bonusByCompanyProduct.get(equipmentQualityBonusKey(plan.companyId, plan.product));
    if (bonus === undefined || !(bonus > 0) || plan.qualityReputation === undefined) return plan;
    const base = unwrapUnit(plan.qualityReputation);
    return { ...plan, qualityReputation: score0to100(Math.max(0, Math.min(100, base + bonus))) };
  });
}
