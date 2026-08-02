// ShrimpX V2 — Phase SAI-1: 標準経営AI基盤 共通型
//
// 【設計】Observationは、companyLab/types.tsのCompanyDecisionProviderが受け取る
// 3つの引数（fixture・ownState・publicInfo）だけから機械的に導出した集計値の
// スナップショットである。observation.tsのビルダー関数のシグネチャ自体が
// この3引数（+period+turn）以外を受け取れないため、Observationには構造上
// 未来のシナリオ・他社の非公開状態が一切混入しえない。
//
// 以降の圧力スコア計算（pressures.ts）・各ドメインの意思決定生成（decision/配下）は、
// 生のfixture/ownState/publicInfoではなく、このObservationだけを主入力として使う
// （必要なfixture由来の定数、例えば工場ID一覧は例外的にそのまま使う）。

import { DemandMarketId, Product } from "../../market/types";
import { PeriodV2 } from "../../core/period";
import { Score0to100 } from "../../core/units";

/**
 * 【可変であることの明示】この型はブランド型（core/units.ts）ではない、単なる
 * 商品別の集計用一時オブジェクトである。意図的にreadonlyを付けず、計算過程での
 * その場更新（result[product] += ...）を許す。最終的にCompanyDecisionInputへ
 * 変換する際は、必ずhosoEqTons()等のスマートコンストラクタを経由させる。
 */
export interface ProductAmount {
  hoso: number;
  pd: number;
  vap: number;
}

export function zeroProductAmount(): ProductAmount {
  return { hoso: 0, pd: 0, vap: 0 };
}

export function sumProductAmount(a: ProductAmount): number {
  return a.hoso + a.pd + a.vap;
}

/** 1工場ぶんの、Observation用に整形した能力・労働の現況。 */
export interface FactoryObservation {
  readonly factoryId: string;
  /** 名目能力（capex加算後、稼働率・設備利用可能率は未適用）。 */
  readonly capacityByProduct: ProductAmount;
  readonly commonProcessingCapacity: number;
  readonly freezingPackagingCapacity: number;
  /**
   * 【2026-08-02・能力認識監査Phase 3】production/capacity.tsの
   * calculateFactoryEffectiveCapacity（生産エンジン本体が実際の生産制約として使う
   * のと同じ純粋関数）を適用した実効能力（baseUtilizationRate×
   * equipmentAvailabilityRate適用後）。上のcapacityByProduct等の「名目能力」とは
   * 明確に区別する。
   */
  readonly effectiveCapacityByProduct: ProductAmount;
  readonly effectiveCommonProcessingCapacity: number;
  readonly effectiveFreezingPackagingCapacity: number;
  readonly currentRegularHeadcount: number;
  readonly skillByProduct: ProductAmount;
  readonly attendanceRate: number;
}

/**
 * 【2026-08-02・能力認識監査Phase 2新設】ベトナム国内未凍結原料市場の、前四半期の
 * 公開清算結果（数量側）。vietnamDomesticPriorPrice（価格のみ、既存）と対になる。
 * market/types.tsのVietnamDomesticResultのうち、既に画面へ公開表示されている
 * 数量系フィールドだけを転記する（新しい市場ルールは作らない。既存の
 * PublicMarketInfo.lastMarketResult.vietnamDomesticから読み出すだけ）。
 * turn1等、前四半期の市場結果が存在しない場合はundefined。
 */
export interface VietnamDomesticPriorMarketObservation {
  /** 前四半期の農家側供給量（HOSO換算トン）。 */
  readonly supply: number;
  /** 前四半期の（プロラタ最低引取ルール適用後）実効需要。 */
  readonly effectiveDemand: number;
  /** 前四半期に実際に取引が成立した数量。 */
  readonly transactedVolume: number;
  /** 前四半期、農家が売却しなかった（できなかった）潜在供給量 = supply - transactedVolume。 */
  readonly unsoldSupply: number;
}

/**
 * 【情報境界の明示】PublicMarketInfoには市場別の需要数量そのものは含まれない
 * （前期実績の価格・プレミアムのみ）。したがって市場別の優先順位は「前期実績の
 * 参照価格が高い市場を優先する」という、公開情報だけで完結する規則にする
 * （会社固有の「好みの市場リスト」は持たない＝会社IDによる分岐を避ける）。
 */
export interface MarketObservationEntry {
  readonly market: DemandMarketId;
  /** 前期実績の商品別参照価格（USD/HOSO換算kg）。前期実績が無い場合はundefined。 */
  readonly referencePriceByProduct?: ProductAmount;
}

/**
 * 標準AIが参照してよい情報の、境界を明示した整形済みスナップショット
 * （§types.tsコメント参照）。
 */
export interface StandardAiObservation {
  readonly companyId: string;
  readonly period: PeriodV2;
  readonly turn: number;

  // --- 契約・在庫 ---
  readonly outstandingContractByProduct: ProductAmount;
  readonly finishedGoodsByProduct: ProductAmount;
  readonly rawMaterialAvailable: number;
  /** 輸送中輸入・養殖中など、将来利用可能になる予定の原料量。 */
  readonly rawMaterialPipeline: number;
  /** 【SAI-6.1新設】rawMaterialPipelineの内訳: 輸送中輸入のみ（養殖中を含まない）。 */
  readonly rawMaterialInTransitImportQuantity: number;
  /** 【SAI-6.1新設】rawMaterialPipelineの内訳: 養殖中（未収穫）のみ。当期利用可能原料には含めない。 */
  readonly rawMaterialGrowingAquacultureQuantity: number;
  /** 【SAI-6.1新設】輸送中輸入のうち、availableFromPeriodが当期以前（＝当期確実に取得可能）な量。 */
  readonly rawMaterialCertainInboundThisPeriod: number;

  // --- 能力 ---
  readonly factories: readonly FactoryObservation[];
  /** 名目能力の会社合計（capex加算後）。 */
  readonly totalCapacityByProduct: ProductAmount;
  readonly totalCommonProcessingCapacity: number;
  /**
   * 【2026-08-02・能力認識監査Phase 3新設】実効能力（factories[].effective*の会社合計）。
   * production/capacity.tsのcalculateFactoryEffectiveCapacityをそのまま再利用して
   * 算出（新しい能力算出ロジックは増設していない）。生産意思決定・診断は、原則
   * こちらを「現在の実行可能な生産上限」として参照する（totalCapacityByProduct等の
   * 名目値は設備設計値の参考情報として保持するのみ）。
   */
  readonly totalEffectiveCapacityByProduct: ProductAmount;
  readonly totalEffectiveCommonProcessingCapacity: number;
  readonly totalEffectiveFreezingPackagingCapacity: number;
  readonly aquacultureCapacity: number;
  readonly salesForceHeadcountTotal: number;
  readonly procurementHeadcountTotal: number;

  // --- 前期操業実績（持続性判断のヒステリシス用シグナル） ---
  /** 前期の会社全体の設備稼働率（0〜1、未接続ならundefined＝turn1等）。 */
  readonly lastQuarterEquipmentUtilizationRate?: number;
  /** 前期の会社全体の労働稼働率。 */
  readonly lastQuarterLaborUtilizationRate?: number;
  /** 前期の会社×商品別の実績生産量。 */
  readonly lastQuarterActualProductionByProduct: Readonly<Partial<Record<Product, number>>>;

  // --- 市場（公開情報） ---
  readonly markets: readonly MarketObservationEntry[];
  /** 商品別の市場プレミアム（前期実績、VN。turn1等は未定義）。 */
  readonly marketPremiumByProduct: Readonly<{ pd?: number; vap?: number }>;
  readonly vietnamDomesticPriorPrice?: number;
  /**
   * 【2026-08-02・能力認識監査Phase 2新設】ベトナム国内未凍結原料市場の、前四半期の
   * 公開清算結果（数量側）。price（vietnamDomesticPriorPrice、既存）と対になる。
   * 既にPublicMarketInfo.lastMarketResult.vietnamDomesticとして渡ってきていた値を
   * observationへ転記するだけであり、新しい市場ルールは追加していない。
   */
  readonly vietnamDomesticPriorMarket?: VietnamDomesticPriorMarketObservation;
  /** HOSO国際基準価格（前期実績、VN）。契約時予想原価の下限目安に使う。 */
  readonly lastHosoPriceVn?: number;

  // --- 会社経済性（フィクスチャ由来） ---
  readonly productEconomics: {
    readonly expectedProcessingCostUsdPerHosoEqKg: Readonly<Record<Product, number>>;
  };

  // --- 財務・資金繰り ---
  readonly cashUsd: number;
  readonly existingLoanBalanceUsd: number;
  readonly regularHeadcountTotal: number;

  // --- 設備投資 ---
  readonly activeCapexProjectTargets: ReadonlySet<Product | "commonProcessing" | "freezingPackaging" | "coldStorage">;
  /** 【SAI-5F】資金難で中断中（suspended）の自社設備投資案件ID（projectId昇順。
   *  資金回復時のresume提案の対象）。 */
  readonly suspendedCapexProjectIds?: readonly string[];

  // --- 品質・顧客信頼・納期信頼性（自社の前四半期末までの実績。Phase 7A接続） ---
  readonly qualityScoreByProduct: Readonly<Partial<Record<Product, Score0to100>>>;
  readonly customerTrustByMarket: Readonly<Partial<Record<DemandMarketId, Score0to100>>>;
  readonly deliveryReliabilityByMarket: Readonly<Partial<Record<DemandMarketId, Score0to100>>>;

  // --- 【SAI-5D】自社の営業基盤（会社×市場×商品、前四半期末まで） ---
  /** 市場×商品の営業基盤スコア（salesBaseAccumulation有効時のみ。存在しないキーは中立50）。 */
  readonly salesBaseByMarketProduct?: Readonly<Partial<Record<DemandMarketId, Readonly<Partial<Record<Product, Score0to100>>>>>>;
  /** 【監査指摘G】当期の成約配分で実際に使われる営業基盤の競争力ウェイト（機能OFF時は0）。 */
  readonly salesBaseCompetitivenessWeight?: number;

  // --- 【SAI-5C】市場別の商品ライフサイクル公開トレンド（前四半期までの公開情報） ---
  /** 前四半期に適用された市場×商品の需要構成比（productLifecycle有効時のみ。turn1はundefined）。 */
  readonly lifecycleSharesByMarket?: Readonly<Record<DemandMarketId, Readonly<Record<Product, number>>>>;
  /** 構成比の四半期トレンド（前期−前々期。productLifecycle有効時のみ）。 */
  readonly lifecycleTrendByMarket?: Readonly<Record<DemandMarketId, Readonly<Record<Product, number>>>>;

  // --- 【SAI-5E】商品別供給圧力の公開統計（前四半期末までのEWMA） ---
  /** 5社提示量÷対象需要のEWMA（1.0=均衡、>1=供給過剰の持続。SAI-5有効時のみ）。 */
  readonly productSupplyPressureByProduct?: Readonly<Record<"pd" | "vap", number>>;
}
