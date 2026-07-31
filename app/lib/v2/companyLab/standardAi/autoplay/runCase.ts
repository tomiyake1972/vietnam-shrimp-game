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
import { hosoEqTons } from "../../../core/units";
import { ALL_COMPANY_IDS, initializeUnifiedCompanyLabFromTemplate } from "../report/decomposeHarness";
import { runFromInit } from "../report/decomposeHarness";
import { buildSai5HeterogeneousOverrides } from "../report/heterogeneousPreset";
import { StandardBaselineCandidate } from "../report/standardBaseline";
import { createInstrumentedStandardAiRun, QuarterStartCapture } from "./capture";
import { StandardAiQuarterDiagnostics } from "../policy";
import { CompanyQuarterRecord } from "../../types";
import { createSai5ParamsResolver } from "../orientationProfile";

export interface AutoplayCaseConfig {
  readonly scenarioId: string;
  readonly seed: string;
  readonly quarters: number;
  readonly companyIds: readonly CompanyId[];
  readonly candidate: StandardBaselineCandidate;
  /** 標準候補の営業人数を上書きする場合の値(未指定なら候補既定値のまま)。
   *  SAI-2の80/85/90人比較や、将来のheadcount感度分析をスクリプト固有処理に
   *  せず、この実行基盤から直接指定できるようにする。 */
  readonly salesForceHeadcountOverride?: number;
  /**
   * 【SAI-4追加】5社共通の養殖能力(aquacultureCapacity、HOSO換算トン)を上書きする
   * 場合の値(未指定なら候補既定値のまま)。実装指示の「養殖上限4,000トン」試験用。
   * salesForceHeadcountOverrideと同じ設計方針(既存のbuildCompanyFixtures・
   * standardBaseline.tsの校正値そのものは書き換えず、この実行時オプションだけで
   * 上書きする)を踏襲する。上限そのものの強制はAI側の自己抑制ではなく、
   * rawMaterials/aquaculture.ts の assertValidStockingPlan()
   * (エンジン側のハード制約)が担う。ここでの上書きは、その制約が実際に効く
   * fixture.aquacultureCapacityの値を全社同一に揃えるだけである。
   */
  readonly aquacultureCapacityOverrideHosoEqTons?: number;
  /**
   * 【SAI-4追加】trueの場合のみ、会社IDに応じた経営性格プロファイル
   * (managementProfile.ts)による小幅なStandardAiParametersバイアスを適用する。
   * 未指定(false相当)なら従来どおり全社STANDARD_AI_PARAMETERS_V1固定
   * (既存の全出力・全テストへの影響ゼロ)。
   */
  readonly managementProfilesEnabled?: boolean;
  /**
   * 【SAI-5A追加】trueの場合のみ、会社IDに応じた市場・商品志向プロファイル
   * (orientationProfile.ts)を適用する。SAI-4の経営性格とは独立したレイヤーで
   * あり、両フラグの4通りの組み合わせすべてが有効（§13EのA/B比較用）。
   * 未指定(false相当)なら志向なし＝既存挙動とビット単位で一致。
   */
  readonly marketProductOrientationEnabled?: boolean;
  /** 【SAI-5B】trueの場合のみ異質5社preset（会社別の小幅な初期差）を適用する。 */
  readonly heterogeneousInitialConditionsEnabled?: boolean;
  /** 【SAI-5C】trueの場合のみ市場別の商品ライフサイクル需要を有効化する（エンジン側フラグ）。 */
  readonly productLifecycleEnabled?: boolean;
  /** 【SAI-5D】trueの場合のみ会社×市場×商品の営業基盤蓄積を有効化する（エンジン側フラグ）。 */
  readonly salesBaseAccumulationEnabled?: boolean;
  /** 【SAI-5E】trueの場合のみ5社供給圧力→翌期プレミアムのフィードバックを有効化する（エンジン側フラグ）。 */
  readonly supplyPremiumFeedbackEnabled?: boolean;
  /** 【SAI-5F】trueの場合のみStandard AIの拡張設備投資判断を有効化する。 */
  readonly standardAiCapexEnabled?: boolean;
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
  salesForceHeadcountOverride: number | undefined,
  aquacultureCapacityOverrideHosoEqTons: number | undefined
): (startPeriod: PeriodV2) => CompanyFixture {
  if (salesForceHeadcountOverride === undefined && aquacultureCapacityOverrideHosoEqTons === undefined) {
    return candidate.buildFixtureTemplate;
  }
  return (startPeriod: PeriodV2) => ({
    ...candidate.buildFixtureTemplate(startPeriod),
    ...(salesForceHeadcountOverride === undefined ? {} : { salesForceHeadcountTotal: salesForceHeadcountOverride }),
    ...(aquacultureCapacityOverrideHosoEqTons === undefined
      ? {}
      : { aquacultureCapacity: hosoEqTons(aquacultureCapacityOverrideHosoEqTons) }),
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
  const buildFixtureTemplate = buildFixtureTemplateWithOverride(
    config.candidate,
    config.salesForceHeadcountOverride,
    config.aquacultureCapacityOverrideHosoEqTons
  );

  // 【SAI-5】エンジン側の機能フラグ。全てOFF（未指定）のときはsai5フィールド自体を
  // 付与しない（CompanyLabConfigの内容が従来と完全に同一＝再現性・スナップショット
  // 互換の面でも既存と一致する）。
  const engineFlagsActive =
    Boolean(config.productLifecycleEnabled) ||
    Boolean(config.salesBaseAccumulationEnabled) ||
    Boolean(config.supplyPremiumFeedbackEnabled);
  const initResult = initializeUnifiedCompanyLabFromTemplate(
    {
      scenarioId: config.scenarioId,
      mode: "canonical",
      seed: config.seed,
      turns: config.quarters,
      ...(engineFlagsActive
        ? {
            sai5: {
              productLifecycle: Boolean(config.productLifecycleEnabled),
              salesBaseAccumulation: Boolean(config.salesBaseAccumulationEnabled),
              supplyPremiumFeedback: Boolean(config.supplyPremiumFeedbackEnabled),
            },
          }
        : {}),
    },
    buildFixtureTemplate,
    config.candidate.financeFixtureTemplate,
    config.candidate.contractDefs,
    order,
    // 【SAI-5B】異質preset有効時のみ、会社別の小幅な初期差（設備ミックス・技能・
    // 初期営業基盤・比例した固定資産調整）を適用する。未指定なら従来どおり
    // 5社完全同一（identical-standard）。
    config.heterogeneousInitialConditionsEnabled ? buildSai5HeterogeneousOverrides() : undefined
  );

  const useResolver =
    Boolean(config.managementProfilesEnabled) ||
    Boolean(config.marketProductOrientationEnabled) ||
    Boolean(config.standardAiCapexEnabled);
  const { provider, quarterStartCaptures, diagnostics } = createInstrumentedStandardAiRun(
    useResolver
      ? {
          resolveParams: createSai5ParamsResolver({
            managementProfilesEnabled: Boolean(config.managementProfilesEnabled),
            orientationEnabled: Boolean(config.marketProductOrientationEnabled),
            aiCapexEnabled: Boolean(config.standardAiCapexEnabled),
          }),
        }
      : {}
  );
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
