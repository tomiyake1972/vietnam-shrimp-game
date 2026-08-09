// ShrimpX V2 — Vision駆動の戦略成長・新工場判断の実測（Phase 5 §H ベンチマーク）
//
// 「建てた／建てなかった」だけでなく、**どのゲートで止まったか**を毎ターン出力する。
// simulation engine は診断を縮約して保持するため、ここでは同じ config で
// runCompanyLabWithAutoPolicyForAllCompanies を回し、createStandardAiProvider が
// 収集する完全な診断を読む（ゲーム結果は engine と同一の決定論的経路）。

import { CompanyLabConfig } from "../app/lib/v2/companyLab/types";
import { runCompanyLabWithAutoPolicyForAllCompanies } from "../app/lib/v2/companyLab/runner";
import { createStandardAiProvider } from "../app/lib/v2/companyLab/standardAi/policy";
import { MANAGEMENT_CONSOLE_STANDARD_TURNS } from "../app/lib/v2/companyLab/simulation/types";

const TURNS = Number(process.env.PROBE_TURNS ?? MANAGEMENT_CONSOLE_STANDARD_TURNS);
const ONLY = process.env.PROBE_COMPANY;

const config: CompanyLabConfig = { scenarioId: "baseline", mode: "canonical", seed: "management-console-32q", turns: TURNS };
const { provider, diagnostics } = createStandardAiProvider();
const result = runCompanyLabWithAutoPolicyForAllCompanies(config, provider);
void result;

console.log("turn 会社   成長圧力  gap(t)  gap率  状態             止まったゲート（値） | 理由コード");
for (const diag of diagnostics) {
  if (ONLY && diag.companyId !== ONLY) continue;
  const a = diag.newFactoryAssessment;
  if (!a) continue;
  const failed = a.gates.find((g) => !g.passed);
  const detail = failed ? `${failed.gate} ${JSON.stringify(failed.keyValues)}` : "(全通過)";
  console.log(
    `Q${String(diag.turn).padStart(2)} ${diag.companyId.padEnd(6)} ${a.growthPressure.padEnd(9)} ${Math.round(a.strategicScaleGapTons)
      .toString()
      .padStart(6)} ${(a.strategicScaleGapRatio * 100).toFixed(1).padStart(6)}% ${a.status.padEnd(15)} ${detail} | ${a.reasonCodes.join(",")}`
  );
}

const proposals = diagnostics.filter((d) => d.newFactoryAssessment?.status === "READY_TO_BUILD");
console.log(`\n新工場を提案したターン数: ${proposals.length}`);
for (const p of proposals) console.log(`  Q${p.turn} ${p.companyId}`);
