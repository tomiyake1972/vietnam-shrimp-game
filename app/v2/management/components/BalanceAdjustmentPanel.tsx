"use client";

// ShrimpX V2 — Management Console 手動バランス調整（MANUAL-BALANCE-1）
//
// 【目的】全社Standard AI運用のまま、次の未実行Turnから
// 配当性向・販売市場価格指数・原料市場価格指数を手動で指定できるようにする。
//
// 【SSoT】表示する「最終適用値」は必ず resolveManualBalanceForTurn を通す。
// 画面独自の解決ロジックをここに作らない（画面の表示とEngineが使う値が
// 食い違う事故を構造的に防ぐ）。
//
// 【過去Turnは変更不可】編集対象は常に「次の未実行Turn」以降。確定済みTurnの
// 記録は書き換えない。処理中（busy）は編集・保存をロックする。

import { useState } from "react";
import { SimulationSession } from "../../../lib/v2/companyLab/simulation/types";
import {
  MANUAL_DIVIDEND_PAYOUT_PERCENT_MAX,
  MANUAL_DIVIDEND_PAYOUT_PERCENT_MIN,
  MANUAL_PRICE_INDEX_MAX,
  MANUAL_PRICE_INDEX_MIN,
  MANUAL_PRICE_INDEX_NEUTRAL,
  ManualBalanceSchedule,
  ManualBalanceSettings,
  manualBalanceScheduleTable,
  resolveManualBalanceForTurn,
  validateManualBalanceSettings,
  withManualBalanceContinuingApplied,
  withManualBalancePerTurnApplied,
  withManualBalanceReleased,
} from "../../../lib/v2/companyLab/manualBalance/overrides";
import {
  MANUAL_BALANCE_SPEC_VERSION,
  ManualBalancePortableIdentity,
  buildManualBalancePortableDocument,
  parseManualBalancePortableDocument,
} from "../../../lib/v2/companyLab/manualBalance/portable";

/** 適用期間の指定方法。保存形式では「次1ターンのみ」もperTurn1件として表現する。 */
type ApplicationMode = "singleTurn" | "continuing" | "perTurnList";

interface BalanceAdjustmentPanelProps {
  readonly session: SimulationSession | null;
  /** 新しいスケジュールを適用して保存する。 */
  readonly onApply: (schedule: ManualBalanceSchedule) => void;
  /** 処理中は編集・保存をロックする。 */
  readonly busy: boolean;
  /** Game End後など、これ以上編集させない場合。 */
  readonly locked: boolean;
}

interface DraftState {
  /** 空文字は「未設定」。"0" は明示的0%として扱う（未設定と区別する）。 */
  readonly dividendPercent: string;
  readonly salesPriceIndex: string;
  readonly rawMarketPriceIndex: string;
  readonly mode: ApplicationMode;
  /** continuing / perTurnList で使う開始Turn。 */
  readonly fromTurn: string;
  /** perTurnList で使う終了Turn。 */
  readonly toTurn: string;
}

function emptyDraft(nextTurn: number): DraftState {
  return {
    dividendPercent: "",
    salesPriceIndex: "",
    rawMarketPriceIndex: "",
    mode: "singleTurn",
    fromTurn: String(nextTurn),
    toTurn: String(nextTurn),
  };
}

/**
 * 入力文字列を設定値へ変換する。
 *
 * 【空欄が0にならないこと】空欄・空白のみは undefined（未設定）とし、
 * Number("")===0 の落とし穴を踏まない。配当性向だけは "0" を
 * 明示的0%（kind:"specified", payoutRatio:0）として扱い、未設定と区別する。
 */
function draftToSettings(draft: DraftState): { settings: ManualBalanceSettings | null; error: string | null } {
  const parseIndex = (raw: string, label: string): { value: number | undefined; error: string | null } => {
    const trimmed = raw.trim();
    if (trimmed === "") return { value: undefined, error: null };
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return { value: undefined, error: `${label}は数値で入力してください。` };
    return { value: parsed, error: null };
  };

  const sales = parseIndex(draft.salesPriceIndex, "販売市場価格指数");
  if (sales.error) return { settings: null, error: sales.error };
  const raw = parseIndex(draft.rawMarketPriceIndex, "原料市場価格指数");
  if (raw.error) return { settings: null, error: raw.error };

  const dividendTrimmed = draft.dividendPercent.trim();
  let dividendPayout: ManualBalanceSettings["dividendPayout"];
  if (dividendTrimmed === "") {
    dividendPayout = { kind: "unspecified" };
  } else {
    const parsed = Number(dividendTrimmed);
    if (!Number.isFinite(parsed)) return { settings: null, error: "配当性向は数値で入力してください。" };
    dividendPayout = { kind: "specified", payoutRatio: parsed / 100 };
  }

  const settings: ManualBalanceSettings = {
    dividendPayout,
    salesPriceIndex: sales.value,
    rawMarketPriceIndex: raw.value,
  };
  const issues = validateManualBalanceSettings(settings);
  if (issues.length > 0) return { settings: null, error: issues.map((i) => i.message).join(" ") };
  return { settings, error: null };
}

function formatIndex(value: number | undefined): string {
  return value === undefined ? "－（補正なし）" : String(value);
}

function formatDividend(settings: ManualBalanceSettings): string {
  const d = settings.dividendPayout;
  if (d.kind === "unspecified") return "－（未設定＝既定値）";
  // 明示的0%は「未設定」と必ず別表示にする。
  return `${(d.payoutRatio * 100).toFixed(1)}%${d.payoutRatio === 0 ? "（明示的に配当なし）" : ""}`;
}

export function BalanceAdjustmentPanel({ session, onApply, busy, locked }: BalanceAdjustmentPanelProps) {
  const nextTurn = session ? session.state.scenarioState.currentTurn : 1;
  const [draft, setDraft] = useState<DraftState>(() => emptyDraft(nextTurn));
  const [dirty, setDirty] = useState(false);

  if (!session) {
    return <p className="text-xs text-slate-400">Runを開始すると、ここから配当性向・市場価格指数を手動で調整できます。</p>;
  }

  const schedule = session.state.config.manualBalanceOverrides;
  const applied = session.manualBalanceApplied;
  const { settings: draftSettings, error: draftError } = draftToSettings(draft);
  const editable = !busy && !locked;

  const update = (patch: Partial<DraftState>): void => {
    setDraft((prev) => ({ ...prev, ...patch }));
    setDirty(true);
  };

  const commit = (nextSchedule: ManualBalanceSchedule): void => {
    onApply(nextSchedule);
    setDraft(emptyDraft(nextTurn));
    setDirty(false);
  };

  const handleApply = (): void => {
    if (!editable || !draftSettings) return;
    const recordedAt = new Date().toISOString();
    const fromTurn = Math.max(nextTurn, Math.round(Number(draft.fromTurn) || nextTurn));

    if (draft.mode === "singleTurn") {
      commit(withManualBalancePerTurnApplied(schedule, nextTurn, draftSettings, recordedAt));
      return;
    }
    if (draft.mode === "continuing") {
      commit(withManualBalanceContinuingApplied(schedule, fromTurn, draftSettings, recordedAt));
      return;
    }
    // perTurnList: 指定範囲の各Turnへ個別エントリを作る（ターン別は継続より優先される）。
    const toTurn = Math.max(fromTurn, Math.round(Number(draft.toTurn) || fromTurn));
    let next: ManualBalanceSchedule = schedule ?? [];
    for (let turn = fromTurn; turn <= toTurn; turn += 1) {
      next = withManualBalancePerTurnApplied(next, turn, draftSettings, recordedAt);
    }
    commit(next);
  };

  const handleRelease = (): void => {
    if (!editable) return;
    commit(withManualBalanceReleased(schedule, nextTurn, new Date().toISOString()));
  };

  const resolvedNext = resolveManualBalanceForTurn(schedule, nextTurn);
  const hasPendingForNextTurn = resolvedNext.appliedSource.kind !== "none";

  // 【3状態表示】入力中／保存済み・適用予定／Turn○で適用済み。
  const stateLabel = dirty
    ? { text: "入力中（未保存）", testId: "balance-state-editing", className: "bg-amber-900/50 text-amber-300" }
    : hasPendingForNextTurn
      ? { text: `保存済み・Turn ${nextTurn} で適用予定`, testId: "balance-state-saved", className: "bg-sky-900/50 text-sky-300" }
      : { text: "手動補正なし", testId: "balance-state-none", className: "bg-slate-800 text-slate-400" };

  const previewFrom = nextTurn;
  const previewTo = Math.min(nextTurn + 7, session.run.requestedTurns);
  const previewRows = manualBalanceScheduleTable(schedule, previewFrom, previewTo);

  return (
    <div className="space-y-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-[10px] ${stateLabel.className}`} data-testid={stateLabel.testId}>
          {stateLabel.text}
        </span>
        {busy ? <span className="text-[10px] text-slate-500">処理中は編集できません。</span> : null}
      </div>

      <p className="text-[11px] leading-snug text-slate-500">
        ここでの変更は<strong className="text-slate-300">Turn {nextTurn}以降</strong>
        から有効になります（確定済みTurnの結果・AI判断は書き換えません）。価格指数は
        <strong className="text-slate-300">100が補正なし</strong>、95なら「そのTurnの通常計算価格の95%」です
        （前Turnの補正後価格に重ねて掛かる複利にはなりません）。
      </p>

      <div className="grid gap-2 sm:grid-cols-3">
        <label className="block">
          <span className="mb-0.5 block text-[10px] text-slate-400">配当性向（%・空欄は未設定）</span>
          <input
            type="number"
            value={draft.dividendPercent}
            min={MANUAL_DIVIDEND_PAYOUT_PERCENT_MIN}
            max={MANUAL_DIVIDEND_PAYOUT_PERCENT_MAX}
            step={1}
            disabled={!editable}
            placeholder="未設定"
            onChange={(e) => update({ dividendPercent: e.target.value })}
            data-testid="balance-dividend-percent"
            className="w-full rounded border border-slate-600 bg-slate-900 px-1.5 py-1 text-[11px] disabled:opacity-40"
          />
          <span className="mt-0.5 block text-[10px] text-slate-500">0を入力すると「配当しない」という明示指定になります。</span>
        </label>

        <label className="block">
          <span className="mb-0.5 block text-[10px] text-slate-400">販売市場価格指数（100=補正なし）</span>
          <input
            type="number"
            value={draft.salesPriceIndex}
            min={MANUAL_PRICE_INDEX_MIN}
            max={MANUAL_PRICE_INDEX_MAX}
            step={1}
            disabled={!editable}
            placeholder="未設定"
            onChange={(e) => update({ salesPriceIndex: e.target.value })}
            data-testid="balance-sales-index"
            className="w-full rounded border border-slate-600 bg-slate-900 px-1.5 py-1 text-[11px] disabled:opacity-40"
          />
        </label>

        <label className="block">
          <span className="mb-0.5 block text-[10px] text-slate-400">原料市場価格指数（100=補正なし）</span>
          <input
            type="number"
            value={draft.rawMarketPriceIndex}
            min={MANUAL_PRICE_INDEX_MIN}
            max={MANUAL_PRICE_INDEX_MAX}
            step={1}
            disabled={!editable}
            placeholder="未設定"
            onChange={(e) => update({ rawMarketPriceIndex: e.target.value })}
            data-testid="balance-raw-index"
            className="w-full rounded border border-slate-600 bg-slate-900 px-1.5 py-1 text-[11px] disabled:opacity-40"
          />
        </label>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="mb-0.5 block text-[10px] text-slate-400">適用期間</span>
          <select
            value={draft.mode}
            disabled={!editable}
            onChange={(e) => update({ mode: e.target.value as ApplicationMode })}
            data-testid="balance-mode"
            className="rounded border border-slate-600 bg-slate-900 px-1.5 py-1 text-[11px] disabled:opacity-40"
          >
            <option value="singleTurn">次の1ターンのみ（Turn {nextTurn}）</option>
            <option value="continuing">指定ターンから継続</option>
            <option value="perTurnList">ターン別（範囲指定）</option>
          </select>
        </label>

        {draft.mode !== "singleTurn" ? (
          <label className="block">
            <span className="mb-0.5 block text-[10px] text-slate-400">開始Turn</span>
            <input
              type="number"
              value={draft.fromTurn}
              min={nextTurn}
              disabled={!editable}
              onChange={(e) => update({ fromTurn: e.target.value })}
              data-testid="balance-from-turn"
              className="w-20 rounded border border-slate-600 bg-slate-900 px-1.5 py-1 text-[11px] disabled:opacity-40"
            />
          </label>
        ) : null}

        {draft.mode === "perTurnList" ? (
          <label className="block">
            <span className="mb-0.5 block text-[10px] text-slate-400">終了Turn</span>
            <input
              type="number"
              value={draft.toTurn}
              min={nextTurn}
              disabled={!editable}
              onChange={(e) => update({ toTurn: e.target.value })}
              data-testid="balance-to-turn"
              className="w-20 rounded border border-slate-600 bg-slate-900 px-1.5 py-1 text-[11px] disabled:opacity-40"
            />
          </label>
        ) : null}

        <button
          type="button"
          disabled={!editable || draftSettings === null}
          onClick={handleApply}
          data-testid="balance-apply"
          className="rounded border border-sky-700 bg-sky-950/40 px-2 py-1 text-[11px] hover:bg-sky-900/40 disabled:opacity-40"
        >
          保存して適用予定にする
        </button>
        <button
          type="button"
          disabled={!editable}
          onClick={handleRelease}
          data-testid="balance-release"
          className="rounded border border-slate-600 px-2 py-1 text-[11px] hover:bg-slate-800 disabled:opacity-40"
        >
          解除（Turn {nextTurn}以降）
        </button>
      </div>

      {draftError ? (
        <p className="text-[10px] text-red-400" data-testid="balance-validation-error">
          {draftError}
        </p>
      ) : null}

      <div className="overflow-x-auto">
        <p className="mb-1 text-[10px] text-slate-400">
          適用予定（Turn {previewFrom}〜{previewTo}）。ターン別指定は継続指定より優先されます。
        </p>
        <table className="w-full min-w-[520px] text-[11px]" data-testid="balance-schedule-table">
          <thead>
            <tr className="border-b border-slate-700 text-left text-slate-400">
              <th className="py-1 pr-2">Turn</th>
              <th className="py-1 pr-2">配当性向</th>
              <th className="py-1 pr-2">販売指数</th>
              <th className="py-1 pr-2">原料指数</th>
              <th className="py-1 pr-2">由来</th>
            </tr>
          </thead>
          <tbody>
            {previewRows.map((row) => (
              <tr key={row.turn} className="border-b border-slate-800" data-testid={`balance-schedule-row-${row.turn}`}>
                <td className="py-1 pr-2 tabular-nums">{row.turn}</td>
                <td className="py-1 pr-2 tabular-nums">{formatDividend(row.settings)}</td>
                <td className="py-1 pr-2 tabular-nums">{formatIndex(row.settings.salesPriceIndex)}</td>
                <td className="py-1 pr-2 tabular-nums">{formatIndex(row.settings.rawMarketPriceIndex)}</td>
                <td className="py-1 pr-2 text-slate-500">
                  {row.appliedSource.kind === "none"
                    ? "－"
                    : row.appliedSource.kind === "perTurn"
                      ? "ターン別"
                      : "継続"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <AppliedHistoryTable applied={applied} neutralIndex={MANUAL_PRICE_INDEX_NEUTRAL} />

      <ResultsComparisonTable session={session} />

      <PortablePanel
        schedule={schedule ?? []}
        identity={{
          sourceCommit: process.env.NEXT_PUBLIC_SOURCE_COMMIT || "UNKNOWN",
          specVersion: MANUAL_BALANCE_SPEC_VERSION,
          scenarioId: session.run.scenarioId,
          seed: session.run.seed,
          salesModelId: session.state.config.salesModelId ?? null,
        }}
        onImport={commit}
        editable={editable}
      />

      <ManagementAccountingLimitationNotice />
    </div>
  );
}

/**
 * 【結果の比較表】直近Turnの会社別実績を、バランス調整の効果を読むために並べる。
 *
 * 【配当による現金減少と事業悪化による現金減少を区別する】
 * 現金増減をそのまま出すと、配当を増やしたことによる減少と、事業が悪化したことに
 * よる減少が同じ「現金が減った」に見えてしまう。そこで
 *   現金増減 ／ うち配当 ／ 配当を除く現金増減
 * の3列を並べ、どちらが効いているかを直接読めるようにする。
 *
 * 【再計算しない】値は確定済みの財務結果・配当結果からそのまま読む。
 */
function ResultsComparisonTable({ session }: { readonly session: SimulationSession }) {
  const history = session.state.history;
  if (history.length === 0) {
    return (
      <p className="text-[10px] text-slate-500" data-testid="balance-results-empty">
        まだTurnが確定していません。
      </p>
    );
  }

  const latest = history[history.length - 1];
  const previous = history.length >= 2 ? history[history.length - 2] : null;
  const money = (value: number): string => `${Math.round(value).toLocaleString()}`;

  return (
    <div className="overflow-x-auto">
      <p className="mb-1 text-[10px] text-slate-400">
        会社別実績（Turn {latest.turn}）。現金増減は「うち配当」と「配当を除く」に分けて表示します。
      </p>
      <table className="w-full min-w-[760px] text-[11px]" data-testid="balance-results-table">
        <thead>
          <tr className="border-b border-slate-700 text-left text-slate-400">
            <th className="py-1 pr-2">会社</th>
            <th className="py-1 pr-2">売上</th>
            <th className="py-1 pr-2">純利益</th>
            <th className="py-1 pr-2">利益率</th>
            <th className="py-1 pr-2">配当</th>
            <th className="py-1 pr-2">現金</th>
            <th className="py-1 pr-2">現金増減</th>
            <th className="py-1 pr-2">うち配当</th>
            <th className="py-1 pr-2">配当を除く増減</th>
            <th className="py-1 pr-2">負債</th>
          </tr>
        </thead>
        <tbody>
          {latest.financialResults.map((fin) => {
            const netRevenue = Number(fin.profitAndLoss.netRevenue);
            const netIncome = Number(fin.profitAndLoss.netIncome);
            const cash = Number(fin.balanceSheet.cash);
            const debt = Number(fin.balanceSheet.shortTermLoans) + Number(fin.balanceSheet.longTermLoans);
            const dividend = (latest.dividendResults ?? []).find((d) => d.companyId === fin.companyId)?.appliedDividendUsd ?? 0;

            const previousCash = previous
              ? Number(previous.financialResults.find((f) => f.companyId === fin.companyId)?.balanceSheet.cash ?? Number.NaN)
              : Number.NaN;
            const cashChange = Number.isNaN(previousCash) ? null : cash - previousCash;
            const cashChangeExDividend = cashChange === null ? null : cashChange + dividend;

            return (
              <tr key={fin.companyId} className="border-b border-slate-800" data-testid={`balance-results-row-${fin.companyId}`}>
                <td className="py-1 pr-2 font-semibold">{fin.companyId}</td>
                <td className="py-1 pr-2 tabular-nums">{money(netRevenue)}</td>
                <td className="py-1 pr-2 tabular-nums">{money(netIncome)}</td>
                <td className="py-1 pr-2 tabular-nums">
                  {netRevenue !== 0 ? `${((netIncome / netRevenue) * 100).toFixed(1)}%` : "－"}
                </td>
                <td className="py-1 pr-2 tabular-nums">{money(dividend)}</td>
                <td className="py-1 pr-2 tabular-nums">{money(cash)}</td>
                {/* 前Turnが無い（Turn1）ときは増減を計算できないため「－」。0で埋めない。 */}
                <td className="py-1 pr-2 tabular-nums">{cashChange === null ? "－" : money(cashChange)}</td>
                <td className="py-1 pr-2 tabular-nums text-slate-400">{dividend === 0 ? "－" : `-${money(dividend)}`}</td>
                <td className="py-1 pr-2 tabular-nums">{cashChangeExDividend === null ? "－" : money(cashChangeExDividend)}</td>
                <td className="py-1 pr-2 tabular-nums">{money(debt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * 【別Runで同じ条件を試すための持ち出し／取り込み】
 *
 * 書き出したJSONには、そのRunの識別情報（source commit・仕様版・Scenario・seed・
 * 販売市場モデル）を必ず同梱する。取り込み時に現在のRunとの差分を提示し、
 * 別条件の設定を同条件だと誤認したまま比較することを防ぐ。
 */
function PortablePanel({
  schedule,
  identity,
  onImport,
  editable,
}: {
  readonly schedule: ManualBalanceSchedule;
  readonly identity: ManualBalancePortableIdentity;
  readonly onImport: (schedule: ManualBalanceSchedule) => void;
  readonly editable: boolean;
}) {
  const [importText, setImportText] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const exported = JSON.stringify(
    buildManualBalancePortableDocument({ schedule, identity, exportedAt: new Date().toISOString() }),
    null,
    2
  );

  const handleImport = (): void => {
    const result = parseManualBalancePortableDocument(importText, identity);
    if (!result.ok) {
      setMessage(`取り込めませんでした: ${result.error}`);
      return;
    }
    onImport(result.document.schedule);
    setMessage(
      result.identityDifferences.length === 0
        ? "取り込みました（Run識別情報は一致しています）。"
        : `取り込みました。ただし別条件のRunで作られた設定です: ${result.identityDifferences
            .map((d) => `${d.field}（取込 ${d.imported} / 現在 ${d.current}）`)
            .join("、")}`
    );
    setImportText("");
  };

  return (
    <details className="rounded border border-slate-700 bg-slate-900/40 p-2">
      <summary className="cursor-pointer text-[10px] text-slate-400">設定の持ち出し／取り込み（別Runで同じ条件を試す）</summary>
      <div className="mt-2 space-y-2">
        <div>
          <p className="mb-0.5 text-[10px] text-slate-400">現在の設定（コピーして保管できます）</p>
          <textarea
            readOnly
            value={exported}
            rows={5}
            data-testid="balance-portable-export"
            className="w-full rounded border border-slate-700 bg-slate-950 px-1.5 py-1 font-mono text-[10px] text-slate-300"
          />
        </div>
        <div>
          <p className="mb-0.5 text-[10px] text-slate-400">貼り付けて取り込む</p>
          <textarea
            value={importText}
            rows={4}
            disabled={!editable}
            onChange={(e) => setImportText(e.target.value)}
            data-testid="balance-portable-import"
            className="w-full rounded border border-slate-700 bg-slate-950 px-1.5 py-1 font-mono text-[10px] disabled:opacity-40"
          />
          <button
            type="button"
            disabled={!editable || importText.trim() === ""}
            onClick={handleImport}
            data-testid="balance-portable-import-apply"
            className="mt-1 rounded border border-slate-600 px-2 py-1 text-[10px] hover:bg-slate-800 disabled:opacity-40"
          >
            取り込む
          </button>
        </div>
        {message ? (
          <p className="text-[10px] text-slate-300" data-testid="balance-portable-message">
            {message}
          </p>
        ) : null}
      </div>
    </details>
  );
}

/**
 * 【管理会計指標の限界表示】現行Engineでは、absorption P&L に含まれる次の4費目が
 * 管理会計（変動原価計算）レポートの変動費・固定費のどちらのプールにも入っていない。
 *
 * 【原因と扱い】原因は finance/quarterClose.ts の費用式にあり、その変更は本Phaseでは
 * 禁止されている（#05 費用Projection接続Phaseで同じ判断が明記されている）。
 * したがってここでは修正せず、影響を受ける指標に限界があることを明示する。
 *
 * 【分類のみの問題であること】absorption側の営業利益・現金は4費目を正しく含んでおり、
 * 経済実態がずれているわけではない。ずれているのは管理会計レポートの
 * managementOperatingProfit・totalFixedCost・損益分岐点の側だけである。
 */
function ManagementAccountingLimitationNotice() {
  return (
    <div className="rounded border border-slate-700 bg-slate-900/60 p-2" data-testid="management-accounting-limitation">
      <p className="mb-1 text-[10px] font-semibold text-slate-300">管理会計指標の限界（既知・本機能では未修正）</p>
      <p className="text-[10px] leading-snug text-slate-400">
        管理会計（変動原価計算）レポートの<strong className="text-slate-300">限界利益・固定費合計・管理会計上の営業利益・損益分岐点</strong>
        には、次の4費目が含まれていません。損益計算書（全部原価計算）側の営業利益・現金には正しく含まれているため、
        <strong className="text-slate-300">経済実態のずれではなく分類上のずれ</strong>です。
      </p>
      <ul className="mt-1 list-disc pl-4 text-[10px] text-slate-400">
        <li>capexMaintenanceCost（設備保守費）</li>
        <li>factoryLifecycleCarryingCost（工場休止・売却保有費）</li>
        <li>salesForceSeveranceCost（営業人員の退職費用）</li>
        <li>vapProductDevelopmentSpendUsd（VAP商品開発費）</li>
      </ul>
      <p className="mt-1 text-[10px] leading-snug text-slate-500">
        実測（baseline・32Turn・5社＝160レコード）では146レコードで発生し、1レコードあたり最大約797,000 USDでした。
        修正にはEngineの費用式変更が必要で、本機能の範囲外です（バランス調整の結果を読むときは、
        損益計算書側の営業利益・現金を正としてください）。
      </p>
    </div>
  );
}

/**
 * 【Turn○で適用済み】実際に適用された値と、補正前／適用後の価格を並べる。
 *
 * 【推測で埋めない】この機能より前に保存されたRunは applied 自体が undefined で
 * あり、その場合は「不明」と表示する（手動補正なしだったと言い切らない）。
 */
function AppliedHistoryTable({
  applied,
  neutralIndex,
}: {
  readonly applied: SimulationSession["manualBalanceApplied"];
  readonly neutralIndex: number;
}) {
  if (applied === undefined) {
    return (
      <p className="text-[10px] text-slate-500" data-testid="balance-applied-unknown">
        このRunには手動バランス調整の適用記録がありません（この機能より前に計算されたRunのため、各Turnの適用状況は<strong>不明</strong>です）。
      </p>
    );
  }
  if (applied.length === 0) {
    return (
      <p className="text-[10px] text-slate-500" data-testid="balance-applied-empty">
        まだTurnが確定していません。
      </p>
    );
  }

  const warnings = applied.flatMap((r) => r.warnings);

  return (
    <div className="overflow-x-auto">
      <p className="mb-1 text-[10px] text-slate-400">適用実績（確定済みTurn）。補正前と適用後を並べて表示します。</p>
      <table className="w-full min-w-[720px] text-[11px]" data-testid="balance-applied-table">
        <thead>
          <tr className="border-b border-slate-700 text-left text-slate-400">
            <th className="py-1 pr-2">Turn</th>
            <th className="py-1 pr-2">配当性向</th>
            <th className="py-1 pr-2">販売指数</th>
            <th className="py-1 pr-2">原料指数</th>
            <th className="py-1 pr-2">原料 補正前</th>
            <th className="py-1 pr-2">原料 適用後</th>
            <th className="py-1 pr-2">Scenario捕捉指数</th>
          </tr>
        </thead>
        <tbody>
          {applied.map((record) => (
            <tr key={record.turn} className="border-b border-slate-800" data-testid={`balance-applied-row-${record.turn}`}>
              <td className="py-1 pr-2 tabular-nums">
                {record.turn}
                {record.appliedSourceKind !== "none" ? (
                  <span className="ml-1 rounded bg-emerald-900/50 px-1 py-0.5 text-[10px] text-emerald-300">
                    Turn{record.turn}で適用済み
                  </span>
                ) : null}
              </td>
              <td className="py-1 pr-2 tabular-nums">
                {record.manualDividendPayoutRatio === null
                  ? "－（既定）"
                  : `${(record.manualDividendPayoutRatio * 100).toFixed(1)}%`}
              </td>
              <td className="py-1 pr-2 tabular-nums">{record.manualSalesPriceIndex}</td>
              <td className="py-1 pr-2 tabular-nums">{record.manualRawMarketPriceIndex}</td>
              <td className="py-1 pr-2 tabular-nums">{record.preManualRawMarketPrice.toFixed(4)}</td>
              <td className="py-1 pr-2 tabular-nums">
                {record.appliedRawMarketPrice.toFixed(4)}
                {record.manualRawMarketPriceIndex !== neutralIndex ? (
                  <span className="ml-1 text-[10px] text-sky-400">
                    ×{(record.manualRawMarketPriceIndex / neutralIndex).toFixed(2)}
                  </span>
                ) : null}
              </td>
              <td className="py-1 pr-2 tabular-nums text-slate-500">{record.scenarioRawPriceCaptureIndex.toFixed(3)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {warnings.length > 0 ? (
        <div className="mt-2 rounded border border-amber-800 bg-amber-950/30 p-2" data-testid="balance-audit-warnings">
          <p className="mb-1 text-[10px] font-semibold text-amber-300">監査警告（値は再クランプしていません）</p>
          <ul className="list-disc space-y-0.5 pl-4 text-[10px] text-amber-200">
            {warnings.map((w, index) => (
              <li key={`${w.turn}-${w.code}-${index}`}>
                Turn{w.turn}: {w.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
