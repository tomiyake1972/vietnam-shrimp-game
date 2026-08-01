// ShrimpX V2 — Phase SAI-3A: 判断記録基盤 — 1ケース（1 seed × 5社 × Nクォーター）の実行
//
// 【既存実装の再利用】シミュレーション本体は既存のSAI-2ハーネス
// （companyLab/standardAi/report/decomposeHarness.ts の
// initializeUnifiedCompanyLabFromTemplate + runFromInit）をそのまま呼び出す。
// 新しいrunner・新しいturnループは作らない。標準AIの意思決定生成は
// autoplay/capture.ts のインストルメント済みproviderを渡すだけで、
// standardAi本体のロジックは一切変更しない。

import { CompanyId } from "../../../sales/types";
import { CompanyDecisionProvider, CompanyFixture } from "../../types";
import type { SupplyPressureDefinition } from "../../marketEvolution";
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
import { applyStrategyProfileCapexOverlay } from "../../strategyProfileCapexOverlay";

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
  /**
   * 【商品戦略プロファイル・companyLab検証専用】trueの場合のみ、会社IDに応じた
   * 商品戦略プロファイル（standardAi/strategyProfile.ts）による小幅な
   * StandardAiParametersバイアスと、対応するcapex overlay（追加設備投資提案）を
   * 有効化する（investment overlay側=VAP R&D投資はcompanyLab/runner.ts側の
   * CompanyLabConfig.strategyProfilesEnabledで別途制御する。標準AI本体のcapex提案
   * ロジック(decision/capex.ts)は一切変更しない）。未指定(false相当)なら従来どおり
   * （既存の全出力・全テストへの影響ゼロ）。
   */
  readonly strategyProfilesEnabled?: boolean;
  /**
   * 【監査指摘B・定義比較用】供給圧力の定義。未指定＝採用済みの既定。
   * scripts/sai5SupplyPressureStudy.ts が候補を実測比較するためだけに使う。
   */
  readonly supplyPressureDefinition?: SupplyPressureDefinition;
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
  //
  // 【商品戦略プロファイル・procurementScaleEffect/vapDifferentiation追加】この2つの
  // sai5フラグは、それぞれTask 23（調達規模効果）・Task 25（VAP差別化）で実装済み
  // だが、このハーネスからは一度も有効化されていなかった（strategyProfilesEnabled
  // で会社別プロファイルのバイアスは効いても、対応するエンジン側の効果測定フラグが
  // OFFのままだったため、MASS/HOSO_SCALEの調達規模割引・VAPのR&D→能力係数が実際には
  // 一切反映されていなかった）。strategyProfilesEnabled有効時にのみ、この2フラグを
  // 連動して有効化する（strategyProfilesEnabled=false、すなわち既存の全呼び出し元・
  // 既存テストでは、この2フラグも従来どおり未設定のまま＝ビット単位で既存挙動と一致）。
  const engineFlagsActive =
    Boolean(config.productLifecycleEnabled) ||
    Boolean(config.salesBaseAccumulationEnabled) ||
    Boolean(config.supplyPremiumFeedbackEnabled) ||
    Boolean(config.strategyProfilesEnabled);
  const initResult = initializeUnifiedCompanyLabFromTemplate(
    {
      scenarioId: config.scenarioId,
      mode: "canonical",
      seed: config.seed,
      turns: config.quarters,
      // 【CompanyLabConfig.strategyProfilesEnabled(トップレベル)追加】これは
      // AutoplayCaseConfig.strategyProfilesEnabledとは別の(同名だが型上は別の)
      // フラグで、companyLab/runner.ts側でVAP商品開発「投資額」そのものを
      // strategyProfileInvestmentOverlay.ts経由でproductDevelopmentStateへ
      // 実際に投入するかどうかを制御する（types.ts CompanyLabConfig定義参照）。
      // これが未設定のままだと、sai5.vapDifferentiationをONにしても投資額が
      // 常に0のままなので、productDevelopmentScoreが中立値50から一切動かず、
      // vapCapabilityCoefficientもVAP_DIFFERENTIATIONプロファイルの狙いどおりには
      // 変化しない（Task 25のR&D→能力係数メカニズムが実質的に働かない）。
      // AutoplayCaseConfig.strategyProfilesEnabled=true時にのみ連動させる
      // （false時は従来どおり未設定＝ビット単位で既存挙動と一致）。
      ...(config.strategyProfilesEnabled ? { strategyProfilesEnabled: true } : {}),
      ...(engineFlagsActive
        ? {
            sai5: {
              productLifecycle: Boolean(config.productLifecycleEnabled),
              salesBaseAccumulation: Boolean(config.salesBaseAccumulationEnabled),
              supplyPremiumFeedback: Boolean(config.supplyPremiumFeedbackEnabled),
              ...(config.strategyProfilesEnabled
                ? { procurementScaleEffect: true, vapDifferentiation: true }
                : {}),
              ...(config.supplyPressureDefinition ? { supplyPressureDefinition: config.supplyPressureDefinition } : {}),
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
    Boolean(config.standardAiCapexEnabled) ||
    Boolean(config.strategyProfilesEnabled);
  const { provider: baseProvider, quarterStartCaptures, diagnostics } = createInstrumentedStandardAiRun(
    useResolver
      ? {
          resolveParams: createSai5ParamsResolver({
            managementProfilesEnabled: Boolean(config.managementProfilesEnabled),
            orientationEnabled: Boolean(config.marketProductOrientationEnabled),
            aiCapexEnabled: Boolean(config.standardAiCapexEnabled),
            strategyProfileEnabled: Boolean(config.strategyProfilesEnabled),
          }),
        }
      : {}
  );
  // 【商品戦略プロファイル・capex overlay】標準AI本体(decision/capex.ts)が一切提案しない
  // pdMechanization/qualityControlEquipmentを、strategyProfilesEnabled有効時のみ
  // 会社の戦略プロファイルに応じて標準AIの提出後に追加する（decision/*.ts・policy.ts
  // は一切変更しない。providerが返す意思決定を「意思決定生成の直後」でラップするだけ）。
  const provider: CompanyDecisionProvider = config.strategyProfilesEnabled
    ? (fixture, ownState, publicInfo, period, turn) => {
        const decision = baseProvider(fixture, ownState, publicInfo, period, turn);
        return applyStrategyProfileCapexOverlay(fixture, ownState, publicInfo, period, turn, decision);
      }
    : baseProvider;
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
