// ShrimpX V2 — 工場・ワーカー・生産モジュール パラメータ定義（Phase 6、Phase 6.1で歩留まり定義を修正）
//
// Phase5（app/lib/v2/rawMaterials/parameters.ts）と同じ方針で、計算ロジックに
// マジックナンバーを直接書かず、すべての係数をこの1ファイルへ集約する。
// すべて「Phase6新規・要校正」の暫定値であり、ゲームバランス調整フェーズで
// 再検討する前提とする。
//
// 【Phase 6.1修正】yield配下を physicalYieldRatio（参考値・非換算用）と
// saleableRecoveryRatio（HOSO換算数量の計算に使う真の回収率）へ分離した。
// 経緯: Phase6初版のbaseYieldRatio（HOSO 0.92/PD 0.80/VAP 0.70）は、殻・頭の
// 除去による通常の物理的重量減少（HOSO換算という単位変換の時点で既に織り込み
// 済み）を、HOSO換算済みの完成品数量へさらに掛けてしまっており、正常な加工を
// 「加工損失」として二重計上していた。詳細はdocs/v2/PRODUCTION_ARCHITECTURE_v0.1.md
// §6を参照。

import { Product } from "../market/types";

export interface ProductionParameters {
  readonly parametersVersion: string;

  readonly yield: {
    /**
     * 商品別の物理歩留まり（HOSO原料の物理重量 → 完成品の物理重量、0〜1）。
     * 【参考値・非換算用】殻・頭の除去等による通常の物理的重量減少を表す。
     * HOSO換算トンは「HOSO換算」という単位変換の時点で既にこの物理的な
     * 重量減少を織り込んでいるため、本比率をHOSO換算数量（原料・完成品在庫・
     * 能力・供給シグナル・契約数量のいずれも）へ直接掛けてはならない
     * （二重減額になる。§「HOSO換算数量と物理歩留まりの分離」参照）。
     * yieldConversion.tsのcalculatePhysicalOutputTons（参考情報・非永続）でのみ使う。
     *
     * 【Phase 6.3修正・暫定換算基準】
     *   HOSO原料100トン → 冷凍HOSO 約100物理トン（= 1.00）
     *   HOSO原料100トン → HLSO    約 60物理トン（= 0.60。HLSOは現時点で商品enumに
     *                      存在しないため値は持たず、参考基準としてのみ文書化する）
     *   HOSO原料100トン → PD      約 54物理トン（= 0.54）
     * VAPは衣・ソース・加熱等で仕様差が大きく一律の物理歩留まりを定義できないため
     * 値を設定しない（undefined）。VAPの主数量は投入エビ原料のHOSO換算量で管理する。
     * 物理重量換算は表示・仕様変換の境界で一度だけ使用し、契約・在庫のHOSO換算量へ
     * 再適用しない。
     */
    readonly physicalYieldRatio: Readonly<Partial<Record<Product, number>>>;
    /**
     * 商品別の販売可能回収率（原料HosoEqTons → 完成品HosoEqTons、0〜1）。
     * 不適合・破損・廃棄等、HOSO換算上でも実際に失われる真の損失のみを表す。
     * 【Phase 6.3修正】正常な頭・殻の除去はHOSO換算量を減らさないため、
     * 通常操業時はHOSO・PD・VAPとも原則1.00を基準とする。品質不良・加工ミス・
     * 廃棄等の真の損失はPhase 7以降でこの比率を通じて変動させられる構造として
     * 残す（構造は維持し、基準値のみ1.00へ是正）。原料消費量→完成品HOSO換算量の
     * 変換は、このモジュール内でこの比率を通じてのみ行う（二重適用を避けるため、
     * 他の比率を併用しない）。
     */
    readonly saleableRecoveryRatio: Readonly<Record<Product, number>>;
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
    /**
     * 【Test15新設】商品別の労働集約度係数。1人あたり基準効率
     * （regularEfficiencyPerHeadTons / temporaryEfficiencyPerHeadTons）を、
     * この係数で除して商品別の実効1人あたり効率を求める（値が大きいほど、
     * 同じ数量を生産するのにより多くの人手を要する）。
     * HOSO=1.0を基準に PD=1.2、VAP=3.0（Test15暫定値・要校正）。
     * 唯一の情報源はこのテーブルであり、production/labor.ts の
     * effectiveEfficiencyPerHeadTons()を通じてのみ参照する
     * （呼び出し側・UI・AIが個別に係数をハードコードしない）。
     * 【将来拡張への配慮】PDの機械化投資（別セッションでの実装予定）は、
     * この係数の上へ掛け合わせる別レイヤー（機械化倍率）として追加される想定であり、
     * 本係数自体は機械化前のベースライン値を表す（本タスクでは機械化倍率は実装しない）。
     */
    readonly laborIntensityCoefficient: Readonly<Record<Product, number>>;
    /**
     * 【PD省人化・商品別労働係数】機械化が完全に成熟したときの商品別労働集約度係数。
     *
     * 機械化の効果を「PD専用のフロア値」ではなく **商品別の到達係数テーブル** として
     * 持つことで、次の3つを1箇所で表現する。
     *   HOSO 1.0 → 1.0 : 殻剥き工程が無いため機械化の対象外（一切変わらない）。
     *   PD   1.8 → 1.2 : 殻剥き・背ワタ除去の省人化効果を丸ごと受ける。
     *                    同じPD数量に必要な人手が 1 − 1.2/1.8 = 33.3% 減り、
     *                    同じ人手で 1.8/1.2 = 1.5 倍のPDを作れる。
     *   VAP  3.0 → 2.6 : 前工程に殻剥きを含むため部分的に恩恵を受けるが、
     *                    成形・味付け・加熱・包装・検品は人手のまま残るため
     *                    PDほどは下がらない（13.3%減）。
     *
     * 【重要・二重適用の防止】機械化レベル(0〜1)から実効係数への写像は
     * production/labor.ts の resolveLaborIntensityCoefficient **1箇所だけ**が行う。
     * capex/pdMechanization.ts・意思決定画面・Standard AI・Excelはいずれも
     * この関数（またはこれを内部で使うeffectiveEfficiencyPerHeadTons）を経由し、
     * 独自に係数を補間・上書きしない。
     */
    readonly mechanizedLaborIntensityCoefficient: Readonly<Record<Product, number>>;
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
  parametersVersion: "production-v0.2", // Phase 6.3: 歩留まり定義是正（physicalYieldRatio基準変更・saleableRecoveryRatio=1.00基準）

  yield: {
    // 【Phase 6.3修正】暫定換算基準（実装指示 §2）。HOSO換算数量の計算には使わない。
    // HLSO（≈0.60）は商品enum未追加のため値を持たない。VAPは一律の物理歩留まりを
    // 設定しない（HOSO換算量のみで管理する）。
    physicalYieldRatio: {
      hoso: 1.0,
      pd: 0.54,
    },
    // 【Phase 6.3修正】正常な頭・殻の除去ではHOSO換算量を減らさないため、
    // 通常操業時の基準は全品1.00。品質不良・加工ミス・廃棄等の真の損失は
    // Phase 7からこの比率を通じて変動させる。
    saleableRecoveryRatio: {
      hoso: 1.0,
      pd: 1.0,
      vap: 1.0,
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
    // 【要校正】機械化前 HOSO:PD:VAP = 1.0 : 1.8 : 3.0
    // 【変更履歴】Test15時点は pd=1.2 だったが、これは「機械化後の到達値」に相当する
    // 水準であり、機械化前の人手の重さを表現できていなかった（機械化の余地が
    // 1.2→1.0 の16.67%しか無く、投資が構造的に回収不能だった一因）。
    // 機械化前を1.8へ引き上げ、機械化後の到達値を別テーブルで1.2と定義し直す。
    laborIntensityCoefficient: {
      hoso: 1.0,
      pd: 1.8,
      vap: 3.0,
    },
    // 【要校正】機械化後 HOSO:PD:VAP = 1.0 : 1.2 : 2.6
    mechanizedLaborIntensityCoefficient: {
      hoso: 1.0,
      pd: 1.2,
      vap: 2.6,
    },
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
