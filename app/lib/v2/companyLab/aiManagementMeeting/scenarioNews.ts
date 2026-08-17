// ShrimpX V2 — AI Management Meeting: シナリオNewsのAI向け投影（player-facing のみ）
//
// 【何をするか】そのターン時点で「standard レベル（＝人間プレイヤーが読める範囲）」として
// 公開済みの InformationRelease を、AI役員へ渡してよいフィールドだけへ射影する。
//
// 【何をしないか】
//  - 公開可否の判定を再実装しない。既存の scenario/informationEngine.ts の
//    getAvailableInformation にそのまま委ねる（未来の記事・gm 専用・postGameTruth は
//    この関数が構造的に落とす）。
//  - シナリオIDでの分岐を一切持たない。informationReleases があれば渡す、無ければ空。
//    Dynamic Scenario 2 以降もこのまま動く。
//  - News に「これは重要な兆候だ」といった解釈・重み付けを付けない。人間プレイヤーが
//    読むのと同じ記事をそのまま渡し、意味の解釈はAI役員自身に任せる。
//
// 【隠しメタデータを渡さない】下の toAiMeetingNewsItem は allowlist（明示的な
// フィールド列挙）であり、InformationRelease に将来フィールドが増えても自動では
// 通さない。signalClass / futureEffectTurn / hiddenImportance / scenarioRelevance の
// ような内部メタデータは、そもそも InformationRelease 型に存在せず（シナリオ定義側の
// 開発用 NewsSpec に留まる）、かつこの allowlist も通らない、という二重の防御にする。

import { getAvailableInformation } from "../../scenario/informationEngine";
import { InformationRelease, ScenarioDefinition } from "../../scenario/types";

/** AI役員へ渡す News 1件（人間プレイヤーが画面で読めるものと同じ範囲）。 */
export interface AiMeetingNewsItem {
  readonly informationId: string;
  /** 見出し。 */
  readonly headline: string;
  /** 記事本文。持たない記事では null。 */
  readonly body: string | null;
  /** 観測・噂か、確報か（画面の公開ラベルと同じ意味）。 */
  readonly isRumor: boolean;
  /** この記事が読めるようになったターン。 */
  readonly availableFromTurn: number;
  /** 記事に添えられた構造化事実。 */
  readonly facts: readonly { readonly label: string; readonly value: string | number; readonly unit: string | null }[];
  /** 推定レンジ。持たない記事では null。 */
  readonly estimateRange: { readonly low: number; readonly high: number; readonly unit: string | null } | null;
  /** 0〜1の確度。示されていない記事では null。 */
  readonly confidence: number | null;
}

function toAiMeetingNewsItem(release: InformationRelease): AiMeetingNewsItem {
  return {
    informationId: release.informationId,
    headline: release.headlineTemplate,
    body: release.body ?? null,
    isRumor: release.isRumor,
    availableFromTurn: release.availableFromTurn,
    facts: release.structuredFacts.map((f) => ({ label: f.label, value: f.value, unit: f.unit ?? null })),
    estimateRange:
      release.estimateRange === undefined
        ? null
        : { low: release.estimateRange.low, high: release.estimateRange.high, unit: release.estimateRange.unit ?? null },
    confidence: release.confidence ?? null,
  };
}

/**
 * 指定シナリオ・指定ターンで、AI役員へ渡してよい News を返す（新しい順）。
 *
 * definition が null（シナリオ定義を解決できない）場合や、そのシナリオが
 * informationReleases を持たない場合は空配列。呼び出し側で分岐する必要はない。
 */
export function buildAiMeetingScenarioNews(definition: ScenarioDefinition | null | undefined, turn: number): readonly AiMeetingNewsItem[] {
  if (!definition) return [];
  const clampedTurn = Math.min(Math.max(1, turn), definition.durationTurns);
  const available = getAvailableInformation(definition.informationReleases, clampedTurn, "standard");
  return [...available]
    .sort(
      (a, b) =>
        b.availableFromTurn - a.availableFromTurn ||
        Number(a.isRumor) - Number(b.isRumor) ||
        a.informationId.localeCompare(b.informationId)
    )
    .map(toAiMeetingNewsItem);
}
