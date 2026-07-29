// ShrimpX V2 — Phase SAI-3A: 判断記録基盤 — 1ケース（1 seed × 5社 × Nクォーター）の実行
//
// 【既存実装の再利用】シミュレーション本体は既存のSAI-2ハーネス
// （companyLab/standardAi/report/decomposeHarness.ts の
// initializeUnifiedCompanyLabFromTemplate + runFromInit）をそのまま呼び出す。
// 新しいrunner・新しいturnループは作らない。標準AIの意思決定生成は
// autoplay/capture.ts のインストルメント済みproviderを渡すだけで、
// standardAi本体のロジックは一切変更しない。

import { CompanyId } from "../../../sales/types";
import { CompanyFixture } from "../../types";
import { PeriodV2 } from "../../../core/period";
import { ALL_COMPANY_IDS, initializeUnifiedCompanyLabFromTemplate } from "../report/decomposeHarness";
import { runFromInit } from "../report/decomposeHarness";
import { StandardBaselineCandidate } from "../report/standardBaseline";
import { createInstrumentedStandardAiRun, QuarterStartCapture } from "./capture";
import { StandardAiQuarterDiagnostics } from "../policy";
import { CompanyQuarterRecord } from "../../types";

export interface AutoplayCaseConfig {
  readonly scenarioId: string;
  readonly seed: string;
  readonly quarters: number;
  readonly companyIds: readonly CompanyId[];
  readonly candidate: StandardBaselineCandidate;
  /** 標準候補の営業人数を上書きする場合の値（未指定なら候補既定値のまま）。
   *  SAI-2の80/85/90人比較や、将来のheadcount感度分析をスクリプト固有処理に
   *  せず、この実行基盤から直接指定できるようにする。 */
  readonly salesForceHeadcountOverride?: number;
}

export interface AutoplayCaseResult {
  readonly seed: string;
  readonly companyIds: readonly CompanyId[];
  readonly quarters: number;
  readonly companies: readonly CompanyFixture[];
  readonly history: readonly CompanyQuarterRecord[];
  readonly quarterStartCaptures: readonly QuarterStartCapture[];
  readonly diagnostics: readonly StandardAiQuarterDiagnostics[];
  readonly completedTurns: number;
}

function buildFixtureTemplateWithOverride(
  candidate: StandardBaselineCandidate,
  salesForceHeadcountOverride: number | undefined
): (startPeriod: PeriodV2) => CompanyFixture {
  if (salesForceHeadcountOverride === undefined) return candidate.buildFixtureTemplate;
  return (startPeriod: PeriodV2) => ({
    ...candidate.buildFixtureTemplate(startPeriod),
    salesForceHeadcountTotal: salesForceHeadcountOverride,
  });
}

/**
 * 1 seed × 指定会社群 × 指定クォーター数を、標準AIで自動運転する（純粋関数に近い
 * 実行 — 唯一の非決定要素はseedそのものであり、同一config・同一seedなら常に
 * 同一結果を返す）。失敗時は例外をそのままスローする（呼び出し側のrunBatch.tsが
 * catchしてケース単位のエラーとして扱う。ここでは握りつぶさない）。
 */
export function runAutoplayCase(config: AutoplayCaseConfig): AutoplayCaseResult {
  const order: readonly CompanyId[] = config.companyIds.length > 0 ? config.companyIds : ALL_COMPANY_IDS;
  const buildFixtureTemplate = buildFixtureTemplateWithOverride(config.candidate, config.salesForceHeadcountOverride);

  const initResult = initializeUnifiedCompanyLabFromTemplate(
    { scenarioId: config.scenarioId, mode: "canonical", seed: config.seed, turns: config.quarters },
    buildFixtureTemplate,
    config.candidate.financeFixtureTemplate,
    config.candidate.contractDefs,
    order
  );

  const { provider, quarterStartCaptures, diagnostics } = createInstrumentedStandardAiRun();
  const { companies, history } = runFromInit(initResult, provider);

  return {
    seed: config.seed,
    companyIds: order,
    quarters: config.quarters,
    companies,
    history,
    quarterStartCaptures,
    diagnostics,
    completedTurns: history.length,
  };
}
