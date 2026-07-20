// ShrimpX V2 — 会社経営統合テスト環境（Phase 6.3） テスト環境前提値
//
// 【Phase 6.3変更】旧COMPANY_LAB_RAW_MATERIALS_PARAMETERS（調達処理能力の
// 約100倍一律補正）は廃止した。明確な経済的根拠のないテスト専用倍率であり、
// 補正後は調達能力が工場能力の7〜11倍と過大で制約として一度も機能していなかった
// （Phase 6.2診断）。調達処理能力は、rawMaterials/domesticPurchase.tsの
// 工場能力連動方式（capacityFactoryLinked: 工場共通原料処理能力×人員曲線で
// 通常時1.0〜1.5倍）へ置き換えた。
//
// 本ファイルには、companyLabテスト環境固有の前提値（外部加工業者需要の集計
// モデル等）のみを集約する。これらは本番の業界モデルではなく、後から交換可能な
// テスト用フィクスチャの一部である。

import { ExternalProcessorDemandAssumptions } from "./externalDemand";

/**
 * 外部加工業者需要（実装指示 §5）の暫定前提値（すべて要校正）。
 *
 * スケールの根拠:
 *   - シナリオbaselineのベトナム国内原料供給は約450,000 HOSO換算トン/四半期。
 *   - 5社フィクスチャの通常時国内買付需要は合計6万〜9万トン/四半期程度
 *     （調達構成の再校正後）。
 *   - 「5社がベトナム加工業界の20〜30%、外部加工業者が70〜80%」の暫定設定に
 *     合わせ、外部需要の基準を 0.70 × 450,000 = 315,000トン/四半期 とする
 *     （総需要 約37万〜40万トンに対する5社シェア ≈ 15〜23%）。
 */
export const EXTERNAL_PROCESSOR_DEMAND_ASSUMPTIONS_V1: ExternalProcessorDemandAssumptions = {
  referenceDomesticSupplyTons: 450000,
  baseShareOfReferenceSupply: 0.7,
  priceElasticity: 0.4,
  referencePriceUsdPerHosoEqKg: 2.6,
  worldDemandElasticity: 0.5,
  minShareOfReferenceSupply: 0.4,
  maxShareOfReferenceSupply: 0.9,
};

/**
 * 世界需要指数の基準値（HOSO換算トン/四半期）。シナリオ前史の需要市場別
 * 前期消費の合計（CN 380,000 + US 320,000 + EU 260,000 + JP 90,000 +
 * OTHER 150,000 = 1,200,000）。worldDemandIndex = Σ(前期消費×景気指数) / この値。
 */
export const REFERENCE_WORLD_CONSUMPTION_TONS = 1200000;

/**
 * 【Phase 8B-1】5社自動方針の「単純な資金調達方針」の前提値（実装指示 §5.6。
 * 会社ごとの高度な財務戦略はPhase 9対象。ここでは「最低必要現金を下回れば
 * 借入申請、十分あれば借入しない、返済可能なら高金利借入を優先返済」という
 * 単純なルールの閾値だけを持つ。将来校正対象・要校正）。
 */
export interface AutoFinancingPolicyParameters {
  /** 現金がこれを下回れば通常融資を申請する（希望額はこの水準まで戻す額）。 */
  readonly targetMinimumCashUsd: number;
  /** 現金がこれを上回り、既存借入があれば、超過分を任意期限前返済として申請する。 */
  readonly voluntaryPrepaymentThresholdCashUsd: number;
  readonly desiredTermQuarters: number;
  /** 通常融資が利用可能なら緊急融資を選ばない、という方針だが、通常融資が
   * 不足した場合の最後の手段としては受け入れる（emergencyAcceptable=true固定）。 */
  readonly emergencyAcceptable: boolean;
}

export const AUTO_FINANCING_POLICY_PARAMETERS_V1: AutoFinancingPolicyParameters = {
  // 5社フィクスチャの1四半期あたりの国内買付必要現金は概ね1,000万〜7,000万USD
  // 規模（診断結果より）であるため、最低現金目標をその規模に合わせる
  // （15M等の小さすぎる目標では、四半期内の資金需要に対して早期の借入申請が
  // 間に合わず、資金不足を防げない。要将来校正）。
  targetMinimumCashUsd: 40_000_000,
  voluntaryPrepaymentThresholdCashUsd: 100_000_000,
  desiredTermQuarters: 4,
  emergencyAcceptable: true,
};
