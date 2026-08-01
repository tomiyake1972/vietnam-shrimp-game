// ShrimpX V2 — 会社経営統合テスト環境（Phase 6.3） PD/VAP最低受注プレミアム
//
// 実装指示 §9: 供給過剰でも加工会社が採算を無視して無制限に値下げしない構造。
// 会社×商品（PD/VAP）について、目標プレミアム（フル原価＋目標マージン）と
// 最低受注プレミアム（回避可能費＋最低貢献利益）を区別し、市場プレミアムとの
// 比較で受注量を決める。
//
//   - 市場プレミアム >= 目標水準: 通常受注（係数1.0）
//   - 目標未満・最低受注水準以上: 稼働率・顧客維持等を考慮した縮小受注
//     （係数を最低受注水準到達時0.4まで線形に縮小）
//   - 最低受注水準未満: 販売提案を出さない（係数0）
//
// これにより供給過剰時は「プレミアム低下 → 経済的下限へ到達 → それ以上は
// 価格ではなく稼働率低下で調整」となる（受注を止めた会社の生産希望量が下がり、
// PD/VAP供給シグナル経由で翌期以降のプレミアムが自己修正される）。
// 高コスト会社（最低受注水準が高い会社）から先に退出し、効率的な会社は
// 受注を続けられる。プレミアム下限付近の配分では、既存Phase4の非価格競争
// （顧客関係・品質・納期信頼性・営業カバレッジ、上限付き飽和型の価格効果）を
// そのまま使う（本ファイルは配分ロジックへ一切手を入れない）。
//
// Phase 8の正式原価計算は未実装のため、構成要素はフィクスチャの暫定値
// （CompanyPremiumEconomics）から与える（実原価へ交換可能）。

import { CompanyPremiumEconomics } from "./types";

// ---------------------------------------------------------------------
// VAP差別化戦略（顧客理解型）: 会社別に獲得できるVAPプレミアム（2026-08-01新規）
//
// 市場全体のVAPプレミアム（market/productPremium.ts の calculateProductPremium）
// は一切変更しない。本節は、その市場プレミアムに会社別の「能力係数」を掛けて
// 会社が実際に実現するプレミアムを算出する、市場計算の**外側**の合成層。
//
// 能力係数の構成要素（すべてVAPに限定して使う。HOSO/PDには一切接続しない）:
//   - salesBaseScoreVap: 会社×市場×商品の営業基盤（companyLab/salesBase.ts）の
//     うちVAPぶん（market×product=vapのスコア、呼び出し側が集約して渡す）。
//   - productDevelopmentScore: VAP商品開発投資の蓄積（companyLab/productDevelopmentState.ts）。
//   - qualityAssuranceLevel: 品質保証投資水準（companyLab/qualityAssuranceInvestment.ts、
//     capexから導出、0〜1）。
//   - deliveryReliability: 納期信頼性（quality/scoreUpdates.tsが更新、0〜1に正規化して渡す）。
//   - recentMajorIncidentPenalty: 直近の重大品質事故ペナルティ（0以上）。
// ---------------------------------------------------------------------

/** 会社能力係数の合成に使う重み・上下限（暫定値・要校正。合計影響が過大にならない範囲で設定）。 */
export interface CompanyCapabilityCoefficientParameters {
  /** 中立値（0-100スケールの各スコアがちょうど50のときの寄与、能力係数への影響ゼロの基準点）。 */
  readonly neutralScore: number;
  /**
   * 【暫定値・要校正】営業基盤(salesBaseScoreVap)の重み。0-100スコアの
   * 中立超過分1点あたり能力係数への寄与。salesBase.tsの営業基盤は「顧客理解・
   * 顧客接点」の蓄積で、VAP差別化戦略（顧客理解型）の中核シグナルのため、
   * 4要素の中で最大の重みを置く。
   */
  readonly salesBaseWeight: number;
  /** 【暫定値・要校正】商品開発力(productDevelopmentScore)の重み。営業基盤と同水準。 */
  readonly productDevelopmentWeight: number;
  /**
   * 【暫定値・要校正】品質保証投資水準(qualityAssuranceLevel、0〜1)の重み。
   * 0〜1レンジのため、他の0-100スコアの重みとスケールを揃えるための係数
   * （qualityAssuranceLevel×100を中立50基準の点数とみなして重みを掛ける）。
   */
  readonly qualityAssuranceWeight: number;
  /**
   * 【暫定値・要校正】納期信頼性(deliveryReliability、0〜1)の重み。品質保証投資と
   * 同様のスケール換算。他の3要素より小さい重み（VAPプレミアム獲得力の主因は
   * 顧客理解・商品開発・品質保証であり、納期は補助的なシグナルという位置づけ）。
   */
  readonly deliveryReliabilityWeight: number;
  /**
   * 【暫定値・要校正】直近の重大事故ペナルティ(recentMajorIncidentPenalty、0以上、
   * severityスケール想定)1点あたりの能力係数への減点係数。salesBase.tsの
   * majorIncidentPenaltyPerSeverityと同様、事故の重大度に比例して効かせる。
   */
  readonly majorIncidentPenaltyWeight: number;
  /** 能力係数の下限（実装指示どおり0.7）。 */
  readonly coefficientFloor: number;
  /** 能力係数の上限（実装指示どおり1.3）。 */
  readonly coefficientCap: number;
}

export const COMPANY_CAPABILITY_COEFFICIENT_PARAMETERS_V1: CompanyCapabilityCoefficientParameters = {
  neutralScore: 50,
  // 4要素合計で中立点（すべて中立/中庸）のとき係数=1.0、全要素が振れ切ったとき
  // おおむね下限0.7〜上限1.3の範囲へ収まるよう、小さめの重みを暫定的に置く
  // （0-100スコアが中立50から最大50点乖離したとき: 0.006×50=0.30が上限寄与）。
  salesBaseWeight: 0.006,
  productDevelopmentWeight: 0.006,
  // qualityAssuranceLevel(0〜1)・deliveryReliability(0〜1)は×100して同じ点数
  // スケールに揃えたうえで重みを掛ける（下記calculateCompanyCapabilityCoefficient参照）。
  qualityAssuranceWeight: 0.004,
  deliveryReliabilityWeight: 0.003,
  // severity 0.5の重大事故1件でおおむね0.05の減点（salesBase.tsのmajorIncidentPenaltyPerSeverity=8点、
  // 能力係数側は同じ事故一発で過大に効かせないよう小さめに設定）。
  majorIncidentPenaltyWeight: 0.1,
  coefficientFloor: 0.7,
  coefficientCap: 1.3,
};

/** calculateCompanyCapabilityCoefficient への入力一式。 */
export interface CompanyCapabilityCoefficientInput {
  /** 会社×市場×商品(vap)の営業基盤スコア（0-100、companyLab/salesBase.tsから取得）。 */
  readonly salesBaseScoreVap: number;
  /** 会社のVAP商品開発力スコア（0-100、companyLab/productDevelopmentState.tsから取得）。 */
  readonly productDevelopmentScore: number;
  /** 会社のVAP品質保証投資レベル（0-1、companyLab/qualityAssuranceInvestment.tsから取得）。 */
  readonly qualityAssuranceLevel: number;
  /** 会社の納期信頼性（0-1、既存のdeliveryReliabilityByMarketから取得・正規化した値）。 */
  readonly deliveryReliability: number;
  /** 直近の重大事故ペナルティ（0以上。severity比例のスコアを想定、無ければ0）。 */
  readonly recentMajorIncidentPenalty: number;
}

/**
 * 会社別のVAP能力係数を算出する（重み付き合成 → clamp(下限0.7, 上限1.3)）。
 * 市場全体のVAPプレミアム計算（market/productPremium.ts）には一切依存せず、
 * その結果を後段で乗じるための係数だけをここで作る。
 */
export function calculateCompanyCapabilityCoefficient(
  input: CompanyCapabilityCoefficientInput,
  params: CompanyCapabilityCoefficientParameters = COMPANY_CAPABILITY_COEFFICIENT_PARAMETERS_V1
): number {
  const salesBaseContribution = (input.salesBaseScoreVap - params.neutralScore) * params.salesBaseWeight;
  const productDevelopmentContribution = (input.productDevelopmentScore - params.neutralScore) * params.productDevelopmentWeight;
  // 0〜1レンジのqualityAssuranceLevel・deliveryReliabilityは×100して0-100スコアと
  // 同じ点数スケールへ揃えたうえで、中立50を基準に寄与を計算する。
  const qualityAssuranceContribution =
    (Math.max(0, Math.min(1, input.qualityAssuranceLevel)) * 100 - params.neutralScore) * params.qualityAssuranceWeight;
  const deliveryReliabilityContribution =
    (Math.max(0, Math.min(1, input.deliveryReliability)) * 100 - params.neutralScore) * params.deliveryReliabilityWeight;
  const majorIncidentContribution = -Math.max(0, input.recentMajorIncidentPenalty) * params.majorIncidentPenaltyWeight;

  const raw =
    1 +
    salesBaseContribution +
    productDevelopmentContribution +
    qualityAssuranceContribution +
    deliveryReliabilityContribution +
    majorIncidentContribution;

  return Math.max(params.coefficientFloor, Math.min(params.coefficientCap, raw));
}

/**
 * 市場プレミアム（前期実績の公開情報、market/productPremium.tsの出力そのもの）に
 * 会社別の能力係数を掛けて、会社が実際に実現するVAPプレミアムを算出する。
 * VAPに限って使う（HOSO/PDの価格計算からは一切呼び出さない。呼び出し側
 * 参照: companyLab/autoPolicy.ts・companyLab/standardAi/decision/sales.ts の
 * orderFactorsByProduct、VAPの分岐のみ）。
 */
export function calculateCompanyRealizedVapPremiumRatio(marketPremiumRatio: number, capabilityCoefficient: number): number {
  return marketPremiumRatio * capabilityCoefficient;
}

/** 目標プレミアム（フル原価＋目標マージン。これ以上なら通常受注）。 */
export function targetPremium(econ: CompanyPremiumEconomics): number {
  return (
    econ.expectedVariableProcessingCostUsdPerHosoEqKg +
    econ.allocatedFixedCostUsdPerHosoEqKg +
    econ.sellingAndLogisticsCostUsdPerHosoEqKg +
    econ.targetMarginUsdPerHosoEqKg
  );
}

/** 最低受注プレミアム（回避可能費＋最低貢献利益。これ未満では販売提案を出さない）。 */
export function minimumAcceptablePremium(econ: CompanyPremiumEconomics): number {
  return (
    econ.avoidableVariableProcessingCostUsdPerHosoEqKg +
    econ.incrementalSellingAndLogisticsCostUsdPerHosoEqKg +
    econ.minimumContributionMarginUsdPerHosoEqKg
  );
}

/** 縮小受注時の下限係数（最低受注水準ちょうどのときの受注量係数。暫定値・要校正）。 */
export const REDUCED_ORDER_FLOOR_FACTOR = 0.4;

/**
 * 市場プレミアム（前期実績の公開情報）に対する受注量係数（0〜1）を返す。
 * marketPremiumがundefined（turn 1等、前期実績が未知）の場合は、目標水準が
 * 満たされる想定で通常受注（1.0）とする。
 */
export function orderQuantityFactor(econ: CompanyPremiumEconomics, marketPremium: number | undefined): number {
  if (marketPremium === undefined) return 1;
  const target = targetPremium(econ);
  const minimum = minimumAcceptablePremium(econ);
  if (marketPremium >= target) return 1;
  if (marketPremium < minimum) return 0;
  const span = Math.max(target - minimum, 1e-9);
  const position = (marketPremium - minimum) / span; // 0（最低受注水準）〜1（目標水準）
  return REDUCED_ORDER_FLOOR_FACTOR + (1 - REDUCED_ORDER_FLOOR_FACTOR) * position;
}
