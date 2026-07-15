"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { COMPANIES, CompanyId } from "../../lib/gameData";
import { CompanyState, GameSession, PlayerType, SubmissionStatusResponse, SubmittedBy, TurnResult } from "../../lib/gameTypes";

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

  async function load(code: string) {
    const gameRes = await fetch(`/api/game/${code}`);
    if (!gameRes.ok) { setError("ゲームが見つかりません"); return; }
    const gameData = await gameRes.json();
    setSession(gameData.session);
    setCompanyStates(gameData.companyStates);
  }

  // セッション・会社状態の読み込み（マウント時、ターン処理後）
  useEffect(() => {
    fetch(`/api/game/${gameCode}`).then((r) => (r.ok ? r.json() : null)).then((data) => {
      if (!data) { setError("ゲームが見つかりません"); return; }
      setSession(data.session);
      setCompanyStates(data.companyStates);
    });
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
                    <span className={`text-sm font-semibold ${statusColor}`}>{statusLabel}</span>
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
