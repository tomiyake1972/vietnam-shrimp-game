// ShrimpX V2 — 設備投資モジュール 新工場建設（Test15新設）
//
// newFactoryConstruction案件（capex/parameters.ts参照）が完成・稼働開始した後、
// 会社のFactory[]へ新しいFactoryそのものを1つ追加するための純粋関数群。
//
// 【既存の能力効果（capacityEffect.ts）との違い】
//   既存の設備投資（HOSO/PD/VAP増設等）は、承認済み案件のfutureCapacityEffectを
//   毎期再導出し、会社の「主工場」（factories配列の先頭）へ単一プールぶんだけ
//   加算する（applyCapexCapacityToFactories）。新工場建設はこれとは根本的に異なり、
//   既存工場の能力を一切変更せず、完全に新しいFactoryオブジェクトを1つ合成して
//   Factory[]へ追加する。
//
// 【禁止事項（実装指示どおり）】
//   - 「稼働開始済みか否か」の判定を独自に書かない。必ず
//     capacityEffect.ts の isCapexProjectOperationalAt を呼ぶ。
//   - 新設Factoryの能力値・ランプアップ倍率をここへハードコードしない。
//     唯一の情報源は承認時スナップショット（CapitalProject.newFactoryEffect）。
//   - ワーカー・営業人員・需要・販売能力を、Factory[]の要素数や新設Factoryの
//     能力から自動的に増やさない（それぞれ別の既存システムが引き続き管理する）。

import { PeriodV2, toYearQuarter } from "../core/period";
import { hosoEqTons, ratio } from "../core/units";
import { CompanyId } from "../sales/types";
import { Factory } from "../production/types";
import { deriveDefaultFactorySpaceUnits } from "../production/factorySpace";
import { applyCapexCapacityToFactories, computeOperationalStartPeriod, isCapexProjectOperationalAt } from "./capacityEffect";
import { isActiveStatus } from "./projectLifecycle";
import { CapexState, CapitalProject } from "./types";

// ---------------------------------------------------------------------
// 期間演算（capacityEffect.ts・depreciation.tsと同じローカル実装パターンを踏襲。
// 共通ユーティリティへ抽出しない既存の慣例に従う）。
// ---------------------------------------------------------------------

function quartersBetween(from: PeriodV2, to: PeriodV2): number {
  const a = toYearQuarter(from);
  const b = toYearQuarter(to);
  return (b.year * 4 + b.quarter) - (a.year * 4 + a.quarter);
}

// ---------------------------------------------------------------------
// 1. 決定論的Factory ID
// ---------------------------------------------------------------------

/**
 * 新設Factoryの決定論的ID。
 *
 * 【調査結果】既存のFactory IDは "${companyId}-F1"（companyLab/fixtures.ts）のような
 * 「会社ID＋工場連番」だけの単純なパターンであり、ゲーム（ラボ）インスタンスを
 * 識別する"game ID"に相当するものは、生産・設備投資エンジン（production/・capex/）の
 * 層には存在しない（CompanyLabのラボID・シード等は永続化層（app/v2/company-lab/）
 * にはあるが、この2モジュールへは一切渡っていない）。
 *
 * このため、既存パターンと衝突しないよう明確に区別できるプレフィックス"NEWF"を使い、
 * さらに「会社ID＋この投資案件の連番」を組み込む。CapitalProject.projectIdは
 * すでに"${companyId}-CAPEX-${連番}"という会社スコープの決定論的な連番
 * （CompanyCapexState.nextProjectSequence、承認時にのみ進む）を持つため、これを
 * そのまま使えば、同じ会社・同じ案件からは常に同じFactory IDが得られ、かつ
 * どの投資案件がこの工場を作ったかも直接追跡できる。
 */
export function buildNewFactoryId(project: Pick<CapitalProject, "companyId" | "projectId">): string {
  return `${project.companyId}-NEWF-${project.projectId}`;
}

// ---------------------------------------------------------------------
// 2. ランプアップ倍率
// ---------------------------------------------------------------------

/**
 * 稼働開始からの経過四半期数（0始まり。稼働開始した四半期そのものが0）から、
 * その四半期の実効能力倍率を求める。倍率テーブルの末尾を超える四半期は、
 * 末尾の値（＝フルランプ、通常1.0）をそのまま使い続ける。
 */
export function rampMultiplierForQuartersOperational(quartersOperational: number, rampMultipliers: readonly number[]): number {
  if (rampMultipliers.length === 0) return 1;
  const clampedIndex = Math.max(0, Math.min(quartersOperational, rampMultipliers.length - 1));
  const m = rampMultipliers[clampedIndex];
  return Number.isFinite(m) && m >= 0 ? m : 1;
}

// ---------------------------------------------------------------------
// 3. Factory合成
// ---------------------------------------------------------------------

/**
 * 1件のnewFactoryConstruction案件から、period時点の新設Factoryを合成する。
 * まだ稼働開始していなければundefinedを返す（＝Factory[]へ一切追加しない。
 * 実装指示「完成+操業準備期間経過後」に新規要素を追加する、を満たす）。
 *
 * 【ランプアップの適用範囲】commonProcessing/hoso/pd/vap/freezingPackaging・
 * coldStorageのすべての能力プールへ、その四半期のランプ倍率を掛ける
 * （「実効能力」という実装指示の表現に合わせる）。totalFactorySpaceUnitsだけは
 * フルランプ（満稼働）時の名目能力から導出する（建屋自体の床面積は竣工時点で
 * 確定しており、操業度に応じて物理的に変化するものではないため）。
 *
 * 【baseUtilizationRate・equipmentAvailabilityRate・statusについて】
 * companyLab/fixtures.tsの標準工場ヘルパー（factory()関数）の既定値
 * （baseUtilizationRate=0.9、equipmentAvailabilityRate=0.95、status="active"）を
 * そのまま複製する（要件「標準工場の値をそのまま流用する」。capex/はcompanyLab/を
 * importできない層構造のため、companyLab/fixtures.tsのfactory()を直接呼ぶのではなく
 * 同じ定数をここへ複製している。値の変更が必要な場合は両箇所を同時に見直すこと）。
 */
export function buildNewFactoryFromProject(project: CapitalProject, period: PeriodV2): Factory | undefined {
  if (project.projectType !== "newFactoryConstruction") return undefined;
  if (!isCapexProjectOperationalAt(project, period)) return undefined;
  const effect = project.newFactoryEffect;
  if (!effect || project.completedPeriod === undefined) return undefined;

  const readiness = project.futureCapacityEffect?.readinessQuartersAfterCompletion ?? 0;
  const operationalStart = computeOperationalStartPeriod(project.completedPeriod, readiness);
  const quartersOperational = quartersBetween(operationalStart, period);
  const multiplier = rampMultiplierForQuartersOperational(quartersOperational, effect.rampMultipliers);

  const full = effect.fullCapacities;
  const rampedFactory: Factory = {
    factoryId: buildNewFactoryId(project),
    companyId: project.companyId,
    status: "active",
    commonProcessingCapacity: hosoEqTons(full.commonProcessing * multiplier),
    hosoCapacity: hosoEqTons(full.hoso * multiplier),
    pdCapacity: hosoEqTons(full.pd * multiplier),
    vapCapacity: hosoEqTons(full.vap * multiplier),
    freezingPackagingCapacity: hosoEqTons(full.freezingPackaging * multiplier),
    coldStorageCapacity: hosoEqTons(full.coldStorage * multiplier),
    // 【companyLab/fixtures.ts factory()の既定値を複製（上記コメント参照）】
    baseUtilizationRate: ratio(0.9),
    equipmentAvailabilityRate: ratio(0.95),
  };

  // totalFactorySpaceUnitsは、ランプの影響を受けないフルランプ時の名目能力から
  // 導出する（production/factorySpace.tsのderiveDefaultFactorySpaceUnitsをそのまま
  // 使い、スペース係数・計算式を複製しない）。
  const fullNominalFactory: Factory = {
    ...rampedFactory,
    commonProcessingCapacity: hosoEqTons(full.commonProcessing),
    hosoCapacity: hosoEqTons(full.hoso),
    pdCapacity: hosoEqTons(full.pd),
    vapCapacity: hosoEqTons(full.vap),
    freezingPackagingCapacity: hosoEqTons(full.freezingPackaging),
    coldStorageCapacity: hosoEqTons(full.coldStorage),
  };

  return {
    ...rampedFactory,
    totalFactorySpaceUnits: deriveDefaultFactorySpaceUnits(fullNominalFactory),
  };
}

/**
 * 1社ぶんの投資案件ポートフォリオから、period時点で稼働開始済みの
 * newFactoryConstruction案件だけを対象に、新設Factoryの一覧を合成する
 * （承認順・projectId順に決定論的に並べる）。
 */
export function computeNewFactoriesForCompany(projects: readonly CapitalProject[], period: PeriodV2): readonly Factory[] {
  return projects
    .filter((p) => p.projectType === "newFactoryConstruction")
    .slice()
    .sort((a, b) => (a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0))
    .map((p) => buildNewFactoryFromProject(p, period))
    .filter((f): f is Factory => f !== undefined);
}

/**
 * 既存のcapex/capacityEffect.ts applyCapexCapacityToFactoriesが返した
 * （HOSO/PD/VAP等ライン増設ぶんを主工場へ加算済みの）Factory[]へ、稼働開始済みの
 * newFactoryConstruction案件ぶんの新設Factoryを追加する。
 *
 * 【呼び出し順序】companyLab/runner.tsが
 *   applyCapexCapacityToFactories → applyNewFactoryConstructionToFactories
 * の順で呼ぶことを前提とする（新設Factoryは既存工場ではないため、既存能力への
 * 加算ロジック（主工場への単一プール加算）とは完全に独立しており、どちらを先に
 * 呼んでも結果は変わらないが、呼び出し側の意図を明確にするため常にこの順序とする）。
 *
 * 【会社をまたいで影響しない】capexState.companiesをcompanyIdでグルーピングし、
 * 各社の新設Factoryはその会社のfactoriesへのみ追加する。
 */
export function applyNewFactoryConstructionToFactories(factories: readonly Factory[], capexState: CapexState, period: PeriodV2): readonly Factory[] {
  const newFactoriesByCompany = new Map<CompanyId, readonly Factory[]>();
  for (const company of capexState.companies) {
    const newFactories = computeNewFactoriesForCompany(company.portfolio.projects, period);
    if (newFactories.length > 0) newFactoriesByCompany.set(company.companyId, newFactories);
  }
  if (newFactoriesByCompany.size === 0) return factories;

  const result = factories.slice();
  const existingFactoryIds = new Set(factories.map((f) => f.factoryId));
  for (const [, newFactories] of newFactoriesByCompany) {
    for (const nf of newFactories) {
      // 【冪等性】同じFactory IDがすでに存在する場合は追加しない（呼び出し側が
      // 誤って2回適用しても工場が重複しない。buildNewFactoryIdは決定論的なので、
      // 同じ案件からは常に同じIDが得られる）。
      if (existingFactoryIds.has(nf.factoryId)) continue;
      result.push(nf);
      existingFactoryIds.add(nf.factoryId);
    }
  }
  return result;
}

// ---------------------------------------------------------------------
// 3b. 当四半期の「実効Factory[]」の唯一の計算箇所（develop/v2統合・Required fix 2）
// ---------------------------------------------------------------------

/**
 * ある四半期時点で実際に使える「実効Factory[]」（既存工場への能力加算＋稼働開始済み
 * 新設Factoryの合成の両方を反映した最終形）を計算する、唯一の場所。
 *
 * 【背景（develop/v2統合時に発見・修正）】companyLab/runner.ts の advanceCompanyLabQuarter
 * は、この2関数（applyCapexCapacityToFactories → applyNewFactoryConstructionToFactories）
 * を毎期この順で呼んで実効Factory[]を求めていたが、意思決定側
 * （companyLab/types.ts CompanyOwnState・app/v2/company-lab/decisionDraft.ts・
 * DecisionEditor.tsx）は同じ計算をせず、fixture.factories（静的・作成時点の初期工場
 * だけ）を直接参照していた。このため、新工場建設が稼働開始しても、プレイヤーは
 * その工場へ生産計画・ワーカー配置を入力する手段がなかった（新設Factory自体は
 * エンジン内では正しく生産されるが、UIからは触れなかった）。
 *
 * この関数をCompanyOwnState.effectiveFactories（companyLab/runner.ts
 * buildCompanyOwnState）・advanceCompanyLabQuarter自身の両方から呼ぶことで、
 * 「今使えるFactory[]」の計算箇所を本関数の1箇所へ統一し、両者が食い違うことを
 * 構造的に防ぐ（実装指示「ONE canonical place」）。
 */
export function computeEffectiveFactories(baseFactories: readonly Factory[], capexState: CapexState, period: PeriodV2): readonly Factory[] {
  // 【複数工場CAPEX Targeting修正】先に稼働開始済み新設Factoryを合成してから
  // 能力増強効果を適用する（順序を入れ替えた）。理由: targetFactoryIdが
  // 新設Factory（例: BAL-NEWF-...）を指す案件が完成した場合、applyCapexCapacityToFactories
  // がその増強を適用できるためには、対象Factoryが渡すfactories配列に既に
  // 存在していなければならない。applyNewFactoryConstructionToFactoriesは
  // 新設Factoryを純粋に追加するだけで、baseFactories側の能力増強有無には
  // 依存しないため、順序を入れ替えても既存工場側の結果は変わらない。
  const withNewFactories = applyNewFactoryConstructionToFactories(baseFactories, capexState, period);
  return applyCapexCapacityToFactories(withNewFactories, capexState, period);
}

// ---------------------------------------------------------------------
// 4. 工場数上限（実装指示: 1社あたり最大4工場）
// ---------------------------------------------------------------------

export const MAX_FACTORIES_PER_COMPANY = 4;

/**
 * 「この会社は今、最終的に何工場になりうるか」を数える。
 * 既存の基礎工場数（fixture.factories.length、静的）＋ newFactoryConstruction案件のうち
 * 取消(cancelled)以外（approved・underConstruction・suspended・completed。＝着工前の
 * 承認済みも含め、将来工場になりうる案件をすべて数える）の件数を合算する。
 * 実装指示「active + completed + still-under-construction の新工場案件を合算してカウント」
 * を満たす（isActiveStatusはapproved/underConstruction/suspendedを指す。これに
 * completedを加えたものが「取消以外すべて」と一致する）。
 */
export function countProspectiveFactories(existingFactoryCount: number, projects: readonly CapitalProject[]): number {
  const newFactoryProjectCount = projects.filter(
    (p) => p.projectType === "newFactoryConstruction" && (isActiveStatus(p.status) || p.status === "completed")
  ).length;
  return existingFactoryCount + newFactoryProjectCount;
}

/** 新工場建設の追加提案1件を承認すると上限(4工場)を超えるか。 */
export function wouldExceedMaxFactories(existingFactoryCount: number, projects: readonly CapitalProject[]): boolean {
  return countProspectiveFactories(existingFactoryCount, projects) + 1 > MAX_FACTORIES_PER_COMPANY;
}
