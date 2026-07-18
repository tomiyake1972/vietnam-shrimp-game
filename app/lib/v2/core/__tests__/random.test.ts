import { test } from "node:test";
import assert from "node:assert/strict";
import { createRandomStream } from "../random";

// テスト19: 同じシードから同じ乱数列が得られる
test("同じシードは同じ乱数列を生成する", () => {
  const a = createRandomStream("seed-abc");
  const b = createRandomStream("seed-abc");
  const seqA = Array.from({ length: 10 }, () => a.next());
  const seqB = Array.from({ length: 10 }, () => b.next());
  assert.deepEqual(seqA, seqB);
});

// テスト20: 異なるシードは異なる乱数列を生成する
test("異なるシードは異なる乱数列を生成する", () => {
  const a = createRandomStream("seed-abc");
  const b = createRandomStream("seed-xyz");
  const seqA = Array.from({ length: 10 }, () => a.next());
  const seqB = Array.from({ length: 10 }, () => b.next());
  assert.notDeepEqual(seqA, seqB);
});

test("next()は常に[0,1)の範囲を返す", () => {
  const r = createRandomStream("range-check");
  for (let i = 0; i < 1000; i++) {
    const v = r.next();
    assert.ok(v >= 0 && v < 1, `値が範囲外です: ${v}`);
  }
});

test("nextIntは[min,max)の整数を返す", () => {
  const r = createRandomStream("int-check");
  for (let i = 0; i < 200; i++) {
    const v = r.nextInt(5, 10);
    assert.ok(Number.isInteger(v) && v >= 5 && v < 10, `値が範囲外です: ${v}`);
  }
});

test("pickは配列内の要素のみを返す", () => {
  const r = createRandomStream("pick-check");
  const items = ["a", "b", "c"];
  for (let i = 0; i < 50; i++) {
    assert.ok(items.includes(r.pick(items)));
  }
});

test("消費順序はインスタンスごとに独立している（片方を進めても他方に影響しない）", () => {
  const a = createRandomStream("independent");
  const b = createRandomStream("independent");
  a.next();
  a.next();
  // aは2回消費済み、bは未消費。3回目のaとbの1回目は異なるはず（同じ状態から出発していない）。
  assert.equal(a.getDrawCount(), 2);
  assert.equal(b.getDrawCount(), 0);
});

test("空配列に対するpickは例外", () => {
  const r = createRandomStream("empty-pick");
  assert.throws(() => r.pick([]));
});
