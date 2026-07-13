"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { COMPANIES, CompanyId } from "../../lib/gameData";
import { GameSession } from "../../lib/gameTypes";
const colorMap: Record<string, string> = { blue:"bg-blue-600 hover:bg-blue-700", green:"bg-green-600 hover:bg-green-700", purple:"bg-purple-600 hover:bg-purple-700", orange:"bg-orange-500 hover:bg-orange-600", red:"bg-red-600 hover:bg-red-700" };
const playerTypeLabel: Record<string, string> = { "human":"👤 プレイヤー", "ai-a":"🤖 AI（上級）", "ai-b":"🤖 AI（中級）", "ai-c":"🤖 AI（初級）" };
export default function LobbyPage({ params }: { params: Promise<{ gameCode: string }> }) {
  const [gameCode, setGameCode] = useState("");
  const [session, setSession] = useState<GameSession | null>(null);
  const router = useRouter();
  useEffect(() => {
    params.then(({ gameCode }) => {
      setGameCode(gameCode);
      fetch(`/api/game/${gameCode}`).then(r => r.json()).then(d => setSession(d.session));
    });
  }, [params]);
  if (!session) return <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center"><p>読み込み中...</p></div>;
  const humanCompanies = Object.entries(session.players).filter(([,type]) => type === "human").map(([id]) => id as CompanyId);
  return (
    <div className="min-h-screen bg-gray-900 text-white flex flex-col items-center justify-center p-8">
      <div className="max-w-lg w-full">
        <div className="text-center mb-8">
          <p className="text-gray-400 text-sm mb-1">ゲームコード</p>
          <h1 className="text-5xl font-bold tracking-widest text-yellow-400">{gameCode}</h1>
          <p className="text-xl font-semibold mt-2">{session.title}</p>
          <p className="text-gray-400 text-sm">{session.currentYear}年 第{session.currentQuarter}四半期</p>
        </div>
        <div className="bg-gray-800 rounded-2xl p-5 mb-4">
          <h2 className="text-sm text-gray-400 mb-3 font-semibold uppercase tracking-wide">あなたの担当会社を選んでください</h2>
          <div className="space-y-2">
            {humanCompanies.map((id) => {
              const company = COMPANIES[id];
              return (
                <button key={id} onClick={() => router.push(`/company/${id}?game=${gameCode}`)} className={`w-full ${colorMap[company.color]} rounded-xl p-4 text-left transition-colors`}>
                  <div className="flex justify-between items-center">
                    <div><span className="font-bold text-lg">{company.name}</span><span className="ml-3 text-white/80">{company.fullName}</span></div>
                    <span className="text-white/70 text-sm">現金 ${company.cash}M</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
        <div className="bg-gray-800 rounded-xl p-4">
          <h3 className="text-sm text-gray-400 mb-2">AI担当会社</h3>
          <div className="space-y-1">
            {Object.entries(session.players).filter(([,type]) => type !== "human").map(([id, type]) => (
              <div key={id} className="flex justify-between text-sm">
                <span className="text-gray-300">{COMPANIES[id as CompanyId].name} — {COMPANIES[id as CompanyId].fullName}</span>
                <span className="text-gray-500">{playerTypeLabel[type]}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
