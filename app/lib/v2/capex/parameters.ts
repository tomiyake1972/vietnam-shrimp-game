// ShrimpX V2 — 設備投資モジュール パラメータ定義（Phase 8B-2A）
//
// finance/parameters.ts・financing/parameters.tsと同じ方針で、係数を1ファイルへ
// 集約する。すべて「Phase 8B-2A新規・要校正」の暫定値であり、Phase 8B-2B以降の
// 経済校正で再検討する前提とする（実装指示§31「以下は停止せず、合理的な
// 初期値で前進してください」に列挙された項目はすべて本ファイルの値である）。

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
  /** 完成後、稼働開始まで待つ想定四半期数（Phase 8B-2Aでは記録のみ。稼働開始自体の効果は8B-2B）。 */
  readonly postCompletionReadinessQuarters: number;
  /** Phase 8B-2B用の予約メタデータ（8B-2Aでは一切参照・使用しない）。 */
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
    futureCapacityEffect,
  };
}

export const CAPEX_PARAMETERS_V1: CapexParameters = {
  parametersVersion: "capex-v0.1",

  templatesByType: {
    hosoLineExpansion: template(
      "hosoLineExpansion",
      "HOSO加工ライン増設",
      3_000_000,
      [0.3, 0.4, 0.3],
      "productionEquipment",
      1,
      { targetProduct: "hoso", capacityIncreaseTonsPerQuarter: 500, readinessQuartersAfterCompletion: 1 }
    ),
    pdLineExpansion: template(
      "pdLineExpansion",
      "PD加工ライン増設",
      4_000_000,
      [0.3, 0.4, 0.3],
      "productionEquipment",
      1,
      { targetProduct: "pd", capacityIncreaseTonsPerQuarter: 350, readinessQuartersAfterCompletion: 1 }
    ),
    vapLineExpansion: template(
      "vapLineExpansion",
      "VAP加工ライン増設",
      6_000_000,
      [0.25, 0.35, 0.25, 0.15],
      "productionEquipment",
      2,
      { targetProduct: "vap", capacityIncreaseTonsPerQuarter: 250, readinessQuartersAfterCompletion: 2 }
    ),
    coldStorageExpansion: template(
      "coldStorageExpansion",
      "冷凍・冷蔵保管庫増設",
      2_500_000,
      [0.5, 0.5],
      "storageEquipment",
      1,
      { targetProduct: "common", capacityIncreaseTonsPerQuarter: 0, readinessQuartersAfterCompletion: 1 }
    ),
    qualityControlEquipment: template(
      "qualityControlEquipment",
      "品質管理設備",
      1_200_000,
      [0.6, 0.4],
      "qualityEquipment",
      0,
      { targetProduct: "common", capacityIncreaseTonsPerQuarter: 0, readinessQuartersAfterCompletion: 0 }
    ),
    environmentalEquipment: template(
      "environmentalEquipment",
      "排水・環境設備",
      1_800_000,
      [0.5, 0.5],
      "environmentalEquipment",
      0,
      { targetProduct: "common", capacityIncreaseTonsPerQuarter: 0, readinessQuartersAfterCompletion: 0 }
    ),
  },

  // 5社の初期現金（22M〜35M USD、finance/initialState.ts参照）に対し、通常の
  // 事業運営に必要な現金を圧迫しない程度の暫定値（要校正）。
  minimumCashReserveUsd: 10_000_000,
  maxConcurrentActiveProjectsPerCompany: 3,
  epsilonUsd: 0.01,
};
