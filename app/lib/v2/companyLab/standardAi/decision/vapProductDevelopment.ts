// ShrimpX V2 — Standard AI Capability Expansion Phase CE-2: VAP Product Development
//
// 【既存仕様（変更しない）】VAP商品開発は capex/types.ts の CapitalProjectType
// ではない。companyLab/types.ts の CompanyDecisionInput.vapProductDevelopmentSpendUsd
// （companyLab/productDevelopmentState.ts の4段階 $0/$100,000/$250,000/$500,000
// のいずれか）を毎四半期選ぶ、factory非依存・company-wide・one-time資産計上なしの
// 継続的裁量支出である。全額が当期SG&Aへ即時費用化され、同額が当期キャッシュ
// フロー支出になる（資産計上・減価償却なし）。同じ値が
// updateProductDevelopmentState()（ヘッドルーム付きスコア更新式、spend=0なら
// 中立値へ減衰）の入力にもなる、唯一の情報源。このスコアは
// premiumPolicy.calculateCompanyCapabilityCoefficientの40%ウェイトとして
// sales/allocation.tsの非価格競争力（vapCapability）へ間接的に効く。
//
// 【PD Mechanizationとの違い（指示§15-16）】targetFactoryId・CapexProjectProposalInput・
// 進行中/完了ステータスという概念がそもそも存在しない。ここではPD Mechanizationの
// 構造をそのままコピーせず、「4段階tierのうちどれを選ぶか」という離散選択問題として
// 設計する。
//
// 【Economics formula（指示§7・§39「捏造しない」）】VAP商品開発スコア→競争力ウェイト→
// 実際の受注確率、という経路には、コードベース上どこにも「$いくらの追加売上/マージンに
// 換算されるか」という弾力性定数が存在しない（推測で新しい効果値を作らない、が
// 最優先の制約）。そこで「投資額が、直近四半期の実際のVAP貢献利益規模に対して
// 身の丈に合っているか」というaffordability指標（投資額 ÷ 現在のVAP四半期貢献利益）
// を使う。ROI paybackではなく、既存の実績データだけを使った「支出の妥当な大きさ」の
// 代理指標であることをコード全体で明示する。

import { StandardAiObservation } from "../types";
import { PressureScores } from "../pressures";
import { StandardAiParameters, STANDARD_AI_PARAMETERS_V1 } from "../parameters";
import { StandardAiDiagnosticEntry } from "../reasonCodes";
import { CompanyFixture } from "../../types";
import { minimumAcceptablePremium } from "../../premiumPolicy";
import { PRODUCT_DEVELOPMENT_PARAMETERS_V1, VAP_PRODUCT_DEVELOPMENT_SPEND_TIERS_USD } from "../../productDevelopmentState";

const EPSILON = 1e-6;

export interface VapProductDevelopmentResult {
  readonly spendUsd: number;
  readonly diagnostics: readonly StandardAiDiagnosticEntry[];
}

/**
 * 【指示§20】既存のcapexCashGateMode="costBased"と同じ考え方（最低現金バッファ＋
 * 投資額＋投資額×安全余裕）を、CAPEX専用のcashAndBorrowingSafe関数を流用せず
 * ここで直接評価する（vapProductDevelopmentSpendUsdはCapitalProjectTypeではなく
 * capexParams.templatesByTypeに存在しないため、既存関数をそのまま呼べない。
 * ただし式そのものは既存のcapex.tsのcostBased式と完全に同一にする）。
 */
function financeSafeForSpend(observation: StandardAiObservation, pressures: PressureScores, params: StandardAiParameters, spendUsd: number): boolean {
  const requiredCashUsd = pressures.targetMinimumCashUsd + spendUsd * (1 + params.capexCostSafetyRatio);
  return observation.cashUsd > requiredCashUsd && pressures.borrowingPressure < 1;
}

export function buildStandardAiVapProductDevelopmentDecision(
  fixture: CompanyFixture,
  observation: StandardAiObservation,
  pressures: PressureScores,
  params: StandardAiParameters = STANDARD_AI_PARAMETERS_V1
): VapProductDevelopmentResult {
  const diagnostics: StandardAiDiagnosticEntry[] = [];

  const vapCapacity = observation.totalEffectiveCapacityByProduct.vap;
  const vapProductionTons = observation.lastQuarterActualProductionByProduct.vap ?? 0;
  const vapUtilization = vapCapacity > EPSILON ? vapProductionTons / vapCapacity : 0;
  const vapPremium = observation.marketPremiumByProduct.vap;
  const vapEconomics = fixture.productEconomics.premiumEconomics.vap;
  const currentScore = observation.vapProductDevelopmentScore;
  const headroom = 1 - currentScore / PRODUCT_DEVELOPMENT_PARAMETERS_V1.cap;

  diagnostics.push({
    code: "VAP_DEV_CONSIDERED",
    domain: "sales",
    companyId: fixture.companyId,
    severity: "info",
    keyValues: {
      vapProductionTons,
      vapCapacity,
      vapUtilization,
      currentDevelopmentScore: currentScore,
      headroom,
    },
    message: `VAP稼働率（前期実績 ${(vapUtilization * 100).toFixed(1)}%）・VAP商品開発スコア（${currentScore.toFixed(
      1
    )}、ヘッドルーム ${(headroom * 100).toFixed(1)}%）を基に、当期のVAP商品開発費tierを評価する。`,
  });

  // --- Operational/Commercial Need（指示§6） ---
  if (vapUtilization < params.capexPdInUseUtilizationThreshold) {
    diagnostics.push({
      code: "VAP_DEV_LOW_OPPORTUNITY",
      domain: "sales",
      companyId: fixture.companyId,
      severity: "info",
      keyValues: { vapUtilization, capexPdInUseUtilizationThreshold: params.capexPdInUseUtilizationThreshold },
      message: "VAP稼働率が低く、商品開発投資を検討する段階にないため見送る。",
    });
    return { spendUsd: 0, diagnostics };
  }
  if (vapPremium === undefined || vapPremium < minimumAcceptablePremium(vapEconomics)) {
    diagnostics.push({
      code: "VAP_DEV_LOW_MARGIN",
      domain: "sales",
      companyId: fixture.companyId,
      severity: "info",
      keyValues: {
        vapMarketPremium: vapPremium ?? -1,
        minimumAcceptablePremium: minimumAcceptablePremium(vapEconomics),
      },
      message: "VAP市場プレミアムが最低受注水準に届いていないため、商品開発投資を見送る。",
    });
    return { spendUsd: 0, diagnostics };
  }

  // --- Saturation guard（指示§18） ---
  if (headroom < params.vapProductDevelopmentMinHeadroomRatio) {
    diagnostics.push({
      code: "VAP_DEV_ALREADY_ACTIVE",
      domain: "sales",
      companyId: fixture.companyId,
      severity: "info",
      keyValues: { currentDevelopmentScore: currentScore, headroom, vapProductDevelopmentMinHeadroomRatio: params.vapProductDevelopmentMinHeadroomRatio },
      message: `VAP商品開発スコアが既に高く（${currentScore.toFixed(1)}）、ヘッドルームが乏しいため新規支出を見送る。`,
    });
    return { spendUsd: 0, diagnostics };
  }

  // --- Economics / Strategy Fit（指示§7-9） ---
  const vapContributionMarginUsdPerHosoEqKg = vapEconomics.targetMarginUsdPerHosoEqKg;
  const currentQuarterlyVapContributionUsd = vapProductionTons * 1000 * vapContributionMarginUsdPerHosoEqKg;

  const financialConservatismRatio = params.capexCurrentShortfallRatioThreshold / STANDARD_AI_PARAMETERS_V1.capexCurrentShortfallRatioThreshold;
  const productOrientationHoso = params.productOrientationMultipliers.hoso ?? 1;
  const productOrientationVap = params.productOrientationMultipliers.vap ?? 1;
  const strategyFitMultiplier = productOrientationHoso > EPSILON ? productOrientationVap / productOrientationHoso : 1;
  const effectiveMaxAffordabilityQuarters =
    financialConservatismRatio > EPSILON
      ? (params.vapProductDevelopmentMaxAffordabilityQuarters * strategyFitMultiplier) / financialConservatismRatio
      : params.vapProductDevelopmentMaxAffordabilityQuarters;

  // 【Phase PC-2A・指示§2-9】Investment Intensity = headroom・VAP事業規模・affordabilityの
  // 単純平均（0〜1）。PC-1.5監査で判明した「affordabilityが通れば必ず最大tierになる」
  // bang-bang挙動（$500k pass率93〜97%・中間tier実測ほぼ0%）を解消するため、
  // どのtierを「狙うか」をaffordability単独ではなくIntensity（3要素の合成）で決める
  // （指示§9「最大tierがaffordableなら必ず最大tierにはしない」）。会社IDによる分岐は
  // 行わない（指示§7・§9「会社名hardcode禁止」「VAP会社だから必ず$500kは禁止」）。
  // affordability・財務ゲート自体（既存のeffectiveMaxAffordabilityQuarters・
  // financeSafeForSpend）は一切変更しない（指示§8「既存概念を維持可能」）。
  const maxTierUsd = Math.max(...VAP_PRODUCT_DEVELOPMENT_SPEND_TIERS_USD);
  const totalProductionTons =
    (observation.lastQuarterActualProductionByProduct.hoso ?? 0) +
    (observation.lastQuarterActualProductionByProduct.pd ?? 0) +
    (observation.lastQuarterActualProductionByProduct.vap ?? 0);
  // 【指示§7】VAP business scale＝この会社の生産全体に占めるVAPの比重。既存の実績生産量
  // （lastQuarterActualProductionByProduct、新しい観測ではない）だけから導出する。
  const vapBusinessScale = totalProductionTons > EPSILON ? Math.min(1, vapProductionTons / totalProductionTons) : 0;
  // 【指示§8】affordability指標を0〜1へ正規化（既存のeffectiveMaxAffordabilityQuarters×
  // currentQuarterlyVapContributionUsdが「その期間内で賄える$」であることを利用し、
  // 最大tier$500kに対する充足度として表現するだけで、新しい効果値は作らない）。
  const affordabilityScore = maxTierUsd > EPSILON ? Math.min(1, (effectiveMaxAffordabilityQuarters * currentQuarterlyVapContributionUsd) / maxTierUsd) : 0;
  const investmentIntensity = (headroom + vapBusinessScale + affordabilityScore) / 3;
  // 【指示§13 BEFORE/AFTER比較用のablationスイッチ】省略時（=undefined）は新方式（Intensity）。
  // falseの場合のみ、PC-2A以前の挙動（常に最高tier＝$500kを候補とする、affordability・
  // 財務ゲートだけで絞り込む旧方式）を再現する。既存呼び出し元・既存テストの挙動には
  // 一切影響しない（他フェーズのablationスイッチと同じ設計パターン）。
  const candidateTierUsd =
    params.vapDevelopmentTierIntensityEnabled === false
      ? 500_000
      : investmentIntensity >= params.vapProductDevelopmentIntensityHighThreshold
        ? 500_000
        : investmentIntensity >= params.vapProductDevelopmentIntensityMediumThreshold
          ? 250_000
          : 100_000;

  diagnostics.push({
    code: "VAP_DEV_INTENSITY_EVALUATED",
    domain: "sales",
    companyId: fixture.companyId,
    severity: "info",
    keyValues: {
      headroom,
      vapBusinessScale,
      affordabilityScore,
      investmentIntensity,
      candidateTierUsd,
      intensityHighThreshold: params.vapProductDevelopmentIntensityHighThreshold,
      intensityMediumThreshold: params.vapProductDevelopmentIntensityMediumThreshold,
    },
    message: `Investment Intensity ${(investmentIntensity * 100).toFixed(1)}%（headroom ${(headroom * 100).toFixed(
      1
    )}%・VAP事業規模 ${(vapBusinessScale * 100).toFixed(1)}%・affordability ${(affordabilityScore * 100).toFixed(
      1
    )}%の単純平均）から、候補tier $${candidateTierUsd.toLocaleString()}を導出する。`,
  });

  // 候補tier以下を高い順に、affordability・財務ゲートの両方を満たす最初のtierを選ぶ
  // （Intensityで「狙うtier」を決めた後、その候補が両ゲートを満たさない場合だけ、
  // より低いtierへ段階的に下げる。指示§17のCAPEX ranking合流は呼び出し元policy.tsが担う）。
  const candidateTiers = [...VAP_PRODUCT_DEVELOPMENT_SPEND_TIERS_USD]
    .filter((t) => t > 0 && t <= candidateTierUsd)
    .sort((a, b) => b - a);
  let bestPaybackUnattractiveTier: number | null = null;
  let bestFinanceBlockedTier: number | null = null;

  for (const tierUsd of candidateTiers) {
    const paybackQuarters = currentQuarterlyVapContributionUsd > EPSILON ? tierUsd / currentQuarterlyVapContributionUsd : Number.POSITIVE_INFINITY;
    if (!(paybackQuarters <= effectiveMaxAffordabilityQuarters)) {
      bestPaybackUnattractiveTier = bestPaybackUnattractiveTier ?? tierUsd;
      continue;
    }
    if (!financeSafeForSpend(observation, pressures, params, tierUsd)) {
      bestFinanceBlockedTier = bestFinanceBlockedTier ?? tierUsd;
      continue;
    }
    const expectedIncrementalBenefitUsd =
      params.vapProductDevelopmentMaxAffordabilityQuarters > EPSILON ? tierUsd / params.vapProductDevelopmentMaxAffordabilityQuarters : 0;
    diagnostics.push({
      code: "VAP_DEV_PROPOSED",
      domain: "sales",
      companyId: fixture.companyId,
      severity: "info",
      keyValues: {
        vapSalesTons: vapProductionTons,
        vapProductionTons,
        vapOpportunityTons: vapCapacity,
        vapContributionMargin: vapContributionMarginUsdPerHosoEqKg,
        currentDevelopmentScore: currentScore,
        expectedIncrementalBenefitUsd,
        investmentCostUsd: tierUsd,
        paybackQuarters,
        effectiveMaxPaybackQuarters: effectiveMaxAffordabilityQuarters,
        strategyFitMultiplier,
        financialConservatismRatio,
      },
      message: `VAP商品開発費として$${tierUsd.toLocaleString()}/四半期を提案する（affordability ${paybackQuarters.toFixed(
        1
      )}四半期 ≤ 許容基準 ${effectiveMaxAffordabilityQuarters.toFixed(1)}四半期、現在のスコア ${currentScore.toFixed(1)}）。`,
    });
    return { spendUsd: tierUsd, diagnostics };
  }

  if (bestFinanceBlockedTier !== null) {
    diagnostics.push({
      code: "VAP_DEV_FINANCE_BLOCKED",
      domain: "sales",
      companyId: fixture.companyId,
      severity: "info",
      keyValues: { investmentCostUsd: bestFinanceBlockedTier, cashUsd: observation.cashUsd, targetMinimumCashUsd: pressures.targetMinimumCashUsd },
      message: "経済性のあるVAP商品開発tierがあったが、現金・借入余力の財務ゲートを満たさないため今期は見送る。",
    });
  } else {
    diagnostics.push({
      code: "VAP_DEV_PAYBACK_UNATTRACTIVE",
      domain: "sales",
      companyId: fixture.companyId,
      severity: "info",
      keyValues: {
        currentQuarterlyVapContributionUsd,
        effectiveMaxPaybackQuarters: effectiveMaxAffordabilityQuarters,
        strategyFitMultiplier,
        financialConservatismRatio,
      },
      message: "どのtierも現在のVAP事業規模に対して支出が過大（affordability基準未達）のため見送る。",
    });
  }
  return { spendUsd: 0, diagnostics };
}
