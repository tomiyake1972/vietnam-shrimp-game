// ShrimpX V2 — 情報公開エンジン（Phase 2）
//
// シナリオ内部の真実と、プレイヤー・AI会社が知る情報を分離する（実装指示 §8）。
// 情報レベルは public ⊂ standard ⊂ advanced ⊂ gm の累積アクセスとし、
// postGame は別チャンネル（ゲーム終了後のみ、真実と将来を含む全情報）として扱う。
//
// 安全側の設計:
//  - public/standard/advanced/gm はすべて availableFromTurn <= turn のリリース
//    しか返さない。未来のイベント・未公開の事実は、どの情報レベルであっても
//    現在ターンを過ぎたリリースを返すことでは漏れない。
//  - postGame以外のレベルでは postGameTruth フィールドを常に取り除いて返す
//    （多重防御。定義側の設定ミスでも漏れないようにする）。
//  - postGameレベルは isGameComplete=true のときのみ、availableFromTurnを
//    無視して全リリース＋postGameTruthを返す。

import { InformationLevel, InformationRelease } from "./types";

const LEVEL_ORDER: readonly InformationLevel[] = ["public", "standard", "advanced", "gm", "postGame"];

/** informationLevelが要求する累積アクセスレベル一覧（postGameは含まない）。 */
function cumulativeLevelsFor(level: InformationLevel): readonly InformationLevel[] {
  if (level === "postGame") return [];
  const idx = LEVEL_ORDER.indexOf(level);
  return LEVEL_ORDER.slice(0, idx + 1);
}

/**
 * 指定したturn・情報レベルで取得可能な InformationRelease の一覧を返す。
 * 入力の releases 配列・各要素は変更しない。
 */
export function getAvailableInformation(
  releases: readonly InformationRelease[],
  turn: number,
  informationLevel: InformationLevel,
  isGameComplete = false
): readonly InformationRelease[] {
  if (informationLevel === "postGame") {
    if (!isGameComplete) return [];
    return releases.map((r) => ({ ...r }));
  }

  const allowedLevels = cumulativeLevelsFor(informationLevel);
  return releases
    .filter((r) => r.informationLevel !== "postGame")
    .filter((r) => allowedLevels.includes(r.informationLevel))
    .filter((r) => r.availableFromTurn <= turn)
    .map((r) => stripPostGameTruth(r));
}

function stripPostGameTruth(release: InformationRelease): InformationRelease {
  if (release.postGameTruth === undefined) return release;
  const { postGameTruth, ...rest } = release;
  void postGameTruth;
  return rest as InformationRelease;
}
