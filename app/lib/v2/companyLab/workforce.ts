// ShrimpX V2 — Worker（工場作業者）の総人数管理（Phase 8D-4新設）
//
// 【このモジュールが存在する理由（テストプレイで見つかった不具合）】
//   Phase 8D以前、意思決定画面のワーカー人数の初期値は
//   decisionDraft.ts の buildInitialDraft が
//     autoDecision.workerAssignments（= fixture.workerBaseline そのまま）
//   から作っていた。つまり**前四半期にプレイヤーが人数を変えても、次の四半期の
//   初期値は毎回fixtureの初期人数へ戻ってしまう**。会社の人員規模という、
//   本来ターンをまたいで残るべき状態がどこにも保持されていなかった。
//
//   Phase 8D-4では、
//     - 会社状態には「変更後の総人数」を保持し（このモジュールのWorkforceState）
//     - 意思決定では「増減差分」を入力する
//   という形へ改める（実装指示 Phase 8D-4）。
//
// 【エンジンとの接続】
//   生産エンジン（production/labor.ts・allocation.ts）の入力は従来どおり
//   WorkerAssignment（絶対人数）である。エンジンの契約は一切変更しない。
//   本モジュールは「前期末の総人数 ＋ 当期の増減 ＝ 当期の絶対人数」という
//   変換と、その結果を次期の総人数として繰り越す責務だけを持つ。
//
//   人件費も同様で、finance/quarterClose.ts が
//     正社員人件費 = 正社員数 × regularWorkerSalaryUsdPerQuarter
//     遊休労務費   = （割り当てられなかった正社員数）× 同単価
//   をすでに実装済みである。したがってWorkerを減らせば、画面の警告だけでなく
//   実際の人件費と有効労働能力の両方へ自動的に反映される（本モジュールは
//   人件費の計算式を再実装しない。表示用の試算だけ、同じパラメータを使って行う）。
//
// 【今回追加しないもの（実装指示 Phase 8D-4）】
//   採用費・解雇費・退職費・解雇人数制限・教育期間・習熟度・労使関係・
//   機械化/省人化投資。将来の設計案は完了報告に記載する。
//
// 【禁止事項】
//   - 有効労働能力の計算式をここで再実装しない
//     （production/labor.ts の calculateLaborCapacityFromAssignedHeadcount /
//      requiredHeadcountForQuantity を必ず呼ぶ）。
//   - 人件費の単価をここへハードコードしない（finance/parameters.ts が唯一の情報源）。
//   - 総人数を負にしない。増減差分が総人数を下回る場合は0で止める。

import { CompanyId } from "../sales/types";
import { Product } from "../market/types";
import { WorkerAssignment } from "../production/types";
import { PRODUCTION_PARAMETERS_V1, ProductionParameters } from "../production/parameters";
import { requiredHeadcountForQuantity } from "../production/labor";
import { FINANCE_PARAMETERS_V1, FinanceParameters } from "../finance/parameters";
// 型のみの参照にとどめ、実行時の循環参照を作らない（types.ts はこのファイルの
// 状態型を型としてだけ参照し、このファイルは CompanyFixture を型としてだけ参照する）。
import type { CompanyFixture } from "./types";

// ---------------------------------------------------------------------
// 1. 状態（ターンをまたいで保持する）
// ---------------------------------------------------------------------

/** 1工場ぶんのWorker総人数（前期末時点＝当期の意思決定の出発点）。 */
export interface FactoryWorkforceState {
  readonly factoryId: string;
  /** 常用（正社員）ワーカーの総人数。ターンをまたいで保持する。 */
  readonly regularHeadcount: number;
}

export interface CompanyWorkforceState {
  readonly companyId: CompanyId;
  readonly factories: readonly FactoryWorkforceState[];
}

export interface WorkforceState {
  readonly companies: readonly CompanyWorkforceState[];
}

/**
 * ラボ作成時の初期Worker状態。fixture.workerBaseline の常用人数をそのまま
 * 初期総人数とする。
 *
 * 【後方互換】Phase 8D以前に作成された保存データには workforceState が存在しない。
 * その場合も同じこの関数で fixtures から復元するため、旧データを読み込んだ
 * 直後の人数は「これまで画面に出ていた初期値」と完全に一致する。
 */
export function buildInitialWorkforceState(fixtures: readonly CompanyFixture[]): WorkforceState {
  return {
    companies: fixtures.map((f) => ({
      companyId: f.companyId,
      factories: f.workerBaseline.map((b) => ({ factoryId: b.factoryId, regularHeadcount: Math.max(0, Math.round(b.regularHeadcount)) })),
    })),
  };
}

/** 指定会社・指定工場の前期末総人数。見つからなければ undefined（0で埋めない）。 */
export function findFactoryRegularHeadcount(
  state: WorkforceState | undefined,
  companyId: CompanyId,
  factoryId: string
): number | undefined {
  const company = state?.companies.find((c) => c.companyId === companyId);
  const factory = company?.factories.find((f) => f.factoryId === factoryId);
  return factory?.regularHeadcount;
}

/**
 * 当期の意思決定（＝エンジンへ渡した WorkerAssignment の絶対人数）から、
 * 次期へ繰り越すWorker状態を作る。
 *
 * 【なぜ意思決定の絶対人数を正とするか】
 *   「会社状態には変更後の総人数を保存する」という要件を、増減差分を
 *   もう一度足し直す形で実装すると、UI側の計算とエンジンへ渡した値がずれたときに
 *   人数が静かに乖離する。エンジンが実際に使った値をそのまま繰り越すことで、
 *   保存される総人数は常に「実際にその四半期を動かした人数」に一致する。
 */
export function deriveNextWorkforceState(
  previous: WorkforceState,
  fixtures: readonly CompanyFixture[],
  workerAssignmentsByCompanyId: ReadonlyMap<CompanyId, readonly WorkerAssignment[]>
): WorkforceState {
  return {
    companies: fixtures.map((f) => {
      const prevCompany = previous.companies.find((c) => c.companyId === f.companyId);
      const submitted = workerAssignmentsByCompanyId.get(f.companyId) ?? [];
      return {
        companyId: f.companyId,
        factories: f.workerBaseline.map((b) => {
          const assignment = submitted.find((w) => w.factoryId === b.factoryId);
          if (assignment !== undefined) {
            return { factoryId: b.factoryId, regularHeadcount: Math.max(0, Math.round(assignment.regularHeadcount)) };
          }
          // 当期の意思決定にその工場のワーカー配置が含まれていなければ、前期末の
          // 人数を据え置く（0へ落とさない。「指定しなかった＝全員解雇」ではない）。
          const prevFactory = prevCompany?.factories.find((x) => x.factoryId === b.factoryId);
          return { factoryId: b.factoryId, regularHeadcount: prevFactory?.regularHeadcount ?? Math.max(0, Math.round(b.regularHeadcount)) };
        }),
      };
    }),
  };
}

/**
 * 【Phase 8D-4 後方互換】確定履歴に保存済みの意思決定（各社の WorkerAssignment）から
 * Worker総人数を復元する。
 *
 * Phase 8D以前に作成されたラボのランタイム状態には workforceState が存在しないが、
 * 「その四半期に実際に何人で動かしたか」は確定履歴の decisions[].workerAssignments に
 * 保存済みである。したがって推測値を作らずに、直近の確定履歴からそのまま復元できる。
 * 履歴も無い（1四半期も進んでいない）場合は空を返し、呼び出し側が fixture の
 * 基準人数へフォールバックする。
 */
export function deriveWorkforceStateFromDecisions(
  decisions: readonly { readonly companyId: CompanyId; readonly workerAssignments: readonly WorkerAssignment[] }[]
): WorkforceState {
  return {
    companies: decisions.map((d) => ({
      companyId: d.companyId,
      factories: d.workerAssignments.map((w) => ({
        factoryId: w.factoryId,
        regularHeadcount: Math.max(0, Math.round(w.regularHeadcount)),
      })),
    })),
  };
}

/** 総人数の状態が実質的に空か（会社が無い、またはどの会社にも工場エントリが無い）。 */
export function isWorkforceStateEmpty(state: WorkforceState | undefined): boolean {
  if (state === undefined) return true;
  if (state.companies.length === 0) return true;
  return state.companies.every((c) => c.factories.length === 0);
}

// ---------------------------------------------------------------------
// 2. 増減差分 → 変更後総人数
// ---------------------------------------------------------------------

/** 1工場ぶんのWorker増減意思決定（意思決定側は差分を持つ）。 */
export interface WorkerHeadcountChange {
  readonly factoryId: string;
  /** 増員は正、減員は負。 */
  readonly regularHeadcountChange: number;
}

/**
 * 前期末の総人数へ増減差分を適用して、当期の総人数を求める。
 * 総人数は0未満にしない（減員希望が現在人数を上回る場合は0で止める）。
 */
export function applyHeadcountChange(currentHeadcount: number, change: number): number {
  const safeCurrent = Number.isFinite(currentHeadcount) && currentHeadcount > 0 ? Math.round(currentHeadcount) : 0;
  const safeChange = Number.isFinite(change) ? Math.round(change) : 0;
  return Math.max(0, safeCurrent + safeChange);
}

// ---------------------------------------------------------------------
// 3. 必要人数の算出（生産計画に対する過不足）
// ---------------------------------------------------------------------

export interface RequiredHeadcountInput {
  /** 商品別に処理したい数量（完成品HOSO換算トン）。 */
  readonly quantityByProduct: Readonly<Partial<Record<Product, number>>>;
  /** 技能水準（商品別、0〜1）。 */
  readonly skillByProduct: Readonly<Partial<Record<Product, number>>>;
  readonly attendanceRate: number;
  readonly appliedOvertimeRate: number;
  /** すでに配置済みの臨時ワーカー人数（常用の必要人数を減らす）。 */
  readonly temporaryHeadcount: number;
  readonly params?: ProductionParameters;
}

export interface RequiredHeadcountResult {
  /** 商品別の必要常用人数（臨時ワーカーを考慮する前）。 */
  readonly requiredRegularByProduct: Readonly<Partial<Record<Product, number>>>;
  /** 必要常用人数の合計（臨時ワーカーを考慮する前）。 */
  readonly requiredRegularBeforeTemporary: number;
  /** 臨時ワーカーが肩代わりできる常用人数の相当分。 */
  readonly temporaryEquivalentRegularHeadcount: number;
  /** 実際に必要な常用人数（臨時ワーカーぶんを差し引いたあと。0未満にはしない）。 */
  readonly requiredRegularHeadcount: number;
}

/**
 * 生産計画を処理するために必要な常用ワーカー人数を算出する。
 *
 * 逆算そのものは production/labor.ts の requiredHeadcountForQuantity が担い、
 * このモジュールは商品ごとの合算と、臨時ワーカーぶんの差し引きだけを行う。
 *
 * 【近似であることの明示】エンジンは商品ごとに優先順位階層＋水位法で
 * ワーカーを配分するため、「必要人数」は配分結果と厳密には一致しない
 * （能力・原料側で先に頭打ちになれば、必要人数はこれより少なくて済む）。
 * したがって呼び出し側は、この値を目安として示し、実際に処理できる量は
 * 必ず allocateProductionPlans を通した処理見込みで示すこと。
 */
export function computeRequiredRegularHeadcount(input: RequiredHeadcountInput): RequiredHeadcountResult {
  const params = input.params ?? PRODUCTION_PARAMETERS_V1;
  const requiredRegularByProduct: Partial<Record<Product, number>> = {};
  let requiredRegularBeforeTemporary = 0;

  for (const [product, quantity] of Object.entries(input.quantityByProduct) as [Product, number][]) {
    if (!Number.isFinite(quantity) || quantity <= 0) continue;
    const required = requiredHeadcountForQuantity(
      quantity,
      params.labor.regularEfficiencyPerHeadTons,
      input.attendanceRate,
      input.skillByProduct[product] ?? 0,
      input.appliedOvertimeRate,
      params
    );
    requiredRegularByProduct[product] = required;
    requiredRegularBeforeTemporary += required;
  }

  // 臨時ワーカー1人は、常用ワーカー（temporaryEfficiency / regularEfficiency）人分の
  // 働きをする。効率の比だけで換算し、独自の係数を持ち込まない。
  const efficiencyRatio =
    params.labor.regularEfficiencyPerHeadTons > 0 ? params.labor.temporaryEfficiencyPerHeadTons / params.labor.regularEfficiencyPerHeadTons : 0;
  const safeTemporary = Number.isFinite(input.temporaryHeadcount) && input.temporaryHeadcount > 0 ? input.temporaryHeadcount : 0;
  const temporaryEquivalentRegularHeadcount = safeTemporary * efficiencyRatio;

  return {
    requiredRegularByProduct,
    requiredRegularBeforeTemporary,
    temporaryEquivalentRegularHeadcount,
    requiredRegularHeadcount: Math.max(0, requiredRegularBeforeTemporary - temporaryEquivalentRegularHeadcount),
  };
}

// ---------------------------------------------------------------------
// 4. 人件費の試算（finance/parameters.ts の単価をそのまま使う）
// ---------------------------------------------------------------------

export interface QuarterlyLaborCostBreakdown {
  readonly regularHeadcount: number;
  readonly temporaryHeadcount: number;
  readonly regularCostUsd: number;
  readonly temporaryCostUsd: number;
  readonly totalCostUsd: number;
}

/**
 * 四半期人件費の試算。単価は finance/parameters.ts の
 * regularWorkerSalaryUsdPerQuarter / temporaryWorkerCostUsdPerQuarter をそのまま使う
 * （画面に別の単価を持ち込まない）。残業費は残業率に依存し、実績確定まで
 * 確定しないため、この試算には含めない（含めていないことを呼び出し側が明示する）。
 */
export function computeQuarterlyLaborCost(
  regularHeadcount: number,
  temporaryHeadcount: number,
  financeParams: FinanceParameters = FINANCE_PARAMETERS_V1
): QuarterlyLaborCostBreakdown {
  const safeRegular = Number.isFinite(regularHeadcount) && regularHeadcount > 0 ? regularHeadcount : 0;
  const safeTemporary = Number.isFinite(temporaryHeadcount) && temporaryHeadcount > 0 ? temporaryHeadcount : 0;
  const regularCostUsd = safeRegular * financeParams.labor.regularWorkerSalaryUsdPerQuarter;
  const temporaryCostUsd = safeTemporary * financeParams.labor.temporaryWorkerCostUsdPerQuarter;
  return {
    regularHeadcount: safeRegular,
    temporaryHeadcount: safeTemporary,
    regularCostUsd,
    temporaryCostUsd,
    totalCostUsd: regularCostUsd + temporaryCostUsd,
  };
}

/** 画面・Excelが共通で使う、Worker増減の説明文。 */
export const WORKFORCE_EXPLANATION_TEXT =
  "Workerの人数は、四半期をまたいで会社の状態として引き継がれます。この画面で入力するのは増減の差分です。" +
  "人数を減らすと、四半期人件費が減る一方で、有効労働能力も下がり、生産計画を処理しきれなくなることがあります。" +
  "逆に人数を増やしても、設備能力を超えて生産量が増えることはありません（設備と労働の小さいほうが上限になります）。";

/** 今回モデル化していないコストの明示（誤解を防ぐ）。 */
export const WORKFORCE_NOT_MODELED_NOTE =
  "現時点のエンジンでは、採用費・解雇費・退職金・解雇人数の制限・採用後の教育期間・習熟度の変化・労使関係は、いずれもモデル化されていません。" +
  "そのため人数は毎四半期自由に増減でき、増減そのものに追加費用は発生しません。";
