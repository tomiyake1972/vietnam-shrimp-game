// ShrimpX V2 — 工場・ワーカー・生産モジュール パラメータ定義（Phase 6）
//
// Phase5（app/lib/v2/rawMaterials/parameters.ts）と同じ方針で、計算ロジックに
// マジックナンバーを直接書かず、すべての係数をこの1ファイルへ集約する。
// すべて「Phase6新規・要校正」の暫定値であり、ゲームバランス調整フェーズで
// 再検討する前提とする。

import { Product } from "../market/types";

export interface ProductionParameters {
  readonly parametersVersion: string;

  readonly yield: {
    /** 商品別の基準歩留まり（原料HosoEqTons → 完成品HosoEqTons、0〜1）。VAP/PDで異なる値を持てる。 */
    readonly baseYieldRatio: Readonly<Record<Product, number>>;
  };

  readonly capacity: {
    /**
     * ラウンド誤差等で発生しうる微小な負値・オーバーシュートを許容する誤差。
     * rawMaterials/waterFill.tsのEPSILONと同じ考え方（暫定値）。
     */
    readonly epsilon: number;
  };

  readonly labor: {
    /** 正社員・常用ワーカー1人あたりの基準有効生産能力（完成品HosoEqTons/四半期）。 */
    readonly regularEfficiencyPerHeadTons: number;
    /** 臨時ワーカー1人あたりの基準有効生産能力。常用ワーカーより低い値とする。 */
    readonly temporaryEfficiencyPerHeadTons: number;
    /** 残業率の上限（これを超える残業率は切り詰める）。 */
    readonly overtimeRateCap: number;
    /** 残業1単位（overtimeRate=1.0）あたりの能力増加係数（線形近似）。 */
    readonly overtimeEfficiencyFactor: number;
  };

  readonly cost: {
    /** 商品別の基準加工費単価（完成品HosoEqTonsあたり、USD）。記録用・非会計計上。 */
    readonly baseProcessingCostUsdPerTon: Readonly<Record<Product, number>>;
    /** HosoEqTons → kg 換算係数。原料取得原価（UsdM）算出にのみ使う（暫定値）。 */
    readonly hosoEqKgPerTon: number;
  };

  readonly finishedGoods: {
    /** 完成品ロットの標準使用期限（生産からのターン数）。undefinedの場合は期限を設けない。 */
    readonly defaultShelfLifeTurns?: number;
  };

  readonly supplySignal: {
    /**
     * 実績供給シグナルが存在しない産地について、Phase3の暫定PD/VAP前提
     * （CountrySupplyInputの既存値）をそのまま残すためのフォールバック方針。
     * true の場合、対象産地に本Phaseの供給シグナルが1件も無ければ既存値を変更しない。
     */
    readonly preserveExistingWhenNoSignal: boolean;
  };
}

export const PRODUCTION_PARAMETERS_V1: ProductionParameters = {
  parametersVersion: "production-v0.1",

  yield: {
    baseYieldRatio: {
      hoso: 0.92,
      pd: 0.8,
      vap: 0.7,
    },
  },

  capacity: {
    epsilon: 1e-6,
  },

  labor: {
    regularEfficiencyPerHeadTons: 6,
    temporaryEfficiencyPerHeadTons: 3.5,
    overtimeRateCap: 0.3,
    overtimeEfficiencyFactor: 0.5,
  },

  cost: {
    baseProcessingCostUsdPerTon: {
      hoso: 350,
      pd: 520,
      vap: 780,
    },
    hosoEqKgPerTon: 1000,
  },

  finishedGoods: {
    defaultShelfLifeTurns: 4,
  },

  supplySignal: {
    preserveExistingWhenNoSignal: true,
  },
};
