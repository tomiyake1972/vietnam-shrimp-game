// ShrimpX V2 — SAI-5 監査指摘A（Blocker A）の実効テスト
//
// 【背景】SAI-5D実装時、競争力の合計処理が2箇所（公開ヘルパー
// computeCompetitivenessWeight と 実エンジン allocateMarketProduct の手書き合計）に
// 分岐しており、実エンジン側だけ salesBaseContribution が抜けていた。
// その結果「営業基盤の状態は蓄積されるが、実際の成約量には一切効かない」という
// 状態になっていたにもかかわらず、既存テストは「状態が範囲内に収まる」ことしか
// 見ていなかったため検出できなかった。
//
// 本ファイルは「状態が存在する」ではなく「状態が結果（成約量）を変える」ことを
// 検証する。三宅さんのご指示§1の必須テスト(a)〜(e)に一対一で対応する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { allocateMarketProduct, computeCompetitivenessBreakdown, computeCompetitivenessWeight, sumCompetitivenessContributions } from "../allocation";
import { SALES_PARAMETERS_SAI5_SALES_BASE_V1, SALES_PARAMETERS_V1 } from "../parameters";
import { CompanySalesPlanEntry } from "../types";
import { hosoEqTons, score0to100, unwrapUnit, usdPerHosoEqKg } from "../../core/units";
import { period } from "../../core/period";

const P1 = period(2015, 1);
const BASE_PRICE = usdPerHosoEqKg(4.5);
const TARGET_DEMAND = hosoEqTons(10000);

/**
 * 他条件を完全に一定にした販売計画。営業人員・販売希望量は十分大きく取り、
 * 「処理能力上限・販売希望量上限・最大供給者シェア上限」のいずれにも当たらない
 * ようにする（＝成約量の差が競争力ウェイトの差だけで決まる状態にする）。
 */
function entry(companyId: string, salesBase: number | undefined): CompanySalesPlanEntry {
  return {
    companyId,
    market: "CN",
    product: "hoso",
    desiredQuantity: hosoEqTons(100000),
    priceAdjustmentUsdPerHosoEqKg: 0,
    salesForceHeadcount: 40,
    ...(salesBase !== undefined ? { salesBaseScore: score0to100(salesBase) } : {}),
  };
}

function allocatedOf(
  entries: readonly CompanySalesPlanEntry[],
  params: typeof SALES_PARAMETERS_V1,
  companyId: string
): number {
  const result = allocateMarketProduct("CN", "hoso", P1, entries, BASE_PRICE, TARGET_DEMAND, params);
  const found = result.companies.find((c) => c.companyId === companyId);
  assert.ok(found !== undefined, `会社 ${companyId} の配分結果が見つからない`);
  return unwrapUnit(found.allocatedQuantity);
}

// ---------------------------------------------------------------------------
// (a) 他条件が同一なら、営業基盤100の会社は営業基盤0の会社より多く成約する
// ---------------------------------------------------------------------------

test("SAI-5A修正(a): 他条件同一なら営業基盤100の会社は営業基盤0の会社より多く成約する", () => {
  const entries = [entry("HIGH", 100), entry("LOW", 0), entry("MID", 50)];
  const high = allocatedOf(entries, SALES_PARAMETERS_SAI5_SALES_BASE_V1, "HIGH");
  const low = allocatedOf(entries, SALES_PARAMETERS_SAI5_SALES_BASE_V1, "LOW");
  const mid = allocatedOf(entries, SALES_PARAMETERS_SAI5_SALES_BASE_V1, "MID");

  assert.ok(high > low, `営業基盤100の成約量(${high})が営業基盤0(${low})を上回っていない`);
  assert.ok(high > mid && mid > low, `成約量が営業基盤の単調増加になっていない（100:${high} / 50:${mid} / 0:${low}）`);
  // 差が丸め誤差ではなく、意味のある大きさであること（0.08ウェイト分の差は数%規模になる）
  assert.ok((high - low) / low > 0.05, `営業基盤100と0の成約量差(${((high - low) / low) * 100}%)が小さすぎる`);
});

test("SAI-5A修正(a2): 営業基盤の差は実エンジン(allocateMarketProduct)の競争力ウェイトに反映される", () => {
  const entries = [entry("HIGH", 100), entry("LOW", 0)];
  const result = allocateMarketProduct("CN", "hoso", P1, entries, BASE_PRICE, TARGET_DEMAND, SALES_PARAMETERS_SAI5_SALES_BASE_V1);
  for (const c of result.companies) {
    // 内訳の全項目合計 === 実際に配分で使われたウェイト（分岐していないことの構造的検証）
    assert.equal(
      sumCompetitivenessContributions(c.competitivenessBreakdown),
      c.competitivenessWeight,
      `会社 ${c.companyId} で内訳合計と配分に使われたウェイトが一致しない（合計処理が再び分岐している）`
    );
  }
  const high = result.companies.find((c) => c.companyId === "HIGH");
  const low = result.companies.find((c) => c.companyId === "LOW");
  assert.ok(high !== undefined && low !== undefined);
  assert.ok(high.competitivenessBreakdown.salesBaseContribution > low.competitivenessBreakdown.salesBaseContribution);
  assert.ok(
    high.competitivenessWeight > low.competitivenessWeight,
    `営業基盤の差(${high.competitivenessBreakdown.salesBaseContribution} vs ${low.competitivenessBreakdown.salesBaseContribution})が合成ウェイトに反映されていない`
  );
});

// ---------------------------------------------------------------------------
// (b) ウェイト0のときは営業基盤の値によらず結果が同一
// ---------------------------------------------------------------------------

test("SAI-5A修正(b): 営業基盤ウェイト0のとき、営業基盤100と0の結果は完全に同一", () => {
  const entries = [entry("HIGH", 100), entry("LOW", 0)];
  const result = allocateMarketProduct("CN", "hoso", P1, entries, BASE_PRICE, TARGET_DEMAND, SALES_PARAMETERS_V1);
  const high = result.companies.find((c) => c.companyId === "HIGH");
  const low = result.companies.find((c) => c.companyId === "LOW");
  assert.ok(high !== undefined && low !== undefined);
  assert.equal(high.competitivenessWeight, low.competitivenessWeight, "ウェイト0なのに競争力ウェイトが分かれた");
  assert.equal(unwrapUnit(high.allocatedQuantity), unwrapUnit(low.allocatedQuantity), "ウェイト0なのに成約量が分かれた");
  assert.equal(high.competitivenessBreakdown.salesBaseContribution, 0);
  assert.equal(low.competitivenessBreakdown.salesBaseContribution, 0);
});

// ---------------------------------------------------------------------------
// (c) SAI-5有効時のウェイト合計が設計値どおり
// ---------------------------------------------------------------------------

test("SAI-5A修正(c): 競争力ウェイトの合計は既定・SAI-5有効時ともに設計値1.0（salesBaseは0→0.08）", () => {
  const sum = (w: typeof SALES_PARAMETERS_V1.competitivenessWeights): number =>
    w.price + w.coverage + w.relationship + w.quality + w.deliveryReliability + w.salesBase;

  assert.equal(sum(SALES_PARAMETERS_V1.competitivenessWeights), 1.0);
  assert.equal(SALES_PARAMETERS_V1.competitivenessWeights.salesBase, 0);

  const sai5 = SALES_PARAMETERS_SAI5_SALES_BASE_V1.competitivenessWeights;
  assert.ok(Math.abs(sum(sai5) - 1.0) < 1e-12, `SAI-5有効時のウェイト合計(${sum(sai5)})が1.0でない`);
  assert.equal(sai5.salesBase, 0.08);
  // 価格・納期信頼性の重みは切り出しの対象外（設計判断: parameters.ts参照）
  assert.equal(sai5.price, SALES_PARAMETERS_V1.competitivenessWeights.price);
  assert.equal(sai5.deliveryReliability, SALES_PARAMETERS_V1.competitivenessWeights.deliveryReliability);
});

test("SAI-5A修正(c2): 内訳の全項目合計は公開ヘルパーの返り値と厳密に一致する（両パラメータ）", () => {
  for (const params of [SALES_PARAMETERS_V1, SALES_PARAMETERS_SAI5_SALES_BASE_V1]) {
    for (const salesBase of [0, 50, 100]) {
      const e = entry("X", salesBase);
      const breakdown = computeCompetitivenessBreakdown(e, BASE_PRICE, BASE_PRICE, 0.7, params);
      assert.equal(sumCompetitivenessContributions(breakdown), computeCompetitivenessWeight(e, BASE_PRICE, BASE_PRICE, 0.7, params));
    }
  }
});

// ---------------------------------------------------------------------------
// (d) 営業基盤の導入だけで、5社合計の競争力が0.08分不自然に目減りしない
// ---------------------------------------------------------------------------

test("SAI-5A修正(d): 全社が中立基盤50のとき、SAI-5ウェイト導入で5社合計の競争力・成約量が不自然に減らない", () => {
  // 全社中立（basis 50）＝「営業基盤という概念が入っただけで、まだ誰も差をつけていない」状態。
  // このとき5社合計の競争力・成約量が大きく落ちるなら、0.08の切り出しが
  // 外部選択肢（externalOptionWeight=0.35）に対して5社を構造的に不利にしている。
  const entries = ["A", "B", "C", "D", "E"].map((id) => entry(id, 50));

  const baseResult = allocateMarketProduct("CN", "hoso", P1, entries, BASE_PRICE, TARGET_DEMAND, SALES_PARAMETERS_V1);
  const sai5Result = allocateMarketProduct("CN", "hoso", P1, entries, BASE_PRICE, TARGET_DEMAND, SALES_PARAMETERS_SAI5_SALES_BASE_V1);

  const sumWeight = (r: typeof baseResult): number => r.companies.reduce((s, c) => s + c.competitivenessWeight, 0);
  const sumAllocated = (r: typeof baseResult): number => r.companies.reduce((s, c) => s + unwrapUnit(c.allocatedQuantity), 0);

  const weightDrop = (sumWeight(baseResult) - sumWeight(sai5Result)) / sumWeight(baseResult);
  const allocDrop = (sumAllocated(baseResult) - sumAllocated(sai5Result)) / sumAllocated(baseResult);

  // 中立基盤50 は「切り出した0.08の半分（0.04）が返ってくる」設計なので、
  // 残差は coverage 側の切り出し（0.04 × カバレッジスコア）に由来する数%以内に収まる。
  assert.ok(Math.abs(weightDrop) < 0.05, `5社合計の競争力が${(weightDrop * 100).toFixed(2)}%変化した（許容±5%）`);
  assert.ok(Math.abs(allocDrop) < 0.05, `5社合計の成約量が${(allocDrop * 100).toFixed(2)}%変化した（許容±5%）`);
  // 外部選択肢へ流れる需要も大きく増えていないこと（＝5社の総取り分が構造的に削られていない）
  const externalIncrease =
    (unwrapUnit(sai5Result.externalOptionQuantity) - unwrapUnit(baseResult.externalOptionQuantity)) / unwrapUnit(baseResult.externalOptionQuantity);
  assert.ok(Math.abs(externalIncrease) < 0.10, `外部選択肢への流出が${(externalIncrease * 100).toFixed(2)}%変化した（許容±10%）`);
});

test("SAI-5A修正(d2): 5社が営業基盤を築いた状態では、5社合計の成約量が中立時を上回る", () => {
  // 「営業基盤を積む」という行為に、5社全体として意味があること（努力が報われる方向）。
  const neutral = ["A", "B", "C", "D", "E"].map((id) => entry(id, 50));
  const built = ["A", "B", "C", "D", "E"].map((id) => entry(id, 85));

  const sumAllocated = (es: readonly CompanySalesPlanEntry[]): number =>
    allocateMarketProduct("CN", "hoso", P1, es, BASE_PRICE, TARGET_DEMAND, SALES_PARAMETERS_SAI5_SALES_BASE_V1).companies.reduce(
      (s, c) => s + unwrapUnit(c.allocatedQuantity),
      0
    );

  assert.ok(sumAllocated(built) > sumAllocated(neutral), "全社が営業基盤を築いても5社合計の成約量が増えない");
});

// ---------------------------------------------------------------------------
// (e) 機能フラグOFF（既定パラメータ）では既存の基準結果と完全一致
// ---------------------------------------------------------------------------

test("SAI-5A修正(e): 既定パラメータでは salesBaseScore の有無で結果がビット単位で一致する", () => {
  const withScores = ["A", "B", "C", "D", "E"].map((id, i) => entry(id, i * 25));
  const withoutScores = ["A", "B", "C", "D", "E"].map((id) => entry(id, undefined));

  const a = allocateMarketProduct("CN", "hoso", P1, withScores, BASE_PRICE, TARGET_DEMAND, SALES_PARAMETERS_V1);
  const b = allocateMarketProduct("CN", "hoso", P1, withoutScores, BASE_PRICE, TARGET_DEMAND, SALES_PARAMETERS_V1);

  assert.deepEqual(
    a.companies.map((c) => ({ id: c.companyId, w: c.competitivenessWeight, q: unwrapUnit(c.allocatedQuantity) })),
    b.companies.map((c) => ({ id: c.companyId, w: c.competitivenessWeight, q: unwrapUnit(c.allocatedQuantity) })),
    "機能フラグOFFで営業基盤の値が結果に影響している（後方互換の破壊）"
  );
  assert.equal(unwrapUnit(a.externalOptionQuantity), unwrapUnit(b.externalOptionQuantity));
});
