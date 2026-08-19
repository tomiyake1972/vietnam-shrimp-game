// ShrimpX V2 — ENG-FAC-1: Factory lifecycleの会計効果と監査イベント
//
// 【責務】capex/factoryLifecycle.ts が導出したstateを、finance/が計上できる
// 金額（carrying cost / holding cost / reactivation cost / PPE除却 / sale proceeds /
// disposal gain-loss）へ変換する純粋関数群と、監査イベント（実装指示§18）の生成。
//
// 【新しいCash経路を作らないこと（実装指示§10）】ここで現金を直接動かさない。
// 算出した金額はFactoryLifecycleAdjustmentとしてfinance/quarterClose.tsへ渡し、
// 既存の営業CF（製造費支払）・既存の投資CF（investingCashFlow）へ合流させる。
//
// 【減価償却タイミング（実装指示§12）】売却完了四半期(T+2)には当該工場の
// 減価償却を計上しない。したがって除却する簿価は「T+2の期首時点」の値であり、
// 本モジュールは簿価射影を previousPeriod(T+2) で評価する。これにより
// 二重償却も償却漏れも起きない。

import { PeriodV2, previousPeriod } from "../core/period";
import { Factory } from "../production/types";
import { FinanceParameters } from "../finance/parameters";
import { CapexParameters } from "./parameters";
import { CapitalProject } from "./types";
import { computeFactoryAssetProjection, FactoryAssetValues } from "./factoryAssetProjection";
import {
  FACTORY_LIFECYCLE_PARAMETERS_V1,
  FactoryLifecycleDecisionRecord,
  FactoryLifecycleParameters,
  FactoryLifecycleState,
  isFactoryReactivationDecidedIn,
  listFactoriesCompletingSaleIn,
  listFactoryIdsWithLifecycleDecisions,
  resolveFactoryLifecycleStateAt,
} from "./factoryLifecycle";

// ---------------------------------------------------------------------
// 1. 監査イベント（実装指示§18）
// ---------------------------------------------------------------------

export type FactoryLifecycleEventCode =
  | "FACTORY_MOTHBALL_DECIDED"
  | "FACTORY_MOTHBALL_EFFECTIVE"
  | "FACTORY_REACTIVATION_DECIDED"
  | "FACTORY_REACTIVATED"
  | "FACTORY_SALE_DECIDED"
  | "FACTORY_SALE_OPERATION_STOPPED"
  | "FACTORY_SALE_COMPLETED"
  | "FACTORY_DISPOSAL_GAIN"
  | "FACTORY_DISPOSAL_LOSS";

export interface FactoryLifecycleEvent {
  readonly code: FactoryLifecycleEventCode;
  readonly companyId: string;
  readonly factoryId: string;
  readonly period: PeriodV2;
  readonly previousState: FactoryLifecycleState | null;
  readonly nextState: FactoryLifecycleState;
  /** 金額系（該当しないイベントではundefined。推測値は入れない）。 */
  readonly grossPpeRemovedUsd?: number;
  readonly accumulatedDepreciationRemovedUsd?: number;
  readonly bookValueUsd?: number;
  readonly proceedsUsd?: number;
  readonly gainLossUsd?: number;
  /** 当該工場がこの四半期に失った実効生産能力（HOSO換算トン/四半期）。 */
  readonly capacityRemovedTons?: number;
  /** 当該工場について当四半期に消えた通常cash固定費（carrying/holding costは含まない純減額）。 */
  readonly fixedCostRemovedUsd?: number;
}

// ---------------------------------------------------------------------
// 2. finance/へ渡す調整（新しいCash経路を作らない）
// ---------------------------------------------------------------------

export interface FactoryLifecycleAdjustment {
  /** MOTHBALLED工場のcarrying cost合計（§4.4。当期費用かつ現金支出）。 */
  readonly mothballCarryingCostUsd: number;
  /** SALE_PENDING工場のholding cost合計（§8）。 */
  readonly salePendingHoldingCostUsd: number;
  /** 当期に再稼働を決定した工場の再稼働コスト合計（§5）。 */
  readonly reactivationCostUsd: number;
  /** 当期の売却完了にともなうGross PPE除却額（§11）。 */
  readonly disposalGrossPpeRemovedUsd: number;
  /** 同、減価償却累計額の除却額（§11）。 */
  readonly disposalAccumulatedDepreciationRemovedUsd: number;
  /**
   * 上記のうち、初期工場（legacy PPE）に帰属する取得原価の除却額。
   * 既存資産の減価償却ベース（finance/quarterClose.tsのexistingAssetOpeningGrossUsd）
   * から当期分を差し引くために使う（§12「SOLD: depreciationなし」を売却完了
   * 四半期そのものから成立させるため）。
   */
  readonly disposalLegacyGrossRemovedUsd: number;
  /** 当期の売却代金（§9。投資CFへ計上）。 */
  readonly disposalProceedsUsd: number;
  /** 当期のdisposal gain(+)/loss(−)（§10）。 */
  readonly disposalGainLossUsd: number;
}

export const EMPTY_FACTORY_LIFECYCLE_ADJUSTMENT: FactoryLifecycleAdjustment = {
  mothballCarryingCostUsd: 0,
  salePendingHoldingCostUsd: 0,
  reactivationCostUsd: 0,
  disposalGrossPpeRemovedUsd: 0,
  disposalAccumulatedDepreciationRemovedUsd: 0,
  disposalLegacyGrossRemovedUsd: 0,
  disposalProceedsUsd: 0,
  disposalGainLossUsd: 0,
};

export function isEmptyFactoryLifecycleAdjustment(adjustment: FactoryLifecycleAdjustment): boolean {
  return (
    adjustment.mothballCarryingCostUsd === 0 &&
    adjustment.salePendingHoldingCostUsd === 0 &&
    adjustment.reactivationCostUsd === 0 &&
    adjustment.disposalGrossPpeRemovedUsd === 0 &&
    adjustment.disposalAccumulatedDepreciationRemovedUsd === 0 &&
    adjustment.disposalProceedsUsd === 0 &&
    adjustment.disposalGainLossUsd === 0
  );
}

// ---------------------------------------------------------------------
// 3. 算出
// ---------------------------------------------------------------------

export interface FactoryLifecycleAccountingInput {
  readonly companyId: string;
  readonly period: PeriodV2;
  readonly decisions: readonly FactoryLifecycleDecisionRecord[];
  /** この会社の初期工場（fixture.factories。静的）。 */
  readonly baselineFactories: readonly Factory[];
  /** この会社のCapital Project全件（当四半期のcapexクローズ**前**の状態）。 */
  readonly projects: readonly CapitalProject[];
  /** 当四半期期首の会社BS取得原価（prev.fixedAssetsGross）。 */
  readonly companyFixedAssetsGrossUsd: number;
  /** 当四半期期首の会社BS減価償却累計額（prev.accumulatedDepreciation）。 */
  readonly companyAccumulatedDepreciationUsd: number;
  /**
   * 通常cash factory fixed cost（1工場・1四半期あたり。工場固定費＋固定ユーティリティ）。
   * 実装指示§4「この基準額は必ず1か所へ集約し、1.20M + 0.25M を複数箇所へ
   * 直書きしないこと」に従い、finance/parameters.tsの
   * normalCashFixedFactoryCostUsdPerQuarter() の戻り値だけを渡すこと。
   */
  readonly normalCashFixedFactoryCostUsdPerQuarter: number;
  readonly financeParams: FinanceParameters;
  readonly capexParams: CapexParameters;
  readonly lifecycleParams?: FactoryLifecycleParameters;
}

export interface FactoryLifecycleAccountingResult {
  readonly adjustment: FactoryLifecycleAdjustment;
  readonly events: readonly FactoryLifecycleEvent[];
  /** 当四半期のMOTHBALLED工場数（診断・テスト用）。 */
  readonly mothballedFactoryCount: number;
  /** 当四半期のSALE_PENDING工場数（診断・テスト用）。 */
  readonly salePendingFactoryCount: number;
}

/**
 * 1社・1四半期ぶんのlifecycle会計効果と監査イベントを求める（純粋関数）。
 */
export function computeFactoryLifecycleAccounting(input: FactoryLifecycleAccountingInput): FactoryLifecycleAccountingResult {
  const params = input.lifecycleParams ?? FACTORY_LIFECYCLE_PARAMETERS_V1;
  const { period, decisions, baselineFactories, projects, companyId } = input;
  const normalCost = input.normalCashFixedFactoryCostUsdPerQuarter;

  const events: FactoryLifecycleEvent[] = [];
  const factoryIds = listFactoryIdsWithLifecycleDecisions(decisions);

  // --- 当四半期のstate分布 ---
  let mothballedFactoryCount = 0;
  let salePendingFactoryCount = 0;
  for (const factoryId of factoryIds) {
    const state = resolveFactoryLifecycleStateAt(decisions, factoryId, period);
    if (state === "MOTHBALLED") mothballedFactoryCount += 1;
    else if (state === "SALE_PENDING") salePendingFactoryCount += 1;
  }

  // --- 売却完了（T+2）の簿価は「当四半期の期首時点」で評価する（§12） ---
  const saleCompletions = listFactoriesCompletingSaleIn(decisions, period);
  const priorPeriod = previousPeriod(period);
  const projectionAtPriorPeriod: ReadonlyMap<string, FactoryAssetValues> = computeFactoryAssetProjection({
    baselineFactories,
    projects,
    lifecycleDecisions: decisions,
    period: priorPeriod,
    companyFixedAssetsGrossUsd: input.companyFixedAssetsGrossUsd,
    companyAccumulatedDepreciationUsd: input.companyAccumulatedDepreciationUsd,
    financeParams: input.financeParams,
    capexParams: input.capexParams,
  });

  const baselineFactoryIds = new Set(baselineFactories.map((f) => f.factoryId));
  let disposalGrossPpeRemovedUsd = 0;
  let disposalAccumulatedDepreciationRemovedUsd = 0;
  let disposalLegacyGrossRemovedUsd = 0;
  let disposalProceedsUsd = 0;
  let disposalGainLossUsd = 0;

  for (const factoryId of saleCompletions) {
    const assets = projectionAtPriorPeriod.get(factoryId);
    if (!assets) continue; // 簿価射影に現れない工場（構造的には起こらない）は捏造しない。
    const proceedsUsd = assets.netBookValueUsd * params.saleProceedsRecoveryRate;
    const gainLossUsd = proceedsUsd - assets.netBookValueUsd;

    disposalGrossPpeRemovedUsd += assets.grossPpeUsd;
    disposalAccumulatedDepreciationRemovedUsd += assets.accumulatedDepreciationUsd;
    disposalProceedsUsd += proceedsUsd;
    disposalGainLossUsd += gainLossUsd;
    if (baselineFactoryIds.has(factoryId)) {
      // legacy按分ぶんの取得原価だけを取り出す（capex帰属分は
      // nonDepreciatingCapexGrossAtPeriodStartUsd側の除外で扱われる）。
      const capexGrossUsd = projects
        .filter((p) => p.status === "completed" && p.capitalizedAmountUsd !== undefined)
        .filter((p) => (p.targetFactoryId ?? baselineFactories[0]?.factoryId) === factoryId && p.projectType !== "newFactoryConstruction")
        .reduce((s, p) => s + (p.capitalizedAmountUsd ?? 0), 0);
      disposalLegacyGrossRemovedUsd += Math.max(0, assets.grossPpeUsd - capexGrossUsd);
    }

    events.push({
      code: "FACTORY_SALE_COMPLETED",
      companyId,
      factoryId,
      period,
      previousState: "SALE_PENDING",
      nextState: "SOLD",
      grossPpeRemovedUsd: assets.grossPpeUsd,
      accumulatedDepreciationRemovedUsd: assets.accumulatedDepreciationUsd,
      bookValueUsd: assets.netBookValueUsd,
      proceedsUsd,
      gainLossUsd,
      fixedCostRemovedUsd: normalCost * params.salePendingHoldingCostRatio,
    });
    events.push({
      code: gainLossUsd >= 0 ? "FACTORY_DISPOSAL_GAIN" : "FACTORY_DISPOSAL_LOSS",
      companyId,
      factoryId,
      period,
      previousState: "SALE_PENDING",
      nextState: "SOLD",
      bookValueUsd: assets.netBookValueUsd,
      proceedsUsd,
      gainLossUsd,
    });
  }

  // --- 決定イベント・発効イベント（金額を伴わないもの） ---
  for (const decision of decisions) {
    if (decision.decidedPeriod === period) {
      events.push({
        code:
          decision.type === "MOTHBALL_FACTORY"
            ? "FACTORY_MOTHBALL_DECIDED"
            : decision.type === "REACTIVATE_FACTORY"
              ? "FACTORY_REACTIVATION_DECIDED"
              : "FACTORY_SALE_DECIDED",
        companyId,
        factoryId: decision.factoryId,
        period,
        previousState: resolveFactoryLifecycleStateAt(decisions, decision.factoryId, period),
        nextState: resolveFactoryLifecycleStateAt(decisions, decision.factoryId, period),
      });
      continue;
    }
    // 発効四半期（T+1）のイベント。
    const state = resolveFactoryLifecycleStateAt(decisions, decision.factoryId, period);
    const statePrior = resolveFactoryLifecycleStateAt(decisions, decision.factoryId, priorPeriod);
    if (state === statePrior) continue;
    if (decision.type === "MOTHBALL_FACTORY" && state === "MOTHBALLED") {
      events.push({
        code: "FACTORY_MOTHBALL_EFFECTIVE",
        companyId,
        factoryId: decision.factoryId,
        period,
        previousState: statePrior,
        nextState: state,
        fixedCostRemovedUsd: normalCost * (1 - params.mothballCarryingCostRatio),
      });
    } else if (decision.type === "REACTIVATE_FACTORY" && state === "OPERATING") {
      events.push({ code: "FACTORY_REACTIVATED", companyId, factoryId: decision.factoryId, period, previousState: statePrior, nextState: state });
    } else if (decision.type === "SELL_FACTORY" && state === "SALE_PENDING") {
      events.push({
        code: "FACTORY_SALE_OPERATION_STOPPED",
        companyId,
        factoryId: decision.factoryId,
        period,
        previousState: statePrior,
        nextState: state,
        fixedCostRemovedUsd: normalCost * (1 - params.salePendingHoldingCostRatio),
      });
    }
  }

  const reactivationCostUsd =
    factoryIds.filter((factoryId) => isFactoryReactivationDecidedIn(decisions, factoryId, period)).length * params.reactivationCostUsd;

  return {
    adjustment: {
      mothballCarryingCostUsd: mothballedFactoryCount * normalCost * params.mothballCarryingCostRatio,
      salePendingHoldingCostUsd: salePendingFactoryCount * normalCost * params.salePendingHoldingCostRatio,
      reactivationCostUsd,
      disposalGrossPpeRemovedUsd,
      disposalAccumulatedDepreciationRemovedUsd,
      disposalLegacyGrossRemovedUsd,
      disposalProceedsUsd,
      disposalGainLossUsd,
    },
    events,
    mothballedFactoryCount,
    salePendingFactoryCount,
  };
}
