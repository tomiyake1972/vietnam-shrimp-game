// ShrimpX V2 — Phase 8D-1/8D-2 投資計画の共通forecast/view-model
//
// 【この層の目的（実装指示 Phase 8D-1）】
//   設備投資・Worker・工場スペース・生産能力・投資採算のすべての数字を、
//   **同じ計算基盤から**取得できるようにする。画面・Excel・診断出力が、
//   それぞれ独自の計算を持たない状態にする。
//
// 【「画面では処理可能と出たのに、ターンを実行すると処理できない」を防ぐ方法】
//   処理見込みは、UI用の簡易計算ではなく、**生産エンジンの純粋関数
//   allocateProductionPlans をそのまま呼んで得る**（processingForecastViewModel.ts の
//   buildCompanyProcessingForecast 経由）。投資完成後の見込みも同じで、
//   「能力を増やした仮のFactory」を作って同じ関数へもう一度渡すだけであり、
//   増加ぶんを見積もる別の式は存在しない。
//
// 【禁止事項】
//   - 能力・労働・スペース・保管の計算式をこのファイルで再実装しない。
//     いずれも app/lib/v2/ 配下の純粋関数を呼ぶ。
//   - 根拠のない収益増加・事故率低下・品質向上・販売増加を仮定しない。
//     算定できない値は数値を作らず、理由つきで「算定対象外」として返す。
//   - エンジンに未接続の効果を、実装済みの効果として並べない
//     （implementedEffects と notImplementedEffects を必ず分けて返す）。

import { PeriodV2 } from "../../lib/v2/core/period";
import { hosoEqTons, unwrapUnit } from "../../lib/v2/core/units";
import { Product } from "../../lib/v2/market/types";
import { CompanyId } from "../../lib/v2/sales/types";
import { RawMaterialLot } from "../../lib/v2/rawMaterials/types";
import { CompanyProductionPlanEntry, Factory, FinishedGoodsLot, WorkerAssignment } from "../../lib/v2/production/types";
import { PRODUCTION_PARAMETERS_V1 } from "../../lib/v2/production/parameters";
import { calculateLaborCapacityFromAssignedHeadcount } from "../../lib/v2/production/labor";
import {
  buildCompanyColdStorageState,
  CompanyColdStorageState,
  COLD_STORAGE_ENGINE_CONNECTION_NOTE,
  FREEZING_VS_STORAGE_EXPLANATION_TEXT,
} from "../../lib/v2/production/coldStorage";
import {
  CompanyFactorySpaceState,
  FACTORY_SPACE_PARAMETERS_V1,
  SpaceConsumingPoolKey,
} from "../../lib/v2/production/factorySpace";
import { CapexParameters, CAPEX_PARAMETERS_V1, CapexState, CapitalProjectType, CAPITAL_PROJECT_TYPES } from "../../lib/v2/capex";
import { computeCapacityEffectForCompany } from "../../lib/v2/capex/capacityEffect";
import { computeEffectiveFactories } from "../../lib/v2/capex/factoryConstruction";
import type { FactoryLifecycleStateTable } from "../../lib/v2/capex/factoryLifecycle";
import { buildCompanyFactorySpaceState, computeCandidateProjectSpaceUnits } from "../../lib/v2/capex/factorySpace";
import { CompanyFinancialQuarterResult } from "../../lib/v2/finance/types";
import { FINANCE_PARAMETERS_V1 } from "../../lib/v2/finance/parameters";
import {
  computeIncrementalRegularHires,
  computeQuarterlyLaborCost,
  computeRequiredRegularHeadcount,
  CompanyWorkforceState,
  QuarterlyLaborCostBreakdown,
  WORKFORCE_NOT_MODELED_NOTE,
} from "../../lib/v2/companyLab/workforce";
import { buildCapexCandidateViewModel, CapexCandidateViewModel, TARGET_PRODUCT_LABELS } from "./capexViewModel";
import { buildCompanyProcessingForecast, CompanyProcessingForecast } from "./processingForecastViewModel";

// ---------------------------------------------------------------------
// 1. 実装済み効果／未実装効果の開示（Phase 8D-6）
// ---------------------------------------------------------------------

/**
 * 案件種別ごとの「エンジンへ接続済みの効果」と「未接続の効果」。
 *
 * 【この表を手で書いている理由】
 *   接続の有無はコード経路そのものであり、値として取り出せる場所が無い。
 *   そのため調査結果を1箇所へ明文化し、画面・Excelがここだけを見るようにする。
 *   調査根拠は docs/phase8d_completion_report_2026-07-26.md §品質設備・環境設備 に
 *   ファイル・行番号つきで記載している。
 */
export interface ProjectEffectDisclosure {
  readonly implementedEffects: readonly string[];
  readonly notImplementedEffects: readonly string[];
  /** 未実装効果がある場合に画面へ必ず出す注記（無ければundefined）。 */
  readonly notImplementedNote?: string;
}

const CAPACITY_EFFECT_COMMON: readonly string[] = [
  "稼働開始四半期からの生産能力の増加（生産エンジンの上限として実際に働く）",
  "取得原価の固定資産振替と、建物・機械コンポーネント別の減価償却",
  "稼働開始後の四半期固定保守費",
  "工場スペースの占有",
];

const NOT_CONNECTED_NOTE =
  "現在は設備資産・投資案件としてのみ実装されています。以下の効果は、現時点ではエンジンへ未接続です（投資しても数値は変わりません）。";

export const PROJECT_EFFECT_DISCLOSURES: Readonly<Record<CapitalProjectType, ProjectEffectDisclosure>> = {
  hosoLineExpansion: { implementedEffects: CAPACITY_EFFECT_COMMON, notImplementedEffects: [] },
  pdLineExpansion: { implementedEffects: CAPACITY_EFFECT_COMMON, notImplementedEffects: [] },
  vapLineExpansion: { implementedEffects: CAPACITY_EFFECT_COMMON, notImplementedEffects: [] },
  commonProcessingExpansion: { implementedEffects: CAPACITY_EFFECT_COMMON, notImplementedEffects: [] },
  freezingPackagingExpansion: { implementedEffects: CAPACITY_EFFECT_COMMON, notImplementedEffects: [] },
  coldStorageExpansion: {
    implementedEffects: [
      "冷凍・冷蔵保管能力（同時に保管できる在庫量）の増加",
      "取得原価の固定資産振替と、建物・機械コンポーネント別の減価償却",
      "稼働開始後の四半期固定保守費",
      "工場スペースの占有",
    ],
    notImplementedEffects: [
      "保管能力を超えた場合の入庫拒否・期末在庫の自動廃棄・外部倉庫への振替・強制販売",
      "四半期あたりの凍結・包装処理量（＝生産量の上限）の増加（これは「凍結・包装処理能力増設」の効果です）",
    ],
    notImplementedNote: COLD_STORAGE_ENGINE_CONNECTION_NOTE,
  },
  qualityControlEquipment: {
    implementedEffects: [
      "取得原価の固定資産振替と、機械コンポーネントの減価償却",
      "稼働開始後の四半期固定保守費",
      "工場スペースの占有",
    ],
    notImplementedEffects: [
      "格落ち率の低下",
      "再加工率の低下",
      "廃棄率の低下",
      "重大品質事故率の低下",
      "品質スコア・顧客信頼の向上",
      "品質検査関連指標の改善",
    ],
    notImplementedNote:
      NOT_CONNECTED_NOTE +
      "品質エンジンの入力は、設備の有無ではなく操業リスク（稼働ストレス・残業・臨時工比率・商品構成の複雑さ・原料滞留・立ち上がり）だけで決まります。" +
      "したがって現時点でこの投資は、減価償却費と保守費というコストだけが発生し、操業上の便益はありません。",
  },
  environmentalEquipment: {
    implementedEffects: [
      "取得原価の固定資産振替と、建物・機械コンポーネント別の減価償却",
      "稼働開始後の四半期固定保守費",
      "工場スペースの占有",
    ],
    notImplementedEffects: [
      "排水処理能力という状態量そのもの（エンジンに概念が存在しません）",
      "環境事故の発生率",
      "行政処分・罰金",
      "環境監査・規制遵守の判定",
      "生産計画に対する排水処理の使用率",
    ],
    notImplementedNote:
      NOT_CONNECTED_NOTE +
      "環境・排水に関するロジックは、現時点のエンジンにひとつも実装されていません（能力・事故・行政処分・監査のいずれも存在しません）。" +
      "したがって現時点でこの投資は、減価償却費と保守費というコストだけが発生し、操業上の便益はありません。",
  },
  // 【Test15新設】既存工場の能力増強ではなく、完成・稼働開始後（操業準備期間経過後）に
  // 会社のFactory[]へ新しいFactoryそのものを1つ追加する（capex/factoryConstruction.ts参照）。
  // 稼働開始後は50%→75%→100%の3段階でランプアップする点が、他の案件種別（即座にフル効果）と異なる。
  newFactoryConstruction: {
    implementedEffects: [
      "完成・稼働開始後、会社のFactory[]へ新しい工場（標準工場）を1つ追加",
      "稼働開始四半期からの3段階ランプアップ（1四半期目50%・2四半期目75%・3四半期目以降100%の実効能力）",
      "取得原価の固定資産振替と、建物・機械コンポーネント別の減価償却",
      "稼働開始後の四半期固定保守費",
      "稼働中工場数（activeFactoryCount）としての四半期固定費への算入（稼働開始後のみ）",
    ],
    notImplementedEffects: [
      "新設工場ぶんのWorker（常用・臨時）の自動配置・自動採用（従来どおりWorker意思決定で別途配置が必要）",
      "新設工場ぶんの営業人員・販売能力・市場需要の自動増加（従来どおり営業人員の意思決定で別途対応が必要）",
      "既存工場のスペースプールとの連動（新設工場は既存工場のtotalFactorySpaceUnitsを消費しない別枠として扱われます）",
    ],
    notImplementedNote:
      "新設工場の能力は、稼働開始後もWorker・営業人員・市場需要と自動的には連動しません。新設工場を実際に稼働させるには、" +
      "Worker意思決定でその工場へ人員を配置する必要があります（本タスク時点では、意思決定画面のWorker・生産計画の行は" +
      "既存fixtureの工場だけを対象に生成されるため、新設工場への配置導線は今後の拡張課題です）。",
  },
  // 【Test15新設】特定Factory1件を対象に、そのFactoryのPD労働集約度係数だけを引き下げる
  // （PD生産能力そのものは増やさない。HOSO/VAPには一切影響しない）。
  pdMechanization: {
    implementedEffects: [
      "対象Factory1件だけのPD労働集約度係数を、稼働開始後の習熟進捗×前四半期PD稼働率に応じて段階的に引き下げ（capex/pdMechanization.ts）",
      "取得原価の固定資産振替と、建物・機械コンポーネント別の減価償却",
      "稼働開始後の四半期固定保守費",
    ],
    notImplementedEffects: [
      "対象FactoryのPD生産能力（pdCapacity）そのものの増加（このプロジェクトは能力を増やしません）",
      "HOSO・VAPの労働集約度係数（対象Factoryも含め一切変化しません）",
      "他社・他工場のPD労働集約度係数",
    ],
    notImplementedNote:
      "この投資の効果は、対象Factoryの前四半期PD稼働率が低いほど小さくなります（稼働率が低い工場では、機械化しても実際の削減効果はほとんど発現しません）。" +
      "稼働開始直後は習熟期間中のため、フル効果ではありません。",
  },
};

// ---------------------------------------------------------------------
// 2. Worker（人員）の行
// ---------------------------------------------------------------------

export interface WorkforcePlanRow {
  readonly factoryId: string;
  /** 前期末の常用ワーカー総人数（会社状態から引き継いだ出発点）。 */
  readonly headcountBefore: number;
  /** 当期の増減差分（増員は正、減員は負）。 */
  readonly headcountChange: number;
  /** 変更後の常用ワーカー総人数（＝エンジンへ渡す絶対人数）。 */
  readonly headcountAfter: number;
  readonly temporaryHeadcount: number;
  readonly overtimeRate: number;
  readonly attendanceRate: number;
  readonly skillByProduct: Readonly<Partial<Record<Product, number>>>;
  /** 現在の生産計画（希望量）を処理するために必要な常用人数の目安。 */
  readonly requiredRegularHeadcount: number;
  /** 過不足人数（変更後人数 − 必要人数）。負なら不足。 */
  readonly headcountSurplus: number;
  readonly isShortage: boolean;
  /** 変更後の推定労働能力（商品別、完成品HOSO換算トン/四半期）。 */
  readonly laborCapacityByProductAfter: Readonly<Partial<Record<Product, number>>>;
  readonly costBefore: QuarterlyLaborCostBreakdown;
  readonly costAfter: QuarterlyLaborCostBreakdown;
  /** 四半期人件費の増減（変更後 − 変更前）。 */
  readonly costDeltaUsd: number;
  /**
   * Worker削減によって処理できなくなる見込み量（完成品HOSO換算トン）。
   * 実際の処理見込み（生産エンジンの配分結果）のうち、労働制約で減っているぶんを
   * そのまま写す。見積り式ではなくエンジンの出力である。
   */
  readonly unprocessedByLaborTons: number;
  /** 不足の説明文（不足していなければundefined）。 */
  readonly shortageSentence: string | undefined;
}

// ---------------------------------------------------------------------
// 3. 投資カード
// ---------------------------------------------------------------------

/**
 * 【Phase 8D 追補】追加Worker人件費を増分キャッシュフローから控除しても
 * 二重控除にならないことの根拠。コードで確認した費用構成をそのまま記述する。
 *
 * finance/quarterClose.ts を確認した結果:
 *   - 限界利益 ＝ 純売上高 − totalVariableCost（quarterClose.ts:1026）
 *   - totalVariableCost の労務費部分は variableLaborCost だけであり、
 *     その中身は cogsLaborVariable ＋（生産ゼロ時の臨時ワーカー費・残業費）
 *     （quarterClose.ts:1022, 1025）
 *   - cogsLaborVariable は laborVariablePerTon の積み上げであり、
 *     laborVariablePerTon の定義は「変動労務費（**臨時ワーカー費＋残業費**の配賦）」
 *     （finance/types.ts:162、quarterClose.ts:439）
 *   - **正社員（常用Worker）の給与は laborFixedPerTon（固定労務費）として分離**され
 *     （finance/types.ts:166、quarterClose.ts:441）、
 *     fixedManufacturingCost ＝ regularLaborCost ＋ 工場固定費 ＋ 固定ユーティリティ ＋ 減価償却
 *     として**限界利益の外側**に置かれている（quarterClose.ts:1029-1033）
 *
 * したがって「実績限界利益／販売トン」には常用Workerの給与が一切含まれておらず、
 * 増分キャッシュフローから追加常用Workerの人件費を差し引くことは二重控除ではない。
 * 逆に、残業・臨時ワーカーで増産を吸収する場合の費用は限界利益側ですでに
 * 控除済みであるため、こちらを重ねて引いてはいけない（本計算では追加人員を
 * すべて常用Workerとして数え、臨時ワーカー0人で算出している）。
 */
export const PAYBACK_DOUBLE_COUNTING_NOTE =
  "追加Workerの人件費は、限界利益と二重に控除されていません。" +
  "エンジンの限界利益（ContributionMarginReport）に含まれる労務費は「変動労務費＝臨時ワーカー費＋残業費」だけであり、" +
  "常用Worker（正社員）の給与は固定製造費（fixedManufacturingCost）として限界利益の外側に置かれているためです。" +
  "そのため、増産のために常用Workerを増やす場合の人件費は、増分キャッシュフローから別途差し引く必要があります。";

/** 投資回収の算定結果。算定できない場合は理由を返し、数値を作らない。 */
export interface PaybackEstimate {
  readonly isComputable: boolean;
  /** 算定できない理由（isComputable=falseのときのみ）。 */
  readonly notComputableReason?: string;
  /** 投資完成後に追加で処理できる見込み量（完成品HOSO換算トン/四半期）。 */
  readonly incrementalProcessableTonsPerQuarter: number;
  /** 直近確定四半期の実績に基づく限界利益（USD/販売トン）。 */
  readonly contributionMarginUsdPerTon?: number;
  /** 増分限界利益（USD/四半期）。 */
  readonly incrementalContributionUsdPerQuarter?: number;
  /** 稼働開始後に増える四半期固定保守費（USD/四半期）。 */
  readonly incrementalMaintenanceUsdPerQuarter: number;
  /**
   * 【Phase 8D 追補】増分処理量を実際に処理するために追加で必要になる
   * 常用Workerの四半期人件費（USD/四半期）。
   * 正社員給与は限界利益の計算に含まれていない（固定費側）ため、ここで控除しても
   * 二重控除にはならない。根拠は doubleCountingNote を参照。
   */
  readonly incrementalLaborCostUsdPerQuarter: number;
  /**
   * 上記の人件費に対応する追加常用Worker人数（整数）。
   * **設備投資によって新たに発生する採用人数**であり、現在の人員余力（遊休Worker）で
   * 吸収できるぶんと、投資前からすでに存在する不足人数は含まれない
   * （companyLab/workforce.ts の computeIncrementalRegularHires を参照）。
   */
  readonly incrementalRegularHeadcount: number;
  /**
   * 増分キャッシュフロー（USD/四半期）
   *   ＝ 増分限界利益 − 増分保守費 − 増分Worker人件費
   * 減価償却は非現金支出なので含めない。
   */
  readonly incrementalCashFlowUsdPerQuarter?: number;
  /** 概算投資回収年数（投資総額 ÷ 年間増分キャッシュフロー）。 */
  readonly paybackYears?: number;
  /** 算定式と前提の説明（画面・Excelに必ず併記する）。 */
  readonly formulaText: string;
  readonly assumptionTexts: readonly string[];
  /** 追加Worker人件費が二重控除にならない根拠（コードで確認した費用構成）。 */
  readonly doubleCountingNote: string;
}

export interface InvestmentCardViewModel {
  readonly projectType: CapitalProjectType;
  /** 設備名・投資額・建設期間・支払予定・減価償却などの既存プレビュー値。 */
  readonly candidate: CapexCandidateViewModel;
  readonly description: string;
  // --- 能力 ---
  readonly targetPoolKey?: SpaceConsumingPoolKey;
  readonly targetPoolLabel?: string;
  /** 現在の能力（対象プール、名目トン）。対象プールが無い案件はundefined。 */
  readonly currentCapacityTons?: number;
  /** 追加能力（対象プール、名目トン）。 */
  readonly capacityIncreaseTons: number;
  /** 投資完成後の能力（現在＋追加）。 */
  readonly capacityAfterTons?: number;
  // --- 工場スペース ---
  readonly requiredSpaceUnits: number;
  readonly freeSpaceUnitsBefore: number;
  readonly spaceUsedAfterUnits: number;
  readonly spaceUtilizationRateAfter: number | undefined;
  readonly fitsInFactorySpace: boolean;
  readonly spaceShortfallUnits: number;
  // --- Worker ---
  /**
   * 追加で必要になる常用Worker人数。
   * **設備投資によって新たに発生する採用人数だけ**であり、現在の人員余力で吸収できる場合は0、
   * 投資前から存在する不足人数も含まない（`computeIncrementalRegularHires`）。
   */
  readonly additionalRequiredHeadcount: number;
  /** 追加四半期人件費（追加Worker × 常用Worker給与単価。単価は finance/parameters.ts）。 */
  readonly additionalQuarterlyLaborCostUsd: number;
  // --- 効果 ---
  /** 現在の生産計画に対する効果（投資完成後に追加で処理できる見込み量）。 */
  readonly incrementalProcessableTonsPerQuarter: number;
  /** 効果が0の場合の説明（例: 別の制約が先に効いているため増えない）。 */
  readonly noEffectReason: string | undefined;
  /** 現在の主なボトルネック（処理見込みの主因のうち最も多く現れたもの）。 */
  readonly primaryBottleneckLabel: string | undefined;
  readonly payback: PaybackEstimate;
  readonly effectDisclosure: ProjectEffectDisclosure;
  /** 完成前は当期に使えないことの注記。 */
  readonly notAvailableThisQuarterNote: string;
}

// ---------------------------------------------------------------------
// 4. 警告
// ---------------------------------------------------------------------

export type PlanningWarningKind =
  | "equipmentCapacityShortage"
  | "workerShortage"
  | "factorySpaceShortage"
  | "freezingPackagingShortage"
  | "coldStorageOverCapacity"
  | "investmentNotAvailableYet"
  | "engineNotConnected";

export const PLANNING_WARNING_LABELS: Readonly<Record<PlanningWarningKind, string>> = {
  equipmentCapacityShortage: "設備能力不足",
  workerShortage: "Worker不足",
  factorySpaceShortage: "工場スペース不足",
  freezingPackagingShortage: "凍結・包装処理能力不足",
  coldStorageOverCapacity: "保管能力超過見込み",
  investmentNotAvailableYet: "投資完成前で当期には利用できない",
  engineNotConnected: "エンジン未接続の効果",
};

export interface PlanningWarning {
  readonly kind: PlanningWarningKind;
  readonly label: string;
  /** 不足量または発生理由を文章で示す（色だけに頼らない）。 */
  readonly sentence: string;
  /** 数値で示せる不足量（単位は kind により異なる。示せない場合はundefined）。 */
  readonly shortfallAmount?: number;
  readonly shortfallUnitLabel?: string;
}

// ---------------------------------------------------------------------
// 5. 全体
// ---------------------------------------------------------------------

export interface CompanyInvestmentPlanningViewModel {
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  /** 現在の入力に基づく処理見込み（生産エンジンの出力そのもの）。 */
  readonly forecast: CompanyProcessingForecast;
  readonly workforceRows: readonly WorkforcePlanRow[];
  readonly factorySpace: CompanyFactorySpaceState;
  readonly coldStorage: CompanyColdStorageState;
  readonly investmentCards: readonly InvestmentCardViewModel[];
  readonly warnings: readonly PlanningWarning[];
  /** 「生産計画 → 必要能力 → 必要Worker → 必要スペース → 不足 → 投資」の説明文。 */
  readonly chainExplanationSteps: readonly string[];
  readonly freezingVsStorageExplanation: string;
  readonly workforceNotModeledNote: string;
}

export interface BuildCompanyInvestmentPlanningInput {
  /**
   * 【ENG-FAC-1 read-path consistency】Factory lifecycle決定ログ（capex/factoryLifecycle.ts）。
   * CompanyOwnState.factoryLifecycleState をそのまま渡すこと。省略時はlifecycleを一切
   * 適用しない＝この機能の導入前と完全に同一の表示（既存呼び出し元との後方互換）。
   * ここで status の独自判定は行わない（判定は computeEffectiveFactories の1箇所のみ）。
   */
  readonly factoryLifecycleState?: FactoryLifecycleStateTable;
  readonly companyId: CompanyId;
  /** ラボ作成時の静的な工場（capex加算前）。 */
  readonly baseFactories: readonly Factory[];
  readonly capexState: CapexState;
  readonly period: PeriodV2;
  /** 現在の入力から作った生産計画（buildDecisionInputFromDraftの出力をそのまま渡す）。 */
  readonly productionPlans: readonly CompanyProductionPlanEntry[];
  /** 現在の入力から作ったワーカー配置（変更後の絶対人数）。 */
  readonly workerAssignments: readonly WorkerAssignment[];
  /** 各工場の前期末Worker総人数（増減差分の表示に使う）。 */
  readonly workforceState?: CompanyWorkforceState;
  readonly rawMaterialLots: readonly RawMaterialLot[];
  readonly finishedGoodsLots: readonly FinishedGoodsLot[];
  /** 直近確定四半期の財務結果（投資回収の限界利益に使う）。無ければ回収年数は算定対象外。 */
  readonly lastQuarterFinancialResult?: CompanyFinancialQuarterResult | null;
  readonly capexParams?: CapexParameters;
}

const PRODUCTS: readonly Product[] = ["hoso", "pd", "vap"];

function poolNominalTons(factory: Factory, pool: SpaceConsumingPoolKey): number {
  switch (pool) {
    case "commonProcessing":
      return unwrapUnit(factory.commonProcessingCapacity);
    case "hoso":
      return unwrapUnit(factory.hosoCapacity);
    case "pd":
      return unwrapUnit(factory.pdCapacity);
    case "vap":
      return unwrapUnit(factory.vapCapacity);
    case "freezingPackaging":
      return unwrapUnit(factory.freezingPackagingCapacity);
    case "coldStorage":
      return factory.coldStorageCapacity !== undefined ? unwrapUnit(factory.coldStorageCapacity) : 0;
  }
}

/** 対象プールの名目能力を increaseTons だけ増やした仮のFactoryを作る（元は変更しない）。 */
function withHypotheticalCapacityIncrease(factory: Factory, pool: SpaceConsumingPoolKey, increaseTons: number): Factory {
  const next = poolNominalTons(factory, pool) + increaseTons;
  switch (pool) {
    case "commonProcessing":
      return { ...factory, commonProcessingCapacity: hosoEqTons(next) };
    case "hoso":
      return { ...factory, hosoCapacity: hosoEqTons(next) };
    case "pd":
      return { ...factory, pdCapacity: hosoEqTons(next) };
    case "vap":
      return { ...factory, vapCapacity: hosoEqTons(next) };
    case "freezingPackaging":
      return { ...factory, freezingPackagingCapacity: hosoEqTons(next) };
    case "coldStorage":
      return { ...factory, coldStorageCapacity: hosoEqTons(next) };
  }
}

function totalForecastTons(forecast: CompanyProcessingForecast): number {
  return forecast.rows.reduce((sum, r) => sum + r.forecastProcessedTons, 0);
}

/** 処理見込みを商品別に合計する（必要Worker人数は商品別の技能で決まるため商品別に分ける）。 */
function processedTonsByProduct(forecast: CompanyProcessingForecast): Readonly<Partial<Record<Product, number>>> {
  const byProduct: Partial<Record<Product, number>> = {};
  for (const row of forecast.rows) {
    if (row.forecastProcessedTons <= 0) continue;
    byProduct[row.product] = (byProduct[row.product] ?? 0) + row.forecastProcessedTons;
  }
  return byProduct;
}

/**
 * 直近確定四半期の実績から、限界利益（USD/販売トン）を求める。
 *
 * 【推測値を使わない設計】売上単価も限界利益率も仮定せず、エンジンが確定させた
 * ContributionMarginReport.contributionMargin（実績の限界利益額）と、
 * 同じ四半期の販売量（costRecords の driver="salesQuantity" の driverQuantity。
 * これも実績）だけを使って割り算する。どちらかが得られなければ undefined を返し、
 * 呼び出し側は「算定対象外」と表示する。
 */
export function computeRealizedContributionMarginUsdPerTon(result: CompanyFinancialQuarterResult | null | undefined): number | undefined {
  if (!result) return undefined;
  const salesRecord = result.costRecords.find((r) => r.driver === "salesQuantity");
  const soldTons = salesRecord?.driverQuantity;
  if (soldTons === undefined || !Number.isFinite(soldTons) || soldTons <= 0) return undefined;
  const contributionMargin = result.contributionMargin.contributionMargin as unknown as number;
  if (!Number.isFinite(contributionMargin)) return undefined;
  return contributionMargin / soldTons;
}

export function buildCompanyInvestmentPlanningViewModel(
  input: BuildCompanyInvestmentPlanningInput
): CompanyInvestmentPlanningViewModel {
  const capexParams = input.capexParams ?? CAPEX_PARAMETERS_V1;
  const companyBase = input.baseFactories.filter((f) => f.companyId === input.companyId);
  // 【Test15・develop/v2統合（Required fix 2）】唯一の計算箇所computeEffectiveFactories
  // を使う（applyCapexCapacityToFactoriesだけだと、稼働開始済みの新設Factoryが
  // currentFactoriesへ現れず、投資計画・工場スペース・Worker必要人数の各表示から
  // 新設工場が漏れてしまう）。
  const currentFactories = computeEffectiveFactories(companyBase, input.capexState, input.period, input.factoryLifecycleState);

  // --- 現在の処理見込み（生産エンジンの出力そのもの） ---
  const forecast = buildCompanyProcessingForecast({
    companyId: input.companyId,
    baseFactories: companyBase,
    capexState: input.capexState,
    period: input.period,
    factoryLifecycleState: input.factoryLifecycleState,
    productionPlans: input.productionPlans,
    workerAssignments: input.workerAssignments,
    rawMaterialLots: input.rawMaterialLots,
  });
  const currentTotalTons = totalForecastTons(forecast);

  // --- 工場スペース ---
  const factorySpace = buildCompanyFactorySpaceState({
    companyId: input.companyId,
    baseFactories: companyBase,
    currentFactories,
    capexState: input.capexState,
    period: input.period,
  });
  const freeSpaceUnitsBefore = Math.max(0, factorySpace.totalSpaceUnits - factorySpace.usedAfterPendingSpaceUnits);

  // --- 冷凍・冷蔵保管（ストック） ---
  const companyCapex = input.capexState.companies.find((c) => c.companyId === input.companyId);
  const pendingColdStorageAdditionTons = companyCapex
    ? companyCapex.portfolio.projects
        .filter((p) => p.status !== "cancelled")
        .reduce((sum, p) => {
          const e = p.futureCapacityEffect;
          if (!e || e.targetProduct !== "coldStorage") return sum;
          // すでに稼働開始済みのぶんは currentFactories の能力へ入っているので加えない。
          const alreadyOperational = computeCapacityEffectForCompany([p], input.period).coldStorage > 0;
          return alreadyOperational ? sum : sum + (e.capacityIncreaseTonsPerQuarter ?? 0);
        }, 0)
    : 0;
  const coldStorage = buildCompanyColdStorageState({
    companyId: input.companyId,
    currentFactories,
    finishedGoodsLots: input.finishedGoodsLots,
    pendingColdStorageAdditionTons,
  });

  // --- Worker ---
  const workforceRows: WorkforcePlanRow[] = input.workerAssignments
    .filter((w) => w.companyId === input.companyId)
    .map((assignment) => {
      // 【staging再現バグの根本原因】headcountBeforeを「workforceStateに無ければ
      // assignment.regularHeadcount（＝今まさに編集中の現在値）」にfallbackしていたため、
      // workforceStateにまだ記録が無い工場（稼働開始したばかりで、一度もWorker決定が
      // 確定していない新設Factory）では headcountBefore が常に headcountAfter と同じ値になり、
      // headcountChange（＝この「増員／減員」inputの表示値）が入力のたびに必ず0へ計算し直され、
      // 何人入力しても増減欄が0のまま動かないように見えていた（他のUI層・draft側は正しく
      // 動いていた＝入力binding自体は壊れていない。表示計算だけが誤っていた）。
      // workforceStateが渡されているのに対象Factoryの記録が無い場合は「まだ誰もアサインした
      // ことが無い＝0人からのスタート」が正しい前提であり、assignment.regularHeadcountへ
      // fallbackしてはいけない。workforceState自体が渡されていない呼び出し（無い場合の
      // 既存動作を変えない）だけ、従来どおりassignment.regularHeadcountへfallbackする。
      const persistedHeadcount = input.workforceState?.factories.find((f) => f.factoryId === assignment.factoryId)?.regularHeadcount;
      const headcountBefore = persistedHeadcount !== undefined ? persistedHeadcount : input.workforceState ? 0 : assignment.regularHeadcount;
      const headcountAfter = assignment.regularHeadcount;
      const attendanceRate = unwrapUnit(assignment.attendanceRate);
      const overtimeRate = unwrapUnit(assignment.overtimeRate);

      const skillByProduct: Partial<Record<Product, number>> = {};
      for (const s of assignment.skills) skillByProduct[s.product] = unwrapUnit(s.skillLevel);

      const quantityByProduct: Partial<Record<Product, number>> = {};
      for (const plan of input.productionPlans) {
        if (plan.companyId !== input.companyId || plan.factoryId !== assignment.factoryId) continue;
        quantityByProduct[plan.product] = (quantityByProduct[plan.product] ?? 0) + unwrapUnit(plan.desiredQuantity);
      }

      const required = computeRequiredRegularHeadcount({
        quantityByProduct,
        skillByProduct,
        attendanceRate,
        appliedOvertimeRate: overtimeRate,
        temporaryHeadcount: assignment.temporaryHeadcount,
      });

      const factory = currentFactories.find((f) => f.factoryId === assignment.factoryId);
      const laborCapacityByProductAfter: Partial<Record<Product, number>> = {};
      for (const product of PRODUCTS) {
        // 労働能力の計算式はエンジンの関数をそのまま呼ぶ（設備能力でのクリップも
        // エンジン側の実装に含まれるため、「人を増やしても設備能力は超えない」が
        // 表示上も自動的に成り立つ）。
        laborCapacityByProductAfter[product] = calculateLaborCapacityFromAssignedHeadcount(
          headcountAfter,
          assignment.temporaryHeadcount,
          attendanceRate,
          skillByProduct[product] ?? 0,
          overtimeRate,
          factory ? poolNominalTons(factory, product as SpaceConsumingPoolKey) : 0,
          PRODUCTION_PARAMETERS_V1,
          product
        );
      }

      const costBefore = computeQuarterlyLaborCost(headcountBefore, assignment.temporaryHeadcount, FINANCE_PARAMETERS_V1);
      const costAfter = computeQuarterlyLaborCost(headcountAfter, assignment.temporaryHeadcount, FINANCE_PARAMETERS_V1);

      // 労働制約で減っているぶんは、エンジンが返した処理見込みからそのまま取る。
      const unprocessedByLaborTons = forecast.rows
        .filter((r) => r.factoryId === assignment.factoryId)
        .reduce((sum, r) => sum + (r.constraints.find((c) => c.reason === "laborShortage")?.reducedTons ?? 0), 0);

      const headcountSurplus = headcountAfter - required.requiredRegularHeadcount;
      const isShortage = unprocessedByLaborTons > 0 || headcountSurplus < 0;

      return {
        factoryId: assignment.factoryId,
        headcountBefore,
        headcountChange: headcountAfter - headcountBefore,
        headcountAfter,
        temporaryHeadcount: assignment.temporaryHeadcount,
        overtimeRate,
        attendanceRate,
        skillByProduct,
        requiredRegularHeadcount: required.requiredRegularHeadcount,
        headcountSurplus,
        isShortage,
        laborCapacityByProductAfter,
        costBefore,
        costAfter,
        costDeltaUsd: costAfter.totalCostUsd - costBefore.totalCostUsd,
        unprocessedByLaborTons,
        shortageSentence: isShortage
          ? `この工場では、現在の生産計画に対して常用Workerが約${Math.max(0, Math.ceil(-headcountSurplus)).toLocaleString("en-US")}人不足しています。` +
            (unprocessedByLaborTons > 0
              ? `そのため、処理見込みが ${unprocessedByLaborTons.toFixed(2)} トン減っています。`
              : "現時点では他の制約が先に効いているため処理見込みは減っていませんが、他の制約が緩むと不足が表面化します。")
          : undefined,
      };
    });

  // --- 主なボトルネック（処理見込みの主因のうち、最も多く現れたもの） ---
  const bottleneckCounts = new Map<string, { readonly label: string; count: number }>();
  for (const row of forecast.rows) {
    const primary = row.primaryConstraint;
    if (!primary) continue;
    const entry = bottleneckCounts.get(primary.reason) ?? { label: primary.label, count: 0 };
    entry.count += 1;
    bottleneckCounts.set(primary.reason, entry);
  }
  const primaryBottleneckLabel = Array.from(bottleneckCounts.values()).sort((a, b) => b.count - a.count)[0]?.label;

  const contributionMarginUsdPerTon = computeRealizedContributionMarginUsdPerTon(input.lastQuarterFinancialResult);

  // --- 【Phase 8D 追補2】投資前の必要人数と現在人数（全カード共通。カードごとに再計算しない） ---
  //
  // 【複数工場について】投資案件は factoryId を持たず、能力は主工場（先頭）へ加算される
  // （capex/capacityEffect.ts の規則）。したがって技能・出勤率・残業率は主工場のワーカー
  // 配置を代表値として使い、人数は会社合計で比較する。現行フィクスチャは全社1工場のため、
  // 実質的な差は生じない。
  const representativeRow = workforceRows[0];
  const representativeWorkerProfile = {
    skillByProduct: representativeRow?.skillByProduct ?? {},
    attendanceRate: representativeRow?.attendanceRate ?? 0,
    overtimeRate: representativeRow?.overtimeRate ?? 0,
    temporaryHeadcount: representativeRow?.temporaryHeadcount ?? 0,
  };
  /** 現在の常用Worker総人数（当期の意思決定を反映した変更後人数）。 */
  const currentRegularHeadcountTotal = workforceRows.reduce((sum, r) => sum + r.headcountAfter, 0);
  /** 投資前の処理見込み量（商品別）。必要人数の基準はこの「実際に処理される量」とする。 */
  const currentProcessedByProduct = processedTonsByProduct(forecast);
  /** 投資前の生産量を処理するために必要な常用Worker人数。 */
  const requiredHeadcountBeforeInvestment = computeRequiredRegularHeadcount({
    quantityByProduct: currentProcessedByProduct,
    skillByProduct: representativeWorkerProfile.skillByProduct,
    attendanceRate: representativeWorkerProfile.attendanceRate,
    appliedOvertimeRate: representativeWorkerProfile.overtimeRate,
    temporaryHeadcount: representativeWorkerProfile.temporaryHeadcount,
  }).requiredRegularHeadcount;

  // --- 投資カード ---
  const investmentCards: InvestmentCardViewModel[] = CAPITAL_PROJECT_TYPES.map((projectType) => {
    const template = capexParams.templatesByType[projectType];
    const candidate = buildCapexCandidateViewModel(projectType, input.period, capexParams);
    const targetPoolKey = template.futureCapacityEffect.targetProduct as SpaceConsumingPoolKey | undefined;
    const capacityIncreaseTons = template.futureCapacityEffect.capacityIncreaseTonsPerQuarter ?? 0;

    const currentCapacityTons =
      targetPoolKey !== undefined ? currentFactories.reduce((sum, f) => sum + poolNominalTons(f, targetPoolKey), 0) : undefined;

    // --- 投資完成後の処理見込み（同じ生産エンジンへ、能力を増やしたFactoryで再度渡す） ---
    let incrementalProcessableTonsPerQuarter = 0;
    let noEffectReason: string | undefined;
    /** 投資後の商品別処理見込み量（無投資なら現在と同じ）。必要人数の算出に使う。 */
    let processedByProductAfter: Readonly<Partial<Record<Product, number>>> = currentProcessedByProduct;
    if (targetPoolKey !== undefined && capacityIncreaseTons > 0 && targetPoolKey !== "coldStorage") {
      const primaryFactoryId = currentFactories[0]?.factoryId;
      const hypotheticalFactories = currentFactories.map((f) =>
        f.factoryId === primaryFactoryId ? withHypotheticalCapacityIncrease(f, targetPoolKey, capacityIncreaseTons) : f
      );
      const afterForecast = buildCompanyProcessingForecast({
        companyId: input.companyId,
        // すでに設備投資を反映済みのFactoryを渡すため、capexStateは空にする（二重加算の防止）。
        // 【ENG-FAC-1】hypotheticalFactoriesはcurrentFactories由来＝lifecycle適用済みのため、
        // factoryLifecycleStateもここでは渡さない（二重適用の防止。売却済み工場は既に不在）。
        baseFactories: hypotheticalFactories,
        capexState: { companies: [] },
        period: input.period,
        productionPlans: input.productionPlans,
        workerAssignments: input.workerAssignments,
        rawMaterialLots: input.rawMaterialLots,
      });
      incrementalProcessableTonsPerQuarter = Math.max(0, totalForecastTons(afterForecast) - currentTotalTons);
      processedByProductAfter = processedTonsByProduct(afterForecast);
      if (incrementalProcessableTonsPerQuarter <= 0) {
        noEffectReason =
          primaryBottleneckLabel !== undefined
            ? `現在の入力では、この能力より先に「${primaryBottleneckLabel}」が処理量を制約しているため、この投資だけでは処理見込みが増えません。`
            : "現在の入力では、この能力が制約になっていないため、この投資だけでは処理見込みが増えません。";
      }
    } else if (targetPoolKey === "coldStorage") {
      noEffectReason =
        "冷凍・冷蔵保管能力は在庫を置ける量（ストック）であり、四半期あたりの処理量（フロー）の上限ではありません。したがって処理見込みは増えません。";
    } else {
      noEffectReason = "この投資は生産能力を増加させません。";
    }

    // --- 【Phase 8D 追補2】設備投資によって「新たに発生する」採用人数だけを求める ---
    //
    // 「増分処理量に必要な人数」をそのまま採用人数にすると、
    //   (a) 現在の人員に余力（遊休Worker）がある場合、
    //   (b) 1人未満の端数を単独で切り上げる場合、
    //   (c) 投資前からすでに人員が不足している場合
    // のいずれでも過大計上になる。そこで **投資前の総必要人数** と **投資後の総必要人数** を
    // それぞれ現在人数と突き合わせ、その採用人数の差だけを増分として扱う
    // （計算式は companyLab/workforce.ts の computeIncrementalRegularHires に一元化。
    //  UI側に別の式を作らない）。
    const requiredHeadcountAfterInvestment = computeRequiredRegularHeadcount({
      quantityByProduct: processedByProductAfter,
      skillByProduct: representativeWorkerProfile.skillByProduct,
      attendanceRate: representativeWorkerProfile.attendanceRate,
      appliedOvertimeRate: representativeWorkerProfile.overtimeRate,
      temporaryHeadcount: representativeWorkerProfile.temporaryHeadcount,
    }).requiredRegularHeadcount;

    const hires = computeIncrementalRegularHires({
      requiredHeadcountBefore: requiredHeadcountBeforeInvestment,
      requiredHeadcountAfter: requiredHeadcountAfterInvestment,
      currentRegularHeadcount: currentRegularHeadcountTotal,
    });
    const additionalRequiredHeadcount = hires.incrementalHires;
    // 単価は finance/parameters.ts の常用Worker給与（Worker増減パネルの人件費試算と同一）。
    // ここに金額をハードコードしない。
    const additionalQuarterlyLaborCostUsd =
      computeQuarterlyLaborCost(additionalRequiredHeadcount, 0, FINANCE_PARAMETERS_V1).regularCostUsd;

    // --- 工場スペース ---
    const requiredSpaceUnits = computeCandidateProjectSpaceUnits(projectType, capexParams, FACTORY_SPACE_PARAMETERS_V1);
    const spaceUsedAfterUnits = factorySpace.usedAfterPendingSpaceUnits + requiredSpaceUnits;
    const fitsInFactorySpace = requiredSpaceUnits <= freeSpaceUnitsBefore + FACTORY_SPACE_PARAMETERS_V1.epsilonSpaceUnits;

    // --- 投資回収 ---
    const incrementalMaintenanceUsdPerQuarter = candidate.quarterlyMaintenanceCostUsd;
    const payback = buildPaybackEstimate({
      totalInvestmentUsd: candidate.totalInvestmentUsd,
      incrementalProcessableTonsPerQuarter,
      contributionMarginUsdPerTon,
      incrementalMaintenanceUsdPerQuarter,
      // 【Phase 8D 追補】増分処理量を実現するために必要な追加Workerの人件費を控除する。
      // カードに表示している人数・金額と同一の値をそのまま渡す。
      incrementalRegularHeadcount: additionalRequiredHeadcount,
      incrementalLaborCostUsdPerQuarter: additionalQuarterlyLaborCostUsd,
      hasLastQuarterResult: Boolean(input.lastQuarterFinancialResult),
      noEffectReason,
    });

    return {
      projectType,
      candidate,
      description: candidate.description,
      targetPoolKey,
      targetPoolLabel: targetPoolKey !== undefined ? TARGET_PRODUCT_LABELS[targetPoolKey] : undefined,
      currentCapacityTons,
      capacityIncreaseTons,
      capacityAfterTons: currentCapacityTons !== undefined ? currentCapacityTons + capacityIncreaseTons : undefined,
      requiredSpaceUnits,
      freeSpaceUnitsBefore,
      spaceUsedAfterUnits,
      spaceUtilizationRateAfter: factorySpace.totalSpaceUnits > 0 ? spaceUsedAfterUnits / factorySpace.totalSpaceUnits : undefined,
      fitsInFactorySpace,
      spaceShortfallUnits: Math.max(0, requiredSpaceUnits - freeSpaceUnitsBefore),
      additionalRequiredHeadcount,
      additionalQuarterlyLaborCostUsd,
      incrementalProcessableTonsPerQuarter,
      noEffectReason,
      primaryBottleneckLabel,
      payback,
      effectDisclosure: PROJECT_EFFECT_DISCLOSURES[projectType],
      notAvailableThisQuarterNote: `この投資は${candidate.constructionQuarters}四半期の工期のあと完成し、稼働開始は ${candidate.expectedOperationalStartPeriod} の見込みです。当期の生産能力は増えません。`,
    };
  });

  // --- 警告 ---
  const warnings: PlanningWarning[] = [];

  const equipmentShortfallTons = forecast.rows.reduce(
    (sum, r) => sum + (r.constraints.find((c) => c.reason === "productCapacityShortage")?.reducedTons ?? 0),
    0
  );
  if (equipmentShortfallTons > 0) {
    warnings.push({
      kind: "equipmentCapacityShortage",
      label: PLANNING_WARNING_LABELS.equipmentCapacityShortage,
      sentence: `商品別の設備能力が足りないため、処理見込みが合計 ${equipmentShortfallTons.toFixed(2)} トン減っています。設備投資で該当商品の加工能力を増やすか、生産計画を見直してください。`,
      shortfallAmount: equipmentShortfallTons,
      shortfallUnitLabel: "トン/四半期",
    });
  }

  const freezingShortfallTons = forecast.rows.reduce(
    (sum, r) => sum + (r.constraints.find((c) => c.reason === "packagingCapacityShortage")?.reducedTons ?? 0),
    0
  );
  if (freezingShortfallTons > 0) {
    warnings.push({
      kind: "freezingPackagingShortage",
      label: PLANNING_WARNING_LABELS.freezingPackagingShortage,
      sentence: `凍結・包装処理能力（トン/四半期）が足りないため、処理見込みが合計 ${freezingShortfallTons.toFixed(2)} トン減っています。これは保管能力ではなく処理量の上限です。増やすには「凍結・包装処理能力増設」を投資してください。`,
      shortfallAmount: freezingShortfallTons,
      shortfallUnitLabel: "トン/四半期",
    });
  }

  for (const row of workforceRows) {
    if (!row.isShortage || row.shortageSentence === undefined) continue;
    warnings.push({
      kind: "workerShortage",
      label: PLANNING_WARNING_LABELS.workerShortage,
      sentence: `${row.factoryId}: ${row.shortageSentence}`,
      shortfallAmount: Math.max(0, -row.headcountSurplus),
      shortfallUnitLabel: "人",
    });
  }

  if (factorySpace.isShortage) {
    warnings.push({
      kind: "factorySpaceShortage",
      label: PLANNING_WARNING_LABELS.factorySpaceShortage,
      sentence: `工場スペースが ${Math.round(factorySpace.shortfallSpaceUnits).toLocaleString("en-US")} スペース単位不足しています。建設中の案件を取り消すか、投資対象を絞り込んでください（既存設備の能力が減ることはありません）。`,
      shortfallAmount: factorySpace.shortfallSpaceUnits,
      shortfallUnitLabel: "スペース単位",
    });
  }

  if (coldStorage.isOverCapacity) {
    warnings.push({
      kind: "coldStorageOverCapacity",
      label: PLANNING_WARNING_LABELS.coldStorageOverCapacity,
      sentence: `完成品在庫が冷凍・冷蔵保管能力を ${coldStorage.overCapacityTons.toFixed(2)} トン超えています。${COLD_STORAGE_ENGINE_CONNECTION_NOTE}`,
      shortfallAmount: coldStorage.overCapacityTons,
      shortfallUnitLabel: "トン",
    });
  } else if (coldStorage.isTight) {
    warnings.push({
      kind: "coldStorageOverCapacity",
      label: PLANNING_WARNING_LABELS.coldStorageOverCapacity,
      sentence: `完成品在庫が冷凍・冷蔵保管能力の${((coldStorage.utilizationRate ?? 0) * 100).toFixed(1)}%に達しています（空き ${coldStorage.freeTons.toFixed(2)} トン）。${COLD_STORAGE_ENGINE_CONNECTION_NOTE}`,
      shortfallAmount: coldStorage.freeTons,
      shortfallUnitLabel: "トン",
    });
  }

  if (factorySpace.reservedByPendingSpaceUnits > 0) {
    warnings.push({
      kind: "investmentNotAvailableYet",
      label: PLANNING_WARNING_LABELS.investmentNotAvailableYet,
      sentence:
        "建設中・完成準備中の投資案件があります。これらは工場スペースをすでに予約していますが、稼働開始四半期までは生産能力として使えません。",
      shortfallAmount: factorySpace.reservedByPendingSpaceUnits,
      shortfallUnitLabel: "スペース単位（予約中）",
    });
  }

  warnings.push({
    kind: "engineNotConnected",
    label: PLANNING_WARNING_LABELS.engineNotConnected,
    sentence:
      "品質管理設備・排水環境設備は、現時点では資産と費用としてのみ実装されており、品質・事故・行政処分への効果はエンジンへ未接続です。冷凍・冷蔵保管能力も、超過時の強制的な制約は未接続です。各投資カードの「未実装の効果」欄を必ず確認してください。",
  });

  return {
    companyId: input.companyId,
    period: input.period,
    forecast,
    workforceRows,
    factorySpace,
    coldStorage,
    investmentCards,
    warnings,
    chainExplanationSteps: [
      "① 生産計画（工場×商品の希望量と優先度）を入力する",
      "② その希望量を処理するのに必要な設備能力（共通前処理・商品別・凍結包装）が決まる",
      "③ 同じ希望量を処理するのに必要なWorker人数が決まる",
      "④ 設備を置くために必要な工場スペースが決まる",
      "⑤ 足りない能力（＝処理見込みが減っている原因）が分かる",
      "⑥ その不足を埋める投資案件を選ぶ",
      "⑦ 投資は完成・稼働開始してから能力になる（当期には増えない）",
      "⑧ 増分費用（分割払い・保守費・減価償却・追加人件費）が発生する",
      "⑨ 投資完成後に追加で処理できる量が分かる",
    ],
    freezingVsStorageExplanation: FREEZING_VS_STORAGE_EXPLANATION_TEXT,
    workforceNotModeledNote: WORKFORCE_NOT_MODELED_NOTE,
  };
}

/**
 * 投資回収の算定。
 *
 * 【売上ではなく増分キャッシュフローを使う理由】実装指示 Phase 8D-2 のとおり、
 * 単純な売上増を根拠にすると、原料費・加工費・物流費を無視した過大な回収年数に
 * なる。そこで「直近確定四半期の実績限界利益 ÷ 実績販売トン」で1トンあたりの
 * 限界利益を求め、増分処理量に掛ける。そこから増分保守費を引いたものを
 * 増分キャッシュフローとする（減価償却費は非現金支出なので引かない）。
 *
 * 【算定できない場合に数値を作らない】直近確定四半期が無い（初回四半期）、
 * 販売実績が0、増分処理量が0、増分キャッシュフローが0以下、のいずれでも
 * 回収年数は算出せず、理由つきで「算定対象外」を返す。
 */
export function buildPaybackEstimate(input: {
  readonly totalInvestmentUsd: number;
  readonly incrementalProcessableTonsPerQuarter: number;
  readonly contributionMarginUsdPerTon: number | undefined;
  readonly incrementalMaintenanceUsdPerQuarter: number;
  /** 増分処理量を処理するために追加で必要になる常用Worker人数（整数）。 */
  readonly incrementalRegularHeadcount: number;
  /** 上記の四半期人件費（USD/四半期）。 */
  readonly incrementalLaborCostUsdPerQuarter: number;
  readonly hasLastQuarterResult: boolean;
  readonly noEffectReason: string | undefined;
}): PaybackEstimate {
  const formulaText =
    "概算投資回収年数 ＝ 投資総額 ÷ （増分処理可能量 × 実績限界利益/販売トン − 増分四半期保守費 − 増分Worker四半期人件費） ÷ 4四半期";
  const assumptionTexts: readonly string[] = [
    "限界利益は、直近の確定四半期の実績（限界利益額 ÷ 販売トン）をそのまま使っています。将来の価格・原料費の変化は織り込んでいません。",
    "増分処理可能量は、現在の入力のまま能力だけを増やして生産エンジンへ再度渡した結果の差です（推測式ではありません）。",
    "減価償却費は現金の支出ではないため、増分キャッシュフローから差し引いていません。",
    "増分処理量を処理するために追加で必要になる常用Workerの人件費は、増分キャッシュフローから差し引いています（下記の二重控除の確認を参照）。",
    "追加Worker人数は「投資後に必要な人数 − 現在人数」と「投資前に必要な人数 − 現在の人数」の差であり、設備投資によって新たに発生する採用人数だけです。現在の人員に余力がある場合は0人、投資前から存在する不足人数も含めません。",
    "増えた処理量は常用Workerで処理する前提で人数を算出しています。残業や臨時ワーカーで吸収する場合、その費用はすでに限界利益側で控除済みです。",
    "売上増加そのものを根拠にはしていません。販売できるかどうかは営業の成約次第です。",
  ];

  const base = {
    incrementalProcessableTonsPerQuarter: input.incrementalProcessableTonsPerQuarter,
    incrementalMaintenanceUsdPerQuarter: input.incrementalMaintenanceUsdPerQuarter,
    incrementalLaborCostUsdPerQuarter: input.incrementalLaborCostUsdPerQuarter,
    incrementalRegularHeadcount: input.incrementalRegularHeadcount,
    formulaText,
    assumptionTexts,
    doubleCountingNote: PAYBACK_DOUBLE_COUNTING_NOTE,
  };

  if (input.incrementalProcessableTonsPerQuarter <= 0) {
    return {
      ...base,
      isComputable: false,
      notComputableReason:
        input.noEffectReason ?? "この投資では現在の入力に対して処理可能量が増えないため、現在の実装では算定対象外です。",
    };
  }
  if (!input.hasLastQuarterResult || input.contributionMarginUsdPerTon === undefined) {
    return {
      ...base,
      isComputable: false,
      notComputableReason:
        "直近の確定四半期の販売実績がまだないため、1トンあたりの限界利益を実績から求められません。現在の実装では算定対象外です（推測値は使いません）。",
    };
  }

  const incrementalContributionUsdPerQuarter = input.incrementalProcessableTonsPerQuarter * input.contributionMarginUsdPerTon;
  const incrementalCashFlowUsdPerQuarter =
    incrementalContributionUsdPerQuarter - input.incrementalMaintenanceUsdPerQuarter - input.incrementalLaborCostUsdPerQuarter;

  if (!(incrementalCashFlowUsdPerQuarter > 0)) {
    return {
      ...base,
      isComputable: false,
      contributionMarginUsdPerTon: input.contributionMarginUsdPerTon,
      incrementalContributionUsdPerQuarter,
      incrementalCashFlowUsdPerQuarter,
      notComputableReason:
        "増分の限界利益が、増分保守費と増分Worker人件費の合計を上回らないため、この前提では投資を回収できません（回収年数は算定できません）。",
    };
  }

  const paybackYears = input.totalInvestmentUsd / (incrementalCashFlowUsdPerQuarter * 4);
  return {
    ...base,
    isComputable: true,
    contributionMarginUsdPerTon: input.contributionMarginUsdPerTon,
    incrementalContributionUsdPerQuarter,
    incrementalCashFlowUsdPerQuarter,
    paybackYears: Number.isFinite(paybackYears) && paybackYears > 0 ? paybackYears : undefined,
  };
}
