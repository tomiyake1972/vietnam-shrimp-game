// ShrimpX V2 — 会社ラボ専用永続化モデル ランタイムスナップショット生成（Phase 8C-1）
//
// CompanyLabState → CompanyLabRuntimeSnapshot への唯一の変換経路。
// 【最重要】保存対象フィールドを明示的に1つずつ組み立てる（Omit型やスプレッドで
// 済ませない）。CompanyLabState.history、およびCompanyLabState.productionState内部の
// history（ProductionQuarterRecord[]）の両方を、意図的に・確実に除去する
// （types.ts冒頭コメント・CompanyLabProductionRuntimeSnapshotのコメント参照）。

import { CompanyLabState } from "../types";
import { CompanyLabRuntimeSnapshot } from "./types";

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
    history,
    isComplete: snapshot.isComplete,
  };
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
