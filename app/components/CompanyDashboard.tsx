"use client";
import { useState } from "react";
import Link from "next/link";
import { CompanyProfile } from "../lib/gameData";
interface Phase { id: number; title: string; description: string; }
interface Props { company: CompanyProfile; phases: Phase[]; gameCode?: string; }
const colorBg: Record<string,string> = { blue:"bg-blue-600", green:"bg-green-600", purple:"bg-purple-600", orange:"bg-orange-500", red:"bg-red-600" };
const colorBorder: Record<string,string> = { blue:"border-blue-500", green:"border-green-500", purple:"border-purple-500", orange:"border-orange-400", red:"border-red-500" };
const colorText: Record<string,string> = { blue:"text-blue-400", green:"text-green-400", purple:"text-purple-400", orange:"text-orange-400", red:"text-red-400" };
export default function CompanyDashboard({ company, phases, gameCode }: Props) {
  const [currentPhase, setCurrentPhase] = useState(0);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [decisions, setDecisions] = useState<Record<string,string>>({});
  const handleSubmit = async () => {
    setSubmitting(true);
    if (gameCode) {
      await fetch(`/api/game/${gameCode}/decisions`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ companyId: company.id, phases: decisions }) });
    }
    setSubmitted(true); setSubmitting(false);
  };
  const debt = company.totalAssets - company.equity;
  const backUrl = gameCode ? `/lobby/${gameCode}` : "/";
  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <div className={`${colorBg[company.color]} px-6 py-4`}>
        <div className="max-w-5xl mx-auto flex justify-between items-center">
          <div>
            <h1 className="text-2xl font-bold">{company.name} — {company.fullName}</h1>
            <p className="text-white/80 text-sm">2015年 第1四半期{gameCode && ` | ゲーム: ${gameCode}`}</p>
          </div>
          <Link href={backUrl} className="text-white/70 hover:text-white text-sm">← 戻る</Link>
        </div>
      </div>
      <div className="max-w-5xl mx-auto px-6 py-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="space-y-4">
          <div className={`bg-gray-800 rounded-xl p-4 border-l-4 ${colorBorder[company.color]}`}>
            <h2 className="text-sm text-gray-400 mb-3 font-semibold uppercase tracking-wide">期初バランスシート</h2>
            <div className="space-y-2 text-sm">
              <Row label="現金" value={`$${company.cash}M`} highlight={company.cash < 8} />
              <Row label="総資産" value={`$${company.totalAssets}M`} />
              <Row label="負債" value={`$${debt}M`} />
              <Row label="純資産" value={`$${company.equity}M`} />
              <Row label="D/E比率" value={`${company.debtEquityRatio}x`} highlight={company.debtEquityRatio > 2.5} />
            </div>
          </div>
          <div className={`bg-gray-800 rounded-xl p-4 border-l-4 ${colorBorder[company.color]}`}>
            <h2 className="text-sm text-gray-400 mb-3 font-semibold uppercase tracking-wide">オペレーション</h2>
            <div className="space-y-2 text-sm">
              <Row label="養殖面積" value={`${company.farmingArea.toLocaleString()} ha`} />
              <Row label="加工能力" value={`${company.processingCapacity.toLocaleString()} t/Q`} />
            </div>
          </div>
          <div className={`bg-gray-800 rounded-xl p-4 border-l-4 ${colorBorder[company.color]}`}>
            <h2 className="text-sm text-gray-400 mb-3 font-semibold uppercase tracking-wide">信用スコア</h2>
            <div className="flex items-end gap-2">
              <span className={`text-4xl font-bold ${colorText[company.color]}`}>{company.creditScore}</span>
              <span className="text-gray-400 text-sm mb-1">/ 100点</span>
            </div>
            <div className="mt-2 bg-gray-700 rounded-full h-2">
              <div className={`${colorBg[company.color]} h-2 rounded-full`} style={{width:`${company.creditScore}%`}} />
            </div>
          </div>
        </div>
        <div className="lg:col-span-2">
          {submitted ? (
            <div className="bg-gray-800 rounded-xl p-8 text-center">
              <div className="text-5xl mb-4">✅</div>
              <h2 className="text-xl font-bold mb-2">意思決定を提出しました</h2>
              <p className="text-gray-400">ゲームマスターがターンを処理するまでお待ちください。</p>
            </div>
          ) : (
            <div className="bg-gray-800 rounded-xl p-5">
              <div className="flex flex-wrap gap-2 mb-5">
                {phases.map((p) => (
                  <button key={p.id} onClick={() => setCurrentPhase(p.id)} className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${currentPhase===p.id ? `${colorBg[company.color]} text-white` : "bg-gray-700 text-gray-400 hover:bg-gray-600"}`}>
                    F{p.id}: {p.title}
                  </button>
                ))}
              </div>
              <PhaseForm phase={phases[currentPhase]} company={company} decisions={decisions} setDecisions={setDecisions} />
              <div className="flex justify-between mt-5">
                <button onClick={() => setCurrentPhase((p) => Math.max(0,p-1))} disabled={currentPhase===0} className="px-4 py-2 bg-gray-700 rounded-lg text-sm disabled:opacity-30 hover:bg-gray-600">← 前のフェーズ</button>
                {currentPhase < phases.length-1 ? (
                  <button onClick={() => setCurrentPhase((p) => p+1)} className={`px-4 py-2 ${colorBg[company.color]} rounded-lg text-sm font-medium hover:opacity-90`}>次のフェーズ →</button>
                ) : (
                  <button onClick={handleSubmit} disabled={submitting} className="px-6 py-2 bg-yellow-500 hover:bg-yellow-400 text-black rounded-lg text-sm font-bold disabled:opacity-50">
                    {submitting ? "送信中..." : "🔒 意思決定を提出する"}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
function Row({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return <div className="flex justify-between"><span className="text-gray-400">{label}</span><span className={highlight ? "text-yellow-400 font-semibold" : "text-white"}>{value}</span></div>;
}
function PhaseForm({ phase, company, decisions, setDecisions }: { phase: Phase; company: CompanyProfile; decisions: Record<string,string>; setDecisions: (d: Record<string,string>) => void }) {
  const update = (key: string, val: string) => setDecisions({...decisions, [key]: val});
  return (
    <div>
      <div className="mb-4"><h3 className="text-lg font-bold">フェーズ{phase.id}: {phase.title}</h3><p className="text-gray-400 text-sm">{phase.description}</p></div>
      {phase.id===0 && <div className="bg-gray-700/50 rounded-lg p-4 space-y-2 text-sm"><p className="text-yellow-400 font-semibold mb-2">📋 確定受注残（Q2以降）</p><p className="text-gray-300">・EU向けバルク: 850t @ $3.8/kg（Q2納品）</p><p className="text-gray-300">・日本向けVAP: 320t @ $8.5/kg（Q2納品）</p><p className="text-gray-400 text-xs mt-3">※ これが生産計画の下限になります</p></div>}
      {phase.id===1 && <label className="block text-sm"><span className="text-gray-300 mb-1 block">工場新設・拡張の検討申請</span><select value={decisions["phase1_factory"]||""} onChange={(e)=>update("phase1_factory",e.target.value)} className="w-full bg-gray-700 rounded-lg px-3 py-2 text-sm"><option value="">選択してください</option><option value="none">申請なし</option><option value="expand">既存工場の拡張を申請</option><option value="new">新工場の建設を申請</option></select></label>}
      {phase.id===2 && <label className="block text-sm"><span className="text-gray-300 mb-1 block">今期の養殖投入量（トン、生体重）</span><input type="number" placeholder={`最大 ${Math.round(company.farmingArea*5)} t`} value={decisions["phase2_farming"]||""} onChange={(e)=>update("phase2_farming",e.target.value)} className="w-full bg-gray-700 rounded-lg px-3 py-2 text-sm" /></label>}
      {phase.id===3 && <div className="space-y-3"><label className="block text-sm"><span className="text-gray-300 mb-1 block">外部調達量（トン）</span><input type="number" placeholder="0〜3000 t" value={decisions["phase3_procurement"]||""} onChange={(e)=>update("phase3_procurement",e.target.value)} className="w-full bg-gray-700 rounded-lg px-3 py-2 text-sm" /></label><label className="block text-sm"><span className="text-gray-300 mb-1 block">調達先</span><select value={decisions["phase3_source"]||""} onChange={(e)=>update("phase3_source",e.target.value)} className="w-full bg-gray-700 rounded-lg px-3 py-2 text-sm"><option value="">選択してください</option><option value="spot">スポット市場（$2.1〜2.5/kg）</option><option value="contract">既存契約農家（$1.9/kg）</option></select></label></div>}
      {phase.id===4 && <div className="space-y-3"><label className="block text-sm"><span className="text-gray-300 mb-1 block">VAP比率（%）</span><input type="number" min="0" max="100" placeholder="例: 30" value={decisions["phase4_vap_ratio"]||""} onChange={(e)=>update("phase4_vap_ratio",e.target.value)} className="w-full bg-gray-700 rounded-lg px-3 py-2 text-sm" /></label><p className="text-gray-400 text-xs">バルク変換比率1.3 / VAP変換比率2.5</p></div>}
      {phase.id===5 && <div className="space-y-3">{["EU（バルク）","日本（VAP）","米国（バルク）","国内（スポット）"].map((market)=><label key={market} className="block text-sm"><span className="text-gray-300 mb-1 block">{market} — 数量（t）</span><input type="number" placeholder="0" value={decisions[`phase5_${market}`]||""} onChange={(e)=>update(`phase5_${market}`,e.target.value)} className="w-full bg-gray-700 rounded-lg px-3 py-2 text-sm" /></label>)}</div>}
      {phase.id===6 && <div className="space-y-3"><label className="block text-sm"><span className="text-gray-300 mb-1 block">短期借入（$M）</span><input type="number" placeholder="0" value={decisions["phase6_borrow"]||""} onChange={(e)=>update("phase6_borrow",e.target.value)} className="w-full bg-gray-700 rounded-lg px-3 py-2 text-sm" /></label><label className="block text-sm"><span className="text-gray-300 mb-1 block">長期借入返済（$M）</span><input type="number" placeholder="0" value={decisions["phase6_repay"]||""} onChange={(e)=>update("phase6_repay",e.target.value)} className="w-full bg-gray-700 rounded-lg px-3 py-2 text-sm" /></label><label className="block text-sm"><span className="text-gray-300 mb-1 block">増資の申請</span><select value={decisions["phase6_equity"]||""} onChange={(e)=>update("phase6_equity",e.target.value)} className="w-full bg-gray-700 rounded-lg px-3 py-2 text-sm"><option value="">申請なし</option><option value="swf">中東SWF</option><option value="sogo">日本商社</option><option value="asia">アジア戦略投資家</option></select></label></div>}
    </div>
  );
}
