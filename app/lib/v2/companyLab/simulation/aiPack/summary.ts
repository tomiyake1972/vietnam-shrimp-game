// ShrimpX V2 — AI Analysis Pack: 01_Run_Summary.md
//
// 【生成AIを使わない】テンプレートに記録値を差し込むだけの決定論的な出力。
//
// 【勝手に評価しない】「MASSは誤った経営をした」のような評価は書かない。
// 書くのは「MASS の営業利益が X 四半期にわたり赤字だった」という事実まで。
// 評価・原因分析は、この Pack を受け取った人間と AI が行う。

import { AiAnalysisPackContext } from "./types";

function money(v: number | null): string {
  return v === null ? "n/a" : `${(v / 1_000_000).toFixed(2)}M USD`;
}

function tons(v: number | null): string {
  return v === null ? "n/a" : `${Math.round(v).toLocaleString()} t`;
}

function count(v: number | null): string {
  return v === null ? "n/a" : String(Math.round(v));
}

export function buildRunSummaryMarkdown(context: AiAnalysisPackContext): string {
  const lines: string[] = [];
  const run = context.run;

  // --- AI への読み方説明（テンプレート） ---
  lines.push("# ShrimpX Simulation Run — AI Analysis Pack");
  lines.push("");
  // 【§45/§46】途中実行を8年ぶんの結論として読まれないよう、最初に強く出す。
  if (run.isPartialRun) {
    lines.push(`> ## ⚠️ ${run.runCompletenessLabel}`);
    lines.push(">");
    lines.push(`> This run stopped after **${run.completedTurns} of ${run.requestedTurns}** quarters (stopReason: \`${run.stopReason}\`).`);
    lines.push("> The remaining quarters are **absent, not zero**. Do not read this as an 8-year outcome,");
    lines.push("> and do not extrapolate the missing quarters.");
    lines.push("");
  } else {
    lines.push(`**${run.runCompletenessLabel}**`);
    lines.push("");
  }

  lines.push("## How to read this package (for ChatGPT / Claude)");
  lines.push("");
  for (const guide of context.readingGuide) lines.push(`- ${guide}`);
  lines.push("");
  lines.push("This summary is generated from recorded values by a fixed template. No AI wrote it, and it contains no evaluation or judgement — only facts.");
  lines.push("");

  // --- Run Identity ---
  lines.push("## Run Identity");
  lines.push("");
  lines.push("| Field | Value |");
  lines.push("|---|---|");
  lines.push(`| simulationRunId | \`${run.simulationRunId}\` |`);
  lines.push(`| scenarioId | ${run.scenarioId} |`);
  lines.push(`| scenarioVersion | ${run.scenarioVersion} |`);
  lines.push(`| seed | ${run.seed} |`);
  lines.push(`| startingTurn | ${run.startingTurn} |`);
  lines.push(`| requestedTurns | ${run.requestedTurns} |`);
  lines.push(`| completedTurns | **${run.completedTurns}** |`);
  lines.push(`| stopReason | ${run.stopReason} |`);
  lines.push(`| startedAt | ${run.startedAt} |`);
  lines.push(`| completedAt | ${run.completedAt ?? "n/a"} |`);
  lines.push(`| exportedAt | ${run.exportedAt} |`);
  lines.push("");

  // --- Versions ---
  lines.push("## Versions");
  lines.push("");
  lines.push("| Field | Value |");
  lines.push("|---|---|");
  lines.push(`| packSchemaVersion | ${context.schemaVersion} |`);
  lines.push(`| gameParameterVersion | ${run.gameParameterVersion} |`);
  lines.push(`| standardAiVersion | ${run.standardAiVersion} |`);
  lines.push(`| strategyProfileVersion | ${run.strategyProfileVersion} |`);
  lines.push(`| sourceBranch | ${run.sourceBranch} |`);
  lines.push(`| sourceCommit | ${run.sourceCommit} |`);
  lines.push("");

  // --- Decision ownership（Phase 7・Manual Override） ---
  lines.push("## Decision Ownership");
  lines.push("");
  const ownership = context.decisionOwnership;
  if (ownership.playerTurnCount === 0) {
    lines.push("Decision ownership: STANDARD_AI only (no PLAYER turns were recorded in this run).");
  } else {
    lines.push(`Decision ownership:`);
    lines.push(`- STANDARD_AI turns: ${ownership.standardAiTurnCount}`);
    lines.push(`- PLAYER turns: ${ownership.playerTurnCount}`);
    lines.push("");
    lines.push(`PLAYER companies: ${ownership.playerCompanyIds.join(", ")}`);
    lines.push("");
    lines.push(
      "This run includes human (Management Console Manual Override) intervention. See `companies[].turns[].decisionOwner` in `02_AI_Context.json` for the exact company × turn breakdown, and the reading guide above for how to interpret Standard AI reference diagnosis recorded alongside PLAYER decisions."
    );
  }
  lines.push("");

  // --- Companies ---
  lines.push("## Companies");
  lines.push("");
  lines.push("| Company | Name | Quarters recorded |");
  lines.push("|---|---|---|");
  for (const c of context.companySummaries) {
    lines.push(`| ${c.companyId} | ${c.displayName} | ${context.companies[c.companyId]?.turns.length ?? 0} |`);
  }
  lines.push("");

  // --- Beginning vs Ending ---
  lines.push("## Beginning vs Ending");
  lines.push("");
  lines.push("| Company | Revenue (first → last) | Cumulative revenue | Cumulative operating profit | Cash (start → end) | Debt (start → end) | Equity (start → end) | Sales headcount (start → end) |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const c of context.companySummaries) {
    lines.push(
      `| ${c.companyId} | ${money(c.startingRevenueUsd)} → ${money(c.endingRevenueUsd)} | ${money(c.cumulativeRevenueUsd)} | ${money(c.cumulativeOperatingProfitUsd)} | ` +
        `${money(c.startingCashUsd)} → ${money(c.endingCashUsd)} | ${money(c.startingDebtUsd)} → ${money(c.endingDebtUsd)} | ` +
        `${money(c.startingEquityUsd)} → ${money(c.endingEquityUsd)} | ${count(c.startingSalesHeadcount)} → ${count(c.endingSalesHeadcount)} |`
    );
  }
  lines.push("");
  lines.push("| Company | HOSO capacity (start → end) | PD capacity | VAP capacity | Quarters with negative operating profit | Final bottleneck |");
  lines.push("|---|---|---|---|---|---|");
  for (const c of context.companySummaries) {
    lines.push(
      `| ${c.companyId} | ${tons(c.startingCapacityTonsByProduct.hoso)} → ${tons(c.endingCapacityTonsByProduct.hoso)} | ` +
        `${tons(c.startingCapacityTonsByProduct.pd)} → ${tons(c.endingCapacityTonsByProduct.pd)} | ` +
        `${tons(c.startingCapacityTonsByProduct.vap)} → ${tons(c.endingCapacityTonsByProduct.vap)} | ` +
        `${c.operatingProfitNegativeQuarters} | ${c.finalPrimaryBottleneck ?? "n/a"} |`
    );
  }
  lines.push("");

  // --- Major Investments ---
  lines.push("## Major Investments");
  lines.push("");
  const investments = context.companySummaries.flatMap((c) => c.majorInvestments.map((m) => ({ ...m, companyId: c.companyId })));
  if (investments.length === 0) {
    lines.push("No capital project state transitions were recorded in this run.");
  } else {
    lines.push("| Turn | Company | Project type | Transition |");
    lines.push("|---|---|---|---|");
    for (const inv of investments.sort((a, b) => a.turn - b.turn)) {
      lines.push(`| ${inv.turn} | ${inv.companyId} | ${inv.projectType} | ${inv.event} |`);
    }
  }
  lines.push("");
  lines.push("### Capital project types");
  lines.push("");
  lines.push(`- Types the Standard AI can ever propose: ${context.standardAiProposableCapexTypes.join(", ")}`);
  lines.push(`- Types that exist in the game engine: ${context.gameCapexTypes.join(", ")}`);
  const neverProposable = context.gameCapexTypes.filter((t) => !context.standardAiProposableCapexTypes.includes(t));
  if (neverProposable.length > 0) {
    lines.push(
      `- Types present in the engine but **never proposed by the Standard AI** (this is a property of the AI code, not of this run): ${neverProposable.join(", ")}`
    );
  }
  lines.push("");

  // --- Bottleneck transitions ---
  lines.push("## Bottleneck Transitions");
  lines.push("");
  const transitions = context.majorChanges.filter((c) => c.metric === "PRIMARY_BOTTLENECK");
  if (transitions.length === 0) {
    lines.push("No bottleneck transitions were recorded.");
  } else {
    lines.push("| Turn | Company | From | To |");
    lines.push("|---|---|---|---|");
    for (const t of transitions) lines.push(`| ${t.turn} | ${t.scope} | ${t.from} | ${t.to} |`);
  }
  lines.push("");

  // --- Major events ---
  lines.push("## Major Events (first 60 of the deterministic change log)");
  lines.push("");
  lines.push(`Total recorded changes: ${context.majorChanges.length}. Full list: \`04_Event_Change_Log.csv\` and \`majorChanges\` in the JSON.`);
  lines.push("");
  lines.push("| Turn | Scope | Metric | From | To |");
  lines.push("|---|---|---|---|---|");
  for (const c of context.majorChanges.slice(0, 60)) {
    lines.push(`| ${c.turn} | ${c.scope} | ${c.metric} | ${c.from} | ${c.to} |`);
  }
  lines.push("");

  // --- Data availability ---
  lines.push("## Important Data Availability Notes");
  lines.push("");
  lines.push("| Field | Availability | Reason |");
  lines.push("|---|---|---|");
  for (const note of context.dataAvailability) {
    lines.push(`| \`${note.field}\` | ${note.availability} | ${note.reason} |`);
  }
  lines.push("");

  // --- Files ---
  lines.push("## Files in this Pack");
  lines.push("");
  lines.push("| File | Purpose |");
  lines.push("|---|---|");
  lines.push("| `01_Run_Summary.md` | This file. Entry point for a human or an AI. |");
  lines.push("| `02_AI_Context.json` | **The centre of this pack.** Full per-turn causal record (world → observable → diagnosis → wanted → constraints → decision → execution → financial → ending). |");
  lines.push("| `03_Analysis.xlsx` | Quantitative cross-checking for humans. Analysis sheets plus long-format raw sheets. |");
  lines.push("| `04_Event_Change_Log.csv` | Deterministic turn-over-turn change log. |");
  lines.push("| `05_Data_Dictionary.md` | Field definitions, units, sources, true/observable classification. |");
  lines.push("");

  // --- Suggested questions ---
  lines.push("## Suggested Questions (templates — no answers are generated at export time)");
  lines.push("");
  lines.push("- 8年間で5社はどのように分化したか？");
  lines.push("- 誰も新工場を建てなかったのはなぜか？（`standardAiProposableCapexTypes`、`factorySpaceRemainingUnits`、`capacityTonsByProduct`、`diagnosis.reasonCodes` を確認してください）");
  lines.push("- Standard AI の判断に矛盾はあるか？（`wanted` と `decision` の差、`constraints` を確認してください）");
  lines.push("- 市場変化に最も適応した会社はどこか？（`standardAiObservable` と `decision.salesAllocationByMarket` を突き合わせてください）");
  lines.push("- HOSO / PD / VAP 戦略は成立しているか？（`financialResult.productEconomics` を確認してください）");
  lines.push("- 観測された問題を STANDARD_AI_ISSUE / SCENARIO_ISSUE / GAME_ENVIRONMENT_ISSUE / INITIAL_CONDITION_ISSUE / EMERGENT_BEHAVIOR に分類してください。");
  lines.push("- シナリオをよりダイナミックにするには何を変えるべきか？");
  lines.push("");

  return lines.join("\n");
}
