// ShrimpX V2 — Phase SAI-1: 標準経営AI基盤 閾値・設定パラメータ
//
// すべての閾値・重みをこのファイルへ集約する（実装指示: 「閾値・重み・優先順位を
// 後から1箇所で調整できること」）。5社すべてに同一の値を適用する（会社IDに
// よる分岐は存在しない）。将来の校正フェーズでの調整対象であることを明示する。
//
// 【SAI-4追記】STANDARD_AI_PARAMETERS_V1は引き続き「全社同一」の既定値であり、
// 本ファイル自体は一切変更していない（既存のSAI-1〜SAI-3Bの全テスト・成果物に
// 影響を与えない）。5社異質モデル（小幅な経営性格差）は、このデフォルトを会社ID
// ごとに小さくバイアスした別の`StandardAiParameters`インスタンスを、companyLab/
// standardAi/managementProfile.tsが生成して差し替えるだけであり、ここで会社IDに
// よる分岐を持ち込むわけではない。

import { CompanyFixture } from "../types";
import { unwrapUnit } from "../../core/units";
import { computeQuarterlyLaborCost } from "../workforce";
import { DemandMarketId, Product } from "../../market/types";

export interface StandardAiParameters {
  // --- 在庫目標（生産・調達共通） ---
  /** 完成品在庫の目標水準（今期生産希望量に対する四半期数）。これを超えると過剰。 */
  readonly finishedGoodsTargetQuarters: number;
  /** 原料在庫の目標水準（今期必要原料量に対する四半期数）。 */
  readonly rawMaterialTargetQuarters: number;
  /** 在庫補正の減衰係数（目標との乖離のうち1四半期で埋めにいく比率）。 */
  readonly inventoryCorrectionDamping: number;

  // --- 販売 ---
  /** 完成品在庫過剰とみなす比率（在庫/目標在庫がこれを超えたら値引き）。 */
  readonly excessInventoryRatioForDiscount: number;
  /** 在庫過剰時の最大値引き率（基準価格に対する比率）。 */
  readonly maxDiscountRatioForExcessStock: number;
  /** 供給余力が薄いときの値引き回避しきい値（能力使用率）。 */
  readonly highUtilizationRatioForNoDiscount: number;
  /** 【SAI-4追加】商品別能力に対する目標販売数量の比率（会社×商品ごとの目標稼働率）。
   *  従来はdecision/sales.tsに`BASE_UTILIZATION_TARGET = 0.8`としてハードコードされて
   *  いた定数をパラメータ化しただけで、既定値0.8は変更していない（全社一律の
   *  数値が変わっていないため、既存の全テスト・成果物への影響はゼロ）。5社異質
   *  モデルのsalesVolumeBias/marketShareBias（B社が少し高め・C社が少し低めにする等）
   *  の差し込み口として使う。 */
  readonly salesUtilizationTarget: number;
  /** 【SAI-4追加】PD/VAPの受注量係数（premiumPolicy.tsのorderQuantityFactor、
   *  0〜1）に加算する上乗せ・割引（±0〜0.1程度を想定）。既定0（無補正、premiumPolicy.ts
   *  の計算式は一切変更しない）。5社異質モデルのvalueAddedBias（D社がPD/VAPを
   *  少し優先する）の差し込み口。加算後は[0, 1.1]にクランプする
   *  （decision/sales.ts参照、捏造的な値を作らないための上限）。 */
  readonly valueAddedOrderFactorBoost: number;

  // --- 【SAI-5A追加】市場・商品志向（orientationProfile.tsが会社別に注入） ---
  /** 市場志向倍率（市場ごとの魅力度補正、許容範囲0.80〜1.25）。既定は空
   *  オブジェクト（=全市場1.0、志向なし）。空のときdecision/sales.tsは
   *  再配分コードパス自体をスキップするため、既定値での浮動小数点結果は
   *  従来とビット単位で一致する。値の意味・会社別の設定は
   *  orientationProfile.tsに一箇所集約（ここでは会社IDによる分岐を持たない）。 */
  readonly marketOrientationMultipliers: Readonly<Partial<Record<DemandMarketId, number>>>;
  /** 商品志向倍率（商品ごとの魅力度補正、許容範囲0.85〜1.20）。既定は空
   *  オブジェクト（=全商品1.0）。商品別の目標販売数量（能力×目標稼働率）に
   *  乗算する。上限1.20×既定稼働率0.8=0.96のため能力超過は構造上起きない。 */
  readonly productOrientationMultipliers: Readonly<Partial<Record<Product, number>>>;
  /** 【SAI-5F】成長トレンド応答度（0〜1）。公開のライフサイクル構成比トレンド
   *  （前期差分）が正のとき、PD/VAP設備投資の入口しきい値をどの程度前倒し
   *  するかの係数。既定0（無効。orientation有効時のみ会社別に設定される）。 */
  readonly growthTrendResponsiveness: number;
  /** 【SAI-5F】過剰供給リトリート感度（0〜1）。公開の商品別供給圧力が高い
   *  とき、PD/VAP設備投資をどの程度強く見送るか。既定0（無効）。 */
  readonly oversupplyRetreatSensitivity: number;
  /** 【SAI-5F】Standard AIの拡張設備投資判断（suspended案件のresume提案・
   *  ライフサイクル成長エントリ・過剰供給リトリート）の有効化。既定false
   *  （decision/capex.tsの既存判断と完全に同一の挙動）。 */
  readonly standardAiCapexExtensionsEnabled: boolean;
  /** 【SAI-5F】成長エントリの最低前期稼働率（通常のcapex条件0.92より低い入口。
   *  ライフサイクル成長局面では能力逼迫の「手前」で投資判断するための緩和値。
   *  資金・在庫・借入の安全条件は通常capexと完全に同一のまま）。 */
  readonly capexGrowthEntryUtilizationThreshold: number;
  /** 【SAI-5F】成長エントリとみなす公開ライフサイクルトレンドの下限
   *  （構成比pt/四半期。0.004 = 年率約1.6ptの構成比シフト）。 */
  readonly capexGrowthEntryTrendPerQuarterThreshold: number;
  /** 【SAI-5F】これを超える公開供給圧力のEWMAではPD/VAPの設備投資を見送る
   *  （CAPEX_DEFERRED_OVERSUPPLY / VAP_OVERSUPPLY_RETREAT）。
   *  【監査指摘B後に再測定】供給圧力の定義を completed_supply
   *  （= 1 + 売れ残り提示量/対象需要）へ構造修正したため、旧定義（0.2〜0.5の
   *  レンジ）を前提にした1.15は意味を失った。4seed×32Q実測のEWMA分布は
   *  PD 1.000〜1.044（中央値1.021）、VAP 1.070〜1.318（中央値1.106、p75 1.141、
   *  p90 1.279）。設備投資の見送りは販売抑制より重い判断のため、VAPで上位2割
   *  程度の局面だけが該当する水準に置く。 */
  readonly capexOversupplyPressureThreshold: number;
  /** 【SAI-5F】ライフサイクル成長トレンドによる販売数量ブーストの上限
   *  （比率。成長市場でも希望量の増加は最大+5%までの小幅な前傾）。 */
  readonly lifecycleGrowthSalesBoostCap: number;
  /** 【SAI-5F】トレンド（構成比pt/四半期）→販売ブースト比率への変換係数。 */
  readonly lifecycleGrowthSalesBoostScale: number;
  /** 【SAI-5F】これを超える公開供給圧力のEWMAで当該商品の販売希望量を抑制し始める。
   *  【監査指摘B後に再測定】上記と同じ実測分布に基づき、VAPの上位25%程度
   *  （p75=1.141付近）から緩やかに抑制が効き始める水準に置く。PD側は実測レンジの
   *  上限が1.044のため通常運転では発火しない（＝PDは本シナリオで供給過剰に
   *  ならない、という測定結果。発火させるための本体ロジックの追加はしない）。 */
  readonly supplyPressureRetreatThreshold: number;
  /** 【SAI-5F】供給圧力リトリートによる販売希望量縮小の下限倍率（最大-15%）。 */
  readonly supplyPressureRetreatFloor: number;

  // --- 労働 ---
  /** ワーカー不足が「持続的」とみなす連続四半期しきい値（ヒステリシス）。 */
  readonly sustainedShortageQuarterThreshold: number;
  /** ワーカー過剰が「持続的」とみなす連続四半期しきい値。 */
  readonly sustainedExcessQuarterThreshold: number;
  /** 一時的な不足に対して認める最大残業率。 */
  readonly maxOvertimeRateForTransientShortage: number;
  /** 一時的な不足に対して認める、必要人数に対する臨時ワーカー比率上限。 */
  readonly maxTemporaryRatioForTransientShortage: number;
  /** 正社員の増減は必要人数とのギャップのうち、この比率だけを1四半期で埋める（過剰反応防止）。 */
  readonly regularHeadcountAdjustmentDamping: number;

  // --- 資金繰り ---
  /** 最低現金バッファの目安となる四半期数（会社規模連動の推定四半期支出に対する倍率）。 */
  readonly cashBufferQuarters: number;
  /** 現金がこの倍率（対最低バッファ）を超えたら任意期限前返済を検討する。 */
  readonly voluntaryPrepaymentMultiple: number;
  /** 最低現金バッファの絶対下限（USD）。会社規模が極端に小さい場合の安全弁。 */
  readonly minimumCashBufferFloorUsd: number;
  /** 通常融資の希望期間（四半期）。 */
  readonly desiredTermQuarters: number;
  /** 原料調達に想定する暫定原料価格（前期実績が無い場合のフォールバック、USD/HOSO換算kg）。 */
  readonly defaultExpectedRawPriceUsdPerKg: number;
  /** 想定臨時ワーカー比率（現金バッファ試算に使う簡易な人件費見積り用）。 */
  readonly typicalTemporaryHeadcountRatio: number;
  /** 想定稼働率（現金バッファ試算・原料コスト見積りに使う）。 */
  readonly typicalUtilizationForCashEstimate: number;

  // --- 設備投資（capex） ---
  /** これ以上の設備稼働率（前期実績）が続けば「持続的ボトルネック」とみなす。 */
  readonly capexSustainedUtilizationThreshold: number;
  /** 当四半期の必要量が能力を超える比率（capexを検討する最低条件）。 */
  readonly capexCurrentShortfallRatioThreshold: number;
  /** 設備投資後も安全に維持できる現金の、最低バッファに対する倍率（これ未満なら見送り）。 */
  readonly capexCashSafetyMultiple: number;
  /** 借入残高が会社規模推定に対してこの比率を超えたら、財務健全性を理由にcapexを見送る。 */
  readonly capexMaxLoanToSizeRatio: number;

  // --- 養殖 ---
  /** 養殖の期待収穫比率（池入れ量→収穫量の目安）。 */
  readonly expectedAquacultureHarvestRatio: number;
  /** 養殖強度（0〜1、固定・全社一律）。 */
  readonly aquacultureIntensity: number;
  /** バイオセキュリティ水準（0〜1、固定・全社一律）。 */
  readonly bioSecurityLevel: number;

  // --- 調達構成 ---
  /** 輸入に振り向ける比率の目安（構成比ベース）。 */
  readonly importMixRatio: number;
  /** 国内買付需要の下限（基礎需要に対する比率）。ゼロへ一斉に落ちるのを防ぐ。 */
  readonly minDomesticPurchaseRatioOfBase: number;
  /**
   * 自社養殖だけで必要原料量を完全自給しないための上限（必要原料量に対する比率）。
   * 養殖能力が大きい会社でも、この比率を超えて自給せず、国内買付・輸入の需要を
   * 恒常的に残す（全社一律の上限。会社ごとの違いは実際の養殖能力の差だけから生じる）。
   */
  readonly maxAquacultureShareOfRequirement: number;
  /** 現金圧力が高いときに調達希望量を抑える度合い（0〜1、大きいほど強く抑制）。 */
  readonly cashConstrainedProcurementDampingAtSeverePressure: number;
  /** これを超える現金圧力を「深刻」とみなし、調達を必要最小限へ寄せる。 */
  readonly severeCashPressureThreshold: number;

  /** 【SAI-4追加】設備投資しきい値（capexCurrentShortfallRatioThreshold）の、
   *  商品別の追加バイアス（比率。正の値＝そのぶんしきい値を下げて投資判断を早める、
   *  負の値＝遅らせる）。既定は空オブジェクト（全商品バイアスなし＝既存の
   *  capex.tsの計算式と完全に同じ結果になる）。5社異質モデルのD社（高付加価値型）
   *  が「PD・VAP能力不足が継続した場合の設備投資判断を少し早める」を、HOSOには
   *  影響させずPD/VAPだけに適用するための差し込み口。 */
  readonly capexShortfallThresholdBiasByProduct: Readonly<Partial<Record<Product, number>>>;
}

/**
 * SAI-1の既定パラメータ。値はいずれも実運用開始後の校正対象（暫定値）。
 * 5社すべてに同一の値を適用する。
 */
export const STANDARD_AI_PARAMETERS_V1: StandardAiParameters = {
  finishedGoodsTargetQuarters: 0.35,
  rawMaterialTargetQuarters: 0.4,
  inventoryCorrectionDamping: 0.5,

  excessInventoryRatioForDiscount: 1.3,
  maxDiscountRatioForExcessStock: 0.12,
  highUtilizationRatioForNoDiscount: 0.95,
  salesUtilizationTarget: 0.8,
  valueAddedOrderFactorBoost: 0,

  marketOrientationMultipliers: {},
  productOrientationMultipliers: {},
  growthTrendResponsiveness: 0,
  oversupplyRetreatSensitivity: 0,
  standardAiCapexExtensionsEnabled: false,
  capexGrowthEntryUtilizationThreshold: 0.85,
  capexGrowthEntryTrendPerQuarterThreshold: 0.004,
  capexOversupplyPressureThreshold: 1.2,
  lifecycleGrowthSalesBoostCap: 0.05,
  lifecycleGrowthSalesBoostScale: 10,
  supplyPressureRetreatThreshold: 1.14,
  supplyPressureRetreatFloor: 0.85,

  sustainedShortageQuarterThreshold: 2,
  sustainedExcessQuarterThreshold: 2,
  maxOvertimeRateForTransientShortage: 0.2,
  maxTemporaryRatioForTransientShortage: 0.35,
  regularHeadcountAdjustmentDamping: 0.5,

  cashBufferQuarters: 0.6,
  voluntaryPrepaymentMultiple: 2.5,
  minimumCashBufferFloorUsd: 5_000_000,
  desiredTermQuarters: 4,
  defaultExpectedRawPriceUsdPerKg: 2.5,
  typicalTemporaryHeadcountRatio: 0.15,
  typicalUtilizationForCashEstimate: 0.75,

  capexSustainedUtilizationThreshold: 0.92,
  capexCurrentShortfallRatioThreshold: 1.05,
  capexCashSafetyMultiple: 1.75,
  capexMaxLoanToSizeRatio: 1.5,

  expectedAquacultureHarvestRatio: 0.9,
  aquacultureIntensity: 0.6,
  bioSecurityLevel: 0.6,

  importMixRatio: 0.15,
  minDomesticPurchaseRatioOfBase: 0.2,
  maxAquacultureShareOfRequirement: 0.35,
  cashConstrainedProcurementDampingAtSeverePressure: 0.5,
  severeCashPressureThreshold: 0.7,

  capexShortfallThresholdBiasByProduct: {},
};

// ---------------------------------------------------------------------
// 会社規模の推定（現金バッファ・借入健全性しきい値の分母に使う）
// ---------------------------------------------------------------------

/**
 * 【SAI-1固有の設計判断・実装指示で明示要求】最低現金バッファは会社規模・四半期
 * 支出に連動させ、全社一律の絶対額（例: companyLab/parameters.tsの
 * AUTO_FINANCING_POLICY_PARAMETERS_V1.targetMinimumCashUsd = 40,000,000固定）を
 * 使わない。
 *
 * ここでは「会社の総処理能力（HOSO/PD/VAP合計）× 想定稼働率 × 想定原料単価」＋
 * 「常用ワーカー人件費（想定臨時ワーカー込み）」を、1四半期あたりの典型的な
 * 現金支出の目安として推定し、その定数倍（cashBufferQuarters）を最低現金バッファ
 * とする。会社の工場規模・人員規模が異なれば、この推定値も自然に異なる
 * （会社IDによる分岐ではなく、fixtureの実際の規模差に連動する）。
 *
 * 借入健全性の分母（capexMaxLoanToSizeRatio等）にも同じ推定値を再利用する。
 */
export function estimateQuarterlyScaleUsd(
  fixture: CompanyFixture,
  expectedRawPriceUsdPerKg: number,
  params: StandardAiParameters = STANDARD_AI_PARAMETERS_V1
): number {
  const totalCapacity = fixture.factories.reduce(
    (sum, f) => sum + unwrapUnit(f.hosoCapacity) + unwrapUnit(f.pdCapacity) + unwrapUnit(f.vapCapacity),
    0
  );
  const estimatedRawMaterialSpendUsd = totalCapacity * params.typicalUtilizationForCashEstimate * expectedRawPriceUsdPerKg * 1000;
  // HosoEqTons -> kg換算(*1000)してからUSD/kgで単価をかける（既存の数量・単価規約に合わせる）。

  const regularHeadcountTotal = fixture.workerBaseline.reduce((sum, w) => sum + w.regularHeadcount, 0);
  const typicalTemporaryHeadcount = regularHeadcountTotal * params.typicalTemporaryHeadcountRatio;
  // 人件費単価はfinance/parameters.tsが唯一の情報源（workforce.tsのcomputeQuarterlyLaborCostが
  // 内部でFINANCE_PARAMETERS_V1を参照する）。ここへ独自の単価を持ち込まない。
  const estimatedLaborCostUsd = computeQuarterlyLaborCost(regularHeadcountTotal, typicalTemporaryHeadcount).totalCostUsd;

  return estimatedRawMaterialSpendUsd + estimatedLaborCostUsd;
}

/** 会社規模に連動した最低現金バッファ（絶対下限つき）。 */
export function estimateTargetMinimumCashUsd(
  fixture: CompanyFixture,
  expectedRawPriceUsdPerKg: number,
  params: StandardAiParameters = STANDARD_AI_PARAMETERS_V1
): number {
  const scale = estimateQuarterlyScaleUsd(fixture, expectedRawPriceUsdPerKg, params);
  return Math.max(params.minimumCashBufferFloorUsd, scale * params.cashBufferQuarters);
}
