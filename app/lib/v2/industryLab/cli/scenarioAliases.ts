// ShrimpX V2 — 業界シミュレーション CLI（差分） シナリオID解決
//
// 既存の ScenarioDefinition.scenarioId（例: "baseline-v0.1"）をそのまま
// CLI引数として受け付けつつ、`--scenario baseline` のようにバージョン接尾辞
// （`-v0.1` 等、既存コードがすでに採用している命名規則）を省略した短縮形も
// 受け付ける。新しい経済ロジック・シナリオ内容には一切踏み込まない、
// 純粋なID解決のみを行うヘルパー。

import { ScenarioDefinition } from "../../scenario/types";
import { ALL_SCENARIO_DEFINITIONS } from "../../scenario";
import { DEVELOPMENT_SCENARIO_DEFINITIONS } from "../../scenario/definitions";

/** scenarioIdからバージョン接尾辞（例: "-v0.1"）を取り除いた短縮形。 */
export function shortScenarioAlias(scenarioId: string): string {
  return scenarioId.replace(/-v[\d.]+$/i, "");
}

export interface ScenarioAliasEntry {
  readonly definition: ScenarioDefinition;
  readonly alias: string;
}

/**
 * 公開シナリオの (完全ID, 短縮形, 定義) 一覧。CLIのヘルプ・エラー表示に使う。
 *
 * 【開発中シナリオを含めない理由】この一覧は「利用可能なシナリオ」として
 * エラーメッセージへ出るため、ここへ開発中シナリオを混ぜると、まだ公開判断が
 * 済んでいないシナリオ名がプレイヤーの目に触れうる。開発中シナリオは
 * scenarioId を明示した場合のみ resolveScenarioDefinition が解決する。
 */
export function listScenarioAliases(): readonly ScenarioAliasEntry[] {
  return ALL_SCENARIO_DEFINITIONS.map((definition) => ({
    definition,
    alias: shortScenarioAlias(definition.scenarioId),
  }));
}

/**
 * 解決対象になるシナリオ一覧。公開シナリオに加えて開発中シナリオも含む。
 *
 * 画面のシナリオセレクタは ALL_SCENARIO_DEFINITIONS を直接読むため、
 * 開発中シナリオはプレイヤーの選択肢には出ない。scenarioId を明示した
 * benchmark スクリプト・CLI からのみ到達できる。
 */
function resolvableScenarioDefinitions(): readonly ScenarioDefinition[] {
  return [...ALL_SCENARIO_DEFINITIONS, ...DEVELOPMENT_SCENARIO_DEFINITIONS];
}

/**
 * CLI引数として渡された文字列からシナリオ定義を解決する。
 * 1. 完全なscenarioId（例: "baseline-v0.1"）との完全一致
 * 2. バージョン接尾辞を除いた短縮形（例: "baseline"）との完全一致
 * のどちらにも一致しなければundefined。
 */
export function resolveScenarioDefinition(input: string): ScenarioDefinition | undefined {
  const candidates = resolvableScenarioDefinitions();
  const exact = candidates.find((d) => d.scenarioId === input);
  if (exact) return exact;
  return candidates.find((d) => shortScenarioAlias(d.scenarioId) === input);
}
