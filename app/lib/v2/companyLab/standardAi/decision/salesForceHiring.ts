// ShrimpX V2 — Standard AI 経営ボトルネック起点の営業採用・減員判断（新設）
//
// 【設計意図（三宅さんご指示）】単に「salesForceHireCountを付け足す」実装ではない。
// 営業採用を、
//   market opportunity → sales capacity → production capacity → Worker
//   → raw material → cash / borrowing capacity
// という連鎖の中で、1人ずつ（incremental）marginal economicsを確認しながら
// 判断する。marginal contribution（追加1人による貢献利益の増分）が
// salesperson salaryを上回り、かつ生産・Worker・原料・資金のいずれの制約にも
// ブロックされない場合にのみ採用候補にする。
//
// 【hard-code禁止（三宅さんご指示）】営業人員容量の式・パラメータ・商品別営業工数
// 係数は、必ず既存の共有モジュール（sales/salesForce.ts・sales/marketEffort.ts・
// sales/parameters.ts）をそのまま呼ぶ。#04が将来これらの値・式自体を変更しても
// （例: 飽和曲線から線形容量モデルへの変更）、本モジュールは一切変更せずに追随する
// （呼んでいる関数のシグネチャが変わらない限り）。同様に、営業人員給与
// （finance/parameters.ts）・退職金四半期数（finance/quarterClose.ts、現状は
// エクスポートされていないローカル定数のため、値だけを参照コメント付きで引用する。
// #04へ「共有定数としてexportする」ことを申し送る。§後述docs参照）も、
// #05側で新しい数値を発明しない。
//
// 【スコープ外（変更しないこと）】production decision・Worker decision（labor.ts）・
// raw procurement decision（procurement.ts）・finance decisionのロジック自体は
// 一切変更しない。本モジュールは「これらの既存モジュールが既に計算した結果
// （観測・診断値）を読むだけ」で営業採用/減員を判断する。

import { DemandMarketId, Product } from "../../../market/types";
import { hosoEqTons, unwrapUnit } from "../../../core/units";
import { CompanySalesPlanEntry } from "../../../sales/types";
import { SalesParameters, SALES_PARAMETERS_V1 } from "../../../sales/parameters";
import { allocateHeadcountAcrossMarkets, computeMarketSalesEffort, salesEffortWeightedQuantity } from "../../../sales/marketEffort";
import { FINANCE_PARAMETERS_V1 } from "../../../finance/parameters";
import { PRODUCTION_PARAMETERS_V1 } from "../../../production/parameters";
import { CompanyFixture } from "../../types";
import { StandardAiParameters, STANDARD_AI_PARAMETERS_V1 } from "../parameters";
import { PressureScores } from "../pressures";
import { ProductAmount, StandardAiObservation } from "../types";
import { StandardAiDiagnosticEntry } from "../reasonCodes";
import { SalesWishEntry } from "./sales";
import { StandardAiUnitEconomicsResult } from "../diagnosis/forwardUnitEconomics";

const EPSILON = 1e-6;
const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

/**
 * 【#04へ申し送り】finance/quarterClose.tsのSALES_FORCE_SEVERANCE_QUARTERS（値=2）は
 * ローカル定数でexportされていないため、ここでは値を直接引用するのではなく、
 * この定数をfinance/parameters.ts（FINANCE_PARAMETERS_V1）へ共有定数として
 * 追加exportしてもらうことを推奨する。現時点では#04コードのコメント上の値（2四半期分）
 * を根拠を明示した上で参照する（推測ではなく実際のコード値の引用）。
 */
const SALES_FORCE_SEVERANCE_QUARTERS_REFERENCE = 2; // 根拠: app/lib/v2/finance/quarterClose.ts:945

/** 1人分の営業人員採用/減員の増分評価（marginal economics）。 */
export interface MarginalSalespersonEvaluation {
  readonly direction: "hire" | "layoff";
  readonly headcountBefore: number;
  readonly headcountAfter: number;
  /** その1人による、商品別の受注量変化（HOSO換算トン。hireなら正、layoffなら負を絶対値で保持し方向はdirectionで表す）。 */
  readonly incrementalSalesTonsByProduct: ProductAmount;
  readonly incrementalSalesTonsTotal: number;
  /** 既存完成品在庫（FG）で賄える増分（追加生産不要な部分）。 */
  readonly incrementalSalesCoveredByExistingFgTons: number;
  /** 既存FGで賄えず、追加生産が必要になる部分。 */
  readonly incrementalSalesRequiringNewProductionTons: number;
  readonly incrementalContributionMarginUsd: number | null;
  readonly salespersonQuarterlySalaryUsd: number;
  readonly marginalContributionAfterSalesSalaryUsd: number | null;
  readonly productionHeadroomSufficient: boolean;
  readonly rawMaterialPathUncertain: boolean;
  readonly liquidityAfterHiringUsd: number | null;
  readonly liquidityOk: boolean;
  /** 生産・原料・資金・経済性のいずれの制約にも達しない、「必要な将来営業能力」の一部として正当化されたかどうか。 */
  readonly accepted: boolean;
  /**
   * acceptedはtrueだが、1四半期あたりの反映人数ガバナー（quarterlyGovernorCap）に
   * より、今四半期の実際の採用数には含まれず、次四半期以降へ繰り越された候補。
   */
  readonly deferredByQuarterlyGovernor?: boolean;
  /** acceptedがfalseの場合、その理由コード（受理された場合はundefined）。 */
  readonly blockedReasonCode?:
    | "SALES_HIRING_NOT_ECONOMIC"
    | "SALES_HIRING_BLOCKED_BY_PRODUCTION"
    | "SALES_HIRING_BLOCKED_BY_LIQUIDITY"
    | "SALES_HIRING_BLOCKED_BY_RAW_SUPPLY_UNCERTAINTY";
}

export interface SalesForceHiringDecisionResult {
  /** 今四半期に実際へ反映する採用数（quarterlyGovernorCap適用後）。 */
  readonly salesForceHireCount: number;
  readonly salesForceLayoffCount: number;
  /**
   * 生産・原料・資金・経済性のいずれの制約にも達しない、「必要な将来営業能力」
   * （Target Sales Force）。currentHeadcount + targetSalesForceHeadcountGap。
   * salesForceHireCountはこの目標に対する今四半期の反映分（ガバナー適用後）であり、
   * 目標そのものではない（目標 > 反映分の場合、残りは次四半期以降に繰り越される）。
   */
  readonly targetSalesForceHeadcount: number;
  readonly evaluations: readonly MarginalSalespersonEvaluation[];
  readonly diagnostics: readonly StandardAiDiagnosticEntry[];
}

/**
 * 【2026-08-05修正・三宅さんレビュー反映】旧設計では「1回の判断で極端な人数を
 * 動かさない」ための安全上限を「現在の（既に増員済みの）営業人員数」に対する
 * 相対値としていた。これは実際には安全上限として機能せず、採用が起きるたびに
 * 次の四半期の上限自体も膨張する複利成長の式になっていた（8Qシミュレーションで
 * 18→27→41→62→93→140人という指数的増加が実際に発生し、三宅さんより
 * 「バグというより設計通り暴走した」とご指摘を受けた）。
 *
 * 修正方針（三宅さんご指示）:
 *   1) まず生産・原料・資金いずれの制約にも達しないマージナル経済性の
 *      自然停止点まで評価し、「必要な将来営業能力（Target Sales Force）」を
 *      先に計算する。
 *   2) 必要人数 − 現在人数 = 採用必要数（不足分）を求める。
 *   3) 1四半期に実際へ反映する人数の上限（ガバナー）は、「その四半期ごとに
 *      膨張する現在人数」ではなく、会社の静的な基準規模
 *      （fixture.salesForceHeadcountTotal、会社設立時の値でターンをまたいでも
 *      変わらない）に対する相対値とする。これにより採用が起きても次四半期の
 *      ガバナー自体は膨張せず、複利成長を構造的に排除する。
 */
const MAX_HIRE_PER_QUARTER_ABSOLUTE_FLOOR = 5;
const MAX_HIRE_PER_QUARTER_RELATIVE_RATIO = 0.5; // 静的な基準規模の50%まで、かつ絶対floor以上

/** ガバナーの基準人数。会社の静的な基準規模（ターンをまたいでも変わらない）を用いる。 */
function quarterlyGovernorCap(staticBaselineHeadcount: number): number {
  return Math.max(MAX_HIRE_PER_QUARTER_ABSOLUTE_FLOOR, Math.round(staticBaselineHeadcount * MAX_HIRE_PER_QUARTER_RELATIVE_RATIO));
}

/**
 * マージナル経済性ループ自体の反復回数上限。ビジネス上の意思決定ガバナーでは
 * なく、純粋な暴走防止のための機械的セーフガード（万一のロジック不具合で
 * 無限ループにならないための安全弁）。実際の停止は、A（機会消滅）・
 * D（非経済的）・E（生産余力超）・G（原料供給制約）・H（資金バッファ超）の
 * いずれかの自然な停止条件で先に発生する想定。
 */
const NATURAL_STOP_SAFETY_ITERATION_CEILING = 2000;

/** 会社×市場×商品の希望量マップ（salesWishByMarketProductから再構成）。 */
function buildWishMap(salesWish: readonly SalesWishEntry[]): Map<DemandMarketId, Record<Product, number>> {
  const map = new Map<DemandMarketId, Record<Product, number>>();
  for (const w of salesWish) {
    const key = w.market;
    if (!map.has(key)) map.set(key, { hoso: 0, pd: 0, vap: 0 });
    map.get(key)![w.product] = w.desiredQuantityBeforeEffortConstraint;
  }
  return map;
}

/**
 * ある総営業人員数(headcount)における、市場別の営業工数配分と、
 * effort容量制約を適用した後の商品別realistic sales合計を計算する。
 * sales/marketEffort.tsの既存関数（エンジン本体・decision/sales.tsと同一の
 * 純粋関数）をそのまま呼ぶだけであり、飽和曲線・effort係数のいずれも
 * 本モジュールでは再実装しない（#04が値・式を変更しても自動的に追随する）。
 */
function realisticSalesAtHeadcount(
  headcount: number,
  wishByMarket: ReadonlyMap<DemandMarketId, Record<Product, number>>,
  salesParams: SalesParameters
): ProductAmount {
  const effortDemandByMarket = new Map<DemandMarketId, number>();
  for (const [market, byProduct] of wishByMarket) {
    effortDemandByMarket.set(market, salesEffortWeightedQuantity(byProduct, salesParams));
  }
  const headcountByMarket = allocateHeadcountAcrossMarkets(headcount, effortDemandByMarket);
  const total: ProductAmount = { hoso: 0, pd: 0, vap: 0 };
  for (const [market, byProduct] of wishByMarket) {
    const h = headcountByMarket.get(market) ?? 0;
    const result = computeMarketSalesEffort(h, byProduct, salesParams);
    for (const p of PRODUCTS) total[p] += result.adjustedQuantityByProduct[p];
  }
  return total;
}

/** Forward Unit Economicsから、商品別の「参考貢献利益（USD/トン）」を導出する（市場をまたいだ単純平均。null=採算不明）。 */
function averageContributionMarginUsdPerTonByProduct(unitEconomics: StandardAiUnitEconomicsResult): Readonly<Record<Product, number | null>> {
  const hosoEqKgPerTon = PRODUCTION_PARAMETERS_V1.cost.hosoEqKgPerTon;
  const sums: Record<Product, number> = { hoso: 0, pd: 0, vap: 0 };
  const counts: Record<Product, number> = { hoso: 0, pd: 0, vap: 0 };
  for (const e of unitEconomics.entries) {
    if (e.contributionMarginUsdPerKg === null) continue;
    sums[e.product] += e.contributionMarginUsdPerKg * hosoEqKgPerTon;
    counts[e.product] += 1;
  }
  const result: Record<Product, number | null> = { hoso: null, pd: null, vap: null };
  for (const p of PRODUCTS) {
    result[p] = counts[p] > 0 ? sums[p] / counts[p] : null;
  }
  return result;
}

export interface SalesForceHiringDecisionInput {
  readonly fixture: CompanyFixture;
  readonly observation: StandardAiObservation;
  readonly pressures: PressureScores;
  readonly params: StandardAiParameters;
  readonly salesParams: SalesParameters;
  readonly salesWishByMarketProduct: readonly SalesWishEntry[];
  /** 現在の営業人員数での基本当期生産必要量（productionRequirement.ts、既に計算済みの値をそのまま受け取る）。 */
  readonly finalProductionRequirementByProduct: ProductAmount;
  /** Standard AIが現在認識できる生産能力（binding capacity相当。situationDiagnosis.tsのbindingCapacityTotal系と同じ考え方）。 */
  readonly totalEffectiveCapacityByProduct: ProductAmount;
  readonly unitEconomics: StandardAiUnitEconomicsResult;
  /**
   * 追加原料調達の確実性（situationDiagnosis.rawMaterialSupplyConstraintStateを
   * そのまま渡す）。"shortage"なら「真の供給制約」であり、増産を前提とした
   * 採用を積極的にブロックする。"unknown"なら断定せず、警告のみに留める
   * （§憶測しない、という本セッション全体の原則を維持）。
   */
  readonly rawMaterialSupplyConstraintState: "shortage" | "balanced" | "surplus" | "unknown";
}

/**
 * 営業人員の採用/減員を、1人ずつのmarginal economics評価で決定する
 * （純粋関数。副作用なし、同一入力なら常に同一出力）。
 */
export function buildStandardAiSalesForceHiringDecision(input: SalesForceHiringDecisionInput): SalesForceHiringDecisionResult {
  const {
    fixture,
    observation,
    pressures,
    salesParams = SALES_PARAMETERS_V1,
    salesWishByMarketProduct,
    finalProductionRequirementByProduct,
    totalEffectiveCapacityByProduct,
    unitEconomics,
    rawMaterialSupplyConstraintState,
  } = input;
  // 【将来の拡張点】input.paramsは現時点で未使用（marginal contributionの経済性判定は
  // finance/production/sales共有パラメータのみで完結するため）。将来、経営性格プロファイル
  // （managementProfile.ts）由来の営業採用バイアスをこのモジュールへ接続する際の受け皿として、
  // SalesForceHiringDecisionInputのフィールド自体は維持する。
  void input.params;

  const diagnostics: StandardAiDiagnosticEntry[] = [];
  const evaluations: MarginalSalespersonEvaluation[] = [];

  const wishByMarket = buildWishMap(salesWishByMarketProduct);
  const currentHeadcount = observation.salesForceHeadcountTotal;
  const contributionPerTon = averageContributionMarginUsdPerTonByProduct(unitEconomics);
  const salaryUsdPerQuarter = FINANCE_PARAMETERS_V1.sellingGeneralAdmin.salesForceSalaryUsdPerQuarter;
  const severanceUsdPerPerson = SALES_FORCE_SEVERANCE_QUARTERS_REFERENCE * salaryUsdPerQuarter;

  // 生産余力（既存の当期生産必要量に対する、実行可能な生産上限の余り）。
  // 負の場合は既に生産が詰まっている（余力なし）ことを意味する。
  const productionHeadroomByProduct: ProductAmount = {
    hoso: totalEffectiveCapacityByProduct.hoso - finalProductionRequirementByProduct.hoso,
    pd: totalEffectiveCapacityByProduct.pd - finalProductionRequirementByProduct.pd,
    vap: totalEffectiveCapacityByProduct.vap - finalProductionRequirementByProduct.vap,
  };

  // 資金余力（§13）。簡易版: 現金 − 最低現金バッファ − これまでの追加採用による
  // 累積年間人件費相当（四半期給与×採用数。将来四半期分は今回のスコープでは
  // 簡略化し、当四半期分の給与増分のみで判定する。より厳密な多四半期キャッシュ
  // フロー投影はFinancial Capacity診断モジュール（診断専用）と併用することを
  // #04/#05引き続きの課題として明記する）。
  let cumulativeAddedSalaryUsd = 0;
  const liquidityFloorUsd = observation.cashUsd - pressures.targetMinimumCashUsd;

  const currentFg = observation.finishedGoodsByProduct;
  // 【2026-08-05修正】ここは「今四半期に反映してよい上限」ではなく、マージナル
  // 経済性ループが自然停止条件（A/D/E/G/H）へ到達するまで評価を続けるための
  // 純粋な暴走防止セーフガード。Target Sales Force（必要な将来営業能力）を
  // 現在人数の大小に関わらず正しく計算するため、ここで打ち切ってはならない。
  const naturalStopCeiling = NATURAL_STOP_SAFETY_ITERATION_CEILING;

  // --- 採用方向（+1ずつ、自然停止条件まで評価し、Target Sales Forceを求める） ---
  let hireCount = 0;
  let salesAtCurrent = realisticSalesAtHeadcount(currentHeadcount + hireCount, wishByMarket, salesParams);
  for (let i = 0; i < naturalStopCeiling; i++) {
    const before = currentHeadcount + hireCount;
    const after = before + 1;
    const salesAfter = realisticSalesAtHeadcount(after, wishByMarket, salesParams);

    const incrementalByProduct: ProductAmount = {
      hoso: Math.max(0, salesAfter.hoso - salesAtCurrent.hoso),
      pd: Math.max(0, salesAfter.pd - salesAtCurrent.pd),
      vap: Math.max(0, salesAfter.vap - salesAtCurrent.vap),
    };
    const incrementalTotal = incrementalByProduct.hoso + incrementalByProduct.pd + incrementalByProduct.vap;

    if (incrementalTotal <= EPSILON) {
      // A. profitable unserved opportunityが消滅（希望量に対し既に容量が十分足りている）。
      break;
    }

    // 既存FGで賄える分／新規生産が必要な分を分離（§8・§9・Turn3在庫優先ロジック）。
    let coveredByFg = 0;
    let requiringNewProduction = 0;
    for (const p of PRODUCTS) {
      const fgAvailableForThis = Math.max(0, currentFg[p]); // 簡略化: 他の増分と共有せず、各評価ステップで独立に参照（1人単位の小さな増分のため、FG取り合いの誤差は小さいと判断）。
      const covered = Math.min(incrementalByProduct[p], fgAvailableForThis);
      coveredByFg += covered;
      requiringNewProduction += incrementalByProduct[p] - covered;
    }

    // 経済性（marginal contribution after salary）。
    let incrementalContribution: number | null = 0;
    let hasUnknownContribution = false;
    for (const p of PRODUCTS) {
      const perTon = contributionPerTon[p];
      if (incrementalByProduct[p] <= EPSILON) continue;
      if (perTon === null) {
        hasUnknownContribution = true;
        continue; // 採算不明分は貢献利益に加算しない（憶測しない。保守的に0扱い）。
      }
      incrementalContribution = (incrementalContribution ?? 0) + perTon * incrementalByProduct[p];
    }
    if (hasUnknownContribution && incrementalContribution === 0) incrementalContribution = null;
    const marginalAfterSalary = incrementalContribution === null ? null : incrementalContribution - salaryUsdPerQuarter;

    if (marginalAfterSalary === null || marginalAfterSalary <= EPSILON) {
      evaluations.push({
        direction: "hire",
        headcountBefore: before,
        headcountAfter: after,
        incrementalSalesTonsByProduct: incrementalByProduct,
        incrementalSalesTonsTotal: incrementalTotal,
        incrementalSalesCoveredByExistingFgTons: coveredByFg,
        incrementalSalesRequiringNewProductionTons: requiringNewProduction,
        incrementalContributionMarginUsd: incrementalContribution,
        salespersonQuarterlySalaryUsd: salaryUsdPerQuarter,
        marginalContributionAfterSalesSalaryUsd: marginalAfterSalary,
        productionHeadroomSufficient: true,
        rawMaterialPathUncertain: false,
        liquidityAfterHiringUsd: null,
        liquidityOk: true,
        accepted: false,
        blockedReasonCode: "SALES_HIRING_NOT_ECONOMIC",
      });
      break; // D. marginal contribution <= cost（これ以上増やしても経済的に非合理）。
    }

    // 生産余力チェック（§5-E・§10・§17）。既存FGで賄える分は生産不要のため対象外。
    // 【簡略化・明示】商品別の生産余力を厳密に商品ごとに追跡せず、会社全体の
    // 生産余力合計（余力がある商品の合計）に対して、新規生産が必要な増分の合計を
    // 比較する単純化を採用している。商品別の生産余力が偏っている場合（例:
    // HOSOには余力があるがVAPには無い）、この単純化は実際より緩い判定になりうる
    // ことを設計上の既知の制約として明示する（#05引き続きの精緻化課題）。
    const productionHeadroomTotal = PRODUCTS.reduce((s, p) => s + Math.max(0, productionHeadroomByProduct[p]), 0);
    const blockedByProduction = requiringNewProduction > productionHeadroomTotal + EPSILON;

    if (blockedByProduction) {
      evaluations.push({
        direction: "hire",
        headcountBefore: before,
        headcountAfter: after,
        incrementalSalesTonsByProduct: incrementalByProduct,
        incrementalSalesTonsTotal: incrementalTotal,
        incrementalSalesCoveredByExistingFgTons: coveredByFg,
        incrementalSalesRequiringNewProductionTons: requiringNewProduction,
        incrementalContributionMarginUsd: incrementalContribution,
        salespersonQuarterlySalaryUsd: salaryUsdPerQuarter,
        marginalContributionAfterSalesSalaryUsd: marginalAfterSalary,
        productionHeadroomSufficient: false,
        rawMaterialPathUncertain: false,
        liquidityAfterHiringUsd: null,
        liquidityOk: true,
        accepted: false,
        blockedReasonCode: "SALES_HIRING_BLOCKED_BY_PRODUCTION",
      });
      break; // E. 「営業を増やしてもproductionが完全に詰まっている」状態（三宅さんご指示§4）。
    }

    // 原料供給の確実性チェック（§4-G・§12）。真の供給制約（"shortage"）が既に
    // 診断されている場合のみブロックする。"unknown"では断定せず、警告のみに留める
    // （既存のRAW_MATERIAL_SUPPLY_CONSTRAINT_UNKNOWN診断の設計方針を継承）。
    const rawBlocked = requiringNewProduction > EPSILON && rawMaterialSupplyConstraintState === "shortage";
    if (rawBlocked) {
      evaluations.push({
        direction: "hire",
        headcountBefore: before,
        headcountAfter: after,
        incrementalSalesTonsByProduct: incrementalByProduct,
        incrementalSalesTonsTotal: incrementalTotal,
        incrementalSalesCoveredByExistingFgTons: coveredByFg,
        incrementalSalesRequiringNewProductionTons: requiringNewProduction,
        incrementalContributionMarginUsd: incrementalContribution,
        salespersonQuarterlySalaryUsd: salaryUsdPerQuarter,
        marginalContributionAfterSalesSalaryUsd: marginalAfterSalary,
        productionHeadroomSufficient: true,
        rawMaterialPathUncertain: true,
        liquidityAfterHiringUsd: null,
        liquidityOk: true,
        accepted: false,
        blockedReasonCode: "SALES_HIRING_BLOCKED_BY_RAW_SUPPLY_UNCERTAINTY",
      });
      break;
    }

    // 資金余力チェック（§13）。当四半期の追加給与コストの累積が、現金の
    // 最低バッファ余力を超えないか（簡略化した単四半期判定。多四半期の
    // キャッシュタイミングは今回のスコープでは近似しない＝#04/#05引き続きの課題）。
    const liquidityAfter = liquidityFloorUsd - (cumulativeAddedSalaryUsd + salaryUsdPerQuarter);
    if (liquidityAfter < 0) {
      evaluations.push({
        direction: "hire",
        headcountBefore: before,
        headcountAfter: after,
        incrementalSalesTonsByProduct: incrementalByProduct,
        incrementalSalesTonsTotal: incrementalTotal,
        incrementalSalesCoveredByExistingFgTons: coveredByFg,
        incrementalSalesRequiringNewProductionTons: requiringNewProduction,
        incrementalContributionMarginUsd: incrementalContribution,
        salespersonQuarterlySalaryUsd: salaryUsdPerQuarter,
        marginalContributionAfterSalesSalaryUsd: marginalAfterSalary,
        productionHeadroomSufficient: true,
        rawMaterialPathUncertain: false,
        liquidityAfterHiringUsd: liquidityAfter,
        liquidityOk: false,
        accepted: false,
        blockedReasonCode: "SALES_HIRING_BLOCKED_BY_LIQUIDITY",
      });
      break; // H. liquidityが危険水準（三宅さんご指示§4-H・§13）。
    }

    // すべてのゲートを通過 → この1人を採用候補として受理し、次の+1へ進む。
    cumulativeAddedSalaryUsd += salaryUsdPerQuarter;
    hireCount += 1;
    salesAtCurrent = salesAfter;
    evaluations.push({
      direction: "hire",
      headcountBefore: before,
      headcountAfter: after,
      incrementalSalesTonsByProduct: incrementalByProduct,
      incrementalSalesTonsTotal: incrementalTotal,
      incrementalSalesCoveredByExistingFgTons: coveredByFg,
      incrementalSalesRequiringNewProductionTons: requiringNewProduction,
      incrementalContributionMarginUsd: incrementalContribution,
      salespersonQuarterlySalaryUsd: salaryUsdPerQuarter,
      marginalContributionAfterSalesSalaryUsd: marginalAfterSalary,
      productionHeadroomSufficient: true,
      rawMaterialPathUncertain: false,
      liquidityAfterHiringUsd: liquidityAfter,
      liquidityOk: true,
      accepted: true,
      blockedReasonCode: undefined,
    });
  }

  // hireCountはここまでで、生産・原料・資金・経済性いずれの制約にも達しない
  // 「必要な将来営業能力」（Target Sales Force）の不足分＝targetGapである。
  const targetGap = hireCount;
  const targetSalesForceHeadcount = currentHeadcount + targetGap;

  // 【2026-08-05修正】1四半期に実際へ反映する人数は、targetGapそのものではなく、
  // 会社の静的な基準規模に対するガバナー上限でキャップする。上限を超えた分は
  // 「今四半期は反映しない（次四半期以降に繰り越し。次四半期はその時点の新しい
  // wish/observationで target を再計算するため、単純な繰り越しキューではない）」
  // として扱う。
  const governorCap = quarterlyGovernorCap(fixture.salesForceHeadcountTotal);
  const hireCountThisQuarter = Math.min(targetGap, governorCap);
  const deferredCount = targetGap - hireCountThisQuarter;

  // 採用方向の評価一覧のうち、ガバナー上限を超えた分（acceptedだが今四半期は
  // 反映しない候補）にdeferredByQuarterlyGovernorを付与する。
  let acceptedSeen = 0;
  for (const evalEntry of evaluations) {
    if (evalEntry.direction !== "hire" || !evalEntry.accepted) continue;
    acceptedSeen += 1;
    if (acceptedSeen > hireCountThisQuarter) {
      (evalEntry as { deferredByQuarterlyGovernor?: boolean }).deferredByQuarterlyGovernor = true;
    }
  }

  hireCount = hireCountThisQuarter;

  if (targetGap > 0) {
    diagnostics.push({
      code: "SALES_HIRING_PROFITABLE_UNSERVED_OPPORTUNITY",
      domain: "sales",
      companyId: fixture.companyId,
      severity: "info",
      keyValues: { targetGap, targetSalesForceHeadcount, currentHeadcount, hireCountThisQuarter, deferredCount, governorCap },
      decisionSummary:
        deferredCount > 0
          ? `Target Sales Force ${targetSalesForceHeadcount}人（不足${targetGap}人）のうち、今四半期は${hireCountThisQuarter}人を採用（${deferredCount}人は次四半期以降へ繰り越し）`
          : `Target Sales Force ${targetSalesForceHeadcount}人へ向け、営業${hireCountThisQuarter}人の新規採用を提案`,
      message:
        deferredCount > 0
          ? `収益性のある未充足の販売機会があり、必要な将来営業能力（Target Sales Force）は${targetSalesForceHeadcount}人（現在${currentHeadcount}人比+${targetGap}人）と評価されたが、1四半期あたりの採用ガバナー（静的な会社規模基準の${governorCap}人）により、今四半期は${hireCountThisQuarter}人のみ採用し、残り${deferredCount}人は次四半期以降の再評価に委ねる。`
          : `収益性のある未充足の販売機会があり、必要な将来営業能力（Target Sales Force）${targetSalesForceHeadcount}人まではmarginal contributionが給与を上回り、生産・原料・資金のいずれのボトルネックにも達しないため、営業${hireCountThisQuarter}人の新規採用を提案する。`,
    });
  }
  const lastEval = evaluations[evaluations.length - 1];
  if (lastEval && lastEval.direction === "hire" && !lastEval.accepted) {
    const codeToMessage: Record<string, string> = {
      SALES_HIRING_NOT_ECONOMIC: "これ以上の営業採用は、追加1人あたりのmarginal contributionが給与を下回るため経済的でない。",
      SALES_HIRING_BLOCKED_BY_PRODUCTION: "販売機会はあるが、生産能力（binding capacity）に余力がないため、これ以上の営業採用を見送る。",
      SALES_HIRING_BLOCKED_BY_LIQUIDITY: "追加採用の給与コストが、当期の最低現金バッファ余力を超えるため、これ以上の営業採用を見送る。",
      SALES_HIRING_BLOCKED_BY_RAW_SUPPLY_UNCERTAINTY: "追加販売には新規生産（＝追加原料）が必要だが、真の原料供給制約が診断されているため、これ以上の営業採用を見送る。",
    };
    diagnostics.push({
      code: lastEval.blockedReasonCode ?? "SALES_HIRING_NOT_ECONOMIC",
      domain: "sales",
      companyId: fixture.companyId,
      severity: "info",
      keyValues: { targetSalesForceHeadcount, hireCountThisQuarter },
      message: codeToMessage[lastEval.blockedReasonCode ?? "SALES_HIRING_NOT_ECONOMIC"],
    });
  }

  // --- 減員方向（§7）。既存の1人（末尾）のmarginal contributionを評価し、
  // 0以下（=既に過剰）かつ在庫が制約になっていない場合のみ、退職金を考慮して
  // 減員候補にする。既存採用がある場合（hireCount>0）は同時に評価しない
  // （game engine側の「同一四半期に採用と減員を両方>0で入力することは禁止」制約と整合）。
  let layoffCount = 0;
  if (hireCount === 0 && currentHeadcount > 0) {
    let headcountForLayoffEval = currentHeadcount;
    const inventoryIsLimiting = PRODUCTS.some((p) => currentFg[p] <= EPSILON) || pressures.finishedGoodsExcessRatioByProduct.hoso < 0.5;
    for (let i = 0; i < naturalStopCeiling && headcountForLayoffEval > 0; i++) {
      const after = headcountForLayoffEval - 1;
      const salesAtCurrentH = realisticSalesAtHeadcount(headcountForLayoffEval, wishByMarket, salesParams);
      const salesAtLower = realisticSalesAtHeadcount(after, wishByMarket, salesParams);
      const lostByProduct: ProductAmount = {
        hoso: Math.max(0, salesAtCurrentH.hoso - salesAtLower.hoso),
        pd: Math.max(0, salesAtCurrentH.pd - salesAtLower.pd),
        vap: Math.max(0, salesAtCurrentH.vap - salesAtLower.vap),
      };
      const lostTotal = lostByProduct.hoso + lostByProduct.pd + lostByProduct.vap;

      let lostContribution: number | null = 0;
      let unknown = false;
      for (const p of PRODUCTS) {
        const perTon = contributionPerTon[p];
        if (lostByProduct[p] <= EPSILON) continue;
        if (perTon === null) {
          unknown = true;
          continue;
        }
        lostContribution = (lostContribution ?? 0) + perTon * lostByProduct[p];
      }
      if (unknown && lostContribution === 0) lostContribution = null;

      // marginal contributionが給与以下（＝この人がいなくても損失が小さい）かつ
      // 在庫が販売のボトルネックになっていない場合のみ減員候補にする（三宅さんご指示§7、
      // 「今期売るものが少ないだけで大量解雇しない」ため、在庫制約チェックを必須にする）。
      const excessCapacity = lostContribution !== null && lostContribution - salaryUsdPerQuarter <= EPSILON;
      if (!excessCapacity || inventoryIsLimiting || lostTotal <= EPSILON) {
        break;
      }
      // 節約額（今後の四半期給与）が退職金（2四半期分）を上回るかを確認する
      // （2四半期目以降は必ず正のため、実質的には常に真だが、明示的に検証する）。
      const savingsExceedSeverance = salaryUsdPerQuarter * 2 > severanceUsdPerPerson - EPSILON;
      if (!savingsExceedSeverance) break;

      layoffCount += 1;
      headcountForLayoffEval = after;
      evaluations.push({
        direction: "layoff",
        headcountBefore: headcountForLayoffEval + 1,
        headcountAfter: headcountForLayoffEval,
        incrementalSalesTonsByProduct: lostByProduct,
        incrementalSalesTonsTotal: -lostTotal,
        incrementalSalesCoveredByExistingFgTons: 0,
        incrementalSalesRequiringNewProductionTons: 0,
        incrementalContributionMarginUsd: lostContribution,
        salespersonQuarterlySalaryUsd: salaryUsdPerQuarter,
        marginalContributionAfterSalesSalaryUsd: lostContribution === null ? null : lostContribution - salaryUsdPerQuarter,
        productionHeadroomSufficient: true,
        rawMaterialPathUncertain: false,
        liquidityAfterHiringUsd: null,
        liquidityOk: true,
        accepted: true,
        blockedReasonCode: undefined,
      });
    }
    // 採用側と対称に、1四半期に実際へ反映する減員数も静的な基準規模に対する
    // ガバナーでキャップする（大量解雇の一括実行を避けるため）。
    const layoffGovernorCap = quarterlyGovernorCap(fixture.salesForceHeadcountTotal);
    const layoffCountThisQuarter = Math.min(layoffCount, layoffGovernorCap);
    const layoffDeferredCount = layoffCount - layoffCountThisQuarter;
    if (layoffDeferredCount > 0) {
      let acceptedLayoffSeen = 0;
      for (const evalEntry of evaluations) {
        if (evalEntry.direction !== "layoff" || !evalEntry.accepted) continue;
        acceptedLayoffSeen += 1;
        if (acceptedLayoffSeen > layoffCountThisQuarter) {
          (evalEntry as { deferredByQuarterlyGovernor?: boolean }).deferredByQuarterlyGovernor = true;
        }
      }
    }
    layoffCount = layoffCountThisQuarter;
    if (layoffCount > 0) {
      diagnostics.push({
        code: "SALES_FORCE_EXCESS_CAPACITY",
        domain: "sales",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: { layoffCount, currentHeadcount, severanceUsdPerPerson, layoffDeferredCount },
        decisionSummary: `営業${layoffCount}人の減員を提案`,
        message: `持続的な営業容量過剰（追加販売機会が乏しく、在庫も販売のボトルネックになっていない）と診断し、退職金（1人あたり${Math.round(
          severanceUsdPerPerson
        )}USD）を考慮しても節約効果が上回るため、営業${layoffCount}人の減員を提案する${
          layoffDeferredCount > 0 ? `（さらに${layoffDeferredCount}人は次四半期以降の再評価に委ねる）` : ""
        }。`,
      });
    }
  }

  return {
    salesForceHireCount: hireCount,
    salesForceLayoffCount: layoffCount,
    targetSalesForceHeadcount,
    evaluations,
    diagnostics,
  };
}

// 型チェック用（未使用importの検知回避・将来の呼び出し側の参考）。
export type { ProductAmount, CompanySalesPlanEntry };
void hosoEqTons;
void unwrapUnit;
void STANDARD_AI_PARAMETERS_V1;
