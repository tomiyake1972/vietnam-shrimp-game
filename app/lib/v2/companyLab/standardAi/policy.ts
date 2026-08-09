// ShrimpX V2 — Phase SAI-1: 標準経営AI基盤 オーケストレーター
//
// 【目的（SAI-1、実装指示の非目標を明示）】本モジュールは「最強のAI」でも
// 「個性を演じ分けるAI」でもない。目的は (1) バランス調整用の自動テストプレイヤー、
// (2) 将来のAI改善の比較対象となるベースライン方針、(3) 将来のAI取締役会提案機能の
// 土台、(4) 意思決定→結果の因果関係を追跡・診断する基盤の4つである。
//
// 【全社同一ロジック】5社すべてに同一の判断ロジック・同一の閾値
// （parameters.ts、STANDARD_AI_PARAMETERS_V1）・同一の情報範囲を適用する。
// 会社IDによる分岐は一切行わない。結果が会社ごとに異なるのは各社の実際の状態
// （CompanyFixture・CompanyOwnState）が異なるためであり、AI側のロジックが
// 会社を特別扱いしているからではない。
//
// 【情報境界】本モジュールが呼び出す各ドメイン生成関数は、いずれも
// StandardAiObservation（fixture・ownState・publicInfoだけから機械的に導出した
// スナップショット、observation.ts参照）とPressureScoresだけを主入力として使う。
// 生のturn runner状態・他社の非公開情報・将来の乱数は、関数シグネチャ上そもそも
// 受け取れない。

import { PeriodV2 } from "../../core/period";
import { unwrapUnit } from "../../core/units";
import { CompanyDecisionInput, CompanyDecisionProvider, CompanyFixture, CompanyOwnState, PublicMarketInfo } from "../types";
import { buildStandardAiObservation } from "./observation";
import { computePressureScores } from "./pressures";
import { StandardAiParameters, STANDARD_AI_PARAMETERS_V1 } from "./parameters";
import { buildStandardAiSalesPlans } from "./decision/sales";
import { buildStandardAiProductionPlans } from "./decision/production";
import { buildStandardAiProcurementPlan } from "./decision/procurement";
import { buildStandardAiWorkerAssignments } from "./decision/labor";
import { buildStandardAiFinancingRequest } from "./decision/finance";
import { buildStandardAiCapexDecision } from "./decision/capex";
import { sumProductAmount } from "./types";
import { StandardAiDiagnosticEntry } from "./reasonCodes";
import { SalesWishEntry } from "./decision/sales";
import { PressureScores } from "./pressures";
import { AppliedManagementBiasItem } from "./managementProfile";
import { buildCurrentPeriodDeliveryDemand, CurrentPeriodDeliveryDemand } from "./diagnosis/currentPeriodDeliveryDemand";
import { buildStandardAiSituationDiagnosis, StandardAiSituationDiagnosis } from "./diagnosis/situationDiagnosis";
import {
  computeBasicCurrentPeriodProductionRequirement,
  computeEligibleCurrentPeriodDemand,
  computeFinalProductionRequirement,
  computeNormalInventoryTargetByProduct,
} from "./diagnosis/productionRequirement";
import { buildStandardAiUnitEconomics } from "./diagnosis/forwardUnitEconomics";
import { buildStandardAiSalesForceHiringDecision } from "./decision/salesForceHiring";
import { SALES_PARAMETERS_V1, SalesParameters } from "../../sales/parameters";
import { computeTargetScaleBand } from "./targetScale";
import { computeTargetCapability } from "./targetCapability";
import { STANDARD_AI_STRATEGIC_INTENT_V1 } from "./strategicIntent";
import { defaultVisionDocumentFor } from "../vision/defaults";
import { resolveVisionAtTurn, CompanyVision } from "../vision/types";
import { computeStrategicGrowthState, StrategicGrowthState } from "../vision/strategicGrowth";
import { CommercialAmbition, computeCommercialAmbition } from "../vision/commercialAmbition";
import { computeUnservedOpportunity, UnservedOpportunity } from "../vision/unservedOpportunity";
import { buildCommercialGrowthDiagnostics } from "./diagnosis/commercialGrowth";
import { computeObservableCommercialOpportunity, ObservableCommercialOpportunity } from "./decision/sales";
import { evaluateNewFactoryDecision, NewFactoryAssessment } from "./decision/newFactory";

// 【SAI-1.5 追記／マージ前受入修正】原因分解レポート（三宅さん指示）のため、
// 診断情報にこれまで捨てていた圧力スコア(pressures)と、当四半期の意思決定
// そのもの(decision＝「希望値」)を追加で保持する。計算そのものは重複させない
// （generateStandardAiDecisionWithDiagnostics内で既に計算済みの値をそのまま
// 詰め直すだけ）。既存の`entries`の意味・件数は変更しない。
export interface StandardAiQuarterDiagnostics {
  readonly companyId: string;
  readonly turn: number;
  readonly period: PeriodV2;
  readonly entries: readonly StandardAiDiagnosticEntry[];
  /** 当四半期の圧力スコア一式（レポートの「圧力値推移」節で使用）。 */
  readonly pressures: PressureScores;
  /** 当四半期にAIが提出した意思決定（＝「希望値」。ゲーム側の実行値・補正後の
   *  値と対比するため、レポート生成側で companySummaries 等と突き合わせる）。 */
  readonly decision: CompanyDecisionInput;
  /** 【SAI-3A】営業工数制約を適用する前の、会社×市場×商品ぶんの希望販売数量
   *  （decision.salesPlansは制約適用後の値のため、両者を突き合わせることで
   *  「事前希望案→営業工数調整後」の差分を再計算なしで追跡できる）。 */
  readonly salesWishByMarketProduct: readonly SalesWishEntry[];
  /**
   * 【SAI-4追加】経営性格プロファイルが有効な場合のみ設定される（createStandardAiProvider
   * に resolveParams オプションを渡した場合。既定=undefinedであり、既存の全出力・
   * 全テストへの影響はゼロ）。実装指示§8「基準値→バイアス後」の追跡用。
   */
  readonly managementProfile?: StandardAiManagementProfileDiagnostics;
  /**
   * 【SAI-6.1・6.3追加】Situation Diagnosis（不足型／過剰型の6カテゴリ診断）と
   * Current Period Delivery Demand（当期納品需要、Standard AI内部の中間概念）。
   * 診断専用の並行計算であり、本インターフェースの`decision`（実際の意思決定）には
   * 一切影響しない（今回のスコープでは意思決定ロジックを変更していない）。
   *
   * 【永続化の後方互換】optionalとしているのは、Phase Aで永続化を始めた
   * 既存の`aiProposalDiagnostics`（persistence/types.ts）に、この変更より前に
   * 保存されたドラフトが存在する場合、これらのフィールドを持たないため
   * （persistence/schema.tsのshallow validatorはこの2フィールドを必須にしていない）。
   * generateStandardAiDecisionWithDiagnosticsが新規生成する値では常に設定される。
   */
  readonly situationDiagnosis?: StandardAiSituationDiagnosis;
  readonly currentPeriodDeliveryDemand?: CurrentPeriodDeliveryDemand;
  /**
   * 【2026-08-09新設・Vision駆動の戦略成長】その四半期に有効だった Vision と、
   * 志に対する現在地（strategic scale gap / growth pressure）。
   * Vision が与えられていない会社では undefined（架空の Vision を作らない）。
   */
  readonly vision?: CompanyVision;
  readonly strategicGrowth?: StrategicGrowthState;
  /**
   * 【Phase 6】観測できる商業機会・今期目指した販売規模・取れなかった採算つき機会。
   * Vision がどこまで商業判断へ伝わったかを、画面と Pack の双方から追えるようにする。
   */
  readonly commercialAmbition?: CommercialAmbition;
  readonly observableOpportunity?: ObservableCommercialOpportunity;
  readonly unservedOpportunity?: UnservedOpportunity;
  /** 新工場を検討した結果（提案しなかった場合も、どのゲートで止まったかを保持する）。 */
  readonly newFactoryAssessment?: NewFactoryAssessment;
}

/**
 * 【SAI-4追加】1社・1四半期ぶんの経営性格プロファイル適用結果（診断専用）。
 * 「STANDARD_AI_PARAMETERS_V1による基準判断」と「プロファイル適用後の判断
 * （＝実際にゲームへ提出される決定。安全ガードは既にdecision内に反映済み）」を
 * 区別できるようにするためのもの。
 */
export interface StandardAiManagementProfileDiagnostics {
  readonly profileId: string;
  /** このプロファイルが基準値から実際に変更したパラメータ項目一覧（0件=A社balanced相当）。 */
  readonly appliedBiasItems: readonly AppliedManagementBiasItem[];
  /**
   * バイアスなし（STANDARD_AI_PARAMETERS_V1）で同一入力を評価した場合の判断。
   * appliedBiasItemsが1件もない場合（バイアスなし＝decisionと数学的に同一になる）は
   * 無駄な二重計算を避けるため計算しない（undefined）。
   *
   * 【実装指示§4の制約への対応】Standard AI全体を大規模に二重実行するのではなく、
   * 「entryポイント（generateStandardAiDecisionWithDiagnostics）をもう一度、
   * 基準パラメータで呼ぶだけ」という最小実装にとどめている。ゲームエンジン・
   * 状態遷移・他四半期への影響は一切ない（純粋関数の再呼び出しのみ）。
   */
  readonly baselineDecision?: CompanyDecisionInput;
}

export interface StandardAiDecisionWithDiagnostics {
  readonly decision: CompanyDecisionInput;
  readonly diagnostics: StandardAiQuarterDiagnostics;
}

/**
 * 標準AIの意思決定一式を、診断情報つきで生成する（純粋関数。副作用・内部状態を
 * 一切持たない。同一入力・同一パラメータなら常に同一出力＝決定論的）。
 */
export function generateStandardAiDecisionWithDiagnostics(
  fixture: CompanyFixture,
  ownState: CompanyOwnState,
  publicInfo: PublicMarketInfo,
  period: PeriodV2,
  turn: number,
  params: StandardAiParameters = STANDARD_AI_PARAMETERS_V1,
  /** 【Phase 6B】営業パラメータの上書き（比較用。未指定なら既定）。 */
  salesParams: SalesParameters = SALES_PARAMETERS_V1
): StandardAiDecisionWithDiagnostics {
  const observation = buildStandardAiObservation(fixture, ownState, publicInfo, period, turn);
  const pressures = computePressureScores(observation, fixture, params);

  // 【2026-08-09・Phase 6】Vision → Commercial Ambition を**販売計画より前**に求める。
  // Phase 5 では Vision が新工場判断にしか届いておらず、販売希望量は
  // 「自社能力 × salesUtilizationTarget」だけで決まっていた（監査で実測）。
  const targetScaleResult = computeTargetScaleBand(fixture, observation, STANDARD_AI_STRATEGIC_INTENT_V1, params);
  const visionDocument = defaultVisionDocumentFor(fixture.companyId);
  const vision: CompanyVision | null = visionDocument ? resolveVisionAtTurn(visionDocument, turn) : null;
  const strategicGrowth: StrategicGrowthState | null = vision
    ? computeStrategicGrowthState({ vision, turn, currentSustainableScaleTons: targetScaleResult.currentSustainableScaleTons })
    : null;

  // 観測できる商業機会（採算つき）。未来の TRUE WORLD は含まれない。
  const observableOpportunity = computeObservableCommercialOpportunity(observation, salesParams);
  const capacityAnchorTons = sumProductAmount({ ...observation.totalCapacityByProduct }) * params.salesUtilizationTarget;
  const recentActualScaleTons =
    (observation.lastQuarterActualProductionByProduct.hoso ?? 0) +
    (observation.lastQuarterActualProductionByProduct.pd ?? 0) +
    (observation.lastQuarterActualProductionByProduct.vap ?? 0);
  const commercialAmbition = computeCommercialAmbition({
    vision,
    strategicGrowth,
    capacityAnchorTons,
    recentActualScaleTons,
    attainableProfitableTons: observableOpportunity.attainableProfitableTons,
    weightedContributionUsdPerKg: observableOpportunity.weightedContributionUsdPerKg,
    priceObservationMissing: observableOpportunity.priceObservationMissing,
    maxFinishedGoodsExcessRatio: Math.max(
      pressures.finishedGoodsExcessRatioByProduct.hoso,
      pressures.finishedGoodsExcessRatioByProduct.pd,
      pressures.finishedGoodsExcessRatioByProduct.vap
    ),
  });

  const salesResult = buildStandardAiSalesPlans(
    fixture,
    observation,
    pressures,
    params,
    salesParams,
    commercialAmbition.ambitionMultiplier
  );

  // 【SAI-6.4】生産計画の営業側inputを、工場能力起点の理論希望量（desiredByProduct）から
  // Standard AI内部の当期納品需要（currentPeriodDeliveryDemand、SAI-6.3）起点の
  // 「基本当期生産必要量」へ切り替える。当期納品需要は既にrealisticSalesByProduct
  // （現実的販売可能量）＋outstandingContractByProduct（既存契約）を含んでいるため、
  // ここで既存契約を再度加算しない（二重計上防止。実装指示C-2、および
  // diagnosis/productionRequirement.tsのコメント参照）。
  //
  // 【Unit Economics差し込み口（実装指示C-4）】computeEligibleCurrentPeriodDemand()は
  // 今回identity実装（当期納品需要をそのまま返す）。将来Unit Economics採算フィルターを
  // 実装する際は、この関数の内部だけを置き換える想定であり、production.ts・policy.tsの
  // 側は密結合させない。
  //
  // 【戦略先行生産（実装指示C-3）】今回は常に0（strategicProductionAdjustmentByProduct省略時
  // のデフォルト）。Test14 Turn1を含む今回のスコープでは戦略在庫理由が観測されていない。
  const deliveryDemandResult = buildCurrentPeriodDeliveryDemand(fixture.companyId, observation, salesResult.realisticSalesByProduct);
  const eligibleCurrentPeriodDemand = computeEligibleCurrentPeriodDemand(deliveryDemandResult.deliveryDemand);
  const normalInventoryTargetByProduct = computeNormalInventoryTargetByProduct(observation, params);
  const basicProductionRequirementByProduct = computeBasicCurrentPeriodProductionRequirement(
    eligibleCurrentPeriodDemand,
    normalInventoryTargetByProduct,
    observation.finishedGoodsByProduct
  );
  const finalProductionRequirementByProduct = computeFinalProductionRequirement(basicProductionRequirementByProduct);

  const productionResult = buildStandardAiProductionPlans(fixture, observation, pressures, finalProductionRequirementByProduct);
  const requiredRawMaterial = productionResult.productionPlans.reduce((sum, p) => sum + unwrapUnit(p.desiredQuantity), 0);
  const requiredRawMaterialUnconstrained = sumProductAmount(productionResult.neededByProduct);

  const procurementResult = buildStandardAiProcurementPlan(fixture, observation, pressures, requiredRawMaterial, period, params);
  const laborResult = buildStandardAiWorkerAssignments(fixture, observation, pressures, productionResult.productionPlans, params);
  // 【Test16】資金繰り判断へ当期の原料調達計画を渡す。これにより「原料を買うのに
  // 資金が要る」ことが借入判断の入力になる（従来は最低現金バッファだけで決めていた）。
  // 調達計画は上で確定済みであり、循環しない。
  const financingResult = buildStandardAiFinancingRequest(observation, pressures, params, {
    domesticDesiredQuantityTons: unwrapUnit(procurementResult.domesticPurchasePlan.desiredQuantity),
    importOrderedQuantityTons: procurementResult.importOrders.reduce((sum, o) => sum + unwrapUnit(o.orderedQuantity), 0),
  });
  const capexResult = buildStandardAiCapexDecision(
    fixture,
    observation,
    pressures,
    productionResult.neededByProduct,
    requiredRawMaterialUnconstrained,
    params
  );

  // 【SAI-6.4改訂】Current Period Delivery Demand（当期納品需要）は、今回から
  // decision.productionPlansの実際の入力として使われている（上で計算済みの
  // deliveryDemandResult）。診断出力としても、実際に使われた値をそのまま再利用する
  // （計算を重複させない）。
  //
  // 【SAI-6.1】Situation Diagnosis（不足型／過剰型の6カテゴリ診断）は、依然として
  // 診断専用の並行計算であり、上のdecisionには影響しない（診断内部で再計算する
  // 基本当期生産必要量は、上のfinalProductionRequirementByProductと同じ共通実装
  // diagnosis/productionRequirement.tsを使うため、値は一致する）。
  const situationDiagnosisResult = buildStandardAiSituationDiagnosis(
    fixture,
    observation,
    pressures,
    salesResult.desiredByProduct,
    salesResult.realisticSalesByProduct,
    deliveryDemandResult.deliveryDemand,
    params
  );

  // 【2026-08-05新設・営業採用/減員】market opportunity(Forward Unit Economics)→
  // sales capacity→production capacity→raw material→cashの連鎖で、1人ずつの
  // marginal economicsを確認しながらsalesForceHireCount/salesForceLayoffCountを
  // 決定する。production decision・Worker decision・procurement decision・
  // finance decisionのいずれの計算結果も変更しない（既に計算済みの値を読むだけ）。
  const unitEconomicsResult = buildStandardAiUnitEconomics(observation);

  // 【2026-08-05新設・Strategic Intent / Target Scale】三宅さんご指示により、
  // 「限界利益が正な間は増員」ではなく「この会社が目指す規模（Target Scale Band）
  // に必要な人数」を営業採用判断の中心に据える。Strategic Intentは今回、Standard AI
  // 共通のBALANCED_GROWTHを使う（会社別性格への拡張は将来、この定数を差し替える
  // だけで済む設計）。8期先市場の精密予測は行わず、現在の会社規模・実効生産能力・
  // 成長姿勢から算定する（targetScale.ts参照）。
  const liquidityFloorUsdForCapability = observation.cashUsd - pressures.targetMinimumCashUsd;
  const approxVariableCostUsdPerTon =
    (observation.productEconomics.expectedProcessingCostUsdPerHosoEqKg.hoso +
      observation.productEconomics.expectedProcessingCostUsdPerHosoEqKg.pd +
      observation.productEconomics.expectedProcessingCostUsdPerHosoEqKg.vap) /
    3 /
    1000; // USD/kg -> USD/トン簡易換算（3商品単純平均。精密な商品別配分はここでは行わない）。
  const targetCapabilityResult = computeTargetCapability({
    fixture,
    observation,
    targetScaleBand: targetScaleResult.targetScaleBand,
    liquidityFloorUsd: liquidityFloorUsdForCapability,
    approxVariableCostUsdPerTon,
  });

  // 【2026-08-09新設・Vision駆動の戦略成長】会社の「志」（Vision）を外から与え、
  // その志と現在地の差（strategic scale gap）から成長圧力を測る。
  //
  // 【役割分担】Vision を決めるのは人間の経営者であり、Standard AI ではない。
  // Standard AI はここで成長目標を発明せず、与えられた志に対する遅れへ反応するだけ。
  // 未来の TRUE WORLD は computeStrategicGrowthState の引数に存在しない。
  // 【Phase 6】取りたかったが取れなかった採算つき機会と、その原因分解。
  // 「稼働率がまだ75%だから新工場は不要」だけで判断しないための一次情報である。
  const submittedSalesTons = salesResult.salesPlans.reduce((sum, p) => sum + unwrapUnit(p.desiredQuantity), 0);
  const desiredBeforeEffortTons = salesResult.salesWishByMarketProduct.reduce(
    (sum, w) => sum + w.desiredQuantityBeforeEffortConstraint,
    0
  );
  const bindingProductionCapacityTons = Math.min(
    sumProductAmount({ ...observation.totalEffectiveCapacityByProduct }),
    observation.totalEffectiveCommonProcessingCapacity
  );
  const unservedOpportunity = computeUnservedOpportunity({
    commercialAmbitionTons: commercialAmbition.ambitionTons,
    desiredBeforeEffortTons,
    submittedSalesTons,
    bindingProductionCapacityTons,
    heldByInventory: commercialAmbition.limiter === "INVENTORY_EXCESS",
    // 【推測しない】労働・原料が制約かどうかは、既存の状況診断が名指しした場合だけ。
    laborIsBindingConstraint: situationDiagnosisResult.diagnosis.workerLoadState === "shortage",
    rawMaterialIsBindingConstraint: situationDiagnosisResult.diagnosis.rawMaterialSupplyConstraintState === "shortage",
  });

  const commercialGrowthDiagnostics = buildCommercialGrowthDiagnostics({
    companyId: fixture.companyId,
    vision,
    strategicGrowth,
    opportunity: observableOpportunity,
    ambition: commercialAmbition,
    unserved: unservedOpportunity,
    submittedSalesTons,
  });

  // 【新工場は既存増設とは別の判断】既存の capex.ts（今期このラインが足りるか）とは
  // 独立した戦略評価を行う。提案しなかった場合も理由コードを必ず残す。
  const newFactoryResult = evaluateNewFactoryDecision({
    fixture,
    observation,
    pressures,
    vision,
    strategicGrowth,
    productionNeededByProductBeforeCap: productionResult.neededByProduct,
    existingExpansionProposedThisQuarter: capexResult.capexDecision.newProjectProposals.length > 0,
    commercialAmbition,
    unservedOpportunity,
    // 【§23 持続性】一時的な好況で工場を建てない。
    // 「前四半期に工場を実際に満杯まで回していた（既存の sustained しきい値を再利用）」
    // かつ「今期の志がその能力を超えている」ときだけ、持続的な能力不足の根拠とみなす。
    // 新しい閾値は発明していない（capexSustainedUtilizationThreshold をそのまま使う）。
    persistentCapacityCausedUnserved:
      pressures.hadPriorQuarterUtilization &&
      bindingProductionCapacityTons > 0 &&
      recentActualScaleTons >= bindingProductionCapacityTons * params.capexSustainedUtilizationThreshold,
  });

  const salesForceHiringResult = buildStandardAiSalesForceHiringDecision({
    fixture,
    observation,
    pressures,
    params,
    salesParams,
    salesWishByMarketProduct: salesResult.salesWishByMarketProduct,
    finalProductionRequirementByProduct: finalProductionRequirementByProduct,
    totalEffectiveCapacityByProduct: observation.totalEffectiveCapacityByProduct,
    unitEconomics: unitEconomicsResult,
    rawMaterialSupplyConstraintState: situationDiagnosisResult.diagnosis.rawMaterialSupplyConstraintState,
    targetScaleBand: targetScaleResult.targetScaleBand,
    hasNearTermCapexUnderConstruction: targetCapabilityResult.hasNearTermCapexUnderConstruction,
    commercialAmbitionTons: commercialAmbition.ambitionTons,
  });

  const decision: CompanyDecisionInput = {
    companyId: fixture.companyId,
    salesPlans: salesResult.salesPlans,
    salesForceHireCount: salesForceHiringResult.salesForceHireCount > 0 ? salesForceHiringResult.salesForceHireCount : undefined,
    salesForceLayoffCount: salesForceHiringResult.salesForceLayoffCount > 0 ? salesForceHiringResult.salesForceLayoffCount : undefined,
    domesticPurchasePlan: procurementResult.domesticPurchasePlan,
    importOrders: procurementResult.importOrders,
    aquacultureStockingPlans: procurementResult.aquacultureStockingPlans,
    productionPlans: productionResult.productionPlans,
    workerAssignments: laborResult.workerAssignments,
    financingRequest: financingResult.financingRequest,
    // 【新工場の提案を既存 capex 提案と同じ意思決定へ合流させる】
    // 既存増設の提案内容は一切変更せず、新工場ぶんを末尾へ足すだけにする
    // （既存の設備投資判断の挙動を変えない）。
    capexDecision:
      newFactoryResult.proposals.length > 0
        ? {
            ...capexResult.capexDecision,
            newProjectProposals: [...capexResult.capexDecision.newProjectProposals, ...newFactoryResult.proposals],
          }
        : capexResult.capexDecision,
  };

  const strategicTargetScaleDiagnostic: StandardAiDiagnosticEntry = {
    code: "STRATEGIC_TARGET_SCALE_SET",
    domain: "diagnosis",
    companyId: fixture.companyId,
    severity: "info",
    keyValues: {
      targetMinTons: targetScaleResult.targetScaleBand.quarterlySalesTons.min,
      targetPreferredTons: targetScaleResult.targetScaleBand.quarterlySalesTons.preferred,
      targetMaxTons: targetScaleResult.targetScaleBand.quarterlySalesTons.max,
      currentSustainableScaleTons: targetScaleResult.currentSustainableScaleTons,
    },
    decisionSummary: `Target Scale Band: ${Math.round(targetScaleResult.targetScaleBand.quarterlySalesTons.min)}〜${Math.round(
      targetScaleResult.targetScaleBand.quarterlySalesTons.max
    )}t/期（preferred ${Math.round(targetScaleResult.targetScaleBand.quarterlySalesTons.preferred)}t/期）`,
    message: `Strategic Intent（${STANDARD_AI_STRATEGIC_INTENT_V1.growthPosture}）と現在の持続可能規模（約${Math.round(
      targetScaleResult.currentSustainableScaleTons
    )}t/期）から、Target Scale Bandを${Math.round(targetScaleResult.targetScaleBand.quarterlySalesTons.min)}〜${Math.round(
      targetScaleResult.targetScaleBand.quarterlySalesTons.max
    )}t/期（preferred ${Math.round(
      targetScaleResult.targetScaleBand.quarterlySalesTons.preferred
    )}t/期）と算定した。8期先市場の精密予測ではなく、現時点の会社規模・実効生産能力・成長姿勢からの逆算である${
      targetScaleResult.marketOpportunityDirection ? `（補助情報: 市場機会の方向性=${targetScaleResult.marketOpportunityDirection}）` : ""
    }。`,
  };

  const entries: StandardAiDiagnosticEntry[] = [
    ...salesResult.diagnostics,
    ...productionResult.diagnostics,
    ...procurementResult.diagnostics,
    ...laborResult.diagnostics,
    ...financingResult.diagnostics,
    ...capexResult.diagnostics,
    ...deliveryDemandResult.diagnostics,
    ...situationDiagnosisResult.diagnostics,
    strategicTargetScaleDiagnostic,
    ...targetCapabilityResult.diagnostics,
    ...salesForceHiringResult.diagnostics,
    ...commercialGrowthDiagnostics,
    ...newFactoryResult.diagnostics,
  ];

  return {
    decision,
    diagnostics: {
      companyId: fixture.companyId,
      turn,
      period,
      entries,
      pressures,
      situationDiagnosis: situationDiagnosisResult.diagnosis,
      currentPeriodDeliveryDemand: deliveryDemandResult.deliveryDemand,
      decision,
      salesWishByMarketProduct: salesResult.salesWishByMarketProduct,
      ...(vision ? { vision } : {}),
      ...(strategicGrowth ? { strategicGrowth } : {}),
      commercialAmbition,
      observableOpportunity,
      unservedOpportunity,
      newFactoryAssessment: newFactoryResult.assessment,
    },
  };
}

/**
 * CompanyDecisionProvider型に一致する、標準AIの意思決定生成関数
 * （companyLab/runner.tsのrunCompanyLabWithAutoPolicyForAllCompaniesへ
 * そのまま渡せる）。診断情報が不要な呼び出し元（既存の自動テスト・CLI標準実行）
 * 向けの薄いラッパーであり、内部でgenerateStandardAiDecisionWithDiagnosticsを
 * 呼ぶだけで計算を重複させない。
 */
export function generateStandardAiDecision(
  fixture: CompanyFixture,
  ownState: CompanyOwnState,
  publicInfo: PublicMarketInfo,
  period: PeriodV2,
  turn: number
): CompanyDecisionInput {
  return generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, period, turn).decision;
}

// CompanyDecisionProvider型と完全に一致することをコンパイル時に保証する。
const _typeCheck: CompanyDecisionProvider = generateStandardAiDecision;
void _typeCheck;

/**
 * 【診断情報の収集】自動テストプレイ・CLI（--format=json等）が、計算を一切
 * 重複させずに全社・全四半期の診断情報を読み取れるようにするためのクロージャ。
 * providerはCompanyDecisionProviderと完全に同じ形（純粋関数として呼び出し可能）で
 * あり、副作用は「呼ばれるたびにdiagnostics配列へ今回ぶんを追記する」ことだけに
 * 限定される（意思決定の計算結果そのものは、直接generateStandardAiDecisionを
 * 呼んだ場合と完全に同一。決定論性・再現性に影響しない）。
 */
export interface StandardAiParamsResolution {
  readonly params: StandardAiParameters;
  readonly profileId: string;
  readonly appliedBiasItems: readonly AppliedManagementBiasItem[];
}

export interface StandardAiProviderOptions {
  /** 【Phase 6B】営業パラメータの上書き（候補モデル比較用）。 */
  readonly salesParams?: SalesParameters;
  /**
   * 【SAI-4追加】会社IDごとにStandardAiParametersを解決する関数（省略時=undefinedなら
   * 従来どおり全社STANDARD_AI_PARAMETERS_V1固定。既存の呼び出し元は一切変更不要で、
   * 既存の全出力・全テストへの影響はゼロ）。
   *
   * 【会社IDによる分岐の集約】本オプションを注入する側（managementProfile.tsの
   * createManagementProfileParamsResolver等）だけが会社IDによる分岐を持ち、
   * policy.ts自身は「渡された関数をfixture.companyIdで呼ぶ」以外の分岐を
   * 一切持たない。decision/*.tsの内部にも会社ID分岐は存在しない。
   */
  readonly resolveParams?: (companyId: string) => StandardAiParamsResolution;
}

export function createStandardAiProvider(
  options: StandardAiProviderOptions = {}
): {
  readonly provider: CompanyDecisionProvider;
  readonly diagnostics: StandardAiQuarterDiagnostics[];
} {
  const { resolveParams } = options;
  const salesParams = options.salesParams ?? SALES_PARAMETERS_V1;
  const diagnostics: StandardAiQuarterDiagnostics[] = [];
  const provider: CompanyDecisionProvider = (fixture, ownState, publicInfo, period, turn) => {
    if (!resolveParams) {
      const result = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, period, turn, STANDARD_AI_PARAMETERS_V1, salesParams);
      diagnostics.push(result.diagnostics);
      return result.decision;
    }

    const resolution = resolveParams(fixture.companyId);
    const result = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, period, turn, resolution.params, salesParams);

    // 【実装指示§4】バイアスが1件でも適用されている場合のみ、基準パラメータでの
    // 判断も計算し診断へ残す（バイアスなしの会社・四半期では省略し、Standard AI
    // 全体の実行コストを不必要に倍増させない）。
    const baselineDecision =
      resolution.appliedBiasItems.length > 0
        ? generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, period, turn, STANDARD_AI_PARAMETERS_V1).decision
        : undefined;

    diagnostics.push({
      ...result.diagnostics,
      managementProfile: {
        profileId: resolution.profileId,
        appliedBiasItems: resolution.appliedBiasItems,
        baselineDecision,
      },
    });
    return result.decision;
  };
  return { provider, diagnostics };
}
