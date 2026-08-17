// ShrimpX V2 — 長期シナリオ・イベントモジュール 共通型（Phase 2）
//
// 本モジュールは「価格を直接決定しない」。ScenarioBaseVariable の一覧に
// 価格そのもの（HOSO価格・国内原料価格・PD/VAPプレミアム）は一切含まれて
// いない。イベント・トレンドは必ず基礎変数（能力・生残率・コスト・需要指数等）
// にのみ作用し、価格は市場モジュール（app/lib/v2/market）が唯一計算する
// （実装指示 §2）。この制約は型レベルで強制している。ScenarioEffect.variable
// の型が ScenarioBaseVariable である限り、価格変数を指す効果はコンパイルが通らない。

import { PeriodV2 } from "../core/period";
import { HosoEqTons, UsdPerHosoEqKg, Ratio, Score0to100 } from "../core/units";
import { CountryId, DemandMarketId, MarketQuarterResult } from "../market/types";
import { ProductLifecycleOverrides } from "../market/productLifecycle";

export class ScenarioValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioValidationError";
  }
}

// ---------------------------------------------------------------------
// 基礎変数（イベント・トレンドが作用できる先。価格は含まない）
// ---------------------------------------------------------------------

export type ScenarioBaseVariable =
  | "COUNTRY_CAPACITY" // 国別養殖能力
  | "STOCKING_VOLUME" // 放養量
  | "UTILIZATION_RATE" // 能力稼働率
  | "PRODUCTIVITY" // 養殖生産性
  | "SURVIVAL_RATE" // 生残率
  | "DISEASE_PRESSURE" // 疾病圧力
  | "EXPORT_ELIGIBILITY_RATE" // 輸出適格率
  | "AQUACULTURE_COST" // 養殖コスト
  | "FEED_ENERGY_LABOR_COST" // 飼料・エネルギー・人件費
  | "EXPORTABLE_SUPPLY" // 国別輸出可能供給量（能力等からの導出を上書きしたい場合の直接指定用）
  | "PD_PROCESSING_CAPACITY" // PD加工能力（市場モジュールpdProcessingCapacityへ接続するため。18項目の例示リストへの拡張）
  | "VAP_PROCESSING_CAPACITY" // VAP加工能力（同上）
  | "REGIONAL_DEMAND" // 地域別潜在需要
  | "ECONOMIC_INDEX" // 景気指数
  | "CONSUMPTION_GROWTH" // 消費成長率
  | "FROZEN_INVENTORY" // 冷凍在庫
  | "LOGISTICS_CAPACITY" // 物流能力
  | "TRADE_RESTRICTION" // 貿易規制
  | "SUPPLY_RELIABILITY" // 供給信頼性
  | "QUALITY_SCORE"; // 品質評価

/** 各基礎変数がどの単位で対象を指定するか（国別／需要市場別／シナリオ全体）。 */
export type VariableScope = "country" | "market" | "global";

export const VARIABLE_SCOPE: Readonly<Record<ScenarioBaseVariable, VariableScope>> = {
  COUNTRY_CAPACITY: "country",
  STOCKING_VOLUME: "country",
  UTILIZATION_RATE: "country",
  PRODUCTIVITY: "country",
  SURVIVAL_RATE: "country",
  DISEASE_PRESSURE: "country",
  EXPORT_ELIGIBILITY_RATE: "country",
  AQUACULTURE_COST: "country",
  FEED_ENERGY_LABOR_COST: "country",
  EXPORTABLE_SUPPLY: "country",
  PD_PROCESSING_CAPACITY: "country",
  VAP_PROCESSING_CAPACITY: "country",
  SUPPLY_RELIABILITY: "country",
  QUALITY_SCORE: "country",
  LOGISTICS_CAPACITY: "country",
  TRADE_RESTRICTION: "country",
  REGIONAL_DEMAND: "market",
  ECONOMIC_INDEX: "market",
  CONSUMPTION_GROWTH: "market",
  FROZEN_INVENTORY: "global",
};

/** 変数ごとの妥当な値域（clamp・検証に使う）。undefinedは無制限（正負どちらも許容）。 */
export interface VariableDomain {
  readonly min?: number;
  readonly max?: number;
}

export const VARIABLE_DOMAIN: Readonly<Record<ScenarioBaseVariable, VariableDomain>> = {
  COUNTRY_CAPACITY: { min: 0 },
  STOCKING_VOLUME: { min: 0 },
  UTILIZATION_RATE: { min: 0, max: 1 },
  PRODUCTIVITY: { min: 0 },
  SURVIVAL_RATE: { min: 0, max: 1 },
  DISEASE_PRESSURE: { min: 0, max: 1 },
  EXPORT_ELIGIBILITY_RATE: { min: 0, max: 1 },
  AQUACULTURE_COST: { min: 0 },
  FEED_ENERGY_LABOR_COST: { min: 0 },
  EXPORTABLE_SUPPLY: { min: 0 },
  PD_PROCESSING_CAPACITY: { min: 0 },
  VAP_PROCESSING_CAPACITY: { min: 0 },
  SUPPLY_RELIABILITY: { min: 0, max: 100 },
  QUALITY_SCORE: { min: 0, max: 100 },
  LOGISTICS_CAPACITY: { min: 0, max: 1 },
  TRADE_RESTRICTION: { min: 0, max: 1 },
  REGIONAL_DEMAND: { min: 0 },
  ECONOMIC_INDEX: { min: 0 },
  CONSUMPTION_GROWTH: {},
  FROZEN_INVENTORY: { min: 0 },
};

// ---------------------------------------------------------------------
// イベント
// ---------------------------------------------------------------------

export type ScenarioEventType =
  | "DISEASE_OUTBREAK"
  | "ABNORMAL_WEATHER"
  | "FEED_COST_SHOCK"
  | "TRADE_REGULATION"
  | "LOGISTICS_DISRUPTION"
  | "DEMAND_SHOCK"
  | "FOOD_SAFETY_INCIDENT"
  | "CAPACITY_EXPANSION"
  | "CAPACITY_DELAY"
  | "ECONOMIC_BOOM"
  | "ECONOMIC_DOWNTURN";

/**
 * 効果の合成方式。
 *  - "multiplicative": magnitudeは倍率（例: 1.08 = +8%）。複数イベント重複時は倍率を掛け合わせる。
 *  - "additivePoint": magnitudeはポイント差分（例: -0.18、-6）。複数イベント重複時は差分を合算する。
 * 合成後は必ず VARIABLE_DOMAIN の範囲へclampする（詳細はeventEngine.ts）。
 */
export type EffectCompositionMode = "multiplicative" | "additivePoint";

export interface ScenarioEffect {
  readonly variable: ScenarioBaseVariable;
  readonly mode: EffectCompositionMode;
  readonly magnitude: number;
}

export interface EventVariationRange {
  /** 開始ターンのジッター幅（±ターン）。Variation modeでのみ使用。 */
  readonly startTurnJitter?: number;
  /** 効果の強さ（magnitude）のジッター比率（例: 0.2 = ±20%）。 */
  readonly magnitudeJitterRatio?: number;
  readonly durationJitterTurns?: number;
  readonly recoveryJitterTurns?: number;
}

export interface ScenarioEvent {
  readonly eventId: string;
  readonly eventType: ScenarioEventType;
  readonly targetCountries: readonly CountryId[];
  readonly targetMarkets: readonly DemandMarketId[];

  /** シナリオ内のターン番号（1始まり）。 */
  readonly startTurn: number;
  readonly durationTurns: number;
  readonly rampUpTurns: number;
  readonly recoveryTurns: number;

  /** プレイヤーには見せない、GM・実装者向けの内部説明。 */
  readonly hiddenDescription: string;
  readonly effects: readonly ScenarioEffect[];
  readonly informationReleaseIds: readonly string[];
  readonly variationRange?: EventVariationRange;
}

// ---------------------------------------------------------------------
// 長期トレンド
// ---------------------------------------------------------------------

export interface LongTermTrendKeyframe {
  /** シナリオ内のターン番号（1始まり）。 */
  readonly turn: number;
  readonly value: number;
}

export type TrendScope =
  | { readonly kind: "country"; readonly countryId: CountryId }
  | { readonly kind: "market"; readonly marketId: DemandMarketId }
  | { readonly kind: "global" };

/**
 * 補間方式。
 *  - "linear": 前後のキーフレーム間を線形補間する（段差ではなく徐々に変化）。
 *  - "step": 直前のキーフレームの値をそのまま維持し、キーフレームの瞬間だけ値が変わる。
 * 詳細な補間規則は interpolation.ts に実装し、単体テストで検証する。
 */
export type TrendInterpolation = "linear" | "step";

export interface LongTermTrend {
  readonly trendId: string;
  readonly variable: ScenarioBaseVariable;
  readonly scope: TrendScope;
  readonly interpolation: TrendInterpolation;
  /** turn昇順に2点以上。範囲外のturnは最初／最後のキーフレーム値を保持する。 */
  readonly keyframes: readonly LongTermTrendKeyframe[];
}

// ---------------------------------------------------------------------
// 情報公開
// ---------------------------------------------------------------------

export type InformationLevel = "public" | "standard" | "advanced" | "gm" | "postGame";

export interface StructuredFact {
  readonly key: string;
  readonly label: string;
  readonly value: string | number;
  readonly unit?: string;
}

export interface EstimateRange {
  readonly low: number;
  readonly high: number;
  readonly unit?: string;
}

export interface InformationRelease {
  readonly informationId: string;
  readonly relatedEventId?: string;
  /** シナリオ内のターン番号（1始まり）。このターンに到達するまでは一切返さない。 */
  readonly availableFromTurn: number;
  readonly informationLevel: InformationLevel;
  readonly headlineTemplate: string;
  /**
   * 記事本文（プレイヤーが読む業界ニュース）。
   *
   * 見出しだけでは「重要かどうか」を判断できないため、業界紙の記事として
   * 読める分量の本文を持たせる。本文には確認された事実・業界関係者の見方・
   * 現時点で不確かな点・波及の可能性を混ぜてよいが、
   * **将来のイベントの答え（何がいつどれだけ起きるか）は書かない**。
   *
   * 内部パラメータ値・シナリオ上の重要度・効果発生ターンは決して書かない
   * （それらは gm / postGameTruth レベルの管轄）。
   * 未設定の場合、画面は見出しと構造化事実だけを表示する。
   */
  readonly body?: string;
  readonly structuredFacts: readonly StructuredFact[];
  readonly estimateRange?: EstimateRange;
  /** 0〜1。省略可（不明な場合に明示しない）。 */
  readonly confidence?: number;
  readonly isRumor: boolean;
  readonly revisionOf?: string;
  /** ゲーム終了後のみ開示する真実。通常のアクセス関数からは絶対に返さない。 */
  readonly postGameTruth?: readonly StructuredFact[];
}

// ---------------------------------------------------------------------
// 前史・初期状態
// ---------------------------------------------------------------------

export interface CarriedOverEvent {
  readonly eventId: string;
  readonly description: string;
  /** Year1 Q1時点で、開始からすでに何ターン経過した状態として扱うか。 */
  readonly turnsAlreadyElapsedAtGameStart: number;
  readonly countryId: CountryId;
  readonly effects: readonly ScenarioEffect[];
  readonly rampUpTurns: number;
  readonly durationTurns: number;
  readonly recoveryTurns: number;
}

export interface ScenarioPrehistory {
  /** 2〜4年を想定。 */
  readonly lengthYears: number;
  readonly priorHosoFobPriceUsdPerKg: Readonly<Record<CountryId, number>>;
  readonly priorVietnamDomesticPriceUsdPerKg: number;
  /** 定性的な世界需要傾向のメモ（構造化データ化はPhase2のスコープ外）。 */
  readonly priorWorldDemandTrendNote: string;
  /** 過去の需要市場別（CN/US/EU/JP/OTHER）消費量。世界需要傾向の定量データ。 */
  readonly priorMarketConsumptionHosoEqTons: Readonly<Record<DemandMarketId, number>>;
  readonly countryAquacultureCostIndex: Readonly<Record<CountryId, number>>;
  readonly countrySupplyHosoEqTons: Readonly<Record<CountryId, number>>;
  readonly growingInventoryHosoEqTons: Readonly<Record<CountryId, number>>;
  readonly frozenInventoryHosoEqTons: Readonly<Record<CountryId, number>>;
  readonly farmerExpectedPriceUsdPerKg: Readonly<Record<CountryId, number>>;
  readonly carriedOverEvents: readonly CarriedOverEvent[];
}

export interface VietnamProcessingEconomics {
  /**
   * 国内原料（HOSO換算）→輸出製品（HOSO換算）の真の販売可能回収率。
   * 【Phase 6.3修正】旧フィールド名hosoYieldRatio（0.62、HLSO相当の物理歩留まり）は
   * HOSO換算価格どうしの買付上限計算に物理重量換算を混入させていたため廃止。
   * 通常操業時の基準は1.00（正常な頭・殻の除去はHOSO換算量を減らさない）。
   */
  readonly hosoEqRecoveryRatio: number;
  readonly processingExportCostUsdPerKg: number;
  readonly requiredMarginUsdPerKg: number;
}

/**
 * 養殖農家の販売留保価格の構成要素（Phase 6.3、実装指示 §4）。シナリオから
 * 変動可能な設定値。未指定時は市場モジュール既定値（MarketParameters）を使う。
 */
export interface VietnamFarmerEconomics {
  readonly farmingCostUsdPerHosoEqKg: number;
  readonly diseaseRiskAllowanceUsdPerHosoEqKg: number;
  readonly minimumFarmerMarginUsdPerHosoEqKg: number;
}

export interface ScenarioInitialStateOverrides {
  readonly vietnamProcessingEconomics: VietnamProcessingEconomics;
  /** 未指定時は市場モジュール既定値（farmerEconomicsDefaults）を使う。 */
  readonly vietnamFarmerEconomics?: VietnamFarmerEconomics;
  readonly vietnamTrailingAverageDomesticPurchaseHosoEqTons: number;
  /** PreviousMarketContextを呼び出し側がまだ持たないturn=1向けの参考初期値。 */
  readonly initialDomesticProcurementIntentHosoEqTons: number;
}

// ---------------------------------------------------------------------
// シナリオ定義
// ---------------------------------------------------------------------

export type ScenarioMode = "canonical" | "variation";

export interface ScenarioVariationSettings {
  readonly allowedModes: readonly ScenarioMode[];
  readonly defaultMode: ScenarioMode;
}

export interface ScenarioDefinition {
  readonly scenarioId: string;
  readonly version: string;
  readonly title: string;
  /** 20〜40ターン、標準32ターン。 */
  readonly durationTurns: number;

  readonly publicBackground: string;
  readonly gmDescription: string;
  readonly postGameExplanation: string;

  readonly prehistory: ScenarioPrehistory;
  readonly initialStateOverrides: ScenarioInitialStateOverrides;
  readonly longTermTrends: readonly LongTermTrend[];
  readonly scheduledEvents: readonly ScenarioEvent[];
  readonly informationReleases: readonly InformationRelease[];
  readonly variationSettings: ScenarioVariationSettings;

  /**
   * 市場×商品の需要構成比（HOSO/PD/VAPの普及曲線）の部分上書き。
   *
   * 「日本のVAPはいつ立ち上がるか」「中国のPD/VAPはいつ高付加価値化するか」
   * という**市場の長期構造**はシナリオ（世界の物語）の管轄であるという整理に
   * 基づく。未指定のシナリオは市場モジュール既定値
   * （PRODUCT_LIFECYCLE_PARAMETERS_V1）をそのまま使い、既存挙動と完全に一致する。
   *
   * 【シナリオが決めるのは構造であって結果ではない】ここで定義するのは
   * 「その市場にその商品の需要が存在する（していく）」という構造だけであり、
   * 各社が何トン売れるか・誰が高い価格を取るか・シェアがどうなるかは
   * 従来どおり市場清算と5社の競争が決める。
   */
  readonly productLifecycleOverrides?: ProductLifecycleOverrides;

  /**
   * 市場別の構造需要アンカー（opt-in）。
   *
   * 未指定時は消費国在庫モデルの従来挙動（前期の実現消費を翌期の基準にする）
   * をそのまま使う。指定した場合、翌期の消費基準を「前期実現消費」から
   * 「シナリオが定義する構造需要」へ向けて引き戻す。
   * 詳細は market/consumerInventory.ts の StructuralDemandAnchor を参照。
   */
  readonly structuralDemandAnchor?: StructuralDemandAnchorSettings;

  /**
   * このシナリオが成立するために必要なゲーム機能。
   *
   * 【なぜシナリオ側が宣言するのか】市場×商品の商品構成の時間変化は
   * 機能フラグ（CompanyLabConfig.sai5.productLifecycle）で切り替わるが、
   * Management Console の32Q実行のように呼び出し側がフラグを設定しない経路がある。
   * その場合 productLifecycleOverrides を持つシナリオでも構成比が世界一律の
   * 固定値へフォールバックし、**シナリオが定義した世界と違う世界が動いてしまう**。
   *
   * 呼び出し側ごとにフラグを設定して回ると設定漏れが必ず起きるため、
   * 「このシナリオにはこの機能が要る」という事実をシナリオ定義（＝世界の正典）に
   * 持たせ、初期化時に呼び出し側の設定へ**足りない分だけ**マージする。
   *
   * 【安全性】ここで宣言できるのは有効化（true）だけで、呼び出し側が明示的に
   * 有効化した機能を無効化することはできない。宣言を持たないシナリオは
   * マージが恒等変換になり、既存挙動と完全に一致する。
   */
  readonly requiredCapabilities?: ScenarioRequiredCapabilities;

  /**
   * 会社の初期VAP加工設備能力（HOSO換算 t/四半期）の部分上書き（opt-in）。
   *
   * 【なぜシナリオが持つか】「その世界のベトナム加工業者が、ゲーム開始時点で
   * どれだけVAP設備を持っているか」は、5社の性格ではなくその世界の産業の
   * 成熟度の話だから。VAP市場をこれから育てる世界と、既に成熟した世界とでは
   * 開始時点の設備量が違ってよい。
   *
   * 未指定のシナリオは共有フィクスチャ（companyLab/fixtures.ts）の値をそのまま
   * 使い、既存挙動と完全に一致する（baseline 等は一切変わらない）。
   *
   * 【工場の広さは変えない】上書きするのは vapCapacity だけで、
   * totalFactorySpaceUnits（建屋の広さ）は共有フィクスチャの値を保つ。
   * その結果、初期VAP設備を減らしたぶんは空きスペースになり、後から
   * VAPライン増設へ投資できる余地として残る。
   */
  readonly initialCompanyVapCapacityTons?: Readonly<Record<string, number>>;

  /**
   * ベトナムの world VAP capacity シグナルに何を使うか（opt-in）。
   *
   *  - 未指定（既定）: "plannedProduction"。5社の当期VAP生産計画の合計を
   *    CountrySupplyInput.vapProcessingCapacity へ入れる（従来挙動）。
   *  - "nominalEquipment": 5社が実際に保有するVAP設備能力の合計を入れる。
   *
   * 【なぜ選べるようにするか】プレミアム計算（market/productPremium.ts）は
   * この値を globalCapacity＝「世界の加工能力」として読み、需要/能力で稼働率を
   * 出す。生産計画は「能力」ではなく「今期どれだけ作るつもりか」なので、
   * 計画を減らすと能力が減ったことになり、稼働率が上がってプレミアムが上がる、
   * という逆向きの因果が混ざる。設備能力を入れれば、稼働率は素直に
   * 「世界の需要 ÷ 世界の設備」になる。
   *
   * 既存シナリオの挙動を変えないため、切り替えはシナリオ側の宣言に委ねる。
   */
  readonly vapCapacitySignal?: "plannedProduction" | "nominalEquipment";
}

/**
 * シナリオが成立するために有効でなければならない機能。
 * すべて optional で、true のものだけが有効化される（無効化はできない）。
 */
export interface ScenarioRequiredCapabilities {
  /** 市場×商品の商品ライフサイクル（productLifecycleOverrides を使うシナリオに必須）。 */
  readonly productLifecycle?: boolean;
  /** 供給圧力→翌期プレミアム倍率のフィードバック（商品への殺到がプレミアムを下げる経路）。 */
  readonly supplyPremiumFeedback?: boolean;
  /** 会社×市場×商品の営業基盤ストック。 */
  readonly salesBaseAccumulation?: boolean;
}

/**
 * 構造需要アンカーの設定（ScenarioDefinition.structuralDemandAnchor）。
 *
 * 【解決したい問題】消費国在庫モデルは翌期の消費基準に前期の**実現**消費を使う。
 * 供給が届かなかった四半期は実現消費が計画消費を下回るため、その差が翌期以降の
 * 市場規模そのものを恒久的に縮小させ、さらに市場別按分ウェイトを下げて供給を
 * 遠ざける、という復元力の無い正のフィードバックが生じていた
 * （baseline 32Q 実測で日本の対象需要が −99.3%）。
 *
 * 【方針】長期の市場構造はシナリオが決め、短期の需給はエンジンが揺らす。
 * 過去の供給不足を理由に、シナリオが定義した市場構造が消滅しないようにする。
 *
 * 【販売保証ではない】アンカーが守るのは「その市場に消費需要が存在すること」
 * だけである。5社がそれを取れるかどうかは、産地間の配分・外部供給者との競争・
 * 各社の競争力が従来どおり決める。
 */
export interface StructuralDemandAnchorSettings {
  /**
   * 前期実現消費を構造需要へ引き戻す強さ（0〜1）。
   *  - 0   : 従来挙動（構造需要を参照しない）
   *  - 1   : 毎期その turn の構造需要を基準にする（供給不足の記憶を持ち越さない）
   *  - 中間: 供給不足の影響が数四半期かけて減衰する
   * 在庫（openingInventoryTons）の持ち越しはこの設定に関係なく従来どおり残るため、
   * 短期の需給逼迫・在庫調整はどの値でも機能する。
   */
  readonly pullStrength: number;
}

export interface ScenarioValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

// ---------------------------------------------------------------------
// ターン入力・状態
// ---------------------------------------------------------------------

export interface ScenarioTurnCountryVariables {
  readonly countryId: CountryId;

  // --- 市場モジュールへ接続可能（marketAdapter.tsが変換する） ---
  readonly production: HosoEqTons;
  readonly exportCapacityRatio: Ratio;
  readonly aquacultureCostIndex: number;
  readonly priorAquacultureCostIndex: number;
  readonly qualityScore: Score0to100;
  readonly reliabilityScore: Score0to100;
  readonly pdProcessingCapacity: HosoEqTons;
  readonly vapProcessingCapacity: HosoEqTons;

  // --- シナリオ内部にのみ保持（現時点では市場モジュールへ未接続。§3参照） ---
  readonly survivalRate: Ratio;
  readonly diseasePressure: Ratio;
  readonly stockingVolume: HosoEqTons;
  readonly growingInventory: HosoEqTons;
  readonly frozenInventory: HosoEqTons;
  readonly farmerExpectedPriceUsdPerKg: UsdPerHosoEqKg;
  readonly logisticsCapacityRatio: Ratio;
  readonly tradeRestrictionSeverity: Ratio;
}

export interface ScenarioTurnMarketVariables {
  readonly marketId: DemandMarketId;
  readonly priorPeriodConsumption: HosoEqTons;
  readonly economicIndex: number;
  readonly populationGrowthRate: number;
}

export interface ScenarioTurnInput {
  readonly turn: number;
  readonly period: PeriodV2;
  readonly countries: Readonly<Record<CountryId, ScenarioTurnCountryVariables>>;
  readonly demandMarkets: Readonly<Record<DemandMarketId, ScenarioTurnMarketVariables>>;
  readonly vietnamDomesticRawSupply: HosoEqTons;
  readonly vietnamTrailingAverageDomesticPurchase: HosoEqTons;
  readonly vietnamProcessingEconomics: VietnamProcessingEconomics;
  /** シナリオが指定した場合のみ設定される（未指定時は市場モジュール既定値）。 */
  readonly vietnamFarmerEconomics?: VietnamFarmerEconomics;
  readonly pdVapDemand: { readonly pdDemand: HosoEqTons; readonly vapDemand: HosoEqTons };
  /** このターンに何らかの強度（0超）で影響しているイベントのID一覧。 */
  readonly activeEventIds: readonly string[];
}

// ---------------------------------------------------------------------
// 市場アダプター
// ---------------------------------------------------------------------

export interface PreviousMarketContext {
  readonly priorHosoFobPrice: Readonly<Record<CountryId, UsdPerHosoEqKg>>;
  /** 会社側からの入力（業界集計値）。市場価格形成モジュールPhase1と同じ簡略化。 */
  readonly domesticProcurementIntent: HosoEqTons;
}

// ---------------------------------------------------------------------
// フィードバック
// ---------------------------------------------------------------------

export interface ExternalProducerResponse {
  readonly countryId: CountryId;
  /** 将来の放養量調整倍率（今回は記録のみ。計算へは未接続。§11参照）。 */
  readonly stockingAdjustmentRatio: number;
  readonly rationale: string;
}

export interface ScenarioTurnFeedback {
  readonly realizedMarketResult?: MarketQuarterResult;
  readonly externalProducerResponses?: readonly ExternalProducerResponse[];
}

// ---------------------------------------------------------------------
// シナリオ状態
// ---------------------------------------------------------------------

export interface ResolvedScenarioEvent {
  readonly source: ScenarioEvent;
  readonly resolvedStartTurn: number;
  readonly resolvedDurationTurns: number;
  readonly resolvedRampUpTurns: number;
  readonly resolvedRecoveryTurns: number;
  /** 1.0 = 定義どおりの強さ。Variation modeでのみ1.0から揺らぐ。 */
  readonly resolvedMagnitudeScale: number;
}

export interface ScenarioTurnRecord {
  readonly turn: number;
  readonly feedback?: ScenarioTurnFeedback;
}

export interface ScenarioState {
  readonly definition: ScenarioDefinition;
  readonly mode: ScenarioMode;
  readonly randomSeed: string;
  /** 1始まり。durationTurnsを超えることはない。 */
  readonly currentTurn: number;
  readonly resolvedEvents: readonly ResolvedScenarioEvent[];
  readonly turnHistory: readonly ScenarioTurnRecord[];
}
