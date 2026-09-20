// ShrimpX V2 — Phase DIV-4 / 年間純利益ベース配当（Annual Net-Income-Based Settlement）
//
// 【今回の変更（確定仕様）】配当額の算定baseを
//   旧: max(0, 直近確定四半期の純利益) × payoutRatio   （Q4判断時は実質「Q3純利益」）
//   新: max(0, 同年度Q1〜Q4の純利益合計) × payoutRatio − 同年度の既支払配当
// へ変更した。新baseはQ4決算が終わるまで確定しないため、本モジュールは
// **金額を決めない**。Q4意思決定時点で決めるのは
//   ・配当を検討してよいか（既存の安全gate）
//   ・適用する配当性向
// だけであり、金額の確定と支払は runner.ts がQ4決算後に
// finance/annualDividend.ts を使って行う（実装指示§4の A→F 構造）。
// これにより、未確定のQ4純利益をStandard AIへ先読みさせない。
//
// 【安全gateは削除していない】Q4のみ・財務健全性・Crisis State・当期の新規CAPEX提案・
// 分配可能利益・現金の各gateはそのまま残る。唯一「当期純利益が正であること」
// （旧Gate E）だけは、判定対象が直近確定四半期（＝Q3）から年間純利益へ移るため、
// 本モジュールではなく年間精算側の「年間純利益<=0なら目標0」へ移設した
// （実装指示§3が定める確定仕様。gateを消したのではなく、基準を年間へ移した）。
//
// 【DIV-3からの設計変更（実装指示§1・§2）】DIV-3は配当額を
//   distributableEarnings（累計利益stock）× payoutRatio
// で算定していた。これは「過去利益を毎四半期一定割合ずつ繰り返し取り崩す」挙動に
// なり、period payout policyの基準として正しくない（DIV-3ベンチマークで、
// ratio=10%以上ではこの取り崩しが会社の運転資金を枯渇させることも実測された）。
//
// DIV-4は配当額の算定baseを「直近確定四半期の純利益（flow）」へ変更した。
// 本変更はさらにそれを「年間（Q1〜Q4）純利益」へ移す。
// distributableEarningsは今回も「算定base」ではなく「配当可能額の上限」としてのみ使う
// （computeMaxDividendUsd = min(Cash, distributableEarnings) 経由。実装指示§8）。
//
// 【currentQuarterNetIncomeUsdの位置づけ】本モジュールは引き続き直近確定四半期の
// Net Incomeを受け取るが、**配当額の算定には使わない**（診断表示専用）。
// Turn N の意思決定時点では Turn N の損益がまだ確定していないため、Q4判断時に
// 参照できるのは同年Q3までである。年間純利益はQ4決算後にrunner.ts側で確定する。
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
// 会計仕訳も、既存のapplyDividendToFinanceStateの経路をそのまま通る。
//
// 【上限超過で全額消えないようにする】resolveDividendDecisionは上限超過を
// 「部分執行せず全額拒否」する仕様（finance/dividend.ts §7）である。年間精算側でも
// この仕様を変えず、支払前に min(年末追加目標, computeMaxDividendUsd) へクランプする
// ことで、上限を1セント超えただけで配当がまるごと消える挙動を避ける。
//
// 【「強い配当AI」を作らない】本モジュールは将来のTSVを試算しない・複数案を
// 比較しない・配当タイミングを最適化しない。参照するのは、当期のPeriod、
// 前Turnまでに確定した自社の財務値、当期の自社CAPEX提案の有無だけである。

import { CompanyFinanceState, unwrapUsd } from "../../../finance/types";
import { computeMaxDividendUsd, DividendDecisionInput } from "../../../finance/dividend";
import { DividendPayoutRatioSource } from "../../../finance/annualDividend";
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

/**
 * Q4意思決定時点で確定させる「年間精算の意思」。金額は含まない。
 * runner.tsがQ4決算後に、この率で年間純利益から金額を確定する。
 */
export interface AnnualDividendSettlementIntent {
  /** 年間精算に使う配当性向（0も有効な指定。未指定との区別は上位で行う）。 */
  readonly payoutRatio: number;
  /** その率の出所。金額指定（PLAYER）はここに現れない。 */
  readonly payoutRatioSource: DividendPayoutRatioSource;
}

export interface StandardAiDividendDecisionResult {
  /**
   * CompanyDecisionInput.dividendDecisionへそのまま載せる値。
   * 【常にundefined】Standard AIはTurn開始時点の金額指定配当を行わない
   * （年間精算はQ4決算後に別経路で実行される）。Player金額指定の経路は不変。
   */
  readonly dividendDecision: DividendDecisionInput | undefined;
  /** Q4に年間精算を行う意思（gateで見送った場合・Q4以外はundefined）。 */
  readonly annualSettlementIntent: AnnualDividendSettlementIntent | undefined;
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
  /**
   * params.dividendBasePayoutRatio の出所。
   * 管理者がManagement Consoleで手動指定した率なら "MANUAL_OVERRIDE"。
   * ここを後から現在のparameterで再計算して表示に使ってはならない
   * （実際に使った値を記録して転記する、が今回の方針。実装指示§13）。
   *
   * 省略時は "STANDARD_AI"（手動指定が無いRun・既存テストと同じ意味）。
   */
  readonly payoutRatioSource?: DividendPayoutRatioSource;
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
  const payoutRatioSource: DividendPayoutRatioSource = input.payoutRatioSource ?? "STANDARD_AI";

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
    annualSettlementIntent: undefined,
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

  // 【旧Gate E（当期純利益が正であること）の移設・実装指示§3/§6】
  //
  // 旧実装はここで「直近確定四半期（Q4判断時は同年Q3）の純利益が正か」を判定して
  // いた。年間純利益ベースの確定仕様では、判定すべきは年間（Q1〜Q4）純利益であり、
  // それはQ4決算が終わるまで確定しない。したがってこのgateは削除ではなく
  // **年間精算側へ移設**した（finance/annualDividend.ts の
  // 「annualNetIncome <= 0 なら annualDividendTarget = 0」がその実体）。
  //
  // ここでQ3の符号だけで打ち切ると、「Q3は赤字だが年間では黒字」という年度の配当が
  // 年間基準の契約に反して0になるため、意図的に判定しない。
  // 当期純利益の値自体は診断用に common へ残る。

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

  // 【ここから先は「率」だけを確定する（実装指示§4A）】
  // 金額はQ4決算後にrunner.tsが年間純利益から確定する。未確定のQ4損益を
  // Standard AIへ先読みさせないため、本モジュールは金額を一切計算しない。
  if (payoutRatio <= 0) {
    // dividendBasePayoutRatio=0（配当ポリシーOFF）・手動で明示0%を指定した場合。
    // 「未指定」ではなく「0%と決めた」ため、年間配当目標は0になる。
    return {
      ...common,
      dividendDecision: undefined,
      annualSettlementIntent: undefined,
      baseDividendUsd: 0,
      diagnostics: [
        {
          code: "DIVIDEND_SKIPPED_NO_CURRENT_EARNINGS",
          domain: "finance",
          companyId,
          severity: "info",
          keyValues: { payoutRatio, distributableEarningsUsd, cashUsd, maxDividendUsd, currentQuarterNetIncomeUsd: netIncomeUsd },
          decisionSummary: "配当なし（配当性向0%）",
          message: `配当性向が${(payoutRatio * 100).toFixed(1)}%のため、年間配当目標は0となり配当を行わない。`,
        },
      ],
    };
  }

  return {
    ...common,
    // 【Turn開始時の金額指定配当はしない】Standard AIの配当は年度末精算のみ。
    dividendDecision: undefined,
    annualSettlementIntent: { payoutRatio, payoutRatioSource },
    // 年間基準では「クランプ前の基準配当額」は決算後にしか決まらないため0を入れる
    // （旧フィールドは診断互換のために残すが、年間精算の根拠には使わない）。
    baseDividendUsd: 0,
    diagnostics: [
      {
        code: "DIVIDEND_PROPOSED",
        domain: "finance",
        companyId,
        severity: "info",
        keyValues: {
          payoutRatio,
          maxDividendUsd,
          distributableEarningsUsd,
          cashUsd,
          currentQuarterNetIncomeUsd: netIncomeUsd,
          year,
        },
        threshold: payoutRatio,
        decisionSummary: `年度末に配当性向${(payoutRatio * 100).toFixed(1)}%で年間精算`,
        message:
          `年度末（${period}）に、財務健全性=healthy・Crisis無し・当期の新規設備投資提案なしの条件を満たすため、` +
          `配当性向${(payoutRatio * 100).toFixed(1)}%（${payoutRatioSource === "MANUAL_OVERRIDE" ? "管理者の手動指定" : "Standard AIの実効値"}）で` +
          "年度末に年間精算を行う。配当額は当年度Q1〜Q4の純利益合計が確定した後に決まるため、この時点では金額を決めない。",
      },
    ],
  };
}
