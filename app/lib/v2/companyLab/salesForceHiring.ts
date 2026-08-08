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

// ---------------------------------------------------------------------
// 営業組織の増員速度制約（ゲーム共通ルール・2026-08-08追加）
// ---------------------------------------------------------------------
//
// 【これはゲームルールであり、Standard AI専用の制約ではない】
// 人間プレイヤーの入力にも、Standard AIの提案にも、同一の式が適用される。
// Standard AI側でこの式を再実装してはいけない（Single Source of Truth）。
//
// 【何を表現しているか】
// 「採用市場に人がいない」という意味ではない。営業組織を一度に大きく増やすと、
// 顧客の引継ぎ・育成・管理者のspan of control・商談情報の共有・商品知識・
// 顧客との関係構築が追いつかず、増えた人数が有効な営業戦力として機能しない、
// という組織の吸収能力（organizational absorption capacity）を表現する。
//
// 【MVPで入れないもの】
// 「営業1人あたりの習熟度」パラメータは追加しない。まず人数の増加速度だけで
// 表現する。将来必要になれば salesforce ramp-up / productivity を検討する。
//
// 【減員には適用しない】
// 人数としては任意に減らせる（上限なし）。ただし退職金・当期/翌期の反映遅延・
// 給与処理は既存ルールのまま維持される。「自由に減らせる」ことと「費用ゼロ」は別。

/** 増員上限の絶対下限。人数が少ない会社でも最低これだけは増やせる。 */
export const MIN_SALES_HIRES_PER_QUARTER = 3;

/** 増員上限の相対比率（現在の稼働営業人員に対して）。 */
export const SALES_HIRE_RAMP_RATIO = 0.3;

/**
 * 1四半期に追加できる営業人数の上限。
 *
 *   max(3, ceil(現在の稼働営業人員 × 0.30))
 *
 * 【ceilを採用した理由】三宅さんご指示の第一候補がceilであり、既存の人数処理
 * （sanitizeNonNegativeCountのround、computeEffectiveSalesForceLayoffCountのmin）
 * と矛盾しない。これらは「入力値の正規化」と「頭打ち」であって丸め方向の規約では
 * ないため、ここでceilを使っても既存ルールと衝突しない。
 * ceilにより、20人→+6（19人→+6）のように「あと少しで1人増える」場合に
 * 切り上がる。上限を切り下げて成長を余計に縛らない方向である。
 *
 * 実測例:
 *   5人 → +3 / 10人 → +3 / 20人 → +6 / 30人 → +9 / 40人 → +12 / 74人 → +23
 */
export function computeMaxSalesHiresPerQuarter(currentActiveHeadcount: number): number {
  const safe = sanitizeNonNegativeCount(currentActiveHeadcount);
  return Math.max(MIN_SALES_HIRES_PER_QUARTER, Math.ceil(safe * SALES_HIRE_RAMP_RATIO));
}

/**
 * 実際に採用できる人数（希望採用数を組織の吸収能力で頭打ちにした値）。
 * 経済合理性で決めた希望人数を、この関数に通してから意思決定へ反映する。
 *
 *   Economic Desired Hiring → Organizational Ramp Constraint → Actual Hiring
 */
export function applySalesHireRampLimit(
  currentActiveHeadcount: number,
  desiredHireCount: number
): { readonly actualHireCount: number; readonly limit: number; readonly deferredCount: number } {
  const limit = computeMaxSalesHiresPerQuarter(currentActiveHeadcount);
  const desired = sanitizeNonNegativeCount(desiredHireCount);
  const actualHireCount = Math.min(desired, limit);
  return { actualHireCount, limit, deferredCount: Math.max(0, desired - actualHireCount) };
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
