// ShrimpX V2 — Dynamic Scenario 2（HOSO量産戦略の再校正テスト版）
//
// 【Dynamic Scenario 1 との関係】世界の側は DS1 をそのまま引き継ぐ。
// イベント経路（T6 予兆 → T7-9 原料ショック → T8-12 消費好況 → T13-16 global調達化 →
// China HOSO spike → T17-20 需要ショック → T21 回復 → T22-24 reopening →
// T25-32 China premiumization → 終盤ショック）、News 72記事、市場別の商品普及曲線、
// 構造需要アンカー、産地別VAP加工能力、ベトナム5社の初期VAP設備は DS1 と同一。
// スプレッドで丸ごと継承しているので、DS1 側を直せば DS2 も自動で追随する
// （world 側の設定を2箇所で持たないための意図的な作り）。
//
// 【DS2 が変えるのは会社側の初期財務条件だけ】
// DS1 の32ターンテストで、MASS（HOSO大量生産型）は Strategic Posture を他社と
// 揃えても、VAP能力問題を直しても、序盤から赤字が続いて経営不能へ向かった。
// 原因候補のうち「初期借入 80M の重さ」を単独で測るため、DS2 では MASS の
// 初期借入だけを 40M へ下げる。ほかの初期条件（現金・設備・人員・営業・
// 商品構成・Vision・成長意欲）には一切触れていない。
//
// 【この Phase では HOSO Scale mechanic を入れない】「大量処理すると加工コストが
// 下がる」という規模の経済は次段階（Phase 2B）。先に借入単独の寄与を見る。
//
// 【今後】テスト条件を大きく変える場合は Dynamic Scenario 3 / 4 と番号を進める。
// DS1 は比較用としてそのまま残す。

import { ScenarioDefinition } from "../types";
import { DYNAMIC_SCENARIO_1 } from "./dynamicScenario1";
import { DS2_INITIAL_COMPANY_DEBT_USD } from "./dynamicScenario2Parameters";

export const DYNAMIC_SCENARIO_2: ScenarioDefinition = {
  ...DYNAMIC_SCENARIO_1,

  scenarioId: "dynamic-scenario-2-v0.1",
  version: "0.1.0",
  title: "Dynamic Scenario 2 — HOSO Scale Recalibration（動的シナリオ2：量産戦略の再校正）",
  publicBackground: DYNAMIC_SCENARIO_1.publicBackground,

  gmDescription:
    "HOSO量産戦略と初期財務条件を再校正したテスト版。世界の出来事・News・市場構造・産地別VAP能力は " +
    "Dynamic Scenario 1 と同一で、変えてあるのは MASS の初期借入（80M → 40M）だけ。" +
    "HOSO大量生産型の会社が構造的に負けない条件を探すための比較版であり、DS1 は比較用にそのまま残している。" +
    "\n\n" +
    "【Phase 2A の範囲】初期借入の寄与を単独で測るところまで。『大量処理すると加工コストが下がる』" +
    "という HOSO Scale Processing Efficiency は次段階（Phase 2B）で入れる。",

  // 【DS2 のみ】MASS の初期借入 80M → 40M。
  // 貸借は利益剰余金が残差で吸収するため、他の初期項目は変えない。
  initialCompanyDebtUsd: DS2_INITIAL_COMPANY_DEBT_USD,
};
