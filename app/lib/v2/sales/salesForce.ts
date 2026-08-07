// ShrimpX V2 — 販売計画・営業人員・成約・約定残モジュール 営業人員（Phase 4）
//
// 営業人員数から「市場カバレッジ（成約配分の競争力ウェイトの一因子）」と
// 「処理能力（成約量の上限）」を導出する純粋関数のみを提供する。
// どちらも Michaelis-Menten型の飽和曲線（x/(x+k)）を採用し、
//   - headcount=0 でも既存顧客ぶんの最低限の値を残す
//   - headcount増加の効果は逓減する（人員を増やすほど追加1人あたりの伸びが減る）
//   - 上限は有限（青天井にならない）
// という実装指示の要件を満たす。将来、営業人員の異動コスト・配置変更の遅延・
// 市場経験による補正を追加する場合は、この2関数のシグネチャに引数を足すだけで
// 拡張できる（本Phaseでは異動コスト・遅延は未実装のまま）。

import { HosoEqTons, hosoEqTons, roundHosoEqTons } from "../core/units";
import { SalesValidationError } from "./types";
import { SalesParameters } from "./parameters";
import { DemandMarketId } from "../market/types";

function assertNonNegativeIntegerHeadcount(headcount: number): void {
  if (!Number.isInteger(headcount) || headcount < 0) {
    throw new SalesValidationError(`salesForceHeadcount は0以上の整数である必要があります。受け取った値: ${headcount}`);
  }
}

/**
 * 営業人員数から市場カバレッジ（0〜1）を導出する。
 * coverage(0) = baselineCoverageAtZeroHeadcount（既存顧客による最低限の成約力）。
 * headcount → ∞ で 1 に漸近する（決して1を超えない）。
 */
export function salesCoverageScore(headcount: number, params: SalesParameters): number {
  assertNonNegativeIntegerHeadcount(headcount);
  const { baselineCoverageAtZeroHeadcount, coverageSaturationHeadcount } = params.salesForce;
  const growth = headcount / (headcount + coverageSaturationHeadcount);
  return baselineCoverageAtZeroHeadcount + (1 - baselineCoverageAtZeroHeadcount) * growth;
}

/**
 * 営業人員数から処理能力（HOSO換算トン、成約量の上限の一因子）を導出する。
 * capacity(0) = baselineCapacityTons（既存顧客ぶん）。
 * headcount → ∞ で baselineCapacityTons + capacityMaxIncrementTons に漸近する。
 */
export function processingCapacity(headcount: number, params: SalesParameters): HosoEqTons {
  assertNonNegativeIntegerHeadcount(headcount);
  const { baselineCapacityTons, capacityMaxIncrementTons, capacitySaturationHeadcount } = params.salesForce;
  const growth = headcount / (headcount + capacitySaturationHeadcount);
  return hosoEqTons(roundHosoEqTons(baselineCapacityTons + capacityMaxIncrementTons * growth));
}

/**
 * 【営業人員バジェット検証】1社の営業人員は`salesForceHeadcountTotal`人しかいない
 * （companyLab/fixtures.tsで会社ごとに固定）。販売計画(salesPlans)は「市場×商品」
 * 単位の行で構成されるが、【SAI-2追加作業: 市場別営業配置】以降は「同じ市場の
 * HOSO/PD/VAPは同じ営業チーム（同一人数）を共有する」という前提に変わったため、
 * 単純な行ごとの合計ではなく、**市場ごとに重複排除したうえでの合計**が実在する
 * 営業人員数を超えていないかを検証する（例：CN市場のHOSO/PD/VAP各行に同じ8人と
 * 入力するのは正しい入力であり、8+8+8=24人と誤カウントしてはならない）。
 *
 * 検証内容:
 *   1. 同一市場内の全行で`salesForceHeadcount`が一致していること（不一致は入力ミス。
 *      同一市場に異なる人数を指定することはできない）。
 *   2. 市場ごとに1回だけ数えたうえでの合計人数が、実在する営業人員数を超えないこと。
 *
 * 【設計判断】「各市場ごとの上限」ではなく「全社合計の上限」にしているのは、
 * 現実には同じ営業チームが複数商品を兼務できても、複数市場を同時に掛け持ちする
 * ことは（少なくとも本モデルでは）想定していないため。全社合計を守っていれば、
 * 市場間の配分は会社の裁量に委ねる。
 *
 * 【sales/marketEffort.tsとの関係】applyMarketSalesEffortCapacity内でも同様の
 * 「同一市場内で人数一致」の検証を行っている。本関数は意思決定の受理可否を
 * 会社単位でまとめてエラーにする早期バリデーション（companyLab/runner.ts）で、
 * marketEffort.ts側はエンジン内部（advanceSalesQuarter、どの呼び出し元であっても
 * 必ず通る）での構造的な安全網であり、同じ不変条件を異なる層で確認しているだけで
 * 二重の制約を課しているわけではない。
 */
export function validateSalesForceHeadcountBudget(
  salesPlans: readonly { readonly market: DemandMarketId; readonly salesForceHeadcount: number }[],
  salesForceHeadcountTotal: number
): void {
  const headcountByMarket = new Map<DemandMarketId, number>();
  for (const p of salesPlans) {
    const existing = headcountByMarket.get(p.market);
    if (existing !== undefined && existing !== p.salesForceHeadcount) {
      throw new SalesValidationError(
        `市場 "${p.market}" 内で、商品ごとに異なる営業人員(salesForceHeadcount)が指定されています` +
          `（${existing}人 と ${p.salesForceHeadcount}人）。同一市場内の全商品は同一の営業人員数を共有する必要があります。`
      );
    }
    headcountByMarket.set(p.market, p.salesForceHeadcount);
  }
  const totalAssigned = Array.from(headcountByMarket.values()).reduce((sum, h) => sum + h, 0);
  if (totalAssigned > salesForceHeadcountTotal) {
    throw new SalesValidationError(
      `販売計画(salesPlans)の営業人員(salesForceHeadcount)の合計（市場ごとに重複排除後）が、実在する営業人員数を超えています。` +
        `合計配置人数: ${totalAssigned}人、実在する営業人員数: ${salesForceHeadcountTotal}人。` +
        `同じ人員を複数の市場に重複して配置することはできません（1人は1つの市場にのみ配置可能という前提です。同一市場内の複数商品では共有できます）。`
    );
  }
}
