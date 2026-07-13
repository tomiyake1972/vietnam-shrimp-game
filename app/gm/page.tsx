"use client";
import { useState, useEffect } from "react";
import Link from "next/link";
import { COMPANIES, CompanyId } from "../lib/gameData";
import { GameSession, PlayerType } from "../lib/gameTypes";
const playerOptions: { value: PlayerType; label: string }[] = [
  { value: "human", label: "👤 プレイヤー" },
  { value: "ai-b", label: "🤖 AI（中級）" },
  { value: "ai-a", label: "🤖 AI（上級）" },
  { value: "ai-c", label: "🤖 AI（初級）" },
];
export default function GmPage() {
  const [games, setGames] = useState<GameSession[]>([]);
  const [title, setTitle] = useState("");
  const [players, setPlayers] = useState<Record<CompanyId, PlayerType>>({ A:"human", B:"ai-b", C:"ai-b", D:"ai-b", E:"ai-b" });
  const [creating, setCreating] = useState(false);
  const [newGame, setNewGame] = useState<{ gameCode: string } | null>(null);
  useEffect(() => { fetch("/api/game").then(r => r.json()).then(setGames); }, []);
  const createGame = async () => {
    setCreating(true);
    const res = await fetch("/api/game", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ title, players }) });
    const data = await res.json();
    setNewGame(data);
    setCreating(false);
    fetch("/api/game").then(r => r.json()).then(setGames);
  };
  return (
    <div className="min-h-screen bg-gray-900 text-white p-8">
      <div className="max-w-3xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-bold">🎮 GMコンソール</h1>
          <Link href="/" className="text-gray-400 hover:text-white text-sm">← プレイヤー画面</Link>
        </div>
        <div className="bg-gray-800 rounded-2xl p-6 mb-8">
          <h2 className="text-xl font-semibold mb-4">新しいゲームを作成</h2>
          <div className="mb-4">
            <label className="block text-sm text-gray-400 mb-1">ゲームタイトル</label>
            <input type="text" placeholder="例：2025年7月研修 第1回" value={title} onChange={(e) => setTitle(e.target.value)} className="w-full bg-gray-700 rounded-lg px-4 py-2 text-sm" />
          </div>
          <div className="mb-5">
            <label className="block text-sm text-gray-400 mb-2">プレイヤー設定</label>
            <div className="space-y-2">
              {(Object.keys(COMPANIES) as CompanyId[]).map((id) => (
                <div key={id} className="flex items-center gap-3">
                  <span className="w-36 text-sm text-gray-300">{COMPANIES[id].name} {COMPANIES[id].fullName}</span>
                  <select value={players[id]} onChange={(e) => setPlayers({...players, [id]: e.target.value as PlayerType})} className="flex-1 bg-gray-700 rounded-lg px-3 py-1.5 text-sm">
                    {playerOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
              ))}
            </div>
          </div>
          <button onClick={createGame} disabled={creating} className="w-full py-3 bg-yellow-500 hover:bg-yellow-400 text-black rounded-xl font-bold text-sm disabled:opacity-50">
            {creating ? "作成中..." : "ゲームを作成する"}
          </button>
          {newGame && (
            <div className="mt-4 bg-green-900/40 border border-green-500 rounded-xl p-4 text-center">
              <p className="text-green-400 text-sm mb-1">ゲームが作成されました！</p>
              <p className="text-4xl font-bold tracking-widest text-white mb-2">{newGame.gameCode}</p>
              <p className="text-gray-400 text-xs">このコードをプレイヤーに伝えてください</p>
              <p className="text-gray-400 text-xs mt-1">参加URL: <span className="text-blue-400">{typeof window !== "undefined" ? window.location.origin : ""}/lobby/{newGame.gameCode}</span></p>
            </div>
          )}
        </div>
        {games.length > 0 && (
          <div className="bg-gray-800 rounded-2xl p-6">
            <h2 className="text-lg font-semibold mb-4">過去のゲーム</h2>
            <div className="space-y-3">
              {games.map((game) => (
                <div key={game.gameCode} className="flex justify-between items-center bg-gray-700 rounded-xl p-4">
                  <div>
                    <span className="font-bold tracking-wider text-yellow-400">{game.gameCode}</span>
                    <span className="ml-3 text-sm text-gray-300">{game.title}</span>
                    <span className="ml-3 text-xs text-gray-500">{game.currentYear}年Q{game.currentQuarter}</span>
                  </div>
                  <Link href={`/lobby/${game.gameCode}`} className="text-xs text-blue-400 hover:text-blue-300">開く →</Link>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
