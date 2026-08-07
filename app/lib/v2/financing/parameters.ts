// ShrimpX V2 — 資金繰り・借入・銀行信用モジュール パラメータ定義（Phase 8B-1）
//
// finance/parameters.tsと同じ方針で、係数を1ファイルへ集約する。すべて
// 「Phase 8B-1新規・要校正」の暫定値であり、Phase 8B-2以降・Phase 8Cの経済校正で
// 再検討する前提とする（実装指示§13「以下は停止せず、合理的な初期値で
// 前進してください」に列挙された項目はすべて本ファイルの値である）。

export interface FinancingParameters {
  readonly parametersVersion: string;

  readonly interestRate: {
    /** 基準金利（年率）。 */
    readonly baseRateAnnual: number;
    /** 信用区分別の信用スプレッド（年率）。 */
    readonly creditSpreadAnnualByTier: Readonly<Record<"A" | "B" | "C" | "D" | "E", number>>;
    /** 緊急融資の条件加算（年率、基準金利+信用スプレッドに加算）。 */
    readonly emergencyLoanSurchargeAnnual: number;
    /** 財務制限条項違反時の条件加算（年率）。 */
    readonly covenantBreachSurchargeAnnual: number;
    /** 延滞履歴がある場合の条件加算（年率）。 */
    readonly arrearsHistorySurchargeAnnual: number;
    /** 借換え時の条件加算（年率、事務手数料相当の簡易表現）。 */
    readonly refinanceSurchargeAnnual: number;
    /** 融資期間が長期（termLoan）の場合の期間加算（年率）。 */
    readonly termLoanDurationSurchargeAnnual: number;
  };

  readonly creditScore: {
    /** 各要素の重み（合計1.0を目安。正規化スコア0〜100×重みの加重平均で最終スコアを出す）。 */
    readonly weights: {
      readonly cashRunway: number;
      readonly operatingCashFlow: number;
      readonly profitability: number;
      readonly interestCoverage: number;
      readonly leverage: number;
      readonly equityRatio: number;
      readonly repaymentTrackRecord: number;
      readonly arrearsHistory: number;
      readonly customerTrustAndDelivery: number;
    };
    /** 信用区分の下限閾値（0〜100）。 */
    readonly tierThresholds: { readonly A: number; readonly B: number; readonly C: number; readonly D: number };
    /** 初回四半期（履歴なし）に使う中立スコア（0〜100）。 */
    readonly neutralInitialScore: number;
  };

  readonly borrowingCapacity: {
    /** 売掛金の担保掛目。 */
    readonly receivablesHaircut: number;
    /** 使用可能原料在庫（availableステータス）の担保掛目。 */
    readonly rawMaterialInventoryHaircut: number;
    /** 未着輸入原料（inTransitImportステータス）の担保掛目（通常在庫より低い）。 */
    readonly rawMaterialInTransitHaircut: number;
    /** 完成品在庫の担保掛目。 */
    readonly finishedGoodsInventoryHaircut: number;
    /** 直近収益力（EBITDA相当）に対する借入枠の倍率。 */
    readonly earningsMultiple: number;
    /** 信用区分別の自己資本に対する借入枠上限倍率。 */
    readonly creditTierEquityMultiple: Readonly<Record<"A" | "B" | "C" | "D" | "E", number>>;
  };

  readonly covenant: {
    /** 最低自己資本比率（自己資本 / 総資産）。 */
    readonly minEquityRatio: number;
    /** 最大負債比率（総負債 / 総資産）。 */
    readonly maxDebtToAssetsRatio: number;
    /** 最低利払能力（EBITDA相当 / 支払利息発生額）。利息が0の場合は判定対象外。 */
    readonly minInterestCoverageRatio: number;
    /** 違反時の翌期信用スコア減点（0〜100スケール）。 */
    readonly breachCreditScorePenalty: number;
    /** 違反が継続四半期数を超えると通常融資を停止する閾値。 */
    readonly consecutiveBreachFreezeThresholdQuarters: number;
  };

  readonly emergencyLoan: {
    /** 緊急融資の総年率（基準金利+信用スプレッド+緊急融資加算とは別に、上限として使う目安総年率）。 */
    readonly standardAnnualRateRange: { readonly min: number; readonly max: number };
    /** 緊急融資の上限（適格売掛金＋適格在庫の回収可能価値に対する倍率）。 */
    readonly capRatioOfCollateral: number;
    /** 緊急融資の絶対上限（USD、会社の規模に関わらない安全弁）。 */
    readonly absoluteCapUsd: number;
    /** 緊急融資の標準期間（四半期）。 */
    readonly termQuarters: number;
  };

  readonly liquidity: {
    /** 調達（国内買付）に充当してよい、利用可能流動性に対する割合（残りは賃金等の最優先支払に確保）。 */
    readonly domesticPurchaseCashAllocationRatio: number;
    /** 支払延滞が重大とみなされる、期日到来債務に対する未払割合の閾値。 */
    readonly severeArrearsRatioThreshold: number;
    /** 支払不能（paymentDefault）と判定する連続延滞四半期数の閾値。 */
    readonly paymentDefaultConsecutiveQuartersThreshold: number;
    /** 自動方針が確保しようとする最低現金バッファ（四半期の想定固定費に対する倍率）。 */
    readonly targetCashBufferMultipleOfFixedCost: number;
    /** 自動方針が任意期限前返済を検討する現金バッファの倍率（これを超える余剰があれば高金利融資を返済）。 */
    readonly voluntaryPrepaymentCashBufferMultiple: number;
  };

  /** 貸借一致・CF一致等の検証に使う許容誤差（USD）。 */
  readonly epsilonUsd: number;
}

export const FINANCING_PARAMETERS_V1: FinancingParameters = {
  parametersVersion: "financing-v0.1",

  interestRate: {
    baseRateAnnual: 0.04,
    creditSpreadAnnualByTier: { A: 0.02, B: 0.035, C: 0.05, D: 0.07, E: 0.09 },
    emergencyLoanSurchargeAnnual: 0.1,
    covenantBreachSurchargeAnnual: 0.015,
    arrearsHistorySurchargeAnnual: 0.02,
    refinanceSurchargeAnnual: 0.005,
    termLoanDurationSurchargeAnnual: 0.005,
  },

  creditScore: {
    weights: {
      cashRunway: 0.15,
      operatingCashFlow: 0.15,
      profitability: 0.15,
      interestCoverage: 0.1,
      leverage: 0.15,
      equityRatio: 0.1,
      repaymentTrackRecord: 0.1,
      arrearsHistory: 0.05,
      customerTrustAndDelivery: 0.05,
    },
    tierThresholds: { A: 80, B: 65, C: 50, D: 35 },
    neutralInitialScore: 65,
  },

  borrowingCapacity: {
    receivablesHaircut: 0.7,
    rawMaterialInventoryHaircut: 0.4,
    rawMaterialInTransitHaircut: 0.15,
    finishedGoodsInventoryHaircut: 0.3,
    earningsMultiple: 2.0,
    creditTierEquityMultiple: { A: 1.5, B: 1.1, C: 0.75, D: 0.4, E: 0 },
  },

  covenant: {
    minEquityRatio: 0.15,
    maxDebtToAssetsRatio: 0.85,
    minInterestCoverageRatio: 1.0,
    breachCreditScorePenalty: 8,
    consecutiveBreachFreezeThresholdQuarters: 2,
  },

  emergencyLoan: {
    standardAnnualRateRange: { min: 0.15, max: 0.2 },
    capRatioOfCollateral: 0.5,
    absoluteCapUsd: 30_000_000,
    termQuarters: 2,
  },

  liquidity: {
    domesticPurchaseCashAllocationRatio: 0.6,
    severeArrearsRatioThreshold: 0.5,
    paymentDefaultConsecutiveQuartersThreshold: 3,
    targetCashBufferMultipleOfFixedCost: 1.0,
    voluntaryPrepaymentCashBufferMultiple: 2.5,
  },

  epsilonUsd: 0.01,
};
