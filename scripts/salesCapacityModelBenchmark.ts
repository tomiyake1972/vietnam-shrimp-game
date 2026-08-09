// ShrimpX V2 — Phase 6B §8〜§11 営業能力モデル比較ベンチマーク
//
// **正式モデルは決め打ちしない**（#04 §16）。Control / Case A / Case B / Case C を
// 同一 baseline・同一 seed・5社×32Q で回し、比較材料だけを出す。

import { SALES_PARAMETERS_V1, SalesParameters } from "../app/lib/v2/sales/parameters";
import { SalesCapacityModel, companySalesOrganizationCapacity, marketFragmentationFactor } from "../app/lib/v2/sales/salesCapacityModel";
import { processingCapacity } from "../app/lib/v2/sales/salesForce";
import { unwrapUnit } from "../app/lib/v2/core/units";
import { Product } from "../app/lib/v2/market/types";

const n = (v: number, w = 7) => Math.round(v).toLocaleString().padStart(w);

// ---------------------------------------------------------------------
// 候補モデル（#04 §2）
// ---------------------------------------------------------------------

/** Case A: 現行構造（市場単位）のまま、曲線パラメータだけ再校正。 */
function caseAParams(effort: Readonly<Record<Product, number>>): SalesParameters {
  return {
    ...SALES_PARAMETERS_V1,
    salesForce: {
      ...SALES_PARAMETERS_V1.salesForce,
      // 市場あたり20〜36人という現実的な人数帯で伸びるよう半飽和点を下げ、
      // 上限は据え置く（市場単位のまま到達可能にする最小変更）。
      capacitySaturationHeadcount: 18,
      capacityMaxIncrementTons: 24_000,
    },
    salesEffortCoefficients: effort,
  };
}

/** Case B: 会社全体で1回だけ能力を求め、市場へ配分する。 */
function caseBParams(effort: Readonly<Record<Product, number>>, model?: Partial<SalesCapacityModel>): SalesParameters {
  return {
    ...SALES_PARAMETERS_V1,
    salesEffortCoefficients: effort,
    salesCapacityModel: {
      kind: "companyWide",
      companyBaselineCapacityTons: 1_000,
      companyCapacityMaxIncrementTons: 95_000,
      companyCapacitySaturationHeadcount: 190,
      fragmentationPenaltyPerExtraMarket: 0,
      fragmentationFloor: 1,
      ...model,
    },
  };
}

/** Case C: Case B ＋ 市場展開の非効率（5市場で 0.88 倍）。 */
function caseCParams(effort: Readonly<Record<Product, number>>): SalesParameters {
  return caseBParams(effort, {
    kind: "companyWideWithFragmentation",
    fragmentationPenaltyPerExtraMarket: 0.03,
    fragmentationFloor: 0.85,
  });
}

const V1: Readonly<Record<Product, number>> = { hoso: 1.0, pd: 1.2, vap: 3.0 };
const V2: Readonly<Record<Product, number>> = { hoso: 1.0, pd: 1.2, vap: 2.0 };
const V3: Readonly<Record<Product, number>> = { hoso: 1.0, pd: 1.25, vap: 1.75 };

const CANDIDATES: readonly { readonly name: string; readonly params: SalesParameters }[] = [
  { name: "Control (現行)", params: SALES_PARAMETERS_V1 },
  { name: "Case A + V1", params: caseAParams(V1) },
  { name: "Case B + V1", params: caseBParams(V1) },
  { name: "Case B + V2", params: caseBParams(V2) },
  { name: "Case C + V1", params: caseCParams(V1) },
  { name: "Case C + V2", params: caseCParams(V2) },
  { name: "Case C + V3", params: caseCParams(V3) },
];

// ---------------------------------------------------------------------
// §10 Growth ladder（シミュレーション不要・能力式だけで出せる）
// ---------------------------------------------------------------------

/** 商品構成別の 1t あたり営業工数。 */
const MIXES: readonly { readonly name: string; readonly share: Readonly<Record<Product, number>> }[] = [
  { name: "HOSO中心", share: { hoso: 0.7, pd: 0.2, vap: 0.1 } },
  { name: "PD中心", share: { hoso: 0.2, pd: 0.6, vap: 0.2 } },
  { name: "VAP中心", share: { hoso: 0.2, pd: 0.2, vap: 0.6 } },
  { name: "mixed", share: { hoso: 0.4, pd: 0.35, vap: 0.25 } },
];

function effortPerTon(effort: Readonly<Record<Product, number>>, share: Readonly<Record<Product, number>>): number {
  return (["hoso", "pd", "vap"] as const).reduce((s, p) => s + effort[p] * share[p], 0);
}

/** その候補が headcount 人で処理できる実売トン数（5市場・需要比例配分を前提）。 */
function sellableTons(params: SalesParameters, headcount: number, mixShare: Readonly<Record<Product, number>>, marketCount = 5): number {
  const perTon = effortPerTon(params.salesEffortCoefficients, mixShare);
  const model = params.salesCapacityModel;
  let effortCapacity: number;
  if (!model || model.kind === "perMarket") {
    // 市場単位: 需要比例配分なので、均等展開時は headcount/marketCount 人ずつ。
    const perMarket = Math.floor(headcount / marketCount);
    effortCapacity = marketCount * unwrapUnit(processingCapacity(perMarket, params));
  } else {
    effortCapacity = companySalesOrganizationCapacity(headcount, model) * marketFragmentationFactor(marketCount, model);
  }
  return effortCapacity / perTon;
}

console.log("=== Phase 6B 営業能力モデル比較（baseline / seed=management-console-32q）===\n");

console.log("【§10 Growth ladder: 各モデルが処理できる実売トン/四半期（5市場展開）】");
console.log("  目安: 60人→15〜18k / 100人→25〜30k / 130人→30〜35k / 160〜180人→40k級\n");
for (const mix of MIXES) {
  console.log(`  --- ${mix.name} ---`);
  console.log("  モデル                60人     100人     130人     160人     180人");
  for (const c of CANDIDATES) {
    const cells = [60, 100, 130, 160, 180].map((h) => n(sellableTons(c.params, h, mix.share), 9)).join("");
    console.log(`  ${c.name.padEnd(16)}${cells}`);
  }
  console.log("");
}

// ---------------------------------------------------------------------
// 【未実施】§8〜§9 の 32Q マルチ候補ベンチマーク
// ---------------------------------------------------------------------
// SalesParameters を runner・Standard AI の両方へ注入する配線が未実装のため、
// このスクリプトでは Growth Ladder（能力式だけで決まる部分）のみを出す。
// 32Q 実走比較は配線を追加してから行う。
