// ShrimpX V2 — Phase SAI-3B-1: 複数SAI-3A run間の比較可能性検証（純粋関数）
//
// 三宅さんの指示§3「異なる比較runについて、seed・会社・quarterなどの対応関係を
// 検証する」「比較条件が不整合な場合は、黙って比較せず警告またはエラーにする」に
// 対応する。1 runのみの入力（単一runブック）ではこの検証はスキップされる
// （呼び出し元がrunLabels.length>=2の場合のみ呼び出す想定）。

import { LoadedSai3aRun, Sai3bComparisonValidation, SaiCompanyId } from "./schema";

function sortedUnique<T>(arr: readonly T[]): T[] {
  return Array.from(new Set(arr)).sort();
}

function intersect<T>(a: readonly T[], b: readonly T[]): T[] {
  const setB = new Set(b);
  return a.filter((x) => setB.has(x));
}

export function validateComparableRuns(runs: readonly LoadedSai3aRun[]): Sai3bComparisonValidation {
  if (runs.length === 0) {
    return { comparable: false, issues: ["比較対象のrunが1件もありません。"], commonSeeds: [], commonCompanyIds: [], commonQuarters: 0 };
  }
  if (runs.length === 1) {
    const r = runs[0];
    return {
      comparable: true,
      issues: [],
      commonSeeds: sortedUnique(r.manifest.seeds),
      commonCompanyIds: sortedUnique(r.manifest.companyIds) as SaiCompanyId[],
      commonQuarters: r.manifest.quarters,
    };
  }

  const issues: string[] = [];

  const runLabelCounts = new Map<string, number>();
  for (const r of runs) runLabelCounts.set(r.runLabel, (runLabelCounts.get(r.runLabel) ?? 0) + 1);
  const duplicateLabels = Array.from(runLabelCounts.entries()).filter(([, count]) => count > 1).map(([label]) => label);
  if (duplicateLabels.length > 0) {
    issues.push(`複数のrun入力に同一のrun識別ラベルが使われています: ${duplicateLabels.join(", ")}（--inputごとに一意なラベルが必要です）。`);
  }

  let commonSeeds = sortedUnique(runs[0].manifest.seeds);
  let commonCompanyIds = sortedUnique(runs[0].manifest.companyIds) as SaiCompanyId[];
  for (const r of runs.slice(1)) {
    commonSeeds = intersect(commonSeeds, sortedUnique(r.manifest.seeds));
    commonCompanyIds = intersect(commonCompanyIds, sortedUnique(r.manifest.companyIds) as SaiCompanyId[]);
  }

  const seedSets = runs.map((r) => sortedUnique(r.manifest.seeds));
  const allSeedsMatch = seedSets.every((s) => s.length === seedSets[0].length && s.every((v, i) => v === seedSets[0][i]));
  if (!allSeedsMatch) {
    issues.push(
      `run間でseed集合が一致していません: ${runs.map((r) => `"${r.runLabel}"=[${sortedUnique(r.manifest.seeds).join(",")}]`).join("; ")}` +
        `。共通するseedのみで比較します（共通seed数: ${commonSeeds.length}）。`
    );
  }

  const companySets = runs.map((r) => sortedUnique(r.manifest.companyIds));
  const allCompaniesMatch = companySets.every((s) => s.length === companySets[0].length && s.every((v, i) => v === companySets[0][i]));
  if (!allCompaniesMatch) {
    issues.push(
      `run間で会社ID集合が一致していません: ${runs.map((r) => `"${r.runLabel}"=[${sortedUnique(r.manifest.companyIds).join(",")}]`).join("; ")}` +
        `。共通する会社IDのみで比較します（共通会社数: ${commonCompanyIds.length}）。`
    );
  }

  const quartersSet = sortedUnique(runs.map((r) => r.manifest.quarters));
  if (quartersSet.length > 1) {
    issues.push(`run間でquarters（実行四半期数）が一致していません: ${runs.map((r) => `"${r.runLabel}"=${r.manifest.quarters}`).join(", ")}。`);
  }
  const commonQuarters = Math.min(...runs.map((r) => r.manifest.quarters));

  const headcounts = runs.map((r) => r.manifest.salesForceHeadcountTotal);
  if (new Set(headcounts).size !== headcounts.length) {
    issues.push(`複数のrunが同一の営業人員数（salesForceHeadcountTotal）を持っています: ${headcounts.join(", ")}。比較の意図と異なる可能性があります。`);
  }

  if (commonSeeds.length === 0) {
    issues.push("共通するseedが1件もないため、seed×会社単位の比較（headcount比較シート等）は生成できません。");
  }
  if (commonCompanyIds.length === 0) {
    issues.push("共通する会社IDが1件もないため、会社単位の比較は生成できません。");
  }

  const comparable = duplicateLabels.length === 0 && commonSeeds.length > 0 && commonCompanyIds.length > 0;

  return { comparable, issues, commonSeeds, commonCompanyIds, commonQuarters };
}
