// ShrimpX V2 — シナリオ定義用 情報公開ヘルパー（Phase 2）
//
// 5つの代表シナリオが、主要イベントごとに「噂（standard, isRumor）→
// 確度の高い確定情報（advanced, revisionOf）→ GM向け内部情報（gm）→
// ゲーム終了後の真実（postGame, postGameTruth）」という典型的な情報公開
// パターンを毎回手書きしなくて済むようにする組み立てヘルパー。
// 生成AI（Claude API等）は一切使わず、構造化事実・見出しテンプレート・
// 見積り範囲・確信度のみを返す（実装指示 §8）。

import { InformationRelease, StructuredFact } from "../types";

export interface EventInformationTemplateInput {
  readonly eventId: string;
  readonly idPrefix: string;
  readonly startTurn: number;
  readonly rumorHeadline: string;
  readonly rumorFacts: readonly StructuredFact[];
  readonly confirmedHeadline: string;
  readonly confirmedFacts: readonly StructuredFact[];
  readonly confirmedEstimateRange?: { readonly low: number; readonly high: number; readonly unit?: string };
  readonly confirmedDelayTurns?: number;
  readonly gmHeadline: string;
  readonly gmFacts: readonly StructuredFact[];
  readonly postGameHeadline: string;
  readonly postGameTruth: readonly StructuredFact[];
}

/**
 * 1つのイベントに対する典型的な情報公開の組（噂→確定→GM→ゲーム終了後）を生成する。
 * availableFromTurnはすべてイベントのstartTurn基準（1以上を保証）。
 */
export function buildEventInformationReleases(input: EventInformationTemplateInput): readonly InformationRelease[] {
  const rumorId = `${input.idPrefix}-rumor`;
  const confirmedId = `${input.idPrefix}-confirmed`;
  const gmId = `${input.idPrefix}-gm`;
  const postGameId = `${input.idPrefix}-postgame`;

  const rumorTurn = Math.max(1, input.startTurn);
  const confirmedTurn = Math.max(1, input.startTurn + (input.confirmedDelayTurns ?? 1));

  const rumor: InformationRelease = {
    informationId: rumorId,
    relatedEventId: input.eventId,
    availableFromTurn: rumorTurn,
    informationLevel: "standard",
    headlineTemplate: input.rumorHeadline,
    structuredFacts: input.rumorFacts,
    confidence: 0.35,
    isRumor: true,
  };

  const confirmed: InformationRelease = {
    informationId: confirmedId,
    relatedEventId: input.eventId,
    availableFromTurn: confirmedTurn,
    informationLevel: "advanced",
    headlineTemplate: input.confirmedHeadline,
    structuredFacts: input.confirmedFacts,
    estimateRange: input.confirmedEstimateRange,
    confidence: 0.8,
    isRumor: false,
    revisionOf: rumorId,
  };

  const gm: InformationRelease = {
    informationId: gmId,
    relatedEventId: input.eventId,
    availableFromTurn: 1,
    informationLevel: "gm",
    headlineTemplate: input.gmHeadline,
    structuredFacts: input.gmFacts,
    confidence: 1,
    isRumor: false,
  };

  const postGame: InformationRelease = {
    informationId: postGameId,
    relatedEventId: input.eventId,
    availableFromTurn: rumorTurn,
    informationLevel: "postGame",
    headlineTemplate: input.postGameHeadline,
    structuredFacts: input.confirmedFacts,
    confidence: 1,
    isRumor: false,
    postGameTruth: input.postGameTruth,
  };

  return [rumor, confirmed, gm, postGame];
}
