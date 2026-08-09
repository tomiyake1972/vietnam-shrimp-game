// ShrimpX V2 — 市場配分モデル監査（#04 D/E 12項目）
//
// 【READ ONLY】このスクリプトは一切のパラメータ・モデルを変更しない。
// #04 §G「market配分については parameter変更 / market demand変更 /
// external outflow変更 / maximumSupplierShare変更をまだ行わない」に従い、
// 既存コードを走らせて観測するだけである。
//
// 目的: 5社の合計シェアが 25〜30% に張り付くのは
//   (A) 意図された世界設計（他産地・非購入が主役）なのか
//   (B) 旧パラメータが偶然固定してしまっているのか
// を、コードの構造と実測の両方から切り分ける。

import { CompanyLabConfig } from "../app/lib/v2/companyLab/types";
import { runCompanyLabWithAutoPolicyForAllCompanies } from "../app/lib/v2/companyLab/runner";
import { createStandardAiProvider } from "../app/lib/v2/companyLab/standardAi/policy";
import { SALES_PARAMETERS_V1 } from "../app/lib/v2/sales/parameters";
import { unwrapUnit } from "../app/lib/v2/core/units";

const TURNS = Number(process.env.ALLOC_TURNS ?? 32);
const P = SALES_PARAMETERS_V1;
const n = (v: number, w = 9) => Math.round(v).toLocaleString().padStart(w);
const pct = (v: number, w = 6) => `${(v * 100).toFixed(1).padStart(w)}%`;

const config: CompanyLabConfig = { scenarioId: "baseline", mode: "canonical", seed: "management-console-32q", turns: TURNS };
const { provider } = createStandardAiProvider();
const result = runCompanyLabWithAutoPolicyForAllCompanies(config, provider);

console.log("=== 市場配分モデル監査（READ ONLY・baseline / seed=management-console-32q / 32Q）===\n");

// ---------------------------------------------------------------------
// 監査1〜4: TRUE需要の定義と、5社が奪い合っている需要の正体
// ---------------------------------------------------------------------

console.log("【監査1〜4 需要の階層（コード上の定義）】");
console.log("  worldDemand                 market/globalDemand.ts  … 世界全体の需要");
console.log("  hosoPrices.VN.allocatedDemand market/hosoPricing.ts  … そのうちベトナム産が獲得した数量");
console.log("  targetDemand(市場×商品)      sales/marketAdapter.ts … 上をa)商品構成比 b)市場ウェイトで按分したもの");
console.log("  → **5社が奪い合っているのは world 需要ではなく『ベトナムが既に獲得した需要』である**");
console.log("  → その各セルの中で、5社と EXTERNAL_OPTION（他のベトナム供給者・非購入）が水位法で競合する\n");

for (const turn of [1, 8, 16, 24, 32].filter((t) => t <= TURNS)) {
  const h = result.history.find((x) => x.turn === turn);
  if (!h) continue;
  const world = unwrapUnit(h.marketResult.worldDemand);
  const vnAllocated = unwrapUnit(h.marketResult.hosoPrices.VN.allocatedDemand);
  const target = h.salesRecord.allocations.reduce((s, a) => s + unwrapUnit(a.targetDemand), 0);
  const contracted = h.salesRecord.allocations.reduce(
    (s, a) => s + a.companies.reduce((s2, c) => s2 + unwrapUnit(c.allocatedQuantity), 0),
    0
  );
  const external = h.salesRecord.allocations.reduce((s, a) => s + unwrapUnit(a.externalOptionQuantity), 0);
  if (turn === 1) {
    console.log("   Q  world需要  VN獲得需要  VN獲得/world  targetDemand合計   5社成約  5社/target  外部流出  外部/target");
  }
  console.log(
    `  ${String(turn).padStart(2)} ${n(world)} ${n(vnAllocated)} ${pct(world > 0 ? vnAllocated / world : 0, 13)} ${n(
      target,
      17
    )} ${n(contracted)} ${pct(target > 0 ? contracted / target : 0, 11)} ${n(external)} ${pct(target > 0 ? external / target : 0, 11)}`
  );
}

// ---------------------------------------------------------------------
// 監査5〜7: maximumSupplierShare の意味・単位
// ---------------------------------------------------------------------

console.log("\n【監査5〜7 maximumSupplierShare = 0.35 の適用単位（sales/allocation.ts:264）】");
console.log(`  値: ${P.maximumSupplierShare}（sales/parameters.ts:181）`);
console.log("  式: shareCap = targetDemand(その市場×商品セル) × 0.35");
console.log("      cap = min(希望販売量, processingCapacity(その市場の営業人数), shareCap, 承認取引枠)");
console.log("  適用単位: **会社単位**（産地単位ではない）。maximumSupplierShareFor(entry, params) は");
console.log("            entry を使わず定数を返す（会社別の動的化は未実装の拡張ポイント）。");
console.log("  セル単位: **市場×商品×四半期**。市場合計でも会社合計でもない。");
console.log(`  → 5社が全員上限に張り付いた場合の理論上限は 5 × 0.35 = ${(5 * P.maximumSupplierShare * 100).toFixed(0)}%（>100%なので、`);
console.log("     この上限だけでは 5社合計を縛れない。実際に縛っているのは別の要因である。\n");

console.log("  【実測】各セルで cap（＝0.35）に到達している会社数の分布");
{
  const hist = new Map<number, number>();
  let cells = 0;
  for (const h of result.history) {
    for (const a of h.salesRecord.allocations) {
      const capTons = unwrapUnit(a.targetDemand) * P.maximumSupplierShare;
      if (capTons <= 1e-6) continue;
      cells += 1;
      const atCap = a.companies.filter((c) => unwrapUnit(c.allocatedQuantity) >= capTons - 0.5).length;
      hist.set(atCap, (hist.get(atCap) ?? 0) + 1);
    }
  }
  console.log(`  対象セル数: ${cells.toLocaleString()}`);
  for (const [k, v] of [...hist].sort((a, b) => a[0] - b[0])) {
    console.log(`    上限到達 ${k} 社: ${String(v).padStart(6)} セル (${((v / cells) * 100).toFixed(1)}%)`);
  }
}

// ---------------------------------------------------------------------
// 監査8: 外部流出の計算方法
// ---------------------------------------------------------------------

console.log("\n【監査8 external outflow の計算（sales/allocation.ts:270〜277）】");
console.log(`  EXTERNAL_OPTION は水位法の参加者の1つとして、weight=${P.externalOptionWeight}、cap=+∞ で参加する。`);
console.log("  → 需要は「5社の合成競争力」対「外部の固定ウェイト0.35」の比で配分される。");
console.log("  → 外部は cap を持たないため、5社が cap で止まると残りは**全額**外部へ流れる。");
console.log("  → 外部ウェイトは価格・品質・信頼にまったく反応しない固定値である（競争相手として動かない）。\n");

console.log("  【実測】5社の合成競争力合計 vs 外部ウェイト（Q32・市場×商品セル別）");
{
  const h = result.history[result.history.length - 1];
  console.log("  市場  商品  targetDemand  5社競争力計 外部ウェイト 競争力比 5社成約   外部流出  5社シェア");
  for (const a of [...h.salesRecord.allocations].sort((x, y) => `${x.market}${x.product}`.localeCompare(`${y.market}${y.product}`))) {
    const wSum = a.companies.reduce((s, c) => s + c.competitivenessWeight, 0);
    const contracted = a.companies.reduce((s, c) => s + unwrapUnit(c.allocatedQuantity), 0);
    const target = unwrapUnit(a.targetDemand);
    if (target < 1) continue;
    console.log(
      `  ${a.market.padEnd(6)}${a.product.padEnd(6)}${n(target, 12)} ${wSum.toFixed(3).padStart(11)} ${P.externalOptionWeight
        .toFixed(3)
        .padStart(12)} ${(wSum / (wSum + P.externalOptionWeight)).toFixed(3).padStart(8)} ${n(contracted, 7)} ${n(
        unwrapUnit(a.externalOptionQuantity),
        10
      )} ${pct(target > 0 ? contracted / target : 0, 10)}`
    );
  }
}

// ---------------------------------------------------------------------
// 監査9〜10: 何が実際に5社のシェアを縛っているのか（binding constraint の分解）
// ---------------------------------------------------------------------

console.log("\n【監査9〜10 各セルで5社の cap を実際に縛っていた要因（Q1〜Q32の全セル×会社）】");
{
  const counts = new Map<string, number>();
  let total = 0;
  for (const h of result.history) {
    const plans = h.decisions.flatMap((d) => d.salesPlans);
    for (const a of h.salesRecord.allocations) {
      const shareCap = unwrapUnit(a.targetDemand) * P.maximumSupplierShare;
      for (const c of a.companies) {
        const plan = plans.find((p) => p.companyId === c.companyId && p.market === a.market && p.product === a.product);
        if (!plan) continue;
        const desired = unwrapUnit(plan.desiredQuantity);
        const capacity = unwrapUnit(c.processingCapacity);
        if (desired <= 1e-6) continue;
        total += 1;
        const binding =
          desired <= Math.min(capacity, shareCap) ? "希望販売量（自社が売りたい量）" : capacity <= shareCap ? "processingCapacity（営業）" : "maximumSupplierShare 0.35";
        // 実際に配分がその上限に達したかどうかも見る。
        const allocated = unwrapUnit(c.allocatedQuantity);
        const cap = Math.min(desired, capacity, shareCap);
        const reached = allocated >= cap - 0.5;
        const key = `${binding} / ${reached ? "上限に到達した" : "上限に届かなかった（競争力配分で決まった）"}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  console.log(`  対象: ${total.toLocaleString()} 件（会社×市場×商品×四半期、希望販売量>0のもの）`);
  for (const [k, v] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(v).padStart(6)} 件 (${((v / total) * 100).toFixed(1).padStart(5)}%)  ${k}`);
  }
}

// ---------------------------------------------------------------------
// 監査11: 強い会社は外部からシェアを奪えるのか（価格・品質・信頼の効き）
// ---------------------------------------------------------------------

console.log("\n【監査11 競争力の内訳が5社シェアへどう効くか（Q32・会社別平均）】");
{
  const h = result.history[result.history.length - 1];
  const byCompany = new Map<string, { w: number; price: number; coverage: number; rel: number; qual: number; del: number; base: number; vap: number; cells: number }>();
  for (const a of h.salesRecord.allocations) {
    for (const c of a.companies) {
      const e = byCompany.get(c.companyId) ?? { w: 0, price: 0, coverage: 0, rel: 0, qual: 0, del: 0, base: 0, vap: 0, cells: 0 };
      e.w += c.competitivenessWeight;
      e.price += c.competitivenessBreakdown.priceContribution;
      e.coverage += c.competitivenessBreakdown.coverageContribution;
      e.rel += c.competitivenessBreakdown.relationshipContribution;
      e.qual += c.competitivenessBreakdown.qualityContribution;
      e.del += c.competitivenessBreakdown.deliveryReliabilityContribution;
      e.base += c.competitivenessBreakdown.salesBaseContribution;
      e.vap += c.competitivenessBreakdown.vapCapabilityContribution;
      e.cells += 1;
      byCompany.set(c.companyId, e);
    }
  }
  console.log("  会社   合成競争力  価格   カバレッジ  関係  品質  納期  営業基盤 VAP能力  外部(0.35)との比");
  for (const [companyId, e] of [...byCompany].sort((a, b) => a[0].localeCompare(b[0]))) {
    const k = e.cells;
    console.log(
      `  ${companyId.padEnd(6)}${(e.w / k).toFixed(3).padStart(10)}${(e.price / k).toFixed(3).padStart(8)}${(e.coverage / k)
        .toFixed(3)
        .padStart(11)}${(e.rel / k).toFixed(3).padStart(7)}${(e.qual / k).toFixed(3).padStart(6)}${(e.del / k).toFixed(3).padStart(6)}${(
        e.base / k
      )
        .toFixed(3)
        .padStart(9)}${(e.vap / k).toFixed(3).padStart(8)}${(e.w / k / P.externalOptionWeight).toFixed(2).padStart(17)}`
    );
  }
  console.log(`  ※ competitivenessWeights: salesBase=${P.competitivenessWeights.salesBase} / vapCapability=${P.competitivenessWeights.vapCapability}（現行は0＝無効）`);
}

// ---------------------------------------------------------------------
// 監査12: 弱い会社はシェアを失うのか（会社間のばらつき）
// ---------------------------------------------------------------------

console.log("\n【監査12 5社間のシェア格差（Q32・会社別の targetDemand に対するシェア）】");
{
  const h = result.history[result.history.length - 1];
  const target = h.salesRecord.allocations.reduce((s, a) => s + unwrapUnit(a.targetDemand), 0);
  const byCompany = new Map<string, number>();
  for (const a of h.salesRecord.allocations) {
    for (const c of a.companies) byCompany.set(c.companyId, (byCompany.get(c.companyId) ?? 0) + unwrapUnit(c.allocatedQuantity));
  }
  for (const [companyId, v] of [...byCompany].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${companyId.padEnd(6)}${n(v)} t   シェア ${pct(target > 0 ? v / target : 0)}`);
  }
  const values = [...byCompany.values()];
  console.log(`  最大/最小 = ${(Math.max(...values) / Math.min(...values)).toFixed(2)} 倍`);
}

// ---------------------------------------------------------------------
// 監査: シェアの時系列（固定されているのか、動いているのか）
// ---------------------------------------------------------------------

console.log("\n【5社合計シェアの推移（固定 or 変動の判定）】");
console.log("   Q  targetDemand   5社成約 5社シェア  外部流出 外部シェア");
for (const h of result.history) {
  const target = h.salesRecord.allocations.reduce((s, a) => s + unwrapUnit(a.targetDemand), 0);
  const contracted = h.salesRecord.allocations.reduce((s, a) => s + a.companies.reduce((s2, c) => s2 + unwrapUnit(c.allocatedQuantity), 0), 0);
  const external = h.salesRecord.allocations.reduce((s, a) => s + unwrapUnit(a.externalOptionQuantity), 0);
  console.log(
    `  ${String(h.turn).padStart(2)} ${n(target, 13)} ${n(contracted)} ${pct(target > 0 ? contracted / target : 0, 9)} ${n(
      external
    )} ${pct(target > 0 ? external / target : 0, 10)}`
  );
}

// ---------------------------------------------------------------------
// 追加所見: allocation.ts が営業能力モデルを通っていない件（SSoT の穴）
// ---------------------------------------------------------------------

console.log("\n【追加所見: sales/allocation.ts:249 は processingCapacity を直接呼んでいる】");
console.log("  allocateMarketProduct 内の個社成約上限は");
console.log("    cap = min(希望販売量, processingCapacity(その市場の営業人数), targetDemand×0.35, 承認枠)");
console.log("  であり、Phase 6B で新設した computeMarketSalesCapacities（会社全体モデル）を通らない。");
console.log("  → 販売計画は会社全体モデルで縮小されるが、成約配分では**旧・市場別曲線が二重に効く**。");
console.log("  → 営業能力モデルを正式採用する場合、ここを同じ SSoT へ寄せる必要がある（今回は変更しない）。");
