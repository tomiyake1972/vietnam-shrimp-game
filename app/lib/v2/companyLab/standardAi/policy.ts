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
import { SALES_PARAMETERS_V1 } from "../../sales/parameters";

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
  params: StandardAiParameters = STANDARD_AI_PARAMETERS_V1
): StandardAiDecisionWithDiagnostics {
  const observation = buildStandardAiObservation(fixture, ownState, publicInfo, period, turn);
  const pressures = computePressureScores(observation, fixture, params);

  const salesResult = buildStandardAiSalesPlans(fixture, observation, pressures, params);

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
  const financingResult = buildStandardAiFinancingRequest(observation, pressures, params);
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
  const salesForceHiringResult = buildStandardAiSalesForceHiringDecision({
    fixture,
    observation,
    pressures,
    params,
    salesParams: SALES_PARAMETERS_V1,
    salesWishByMarketProduct: salesResult.salesWishByMarketProduct,
    finalProductionRequirementByProduct: finalProductionRequirementByProduct,
    totalEffectiveCapacityByProduct: observation.totalEffectiveCapacityByProduct,
    unitEconomics: unitEconomicsResult,
    rawMaterialSupplyConstraintState: situationDiagnosisResult.diagnosis.rawMaterialSupplyConstraintState,
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
    capexDecision: capexResult.capexDecision,
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
    ...salesForceHiringResult.diagnostics,
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
  const diagnostics: StandardAiQuarterDiagnostics[] = [];
  const provider: CompanyDecisionProvider = (fixture, ownState, publicInfo, period, turn) => {
    if (!resolveParams) {
      const result = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, period, turn);
      diagnostics.push(result.diagnostics);
      return result.decision;
    }

    const resolution = resolveParams(fixture.companyId);
    const result = generateStandardAiDecisionWithDiagnostics(fixture, ownState, publicInfo, period, turn, resolution.params);

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
