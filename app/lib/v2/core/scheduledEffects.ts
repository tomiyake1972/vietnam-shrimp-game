// ShrimpX V2 — 遅延効果キュー（Phase 0B）
//
// 将来の各モジュール（営業/輸入/養殖/投資等）が持つ「登録期と発現期がずれる」
// 効果（営業+2期/-1期、Worker+/-1期、輸入原料+1期、自社養殖+2期、
// 工場・機械の完成期 等）を共通に扱うための汎用キュー。
// 本Phaseでは各モジュールの業務ロジックは実装せず、キュー自体が
// 「登録→期の到来→発現→二重発現防止」を正しく行うことだけを保証する。
//
// 設計:
//   - ScheduledEffect<TPayload> はジェネリックにし、any を使わない。
//     payloadの型はドメイン側（将来の各モジュール）が具象型で指定する。
//   - plainなオブジェクト/配列のみで構成し、クラスやFunctionを含まない
//     ため JSON.stringify / JSON.parse をそのまま通せる
//     （Redis保存・snapshot互換の要件）。
//   - キュー操作はすべて純粋関数（引数の配列を変更せず新しい配列を返す）。

import { PeriodV2 } from "./period";

export class ScheduledEffectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduledEffectError";
  }
}

/**
 * 汎用の遅延効果。TPayloadは各ドメイン（営業/輸入/養殖/投資等）が
 * 具象型で指定する（例: { kind: "sales_staff_hire"; companyId: string }）。
 * payloadはJSON直列化可能な値である前提（クラスインスタンス等は不可）。
 */
export interface ScheduledEffect<TPayload> {
  /** 効果を一意に識別するID（同一キュー内で重複しないこと）。 */
  readonly id: string;
  /** この効果が登録された期。 */
  readonly registeredAt: PeriodV2;
  /** この効果が発現すべき期。registeredAtと同じかそれ以降であること。 */
  readonly manifestAt: PeriodV2;
  /** ドメイン固有のペイロード（JSON直列化可能な値のみ）。 */
  readonly payload: TPayload;
  /** 発現済みフラグ。true になった効果は二度と発現処理されない。 */
  readonly manifested: boolean;
}

/** JSON直列化可能な、遅延効果のプレーン配列（Redis/snapshot保存用の型）。 */
export type ScheduledEffectQueue<TPayload> = readonly ScheduledEffect<TPayload>[];

/** 新しい遅延効果をキューへ追加する（元の配列は変更しない）。 */
export function scheduleEffect<TPayload>(
  queue: ScheduledEffectQueue<TPayload>,
  effect: {
    id: string;
    registeredAt: PeriodV2;
    manifestAt: PeriodV2;
    payload: TPayload;
  }
): ScheduledEffectQueue<TPayload> {
  if (!effect.id) {
    throw new ScheduledEffectError("ScheduledEffect の id は空にできません。");
  }
  if (queue.some((e) => e.id === effect.id)) {
    throw new ScheduledEffectError(`ScheduledEffect の id が重複しています: ${effect.id}`);
  }
  const next: ScheduledEffect<TPayload> = {
    id: effect.id,
    registeredAt: effect.registeredAt,
    manifestAt: effect.manifestAt,
    payload: effect.payload,
    manifested: false,
  };
  return [...queue, next];
}

/**
 * 指定Periodにおいて「今まさに発現すべき」効果（manifestAt === period かつ
 * 未発現）だけを抽出する。キューは変更しない（読み取り専用の照会）。
 */
export function dueEffects<TPayload>(
  queue: ScheduledEffectQueue<TPayload>,
  period: PeriodV2
): ScheduledEffect<TPayload>[] {
  return queue.filter((e) => !e.manifested && e.manifestAt === period);
}

/**
 * 指定したidの効果群を「発現済み」としてマークした新しいキューを返す。
 * 既に発現済みの効果を再度マークしようとした場合は二重発現として例外を投げる
 * （要件: 二重発現の防止）。
 */
export function markManifested<TPayload>(
  queue: ScheduledEffectQueue<TPayload>,
  ids: readonly string[]
): ScheduledEffectQueue<TPayload> {
  const idSet = new Set(ids);
  return queue.map((e) => {
    if (!idSet.has(e.id)) return e;
    if (e.manifested) {
      throw new ScheduledEffectError(`効果 ${e.id} は既に発現済みです（二重発現は禁止されています）。`);
    }
    return { ...e, manifested: true };
  });
}

/** 空の遅延効果キューを作る。 */
export function emptyScheduledEffectQueue<TPayload>(): ScheduledEffectQueue<TPayload> {
  return [];
}
