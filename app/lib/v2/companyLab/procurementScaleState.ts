// ShrimpX V2 — 調達規模効果（procurement scale）ストック
//
// 【目的】HOSO集中戦略（コストリーダー戦略）を成立させるため、会社×調達チャネル
// （国内買付/輸入/自社養殖）の粒度で「継続的な調達規模」が蓄積される状態を導入する。
// 継続的に大量調達する会社ほど、チャネル別の実効仕入原価が逓減する（数量割引）
// ・仕入先との関係性が厚くなる（competitivenessWeightへの加点）という2つの経路で
// HOSO大量生産・薄利多売戦略を後押しする。
//
// 【salesBase.tsとの対称性】本ファイルはcompanyLab/salesBase.tsと同じ設計を踏襲する。
//   - 独立ファイル＋State型＋純粋関数updateXxxState＋CompanyOwnStateへの公開
//   - 決定論的（乱数不使用）。エントリはcompanyId固定順でソートして保持する
//   - 更新は四半期処理の最後（当期の配分・収穫が確定した後）に行い、当期の
//     実効原価・競争力ウェイトへ使われるのは前四半期末までの値のみ
//     （今期の購入実績を今期の原価へ遡及させない。salesBase.tsと同じ時間順序）。
//
// 【移動平均の実装方針】trailingVolumeHosoEqTonsは「過去trailingQuarters四半期の
// 単純移動平均」を意図するが、状態には直近スナップショット（前回の平均値）だけを
// 持ち回す設計（salesBase.ts・marketEvolution.tsのEWMA carry stateと同じ形。生の
// 購入量履歴を別途配列で保持しない）。四半期経過数nがtrailingQuarters未満の
// ランプアップ区間では、累積平均の逐次更新式
//   newAvg = oldAvg + (current - oldAvg) / n
// は数学的に単純移動平均（過去n四半期の単純平均）と完全に一致する。
// n=trailingQuartersに達した後もこの式を使い続けると、厳密な「直近4四半期だけの
// 箱型移動平均」からは徐々に乖離し、指数移動平均（重み1/trailingQuarters）に近い
// 挙動になる（＝リングバッファ相当の代替実装。実装指示「既存の移動平均実装
// パターンがコード内に無ければシンプルなリングバッファ相当でよい」に対応する
// 選択）。単発の大量購入と継続購入を区別する（後者の方が最終的な効果が大きい）
// という要求は、この式でも満たされる（procurementScaleState.test.ts参照）。

import { CompanyId } from "../sales/types";
import { hosoEqTons, HosoEqTons, roundHosoEqTons, unwrapUnit } from "../core/units";

export type ProcurementChannel = "domestic" | "imported" | "aquaculture";

const PROCUREMENT_CHANNELS: readonly ProcurementChannel[] = ["domestic", "imported", "aquaculture"];

/** 1チャネルぶんの調達規模スコア。 */
export interface ProcurementChannelScale {
  /** 過去trailingQuarters四半期の（単純）移動平均、HOSO換算トン。早期丸め。 */
  readonly trailingVolumeHosoEqTons: number;
  /** 仕入先との関係スコア（0-100、salesBaseと同じスケール）。 */
  readonly relationshipScore: number;
  /**
   * 移動平均の逐次更新に使う経過四半期数（trailingQuartersで飽和）。
   * 状態の一部として持ち回る内部会計値（公開インターフェースの一部だが、
   * calculateVolumeDiscountRatio等の呼び出し側は通常trailingVolumeHosoEqTonsだけを見ればよい）。
   */
  readonly observedQuarters: number;
}

/** 1件の調達規模エントリ（会社×全チャネル）。 */
export interface ProcurementScaleEntry {
  readonly companyId: CompanyId;
  readonly domestic: ProcurementChannelScale;
  readonly imported: ProcurementChannelScale;
  readonly aquaculture: ProcurementChannelScale;
}

/** 調達規模の全体状態（スパース表現。存在しない会社は全チャネル初期値=ゼロ規模とみなす）。 */
export interface ProcurementScaleState {
  readonly entries: readonly ProcurementScaleEntry[];
}

export interface ProcurementScaleParameters {
  /** 移動平均の対象四半期数。既定4。 */
  readonly trailingQuarters: number;
  /** チャネル別の割引率上限（逓減の飽和値。0.08 = 最大8%引き）。 */
  readonly maxDiscountRatioByChannel: Readonly<Record<ProcurementChannel, number>>;
  /** チャネル別の「効果が半分程度に達する規模」（HOSO換算トン/四半期）。 */
  readonly scaleUnitTonsByChannel: Readonly<Record<ProcurementChannel, number>>;
  /** 活動継続時（当期購入量>0）の関係スコア加点（点/四半期、上限100）。 */
  readonly relationshipActiveGainPerQuarter: number;
  /** 活動なし（当期購入量=0）のとき中立値へ向けた減衰比率（現在値と中立値の差に対する比率/四半期）。 */
  readonly relationshipIdleDecayRatioPerQuarter: number;
  /** 関係スコアの中立値（新規参入・未活動の基準点）。既定50。 */
  readonly relationshipNeutralScore: number;
}

export const PROCUREMENT_SCALE_PARAMETERS_V1: ProcurementScaleParameters = {
  trailingQuarters: 4,
  // 【暫定値・要校正】国内買付が最も割引余地が大きい（国内サプライヤーとの
  // 直接取引で規模の経済が働きやすい）想定。輸入・自社養殖は物流・生物学的
  // 制約で規模効果が相対的に小さい。
  maxDiscountRatioByChannel: {
    domestic: 0.1,
    imported: 0.06,
    aquaculture: 0.04,
  },
  // 会社フィクスチャの調達処理能力（数百〜数千トン/四半期）を踏まえ、
  // 「4四半期継続してこの規模で買い続けると効果の半分程度に達する」水準を暫定設定。
  scaleUnitTonsByChannel: {
    domestic: 800,
    imported: 1200,
    aquaculture: 600,
  },
  relationshipActiveGainPerQuarter: 3.0,
  relationshipIdleDecayRatioPerQuarter: 0.08,
  relationshipNeutralScore: 50,
};

const EPSILON = 1e-9;

/** 空の調達規模状態（全会社・全チャネルがゼロ規模・中立関係）。 */
export function emptyProcurementScaleState(): ProcurementScaleState {
  return { entries: [] };
}

function initialChannelScale(params: ProcurementScaleParameters): ProcurementChannelScale {
  return { trailingVolumeHosoEqTons: 0, relationshipScore: params.relationshipNeutralScore, observedQuarters: 0 };
}

/**
 * トン数から割引率を算出する（飽和型逓減カーブ）。
 *   discountRatio = maxDiscountRatio × (1 - exp(-trailingVolume / scaleUnitTons))
 * - trailingVolumeHosoEqTons <= 0 のとき 0。
 * - trailingVolumeHosoEqTons → ∞ のとき maxDiscountRatioへ漸近する（上限を超えない）。
 * - 数量が増えるほど増分は逓減する（指数飽和カーブの性質そのもの）。
 */
export function calculateVolumeDiscountRatio(trailingVolumeHosoEqTons: number, maxDiscountRatio: number, scaleUnitTons: number): number {
  if (trailingVolumeHosoEqTons <= 0 || maxDiscountRatio <= 0) return 0;
  if (scaleUnitTons <= EPSILON) return maxDiscountRatio;
  const raw = maxDiscountRatio * (1 - Math.exp(-trailingVolumeHosoEqTons / scaleUnitTons));
  return Math.max(0, Math.min(maxDiscountRatio, raw));
}

/** 会社×チャネルの調達規模スコアを引く（存在しなければ初期値）。 */
export function lookupProcurementChannelScale(
  state: ProcurementScaleState | undefined,
  companyId: CompanyId,
  channel: ProcurementChannel,
  params: ProcurementScaleParameters = PROCUREMENT_SCALE_PARAMETERS_V1
): ProcurementChannelScale {
  const entry = state?.entries.find((e) => e.companyId === companyId);
  if (!entry) return initialChannelScale(params);
  return entry[channel];
}

/** 1社ぶんの調達規模スライス（CompanyOwnState公開用）。 */
export function procurementScaleSliceForCompany(
  state: ProcurementScaleState | undefined,
  companyId: CompanyId,
  params: ProcurementScaleParameters = PROCUREMENT_SCALE_PARAMETERS_V1
): Readonly<Record<ProcurementChannel, ProcurementChannelScale>> {
  const entry = state?.entries.find((e) => e.companyId === companyId);
  if (!entry) {
    return {
      domestic: initialChannelScale(params),
      imported: initialChannelScale(params),
      aquaculture: initialChannelScale(params),
    };
  }
  return { domestic: entry.domestic, imported: entry.imported, aquaculture: entry.aquaculture };
}

function updateChannelScale(
  previous: ProcurementChannelScale | undefined,
  currentQuarterVolume: number,
  params: ProcurementScaleParameters
): ProcurementChannelScale {
  const prev = previous ?? initialChannelScale(params);
  const volume = Math.max(0, currentQuarterVolume);

  // --- 移動平均（早期丸め）の逐次更新 ---
  const n = Math.min(params.trailingQuarters, prev.observedQuarters + 1);
  const rawAvg = prev.trailingVolumeHosoEqTons + (volume - prev.trailingVolumeHosoEqTons) / n;
  const trailingVolumeHosoEqTons = Math.max(0, roundHosoEqTons(rawAvg));

  // --- 関係スコア（salesBase.tsのupdateSalesBaseStateと同じ規約: 活動継続なら
  // 加点[上限100]、無活動なら中立値へ向けた比率減衰） ---
  let relationshipScore: number;
  if (volume > EPSILON) {
    relationshipScore = Math.min(100, prev.relationshipScore + params.relationshipActiveGainPerQuarter);
  } else {
    relationshipScore =
      params.relationshipNeutralScore + (prev.relationshipScore - params.relationshipNeutralScore) * (1 - params.relationshipIdleDecayRatioPerQuarter);
  }
  relationshipScore = Math.max(0, Math.min(100, relationshipScore));

  return {
    trailingVolumeHosoEqTons,
    relationshipScore,
    observedQuarters: n,
  };
}

/**
 * 四半期末の調達規模更新（純粋関数・決定論的）。salesBase.tsのupdateSalesBaseState
 * と同じ位置（当期の調達配分が確定した後）で呼び出す想定。
 *
 * @param currentQuarterVolumeByCompanyChannel key=companyId（HosoEqTons単位で
 *   会社別・チャネル別の当期実際購入量/収穫投入量を渡す。存在しないcompanyIdは
 *   全チャネル0として扱う）。
 */
export function updateProcurementScaleState(
  previous: ProcurementScaleState | undefined,
  companyIds: readonly CompanyId[],
  currentQuarterVolumeByCompanyChannel: ReadonlyMap<string, Readonly<Record<ProcurementChannel, number>>>,
  params: ProcurementScaleParameters = PROCUREMENT_SCALE_PARAMETERS_V1
): ProcurementScaleState {
  const prevByCompany = new Map<string, ProcurementScaleEntry>();
  for (const e of previous?.entries ?? []) {
    prevByCompany.set(e.companyId, e);
  }

  const sortedCompanyIds = [...companyIds].sort();
  const entries: ProcurementScaleEntry[] = sortedCompanyIds.map((companyId) => {
    const prevEntry = prevByCompany.get(companyId);
    const volumes = currentQuarterVolumeByCompanyChannel.get(companyId) ?? { domestic: 0, imported: 0, aquaculture: 0 };
    return {
      companyId,
      domestic: updateChannelScale(prevEntry?.domestic, volumes.domestic, params),
      imported: updateChannelScale(prevEntry?.imported, volumes.imported, params),
      aquaculture: updateChannelScale(prevEntry?.aquaculture, volumes.aquaculture, params),
    };
  });

  return { entries };
}

// 内部ヘルパー（他モジュールから調達量トンをまとめる際に使える型ヘルパー）。
export function hosoTonsToChannelVolume(v: HosoEqTons): number {
  return unwrapUnit(v);
}
export function channelVolumeToHosoTons(v: number): HosoEqTons {
  return hosoEqTons(Math.max(0, v));
}

export { PROCUREMENT_CHANNELS };
