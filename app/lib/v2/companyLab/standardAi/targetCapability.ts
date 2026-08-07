// ShrimpX V2 — Standard AI Target Capability（2026-08-05新設）
//
// 【三宅さんご指示§8】Target Scaleから必要能力を逆算する。今回最重要なのは
// Target Sales Capacity（salesForceHiring.ts側で扱う）とTarget Production
// Capacityであり、Worker/Raw/Financialは「gapがあるかどうかの診断」に留める
// （本番ロジックの作り直しはしない、三宅さんご指示§15・§16）。
//
// 【4層の時間軸分離（三宅さんご指示§7）】
//   0〜2Q: operational decisions（既存の各decision/*.tsがそのまま担当）
//   3〜4Q: capacity planning（本ファイルが診断する対象）
//   5〜8Q: strategic direction / target scale（strategicIntent.ts・targetScale.tsが担当）
// 本ファイルは3〜4Q層の「現在〜近い将来の能力がTarget Scaleと整合しているか」を
// 診断するだけで、生産・調達・Worker・資金の本番決定ロジック自体は変更しない。

import { CompanyFixture } from "../types";
import { StandardAiObservation, sumProductAmount } from "./types";
import { TargetScaleBand } from "./targetScale";
import { StandardAiDiagnosticEntry } from "./reasonCodes";

export interface TargetCapabilityResult {
  /** Target Scale（preferred）に対する生産能力のギャップ（トン。正=不足、負=余力）。 */
  readonly productionCapacityGapTons: number;
  /** 4Q以内に稼働見込みの自社設備投資案件があるか（数量・タイミングは捏造しない。存在有無のみ）。 */
  readonly hasNearTermCapexUnderConstruction: boolean;
  /**
   * Target Scale（preferred）が現在の資金体力で賄えるかの簡易診断。
   * 【三宅さんご指示§17】Strategic Target Scale と Currently Financeable Scale を
   * 分離する。ここでは「現金が最低バッファを下回っているか」という既存の
   * liquidityFloor概念（salesForceHiring.tsと同じ考え方）だけを使い、複数四半期の
   * 精緻なキャッシュフロー投影は行わない（Financial Capacity診断モジュールとの
   * 厳密統合は#05引き続きの課題として明記する）。
   */
  readonly financeableScaleTons: number;
  readonly isFinanciallyConstrained: boolean;
  /** Worker capability gapの有無（既存の当期必要人数計算は変更せず、粗い比較のみ）。 */
  readonly hasWorkerCapabilityGapSignal: boolean;
  readonly diagnostics: readonly StandardAiDiagnosticEntry[];
}

export interface TargetCapabilityInput {
  readonly fixture: CompanyFixture;
  readonly observation: StandardAiObservation;
  readonly targetScaleBand: TargetScaleBand;
  readonly liquidityFloorUsd: number;
  /** 直近実効原料コスト単価等から逆算した、資金体力に応じた実現可能規模の目安（USD/トンの逆算に使う簡易係数）。 */
  readonly approxVariableCostUsdPerTon: number;
}

export function computeTargetCapability(input: TargetCapabilityInput): TargetCapabilityResult {
  const { fixture, observation, targetScaleBand, liquidityFloorUsd, approxVariableCostUsdPerTon } = input;
  const diagnostics: StandardAiDiagnosticEntry[] = [];

  const effectiveCapacityTons = sumProductAmount(observation.totalEffectiveCapacityByProduct);
  const productionCapacityGapTons = Math.max(0, targetScaleBand.quarterlySalesTons.preferred - effectiveCapacityTons);

  const hasNearTermCapexUnderConstruction = observation.activeCapexProjectTargets.size > 0;

  if (productionCapacityGapTons > 0) {
    if (hasNearTermCapexUnderConstruction) {
      diagnostics.push({
        code: "FUTURE_CAPEX_SUPPORTS_TARGET_SCALE",
        domain: "diagnosis",
        companyId: fixture.companyId,
        severity: "info",
        keyValues: { productionCapacityGapTons, effectiveCapacityTons, targetPreferredTons: targetScaleBand.quarterlySalesTons.preferred },
        message: `Target Scale（preferred ${Math.round(
          targetScaleBand.quarterlySalesTons.preferred
        )}t/期）に対し現在の実効生産能力（${Math.round(
          effectiveCapacityTons
        )}t/期）は${Math.round(productionCapacityGapTons)}t不足しているが、稼働中の設備投資案件があり、将来の能力拡張が見込まれる。`,
      });
    } else {
      diagnostics.push({
        code: "PRODUCTION_CAPACITY_BELOW_TARGET_SCALE",
        domain: "diagnosis",
        companyId: fixture.companyId,
        severity: "warning",
        keyValues: { productionCapacityGapTons, effectiveCapacityTons, targetPreferredTons: targetScaleBand.quarterlySalesTons.preferred },
        message: `Target Scale（preferred ${Math.round(
          targetScaleBand.quarterlySalesTons.preferred
        )}t/期）に対し現在の実効生産能力（${Math.round(
          effectiveCapacityTons
        )}t/期）は${Math.round(productionCapacityGapTons)}t不足しており、稼働中の設備投資案件も無い。生産能力側がTarget Scale達成のボトルネックになりうる。`,
      });
    }
  }

  // Financeable Scale（簡易版）: 現在の最低現金バッファ余力を、想定変動費単価で
  // トン数へ逆算する。目的は精密な資金計画ではなく、「目標は大きいが現時点では
  // 資金制約がprimary bottleneck」という定性的な診断（三宅さんご指示§17）。
  const financeableScaleTons =
    approxVariableCostUsdPerTon > 0 && liquidityFloorUsd > 0
      ? effectiveCapacityTons + liquidityFloorUsd / approxVariableCostUsdPerTon
      : effectiveCapacityTons;
  const isFinanciallyConstrained = financeableScaleTons < targetScaleBand.quarterlySalesTons.preferred;
  if (isFinanciallyConstrained) {
    diagnostics.push({
      code: "FINANCEABLE_SCALE_BELOW_STRATEGIC_TARGET",
      domain: "diagnosis",
      companyId: fixture.companyId,
      severity: "info",
      keyValues: { financeableScaleTons, targetPreferredTons: targetScaleBand.quarterlySalesTons.preferred },
      message: `Target Scale（preferred ${Math.round(
        targetScaleBand.quarterlySalesTons.preferred
      )}t/期）に対し、現在の資金体力から見た現実的な規模は約${Math.round(
        financeableScaleTons
      )}t/期にとどまる。目標そのものは維持しつつ、当面は資金制約が主たるボトルネックであると診断する。`,
    });
  }

  // Worker capability gap signal（粗い比較のみ。三宅さんご指示§15によりWorker本番
  // ロジックは変更しない。現在の常用ワーカー数に対して、Target Scale相当の
  // 生産量を賄うために必要な「おおよその」人員規模を、現在の生産能力あたり人員
  // 密度から単純比例で見積もるだけの、診断専用の粗い信号である）。
  const currentRegularHeadcount = observation.regularHeadcountTotal;
  const impliedWorkerNeedRatio = effectiveCapacityTons > 0 ? targetScaleBand.quarterlySalesTons.preferred / effectiveCapacityTons : 1;
  const hasWorkerCapabilityGapSignal = currentRegularHeadcount > 0 && impliedWorkerNeedRatio > 1.1;

  return {
    productionCapacityGapTons,
    hasNearTermCapexUnderConstruction,
    financeableScaleTons,
    isFinanciallyConstrained,
    hasWorkerCapabilityGapSignal,
    diagnostics,
  };
}
