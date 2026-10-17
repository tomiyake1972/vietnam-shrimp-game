// ShrimpX V2 — PLAYER-INTRO-1: 受講者向け「経営の基本目安」の組み立て
//
// 【このモジュールの責務】
// 受講者が人数・数量・費用をゼロから推測せずに計画できるよう、Engine が実際に
// 使っているパラメータと関数から「目安」を取り出して、画面がそのまま並べられる
// 形へ射影する。
//
// 【禁止事項（実装指示 §6・§8）】
//   - 新しい計算式・新しい係数をここで作らない。能力・費用の算出は必ず既存
//     Engine の関数（sales/salesForce.ts・sales/salesCapacityModel.ts・
//     production/labor.ts・companyLab/workforce.ts）を呼ぶ。
//   - 単価・係数をハードコードしない（parameters.ts が唯一の情報源）。
//   - 目安を成約・生産・借入の保証として表現しない（呼び出し側が文言で明示する）。
//   - 同じ能力を商品ごとに重複計上しない。営業能力は会社（×市場）で1つの
//     プールであり、商品別の数値は必ず「その商品だけを扱った場合」という
//     条件付きの値として返す（kind: "singleProductOnly"）。
//
// 【将来値を漏らさない】費用は呼び出し側が渡した FinanceParameters だけを使う。
// Player 画面は PlayerDecisionContext.costProjection.financeParameters（当Turnの
// 指数適用後の実効値）を渡す想定であり、このモジュールは Scenario registry にも
// 指数そのものにも触れない。

import { Product } from "../../market/types";
import { SalesParameters, SALES_PARAMETERS_V1 } from "../../sales/parameters";
import { processingCapacity } from "../../sales/salesForce";
import {
  SALES_CAPACITY_MODEL_PER_MARKET,
  companySalesOrganizationCapacity,
  marketFragmentationFactor,
} from "../../sales/salesCapacityModel";
import { unwrapUnit } from "../../core/units";
import { PRODUCTION_PARAMETERS_V1, ProductionParameters } from "../../production/parameters";
import { effectiveEfficiencyPerHeadTons, laborIntensityCoefficientFor } from "../../production/labor";
import { FINANCE_PARAMETERS_V1, FinanceParameters } from "../../finance/parameters";
import { computeQuarterlyLaborCost } from "../../companyLab/workforce";
import { computeMaxSalesHiresPerQuarter, MIN_SALES_HIRES_PER_QUARTER, SALES_HIRE_RAMP_RATIO } from "../../companyLab/salesForceHiring";

export const PRODUCTS_FOR_BASELINES: readonly Product[] = ["hoso", "pd", "vap"];

/** 値の性質。画面はこれを使って「基礎値」「現在の条件での目安」「上限」を言い分ける。 */
export type BaselineValueKind =
  /** parameters.ts の基準値そのもの（条件に依存しない）。 */
  | "baseParameter"
  /** いま選んでいる条件（現在人数・現在の費用指数・この工場）での目安。 */
  | "currentCondition"
  /** その商品だけを扱った場合の条件付き上限。他商品と同時には成立しない。 */
  | "singleProductOnly"
  /** 制度上の上限（これ以上は入力できない）。 */
  | "hardLimit";

export interface BaselineItem {
  readonly label: string;
  readonly value: number | null;
  readonly unit: string;
  readonly kind: BaselineValueKind;
  /** その値が成立する条件。null を返さず、条件が無いときは空文字ではなく明示的な説明を入れる。 */
  readonly condition: string;
  /** 値の出所（関数名 / パラメータ名）。報告書・監査で追跡できるようにする。 */
  readonly source: string;
}

// ---------------------------------------------------------------------
// A. 営業一人あたりの販売能力
// ---------------------------------------------------------------------

/** 商品ごとの「1人あたり何トン売れるか」。 */
export interface SalesPerProductBaseline {
  readonly product: Product;
  /** 営業1人あたりの目安（その商品だけを売った場合）。 */
  readonly perHeadTons: BaselineItem;
  /** いま1人増やしたときに増える量（その商品だけを売った場合）。 */
  readonly addedPerHeadTons: BaselineItem;
  /** 会社全体の目安（その商品だけを売った場合）。 */
  readonly companyTotalTons: BaselineItem;
  /** HOSO を 1 としたときの営業の手間。 */
  readonly effortRelativeToHoso: number;
}

export interface SalesBaselines {
  /** いま有効な営業能力モデルの種別（画面には出さない。監査・テスト用）。 */
  readonly capacityModelKind: string;
  readonly currentSalesHeadcount: number;
  /** 商品ごとの1人あたり目安。画面の主役はこれ。 */
  readonly byProduct: readonly SalesPerProductBaseline[];
  /** 営業人員が0人でも残る量（HOSO 換算の数量で表す）。 */
  readonly baselineTonsAtZeroHeadcount: BaselineItem;
  /**
   * 混ぜて売るときの考え方（受講者向けの1文）。
   * 「それぞれの目安に対する割合を足して100%以内」という形で説明する。
   * これは Engine の営業工数制約と数式として等価であり、新しい式ではない。
   */
  readonly mixedSalesRule: string;
}

/**
 * 営業能力の目安。
 *
 * 【重複計上しない設計】営業能力は「工数換算トン」という1つのプールであり、
 * 商品ごとに別のプールがあるわけではない。したがって商品別の値は
 * capacity ÷ effortCoefficient[product] として kind:"singleProductOnly" で返し、
 * 「HOSOの能力とPDの能力を同時に使える」という読み方ができないようにする。
 */
export function buildSalesBaselines(input: {
  readonly currentSalesHeadcount: number;
  /** 展開している市場数（companyWideWithFragmentation のときだけ効く）。 */
  readonly marketCount: number;
  readonly salesParams?: SalesParameters;
}): SalesBaselines {
  const params = input.salesParams ?? SALES_PARAMETERS_V1;
  const model = params.salesCapacityModel ?? SALES_CAPACITY_MODEL_PER_MARKET;
  const headcount = Math.max(0, Math.round(input.currentSalesHeadcount));
  const marketCount = Math.max(1, Math.round(input.marketCount));

  /**
   * 会社全体の営業能力。Engine と同じ関数だけを使う。
   * 戻り値の単位は Engine 内部の「営業工数換算トン」だが、
   * 画面へはこの単位のまま出さず、必ず商品別のトン数へ割り戻して見せる
   * （受講者向けに「工数」という言葉を使わない）。
   */
  const capacityAt = (h: number): number => {
    if (model.kind === "perMarket") {
      return unwrapUnit(processingCapacity(Math.max(0, Math.round(h)), params));
    }
    return companySalesOrganizationCapacity(h, model) * marketFragmentationFactor(marketCount, model);
  };

  const scopeNote =
    model.kind === "perMarket"
      ? "1つの市場に配員した場合の、その市場ぶんの目安です"
      : "会社全体の営業人員から決まる目安です（市場へは需要の大きさに応じて配分されます）";

  const current = capacityAt(headcount);
  const marginal = capacityAt(headcount + 1) - current;

  const byProduct = PRODUCTS_FOR_BASELINES.map((product): SalesPerProductBaseline => {
    const coefficient = params.salesEffortCoefficients[product];
    const companyTons = coefficient > 0 ? current / coefficient : null;
    const addedTons = coefficient > 0 ? marginal / coefficient : null;
    const perHeadTons = companyTons !== null && headcount > 0 ? companyTons / headcount : null;
    const onlyNote = `${productLabel(product)}だけを売った場合の値です。HOSO・PD・VAPは同じ営業人員を分け合うため、3つを足して同時には売れません。`;
    return {
      product,
      effortRelativeToHoso: coefficient,
      perHeadTons: {
        label: `営業1人あたり ${productLabel(product)} をどれだけ売れるか`,
        value: perHeadTons,
        unit: "t／人／四半期",
        kind: "singleProductOnly",
        condition:
          headcount > 0
            ? `いまの営業${headcount}人で売れる量を人数で割った平均です。${onlyNote}`
            : "営業人員が0人のため、1人あたりの値は計算できません。",
        source: "sales/salesCapacityModel.ts: companySalesOrganizationCapacity ÷ parameters.ts: salesEffortCoefficients ÷ 現在人数",
      },
      addedPerHeadTons: {
        label: `いま営業を1人増やすと ${productLabel(product)} をどれだけ多く売れるか`,
        value: addedTons,
        unit: "t／四半期／人",
        kind: "currentCondition",
        condition: `現在の${headcount}人から1人増やした場合。人数が増えるほど1人あたりの増分は小さくなります。${onlyNote}`,
        source: "sales/salesCapacityModel.ts の能力の差分 ÷ parameters.ts: salesEffortCoefficients",
      },
      companyTotalTons: {
        label: `会社全体で ${productLabel(product)} をどれだけ売れるか`,
        value: companyTons,
        unit: "t／四半期",
        kind: "singleProductOnly",
        condition: `${scopeNote}。${onlyNote}`,
        source: "sales/salesCapacityModel.ts: companySalesOrganizationCapacity ÷ parameters.ts: salesEffortCoefficients",
      },
    };
  });

  const hosoOnly = byProduct.find((b) => b.product === "hoso")?.companyTotalTons.value ?? null;

  return {
    capacityModelKind: model.kind,
    currentSalesHeadcount: headcount,
    byProduct,
    baselineTonsAtZeroHeadcount: {
      label: "営業人員が0人でも売れる量（HOSO の場合）",
      value: capacityAt(0),
      unit: "t／四半期",
      kind: "baseParameter",
      condition: "既存のお客さまぶんとして常に残る量です（新しい営業活動の成果ではありません）。",
      source: "sales/salesCapacityModel.ts / parameters.ts: salesForce.baselineCapacityTons",
    },
    mixedSalesRule:
      "複数の商品を売るときは、それぞれの目安に対する割合を足して100%以内に収まるか、で考えてください。" +
      `例えば ${productLabel("hoso")} をその目安の40%、${productLabel("pd")} をその目安の60%なら合計100%でちょうど一杯です。` +
      "100%を超えると、その市場の全商品が同じ比率で縮小されます。" +
      (hosoOnly !== null ? "" : ""),
  };
}

// ---------------------------------------------------------------------
// B. Worker一人あたりの生産能力
// ---------------------------------------------------------------------

export interface WorkerProductBaseline {
  readonly product: Product;
  readonly regularPerHead: BaselineItem;
  readonly temporaryPerHead: BaselineItem;
  readonly laborIntensityCoefficient: number;
}

export interface WorkerBaselines {
  readonly byProduct: readonly WorkerProductBaseline[];
  readonly overtimeRateCap: BaselineItem;
  readonly overtimeEfficiencyFactor: BaselineItem;
}

/**
 * Worker の1人あたり生産能力の目安。
 *
 * 【条件を必ず添える】返す値は「残業なし・その商品だけを担当した場合」の
 * 基準効率である。実際の生産量は設備・原料との最小値で決まるため、
 * 呼び出し側は「人数×能力＝必ず実生産量」と読めない文言を添える責務を持つ。
 *
 * 【工場条件を反映する】PD省人化投資などで工場ごとに係数が変わる場合は、
 * coefficientOverrideByProduct にその工場の実効係数を渡す
 * （値は companyLab/pdMechanizationState.ts が算出したものをそのまま渡す）。
 */
export function buildWorkerBaselines(input: {
  readonly productionParams?: ProductionParameters;
  /** 工場ごとの実効労働集約度係数の上書き（PD省人化投資など）。 */
  readonly coefficientOverrideByProduct?: Readonly<Partial<Record<Product, number>>>;
  /** 上書きがどの工場のものかを文言へ入れるための名前（省略時は会社標準として表示）。 */
  readonly factoryLabel?: string;
}): WorkerBaselines {
  const params = input.productionParams ?? PRODUCTION_PARAMETERS_V1;
  const scope = input.factoryLabel ? `${input.factoryLabel}の現在の設備条件` : "会社標準の設備条件";

  const byProduct = PRODUCTS_FOR_BASELINES.map((product): WorkerProductBaseline => {
    const override = input.coefficientOverrideByProduct?.[product];
    // 【式を再実装しない】1人あたり実効効率は production/labor.ts の正本関数だけが決める。
    const regular = effectiveEfficiencyPerHeadTons(params.labor.regularEfficiencyPerHeadTons, product, params, override);
    const temporary = effectiveEfficiencyPerHeadTons(params.labor.temporaryEfficiencyPerHeadTons, product, params, override);
    const baseCondition =
      `${scope}・残業なし・${productLabel(product)}だけを担当した場合の基準値です。` +
      "設備能力・原料が足りなければ、この人数ぶんを生産できるとはかぎりません。";
    return {
      product,
      laborIntensityCoefficient: override ?? laborIntensityCoefficientFor(product, params),
      regularPerHead: {
        label: `常用Worker 1人が${productLabel(product)}を生産できる量`,
        value: regular,
        unit: "t／人／四半期",
        kind: input.factoryLabel ? "currentCondition" : "baseParameter",
        condition: baseCondition,
        source: "production/labor.ts: effectiveEfficiencyPerHeadTons（parameters.ts: labor.regularEfficiencyPerHeadTons ÷ laborIntensityCoefficient）",
      },
      temporaryPerHead: {
        label: `臨時Worker 1人が${productLabel(product)}を生産できる量`,
        value: temporary,
        unit: "t／人／四半期",
        kind: input.factoryLabel ? "currentCondition" : "baseParameter",
        condition: baseCondition,
        source: "production/labor.ts: effectiveEfficiencyPerHeadTons（parameters.ts: labor.temporaryEfficiencyPerHeadTons ÷ laborIntensityCoefficient）",
      },
    };
  });

  return {
    byProduct,
    overtimeRateCap: {
      label: "残業率の上限",
      value: params.labor.overtimeRateCap,
      unit: "（基準労働時間に対する比率）",
      kind: "hardLimit",
      condition: "これを超える残業率を入力しても、ここで切り詰められます。",
      source: "production/parameters.ts: labor.overtimeRateCap",
    },
    overtimeEfficiencyFactor: {
      label: "残業1単位あたりの能力増加係数",
      value: params.labor.overtimeEfficiencyFactor,
      unit: "（倍）",
      kind: "baseParameter",
      condition: "残業率1.0に対して能力がこの係数ぶん増える線形近似です（残業しても時間ぶんそのままは増えません）。",
      source: "production/parameters.ts: labor.overtimeEfficiencyFactor",
    },
  };
}

// ---------------------------------------------------------------------
// C. 人を増減したときの影響（反映時期・上限・一時費用）
// ---------------------------------------------------------------------

export interface HeadcountChangeRule {
  readonly subject: "worker" | "salesForce";
  readonly label: string;
  /** 増減がいつ反映されるか。 */
  readonly effectiveTiming: string;
  /** 増員の上限（無い場合は null）。 */
  readonly hireLimitPerQuarter: BaselineItem | null;
  /** 減員の制限。 */
  readonly layoffRule: string;
  /** 増減そのものに伴う一時費用。 */
  readonly oneTimeCost: BaselineItem | null;
  /** モデル化していないことの明示。 */
  readonly notModeled: string;
}

export function buildHeadcountChangeRules(input: {
  readonly currentSalesHeadcount: number;
  readonly financeParams?: FinanceParameters;
}): readonly HeadcountChangeRule[] {
  const finance = input.financeParams ?? FINANCE_PARAMETERS_V1;
  const salesSalary = finance.sellingGeneralAdmin.salesForceSalaryUsdPerQuarter;
  const headcount = Math.max(0, Math.round(input.currentSalesHeadcount));

  return [
    {
      subject: "worker",
      label: "Worker（工場の作業者）",
      effectiveTiming:
        "入力した増減はその四半期の生産からすぐ反映されます（意思決定で入力するのは増減の差分で、総人数は四半期をまたいで引き継がれます）。",
      hireLimitPerQuarter: null,
      layoffRule: "減らす人数に制限はありません。総人数が0人を下回ることはありません。",
      oneTimeCost: null,
      notModeled:
        "採用費・解雇費・退職金・解雇人数の制限・採用後の教育期間・習熟度の変化・労使関係は、現在のエンジンではモデル化されていません。" +
        "そのため増減そのものに追加費用は発生しません。",
    },
    {
      subject: "salesForce",
      label: "営業人員",
      effectiveTiming:
        "その四半期には反映されません。増員・減員はいずれも次の四半期から営業能力と通常給与へ反映されます（採用は教育・引継ぎ、減員は退職手続きの期間として扱います）。",
      hireLimitPerQuarter: {
        label: "1四半期に増やせる営業人員の上限",
        value: computeMaxSalesHiresPerQuarter(headcount),
        unit: "人／四半期",
        kind: "hardLimit",
        condition: `max(${MIN_SALES_HIRES_PER_QUARTER}人, 現在の稼働営業人員${headcount}人 × ${SALES_HIRE_RAMP_RATIO}の切り上げ)。人数が増えるほど上限も上がります。`,
        source: "companyLab/salesForceHiring.ts: computeMaxSalesHiresPerQuarter",
      },
      layoffRule:
        "減らす人数に制限はありません（前期末人数で頭打ちになります）。増員と減員を同じ四半期に同時入力することはできません。",
      oneTimeCost: {
        label: "営業人員を減らしたときの退職金（1人あたり）",
        value: salesSalary * 2,
        unit: "USD／人（一度だけ）",
        kind: "currentCondition",
        condition:
          "営業1人あたり四半期給与の2四半期分を、減員を決めた四半期に一度だけ計上します。減員対象者はその四半期中は営業能力と通常給与に含まれたままです。",
        source: "finance/quarterClose.ts（営業人員退職金）× finance/parameters.ts: sellingGeneralAdmin.salesForceSalaryUsdPerQuarter",
      },
      notModeled: "採用の一時費用・自然退職（離職率）・営業1人あたりの習熟度は、現在のエンジンではモデル化されていません。",
    },
  ];
}

// ---------------------------------------------------------------------
// D. 人件費の目安
// ---------------------------------------------------------------------

/**
 * 常用Worker と 臨時Worker の金銭面の比較。
 *
 * 【なぜ単価だけでは判断できないか】臨時は1人あたりの四半期費用が安いが、
 * 1人あたりの生産量も少ない。したがって「1トン作るのにいくらかかるか」で
 * 比べないと、どちらが割安かは分からない。
 * ここで新しい計算式は作らず、既存の単価（finance/parameters.ts）と
 * 既存の1人あたり能力（production/labor.ts）を割るだけである。
 */
export interface WorkerTypeCostComparison {
  readonly workerType: "regular" | "temporary";
  readonly label: string;
  /** 1人あたり四半期費用。 */
  readonly costPerHead: BaselineItem;
  /** 1人あたり生産量（HOSO を担当した場合）。 */
  readonly tonsPerHead: BaselineItem;
  /** 1トン作るのにかかる人件費（費用 ÷ 生産量）。 */
  readonly costPerTon: BaselineItem;
  /** 金銭面でのその他の違い（受講者向けの短文）。 */
  readonly notes: readonly string[];
}

export interface LaborCostBaselines {
  readonly regularWorkerPerHead: BaselineItem;
  readonly temporaryWorkerPerHead: BaselineItem;
  readonly overtimePremiumFactor: BaselineItem;
  readonly salesForcePerHead: BaselineItem;
  readonly procurementPerHead: BaselineItem;
  /** 人数に関係なく発生する共通固定費（「一人あたり人件費」に混ぜない）。 */
  readonly headcountIndependentFixed: readonly BaselineItem[];
  /** いまの人数での人件費試算（残業費を含まない）。 */
  readonly currentQuarterEstimate: {
    readonly regularCostUsd: number;
    readonly temporaryCostUsd: number;
    readonly totalCostUsd: number;
    readonly excludesOvertime: true;
  };
  /** 常用 と 臨時 の金銭面の比較（1トンあたりで比べられるようにする）。 */
  readonly workerTypeComparison: readonly WorkerTypeCostComparison[];
  /** 費用指数が適用済みの値かどうか。呼び出し側がどちらを渡したかで決まる。 */
  readonly isIndexApplied: boolean;
}

/**
 * 人件費の目安。
 *
 * 【現在値を使う】financeParams には PlayerDecisionContext.costProjection.financeParameters
 * （当Turnの Scenario 費用指数を適用した実効値）を渡すこと。指数そのもの・将来Turnの
 * 値はこのモジュールへ渡さない（渡せる形にもしていない）。
 *
 * 【混ぜない】工場固定費・管理固定費は人数に依存しないため headcountIndependentFixed
 * へ分離し、「一人あたり人件費」としては返さない。
 */
export function buildLaborCostBaselines(input: {
  readonly currentRegularHeadcount: number;
  readonly currentTemporaryHeadcount: number;
  readonly financeParams?: FinanceParameters;
  /** 1トンあたり人件費の比較に使う生産パラメータ。 */
  readonly productionParams?: ProductionParameters;
  /** financeParams が当Turnの指数適用後の値なら true。基準値をそのまま渡した場合は false。 */
  readonly isIndexApplied: boolean;
}): LaborCostBaselines {
  const finance = input.financeParams ?? FINANCE_PARAMETERS_V1;
  const kind: BaselineValueKind = input.isIndexApplied ? "currentCondition" : "baseParameter";
  const conditionSuffix = input.isIndexApplied
    ? "このTurnに実際に適用される値です（シナリオの費用指数を適用済み）。"
    : "シナリオの費用指数を適用していない基準値です。このTurnの実際の値は未取得です。";

  // 【式を再実装しない】人数×単価の試算は companyLab/workforce.ts の正本を使う。
  const estimate = computeQuarterlyLaborCost(input.currentRegularHeadcount, input.currentTemporaryHeadcount, finance);

  /**
   * 【1トンあたりで比べる】能力は HOSO を担当した場合の基準値を使う
   * （商品を固定しないと比較にならないため、条件として明示する）。
   * 能力そのものは production/labor.ts の正本関数から取る。
   */
  const productionParams = input.productionParams ?? PRODUCTION_PARAMETERS_V1;
  const regularTons = effectiveEfficiencyPerHeadTons(productionParams.labor.regularEfficiencyPerHeadTons, "hoso", productionParams);
  const temporaryTons = effectiveEfficiencyPerHeadTons(productionParams.labor.temporaryEfficiencyPerHeadTons, "hoso", productionParams);
  const regularCost = finance.labor.regularWorkerSalaryUsdPerQuarter;
  const temporaryCost = finance.labor.temporaryWorkerCostUsdPerQuarter;

  const comparisonCondition = "HOSO を担当した場合・残業なしの基準値どうしの比較です。";

  const workerTypeComparison: readonly WorkerTypeCostComparison[] = [
    {
      workerType: "regular",
      label: "常用Worker",
      costPerHead: {
        label: "1人あたり四半期費用",
        value: regularCost,
        unit: "USD／人／四半期",
        kind,
        condition: `社会保険等込みの給与です。${conditionSuffix}`,
        source: "finance/parameters.ts: labor.regularWorkerSalaryUsdPerQuarter",
      },
      tonsPerHead: {
        label: "1人あたり生産量",
        value: regularTons,
        unit: "t／人／四半期",
        kind: "baseParameter",
        condition: comparisonCondition,
        source: "production/labor.ts: effectiveEfficiencyPerHeadTons（labor.regularEfficiencyPerHeadTons）",
      },
      costPerTon: {
        label: "1トンあたりの人件費",
        value: regularTons > 0 ? regularCost / regularTons : null,
        unit: "USD／t",
        kind,
        condition: comparisonCondition,
        source: "上記2行の割り算（新しい係数は使っていません）",
      },
      notes: [
        "工場へ配置しなかった人の給与も、そのまま満額かかります（遊休労務費）。減らさないかぎり固定的に出ていく費用です。",
        "残業をさせられるのは常用Workerだけです。残業費は 給与 × 残業率 × 割増係数 で計算します。",
        "人数は四半期をまたいで引き継がれ、増減はその四半期からすぐ反映されます。増減そのものに追加費用はかかりません。",
      ],
    },
    {
      workerType: "temporary",
      label: "臨時Worker",
      costPerHead: {
        label: "1人あたり四半期費用",
        value: temporaryCost,
        unit: "USD／人／四半期",
        kind,
        condition: `契約の単位は四半期です（時間給ではありません）。${conditionSuffix}`,
        source: "finance/parameters.ts: labor.temporaryWorkerCostUsdPerQuarter",
      },
      tonsPerHead: {
        label: "1人あたり生産量",
        value: temporaryTons,
        unit: "t／人／四半期",
        kind: "baseParameter",
        condition: comparisonCondition,
        source: "production/labor.ts: effectiveEfficiencyPerHeadTons（labor.temporaryEfficiencyPerHeadTons）",
      },
      costPerTon: {
        label: "1トンあたりの人件費",
        value: temporaryTons > 0 ? temporaryCost / temporaryTons : null,
        unit: "USD／t",
        kind,
        condition: comparisonCondition,
        source: "上記2行の割り算（新しい係数は使っていません）",
      },
      notes: [
        "その四半期に使った人数ぶんだけかかります（配置しなければ発生しません）。",
        "残業はできません。",
        "1人あたりの単価は常用より安いぶん、1人あたりの生産量も少なくなります。",
      ],
    },
  ];

  return {
    workerTypeComparison,
    regularWorkerPerHead: {
      label: "常用Worker 1人あたり四半期費用",
      value: finance.labor.regularWorkerSalaryUsdPerQuarter,
      unit: "USD／人／四半期",
      kind,
      condition: `社会保険等込みの給与です。工場へ配置されなかった常用Workerの分も遊休労務費として同じ単価で発生します。${conditionSuffix}`,
      source: "finance/parameters.ts: labor.regularWorkerSalaryUsdPerQuarter",
    },
    temporaryWorkerPerHead: {
      label: "臨時Worker 1人あたり四半期費用",
      value: finance.labor.temporaryWorkerCostUsdPerQuarter,
      unit: "USD／人／四半期",
      kind,
      condition: `契約の単位は四半期です（時間給ではありません）。${conditionSuffix}`,
      source: "finance/parameters.ts: labor.temporaryWorkerCostUsdPerQuarter",
    },
    overtimePremiumFactor: {
      label: "残業の割増係数",
      value: finance.labor.overtimePremiumFactor,
      unit: "（倍）",
      kind: "baseParameter",
      condition: "残業費 = 常用Worker給与 × 適用された残業率 × この係数。残業率は実績が確定するまで決まらないため、人件費の試算には含めていません。",
      source: "finance/parameters.ts: labor.overtimePremiumFactor",
    },
    salesForcePerHead: {
      label: "営業 1人あたり四半期費用",
      value: finance.sellingGeneralAdmin.salesForceSalaryUsdPerQuarter,
      unit: "USD／人／四半期",
      kind: "baseParameter",
      condition:
        "営業人員の給与単価には、シナリオの費用指数（常用労務・臨時労務）は適用されません。常用Workerの単価とは別の扱いです。",
      source: "finance/parameters.ts: sellingGeneralAdmin.salesForceSalaryUsdPerQuarter",
    },
    procurementPerHead: {
      label: "調達担当 1人あたり四半期費用",
      value: finance.sellingGeneralAdmin.procurementSalaryUsdPerQuarter,
      unit: "USD／人／四半期",
      kind: "baseParameter",
      condition: "営業人員と同じく、シナリオの費用指数は適用されません。",
      source: "finance/parameters.ts: sellingGeneralAdmin.procurementSalaryUsdPerQuarter",
    },
    headcountIndependentFixed: [
      {
        label: "管理固定費（人数に関係なく発生）",
        value: finance.sellingGeneralAdmin.adminFixedUsdPerQuarter,
        unit: "USD／四半期",
        kind,
        condition: `人数を減らしても減りません。「一人あたり人件費」には含めないでください。${conditionSuffix}`,
        source: "finance/parameters.ts: sellingGeneralAdmin.adminFixedUsdPerQuarter",
      },
      {
        label: "工場固定費（1工場あたり・人数に関係なく発生）",
        value: finance.manufacturing.factoryFixedCostUsdPerQuarter,
        unit: "USD／工場／四半期",
        kind,
        condition: `賃借・保全・工場管理です。稼働している工場の数で決まり、Workerの人数では変わりません。${conditionSuffix}`,
        source: "finance/parameters.ts: manufacturing.factoryFixedCostUsdPerQuarter",
      },
    ],
    currentQuarterEstimate: {
      regularCostUsd: estimate.regularCostUsd,
      temporaryCostUsd: estimate.temporaryCostUsd,
      totalCostUsd: estimate.totalCostUsd,
      excludesOvertime: true,
    },
    isIndexApplied: input.isIndexApplied,
  };
}

// ---------------------------------------------------------------------
// 共通
// ---------------------------------------------------------------------

export function productLabel(product: Product): string {
  if (product === "hoso") return "HOSO";
  if (product === "pd") return "PD";
  return "VAP";
}
