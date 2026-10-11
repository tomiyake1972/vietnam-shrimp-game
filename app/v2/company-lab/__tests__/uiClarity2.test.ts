// ShrimpX V2 — UI-CLARITY-2（実機プレイテストの指摘への対応）のテスト
//
// 検査するのは「表示の決まり方」だけで、engine の判定・数値は一切動かしていない。

import { test } from "node:test";
import assert from "node:assert/strict";

import { humanizeFinanceReason, humanizeFinanceReasons } from "../financeReasonText";
import { formatStopReason, STOP_REASON_LABELS } from "../../management/lib/runStatusLabels";
import { planningWarningsFor, type PlanningWarning } from "../investmentPlanningViewModel";
import { RAW_MATERIAL_FORECAST_EXCLUSION_TEXT } from "../processingForecastViewModel";

// --- D3: 停止理由の日本語化 ---

test("UIC2-1: waiting_for_player が内部名のまま出ない（実機で見えていた事象）", () => {
  assert.equal(formatStopReason("waiting_for_player"), "プレイヤー入力待ち");
});

test("UIC2-2: 既知の停止理由はすべて日本語で、内部名が混ざらない", () => {
  for (const [key, label] of Object.entries(STOP_REASON_LABELS)) {
    assert.equal(formatStopReason(key), label);
    assert.ok(!/[A-Za-z_]{4,}/.test(label), `${key} の表示 "${label}" に内部名が残っている`);
  }
});

test("UIC2-3: 未知の停止理由でも生の値だけを出さず、不明であることを示す", () => {
  assert.equal(formatStopReason("brand_new_reason"), "不明（brand_new_reason）");
});

// --- D3: 財務の理由文 ---

test("UIC2-4: binding の内部名が日本語の制約名に置き換わる", () => {
  const reason = "信用区分C・借入余力枠停止（binding: collateralBased）により通常融資を承認できません。";
  const out = humanizeFinanceReason(reason);
  assert.ok(!out.includes("binding: collateralBased"), out);
  assert.ok(out.includes("効いている制約: "), out);
  assert.ok(out.includes("担保"), `担保ベースの制約名が出るはず: ${out}`);
});

test("UIC2-5: 生の金額が桁区切りのドル表記になる", () => {
  const out = humanizeFinanceReason("配当額(5000000.00)が分配可能利益(1260000.00)を超えています。");
  assert.ok(out.includes("$5,000,000"), out);
  assert.ok(out.includes("$1,260,000"), out);
  assert.ok(!out.includes("5000000.00"), out);
});

test("UIC2-6: USD 接尾辞つきの残額も読める形になる", () => {
  const out = humanizeFinanceReason("借入余力枠(残り4040000USD、binding: earningsBased)を超える申請のため一部のみ承認。");
  assert.ok(out.includes("$4,040,000"), out);
  assert.ok(!out.includes("4040000USD"), out);
});

test("UIC2-7: 変換対象が無い理由文はそのまま返す（未知の理由を握りつぶさない）", () => {
  const reason = "この四半期は申請がありません。";
  assert.equal(humanizeFinanceReason(reason), reason);
  assert.deepEqual(humanizeFinanceReasons([reason]), [reason]);
});

// --- D4: 警告の出し分け ---

test("UIC2-8: 生産画面には生産の入力で直せる警告だけが残る", () => {
  const warnings: readonly PlanningWarning[] = [
    { kind: "workerShortage", label: "Worker不足", sentence: "a" },
    { kind: "engineNotConnected", label: "エンジン未接続の効果", sentence: "b", audience: "investment" },
    { kind: "investmentNotAvailableYet", label: "投資完成前", sentence: "c", audience: "investment" },
  ];
  const production = planningWarningsFor(warnings, "production");
  const investment = planningWarningsFor(warnings, "investment");
  assert.deepEqual(production.map((w) => w.kind), ["workerShortage"]);
  assert.deepEqual(investment.map((w) => w.kind), ["engineNotConnected", "investmentNotAvailableYet"]);
});

test("UIC2-9: audience 未設定の警告は従来どおり生産画面側として扱う", () => {
  const warnings: readonly PlanningWarning[] = [{ kind: "factorySpaceShortage", label: "工場スペース不足", sentence: "a" }];
  assert.equal(planningWarningsFor(warnings, "production").length, 1);
  assert.equal(planningWarningsFor(warnings, "investment").length, 0);
});

// --- D1: 原料の注記 ---

test("UIC2-10: 原料の注記は「当期の買付を含まない」ことを明言している", () => {
  assert.ok(RAW_MATERIAL_FORECAST_EXCLUSION_TEXT.includes("現時点の在庫"));
  assert.ok(RAW_MATERIAL_FORECAST_EXCLUSION_TEXT.includes("含みません"));
  assert.ok(RAW_MATERIAL_FORECAST_EXCLUSION_TEXT.includes("国内買付"));
});
