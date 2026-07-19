// ShrimpX V2 — ターン状態遷移層 builder（Phase 5.5）
//
// TurnOrchestratorResult（runTurnの1ターン分の出力）から、そのまま次回の
// runTurn呼び出しへ渡せる TurnOrchestratorInput を組み立てる、決定論的な
// 純粋関数のみを提供する。永続化（Redis）・API・UIには一切依存しない。
//
// --- 次ターンへ引き継ぐもの ---
//   - Period: turnResult.pendingState.nextPeriod（既存のPeriodV2 API
//     （core/period.ts の nextPeriod）で既に1つ進められた値をそのまま使う。
//     本ファイルで独自にperiod計算をやり直さない）。
//   - 販売契約: turnResult.pendingState.contracts をそのまま
//     existingContracts へ引き継ぐ（更新済契約・未履行の契約残・overdueを
//     含む、Phase4自身が管理する約定残の状態そのもの。fulfilled/cancelled
//     も含め、ステータスによるフィルタは行わない。Phase4の契約は「ステータス
//     が変わるだけで消えない」設計であり、本層が独自に契約を取捨選択すると
//     Phase4の約定残管理と二重管理になるため、丸ごと引き継ぐ）。
//   - 原料ロット: turnResult.pendingState.lots のうち、
//     status が "available" / "inTransitImport" / "growingAquaculture" の
//     ものだけを existingLots へ引き継ぐ（下記参照）。
//
// --- 次ターンへ引き継がないもの（意図的に空へ初期化する） ---
//   - salesPlans: 販売計画は毎ターン会社が新規に提出するものであり、
//     前ターンの計画をそのまま再送すると「同じ販売計画を無限に繰り返す」
//     ことになってしまう。空配列にリセットする。
//   - domesticPurchaseIntentSource: 国内買付計画も毎ターン提出制のため、
//     plansを引き継がない。ただし「会社別データが一切ない
//     （phase3Fallbackモード）」への切り替えは行わず、
//     { type: "companyPlans", plans: [] } という「今のところ誰も
//     提出していない」状態で初期化する（他のプラン系フィールド
//     （salesPlans・importOrders・aquacultureStockingPlans）が
//     いずれも「空配列＝未提出」で統一されているのと同じ考え方）。
//   - importOrders / aquacultureStockingPlans: 同様に毎ターン提出制のため
//     空配列にリセットする。
//   - debug: 監査用の中間集計値であり、次ターンの入力には一切含めない
//     （TurnOrchestratorInputにdebugというフィールド自体が存在しない）。
//
// --- 呼び出し側（将来のシナリオ/API層）が明示的に上書きする必要があるもの ---
//   - marketInput: 次期の市場入力本体（各国の収穫量・需要成長率等）は、
//     前ターンの結果だけからは決まらない外生値であり、本層は生成しない。
//     ただし、返り値のmarketInput.periodだけは、
//     turnResult.pendingState.nextPeriodへ機械的に合わせておく
//     （currentPeriodとmarketInput.periodが食い違ったままrunTurnへ渡ると、
//     result.periodとresult.marketResult.periodが不整合になるため、
//     プレースホルダとしても最低限そこだけは揃えておく）。
//     呼び出し側は、実際の次期シナリオ由来のmarketInputで上書きしてから
//     runTurnへ渡すこと。
//   - scenarioVariables: 次期の疾病圧力等のシナリオ由来値。本層では
//     undefinedにリセットする（runTurn側の既定値＝疾病なしにフォール
//     バックする）。呼び出し側が必要なら明示的に指定すること。
//   - seed / parameters: ゲーム全体を通じて変えない想定の値のため、
//     previousInputの値をそのまま踏襲する（seedはcurrentPeriodと
//     組み合わせてrandomStreamへ渡されるため、同じseed文字列を
//     ターンを通じて使い回しても、ターンごとに異なる乱数列になる。
//     parametersも、ターンの途中で係数を変える理由がない限りそのまま
//     引き継ぐのが自然な既定動作）。

import { RawMaterialLot, RawMaterialLotStatus } from "../rawMaterials/types";
import { TurnOrchestratorInput, TurnOrchestratorResult, TurnStateValidationError } from "./types";

const CARRYABLE_LOT_STATUSES: ReadonlySet<RawMaterialLotStatus> = new Set(["available", "inTransitImport", "growingAquaculture"]);

/**
 * 次ターンへ引き継ぐ原料ロットだけを残す（不変フィルタ、元配列・要素は変更しない）。
 * "consumed"（消費済み）・"expired"（期限切れ）のロットは、Phase5のrunner自身は
 * 履歴として保持し続けるが、次ターンの「生きている在庫」としては引き継がない
 * （復活させない。既に消費・廃棄されたロットが再びavailableとして扱われることは
 * あってはならない）。
 */
function filterCarryableLots(lots: readonly RawMaterialLot[]): readonly RawMaterialLot[] {
  return lots.filter((lot) => CARRYABLE_LOT_STATUSES.has(lot.status));
}

/**
 * runTurnの1ターン分の結果（turnResult）から、そのまま次回のrunTurn呼び出しへ
 * 渡せるTurnOrchestratorInputを組み立てる。previousInput・turnResultのいずれも
 * 変更しない（不変更新のみ）。
 *
 * 前提: turnResult は previousInput を runTurn へ渡して得られた結果であること
 * （turnResult.period !== previousInput.currentPeriod の場合は、組み合わせの
 * 誤りとして例外を投げる）。
 */
export function buildNextTurnInput(
  previousInput: TurnOrchestratorInput,
  turnResult: TurnOrchestratorResult
): TurnOrchestratorInput {
  if (turnResult.period !== previousInput.currentPeriod) {
    throw new TurnStateValidationError(
      `buildNextTurnInput: turnResult.period ("${turnResult.period}") が previousInput.currentPeriod ("${previousInput.currentPeriod}") と一致しません。previousInputをrunTurnへ渡して得られたturnResultを渡してください。`
    );
  }

  return {
    currentPeriod: turnResult.pendingState.nextPeriod,
    marketInput: { ...previousInput.marketInput, period: turnResult.pendingState.nextPeriod },
    scenarioVariables: undefined,
    salesPlans: [],
    domesticPurchaseIntentSource: { type: "companyPlans", plans: [] },
    importOrders: [],
    aquacultureStockingPlans: [],
    existingContracts: turnResult.pendingState.contracts,
    existingLots: filterCarryableLots(turnResult.pendingState.lots),
    seed: previousInput.seed,
    parameters: previousInput.parameters,
  };
}
