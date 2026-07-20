// ShrimpX V2 — 会社経営統合テスト環境 品質・信頼・納期ダッシュボード（Phase 7B）警告判定
//
// Phase 7A（app/lib/v2/quality/）・Phase 6.2（app/lib/v2/companyLab/）が既に
// 計算・保存した実績値（operationalRisk・utilizationRate・overtimeRate・
// temporaryWorkerShare・complexityStress・rawMaterialAgeStress・
// productionRampStress・discardQuantity・majorIncidentCount・
// customerTrustScore・deliveryReliabilityScore）だけを読み取り、表示専用の
// 「注意／警戒／重大」区分へ振り分ける。閾値はすべてこのファイルへ集約し、
// 経済ロジック（quality/・sales/・production/）には一切影響させない
// （実装指示 §2「警告表示」）。閾値は暫定値であり、後から調整しやすい構造にする。

import { unwrapUnit } from "../../lib/v2/core/units";
import { CompanyQuarterRecord } from "../../lib/v2/companyLab";
import { findCompanySummary } from "./dashboardViewModel";

const EPSILON = 1e-6;

export type WarningSeverity = "注意" | "警戒" | "重大";

export interface WarningViewModel {
  readonly key: string;
  readonly label: string;
  readonly severity: WarningSeverity;
  readonly detail: string;
}

const SEVERITY_ORDER: Readonly<Record<WarningSeverity, number>> = { 注意: 0, 警戒: 1, 重大: 2 };

function severityFromThresholds(value: number, warnAt: number, alertAt: number, criticalAt: number): WarningSeverity | undefined {
  if (value >= criticalAt) return "重大";
  if (value >= alertAt) return "警戒";
  if (value >= warnAt) return "注意";
  return undefined;
}

/**
 * 【暫定値・要校正】表示専用の警告閾値。経済ロジックには使わない。
 *
 * 5シナリオ×canonical/variation×32ターン（1,600 company-turns）の実行結果を
 * 元に、「正常操業時に過剰な警告を出さない」（重要テスト項目8）を満たすよう
 * 実測分布（中央値・p90・p99等）を踏まえて校正した値。当初案（絶対値の勘による
 * 暫定値）ではlaborUtilization・overtimeRate・temporaryWorkerShareが実測の
 * 中央値付近にあり、正常操業でも過半数のターンで警告が出てしまっていたため、
 * 実測分布の上位側（おおむね上位1〜10%）で警告が出るよう調整した。
 *
 * 【complexityStress（商品構成の複雑化）について】現行のCompany fixture
 * （companyLab/fixtures.ts）はほぼ全社が常に複数商品を生産する設計のため、
 * complexityStress（productMixComplexityをclamp01しただけの値）は通常操業でも
 * ほぼ常に1.0に張り付き、レベル閾値では「異常」と「通常」を判別できない
 * （実測: 1,600件中1,580件が最大値）。品質パラメータ自体の校正（対象外）を
 * 行わない限りこの信号は意味のある閾値を持てないため、本Phaseでは現行の
 * 生産構成では到達し得ない値に閾値を置き、誤警告を防ぐ（Phase 8以降の校正時に
 * 要見直し。§docs参照）。
 */
export const WARNING_THRESHOLDS = {
  rampStress: { warn: 0.5, alert: 0.65, critical: 0.8 },
  equipmentUtilization: { warn: 0.85, alert: 0.92, critical: 0.97 },
  laborUtilization: { warn: 0.95, alert: 0.98, critical: 0.995 },
  /** overtimeRateは実測上ほぼ二峰性（低水準 or 上限0.18に張り付く）のため、上限到達だけを「警戒」として拾う（warn/alertをほぼ同値にし、中間帯の誤警告を避ける）。「重大」は現行運用では到達しない値にしてある。 */
  overtimeRate: { warn: 0.179, alert: 0.18, critical: 0.19 },
  temporaryWorkerShare: { warn: 0.38, alert: 0.405, critical: 0.6 },
  /** 現行fixtureでは通常操業時でもほぼ常に1.0に張り付くため、到達し得ない値に置く（上記コメント参照）。 */
  complexityStress: { warn: 1.5, alert: 1.7, critical: 1.85 },
  rawMaterialAgeStress: { warn: 0.3, alert: 0.35, critical: 0.39 },
  /** 廃棄比率（廃棄量 / 総生産量）。normal ops（無事故時ratio=1.00・通常操業の小さなリスク）を過剰に警告しないよう、緩めに設定する。 */
  discardRatio: { warn: 0.05, alert: 0.12, critical: 0.2 },
  customerTrustScore: { warn: 40, alert: 25, critical: 12 }, // 低いほど悪いので、下からの閾値として扱う（below系）
  deliveryReliabilityScore: { warn: 40, alert: 25, critical: 12 },
} as const;

function belowThresholdSeverity(value: number, warnBelow: number, alertBelow: number, criticalBelow: number): WarningSeverity | undefined {
  if (value <= criticalBelow) return "重大";
  if (value <= alertBelow) return "警戒";
  if (value <= warnBelow) return "注意";
  return undefined;
}

/**
 * 会社×当期のPhase 7A実績値から、表示用の警告一覧を判定する（経済ロジックへは
 * 一切影響しない、表示専用の集約ポイント）。生産量0の会社×工場×商品は
 * quality/batchAdjustment.tsの構造上adjustments自体に一切現れないため、
 * 誤った品質事故・リスク警告は原理的に発生しない。
 */
export function buildWarnings(record: CompanyQuarterRecord, companyId: string): readonly WarningViewModel[] {
  const summary = findCompanySummary(record, companyId);
  if (!summary) return [];

  const warnings: WarningViewModel[] = [];
  const companyAdjustments = record.qualityAdjustments.filter((a) => a.companyId === companyId);

  // --- 急増産（Phase 7Aが既に閾値判定済みのrampWarningsをそのまま使う。ここでは表示区分だけを付与） ---
  for (const w of summary.rampWarnings) {
    const severity = severityFromThresholds(w.productionRampStress, WARNING_THRESHOLDS.rampStress.warn, WARNING_THRESHOLDS.rampStress.alert, WARNING_THRESHOLDS.rampStress.critical);
    if (severity) {
      warnings.push({
        key: `ramp-${w.factoryId}-${w.product}`,
        label: "急増産",
        severity,
        detail: `${w.factoryId} / ${w.product.toUpperCase()}: 増産ストレス ${(w.productionRampStress * 100).toFixed(0)}%`,
      });
    }
  }

  // --- 稼働率・残業・臨時ワーカー依存（Phase6が既に算出したCompanyQuarterSummaryの値をそのまま使う） ---
  const equipmentSeverity = severityFromThresholds(
    unwrapUnit(summary.equipmentUtilizationRate),
    WARNING_THRESHOLDS.equipmentUtilization.warn,
    WARNING_THRESHOLDS.equipmentUtilization.alert,
    WARNING_THRESHOLDS.equipmentUtilization.critical
  );
  if (equipmentSeverity) {
    warnings.push({ key: "equipment-utilization", label: "高い設備稼働率", severity: equipmentSeverity, detail: `設備稼働率 ${(unwrapUnit(summary.equipmentUtilizationRate) * 100).toFixed(0)}%` });
  }

  const laborSeverity = severityFromThresholds(
    unwrapUnit(summary.laborUtilizationRate),
    WARNING_THRESHOLDS.laborUtilization.warn,
    WARNING_THRESHOLDS.laborUtilization.alert,
    WARNING_THRESHOLDS.laborUtilization.critical
  );
  if (laborSeverity) {
    warnings.push({ key: "labor-utilization", label: "高い労働稼働率", severity: laborSeverity, detail: `労働稼働率 ${(unwrapUnit(summary.laborUtilizationRate) * 100).toFixed(0)}%` });
  }

  const overtimeSeverity = severityFromThresholds(
    unwrapUnit(summary.overtimeRate),
    WARNING_THRESHOLDS.overtimeRate.warn,
    WARNING_THRESHOLDS.overtimeRate.alert,
    WARNING_THRESHOLDS.overtimeRate.critical
  );
  if (overtimeSeverity) {
    warnings.push({ key: "overtime", label: "残業負荷", severity: overtimeSeverity, detail: `残業率 ${(unwrapUnit(summary.overtimeRate) * 100).toFixed(0)}%` });
  }

  const temporarySeverity = severityFromThresholds(
    unwrapUnit(summary.temporaryWorkerShare),
    WARNING_THRESHOLDS.temporaryWorkerShare.warn,
    WARNING_THRESHOLDS.temporaryWorkerShare.alert,
    WARNING_THRESHOLDS.temporaryWorkerShare.critical
  );
  if (temporarySeverity) {
    warnings.push({ key: "temporary-worker", label: "臨時ワーカー依存", severity: temporarySeverity, detail: `臨時ワーカー比率 ${(unwrapUnit(summary.temporaryWorkerShare) * 100).toFixed(0)}%` });
  }

  // --- 商品構成の複雑化・原料の長期滞留（Phase 7Aのrisk内訳のうち、当期最大値を採用） ---
  if (companyAdjustments.length > 0) {
    const maxComplexity = Math.max(...companyAdjustments.map((a) => a.risk.complexityStress));
    const complexitySeverity = severityFromThresholds(
      maxComplexity,
      WARNING_THRESHOLDS.complexityStress.warn,
      WARNING_THRESHOLDS.complexityStress.alert,
      WARNING_THRESHOLDS.complexityStress.critical
    );
    if (complexitySeverity) {
      warnings.push({ key: "complexity", label: "商品構成の複雑化", severity: complexitySeverity, detail: `商品構成複雑度ストレス ${(maxComplexity * 100).toFixed(0)}%` });
    }

    const maxRawMaterialAge = Math.max(...companyAdjustments.map((a) => a.risk.rawMaterialAgeStress));
    const rawMaterialAgeSeverity = severityFromThresholds(
      maxRawMaterialAge,
      WARNING_THRESHOLDS.rawMaterialAgeStress.warn,
      WARNING_THRESHOLDS.rawMaterialAgeStress.alert,
      WARNING_THRESHOLDS.rawMaterialAgeStress.critical
    );
    if (rawMaterialAgeSeverity) {
      warnings.push({ key: "raw-material-age", label: "原料の長期滞留", severity: rawMaterialAgeSeverity, detail: `原料滞留ストレス ${(maxRawMaterialAge * 100).toFixed(0)}%` });
    }
  }

  // --- 品質事故（発生していれば常に重大） ---
  if (summary.majorIncidentCount > 0) {
    warnings.push({ key: "major-incident", label: "品質事故", severity: "重大", detail: `当期の重大品質事故 ${summary.majorIncidentCount}件` });
  }

  // --- 廃棄増加（廃棄比率 = 廃棄量 / 総生産量。生産量0であればNaN回避のため警告自体を出さない） ---
  const totalOriginalProduction = companyAdjustments.reduce((sum, a) => sum + unwrapUnit(a.originalFinishedGoodsQuantity), 0);
  if (totalOriginalProduction > EPSILON) {
    const discardRatio = unwrapUnit(summary.discardQuantity) / totalOriginalProduction;
    const discardSeverity = severityFromThresholds(
      discardRatio,
      WARNING_THRESHOLDS.discardRatio.warn,
      WARNING_THRESHOLDS.discardRatio.alert,
      WARNING_THRESHOLDS.discardRatio.critical
    );
    if (discardSeverity) {
      warnings.push({ key: "discard", label: "廃棄増加", severity: discardSeverity, detail: `廃棄比率 ${(discardRatio * 100).toFixed(1)}%（廃棄 ${unwrapUnit(summary.discardQuantity).toFixed(1)}トン）` });
    }
  }

  // --- 納期信頼性低下・顧客信頼低下（市場別スコアのうち、当期最も低いものを採用） ---
  const reliabilityScores = Object.values(summary.deliveryReliabilityByMarket).filter((v): v is NonNullable<typeof v> => v !== undefined).map((v) => unwrapUnit(v));
  if (reliabilityScores.length > 0) {
    const minReliability = Math.min(...reliabilityScores);
    const reliabilitySeverity = belowThresholdSeverity(
      minReliability,
      WARNING_THRESHOLDS.deliveryReliabilityScore.warn,
      WARNING_THRESHOLDS.deliveryReliabilityScore.alert,
      WARNING_THRESHOLDS.deliveryReliabilityScore.critical
    );
    if (reliabilitySeverity) {
      warnings.push({ key: "delivery-reliability", label: "納期信頼性低下", severity: reliabilitySeverity, detail: `最も低い市場の納期信頼性スコア ${minReliability.toFixed(1)}点` });
    }
  }

  const trustScores = Object.values(summary.customerTrustByMarket).filter((v): v is NonNullable<typeof v> => v !== undefined).map((v) => unwrapUnit(v));
  if (trustScores.length > 0) {
    const minTrust = Math.min(...trustScores);
    const trustSeverity = belowThresholdSeverity(
      minTrust,
      WARNING_THRESHOLDS.customerTrustScore.warn,
      WARNING_THRESHOLDS.customerTrustScore.alert,
      WARNING_THRESHOLDS.customerTrustScore.critical
    );
    if (trustSeverity) {
      warnings.push({ key: "customer-trust", label: "顧客信頼低下", severity: trustSeverity, detail: `最も低い市場の顧客信頼スコア ${minTrust.toFixed(1)}点` });
    }
  }

  return warnings.sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]);
}

/** 当期の警告のうち、最も深刻なもの1件（当期経営サマリーカード用）。 */
export function topWarning(warnings: readonly WarningViewModel[]): WarningViewModel | undefined {
  return warnings[0];
}
