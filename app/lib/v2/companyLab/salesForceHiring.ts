// ShrimpX V2 — 営業人員の追加採用・減員 状態管理（forward-port元: Phase 8G §2 / 旧コミット3f20620。
// 減員・退職金は今回のforward-port続き作業で新規追加）
//
// 【このモジュールが存在する理由】
//   fixture.salesForceHeadcountTotal（./types.ts の CompanyFixture）は静的な
//   テストフィクスチャ値であり、四半期をまたいで増減しない。しかし「営業人員を
//   四半期ごとに増減できる」という、会社の規模という本来ターンをまたいで残る
//   べき状態が必要（./workforce.ts のWorker総人数・Phase 8D-4と同じ理由・
//   同じ設計思想）。
//
// 【workforce.tsとの違い】
//   workforce.tsのWorker総人数は「変更後の絶対人数」を意思決定として渡す
//   （エンジンの入力契約 WorkerAssignment.regularHeadcount が絶対人数のため）。
//   一方、営業人員の採用・減員は「今期決定した増減は今期は反映されず、次の
//   四半期から営業戦力・通常給与へ反映される」という1四半期分の反映遅延を持つ
//   （採用＝教育・引継ぎ期間、減員＝退職手続き期間、いずれも今期は変わらず
//   稼働・給与支払いが続くという設計）。このため意思決定側は「今期の増員数・
//   減員数（いずれも0以上）」という差分のみを持ち、当期の配置可能人数
//   （バジェット検証・実績人件費のいずれも）には一切加算・減算しない。
//   四半期が確定した時点で初めて、次期の状態へ加算・減算する
//   （runner.ts advanceCompanyLabQuarterが、この繰り越し計算の唯一の呼び出し元）。
//
// 【減員・退職金の設計（今回追加）】
//   - 増員・減員は同一四半期に同時入力できない（会社の意思決定として排他。
//     runner.ts側で検証・エラー化する。このモジュールは検証を行わず、
//     入力された増員数・減員数をそのまま使う純粋関数のみを提供する）。
//   - 減員対象者は、決定した当期中は営業戦力・通常給与に含まれたまま
//     （次期から営業戦力・通常給与の対象外になる＝headcountが次期から減る）。
//   - 減員を決定した当期に、1人あたり四半期給与2四半期分の退職金を一度だけ
//     費用・支出計上する（finance/quarterClose.ts側の責務。単価は
//     finance/parameters.tsのsalesForceSalaryUsdPerQuarterをそのまま使う）。
//   - 営業人員は0人未満にはならない（減員数が前期末人数を超える場合は、
//     実際に減員される人数・退職金の対象人数の両方を前期末人数で頭打ちする。
//     computeEffectiveSalesForceLayoffCount参照）。
//
// 【今回追加しないもの】
//   採用一時費用係数・離職率（自然減）。既存のsalesForceSalaryUsdPerQuarter単価
//   （finance/parameters.ts）をそのまま使い、新しい費用係数は一切追加しない
//   （退職金の「2四半期分」という係数のみ、finance/quarterClose.ts側に追加する）。
//   Standard AIの減員判断ロジックは後続課題（autoPolicy.tsは常に
//   salesForceLayoffCount: 0を返し、従来挙動を維持する）。
//
// 【禁止事項】
//   - 人件費の単価をここへハードコードしない（finance/parameters.tsが唯一の
//     情報源。このモジュールは人数の状態管理のみを行う）。
//   - 総人数を負にしない。
//   - 当期の採用・減員意思決定を当期の配置可能人数へ加算・減算しない
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

/** 状態が実質的に空か（会社が1社も無い＝このフィールドが存在しない旧保存データ）。 */
export function isSalesForceHiringStateEmpty(state: SalesForceHiringState | undefined): boolean {
  return state === undefined || state.companies.length === 0;
}

/** 会社1社ぶんの当期の営業人員増減意思決定（採用数・減員数、いずれも0以上）。 */
export interface SalesForceHiringLayoffDecision {
  readonly hireCount: number;
  readonly layoffCount: number;
}

/** 入力値を0以上の整数へ丸める（負・小数・NaN・Infinityへの防御。既存のhire側と同じ丸め方針）。 */
function sanitizeNonNegativeCount(raw: number): number {
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 0;
}

/**
 * 当期の減員意思決定と前期末人数から、当期に実際に減員される人数（＝退職金の
 * 対象人数）を求める。前期末人数を超える減員は前期末人数で頭打ちする
 * （営業人員は0人未満にならない）。負・小数・NaN・Infinityの入力は0として扱う。
 *
 * runner.ts（退職金コスト算出）とderiveNextSalesForceHiringState（次期人数算出）
 * の両方から呼ばれ、「実際に何人減員されたか」の判定を一箇所に集約する
 * （二重実装によるズレを防ぐ）。
 */
export function computeEffectiveSalesForceLayoffCount(currentHeadcount: number, requestedLayoffCount: number): number {
  const safeCurrentHeadcount = sanitizeNonNegativeCount(currentHeadcount);
  const safeRequestedLayoffCount = sanitizeNonNegativeCount(requestedLayoffCount);
  return Math.min(safeRequestedLayoffCount, safeCurrentHeadcount);
}

/**
 * 当期の採用・減員意思決定（会社ごと）から、次期へ繰り越す状態を作る。
 *
 * 次期人数 = 前期末人数 + 当期決定した新規採用人数 − 当期に実際に減員される人数
 * （computeEffectiveSalesForceLayoffCountで前期末人数を頭打ちにした人数）。
 * 増員・減員は同一会社が同一四半期に両方>0で入力することは想定していない
 * （runner.ts側で意思決定の受理時に検証・エラー化する。このモジュールは
 * 検証を行わず、渡された数値をそのまま使う）。
 *
 * この関数はrunner.tsのadvanceCompanyLabQuarterの中で、四半期処理が実際に成功
 * した場合にのみ1回呼ばれる（既存のturnId冪等性guardと同じ経路に乗るため、
 * 再実行・再読込による二重加算・二重減算は起こらない）。
 */
export function deriveNextSalesForceHiringState(
  previous: SalesForceHiringState,
  fixtures: readonly CompanyFixture[],
  decisionsByCompanyId: ReadonlyMap<CompanyId, SalesForceHiringLayoffDecision>
): SalesForceHiringState {
  return {
    companies: fixtures.map((f) => {
      const prevHeadcount = previous.companies.find((c) => c.companyId === f.companyId)?.headcount ?? Math.max(0, Math.round(f.salesForceHeadcountTotal));
      const decision = decisionsByCompanyId.get(f.companyId) ?? { hireCount: 0, layoffCount: 0 };
      const safeHireCount = sanitizeNonNegativeCount(decision.hireCount);
      const effectiveLayoffCount = computeEffectiveSalesForceLayoffCount(prevHeadcount, decision.layoffCount);
      return { companyId: f.companyId, headcount: Math.max(0, prevHeadcount + safeHireCount - effectiveLayoffCount) };
    }),
  };
}
