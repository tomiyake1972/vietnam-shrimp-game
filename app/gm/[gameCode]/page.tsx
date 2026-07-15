"use client";
import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { COMPANIES, CompanyId } from "../../lib/gameData";
import { CompanyDecision, CompanyState, GameSession, TurnResult } from "../../lib/gameTypes";

const COMPANY_IDS: CompanyId[] = ["A", "B", "C", "D", "E"];

export default function GmGamePage({ params }: { params: Promise<{ gameCode: string }> }) {
  const [gameCode, setGameCode] = useState("");
  const [session, setSession] = useState<GameSession | null>(null);
  const [companyStates, setCompanyStates] = useState<Record<string, CompanyState>>({});
  const [decisions, setDecisions] = useState<Record<string, CompanyDecision>>({});
  const [processing, setProcessing] = useState(false);
  const [lastResult, setLastResult] = useState<TurnResult | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async (code: string) => {
    const [gameRes, decisionsRes] = await Promise.all([
      fetch(`/api/game/${code}`),
      fetch(`/api/game/${code}/decisions`),
    ]);
    if (!gameRes.ok) { setError("ゲームが見つかりません"); return; }
    const gameData = await gameRes.json();
    setSession(gameData.session);
    setCompanyStates(gameData.companyStates);
    setDecisions(await decisionsRes.json());
  }, []);

  useEffect(() => {
    params.then(({ gameCode }) => { setGameCode(gameCode); load(gameCode); });
  }, [params, load]);

  const processTurn = async () => {
    setProcessing(true);
    setError("");
    try {
      const res = await fetch(`/api/game/${gameCode}/process-turn`, { method: "POST" });
      if (!res.ok) { const d = await res.json().catch(() => ({})); setError(d.error || "ターン処理に失敗しました"); return; }
      const data = await res.json();
      setLastResult(data.result);
      await load(gameCode);
    } finally {
      setProcessing(false);
    }
  };

  if (error && !session) {
    return <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center"><p className="text-red-400">{error}</p></div>;
  }
  if (!session) return <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center"><p>読み込み中...</p></div>;

  const submittedCount = COMPANY_IDS.filter((id) => decisions[id]).length;

  return (
    <div className="min-h-screen bg-gray-900 text-white p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-2xl font-bold tracking-widest text-yellow-400">{gameCode}</h1>
            <p className="text-gray-400 text-sm">{session.title} ｜ {session.currentYear}年 第{session.currentQuarter}四半期</p>
          </div>
          <Link href="/gm" className="text-gray-400 hover:text-white text-sm">← GMコンソール</Link>
        </div>

        <div className="bg-gray-800 rounded-2xl p-6 mb-6">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-semibold">意思決定の提出状況（{session.currentYear}年Q{session.currentQuarter}）</h2>
            <span className="text-sm text-gray-400">{submittedCount} / {COMPANY_IDS.length} 社</span>
          </div>
          <div className="space-y-2 mb-5">
            {COMPANY_IDS.map((id) => {
              const state = companyStates[id];
              const submitted = Boolean(decisions[id]);
              return (
                <div key={id} className="flex items-center justify-between bg-gray-700/60 rounded-xl px-4 py-3">
                  <div className="flex items-center gap-3">
                    <span className="font-bold">{COMPANIES[id].name}</span>
                    <span className="text-gray-400 text-sm">{COMPANIES[id].fullName}</span>
                    <span className="text-xs text-gray-500">{session.players[id]}</span>
                  </div>
                  <div className="flex items-center gap-4 text-sm">
                    {state && <span className="text-gray-300">現金 ${state.cash}M ｜ 信用 {state.creditScore}</span>}
                    <span className={submitted ? "text-green-400" : "text-yellow-400"}>{submitted ? "✅ 提出済" : "⏳ 未提出"}</span>
                  </div>
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
