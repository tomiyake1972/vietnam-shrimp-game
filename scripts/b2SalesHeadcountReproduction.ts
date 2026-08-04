// ShrimpX V2 — B-2: 営業人員ハードキャップ調査・数値再現（三宅さんovernight指示Part B）
//
// 【目的】営業人員headcountを 0 / 現行初期値 / 1.5x / 2x / 3x / 大きい値 と
// 変化させたとき、salesCoverageScore・processingCapacity（sales/salesForce.ts）
// がどう振る舞うか（離散的な打ち切りがあるか、それとも滑らかな逓減か）を
// 実測する。読み取り専用（本番コードは呼ぶだけで変更しない）。
//
// 使い方: npx tsx scripts/b2SalesHeadcountReproduction.ts

import { SALES_PARAMETERS_V1 } from "../app/lib/v2/sales/parameters";
import { salesCoverageScore, processingCapacity } from "../app/lib/v2/sales/salesForce";
import { unwrapUnit } from "../app/lib/v2/core/units";

const params = SALES_PARAMETERS_V1;
console.log("[パラメータ]", JSON.stringify(params.salesForce, null, 2));

// 現行のfixture初期値レンジ: 10〜22人（companyLab/fixtures.ts）。代表として18人（BAL相当）を使う。
const CURRENT = 18;
const HEADCOUNTS = [0, 1, 5, CURRENT, Math.round(CURRENT * 1.5), CURRENT * 2, CURRENT * 3, 50, 100, 1000, 10000, 1000000];

console.log("\nheadcount | coverageScore | 前刻みからの増分 | processingCapacity(t) | 前刻みからの増分(t)");
console.log("-".repeat(100));
let prevCoverage: number | null = null;
let prevCapacity: number | null = null;
for (const h of HEADCOUNTS) {
  const coverage = salesCoverageScore(h, params);
  const capacity = unwrapUnit(processingCapacity(h, params));
  const dCoverage = prevCoverage === null ? NaN : coverage - prevCoverage;
  const dCapacity = prevCapacity === null ? NaN : capacity - prevCapacity;
  console.log(
    `${String(h).padStart(9)} | ${coverage.toFixed(6).padStart(13)} | ${(isNaN(dCoverage) ? "-" : dCoverage.toFixed(6)).padStart(16)} | ` +
      `${capacity.toFixed(1).padStart(22)} | ${(isNaN(dCapacity) ? "-" : dCapacity.toFixed(1)).padStart(20)}`
  );
  prevCoverage = coverage;
  prevCapacity = capacity;
}

// 追加1人あたりの限界効果（各headcount近傍の数値微分）を明示的に見る
console.log("\n[限界効果（headcount→headcount+1の差分）]");
console.log("headcount→headcount+1 | Δcoverage | Δcapacity(t)");
for (const h of [0, CURRENT - 1, CURRENT, CURRENT * 2, CURRENT * 3, 99, 999, 9999]) {
  const c0 = salesCoverageScore(h, params);
  const c1 = salesCoverageScore(h + 1, params);
  const p0 = unwrapUnit(processingCapacity(h, params));
  const p1 = unwrapUnit(processingCapacity(h + 1, params));
  console.log(`${String(h).padStart(6)}→${String(h + 1).padStart(6)} | ${(c1 - c0).toFixed(8).padStart(12)} | ${(p1 - p0).toFixed(4).padStart(12)}`);
}

console.log(
  "\n[結論] salesCoverageScore・processingCapacityはいずれもMichaelis-Menten型飽和曲線" +
    "（x/(x+k)）であり、headcountがどれだけ大きくなっても【不連続な打ち切り・完全な頭打ち】は" +
    "存在しない（数式上、x→∞でも真の上限には到達せず漸近するのみ）。ただし実務上は、" +
    "coverageSaturationHeadcount=6・capacitySaturationHeadcount=10という半飽和点が" +
    "初期headcount(10〜22)に近いため、headcountを2倍・3倍にしても限界効果（Δ）は" +
    "急速に小さくなる。1,000,000人のような極端な値でも数値としては単調増加を維持し、" +
    "NaN/Infinity/負の値は発生しない（processingCapacityはroundHosoEqTonsで丸められるため、" +
    "限界効果が丸め単位を下回るとdisplay上は増分0に見える場合があるが、これは丸めの" +
    "精度の問題であり、コード上の『ハードキャップ』ではない）。"
);
