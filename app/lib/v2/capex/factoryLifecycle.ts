// ShrimpX V2 — ENG-FAC-1: Factory Mothball / Sale ライフサイクル
//
// 【導入目的（実装指示§21）】生産0・Worker0でも稼働工場固定費が永久に残り、
// 事業再建が構造的に不可能になる問題を、全会社共通のEngine capabilityとして解消する。
// 特定会社・特定Scenarioの救済処理ではない。本モジュールにcompanyIdやScenarioに
// よる分岐は一切存在しない（存在させてはならない）。
//
// 【責務の境界（実装指示§16・§19）】本モジュールが担うのは
//   - Decisionのvalidity（§17）
//   - timing（T→T+1→T+2、§4.2/§5/§7）
//   - lifecycle transition
// の3つだけである。「いつ売るべきか」はStandard AI（SAI-FAC-1）の責任であり、
// 会計上の効果（固定費・減価償却・PPE除却・disposal gain/loss）はfinance/側が
// 本モジュールの導出結果を読んで計上する。
//
// 【Capital Project lifecycleと混ぜない（実装指示§2）】UNDER_CONSTRUCTIONは
// 本stateに含めない。建設中は引き続きCapitalProject.statusの責任範囲であり、
// 完成してFactory[]へ現れて初めて本lifecycleの対象になる。
//
// 【なぜ「決定ログ＋導出」なのか】既存のFactory[]は永続化されておらず、
// computeEffectiveFactories(fixture.factories, capexState, period) として毎期
// 再導出される（capex/factoryConstruction.ts）。したがって工場側に可変stateを
// 置くと「唯一の計算箇所」原則が壊れる。そこで本モジュールは**決定そのもの**
// （いつ・どの工場に・何を決めたか）だけを追記専用で保持し、任意periodの
// lifecycle stateは常にそこから純粋関数で導出する。これにより
//   - T→T+1→T+2のtimingが導出式そのものとして表現される（別途の遷移処理が不要）
//   - Save/Resumeで途中stateを取りこぼす余地が構造的に無い
//   - audit event（§18）を同じログから機械的に再構成できる
// という3つが同時に満たされる。保存量は1工場あたり最大でも数十件のスカラーで
// あり、四半期ごとに際限なく増える種類のデータではない。

import { PeriodV2, nextPeriod, toYearQuarter } from "../core/period";
import { CompanyId } from "../sales/types";

export class FactoryLifecycleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FactoryLifecycleValidationError";
  }
}

// ---------------------------------------------------------------------
// 1. Lifecycle state
// ---------------------------------------------------------------------

/**
 * 完成済みFactoryのライフサイクル状態（実装指示§2）。
 *
 * 既存の production/types.ts FactoryStatus（active/idle/suspended）は
 * **生産側の実効状態**としてそのまま維持し、本stateとは別物として扱う。
 * 本stateがFactoryStatusへどう写像されるかは
 * applyFactoryLifecycleToFactories（capex/factoryConstruction.ts経由）が唯一決める。
 */
export type FactoryLifecycleState = "OPERATING" | "MOTHBALLED" | "SALE_PENDING" | "SOLD";

/** 会社が保有しているとみなす状態（＝最低1工場ルール§6.1のカウント対象）。 */
export function isOwnedFactoryLifecycleState(state: FactoryLifecycleState): boolean {
  return state !== "SOLD";
}

/** 生産能力を持ちうる状態（OPERATINGのみ）。 */
export function isProducingFactoryLifecycleState(state: FactoryLifecycleState): boolean {
  return state === "OPERATING";
}

/**
 * 工場スロット（MAX_FACTORIES_PER_COMPANY）を占有する状態（実装指示§13）。
 * SALE_PENDINGは売却完了まで占有し続け、SOLDになった時点で解放される。
 */
export function occupiesFactorySlot(state: FactoryLifecycleState): boolean {
  return state !== "SOLD";
}

// ---------------------------------------------------------------------
// 2. 決定（Engine汎用Decision interface・実装指示§16）
// ---------------------------------------------------------------------

export type FactoryLifecycleDecisionType = "MOTHBALL_FACTORY" | "REACTIVATE_FACTORY" | "SELL_FACTORY";

/** 1件の意思決定入力（当四半期に会社が出す希望）。 */
export interface FactoryLifecycleDecisionInput {
  readonly type: FactoryLifecycleDecisionType;
  readonly factoryId: string;
}

/**
 * 受理された決定の記録（追記専用）。decidedPeriodは決定した四半期Tそのもの。
 * 実際に効き始めるのはT+1（mothball/reactivate/sale operation stop）であり、
 * 売却完了はT+2である（§4.2・§5・§7）。この「決定期からの相対timing」は
 * resolveFactoryLifecycleStateAtが唯一の解釈者である。
 */
export interface FactoryLifecycleDecisionRecord {
  readonly factoryId: string;
  readonly type: FactoryLifecycleDecisionType;
  readonly decidedPeriod: PeriodV2;
}

/** 1社ぶんのlifecycle決定ログ（ターンをまたいで保持・追記専用）。 */
export interface CompanyFactoryLifecycleState {
  readonly companyId: CompanyId;
  readonly decisions: readonly FactoryLifecycleDecisionRecord[];
}

export interface FactoryLifecycleStateTable {
  readonly companies: readonly CompanyFactoryLifecycleState[];
}

export const EMPTY_FACTORY_LIFECYCLE_STATE: FactoryLifecycleStateTable = { companies: [] };

/** 決定ログが1件も無い（＝この機能を一度も使っていない）か。 */
export function isFactoryLifecycleStateEmpty(state: FactoryLifecycleStateTable | undefined): boolean {
  if (!state) return true;
  return state.companies.every((c) => c.decisions.length === 0);
}

export function findCompanyFactoryLifecycleState(
  state: FactoryLifecycleStateTable | undefined,
  companyId: CompanyId
): CompanyFactoryLifecycleState | undefined {
  return state?.companies.find((c) => c.companyId === companyId);
}

// ---------------------------------------------------------------------
// 3. パラメータ（実装指示§4.4・§5・§8・§9。直書き禁止）
// ---------------------------------------------------------------------

export interface FactoryLifecycleParameters {
  /**
   * MOTHBALLED工場のcarrying cost率（§4.4）。通常cash factory fixed cost
   * （工場固定費＋固定ユーティリティ）に対する比率。保守・警備・保険・
   * 最低限utility・資産保全に相当する。
   */
  readonly mothballCarryingCostRatio: number;
  /** SALE_PENDING工場のholding cost率（§8・§10）。 */
  readonly salePendingHoldingCostRatio: number;
  /** 売却回収率（§9）。Sale Proceeds = Net Book Value × この値。全会社共通。 */
  readonly saleProceedsRecoveryRate: number;
  /** 再稼働コスト（§5）。1工場あたり、再稼働を決定した四半期に現金支出する。 */
  readonly reactivationCostUsd: number;
}

/**
 * 【暫定値・テストプレイ校正対象（仕様書§23）】数値はすべてここに集約し、
 * ロジック内へ直書きしない。Scenario固有値にはしない（全会社共通Engine parameter）。
 */
export const FACTORY_LIFECYCLE_PARAMETERS_V1: FactoryLifecycleParameters = {
  mothballCarryingCostRatio: 0.25,
  salePendingHoldingCostRatio: 0.1,
  saleProceedsRecoveryRate: 0.7,
  reactivationCostUsd: 500_000,
};

// ---------------------------------------------------------------------
// 4. 期間演算（capacityEffect.ts・depreciation.ts等と同じローカル実装パターン）
// ---------------------------------------------------------------------

function quartersBetween(from: PeriodV2, to: PeriodV2): number {
  const a = toYearQuarter(from);
  const b = toYearQuarter(to);
  return b.year * 4 + b.quarter - (a.year * 4 + a.quarter);
}

// ---------------------------------------------------------------------
// 5. State導出（唯一の解釈者）
// ---------------------------------------------------------------------

/**
 * ある四半期時点のlifecycle stateを、決定ログだけから導出する（純粋関数）。
 *
 * timing規約（実装指示§4.2・§5・§7）:
 *   MOTHBALL_FACTORY   決定期T: 通常操業 / T+1以降: MOTHBALLED
 *   REACTIVATE_FACTORY 決定期T: MOTHBALLEDのまま / T+1以降: OPERATING
 *   SELL_FACTORY       決定期T: 通常操業 / T+1: SALE_PENDING / T+2以降: SOLD
 *
 * 決定は decidedPeriod の昇順に適用する。同一四半期に同一工場へ複数の決定を
 * 出すことは受理側（validateFactoryLifecycleDecision）が拒否するため、
 * ここでの順序は決定論的である。
 */
export function resolveFactoryLifecycleStateAt(
  decisions: readonly FactoryLifecycleDecisionRecord[],
  factoryId: string,
  period: PeriodV2
): FactoryLifecycleState {
  const relevant = decisions
    .filter((d) => d.factoryId === factoryId)
    .slice()
    .sort((a, b) => quartersBetween(b.decidedPeriod, a.decidedPeriod));

  let state: FactoryLifecycleState = "OPERATING";
  for (const decision of relevant) {
    const elapsed = quartersBetween(decision.decidedPeriod, period);
    if (elapsed < 1) continue; // 決定した四半期そのものは、まだ従前の状態のまま。
    if (decision.type === "MOTHBALL_FACTORY") {
      state = "MOTHBALLED";
    } else if (decision.type === "REACTIVATE_FACTORY") {
      state = "OPERATING";
    } else {
      // SELL_FACTORY: T+1でSALE_PENDING、T+2以降はSOLD（終端状態）。
      state = elapsed >= 2 ? "SOLD" : "SALE_PENDING";
    }
  }
  return state;
}

/**
 * その四半期に「売却が完了した（SALE_PENDING→SOLDへ移った）」工場かどうか。
 * PPE除却・sale proceeds入金・disposal gain/lossは、この四半期に**一度だけ**
 * 認識される（§7 T+2・§12）。
 */
export function isFactorySaleCompletedIn(
  decisions: readonly FactoryLifecycleDecisionRecord[],
  factoryId: string,
  period: PeriodV2
): boolean {
  const sale = decisions.find((d) => d.factoryId === factoryId && d.type === "SELL_FACTORY");
  if (!sale) return false;
  return quartersBetween(sale.decidedPeriod, period) === 2;
}

/** その四半期に再稼働コストを支出する（＝再稼働を決定した四半期）か。 */
export function isFactoryReactivationDecidedIn(
  decisions: readonly FactoryLifecycleDecisionRecord[],
  factoryId: string,
  period: PeriodV2
): boolean {
  return decisions.some((d) => d.factoryId === factoryId && d.type === "REACTIVATE_FACTORY" && d.decidedPeriod === period);
}

/** この会社が決定ログ上で言及した全factoryId（重複なし・決定順）。 */
export function listFactoryIdsWithLifecycleDecisions(decisions: readonly FactoryLifecycleDecisionRecord[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const d of decisions) {
    if (seen.has(d.factoryId)) continue;
    seen.add(d.factoryId);
    result.push(d.factoryId);
  }
  return result;
}

// ---------------------------------------------------------------------
// 6. Validation（実装指示§17）
// ---------------------------------------------------------------------

export interface FactoryLifecycleValidationContext {
  /**
   * この会社が当四半期に保有している完成済みFactoryのID一覧
   * （＝computeEffectiveFactoriesがlifecycle適用**前**に返すFactory[]のうち、
   * この会社のもの。SOLD判定は本モジュールが決定ログから行うため、ここには
   * 売却済み工場も含まれていてよい）。
   */
  readonly ownedFactoryIds: readonly string[];
  /** 当四半期の決定ログ（当四半期に既に受理した決定を含む）。 */
  readonly decisions: readonly FactoryLifecycleDecisionRecord[];
  /** 判定基準となる四半期（＝決定を出す四半期T）。 */
  readonly period: PeriodV2;
  /**
   * この工場を対象とする、未完了のCapital Project（approved/underConstruction/
   * suspended）のprojectId一覧。§17「no incompatible active project」の判定に使う。
   * 空配列を渡した場合はこの条件を課さない。
   */
  readonly activeProjectFactoryIds?: readonly string[];
}

/**
 * 1件のlifecycle決定を検証する。構造的な誤用（存在しない工場ID・状態不整合）は
 * FactoryLifecycleValidationErrorを投げる（capex/のCapexValidationError、
 * financing/のFinancingValidationErrorと同じ区分）。
 *
 * 【最低1工場ルール（§6.1）】Factory #1を固定で保護しない。判定は常に
 * 「売却後の保有工場数 >= 1」だけである。したがって古いFactory #1を売って
 * 新しいFactory #2を残すことができる。Mothballは最後の1工場にも許可する
 * （会社は一時的にProduction Capacity=0にはできるが、工場資産を完全に
 * 失うことはできない）。
 */
export function validateFactoryLifecycleDecision(decision: FactoryLifecycleDecisionInput, context: FactoryLifecycleValidationContext): void {
  const { factoryId, type } = decision;

  if (!context.ownedFactoryIds.includes(factoryId)) {
    throw new FactoryLifecycleValidationError(`工場"${factoryId}"は存在しない、またはこの会社の工場ではありません。`);
  }

  // 同一四半期に同一工場へ2件目の決定を出すことは、順序が意味を持ってしまい
  // 決定論性を損なうため常に拒否する（timing規約はすべて「決定期Tから何期後か」
  // で表現されており、同一Tに複数の決定があるとその式が破綻する）。
  if (context.decisions.some((d) => d.factoryId === factoryId && d.decidedPeriod === context.period)) {
    throw new FactoryLifecycleValidationError(`工場"${factoryId}"には当四半期(${context.period})に既にlifecycle決定が出されています。`);
  }

  // 【判定時点】決定は次四半期から効くため、判定に使う現在stateは「決定を出す
  // 四半期Tにおけるstate」である。
  const currentState = resolveFactoryLifecycleStateAt(context.decisions, factoryId, context.period);

  if (currentState === "SOLD") {
    throw new FactoryLifecycleValidationError(`工場"${factoryId}"は売却済みのため、これ以上のlifecycle決定はできません。`);
  }
  if (currentState === "SALE_PENDING") {
    throw new FactoryLifecycleValidationError(`工場"${factoryId}"は売却手続中のため、lifecycle決定を変更できません。`);
  }

  if (type === "MOTHBALL_FACTORY") {
    if (currentState !== "OPERATING") {
      throw new FactoryLifecycleValidationError(`工場"${factoryId}"は稼働中(OPERATING)ではないため（現在: ${currentState}）、一時休止できません。`);
    }
    return;
  }

  if (type === "REACTIVATE_FACTORY") {
    if (currentState !== "MOTHBALLED") {
      throw new FactoryLifecycleValidationError(`工場"${factoryId}"は休止中(MOTHBALLED)ではないため（現在: ${currentState}）、再稼働できません。`);
    }
    return;
  }

  // --- SELL_FACTORY ---
  // 【最低1工場ルール】売却後に残る保有工場数を数える。OPERATINGでもMOTHBALLEDでも
  // 「保有している」ことに変わりはない（isOwnedFactoryLifecycleState）。
  //
  // 【当四半期に売却を決定済みの工場を「残る」と数えないこと】売却はT+2まで
  // 完了しないため、決定した四半期Tの時点ではまだ状態がOPERATINGである。
  // そのstateだけで数えると、同一四半期に2工場へ売却を出したときに2件目も
  // 通ってしまい、保有工場0の会社が生まれる。したがって「売却の意思決定が
  // 既に存在する工場」は、完了前であっても残存としては数えない。
  const ownedAfterSale = context.ownedFactoryIds.filter((id) => {
    if (id === factoryId) return false; // 売却対象は残らない
    if (context.decisions.some((d) => d.factoryId === id && d.type === "SELL_FACTORY")) return false; // 売却手続中・売却済み
    return isOwnedFactoryLifecycleState(resolveFactoryLifecycleStateAt(context.decisions, id, context.period));
  }).length;
  if (ownedAfterSale < 1) {
    throw new FactoryLifecycleValidationError(`工場"${factoryId}"を売却すると保有工場が0になります。会社は最低1工場を保有する必要があります。`);
  }

  if (context.activeProjectFactoryIds && context.activeProjectFactoryIds.includes(factoryId)) {
    throw new FactoryLifecycleValidationError(`工場"${factoryId}"には未完了の設備投資案件があるため売却できません。`);
  }
}

/**
 * 当四半期の決定入力群を検証して決定ログへ追記する。1件でも構造的に不正なら
 * 例外を投げる（部分適用しない）。同一四半期の複数決定は入力順に評価するため、
 * 「2工場のうち1つ目の売却は成功し、2つ目の売却は最低1工場ルールで拒否される」
 * が正しく成立する。
 */
export function applyFactoryLifecycleDecisions(
  prev: CompanyFactoryLifecycleState,
  inputs: readonly FactoryLifecycleDecisionInput[],
  context: Omit<FactoryLifecycleValidationContext, "decisions">
): CompanyFactoryLifecycleState {
  if (inputs.length === 0) return prev;
  let decisions: FactoryLifecycleDecisionRecord[] = [...prev.decisions];
  for (const input of inputs) {
    validateFactoryLifecycleDecision(input, { ...context, decisions });
    decisions = [...decisions, { factoryId: input.factoryId, type: input.type, decidedPeriod: context.period }];
  }
  return { companyId: prev.companyId, decisions };
}

/** 会社別stateテーブルへ1社ぶんの更新を反映する（他社は不変）。 */
export function upsertCompanyFactoryLifecycleState(
  table: FactoryLifecycleStateTable,
  next: CompanyFactoryLifecycleState
): FactoryLifecycleStateTable {
  const index = table.companies.findIndex((c) => c.companyId === next.companyId);
  if (index < 0) return { companies: [...table.companies, next] };
  const companies = table.companies.slice();
  companies[index] = next;
  return { companies };
}

// ---------------------------------------------------------------------
// 7. 売却完了四半期の判定ヘルパー（会計側が使う）
// ---------------------------------------------------------------------

/** この四半期に売却が完了する工場のID一覧（§7 T+2）。 */
export function listFactoriesCompletingSaleIn(
  decisions: readonly FactoryLifecycleDecisionRecord[],
  period: PeriodV2
): readonly string[] {
  return decisions.filter((d) => d.type === "SELL_FACTORY" && quartersBetween(d.decidedPeriod, period) === 2).map((d) => d.factoryId);
}

/** 決定Tに対して実際に効き始める四半期（T+1）。audit event記録用。 */
export function effectivePeriodFor(decidedPeriod: PeriodV2): PeriodV2 {
  return nextPeriod(decidedPeriod);
}
