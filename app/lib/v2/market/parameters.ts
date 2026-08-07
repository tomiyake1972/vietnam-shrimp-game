// ShrimpX V2 — 市場・価格形成モジュール パラメータ定義（Phase 1）
//
// 市場価格形成モジュール仕様書 v0.2 に記載された2015年時点の基準値・暫定係数を
// この1ファイルへ集約する。計算ロジック（hosoPricing.ts等）にマジックナンバーを
// 直接書かず、必ずこのファイルの MarketParameters 経由で参照すること。
//
// 各値には出典（仕様書の章番号）と状態（「確定」「仮置き」「Phase1新規・要校正」）を
// コメントで明記する。「仮置き」「要校正」は仕様書自身がそう位置づけている値、
// 「Phase1新規・要校正」は仕様書に数値の記載がなく、本実装のために暫定的に
// 置いた値である（仕様書 表紙「文書状態: 設計仮説。実装前に試算・感度分析・
// 実データ照合を行う」という前提を踏襲し、確定値として扱わない）。

import { CountryId } from "./types";

export interface MarketParameters {
  /** このパラメータセット自体のバージョン（balanceVersionとは別軸で管理）。 */
  readonly parametersVersion: string;

  // --- §4.1 国際HOSO FOB初期値（仮置き・実データ取得後に再校正） ---
  readonly initialHosoFobPriceUsdPerKg: Readonly<Record<CountryId, number>>;

  // --- §5.2 養殖コストカーブの層構成比（仮置き）。Phase1では入力側の
  //     aquacultureCostIndexが既に集計値であることを前提とし、この層構成比
  //     自体は現時点では参照専用（将来、国別コストカーブを内製する際に使用）。
  readonly costTierComposition: {
    readonly low: number;
    readonly mid: number;
    readonly high: number;
  };

  // --- §6.2 農家の期待原料価格ウェイト（仮置き）。Phase1の国内原料価格計算
  //     では単純化のため直近期のみを参照しており未使用。将来の期待形成
  //     モデル拡張のために値だけ保持する。
  readonly expectedPriceWeights: {
    readonly current: number;
    readonly prior: number;
    readonly twoPriorsAgo: number;
  };

  // --- §9.2 簡易国際連動式（プロトタイプ用と仕様書に明記。Phase1ではこの
  //     簡易式を採用し、数量ベースの完全な市場清算（§9.1）は将来移行する）。
  readonly worldInfluenceWeight: Readonly<Record<CountryId, number>>;
  /** R_i = localWeight * L_i + worldWeight * G の localWeight（=0.60）。 */
  readonly localPressureWeight: number;
  /** 同上の worldWeight（=0.40）。 */
  readonly worldPressureWeight: number;

  // --- §9.3 価格制約。仕様書は「シナリオ別に設定」「未設定」とするのみで
  //     数値の指定がないため、Phase1新規・要校正の暫定値を置く。
  /** 四半期あたりのHOSO価格変化率の上限・下限（絶対値）。仮置き±20%。 */
  readonly maxQuarterlyPriceChangeRatio: number;
  /** 価格が非正にならないための絶対下限（USD/HOSO換算kg）。仮置き。 */
  readonly priceFloorUsdPerKg: number;

  // --- 【Phase 6.3新規（実装指示 §8）】国際HOSO価格の自己修正機構。
  //     Phase 6.2診断で、baselineでもIN・ID・VNのHOSO価格が絶対下限($0.50)へ
  //     張り付く問題を確認した。原因は次の2点:
  //       (1) 需要配分が固定シェア（worldInfluenceWeight）のため、供給シェアとの
  //           不一致（EC需要45%対供給27%等）が恒常的な国別需給不均衡として残る。
  //       (2) 価格式が「不均衡の水準」を「価格変化率」に直結する積分器構造のため、
  //           恒常的な不均衡が毎四半期価格を削り続け、下限まで発散する。
  //     価格式全体は書き直さず、次の最小限の修正で対応する:
  //       (a) 需要配分を前期価格に応答させる（安い原産国へ需要が移る自己修正）
  //       (b) コスト連動の長期アンカー価格への平均回帰項を変化率へ加算する
  //           （恒常不均衡は有限の価格ディスカウントに収束し、下限へ発散しない）
  //       (c) 国別価格をグローバル基準価格（需要ウェイト平均）に対する有限の差へ
  //           クランプする（同品質の国際商品の価格が長期間極端に乖離しない）
  readonly hosoPriceSelfCorrection: {
    /**
     * 需要配分の価格応答感度。share_i ∝ weight_i × exp(-感度 × 相対価格乖離)。
     * 0で従来の固定シェア配分。
     */
    readonly demandReallocationPriceSensitivity: number;
    /**
     * 長期アンカー価格（initialHosoFobPrice × 養殖コスト指数）への平均回帰率
     * （四半期あたり）。恒常的な需給圧力Pに対する定常価格乖離は P/回帰率 に収束する。
     */
    readonly meanReversionRate: number;
    /** 国別価格のグローバル基準価格（需要ウェイト平均）からの最大乖離比率。 */
    readonly maxCountryDeviationRatioFromReference: number;
  };

  // --- L_i（国別需給圧力）の合成ウェイト。仕様書は「供給ショックは数量を
  //     介して価格へ影響し、価格への直接加算は例外扱い」（§9.3・§17不変条件）
  //     とするため、需給不均衡を主要因（重い側）、養殖コスト変化を副次要因
  //     （軽い側）として合成する。Phase1新規・要校正の暫定配分。
  readonly supplyDemandPressureWeight: number;
  readonly costPressureWeight: number;

  // --- §12 決定論的な小さな市場ショック。Phase1新規・要校正の暫定振幅。
  /** ショックは [-shockMagnitude, +shockMagnitude] の一様乱数（変化率への加算）。 */
  readonly marketShockMagnitude: number;

  // --- §10.1（全体実装計画書 v0.1）プロラタ最低引取ルール。
  /** 過去4Q平均買付量に対する最低引取比率（=20%、確定値として仕様書に明記）。 */
  readonly minimumOfftakeRatio: number;

  // --- ベトナム国内原料価格の需給調整式（Phase1新規・要校正。Phase 6.3で
  //     農家留保価格・数量調整を追加）。
  readonly vietnamDomestic: {
    /** 需給が均衡している時の乗数（買付上限に対する比率）。 */
    readonly baseMultiplier: number;
    /** 供給過不足1単位あたりの乗数感応度。 */
    readonly demandSensitivity: number;
    /** 乗数の下限（供給過剰時でも買付上限の何%までは支払う想定か）。 */
    readonly floorMultiplier: number;
    /** 需給不均衡比率のクランプ範囲（ゼロ割り近傍の暴発を防ぐ）。 */
    readonly imbalanceClamp: number;
    /**
     * 国内原料価格の絶対下限（USD/HOSO換算kg）。
     * 【Phase 6.3】数値エラー防止用のバックストップとしてのみ残す。通常の
     * 市場計算で到達する経済的下限には使用しない（経済的下限は
     * farmerEconomicsDefaults由来の農家留保価格が担う）。
     */
    readonly absolutePriceFloorUsdPerKg: number;
    /**
     * 養殖農家の販売留保価格の既定構成要素（Phase 6.3、実装指示 §4。
     * VietnamDomesticInput.farmerEconomicsで上書き可能。すべて要校正の暫定値）。
     * farmerReservationPrice = farmingCost + diseaseRiskAllowance + minimumFarmerMargin。
     */
    readonly farmerEconomicsDefaults: {
      readonly farmingCostUsdPerHosoEqKg: number;
      readonly diseaseRiskAllowanceUsdPerHosoEqKg: number;
      readonly minimumFarmerMarginUsdPerHosoEqKg: number;
    };
    /**
     * 買付上限が農家留保価格を下回る局面での取引数量縮小（数量調整。Phase 6.3）。
     * tradeRatio = clamp(1 - severity × severitySensitivity, minTradeRatio, 1)
     * （severity = (reservation - ceiling) / reservation）。
     */
    readonly quantityRationing: {
      readonly severitySensitivity: number;
      readonly minTradeRatio: number;
    };
  };

  // --- PD/VAPプレミアム（Phase1新規・要校正）。
  //     仕様書・全体実装計画書のいずれにも具体的な金額水準の記載がないため、
  //     HOSO価格に対する比率として暫定的に設定する（原価連動性を確保するため）。
  readonly pdVapPremium: {
    /** PDのベースプレミアム比率（世界稼働率が基準値のときの上乗せ率）。 */
    readonly pdBasePremiumRatio: number;
    /** VAPのベースプレミアム比率。 */
    readonly vapBasePremiumRatio: number;
    /** 「基準」とみなす世界稼働率（需要/能力）。 */
    readonly referenceUtilization: number;
    /** 稼働率が基準から1単位ずれた時のプレミアム倍率感応度。 */
    readonly utilizationSensitivity: number;
    /** プレミアム倍率の下限・上限。 */
    readonly utilizationMultiplierFloor: number;
    readonly utilizationMultiplierCap: number;
    /** 品質スコアの「中立」基準値（Score0to100のうちこの値を上回る分だけ加点）。 */
    readonly referenceQualityScore: number;
    /** 品質スコア100点分がHOSO価格の何%の加算になるかの感応度。 */
    readonly qualityPremiumSensitivity: number;
    /** プレミアムの絶対下限（USD/HOSO換算kg。非正化を防ぐ）。 */
    readonly minPremiumUsdPerKg: number;
  };

  // --- 理由コード発火の閾値（Phase1新規・要校正）。
  readonly driverThresholds: {
    /** |imbalance| がこの値を超えたら供給不足/過剰の理由コードを付与。 */
    readonly supplyDemandImbalance: number;
    /** 稼働率がこの値を超えたら能力逼迫、下回ったら能力過剰の理由コードを付与。 */
    readonly capacityTightUtilization: number;
    readonly capacityLooseUtilization: number;
    /** コスト指数の変化率がこの値を超えたらコスト要因の理由コードを付与。 */
    readonly costChangeRatio: number;
    /** 需要側成長率がこの値を超えたら需要要因の理由コードを付与。 */
    readonly demandGrowthRatio: number;
    /** エクアドル・インドの合算PD能力シェアがこの値を超えたら
     *  ECUADOR_PD_CAPACITY_EXPANSION の理由コードを付与。 */
    readonly ecuadorIndiaPdShareTightness: number;
  };
}

/**
 * 2015年基準（市場価格形成モジュール仕様書 v0.2 表紙・§4.1・§16）のPhase1
 * パラメータセット。将来の係数変更はこのオブジェクトの新バージョンとして追加し、
 * 旧バージョンは削除しない（全体実装計画書 v0.1 §20「balanceVersionを更新し、
 * 旧版を削除しない」に準じる）。
 */
export const MARKET_PARAMETERS_V1: MarketParameters = {
  parametersVersion: "market-params-2015-baseline-v0.1",

  initialHosoFobPriceUsdPerKg: {
    EC: 4.7,
    IN: 5.25,
    ID: 5.45,
    VN: 5.6,
  },

  costTierComposition: { low: 0.25, mid: 0.5, high: 0.25 },

  expectedPriceWeights: { current: 0.5, prior: 0.3, twoPriorsAgo: 0.2 },

  worldInfluenceWeight: { EC: 0.45, IN: 0.25, VN: 0.18, ID: 0.12 },
  localPressureWeight: 0.6,
  worldPressureWeight: 0.4,

  maxQuarterlyPriceChangeRatio: 0.2,
  priceFloorUsdPerKg: 0.5,

  // Phase 6.3新規・要校正: baselineの恒常的な供給過剰（世界供給1.8M対需要1.2M
  // トン/四半期）の下でも、価格がアンカー比 -30〜-40%程度の有限なディスカウントへ
  // 収束し、絶対下限に張り付かない水準として設定した暫定値。
  hosoPriceSelfCorrection: {
    demandReallocationPriceSensitivity: 2.0,
    meanReversionRate: 0.8,
    maxCountryDeviationRatioFromReference: 0.35,
  },

  supplyDemandPressureWeight: 0.7,
  costPressureWeight: 0.3,

  marketShockMagnitude: 0.02,

  minimumOfftakeRatio: 0.2,

  vietnamDomestic: {
    // Phase 6.3再校正: 買付上限式から物理歩留まり0.62を除去したことに伴い、
    // 需給均衡時の乗数を再設定（暫定値・要校正）。
    baseMultiplier: 0.92,
    demandSensitivity: 0.35,
    floorMultiplier: 0.4,
    imbalanceClamp: 3,
    // Phase 6.3: 数値エラー防止用バックストップのみ（経済的下限は農家留保価格）。
    absolutePriceFloorUsdPerKg: 0.05,
    // Phase 6.3新規・要校正: ベトナムのバナメイ養殖の実務水準を念頭に置いた
    // 暫定値。合計の留保価格は 1.90 + 0.15 + 0.20 = 2.25 USD/HOSO換算kg となり、
    // 通常シナリオで国内原料価格が$1/kgを下回る領域を経済的に成立しない領域として
    // 排除しつつ、通常時の需給価格（2.4〜3.0程度）が留保価格の上に位置して
    // 買付希望量の増減が価格へ反映される余地を残す（Phase 8校正で再検討）。
    farmerEconomicsDefaults: {
      farmingCostUsdPerHosoEqKg: 1.9,
      diseaseRiskAllowanceUsdPerHosoEqKg: 0.15,
      minimumFarmerMarginUsdPerHosoEqKg: 0.2,
    },
    // Phase 6.3新規・要校正: 買付上限が留保価格を10%下回ると取引量が2割減る程度の
    // 暫定感応度。
    quantityRationing: {
      severitySensitivity: 2.0,
      minTradeRatio: 0.0,
    },
  },

  pdVapPremium: {
    pdBasePremiumRatio: 0.18,
    vapBasePremiumRatio: 0.55,
    referenceUtilization: 0.85,
    utilizationSensitivity: 0.8,
    utilizationMultiplierFloor: 0.5,
    utilizationMultiplierCap: 1.8,
    referenceQualityScore: 50,
    qualityPremiumSensitivity: 0.3,
    minPremiumUsdPerKg: 0.05,
  },

  driverThresholds: {
    supplyDemandImbalance: 0.03,
    capacityTightUtilization: 1.0,
    capacityLooseUtilization: 0.75,
    costChangeRatio: 0.02,
    demandGrowthRatio: 0.02,
    ecuadorIndiaPdShareTightness: 0.4,
  },
};
