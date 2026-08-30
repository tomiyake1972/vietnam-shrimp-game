// ShrimpX V2 — Company Lab プレイヤー画面 ラボ作成フォームのターン数モデル
//
// 【ターン数整合性修正】ターン数の初期値・入力上限の「唯一の正」は、選択中シナリオの
// durationTurns（シナリオ定義そのもの）である。この方針を守るため：
//   - 32・40等の数値をUIコード（page.tsx / NewLabForm.tsx）へ一切ハードコードしない。
//   - シナリオ選択肢（scenarioId・タイトル・durationTurns）はALL_SCENARIO_DEFINITIONSから
//     ここで一度だけ組み立て、Client Component（NewLabForm）へはシリアライズ可能な
//     プレーンなpropsとして渡す。
//   - シナリオ変更時のターン数追随（新しく選択したシナリオのdurationTurnsへ更新）も、
//     この純粋関数（turnBoundsForScenario）を通して行う。将来10年間＝40四半期の
//     シナリオがALL_SCENARIO_DEFINITIONSへ追加されれば、UI側の変更なしで初期値・上限が
//     40へ追随する。
//
// サーバー側の強制はこのモデルには依存しない（validation.tsのdurationTurns検証と
// initializeCompanyLabの検証が独立に働く。クライアント表示だけに依存しない多層防御）。

import { ALL_SCENARIO_DEFINITIONS } from "../../../../lib/v2/scenario";
import { SalesModelId } from "../../../../lib/v2/sales/salesModels";
import { DEFAULT_SALES_MODEL_ID } from "./salesModelDisplay";

/** Client Componentへ渡す、シリアライズ可能なシナリオ選択肢。 */
export interface NewLabScenarioOption {
  readonly scenarioId: string;
  readonly title: string;
  readonly durationTurns: number;
}

/** ラボ作成フォームのシナリオ選択肢一覧（既存のALL_SCENARIO_DEFINITIONSが唯一のデータ源）。 */
export function listScenarioOptionsForNewLab(): readonly NewLabScenarioOption[] {
  return ALL_SCENARIO_DEFINITIONS.map((s) => ({
    scenarioId: s.scenarioId,
    title: s.title,
    durationTurns: s.durationTurns,
  }));
}

export interface NewLabTurnBounds {
  /** ターン数入力の初期値（＝選択中シナリオのdurationTurns）。 */
  readonly defaultTurns: number;
  /** ターン数入力の上限（＝選択中シナリオのdurationTurns）。 */
  readonly maxTurns: number;
}

/**
 * 選択中シナリオのターン数初期値・上限を返す。初期値と上限はどちらも
 * そのシナリオのdurationTurns（唯一の正）。未知のscenarioIdの場合はnull
 * （フォーム側は選択肢からしか選べないため通常到達しないが、防御的に扱う）。
 */
export function turnBoundsForScenario(options: readonly NewLabScenarioOption[], scenarioId: string): NewLabTurnBounds | null {
  const selected = options.find((o) => o.scenarioId === scenarioId);
  if (!selected) return null;
  return { defaultTurns: selected.durationTurns, maxTurns: selected.durationTurns };
}

/**
 * 【UI-SALES-MODEL-SELECT-1】ラボ作成フォームの「販売市場モデル」select値（formData由来の
 * 生文字列）から、handleCreateLabへ渡すべきsalesModelIdを決める純粋関数。
 *
 * 既定選択（DEFAULT_SALES_MODEL_ID＝legacy）のままであれば undefined を返し、
 * 呼び出し側（createLabAction）が salesModelId キー自体をbodyへ含めないようにする
 * （指示§5推奨: 既存Runと完全に同一のpayload・挙動を維持する）。
 * 未知の値が来た場合もそのまま通す（allowlist判定はvalidation.ts側の唯一の正で行う。
 * ここで重複実装しない）。
 */
export function resolveSalesModelIdForSubmission(rawValue: string | undefined): SalesModelId | undefined {
  if (rawValue === undefined || rawValue === DEFAULT_SALES_MODEL_ID) return undefined;
  return rawValue as SalesModelId;
}
