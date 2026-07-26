// ShrimpX V2 — 営業人員の追加採用 状態管理（Phase 8G §2新設）
//
// 【このモジュールが存在する理由】
//   fixture.salesForceHeadcountTotal（./types.ts の CompanyFixture）は静的な
//   テストフィクスチャ値であり、四半期をまたいで増減しない。しかし実装指示
//   Phase 8G §2は「営業人員を四半期ごとに増員できる」という、会社の規模という
//   本来ターンをまたいで残るべき状態を新設するよう求めている
//   （./workforce.ts のWorker総人数・Phase 8D-4と同じ理由・同じ設計思想）。
//
// 【workforce.tsとの違い】
//   workforce.tsのWorker総人数は「変更後の絶対人数」を意思決定として渡す
//   （エンジンの入力契約 WorkerAssignment.regularHeadcount が絶対人数のため）。
//   一方、営業人員の採用は実装指示により「今期採用した人数は今期は使えず、
//   教育・引継ぎ期間を経て次の四半期から営業活動に参加する」という1四半期分の
//   反映遅延を持つ。このため意思決定側は「今期の新規採用人数（0以上の増分）」
//   という差分のみを持ち、当期の配置可能人数（バジェット検証・実績人件費の
//   いずれも）には一切加算しない。四半期が確定した時点で初めて、次期の状態へ
//   加算する（runner.ts advanceCompanyLabQuarterが、この繰り越し計算の唯一の
//   呼び出し元）。
//
// 【今回追加しないもの（実装指示Phase 8G §2）】
//   採用一時費用係数・離職率・解雇費。既存のsalesForceSalaryUsdPerQuarter単価
//   （finance/parameters.ts）をそのまま使い、新しい費用係数は一切追加しない。
//   離職・解雇のモデルも新設しない。
//
// 【禁止事項】
//   - 人件費の単価をここへハードコードしない（finance/parameters.tsが唯一の
//     情報源。このモジュールは人数の状態管理のみを行う）。
//   - 総人数を負にしない。
//   - 当期の採用意思決定を当期の配置可能人数へ加算しない
//     （validateSalesForceHeadcountBudget・実績人件費のいずれも、この状態が
//     持つ「前期末までの人数」だけを参照させること。runner.ts側の責務）。

import { CompanyId } from "../sales/types";
import type { CompanyFixture } from "./types";

/** 1社ぶんの、前期末までに実際に確定した営業人員総数（当期に配分可能な人数）。 */
export interface CompanySalesForceHiringState {
  readonly companyId: CompanyId;
  readonly headcount: number;
}

export interface SalesForceHiringState {
  readonly companies: readonly CompanySalesForceHiringState[];
}

/** ラボ作成時の初期状態。fixture.salesForceHeadcountTotalをそのまま初期人数とする。 */
export function buildInitialSalesForceHiringState(fixtures: readonly CompanyFixture[]): SalesForceHiringState {
  return {
    companies: fixtures.map((f) => ({ companyId: f.companyId, headcount: Math.max(0, Math.round(f.salesForceHeadcountTotal)) })),
  };
}

/** 指定会社の前期末までの営業人員総数。見つからなければundefined（0で埋めない）。 */
export function findCompanySalesForceHeadcount(state: SalesForceHiringState | undefined, companyId: CompanyId): number | undefined {
  return state?.companies.find((c) => c.companyId === companyId)?.headcount;
}

/** 状態が実質的に空か（会社が1社も無い＝このフィールドが存在しない旧保存データ）。 */
export function isSalesForceHiringStateEmpty(state: SalesForceHiringState | undefined): boolean {
  return state === undefined || state.companies.length === 0;
}

/**
 * 当期の採用意思決定（会社ごとの新規採用人数）から、次期へ繰り越す状態を作る。
 *
 * 次期人数 = 前期末人数 + 当期決定した新規採用人数。
 * 採用人数は常に0以上として扱う（負の入力・NaN・Infinityは0に丸める。減員は
 * このモジュールの対象外＝実装指示により離職率・解雇は今回追加しない）。
 *
 * この関数はrunner.tsのadvanceCompanyLabQuarterの中で、四半期処理が実際に成功
 * した場合にのみ1回呼ばれる（既存のturnId冪等性guardと同じ経路に乗るため、
 * 再実行・再読込による二重加算は起こらない）。
 */
export function deriveNextSalesForceHiringState(
  previous: SalesForceHiringState,
  fixtures: readonly CompanyFixture[],
  hireCountByCompanyId: ReadonlyMap<CompanyId, number>
): SalesForceHiringState {
  return {
    companies: fixtures.map((f) => {
      const prevHeadcount = previous.companies.find((c) => c.companyId === f.companyId)?.headcount ?? Math.max(0, Math.round(f.salesForceHeadcountTotal));
      const hireCount = hireCountByCompanyId.get(f.companyId) ?? 0;
      const safeHireCount = Number.isFinite(hireCount) && hireCount > 0 ? Math.round(hireCount) : 0;
      return { companyId: f.companyId, headcount: prevHeadcount + safeHireCount };
    }),
  };
}
