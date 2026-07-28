// ShrimpX V2 — 標準AI（SAI-1）CompanyDecisionProvider 接続点
//
// runner.ts の runCompanyLabWithAutoPolicyForAllCompanies が要求する
// CompanyDecisionProvider シグネチャ（fixture, ownState, publicInfo, period, turn) => CompanyDecisionInput）
// へ、computeStandardAiDecision（判断ロジック本体。policy.ts）をそのまま
// 接続するだけの薄い層。ここには判断ロジックを一切書かない。
//
// 診断情報（StandardAiReasonEntry群）は decision とは別に、任意で収集できる
// ようにする（createStandardAiDecisionProviderWithDiagnostics）。CLI・自動
// テストプレイ・将来の圧力値表示のいずれからも、意思決定そのものを変えずに
// 「なぜその判断になったか」を後から追跡できるようにするため。

import { PeriodV2 } from "../../core/period";
import { CompanyDecisionInput, CompanyFixture, CompanyOwnState, PublicMarketInfo } from "../types";
import { computeStandardAiDecision } from "./policy";
import { StandardAiConfig, StandardAiDecisionDiagnostics } from "./types";
import { DEFAULT_STANDARD_AI_CONFIG_V1 } from "./config";

/**
 * 標準AI（SAI-1）の CompanyDecisionProvider。runCompanyLabWithAutoPolicyForAllCompanies
 * へそのまま渡せる（generateAutoPolicyDecision と同じシグネチャ）。診断情報は
 * 破棄される。診断情報が必要な場合は createStandardAiDecisionProviderWithDiagnostics
 * を使うこと。
 */
export function generateStandardAiDecision(
  fixture: CompanyFixture,
  ownState: CompanyOwnState,
  publicInfo: PublicMarketInfo,
  period: PeriodV2,
  turn: number,
  config: StandardAiConfig = DEFAULT_STANDARD_AI_CONFIG_V1
): CompanyDecisionInput {
  return computeStandardAiDecision(fixture, ownState, publicInfo, period, turn, config).decision;
}

/**
 * 診断情報を蓄積しながら意思決定を生成する CompanyDecisionProvider を作る。
 * 返り値の provider は runCompanyLabWithAutoPolicyForAllCompanies にそのまま渡せる
 * シグネチャを保つ（意思決定の内容そのものは generateStandardAiDecision と完全に同一。
 * 副作用は「呼び出しのたびに diagnosticsLog へ1件追記する」ことだけ）。
 */
export function createStandardAiDecisionProviderWithDiagnostics(config: StandardAiConfig = DEFAULT_STANDARD_AI_CONFIG_V1): {
  readonly provider: (
    fixture: CompanyFixture,
    ownState: CompanyOwnState,
    publicInfo: PublicMarketInfo,
    period: PeriodV2,
    turn: number
  ) => CompanyDecisionInput;
  readonly diagnosticsLog: StandardAiDecisionDiagnostics[];
} {
  const diagnosticsLog: StandardAiDecisionDiagnostics[] = [];

  const provider = (
    fixture: CompanyFixture,
    ownState: CompanyOwnState,
    publicInfo: PublicMarketInfo,
    period: PeriodV2,
    turn: number
  ): CompanyDecisionInput => {
    const { decision, diagnostics } = computeStandardAiDecision(fixture, ownState, publicInfo, period, turn, config);
    diagnosticsLog.push(diagnostics);
    return decision;
  };

  return { provider, diagnosticsLog };
}
