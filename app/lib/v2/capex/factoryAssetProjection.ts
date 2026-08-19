// ShrimpX V2 — ENG-FAC-1: 工場別PPEのderived projection
//
// 【方針（実装指示§1・C-1案(b)採用）】会社BSの既存PPE（CompanyFinanceState.
// fixedAssetsGross / accumulatedDepreciation）を最終SSoTとし、工場別の
// Gross PPE / Accumulated Depreciation / Net Book Value は**そこからの
// 決定論的な射影**として導出する。工場別Fixed Asset Ledgerを新設して既存BSを
// 再定義することはしない。
//
// 【按分キー（実装指示§1）】初期工場の按分キーは、その時点のeffective capacity
// ではなく、各初期工場の**不変なbaseline / design capacity比**である。
// baseline値はfixture.factories（静的・一度も書き換えられない）から読むため、
// MothballやSale Pendingでeffective capacityが0になってもNBVは一切変動しない。
//
// 【売却時に残存工場へ付け替えないこと（実装指示§1「重要」）】按分の分母は
// 「その会社の**全初期工場**（売却済みを含む）」で固定する。売却しても分母は
// 変わらないため、売却工場に帰属していた簿価が残存工場へ再按分されることは
// 構造的に起こらない。売却時は対象工場ぶんのGross PPE・Accumulated Depreciation
// を会社BSから除却し、その結果として会社の残存legacy PPE総額が減るだけである
// （残存各工場の1工場あたり簿価は不変）。この性質はreconciliation invariant test
// （__tests__/factoryAssetProjection.test.ts のFAC-PPE-*）で固定している。
//
// 【新しい台帳を作っていないことの担保】本モジュールは状態を一切持たない。
// 入力は会社BSの2スカラー・fixture.factories・CapitalProject[]・lifecycle決定ログ
// だけであり、すべて既存の永続状態である。

import { PeriodV2, INITIAL_PERIOD_V2 } from "../core/period";
import { unwrapUnit } from "../core/units";
import { Factory } from "../production/types";
import { FinanceParameters } from "../finance/parameters";
import { computeExistingAssetAccumulatedDepreciationUsd } from "../finance/depreciation";
import { CapexParameters } from "./parameters";
import { CapitalProject } from "./types";
import { buildNewFactoryId } from "./factoryConstruction";
import { computeCapexComponentAccumulatedDepreciationUsd } from "./depreciation";
import { FactoryLifecycleDecisionRecord, resolveFactoryLifecycleStateAt } from "./factoryLifecycle";

/** 1工場ぶんの簿価射影。合計は必ず会社BSと一致する（reconciliation invariant）。 */
export interface FactoryAssetValues {
  readonly factoryId: string;
  /** 取得原価（legacy按分分 ＋ その工場に帰属するcapex完成資産分）。 */
  readonly grossPpeUsd: number;
  /** 減価償却累計額（同上の内訳で合算）。 */
  readonly accumulatedDepreciationUsd: number;
  /** 帳簿価額（= grossPpeUsd − accumulatedDepreciationUsd。負にはしない）。 */
  readonly netBookValueUsd: number;
}

export interface FactoryAssetProjectionInput {
  /**
   * この会社の**初期工場**（fixture.factories。静的・不変）。按分キーの分母は
   * この配列全体から作るため、売却済みの工場もそのまま含めて渡すこと
   * （売却しても分母を変えないことが、残存工場へ簿価を付け替えない保証になる）。
   */
  readonly baselineFactories: readonly Factory[];
  /** この会社のCapital Project全件（statusは問わない。completedだけを内部で使う）。 */
  readonly projects: readonly CapitalProject[];
  /** この会社のlifecycle決定ログ。 */
  readonly lifecycleDecisions: readonly FactoryLifecycleDecisionRecord[];
  /** 評価する四半期。 */
  readonly period: PeriodV2;
  /** 会社BSの取得原価（当四半期の期首値＝prev.fixedAssetsGross）。 */
  readonly companyFixedAssetsGrossUsd: number;
  /** 会社BSの減価償却累計額（当四半期の期首値＝prev.accumulatedDepreciation）。 */
  readonly companyAccumulatedDepreciationUsd: number;
  readonly financeParams: FinanceParameters;
  readonly capexParams: CapexParameters;
}

/**
 * 初期工場のbaseline / design capacity（按分キー）。
 * fixture上の各能力プールの合計を使う。fixtureは静的であり、Mothball・Sale Pending・
 * capex増設のいずれによってもこの値は変化しない（effective capacityではない）。
 */
export function baselineDesignCapacityTons(factory: Factory): number {
  return (
    unwrapUnit(factory.commonProcessingCapacity) +
    unwrapUnit(factory.hosoCapacity) +
    unwrapUnit(factory.pdCapacity) +
    unwrapUnit(factory.vapCapacity) +
    unwrapUnit(factory.freezingPackagingCapacity)
  );
}

/**
 * Capital Projectがどの工場へ帰属するか（実装指示§8 Attached Investments）。
 *   - newFactoryConstruction : その案件が生成した新設Factory自身
 *   - targetFactoryId指定あり : その工場（PD機械化・品質管理設備・ライン増設等）
 *   - 指定なし                : 主工場（factories先頭。既存のcapex適用規約と同一）
 */
export function attributeProjectToFactoryId(project: CapitalProject, primaryFactoryId: string | undefined): string | undefined {
  if (project.projectType === "newFactoryConstruction") return buildNewFactoryId(project);
  return project.targetFactoryId ?? primaryFactoryId;
}

/**
 * 売却完了（SOLD）した工場へ帰属する、完成済みCapital ProjectのprojectId集合。
 *
 * これらの資産は会社BSから除却済みであるため、以後
 *   - nonDepreciatingCapexGrossAtPeriodStartUsd（既存資産償却ベースの復元）
 *   - capex資産の減価償却（§12「SOLD: depreciationなし」）
 *   - capex資産の固定保守費
 * のいずれからも除外しなければならない。除外しないと、除却済み資産を償却し続けて
 * 会社BSの整合が崩れる。
 */
export function listDerecognizedCapexProjectIds(
  projects: readonly CapitalProject[],
  baselineFactories: readonly Factory[],
  lifecycleDecisions: readonly FactoryLifecycleDecisionRecord[],
  period: PeriodV2
): ReadonlySet<string> {
  const primaryFactoryId = baselineFactories[0]?.factoryId;
  const result = new Set<string>();
  for (const project of projects) {
    if (project.status !== "completed") continue;
    const factoryId = attributeProjectToFactoryId(project, primaryFactoryId);
    if (!factoryId) continue;
    if (resolveFactoryLifecycleStateAt(lifecycleDecisions, factoryId, period) === "SOLD") {
      result.add(project.projectId);
    }
  }
  return result;
}

/**
 * 工場別のGross PPE / Accumulated Depreciation / NBVを導出する。
 *
 * 【legacy（初期工場）分】
 *   remainingLegacyGross = 会社fixedAssetsGross − Σ(除却済みでない完成capex資産の取得原価)
 *   share_f              = baselineDesignCapacity_f ÷ Σ baselineDesignCapacity(全初期工場)
 *   legacyGross_f        = remainingLegacyGross × share_f ÷ Σ share(未売却の初期工場)
 *
 *   分母のshare合計を「未売却分」に正規化しているのは、remainingLegacyGrossが
 *   既に売却済み工場ぶんだけ減っているためである。この2つは同じ割合で減るので、
 *   結果として legacyGross_f は売却の前後で厳密に不変になる（＝残存工場へ
 *   付け替えていない）。
 *
 *   legacyAccumDep_f は finance/depreciation.ts の閉形式（会社BS側の償却と
 *   完全に同じ式・同じパラメータ）へ legacyGross_f を入れて求める。
 *
 * 【capex建設分】その工場へ帰属する完成済み案件の capitalizedAmountUsd 合計と、
 *   capex/depreciation.ts の閉形式による累計償却額。
 */
export function computeFactoryAssetProjection(input: FactoryAssetProjectionInput): ReadonlyMap<string, FactoryAssetValues> {
  const {
    baselineFactories,
    projects,
    lifecycleDecisions,
    period,
    companyFixedAssetsGrossUsd,
    companyAccumulatedDepreciationUsd,
    financeParams,
    capexParams,
  } = input;

  const primaryFactoryId = baselineFactories[0]?.factoryId;
  const derecognized = listDerecognizedCapexProjectIds(projects, baselineFactories, lifecycleDecisions, period);

  // --- capex完成資産を工場別に集約（除却済みは除く） ---
  const capexProjectsByFactoryId = new Map<string, CapitalProject[]>();
  let liveCapexGrossTotalUsd = 0;
  for (const project of projects) {
    if (project.status !== "completed" || project.capitalizedAmountUsd === undefined) continue;
    if (derecognized.has(project.projectId)) continue;
    const factoryId = attributeProjectToFactoryId(project, primaryFactoryId);
    if (!factoryId) continue;
    liveCapexGrossTotalUsd += project.capitalizedAmountUsd;
    const bucket = capexProjectsByFactoryId.get(factoryId);
    if (bucket) bucket.push(project);
    else capexProjectsByFactoryId.set(factoryId, [project]);
  }

  // --- legacy（初期工場）分の按分 ---
  const remainingLegacyGrossUsd = Math.max(0, companyFixedAssetsGrossUsd - liveCapexGrossTotalUsd);
  const totalBaselineCapacity = baselineFactories.reduce((s, f) => s + baselineDesignCapacityTons(f), 0);
  const survivingBaselineCapacity = baselineFactories.reduce(
    (s, f) => (resolveFactoryLifecycleStateAt(lifecycleDecisions, f.factoryId, period) === "SOLD" ? s : s + baselineDesignCapacityTons(f)),
    0
  );

  const result = new Map<string, FactoryAssetValues>();
  const allFactoryIds = new Set<string>([...baselineFactories.map((f) => f.factoryId), ...capexProjectsByFactoryId.keys()]);

  for (const factoryId of allFactoryIds) {
    const baseline = baselineFactories.find((f) => f.factoryId === factoryId);
    const isSold = resolveFactoryLifecycleStateAt(lifecycleDecisions, factoryId, period) === "SOLD";

    let legacyGrossUsd = 0;
    if (baseline && !isSold && survivingBaselineCapacity > 0 && totalBaselineCapacity > 0) {
      const share = baselineDesignCapacityTons(baseline) / totalBaselineCapacity;
      const survivingShareSum = survivingBaselineCapacity / totalBaselineCapacity;
      legacyGrossUsd = (remainingLegacyGrossUsd * share) / survivingShareSum;
    }
    const legacyAccumDepUsd =
      legacyGrossUsd > 0 ? computeExistingAssetAccumulatedDepreciationUsd(legacyGrossUsd, INITIAL_PERIOD_V2, period, financeParams).totalUsd : 0;

    const factoryProjects = capexProjectsByFactoryId.get(factoryId) ?? [];
    const capexGrossUsd = factoryProjects.reduce((s, p) => s + (p.capitalizedAmountUsd ?? 0), 0);
    const capexAccumDepUsd = computeCapexComponentAccumulatedDepreciationUsd(factoryProjects, capexParams, period).totalUsd;

    const grossPpeUsd = legacyGrossUsd + capexGrossUsd;
    // 【会社BSが最終SSoT】償却累計は取得原価と会社BS実績の双方を超えないようクランプする。
    // これにより、除却額が会社BSに存在しない金額を差し引くことは構造的に起こらない。
    const accumulatedDepreciationUsd = Math.min(legacyAccumDepUsd + capexAccumDepUsd, grossPpeUsd, Math.max(0, companyAccumulatedDepreciationUsd));

    result.set(factoryId, {
      factoryId,
      grossPpeUsd,
      accumulatedDepreciationUsd,
      netBookValueUsd: Math.max(0, grossPpeUsd - accumulatedDepreciationUsd),
    });
  }

  return result;
}
