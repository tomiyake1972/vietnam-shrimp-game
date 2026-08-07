#!/usr/bin/env -S npx tsx
// ShrimpX V2 — SAI-5 監査指摘B: 供給圧力の定義候補の実測比較
//
// 三宅さんのご指示§2「先に係数を調整せず、まず分子と分母の意味をそろえる。
// 候補を実測で比較し、採用条件を満たすものを採る」に対応する測定スクリプト。
//
// 比較する定義（marketEvolution.ts の SupplyPressureDefinition）:
//   raw_target_demand  … 旧実装（5社提示量 ÷ 全ベトナム対象需要）
//   addressable_demand … 候補(i) 5社提示量 ÷ 5社が構造的に取れる需要
//   neutral_baseline   … 候補(ii) 生比率 ÷ その長期EWMA（無次元指数）
//   completed_supply   … 候補(iii) (5社提示量＋外部供給量) ÷ 全ベトナム対象需要
//
// 採用条件（ご指示の8項目）のうち、実運転で測れるものをここで判定する:
//   [1] 同一条件・中立状態で圧力が概ね1.0を中心にする
//   [6] 季節変動だけで上下限へ一方向に張り付かない（32Qで判定）
//   [8] 上下限への張り付き率
// 方向性（供給増→圧力↑ / 供給減→圧力↓ / 圧力↑→翌期プレミアム↓ / ↓→↑）は
// 制御された合成入力で検証する必要があるため、
// app/lib/v2/companyLab/__tests__/supplyPressureDefinition.test.ts が担当する。
//
// 出力: artifacts/sai5/supply-pressure-study/{summary.json,summary.md,trace.csv}

import * as fs from "node:fs";
import * as path from "node:path";
import { runAutoplayCase } from "../app/lib/v2/companyLab/standardAi/autoplay/runCase";
import { ALL_COMPANY_IDS } from "../app/lib/v2/companyLab/standardAi/report/decomposeHarness";
import {
  STANDARD_BASELINE_CANDIDATES,
  SELECTED_STANDARD_BASELINE_CANDIDATE_ID,
} from "../app/lib/v2/companyLab/standardAi/report/standardBaseline";
import { MARKET_EVOLUTION_PARAMETERS_V1, SupplyPressureDefinition } from "../app/lib/v2/companyLab/marketEvolution";

const candidate = STANDARD_BASELINE_CANDIDATES.find((c) => c.id === SELECTED_STANDARD_BASELINE_CANDIDATE_ID)!;
const SEEDS = Array.from({ length: 4 }, (_, i) => `sai5-ab-${String(i + 1).padStart(3, "0")}`);
const QUARTERS = 32;
const DEFINITIONS: readonly SupplyPressureDefinition[] = ["raw_target_demand", "addressable_demand", "neutral_baseline", "completed_supply"];
const PRODUCTS = ["pd", "vap"] as const;

const FLOOR = MARKET_EVOLUTION_PARAMETERS_V1.premiumMultiplierFloor;
const CAP = MARKET_EVOLUTION_PARAMETERS_V1.premiumMultiplierCap;

interface QuarterRow {
  definition: SupplyPressureDefinition;
  seed: string;
  turn: number;
  product: "pd" | "vap";
  offered: number;
  targetDemand: number;
  addressableDemand: number;
  externalOptionQuantity: number;
  rawPressure: number;
  pressureEwma: number;
  appliedPremiumMultiplier: number;
}

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? NaN : xs.reduce((s, v) => s + v, 0) / xs.length;
}
function median(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 === 1 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}
function stdev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1));
}

function main(): void {
  const rows: QuarterRow[] = [];
  let errorCases = 0;

  for (const definition of DEFINITIONS) {
    for (const seed of SEEDS) {
      let result;
      try {
        result = runAutoplayCase({
          scenarioId: "baseline",
          seed,
          quarters: QUARTERS,
          companyIds: ALL_COMPANY_IDS,
          candidate,
          // 供給圧力の定義そのものを比べるため、SAI-5Eフィードバックは必ずON。
          // 他の機能も全ON（本番configと同じ相互作用の下で測る）。
          managementProfilesEnabled: true,
          marketProductOrientationEnabled: true,
          heterogeneousInitialConditionsEnabled: true,
          productLifecycleEnabled: true,
          salesBaseAccumulationEnabled: true,
          supplyPremiumFeedbackEnabled: true,
          standardAiCapexEnabled: true,
          supplyPressureDefinition: definition,
        });
      } catch (e) {
        errorCases += 1;
        console.error(`[${definition}] seed=${seed} エラー:`, e instanceof Error ? e.message : e);
        continue;
      }
      for (const h of result.history) {
        const ev = h.sai5MarketEvolution;
        if (!ev) continue;
        for (const product of PRODUCTS) {
          rows.push({
            definition,
            seed,
            turn: h.turn,
            product,
            offered: ev.offeredByProduct[product],
            targetDemand: ev.targetDemandByProduct[product],
            addressableDemand: ev.addressableDemandByProduct[product],
            externalOptionQuantity: ev.externalOptionQuantityByProduct[product],
            rawPressure: ev.supplyPressureByProduct[product],
            pressureEwma: ev.supplyPressureEwmaByProduct[product],
            appliedPremiumMultiplier: ev.appliedPremiumRatioMultipliers[product],
          });
        }
      }
      console.log(`  ${definition} / ${seed}: ${result.completedTurns}Q 完走`);
    }
  }

  // --- 定義×商品ごとの判定 ---
  const evaluations = [];
  for (const definition of DEFINITIONS) {
    for (const product of PRODUCTS) {
      const subset = rows.filter((r) => r.definition === definition && r.product === product);
      if (subset.length === 0) continue;
      const raw = subset.map((r) => r.rawPressure);
      const ewma = subset.map((r) => r.pressureEwma);
      const mult = subset.map((r) => r.appliedPremiumMultiplier);
      const atFloor = mult.filter((m) => m <= FLOOR + 1e-9).length / mult.length;
      const atCap = mult.filter((m) => m >= CAP - 1e-9).length / mult.length;
      // 「一方向への張り付き」= 後半16Qの倍率がすべて床 or すべて天井
      const lateHalf = subset.filter((r) => r.turn > QUARTERS / 2).map((r) => r.appliedPremiumMultiplier);
      const pegged = lateHalf.length > 0 && (lateHalf.every((m) => m <= FLOOR + 1e-9) || lateHalf.every((m) => m >= CAP - 1e-9));
      evaluations.push({
        definition,
        product,
        samples: subset.length,
        rawPressureMedian: median(raw),
        rawPressureMean: mean(raw),
        rawPressureStdev: stdev(raw),
        rawPressureMin: Math.min(...raw),
        rawPressureMax: Math.max(...raw),
        pressureEwmaMedian: median(ewma),
        premiumMultiplierMedian: median(mult),
        premiumMultiplierMin: Math.min(...mult),
        premiumMultiplierMax: Math.max(...mult),
        shareAtFloor: atFloor,
        shareAtCap: atCap,
        // 判定[1]: 中心が1.0の±20%以内か
        centeredNearOne: Math.abs(median(raw) - 1) <= 0.2,
        // 判定[6][8]: 後半で上下限へ一方向に張り付いていないか
        oneSidedlyPegged: pegged,
      });
    }
  }

  const outDir = path.resolve(process.cwd(), "artifacts/sai5/supply-pressure-study");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "summary.json"),
    JSON.stringify(
      {
        generator: "scripts/sai5SupplyPressureStudy.ts",
        seeds: SEEDS,
        quarters: QUARTERS,
        errorCases,
        premiumMultiplierFloor: FLOOR,
        premiumMultiplierCap: CAP,
        evaluations,
      },
      null,
      2
    )
  );

  const csv = [
    "definition,seed,turn,product,offered,targetDemand,addressableDemand,externalOptionQuantity,rawPressure,pressureEwma,appliedPremiumMultiplier",
    ...rows.map((r) =>
      [
        r.definition,
        r.seed,
        r.turn,
        r.product,
        r.offered.toFixed(2),
        r.targetDemand.toFixed(2),
        r.addressableDemand.toFixed(2),
        r.externalOptionQuantity.toFixed(2),
        r.rawPressure.toFixed(6),
        r.pressureEwma.toFixed(6),
        r.appliedPremiumMultiplier.toFixed(6),
      ].join(",")
    ),
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "trace.csv"), csv);

  const lines: string[] = [];
  lines.push("# SAI-5 監査指摘B — 供給圧力の定義候補 実測比較");
  lines.push("");
  lines.push(`${SEEDS.length} seed × ${QUARTERS}Q、SAI-5全機能ON。定義以外の条件はすべて同一。`);
  lines.push("");
  lines.push("| 定義 | 商品 | 生圧力 中央値 | 平均 | 標準偏差 | 最小 | 最大 | 倍率中央値 | 倍率最小 | 倍率最大 | 床張付率 | 天井張付率 | [1]1.0中心 | [6][8]一方向張付 |");
  lines.push("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|:-:|:-:|");
  for (const e of evaluations) {
    lines.push(
      `| ${e.definition} | ${e.product} | ${e.rawPressureMedian.toFixed(3)} | ${e.rawPressureMean.toFixed(3)} | ${e.rawPressureStdev.toFixed(3)} | ${e.rawPressureMin.toFixed(3)} | ${e.rawPressureMax.toFixed(3)} | ${e.premiumMultiplierMedian.toFixed(3)} | ${e.premiumMultiplierMin.toFixed(3)} | ${e.premiumMultiplierMax.toFixed(3)} | ${(e.shareAtFloor * 100).toFixed(1)}% | ${(e.shareAtCap * 100).toFixed(1)}% | ${e.centeredNearOne ? "○" : "×"} | ${e.oneSidedlyPegged ? "×(張付)" : "○"} |`
    );
  }
  lines.push("");
  lines.push("判定[1]: 生の供給圧力の中央値が 1.0 ± 0.2 の範囲にあるか（分子・分母の母集団が一致していれば中立状態で1.0付近になる）。");
  lines.push("判定[6][8]: 後半16Qのプレミアム倍率がすべて床（0.6）またはすべて天井（1.4）に張り付いていないか。");
  lines.push("");
  fs.writeFileSync(path.join(outDir, "summary.md"), lines.join("\n"));
  console.log(`\n出力: ${outDir}/{summary.json,summary.md,trace.csv}`);
  console.log(lines.slice(4).join("\n"));
}

main();
