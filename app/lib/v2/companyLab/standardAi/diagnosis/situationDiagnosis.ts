// ShrimpX V2 — Phase SAI-6.1: Situation Diagnosis（不足型／過剰型の6カテゴリ診断）
//
// 【目的】Standard AIが意思決定を行う前に、「何が足りないか」と「何が余っているか」を
// 説明可能な形で診断する。対象は営業・生産能力・Worker・原料・在庫・資金の6カテゴリ。
// 6つを1つの合成pressure scoreへ押し込まず、各指標を独立に保持し、
// shortage(不足) / balanced(均衡) / surplus(余剰) を判定できる構造にする
// （設計レポート docs/standard_ai/TEST14_TURN1_STANDARD_AI_REDESIGN_ANALYSIS.md
// §10・三宅さんの実装指示を参照）。
//
// 【今回のスコープ（重要）】本モジュールは診断専用であり、意思決定（productionPlans・
// domesticPurchasePlan・importOrders・aquacultureStockingPlans・workerAssignments・
// financingRequest・capexDecision）を一切変更しない。診断のために「基本当期生産
// 必要量」「必要原料」「理論必要Worker」を独自に計算するが、これは既存の
// decision/production.ts・decision/procurement.ts・decision/labor.tsの計算とは
// 完全に独立した、診断専用の並行計算である（既存モジュールの計算式・出力は
// 一切変更していない）。SAI-6.4（Inventory & Production Planへの接続）で、
// 実際の生産計画がこの「基本当期生産必要量」を参照するように配線を切り替える
// 予定だが、それは別途指示があるまで着手しない。

import { unwrapUnit } from "../../../core/units";
import { CompanyFixture } from "../../types";
import { StandardAiParameters, STANDARD_AI_PARAMETERS_V1 } from "../parameters";
import { PressureScores } from "../pressures";
import { computeReferenceProductionByProduct } from "../pressures";
import { ProductAmount, StandardAiObservation, sumProductAmount, zeroProductAmount } from "../types";
import { StandardAiDiagnosticEntry, StandardAiReasonCode } from "../reasonCodes";
import { computeRequiredRegularHeadcount } from "../../workforce";
import { CurrentPeriodDeliveryDemand } from "./currentPeriodDeliveryDemand";

const EPSILON = 1e-6;

export type ConstraintState = "shortage" | "balanced" | "surplus" | "unknown";

/** 診断が判定できる制約カテゴリ（不足型／過剰型）。primaryConstraint/secondaryConstraintで使う。 */
export type DiagnosisConstraintCategory =
  | "sales_shortage"
  | "production_capacity_shortage"
  | "production_capacity_surplus"
  | "worker_shortage"
  | "worker_surplus"
  | "raw_material_shortage"
  | "inventory_excess"
  | "liquidity_shortage"
  | "none";

/**
 * 【設計判断】各カテゴリの閾値は、生産・調達等の意思決定パラメータ
 * （STANDARD_AI_PARAMETERS_V1）とは独立した、診断専用の分類しきい値として
 * このファイル内に保持する（診断ロジックが意思決定ロジックの既存パラメータに
 * 依存して意図せず変化することを避けるため）。将来、診断結果を意思決定へ
 * 接続する段階（SAI-6.4以降）で、必要に応じてSTANDARD_AI_PARAMETERS_V1へ
 * 統合するかどうかを再検討する。
 */
export const SITUATION_DIAGNOSIS_THRESHOLDS_V1 = {
  salesShortageRatio: 0.6,
  productionShortageRatio: 0.9,
  productionSurplusRatio: 0.5,
  workerShortageRatio: 1.05,
  workerSurplusRatio: 0.6,
  rawMaterialShortageRatio: 1.0,
  inventoryExcessRatio: 1.5,
  liquidityShortageRatio: 1.0,
} as const;

/**
 * 【unknownの扱い（実装指示§11）】各`*Ratio`フィールドは、分母が実質ゼロ等で
 * 算出不能な場合は推測値（0や1などの捏造値）を作らずNaNを保持する。呼び出し側は
 * 必ず対応する`*State`フィールド（"unknown"）で判定すること（NaNを直接比較・
 * 表示しない）。
 */
export interface StandardAiSituationDiagnosis {
  /** 現実的販売可能量（realisticSalesByProduct合計） / 理論販売機会（desiredByProduct合計）。低いほど営業制約が強い。算出不能ならNaN（stateはunknown）。 */
  readonly salesFulfillmentRatio: number;
  readonly salesFulfillmentState: ConstraintState;
  /** 基本当期生産必要量（合計） / Standard AIが現在認識できる生産能力（合計、ノミナル）。高いほど生産能力制約が強い。 */
  readonly productionLoadRatio: number;
  readonly productionLoadState: ConstraintState;
  /** 理論必要Worker / 現在Worker（動的state）。高ければ不足、低すぎれば余剰。 */
  readonly workerLoadRatio: number;
  readonly workerLoadState: ConstraintState;
  /** (当期利用可能原料+当期確実に取得可能な原料) / 必要原料。1未満なら不足。 */
  readonly rawMaterialCoverageRatio: number;
  readonly rawMaterialCoverageState: ConstraintState;
  /** 期首完成品在庫(通常在庫扱い分) / 通常在庫目標。高すぎる場合に在庫過多。 */
  readonly inventoryExcessRatio: number;
  readonly inventoryExcessState: ConstraintState;
  /** 現金 / 会社規模連動の最低現金バッファ。低いほど資金制約が強い（借入余力は今回未接続、§19の未確定事項）。 */
  readonly liquidityCoverageRatio: number;
  readonly liquidityCoverageState: ConstraintState;

  /** 今期の主要制約（上位1件）。複数該当が無ければ"none"。 */
  readonly primaryConstraint: DiagnosisConstraintCategory;
  /** 今期の第2の制約（上位2件目）。無ければ"none"。 */
  readonly secondaryConstraint: DiagnosisConstraintCategory;

  /** SAI-6.3で構築したcurrentPeriodDeliveryDemand（当期納品需要）そのもの。 */
  readonly currentPeriodDeliveryDemandByProduct: ProductAmount;
  readonly deliveryDemandSource: CurrentPeriodDeliveryDemand["source"];

  /** 生産能力の余力（能力合計－基本当期生産必要量合計）。負なら能力不足。 */
  readonly productionCapacityHeadroom: number;
  /** Workerの余力（現在Worker－理論必要Worker）。負なら不足。 */
  readonly workerHeadroom: number;

  /** 診断専用に算出した「基本当期生産必要量」（商品別。§12.1の概念式、戦略先行生産は含まない）。 */
  readonly basicCurrentPeriodProductionRequirementByProduct: ProductAmount;
  /** 診断専用に算出した必要原料量（歩留まり1.0基準、既存procurement.tsと同じ前提）。 */
  readonly requiredRawMaterial: number;
  /** 診断専用に算出した理論必要Worker（会社全体、工場別配分の合計）。 */
  readonly requiredWorker: number;

  /**
   * 【設計判断・実装指示の要請】Standard AIが現在認識できる生産能力（ノミナル）と、
   * 将来利用すべき実効能力（0.855係数＝baseUtilizationRate×equipmentAvailabilityRate
   * 適用後）の差。今回はゲーム側の能力定義・意思決定ロジックのいずれも変更しない
   * （実効能力を使うのはSAI-6.4以降の別途判断）。差が実質的に無い場合（能力定義が
   * 未接続等）はundefined。
   */
  readonly capacityRecognitionGap?: {
    readonly nominalCapacityTotal: number;
    readonly effectiveCapacityTotal: number;
  };
}

export interface SituationDiagnosisResult {
  readonly diagnosis: StandardAiSituationDiagnosis;
  readonly diagnostics: readonly StandardAiDiagnosticEntry[];
}

function classify(ratio: number | undefined, shortageIf: (r: number) => boolean, surplusIf?: (r: number) => boolean): ConstraintState {
  if (ratio === undefined || !Number.isFinite(ratio)) return "unknown";
  if (shortageIf(ratio)) return "shortage";
  if (surplusIf && surplusIf(ratio)) return "surplus";
  return "balanced";
}

/** 基本当期生産必要量（§12.1）: 当期納品需要 + 通常安全在庫目標 − 利用可能な期首完成品在庫。下限0。 */
function computeBasicCurrentPeriodProductionRequirement(
  deliveryDemandByProduct: ProductAmount,
  normalInventoryTargetByProduct: ProductAmount,
  openingFinishedGoodsByProduct: ProductAmount
): ProductAmount {
  const result = zeroProductAmount();
  for (const product of ["hoso", "pd", "vap"] as const) {
    result[product] = Math.max(0, deliveryDemandByProduct[product] + normalInventoryTargetByProduct[product] - openingFinishedGoodsByProduct[product]);
  }
  return result;
}

/** 基本当期生産必要量を各工場へ能力シェアで配分し、理論必要Workerを合算する（labor.tsと同じ配分方式の再利用。独自の推定方式は増設しない）。 */
function computeRequiredWorkerTotal(fixture: CompanyFixture, observation: StandardAiObservation, basicRequirementByProduct: ProductAmount): number {
  const capacityTotals = observation.totalCapacityByProduct;
  let total = 0;
  for (const baseline of fixture.workerBaseline) {
    const factoryObs = observation.factories.find((f) => f.factoryId === baseline.factoryId);
    if (!factoryObs) continue;
    const quantityByProduct = zeroProductAmount();
    for (const product of ["hoso", "pd", "vap"] as const) {
      const companyCapacity = capacityTotals[product];
      const share = companyCapacity > EPSILON ? factoryObs.capacityByProduct[product] / companyCapacity : 0;
      quantityByProduct[product] = basicRequirementByProduct[product] * share;
    }
    const required = computeRequiredRegularHeadcount({
      quantityByProduct,
      skillByProduct: factoryObs.skillByProduct,
      attendanceRate: factoryObs.attendanceRate,
      appliedOvertimeRate: 0,
      temporaryHeadcount: 0,
    });
    total += required.requiredRegularHeadcount;
  }
  return total;
}

export function buildStandardAiSituationDiagnosis(
  fixture: CompanyFixture,
  observation: StandardAiObservation,
  pressures: PressureScores,
  desiredByProduct: ProductAmount,
  realisticSalesByProduct: ProductAmount,
  deliveryDemand: CurrentPeriodDeliveryDemand,
  params: StandardAiParameters = STANDARD_AI_PARAMETERS_V1
): SituationDiagnosisResult {
  const diagnostics: StandardAiDiagnosticEntry[] = [];
  const T = SITUATION_DIAGNOSIS_THRESHOLDS_V1;

  // --- 1. 営業（Sales Fulfillment Ratio） ---
  const theoreticalSalesOpportunity = sumProductAmount(desiredByProduct);
  const realisticSalesTotal = sumProductAmount(realisticSalesByProduct);
  const salesFulfillmentRatio = theoreticalSalesOpportunity > EPSILON ? realisticSalesTotal / theoreticalSalesOpportunity : NaN;
  const salesFulfillmentState = classify(Number.isFinite(salesFulfillmentRatio) ? salesFulfillmentRatio : undefined, (r) => r < T.salesShortageRatio);

  // --- 基本当期生産必要量（診断専用の並行計算。既存decision/production.tsは変更しない） ---
  const normalInventoryTargetByProduct = computeReferenceProductionByProduct(observation, params);
  for (const product of ["hoso", "pd", "vap"] as const) {
    normalInventoryTargetByProduct[product] *= params.finishedGoodsTargetQuarters;
  }
  const basicRequirementByProduct = computeBasicCurrentPeriodProductionRequirement(
    deliveryDemand.byProduct,
    normalInventoryTargetByProduct,
    observation.finishedGoodsByProduct
  );
  const basicRequirementTotal = sumProductAmount(basicRequirementByProduct);

  // --- 2. 生産能力（Production Load Ratio） ---
  const nominalCapacityTotal = sumProductAmount(observation.totalCapacityByProduct);
  const productionLoadRatio = nominalCapacityTotal > EPSILON ? basicRequirementTotal / nominalCapacityTotal : NaN;
  const productionLoadState = classify(
    Number.isFinite(productionLoadRatio) ? productionLoadRatio : undefined,
    (r) => r > T.productionShortageRatio,
    (r) => r < T.productionSurplusRatio
  );
  const productionCapacityHeadroom = nominalCapacityTotal - basicRequirementTotal;

  // 【実装指示§4対応】能力認識ギャップの明示（0.855＝baseUtilizationRate×equipmentAvailabilityRate。
  // ゲーム側の能力定義は一切変更しない。診断情報として差だけを出す）。
  let capacityRecognitionGap: StandardAiSituationDiagnosis["capacityRecognitionGap"];
  const effectiveCapacityTotal = fixture.factories.reduce((sum, f) => {
    const utilization = unwrapUnit(f.baseUtilizationRate);
    const availability = unwrapUnit(f.equipmentAvailabilityRate);
    const nominalForFactory = unwrapUnit(f.hosoCapacity) + unwrapUnit(f.pdCapacity) + unwrapUnit(f.vapCapacity);
    return sum + nominalForFactory * utilization * availability;
  }, 0);
  if (effectiveCapacityTotal > EPSILON && Math.abs(effectiveCapacityTotal - nominalCapacityTotal) > nominalCapacityTotal * 0.01) {
    capacityRecognitionGap = { nominalCapacityTotal, effectiveCapacityTotal };
    diagnostics.push({
      code: "PRODUCTION_CAPACITY_RECOGNITION_GAP",
      domain: "diagnosis",
      companyId: fixture.companyId,
      severity: "info",
      keyValues: { nominalCapacityTotal, effectiveCapacityTotal },
      message:
        `Standard AIが現在参照する生産能力（ノミナル合計${Math.round(nominalCapacityTotal)}t）は、` +
        `労務起因の実効係数（baseUtilizationRate×equipmentAvailabilityRate）適用後の実効能力（合計${Math.round(
          effectiveCapacityTotal
        )}t）より大きい。今回はゲーム側の能力定義・意思決定ロジックを変更していないため、この差はProduction Load Ratioの計算には反映していない（診断情報としての明示のみ）。`,
    });
  }

  // --- 3. Worker（Worker Load Ratio） ---
  const requiredWorker = computeRequiredWorkerTotal(fixture, observation, basicRequirementByProduct);
  const currentWorker = observation.regularHeadcountTotal;
  const workerLoadRatio = currentWorker > EPSILON ? requiredWorker / currentWorker : NaN;
  const workerLoadState = classify(
    Number.isFinite(workerLoadRatio) ? workerLoadRatio : undefined,
    (r) => r > T.workerShortageRatio,
    (r) => r < T.workerSurplusRatio
  );
  const workerHeadroom = currentWorker - requiredWorker;

  // --- 4. 原料（Raw Material Coverage Ratio） ---
  // growingAquaculture（未収穫）は当期利用可能原料に含めない。inTransitImportは
  // availableFromPeriod（既存フィールド）が当期以前のものだけを「当期確実に取得可能」に含める。
  const requiredRawMaterial = basicRequirementTotal; // 歩留まり1.0基準（既存procurement.tsと同じ前提）
  const currentlyAvailable = observation.rawMaterialAvailable + observation.rawMaterialCertainInboundThisPeriod;
  const rawMaterialCoverageRatio = requiredRawMaterial > EPSILON ? currentlyAvailable / requiredRawMaterial : NaN;
  const rawMaterialCoverageState = classify(Number.isFinite(rawMaterialCoverageRatio) ? rawMaterialCoverageRatio : undefined, (r) => r < T.rawMaterialShortageRatio);

  // --- 5. 在庫（Inventory Excess Ratio） ---
  const normalInventoryTargetTotal = sumProductAmount(normalInventoryTargetByProduct);
  const openingFinishedGoodsTotal = sumProductAmount(observation.finishedGoodsByProduct);
  const inventoryExcessRatio = normalInventoryTargetTotal > EPSILON ? openingFinishedGoodsTotal / normalInventoryTargetTotal : NaN;
  // 【命名の注意】在庫については「多すぎる」ことが問題（過剰型）なので、
  // classify()の第3引数（surplusIf）へ過多しきい値を渡す。「shortage」は
  // 発火させない（在庫が少なすぎることは今回のTest14 Turn1診断の対象外。
  // §17の将来教師ケース「在庫過多」参照）。
  const inventoryExcessState = classify(
    Number.isFinite(inventoryExcessRatio) ? inventoryExcessRatio : undefined,
    () => false,
    (r) => r > T.inventoryExcessRatio
  );

  // --- 6. 資金（Liquidity Coverage Ratio） ---
  // 【今回のスコープ】既存のfinanceロジック（pressures.targetMinimumCashUsd）から
  // 取得可能な、説明可能な指標を使う。実行可能借入余力の推定は今回未接続
  // （§19の未確定事項）であり、liquidityCoverageRatioは現金のみを分子とする
  // 簡易版であることをdiagnosticsで明示する。借入判断ロジック自体は変更しない。
  const liquidityCoverageRatio = pressures.targetMinimumCashUsd > EPSILON ? observation.cashUsd / pressures.targetMinimumCashUsd : NaN;
  const liquidityCoverageState = classify(Number.isFinite(liquidityCoverageRatio) ? liquidityCoverageRatio : undefined, (r) => r < T.liquidityShortageRatio);
  if (Number.isFinite(liquidityCoverageRatio)) {
    diagnostics.push({
      code: "LIQUIDITY_CONSTRAINT",
      domain: "diagnosis",
      companyId: fixture.companyId,
      severity: liquidityCoverageState === "shortage" ? "warning" : "info",
      keyValues: { liquidityCoverageRatio, cashUsd: observation.cashUsd, targetMinimumCashUsd: pressures.targetMinimumCashUsd },
      message:
        "Liquidity Coverage Ratio = 現金 / 会社規模連動の最低現金バッファ（簡易版。実行可能借入余力は今回未接続のため分子に含めていない）。",
    });
  }

  // --- 主要制約・第2制約の判定（複合制約・上位2件方式） ---
  type Scored = { category: DiagnosisConstraintCategory; score: number; code: StandardAiReasonCode; message: string };
  const candidates: Scored[] = [];
  if (salesFulfillmentState === "shortage") {
    candidates.push({
      category: "sales_shortage",
      score: (T.salesShortageRatio - salesFulfillmentRatio) / T.salesShortageRatio,
      code: "SALES_FORCE_BINDING_CONSTRAINT",
      message: `現実的販売可能量（${Math.round(realisticSalesTotal)}t）が理論販売機会（${Math.round(
        theoreticalSalesOpportunity
      )}t）を大きく下回るため、営業が支配的な制約と診断する（Sales Fulfillment Ratio=${salesFulfillmentRatio.toFixed(2)}）。`,
    });
  }
  if (productionLoadState === "shortage") {
    candidates.push({
      category: "production_capacity_shortage",
      score: (productionLoadRatio - T.productionShortageRatio) / T.productionShortageRatio,
      code: "PRODUCTION_CAPACITY_BINDING_CONSTRAINT",
      message: `基本当期生産必要量（${Math.round(basicRequirementTotal)}t）が生産能力（${Math.round(
        nominalCapacityTotal
      )}t）に対し高水準のため、生産能力が制約となりうる（Production Load Ratio=${productionLoadRatio.toFixed(2)}）。`,
    });
  } else if (productionLoadState === "surplus") {
    candidates.push({
      category: "production_capacity_surplus",
      score: (T.productionSurplusRatio - productionLoadRatio) / T.productionSurplusRatio,
      code: "PRODUCTION_CAPACITY_HEADROOM",
      message: `生産能力（${Math.round(nominalCapacityTotal)}t）に対し基本当期生産必要量（${Math.round(
        basicRequirementTotal
      )}t）は小さく、生産能力に余力がある（Production Load Ratio=${productionLoadRatio.toFixed(2)}）。`,
    });
  }
  if (workerLoadState === "shortage") {
    candidates.push({
      category: "worker_shortage",
      score: (workerLoadRatio - T.workerShortageRatio) / T.workerShortageRatio,
      code: "WORKER_SHORTAGE_DIAGNOSED",
      message: `理論必要Worker（${Math.round(requiredWorker)}人）が現在Worker（${Math.round(
        currentWorker
      )}人）を上回るため、Worker不足と診断する（Worker Load Ratio=${workerLoadRatio.toFixed(2)}）。`,
    });
  } else if (workerLoadState === "surplus") {
    candidates.push({
      category: "worker_surplus",
      score: (T.workerSurplusRatio - workerLoadRatio) / T.workerSurplusRatio,
      code: "WORKER_SURPLUS",
      message: `現在Worker（${Math.round(currentWorker)}人）が理論必要Worker（${Math.round(
        requiredWorker
      )}人）を大きく上回るため、Worker余剰と診断する（Worker Load Ratio=${workerLoadRatio.toFixed(2)}）。`,
    });
  }
  if (rawMaterialCoverageState === "shortage") {
    candidates.push({
      category: "raw_material_shortage",
      score: 1 - rawMaterialCoverageRatio,
      code: "RAW_MATERIAL_SHORTAGE",
      message: `当期利用可能原料＋当期確実に取得可能な原料（${Math.round(currentlyAvailable)}t）が必要原料（${Math.round(
        requiredRawMaterial
      )}t）を下回るため、原料不足と診断する（Raw Material Coverage Ratio=${rawMaterialCoverageRatio.toFixed(2)}）。`,
    });
  }
  if (inventoryExcessState === "surplus") {
    candidates.push({
      category: "inventory_excess",
      score: (inventoryExcessRatio - T.inventoryExcessRatio) / T.inventoryExcessRatio,
      code: "INVENTORY_EXCESS",
      message: `期首完成品在庫（合計${Math.round(openingFinishedGoodsTotal)}t）が通常在庫目標（合計${Math.round(
        normalInventoryTargetTotal
      )}t）を大きく超えるため、在庫過多と診断する（Inventory Excess Ratio=${inventoryExcessRatio.toFixed(2)}）。`,
    });
  }
  if (liquidityCoverageState === "shortage") {
    candidates.push({
      category: "liquidity_shortage",
      score: (T.liquidityShortageRatio - liquidityCoverageRatio) / T.liquidityShortageRatio,
      code: "LIQUIDITY_CONSTRAINT",
      message: `現金が会社規模連動の最低現金バッファを下回る見込みのため、資金制約と診断する（Liquidity Coverage Ratio=${liquidityCoverageRatio.toFixed(2)}）。`,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const primary = candidates[0];
  const secondary = candidates[1];
  if (primary) {
    diagnostics.push({
      code: primary.code,
      domain: "diagnosis",
      companyId: fixture.companyId,
      severity: "info",
      keyValues: { score: primary.score },
      decisionSummary: `主要制約: ${primary.category}`,
      message: primary.message,
    });
  }
  if (secondary) {
    diagnostics.push({
      code: secondary.code,
      domain: "diagnosis",
      companyId: fixture.companyId,
      severity: "info",
      keyValues: { score: secondary.score },
      decisionSummary: `第2制約: ${secondary.category}`,
      message: secondary.message,
    });
  }

  const diagnosis: StandardAiSituationDiagnosis = {
    salesFulfillmentRatio,
    salesFulfillmentState,
    productionLoadRatio,
    productionLoadState,
    workerLoadRatio,
    workerLoadState,
    rawMaterialCoverageRatio,
    rawMaterialCoverageState,
    inventoryExcessRatio,
    inventoryExcessState,
    liquidityCoverageRatio,
    liquidityCoverageState,
    primaryConstraint: primary?.category ?? "none",
    secondaryConstraint: secondary?.category ?? "none",
    currentPeriodDeliveryDemandByProduct: deliveryDemand.byProduct,
    deliveryDemandSource: deliveryDemand.source,
    productionCapacityHeadroom,
    workerHeadroom,
    basicCurrentPeriodProductionRequirementByProduct: basicRequirementByProduct,
    requiredRawMaterial,
    requiredWorker,
    capacityRecognitionGap,
  };

  return { diagnosis, diagnostics };
}
