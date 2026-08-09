// ShrimpX V2 — Test16 Stage E: 商品集中生産効率の単体テスト
//
// concentrationFactor(product, quantity) が唯一の情報源であること、
// 「人数 → 最大生産量」が代表生産量を仮定せず逆算されることを検証する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { concentrationFactor, peakLaborQuantityTons } from "../concentration";
import {
  effectiveEfficiencyPerHeadTons,
  requiredHeadcountForQuantityWithConcentration,
  maxQuantityForAvailableWorkers,
  laborIntensityCoefficientFor,
} from "../labor";
import { PRODUCTION_PARAMETERS_V1 } from "../parameters";

const near = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) < tol;

test("Stage E-1: HOSOのカーブは 8,000=1.00 / 16,000=0.80 / 24,000=0.60", () => {
  assert.equal(concentrationFactor("hoso", 0), 1);
  assert.equal(concentrationFactor("hoso", 8_000), 1);
  assert.ok(near(concentrationFactor("hoso", 16_000), 0.8));
  assert.ok(near(concentrationFactor("hoso", 24_000), 0.6));
});

test("Stage E-2: PD/VAPのカーブは 4,000=1.00 / 12,000=0.80", () => {
  for (const p of ["pd", "vap"] as const) {
    assert.equal(concentrationFactor(p, 4_000), 1);
    assert.ok(near(concentrationFactor(p, 12_000), 0.8), `${p}`);
  }
});

test("Stage E-3: 基準点の間は線形補間される", () => {
  assert.ok(near(concentrationFactor("hoso", 12_000), 0.9));
  assert.ok(near(concentrationFactor("hoso", 20_000), 0.7));
  assert.ok(near(concentrationFactor("pd", 8_000), 0.9));
});

test("Stage E-4: 下限は設けない（上限数量を超えても外挿する）", () => {
  // 24,000tで0.60、さらに8,000t増えれば0.40。設計上の下限（0.70等）は無い。
  assert.ok(near(concentrationFactor("hoso", 32_000), 0.4));
  assert.ok(concentrationFactor("hoso", 40_000) < 0.4);
});

test("Stage E-5: 実効係数は labor intensity × concentration factor（置換ではなく乗算）", () => {
  const base = PRODUCTION_PARAMETERS_V1.labor.regularEfficiencyPerHeadTons;
  const intensity = laborIntensityCoefficientFor("vap", PRODUCTION_PARAMETERS_V1);
  const qty = 12_000;
  const expected = base / (intensity * concentrationFactor("vap", qty));
  assert.ok(near(effectiveEfficiencyPerHeadTons(base, "vap", PRODUCTION_PARAMETERS_V1, undefined, qty), expected));
});

test("Stage E-6: PD省人化投資の上書きと集中効果は両立する（打ち消し合わない）", () => {
  const base = PRODUCTION_PARAMETERS_V1.labor.regularEfficiencyPerHeadTons;
  const override = 1.0; // 省人化により PD係数 1.2 → 1.0
  const qty = 12_000;
  const withBoth = effectiveEfficiencyPerHeadTons(base, "pd", PRODUCTION_PARAMETERS_V1, override, qty);
  const expected = base / (override * concentrationFactor("pd", qty));
  assert.ok(near(withBoth, expected));
  // 省人化だけ・集中だけの場合より、両方効いた方が効率が高い。
  assert.ok(withBoth > effectiveEfficiencyPerHeadTons(base, "pd", PRODUCTION_PARAMETERS_V1, override));
  assert.ok(withBoth > effectiveEfficiencyPerHeadTons(base, "pd", PRODUCTION_PARAMETERS_V1, undefined, qty));
});

test("Stage E-7: 集中効果が働く数量では必要Workerが減る", () => {
  const base = PRODUCTION_PARAMETERS_V1.labor.regularEfficiencyPerHeadTons;
  const args = [base, "hoso" as const, 1, 1, 0, PRODUCTION_PARAMETERS_V1] as const;
  const at8k = requiredHeadcountForQuantityWithConcentration(8_000, ...args);
  const at16k = requiredHeadcountForQuantityWithConcentration(16_000, ...args);
  // 数量2倍でも必要人数は2倍未満（係数が1.00→0.80になるため 1.6倍）。
  assert.ok(near(at16k / at8k, 1.6, 1e-6), `ratio=${at16k / at8k}`);
});

test("Stage E-8: 必要Workerは設計domain内（頂点まで）で単調増加する（二分探索の前提）", () => {
  const base = PRODUCTION_PARAMETERS_V1.labor.regularEfficiencyPerHeadTons;
  // HOSOの頂点は24,000t＝MAX_HOSO_CAPACITY_TONS。ゲーム内で到達可能な範囲と一致する。
  assert.equal(peakLaborQuantityTons("hoso"), 24_000);
  let prev = -1;
  for (let q = 0; q <= 24_000; q += 500) {
    const r = requiredHeadcountForQuantityWithConcentration(q, base, "hoso", 1, 1, 0, PRODUCTION_PARAMETERS_V1);
    assert.ok(r >= prev, `単調増加が崩れた q=${q}`);
    prev = r;
  }
});

test("Stage E-9: 人数→最大生産量は逆算で求まり、代表生産量を仮定しない", () => {
  // 設備能力(24,000t)ではなく人数が制約になる水準を選ぶ（能力で頭打ちだと逆算の検証にならない）。
  const workers = 2_000;
  const maxQty = maxQuantityForAvailableWorkers(workers, 0, 1, 1, 0, 24_000, PRODUCTION_PARAMETERS_V1, "hoso");
  assert.ok(maxQty < 24_000, "設備能力で頭打ちになってしまっている");
  const base = PRODUCTION_PARAMETERS_V1.labor.regularEfficiencyPerHeadTons;
  const needed = requiredHeadcountForQuantityWithConcentration(maxQty, base, "hoso", 1, 1, 0, PRODUCTION_PARAMETERS_V1);
  // 求めた数量ちょうどで人数を使い切る。
  assert.ok(Math.abs(needed - workers) < 1, `needed=${needed} workers=${workers}`);
  // 集中効果があるぶん、係数1.00で計算した量より多く作れる。
  const withoutConcentration = workers * base;
  assert.ok(maxQty > withoutConcentration, `maxQty=${maxQty} withoutConcentration=${withoutConcentration}`);
});

test("Stage E-10: 設備能力が探索上限として効く（人を増やしても設備は超えない）", () => {
  const capped = maxQuantityForAvailableWorkers(100_000, 0, 1, 1, 0, 5_000, PRODUCTION_PARAMETERS_V1, "hoso");
  assert.equal(capped, 5_000);
});

test("Stage E-11: 集中効果が働かない数量域では従来の閉じた式と厳密に一致する", () => {
  const base = PRODUCTION_PARAMETERS_V1.labor.regularEfficiencyPerHeadTons;
  const intensity = laborIntensityCoefficientFor("hoso", PRODUCTION_PARAMETERS_V1);
  const workers = 100;
  const closedForm = workers * (base / intensity) * 0.95 * 0.9;
  assert.ok(closedForm < 8_000, "この設定では集中効果域に入らないこと");
  const solved = maxQuantityForAvailableWorkers(workers, 0, 0.95, 0.9, 0, 1_000_000, PRODUCTION_PARAMETERS_V1, "hoso");
  assert.ok(near(solved, closedForm), `solved=${solved} closedForm=${closedForm}`);
});

test("Stage E-12: 出勤率・技能が0なら、人数がいくらでも生産量は0", () => {
  assert.equal(maxQuantityForAvailableWorkers(10_000, 10_000, 0, 1, 0, 100_000, PRODUCTION_PARAMETERS_V1, "hoso"), 0);
  assert.equal(maxQuantityForAvailableWorkers(10_000, 10_000, 1, 0, 0, 100_000, PRODUCTION_PARAMETERS_V1, "hoso"), 0);
});

test("Stage E-13: カーブ自体に下限は無いが、労働計算は頂点で頭打ちにして逆転域へ入らない", () => {
  const base = PRODUCTION_PARAMETERS_V1.labor.regularEfficiencyPerHeadTons;
  const peak = peakLaborQuantityTons("hoso");
  assert.equal(peak, 24_000);

  // 係数カーブそのものは下限なし（外挿し続ける）。これは指示どおりの設計。
  assert.ok(concentrationFactor("hoso", 32_000) < concentrationFactor("hoso", 24_000));

  // 【抜け道の封じ込め】計画生産量は意思決定の入力であり、設備能力を超える
  // 非現実的な値も入り得る。基準数量をそのまま使うと係数が0へ近づき
  // 「巨大な計画を書けば労務がタダになる」抜け道になるため、労働計算側は
  // 基準数量を頂点で頭打ちにする。したがって必要Workerは頂点以降**減少しない**。
  const atPeak = requiredHeadcountForQuantityWithConcentration(peak, base, "hoso", 1, 1, 0, PRODUCTION_PARAMETERS_V1);
  const beyond = requiredHeadcountForQuantityWithConcentration(peak + 8_000, base, "hoso", 1, 1, 0, PRODUCTION_PARAMETERS_V1);
  const farBeyond = requiredHeadcountForQuantityWithConcentration(peak * 10, base, "hoso", 1, 1, 0, PRODUCTION_PARAMETERS_V1);
  assert.ok(beyond > atPeak, `頂点超えで必要Workerが増えていない beyond=${beyond} atPeak=${atPeak}`);
  assert.ok(farBeyond > beyond, "数量を10倍にしても必要Workerが増えていない（係数が0へ張り付いている）");

  // 逆算側も同じ位置で探索を打ち切る（順算と逆算で同じ上限を使う）。
  assert.equal(maxQuantityForAvailableWorkers(1_000_000, 0, 1, 1, 0, 100_000, PRODUCTION_PARAMETERS_V1, "hoso"), peak);
});
