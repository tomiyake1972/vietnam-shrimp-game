// ShrimpX V2 — 与信スナップショットテスト共通ヘルパー（資金繰り診断・2026-08-03）
//
// 【位置づけ】このファイル自体はテストファイルではない（`*.test.ts`ではないため
// テストランナーには直接ロードされない）。develop/v2・48コミットスタック(pd_labor)の
// 両方で共有する「1回のシミュレーション実行＋スナップショット捕捉」のロジックを
// 1箇所にまとめ、以下の3つのテストファイルから再利用する:
//   - underwritingSnapshotInvariants.test.ts  （スタック非依存の不変条件。develop/v2・
//     pd_laborの両方でgreenになることを要求する）
//   - underwritingSnapshotDevelopV2.test.ts   （develop/v2固有の期待値）
//   - underwritingSnapshotPdLabor.test.ts     （pd_labor固有の期待値。pd_laborへ
//     一時的にコピーして実行する診断オーバーレイ。ソースは本ブランチにのみ存在）

import { CompanyLabConfig } from "../../companyLab/types";
import {
  SELECTED_STANDARD_BASELINE_CANDIDATE_ID,
  STANDARD_BASELINE_CANDIDATES,
} from "../../companyLab/standardAi/report/standardBaseline";
import {
  ALL_COMPANY_IDS,
  initializeUnifiedCompanyLabFromTemplate,
  runFromInit,
} from "../../companyLab/standardAi/report/decomposeHarness";
import { generateStandardAiDecision } from "../../companyLab/standardAi/policy";
import { setUnderwritingSnapshotObserver, setLoanRollForwardObserver, UnderwritingSnapshot, LoanRollForwardSnapshot } from "../liquidityClose";

export const BASE = STANDARD_BASELINE_CANDIDATES.find((c) => c.id === SELECTED_STANDARD_BASELINE_CANDIDATE_ID)!;
export const SEED = "sai3a-grid-001";
export const TURNS = 8;

export function runOnce(withObservers: boolean) {
  const config: CompanyLabConfig = { scenarioId: "baseline", mode: "canonical", seed: SEED, turns: TURNS };
  const uwSnapshots: UnderwritingSnapshot[] = [];
  const rfSnapshots: LoanRollForwardSnapshot[] = [];
  if (withObservers) {
    setUnderwritingSnapshotObserver((s) => uwSnapshots.push(s));
    setLoanRollForwardObserver((s) => rfSnapshots.push(s));
  }
  try {
    const initResult = initializeUnifiedCompanyLabFromTemplate(
      config,
      BASE.buildFixtureTemplate,
      BASE.financeFixtureTemplate,
      BASE.contractDefs,
      ALL_COMPANY_IDS
    );
    const result = runFromInit(initResult, generateStandardAiDecision);
    return { result, uwSnapshots, rfSnapshots };
  } finally {
    // 【必須】finally節での解除。実行中に例外が投げられても、
    // オブザーバーが登録されたまま他のテスト・他の実行へ残らないことを保証する。
    setUnderwritingSnapshotObserver(undefined);
    setLoanRollForwardObserver(undefined);
  }
}

export function stableStringify(x: unknown): string {
  return JSON.stringify(x);
}
