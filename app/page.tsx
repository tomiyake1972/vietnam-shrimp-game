"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
export default function Home() {
  const [gameCode, setGameCode] = useState("");
  const [error, setError] = useState("");
  const router = useRouter();
  const handleJoin = async () => {
    if (!gameCode.trim()) return;
    const res = await fetch(`/api/game/${gameCode.toUpperCase()}`);
    if (!res.ok) { setError("ゲームコードが見つかりません"); return; }
    router.push(`/lobby/${gameCode.toUpperCase()}`);
  };
  return (
    <main className="min-h-screen bg-gray-900 text-white flex flex-col items-center justify-center p-8">
      <div className="max-w-md w-full">
        <div className="text-center mb-10">
          <h1 className="text-4xl font-bold mb-2">🦐 ベトナムエビ輸出事業</h1>
          <p className="text-gray-400">経営シミュレーションゲーム</p>
        </div>
        <div className="bg-gray-800 rounded-2xl p-6 mb-4">
          <h2 className="text-lg font-semibold mb-4">ゲームに参加する</h2>
          <div className="flex gap-2">
            <input type="text" placeholder="ゲームコード（例：ABC123）" value={gameCode}
              onChange={(e) => { setGameCode(e.target.value.toUpperCase()); setError(""); }}
              className="flex-1 bg-gray-700 rounded-lg px-4 py-3 text-sm uppercase tracking-widest" maxLength={6} />
            <button onClick={handleJoin} className="px-5 py-3 bg-blue-600 hover:bg-blue-500 rounded-lg font-semibold">参加</button>
          </div>
          {error && <p className="text-red-400 text-sm mt-2">{error}</p>}
        </div>
        <div className="text-center">
          <a href="/gm" className="text-gray-400 hover:text-white text-sm underline">GMコンソール（ゲームマスター専用）→</a>
        </div>
      </div>
    </main>
  );
}
