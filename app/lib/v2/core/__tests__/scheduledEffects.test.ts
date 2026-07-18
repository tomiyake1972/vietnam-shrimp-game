import { test } from "node:test";
import assert from "node:assert/strict";
import { period } from "../period";
import {
  emptyScheduledEffectQueue,
  scheduleEffect,
  dueEffects,
  markManifested,
} from "../scheduledEffects";

interface TestPayload {
  readonly kind: "test_effect";
  readonly note: string;
}

// テスト17: 指定Periodでのみ効果が発現する
test("効果は指定したmanifestAtのPeriodでのみdueEffectsに現れる", () => {
  const q1 = period(2020, 1);
  const q2 = period(2020, 2);
  const q3 = period(2020, 3);
  let queue = emptyScheduledEffectQueue<TestPayload>();
  queue = scheduleEffect(queue, {
    id: "effect-1",
    registeredAt: q1,
    manifestAt: q3,
    payload: { kind: "test_effect", note: "sales staff +2 turns 相当" },
  });

  assert.deepEqual(dueEffects(queue, q1), []);
  assert.deepEqual(dueEffects(queue, q2), []);
  assert.equal(dueEffects(queue, q3).length, 1);
  assert.equal(dueEffects(queue, q3)[0].id, "effect-1");
});

test("同一idの重複登録は拒否される", () => {
  const q1 = period(2020, 1);
  let queue = emptyScheduledEffectQueue<TestPayload>();
  queue = scheduleEffect(queue, {
    id: "dup",
    registeredAt: q1,
    manifestAt: q1,
    payload: { kind: "test_effect", note: "a" },
  });
  assert.throws(() =>
    scheduleEffect(queue, {
      id: "dup",
      registeredAt: q1,
      manifestAt: q1,
      payload: { kind: "test_effect", note: "b" },
    })
  );
});

// テスト18: 効果の二重発現の防止
test("markManifestedで発現済みにした効果を再度発現させようとすると拒否される", () => {
  const q1 = period(2020, 1);
  let queue = emptyScheduledEffectQueue<TestPayload>();
  queue = scheduleEffect(queue, {
    id: "effect-2",
    registeredAt: q1,
    manifestAt: q1,
    payload: { kind: "test_effect", note: "once" },
  });

  const due = dueEffects(queue, q1);
  assert.equal(due.length, 1);
  queue = markManifested(queue, due.map((e) => e.id));

  // 発現済みなので、同じPeriodで再度dueEffectsに現れない
  assert.equal(dueEffects(queue, q1).length, 0);
  // 発現済みのものを再度markManifestedしようとすると例外
  assert.throws(() => markManifested(queue, ["effect-2"]));
});

test("JSON直列化してもキューの意味が保たれる", () => {
  const q1 = period(2020, 1);
  let queue = emptyScheduledEffectQueue<TestPayload>();
  queue = scheduleEffect(queue, {
    id: "effect-3",
    registeredAt: q1,
    manifestAt: q1,
    payload: { kind: "test_effect", note: "serializable" },
  });
  const restored = JSON.parse(JSON.stringify(queue));
  assert.deepEqual(restored, queue);
});
