// ShrimpX V2 — ターン状態遷移層 共通型（Phase 5.5）
//
// app/lib/v2/turn/（ターン・オーケストレーター）と、将来の永続化層（Redis保存・
// V2 API・GameSessionV2・Replay・Save/Load）の間に入る、決定論的な純粋関数の境界。
// 「TurnOrchestratorResult（1ターン分の結果）から、次にrunTurnへ渡せる
// TurnOrchestratorInputを組み立てる」責務だけを持つ。Redis・API・UIには一切依存
// しない（app/lib/v2/turn/types.ts 冒頭コメントと同じ設計方針を踏襲する）。
//
// 【重要】本モジュールは「次ターンの市場入力（marketInput）・シナリオ変数・
// 会社別の各種計画・乱数シード」を新規に作り出す責務は持たない。これらは
// 将来のシナリオ/Phase2/3エンジン・プレイヤー入力・API層が、ターンごとに
// 新しく決定するものであり、直前ターンの結果だけから機械的に導出できる情報
// ではない（例: 次期の収穫量・需要成長は前期の契約・在庫からは決まらない）。
// buildNextTurnInputが機械的に確定できるのは、あくまで
//   - Period（1つ進める）
//   - 販売契約の引き継ぎ（約定残・overdueを含む、Phase4自身の状態）
//   - 原料在庫の引き継ぎ（available/inTransitImport/growingAquacultureのみ）
// の3点のみであり、それ以外（marketInput本体・salesPlans・
// domesticPurchaseIntentSource・importOrders・aquacultureStockingPlans・
// scenarioVariables・seed・parameters）は「今回提出されていない＝空」を表す
// 最小限のプレースホルダに初期化するか、previousInputの値をそのまま踏襲する
// （後述のbuilder.tsのコメント参照）。呼び出し側は、返された値のうち
// marketInput・salesPlans等を実際の次ターンのデータで上書きしてから
// runTurnへ渡すことを想定している。

import { TurnOrchestratorInput, TurnOrchestratorResult } from "../turn/types";

export class TurnStateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TurnStateValidationError";
  }
}

export type { TurnOrchestratorInput, TurnOrchestratorResult };
