// ShrimpX V2 — VAP差別化戦略（顧客理解型） 品質保証投資のVAP品質接続（2026-08-01新規）
//
// 【背景】VAP差別化戦略（顧客理解型）を成立させるため、capex/parameters.ts に
// 既存のテンプレートがありながら生産能力・品質のいずれにも未接続だった
// qualityControlEquipment（品質管理設備、capacityIncreaseTonsPerQuarter=0）を、
// 会社のVAP baselineOperationalQuality（quality/parameters.tsのオーバーライド
// 機構、quality/batchAdjustment.tsのbaselineQualityOverride）へ小さな加点として
// 接続する。
//
// 【新規の永続状態を作らない】production/pdMechanizationEffect.tsと同じ方針で、
// 会社別の品質保証投資水準は、既存のCompanyCapexState（capex/types.ts）が保持する
// CapitalProjectの状態遷移（completed・completedPeriod）とcapex/capacityEffect.tsの
// isCapexProjectOperationalAt（稼働開始判定の唯一の真実）から毎期再導出する。
//
// 【既存のPD機械化副次効果接続を壊さない】quality/batchAdjustment.tsの
// baselineQualityOverrideはMap<"companyId::product", number>で、PD機械化の副次
// 効果（companyLab/runner.ts）は company::pd キーだけを書き込む。本ファイルは
// company::vap キーだけを書き込むため、キー自体は衝突しないが、将来どちらかの
// 対象商品が変わっても事故らないよう、呼び出し側（runner.ts）では上書きではなく
// mergeBaselineQualityOverrides で加算合成する（実装指示「上書きではなく加算、
// または既存の合成関数があればそれを使う」に対応する既存の合成関数）。
//
// 【qualityAssuranceLevelの定義（暫定・要校正）】
//   稼働開始済み（isCapexProjectOperationalAt）のqualityControlEquipment案件数を
//   qualityAssuranceLevelProjectCapで正規化した0〜1の値。pdMechanizationのような
//   ramp-up・稼働率連動メタデータ（laborIntensityReduction）がqualityControlEquipment
//   テンプレートには無いため、「稼働中の案件が何件あるか」という単純な段階的指標を
//   採用する（案件1件=部分的、cap件数到達=満額）。

import { CapitalProject, CompanyCapexState } from "../capex/types";
import { isCapexProjectOperationalAt } from "../capex/capacityEffect";
import { PeriodV2 } from "../core/period";

/** 品質保証投資（qualityControlEquipment）→VAP品質接続のパラメータ（暫定値・要校正）。 */
export interface QualityAssuranceInvestmentParameters {
  /**
   * qualityAssuranceLevel=1.0（満額）に達するために必要な、稼働中の
   * qualityControlEquipment案件数。【暫定値・要校正】1件で部分的な効果、
   * 2件目で満額とする（capex/parameters.tsのmaxConcurrentActiveProjectsPerCompanyの
   * 範囲内で現実的に到達しうる件数）。
   */
  readonly levelProjectCap: number;
  /**
   * qualityAssuranceLevel=1.0のときのVAP baselineOperationalQualityへの加点上限
   * （点）。production/pdMechanizationEffect.tsのMAX_QUALITY_BONUS_POINTS(3点、
   * 基準baseline85に対し3.5%強)と同水準の「小さく、上限付き」の効果とする
   * （実装指示§7「品質・環境設備は今回、生産能力を増加させない」を踏襲しつつ、
   * VAP差別化戦略成立のために品質面の小さな副次効果だけを新たに認める）。
   */
  readonly maxVapQualityBonusPoints: number;
}

export const QUALITY_ASSURANCE_INVESTMENT_PARAMETERS_V1: QualityAssuranceInvestmentParameters = {
  levelProjectCap: 2,
  maxVapQualityBonusPoints: 3,
};

/**
 * 1社ぶんの投資案件ポートフォリオから、period時点で稼働開始済み
 * （isCapexProjectOperationalAt）のqualityControlEquipment案件数を数える。
 */
export function countOperationalQualityAssuranceProjects(projects: readonly CapitalProject[], period: PeriodV2): number {
  let count = 0;
  for (const project of projects) {
    if (project.projectType !== "qualityControlEquipment") continue;
    if (!isCapexProjectOperationalAt(project, period)) continue;
    count += 1;
  }
  return count;
}

/**
 * 会社のVAP品質保証投資レベル（0〜1）。既存のCompanyCapexStateから導出する
 * （新規の永続状態を追加しない）。
 */
export function computeQualityAssuranceLevel(
  projects: readonly CapitalProject[],
  period: PeriodV2,
  params: QualityAssuranceInvestmentParameters = QUALITY_ASSURANCE_INVESTMENT_PARAMETERS_V1
): number {
  const count = countOperationalQualityAssuranceProjects(projects, period);
  if (count <= 0) return 0;
  const cap = params.levelProjectCap > 0 ? params.levelProjectCap : 1;
  return Math.max(0, Math.min(1, count / cap));
}

/** CompanyCapexStateから直接、会社のVAP品質保証投資レベル（0〜1）を導出する便利関数。 */
export function computeQualityAssuranceLevelForCompany(
  capexStateForCompany: CompanyCapexState | undefined,
  period: PeriodV2,
  params: QualityAssuranceInvestmentParameters = QUALITY_ASSURANCE_INVESTMENT_PARAMETERS_V1
): number {
  const projects = capexStateForCompany?.portfolio.projects ?? [];
  return computeQualityAssuranceLevel(projects, period, params);
}

/**
 * 品質保証投資レベル（0〜1）から、VAP baselineOperationalQualityへの加点（点）を
 * 算出する。production/pdMechanizationEffect.tsのcomputePdMechanizationQualityBonus
 * と同じ「小さく、上限付き」の設計。
 */
export function computeQualityAssuranceVapQualityBonus(
  qualityAssuranceLevel: number,
  params: QualityAssuranceInvestmentParameters = QUALITY_ASSURANCE_INVESTMENT_PARAMETERS_V1
): number {
  const safeLevel = Number.isFinite(qualityAssuranceLevel) ? Math.max(0, Math.min(1, qualityAssuranceLevel)) : 0;
  return params.maxVapQualityBonusPoints * safeLevel;
}

/**
 * 既存のbaselineQualityOverrideマップ（quality/batchAdjustment.tsのキー形式
 * "companyId::product"、値は「基準品質＋既存の加点」の完成値）へ、別経路の
 * 加点デルタ（bonusDeltaByKey、値は加点そのもの）を**加算合成**する
 * （上書きではなく加算。実装指示「既にPD機械化用の副次効果接続がされている
 * 場合はそれを壊さないよう、加点を合成する形にする」への対応）。
 *
 * - bonusDeltaByKeyのキーがexistingOverridesに既に存在する場合: 既存の完成値へ
 *   加点デルタを加算する（＝2つの投資効果が両方効いている状態を正しく表現）。
 * - bonusDeltaByKeyのキーがexistingOverridesに無い場合:
 *   defaultBaselineForKey(key) + 加点デルタ を新規エントリとして追加する。
 * - existingOverridesのうちbonusDeltaByKeyに無いキーはそのまま保持する。
 *
 * 現状の呼び出し元ではPD機械化がcompany::pd、品質保証投資がcompany::vapのみを
 * 書くため実際にはキーが衝突しないが、将来どちらかの対象商品が変わっても
 * 値の二重計上（完成値同士の単純加算）を起こさない安全な合成にしてある。
 * 両方空ならundefinedを返す（呼び出し側がbaselineQualityOverride自体を付けない
 * 既存挙動を保てるようにするため）。
 */
export function mergeBaselineQualityOverrides(
  existingOverrides: ReadonlyMap<string, number> | undefined,
  bonusDeltaByKey: ReadonlyMap<string, number>,
  defaultBaselineForKey: (key: string) => number
): Map<string, number> | undefined {
  if ((!existingOverrides || existingOverrides.size === 0) && bonusDeltaByKey.size === 0) return undefined;
  const merged = new Map<string, number>(existingOverrides ?? []);
  for (const [key, bonus] of bonusDeltaByKey) {
    if (bonus === 0) continue;
    const base = merged.get(key) ?? defaultBaselineForKey(key);
    merged.set(key, base + bonus);
  }
  return merged.size > 0 ? merged : undefined;
}
