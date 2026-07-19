// ShrimpX V2 — 工場・ワーカー・生産モジュール 優先順位付き制約配分（Phase 6）
//
// 複数の生産計画が共通の希少資源（原料・共通設備・冷凍包装能力・商品別設備）を
// 競合する場合に、生産優先順位（priority、小さいほど優先）に従って配分する。
// 同順位の候補間では、rawMaterials/waterFill.ts の水位法配分（waterFillAllocate）を
// 使って比例配分する。waterFillAllocateの実装は入力配列の順序に一切依存しない
// （合計・比較がすべて順序非依存の演算）ため、本関数も入力順に依存しない
// 決定論的な結果を返す。
//
// アルゴリズム: priorityの昇順で優先度階層をグループ化し、階層ごとに
// waterFillAllocateで（残り予算, その階層の参加者）を配分する。ある階層で
// 使い切れなかった予算（cap未達の参加者がいてもtotalWeightが尽きた場合等は
// 通常発生しないが、安全のため）は次の階層へ持ち越す。

import { waterFillAllocate, WaterFillParticipant } from "../rawMaterials/waterFill";

export interface PriorityAllocationItem {
  readonly id: string;
  readonly priority: number;
  /** この項目が希望する量（水位法の重み・capの両方に使う）。 */
  readonly desired: number;
}

/**
 * priorityの階層順に totalBudget を配分する。戻り値は id → 配分量 のMap。
 * 入力配列の順序（同一priority内の並び順）には一切依存しない。
 */
export function allocateByPriorityTiers(items: readonly PriorityAllocationItem[], totalBudget: number): ReadonlyMap<string, number> {
  const result = new Map<string, number>(items.map((i) => [i.id, 0]));
  if (items.length === 0 || totalBudget <= 0) return result;

  const priorities = Array.from(new Set(items.map((i) => i.priority))).sort((a, b) => a - b);

  let remainingBudget = totalBudget;
  for (const priority of priorities) {
    if (remainingBudget <= 0) break;
    const tierItems = items.filter((i) => i.priority === priority);
    const participants: WaterFillParticipant[] = tierItems.map((i) => ({
      id: i.id,
      weight: Math.max(0, i.desired),
      cap: Math.max(0, i.desired),
    }));
    const { allocated } = waterFillAllocate(participants, remainingBudget);
    let tierTotal = 0;
    for (const p of participants) {
      const value = allocated.get(p.id) ?? 0;
      result.set(p.id, value);
      tierTotal += value;
    }
    remainingBudget -= tierTotal;
  }

  return result;
}
