// ShrimpX V2 — 販売計画・営業人員・成約・約定残モジュール パラメータ定義（Phase 4）
//
// 市場価格形成モジュール（app/lib/v2/market/parameters.ts）と同じ方針で、
// 計算ロジックにマジックナンバーを直接書かず、すべての係数をこの1ファイルへ
// 集約する。すべて「Phase4新規・要校正」の暫定値であり、ゲームバランス調整
// フェーズで再検討する前提とする（ChatGPT側の指示に数値そのものの指定はないため、
// 要求された「効果の方向性」（例: 逓減する、価格が高いほど不利になる）を満たす
// 最小限の暫定値として置く）。

import { Score0to100, score0to100 } from "../core/units";
import { Product } from "../market/types";
import type { SalesCapacityModel } from "./salesCapacityModel";
import { SALES_CAPACITY_MODEL_COMPANY_ORGANIZATION_V1, SALES_CAPACITY_MODEL_PER_MARKET } from "./salesCapacityModel";

// ---------------------------------------------------------------------
// 【ENG-TIERED-MKT-1】三層顧客＋全社同時配分（opt-in）
// ---------------------------------------------------------------------

/**
 * 市場×商品の成約配分アルゴリズムの選択。
 *
 *   legacyWaterfall              … 現行の水位法（sales/allocation.ts）。**未指定時の既定**。
 *   tieredSimultaneousAllocation … 三層顧客ごとに5社＋外部選択肢を同一分母へ入れて
 *                                  一度に配分する新方式（sales/tieredAllocation.ts）。
 *
 * SalesParameters.marketAllocationMode が undefined のときは必ず legacyWaterfall として
 * 扱う。既定パラメータ（SALES_PARAMETERS_V1 とその派生）はこの値を持たないため、
 * 既存 Scenario・既存呼び出し元の挙動はビット単位で不変。
 */
export type MarketAllocationMode = "legacyWaterfall" | "tieredSimultaneousAllocation";

/** 顧客層。demandShare の合計は必ず 1.0。 */
export type CustomerTierId = "PRICE_SENSITIVE" | "STANDARD" | "PREMIUM";

export const CUSTOMER_TIER_IDS: readonly CustomerTierId[] = ["PRICE_SENSITIVE", "STANDARD", "PREMIUM"];

/**
 * 1つの顧客層のパラメータ。
 *
 * 【重要・値の位置づけ】ShrimpX の Phase 0 仕様・既存 parameter・既存 doc のいずれにも
 * 三層顧客モデルの確定係数は存在しない。したがって本ファイルが提供する数値は
 * **検証fixture専用**（TIERED_MARKET_ALLOCATION_PARAMETERS_FIXTURE_V0）であり、
 * production default へ昇格させていない（SALES_PARAMETERS_V1 はこの設定を持たない）。
 */
export interface CustomerTierParameters {
  /** この層が market×product の対象需要に占める比率（3層合計 = 1.0）。 */
  readonly demandShare: number;
  /** 価格乖離（参照価格比）に対する効用の感応度。大きいほど値上げで急速に離れる。 */
  readonly priceSensitivity: number;
  /** 品質評価に対する感応度。 */
  readonly qualitySensitivity: number;
  /** 差別化（VAP能力等）に対する感応度。 */
  readonly differentiationSensitivity: number;
  /**
   * その他の非価格要素（顧客関係・納期信頼性・営業基盤）に対する感応度（集約値）。
   *
   * 【TIERED-MKT-P1D】三要素を個別に持てるようになったため、この値は
   * relationshipSensitivity / deliverySensitivity / salesBaseSensitivity が
   * **いずれも指定されていない項目に対する fallback**（それぞれ nonPriceSensitivity/3）
   * として使われる。旧 tiered parameter（この項目しか持たない）との後方互換のために
   * 残しており、数学的には旧式 nonPriceSensitivity × (平均 − 0.5) と完全に一致する。
   */
  readonly nonPriceSensitivity: number;
  /**
   * 顧客関係（customerRelationship）に対する感応度。
   * 【TIERED-MKT-P1D】未指定なら nonPriceSensitivity / 3（旧式と一致）。
   */
  readonly relationshipSensitivity?: number;
  /**
   * 納期信頼性（deliveryReliability）に対する感応度。
   * 【TIERED-MKT-P1D】未指定なら nonPriceSensitivity / 3（旧式と一致）。
   */
  readonly deliverySensitivity?: number;
  /**
   * 営業基盤（salesBaseScore）に対する感応度。
   * 【TIERED-MKT-P1D】未指定なら nonPriceSensitivity / 3（旧式と一致）。
   */
  readonly salesBaseSensitivity?: number;
  /** 留保価格 = referencePrice × この倍率。層が高いほど高い価格まで許容する。 */
  readonly reservationPriceMultiplier: number;
  /** 留保価格超過に対する連続的なペナルティの傾き（超過比の2乗に掛ける）。 */
  readonly reservationSoftPenaltySlope: number;
  /**
   * 外部選択肢の基準効用。
   *
   * 【TIERED-MKT-P1D・正式定義】外部選択肢は「ゲームに登場しない他のベトナム企業＋
   * 購買見送り」であり、**他産地（Ecuador / India / Indonesia 等）の供給者は含まない**。
   * 他産地との競争は targetDemand 算出前の産地間配分で決着済み。
   */
  readonly externalOptionBaseUtility: number;
}

/** market×product 単位の上書き（部分指定可）。 */
export interface TieredMarketAllocationOverride {
  readonly market: string;
  readonly product: Product;
  readonly tiers: Partial<Record<CustomerTierId, Partial<CustomerTierParameters>>>;
}

export interface TieredMarketAllocationParameters {
  readonly parametersVersion: string;
  readonly tiers: Readonly<Record<CustomerTierId, CustomerTierParameters>>;
  /** market×product 単位の上書き（例: CNは価格感応度高め、JP/EUは品質・差別化高め）。 */
  readonly overrides?: readonly TieredMarketAllocationOverride[];
  /**
   * 効用のclamp幅（±）。**経済的なfloorではなく、softmaxのoverflow防止のみが目的**。
   * 新方式では minimumPriceCompetitiveness のような下限は使用しない。
   */
  readonly utilityClamp: number;
}

export interface SalesParameters {
  readonly parametersVersion: string;

  // --- 営業人員 → 市場カバレッジ（0〜1、逓減曲線） ---
  // coverageScore(headcount) = baseline + (1 - baseline) * headcount / (headcount + saturation)
  // headcount=0 でも baseline 分だけ既存顧客による最低限の成約力を残す。
  readonly salesForce: {
    /** headcount=0 のときのカバレッジ（既存顧客による最低限の成約力）。 */
    readonly baselineCoverageAtZeroHeadcount: number;
    /** カバレッジ逓減曲線の半飽和点（この人数でbaselineと1の中間に到達）。 */
    readonly coverageSaturationHeadcount: number;
    /** headcount=0 のときの処理能力（HOSO換算トン、既存顧客分）。 */
    readonly baselineCapacityTons: number;
    /**
     * 処理能力逓減曲線の漸近的な増分上限（HOSO換算トン）。
     *
     * 【Test15事前校正】4800→24000へ変更。capacitySaturationHeadcountとは必ず
     * 対で調整すること（下記参照）。
     */
    readonly capacityMaxIncrementTons: number;
    /**
     * 処理能力逓減曲線の半飽和点（この人数で増分上限の半分に到達）。
     *
     * 【Test15事前校正】10→70へ変更（capacityMaxIncrementTons 4800→24000 と対）。
     *
     * 【変更理由】旧値（k=10, M=4800）では、会社が実際に運用する人数帯
     * （市場あたり2〜20人）が既に曲線の飽和域に入っており、営業人員を増やしても
     * 処理能力がほとんど伸びなかった（限界生産性が h=19 で 57t/人まで低下）。
     * このため「営業を20人増員しても成約が約2,000tしか増えない」という、
     * 営業投資の判断がゲームとして成立しない状態になっていた（Test14で観測）。
     *
     * 【なぜkとMを対で動かすのか】C(h) = base + M·h/(h+k) の原点付近の傾き
     * （＝営業1人あたりの限界成約力）は M/k で決まる。kだけを外へ動かすと
     * 曲線は「線形に近く」なるが同時に全域で沈み、傾きが 480→68.6 t/人へ
     * 落ちて増員の見返りはかえって小さくなる（回帰テストで実測: +20人の
     * 成約増が +2,236t → +663t へ悪化し、設備稼働率も3%まで低下した）。
     * kを運用人数帯の外側へ動かしつつ M も対で引き上げることで、実運用域
     * （0〜40人）では概ね線形な応答＝増員が素直に報われる形になる。
     *
     * 【M=24000の選定根拠】M を上げるほど増員の見返りは大きくなるが、成約量に
     * 比例して運転資金（原料買付）も増えるため、上げすぎると会社が現金不足に陥る。
     * M=33600では BAL の現金が枯渇し、設備投資案件が16四半期かけても完成しなく
     * なった（capexIntegrationの受入確認テストが失敗）。M=24000は、現行の
     * 成約絶対水準をほぼ維持したまま（BAL turn2: 4,329t → 4,290t）増員の
     * 見返りだけを改善する水準として実測で選定した（+20人の成約増:
     * +2,236t → +3,159t、設備稼働率 38.1% → 44.4%）。
     *
     * 【青天井にならないこと】曲線の形状（Michaelis-Menten型の凹関数）は
     * 変えていないため、漸近上限 baselineCapacityTons + capacityMaxIncrementTons
     * は有限のまま（=24,200t/市場）で、逓減も維持される。
     */
    readonly capacitySaturationHeadcount: number;
  };

  /**
   * 【SAI-2追加作業: 市場別営業配置・商品別営業工数】商品区分ごとの営業工数係数。
   * 「営業工数換算数量 = HOSO数量 + PD係数×PD数量 + VAP係数×VAP数量」という
   * 実装指示の式に使う。価格・加工難易度ではなく、顧客獲得・商品説明・サンプル
   * 対応・仕様調整・契約管理等の「営業側の対応工数」を表す設計値。
   * 【暫定値・確定値】三宅さんのご指示によりHOSO=1.0・PD=1.2・VAP=3.0で確定
   * （PDはHOSOに近く、VAPだけが大幅に営業負荷が高い、という設計意図）。
   */
  readonly salesEffortCoefficients: Readonly<Record<Product, number>>;

  /**
   * 【Phase 6B・比較用】営業能力モデル。
   * 未指定なら現行の "perMarket"（市場ごとに飽和曲線を独立適用）と完全に同一。
   * 正式モデルはまだ決めていない（#04 §16）。
   */
  readonly salesCapacityModel?: SalesCapacityModel;

  // --- 成約競争力の合成ウェイト（合計1.0を推奨） ---
  readonly competitivenessWeights: {
    readonly price: number;
    readonly coverage: number;
    readonly relationship: number;
    readonly quality: number;
    readonly deliveryReliability: number;
    /** 【SAI-5D】営業基盤（会社×市場×商品の蓄積ストック、companyLab/salesBase.ts）
     *  のウェイト。既定0（＝寄与が厳密に0でビット単位の後方互換）。有効化時は
     *  SALES_PARAMETERS_SAI5_SALES_BASE_V1（合計1.0を保ってcoverage/relationship/
     *  qualityから切り出して再配分）をturnInput.parameters.sales経由で渡す。 */
    readonly salesBase: number;
    /** 【Test15新設】VAP能力合成係数（companyLab/premiumPolicy.tsの
     *  calculateCompanyCapabilityCoefficient、VAP商品開発スコア等の合成）の
     *  ウェイト。既定0（＝寄与が厳密に0でビット単位の後方互換）。product==="vap"の
     *  entryにのみ効く設計（allocation.ts参照。HOSO/PDのentryでは常に寄与0）。 */
    readonly vapCapability: number;
  };

  /**
   * 価格競争力の感度係数。priceScore = exp(-priceSensitivity * (askPrice - basePrice) / basePrice)。
   * 大きいほど「基準価格からの乖離」が競争力に与える影響が強くなる。
   */
  readonly priceSensitivity: number;
  /**
   * priceScoreの結果（下限・上限）。安値による過剰受注（値下げすればするほど際限なく
   * 成約力が伸びる「抜け道」）を防ぐため、priceScoreをこの範囲にclampしてから
   * maximumPriceCompetitivenessで割って[0,1]程度へ正規化する。
   * 【暫定値・要校正】priceSensitivity=3.0のとき、約10%値下げでpriceScore≈1.35、
   * 約20%を超える値下げで概ね上限（1.6）に到達する設計。ゲームバランス調整
   * フェーズで再検討する前提とする。
   */
  readonly minimumPriceCompetitiveness: number;
  /** priceScoreの上限。【暫定値・要校正】 */
  readonly maximumPriceCompetitiveness: number;

  /**
   * 市場×商品区分×四半期ごとに、1社が対象需要から成約できる最大比率（0〜1）。
   * 「安値提示＋大量の営業人員＋大量の販売希望量」を同時に満たしても、1社が
   * 対象需要を独占できないようにするための上限。
   * 【暫定値・要校正】現段階では固定値だが、将来的に顧客関係・供給実績・
   * 納期信頼性に応じて会社別に変化させられる構造にする想定（現段階では未実装、
   * allocation.tsのmaximumSupplierShareFor()が将来の拡張ポイント）。
   */
  readonly maximumSupplierShare: number;

  /**
   * 5社以外の外部選択肢の競争力ウェイト。
   * 5社の合成競争力と同じスケール（0〜1程度）で比較する。
   *
   * 【TIERED-MKT-P1D・正式定義】外部選択肢＝「ゲームに登場しない他のベトナム企業へ
   * 流れる需要＋購買を見送る需要」。**他産地供給者は含まない**（他産地との競争は
   * targetDemand 算出前の産地間配分で決着済み）。
   */
  readonly externalOptionWeight: number;

  /** 顧客関係・品質・納期信頼性が未接続の場合に使う中立値（0〜100スケール）。 */
  readonly neutralScore: Score0to100;

  /** 標準リードタイム（ターン数）。希望リードタイム未指定時に使用。仕様上、成約の翌四半期。 */
  readonly standardLeadTimeTurns: number;

  // --- 提示価格の入力検証 ---
  /** askPrice が basePrice のこの比率を下回ったら異常値としてエラー。 */
  readonly minAskPriceRatioOfBase: number;
  /** askPrice が basePrice のこの比率を上回ったら異常値としてエラー。 */
  readonly maxAskPriceRatioOfBase: number;

  /**
   * 【ENG-TIERED-MKT-1】成約配分アルゴリズムの選択。**未指定は legacyWaterfall**。
   * 既定パラメータはこの値を持たないため、既存挙動はビット単位で不変。
   */
  readonly marketAllocationMode?: MarketAllocationMode;
  /**
   * 【ENG-TIERED-MKT-1】三層顧客モデルのパラメータ。
   * marketAllocationMode === "tieredSimultaneousAllocation" のときのみ参照する。
   * 未指定でこのmodeを選ぶと SalesValidationError（推測の既定値を作らない）。
   */
  readonly tieredMarketAllocation?: TieredMarketAllocationParameters;
}

export const SALES_PARAMETERS_V1: SalesParameters = {
  parametersVersion: "sales-v0.2",

  salesForce: {
    baselineCoverageAtZeroHeadcount: 0.15,
    coverageSaturationHeadcount: 6,
    baselineCapacityTons: 200,
    capacityMaxIncrementTons: 24000,
    capacitySaturationHeadcount: 70,
  },

  salesEffortCoefficients: {
    hoso: 1.0,
    pd: 1.2,
    vap: 3.0,
  },

  competitivenessWeights: {
    price: 0.35,
    coverage: 0.25,
    relationship: 0.15,
    quality: 0.15,
    deliveryReliability: 0.1,
    salesBase: 0,
    vapCapability: 0,
  },

  priceSensitivity: 3.0,
  minimumPriceCompetitiveness: 0.5,
  maximumPriceCompetitiveness: 1.6,

  maximumSupplierShare: 0.35,

  externalOptionWeight: 0.35,

  neutralScore: score0to100(50),

  standardLeadTimeTurns: 1,

  minAskPriceRatioOfBase: 0.5,
  maxAskPriceRatioOfBase: 2.0,

  /**
   * 【Test16 正式営業能力モデル（2026-08-10 切替・#05 Phase 6C §2）】
   * 会社営業組織モデル v1。ベンチマーク呼称 "Case B + V1"。
   * 定義・採用理由・能力関数の実測値は sales/salesCapacityModel.ts に記載する。
   *
   * 切替前は undefined（＝市場別モデル）だった。旧挙動が必要な場合は
   * SALES_PARAMETERS_LEGACY_PER_MARKET を使う（下記）。
   */
  salesCapacityModel: SALES_CAPACITY_MODEL_COMPANY_ORGANIZATION_V1,
};

/**
 * 【後方互換・比較対照】Phase 6C 以前の Test16 既定（市場別営業能力モデル）。
 *
 * 正式モデルの切替による差分を測るため、および旧挙動での再現が必要な調査のために
 * 残す。**新しい既定ではない**（production default は SALES_PARAMETERS_V1）。
 */
export const SALES_PARAMETERS_LEGACY_PER_MARKET: SalesParameters = {
  ...SALES_PARAMETERS_V1,
  parametersVersion: "sales-v0.1-legacy-per-market",
  salesCapacityModel: SALES_CAPACITY_MODEL_PER_MARKET,
};

/**
 * 【SAI-5D】営業基盤ウェイト有効化版。salesBase=0.08を、coverage(0.25→0.21)・
 * relationship(0.15→0.13)・quality(0.15→0.13)から切り出して合計1.0を維持する
 * （価格・納期の重みは不変）。
 *
 * 【切り出し元の設計判断】営業基盤は「顧客接点・販路の蓄積」であり、意味的に
 * 最も近いcoverage（当期の営業人員フロー）とrelationship（履行体験の蓄積）から
 * 主に切り出す（同種のシグナルの合計影響力を増やさない＝三重計上の抑制）。
 * 合計を1.0に保つのは、外部オプション（externalOptionWeight=0.35）との相対
 * バランスを変えないため（合計が増えると5社の成約量が構造的に増えてしまう）。
 */
export const SALES_PARAMETERS_SAI5_SALES_BASE_V1: SalesParameters = {
  ...SALES_PARAMETERS_V1,
  parametersVersion: "sales-v0.1+sai5-sales-base",
  competitivenessWeights: {
    price: 0.35,
    coverage: 0.21,
    relationship: 0.13,
    quality: 0.13,
    deliveryReliability: 0.1,
    salesBase: 0.08,
    vapCapability: 0,
  },
};

/**
 * 【Test15新設】VAP能力ウェイト有効化版（テスト・将来のconfig接続用の参考実装）。
 * vapCapability=0.08を、coverage(0.25→0.21)・relationship(0.15→0.13)・
 * quality(0.15→0.13)から切り出して合計1.0を維持する（SAI-5Dのsalesbase版と
 * 同じ切り出し方針）。product!=="vap"のentryには構造的に影響しない
 * （allocation.ts参照）ため、HOSO/PDの配分結果はこのパラメータでも不変。
 * 【Test15暫定値・要校正】
 */
export const SALES_PARAMETERS_TEST15_VAP_CAPABILITY_V1: SalesParameters = {
  ...SALES_PARAMETERS_V1,
  parametersVersion: "sales-v0.1+test15-vap-capability",
  competitivenessWeights: {
    price: 0.35,
    coverage: 0.21,
    relationship: 0.13,
    quality: 0.13,
    deliveryReliability: 0.1,
    salesBase: 0,
    vapCapability: 0.08,
  },
};

/**
 * 【Test15新設・コーディネーター指示による既定ON対応】vapProductDevelopmentCompetitiveness
 * （既定ON）とsalesBaseAccumulation（既定OFF、明示opt-in）の両方が有効なときに使う
 * 組み合わせ版。salesBase=0.08・vapCapability=0.08の両方をcoverage/relationship/
 * qualityから切り出す（各項目につき上のSAI-5D版・Test15単独版の切り出し幅を
 * 単純に2倍し、合計1.0を維持する）。
 * 【Test15暫定値・要校正】
 */
export const SALES_PARAMETERS_TEST15_VAP_CAPABILITY_AND_SALES_BASE_V1: SalesParameters = {
  ...SALES_PARAMETERS_V1,
  parametersVersion: "sales-v0.1+test15-vap-capability+sai5-sales-base",
  competitivenessWeights: {
    price: 0.35,
    coverage: 0.17,
    relationship: 0.11,
    quality: 0.11,
    deliveryReliability: 0.1,
    salesBase: 0.08,
    vapCapability: 0.08,
  },
};

/**
 * 【ENG-TIERED-MKT-1・検証fixture専用】三層顧客モデルのパラメータ。
 *
 * **production default ではない。** ShrimpX の Phase 0 仕様・既存 parameter・既存 doc に
 * 三層顧客モデルの確定係数は存在しないため、ここでは「単調性と構造を検証するための
 * 暫定係数」であることを明示する。SALES_PARAMETERS_V1 はこの設定を持たず、
 * marketAllocationMode も持たないため、この値がゲーム本体へ影響することはない。
 * 正式係数が決まるまで、この定数を既定パラメータへ組み込んではならない。
 *
 * 層の設計意図（値そのものは未確定）:
 *   PRICE_SENSITIVE … 価格感応度が最も高く、留保価格は参照価格に近い。
 *   STANDARD        … 価格・非価格がおおむね均衡。
 *   PREMIUM         … 品質・差別化の感応度が高く、留保価格倍率も高い。
 */
export const TIERED_MARKET_ALLOCATION_PARAMETERS_FIXTURE_V0: TieredMarketAllocationParameters = {
  parametersVersion: "tiered-market-allocation-fixture-v0（検証専用・production defaultではない）",
  tiers: {
    PRICE_SENSITIVE: {
      demandShare: 0.4,
      priceSensitivity: 14,
      qualitySensitivity: 0.6,
      differentiationSensitivity: 0.2,
      nonPriceSensitivity: 0.4,
      reservationPriceMultiplier: 1.05,
      reservationSoftPenaltySlope: 60,
      externalOptionBaseUtility: 0.2,
    },
    STANDARD: {
      demandShare: 0.4,
      priceSensitivity: 8,
      qualitySensitivity: 1.2,
      differentiationSensitivity: 0.8,
      nonPriceSensitivity: 0.8,
      reservationPriceMultiplier: 1.15,
      reservationSoftPenaltySlope: 40,
      externalOptionBaseUtility: 0.2,
    },
    PREMIUM: {
      demandShare: 0.2,
      priceSensitivity: 4,
      qualitySensitivity: 2.4,
      differentiationSensitivity: 2.0,
      nonPriceSensitivity: 1.2,
      reservationPriceMultiplier: 1.35,
      reservationSoftPenaltySlope: 25,
      externalOptionBaseUtility: 0.2,
    },
  },
  utilityClamp: 60,
};

/**
 * 【ENG-TIERED-MKT-1・検証fixture専用】新方式を有効化した SalesParameters。
 * 既存の SALES_PARAMETERS_V1 をそのまま継承し、modeとtier設定だけを足す。
 * **Scenario・production default へは接続していない。**
 */
export const SALES_PARAMETERS_TIERED_FIXTURE_V0: SalesParameters = {
  ...SALES_PARAMETERS_V1,
  parametersVersion: "sales-v0.2+tiered-market-allocation-fixture-v0",
  marketAllocationMode: "tieredSimultaneousAllocation",
  tieredMarketAllocation: TIERED_MARKET_ALLOCATION_PARAMETERS_FIXTURE_V0,
};

// ---------------------------------------------------------------------
// 【TIERED-MKT-P1D】V2.00 三層顧客モデル 正式候補パラメータ（B-moderated-v1）
// ---------------------------------------------------------------------
//
// 【位置づけ】これは「V2.00 プレイテスト用の正式候補」であり、検証fixture
// （..._FIXTURE_V0）とは別物として定義する。ただし **production default では
// まだない**: SALES_PARAMETERS_V1 / SAI5_SALES_BASE_V1 / TEST15_* のいずれも
// marketAllocationMode を持たないため、DS1 / DS2 / DS3 の既定挙動には一切影響しない。
// 起動経路は CompanyLabConfig.salesParamsOverride と診断fixtureのみ。
//
// 【32Q試験・手動プレイ後に再校正可能なparameterとして置く】最終固定値ではない。

/**
 * 外部選択肢の基準効用（V2.00候補）。
 *
 * 【正式定義】外部選択肢＝「Phase 1 の産地間配分後にベトナムへ割り当てられた需要のうち、
 * ゲームに登場しない他のベトナム企業へ流れる需要＋購買を見送る需要」。
 * 他産地（Ecuador / India / Indonesia 等）の供給者は含まない。
 *
 * 【1.6 の位置づけ】V2.00 プレイテスト用の暫定値であり最終固定値ではない。
 * 32Q試験・手動プレイ後に再校正する前提で、名前付き定数としてここに置く
 * （allocation 本体へマジックナンバーとして書かない）。
 */
export const EXTERNAL_OPTION_BASE_UTILITY_V200_CANDIDATE_V1 = 1.6;

/**
 * US / EU の VAP に適用する qualitySensitivity 補正係数（V2.00候補）。
 * 基準層パラメータの qualitySensitivity へ乗算する（オーバーライドは
 * resolveTierParameters が market×product 単位で適用する）。
 */
export const US_EU_VAP_QUALITY_SENSITIVITY_FACTOR_V200_CANDIDATE_V1 = 0.6;

/**
 * 【TIERED-MKT-P1D-2】market×product 15セルの顧客層 demandShare
 * （Phase 1B calibrated candidate、#04 が回収・確定して支給した値）。
 *
 * 順序は [PRICE_SENSITIVE, STANDARD, PREMIUM]、各セル合計 = 1.00。
 *
 * 【位置づけ】**V2.00 calibrated candidate であり最終固定値ではない。**
 * 32Q試験・手動プレイの結果を見て再校正する前提の値。
 * この表は tiered 正式候補（SALES_PARAMETERS_TIERED_V200_CANDIDATE_V1）でのみ
 * 使われ、DS1 / DS2 / DS3 の既定 SalesParameters は marketAllocationMode を
 * 持たないため一切影響を受けない。
 *
 * 【全15セルを明示する理由】base tiers の demandShare へ「代表値」を置いて
 * 一部セルだけ override する形にすると、どのセルが校正済みでどのセルが
 * 既定値のままか読み取れなくなる。ここでは 5市場×3商品すべてを表として持ち、
 * resolveTierParameters の override で全セルを上書きする
 * （base の demandShare は構造上どのセルからも参照されない）。
 */
const TIER_DEMAND_SHARES_V200_CANDIDATE_V1: Readonly<Record<string, Readonly<Record<Product, readonly [number, number, number]>>>> = {
  CN: {
    hoso: [0.55, 0.35, 0.1],
    pd: [0.6, 0.3, 0.1],
    vap: [0.45, 0.4, 0.15],
  },
  JP: {
    hoso: [0.1, 0.45, 0.45],
    pd: [0.15, 0.45, 0.4],
    vap: [0.1, 0.4, 0.5],
  },
  US: {
    hoso: [0.5, 0.4, 0.1],
    pd: [0.35, 0.45, 0.2],
    vap: [0.15, 0.45, 0.4],
  },
  EU: {
    hoso: [0.15, 0.5, 0.35],
    pd: [0.2, 0.45, 0.35],
    vap: [0.15, 0.4, 0.45],
  },
  OTHER: {
    hoso: [0.45, 0.42, 0.13],
    pd: [0.35, 0.45, 0.2],
    vap: [0.25, 0.45, 0.3],
  },
};

/**
 * base tiers に置く demandShare のプレースホルダ。
 * 上の 15セル表が全 market×product を override するため、実際の配分計算では
 * 参照されない（tieredMarketCandidateV1.test.ts の 15セルテストで固定）。
 * それでも型上は必須項目のため、合計 1.0 の中立値を置く。
 */
const TIER_DEMAND_SHARE_BASE_PLACEHOLDER_V200_CANDIDATE_V1 = {
  PRICE_SENSITIVE: 0.4,
  STANDARD: 0.4,
  PREMIUM: 0.2,
} as const;

/**
 * 層別 qualitySensitivity の基準値（FIXTURE_V0 から引き継ぎ）。
 * US/EU VAP の 0.60 倍 override をこの値から生成するため、数値を二重管理しない。
 */
const TIER_QUALITY_SENSITIVITY_V200_CANDIDATE_V1 = {
  PRICE_SENSITIVE: 0.6,
  STANDARD: 1.2,
  PREMIUM: 2.4,
} as const;

/**
 * 【TIERED-MKT-P1D-3】market×product 別 qualitySensitivity の校正係数
 * （anchor calibration factor）。
 *
 * 【何を表すか】「qualityReputation の差を顧客がどの程度 価格 premium として
 * 評価するか」の強さ。品質設備 direct bonus（full ramp +4 point）は変更せず、
 * その +4 point が生む price-equivalent premium を目標水準へ寄せるために、
 * qualitySensitivity 側だけを market×product 単位で調整する。
 *
 * 【掛け算の順序（重要）】解決後の qualitySensitivity は
 *   base qualitySensitivity
 *     × US/EU VAP factor（US・EU の VAP のみ 0.60。それ以外は 1.0）
 *     × anchor calibration factor（この表。未掲載セルは 1.0）
 * とする。既存の US/EU VAP factor 0.60 を消したり吸収したりしない
 * （US/EU VAP は 0.60 適用後の値へさらにこの係数が掛かる）。
 *
 * 【位置づけ】**V2.00 calibrated candidate であり最終固定値ではない。**
 * 今回は 4 つの anchor cell（CN/HOSO, JP/VAP, US/VAP, EU/VAP）だけを校正し、
 * 残り 11 セルは 1.0（＝未校正）のまま監査対象として残す。
 * 目標 price-equivalent premium（quality +4 point 時）:
 *   CN HOSO 約 +0.10 / JP VAP 約 +0.80 / US VAP 約 +0.40 / EU VAP 約 +0.40 USD/kg
 */
export const QUALITY_SENSITIVITY_CALIBRATION_V200_CANDIDATE_V1: Readonly<
  Record<string, Readonly<Partial<Record<Product, number>>>>
> = {
  CN: { hoso: 2.5 },
  JP: { vap: 3.9 },
  US: { vap: 4.2 },
  EU: { vap: 3.8 },
};

/** 未掲載セルの anchor calibration factor（＝未校正）。 */
export const QUALITY_SENSITIVITY_CALIBRATION_DEFAULT_V200_CANDIDATE_V1 = 1;

/**
 * market×product の anchor calibration factor を引く。
 * 表に無いセルは 1.0（未校正）。
 */
export function qualitySensitivityCalibrationFactorFor(market: string, product: Product): number {
  return QUALITY_SENSITIVITY_CALIBRATION_V200_CANDIDATE_V1[market]?.[product] ?? QUALITY_SENSITIVITY_CALIBRATION_DEFAULT_V200_CANDIDATE_V1;
}

/**
 * 【TIERED-MKT-P1D】V2.00 三層顧客モデル 正式候補（B-moderated-v1）。
 *
 * 指示で明示された値:
 *   priceSensitivity          … PRICE_SENSITIVE 6.5 / STANDARD 3.5 / PREMIUM 1.7
 *   differentiationSensitivity… PRICE_SENSITIVE 0.3 / STANDARD 1.4 / PREMIUM 4.0
 *   externalOptionBaseUtility … 全層 1.6
 *   US / EU の VAP            … qualitySensitivity × 0.60
 *
 * 指示で明示されていない項目（qualitySensitivity 基準値・nonPrice 系・
 * reservation 系・utilityClamp・demandShare）は、**新しい値を作らず**
 * TIERED_MARKET_ALLOCATION_PARAMETERS_FIXTURE_V0 の値をそのまま引き継ぐ。
 */
export const TIERED_MARKET_ALLOCATION_PARAMETERS_V200_CANDIDATE_V1: TieredMarketAllocationParameters = {
  parametersVersion: "tiered-market-allocation-v200-candidate-v1（B-moderated-v1・プレイテスト用暫定値）",
  tiers: {
    PRICE_SENSITIVE: {
      demandShare: TIER_DEMAND_SHARE_BASE_PLACEHOLDER_V200_CANDIDATE_V1.PRICE_SENSITIVE,
      priceSensitivity: 6.5,
      qualitySensitivity: TIER_QUALITY_SENSITIVITY_V200_CANDIDATE_V1.PRICE_SENSITIVE,
      differentiationSensitivity: 0.3,
      nonPriceSensitivity: 0.4,
      reservationPriceMultiplier: 1.05,
      reservationSoftPenaltySlope: 60,
      externalOptionBaseUtility: EXTERNAL_OPTION_BASE_UTILITY_V200_CANDIDATE_V1,
    },
    STANDARD: {
      demandShare: TIER_DEMAND_SHARE_BASE_PLACEHOLDER_V200_CANDIDATE_V1.STANDARD,
      priceSensitivity: 3.5,
      qualitySensitivity: TIER_QUALITY_SENSITIVITY_V200_CANDIDATE_V1.STANDARD,
      differentiationSensitivity: 1.4,
      nonPriceSensitivity: 0.8,
      reservationPriceMultiplier: 1.15,
      reservationSoftPenaltySlope: 40,
      externalOptionBaseUtility: EXTERNAL_OPTION_BASE_UTILITY_V200_CANDIDATE_V1,
    },
    PREMIUM: {
      demandShare: TIER_DEMAND_SHARE_BASE_PLACEHOLDER_V200_CANDIDATE_V1.PREMIUM,
      priceSensitivity: 1.7,
      qualitySensitivity: TIER_QUALITY_SENSITIVITY_V200_CANDIDATE_V1.PREMIUM,
      differentiationSensitivity: 4.0,
      nonPriceSensitivity: 1.2,
      reservationPriceMultiplier: 1.35,
      reservationSoftPenaltySlope: 25,
      externalOptionBaseUtility: EXTERNAL_OPTION_BASE_UTILITY_V200_CANDIDATE_V1,
    },
  },
  utilityClamp: 60,
  // 【TIERED-MKT-P1D-2】15セルすべてに demandShare の override を張る。
  // 併せて US / EU の VAP だけ qualitySensitivity を 0.60 倍する（基準値へ係数を
  // 掛けて生成し、係数と基準値の関係が崩れないようにする＝数値を二重管理しない）。
  overrides: Object.entries(TIER_DEMAND_SHARES_V200_CANDIDATE_V1).flatMap(([market, byProduct]) =>
    (Object.entries(byProduct) as Array<[Product, readonly [number, number, number]]>).map(([product, shares]) => {
      // 【TIERED-MKT-P1D-3】US/EU VAP factor（0.60）と anchor calibration factor は
      // どちらも base qualitySensitivity へ「掛ける」。0.60 を anchor 側へ吸収しない。
      const usEuVapFactor =
        (market === "US" || market === "EU") && product === "vap" ? US_EU_VAP_QUALITY_SENSITIVITY_FACTOR_V200_CANDIDATE_V1 : 1;
      const qualityFactor = usEuVapFactor * qualitySensitivityCalibrationFactorFor(market, product);
      return {
        market,
        product,
        tiers: {
          PRICE_SENSITIVE: {
            demandShare: shares[0],
            qualitySensitivity: TIER_QUALITY_SENSITIVITY_V200_CANDIDATE_V1.PRICE_SENSITIVE * qualityFactor,
          },
          STANDARD: {
            demandShare: shares[1],
            qualitySensitivity: TIER_QUALITY_SENSITIVITY_V200_CANDIDATE_V1.STANDARD * qualityFactor,
          },
          PREMIUM: {
            demandShare: shares[2],
            qualitySensitivity: TIER_QUALITY_SENSITIVITY_V200_CANDIDATE_V1.PREMIUM * qualityFactor,
          },
        },
      };
    })
  ),
};

/**
 * 【TIERED-MKT-P1D】V2.00 三層顧客モデル 正式候補を有効化した SalesParameters。
 * SALES_PARAMETERS_TEST15_VAP_CAPABILITY_V1（現行 baseline / DS2 の解決値）を継承し、
 * mode と tier 設定だけを足す。**Scenario・production default へは接続していない。**
 * 起動は salesParamsOverride または診断fixtureからのみ。
 */
export const SALES_PARAMETERS_TIERED_V200_CANDIDATE_V1: SalesParameters = {
  ...SALES_PARAMETERS_TEST15_VAP_CAPABILITY_V1,
  parametersVersion: "sales-v0.2+tiered-market-allocation-v200-candidate-v1",
  marketAllocationMode: "tieredSimultaneousAllocation",
  tieredMarketAllocation: TIERED_MARKET_ALLOCATION_PARAMETERS_V200_CANDIDATE_V1,
};
