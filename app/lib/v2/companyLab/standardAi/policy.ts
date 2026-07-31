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
import { buildStandardAiFinancingRequest, FundingOutlookInputs } from "./decision/finance";
import { buildStandardAiCapexDecision } from "./decision/capex";
import { FINANCE_PARAMETERS_V1 } from "../../finance/parameters";
import { sumProductAmount } from "./types";
import { StandardAiDiagnosticEntry } from "./reasonCodes";
import { SalesWishEntry } from "./decision/sales";
import { PressureScores } from "./pressures";
import { AppliedManagementBiasItem } from "./managementProfile";

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
  const productionResult = buildStandardAiProductionPlans(fixture, observation, pressures, salesResult.desiredByProduct);
  const requiredRawMaterial = productionResult.productionPlans.reduce((sum, p) => sum + unwrapUnit(p.desiredQuantity), 0);
  const requiredRawMaterialUnconstrained = sumProductAmount(productionResult.neededByProduct);

  const procurementResult = buildStandardAiProcurementPlan(fixture, observation, pressures, requiredRawMaterial, period, params);
  const laborResult = buildStandardAiWorkerAssignments(fixture, observation, pressures, productionResult.productionPlans, params);

  // 【SAI-6 Phase 1A】資金見通し（fundingOutlookEnabled=trueのときのみdecision/finance.ts側で
  // 使用される）。当期自身の調達・労務の意思決定（procurementResult・laborResultは、この
  // financing判断より前にすでに確定している＝パイプライン順序は変更していない）から、
  // 当期の現金支出見積りを機械的に導出するだけであり、将来の市場結果・乱数は一切含まない。
  const fundingOutlook: FundingOutlookInputs = {
    period,
    financeState: ownState.financeState,
    financingState: ownState.financingState,
    domesticPurchaseCashNeedUsd:
      unwrapUnit(procurementResult.domesticPurchasePlan.desiredQuantity) *
      1000 *
      (observation.vietnamDomesticPriorPrice ?? params.defaultExpectedRawPriceUsdPerKg),
    laborCashCostUsd: laborResult.workerAssignments.reduce((sum, a) => {
      const regularCost = a.regularHeadcount * FINANCE_PARAMETERS_V1.labor.regularWorkerSalaryUsdPerQuarter;
      const temporaryCost = a.temporaryHeadcount * FINANCE_PARAMETERS_V1.labor.temporaryWorkerCostUsdPerQuarter;
      const overtimeCost = regularCost * unwrapUnit(a.overtimeRate) * FINANCE_PARAMETERS_V1.labor.overtimePremiumFactor;
      return sum + regularCost + temporaryCost + overtimeCost;
    }, 0),
    sgaFixedCashCostUsd:
      FINANCE_PARAMETERS_V1.sellingGeneralAdmin.adminFixedUsdPerQuarter +
      observation.salesForceHeadcountTotal * FINANCE_PARAMETERS_V1.sellingGeneralAdmin.salesForceSalaryUsdPerQuarter +
      observation.procurementHeadcountTotal * FINANCE_PARAMETERS_V1.sellingGeneralAdmin.procurementSalaryUsdPerQuarter,
  };
  const financingResult = buildStandardAiFinancingRequest(observation, pressures, params, fundingOutlook);
  const capexResult = buildStandardAiCapexDecision(
    fixture,
    observation,
    pressures,
    productionResult.neededByProduct,
    requiredRawMaterialUnconstrained,
    params
  );

  const decision: CompanyDecisionInput = {
    companyId: fixture.companyId,
    salesPlans: salesResult.salesPlans,
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
  ];

  return {
    decision,
    diagnostics: {
      companyId: fixture.companyId,
      turn,
      period,
      entries,
      pressures,
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
