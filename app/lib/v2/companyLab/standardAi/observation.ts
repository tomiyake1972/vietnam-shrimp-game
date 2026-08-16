// ShrimpX V2 — Phase SAI-1: 標準経営AI基盤 Observationビルダー
//
// 【情報境界】この関数のシグネチャは既存のCompanyDecisionProvider
// （companyLab/types.ts）と同じ4引数＋turnだけを受け取る。fixture・ownState・
// publicInfoはいずれも「自社の状態」「前四半期までの公開市場情報」のみを
// 保持する既存型であり、本関数はこれ以外の情報源（turn runnerの内部状態・
// 他社の非公開データ・将来の乱数列）に一切アクセスしない（アクセスする手段が
// 関数シグネチャ上そもそも存在しない）。

import { hosoEqTons, unwrapUnit } from "../../core/units";
import { DEMAND_MARKET_IDS, MarketQuarterResult, Product } from "../../market/types";
import { deriveMarketReferencePrices } from "../../market/destinationPricing";
import { CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTS } from "../../market/destinationPricingParameters";
import { PeriodV2 } from "../../core/period";
import { unwrapUsd } from "../../finance/types";
import { CompanyFixture, CompanyOwnState, PublicMarketInfo } from "../types";
import { findFactoryRegularHeadcount } from "../workforce";
import { isCapexProjectOperationalAt } from "../../capex/capacityEffect";
import { computeEffectiveFactories, MAX_FACTORIES_PER_COMPANY } from "../../capex/factoryConstruction";
import { isActiveStatus } from "../../capex/projectLifecycle";
import { calculateFactoryEffectiveCapacity } from "../../production/capacity";
import { computeFactoryUsedSpaceUnits, FACTORY_SPACE_PARAMETERS_V1, resolveFactoryTotalSpaceUnits } from "../../production/factorySpace";
import { computeLoanQuarterlyInterest, computeScheduledPrincipalDue } from "../../financing/loanSchedule";
import { resolveQualityEquipmentStatusByFactory, qualityEquipmentStatusFor } from "../qualityControlEquipmentState";
import { BatchQualityAdjustment } from "../../quality/types";
import { FactoryObservation, MarketObservationEntry, ProductAmount, StandardAiObservation, zeroProductAmount } from "./types";

const EPSILON = 1e-6;

function availableRawMaterialQuantity(ownState: CompanyOwnState): number {
  return ownState.rawMaterialLots.filter((l) => l.status === "available").reduce((sum, l) => sum + unwrapUnit(l.remainingQuantity), 0);
}

function pipelineRawMaterialQuantity(ownState: CompanyOwnState): number {
  return ownState.rawMaterialLots
    .filter((l) => l.status === "inTransitImport" || l.status === "growingAquaculture")
    .reduce((sum, l) => sum + unwrapUnit(l.remainingQuantity), 0);
}

/**
 * 【SAI-6.1新設】輸送中輸入原料のみの残数量（養殖中を含めない）。Raw Material
 * Coverage Ratio（situationDiagnosis.ts）が「当期確実に取得可能な原料」を
 * growingAquaculture（未収穫の養殖投入。当期の生産には使えない）と区別して
 * 扱うために必要。既存のrawMaterialPipeline（両者の合計。既存コードが参照する
 * ため削除しない）とは独立した、新しい在庫認識ロジックを増設するのではなく、
 * 既存のRawMaterialLot.statusによる分類をそのまま使うだけの内訳の追加。
 */
function inTransitImportRawMaterialQuantity(ownState: CompanyOwnState): number {
  return ownState.rawMaterialLots.filter((l) => l.status === "inTransitImport").reduce((sum, l) => sum + unwrapUnit(l.remainingQuantity), 0);
}

/** 【SAI-6.1新設】養殖中（未収穫）の残数量のみ。当期利用可能原料には含めない。 */
function growingAquacultureRawMaterialQuantity(ownState: CompanyOwnState): number {
  return ownState.rawMaterialLots.filter((l) => l.status === "growingAquaculture").reduce((sum, l) => sum + unwrapUnit(l.remainingQuantity), 0);
}

/**
 * 【SAI-6.1新設】輸送中輸入原料のうち、既存のRawMaterialLot.availableFromPeriod
 * （到着・収穫予定四半期。既存フィールドをそのまま使う。新しいタイミング管理は
 * 増設しない）が当期以前の輸入ロットだけを「当期確実に取得可能」として集計する。
 * PeriodV2は"YYYYQn"形式の文字列であり、この範囲では文字列比較がそのまま
 * 時系列比較になる（既存のperiod.tsにcompare関数が無いための最小限の代替）。
 */
function certainInboundImportQuantityThisPeriod(ownState: CompanyOwnState, period: PeriodV2): number {
  return ownState.rawMaterialLots
    .filter((l) => l.status === "inTransitImport" && l.availableFromPeriod <= period)
    .reduce((sum, l) => sum + unwrapUnit(l.remainingQuantity), 0);
}

function outstandingContractByProduct(ownState: CompanyOwnState): ProductAmount {
  const result = { hoso: 0, pd: 0, vap: 0 };
  for (const c of ownState.contracts) {
    if (c.status === "open" || c.status === "partiallyFulfilled" || c.status === "overdue") {
      result[c.product] += unwrapUnit(c.outstandingQuantity);
    }
  }
  return result;
}

function finishedGoodsByProduct(ownState: CompanyOwnState): ProductAmount {
  const result = { hoso: 0, pd: 0, vap: 0 };
  for (const l of ownState.finishedGoodsLots) {
    if (l.status === "available") result[l.product] += unwrapUnit(l.remainingQuantity);
  }
  return result;
}

function referencePricesByMarketProduct(
  lastMarketResult: MarketQuarterResult | undefined
): Partial<Record<(typeof DEMAND_MARKET_IDS)[number], ProductAmount>> | undefined {
  if (!lastMarketResult) return undefined;
  const breakdown = deriveMarketReferencePrices(lastMarketResult, CURRENT_DESTINATION_MARKET_PRICE_COEFFICIENTS);
  const result: Partial<Record<(typeof DEMAND_MARKET_IDS)[number], ProductAmount>> = {};
  for (const market of DEMAND_MARKET_IDS) {
    result[market] = {
      hoso: unwrapUnit(breakdown[market].hoso),
      pd: unwrapUnit(breakdown[market].pd),
      vap: unwrapUnit(breakdown[market].vap),
    };
  }
  return result;
}

function buildMarkets(publicInfo: PublicMarketInfo): readonly MarketObservationEntry[] {
  const byMarket = referencePricesByMarketProduct(publicInfo.lastMarketResult);
  // 【Batch 002】市場×商品別の観測需要（2四半期前の実績、またはゲーム開始時点の
  // 既知市場情報）。publicInfo（＝プレイヤー画面が見るのと同一の公開情報）から
  // そのまま転記するだけで、当期の実需要・将来の需要には一切アクセスしない。
  const observed = publicInfo.observedMarketDemand;
  return DEMAND_MARKET_IDS.map((market) => {
    const entry = observed?.entries.find((e) => e.market === market);
    return {
      market,
      referencePriceByProduct: byMarket ? byMarket[market] : undefined,
      ...(entry
        ? {
            observedDemandByProduct: {
              hoso: entry.observedDemandByProduct.hoso,
              pd: entry.observedDemandByProduct.pd,
              vap: entry.observedDemandByProduct.vap,
            },
          }
        : {}),
    };
  });
}

/**
 * 【Standard AI Capability Expansion・Phase CE-3新設】前四半期のBatchQualityAdjustment
 * （会社×工場×商品）を、Factory単位（商品横断）へ集計する。生産量加重平均の
 * operationalRisk、tons単位のdowngrade/rework/disposal、major incident発生有無、
 * 品質敏感商品（PD+VAP）の生産量シェアだけを求める（新しい品質計算はしない。
 * 既存のBatchQualityAdjustment.risk.operationalRiskとdowngrade/rework/discard
 * Quantityをそのまま合算・加重するだけ）。
 */
function aggregateQualityMetricsByFactory(
  adjustments: readonly BatchQualityAdjustment[]
): ReadonlyMap<string, FactoryObservation["qualityMetrics"]> {
  const byFactory = new Map<string, BatchQualityAdjustment[]>();
  for (const a of adjustments) {
    const list = byFactory.get(a.factoryId) ?? [];
    list.push(a);
    byFactory.set(a.factoryId, list);
  }
  const result = new Map<string, FactoryObservation["qualityMetrics"]>();
  for (const [factoryId, list] of byFactory) {
    let productionTons = 0;
    let qualitySensitiveProductionTons = 0;
    let downgradeTons = 0;
    let reworkTons = 0;
    let disposalTons = 0;
    let riskWeightedSum = 0;
    let majorIncidentOccurred = false;
    for (const a of list) {
      const tons = unwrapUnit(a.originalFinishedGoodsQuantity);
      productionTons += tons;
      if (a.product !== "hoso") qualitySensitiveProductionTons += tons;
      downgradeTons += unwrapUnit(a.downgradeQuantity);
      reworkTons += unwrapUnit(a.reworkQuantity);
      disposalTons += unwrapUnit(a.discardQuantity);
      riskWeightedSum += a.risk.operationalRisk * tons;
      if (a.outcome.majorIncident.occurred) majorIncidentOccurred = true;
    }
    result.set(factoryId, {
      operationalRisk: productionTons > EPSILON ? riskWeightedSum / productionTons : 0,
      downgradeTons,
      reworkTons,
      disposalTons,
      majorIncidentOccurred,
      productionTons,
      qualitySensitiveProductionTons,
    });
  }
  return result;
}

const ZERO_QUALITY_METRICS: FactoryObservation["qualityMetrics"] = {
  operationalRisk: 0,
  downgradeTons: 0,
  reworkTons: 0,
  disposalTons: 0,
  majorIncidentOccurred: false,
  productionTons: 0,
  qualitySensitiveProductionTons: 0,
};

function buildFactoryObservations(fixture: CompanyFixture, ownState: CompanyOwnState, period: PeriodV2): readonly FactoryObservation[] {
  // 【SAI-5F修正（Fable事前監査で特定した既存の観測ギャップ）】完成・稼働開始済み
  // のcapex能力増加を、エンジン側（runner.tsのapplyCapexCapacityToFactories）と
  // 同じ規則で観測へ反映する。従来は静的fixtureの能力のみを観測していたため、
  // 増設が完成してもAIは旧能力を分母に使い続け、同じボトルネックを恒久的に
  // 再提案し得た（判断根拠と実際のエンジン能力の食い違い）。
  //
  // 【2026-08-09・Vision駆動成長】この算出を capex/factoryConstruction.ts の
  // computeEffectiveFactories（runner.ts・simulation engine・AI Analysis Pack が
  // 使うのと同一の関数）へ置き換える。従来はここでライン増設ぶんだけを手計算で
  // 主工場へ加算していたため、**稼働開始した新工場（newFactoryConstruction）が
  // Standard AI からは一切見えなかった**。新工場を Standard AI の候補にする以上、
  // 建てた工場が観測に現れないままでは「建てても能力が増えていないと認識し続ける」
  // という致命的な不整合になる。加算規則（主工場へ寄せる・HOSO能力の上限）は
  // エンジン本体と完全に同一になり、この層で能力を再計算しない。
  const effectiveFactories = computeEffectiveFactories(fixture.factories, { companies: [ownState.capexState] }, period);
  // 【Standard AI Capability Expansion・Phase CE-3新設】品質管理設備の状態・前四半期
  // 品質実績は、いずれもFactory一覧全体を1回だけ渡して事前計算する（PD省人化投資と
  // 同じパターン。Factoryごとに毎回portfolio全体を再走査しない）。
  const qualityEquipmentStatusByFactory = resolveQualityEquipmentStatusByFactory(
    { companies: [ownState.capexState] },
    effectiveFactories,
    period
  );
  const qualityMetricsByFactory = aggregateQualityMetricsByFactory(ownState.lastQuarterQualityAdjustments);
  // 【Standard AI Factory Activation・Phase FA-1・監査で発見した既存バグ】新設Factory
  // （newFactoryConstruction完成後にこの一覧へ現れるFactory）はfixture.workerBaseline
  // に存在しないため、従来skillByProductが常にゼロのままだった。skill=0は
  // computeRequiredRegularHeadcount（companyLab/workforce.ts）上「必要人数を
  // 計算できない（要求量に関わらず0人と算出される）」ことを意味するため、
  // 新設Factoryはproductionを計画しても常にrequiredRegularHeadcount=0となり、
  // 労働力配属が恒久的に発生しない構造的デッドロックの根本原因だった
  // （companyLab/standardAi/decision/labor.tsのbaseline合成だけでは解決しない。
  // labor.ts側はfactoryObs.skillByProductを優先して読むため、ここ＝唯一の
  // FactoryObservation生成元を直さないと効果が出ない）。新しいskill-rampモデルは
  // 作らず、同一会社の既存Factory（workerBaselineに存在するFactory）の平均skillを
  // 流用する（無ければ1.0=フルスキル）。
  const companySkillAverage: ProductAmount = zeroProductAmount();
  if (fixture.workerBaseline.length > 0) {
    for (const product of ["hoso", "pd", "vap"] as const) {
      const samples = fixture.workerBaseline
        .map((w) => unwrapUnit(w.skills.find((s) => s.product === product)?.skillLevel ?? (0 as never)))
        .filter((v) => Number.isFinite(v) && v > 0);
      companySkillAverage[product] = samples.length > 0 ? samples.reduce((s, v) => s + v, 0) / samples.length : 1;
    }
  } else {
    companySkillAverage.hoso = 1;
    companySkillAverage.pd = 1;
    companySkillAverage.vap = 1;
  }
  return effectiveFactories.map((f) => {
    const baseline = fixture.workerBaseline.find((w) => w.factoryId === f.factoryId);
    const currentRegularHeadcount =
      findFactoryRegularHeadcount({ companies: [ownState.workforceState] }, fixture.companyId, f.factoryId) ?? baseline?.regularHeadcount ?? 0;
    const skillByProduct: ProductAmount = baseline ? zeroProductAmount() : { ...companySkillAverage };
    if (baseline) {
      for (const s of baseline.skills) {
        skillByProduct[s.product] = unwrapUnit(s.skillLevel);
      }
    }
    const nominalHoso = unwrapUnit(f.hosoCapacity);
    const nominalPd = unwrapUnit(f.pdCapacity);
    const nominalVap = unwrapUnit(f.vapCapacity);
    const nominalCommon = unwrapUnit(f.commonProcessingCapacity);
    const nominalFreezing = unwrapUnit(f.freezingPackagingCapacity);

    // 【2026-08-02・能力認識監査対応】上のcapacityByProduct/commonProcessingCapacity/
    // freezingPackagingCapacityは「名目能力」（capex加算後、稼働率・設備利用可能率は
    // 未適用）である。これがStandard AIに「24,000t生産可能」のような過大な能力認識を
    // させていた（能力認識監査 Phase 3 参照）。ここで、production/capacity.tsの
    // calculateFactoryEffectiveCapacity（生産エンジン本体・allocation.tsが実際の生産
        // 制約として使うのと全く同じ純粋関数）を、capex加算後の名目値を持つ合成Factory
    // オブジェクトへ適用し、「実効能力」（baseUtilizationRate×equipmentAvailabilityRate
    // 適用後）を新たに算出する。新しい能力算出ロジックを増設するのではなく、既存の
    // 共有関数をそのまま再利用する（実装指示Phase 3「能力を単純に足し算して新しい
    // ロジックを作らず、production engineの共有能力制約を可能な限り再利用してください」）。
    const effective = calculateFactoryEffectiveCapacity({
      ...f,
      hosoCapacity: hosoEqTons(nominalHoso),
      pdCapacity: hosoEqTons(nominalPd),
      vapCapacity: hosoEqTons(nominalVap),
      commonProcessingCapacity: hosoEqTons(nominalCommon),
      freezingPackagingCapacity: hosoEqTons(nominalFreezing),
    });

    return {
      factoryId: f.factoryId,
      capacityByProduct: { hoso: nominalHoso, pd: nominalPd, vap: nominalVap },
      commonProcessingCapacity: nominalCommon,
      freezingPackagingCapacity: nominalFreezing,
      effectiveCapacityByProduct: {
        hoso: unwrapUnit(effective.hoso),
        pd: unwrapUnit(effective.pd),
        vap: unwrapUnit(effective.vap),
      },
      effectiveCommonProcessingCapacity: unwrapUnit(effective.commonProcessing),
      effectiveFreezingPackagingCapacity: unwrapUnit(effective.freezingPackaging),
      currentRegularHeadcount,
      skillByProduct,
      attendanceRate: baseline ? unwrapUnit(baseline.attendanceRate) : 1,
      pdMechanization: {
        previousQuarterPdUtilization: ownState.pdUtilizationByFactory.find((u) => u.factoryId === f.factoryId)?.previousQuarterPdUtilization ?? 0,
        hasActiveOrCompletedProject: ownState.capexState.portfolio.projects.some(
          (p) => p.projectType === "pdMechanization" && p.targetFactoryId === f.factoryId && (isActiveStatus(p.status) || p.status === "completed")
        ),
      },
      qualityEquipment: qualityEquipmentStatusFor(qualityEquipmentStatusByFactory, f.factoryId),
      qualityMetrics: qualityMetricsByFactory.get(f.factoryId) ?? ZERO_QUALITY_METRICS,
    };
  });
}

function totalCapacityByProduct(factories: readonly FactoryObservation[]): ProductAmount {
  return factories.reduce(
    (acc, f) => ({
      hoso: acc.hoso + f.capacityByProduct.hoso,
      pd: acc.pd + f.capacityByProduct.pd,
      vap: acc.vap + f.capacityByProduct.vap,
    }),
    zeroProductAmount()
  );
}

/** 【2026-08-02新設】実効能力（商品別）の会社合計。名目のtotalCapacityByProductと対になる。 */
function totalEffectiveCapacityByProduct(factories: readonly FactoryObservation[]): ProductAmount {
  return factories.reduce(
    (acc, f) => ({
      hoso: acc.hoso + f.effectiveCapacityByProduct.hoso,
      pd: acc.pd + f.effectiveCapacityByProduct.pd,
      vap: acc.vap + f.effectiveCapacityByProduct.vap,
    }),
    zeroProductAmount()
  );
}

function averageEquipmentUtilization(ownState: CompanyOwnState): number | undefined {
  const metrics = ownState.lastQuarterFactoryLoadMetrics;
  if (!metrics || metrics.length === 0) return undefined;
  const sum = metrics.reduce((s, m) => s + unwrapUnit(m.equipmentUtilizationRate), 0);
  return sum / metrics.length;
}

function averageLaborUtilization(ownState: CompanyOwnState): number | undefined {
  const metrics = ownState.lastQuarterFactoryLoadMetrics;
  if (!metrics || metrics.length === 0) return undefined;
  const sum = metrics.reduce((s, m) => s + unwrapUnit(m.laborUtilizationRate), 0);
  return sum / metrics.length;
}

function activeCapexTargets(ownState: CompanyOwnState, period: PeriodV2): ReadonlySet<Product | "commonProcessing" | "freezingPackaging" | "coldStorage"> {
  const targets = new Set<Product | "commonProcessing" | "freezingPackaging" | "coldStorage">();
  for (const project of ownState.capexState.portfolio.projects) {
    // 【SAI-5F修正（Fable事前監査）】従来はapproved/underConstructionのみを
    // 「進行中」とみなしていたため、(a) suspended（資金難で中断中。再開待ちの
    // 実在する案件）、(b) completedだが稼働開始前（readiness期間中の1〜2四半期）
    // の窓で同一ターゲットを重複提案し得た。cancelled と「completedかつ稼働開始
    // 済み（＝能力へ反映済み、上のcapexEffectが観測に含める）」だけを除外する。
    if (project.status === "cancelled") continue;
    if (project.status === "completed" && isCapexProjectOperationalAt(project, period)) continue;
    const target = project.futureCapacityEffect?.targetProduct;
    if (target) targets.add(target);
  }
  return targets;
}

/**
 * まだ稼働開始していない新工場建設案件の件数（取消を除く）。
 * 「もう1つ建て始めてよいか」を判断するための観測であり、ここで上限判定はしない。
 */
function pendingNewFactoryProjectCount(ownState: CompanyOwnState, period: PeriodV2): number {
  return ownState.capexState.portfolio.projects.filter(
    (p) =>
      p.projectType === "newFactoryConstruction" &&
      (isActiveStatus(p.status) || p.status === "completed") &&
      !isCapexProjectOperationalAt(p, period)
  ).length;
}

export function buildStandardAiObservation(
  fixture: CompanyFixture,
  ownState: CompanyOwnState,
  publicInfo: PublicMarketInfo,
  period: PeriodV2,
  turn: number
): StandardAiObservation {
  const factories = buildFactoryObservations(fixture, ownState, period);
  const lastMarketResult = publicInfo.lastMarketResult;

  // 【2026-08-09・Vision駆動成長】工場スペースは production/factorySpace.ts の
  // 既存の導出関数だけで算出する（この層で新しいスペース計算式を作らない）。
  const effectiveFactories = computeEffectiveFactories(fixture.factories, { companies: [ownState.capexState] }, period);
  let factorySpaceTotalUnits = 0;
  let factorySpaceUsedUnits = 0;
  for (const f of effectiveFactories) {
    factorySpaceTotalUnits += resolveFactoryTotalSpaceUnits(f, FACTORY_SPACE_PARAMETERS_V1);
    factorySpaceUsedUnits += computeFactoryUsedSpaceUnits(f, FACTORY_SPACE_PARAMETERS_V1);
  }
  const pendingNewFactories = pendingNewFactoryProjectCount(ownState, period);

  return {
    companyId: fixture.companyId,
    period,
    turn,

    outstandingContractByProduct: outstandingContractByProduct(ownState),
    finishedGoodsByProduct: finishedGoodsByProduct(ownState),
    rawMaterialAvailable: availableRawMaterialQuantity(ownState),
    rawMaterialPipeline: pipelineRawMaterialQuantity(ownState),
    // 【SAI-6.1新設】既存のrawMaterialPipeline（輸送中輸入＋養殖中の合計）の内訳。
    // Situation Diagnosisのみが参照する（既存のpressures.rawMaterialInventoryPosition
    // 等の計算は変更しない）。
    rawMaterialInTransitImportQuantity: inTransitImportRawMaterialQuantity(ownState),
    rawMaterialGrowingAquacultureQuantity: growingAquacultureRawMaterialQuantity(ownState),
    rawMaterialCertainInboundThisPeriod: certainInboundImportQuantityThisPeriod(ownState, period),

    factories,
    totalCapacityByProduct: totalCapacityByProduct(factories),
    totalCommonProcessingCapacity: factories.reduce((s, f) => s + f.commonProcessingCapacity, 0),
    totalEffectiveCapacityByProduct: totalEffectiveCapacityByProduct(factories),
    totalEffectiveCommonProcessingCapacity: factories.reduce((s, f) => s + f.effectiveCommonProcessingCapacity, 0),
    totalEffectiveFreezingPackagingCapacity: factories.reduce((s, f) => s + f.effectiveFreezingPackagingCapacity, 0),
    aquacultureCapacity: unwrapUnit(fixture.aquacultureCapacity),
    // 【SAI-6.2】fixture.salesForceHeadcountTotal（静的な基準値）ではなく、
    // ownState.salesForceHiringState.headcount（前期末までに実際に確定した動的な
    // 現在人数）を観測する。turn1ではfixture値と同一のため既存挙動は変わらない
    // （設計レポート§14参照）。
    salesForceHeadcountTotal: ownState.salesForceHiringState.headcount,
    procurementHeadcountTotal: fixture.procurementHeadcountTotal,

    lastQuarterEquipmentUtilizationRate: averageEquipmentUtilization(ownState),
    lastQuarterLaborUtilizationRate: averageLaborUtilization(ownState),
    lastQuarterActualProductionByProduct: ownState.lastQuarterActualProductionByProduct,

    markets: buildMarkets(publicInfo),
    // 【Batch 002】観測需要のlag・出所を判断側から確認できるようにする
    // （「これは現在の確定需要ではない」ことを型の上で明示する）。
    marketDemandObservationLagQuarters: publicInfo.observedMarketDemand?.observationLagQuarters,
    marketDemandSourceQuarter: publicInfo.observedMarketDemand?.sourceQuarter ?? null,
    marketDemandObservationSource: publicInfo.observedMarketDemand?.observationSource,
    marketPremiumByProduct: {
      pd: lastMarketResult ? unwrapUnit(lastMarketResult.pdPremium.byCountry.VN.premium) : undefined,
      vap: lastMarketResult ? unwrapUnit(lastMarketResult.vapPremium.byCountry.VN.premium) : undefined,
    },
    vapProductDevelopmentScore: ownState.vapProductDevelopmentScore,
    vietnamDomesticPriorPrice: publicInfo.vietnamDomesticPriorPrice > EPSILON ? publicInfo.vietnamDomesticPriorPrice : undefined,
    // 【2026-08-02・能力認識監査Phase 2】publicInfo.lastMarketResult（既存の
    // MarketQuarterResult）は元からvietnamDomestic（VietnamDomesticResult。
    // supply/effectiveDemand/transactedVolume/unsoldSupplyを含む）を保持していた。
    // 従来はここでvietnamDomesticPriorPrice（価格のみ）しか転記しておらず、既に
    // 画面へ公開表示されている数量側の情報がStandardAiObservationに一切露出して
    // いなかった（能力認識監査Phase 4で確認した配線ギャップ）。新しい市場ルールは
    // 追加せず、既存のlastMarketResult.vietnamDomesticから読み出すだけの追加。
    vietnamDomesticPriorMarket: lastMarketResult
      ? {
          supply: unwrapUnit(lastMarketResult.vietnamDomestic.supply),
          effectiveDemand: unwrapUnit(lastMarketResult.vietnamDomestic.effectiveDemand),
          transactedVolume: unwrapUnit(lastMarketResult.vietnamDomestic.transactedVolume),
          unsoldSupply: unwrapUnit(lastMarketResult.vietnamDomestic.unsoldSupply),
        }
      : undefined,
    lastHosoPriceVn: lastMarketResult ? unwrapUnit(lastMarketResult.hosoPrices.VN.price) : undefined,

    productEconomics: {
      expectedProcessingCostUsdPerHosoEqKg: fixture.productEconomics.expectedProcessingCostUsdPerHosoEqKg,
    },

    cashUsd: unwrapUsd(ownState.financeState.cash),
    existingLoanBalanceUsd: ownState.financingState.loanPortfolio.loans.reduce((s, l) => s + l.currentPrincipalUsd, 0),
    regularHeadcountTotal: factories.reduce((s, f) => s + f.currentRegularHeadcount, 0),

    // 【2026-08-03新設・Phase E】ReceivableRecord/PayableRecordの既存
    // dueSettlementPeriodをそのまま当期と比較して集計するだけで、新しい回収・支払
    // ルールは作らない。
    receivablesDueThisPeriodUsd: ownState.financeState.receivables
      .filter((r) => r.dueSettlementPeriod === period)
      .reduce((s, r) => s + unwrapUsd(r.amount), 0),
    receivablesNotYetDueUsd: ownState.financeState.receivables
      .filter((r) => r.dueSettlementPeriod !== period)
      .reduce((s, r) => s + unwrapUsd(r.amount), 0),
    payablesDueThisPeriodUsd: ownState.financeState.payables
      .filter((p) => p.dueSettlementPeriod === period)
      .reduce((s, p) => s + unwrapUsd(p.amount), 0),
    payablesNotYetDueUsd: ownState.financeState.payables
      .filter((p) => p.dueSettlementPeriod !== period)
      .reduce((s, p) => s + unwrapUsd(p.amount), 0),
    existingLoanInterestUsdThisQuarterEstimate: ownState.financingState.loanPortfolio.loans.reduce(
      (s, l) => s + computeLoanQuarterlyInterest(l, period),
      0
    ),
    existingLoanScheduledPrincipalDueUsdThisQuarterEstimate: ownState.financingState.loanPortfolio.loans.reduce(
      (s, l) => s + computeScheduledPrincipalDue(l, period),
      0
    ),
    // availableBorrowingHeadroomUsd: 意図的に未設定（undefined）。ファイル冒頭の
    // types.tsコメント参照（捏造しない）。

    // 【Standard AI Crisis Management・Phase CM-1】前Turnの資金繰りクローズ結果
    // （ownState.lastFinancingResult。既にfinancing/liquidityClose.ts・
    // bankUnderwriting.tsが計算済み）をそのまま渡すだけ。新しい計算はしない。
    lastQuarterProcurementScaleRatio: ownState.lastFinancingResult?.procurementConstraint?.scaleRatio ?? null,
    lastQuarterUnderwritingFrozen: ownState.lastFinancingResult?.borrowingCapacity.underwritingFrozen ?? null,
    lastQuarterImportOrdersBlocked: ownState.lastFinancingResult?.procurementConstraint?.importOrdersBlocked ?? null,
    lastQuarterFinancialHealthTier: ownState.lastFinancingResult?.financialHealth.primary ?? null,

    factoryCount: effectiveFactories.length,
    maxFactoriesPerCompany: MAX_FACTORIES_PER_COMPANY,
    pendingNewFactoryProjectCount: pendingNewFactories,
    prospectiveFactoryCount: effectiveFactories.length + pendingNewFactories,
    factorySpaceTotalUnits,
    factorySpaceUsedUnits,
    factorySpaceRemainingUnits: factorySpaceTotalUnits - factorySpaceUsedUnits,

    activeCapexProjectTargets: activeCapexTargets(ownState, period),
    // 【SAI-5F】中断中案件（projectId昇順の決定論的順序。resume提案の対象）。
    suspendedCapexProjectIds: ownState.capexState.portfolio.projects
      .filter((p) => p.status === "suspended")
      .map((p) => p.projectId)
      .sort(),

    qualityScoreByProduct: ownState.qualityScoreByProduct,
    customerTrustByMarket: ownState.customerTrustByMarket,
    deliveryReliabilityByMarket: ownState.deliveryReliabilityByMarket,

    // 【SAI-5D】自社の営業基盤（前四半期末までの値。ownState経由の一本道）。
    salesBaseByMarketProduct: ownState.salesBaseByMarketProduct,
    salesBaseCompetitivenessWeight: ownState.salesBaseCompetitivenessWeight,

    // 【SAI-5C】ライフサイクル公開トレンド（前四半期までの公開情報のみ。
    // publicInfo経由の一本道＝当期需要の先読みリークはない）。
    lifecycleSharesByMarket: publicInfo.productLifecycleOutlook?.sharesByMarket,
    lifecycleTrendByMarket: publicInfo.productLifecycleOutlook?.quarterlyTrendByMarket,

    // 【SAI-5E】商品別供給圧力の公開統計（前四半期末までのEWMA）。
    productSupplyPressureByProduct: publicInfo.productSupplyPressureOutlook,
  };
}
