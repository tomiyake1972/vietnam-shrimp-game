// ShrimpX V2 — Phase SAI-5C: 市場別の商品ライフサイクル（需要構成の時間変化）
//
// 【目的】「市場全体のエビ需要」と「HOSO/PD/VAPの商品構成比」を分離し、後者を
// 市場×商品ごとのS字型普及曲線として時間変化させる。ゲーム開始時点はHOSOが
// 最大・PDは新しいが意味のある市場・VAPは非常に小さい状態で、日本→米国→
// 欧州/その他→中国の順に普及が進む。
//
// 【二重計上の防止（設計メモ§2.2）】
//  - 市場全体の需要成長（scenario/consumerInventoryの既存機構）と、商品間の
//    構成変化（本モジュール）を厳密に分離する。本モジュールは構成比（行和=1）
//    だけを扱い、市場合計需要を増減させない。
//  - 世界PD/VAP需要（プレミアム計算の入力）と、市場×商品の対象需要按分
//    （成約上限）は、**同一のlifecycleShare関数**から導出する（構成比の食い違い
//    による二重計上・不整合を防ぐ）。
//  - VAP需要急増は固定イベントとして発火させず、基礎需要曲線（普及曲線の加速
//    期間）として表現する（実装指示§6）。
//
// 【決定論】本モジュールは状態を持たない純粋関数のみで構成される（turnの
// 決定論的関数）。乱数は一切使わない。SAI-5Eのaffordability（安値による普及
// 加速）は、adoptionTurnShift（±四半期数のシフト、上下限つき）という入力として
// 外から与えられる（本モジュール自身は価格を参照しない＝価格効果の計上場所を
// 一箇所に限定する）。
//
// 【係数の集約（実装指示§14）】すべての初期値・成熟値・加速時期は
// PRODUCT_LIFECYCLE_PARAMETERS_V1 に集約し、初期値の根拠をコメントで残す。

import { DemandMarketId, DEMAND_MARKET_IDS, MarketQuarterInput, Product } from "./types";
import { HosoEqTons, hosoEqTons, unwrapUnit } from "../core/units";

/** PD/VAPどちらか1商品の、1市場での普及曲線パラメータ。 */
export interface ProductAdoptionCurve {
  /** ゲーム開始時点（turn=1）の需要構成比（0〜1）。 */
  readonly initialShare: number;
  /** 成熟後の上限構成比（0〜1）。 */
  readonly matureShare: number;
  /** 加速前の毎四半期の微成長（構成比pt/四半期。通常成長速度）。 */
  readonly baseGrowthPerQuarter: number;
  /** 加速（S字の立ち上がり）開始turn。 */
  readonly accelStartTurn: number;
  /** 加速期間（四半期数。この期間でmatureShareへ漸近する）。 */
  readonly accelDurationQuarters: number;
}

export interface MarketLifecycleConfig {
  readonly pd: ProductAdoptionCurve;
  readonly vap: ProductAdoptionCurve;
}

export interface ProductLifecycleParameters {
  readonly byMarket: Readonly<Record<DemandMarketId, MarketLifecycleConfig>>;
  /** affordability等による普及前倒し/後ろ倒しシフトの上限（四半期数、±）。 */
  readonly maxAdoptionTurnShift: number;
}

/**
 * SAI-5Cの初期試験値（校正対象の暫定値）。
 *
 * 【初期値の根拠】
 * - 開始時点の構成比: 日本が最も普及が進み（PD 0.34/VAP 0.10）、米国が続き
 *   （0.30/0.06）、欧州は中間（0.28/0.05）、その他は平均的な後発（0.22/0.03）、
 *   中国はHOSO中心（PD 0.12/VAP 0.01）。世界加重平均はPD≈0.25/VAP≈0.05で、
 *   従来の世界一律固定シェア（PD0.28/VAP0.12）より控えめ＝「PDは既に意味の
 *   ある市場・VAPは非常に小さい」という開始条件（実装指示§6）を満たす。
 * - 加速開始turn: JP=4 → US=8 → EU=10 → OTHER=12 → CN(PD)=16/CN(VAP)=22。
 *   「日本が最も早く、米国が続き、欧州は中間、中国はHOSO中心期間が長く
 *   PD→VAPの順でかなり遅れて普及」という指示の時間差をturn差で表現。
 *   32四半期のゲーム期間内に中国のVAP加速（turn22〜30）まで到達する。
 * - 成熟構成比: 日本VAP0.30/米国0.26は「VAP需要急成長」局面を作るのに十分な
 *   伸び幅（初期比3〜4倍超）で、かつhosoシェアが全市場で0.3以上残る範囲。
 * - baseGrowthPerQuarter: PD 0.002/VAP 0.001（加速前の緩やかな浸透）。
 */
export const PRODUCT_LIFECYCLE_PARAMETERS_V1: ProductLifecycleParameters = {
  byMarket: {
    JP: {
      pd: { initialShare: 0.34, matureShare: 0.4, baseGrowthPerQuarter: 0.002, accelStartTurn: 4, accelDurationQuarters: 8 },
      vap: { initialShare: 0.1, matureShare: 0.3, baseGrowthPerQuarter: 0.001, accelStartTurn: 4, accelDurationQuarters: 8 },
    },
    US: {
      pd: { initialShare: 0.3, matureShare: 0.38, baseGrowthPerQuarter: 0.002, accelStartTurn: 8, accelDurationQuarters: 8 },
      vap: { initialShare: 0.06, matureShare: 0.26, baseGrowthPerQuarter: 0.001, accelStartTurn: 8, accelDurationQuarters: 8 },
    },
    EU: {
      pd: { initialShare: 0.28, matureShare: 0.34, baseGrowthPerQuarter: 0.002, accelStartTurn: 10, accelDurationQuarters: 10 },
      vap: { initialShare: 0.05, matureShare: 0.18, baseGrowthPerQuarter: 0.001, accelStartTurn: 10, accelDurationQuarters: 10 },
    },
    OTHER: {
      pd: { initialShare: 0.22, matureShare: 0.3, baseGrowthPerQuarter: 0.002, accelStartTurn: 12, accelDurationQuarters: 10 },
      vap: { initialShare: 0.03, matureShare: 0.14, baseGrowthPerQuarter: 0.001, accelStartTurn: 12, accelDurationQuarters: 10 },
    },
    CN: {
      pd: { initialShare: 0.12, matureShare: 0.3, baseGrowthPerQuarter: 0.001, accelStartTurn: 16, accelDurationQuarters: 10 },
      vap: { initialShare: 0.01, matureShare: 0.1, baseGrowthPerQuarter: 0.0005, accelStartTurn: 22, accelDurationQuarters: 8 },
    },
  },
  maxAdoptionTurnShift: 4,
};

/**
 * 【加工品市場進化 §b】実機出力を実装指示§3の市場別記述と突き合わせて調整した版。
 *
 * 【V1からの変更点と、その根拠（実測ベース。before/after は
 *  docs/v2/design/processed_market_evolution_audit.md §b に記録）】
 *
 * 変更したのは **US市場のPD/VAP加速開始turnの分離** だけである。
 *
 *   before: US.pd accelStartTurn=8 / US.vap accelStartTurn=8
 *           → 実測で PD・VAP の最大伸長がどちらも turn12 に重なり、
 *             「米国はPDが伸びたあとVAPが強く伸びる」という時間差が消えていた。
 *   after:  US.pd accelStartTurn=6 / US.vap accelStartTurn=12
 *           → PDの最大伸長 turn9、VAPの最大伸長 turn16 と分離される。
 *
 * 【V1のまま据え置いた市場と、その理由（実測で指示と一致していたため）】
 *  - JP: PD 0.34→0.40（大きいまま安定）／VAP 0.10→0.30（3倍成長、最大伸長turn8）。
 *        「日本は安定的に大きいPDに加えて、人手不足・厨房コストを背景に
 *         VAPが伸びる」という記述と一致。PDとVAPの加速turnが同じでも、
 *         PD側の伸び幅が小さい（+0.06）ため「PDは安定・VAPが伸びる」に見える。
 *  - EU: PD 0.28→0.34／VAP 0.05→0.18（3.6倍）。PD/VAPへの移行は成立している。
 *        「品質・サステナビリティ・トレーサビリティが誰がプレミアムを取るかを
 *         左右する」部分は構成比ではなく成約・価格側の論点（監査§7）。
 *  - CN: HOSO 0.87→0.60 と全市場で最も高いHOSO比率を最後まで維持し、
 *        PDの最大伸長 turn21・VAPの最大伸長 turn26 と最も遅い。
 *        「中国はHOSO中心の期間が長い」と一致。
 *  - OTHER: 平均的な後発として妥当（PD最大伸長turn17）。
 *
 * 【安全性】V1は削除せず残す（全体実装計画書 §20「旧版を削除しない」）。
 * この表は config.marketEvolution.tunedProductLifecycle を有効にしたラボだけが使う。
 */
export const PRODUCT_LIFECYCLE_PARAMETERS_MARKET_EVOLUTION_V1: ProductLifecycleParameters = {
  ...PRODUCT_LIFECYCLE_PARAMETERS_V1,
  byMarket: {
    ...PRODUCT_LIFECYCLE_PARAMETERS_V1.byMarket,
    US: {
      pd: { ...PRODUCT_LIFECYCLE_PARAMETERS_V1.byMarket.US.pd, accelStartTurn: 6 },
      vap: { ...PRODUCT_LIFECYCLE_PARAMETERS_V1.byMarket.US.vap, accelStartTurn: 12 },
    },
  },
};

/** 市場×商品の需要構成比行列（各市場の行和=1）。 */
export type MarketProductMix = Readonly<Record<DemandMarketId, Readonly<Record<Product, number>>>>;

function smoothstep(p: number): number {
  const t = Math.max(0, Math.min(1, p));
  return t * t * (3 - 2 * t);
}

/**
 * 1市場×1商品（pd/vap）の、指定turnにおける需要構成比。
 * S字（smoothstep）: 加速開始前は緩やかな線形浸透、加速期間でmatureShareへ漸近。
 * adoptionTurnShift（SAI-5E: 安値による普及の前倒し。正=前倒し）は±maxAdoptionTurnShift
 * 四半期にclampして時間軸をシフトする。
 */
export function adoptionShare(curve: ProductAdoptionCurve, turn: number, adoptionTurnShift = 0, maxShift = PRODUCT_LIFECYCLE_PARAMETERS_V1.maxAdoptionTurnShift): number {
  const shift = Math.max(-maxShift, Math.min(maxShift, adoptionTurnShift));
  const t = turn + shift;
  const preGrowth = Math.min(curve.matureShare, curve.initialShare + curve.baseGrowthPerQuarter * Math.max(0, t - 1));
  const progress = curve.accelDurationQuarters > 0 ? (t - curve.accelStartTurn) / curve.accelDurationQuarters : t >= curve.accelStartTurn ? 1 : 0;
  const s = smoothstep(progress);
  const share = preGrowth + (curve.matureShare - preGrowth) * s;
  return Math.max(0, Math.min(curve.matureShare, share));
}

/** SAI-5Eが渡す、市場×商品ごとの普及シフト（四半期数）。省略時0。 */
export type AdoptionTurnShiftByMarketProduct = Readonly<Partial<Record<DemandMarketId, Readonly<Partial<Record<"pd" | "vap", number>>>>>>;

/**
 * 指定turnの市場×商品の需要構成比行列を計算する（各市場の行和=1を保証）。
 * hosoシェア = 1 − pd − vap（残差）。パラメータ検証によりpd+vap<1が保証される
 * ため負のシェアは構造上生じないが、防御的にclampする。
 */
export function computeMarketProductMix(
  turn: number,
  params: ProductLifecycleParameters = PRODUCT_LIFECYCLE_PARAMETERS_V1,
  adoptionShift?: AdoptionTurnShiftByMarketProduct
): MarketProductMix {
  assertLifecycleParametersValid(params);
  const out = {} as Record<DemandMarketId, Record<Product, number>>;
  for (const market of DEMAND_MARKET_IDS) {
    const config = params.byMarket[market];
    const pdShift = adoptionShift?.[market]?.pd ?? 0;
    const vapShift = adoptionShift?.[market]?.vap ?? 0;
    const pd = adoptionShare(config.pd, turn, pdShift, params.maxAdoptionTurnShift);
    const vap = adoptionShare(config.vap, turn, vapShift, params.maxAdoptionTurnShift);
    const hoso = Math.max(0, 1 - pd - vap);
    out[market] = { hoso, pd, vap };
  }
  return out;
}

/** パラメータの健全性検証（成熟時でもhosoシェアが残る・シェアが0〜1）。 */
export function assertLifecycleParametersValid(params: ProductLifecycleParameters): void {
  for (const market of DEMAND_MARKET_IDS) {
    const c = params.byMarket[market];
    for (const [label, curve] of [
      ["pd", c.pd],
      ["vap", c.vap],
    ] as const) {
      if (curve.initialShare < 0 || curve.initialShare > 1 || curve.matureShare < 0 || curve.matureShare > 1) {
        throw new Error(`[productLifecycle] ${market}.${label}: シェアは0〜1である必要があります`);
      }
      if (curve.matureShare < curve.initialShare) {
        throw new Error(`[productLifecycle] ${market}.${label}: matureShare(${curve.matureShare}) < initialShare(${curve.initialShare})`);
      }
      if (curve.accelDurationQuarters < 1 || curve.accelStartTurn < 1) {
        throw new Error(`[productLifecycle] ${market}.${label}: 加速開始turn・期間は1以上である必要があります`);
      }
    }
    if (c.pd.matureShare + c.vap.matureShare >= 0.95) {
      throw new Error(`[productLifecycle] ${market}: 成熟時のpd+vapシェア(${c.pd.matureShare + c.vap.matureShare})が大きすぎます（HOSOシェアが残らない）`);
    }
  }
}

/**
 * 世界PD/VAP需要（プレミアム計算の入力）を、市場別消費×市場別ライフサイクル
 * 構成比の合計で置き換えたMarketQuarterInputを返す（元の入力は変更しない）。
 *
 * 従来の「世界合計消費×固定シェア（scenarioEngineのpdDemandShareOfTotalConsumption
 * =0.28等）」の市場別・時変版であり、同じ消費データ（demandMarkets[m].
 * priorPeriodConsumption）から導出する。消費量そのもの（市場全体需要）は
 * 一切変更しない（構成比のみ＝総需要の二重計上なし）。
 */
export function applyLifecycleDemandToMarketInput(input: MarketQuarterInput, mix: MarketProductMix): MarketQuarterInput {
  let pdDemand = 0;
  let vapDemand = 0;
  for (const market of DEMAND_MARKET_IDS) {
    const consumption = unwrapUnit(input.demandMarkets[market].priorPeriodConsumption);
    pdDemand += consumption * mix[market].pd;
    vapDemand += consumption * mix[market].vap;
  }
  return {
    ...input,
    pdVapDemand: {
      ...input.pdVapDemand,
      pdDemand: hosoEqTons(Math.max(0, pdDemand)),
      vapDemand: hosoEqTons(Math.max(0, vapDemand)),
    },
  };
}

/** 市場×商品の対象需要合計（HOSO換算トン）を検算するユーティリティ（テスト用）。 */
export function sumMixWeightedDemand(
  totalByMarket: Readonly<Record<DemandMarketId, HosoEqTons>>,
  mix: MarketProductMix
): number {
  let sum = 0;
  for (const market of DEMAND_MARKET_IDS) {
    for (const product of ["hoso", "pd", "vap"] as const) {
      sum += unwrapUnit(totalByMarket[market]) * mix[market][product];
    }
  }
  return sum;
}
