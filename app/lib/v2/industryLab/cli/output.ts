// ShrimpX V2 — 業界シミュレーション CLI（差分） 出力整形
//
// このファイルは「すでに計算済みの IndustrySimulationResult /
// ScenarioComparisonResult をどう表示するか」だけを扱う。価格・需給計算は
// 一切行わず、UIパネルと同じ app/lib/v2/industryLab/ui/formatters.ts の
// 数値フォーマッタを再利用することで、summary出力の数値表記をUI画面と揃える。

import { COUNTRY_IDS } from "../../market/types";
import { unwrapUnit } from "../../core/units";
import { IndustryQuarterRecord, IndustrySimulationResult } from "../types";
import { ScenarioComparisonResult } from "../ui/comparison";
import {
  formatHosoEqTons,
  formatUsdPerHosoEqKg,
  formatSupplyDemandBalance,
  formatSignedUsdPerHosoEqKg,
  formatSignedHosoEqTons,
} from "../ui/formatters";

// ---------------------------------------------------------------------
// CSV共通ヘルパー
// ---------------------------------------------------------------------

function csvEscape(value: string | number): string {
  const s = String(value);
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function toCsv(header: readonly string[], rows: ReadonlyArray<readonly (string | number)[]>): string {
  const lines = [header.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(row.map(csvEscape).join(","));
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------
// 単独シナリオ実行
// ---------------------------------------------------------------------

export function formatResultAsSummary(result: IndustrySimulationResult, scenarioTitle: string): string {
  const quarters = result.quarters;
  const last = quarters[quarters.length - 1];
  const lines: string[] = [];

  lines.push("ShrimpX V2 業界シミュレーション CLI — summary");
  lines.push(`シナリオ: ${scenarioTitle}（${result.config.scenarioId}）`);
  lines.push(`モード: ${result.config.mode}`);
  lines.push(`シード: ${result.config.seed}`);
  lines.push(`実行ターン数: ${quarters.length} / ${result.config.turns}`);
  lines.push("");

  if (last) {
    lines.push(`[最終四半期: turn ${last.turn}（${last.periodLabel}）]`);
    lines.push(`  世界総供給: ${formatHosoEqTons(last.marketResult.worldSupply)}`);
    lines.push(`  世界総需要: ${formatHosoEqTons(last.marketResult.worldDemand)}`);
    lines.push(`  需給ギャップ: ${formatSupplyDemandBalance(last.marketResult.worldSupplyDemandBalance)}`);
    lines.push(
      `  国際HOSO価格: ${COUNTRY_IDS.map((c) => `${c} ${formatUsdPerHosoEqKg(last.marketResult.hosoPrices[c].price)}`).join(" / ")}`
    );
    lines.push(`  ベトナム国内原料価格: ${formatUsdPerHosoEqKg(last.marketResult.vietnamDomestic.price)}`);
    lines.push(
      `  PD/VAPプレミアム: PD ${formatUsdPerHosoEqKg(last.marketResult.pdPremium.basePremium)} / VAP ${formatUsdPerHosoEqKg(last.marketResult.vapPremium.basePremium)}`
    );
    lines.push("");
  }

  lines.push("[四半期別推移]");
  lines.push("turn\tperiod\tHOSO(VN)\t国内原料価格\t需給ギャップ");
  for (const q of quarters) {
    lines.push(
      [
        q.turn,
        q.periodLabel,
        formatUsdPerHosoEqKg(q.marketResult.hosoPrices.VN.price),
        formatUsdPerHosoEqKg(q.marketResult.vietnamDomestic.price),
        formatSupplyDemandBalance(q.marketResult.worldSupplyDemandBalance),
      ].join("\t")
    );
  }

  return lines.join("\n") + "\n";
}

export function formatResultAsJson(result: IndustrySimulationResult, scenarioTitle: string): string {
  return JSON.stringify({ config: result.config, scenarioTitle, quarters: result.quarters }, null, 2) + "\n";
}

const QUARTER_CSV_HEADER: readonly string[] = [
  "turn",
  "periodLabel",
  ...COUNTRY_IDS.map((c) => `hosoPrice_${c}`),
  "vietnamDomesticPrice",
  "worldSupply",
  "worldDemand",
  "worldSupplyDemandBalance",
  "pdPremium",
  "vapPremium",
];

function quarterToCsvRow(q: IndustryQuarterRecord): readonly (string | number)[] {
  return [
    q.turn,
    q.periodLabel,
    ...COUNTRY_IDS.map((c) => unwrapUnit(q.marketResult.hosoPrices[c].price)),
    unwrapUnit(q.marketResult.vietnamDomestic.price),
    unwrapUnit(q.marketResult.worldSupply),
    unwrapUnit(q.marketResult.worldDemand),
    q.marketResult.worldSupplyDemandBalance,
    unwrapUnit(q.marketResult.pdPremium.basePremium),
    unwrapUnit(q.marketResult.vapPremium.basePremium),
  ];
}

export function formatResultAsCsv(result: IndustrySimulationResult): string {
  return toCsv(QUARTER_CSV_HEADER, result.quarters.map(quarterToCsvRow));
}

// ---------------------------------------------------------------------
// シナリオ比較
// ---------------------------------------------------------------------

export interface ComparisonLabels {
  readonly scenarioTitleA: string;
  readonly scenarioTitleB: string;
}

export function formatComparisonAsSummary(
  a: IndustrySimulationResult,
  b: IndustrySimulationResult,
  comparison: ScenarioComparisonResult,
  labels: ComparisonLabels
): string {
  const lines: string[] = [];
  lines.push("ShrimpX V2 業界シミュレーション CLI — comparison summary");
  lines.push(`A = ${labels.scenarioTitleA}（${a.config.scenarioId}）`);
  lines.push(`B = ${labels.scenarioTitleB}（${b.config.scenarioId}）`);
  lines.push(`モード: ${a.config.mode} / シード: ${a.config.seed} / ターン数: ${comparison.quarters.length}（B − A）`);
  lines.push("");
  lines.push("[四半期別差分]");
  lines.push("turn\tHOSO(VN)差\t国内原料価格差\t世界供給差\t世界需要差\tPDプレミアム差\tVAPプレミアム差");
  for (const q of comparison.quarters) {
    lines.push(
      [
        q.turn,
        formatSignedUsdPerHosoEqKg(q.hosoPriceDiff.VN),
        formatSignedUsdPerHosoEqKg(q.vietnamDomesticPriceDiff),
        formatSignedHosoEqTons(q.worldSupplyDiff),
        formatSignedHosoEqTons(q.worldDemandDiff),
        formatSignedUsdPerHosoEqKg(q.pdPremiumDiff),
        formatSignedUsdPerHosoEqKg(q.vapPremiumDiff),
      ].join("\t")
    );
  }
  lines.push("");
  lines.push(
    `Aのみのイベント: ${comparison.eventDiff.onlyInA.length === 0 ? "なし" : comparison.eventDiff.onlyInA.map((e) => `${e.eventType}(turn ${e.resolvedStartTurn}〜)`).join("、")}`
  );
  lines.push(
    `Bのみのイベント: ${comparison.eventDiff.onlyInB.length === 0 ? "なし" : comparison.eventDiff.onlyInB.map((e) => `${e.eventType}(turn ${e.resolvedStartTurn}〜)`).join("、")}`
  );

  return lines.join("\n") + "\n";
}

export function formatComparisonAsJson(
  a: IndustrySimulationResult,
  b: IndustrySimulationResult,
  comparison: ScenarioComparisonResult,
  labels: ComparisonLabels
): string {
  return (
    JSON.stringify(
      {
        configA: a.config,
        configB: b.config,
        scenarioTitleA: labels.scenarioTitleA,
        scenarioTitleB: labels.scenarioTitleB,
        comparison,
      },
      null,
      2
    ) + "\n"
  );
}

const COMPARISON_CSV_HEADER: readonly string[] = [
  "turn",
  "periodLabelA",
  "periodLabelB",
  ...COUNTRY_IDS.map((c) => `hosoPriceDiff_${c}`),
  "vietnamDomesticPriceDiff",
  "worldSupplyDiff",
  "worldDemandDiff",
  "pdPremiumDiff",
  "vapPremiumDiff",
];

export function formatComparisonAsCsv(comparison: ScenarioComparisonResult): string {
  const rows = comparison.quarters.map(
    (q): readonly (string | number)[] => [
      q.turn,
      q.periodLabelA,
      q.periodLabelB,
      ...COUNTRY_IDS.map((c) => q.hosoPriceDiff[c]),
      q.vietnamDomesticPriceDiff,
      q.worldSupplyDiff,
      q.worldDemandDiff,
      q.pdPremiumDiff,
      q.vapPremiumDiff,
    ]
  );
  return toCsv(COMPARISON_CSV_HEADER, rows);
}
