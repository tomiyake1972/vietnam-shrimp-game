// ShrimpX V2 — 財務モジュール パラメータ定義（Phase 8A）
//
// production/quality/salesの各parameters.tsと同じ方針で、計算ロジックに
// マジックナンバーを直接書かず、すべての係数をこの1ファイルへ集約する。
// すべて「Phase 8A新規・要校正」の暫定値であり、Phase 8B/8Cの経済校正で
// 再検討する前提とする。
//
// 【スケールの根拠（暫定）】baseline/canonical 8ターンの実測（5社の四半期売上高
// $28M〜$76M、正社員4,500〜9,000人、生産6,000〜16,000トン/四半期、原料消費単価
// $2.9〜3.2/kg、販売単価$4.0〜5.8/kg）に対し、Minh Phu型企業の目安（原料費が
// 売上原価の60〜70%、営業利益率一桁%台）へ収まるよう設定した。
// ベトナム加工業の給与水準（工場ワーカー月給$250〜400相当＋社会保険等）を
// 四半期換算した値を基礎とする。

export interface FinanceParameters {
  readonly parametersVersion: string;

  readonly labor: {
    /** 正社員（工場直接労務）1人あたり四半期給与（USD、社会保険等込み）。段階固定費。 */
    readonly regularWorkerSalaryUsdPerQuarter: number;
    /** 臨時ワーカー1人あたり四半期費用（USD）。変動費。 */
    readonly temporaryWorkerCostUsdPerQuarter: number;
    /** 残業割増係数（残業費 = 正社員給与 × 適用残業率 × 本係数）。変動費。 */
    readonly overtimePremiumFactor: number;
  };

  readonly manufacturing: {
    /**
     * 再加工1トンあたりの追加加工費（USD/トン）。変動費。数量は失われず、
     * 追加費用のみ当期原価へ加算する（Phase 7Aの再加工数量に対応）。
     */
    readonly reworkCostUsdPerTon: number;
    /** 工場1拠点あたりの四半期固定費（賃借・保全・工場管理。USD）。段階固定費（工場数ドライバー）。 */
    readonly factoryFixedCostUsdPerQuarter: number;
    /** 工場ユーティリティ等（その他の製造間接費）の固定部分（USD/工場/四半期）。混合費の固定部分。 */
    readonly factoryUtilityFixedUsdPerQuarter: number;
    /** 工場ユーティリティ等の変動部分（USD/生産トン）。混合費の変動部分。 */
    readonly factoryUtilityVariableUsdPerTon: number;
  };

  readonly sellingGeneralAdmin: {
    /** 営業人員1人あたり四半期費用（USD、出張・販促込み）。段階固定費。 */
    readonly salesForceSalaryUsdPerQuarter: number;
    /** 調達人員1人あたり四半期費用（USD）。段階固定費。 */
    readonly procurementSalaryUsdPerQuarter: number;
    /** 一般管理固定費（本社管理・システム等。USD/四半期/会社）。固定費。 */
    readonly adminFixedUsdPerQuarter: number;
    /** 変動販売物流費（輸出物流・冷凍輸送等。USD/販売トン）。変動費。 */
    readonly sellingLogisticsUsdPerTon: number;
  };

  readonly workingCapital: {
    /**
     * 売掛金の回収サイト（四半期数）。市場別に設定可能な構造とし、Phase 8Aでは
     * 全市場共通1四半期（履行の翌四半期に回収）とする。四半期単位のゲームのため、
     * 日数ではなく決済四半期数へ決定論的に変換して保持する。
     */
    readonly arCollectionQuarters: number;
    /** 輸入原料の買掛金支払サイト（四半期数。発注時に計上し、この四半期数後に支払う）。 */
    readonly apImportPaymentQuarters: number;
    /**
     * 国内原料の支払サイト（四半期数）。ベトナムの養殖農家への支払は即金性が高い
     * 実務を反映し0（当四半期に現金払い）とする。
     */
    readonly apDomesticPaymentQuarters: number;
  };

  readonly finance: {
    /** 短期借入金の四半期利率。 */
    readonly shortTermInterestRatePerQuarter: number;
    /** 長期借入金の四半期利率。 */
    readonly longTermInterestRatePerQuarter: number;
    /** 法人税率（ベトナムCIT 20%を暫定採用。税引前利益が正の場合のみ課税、繰越欠損金はPhase 8B以降）。 */
    readonly incomeTaxRate: number;
    /** 固定資産の四半期減価償却率（取得原価に対する定額法。年10%相当）。 */
    readonly depreciationRatePerQuarter: number;
  };

  readonly quality: {
    /**
     * 格落ち品の販売時値引率（0〜1）。格落ち数量は販売可能数量を減らさず、
     * 販売時に「契約単価×本比率」の売上控除として認識する。
     */
    readonly downgradePriceDiscountRatio: number;
  };

  /** 貸借一致・CF一致等の検証に使う許容誤差（USD）。 */
  readonly epsilonUsd: number;
}

export const FINANCE_PARAMETERS_V1: FinanceParameters = {
  parametersVersion: "finance-v0.1",

  labor: {
    regularWorkerSalaryUsdPerQuarter: 1000,
    temporaryWorkerCostUsdPerQuarter: 800,
    overtimePremiumFactor: 1.5,
  },

  manufacturing: {
    reworkCostUsdPerTon: 200,
    factoryFixedCostUsdPerQuarter: 1_200_000,
    factoryUtilityFixedUsdPerQuarter: 250_000,
    factoryUtilityVariableUsdPerTon: 25,
  },

  sellingGeneralAdmin: {
    salesForceSalaryUsdPerQuarter: 8_000,
    procurementSalaryUsdPerQuarter: 7_000,
    adminFixedUsdPerQuarter: 800_000,
    sellingLogisticsUsdPerTon: 100,
  },

  workingCapital: {
    arCollectionQuarters: 1,
    apImportPaymentQuarters: 1,
    apDomesticPaymentQuarters: 0,
  },

  finance: {
    shortTermInterestRatePerQuarter: 0.022,
    longTermInterestRatePerQuarter: 0.018,
    incomeTaxRate: 0.2,
    depreciationRatePerQuarter: 0.025,
  },

  quality: {
    downgradePriceDiscountRatio: 0.25,
  },

  epsilonUsd: 0.01,
};
