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
   * 5社以外の外部選択肢（他産地供給者・非購入）の競争力ウェイト。
   * 5社の合成競争力と同じスケール（0〜1程度）で比較する。
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
}

export const SALES_PARAMETERS_V1: SalesParameters = {
  parametersVersion: "sales-v0.1",

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
