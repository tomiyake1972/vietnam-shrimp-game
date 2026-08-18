// ShrimpX V2 — Phase DIV-4: Standard AI配当ポリシー（Flow-Based Annual Dividend Policy）
//
// 【DIV-3からの設計変更（実装指示§1・§2）】DIV-3は配当額を
//   distributableEarnings（累計利益stock）× payoutRatio
// で算定していた。これは「過去利益を毎四半期一定割合ずつ繰り返し取り崩す」挙動に
// なり、period payout policyの基準として正しくない（DIV-3ベンチマークで、
// ratio=10%以上ではこの取り崩しが会社の運転資金を枯渇させることも実測された）。
//
// DIV-4では配当額の算定baseを「当期純利益（flow）」へ変更する。
//   baseDividendUsd = max(0, currentQuarterNetIncomeUsd) × effectivePayoutRatio
// distributableEarningsは「算定base」ではなく「配当可能額の上限」としてのみ使う
// （computeMaxDividendUsd = min(Cash, distributableEarnings) 経由。実装指示§2）。
//
// 【当期純利益のsingle source（実装指示§3）】
// CompanyOwnState.lastFinancialResult.profitAndLoss.netIncome を唯一のsourceとする。
// これはrunner.tsが既に確定させ state.history へ保存済みの財務諸表そのものであり、
// ここで独自のNet Income計算はしない。Operating Profit・Cash Flowで代用もしない。
//
// 【"current quarter" の意味】Turn N の意思決定時点では、Turn N の損益はまだ確定して
// いない（DIV-1 finance/dividend.ts §4「当Turn利益の先取り配当はできない」）。
// したがってStandard AIが参照できる「当期純利益」は、直近に確定した四半期
// （= Turn N-1、Q4に判断する場合は同年Q3）のNet Incomeである。診断には実際に
// 参照した四半期（sourcePeriod）を必ず残し、どの利益に対する配当かを追跡可能にする。
//
// 【年1回の配当判定（実装指示§4）】Standard AIは各年度Q4のみ配当を検討する。
// 判定は既存のPeriodV2表現（core/period.ts の toYearQuarter）だけを使う決定論的な
// ものであり、lastDividendTurn等の新規stateは一切追加しない。Q4で条件を満たさな
// ければその年度は無配であり、次のQ1へ繰り越して即配当することもない
// （Q1〜Q3は無条件でDIVIDEND_SKIPPED_NOT_ANNUAL_PERIODになるため、構造的に不可能）。
//
// 【Player配当の自由度は変えない（実装指示§10）】「Standard AIは年1回」と
// 「ゲームルール上は毎Turn配当入力可能」は別のレイヤーである。本モジュールは
// Standard AIの提案生成側にだけ存在し、finance/dividend.ts・resolveDividendDecision・
// evaluationSemantics等のPlayer/game-common側は一切変更していない。
//
// 【新しい会計・評価ロジックを追加しない】配当可能上限はPlayerとまったく同じ
// finance/dividend.tsのcomputeMaxDividendUsdをそのまま呼ぶ。実際の配当実行・
// 会計仕訳・拒否判定も、Playerと同じrunner.ts→resolveDividendDecision/
// applyDividendToFinanceStateの経路を通る（本モジュールは「いくら要求するか」だけを決める）。
//
// 【なぜ要求額を必ずクランプするのか】resolveDividendDecisionは上限超過を
// 「部分執行せず全額拒否」する仕様（finance/dividend.ts §7）である。クランプせずに
// 要求すると、上限を1セント超えただけで配当がまるごと消える不安定な挙動になる。
// ここでcomputeMaxDividendUsdへ寄せることで、AIの配当は「拒否されない範囲でのみ
// 実行される」ことが構造的に保証される。
//
// 【「強い配当AI」を作らない】本モジュールは将来のTSVを試算しない・複数案を
// 比較しない・配当タイミングを最適化しない。参照するのは、当期のPeriod、
// 前Turnまでに確定した自社の財務値、当期の自社CAPEX提案の有無だけである。

import { CompanyFinanceState, unwrapUsd } from "../../../finance/types";
import { computeMaxDividendUsd, DividendDecisionInput } from "../../../finance/dividend";
import { FinancialHealthTier } from "../../../financing/types";
import { PeriodV2, toYearQuarter } from "../../../core/period";
import { StandardAiParameters } from "../parameters";
import { StandardAiDiagnosticEntry } from "../reasonCodes";
import { StandardAiCrisisState } from "../crisisState";

/** 配当額として意味を持たない微小額の下限（finance/dividend.tsのEPS_USDと同じ考え方）。 */
const EPS_USD = 1e-6;

/**
 * 【実装指示§4】Standard AIが配当を検討する四半期。年度末（Q4）のみ。
 * 既存のPeriodV2表現をそのまま読むだけで、新しい暦・年度の概念を作らない。
 */
const ANNUAL_DIVIDEND_QUARTER = 4;

export interface StandardAiDividendDecisionResult {
  /** CompanyDecisionInput.dividendDecisionへそのまま載せる値（配当しない場合はundefined）。 */
  readonly dividendDecision: DividendDecisionInput | undefined;
  /** 配当可能上限（min(Cash, 分配可能利益)）。診断・テスト用。 */
  readonly maxDividendUsd: number;
  /** 算定baseに使った当期純利益（直近確定四半期のP&L Net Income）。診断・テスト用。 */
  readonly currentQuarterNetIncomeUsd: number;
  /** 算定baseに使ったNet Incomeが属する四半期（未確定の場合はnull）。 */
  readonly netIncomeSourcePeriod: PeriodV2 | null;
  /** クランプ前の基準配当額（max(0, 当期純利益) × payoutRatio）。診断・テスト用。 */
  readonly baseDividendUsd: number;
  readonly diagnostics: readonly StandardAiDiagnosticEntry[];
}

export function buildStandardAiDividendDecision(input: {
  readonly companyId: string;
  /** 当期のPeriod（Q4判定に使う。新しい暦の概念は作らず既存表現をそのまま読む）。 */
  readonly period: PeriodV2;
  /**
   * 前Turnまでに確定した自社の財務状態（CompanyOwnState.financeState）。
   * 配当可能上限（distributableEarnings・Cash）の判定にだけ使う。
   */
  readonly financeState: CompanyFinanceState;
  /**
   * 直近に確定した四半期のP&L Net Income（CompanyOwnState.lastFinancialResult
   * .profitAndLoss.netIncome）。まだ1Turnも確定していない場合はnull。
   * ここでOperating Profit・Cash Flow等で代用してはならない（実装指示§3）。
   */
  readonly currentQuarterNetIncomeUsd: number | null;
  /** 上記Net Incomeが属する四半期（診断用。未確定の場合はnull）。 */
  readonly netIncomeSourcePeriod: PeriodV2 | null;
  /**
   * 前Turnの資金繰りクローズで確定した財務健全性（FinancialHealthStatus.primary）。
   * まだ1Turnも確定していない場合（Turn1の意思決定時点）はnull。
   * SSoTはfinancing側のこの値であり、ここで新しいdistress判定は作らない。
   */
  readonly lastQuarterFinancialHealthTier: FinancialHealthTier | null;
  /**
   * 当期のCrisis State（standardAi/crisisState.tsが既存Finance診断シグナルから
   * 導出済みの値をそのまま受け取る。ここで再計算しない）。
   */
  readonly crisisState: StandardAiCrisisState;
  /**
   * 当期にこの会社が提出する新規設備投資提案の件数（既存増設＋新工場、
   * Crisis Gate適用後の最終値）。1件でもあれば配当しない。
   */
  readonly newCapexProposalCount: number;
  /** 経営性格バイアス適用後のパラメータ（dividendBasePayoutRatioを読む）。 */
  readonly params: StandardAiParameters;
}): StandardAiDividendDecisionResult {
  const {
    companyId,
    period,
    financeState,
    currentQuarterNetIncomeUsd,
    netIncomeSourcePeriod,
    lastQuarterFinancialHealthTier,
    crisisState,
    newCapexProposalCount,
    params,
  } = input;

  const maxDividendUsd = computeMaxDividendUsd(financeState);
  const distributableEarningsUsd = unwrapUsd(financeState.distributableEarnings);
  const cashUsd = unwrapUsd(financeState.cash);
  const payoutRatio = params.dividendBasePayoutRatio;
  const netIncomeUsd = currentQuarterNetIncomeUsd ?? 0;
  const { year, quarter } = toYearQuarter(period);

  const common = {
    maxDividendUsd,
    currentQuarterNetIncomeUsd: netIncomeUsd,
    netIncomeSourcePeriod,
  };
  const none = (entry: StandardAiDiagnosticEntry): StandardAiDividendDecisionResult => ({
    ...common,
    dividendDecision: undefined,
    baseDividendUsd: 0,
    diagnostics: [entry],
  });

  // 【Gate A・実装指示§5A】配当検討は年度末（Q4）のみ。
  // Q1〜Q3はここで必ず止まるため、「Q4で見送った年度の配当が次のQ1へ繰り越されて
  // 即実行される」ことは構造的に起こらない（実装指示§4）。
  if (quarter !== ANNUAL_DIVIDEND_QUARTER) {
    return none({
      code: "DIVIDEND_SKIPPED_NOT_ANNUAL_PERIOD",
      domain: "finance",
      companyId,
      severity: "info",
      keyValues: { quarter, year, distributableEarningsUsd, cashUsd },
      decisionSummary: "配当なし（年度末Q4ではない）",
      message: `当期は${period}（Q${quarter}）であり、Standard AIが配当を検討する年度末（Q4）ではないため配当を行わない。`,
    });
  }

  // 【Gate A2・INT-NA】配当判定の入力が「有限の数値」であることを先に確認する。
  //
  // 以降のGate F/GはすべてEPS_USDとの大小比較（x <= EPS_USD）で「配らない」側へ倒す
  // 構造になっている。ところがJavaScriptでは NaN <= x も undefined <= x も常にfalseに
  // なるため、入力が有限数でない場合これらのGateは「条件を満たしている」扱いで素通り
  // してしまい、最終的に NaN の配当額が usd() に渡って FinanceValidationError で
  // シミュレーションごと停止する（Turn 8 NaN停止の直接原因）。
  //
  // ここでの意味論は「値が壊れているなら配当は行わない」であり、壊れた値を0とみなして
  // 計算を続行するのではない。配当は任意の裁量的支出なので、判断材料が信頼できない
  // ときに見送るのが唯一安全な既定動作である（未確定Net IncomeをGate Eで見送るのと同じ扱い）。
  // 値が壊れていること自体はwarningとして必ず診断へ残し、握り潰さない。
  if (
    !Number.isFinite(distributableEarningsUsd) ||
    !Number.isFinite(cashUsd) ||
    !Number.isFinite(maxDividendUsd) ||
    (currentQuarterNetIncomeUsd !== null && !Number.isFinite(currentQuarterNetIncomeUsd))
  ) {
    return none({
      code: "DIVIDEND_SKIPPED_INVALID_FINANCIAL_INPUT",
      domain: "finance",
      companyId,
      severity: "warning",
      keyValues: { distributableEarningsUsd, cashUsd, maxDividendUsd, currentQuarterNetIncomeUsd: netIncomeUsd },
      decisionSummary: "配当なし（財務入力値が有限数でない）",
      message:
        "配当判定の入力（分配可能利益・現金・当期純利益）に有限でない数値が含まれるため配当を行わない" +
        `（distributableEarnings=${String(distributableEarningsUsd)} / cash=${String(cashUsd)} / ` +
        `maxDividend=${String(maxDividendUsd)} / netIncome=${String(currentQuarterNetIncomeUsd)}）。` +
        "値を0とみなして配当を続行することはしない。",
    });
  }

  // 【Gate B・実装指示§5B】財務健全性がhealthyであること（DIV-3の定義を維持）。
  // null（Turn1等、まだ1Turnも確定していない）は「healthyであることを確認できて
  // いない」ため、安全側に倒して配当しない。
  if (lastQuarterFinancialHealthTier !== "healthy") {
    return none({
      code: "DIVIDEND_SKIPPED_NOT_HEALTHY",
      domain: "finance",
      companyId,
      severity: "info",
      keyValues: { distributableEarningsUsd, cashUsd, maxDividendUsd, currentQuarterNetIncomeUsd: netIncomeUsd },
      decisionSummary: "配当なし（財務健全性の条件を満たさない）",
      message:
        `前Turnの財務健全性が"${lastQuarterFinancialHealthTier ?? "未確定"}"であり、healthyではないため配当を行わない` +
        "（株主還元より財務の立て直し・資金繰りの安全を優先する）。",
    });
  }

  // 【Gate C・実装指示§5C】Crisis Gate上、配当を許容できる状態であること。
  // Crisis State自体は既存のcrisisState.tsが導出済みの値をそのまま使う
  // （危機時は新規CAPEX提案・営業採用・VAP開発支出も止まる。配当も同じ扱いにする）。
  if (crisisState !== "NORMAL") {
    return none({
      code: "DIVIDEND_SKIPPED_CRISIS",
      domain: "finance",
      companyId,
      severity: "info",
      keyValues: { distributableEarningsUsd, cashUsd, maxDividendUsd, currentQuarterNetIncomeUsd: netIncomeUsd },
      decisionSummary: "配当なし（Crisis State）",
      message: `Crisis Stateが"${crisisState}"であり、危機対応中は新規の裁量的支出と同様に株主還元も行わない。`,
    });
  }

  // 【Gate D・実装指示§5D】当期に新規設備投資（既存増設・新工場）を提案していないこと。
  // 投資と配当を同じ四半期に同時に行わない、という単純で保守的な資本配分ルール。
  if (newCapexProposalCount > 0) {
    return none({
      code: "DIVIDEND_SKIPPED_CAPEX_PLANNED",
      domain: "finance",
      companyId,
      severity: "info",
      keyValues: { newCapexProposalCount, distributableEarningsUsd, cashUsd, maxDividendUsd, currentQuarterNetIncomeUsd: netIncomeUsd },
      decisionSummary: "配当なし（当期に新規設備投資を提案）",
      message:
        `当期に新規設備投資提案が${newCapexProposalCount}件あるため配当を行わない` +
        "（同じ四半期に投資と株主還元を同時に行わず、投資に必要な現金を先に確保する）。",
    });
  }

  // 【Gate E・実装指示§5E】当期純利益が正であること。
  // 赤字の年度は配当しない（過去の累計利益を取り崩して無理に配当しない＝DIV-4の
  // 中心的な設計意図。distributableEarningsが潤沢でもここで必ず止まる）。
  if (currentQuarterNetIncomeUsd === null || netIncomeUsd <= EPS_USD) {
    return none({
      code: "DIVIDEND_SKIPPED_NO_CURRENT_EARNINGS",
      domain: "finance",
      companyId,
      severity: "info",
      keyValues: { currentQuarterNetIncomeUsd: netIncomeUsd, distributableEarningsUsd, cashUsd, maxDividendUsd },
      decisionSummary: "配当なし（当期純利益が正でない）",
      message:
        currentQuarterNetIncomeUsd === null
          ? "確定済みの四半期損益がまだ無い（Turn1等）ため配当を行わない。"
          : `直近確定四半期${netIncomeSourcePeriod ?? "(不明)"}の当期純利益が${netIncomeUsd.toFixed(0)}USDであり正ではないため配当を行わない` +
            `（累計の分配可能利益は${(distributableEarningsUsd / 1e6).toFixed(2)}M USDあるが、これを取り崩しての配当はしない）。`,
    });
  }

  // 【Gate F・実装指示§5F】分配可能利益が正であること（配れる原資が無ければ配らない）。
  if (distributableEarningsUsd <= EPS_USD) {
    return none({
      code: "DIVIDEND_SKIPPED_NO_DISTRIBUTABLE_EARNINGS",
      domain: "finance",
      companyId,
      severity: "info",
      keyValues: { distributableEarningsUsd, cashUsd, maxDividendUsd, currentQuarterNetIncomeUsd: netIncomeUsd },
      decisionSummary: "配当なし（分配可能利益が正でない）",
      message: `分配可能利益が${distributableEarningsUsd.toFixed(0)}USDであり正ではないため配当を行わない。`,
    });
  }

  // 【Gate G・実装指示§5G】配当可能上限（min(Cash, 分配可能利益)）が正であること。
  if (maxDividendUsd <= EPS_USD) {
    return none({
      code: "DIVIDEND_SKIPPED_NO_DISTRIBUTABLE_EARNINGS",
      domain: "finance",
      companyId,
      severity: "info",
      keyValues: { distributableEarningsUsd, cashUsd, maxDividendUsd, currentQuarterNetIncomeUsd: netIncomeUsd },
      decisionSummary: "配当なし（配当可能上限が0）",
      message:
        `分配可能利益は${distributableEarningsUsd.toFixed(0)}USDあるが、配当可能上限（min(現金, 分配可能利益)）が` +
        `${maxDividendUsd.toFixed(0)}USDのため配当を行わない。`,
    });
  }

  // 【基準配当額（実装指示§2）】max(0, 当期純利益) × 基準配当性向（経営性格バイアス適用後）。
  // distributableEarningsはここには一切現れない（＝算定baseではない）。
  const baseDividendUsd = Math.max(0, netIncomeUsd) * payoutRatio;
  if (baseDividendUsd <= EPS_USD) {
    // dividendBasePayoutRatio=0（配当ポリシーOFF）の場合もここに入る。
    return {
      ...common,
      dividendDecision: undefined,
      baseDividendUsd,
      diagnostics: [
        {
          code: "DIVIDEND_SKIPPED_NO_CURRENT_EARNINGS",
          domain: "finance",
          companyId,
          severity: "info",
          keyValues: { currentQuarterNetIncomeUsd: netIncomeUsd, payoutRatio, distributableEarningsUsd, cashUsd, maxDividendUsd },
          decisionSummary: "配当なし（基準配当額が0）",
          message: `基準配当性向が${(payoutRatio * 100).toFixed(1)}%であり、基準配当額が0のため配当を行わない。`,
        },
      ],
    };
  }

  // 【上限クランプ】Playerとまったく同じcomputeMaxDividendUsd（min(Cash, 分配可能利益)）。
  const appliedUsd = Math.min(baseDividendUsd, maxDividendUsd);
  const diagnostics: StandardAiDiagnosticEntry[] = [];
  if (appliedUsd < baseDividendUsd - EPS_USD) {
    // 何が上限を決めたのか（分配可能利益か現金か）を診断で区別できるようにする。
    if (distributableEarningsUsd <= cashUsd + EPS_USD) {
      diagnostics.push({
        code: "DIVIDEND_LIMITED_BY_DISTRIBUTABLE_EARNINGS",
        domain: "finance",
        companyId,
        severity: "info",
        keyValues: { baseDividendUsd, distributableEarningsUsd, cashUsd, maxDividendUsd, currentQuarterNetIncomeUsd: netIncomeUsd },
        threshold: distributableEarningsUsd,
        decisionSummary: `配当額を分配可能利益${(distributableEarningsUsd / 1e6).toFixed(2)}M USDへ縮小`,
        message:
          `当期純利益に基づく基準配当額${(baseDividendUsd / 1e6).toFixed(2)}M USDが、累計の分配可能利益` +
          `${(distributableEarningsUsd / 1e6).toFixed(2)}M USDを超えるため、そこまで縮小した` +
          "（分配可能利益は配当額の算定baseではなく、上限としてのみ働く）。",
      });
    }
    diagnostics.push({
      code: "DIVIDEND_LIMITED_BY_MAX",
      domain: "finance",
      companyId,
      severity: "info",
      keyValues: { baseDividendUsd, maxDividendUsd, cashUsd, distributableEarningsUsd, currentQuarterNetIncomeUsd: netIncomeUsd },
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
    keyValues: {
      appliedUsd,
      baseDividendUsd,
      maxDividendUsd,
      payoutRatio,
      currentQuarterNetIncomeUsd: netIncomeUsd,
      distributableEarningsUsd,
      cashUsd,
      year,
    },
    threshold: payoutRatio,
    decisionSummary: `年度配当${(appliedUsd / 1e6).toFixed(2)}M USD`,
    message:
      `年度末（${period}）に、財務健全性=healthy・Crisis無し・当期の新規設備投資提案なし・` +
      `直近確定四半期${netIncomeSourcePeriod ?? "(不明)"}の当期純利益${(netIncomeUsd / 1e6).toFixed(2)}M USD>0の` +
      `条件をすべて満たすため、基準配当性向${(payoutRatio * 100).toFixed(1)}%に基づき` +
      `${(appliedUsd / 1e6).toFixed(2)}M USDを配当する。`,
  });

  return {
    ...common,
    dividendDecision: { dividendAmountUsd: appliedUsd },
    baseDividendUsd,
    diagnostics,
  };
}
