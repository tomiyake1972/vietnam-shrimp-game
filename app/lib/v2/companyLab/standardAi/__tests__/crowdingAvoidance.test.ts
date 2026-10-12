// ShrimpX V2 — Standard AI の混雑度回避（PUBLIC-COMPETITOR-3）
//
// 受講者へ公開した混雑度を Standard AI にも使わせる。固定したいのは次の3点。
//  (1) 補正係数の形（混雑度1.0以下・観測不能・weight=0 では必ず無補正）
//  (2) weight = 0 なら、この機能を入れる前と完全に同一の配分になる
//  (3) プレイヤー画面と Standard AI が同じ混雑度の値を見ている

import test from "node:test";
import assert from "node:assert/strict";
import { crowdingOpportunityFactor } from "../decision/sales";
import { crowdingRatioByCell } from "../../publicCompetitorSnapshot";
import { STANDARD_AI_PARAMETERS_V1 } from "../parameters";
import { CompanyQuarterRecord } from "../../types";

test("CA-1: 混雑度が1.0以下のマスは無補正（係数1）", () => {
  for (const ratio of [0, 0.5, 0.8, 1.0]) {
    assert.equal(crowdingOpportunityFactor(ratio, 0.6), 1, `混雑度 ${ratio} で補正が入っている`);
  }
});

test("CA-2: 混雑度が観測できないマスは無補正", () => {
  assert.equal(crowdingOpportunityFactor(undefined, 0.6), 1);
  assert.equal(crowdingOpportunityFactor(Number.NaN, 0.6), 1);
  assert.equal(crowdingOpportunityFactor(Number.POSITIVE_INFINITY, 0.6), 1);
});

test("CA-3【後方互換】: weight = 0 なら、どんな混雑度でも無補正になる", () => {
  for (const ratio of [1.1, 1.5, 2.5, 10]) {
    assert.equal(crowdingOpportunityFactor(ratio, 0), 1, `weight=0 なのに補正が入っている（混雑度 ${ratio}）`);
  }
});

test("CA-4: 混雑しているほど機会スコアが下がり、単調減少する", () => {
  const weight = STANDARD_AI_PARAMETERS_V1.crowdingAvoidanceWeight;
  const factors = [1.0, 1.2, 1.5, 2.0, 3.0].map((ratio) => crowdingOpportunityFactor(ratio, weight));
  for (let i = 1; i < factors.length; i++) {
    assert.ok(factors[i] < factors[i - 1], `単調減少していない: ${factors.join(" / ")}`);
  }
  // 既定値 0.6 で混雑度 1.5 のマスは約77%。コメントに書いた水準と実装を一致させる。
  assert.ok(Math.abs(crowdingOpportunityFactor(1.5, 0.6) - 0.7692) < 0.001, `混雑度1.5の係数: ${crowdingOpportunityFactor(1.5, 0.6)}`);
  // どれだけ混雑しても0にはならない（その市場を完全に捨てる判断はしない）。
  assert.ok(crowdingOpportunityFactor(100, weight) > 0);
});

test("CA-5: 既定パラメータでは混雑度回避が有効（0ではない）", () => {
  assert.ok(
    STANDARD_AI_PARAMETERS_V1.crowdingAvoidanceWeight > 0,
    "既定で無効のままだと、公開した混雑度を AI が使わないことになる"
  );
});

test("CA-6【情報境界】: 混雑度の抽出は1箇所に集約されており、同じ記録からは同じ値が出る", () => {
  const record = {
    crowdingDiagnostics: {
      buckets: [
        { market: "US", product: "pd", crowdingRatio: 1.25, lambda: 0.6, floor: 0.82 },
        { market: "US", product: "pd", crowdingRatio: 0.4, lambda: 0.6, floor: 0.82 },
        { market: "JP", product: "vap", crowdingRatio: 0.9, lambda: 0.6, floor: 0.82 },
      ],
    },
  } as unknown as CompanyQuarterRecord;

  const first = crowdingRatioByCell(record);
  const second = crowdingRatioByCell(record);
  assert.deepEqual([...first.entries()].sort(), [...second.entries()].sort());

  // 同じマスが複数バケツに分かれる場合は最も混んだ値（受講者画面と同じ規約）。
  assert.equal(first.get("US|pd"), 1.25);
  assert.equal(first.get("JP|vap"), 0.9);
});

test("CA-7: crowding 診断が無い記録からは混雑度が一切出ない（0で埋めない）", () => {
  const record = {} as unknown as CompanyQuarterRecord;
  assert.equal(crowdingRatioByCell(record).size, 0);
  assert.equal(crowdingRatioByCell(null).size, 0);
});

test("CA-8【CRWD-14 を壊さない】: 中立 policy（lambda=0・floor=1）の診断からは混雑度を公開しない", () => {
  const neutral = {
    crowdingDiagnostics: {
      buckets: [{ market: "US", product: "pd", crowdingRatio: 2.0, lambda: 0, floor: 1 }],
    },
  } as unknown as CompanyQuarterRecord;
  assert.equal(
    crowdingRatioByCell(neutral).size,
    0,
    "価格に一切影響しない混雑を公開すると、受講者に嘘を伝え、AIも避ける理由の無いマスを避けてしまう"
  );

  const active = {
    crowdingDiagnostics: {
      buckets: [{ market: "US", product: "pd", crowdingRatio: 2.0, lambda: 0.6, floor: 0.82 }],
    },
  } as unknown as CompanyQuarterRecord;
  assert.equal(crowdingRatioByCell(active).get("US|pd"), 2.0, "markdown が効く policy では公開する");
});
