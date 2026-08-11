// ShrimpX V2 — 設備投資モジュール 型定義（Phase 8B-2A）
//
// 設備投資案件（承認→着工→分割支払→建設中→完成・稼働開始）の状態遷移と、
// finance/へのCapexAdjustment接続を扱う。本モジュールはPhase 8B-2Aの範囲に
// 厳密に限定する。新規生産能力の即時増加・新設備の減価償却開始・追加人員・
// 段階固定費・設備専用融資・投資採算（NPV/IRR等）はすべてPhase 8B-2Bの対象
// であり、本モジュールは一切実装しない（docs/v2/CAPITAL_INVESTMENT_ARCHITECTURE_v0.1.md
// §Phase 8B-2Bとの境界 参照）。
//
// 【設計方針】
//   - 建設中勘定（CIP）はCompanyFinanceStateへ新規必須フィールドを追加せず、
//     本モジュール専用のCompanyCapexStateを唯一の真実として保持する
//     （financing/のCompanyFinancingStateが融資ポートフォリオを保持する構造と
//     同じ前例に従う）。fixedAssetsGross・現金・投資CF等への反映は、finance/の
//     closeFinancialQuarterへCapexAdjustment（finance/types.ts）として渡す
//     「ending値」接続方式（financingの融資残高接続と同じ設計）。
//   - 分割支払は全額支払のみ（一部支払は無い）。支払えなければ着工前は
//     approvedのまま、着工後はsuspendedへ遷移する。
//   - 構造的な誤用（存在しない案件ID参照・状態不整合な取消/再開要求）は
//     CapexValidationErrorを投げる。会社の資金繰り・信用状態による新規承認
//     拒否や、当四半期の支払見送りは、投げずに診断理由つきの結果として返す
//     （financing/のFinancingValidationErrorと同じ区分。docs参照）。

import { PeriodV2 } from "../core/period";
import { CompanyId } from "../sales/types";

export class CapexValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapexValidationError";
  }
}

// ---------------------------------------------------------------------
// 1. 投資案件の種類・状態
// ---------------------------------------------------------------------

/**
 * 最低6種類（実装指示§8）＋Phase 8B-2Bで追加した共通前処理能力増設の7種類。
 * 【Phase 8B-2B】commonProcessingExpansionを追加。HOSO/PD/VAPライン増設は
 * 前処理能力（commonProcessingCapacity）を自動的に増加させない（意図的にボトルネック
 * 管理を独立させる設計。capacityEffect.tsのターゲット対応表を参照）。
 */
export type CapitalProjectType =
  | "hosoLineExpansion" // HOSO加工ライン増設
  | "pdLineExpansion" // PD加工ライン増設
  | "vapLineExpansion" // VAP加工ライン増設
  | "coldStorageExpansion" // 冷凍・冷蔵保管庫増設（【Phase 8D-5】保管能力＝ストック側へ再接続）
  | "qualityControlEquipment" // 品質管理設備
  | "environmentalEquipment" // 排水・環境設備
  | "commonProcessingExpansion" // 【Phase 8B-2B】共通前処理能力増設
  | "freezingPackagingExpansion" // 【Phase 8D-5】凍結・包装処理能力増設（フロー側）
  | "newFactoryConstruction" // 【Test15新設】新工場建設（標準工場）。既存工場の能力増強ではなく、
  // Factory[]へ新しい工場そのものを追加する（capex/factoryConstruction.ts参照）。
  | "pdMechanization"; // 【Test15新設】PD省人化投資（機械化）。特定factoryIdを対象とし、
  // そのFactoryのPD労働集約度係数のみを引き下げる（capex/pdMechanization.ts参照）。
  // PD生産能力そのものは増やさない。HOSO/VAPには一切影響しない。

export const CAPITAL_PROJECT_TYPES: readonly CapitalProjectType[] = [
  "hosoLineExpansion",
  "pdLineExpansion",
  "vapLineExpansion",
  "commonProcessingExpansion",
  "freezingPackagingExpansion",
  "coldStorageExpansion",
  "qualityControlEquipment",
  "environmentalEquipment",
  "newFactoryConstruction",
  "pdMechanization",
];

/** 最低6状態（実装指示§10）。 */
export type CapitalProjectStatus = "proposed" | "approved" | "underConstruction" | "suspended" | "completed" | "cancelled";

export const CAPITAL_PROJECT_STATUSES: readonly CapitalProjectStatus[] = [
  "proposed",
  "approved",
  "underConstruction",
  "suspended",
  "completed",
  "cancelled",
];

/**
 * "proposed"は提案入力を評価する一瞬だけの過渡的な状態であり、
 * ポートフォリオ（CompanyCapexState.portfolio.projects）へ永続化されることはない
 * （承認されればapprovedとして即座に登録、拒否されればプロジェクトとして
 * 一切登録せずCapexQuarterResult.rejectedProposalsへ理由だけを記録する。
 * これにより自動方針が何も提案しない通常運用では状態が一切肥大しない）。
 */

// ---------------------------------------------------------------------
// 2. 分割支払スケジュール・投資案件
// ---------------------------------------------------------------------

/** 1回の分割支払（四半期ごとの予定比率）。実際に支払われたかはCapitalProject.completedPaymentStagesCountが真実。 */
export interface PaymentScheduleStage {
  readonly stageIndex: number;
  /** 承認済み予算に対するこの回の予定支払比率（0〜1、全stageの合計は1.0）。 */
  readonly plannedRatio: number;
}

/**
 * 能力効果メタデータ。承認時にテンプレート（capex/parameters.ts）から機械的に
 * コピーされ、案件のライフサイクル全体を通じて不変（後からテンプレートを校正
 * しても、すでに承認済みの案件の効果は変わらない。paymentSchedule等と同じ
 * 「承認時スナップショット」設計）。
 *
 * 【Phase 8B-2B】capex/capacityEffect.tsが、status==="completed"かつ
 * 稼働開始四半期（operationalStartPeriod）に達した案件についてのみ、
 * targetProductに応じてFactoryの対応する能力フィールドへcapacityIncreaseTonsPerQuarterを
 * 加算する。対応表: hoso→hosoCapacity、pd→pdCapacity、vap→vapCapacity、
 * commonProcessing→commonProcessingCapacity（前処理・共通工程）、
 * freezingPackaging→freezingPackagingCapacity（冷凍・包装）。
 * qualityControlEquipment・environmentalEquipmentはtargetProduct省略・
 * capacityIncreaseTonsPerQuarter=0（生産能力を増加させない。品質・環境上の
 * 実効果はPhase 8B-2Bの対象外）。
 */
export interface FutureCapacityEffectPlaceholder {
  /**
   * 増強対象の能力プール。
   * 【Phase 8D-5】"coldStorage"（冷凍・冷蔵保管能力＝ストック）を追加した。
   * "freezingPackaging" は凍結・包装処理能力（フロー、トン/四半期）であり、
   * "coldStorage" は同時保管可能量（ストック、トン）である。両者は別物なので
   * 混同しないこと。
   *
   * 【後方互換】この値は案件の承認時にスナップショットされるため、Phase 8D以前に
   * 承認済みの coldStorageExpansion 案件は "freezingPackaging" を保持したままであり、
   * 稼働開始時にはこれまでどおり凍結・包装処理能力を増加させる（既存の確定挙動を
   * 遡って変えない）。
   */
  readonly targetProduct?: "hoso" | "pd" | "vap" | "commonProcessing" | "freezingPackaging" | "coldStorage";
  readonly capacityIncreaseTonsPerQuarter?: number;
  readonly readinessQuartersAfterCompletion?: number;
}

/**
 * 【Test15新設】新工場建設（newFactoryConstruction）専用の効果メタデータ。
 * 既存のFutureCapacityEffectPlaceholder（targetProduct1個への加算）とは異なり、
 * 完成・稼働開始時にFactory[]へ丸ごと1つ新しいFactoryを追加するために必要な
 * 全能力プールの満稼働（フルランプ）時の値をまとめて持つ。承認時にテンプレート
 * （capex/parameters.ts）から機械的にコピーされ、案件のライフサイクル全体を通じて
 * 不変（futureCapacityEffectと同じ「承認時スナップショット」設計）。
 * 実際のFactory合成・段階的ランプアップの適用はcapex/factoryConstruction.tsが行う。
 */
export interface NewFactoryEffectPlaceholder {
  /** フルランプ（3四半期目以降）時の各能力プール（HOSO換算トン/四半期。coldStorageのみ同時保管トン）。 */
  readonly fullCapacities: {
    readonly commonProcessing: number;
    readonly hoso: number;
    readonly pd: number;
    readonly vap: number;
    readonly freezingPackaging: number;
    readonly coldStorage: number;
  };
  /** 稼働開始からの経過四半期（0始まり）ごとの実効能力倍率。配列末尾を超える四半期は最後の値を使う。 */
  readonly rampMultipliers: readonly number[];
}

/**
 * 1件の設備投資案件。cumulativePaidUsdが建設中勘定（CIP）の唯一の真実。
 *   「着工」= 最初のstage支払が全額実行された時点（approved→underConstruction）。
 *   「完成」= 全stage支払完了 かつ cumulativePaidUsd=approvedBudgetUsd かつ
 *            実際に支払が成功した四半期数がrequiredConstructionQuarters以上に
 *            達した時点（暦上の完成予定期ではない。実装指示§16）。
 */
export interface CapitalProject {
  readonly projectId: string;
  readonly companyId: CompanyId;
  readonly projectType: CapitalProjectType;
  readonly approvedBudgetUsd: number;
  /** 四半期ごとの予定支払比率（承認時にテンプレートから確定、合計1.0）。 */
  readonly paymentSchedule: readonly PaymentScheduleStage[];
  /** 実際に支払が成功した回数（＝分割支払の進捗。一部支払は無いため必ず整数個ぶん進む）。 */
  readonly completedPaymentStagesCount: number;
  /** これまでの現金支払累計（＝建設中勘定残高。完成時に固定資産へ振替える）。 */
  readonly cumulativePaidUsd: number;
  /** 実際に支払が成功した四半期数（＝着工後、支払が成功した四半期のカウント。suspended中は増えない）。 */
  readonly elapsedConstructionQuartersWithPayment: number;
  /** 完成に必要な、支払成功四半期数（テンプレートの標準工期。暦期間ではない）。 */
  readonly requiredConstructionQuarters: number;
  readonly status: CapitalProjectStatus;
  readonly proposedPeriod: PeriodV2;
  readonly approvedPeriod: PeriodV2;
  readonly constructionStartedPeriod?: PeriodV2;
  readonly completedPeriod?: PeriodV2;
  readonly cancelledPeriod?: PeriodV2;
  /** 完成時に固定資産へ振替えた金額（=cumulativePaidUsd@完成時。診断用に保持し、完成後cumulativePaidUsdは変更しない）。 */
  readonly capitalizedAmountUsd?: number;
  /** 同一会社内の複数案件の処理順位（小さいほど優先。既定は提案順に自動付与）。 */
  readonly priority: number;
  /** Phase 8B-2B用の予約フィールド（8B-2Aでは一切参照・使用しない）。 */
  readonly futureCapacityEffect?: FutureCapacityEffectPlaceholder;
  /** 【Test15新設】newFactoryConstruction案件のみ設定される、新設Factory合成用の承認時スナップショット。 */
  readonly newFactoryEffect?: NewFactoryEffectPlaceholder;
  /**
   * 【Test15新設・複数工場CAPEX Targeting修正で全案件種別へ拡張】この案件が
   * 対象とする特定のFactoryId。pdMechanization案件は必須（会社単位ではなく
   * 工場単位の投資のため）。common processing / freezing・packaging /
   * HOSO・PD・VAP line expansion 等の他のFactory-specific CAPEXでも、
   * 会社が複数Factoryを持つ場合はこの値で対象Factoryを明示できる（省略時は
   * 従来どおり「その会社の最初のFactory（主工場）」へ適用される。単一Factory
   * 企業・従来案件の挙動は変えない）。newFactoryConstructionは対象Factory
   * 自体を新設するため使わない。
   */
  readonly targetFactoryId?: string;
  /** 直近の意思決定・処理結果の診断メモ（承認拒否理由・支払見送り理由等、直近1件分）。 */
  readonly lastDiagnosticReasons: readonly string[];
}

export interface CapitalProjectPortfolio {
  readonly companyId: CompanyId;
  readonly projects: readonly CapitalProject[];
}

// ---------------------------------------------------------------------
// 3. 会社別の設備投資状態（ターンをまたいで保持）
// ---------------------------------------------------------------------

export interface CompanyCapexState {
  readonly companyId: CompanyId;
  readonly portfolio: CapitalProjectPortfolio;
  /** 案件ID発行用の連番（会社ごとに単調増加。決定論的なID生成のため、承認された案件でのみ進む）。 */
  readonly nextProjectSequence: number;
}

export interface CapexState {
  readonly companies: readonly CompanyCapexState[];
}

// ---------------------------------------------------------------------
// 4. 意思決定入力（新規提案・取消・再開の希望）
// ---------------------------------------------------------------------

export interface CapexProjectProposalInput {
  readonly projectType: CapitalProjectType;
  /** 省略時はテンプレートの標準投資額（parameters.tsのstandardBudgetUsd）を使う。 */
  readonly requestedBudgetUsd?: number;
  /** 省略時は提案順に自動付与される連番を使う。 */
  readonly priority?: number;
  /**
   * 【Test15新設・複数工場CAPEX Targeting修正で全案件種別へ拡張】この提案が
   * 対象とする特定のFactoryId。pdMechanization提案は必須。他のFactory-specific
   * CAPEXでは省略可（省略時は主工場へ適用。CapitalProject.targetFactoryId参照）。
   */
  readonly targetFactoryId?: string;
}

export interface CapexCancelRequestInput {
  readonly projectId: string;
}

/**
 * suspended状態の案件を再開する意思。着工後のssuspendedはこの明示的な希望が
 * 無い限り当四半期の支払対象に含めない（会社が「もう一度払う」と決めた場合
 * だけ再試行する、という意図的な意思決定を必要とする設計。実装指示§15）。
 */
export interface CapexResumeRequestInput {
  readonly projectId: string;
}

/** 1社・1四半期ぶんの設備投資に関する意思決定。 */
export interface CapexDecisionInput {
  readonly companyId: CompanyId;
  readonly newProjectProposals: readonly CapexProjectProposalInput[];
  readonly cancelRequests: readonly CapexCancelRequestInput[];
  readonly resumeRequests: readonly CapexResumeRequestInput[];
}

// ---------------------------------------------------------------------
// 5. 四半期処理結果
// ---------------------------------------------------------------------

export interface CapexProjectQuarterEvent {
  readonly projectId: string;
  readonly projectType: CapitalProjectType;
  readonly statusBefore: CapitalProjectStatus;
  readonly statusAfter: CapitalProjectStatus;
  readonly paymentAttempted: boolean;
  readonly paymentSucceededUsd: number;
  readonly reasons: readonly string[];
}

export interface CapexRejectedProposal {
  readonly projectType: CapitalProjectType;
  readonly requestedBudgetUsd: number;
  readonly reasons: readonly string[];
}

export interface CapexQuarterResult {
  readonly companyId: CompanyId;
  readonly period: PeriodV2;
  readonly rejectedProposals: readonly CapexRejectedProposal[];
  readonly events: readonly CapexProjectQuarterEvent[];
  /** 当四半期の設備投資に充当可能な現金（設備投資前現金 − 最低現金準備額、負値は0）。 */
  readonly cashAvailableForCapexUsd: number;
  /** 当四半期の現金支払合計（CFIのマイナスの絶対値）。 */
  readonly totalPaidThisQuarterUsd: number;
  /** 当四半期に完成し固定資産へ振替えた金額合計。 */
  readonly completedProjectsTransferUsd: number;
  /** 当四半期末の建設中勘定残高。 */
  readonly endingConstructionInProgressUsd: number;
  /** 当四半期の減価償却対象から除外するprev.fixedAssetsGrossの金額（前四半期までの完成済み分）。 */
  readonly nonDepreciatingCapexGrossAtPeriodStartUsd: number;
  /**
   * 【Phase 8B-2B、Phase 8B-2Cでコンポーネント別合算に変更】当期の稼働開始済み
   * 新規completed資産ぶんの定額法減価償却費合計（建物＋機械。診断用。finance/の
   * depreciationCostは既存資産2区分分とこの値の合算）。
   */
  readonly capexAssetsDepreciationUsd: number;
  /** 【Phase 8B-2C】上記のうち建物・構築物コンポーネント分のみ（診断用）。 */
  readonly capexAssetsBuildingDepreciationUsd: number;
  /** 【Phase 8B-2C】上記のうち機械・設備コンポーネント分のみ（診断用）。 */
  readonly capexAssetsMachineryDepreciationUsd: number;
  /** 【Phase 8B-2B】当期の稼働中completed資産ぶんの固定保守費合計（診断用）。 */
  readonly capexMaintenanceCostUsd: number;
}
