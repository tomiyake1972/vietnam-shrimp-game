"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { COMPANIES, CompanyId } from "../../lib/gameData";
import { CompanyDecision, CompanyState, CompanyTurnResult, GameSession, PlayerType, SubmissionStatusResponse, SubmittedBy, TurnResult } from "../../lib/gameTypes";
import TestGameManagement from "./TestGameManagement";

const COMPANY_IDS: CompanyId[] = ["A", "B", "C", "D", "E"];

const PLAYER_TYPE_LABELS: Record<PlayerType, string> = {
  human: "Human",
  "ai-a": "AI-A",
  "ai-b": "AI-B",
  "ai-c": "AI-C",
};

const SUBMITTED_BY_LABELS: Record<SubmittedBy, string> = {
  player: "Player",
  "gm-test": "GM Test",
  ai: "AI",
  unknown: "Unknown",
};

// 保存値はUTCのISO文字列のまま。表示時にブラウザのタイムゾーン設定に依存せず、
// 常に日本時間として読めるよう明示的にAsia/Tokyoへ変換する。
function formatJST(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

interface Props { gameCode: string; isProduction: boolean; }

export default function GmGameConsole({ gameCode, isProduction }: Props) {
  const [session, setSession] = useState<GameSession | null>(null);
  const [companyStates, setCompanyStates] = useState<Record<string, CompanyState>>({});
  const [submissionStatus, setSubmissionStatus] = useState<SubmissionStatusResponse | null>(null);
  const [submissionError, setSubmissionError] = useState("");
  const [refreshTick, setRefreshTick] = useState(0);
  const [processing, setProcessing] = useState(false);
  const [lastResult, setLastResult] = useState<TurnResult | null>(null);
  const [error, setError] = useState("");
  const [historyResults, setHistoryResults] = useState<Record<string, TurnResult>>({});
  const [historyDecisions, setHistoryDecisions] = useState<Record<string, Partial<Record<CompanyId, CompanyDecision>>>>({});
  const [historyLoading, setHistoryLoading] = useState(false);

  async function loadHistory(history: string[]) {
    if (history.length === 0) return;
    setHistoryLoading(true);
    const results: Record<string, TurnResult> = {};
    const decisions: Record<string, Partial<Record<CompanyId, CompanyDecision>>> = {};
    await Promise.all(
      history.map(async (key) => {
        const [resRes, decRes] = await Promise.all([
          fetch(`/api/game/${gameCode}/results?quarter=${key}`),
          fetch(`/api/game/${gameCode}/decisions?quarter=${key}`),
        ]);
        if (resRes.ok) { const d = await resRes.json(); if (d.result) results[key] = d.result; }
        if (decRes.ok) { decisions[key] = await decRes.json(); }
      })
    );
    setHistoryResults(results);
    setHistoryDecisions(decisions);
    setHistoryLoading(false);
  }

  async function load(code: string) {
    const gameRes = await fetch(`/api/game/${code}`);
    if (!gameRes.ok) { setError("ゲームが見つかりません"); return; }
    const gameData = await gameRes.json();
    setSession(gameData.session);
    setCompanyStates(gameData.companyStates);
    await loadHistory(gameData.session.history ?? []);
  }

  // セッション・会社状態の読み込み（マウント時、ターン処理後）
  useEffect(() => {
    fetch(`/api/game/${gameCode}`).then((r) => (r.ok ? r.json() : null)).then((data) => {
      if (!data) { setError("ゲームが見つかりません"); return; }
      setSession(data.session);
      setCompanyStates(data.companyStates);
      loadHistory(data.session.history ?? []);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameCode]);

  // 提出状況のポーリング（5秒間隔）。タブが非表示の間はスキップし、前回のリクエストが
  // 完了していなければ次のポーリングを重ねない。手動更新（refreshTickの変化）でも
  // 同じ処理を即時実行する。
  useEffect(() => {
    let cancelled = false;
    let fetching = false;

    async function poll() {
      if (cancelled || fetching || document.hidden) return;
      fetching = true;
      try {
        const res = await fetch(`/api/game/${gameCode}/submission-status`);
        if (cancelled) return;
        if (!res.ok) { setSubmissionError("提出状況の取得に失敗しました"); return; }
        const data = await res.json();
        setSubmissionStatus(data);
        setSubmissionError("");
      } catch {
        if (!cancelled) setSubmissionError("提出状況の取得に失敗しました");
      } finally {
        fetching = false;
      }
    }

    poll();
    const interval = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [gameCode, refreshTick]);

  async function reloadAll() {
    await load(gameCode);
    setRefreshTick((t) => t + 1);
  }

  const processTurn = async () => {
    setProcessing(true);
    setError("");
    try {
      const res = await fetch(`/api/game/${gameCode}/process-turn`, { method: "POST" });
      if (!res.ok) { const d = await res.json().catch(() => ({})); setError(d.error || "ターン処理に失敗しました"); return; }
      const data = await res.json();
      setLastResult(data.result);
      await load(gameCode);
      setRefreshTick((t) => t + 1);
    } finally {
      setProcessing(false);
    }
  };

  if (error && !session) {
    return <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center"><p className="text-red-400">{error}</p></div>;
  }
  if (!session) return <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center"><p>読み込み中...</p></div>;

  const showGmTestOperations = !isProduction && session.isTestGame;
  const submittedCount = submissionStatus?.submittedCount ?? 0;
  const allSubmitted = submissionStatus?.allSubmitted ?? false;

  return (
    <div className="min-h-screen bg-gray-900 text-white p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex flex-wrap justify-between items-center gap-2 mb-6">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-bold tracking-widest text-yellow-400">{gameCode}</h1>
              {session.isTestGame && (
                <span className="text-xs font-bold text-purple-300 bg-purple-900/60 px-2 py-0.5 rounded">
                  TEST GAME｜Environment: {session.environment}{session.randomSeed && `｜Seed: ${session.randomSeed}`}
                </span>
              )}
            </div>
            <p className="text-gray-400 text-sm">{session.title} ｜ {session.currentYear}年 第{session.currentQuarter}四半期</p>
          </div>
          <Link href="/gm" className="text-gray-400 hover:text-white text-sm">← GMコンソール</Link>
        </div>

        {showGmTestOperations && (
          <div className="bg-purple-900/30 border border-purple-700 rounded-2xl p-6 mb-6">
            <h2 className="text-lg font-semibold mb-1">🎮 テスト操作</h2>
            <p className="text-xs text-gray-400 mb-4">担当がAIでも人間でも、GMが代わりに各社の画面を開いて意思決定を入力できます（テストゲーム限定）。</p>
            <div className="flex flex-wrap gap-2">
              {COMPANY_IDS.map((id) => (
                <Link
                  key={id}
                  href={`/company/${id}?game=${gameCode}&mode=gm-test`}
                  className="px-4 py-2 bg-purple-700 hover:bg-purple-600 rounded-lg text-sm font-semibold"
                >
                  {COMPANIES[id].name}を操作
                </Link>
              ))}
            </div>
          </div>
        )}

        <div className="bg-gray-800 rounded-2xl p-6 mb-6">
          <div className="flex flex-wrap justify-between items-center gap-2 mb-1">
            <h2 className="text-lg font-semibold">
              意思決定の提出状況（{session.currentYear}年 第{session.currentQuarter}四半期）
            </h2>
            <div className="flex items-center gap-2">
              <span className={`text-sm font-semibold ${allSubmitted ? "text-green-400" : "text-gray-400"}`}>
                {submittedCount} / {COMPANY_IDS.length} 社提出済み
              </span>
              <button onClick={() => setRefreshTick((t) => t + 1)} className="text-xs text-gray-400 hover:text-white">🔄 更新</button>
            </div>
          </div>
          {allSubmitted && (
            <div className="bg-green-900/40 border border-green-600 rounded-lg px-3 py-1.5 text-green-400 text-sm font-semibold mb-3">
              ✅ 全社提出済みです。ターン処理を実行できます。
            </div>
          )}
          {submissionError && <p className="text-yellow-400 text-xs mb-3">⚠️ {submissionError}（前回取得できた内容を表示しています）</p>}

          <div className="space-y-2 mb-5">
            {COMPANY_IDS.map((id) => {
              const state = companyStates[id];
              const status = submissionStatus?.companies.find((c) => c.companyId === id);
              const submitted = status?.submitted ?? false;
              const isResubmission = status?.isResubmission ?? false;
              const statusLabel = !submitted ? "⏳ 未提出" : isResubmission ? "🔁 再提出済み" : "✅ 提出済み";
              const statusColor = !submitted ? "text-yellow-400" : isResubmission ? "text-blue-400" : "text-green-400";
              return (
                <div key={id} className="bg-gray-700/60 rounded-xl px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className="font-bold">{COMPANIES[id].name}</span>
                      <span className="text-gray-400 text-sm">{COMPANIES[id].fullName}</span>
                      <span className="text-xs text-gray-500 bg-gray-800 px-2 py-0.5 rounded">{PLAYER_TYPE_LABELS[session.players[id]]}</span>
                      {state && <span className="text-gray-300 text-xs">現金 ${state.cash}M ｜ 信用 {state.creditScore}</span>}
                    </div>
                    <div className="flex items-center gap-3">
                      {showGmTestOperations && (
                        <Link href={`/company/${id}?game=${gameCode}&mode=gm-test`} className="text-xs text-purple-400 hover:text-purple-300 underline">
                          操作 →
                        </Link>
                      )}
                      <span className={`text-sm font-semibold ${statusColor}`}>{statusLabel}</span>
                    </div>
                  </div>
                  {status && (
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-400">
                      <span>操作者: {SUBMITTED_BY_LABELS[status.submittedBy]}</span>
                      <span>提出回数: {status.submissionCount}</span>
                      <span>最終提出: {formatJST(status.lastSubmittedAt)}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <button onClick={processTurn} disabled={processing} className="w-full py-3 bg-yellow-500 hover:bg-yellow-400 text-black rounded-xl font-bold text-sm disabled:opacity-50">
            {processing ? "処理中..." : `ターン処理を実行する（未提出社は既定値で処理）`}
          </button>
          {error && <p className="text-red-400 text-sm mt-2">{error}</p>}
        </div>

        {showGmTestOperations && (
          <TestGameManagement gameCode={gameCode} onChanged={reloadAll} />
        )}

        {/* ゲームログ：全ターンの履歴 */}
        {session.history?.length > 0 && (
          <div className="bg-gray-800 rounded-2xl p-6 mb-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">📜 ゲームログ</h2>
              {historyLoading && <span className="text-xs text-gray-400">読み込み中...</span>}
            </div>
            <div className="space-y-3">
              {[...session.history].reverse().map((key) => (
                <GameLogEntry key={key} quarterKey={key} result={historyResults[key]} decisions={historyDecisions[key]} />
              ))}
            </div>
          </div>
        )}

        {lastResult && (
          <div className="bg-gray-800 rounded-2xl p-6">
            <h2 className="text-lg font-semibold mb-4">処理結果：{lastResult.year}年 第{lastResult.quarter}四半期</h2>
            <div className="space-y-3">
              {COMPANY_IDS.map((id) => {
                const r = lastResult.companies[id];
                if (!r) return null;
                return (
                  <div key={id} className="bg-gray-700/60 rounded-xl p-4">
                    <div className="flex justify-between items-center mb-2">
                      <span className="font-bold">{COMPANIES[id].name} — {COMPANIES[id].fullName}</span>
                      <span className={r.netIncome >= 0 ? "text-green-400 font-semibold" : "text-red-400 font-semibold"}>
                        純利益 {r.netIncome >= 0 ? "+" : ""}${r.netIncome}M
                      </span>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs text-gray-300 mb-2">
                      <span>売上 ${r.revenue}M</span>
                      <span>売上原価 ${r.cogs}M</span>
                      <span>加工費 ${r.processingCost}M</span>
                      <span>金利 ${r.interestExpense}M</span>
                      <span>現金 ${r.stateAfter.cash}M</span>
                      <span>純資産 ${r.stateAfter.equity}M</span>
                      <span>D/E {r.stateAfter.debtEquityRatio}x</span>
                      <span>信用 {r.stateAfter.creditScore}</span>
                    </div>
                    {r.notes.length > 0 && (
                      <ul className="text-xs text-yellow-400/90 list-disc list-inside space-y-0.5">
                        {r.notes.map((n, i) => <li key={i}>{n}</li>)}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── 定数 ────────────────────────────────────────────────────────────
const MARKETS = ["EU（バルク）", "日本（VAP）", "米国（バルク）", "国内（スポット）"] as const;
const MARKET_PRICES: Record<string, number> = { "EU（バルク）": 3.8, "日本（VAP）": 8.5, "米国（バルク）": 3.6, "国内（スポット）": 3.2 };
const COMPANY_COLORS: Record<CompanyId, string> = { A: "text-blue-400", B: "text-green-400", C: "text-purple-400", D: "text-orange-400", E: "text-red-400" };

function r2(v: number) { return Math.round(v * 100) / 100; }
function money(v: number) { return `$${r2(Math.abs(v)).toFixed(2)}M`; }
function signed(v: number) { return `${v >= 0 ? "+" : "−"}${money(v)}`; }

// ─── 各社詳細カード ──────────────────────────────────────────────────
function CompanyDetailCard({ id, r, decision }: { id: CompanyId; r: CompanyTurnResult; decision?: CompanyDecision }) {
  const [collapsed, setCollapsed] = useState(false);
  const cashNeg = r.stateAfter.cash < 0;

  // 損益計算書の中間値
  const totalCogs = r2(r.cogs + r.processingCost);
  const grossProfit = r2(r.revenue - totalCogs);
  const operatingIncome = r2(grossProfit - r.overhead);

  // 簡易キャッシュフロー
  const cashChange = r2(r.stateAfter.cash - r.stateBefore.cash);
  const financingCF = r2(cashChange - r.netIncome);

  // ── BS 導出値 ──
  // stateAfter に個別フィールドが存在すればそれを使い、
  // なければ当期の取引データ・stateBefore から再導出してフォールバック。
  // （エンジン改修前に処理された旧ターン結果でも常に全行を表示するため）
  const s = r.stateAfter;
  const debt = r2(s.totalAssets - s.equity);

  // 流動資産
  const ar      = s.accountsReceivable ?? r2(r.revenue / 3);
  const rawInvM = s.rawInventory        ?? r2((r.rawInventoryAfter  ?? 0) * 2.1 / 1000);
  const finInvM = s.finishedInventory   ?? r2(
    ((r.bulkInventoryAfter ?? 0) * 2.5 + (r.vapInventoryAfter ?? 0) * 4.5) / 1000,
  );
  // 固定資産
  // 優先順位: stateAfter → stateBefore（建物は1Q分償却） → COMPANIES初期値
  // equipmentGross（取得原価）はゲーム中に増減しないため COMPANIES 値が常に有効な最終FB
  // buildingsNet は経過四半期数で推計（0.9875^処理済四半期数）
  const quartersProcessed = (r.year - 2015) * 4 + r.quarter;
  const bldgNet = s.buildingsNet
    ?? (r.stateBefore.buildingsNet !== undefined
      ? r2(r.stateBefore.buildingsNet * 0.9875)
      : r2(COMPANIES[id].buildingsNet * Math.pow(0.9875, quartersProcessed)));
  const eqGross = s.equipmentGross ?? r.stateBefore.equipmentGross ?? COMPANIES[id].equipmentGross;
  // 設備純額はplug（BS恒等式を保証: 資産合計 = 現金 + 売掛金 + 在庫 + 建物 + 設備純額）
  const eqNet    = r2(s.totalAssets - s.cash - ar - rawInvM - finInvM - bldgNet);
  const accumDepr = r2(eqGross - eqNet);

  // 負債の内訳（旧データでフィールドがない場合はエンジンと同じ計算式で導出）
  // 買掛金 = COGS×30%（農業費＋調達費の30日支払サイト）
  // 短期:長期 = 3:7（買掛金控除後の負債を按分）
  const apDerived  = r2(r.cogs * 0.3);
  const adjDebt    = Math.max(0, r2(debt - apDerived));
  const ap  = s.accountsPayable ?? apDerived;
  const stl = s.shortTermLoans  ?? r2(adjDebt * 0.3);
  const ltl = s.longTermLoans   ?? r2(adjDebt - r2(adjDebt * 0.3));

  // 純資産内訳
  const pic      = s.paidInCapital ?? r.stateBefore.paidInCapital ?? COMPANIES[id].paidInCapital;
  const retained = r2(s.equity - pic);

  return (
    <div className={`rounded-xl overflow-hidden ${cashNeg ? "border border-red-700/50" : "border border-gray-700/40"}`}>
      {/* ─ ヘッダ行（クリックで折りたたみ） ─ */}
      <button
        onClick={() => setCollapsed((c) => !c)}
        className={`w-full px-4 py-2.5 flex items-center justify-between text-left transition-colors ${cashNeg ? "bg-red-900/20 hover:bg-red-900/30" : "bg-gray-800/60 hover:bg-gray-700/60"}`}
      >
        <div className="flex items-center gap-3 flex-wrap">
          <span className={`font-bold ${COMPANY_COLORS[id]}`}>{COMPANIES[id].name}</span>
          <span className="text-gray-400 text-xs">{COMPANIES[id].fullName}</span>
          <span className="text-gray-500 text-xs">売上 <span className="text-gray-200">{money(r.revenue)}</span></span>
          <span className="text-gray-500 text-xs">純利益 <span className={r.netIncome >= 0 ? "text-green-400 font-semibold" : "text-red-400 font-semibold"}>{signed(r.netIncome)}</span></span>
          <span className="text-gray-500 text-xs">現金 <span className={cashNeg ? "text-red-400 font-semibold" : "text-gray-200"}>{money(r.stateAfter.cash)}</span></span>
          <span className="text-gray-500 text-xs">信用 <span className="text-gray-200">{r.stateAfter.creditScore}</span></span>
        </div>
        <span className="text-gray-500 text-xs ml-2">{collapsed ? "▼ 展開" : "▲ 閉じる"}</span>
      </button>

      {/* ─ 詳細（デフォルト表示、クリックで折りたたみ可） ─ */}
      {!collapsed && (
        <div className="bg-gray-900/40 px-4 pb-4 pt-3 grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">

          {/* 損益計算書 */}
          <div>
            <p className="text-yellow-400 font-semibold mb-2">📊 損益計算書</p>
            <table className="w-full">
              <tbody className="space-y-0.5">
                <PLRow label="売上高" value={money(r.revenue)} bold />
                <PLRow label="　原料費（農業＋調達）" value={`−${money(r.cogs)}`} sub />
                <PLRow label="　加工費" value={`−${money(r.processingCost)}`} sub />
                <PLRow label="売上総利益" value={money(grossProfit)} bold color={grossProfit < 0 ? "text-red-400" : "text-green-300"} />
                <PLRow label="　販管費（固定費）" value={`−${money(r.overhead)}`} sub />
                <PLRow label="営業利益" value={signed(operatingIncome)} bold color={operatingIncome < 0 ? "text-red-400" : "text-green-300"} />
                <PLRow label="　支払利息" value={`−${money(r.interestExpense)}`} sub />
                <tr><td colSpan={2} className="border-t border-gray-700 pt-1" /></tr>
                <PLRow label="経常利益" value={signed(r.netIncome)} bold color={r.netIncome < 0 ? "text-red-400" : "text-green-400"} />
              </tbody>
            </table>
          </div>

          {/* 簡易キャッシュフロー */}
          <div>
            <p className="text-yellow-400 font-semibold mb-2">💧 簡易キャッシュフロー</p>
            <table className="w-full">
              <tbody>
                <PLRow label="期首現金" value={money(r.stateBefore.cash)} />
                <PLRow label="営業CF（当期純利益）" value={signed(r.netIncome)} />
                <PLRow label="財務CF（借入±返済±増資）" value={signed(financingCF)} />
                <tr><td colSpan={2} className="border-t border-gray-700 pt-1" /></tr>
                <PLRow label="期末現金" value={money(s.cash)} bold color={cashNeg ? "text-red-400" : "text-white"} />
                <PLRow label="　現金増減" value={signed(cashChange)} color={cashChange >= 0 ? "text-green-300" : "text-red-400"} />
              </tbody>
            </table>
          </div>

          {/* 貸借対照表（全幅） */}
          <div className="md:col-span-2">
            <p className="text-yellow-400 font-semibold mb-2">🏦 貸借対照表（期末）</p>
            <div className="grid grid-cols-2 gap-x-6">

              {/* ── 資産の部 ── */}
              <div>
                <p className="text-gray-400 font-semibold mb-1 text-xs">【資産の部】</p>
                <p className="text-gray-600 text-xs mb-0.5">〈流動資産〉</p>
                <BSRow label="現金・預金" value={money(s.cash)} alert={cashNeg} />
                <BSRow label="売掛金" value={money(ar)} />
                <BSRow label="原料在庫（評価額）" value={money(rawInvM)} />
                <BSRow label="製品在庫（評価額）" value={money(finInvM)} />
                <p className="text-gray-600 text-xs mt-2 mb-0.5">〈固定資産〉</p>
                <BSRow label="建物（純額）" value={money(bldgNet)} />
                <BSRow label="設備（総額）" value={money(eqGross)} />
                <BSRow label="△減価償却累計" value={money(accumDepr)} neg />
                <div className="border-t border-gray-500 my-1.5" />
                <BSRow label="資産合計" value={money(s.totalAssets)} bold />
              </div>

              {/* ── 負債・純資産の部 ── */}
              <div>
                <p className="text-gray-400 font-semibold mb-1 text-xs">【負債の部】</p>
                <p className="text-gray-600 text-xs mb-0.5">〈流動負債〉</p>
                <BSRow label="買掛金" value={money(ap)} />
                <BSRow label="短期借入金" value={money(stl)} />
                <p className="text-gray-600 text-xs mt-2 mb-0.5">〈固定負債〉</p>
                <BSRow label="長期借入金" value={money(ltl)} />
                <div className="border-t border-gray-600 my-1.5" />
                <BSRow label="負債合計" value={money(debt)} bold />

                <p className="text-gray-400 font-semibold mt-3 mb-1 text-xs">【純資産の部】</p>
                <BSRow label="資本金（払込済）" value={money(pic)} />
                <BSRow label="利益剰余金" value={money(retained)} alert={retained < 0} />
                <div className="border-t border-gray-600 my-1.5" />
                <BSRow label="純資産合計" value={money(s.equity)} bold />
                <div className="border-t-2 border-gray-400 my-1.5" />
                <BSRow label="負債純資産合計" value={money(s.totalAssets)} bold />
                <p className="text-gray-600 text-right pt-1">D/E比率: {s.debtEquityRatio}x ｜ 信用スコア: {s.creditScore}</p>
              </div>
            </div>
          </div>

          {/* 数量・在庫 ＋ 市場別販売 */}
          <div className="space-y-4">
            <div>
              <p className="text-yellow-400 font-semibold mb-2">📦 数量結果</p>
              <table className="w-full">
                <tbody>
                  <QRow label="投入可能原料" value={`${r.rawMaterialAvailable.toLocaleString()} t`} />
                  <QRow label="　うち加工に使用" value={`${r.rawMaterialUsed.toLocaleString()} t`} />
                  <QRow label="　原料在庫繰越（冷凍）" value={`${(r.rawInventoryAfter ?? 0).toLocaleString()} t`} hl={(r.rawInventoryAfter ?? 0) > 0} />
                  <tr><td colSpan={2} className="pt-1" /></tr>
                  <QRow label="バルク生産量" value={`${r.productOutput.bulk.toFixed(0)} t`} />
                  <QRow label="VAP生産量" value={`${r.productOutput.vap.toFixed(0)} t`} />
                  <tr><td colSpan={2} className="border-t border-gray-700 pt-1" /></tr>
                  <QRow label="バルク製品在庫繰越" value={`${(r.bulkInventoryAfter ?? 0).toFixed(0)} t`} hl={(r.bulkInventoryAfter ?? 0) > 0} />
                  <QRow label="VAP製品在庫繰越" value={`${(r.vapInventoryAfter ?? 0).toFixed(0)} t`} hl={(r.vapInventoryAfter ?? 0) > 0} />
                </tbody>
              </table>
            </div>

            <div>
              <p className="text-yellow-400 font-semibold mb-2">🌏 市場別販売</p>
              <table className="w-full">
                <thead>
                  <tr className="text-gray-500">
                    <th className="text-left font-normal pb-1">市場</th>
                    <th className="text-right font-normal pb-1">数量</th>
                    <th className="text-right font-normal pb-1">売上高</th>
                  </tr>
                </thead>
                <tbody>
                  {MARKETS.map((market) => {
                    const qty = r.salesByMarket[market] ?? 0;
                    const rev = r2(qty * MARKET_PRICES[market] / 1000);
                    return (
                      <tr key={market} className={qty > 0 ? "" : "opacity-30"}>
                        <td className="text-gray-400 py-0.5">{market}</td>
                        <td className="text-right text-gray-200">{qty > 0 ? `${qty.toLocaleString()} t` : "—"}</td>
                        <td className="text-right text-gray-200">{qty > 0 ? `$${rev.toFixed(2)}M` : "—"}</td>
                      </tr>
                    );
                  })}
                  <tr className="border-t border-gray-700">
                    <td className="text-gray-300 font-semibold pt-1">合計</td>
                    <td />
                    <td className="text-right text-white font-semibold pt-1">{money(r.revenue)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* 意思決定内容 */}
          <div className="md:col-span-2">
            <DecisionPanel decision={decision} submitted={r.submitted} result={r} />
          </div>

          {/* 注記 */}
          {r.notes.length > 0 && (
            <div className="md:col-span-2 bg-yellow-900/20 rounded-lg p-3 space-y-1">
              <p className="text-yellow-400 font-semibold mb-1">📝 注記</p>
              {r.notes.map((n, i) => <p key={i} className="text-yellow-300/80">{n}</p>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── 意思決定パネル ──────────────────────────────────────────────────
const FACTORY_LABEL: Record<string, string> = { none: "申請なし", expand: "既存工場の拡張を申請", new: "新工場の建設を申請" };
const SOURCE_LABEL: Record<string, string> = { spot: "スポット市場 ($2.3/kg)", contract: "既存契約農家 ($1.9/kg)" };
const EQUITY_LABEL: Record<string, string> = { swf: "中東SWF", sogo: "日本商社", asia: "アジア戦略投資家" };

function DecisionPanel({ decision, submitted, result }: { decision?: CompanyDecision; submitted: boolean; result: CompanyTurnResult }) {
  if (!submitted) {
    const defaultFarming = (result.stateBefore.farmingArea ?? 0) * 3;
    return (
      <div className="bg-gray-800/50 rounded-lg p-3 border border-amber-900/40">
        <div className="flex items-center gap-2 mb-2">
          <p className="text-yellow-400 font-semibold">🗂 意思決定（既定値で処理）</p>
          <span className="text-xs text-gray-500">⚠ 意思決定未提出のためシステム既定値を適用</span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-1">
          <DRow phase="F2 養殖投入（既定）" value={`${defaultFarming.toLocaleString()} t`} />
          <DRow phase="F3 外部調達（既定）" value="0 t" />
          <DRow phase="F4 VAP比率（既定）" value="30 %" />
          {MARKETS.map((market) => {
            const qty = result.salesByMarket[market] ?? 0;
            return qty > 0 ? (
              <DRow key={market} phase={`F5 ${market}`} value={`${qty.toLocaleString()} t`} />
            ) : null;
          })}
        </div>
      </div>
    );
  }
  if (!decision) {
    return (
      <div className="bg-gray-800/50 rounded-lg p-3 border border-gray-700/40">
        <p className="text-yellow-400 font-semibold mb-1">🗂 意思決定</p>
        <p className="text-gray-500">データ取得中...</p>
      </div>
    );
  }
  const p = decision.phases;
  const markets = ["EU（バルク）", "日本（VAP）", "米国（バルク）", "国内（スポット）"] as const;
  return (
    <div className="bg-gray-800/50 rounded-lg p-3 border border-gray-700/40">
      <div className="flex items-center gap-3 mb-2">
        <p className="text-yellow-400 font-semibold">🗂 意思決定</p>
        <span className="text-gray-500 text-xs">提出回数: {decision.submissionCount} ｜ 最終提出: {formatJST(decision.lastSubmittedAt)} ｜ 操作者: {decision.submittedBy}</span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-1">
        {/* F1 設備投資 */}
        {p["phase1_factory"] && p["phase1_factory"] !== "none" && (
          <DRow phase="F1 設備投資" value={FACTORY_LABEL[p["phase1_factory"]] ?? p["phase1_factory"]} />
        )}
        {/* F2 生産計画 */}
        {p["phase2_farming"] && (
          <DRow phase="F2 養殖投入" value={`${Number(p["phase2_farming"]).toLocaleString()} t`} />
        )}
        {/* F3 調達 */}
        {p["phase3_procurement"] && (
          <DRow phase="F3 外部調達" value={`${Number(p["phase3_procurement"]).toLocaleString()} t`} />
        )}
        {p["phase3_source"] && (
          <DRow phase="F3 調達先" value={SOURCE_LABEL[p["phase3_source"]] ?? p["phase3_source"]} />
        )}
        {/* F4 加工 */}
        {p["phase4_vap_ratio"] !== undefined && p["phase4_vap_ratio"] !== "" && (
          <DRow phase="F4 VAP比率" value={`${p["phase4_vap_ratio"]} %`} />
        )}
        {/* F5 販売 */}
        {markets.map((m) => {
          const qty = p[`phase5_${m}`];
          return qty && Number(qty) > 0 ? (
            <DRow key={m} phase={`F5 ${m}`} value={`${Number(qty).toLocaleString()} t`} />
          ) : null;
        })}
        {/* F6 財務 */}
        {p["phase6_borrow"] && Number(p["phase6_borrow"]) > 0 && (
          <DRow phase="F6 借入" value={`$${p["phase6_borrow"]}M`} />
        )}
        {p["phase6_repay"] && Number(p["phase6_repay"]) > 0 && (
          <DRow phase="F6 返済" value={`$${p["phase6_repay"]}M`} />
        )}
        {p["phase6_equity"] && p["phase6_equity"] !== "" && (
          <DRow phase="F6 増資申請" value={EQUITY_LABEL[p["phase6_equity"]] ?? p["phase6_equity"]} />
        )}
      </div>
    </div>
  );
}
function DRow({ phase, value }: { phase: string; value: string }) {
  return (
    <div className="py-0.5">
      <span className="text-gray-500">{phase}: </span>
      <span className="text-gray-200">{value}</span>
    </div>
  );
}

// ─── 補助コンポーネント ──────────────────────────────────────────────
function PLRow({ label, value, bold, sub, color }: { label: string; value: string; bold?: boolean; sub?: boolean; color?: string }) {
  return (
    <tr>
      <td className={`py-0.5 ${sub ? "pl-3 text-gray-500" : bold ? "text-gray-300 font-semibold" : "text-gray-400"}`}>{label}</td>
      <td className={`text-right py-0.5 ${color ?? (bold ? "text-white font-semibold" : "text-gray-300")}`}>{value}</td>
    </tr>
  );
}
function BSRow({ label, value, bold, neg, alert }: { label: string; value: string; bold?: boolean; neg?: boolean; alert?: boolean }) {
  return (
    <div className="flex justify-between py-0.5">
      <span className={bold ? "text-gray-300 font-semibold" : "text-gray-500"}>{label}</span>
      <span className={alert ? "text-red-400 font-semibold" : neg ? "text-orange-400" : bold ? "text-white font-semibold" : "text-gray-300"}>{neg ? `△${value}` : value}</span>
    </div>
  );
}
function QRow({ label, value, hl }: { label: string; value: string; hl?: boolean }) {
  return (
    <tr>
      <td className="text-gray-500 py-0.5">{label}</td>
      <td className={`text-right py-0.5 ${hl ? "text-yellow-300 font-semibold" : "text-gray-300"}`}>{value}</td>
    </tr>
  );
}

// ─── 四半期ログエントリ ──────────────────────────────────────────────
function GameLogEntry({ quarterKey, result, decisions }: { quarterKey: string; result: TurnResult | undefined; decisions?: Partial<Record<CompanyId, CompanyDecision>> }) {
  const [open, setOpen] = useState(false);

  if (!result) {
    return (
      <div className="bg-gray-700/30 rounded-xl px-4 py-3 text-gray-500 text-sm">
        {quarterKey} — データ未取得
      </div>
    );
  }

  const totalRevenue = COMPANY_IDS.reduce((s, id) => s + (result.companies[id]?.revenue ?? 0), 0);
  const alerts = COMPANY_IDS.filter((id) => {
    const r = result.companies[id];
    return r && (r.stateAfter.cash < 0 || r.notes.length > 0);
  });

  return (
    <div className="bg-gray-700/30 rounded-xl overflow-hidden">
      {/* 四半期ヘッダ */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-gray-700/50 transition-colors"
      >
        <div className="flex items-center gap-3 flex-wrap">
          <span className="font-semibold">{result.year}年 第{result.quarter}四半期</span>
          <span className="text-xs text-gray-400">全社合計売上 ${r2(totalRevenue).toFixed(2)}M</span>
          {alerts.length > 0 && (
            <span className="text-xs text-yellow-400 bg-yellow-900/30 px-2 py-0.5 rounded">
              ⚠ {alerts.length}社に注記あり
            </span>
          )}
        </div>
        <span className="text-gray-500 text-xs">{open ? "▲ 閉じる" : "▼ 詳細を見る"}</span>
      </button>

      {open && (
        <div className="border-t border-gray-700 px-4 pb-5 pt-4 space-y-4">

          {/* 市場別売上マトリクス（全社一覧） */}
          <div>
            <p className="text-xs text-gray-400 font-semibold mb-2 uppercase tracking-wide">🌏 市場別販売数量（全社）</p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-center border-collapse">
                <thead>
                  <tr className="text-gray-500">
                    <th className="text-left font-normal py-1 pr-3">会社</th>
                    {MARKETS.map((m) => <th key={m} className="font-normal py-1 px-2">{m}</th>)}
                    <th className="font-normal py-1 px-2">合計売上</th>
                    <th className="font-normal py-1 px-2">純利益</th>
                  </tr>
                </thead>
                <tbody>
                  {COMPANY_IDS.map((id) => {
                    const r = result.companies[id];
                    if (!r) return null;
                    return (
                      <tr key={id} className="border-t border-gray-800">
                        <td className={`text-left py-1.5 pr-3 font-semibold ${COMPANY_COLORS[id]}`}>{COMPANIES[id].name}</td>
                        {MARKETS.map((market) => {
                          const qty = r.salesByMarket[market] ?? 0;
                          return (
                            <td key={market} className={`py-1.5 px-2 ${qty > 0 ? "text-gray-200" : "text-gray-700"}`}>
                              {qty > 0 ? `${qty.toLocaleString()}t` : "—"}
                            </td>
                          );
                        })}
                        <td className="py-1.5 px-2 text-white font-semibold">${r2(r.revenue).toFixed(2)}M</td>
                        <td className={`py-1.5 px-2 font-semibold ${r.netIncome >= 0 ? "text-green-400" : "text-red-400"}`}>
                          {r.netIncome >= 0 ? "+" : ""}${r2(r.netIncome).toFixed(2)}M
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* 各社詳細カード */}
          <div>
            <p className="text-xs text-gray-400 font-semibold mb-2 uppercase tracking-wide">各社詳細（クリックで展開）</p>
            <div className="space-y-2">
              {COMPANY_IDS.map((id) => {
                const r = result.companies[id];
                if (!r) return null;
                return <CompanyDetailCard key={id} id={id} r={r} decision={decisions?.[id]} />;
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
