// ShrimpX V2 — 会社ラボ専用永続化モデル ランタイムスナップショット生成（Phase 8C-1）
//
// CompanyLabState → CompanyLabRuntimeSnapshot への唯一の変換経路。
// 【最重要】保存対象フィールドを明示的に1つずつ組み立てる（Omit型やスプレッドで
// 済ませない）。CompanyLabState.history、およびCompanyLabState.productionState内部の
// history（ProductionQuarterRecord[]）の両方を、意図的に・確実に除去する
// （types.ts冒頭コメント・CompanyLabProductionRuntimeSnapshotのコメント参照）。

import { CompanyLabState } from "../types";
import { deriveWorkforceStateFromDecisions, isWorkforceStateEmpty, WorkforceState } from "../workforce";
import { CompanyLabRuntimeSnapshot } from "./types";
import { hosoEqTons } from "../../core/units";
import { DEMAND_MARKET_IDS, DemandMarketId, DemandMarketInput } from "../../market/types";
import { buildInitialConsumerMarketCarryStateTable, ConsumerMarketCarryStateTable, isConsumerMarketStateEmpty } from "../../market/consumerInventory";

/**
 * CompanyLabStateから、再開に必要な現在状態だけを持つCompanyLabRuntimeSnapshotを
 * 生成する（純粋関数、入力を変更しない）。
 *
 * `history`（最上位）は返り値のオブジェクトリテラルに一切書かないため、
 * 呼び出し側が誤ってstate全体をスプレッドしない限り、実行時オブジェクトにも
 * "history"というキー自体が存在しない。productionStateも同様に、
 * currentPeriod・finishedGoodsLotsだけを明示的に取り出した新しいオブジェクトを
 * 組み立てており、state.productionStateをそのまま参照渡ししない
 * （state.productionState.historyへの参照が透過的に残ることを防ぐため）。
 */
export function createCompanyLabRuntimeSnapshot(state: CompanyLabState): CompanyLabRuntimeSnapshot {
  return {
    currentPeriod: state.currentPeriod,
    scenarioState: state.scenarioState,
    contracts: state.contracts,
    rawMaterialLots: state.rawMaterialLots,
    productionState: {
      currentPeriod: state.productionState.currentPeriod,
      finishedGoodsLots: state.productionState.finishedGoodsLots,
    },
    lastQuarterActualProduction: state.lastQuarterActualProduction,
    qualityState: state.qualityState,
    financeState: state.financeState,
    financingState: state.financingState,
    capexState: state.capexState,
    // 【Phase 8D-4】Worker総人数（ターンをまたいで保持する会社状態）。
    workforceState: state.workforceState,
    // 【Phase 8F-1】市場別・消費国在庫・購買循環モデルのcarry state。
    consumerMarketState: state.consumerMarketState,
    // 【SAI-5D/5E】営業基盤ストック・市場進化carry state（SAI-5機能フラグ有効時
    // のみ存在するoptional。undefinedのときはキー自体を含めない＝既存スナップ
    // ショットと同一形状）。
    ...(state.salesBaseState ? { salesBaseState: state.salesBaseState } : {}),
    ...(state.marketEvolutionState ? { marketEvolutionState: state.marketEvolutionState } : {}),
    // 【営業人員の追加採用・forward-port】会社別・営業人員総数。
    salesForceHiringState: state.salesForceHiringState,
    // 【Test15】Factory単位PD稼働率・会社単位VAP商品開発スコア。undefinedのときは
    // キー自体を含めない（既存スナップショットと同一形状。salesBaseStateと同じ方式）。
    ...(state.pdMechanizationState ? { pdMechanizationState: state.pdMechanizationState } : {}),
    ...(state.productDevelopmentState ? { productDevelopmentState: state.productDevelopmentState } : {}),
    isComplete: state.isComplete,
  };
}

/**
 * CompanyLabRuntimeSnapshotに、指定したCompanyLabConfigと確定履歴配列を組み合わせて、
 * advanceCompanyLabQuarterへそのまま渡せる完全なCompanyLabStateへ復元する。
 *
 * `history`引数は呼び出し側が別途（会社ラボ専用Redisキーの四半期別履歴等から）
 * 用意したものを渡す想定。本関数自体はhistoryの中身を検証・再構成しない
 * （それは呼び出し側・schema.ts側の責務）。省略時は空配列＝「これから最初の
 * 四半期を処理する（またはhistoryを別途読み込まない）」状態として扱う。
 *
 * productionState.historyは常に空配列で復元する（snapshot.ts冒頭コメントの
 * 根拠により、production側のゲームロジックはこの内部historyの過去要素を
 * 一切参照しないため、空配列での復元は計算結果に影響しない）。
 */
export function restoreCompanyLabStateFromRuntimeSnapshot(
  config: CompanyLabState["config"],
  snapshot: CompanyLabRuntimeSnapshot,
  history: CompanyLabState["history"] = []
): CompanyLabState {
  return {
    config,
    currentPeriod: snapshot.currentPeriod,
    scenarioState: snapshot.scenarioState,
    contracts: snapshot.contracts,
    rawMaterialLots: snapshot.rawMaterialLots,
    productionState: {
      currentPeriod: snapshot.productionState.currentPeriod,
      finishedGoodsLots: snapshot.productionState.finishedGoodsLots,
      history: [],
    },
    lastQuarterActualProduction: snapshot.lastQuarterActualProduction,
    qualityState: snapshot.qualityState,
    financeState: snapshot.financeState,
    financingState: snapshot.financingState,
    capexState: snapshot.capexState,
    // 【Phase 8D-4 後方互換】Phase 8D以前に保存されたスナップショットには
    // workforceState が存在しない（schema側で空として復元される）。その場合は、
    // 確定履歴に保存済みの意思決定（decisions[].workerAssignments）から
    // 「実際にその四半期を動かした人数」をそのまま復元する。推測値は作らない。
    // 履歴も無ければ空のままとし、会社単位のフォールバック
    // （runner.ts buildCompanyOwnState）が fixture の基準人数を使う。
    workforceState: isWorkforceStateEmpty(snapshot.workforceState)
      ? restoreWorkforceStateFromHistory(history)
      : snapshot.workforceState,
    // 【Phase 8F-1 後方互換】Phase 8F-1以前に保存されたスナップショットには
    // consumerMarketState が存在しない（schema側で全市場ゼロ値として復元される。
    // isConsumerMarketStateEmptyがtrueと判定する）。その場合は、確定履歴の
    // 直近四半期のmarketInput.demandMarketsから決定論的に再構築する
    // （推測値は作らない。workforceStateと同じ方式）。
    consumerMarketState: isConsumerMarketStateEmpty(snapshot.consumerMarketState)
      ? restoreConsumerMarketStateFromHistory(history)
      : snapshot.consumerMarketState,
    // 【SAI-5D 後方互換】schemaVersion:1〜3のスナップショットにはsalesBaseState
    // キーが存在しない → undefined（機能無効）として復元する。履歴からの再構築は
    // しない（機能フラグ無効のラボでは状態が存在しないことが正しい状態のため）。
    ...(snapshot.salesBaseState ? { salesBaseState: snapshot.salesBaseState } : {}),
    // 【SAI-5E 後方互換】salesBaseStateと同じ方式（キー欠落=機能無効）。
    ...(snapshot.marketEvolutionState ? { marketEvolutionState: snapshot.marketEvolutionState } : {}),
    // 【営業人員の追加採用・forward-port 後方互換】この機能導入前に保存された
    // スナップショットには salesForceHiringState が存在しない（schema側で空
    // として復元される）。この機能自体が今回新設されたものであり、それ以前の
    // どの四半期にも「採用」という意思決定は存在し得なかったため、
    // workforceStateのように履歴から積算し直す必要はない（積算しても結果は0の
    // まま＝会社単位のフォールバックと完全に一致する）。空のままとし、会社単位
    // のフォールバック（runner.ts buildCompanyOwnState・advanceCompanyLabQuarter）
    // が fixture.salesForceHeadcountTotal を使う。
    salesForceHiringState: snapshot.salesForceHiringState,
    // 【Test15 後方互換】schemaVersion:1〜6のスナップショットにはpdMechanizationState・
    // productDevelopmentStateキーが存在しない → undefinedとして復元する。
    // 履歴からの再構築・推測値の捏造は行わない（呼び出し側が既定の初期値
    // （initialPdUtilizationRatio(0.0)・中立値50）を使う設計のため、それで十分）。
    ...(snapshot.pdMechanizationState ? { pdMechanizationState: snapshot.pdMechanizationState } : {}),
    ...(snapshot.productDevelopmentState ? { productDevelopmentState: snapshot.productDevelopmentState } : {}),
    history,
    isComplete: snapshot.isComplete,
  };
}

/** 確定履歴の最後のエントリの意思決定からWorker総人数を復元する（無ければ空）。 */
function restoreWorkforceStateFromHistory(history: CompanyLabState["history"]): WorkforceState {
  const last = history[history.length - 1];
  if (!last) return { companies: [] };
  return deriveWorkforceStateFromDecisions(last.decisions);
}

/**
 * 確定履歴の最後のエントリのmarketInput.demandMarketsから、市場別・消費国在庫
 * carry stateを決定論的に再構築する（実装指示§13「初期化は決定論的に、直近の
 * 消費実績と市場別目標在庫月数から行う」）。確定履歴が一件も無い場合
 * （Phase 8F-1より前に初期化され、まだ一四半期も処理されていないラボ）は、
 * 既知の消費実績が無いため、前期消費量ゼロからの決定論的な初期化にフォールバック
 * する（次の四半期の計画で実需要へ追従するため、影響は初回のみ）。
 */
function restoreConsumerMarketStateFromHistory(history: CompanyLabState["history"]): ConsumerMarketCarryStateTable {
  const last = history[history.length - 1];
  if (last) {
    return buildInitialConsumerMarketCarryStateTable(last.marketInput.demandMarkets);
  }
  const zeroDemand: DemandMarketInput = { priorPeriodConsumption: hosoEqTons(0), economicIndex: 1, populationGrowthRate: 0 };
  const zeroDemandMarkets = Object.fromEntries(DEMAND_MARKET_IDS.map((m) => [m, zeroDemand])) as Record<DemandMarketId, DemandMarketInput>;
  return buildInitialConsumerMarketCarryStateTable(zeroDemandMarkets);
}

/**
 * スナップショットのトップレベル、およびproductionStateサブオブジェクト直下に
 * "history"というキーが一切混入していないことを検証する純粋関数（テスト・診断用）。
 *
 * 【注意】本関数はスナップショット全体を無差別に再帰走査して"history"という
 * キー名を探すものではない。理由: financingState.companies[].history
 * （CompanyFinancingHistory＝延滞回数等の小さな集計カウンタオブジェクト。
 * 配列ではない）は、本Phaseが問題視している「四半期ごとに増え続ける重複ログ」
 * とは全く別種の、正当かつ必要な既存フィールドである。無差別な文字列一致・
 * キー名一致による検出は、この正当なフィールドを誤検出してしまう。
 * そのため、本Phaseで実際に除去を保証すべき2箇所（CompanyLabRuntimeSnapshot
 * トップレベルの"history"、およびproductionStateサブオブジェクト直下の
 * "history"）だけを名指しで検証する、意図の明確なチェックとする。
 */
export function snapshotHasForbiddenHistoryKeys(snapshot: unknown): boolean {
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return false;
  }
  const obj = snapshot as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(obj, "history")) {
    return true;
  }
  const productionState = obj.productionState;
  if (productionState !== null && typeof productionState === "object" && !Array.isArray(productionState)) {
    if (Object.prototype.hasOwnProperty.call(productionState as Record<string, unknown>, "history")) {
      return true;
    }
  }
  return false;
}
