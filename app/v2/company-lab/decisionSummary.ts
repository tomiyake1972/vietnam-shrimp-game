// ShrimpX V2 — 提出前の最終確認に出す「提出内容の一覧」（UI-TRIAL-1 §5）
//
// 【なぜ必要か】予行演習の準備で「何を提出するのか分からない」という指摘を受けた。
// 入力画面は7つに分かれているため、提出の直前に全部を一覧で見せる場所が無かった。
//
// 【この層は計算しない】ここがやるのは、提出される下書き（CompanyDecisionDraft）を
// 読んで、人が読める行へ並べ替えることだけ。新しい資金予測・新しい見積りは作らない。
// 合計は「提出値をそのまま足すだけで確実に出せるもの」に限る。
//
// 【buildDecisionInputFromDraft と対応させる】実際に提出されるのは
// buildDecisionInputFromDraft の結果であり、そこには
//   - 販売計画 … desiredQuantity が 0 以下の行は落ちる
//   - 輸入発注 … orderedQuantity が 0 以下の行は落ちる
//   - 生産計画 … desiredQuantity が 0 以下の行は落ちる
// という既存の絞り込みがある。一覧では落ちる行にもその旨を書き、
// 「入れたのに提出されていない」が黙って起きないようにする。
//
// 【0・指定なし・未入力を区別する】0 は正当な意思決定、未入力（空欄・非数）は
// 提出を止める対象、指定なし（undefined）は省略。表示用に 0 へ丸めない。

import { CompanyDecisionDraft } from "./decisionDraft";
import { DecisionStudioScreenKey } from "./components/decisionStudio/DecisionStudioNavigation";
import { AnnualDividendGuidance } from "../../lib/v2/finance/annualDividendGuidance";

/** 値の状態。表示用に 0 へ丸めないために、値そのものとは別に持つ。 */
export type SummaryValueState =
  /** 値が入っている（0 以外）。 */
  | "value"
  /** 明示的な 0（正当な意思決定）。 */
  | "zero"
  /** 指定なし（undefined。省略された項目）。 */
  | "unset"
  /** 未入力・不正値（空欄・NaN・Infinity）。提出は止まる。 */
  | "invalid";

/** その値が何なのか。申請・予定・確定済みを混同させない。 */
export type SummaryNature =
  /** 申請（通るかどうかは審査・上限次第。実行額ではない）。 */
  | "application"
  /** 予定（次の四半期から効く等、今期の結果ではない）。 */
  | "plan"
  /** 今期そのまま実行される意思決定。 */
  | "direct"
  /** すでに確定している適用内容（PLAYERの入力ではない）。 */
  | "fixed";

export const SUMMARY_NATURE_LABELS: Readonly<Record<SummaryNature, string>> = {
  application: "申請",
  plan: "予定",
  direct: "実行",
  fixed: "確定済み",
};

export interface DecisionSummaryItem {
  readonly label: string;
  /** 対象（市場／商品／工場／案件）。狭い画面でも所属が分かるように必ず入れる。 */
  readonly target?: string;
  readonly value: string;
  readonly unit?: string;
  readonly state: SummaryValueState;
  readonly nature: SummaryNature;
  /** 補足（この行が提出されない理由など）。 */
  readonly note?: string;
  /** 提出対象に含まれるか（既存の絞り込みの結果）。 */
  readonly submitted: boolean;
}

export interface DecisionSummarySection {
  /**
   * 節を一意に識別する鍵。
   * 1つの入力画面（例 SALES）に複数の節が対応するため、screen とは別に持つ
   * （screen を識別子に使うと「修正する」ボタンが複数一致してしまう）。
   */
  readonly key: string;
  /** 「修正する」で戻る先の画面。 */
  readonly screen: DecisionStudioScreenKey;
  readonly title: string;
  readonly items: readonly DecisionSummaryItem[];
  /** 項目が無いときの説明（0件であることを「何も無い」と誤解させない）。 */
  readonly emptyNote?: string;
}

export interface DecisionSummaryTotal {
  readonly label: string;
  readonly value: string;
  readonly note?: string;
}

export interface DecisionSummary {
  readonly sections: readonly DecisionSummarySection[];
  /** 提出値をそのまま足すだけで出せる合計のみ。 */
  readonly totals: readonly DecisionSummaryTotal[];
  /** 提出されない行があるときの注意書き。 */
  readonly notSubmittedNotes: readonly string[];
  /** この画面からは提出できない（入力経路が無い）意思決定の説明。 */
  readonly noInputPathNotes: readonly string[];
}

function stateOf(n: number | undefined): SummaryValueState {
  if (n === undefined) return "unset";
  if (!Number.isFinite(n)) return "invalid";
  return n === 0 ? "zero" : "value";
}

function num(n: number | undefined, fractionDigits = 0): string {
  if (n === undefined) return "指定なし";
  if (!Number.isFinite(n)) return "未入力";
  return n.toLocaleString("en-US", { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits });
}

function usd(n: number | undefined): string {
  if (n === undefined) return "指定なし";
  if (!Number.isFinite(n)) return "未入力";
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

function signedNum(n: number | undefined): string {
  if (n === undefined) return "指定なし";
  if (!Number.isFinite(n)) return "未入力";
  if (n === 0) return "0";
  return n > 0 ? `+${n.toLocaleString("en-US")}` : `−${Math.abs(n).toLocaleString("en-US")}`;
}

function ratio(n: number | undefined): string {
  if (n === undefined) return "指定なし";
  if (!Number.isFinite(n)) return "未入力";
  return n.toFixed(2);
}

/** 既存の絞り込み（数量0以下の行は提出されない）と同じ判定。 */
function isDroppedByQuantity(quantity: number): boolean {
  return !(Number.isFinite(quantity) && quantity > 0);
}

export interface BuildDecisionSummaryInput {
  readonly draft: CompanyDecisionDraft;
  /** 管理者指定の配当がある場合の既存契約（無ければ渡さない）。 */
  readonly annualDividendGuidance?: AnnualDividendGuidance | null;
}

export function buildDecisionSummary({ draft, annualDividendGuidance }: BuildDecisionSummaryInput): DecisionSummary {
  const sections: DecisionSummarySection[] = [];
  const notSubmittedNotes: string[] = [];

  // ---- SALES: 市場別営業配員 ----
  //
  // 【実測で確認した挙動（scripts/int1/probeSalesForceZeroRows.ts）】
  // 営業配員は salesPlans の各行が持つ値として提出される。
  // buildDecisionInputFromDraft は数量0以下の行を落とすため、
  //   ・その市場の商品行が1つでも数量>0 … その市場の配員は提出される（市場ごとに1回数える）
  //   ・その市場の全商品行が数量0     … その市場の行自体が無くなり、配員は提出されない
  // 画面の「配員済み」は下書きの合計なので、後者では提出値と食い違う。
  // ここで市場ごとに「提出されるか」を判定し、食い違いを隠さない。
  const marketHeadcounts = new Map<string, number>();
  const marketHasSubmittedRow = new Map<string, boolean>();
  for (const row of draft.salesPlans) {
    if (!marketHeadcounts.has(row.market)) marketHeadcounts.set(row.market, row.salesForceHeadcount);
    if (!isDroppedByQuantity(row.desiredQuantity)) marketHasSubmittedRow.set(row.market, true);
  }
  const salesStaffingItems: DecisionSummaryItem[] = Array.from(marketHeadcounts.entries()).map(([market, headcount]) => {
    const submitted = marketHasSubmittedRow.get(market) === true;
    return {
      label: "営業配員",
      target: `${market}市場`,
      value: num(headcount),
      unit: "人",
      state: stateOf(headcount),
      nature: "direct" as const,
      submitted,
      note: submitted
        ? undefined
        : "この市場の販売希望量がすべて0のため、この配員は提出されません（配員は販売計画の行に添えて送られます）。配置するなら、この市場のいずれかの商品に数量を入れてください。",
    };
  });
  const unsubmittedStaffingMarkets = Array.from(marketHeadcounts.entries()).filter(
    ([market, headcount]) => marketHasSubmittedRow.get(market) !== true && Number.isFinite(headcount) && headcount > 0
  );
  if (unsubmittedStaffingMarkets.length > 0) {
    notSubmittedNotes.push(
      `営業配員のうち ${unsubmittedStaffingMarkets.map(([m, h]) => `${m}市場 ${h}人`).join(" / ")} は、` +
        "その市場の販売希望量がすべて0のため提出されません。"
    );
  }
  sections.push({ key: "sales-staffing", screen: "sales", title: "市場別の営業配員", items: salesStaffingItems, emptyNote: "対象となる市場がありません。" });

  // ---- SALES: 市場×商品別 販売数量・価格調整 ----
  const salesPlanItems: DecisionSummaryItem[] = [];
  let droppedSalesRows = 0;
  for (const row of draft.salesPlans) {
    const dropped = isDroppedByQuantity(row.desiredQuantity);
    if (dropped && Number.isFinite(row.desiredQuantity)) droppedSalesRows += 1;
    salesPlanItems.push({
      label: "販売希望量",
      target: `${row.market} × ${row.product.toUpperCase()}`,
      value: num(row.desiredQuantity, 2),
      unit: "t",
      state: stateOf(row.desiredQuantity),
      nature: "plan",
      submitted: !dropped,
      note: dropped && Number.isFinite(row.desiredQuantity) ? "数量が0のため、この行は提出されません（価格調整も一緒に提出されません）。" : undefined,
    });
    salesPlanItems.push({
      label: "価格調整",
      target: `${row.market} × ${row.product.toUpperCase()}`,
      value: Number.isFinite(row.priceAdjustmentUsdPerHosoEqKg) ? `${row.priceAdjustmentUsdPerHosoEqKg >= 0 ? "+" : "−"}$${Math.abs(row.priceAdjustmentUsdPerHosoEqKg).toFixed(2)}` : "未入力",
      unit: "/kg",
      state: stateOf(row.priceAdjustmentUsdPerHosoEqKg),
      nature: "plan",
      submitted: !dropped,
    });
  }
  if (droppedSalesRows > 0) {
    notSubmittedNotes.push(`販売計画のうち ${droppedSalesRows} 行は数量が0のため提出されません（既存の処理と同じ扱いです）。`);
  }
  sections.push({ key: "sales-plans", screen: "sales", title: "市場×商品別の販売数量・価格調整", items: salesPlanItems });

  // ---- SALES: 採用・減員 ----
  sections.push({
    key: "sales-hiring",
    screen: "sales",
    title: "営業人員の採用・減員",
    items: [
      {
        label: "営業人員 採用数",
        target: "全社",
        value: num(draft.salesForceHireCount ?? 0),
        unit: "人",
        state: stateOf(draft.salesForceHireCount ?? 0),
        nature: "plan",
        submitted: true,
        note: "次の四半期から配員できるようになります（当期の配員可能人数は増えません）。",
      },
      {
        label: "営業人員 減員数",
        target: "全社",
        value: num(draft.salesForceLayoffCount ?? 0),
        unit: "人",
        state: stateOf(draft.salesForceLayoffCount ?? 0),
        nature: "plan",
        submitted: true,
        note: "当期は配員・給与の対象のままで、次の四半期から減ります（退職金は当期に発生）。",
      },
    ],
  });

  // ---- PRODUCTION: 工場×商品別 生産計画 ----
  const productionItems: DecisionSummaryItem[] = [];
  let droppedProductionRows = 0;
  for (const row of draft.productionPlans) {
    const dropped = isDroppedByQuantity(row.desiredQuantity);
    if (dropped && Number.isFinite(row.desiredQuantity)) droppedProductionRows += 1;
    productionItems.push({
      label: "生産希望量",
      target: `${row.factoryId} × ${row.product.toUpperCase()}`,
      value: num(row.desiredQuantity, 2),
      unit: "t",
      state: stateOf(row.desiredQuantity),
      nature: "plan",
      submitted: !dropped,
      note: dropped && Number.isFinite(row.desiredQuantity) ? "数量が0のため、この行は提出されません。" : undefined,
    });
    // 優先順位も提出される（能力が足りないときにどの行から処理するかを決める）。
    // 未入力・非数は提出時に1へ丸められるため、その旨も書く。
    productionItems.push({
      label: "生産の優先順位",
      target: `${row.factoryId} × ${row.product.toUpperCase()}`,
      value: num(row.priority),
      state: stateOf(row.priority),
      nature: "plan",
      submitted: !dropped,
      note: Number.isFinite(row.priority)
        ? "能力が足りないときに、どの行から処理するかの順位です。"
        : "未入力のため、提出時に 1 として扱われます。",
    });
  }
  if (droppedProductionRows > 0) {
    notSubmittedNotes.push(`生産計画のうち ${droppedProductionRows} 行は数量が0のため提出されません（既存の処理と同じ扱いです）。`);
  }
  sections.push({ key: "production", screen: "production", title: "工場×商品別の生産計画", items: productionItems, emptyNote: "生産計画の行がありません。" });

  // ---- WORKER: 工場別 人員配置・増減員・残業率 ----
  const workerItems: DecisionSummaryItem[] = [];
  for (const row of draft.workerAssignments) {
    const before = row.regularHeadcountBefore ?? row.regularHeadcount;
    workerItems.push({
      label: "常用人数 増員／減員",
      target: row.factoryId,
      value: signedNum(row.regularHeadcountChange),
      unit: "人",
      state: stateOf(row.regularHeadcountChange),
      nature: "direct",
      submitted: true,
      note: `前期末 ${num(before)}人 → 提出する常用人数 ${num(row.regularHeadcount)}人`,
    });
    workerItems.push({
      label: "臨時人数",
      target: row.factoryId,
      value: num(row.temporaryHeadcount),
      unit: "人",
      state: stateOf(row.temporaryHeadcount),
      nature: "direct",
      submitted: true,
    });
    workerItems.push({
      label: "残業率",
      target: row.factoryId,
      value: ratio(row.overtimeRate),
      state: stateOf(row.overtimeRate),
      nature: "direct",
      submitted: true,
    });
  }
  sections.push({ key: "worker", screen: "worker", title: "工場別の人員配置・増減員・残業率", items: workerItems, emptyNote: "対象となる工場がありません。" });

  // ---- PROCUREMENT: 国内買付・輸入・養殖 ----
  const procurementItems: DecisionSummaryItem[] = [
    {
      label: "国内買付 希望量",
      target: "国内",
      value: num(draft.domesticPurchase.desiredQuantity, 2),
      unit: "t",
      state: stateOf(draft.domesticPurchase.desiredQuantity),
      nature: "plan",
      submitted: true,
    },
    {
      label: "国内買付 価格調整",
      target: "国内",
      value: Number.isFinite(draft.domesticPurchase.priceAdjustmentUsdPerHosoEqKg)
        ? `${draft.domesticPurchase.priceAdjustmentUsdPerHosoEqKg >= 0 ? "+" : "−"}$${Math.abs(draft.domesticPurchase.priceAdjustmentUsdPerHosoEqKg).toFixed(2)}`
        : "未入力",
      unit: "/kg",
      state: stateOf(draft.domesticPurchase.priceAdjustmentUsdPerHosoEqKg),
      nature: "plan",
      submitted: true,
    },
    {
      label: "買付担当人数",
      target: "国内",
      value: num(draft.domesticPurchase.procurementHeadcount),
      unit: "人",
      state: stateOf(draft.domesticPurchase.procurementHeadcount),
      nature: "direct",
      submitted: true,
    },
  ];
  let droppedImportRows = 0;
  for (const row of draft.importOrders) {
    const dropped = isDroppedByQuantity(row.orderedQuantity);
    if (dropped && Number.isFinite(row.orderedQuantity)) droppedImportRows += 1;
    procurementItems.push({
      label: "輸入発注量",
      target: row.originCountry,
      value: num(row.orderedQuantity, 2),
      unit: "t",
      state: stateOf(row.orderedQuantity),
      nature: "direct",
      submitted: !dropped,
      note: dropped && Number.isFinite(row.orderedQuantity) ? "数量が0のため、この行は提出されません。" : undefined,
    });
    procurementItems.push({
      label: "輸入リードタイム",
      target: row.originCountry,
      value: row.leadTimeTurns === undefined ? "指定なし" : num(row.leadTimeTurns),
      unit: row.leadTimeTurns === undefined ? undefined : "Turn",
      state: stateOf(row.leadTimeTurns),
      nature: "direct",
      submitted: !dropped,
      note: row.leadTimeTurns === undefined ? "指定なしのため、既定のリードタイムが使われます。" : undefined,
    });
  }
  if (droppedImportRows > 0) {
    notSubmittedNotes.push(`輸入発注のうち ${droppedImportRows} 行は数量が0のため提出されません（既存の処理と同じ扱いです）。`);
  }
  draft.aquacultureStockingPlans.forEach((row, index) => {
    const target = draft.aquacultureStockingPlans.length > 1 ? `養殖計画 ${index + 1}` : "養殖";
    procurementItems.push({
      label: "養殖 投入量",
      target,
      value: num(row.plannedStockingQuantity, 2),
      unit: "t",
      state: stateOf(row.plannedStockingQuantity),
      nature: "plan",
      submitted: true,
    });
    procurementItems.push({
      label: "養殖 集約度",
      target,
      value: ratio(row.aquacultureIntensity),
      state: stateOf(row.aquacultureIntensity),
      nature: "direct",
      submitted: true,
    });
    procurementItems.push({
      label: "養殖 防疫水準",
      target,
      value: ratio(row.bioSecurityLevel),
      state: stateOf(row.bioSecurityLevel),
      nature: "direct",
      submitted: true,
    });
  });
  sections.push({ key: "procurement", screen: "procurement", title: "国内買付・輸入・養殖", items: procurementItems });

  // ---- INVESTMENT: 設備投資案件（複数案件が分かる形で列挙） ----
  const investmentItems: DecisionSummaryItem[] = [];
  draft.capexDecision.newProjectProposals.forEach((proposal, index) => {
    const target = `案件 ${index + 1}: ${proposal.projectType}${proposal.targetFactoryId !== undefined ? ` / ${proposal.targetFactoryId}` : ""}`;
    investmentItems.push({
      label: "設備投資 申請額",
      target,
      value: usd(proposal.requestedBudgetUsd),
      state: stateOf(proposal.requestedBudgetUsd),
      nature: "application",
      submitted: true,
      note:
        proposal.requestedBudgetUsd === undefined
          ? "申請額の指定なし（案件の標準額が使われます）。審査で減額・否認されることがあります。"
          : "申請額です。審査で減額・否認されることがあります（実行額ではありません）。",
    });
    if (proposal.targetFactoryId === undefined) {
      investmentItems.push({
        label: "対象工場",
        target,
        value: "指定なし（主工場）",
        state: "unset",
        nature: "application",
        submitted: true,
      });
    } else {
      investmentItems.push({
        label: "対象工場",
        target,
        value: proposal.targetFactoryId,
        state: "value",
        nature: "application",
        submitted: true,
      });
    }
    if (proposal.priority !== undefined) {
      investmentItems.push({
        label: "優先度",
        target,
        value: num(proposal.priority),
        state: stateOf(proposal.priority),
        nature: "application",
        submitted: true,
      });
    }
  });
  for (const cancel of draft.capexDecision.cancelRequests) {
    investmentItems.push({ label: "投資案件の取消申請", target: cancel.projectId, value: "取消を申請", state: "value", nature: "application", submitted: true });
  }
  for (const resume of draft.capexDecision.resumeRequests) {
    investmentItems.push({ label: "投資案件の再開申請", target: resume.projectId, value: "再開を申請", state: "value", nature: "application", submitted: true });
  }
  investmentItems.push({
    label: "VAP商品開発費",
    target: "全社",
    value: usd(draft.vapProductDevelopmentSpendUsd),
    state: stateOf(draft.vapProductDevelopmentSpendUsd),
    nature: "direct",
    submitted: true,
    note: "$0 / $100,000 / $250,000 / $500,000 のいずれか。それ以外は0として扱われます。",
  });
  sections.push({
    key: "investment",
    screen: "investment",
    title: "設備投資・商品開発",
    items: investmentItems,
    emptyNote: "新規の投資案件はありません。",
  });

  // ---- FINANCE: 借入申請・返済・配当 ----
  const financeItems: DecisionSummaryItem[] = [
    {
      label: "借入 希望額",
      target: "全社",
      value: usd(draft.financingRequest.desiredAmountUsd),
      state: stateOf(draft.financingRequest.desiredAmountUsd),
      nature: "application",
      submitted: true,
      note: "申請額です。銀行審査で減額・否認されることがあります（実行額ではありません）。",
    },
    {
      label: "借入 種別",
      target: "全社",
      value: draft.financingRequest.desiredLoanType,
      state: "value",
      nature: "application",
      submitted: true,
    },
    {
      label: "借入 期間",
      target: "全社",
      value: num(draft.financingRequest.desiredTermQuarters),
      unit: "四半期",
      state: stateOf(draft.financingRequest.desiredTermQuarters),
      nature: "application",
      submitted: true,
    },
    {
      label: "借入 返済方式",
      target: "全社",
      value: draft.financingRequest.desiredRepaymentMethod,
      state: "value",
      nature: "application",
      submitted: true,
    },
    {
      label: "期限前返済額",
      target: "全社",
      value: usd(draft.financingRequest.desiredPrepaymentUsd),
      state: stateOf(draft.financingRequest.desiredPrepaymentUsd),
      nature: "direct",
      submitted: true,
    },
    {
      label: "緊急融資の利用",
      target: "全社",
      value: draft.financingRequest.emergencyAcceptable ? "許可する" : "許可しない",
      state: "value",
      nature: "application",
      submitted: true,
    },
    {
      label: "配当 希望額（PLAYERの指示）",
      target: "全社・当四半期",
      value: usd(draft.dividendAmountUsd ?? 0),
      state: stateOf(draft.dividendAmountUsd ?? 0),
      nature: "application",
      submitted: true,
      note:
        annualDividendGuidance?.kind === "ADMIN_SPECIFIED"
          ? "あなたが当四半期に出す配当の申請です。下の管理者指定（年度末の自動精算）とは別の指示で、互いを打ち消しません。配当可能額を超える場合は全額が拒否されます（実行額ではありません）。"
          : "申請額です。配当可能額を超える場合は全額が拒否されます（実行額ではありません）。",
    },
  ];
  if (annualDividendGuidance?.kind === "ADMIN_SPECIFIED") {
    const f = annualDividendGuidance.figures;
    financeItems.push({
      label: "管理者指定の配当性向（PLAYERの入力ではありません）",
      target: `${f.targetYear}年度`,
      value: `${(f.adminPayoutRatio * 100).toFixed(1)}%`,
      state: "value",
      nature: "fixed",
      submitted: false,
      note:
        "管理者が指定しているため、Q4決算直後に年間純利益ベースで自動精算されます。" +
        "上の「配当 希望額」はPLAYERが編集できる当期ぶんの申請であり、この自動精算を打ち消すものではありません。",
    });
    financeItems.push({
      label: "年初来実績ベースの参考配当額",
      target: `${f.targetYear}年度`,
      value: usd(f.ytdReferenceDividendUsd),
      state: "value",
      nature: "fixed",
      submitted: false,
      note: `確定済み ${f.confirmedQuarterCount} 四半期の実績から算出した参考値です（将来利益の予測ではありません）。`,
    });
  }
  sections.push({ key: "finance", screen: "finance", title: "借入・返済・配当", items: financeItems });

  // ---- 合計（提出値をそのまま足すだけで出せるものに限る） ----
  const totals: DecisionSummaryTotal[] = [];
  const submittedSalesTons = draft.salesPlans
    .filter((p) => !isDroppedByQuantity(p.desiredQuantity))
    .reduce((sum, p) => sum + p.desiredQuantity, 0);
  totals.push({
    label: "提出される販売希望量 合計",
    value: `${submittedSalesTons.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} t`,
    note: "数量0で提出されない行は含みません。",
  });
  // 提出される配員だけを合計する（engine が市場ごとに重複排除して数える値と一致する）。
  const submittedHeadcount = Array.from(marketHeadcounts.entries())
    .filter(([market]) => marketHasSubmittedRow.get(market) === true)
    .reduce((sum, [, h]) => sum + (Number.isFinite(h) ? h : 0), 0);
  const draftHeadcount = Array.from(marketHeadcounts.values()).reduce((sum, h) => sum + (Number.isFinite(h) ? h : 0), 0);
  totals.push({
    label: "提出される営業配員 合計",
    value: `${submittedHeadcount.toLocaleString("en-US")} 人`,
    note:
      submittedHeadcount === draftHeadcount
        ? "市場ごとに1回だけ数えた合計です。"
        : `入力の合計は ${draftHeadcount.toLocaleString("en-US")} 人ですが、販売希望量がすべて0の市場の配員は提出されないため ${submittedHeadcount.toLocaleString("en-US")} 人になります。`,
  });
  const submittedProductionTons = draft.productionPlans
    .filter((p) => !isDroppedByQuantity(p.desiredQuantity))
    .reduce((sum, p) => sum + p.desiredQuantity, 0);
  totals.push({
    label: "提出される生産希望量 合計",
    value: `${submittedProductionTons.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} t`,
    note: "数量0で提出されない行は含みません。",
  });
  const requestedCapexTotal = draft.capexDecision.newProjectProposals.reduce(
    (sum, p) => sum + (p.requestedBudgetUsd !== undefined && Number.isFinite(p.requestedBudgetUsd) ? p.requestedBudgetUsd : 0),
    0
  );
  totals.push({
    label: "設備投資 申請額 合計",
    value: usd(requestedCapexTotal),
    note: "申請額の合計です。審査結果（実行額）ではありません。申請額の指定が無い案件は0として合計しています。",
  });

  // ---- この画面からは提出できない意思決定 ----
  /**
   * 【UI-TRIAL-1 §3・基点 d45b0bf を調査した結果】
   * 工場の一時休止・再稼働・売却は、engine（capex/factoryLifecycle.ts）と保存
   * （persistence/schema.ts）と受け口（CompanyDecisionInput.factoryLifecycleDecisions）
   * は揃っているが、この版には決定を作る経路が無い。
   *   ・Decision Studio（PLAYER）に入力欄が無い
   *   ・GM Console にも操作UIが無い
   *   ・API にも受け口が無い（app/api/ に factoryLifecycleDecisions を受ける口は無い）
   *   ・Standard AI・自動方針も生成しない
   * 生成しているのは検証用スクリプト（scripts/factoryLifecycle*Probe.ts）とテストだけ。
   * したがって「この版ではPLAYERはどの経路でも操作できない」。
   * 画面にはこの事実だけを書き、未統合branchの存在は書かない（利用者の操作には関係しないため）。
   */
  const noInputPathNotes: string[] = [
    "工場の一時休止・再稼働・売却は、この版では提出できません。PLAYER画面にもGM画面にも入力欄が無く、どの経路からも提出されません（ゲームの処理側には受け口がありますが、決定を作る画面がありません）。この確認画面にも提出対象として表示しません。",
  ];

  return { sections, totals, notSubmittedNotes, noInputPathNotes };
}
