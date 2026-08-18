// ShrimpX V2 — Shared Game Knowledge Registry: 決定論的な目安計算（実装指示§8・§10）
//
// 【Claudeに暗算させない】「8,000t売るには何人？」「PD 1,000tに何人？」といった
// 質問には、engine の既存関数・現在のparameterを使った **決定論的なhelper** で
// 答えを作り、その数値をプロンプトへ渡す。LLMに計算させない。
//
// 【確定できないものは確定しない】営業は需要・価格・信頼・在庫でも決まるため、
// 「必要人数」は一意に決まらない。ここが返すのは「営業工数能力の観点だけで見た
// 目安」であり、その旨を必ず caveat として同梱する（実装指示§8）。

import { Product } from "../market/types";
import { companySalesOrganizationCapacity, SALES_CAPACITY_MODEL_PER_MARKET } from "../sales/salesCapacityModel";
import { effectiveEfficiencyPerHeadTons, requiredHeadcountForQuantity } from "../production/labor";
import { DEFAULT_GAME_KNOWLEDGE_PARAMETERS, GameKnowledgeParameterSources } from "./dynamicValues";

/** 営業能力の目安1件。 */
export interface SalesCapacityEstimate {
  readonly headcount: number;
  /** 会社全体の営業工数能力（工数トン／四半期）。モデルがperMarketの場合はnull。 */
  readonly effortCapacityTons: number | null;
  /** 商品構成別の販売可能トン目安（工数能力 ÷ 商品の工数係数）。 */
  readonly sellableTonsByProduct: Readonly<Record<Product, number | null>>;
  readonly caveats: readonly string[];
}

/**
 * 「営業N人ならどれくらい売れるか」の目安（実装指示§8）。
 * 商品構成で大きく変わるため、単一の数値ではなく商品別の上限を返す。
 */
export function estimateSalesCapacity(
  headcount: number,
  sources: GameKnowledgeParameterSources = DEFAULT_GAME_KNOWLEDGE_PARAMETERS
): SalesCapacityEstimate {
  const sales = sources.sales;
  const model = sales.salesCapacityModel ?? SALES_CAPACITY_MODEL_PER_MARKET;
  const caveats = [
    "これは営業組織の処理能力（上限）の目安であり、この量が必ず売れることを意味しない。",
    "実際の成約量は市場需要・提示価格・顧客信頼・品質・納期信頼性との競争で決まる。",
    "生産能力・原料・在庫が足りなければ、営業能力があっても納品できない。",
  ];
  if (model.kind === "perMarket") {
    return {
      headcount,
      effortCapacityTons: null,
      sellableTonsByProduct: { hoso: null, pd: null, vap: null },
      caveats: [...caveats, "現在の営業能力モデルは市場別モデル（perMarket）であり、会社全体の単一能力として表せない。"],
    };
  }
  const effortCapacityTons = companySalesOrganizationCapacity(Math.max(0, headcount), model);
  const perProduct = (product: Product): number | null => {
    const coefficient = sales.salesEffortCoefficients[product];
    return Number.isFinite(coefficient) && coefficient > 0 ? effortCapacityTons / coefficient : null;
  };
  return {
    headcount,
    effortCapacityTons,
    sellableTonsByProduct: { hoso: perProduct("hoso"), pd: perProduct("pd"), vap: perProduct("vap") },
    caveats: [
      ...caveats,
      "販売可能トンは商品構成で変わる（HOSO中心なら多く、VAP中心なら少ない）。実際の混合構成では各商品の値の間になる。",
    ],
  };
}

/** 「Nトン売るには営業何人か」の逆算（工数能力の観点のみ）。 */
export function estimateSalesHeadcountForTons(
  targetTons: number,
  product: Product,
  sources: GameKnowledgeParameterSources = DEFAULT_GAME_KNOWLEDGE_PARAMETERS
): { readonly requiredHeadcount: number | null; readonly caveats: readonly string[] } {
  const sales = sources.sales;
  const model = sales.salesCapacityModel ?? SALES_CAPACITY_MODEL_PER_MARKET;
  const coefficient = sales.salesEffortCoefficients[product];
  const caveats = [
    "営業工数能力の観点だけで逆算した目安であり、必要人数はこれで確定しない。",
    "市場需要が足りなければ人数を増やしても売れない。逆に競争力が高ければ少ない人数でも取れることがある。",
  ];
  if (model.kind === "perMarket" || !(coefficient > 0) || !(targetTons > 0)) {
    return { requiredHeadcount: null, caveats: [...caveats, "現在のパラメータでは一意に逆算できない。"] };
  }
  const requiredEffort = targetTons * coefficient;
  const maxEffort = model.companyBaselineCapacityTons + model.companyCapacityMaxIncrementTons;
  if (requiredEffort >= maxEffort) {
    return {
      requiredHeadcount: null,
      caveats: [...caveats, `必要な営業工数(${Math.round(requiredEffort)})が、この曲線の漸近上限(${Math.round(maxEffort)})に達しているため、人数を増やしても到達できない。`],
    };
  }
  // capacity(h) = base + inc·h/(h+k) を h について解く。
  const numerator = model.companyCapacitySaturationHeadcount * (requiredEffort - model.companyBaselineCapacityTons);
  const denominator = model.companyBaselineCapacityTons + model.companyCapacityMaxIncrementTons - requiredEffort;
  const h = numerator / denominator;
  return { requiredHeadcount: h > 0 ? Math.ceil(h) : 0, caveats };
}

export interface WorkerRequirementEstimate {
  readonly product: Product;
  readonly quantityTons: number;
  /** 常用Workerのみ・出勤率1・技能1・残業なしの基準ケース。 */
  readonly baseRegularHeadcount: number;
  /** 残業を上限まで使った場合。 */
  readonly withMaxOvertimeHeadcount: number;
  readonly appliedOvertimeRate: number;
  readonly effectiveTonsPerHead: number;
  readonly caveats: readonly string[];
}

/**
 * 「PD 1,000tを作るのに常用Worker何人か」の目安（実装指示§10）。
 * engine の requiredHeadcountForQuantity / effectiveEfficiencyPerHeadTons を
 * そのまま使う（新しい労務式をここで作らない）。
 */
export function estimateWorkerRequirement(
  quantityTons: number,
  product: Product,
  sources: GameKnowledgeParameterSources = DEFAULT_GAME_KNOWLEDGE_PARAMETERS
): WorkerRequirementEstimate {
  const production = sources.production;
  const base = production.labor.regularEfficiencyPerHeadTons;
  // 集中生産効果は計画数量に依存するため、目安では適用しない（適用すると
  // 「大きな計画を書くほど人が要らない」と誤解される。実際の必要人数は
  // 集中効果でこれより少なくなりうる、と caveat で伝える）。
  const efficiency = effectiveEfficiencyPerHeadTons(base, product, production);
  const overtimeCap = production.labor.overtimeRateCap;
  return {
    product,
    quantityTons,
    baseRegularHeadcount: Math.ceil(requiredHeadcountForQuantity(quantityTons, efficiency, 1, 1, 0, production)),
    withMaxOvertimeHeadcount: Math.ceil(requiredHeadcountForQuantity(quantityTons, efficiency, 1, 1, overtimeCap, production)),
    appliedOvertimeRate: overtimeCap,
    effectiveTonsPerHead: efficiency,
    caveats: [
      "出勤率100%・技能水準1.0・常用Workerのみの基準ケースである。実際の出勤率・技能・臨時Workerの比率で増減する。",
      "1商品へ生産を集中させると集中生産効果が働き、必要人数はこれより少なくなることがある。",
      "PD省人化投資が稼働している工場では、PDの必要人数がこれより少なくなる。",
      "Workerを揃えても、設備能力（商品ライン・共通前処理）が足りなければその量は作れない。",
    ],
  };
}
