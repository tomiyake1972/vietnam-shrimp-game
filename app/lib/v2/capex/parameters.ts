// ShrimpX V2 — 設備投資モジュール パラメータ定義（Phase 8B-2A、Phase 8B-2Bで拡張）
//
// finance/parameters.ts・financing/parameters.tsと同じ方針で、係数を1ファイルへ
// 集約する。すべて「Phase 8B-2A新規・要校正」の暫定値であり、Phase 8B-2B以降の
// 経済校正で再検討する前提とする（実装指示§31「以下は停止せず、合理的な
// 初期値で前進してください」に列挙された項目はすべて本ファイルの値である）。
//
// 【Phase 8B-2B追加】usefulLifeQuarters（案件種別ごとの耐用年数・四半期数）・
// maintenanceRatePerQuarter（案件種別ごとの四半期固定保守費率、
// capitalizedAmountUsd×この率）を追加。いずれも案件固有の永続フィールドには
// せず、projectType経由でこのテンプレートから毎期導出する（実装指示§4「耐用
// 年数は案件固有の永続フィールドにはせず、テンプレート値から導出」）。
// 既存のfutureCapacityEffect（capacityIncreaseTonsPerQuarter・targetProduct・
// readinessQuartersAfterCompletion）は承認時にCapitalProjectへスナップショット
// コピーされる既存設計のままとし、usefulLifeQuarters・maintenanceRatePerQuarterは
// あえてスナップショットせず、常に「現在のテンプレート値」を毎期ライブ参照する
// （将来の経済校正でこれらの値を変更した場合、既存案件にも遡って新しい値が
// 適用される。readiness/能力効果はスナップショットで不変・耐用年数/保守費率は
// ライブ参照、という非対称性は実装指示の要求どおりであり意図的）。

import { CapitalProjectType, FutureCapacityEffectPlaceholder } from "./types";

export interface CapexProjectTemplate {
  readonly projectType: CapitalProjectType;
  readonly displayName: string;
  /** 標準投資額（USD）。CapexProjectProposalInput.requestedBudgetUsd省略時に使う。 */
  readonly standardBudgetUsd: number;
  /** 標準工期（四半期）。paymentRatios.lengthと必ず一致させる（実装指示§16の設計上の単純化。docs参照）。 */
  readonly standardConstructionQuarters: number;
  /** 四半期ごとの予定支払比率（合計1.0、要素数=standardConstructionQuarters）。 */
  readonly paymentRatios: readonly number[];
  readonly assetCategory: "productionEquipment" | "storageEquipment" | "qualityEquipment" | "environmentalEquipment";
  /**
   * 完成後、稼働開始まで待つ想定四半期数。稼働開始四半期
   * （operationalStartPeriod = completedPeriodの翌四半期 + この値）から、
   * 能力増加・新規capex資産の減価償却・固定保守費がすべて同時に発生する
   * （Phase 8B-2B、実装指示§3.2「原則として同じoperationalStartPeriodに統一」）。
   */
  readonly postCompletionReadinessQuarters: number;
  /**
   * 【Phase 8B-2B】新規完成資産の耐用年数（四半期数）。定額法の分母
   * （capitalizedAmountUsd ÷ usefulLifeQuarters）。既存レガシー資産の定率法
   * （finance/parameters.tsのdepreciationRatePerQuarter=0.025、四半期当たり
   * 粗取得原価の2.5%）に相当する耐用年数40四半期（10年）を、生産設備の基準値
   * として踏襲した。倉庫・環境設備は耐用年数を長め、精密機器は短めに校正。
   */
  readonly usefulLifeQuarters: number;
  /**
   * 【Phase 8B-2B】四半期固定保守費率。quarterlyMaintenanceUsd =
   * capitalizedAmountUsd × maintenanceRatePerQuarter。一般的な工業設備の
   * 年間保守費（取得原価比2〜5%程度）を四半期換算した暫定値（要校正）。
   */
  readonly maintenanceRatePerQuarter: number;
  /** Phase 8B-2Bで能力増加・稼働開始時期の算出に使う予約メタデータ。 */
  readonly futureCapacityEffect: FutureCapacityEffectPlaceholder;
}

export interface CapexParameters {
  readonly parametersVersion: string;
  readonly templatesByType: Readonly<Record<CapitalProjectType, CapexProjectTemplate>>;
  /** 設備投資可能額算出の基準となる最低現金準備額（USD）。実装指示§14の6段階配分の起点。 */
  readonly minimumCashReserveUsd: number;
  /** 会社ごとの同時進行中案件数の上限（proposed以外＝approved/underConstruction/suspendedの合計）。 */
  readonly maxConcurrentActiveProjectsPerCompany: number;
  /** 貸借一致・CF一致等の検証に使う許容誤差（USD）。 */
  readonly epsilonUsd: number;
}

function template(
  projectType: CapitalProjectType,
  displayName: string,
  standardBudgetUsd: number,
  paymentRatios: readonly number[],
  assetCategory: CapexProjectTemplate["assetCategory"],
  postCompletionReadinessQuarters: number,
  usefulLifeQuarters: number,
  maintenanceRatePerQuarter: number,
  futureCapacityEffect: FutureCapacityEffectPlaceholder
): CapexProjectTemplate {
  return {
    projectType,
    displayName,
    standardBudgetUsd,
    standardConstructionQuarters: paymentRatios.length,
    paymentRatios,
    assetCategory,
    postCompletionReadinessQuarters,
    usefulLifeQuarters,
    maintenanceRatePerQuarter,
    futureCapacityEffect,
  };
}

export const CAPEX_PARAMETERS_V1: CapexParameters = {
  parametersVersion: "capex-v0.2",

  templatesByType: {
    hosoLineExpansion: template(
      "hosoLineExpansion",
      "HOSO加工ライン増設",
      3_000_000,
      [0.3, 0.4, 0.3],
      "productionEquipment",
      1,
      40, // 10年（既存レガシー資産の定率法2.5%/四半期に相当する耐用年数を基準値とした）
      0.0075, // 3%/年（生産ラインの標準的な保守費水準の暫定値）
      { targetProduct: "hoso", capacityIncreaseTonsPerQuarter: 500, readinessQuartersAfterCompletion: 1 }
    ),
    pdLineExpansion: template(
      "pdLineExpansion",
      "PD加工ライン増設",
      4_000_000,
      [0.3, 0.4, 0.3],
      "productionEquipment",
      1,
      40,
      0.0075,
      { targetProduct: "pd", capacityIncreaseTonsPerQuarter: 350, readinessQuartersAfterCompletion: 1 }
    ),
    vapLineExpansion: template(
      "vapLineExpansion",
      "VAP加工ライン増設",
      6_000_000,
      [0.25, 0.35, 0.25, 0.15],
      "productionEquipment",
      2,
      40,
      0.01, // 4%/年（VAPは高付加価値・高複雑度の設備のため、保守費率をやや高めに設定）
      { targetProduct: "vap", capacityIncreaseTonsPerQuarter: 250, readinessQuartersAfterCompletion: 2 }
    ),
    coldStorageExpansion: template(
      "coldStorageExpansion",
      "冷凍・冷蔵保管庫増設",
      2_500_000,
      [0.5, 0.5],
      "storageEquipment",
      1,
      60, // 15年（倉庫・冷凍設備は加工ラインより耐用年数が長い一般的な想定）
      0.005, // 2%/年（保管インフラは加工ラインより保守費率が低い一般的な想定）
      // 【Phase 8B-2B】targetProductをfreezingPackaging（冷凍・包装能力）へ確定し、
      // capacityIncreaseTonsPerQuarterを0から500へ校正した（実装指示§3.4
      // 「coldStorageExpansionを現在の0のままにしてはいけない」）。根拠・初期能力比は
      // 完了報告に記載。
      { targetProduct: "freezingPackaging", capacityIncreaseTonsPerQuarter: 500, readinessQuartersAfterCompletion: 1 }
    ),
    qualityControlEquipment: template(
      "qualityControlEquipment",
      "品質管理設備",
      1_200_000,
      [0.6, 0.4],
      "qualityEquipment",
      0,
      20, // 5年（精密計測・検査機器は加工ラインより耐用年数が短い一般的な想定）
      0.0125, // 5%/年（精密機器は校正・保守頻度が高い一般的な想定）
      // 【実装指示§7】品質・環境設備は今回、生産能力を増加させない
      // （targetProduct省略・capacityIncreaseTonsPerQuarter=0）。固定資産振替・
      // 減価償却・固定保守費は他の案件種別と同様に適用される。品質・環境面の
      // 実際の効果（品質スコア・事故率・規制遵守等への接続）はPhase 8B-2Bの
      // 対象外であり、現時点ではコスト（減価償却＋保守費）のみが発生し操業上の
      // 便益が無い。通常のプレイヤー向け提案候補として安易に推奨される投資では
      // ないことに留意（docs/v2/CAPITAL_INVESTMENT_ARCHITECTURE_v0.1.md参照）。
      { capacityIncreaseTonsPerQuarter: 0, readinessQuartersAfterCompletion: 0 }
    ),
    environmentalEquipment: template(
      "environmentalEquipment",
      "排水・環境設備",
      1_800_000,
      [0.5, 0.5],
      "environmentalEquipment",
      0,
      40, // 10年（規制対応の処理設備。生産設備と同水準の耐用年数の暫定値）
      0.01, // 4%/年（排水・環境処理設備は規制順守目的で保守頻度が高い一般的な想定）
      // 【実装指示§7】品質管理設備と同じ理由で、生産能力は増加させない。
      { capacityIncreaseTonsPerQuarter: 0, readinessQuartersAfterCompletion: 0 }
    ),
    commonProcessingExpansion: template(
      "commonProcessingExpansion",
      "共通前処理能力増設",
      5_000_000,
      [0.3, 0.4, 0.3],
      "productionEquipment",
      1,
      40,
      0.0075,
      // 【Phase 8B-2B新規】HOSO/PD/VAPライン増設からは独立した、共通原料処理
      // 能力（commonProcessingCapacity、全商品が共有する前工程）専用の投資案件。
      // 実装指示§3.1「HOSO・PD・VAP増設によって共通前処理能力を自動的に増加
      // させない」を満たすため、ボトルネック管理を独立した投資判断として学べる
      // 構造にする。予算・工期・保守費率はhosoLineExpansion/pdLineExpansionと
      // 同水準（前工程も本質的には同種の加工設備であるため）。
      { targetProduct: "commonProcessing", capacityIncreaseTonsPerQuarter: 700, readinessQuartersAfterCompletion: 1 }
    ),
  },

  // 5社の初期現金（22M〜35M USD、finance/initialState.ts参照）に対し、通常の
  // 事業運営に必要な現金を圧迫しない程度の暫定値（要校正）。
  minimumCashReserveUsd: 10_000_000,
  maxConcurrentActiveProjectsPerCompany: 3,
  epsilonUsd: 0.01,
};
