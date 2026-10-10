// ShrimpX V2 — UI-TRIAL-1 §5/§6: 提出前の最終確認画面
//
// 【背景】入力画面が7つに分かれているため、提出の直前に「何を提出するのか」を
// 一覧で見られる場所が無かった。予行演習で重要な意思決定が抜けたまま提出される
// 事故を防ぐため、最終確認画面を両PLAYER経路へ入れる。
//
// ここで固定する契約
//   1. 実際に提出される全フィールドが一覧に現れる（棚卸しの機械チェック）。
//   2. 0・指定なし・未入力を区別し、表示用に0へ丸めない。
//   3. 既存の絞り込み（数量0の行は提出されない）を隠さない。
//   4. 申請・予定・確定済み・実行を区別する。借入申請額を実行額として出さない。
//   5. 管理者指定の配当がある場合は、適用内容とPLAYERが編集できる範囲を示す。
//   6. 設備投資は複数案件が分かる形で列挙する。
//   7. 合計は提出値をそのまま足せるものだけ（新しい資金予測を作らない）。
//   8. 確認画面を開いただけではサーバーへ何も送らない。
//   9. 検証エラーがあるときは確定/提出ボタンを押せない。二重クリックも防ぐ。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import DecisionConfirmationScreen from "../components/decisionStudio/DecisionConfirmationScreen";
import { buildDecisionSummary, DecisionSummary, DecisionSummaryItem } from "../decisionSummary";
import { buildDecisionInputFromDraft, buildInitialDraft, CompanyDecisionDraft } from "../decisionDraft";
import { buildCompanyOwnState, buildPublicMarketInfo, initializeCompanyLab } from "../../../lib/v2/companyLab";
import { generateStandardAiDecision } from "../../../lib/v2/companyLab/standardAi/policy";
import type { AnnualDividendGuidance } from "../../../lib/v2/finance/annualDividendGuidance";

function setup() {
  const { state, fixtures } = initializeCompanyLab({ scenarioId: "baseline", mode: "canonical", seed: "ui-trial1-confirm", turns: 6 });
  const fixture = fixtures.find((f) => f.companyId === "BAL")!;
  const ownState = buildCompanyOwnState(state, fixture);
  const ai = generateStandardAiDecision(fixture, ownState, buildPublicMarketInfo(state), state.currentPeriod, 1);
  const draft = buildInitialDraft(fixture, ai, ownState.workforceState, ownState.effectiveFactories);
  return { state, fixture, ownState, draft };
}

function allItems(summary: DecisionSummary): readonly DecisionSummaryItem[] {
  return summary.sections.flatMap((s) => s.items);
}

function hasLabel(summary: DecisionSummary, label: string): boolean {
  return allItems(summary).some((i) => i.label === label);
}

/**
 * 確定/提出ボタンの開始タグを取り出す。
 * class に Tailwind の "disabled:..." が入っているため、タグ全体を取り出してから
 * 独立した disabled 属性の有無で判定する（部分一致で誤判定しない）。
 */
function commitButtonTag(html: string): string {
  const match = html.match(/<button[^>]*data-testid="decision-confirmation-commit"[^>]*>/);
  assert.ok(match !== null, "確定/提出ボタンが見つからない");
  return match[0];
}

function isCommitDisabled(html: string): boolean {
  return commitButtonTag(html).includes('disabled=""');
}

/** 編集可能な素のオブジェクトへ落とす（NaN を入れる前に行う）。 */
function editable(draft: CompanyDecisionDraft): Record<string, unknown> {
  return JSON.parse(JSON.stringify(draft)) as Record<string, unknown>;
}

test("UIT1-C1【棚卸し】: 実際に提出される全フィールドが一覧に現れる", () => {
  const { draft, fixture, state } = setup();
  /**
   * AI初期下書きは投資案件が空なので、棚卸しでは任意項目も埋めた下書きを使う
   * （空のコレクションでは「出し忘れ」を検知できない）。
   */
  const raw = editable(draft);
  (raw.capexDecision as Record<string, unknown>).newProjectProposals = [
    { projectType: "pdMechanization", requestedBudgetUsd: 1_000_000, targetFactoryId: "F1", priority: 1 },
  ];
  const filled = raw as unknown as CompanyDecisionDraft;
  const decision = buildDecisionInputFromDraft(filled, fixture, state.currentPeriod);
  const summary = buildDecisionSummary({ draft: filled });

  /**
   * buildDecisionInputFromDraft が返す各キーに対して、確認画面のどの行が対応するか。
   * 提出フィールドを増やしたのに確認画面へ出し忘れた場合、このテストが落ちる。
   * companyId は一覧の行ではなく画面見出し（会社名）で示すため別扱い。
   */
  const expectedLabelsByKey: Readonly<Record<string, readonly string[]>> = {
    companyId: [],
    salesPlans: ["販売希望量", "価格調整", "営業配員"],
    domesticPurchasePlan: ["国内買付 希望量", "国内買付 価格調整", "買付担当人数"],
    importOrders: ["輸入発注量", "輸入リードタイム"],
    aquacultureStockingPlans: ["養殖 投入量", "養殖 集約度", "養殖 防疫水準"],
    productionPlans: ["生産希望量", "生産の優先順位"],
    workerAssignments: ["常用人数 増員／減員", "臨時人数", "残業率"],
    financingRequest: ["借入 希望額", "借入 種別", "借入 期間", "借入 返済方式", "期限前返済額", "緊急融資の利用"],
    capexDecision: ["設備投資 申請額", "対象工場"],
    salesForceHireCount: ["営業人員 採用数"],
    salesForceLayoffCount: ["営業人員 減員数"],
    vapProductDevelopmentSpendUsd: ["VAP商品開発費"],
    dividendDecision: ["配当 希望額（PLAYERの指示）"],
  };

  // 変換結果のキーがすべて対応表にあること（新しい提出フィールドの追加を検知する）。
  for (const key of Object.keys(decision)) {
    assert.ok(key in expectedLabelsByKey, `提出フィールド "${key}" が確認画面の対応表に無い（棚卸し漏れ）`);
  }
  // 対応表の各ラベルが実際に一覧へ出ていること。
  for (const [key, labels] of Object.entries(expectedLabelsByKey)) {
    for (const label of labels) {
      assert.ok(hasLabel(summary, label), `提出フィールド "${key}" の行 "${label}" が確認画面に無い`);
    }
  }
});

test("UIT1-C2: 0・指定なし・未入力を区別し、表示用に0へ丸めない", () => {
  const { draft } = setup();
  const raw = editable(draft);

  // 明示的な 0
  (raw.salesPlans as Record<string, unknown>[])[0].desiredQuantity = 0;
  // 指定なし（undefined）
  (raw.importOrders as Record<string, unknown>[])[0].leadTimeTurns = undefined;
  // 未入力（NaN）
  (raw.workerAssignments as Record<string, unknown>[])[0].temporaryHeadcount = Number.NaN;

  const summary = buildDecisionSummary({ draft: raw as unknown as CompanyDecisionDraft });
  const items = allItems(summary);

  const zeroItem = items.find((i) => i.label === "販売希望量" && i.state === "zero");
  assert.ok(zeroItem !== undefined, "明示的な0が zero として区別されていない");

  const unsetItem = items.find((i) => i.label === "輸入リードタイム" && i.state === "unset");
  assert.ok(unsetItem !== undefined, "指定なしが unset として区別されていない");
  assert.equal(unsetItem.value, "指定なし", "指定なしが0で表示されている");

  const invalidItem = items.find((i) => i.label === "臨時人数" && i.state === "invalid");
  assert.ok(invalidItem !== undefined, "未入力が invalid として区別されていない");
  assert.equal(invalidItem.value, "未入力", "未入力が0へ丸められて表示されている");
});

test("UIT1-C3: 数量0で提出されない行を隠さない", () => {
  const { draft } = setup();
  const raw = editable(draft);
  (raw.salesPlans as Record<string, unknown>[])[0].desiredQuantity = 0;
  (raw.productionPlans as Record<string, unknown>[])[0].desiredQuantity = 0;

  const summary = buildDecisionSummary({ draft: raw as unknown as CompanyDecisionDraft });
  const notSubmitted = allItems(summary).filter((i) => !i.submitted);
  assert.ok(notSubmitted.length > 0, "提出されない行が一覧に印されていない");
  assert.ok(
    notSubmitted.some((i) => i.note?.includes("提出されません") === true),
    "提出されない理由が書かれていない"
  );
  assert.ok(summary.notSubmittedNotes.length >= 2, "提出されない行がある旨の注意書きが足りない");

  // 実際の変換結果と件数が整合する（表示と提出が食い違わない）。
  const submittedSalesLabels = allItems(summary).filter((i) => i.label === "販売希望量" && i.submitted).length;
  const expected = (raw.salesPlans as Record<string, unknown>[]).filter((p) => Number(p.desiredQuantity) > 0).length;
  assert.equal(submittedSalesLabels, expected, "提出される販売計画の行数が変換結果と合わない");
});

test("UIT1-C4: 申請・予定・実行・確定済みを区別し、借入申請額を実行額として出さない", () => {
  const { draft } = setup();
  const summary = buildDecisionSummary({ draft });
  const items = allItems(summary);

  const loan = items.find((i) => i.label === "借入 希望額")!;
  assert.equal(loan.nature, "application", "借入希望額が申請として示されていない");
  assert.ok(loan.note?.includes("実行額ではありません") === true, "借入申請額が実行額ではない旨の注記が無い");

  const dividend = items.find((i) => i.label === "配当 希望額（PLAYERの指示）")!;
  assert.equal(dividend.nature, "application", "配当希望額が申請として示されていない");

  const hire = items.find((i) => i.label === "営業人員 採用数")!;
  assert.equal(hire.nature, "plan", "採用数が予定として示されていない");

  const temporary = items.find((i) => i.label === "臨時人数")!;
  assert.equal(temporary.nature, "direct", "臨時人数が当期実行として示されていない");

  // 「実行額」「実行される借入」のような断定表示をしていない。
  assert.ok(!items.some((i) => i.label.includes("借入実行")), "借入実行額という表示が出ている");
});

test("UIT1-C5: 管理者指定の配当がある場合は適用内容とPLAYERの編集範囲を示す", () => {
  const { draft } = setup();
  const guidance: AnnualDividendGuidance = {
    kind: "ADMIN_SPECIFIED",
    figures: {
      targetYear: 2026,
      currentQuarter: 2,
      adminPayoutRatio: 0.3,
      confirmedQuarterCount: 1,
      ytdNetIncomeUsd: 1_000_000,
      ytdReferenceDividendUsd: 300_000,
      ytdPaidDividendUsd: 0,
      referenceAdditionalUsd: 300_000,
      referencePayableUsd: 300_000,
      referenceCashAfterUsd: 700_000,
    },
  };
  const summary = buildDecisionSummary({ draft, annualDividendGuidance: guidance });
  const items = allItems(summary);

  const adminRatio = items.find((i) => i.label === "管理者指定の配当性向（PLAYERの入力ではありません）");
  assert.ok(adminRatio !== undefined, "管理者指定の配当が表示されていない");
  assert.equal(adminRatio.nature, "fixed", "管理者指定が確定済みとして示されていない");
  assert.equal(adminRatio.value, "30.0%");
  assert.ok(adminRatio.note?.includes("自動精算") === true, "自動精算される旨が書かれていない");
  assert.ok(adminRatio.note?.includes("PLAYERが編集できる") === true, "PLAYERが編集できる範囲が書かれていない");
  assert.equal(adminRatio.submitted, false, "管理者指定がPLAYERの提出値として示されている");

  // 管理者指定が無い場合は出さない（0%や既定率を捏造しない）。
  const noAdmin = buildDecisionSummary({ draft, annualDividendGuidance: { kind: "NO_ADMIN_SETTING", targetYear: 2026 } });
  assert.ok(!hasLabel(noAdmin, "管理者指定の配当性向（PLAYERの入力ではありません）"), "管理者指定が無いのに表示されている");
});

test("UIT1-C6: 設備投資は複数案件が分かる形で列挙される", () => {
  const { draft } = setup();
  const raw = editable(draft);
  (raw.capexDecision as Record<string, unknown>).newProjectProposals = [
    { projectType: "newStandardFactory", requestedBudgetUsd: 5_000_000, targetFactoryId: "F1", priority: 1 },
    { projectType: "pdMechanization", requestedBudgetUsd: 1_200_000, targetFactoryId: "F2" },
    { projectType: "qualityControlEquipment" },
  ];
  const summary = buildDecisionSummary({ draft: raw as unknown as CompanyDecisionDraft });
  const amounts = allItems(summary).filter((i) => i.label === "設備投資 申請額");
  assert.equal(amounts.length, 3, "投資案件が3件とも列挙されていない");
  assert.ok(amounts[0].target?.includes("案件 1") === true, "案件番号が付いていない");
  assert.ok(amounts[0].target?.includes("F1") === true, "対象工場が案件の見出しに出ていない");
  assert.equal(amounts[2].state, "unset", "申請額の指定なしが0として表示されている");

  // 対象工場の指定が無い案件は「指定なし（主工場）」と出す（推測しない）。
  const targets = allItems(summary).filter((i) => i.label === "対象工場");
  assert.ok(targets.some((i) => i.value === "指定なし（主工場）"), "対象工場の指定なしが示されていない");

  // 申請額合計は申請値の素の合計（審査結果ではない）。
  const total = summary.totals.find((t) => t.label === "設備投資 申請額 合計")!;
  assert.equal(total.value, "$6,200,000");
  assert.ok(total.note?.includes("審査結果（実行額）ではありません") === true, "申請額合計が実行額ではない旨の注記が無い");
});

test("UIT1-C7: 合計は提出値をそのまま足せるものだけで、資金予測を作らない", () => {
  const { draft } = setup();
  const summary = buildDecisionSummary({ draft });
  const labels = summary.totals.map((t) => t.label);
  assert.deepEqual(labels, ["提出される販売希望量 合計", "提出される営業配員 合計", "提出される生産希望量 合計", "設備投資 申請額 合計"]);
  // 新しい資金予測の類を作っていない。
  for (const label of labels) {
    assert.ok(!label.includes("予測"), `合計に予測が含まれている: ${label}`);
    assert.ok(!label.includes("見込みCash"), `合計に将来Cashの見込みが含まれている: ${label}`);
  }
  // 販売希望量の合計は、提出される行だけの素の合計と一致する。
  const expected = draft.salesPlans.filter((p) => p.desiredQuantity > 0).reduce((s, p) => s + p.desiredQuantity, 0);
  assert.equal(summary.totals[0].value, `${expected.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} t`);
});

test("UIT1-C8: 入力経路が無い意思決定を黙って欠落させない", () => {
  const { draft } = setup();
  const summary = buildDecisionSummary({ draft });
  assert.ok(summary.noInputPathNotes.length > 0, "入力経路が無い意思決定の説明が無い");
  assert.ok(
    summary.noInputPathNotes.some((n) => n.includes("休止") && n.includes("売却")),
    "工場の休止・売却に入力欄が無いことが説明されていない"
  );
});

test("UIT1-C9【描画】: 会社名・対象Turn・分野別の「修正する」・未提出の明示が出る", () => {
  const { draft, fixture } = setup();
  const summary = buildDecisionSummary({ draft });
  const html = renderToStaticMarkup(
    React.createElement(DecisionConfirmationScreen, {
      summary,
      companyName: fixture.displayName,
      companyId: fixture.companyId,
      turnLabel: "Turn 1（2026-Q1）",
      copy: { heading: "提出内容の最終確認", commitLabel: "この内容で提出", committingLabel: "提出中…", description: "説明" },
      validationErrors: [],
      onEdit: () => {},
      onBack: () => {},
      onCommit: () => {},
      committing: false,
      commitError: null,
    })
  );
  assert.ok(html.includes('data-testid="decision-confirmation-screen"'));
  assert.ok(html.includes(fixture.displayName), "会社名が出ていない");
  assert.ok(html.includes("Turn 1（2026-Q1）"), "対象Turn／四半期が出ていない");
  assert.ok(html.includes('data-testid="decision-confirmation-not-submitted-yet"'), "まだ提出されていない旨の表示が無い");
  // 節ごとに「修正する」がある（1つの入力画面に複数の節が対応するため節単位）。
  for (const key of ["sales-staffing", "sales-plans", "sales-hiring", "production", "worker", "procurement", "investment", "finance"]) {
    assert.ok(html.includes(`data-testid="decision-confirmation-edit-${key}"`), `「修正する」が無い: ${key}`);
  }
  // 確定/提出ボタンは押せる状態。
  assert.ok(html.includes('data-testid="decision-confirmation-commit"'));
  assert.ok(!isCommitDisabled(html), "検証エラーが無いのにボタンが無効になっている");
});

test("UIT1-C10【描画】: 検証エラーがあるときは項目名と理由を出し、確定/提出を押せない", () => {
  const { draft, fixture } = setup();
  const summary = buildDecisionSummary({ draft });
  const html = renderToStaticMarkup(
    React.createElement(DecisionConfirmationScreen, {
      summary,
      companyName: fixture.displayName,
      companyId: fixture.companyId,
      turnLabel: "Turn 1（2026-Q1）",
      copy: { heading: "提出内容の最終確認", commitLabel: "この内容で提出", committingLabel: "提出中…", description: "説明" },
      validationErrors: ["販売希望量（CN × HOSO）: 未入力です", "残業率（F1）: 0〜1 の範囲で入力してください"],
      onEdit: () => {},
      onBack: () => {},
      onCommit: () => {},
      committing: false,
      commitError: null,
    })
  );
  assert.ok(html.includes('data-testid="decision-confirmation-validation-errors"'), "検証エラーの表示が無い");
  assert.ok(html.includes("販売希望量（CN × HOSO）: 未入力です"), "項目名と理由が出ていない");
  assert.ok(html.includes("入力は保持しています"), "入力が保持される旨が書かれていない");
  assert.ok(isCommitDisabled(html), "検証エラーがあるのに提出ボタンが押せる");
});

test("UIT1-C11【描画】: 実行中はボタンを押せない（二重クリックによる重複送信の防止）", () => {
  const { draft, fixture } = setup();
  const summary = buildDecisionSummary({ draft });
  const html = renderToStaticMarkup(
    React.createElement(DecisionConfirmationScreen, {
      summary,
      companyName: fixture.displayName,
      companyId: fixture.companyId,
      turnLabel: "Turn 1（2026-Q1）",
      copy: { heading: "提出内容の最終確認", commitLabel: "この内容で提出", committingLabel: "提出中…", description: "説明" },
      validationErrors: [],
      onEdit: () => {},
      onBack: () => {},
      onCommit: () => {},
      committing: true,
      commitError: null,
    })
  );
  assert.ok(isCommitDisabled(html), "実行中にボタンが押せる（重複送信の恐れ）");
  assert.ok(html.includes("提出中…"), "実行中の表示になっていない");
});

test("UIT1-C12【描画】: 確認中にTurnが進んだ場合は古い内容を提出させない", () => {
  const { draft, fixture } = setup();
  const summary = buildDecisionSummary({ draft });
  const html = renderToStaticMarkup(
    React.createElement(DecisionConfirmationScreen, {
      summary,
      companyName: fixture.displayName,
      companyId: fixture.companyId,
      turnLabel: "Turn 1（2026-Q1）",
      copy: { heading: "提出内容の最終確認", commitLabel: "この内容で提出", committingLabel: "提出中…", description: "説明" },
      validationErrors: [],
      onEdit: () => {},
      onBack: () => {},
      onCommit: () => {},
      committing: false,
      commitError: null,
      staleNotice: "確認中にTurnが進みました（確認したのは Turn 1、現在は Turn 2）。",
    })
  );
  assert.ok(html.includes('data-testid="decision-confirmation-stale"'), "Turn進行の注意が出ていない");
  assert.ok(isCommitDisabled(html), "Turnが進んだのに提出できる");
});

test("UIT1-C13: 確認画面は自分ではサーバーへ通信しない（開いただけで提出・取得が起きない）", () => {
  const source = readFileSync(
    path.join(process.cwd(), "app/v2/company-lab/components/decisionStudio/DecisionConfirmationScreen.tsx"),
    "utf8"
  );
  // 取得・送信・定期実行をこの画面自身が持たない（BW-1の条件付き取得にも影響しない）。
  for (const forbidden of ["fetch(", "useEffect", "setInterval", "setTimeout", "XMLHttpRequest"]) {
    assert.ok(!source.includes(forbidden), `確認画面が ${forbidden} を持っている（開いただけで通信・副作用が起きる恐れ）`);
  }
});

test("UIT1-C14: 一覧は下書きだけから作る（前期実績やAIの影の判断を提出値として混ぜない）", () => {
  const source = readFileSync(path.join(process.cwd(), "app/v2/company-lab/decisionSummary.ts"), "utf8");
  // 入力は draft（＋管理者指定配当の既存契約）だけ。
  const forbidden = ["generateStandardAiDecision", "autoPolicy", "state.history", "companySummaries"];
  for (const f of forbidden) {
    assert.ok(!source.includes(f), `確認画面の一覧が ${f} を参照している（提出値ではないものを混ぜている）`);
  }
});

test("UIT1-C15: 節の識別子は一意（「修正する」が複数一致しない）", () => {
  const { draft } = setup();
  const summary = buildDecisionSummary({ draft });
  const keys = summary.sections.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length, `節の識別子が重複している: ${keys.join(", ")}`);
  // 1つの入力画面へ複数の節が対応することは許す（SALESは3節）。
  const salesSections = summary.sections.filter((s) => s.screen === "sales");
  assert.ok(salesSections.length >= 2, "前提: SALES画面に複数の節が対応している");
  for (const section of summary.sections) {
    assert.ok(section.key.length > 0, "節の識別子が空");
  }
});

// ---------------------------------------------------------------------
// UI-TRIAL-1 §2（限定仕上げ）: 確認画面の説明を実際の提出挙動に合わせる
//
// 実測（scripts/int1/probeSalesForceZeroRows.ts）:
//   ・市場の商品行が1つでも数量>0 → その市場の営業配員は提出される
//   ・市場の全商品行が数量0       → その市場の行自体が落ち、配員も提出されない
// 画面の「配員済み」は下書きの合計なので、後者では提出値と食い違う。
// ---------------------------------------------------------------------

test("UIT1-C16: 全商品が数量0の市場は、営業配員も提出されないと示す", () => {
  const { draft, fixture, state } = setup();
  const raw = editable(draft);
  // CN市場の全商品を0にし、配員だけ9人入れる。
  for (const row of raw.salesPlans as Record<string, unknown>[]) {
    if (row.market === "CN") {
      row.desiredQuantity = 0;
      row.salesForceHeadcount = 9;
    }
  }
  const filled = raw as unknown as CompanyDecisionDraft;
  const summary = buildDecisionSummary({ draft: filled });

  const cn = allItems(summary).find((i) => i.label === "営業配員" && i.target === "CN市場")!;
  assert.equal(cn.submitted, false, "全商品0の市場の配員が提出されると表示されている");
  assert.ok(cn.note?.includes("提出されません") === true, "提出されない理由が書かれていない");
  assert.ok(
    summary.notSubmittedNotes.some((n) => n.includes("営業配員") && n.includes("CN")),
    "提出されない営業配員の注意書きが無い"
  );

  // 他の市場は提出される。
  const other = allItems(summary).filter((i) => i.label === "営業配員" && i.target !== "CN市場");
  assert.ok(other.length > 0 && other.every((i) => i.submitted), "他市場の配員まで提出されない扱いになっている");

  // 合計は実際に提出される配員と一致する（実測の engine 集計と同じ数え方）。
  const decision = buildDecisionInputFromDraft(filled, fixture, state.currentPeriod);
  const byMarket = new Map<string, number>();
  for (const p of decision.salesPlans) byMarket.set(p.market, p.salesForceHeadcount);
  const engineTotal = Array.from(byMarket.values()).reduce((sum, h) => sum + h, 0);
  const total = summary.totals.find((t) => t.label === "提出される営業配員 合計")!;
  assert.equal(total.value, `${engineTotal.toLocaleString("en-US")} 人`, "合計が実際の提出値と一致しない");
  assert.ok(total.note?.includes("提出されない") === true, "入力の合計との差の説明が無い");
});

test("UIT1-C17: 1商品でも数量があれば、その市場の営業配員は提出される", () => {
  const { draft, fixture, state } = setup();
  const raw = editable(draft);
  for (const row of raw.salesPlans as Record<string, unknown>[]) {
    if (row.market === "CN") {
      row.desiredQuantity = row.product === "hoso" ? 100 : 0;
      row.salesForceHeadcount = 9;
    }
  }
  const filled = raw as unknown as CompanyDecisionDraft;
  const summary = buildDecisionSummary({ draft: filled });
  const cn = allItems(summary).find((i) => i.label === "営業配員" && i.target === "CN市場")!;
  assert.equal(cn.submitted, true, "1商品に数量があるのに配員が提出されない扱いになっている");

  const decision = buildDecisionInputFromDraft(filled, fixture, state.currentPeriod);
  const submittedCn = decision.salesPlans.filter((p) => p.market === "CN");
  assert.equal(submittedCn.length, 1, "前提: CNは1行だけ提出される");
  assert.equal(submittedCn[0].salesForceHeadcount, 9, "前提: 提出行が配員を運ぶ");

  const byMarket = new Map<string, number>();
  for (const p of decision.salesPlans) byMarket.set(p.market, p.salesForceHeadcount);
  const engineTotal = Array.from(byMarket.values()).reduce((sum, h) => sum + h, 0);
  const total = summary.totals.find((t) => t.label === "提出される営業配員 合計")!;
  assert.equal(total.value, `${engineTotal.toLocaleString("en-US")} 人`);
});

test("UIT1-C18: 工場×商品ごとの生産の優先順位も一覧に出る", () => {
  const { draft } = setup();
  const summary = buildDecisionSummary({ draft });
  const priorities = allItems(summary).filter((i) => i.label === "生産の優先順位");
  assert.equal(priorities.length, draft.productionPlans.length, "優先順位の行数が生産計画の行数と一致しない");
  for (const row of draft.productionPlans) {
    const found = priorities.find((i) => i.target === `${row.factoryId} × ${row.product.toUpperCase()}`);
    assert.ok(found !== undefined, `優先順位が無い: ${row.factoryId}/${row.product}`);
  }
  // 数量0で落ちる行は、優先順位も提出されない扱いになる。
  const raw = editable(draft);
  (raw.productionPlans as Record<string, unknown>[])[0].desiredQuantity = 0;
  const withZero = buildDecisionSummary({ draft: raw as unknown as CompanyDecisionDraft });
  const first = (raw.productionPlans as Record<string, unknown>[])[0];
  const target = `${String(first.factoryId)} × ${String(first.product).toUpperCase()}`;
  const zeroPriority = allItems(withZero).find((i) => i.label === "生産の優先順位" && i.target === target)!;
  assert.equal(zeroPriority.submitted, false, "数量0で落ちる行の優先順位が提出される扱いになっている");
});

test("UIT1-C19: 管理者指定の配当とPLAYER自身の配当指示が文言で区別される", () => {
  const { draft } = setup();
  const guidance: AnnualDividendGuidance = {
    kind: "ADMIN_SPECIFIED",
    figures: {
      targetYear: 2026, currentQuarter: 2, adminPayoutRatio: 0.3, confirmedQuarterCount: 1,
      ytdNetIncomeUsd: 1_000_000, ytdReferenceDividendUsd: 300_000, ytdPaidDividendUsd: 0,
      referenceAdditionalUsd: 300_000, referencePayableUsd: 300_000, referenceCashAfterUsd: 700_000,
    },
  };
  const summary = buildDecisionSummary({ draft, annualDividendGuidance: guidance });
  const items = allItems(summary);

  const player = items.find((i) => i.label === "配当 希望額（PLAYERの指示）")!;
  assert.equal(player.submitted, true, "PLAYERの配当が提出対象になっていない");
  assert.ok(player.note?.includes("管理者指定") === true, "管理者指定との関係が書かれていない");
  assert.ok(player.note?.includes("打ち消しません") === true, "互いを打ち消さないことが書かれていない");

  const admin = items.find((i) => i.label === "管理者指定の配当性向（PLAYERの入力ではありません）")!;
  assert.equal(admin.submitted, false, "管理者指定がPLAYERの提出値として示されている");
  assert.notEqual(player.nature, admin.nature, "PLAYERの指示と管理者指定が同じ区分で示されている");
});

test("UIT1-C20: 工場操作の説明は、確認できた事実（どの経路でも提出できない）に合わせる", () => {
  const { draft } = setup();
  const summary = buildDecisionSummary({ draft });
  const note = summary.noInputPathNotes.find((n) => n.includes("休止"))!;
  assert.ok(note !== undefined, "工場操作の説明が無い");
  assert.ok(note.includes("PLAYER画面") && note.includes("GM画面"), "どの画面にも無いことが書かれていない");
  assert.ok(note.includes("どの経路からも提出されません"), "どの経路でも提出できないことが書かれていない");
  // 未統合branchの話は画面へ書かない（利用者の操作に関係しない）。
  assert.ok(!note.includes("branch") && !note.includes("ブランチ"), "画面の説明にbranchの話が混ざっている");
});
