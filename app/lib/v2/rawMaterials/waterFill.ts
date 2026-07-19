// ShrimpX V2 — 国内原料・輸入・養殖・原料在庫モジュール 配分アルゴリズム共通部（Phase 5）
//
// Phase4のallocation.ts内部にある水位法（water-filling）と同じアルゴリズムを、
// 国内供給配分（domesticPurchase.ts）・原産国別輸入上限配分（imports.ts）の
// 両方から使い回すためにこのファイルへ切り出す。Phase4のwaterFillAllocateは
// allocation.ts内部の非公開関数のため、ここでは独立した実装を持つ（アルゴリズム
// 自体はPhase4と同一の考え方の再利用であり、新しい経済ロジックの追加ではない）。
//
// 参加者ごとの重みに比例して予算(totalBudget)を配分しつつ、各参加者のcapを
// 超えないよう、超過分を毎ラウンド未飽和の参加者へ再配分する。入力配列の
// 順序には一切依存しない（合計・比較はすべて順序非依存の演算）。

const EPSILON = 1e-6;

export interface WaterFillParticipant {
  readonly id: string;
  readonly weight: number;
  readonly cap: number;
}

export interface WaterFillResult {
  readonly allocated: ReadonlyMap<string, number>;
}

export function waterFillAllocate(participants: readonly WaterFillParticipant[], totalBudget: number): WaterFillResult {
  const allocated = new Map<string, number>(participants.map((p) => [p.id, 0]));
  const active = new Set(participants.filter((p) => p.cap > EPSILON).map((p) => p.id));

  let budget = totalBudget;
  let safety = 0;
  const safetyLimit = participants.length + 5;

  while (budget > EPSILON && active.size > 0 && safety < safetyLimit) {
    safety += 1;
    const activeParticipants = participants.filter((p) => active.has(p.id));
    const totalWeight = activeParticipants.reduce((sum, p) => sum + Math.max(0, p.weight), 0);
    if (totalWeight <= EPSILON) break;

    const overflowing = activeParticipants.filter((p) => {
      const tentativeShare = budget * (Math.max(0, p.weight) / totalWeight);
      const room = p.cap - (allocated.get(p.id) ?? 0);
      return tentativeShare > room + EPSILON;
    });

    if (overflowing.length === 0) {
      for (const p of activeParticipants) {
        const share = budget * (Math.max(0, p.weight) / totalWeight);
        allocated.set(p.id, (allocated.get(p.id) ?? 0) + share);
      }
      budget = 0;
      break;
    }

    for (const p of overflowing) {
      const room = p.cap - (allocated.get(p.id) ?? 0);
      allocated.set(p.id, (allocated.get(p.id) ?? 0) + room);
      budget -= room;
      active.delete(p.id);
    }
  }

  return { allocated };
}
