// ShrimpX V2 — 業界シミュレーション・テスト環境（Phase 3） 選択・フィルタ用の純粋関数
//
// 表示する四半期の選択、情報レベルに応じた表示切り替えといった、UI状態から
// 導出できる値をコンポーネント外の純粋関数として分離する（実装指示 §13）。

import { InformationRelease } from "../../scenario/types";
import { IndustryQuarterRecord, DisplayInformationLevel } from "../types";

/** turn番号から該当する四半期履歴を探す。見つからなければundefined。 */
export function selectQuarterByTurn(
  quarters: readonly IndustryQuarterRecord[],
  turn: number
): IndustryQuarterRecord | undefined {
  return quarters.find((q) => q.turn === turn);
}

/** 最新（最大turn）の四半期履歴を返す。空配列ならundefined。 */
export function selectLatestQuarter(quarters: readonly IndustryQuarterRecord[]): IndustryQuarterRecord | undefined {
  if (quarters.length === 0) return undefined;
  return quarters[quarters.length - 1];
}

/**
 * 指定した情報レベルに対応する、その四半期の公開情報一覧を返す。
 * IndustryQuarterRecordはすでにpublic/standard/advanced/gmの4通りを
 * 事前計算済みのため、ここでは選択するだけで再計算はしない
 * （public表示中にadvanced/gm情報が混入しないことを型で保証する）。
 */
export function selectInformationForLevel(
  record: IndustryQuarterRecord,
  level: DisplayInformationLevel
): readonly InformationRelease[] {
  switch (level) {
    case "public":
      return record.publicInformation;
    case "standard":
      return record.standardInformation;
    case "advanced":
      return record.advancedInformation;
    case "gm":
      return record.gmInformation;
    default: {
      const exhaustiveCheck: never = level;
      throw new Error(`未知の情報レベルです: ${String(exhaustiveCheck)}`);
    }
  }
}

/** 現在ramp-up中・継続中・回復中（＝何らかの強度で影響している）イベントだけを抽出する。 */
export function selectCurrentlyActiveEvents(record: IndustryQuarterRecord): IndustryQuarterRecord["activeEvents"] {
  return record.activeEvents.filter((e) => e.phase === "rampUp" || e.phase === "active" || e.phase === "recovering");
}
