"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { CompanyProfile } from "../lib/gameData";
import { CompanyDecision, CompanyState, CompanyTurnResult, ConfirmedOrder, GameSession } from "../lib/gameTypes";
interface Phase { id: number; title: string; description: string; }
interface Props { profile: CompanyProfile; phases: Phase[]; gameCode?: string; isGmTestMode?: boolean; }
const colorBg: Record<string,string> = { blue:"bg-blue-600", green:"bg-green-600", purple:"bg-purple-600", orange:"bg-orange-500", red:"bg-red-600" };
const colorBorder: Record<string,string> = { blue:"border-blue-500", green:"border-green-500", purple:"border-purple-500", orange:"border-orange-400", red:"border-red-500" };
const colorText: Record<string,string> = { blue:"text-blue-400", green:"text-green-400", purple:"text-purple-400", orange:"text-orange-400", red:"text-red-400" };

export default function CompanyDashboard({ profile, phases, gameCode, isGmTestMode }: Props) {
  const [currentPhase, setCurrentPhase] = useState(0);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [decisions, setDecisions] = useState<Record<string,string>>({});
  const [session, setSession] = useState<GameSession | null>(null);
  const [liveState, setLiveState] = useState<CompanyState | null>(null);
  const [lastResult, setLastResult] = useState<CompanyTurnResult | null>(null);
  const [prevDecisions, setPrevDecisions] = useState<CompanyDecision | null>(null);
  const [loadedQuarterKey, setLoadedQuarterKey] = useState("");

  // 前四半期のキーを返す（2015Q1の前は存在しないのでnull）
  function calcPrevPeriod(year: number, quarter: number): string | null {
    if (year === 2015 && quarter === 1) return null;
    return quarter <= 1 ? `${year - 1}Q4` : `${year}Q${quarter - 1}`;
  }

  async function fetchPrevDecisions(gameSession: GameSession) {
    if (!gameCode) return;
    const prevPeriod = calcPrevPeriod(gameSession.currentYear, gameSession.currentQuarter);
    if (!prevPeriod) { setPrevDecisions(null); return; }
    const r = await fetch(`/api/game/${gameCode}/decisions?quarter=${prevPeriod}`);
    if (r.ok) {
      const data = await r.json();
      setPrevDecisions(data[profile.id] ?? null);
    }
  }

  async function load() {
    if (!gameCode) return;
    const res = await fetch(`/api/game/${gameCode}`);
    if (!res.ok) return;
    const data = await res.json();
    const gameSession: GameSession = data.session;
    setSession(gameSession);
    setLiveState(data.companyStates?.[profile.id] ?? null);

    const quarterKey = `${gameSession.currentYear}Q${gameSession.currentQuarter}`;
    if (quarterKey !== loadedQuarterKey) {
      setLoadedQuarterKey(quarterKey);
      setSubmitted(false);
      setDecisions({});
    }

    const history = gameSession.history ?? [];
    if (history.length > 0) {
      const lastKey = history[history.length - 1];
      const resultsRes = await fetch(`/api/game/${gameCode}/results?quarter=${lastKey}`);
      if (resultsRes.ok) {
        const resultsData = await resultsRes.json();
        setLastResult(resultsData.result?.companies?.[profile.id] ?? null);
      }
    }
    await fetchPrevDecisions(gameSession);
  }

  useEffect(() => {
    if (gameCode) fetch(`/api/game/${gameCode}`).then((r) => (r.ok ? r.json() : null)).then((data) => {
      if (!data) return;
      const gameSession: GameSession = data.session;
      setSession(gameSession);
      setLiveState(data.companyStates?.[profile.id] ?? null);
      setLoadedQuarterKey(`${gameSession.currentYear}Q${gameSession.currentQuarter}`);
      const history: string[] = gameSession.history ?? [];
      if (history.length > 0) {
        const lastKey = history[history.length - 1];
        fetch(`/api/game/${gameCode}/results?quarter=${lastKey}`).then((r) => (r.ok ? r.json() : null)).then((resultsData) => {
          if (resultsData) setLastResult(resultsData.result?.companies?.[profile.id] ?? null);
        });
      }
      fetchPrevDecisions(gameSession);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameCode]);

  const company = liveState ? { ...profile, ...liveState } : profile;

  const handleSubmit = async () => {
    setSubmitting(true);
    if (gameCode) {
      await fetch(`/api/game/${gameCode}/decisions`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ companyId: profile.id, phases: decisions, isGmTestSubmission: Boolean(isGmTestMode) }) });
    }
    setSubmitted(true); setSubmitting(false);
  };
  const debt = company.totalAssets - company.equity;
  const backUrl = gameCode
    ? isGmTestMode ? `/gm/${gameCode}` : `/lobby/${gameCode}`
    : "/";
  const periodLabel = session ? `${session.currentYear}年 第${session.currentQuarter}四半期` : "2015年 第1四半期";
  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <div className={`${colorBg[profile.color]} px-6 py-4`}>
        <div className="max-w-5xl mx-auto flex justify-between items-center">
          <div>
            <p className="text-white/55 text-xs font-semibold uppercase tracking-widest mb-0.5">企業経営画面</p>
            <h1 className="text-2xl font-bold">{profile.name} — {profile.fullName}</h1>
            <p className="text-white/80 text-sm">{periodLabel}{gameCode && ` | ゲーム: ${gameCode}`}</p>
          </div>
          <div className="flex items-center gap-4">
            {gameCode && <button onClick={load} className="text-white/70 hover:text-white text-sm">🔄 更新</button>}
            <Link href={backUrl} className="text-white/70 hover:text-white text-sm">← 戻る</Link>
          </div>
        </div>
      </div>
      {isGmTestMode && (
        <div className="bg-purple-700/90 text-white text-center text-xs sm:text-sm font-semibold px-3 py-1.5">
          🎮 GMテスト操作中 — {profile.name}（{profile.fullName}）を代理操作しています
        </div>
      )}
      <div className="max-w-5xl mx-auto px-6 py-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="space-y-4">
          <div className={`bg-gray-800 rounded-xl p-4 border-l-4 ${colorBorder[profile.color]}`}>
            <h2 className="text-sm text-gray-400 mb-3 font-semibold uppercase tracking-wide">貸借対照表</h2>
            {company.equipmentGross !== undefined ? (
              <div className="text-xs space-y-0.5">
                {/* 資産の部 */}
                <p className="text-gray-500 font-semibold pt-0.5">【資産の部】</p>
                <BSRow label="現金・預金" value={company.cash} highlight={company.cash < 8} />
                <BSRow label="売掛金" value={company.accountsReceivable ?? 0} />
                <BSRow label="原料在庫" value={company.rawInventory ?? 0} />
                <BSRow label="製品在庫" value={company.finishedInventory ?? 0} />
                <BSRow label="建物" value={company.buildingsNet ?? 0} sub />
                <BSRow label="設備（総額）" value={company.equipmentGross} sub />
                <BSRow label="　減価償却累計額" value={-(company.accumulatedDepreciation ?? 0)} sub />
                <div className="border-t border-gray-600 my-1" />
                <BSRow label="資産合計" value={company.totalAssets} bold />
                {/* 負債の部 */}
                <p className="text-gray-500 font-semibold pt-1.5">【負債の部】</p>
                <BSRow label="買掛金" value={company.accountsPayable ?? 0} />
                <BSRow label="短期借入金" value={company.shortTermLoans ?? 0} highlight={(company.shortTermLoans ?? 0) > 60} />
                <BSRow label="長期借入金" value={company.longTermLoans ?? 0} />
                <div className="border-t border-gray-600 my-1" />
                <BSRow label="負債合計" value={debt} bold />
                {/* 純資産の部 */}
                <p className="text-gray-500 font-semibold pt-1.5">【純資産の部】</p>
                <BSRow label="資本金" value={company.paidInCapital ?? 0} />
                <BSRow label="利益剰余金" value={company.equity - (company.paidInCapital ?? 0)} highlight={company.equity - (company.paidInCapital ?? 0) < 0} />
                <div className="border-t border-gray-600 my-1" />
                <BSRow label="純資産合計" value={company.equity} bold />
                <div className="border-t-2 border-gray-500 my-1" />
                <BSRow label="負債純資産合計" value={company.totalAssets} bold />
                <p className="text-gray-600 text-right pt-1">D/E {company.debtEquityRatio}x</p>
              </div>
            ) : (
              <div className="space-y-2 text-sm">
                <Row label="現金" value={`$${company.cash}M`} highlight={company.cash < 8} />
                <Row label="総資産" value={`$${company.totalAssets}M`} />
                <Row label="負債" value={`$${debt}M`} />
                <Row label="純資産" value={`$${company.equity}M`} />
                <Row label="D/E比率" value={`${company.debtEquityRatio}x`} highlight={company.debtEquityRatio > 2.5} />
              </div>
            )}
          </div>
          <div className={`bg-gray-800 rounded-xl p-4 border-l-4 ${colorBorder[profile.color]}`}>
            <h2 className="text-sm text-gray-400 mb-3 font-semibold uppercase tracking-wide">オペレーション</h2>
            <div className="space-y-2 text-sm">
              <Row label="養殖面積" value={`${profile.farmingArea.toLocaleString()} ha`} />
              <Row label="加工能力" value={`${profile.processingCapacity.toLocaleString()} t/Q`} />
            </div>
          </div>
          <div className={`bg-gray-800 rounded-xl p-4 border-l-4 ${colorBorder[profile.color]}`}>
            <h2 className="text-sm text-gray-400 mb-3 font-semibold uppercase tracking-wide">信用スコア</h2>
            <div className="flex items-end gap-2">
              <span className={`text-4xl font-bold ${colorText[profile.color]}`}>{company.creditScore}</span>
              <span className="text-gray-400 text-sm mb-1">/ 100点</span>
            </div>
            <div className="mt-2 bg-gray-700 rounded-full h-2">
              <div className={`${colorBg[profile.color]} h-2 rounded-full`} style={{width:`${company.creditScore}%`}} />
            </div>
          </div>
          {lastResult && (() => {
            const totalCogs = Math.round((lastResult.cogs + lastResult.processingCost) * 100) / 100;
            const grossProfit = Math.round((lastResult.revenue - totalCogs) * 100) / 100;
            const operatingIncome = Math.round((grossProfit - lastResult.overhead) * 100) / 100;
            const fmt = (v: number) => `$${v}M`;
            const signFmt = (v: number) => `${v >= 0 ? "+" : ""}$${v}M`;
            return (
              <div className={`bg-gray-800 rounded-xl p-4 border-l-4 ${colorBorder[profile.color]}`}>
                <h2 className="text-sm text-gray-400 mb-3 font-semibold uppercase tracking-wide">前期損益計算書（{lastResult.year}年Q{lastResult.quarter}）</h2>
                <div className="space-y-1 text-sm">
                  <PLRow label="売上高" value={fmt(lastResult.revenue)} bold />
                  <PLRow label="売上原価" value={`−${fmt(totalCogs)}`} indent />
                  <PLRow label="　原料費" value={`−${fmt(lastResult.cogs)}`} indent />
                  <PLRow label="　加工費" value={`−${fmt(lastResult.processingCost)}`} indent />
                  <div className="border-t border-gray-600 my-1" />
                  <PLRow label="売上総利益" value={fmt(grossProfit)} bold highlight={grossProfit < 0} />
                  <PLRow label="販売費及び一般管理費" value={`−${fmt(lastResult.overhead)}`} indent />
                  <div className="border-t border-gray-600 my-1" />
                  <PLRow label="営業利益" value={signFmt(operatingIncome)} bold highlight={operatingIncome < 0} />
                  <PLRow label="支払利息（営業外費用）" value={`−${fmt(lastResult.interestExpense)}`} indent />
                  <div className="border-t border-gray-600 my-1" />
                  <PLRow label="経常利益" value={signFmt(lastResult.netIncome)} bold highlight={lastResult.netIncome < 0} />
                </div>
                {!lastResult.submitted && <p className="text-yellow-400 text-xs mt-2">⚠️ 前回は意思決定が未提出のため既定値で処理されました</p>}
                {lastResult.notes?.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-gray-700 space-y-1">
                    {lastResult.notes.map((note, i) => <p key={i} className="text-gray-400 text-xs">📝 {note}</p>)}
                  </div>
                )}
              </div>
            );
          })()}
        </div>
        <div className="lg:col-span-2">
          {submitted ? (
            <div className="bg-gray-800 rounded-xl p-8 text-center">
              <div className="text-5xl mb-4">✅</div>
              <h2 className="text-xl font-bold mb-2">意思決定を提出しました</h2>
              <p className="text-gray-400 mb-6">ゲームマスターがターンを処理するまでお待ちください。</p>
              {isGmTestMode && gameCode && (
                <Link href={`/gm/${gameCode}`} className="inline-block px-6 py-2 bg-purple-700 hover:bg-purple-600 rounded-lg text-sm font-semibold">
                  ← GMコンソールに戻る
                </Link>
              )}
            </div>
          ) : (
            <div className="bg-gray-800 rounded-xl p-5">
              <div className="flex flex-wrap gap-2 mb-5">
                {phases.map((p) => (
                  <button key={p.id} onClick={() => setCurrentPhase(p.id)} className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${currentPhase===p.id ? `${colorBg[profile.color]} text-white` : "bg-gray-700 text-gray-400 hover:bg-gray-600"}`}>
                    F{p.id}: {p.title}
                  </button>
                ))}
              </div>
              <PhaseForm phase={phases[currentPhase]} company={profile} decisions={decisions} setDecisions={setDecisions} liveState={liveState} lastResult={lastResult} prevDecisions={prevDecisions} confirmedOrders={session?.confirmedOrders?.[profile.id] ?? []} />
              <div className="flex justify-between mt-5">
                <button onClick={() => setCurrentPhase((p) => Math.max(0,p-1))} disabled={currentPhase===0} className="px-4 py-2 bg-gray-700 rounded-lg text-sm disabled:opacity-30 hover:bg-gray-600">← 前のフェーズ</button>
                {currentPhase < phases.length-1 ? (
                  <button onClick={() => setCurrentPhase((p) => p+1)} className={`px-4 py-2 ${colorBg[profile.color]} rounded-lg text-sm font-medium hover:opacity-90`}>次のフェーズ →</button>
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
function BSRow({ label, value, highlight, bold, sub }: { label: string; value: number; highlight?: boolean; bold?: boolean; sub?: boolean }) {
  const fmt = (v: number) => `$${(Math.round(Math.abs(v) * 100) / 100).toFixed(2)}M`;
  const isNeg = value < 0;
  return (
    <div className="flex justify-between">
      <span className={sub ? "text-gray-500 pl-2" : "text-gray-400"}>{label}</span>
      <span className={`${highlight ? "text-yellow-400 font-semibold" : bold ? "text-white font-semibold" : "text-gray-300"} ${isNeg ? "text-orange-400" : ""}`}>
        {isNeg ? `△${fmt(value)}` : fmt(value)}
      </span>
    </div>
  );
}
function Row({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return <div className="flex justify-between"><span className="text-gray-400">{label}</span><span className={highlight ? "text-yellow-400 font-semibold" : "text-white"}>{value}</span></div>;
}
function PLRow({ label, value, highlight, bold, indent }: { label: string; value: string; highlight?: boolean; bold?: boolean; indent?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className={`${indent ? "pl-3 text-gray-500" : "text-gray-300"}`}>{label}</span>
      <span className={`${highlight ? "text-red-400 font-semibold" : bold ? "text-white font-semibold" : "text-gray-300"}`}>{value}</span>
    </div>
  );
}
const MARKET_PRICES: Record<string, number> = { "EU（バルク）": 3.8, "日本（VAP）": 8.5, "米国（バルク）": 3.6, "国内（スポット）": 3.2 };
const SOURCE_LABEL: Record<string, string> = { spot: "スポット市場", contract: "既存契約農家" };
const MARKET_ORDER = ["EU（バルク）", "日本（VAP）", "米国（バルク）", "国内（スポット）"];

function Phase0Panel({ liveState, lastResult, prevDecisions, confirmedOrders }: {
  liveState: CompanyState | null;
  lastResult: CompanyTurnResult | null;
  prevDecisions: CompanyDecision | null;
  confirmedOrders: ConfirmedOrder[];
}) {
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return (
    <div className="space-y-4 text-sm">
      {/* 在庫状況 */}
      <div className="bg-gray-700/50 rounded-lg p-4">
        <p className="text-yellow-400 font-semibold mb-3">📦 現在の在庫（期初）</p>
        <div className="grid grid-cols-3 gap-2">
          <div className="bg-gray-800/60 rounded-lg p-2 text-center">
            <p className="text-gray-400 text-xs mb-1">原料在庫<br/><span className="text-gray-500">（冷凍生エビ）</span></p>
            <p className="text-white font-bold text-base">{((liveState?.rawInventoryQty ?? 0)).toLocaleString()} t</p>
          </div>
          <div className="bg-gray-800/60 rounded-lg p-2 text-center">
            <p className="text-gray-400 text-xs mb-1">バルク製品<br/>在庫</p>
            <p className="text-white font-bold text-base">{((liveState?.bulkInventoryQty ?? 0)).toLocaleString()} t</p>
          </div>
          <div className="bg-gray-800/60 rounded-lg p-2 text-center">
            <p className="text-gray-400 text-xs mb-1">VAP製品<br/>在庫</p>
            <p className="text-white font-bold text-base">{((liveState?.vapInventoryQty ?? 0)).toLocaleString()} t</p>
          </div>
        </div>
      </div>

      {/* 確定受注残 */}
      <div className="bg-gray-700/50 rounded-lg p-4">
        <p className="text-yellow-400 font-semibold mb-2">📋 確定受注残（市場別）</p>
        {confirmedOrders.length === 0 ? (
          <p className="text-gray-400">現時点での確定受注なし</p>
        ) : (
          MARKET_ORDER.map((market) => {
            const orders = confirmedOrders.filter((o) => o.destination === market);
            if (orders.length === 0) return <p key={market} className="text-gray-500">・{market}: なし</p>;
            return orders.map((o, i) => (
              <p key={`${market}-${i}`} className="text-gray-300">・{market}: {o.quantity.toLocaleString()}t @ ${o.price}/kg（Q{o.deliveryQuarter}納品）</p>
            ));
          })
        )}
      </div>

      {/* 前期実績 */}
      {lastResult ? (
        <div className="bg-gray-700/50 rounded-lg p-4 space-y-3">
          <p className="text-yellow-400 font-semibold">📊 前期実績（{lastResult.year}年Q{lastResult.quarter}）</p>

          <div>
            <p className="text-gray-400 font-semibold text-xs mb-1">▍生産数量</p>
            <p className="text-gray-300">バルク: {lastResult.productOutput.bulk.toFixed(0)} t　／　VAP: {lastResult.productOutput.vap.toFixed(0)} t</p>
          </div>

          <div>
            <p className="text-gray-400 font-semibold text-xs mb-1">▍市場別 販売成約数量・デリバリー・売上高</p>
            <div className="space-y-0.5">
              {MARKET_ORDER.map((market) => {
                const qty = lastResult.salesByMarket[market] ?? 0;
                const rev = r2(qty * MARKET_PRICES[market] / 1000);
                return (
                  <div key={market} className="flex justify-between">
                    <span className="text-gray-400">{market}</span>
                    <span className={qty > 0 ? "text-gray-200" : "text-gray-600"}>
                      {qty > 0 ? `${qty.toLocaleString()} t → $${rev}M` : "—"}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        <div className="bg-gray-700/50 rounded-lg p-4">
          <p className="text-gray-400">前期実績なし（ゲーム開始初期）</p>
        </div>
      )}

      {/* 前四半期の意思決定 */}
      {prevDecisions ? (
        <div className="bg-gray-700/50 rounded-lg p-4 space-y-2">
          <p className="text-yellow-400 font-semibold mb-1">🗂 前四半期の意思決定（{prevDecisions.year}年Q{prevDecisions.quarter}）</p>
          <div className="space-y-1 text-xs text-gray-300">
            {prevDecisions.phases["phase2_farming"] && (
              <p>・養殖投入量: {Number(prevDecisions.phases["phase2_farming"]).toLocaleString()} t</p>
            )}
            {prevDecisions.phases["phase3_procurement"] && (
              <p>・外部調達: {Number(prevDecisions.phases["phase3_procurement"]).toLocaleString()} t（{SOURCE_LABEL[prevDecisions.phases["phase3_source"] ?? "spot"] ?? prevDecisions.phases["phase3_source"]}）</p>
            )}
            {prevDecisions.phases["phase4_vap_ratio"] && (
              <p>・VAP比率: {prevDecisions.phases["phase4_vap_ratio"]} %</p>
            )}
            {MARKET_ORDER.map((market) => {
              const qty = prevDecisions.phases[`phase5_${market}`];
              return qty && Number(qty) > 0 ? (
                <p key={market}>・販売 {market}: {Number(qty).toLocaleString()} t</p>
              ) : null;
            })}
            {prevDecisions.phases["phase6_borrow"] && Number(prevDecisions.phases["phase6_borrow"]) > 0 && (
              <p>・借入: ${prevDecisions.phases["phase6_borrow"]}M</p>
            )}
            {prevDecisions.phases["phase6_repay"] && Number(prevDecisions.phases["phase6_repay"]) > 0 && (
              <p>・返済: ${prevDecisions.phases["phase6_repay"]}M</p>
            )}
            {prevDecisions.phases["phase6_equity"] && (
              <p>・増資申請: {prevDecisions.phases["phase6_equity"]}</p>
            )}
          </div>
        </div>
      ) : (
        <div className="bg-gray-700/50 rounded-lg p-4">
          <p className="text-gray-400 text-xs">前四半期の意思決定なし（ゲーム開始初期）</p>
        </div>
      )}
    </div>
  );
}

function PhaseForm({ phase, company, decisions, setDecisions, liveState, lastResult, prevDecisions, confirmedOrders }: { phase: Phase; company: CompanyProfile; decisions: Record<string,string>; setDecisions: (d: Record<string,string>) => void; liveState: CompanyState | null; lastResult: CompanyTurnResult | null; prevDecisions: CompanyDecision | null; confirmedOrders: ConfirmedOrder[] }) {
  const update = (key: string, val: string) => setDecisions({...decisions, [key]: val});
  return (
    <div>
      <div className="mb-4"><h3 className="text-lg font-bold">フェーズ{phase.id}: {phase.title}</h3><p className="text-gray-400 text-sm">{phase.description}</p></div>
      {phase.id===0 && <Phase0Panel liveState={liveState} lastResult={lastResult} prevDecisions={prevDecisions} confirmedOrders={confirmedOrders} />}
      {phase.id===1 && <label className="block text-sm"><span className="text-gray-300 mb-1 block">工場新設・拡張の検討申請</span><select value={decisions["phase1_factory"]||""} onChange={(e)=>update("phase1_factory",e.target.value)} className="w-full bg-gray-700 rounded-lg px-3 py-2 text-sm"><option value="">選択してください</option><option value="none">申請なし</option><option value="expand">既存工場の拡張を申請</option><option value="new">新工場の建設を申請</option></select></label>}
      {phase.id===2 && <label className="block text-sm"><span className="text-gray-300 mb-1 block">今期の養殖投入量（トン、生体重）</span><input type="number" placeholder={`最大 ${Math.round(company.farmingArea*5)} t`} value={decisions["phase2_farming"]||""} onChange={(e)=>update("phase2_farming",e.target.value)} className="w-full bg-gray-700 rounded-lg px-3 py-2 text-sm" /></label>}
      {phase.id===3 && <div className="space-y-3"><label className="block text-sm"><span className="text-gray-300 mb-1 block">外部調達量（トン）</span><input type="number" placeholder={`0〜${Math.max(0, company.processingCapacity - Math.min(Number(decisions["phase2_farming"]||0), company.farmingArea*5)).toLocaleString()} t`} value={decisions["phase3_procurement"]||""} onChange={(e)=>update("phase3_procurement",e.target.value)} className="w-full bg-gray-700 rounded-lg px-3 py-2 text-sm" /></label><label className="block text-sm"><span className="text-gray-300 mb-1 block">調達先</span><select value={decisions["phase3_source"]||""} onChange={(e)=>update("phase3_source",e.target.value)} className="w-full bg-gray-700 rounded-lg px-3 py-2 text-sm"><option value="">選択してください</option><option value="spot">スポット市場（$2.1〜2.5/kg）</option><option value="contract">既存契約農家（$1.9/kg）</option></select></label></div>}
      {phase.id===4 && <div className="space-y-3"><label className="block text-sm"><span className="text-gray-300 mb-1 block">VAP比率（%）</span><input type="number" min="0" max="100" placeholder="例: 30" value={decisions["phase4_vap_ratio"]||""} onChange={(e)=>update("phase4_vap_ratio",e.target.value)} className="w-full bg-gray-700 rounded-lg px-3 py-2 text-sm" /></label><p className="text-gray-400 text-xs">バルク変換比率1.3 / VAP変換比率2.5</p></div>}
      {phase.id===5 && <div className="space-y-3">{["EU（バルク）","日本（VAP）","米国（バルク）","国内（スポット）"].map((market)=><label key={market} className="block text-sm"><span className="text-gray-300 mb-1 block">{market} — 数量（t）</span><input type="number" placeholder="0" value={decisions[`phase5_${market}`]||""} onChange={(e)=>update(`phase5_${market}`,e.target.value)} className="w-full bg-gray-700 rounded-lg px-3 py-2 text-sm" /></label>)}</div>}
      {phase.id===6 && <div className="space-y-3"><label className="block text-sm"><span className="text-gray-300 mb-1 block">短期借入（$M）</span><input type="number" placeholder="0" value={decisions["phase6_borrow"]||""} onChange={(e)=>update("phase6_borrow",e.target.value)} className="w-full bg-gray-700 rounded-lg px-3 py-2 text-sm" /></label><label className="block text-sm"><span className="text-gray-300 mb-1 block">長期借入返済（$M）</span><input type="number" placeholder="0" value={decisions["phase6_repay"]||""} onChange={(e)=>update("phase6_repay",e.target.value)} className="w-full bg-gray-700 rounded-lg px-3 py-2 text-sm" /></label><label className="block text-sm"><span className="text-gray-300 mb-1 block">増資の申請</span><select value={decisions["phase6_equity"]||""} onChange={(e)=>update("phase6_equity",e.target.value)} className="w-full bg-gray-700 rounded-lg px-3 py-2 text-sm"><option value="">申請なし</option><option value="swf">中東SWF</option><option value="sogo">日本商社</option><option value="asia">アジア戦略投資家</option></select></label></div>}
    </div>
  );
}
