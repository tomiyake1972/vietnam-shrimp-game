// ShrimpX V2 — Phase DIV-3: Standard AI配当ポリシー（基準配当ルール）
//
// 【設計の出典】docs/v2/design/standard_ai_dividend_policy_div3_proposal.md
// §4「案C＋案Bのハイブリッド」。すなわち、
//   (1) ベースは案B＝「財務健全性・当期CAPEX予定・分配可能利益」による安全側
//       フィルタ。AIが不適切なタイミングで配当しないことを、この3条件で担保する。
//   (2) その上に、既存ManagementProfileの枠組み（±5%、最大±10%）で
//       dividendPropensityRatioを1軸だけ追加し、5社に小さな配当行動の差を持たせる。
//       ただしバイアスが動かせるのは「配当額」だけであり、発火条件そのものは
//       全社完全に同一である（安全ガードは全社同一という既存原則を守る）。
//
// 【新しい会計・評価ロジックを一切追加しない（実装指示§3の最終項）】
// 配当可能上限はPlayerとまったく同じfinance/dividend.tsのcomputeMaxDividendUsd
// （= min(Cash, distributableEarnings)）をそのまま呼ぶ。AI専用の上限式・AI専用の
// 分配可能利益の定義は作らない。実際の配当実行・会計仕訳・拒否判定も、Playerと
// 同じrunner.ts→resolveDividendDecision/applyDividendToFinanceStateの経路を通る
// （本モジュールは「いくら要求するか」を決めるだけで、会計には一切触れない）。
//
// 【なぜ要求額を必ずクランプするのか】resolveDividendDecisionは上限超過を
// 「部分執行せず全額拒否」する仕様（finance/dividend.ts §7）である。AIがクランプ
// せずに要求すると、上限を1セント超えただけで配当がまるごと消える不安定な挙動に
// なる。ここでcomputeMaxDividendUsdへ寄せておくことで、AIの配当は「拒否されない
// 範囲でのみ実行される」ことが構造的に保証される。
//
// 【「強い配当AI」を作らない（提案書§3案D・§5論点4）】本モジュールは将来の
// TSVを試算しない・複数案を比較しない・配当タイミングを最適化しない。参照するのは
// 前Turnまでに確定した自社の財務値と、当期の自社CAPEX提案の有無だけである。

import { CompanyFinanceState, unwrapUsd } from "../../../finance/types";
import { computeMaxDividendUsd, DividendDecisionInput } from "../../../finance/dividend";
import { FinancialHealthTier } from "../../../financing/types";
import { StandardAiParameters } from "../parameters";
import { StandardAiDiagnosticEntry } from "../reasonCodes";

/** 配当額として意味を持たない微小額の下限（finance/dividend.tsのEPS_USDと同じ考え方）。 */
const EPS_USD = 1e-6;

export interface StandardAiDividendDecisionResult {
  /** CompanyDecisionInput.dividendDecisionへそのまま載せる値（配当しない場合はundefined）。 */
  readonly dividendDecision: DividendDecisionInput | undefined;
  /** 配当可能上限（min(Cash, 分配可能利益)）。診断・テスト用。 */
  readonly maxDividendUsd: number;
  /** バイアス適用後の基準配当額（クランプ前）。診断・テスト用。 */
  readonly baseDividendUsd: number;
  readonly diagnostics: readonly StandardAiDiagnosticEntry[];
}

export function buildStandardAiDividendDecision(input: {
  readonly companyId: string;
  /**
   * 前Turnまでに確定した自社の財務状態（CompanyOwnState.financeState）。
   * 当Turnの営業結果はまだ確定していないため、当Turn利益の先取り配当はできない
   * （finance/dividend.tsの§4と同じ前提。ここでも同じ値を見る）。
   */
  readonly financeState: CompanyFinanceState;
  /**
   * 前Turnの資金繰りクローズで確定した財務健全性（FinancialHealthStatus.primary）。
   * まだ1Turnも確定していない場合（Turn1の意思決定時点）はnull。
   * SSoTはfinancing側のこの値であり、ここで新しいdistress判定は作らない。
   */
  readonly lastQuarterFinancialHealthTier: FinancialHealthTier | null;
  /**
   * 当期にこの会社が提出する新規設備投資提案の件数（既存増設＋新工場、
   * Crisis Gate適用後の最終値）。1件でもあれば配当しない。
   */
  readonly newCapexProposalCount: number;
  /** 経営性格バイアス適用後のパラメータ（dividendBasePayoutRatioを読む）。 */
  readonly params: StandardAiParameters;
}): StandardAiDividendDecisionResult {
  const { companyId, financeState, lastQuarterFinancialHealthTier, newCapexProposalCount, params } = input;

  const maxDividendUsd = computeMaxDividendUsd(financeState);
  const distributableEarningsUsd = unwrapUsd(financeState.distributableEarnings);
  const cashUsd = unwrapUsd(financeState.cash);
  const payoutRatio = params.dividendBasePayoutRatio;

  const none = (entry: StandardAiDiagnosticEntry): StandardAiDividendDecisionResult => ({
    dividendDecision: undefined,
    maxDividendUsd,
    baseDividendUsd: 0,
    diagnostics: [entry],
  });

  // 【条件1】財務健全性がhealthyであること。null（Turn1等、まだ1Turnも確定して
  // いない）は「healthyであることを確認できていない」ため、安全側に倒して配当しない。
  if (lastQuarterFinancialHealthTier !== "healthy") {
    return none({
      code: "DIVIDEND_SKIPPED_NOT_HEALTHY",
      domain: "finance",
      companyId,
      severity: "info",
      keyValues: { distributableEarningsUsd, cashUsd, maxDividendUsd },
      decisionSummary: "配当なし（財務健全性の条件を満たさない）",
      message:
        `前Turnの財務健全性が"${lastQuarterFinancialHealthTier ?? "未確定"}"であり、healthyではないため配当を行わない` +
        "（分配可能利益の有無にかかわらず、株主還元より財務の立て直し・資金繰りの安全を優先する）。",
    });
  }

  // 【条件2】当期に新規設備投資（既存増設・新工場）を提案していないこと。
  // 投資と配当を同じ四半期に同時に行わない、という単純で保守的な資本配分ルール。
  if (newCapexProposalCount > 0) {
    return none({
      code: "DIVIDEND_SKIPPED_CAPEX_PLANNED",
      domain: "finance",
      companyId,
      severity: "info",
      keyValues: { newCapexProposalCount, distributableEarningsUsd, cashUsd, maxDividendUsd },
      decisionSummary: "配当なし（当期に新規設備投資を提案）",
      message:
        `当期に新規設備投資提案が${newCapexProposalCount}件あるため配当を行わない` +
        "（同じ四半期に投資と株主還元を同時に行わず、投資に必要な現金を先に確保する）。",
    });
  }

  // 【条件3】分配可能利益が正であること（そもそも配れる利益が無ければ配らない）。
  if (distributableEarningsUsd <= EPS_USD) {
    return none({
      code: "DIVIDEND_SKIPPED_NO_DISTRIBUTABLE_EARNINGS",
      domain: "finance",
      companyId,
      severity: "info",
      keyValues: { distributableEarningsUsd, cashUsd, maxDividendUsd },
      decisionSummary: "配当なし（分配可能利益が正でない）",
      message: `分配可能利益が${distributableEarningsUsd.toFixed(0)}USDであり正ではないため配当を行わない。`,
    });
  }

  // 【基準配当額】分配可能利益 × 基準配当性向（経営性格バイアス適用後）。
  const baseDividendUsd = distributableEarningsUsd * payoutRatio;
  if (baseDividendUsd <= EPS_USD) {
    // dividendBasePayoutRatio=0（配当ポリシーOFF）の場合もここに入る。
    return {
      dividendDecision: undefined,
      maxDividendUsd,
      baseDividendUsd,
      diagnostics: [
        {
          code: "DIVIDEND_SKIPPED_NO_DISTRIBUTABLE_EARNINGS",
          domain: "finance",
          companyId,
          severity: "info",
          keyValues: { distributableEarningsUsd, cashUsd, maxDividendUsd, payoutRatio },
          decisionSummary: "配当なし（基準配当額が0）",
          message: `基準配当性向が${(payoutRatio * 100).toFixed(1)}%であり、基準配当額が0のため配当を行わない。`,
        },
      ],
    };
  }

  // 【上限クランプ】Playerとまったく同じcomputeMaxDividendUsd（min(Cash, 分配可能利益)）。
  // 現金が分配可能利益を下回っている局面ではここで自動的に縮小される。
  const appliedUsd = Math.min(baseDividendUsd, maxDividendUsd);
  if (appliedUsd <= EPS_USD) {
    return none({
      code: "DIVIDEND_SKIPPED_NO_DISTRIBUTABLE_EARNINGS",
      domain: "finance",
      companyId,
      severity: "info",
      keyValues: { distributableEarningsUsd, cashUsd, maxDividendUsd, baseDividendUsd },
      decisionSummary: "配当なし（配当可能上限が0）",
      message:
        `分配可能利益は${distributableEarningsUsd.toFixed(0)}USDあるが、配当可能上限（min(現金, 分配可能利益)）が` +
        `${maxDividendUsd.toFixed(0)}USDのため配当を行わない。`,
    });
  }

  const diagnostics: StandardAiDiagnosticEntry[] = [];
  const clamped = appliedUsd < baseDividendUsd - EPS_USD;
  if (clamped) {
    diagnostics.push({
      code: "DIVIDEND_LIMITED_BY_MAX",
      domain: "finance",
      companyId,
      severity: "info",
      keyValues: { baseDividendUsd, maxDividendUsd, cashUsd, distributableEarningsUsd },
      threshold: maxDividendUsd,
      decisionSummary: `配当額を上限${(maxDividendUsd / 1e6).toFixed(2)}M USDへ縮小`,
      message:
        `基準配当額${(baseDividendUsd / 1e6).toFixed(2)}M USDが配当可能上限（min(現金, 分配可能利益)）` +
        `${(maxDividendUsd / 1e6).toFixed(2)}M USDを超えるため、上限まで縮小した。`,
    });
  }
  diagnostics.push({
    code: "DIVIDEND_PROPOSED",
    domain: "finance",
    companyId,
    severity: "info",
    keyValues: { appliedUsd, baseDividendUsd, maxDividendUsd, payoutRatio, distributableEarningsUsd, cashUsd },
    threshold: payoutRatio,
    decisionSummary: `配当${(appliedUsd / 1e6).toFixed(2)}M USD`,
    message:
      `財務健全性=healthy・当期の新規設備投資提案なし・分配可能利益${(distributableEarningsUsd / 1e6).toFixed(2)}M USD>0の` +
      `3条件を満たすため、基準配当性向${(payoutRatio * 100).toFixed(1)}%に基づき${(appliedUsd / 1e6).toFixed(2)}M USDを配当する。`,
  });

  return {
    dividendDecision: { dividendAmountUsd: appliedUsd },
    maxDividendUsd,
    baseDividendUsd,
    diagnostics,
  };
}
