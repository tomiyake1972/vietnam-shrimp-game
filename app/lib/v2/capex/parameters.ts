// ShrimpX V2 — 設備投資モジュール パラメータ定義
// （Phase 8B-2A新設、Phase 8B-2Bで操業接続用の値を追加、Phase 8B-2Cで
// 固定資産2区分・コンポーネント別定額法へ拡張）
//
// finance/parameters.ts・financing/parameters.tsと同じ方針で、係数を1ファイルへ
// 集約する。すべて「Phase 8B-2A新規・要校正」の暫定値であり、以降の経済校正で
// 再検討する前提とする。
//
// 【Phase 8B-2C】新規completed資産の減価償却は、単一のusefulLifeQuarters
// （案件種別ごとの耐用年数）による定額法から、建物・機械2区分のコンポーネント別
// 定額法へ置き換えた。usefulLifeQuartersフィールドは削除し（新規案件の永続
// フィールドではなく本ファイルのテンプレート専用の値だったため、後方互換の
// 都合で残す必要がない）、代わりに:
//   - buildingRatio・machineryRatio（案件種別ごとに異なる、取得原価の建物/機械
//     への配分比率。合計は必ず1）
//   - componentUsefulLifeQuarters（建物100四半期・機械40四半期。案件種別に
//     関わらず固定資産区分自体に一意に定まる耐用年数のため、テンプレートごとの
//     重複定義を避けCapexParameters直下へ一元化）
// を追加した。maintenanceRatePerQuarter（固定保守費率）は変更していない
// （実装指示§8「固定保守費の計算は原則として変更しない」）。
//
// 既存のfutureCapacityEffect（capacityIncreaseTonsPerQuarter・targetProduct・
// readinessQuartersAfterCompletion）は承認時にCapitalProjectへスナップショット
// コピーされる既存設計のままとし、buildingRatio・machineryRatio・
// maintenanceRatePerQuarterはあえてスナップショットせず、常に「現在のテンプレート
// 値」を毎期ライブ参照する（将来の経済校正でこれらの値を変更した場合、既存案件にも
// 遡って新しい値が適用される。readiness/能力効果はスナップショットで不変・
// 構成比/保守費率はライブ参照、という非対称性は実装指示の要求どおりであり意図的）。

import { CapexValidationError, CapitalProjectType, FutureCapacityEffectPlaceholder } from "./types";

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
   * 【Phase 8B-2C】案件総額（capitalizedAmountUsd）のうち、建物・構築物区分への
   * 配分比率（0〜1）。machineryRatioとの合計は必ず1（CAPEX_PARAMETERS_V1読み込み
   * 時にassertValidComponentRatiosで検証する）。個別の設備・工事内訳を再現する
   * ものではなく、ゲーム上「投資の違いが見える」程度に単純化した簡便配分。
   */
  readonly buildingRatio: number;
  /** 案件総額のうち機械・設備区分への配分比率（0〜1）。buildingRatio + machineryRatio = 1。 */
  readonly machineryRatio: number;
  /**
   * 四半期固定保守費率。quarterlyMaintenanceUsd =
   * capitalizedAmountUsd × maintenanceRatePerQuarter。一般的な工業設備の
   * 年間保守費（取得原価比2〜5%程度）を四半期換算した暫定値（要校正）。
   * 【Phase 8B-2C】建物・機械へ分解する必要はなく、案件総額に対する率のまま
   * 維持する（実装指示§8「保守費を建物部分と機械部分に分解する必要はない」）。
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
  /**
   * 【Phase 8B-2C】新規capex資産・コンポーネント別の耐用年数（四半期数）。
   * 案件種別に関わらず、固定資産区分（建物・機械）自体に一意に定まる値のため
   * テンプレートごとに重複定義せずここへ集約する（実装指示「資産区分とゲーム上の
   * 耐用年数は次の2つだけとします」）。
   */
  readonly componentUsefulLifeQuarters: {
    /** 建物・構築物の耐用年数（四半期数、25年）。 */
    readonly building: number;
    /** 機械・設備の耐用年数（四半期数、10年）。 */
    readonly machinery: number;
  };
}

function template(
  projectType: CapitalProjectType,
  displayName: string,
  standardBudgetUsd: number,
  paymentRatios: readonly number[],
  assetCategory: CapexProjectTemplate["assetCategory"],
  postCompletionReadinessQuarters: number,
  buildingRatio: number,
  machineryRatio: number,
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
    buildingRatio,
    machineryRatio,
    maintenanceRatePerQuarter,
    futureCapacityEffect,
  };
}

/**
 * 【Phase 8B-2C】各テンプレートのbuildingRatio + machineryRatioが厳密に1になっている
 * ことを検証する（浮動小数点誤差を許容するepsilon比較）。CAPEX_PARAMETERS_V1の
 * 定義直後にモジュール読み込み時点で実行し、値の校正ミスを即座に検知する。
 */
const COMPONENT_RATIO_EPSILON = 1e-9;
function assertValidComponentRatios(templatesByType: Readonly<Record<CapitalProjectType, CapexProjectTemplate>>): void {
  for (const t of Object.values(templatesByType)) {
    const sum = t.buildingRatio + t.machineryRatio;
    if (Math.abs(sum - 1) > COMPONENT_RATIO_EPSILON) {
      throw new CapexValidationError(
        `capex/parameters.ts: ${t.projectType} の buildingRatio(${t.buildingRatio}) + machineryRatio(${t.machineryRatio}) が1になりません（実際の合計: ${sum}）。`
      );
    }
  }
}

export const CAPEX_PARAMETERS_V1: CapexParameters = {
  parametersVersion: "capex-v0.3",

  templatesByType: {
    hosoLineExpansion: template(
      "hosoLineExpansion",
      "HOSO加工ライン増設",
      3_000_000,
      [0.3, 0.4, 0.3],
      "productionEquipment",
      1,
      0.2, // 建物20%（生産ラインは大部分が機械設備という一般的な想定）
      0.8, // 機械80%
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
      0.2,
      0.8,
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
      0.25, // 建物25%（VAPは高付加価値・高複雑度設備で建屋要件もやや高いという想定）
      0.75,
      0.01, // 4%/年（VAPは高付加価値・高複雑度の設備のため、保守費率をやや高めに設定）
      { targetProduct: "vap", capacityIncreaseTonsPerQuarter: 250, readinessQuartersAfterCompletion: 2 }
    ),
    // 【Phase 8D-5】保管（ストック）側へ再接続。Phase 8D以前は誤って
    // targetProduct: "freezingPackaging"（＝四半期あたりの処理量）を増やしていたため、
    // 「冷凍能力」がフローなのかストックなのか画面上で判別できなかった。
    // 投資額は実装指示の目安（保管1トンあたり USD 1,500〜2,500）の中央付近になるよう
    // 校正した: 2,500,000 USD ÷ 1,250 t = **2,000 USD/保管トン**。
    coldStorageExpansion: template(
      "coldStorageExpansion",
      "冷凍・冷蔵保管庫増設",
      2_500_000,
      [0.5, 0.5],
      "storageEquipment",
      1,
      0.4, // 建物40%（倉庫・保管庫は建屋比率が加工ラインより高いという一般的な想定）
      0.6, // 機械60%（冷凍・冷却設備）
      0.005, // 2%/年（保管インフラは加工ラインより保守費率が低い一般的な想定）
      { targetProduct: "coldStorage", capacityIncreaseTonsPerQuarter: 1_250, readinessQuartersAfterCompletion: 1 }
    ),
    // 【Phase 8D-5新規】凍結・包装処理能力（フロー、トン/四半期）専用の投資案件。
    // coldStorageExpansionが保管（ストック）側へ移ったため、生産エンジンの段階3が
    // 使う上限（allocation.tsのfreezingPackaging）を増やす手段としてこちらを新設する。
    // 予算・工期・構成比・保守費率はhosoLineExpansion（同種の加工設備）と同水準。
    freezingPackagingExpansion: template(
      "freezingPackagingExpansion",
      "凍結・包装処理能力増設",
      2_800_000,
      [0.4, 0.6],
      "productionEquipment",
      1,
      0.25, // 建物25%（凍結トンネル・包装ラインは建屋要件がやや高い）
      0.75,
      0.0075, // 3%/年（生産ラインと同水準）
      { targetProduct: "freezingPackaging", capacityIncreaseTonsPerQuarter: 800, readinessQuartersAfterCompletion: 1 }
    ),
    qualityControlEquipment: template(
      "qualityControlEquipment",
      "品質管理設備",
      1_200_000,
      [0.6, 0.4],
      "qualityEquipment",
      0,
      0, // 建物0%（精密計測・検査機器そのものであり、専用建屋を要しない想定）
      1, // 機械100%
      0.0125, // 5%/年（精密機器は校正・保守頻度が高い一般的な想定）
      // 【実装指示§7】品質・環境設備は今回、生産能力を増加させない
      // （targetProduct省略・capacityIncreaseTonsPerQuarter=0）。固定資産振替・
      // 減価償却・固定保守費は他の案件種別と同様に適用される。品質・環境面の
      // 実際の効果（品質スコア・事故率・規制遵守等への接続）は対象外であり、
      // 現時点ではコスト（減価償却＋保守費）のみが発生し操業上の便益が無い。
      // 通常のプレイヤー向け提案候補として安易に推奨される投資ではないことに
      // 留意（docs/v2/CAPITAL_INVESTMENT_ARCHITECTURE_v0.1.md参照）。
      { capacityIncreaseTonsPerQuarter: 0, readinessQuartersAfterCompletion: 0 }
    ),
    environmentalEquipment: template(
      "environmentalEquipment",
      "排水・環境設備",
      1_800_000,
      [0.5, 0.5],
      "environmentalEquipment",
      0,
      0.3, // 建物30%（処理槽等の構築物を伴うため品質管理設備よりは高め）
      0.7,
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
      0.2,
      0.8,
      0.0075,
      // 【Phase 8B-2B新規】HOSO/PD/VAPライン増設からは独立した、共通原料処理
      // 能力（commonProcessingCapacity、全商品が共有する前工程）専用の投資案件。
      // 実装指示§3.1「HOSO・PD・VAP増設によって共通前処理能力を自動的に増加
      // させない」を満たすため、ボトルネック管理を独立した投資判断として学べる
      // 構造にする。予算・工期・保守費率・建物/機械構成比はhosoLineExpansion/
      // pdLineExpansionと同水準（前工程も本質的には同種の加工設備であるため）。
      { targetProduct: "commonProcessing", capacityIncreaseTonsPerQuarter: 700, readinessQuartersAfterCompletion: 1 }
    ),
  },

  // 5社の初期現金（22M〜35M USD、finance/initialState.ts参照）に対し、通常の
  // 事業運営に必要な現金を圧迫しない程度の暫定値（要校正）。
  minimumCashReserveUsd: 10_000_000,
  maxConcurrentActiveProjectsPerCompany: 3,
  epsilonUsd: 0.01,

  // 【Phase 8B-2C】建物25年（100四半期）・機械10年（10年=40四半期）。
  // 既存レガシー資産の旧・定率法(実質は取得原価一律2.5%/四半期=10年均等)が
  // 案件種別を問わず単一の耐用年数だったのに対し、新規capex資産はコンポーネントの
  // 種類（建物 or 機械）だけで耐用年数が決まり、案件種別（HOSO/PD/VAP/...）には
  // 依存しない、という実装指示の方針に従う。
  componentUsefulLifeQuarters: { building: 100, machinery: 40 },
};

assertValidComponentRatios(CAPEX_PARAMETERS_V1.templatesByType);
