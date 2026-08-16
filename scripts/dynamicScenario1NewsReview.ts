#!/usr/bin/env -S npx tsx
// Dynamic Scenario 1 — News レビュー用一覧の生成（read-only）
//
// Turn 1〜32 の全記事を、内部メタデータ（signal class 等）つきで出力する。
// **この内部メタデータはプレイヤー画面には出ない**（開発レビュー専用）。
//
//   npx tsx scripts/dynamicScenario1NewsReview.ts > docs/v2/reports/dynamic_scenario_1_news_review.md

import { DS1_NEWS_SPECS, DS1_NEWS_EFFECT_SYNC, NewsSpec } from "../app/lib/v2/scenario/definitions/dynamicScenario1News";
import { DYNAMIC_SCENARIO_1 } from "../app/lib/v2/scenario/definitions/dynamicScenario1";
import { initializeScenario } from "../app/lib/v2/scenario/scenarioEngine";
import { eventIntensityAtTurn } from "../app/lib/v2/scenario/eventEngine";

const state = initializeScenario(DYNAMIC_SCENARIO_1, "canonical", "news-review");
const syncByInfoId = new Map(DS1_NEWS_EFFECT_SYNC.map((s) => [s.informationId, s]));

function newsType(spec: NewsSpec): string {
  if (spec.isRumor) return "Leading";
  if (spec.eventId !== undefined) return "Current";
  return "Structural";
}

function relatedEventLabel(spec: NewsSpec): string {
  if (spec.eventId === undefined) return "（トレンド由来）";
  const sync = syncByInfoId.get(spec.id);
  const resolved = state.resolvedEvents.find((e) => e.source.eventId === spec.eventId);
  const intensityNow = resolved ? eventIntensityAtTurn(resolved, spec.turn) : 0;
  const lead = sync ? `lead ${sync.leadQuarters}Q（effect開始 T${sync.effectStartTurn}）` : "同期表への宣言なし";
  return `${spec.eventId} / ${lead} / 記事ターンの発現強度 ${intensityNow.toFixed(2)}`;
}

const total = DS1_NEWS_SPECS.length;
const byScale = { major: 0, normal: 0, background: 0 };
const bySignal = { strong: 0, weak: 0, background: 0 };
const byType = { Current: 0, Leading: 0, Structural: 0 } as Record<string, number>;
for (const spec of DS1_NEWS_SPECS) {
  byScale[spec.scale] += 1;
  bySignal[spec.signalClass] += 1;
  byType[newsType(spec)] += 1;
}

console.log("# Dynamic Scenario 1 — News レビュー一覧");
console.log("");
console.log("> Internal signal class / scale はレビュー専用であり、**プレイヤー画面には表示されない**。");
console.log("> プレイヤーは見出しと本文だけを読んで重要度を判断する。");
console.log("");
console.log("## サマリー");
console.log("");
console.log(`- 記事総数: **${total}件**`);
console.log(`- 分量クラス: Major ${byScale.major} / Normal ${byScale.normal} / Background ${byScale.background}`);
console.log(`- 内部signal class: Strong ${bySignal.strong} / Weak ${bySignal.weak} / Background ${bySignal.background}`);
console.log(`- 時間軸分類: Current ${byType.Current} / Leading ${byType.Leading} / Structural ${byType.Structural}`);
console.log("");

console.log("## ターン別の記事数");
console.log("");
console.log("| Turn | 件数 | 内訳（signal class） |");
console.log("|---|---|---|");
for (let turn = 1; turn <= DYNAMIC_SCENARIO_1.durationTurns; turn++) {
  const specs = DS1_NEWS_SPECS.filter((s) => s.turn === turn);
  const mix = specs.map((s) => s.signalClass).join(" / ");
  console.log(`| T${turn} | ${specs.length} | ${mix} |`);
}
console.log("");

console.log("## 全記事");
console.log("");
for (let turn = 1; turn <= DYNAMIC_SCENARIO_1.durationTurns; turn++) {
  const specs = DS1_NEWS_SPECS.filter((s) => s.turn === turn);
  if (specs.length === 0) continue;
  console.log(`### Turn ${turn}`);
  console.log("");
  for (const spec of specs) {
    console.log(`#### ${spec.headline}`);
    console.log("");
    console.log(spec.body);
    console.log("");
    const meta: string[] = [
      `**Type**: ${newsType(spec)}`,
      `**Scale**: ${spec.scale}（${spec.body.length}字）`,
      `**Signal**: ${spec.signalClass}`,
    ];
    if (spec.market !== undefined) meta.push(`**Market**: ${spec.market}`);
    if (spec.product !== undefined) meta.push(`**Product**: ${spec.product}`);
    if (spec.origin !== undefined) meta.push(`**Origin**: ${spec.origin}`);
    meta.push(`**Confidence**: ${spec.confidence}`);
    console.log(`- ${meta.join(" ／ ")}`);
    console.log(`- **Related event**: ${relatedEventLabel(spec)}`);
    if (spec.estimateRange) {
      console.log(`- **Estimate range**: ${spec.estimateRange.low} 〜 ${spec.estimateRange.high}`);
    }
    console.log(`- **Facts**: ${spec.facts.map((x) => `${x.label}=${x.value}`).join(" / ")}`);
    console.log(`- **ID**: \`${spec.id}\``);
    console.log("");
  }
}
