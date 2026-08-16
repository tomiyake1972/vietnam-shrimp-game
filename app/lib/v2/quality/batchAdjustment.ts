// ShrimpX V2 — 品質・顧客信頼・納期信頼性モジュール バッチ品質調整（Phase 7A）
//
// production/batches.ts（Phase6、saleableRecoveryRatio=1.00基準）が生成した
// 生産バッチ配列に対し、当期の操業リスク・重大品質事故から算出した品質結果を
// 「後段の品質調整」として一度だけ適用するアダプター。production/allocation.ts・
// batches.tsそのものは一切書き換えない（既存公開関数を再利用し、アダプターと
// 状態遷移で接続する、という開発ルールに従う）。
//
//   - 廃棄だけが完成品HOSO換算量の真の損失（原料消費量は変えず、
//     finishedGoodsQuantityを減らし、processingLossへ同量を足すことで
//     「原料消費 = 完成品 + 加工損失」の数量保存を維持する）
//   - 格落ち・再加工はPhase 7Aでは数量を減らさない（記録用フィールドのみ）
//   - 生産量が0のバッチ（原料不足等で何も生産されなかった場合）は品質調整
//     そのものをスキップする（意味のある品質イベントが存在しないため）が、
//     増産履歴（rampHistory）には「当期の実績は0」として記録する

import { hosoEqTons, roundHosoEqTons, unwrapUnit } from "../core/units";
import { PeriodV2 } from "../core/period";
import { Product } from "../market/types";
import { calculateFactoryEffectiveCapacity } from "../production/capacity";
import { Factory, FactoryLoadMetrics, ProductionBatch } from "../production/types";
import { calculateOperationalRisk } from "./operationalRisk";
import { calculateMajorIncidentProbability, deriveQualityIncidentSeed, drawMajorIncident } from "./majorIncident";
import { calculateQualityOutcome } from "./qualityOutcome";
import { QualityParameters, QUALITY_PARAMETERS_V1 } from "./parameters";
import { BatchQualityAdjustment, CompanyFactoryProductRampState, QualityValidationError } from "./types";

const EPSILON = 1e-6;

function rampKey(companyId: string, factoryId: string, product: string): string {
  return `${companyId}::${factoryId}::${product}`;
}

function capacityForProduct(factory: Factory, product: Product): number {
  const capacity = calculateFactoryEffectiveCapacity(factory);
  if (product === "hoso") return unwrapUnit(capacity.hoso);
  if (product === "pd") return unwrapUnit(capacity.pd);
  return unwrapUnit(capacity.vap);
}

export interface QualityAdjustmentInput {
  /** Phase6（production/batches.ts）が生成した、品質調整前のバッチ（saleableRecoveryRatio=1.00基準）。 */
  readonly batches: readonly ProductionBatch[];
  /** 当期の工場別操業負荷指標（production/loadMetrics.ts、Phase6が既に算出済み）。 */
  readonly factoryLoadMetrics: readonly FactoryLoadMetrics[];
  /** 当期のバッチが属する工場一式（有効設備能力の算出に使う）。 */
  readonly factories: readonly Factory[];
  /** 会社×工場×商品の前四半期実績生産量（急増産ストレスの比較対象）。 */
  readonly rampHistory: readonly CompanyFactoryProductRampState[];
  /** production/parameters.tsのlabor.overtimeRateCap（残業ストレスの分母）。 */
  readonly overtimeRateCap: number;
  readonly period: PeriodV2;
  readonly turn: number;
  /** ゲーム全体のシード（重大事故用の独立シード導出に使う。市場価格等の乱数ストリームとは名前空間で分離される）。 */
  readonly gameSeed: string;
  /**
   * 会社×商品別の基準操業品質（baselineOperationalQuality）の上書き。未指定の
   * 組み合わせはQUALITY_PARAMETERS_V1.qualityOutcome.baselineOperationalQualityを
   * 使う（現状は全社共通の中立値。既存フィクスチャに品質能力の値がなかったため。
   * §文書化参照）。
   */
  readonly baselineQualityOverride?: ReadonlyMap<string, number>;
  /**
   * 【Phase QI-I1新設】品質管理設備（capex/qualityControlEquipmentEffect.ts）による、
   * Factory単位のoperationalRisk低減乗数（0〜1。companyLab/qualityControlEquipmentState.ts
   * が唯一の情報源）。未指定のFactoryは乗数1.0（効果なし）とみなす。設計方針
   * （docs/v2/quality_control_equipment_design_qi_d1.md）どおり、この乗数は
   * risk.operationalRiskそのものではなく、outcome算出に使うeffectiveOperationalRisk
   * だけに適用する（Quality Scoreへの直接加点は行わない）。
   */
  readonly qualityEquipmentRiskMultiplierByFactory?: ReadonlyMap<string, number>;
}

export interface QualityAdjustmentResult {
  readonly adjustedBatches: readonly ProductionBatch[];
  readonly adjustments: readonly BatchQualityAdjustment[];
  readonly updatedRampHistory: readonly CompanyFactoryProductRampState[];
}

/**
 * 生産バッチ配列へ、当期の操業リスク・品質結果を一度だけ適用する純粋関数。
 * 入力batches・rampHistoryは変更しない。
 */
export function applyQualityToBatches(input: QualityAdjustmentInput, params: QualityParameters = QUALITY_PARAMETERS_V1): QualityAdjustmentResult {
  const loadMetricsByFactoryId = new Map(input.factoryLoadMetrics.map((m) => [m.factoryId, m]));
  const factoryById = new Map(input.factories.map((f) => [f.factoryId, f]));
  const rampByKey = new Map(input.rampHistory.map((r) => [rampKey(r.companyId, r.factoryId, r.product), r]));
  const nextRampByKey = new Map(rampByKey);

  const adjustments: BatchQualityAdjustment[] = [];
  const adjustedBatches: ProductionBatch[] = [];

  for (const batch of input.batches) {
    const originalFinishedGoodsQuantity = hosoEqTons(unwrapUnit(batch.finishedGoodsQuantity));
    const currentProduction = unwrapUnit(originalFinishedGoodsQuantity);
    const rk = rampKey(batch.companyId, batch.factoryId, batch.product);

    // 生産量0のバッチは意味のある品質イベントがないため調整をスキップするが、
    // 増産履歴には「当期実績0」として反映する（次期の急増産ストレスの基準）。
    if (currentProduction <= EPSILON) {
      adjustedBatches.push(batch);
      nextRampByKey.set(rk, { companyId: batch.companyId, factoryId: batch.factoryId, product: batch.product, lastQuarterProductionQuantity: hosoEqTons(0) });
      continue;
    }

    const loadMetrics = loadMetricsByFactoryId.get(batch.factoryId);
    if (!loadMetrics) {
      throw new QualityValidationError(`工場 "${batch.factoryId}" のfactoryLoadMetricsが見つかりません（production/loadMetrics.tsの出力をそのまま渡してください）。`);
    }
    const factory = factoryById.get(batch.factoryId);
    if (!factory) {
      throw new QualityValidationError(`工場 "${batch.factoryId}" がfactories一覧に見つかりません。`);
    }

    const previousRamp = rampByKey.get(rk);
    const previousActualProduction = previousRamp ? unwrapUnit(previousRamp.lastQuarterProductionQuantity) : undefined;
    const productCapacity = capacityForProduct(factory, batch.product);

    const risk = calculateOperationalRisk(
      {
        equipmentUtilizationRate: unwrapUnit(loadMetrics.equipmentUtilizationRate),
        laborUtilizationRate: unwrapUnit(loadMetrics.laborUtilizationRate),
        overtimeRate: unwrapUnit(loadMetrics.overtimeRate),
        overtimeRateCap: input.overtimeRateCap,
        temporaryWorkerShare: unwrapUnit(loadMetrics.temporaryWorkerShare),
        productMixComplexity: unwrapUnit(loadMetrics.productMixComplexity),
        averageRawMaterialAgeQuarters: loadMetrics.averageRawMaterialAgeQuarters,
        currentPlannedOrAllocatedProduction: currentProduction,
        previousActualProduction,
        productCapacity,
      },
      params
    );

    // 【Phase QI-I1新設】品質管理設備は、outcome算出（nonConformance・major incident
    // 確率の両方）にだけ使うeffectiveOperationalRiskを、risk.operationalRiskへの
    // 有界な乗算で低減する。risk（内訳6要因＋operationalRisk）自体は「純粋な操業条件」
    // のまま変更しない（Quality Scoreへの直接加点をしないという設計方針の核心）。
    const qualityEquipmentRiskMultiplier = input.qualityEquipmentRiskMultiplierByFactory?.get(batch.factoryId) ?? 1;
    const effectiveOperationalRisk = Math.max(0, Math.min(1, risk.operationalRisk * qualityEquipmentRiskMultiplier));

    const incidentSeed = deriveQualityIncidentSeed(input.gameSeed, input.turn, batch.companyId, batch.factoryId, batch.product);
    const probability = calculateMajorIncidentProbability(effectiveOperationalRisk, params);
    const majorIncident = drawMajorIncident(incidentSeed, probability);

    const baselineQuality =
      input.baselineQualityOverride?.get(`${batch.companyId}::${batch.product}`) ?? unwrapUnit(params.qualityOutcome.baselineOperationalQuality);

    const outcome = calculateQualityOutcome(effectiveOperationalRisk, majorIncident, baselineQuality, params);

    const adjustedFinishedGoodsQuantity = hosoEqTons(Math.max(0, roundHosoEqTons(currentProduction * unwrapUnit(outcome.saleableRecoveryRatio))));
    const discardQuantity = hosoEqTons(Math.max(0, roundHosoEqTons(currentProduction - unwrapUnit(adjustedFinishedGoodsQuantity))));
    const downgradeQuantity = hosoEqTons(Math.max(0, roundHosoEqTons(currentProduction * outcome.downgradeRatio)));
    const reworkQuantity = hosoEqTons(Math.max(0, roundHosoEqTons(currentProduction * outcome.reworkRatio)));

    const adjustedBatch: ProductionBatch = {
      ...batch,
      finishedGoodsQuantity: adjustedFinishedGoodsQuantity,
      processingLoss: hosoEqTons(roundHosoEqTons(unwrapUnit(batch.processingLoss) + unwrapUnit(discardQuantity))),
    };
    adjustedBatches.push(adjustedBatch);

    adjustments.push({
      batchId: batch.batchId,
      companyId: batch.companyId,
      factoryId: batch.factoryId,
      product: batch.product,
      period: batch.period,
      risk,
      qualityEquipmentRiskMultiplier,
      effectiveOperationalRisk,
      outcome,
      originalFinishedGoodsQuantity,
      adjustedFinishedGoodsQuantity,
      downgradeQuantity,
      reworkQuantity,
      discardQuantity,
    });

    nextRampByKey.set(rk, {
      companyId: batch.companyId,
      factoryId: batch.factoryId,
      product: batch.product,
      lastQuarterProductionQuantity: hosoEqTons(currentProduction),
    });
  }

  const updatedRampHistory = Array.from(nextRampByKey.values()).sort((a, b) => {
    if (a.companyId !== b.companyId) return a.companyId.localeCompare(b.companyId);
    if (a.factoryId !== b.factoryId) return a.factoryId.localeCompare(b.factoryId);
    return a.product.localeCompare(b.product);
  });

  return { adjustedBatches, adjustments, updatedRampHistory };
}

/** batchIdをキーにした品質調整結果のルックアップを作る（完成品ロットへの品質情報付与に使う）。 */
export function adjustmentsByBatchId(adjustments: readonly BatchQualityAdjustment[]): ReadonlyMap<string, BatchQualityAdjustment> {
  return new Map(adjustments.map((a) => [a.batchId, a]));
}
