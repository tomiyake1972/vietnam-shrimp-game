// ShrimpX V2 — 財務モジュール パラメータ定義（Phase 8A、Phase 8B-2Cで既存資産の
// 減価償却方式を拡張）
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
//
// 【Phase 8B-2C】depreciationRatePerQuarter（取得原価一律2.5%/四半期）を廃止し、
// existingAssetDepreciationへ置き換えた。旧計算は「定率法」とコメントされていたが、
// 実際の計算内容（取得原価に対する一定率を毎期定額で控除する方式。純額フロアで
// 頭打ち）は定率法ではなく実質的には定額法（10年均等）だったため、ユーザー指示に
// 従い正しい実装内容（既存資産を建物・機械2区分へ簡便配分し、区分ごとの推定残存
// 耐用年数で定額償却する）へ改め、コメント上の呼称の誤りも解消した。

import { FinanceValidationError } from "./types";
import { Product } from "../market/types";

/**
 * 【ENG-FAC-1・実装指示§4】通常cash factory fixed cost（1工場・1四半期あたり）。
 * 工場固定費と固定ユーティリティの合計であり、Mothball carrying cost(25%)と
 * Sale Pending holding cost(10%)の**唯一の基準額**である。
 *
 * この関数がその基準額を持つ唯一の場所であり、"1.20M + 0.25M"を他所へ
 * 直書きしてはならない（実装指示§4「この基準額は必ず1か所へ集約」）。
 */
export function normalCashFixedFactoryCostUsdPerQuarter(params: FinanceParameters): number {
  return params.manufacturing.factoryFixedCostUsdPerQuarter + params.manufacturing.factoryUtilityFixedUsdPerQuarter;
}

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
    /**
     * 【Phase 8B-2C】ゲーム開始時点で保有している既存固定資産（capex経由の
     * 新規completed資産を除く）の減価償却方針。個別の取得履歴・取得時期が
     * 存在しないため、精密な固定資産台帳は新設せず、ゲーム開始時点の帳簿価額
     * （=各社の初期fixedAssetsGross）を建物・機械の2区分へ共通比率で簡便配分し、
     * それぞれゲーム開始時点で残っているとみなす耐用年数で定額償却する
     * 簡略モデル（finance/depreciation.tsのcomputeExistingAssetDepreciationUsd参照）。
     */
    readonly existingAssetDepreciation: {
      /** ゲーム開始時点帳簿価額のうち建物・構築物への配分比率。machineryOpeningRatioとの合計は1。 */
      readonly buildingOpeningRatio: number;
      /** ゲーム開始時点帳簿価額のうち機械・設備への配分比率。 */
      readonly machineryOpeningRatio: number;
      /** ゲーム開始時点で建物区分に残っているとみなす耐用年数（四半期数）。 */
      readonly buildingRemainingLifeQuartersAtGameStart: number;
      /** ゲーム開始時点で機械区分に残っているとみなす耐用年数（四半期数）。 */
      readonly machineryRemainingLifeQuartersAtGameStart: number;
    };
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

  /**
   * 【商品別固定費配賦・労務費区分】管理会計専用パラメータ。財務会計
   * （在庫評価・FIFOロット原価・COGS・PL/BS/CF）には一切使用しない。
   * ContributionMarginReport.byProduct[].directFixedCostの算定にのみ使う、
   * 並行した「配賦ビュー」のための係数。ゲーム開始時点で固定し、途中で
   * 変更・遡及適用しない。
   */
  readonly managementAccounting: {
    /**
     * 商品別の「加工度ウェイト付き数量」配賦係数。共通工場・設備固定費
     * （factoryFixedCost + utilityFixedCost + 既存資産減価償却費）を、
     * 各商品のadjustedTons×本係数の比で配賦するために使う（数量そのものの
     * 配賦ではなく、加工度＝設備占有・工程負荷の違いを反映するため）。
     * 既存の加工費想定単価（HOSO $0.50/PD $0.75/VAP $1.20）の比から
     * 初期値を導出（HOSOを1.0として正規化）。
     */
    readonly fixedCostAllocationCoefficientByProduct: Readonly<Record<Product, number>>;
  };
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
    existingAssetDepreciation: {
      // 実装指示の暫定値: 既存資産の35%を建物・65%を機械とみなす。
      buildingOpeningRatio: 0.35,
      machineryOpeningRatio: 0.65,
      // 建物25年（100四半期）のうち20年（80四半期）が残存、
      // 機械10年（40四半期）のうち8年（32四半期）が残存、という想定。
      buildingRemainingLifeQuartersAtGameStart: 80,
      machineryRemainingLifeQuartersAtGameStart: 32,
    },
  },

  quality: {
    downgradePriceDiscountRatio: 0.25,
  },

  epsilonUsd: 0.01,

  managementAccounting: {
    // 既存の加工費想定単価 $0.50(HOSO) / $0.75(PD) / $1.20(VAP) の比から導出
    // （HOSOを1.0に正規化: 0.75/0.50=1.5, 1.20/0.50=2.4）。
    fixedCostAllocationCoefficientByProduct: {
      hoso: 1.0,
      pd: 1.5,
      vap: 2.4,
    },
  },
};

/**
 * 【Phase 8B-2C】既存資産のbuildingOpeningRatio + machineryOpeningRatioが厳密に1に
 * なっていることを検証する（浮動小数点誤差を許容するepsilon比較）。
 * FINANCE_PARAMETERS_V1定義直後にモジュール読み込み時点で実行し、値の校正ミスを
 * 即座に検知する（capex/parameters.tsのassertValidComponentRatiosと同じ方針）。
 */
const EXISTING_ASSET_RATIO_EPSILON = 1e-9;
function assertValidExistingAssetRatios(p: FinanceParameters): void {
  const { buildingOpeningRatio, machineryOpeningRatio } = p.finance.existingAssetDepreciation;
  const sum = buildingOpeningRatio + machineryOpeningRatio;
  if (Math.abs(sum - 1) > EXISTING_ASSET_RATIO_EPSILON) {
    throw new FinanceValidationError(
      `finance/parameters.ts: existingAssetDepreciation.buildingOpeningRatio(${buildingOpeningRatio}) + machineryOpeningRatio(${machineryOpeningRatio}) が1になりません（実際の合計: ${sum}）。`
    );
  }
}
assertValidExistingAssetRatios(FINANCE_PARAMETERS_V1);

/**
 * 【商品別固定費配賦】fixedCostAllocationCoefficientByProductの全商品が正の
 * 有限数であることを検証する（0以下や非数だと配賦比率の計算がゼロ除算・
 * 負値になり得るため、モジュール読み込み時点で校正ミスを検知する）。
 */
function assertValidFixedCostAllocationCoefficients(p: FinanceParameters): void {
  const coeffs = p.managementAccounting.fixedCostAllocationCoefficientByProduct;
  for (const product of Object.keys(coeffs) as Product[]) {
    const value = coeffs[product];
    if (!Number.isFinite(value) || value <= 0) {
      throw new FinanceValidationError(
        `finance/parameters.ts: managementAccounting.fixedCostAllocationCoefficientByProduct.${product}(${value}) は正の有限数である必要があります。`
      );
    }
  }
}
assertValidFixedCostAllocationCoefficients(FINANCE_PARAMETERS_V1);
