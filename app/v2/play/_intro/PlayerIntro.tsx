"use client";

// ShrimpX V2 — PLAYER-INTRO-1 §4/§7/§12 + 追加仕様: 受講者向け導入
//
// 【段階的に開く】最初の画面には短い要点だけを置き、詳しい説明はすべて
// 折りたたみの中に入れる（§1「長文を最初の画面へ詰め込まない」）。
//
// 【開発内部の用語を出さない】Engine・Standard AI の内部モジュール名・Phase 番号・
// 指示番号は受講者向け本文へ一切出さない。
//
// 【入力を壊さない】このコンポーネントは draft にも提出状態にも触れない。
// 開閉は自身の state と localStorage だけで行い、勝手に保存・提出しない。

import { useCallback, useEffect, useId, useState } from "react";
import { ManagementBaselinesPanel } from "./ManagementBaselines";
import {
  buildQualityDiscardNote,
  YIELD_ASSUMPTION_BODY,
  YIELD_ASSUMPTION_EXAMPLE,
  YIELD_ASSUMPTION_HEADING,
} from "../../../lib/v2/player/intro/yieldAssumption";
import {
  hasAcknowledgedYieldAssumption,
  hasSeenIntro,
  markIntroSeen,
  markYieldAssumptionAcknowledged,
} from "./introStorage";
import type { PlayerDecisionContext } from "../../../lib/v2/player/decisionContext";

const DASH = "－";
const usd = (v: number | null | undefined) => (v === null || v === undefined ? DASH : `${Math.round(v).toLocaleString()} USD`);
const tons = (v: number | null | undefined) => (v === null || v === undefined ? DASH : `${Math.round(v).toLocaleString()} t`);

/** 【追加仕様】Standard AI の初期入力についての説明（指定された文案をそのまま使う）。 */
export const AI_DRAFT_EXPLANATION: readonly string[] = [
  "入力欄には、ゲームのルールと、その時点で利用できる情報をもとにStandard AIが考えた案が入っています。白紙から数字を作る必要はありません。",
  "この案は、標準的な経営判断のたたき台です。そのまま提出してゲームを進めることも、一部を変更することもできます。最適な判断や平均順位・利益を保証するものではありません。",
  "AI案が入力されているだけでは、まだ提出されていません。内容を確認し、提出してください。",
];

function Disclosure({
  title,
  children,
  defaultOpen,
  testId,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
  readonly defaultOpen?: boolean;
  readonly testId: string;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const panelId = useId();
  return (
    <section className="rounded-lg border border-slate-700 bg-slate-900/50">
      <h3>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={panelId}
          data-testid={`${testId}-toggle`}
          className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-sm font-semibold text-slate-100 hover:bg-slate-800/60"
        >
          <span>{title}</span>
          <span aria-hidden="true" className="text-xs text-slate-400">
            {open ? "閉じる ▲" : "ひらく ▼"}
          </span>
        </button>
      </h3>
      <div id={panelId} hidden={!open} className="border-t border-slate-800 px-3 py-3" data-testid={testId}>
        {children}
      </div>
    </section>
  );
}

/** §3 の必須カード。導入の冒頭に、折りたたまずに出す。 */
export function YieldAssumptionCard({ compact }: { readonly compact?: boolean }) {
  return (
    <div
      className="rounded-lg border-2 border-amber-500 bg-amber-950/30 p-3"
      role="note"
      aria-label={YIELD_ASSUMPTION_HEADING}
      data-testid={compact ? "play-yield-note-compact" : "play-intro-yield-card"}
    >
      <p className="text-sm font-bold text-amber-200">【{YIELD_ASSUMPTION_HEADING}】</p>
      {YIELD_ASSUMPTION_BODY.map((line) => (
        <p key={line} className="mt-1.5 text-xs leading-relaxed text-slate-100">
          {line}
        </p>
      ))}
      {compact ? null : (
        <>
          <p className="mt-2 rounded border border-amber-700/60 bg-amber-900/20 p-2 text-xs leading-relaxed text-amber-100">
            {YIELD_ASSUMPTION_EXAMPLE}
          </p>
          <p className="mt-2 text-[11px] leading-relaxed text-slate-300">{buildQualityDiscardNote()}</p>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// 導入本体
// ---------------------------------------------------------------------

export interface PlayerIntroProps {
  readonly context: PlayerDecisionContext;
  /** 初回（まだ読んでいない）なら全画面で出す。再訪なら「遊び方」から開く。 */
  readonly mode: "firstVisit" | "reopened";
  /** 「経営の基本目安」を開いた状態で立ち上げる（意思決定中のヒントから来た場合）。 */
  readonly initialSection?: "baselines";
  readonly onClose: () => void;
}

export function PlayerIntro({ context, mode, initialSection, onClose }: PlayerIntroProps) {
  const runId = context.simulationRunId;
  const [yieldAcknowledged, setYieldAcknowledged] = useState<boolean>(() => hasAcknowledgedYieldAssumption(runId));
  /** 確認を端末へ記録できなかった場合に、その事実だけを伝える（進行は止めない）。 */
  const [ackPersisted, setAckPersisted] = useState(true);

  const own = context.ownState;
  const isMidGameJoin = context.turn > 1;

  const acknowledgeYield = useCallback(() => {
    setYieldAcknowledged(true);
    setAckPersisted(markYieldAssumptionAcknowledged(runId));
  }, [runId]);

  const close = useCallback(() => {
    markIntroSeen(runId);
    onClose();
  }, [runId, onClose]);

  // Esc で閉じられるようにする（確認がまだなら閉じない）。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && (mode === "reopened" || yieldAcknowledged)) close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close, mode, yieldAcknowledged]);

  const canClose = mode === "reopened" || yieldAcknowledged;

  const cash = own.financeState.cash as unknown as number;
  // 【借入残高】新しい集計をここで作らず、直近に確定した四半期の貸借対照表を
  // そのまま読む（Turn 1 など確定四半期が無い場合は null のままにして、
  // 0 で埋めない）。
  const balanceSheet = context.lastQuarterFinancialResult?.balanceSheet ?? null;
  const shortTerm = balanceSheet === null ? null : (balanceSheet.shortTermLoans as unknown as number);
  const longTerm = balanceSheet === null ? null : (balanceSheet.longTermLoans as unknown as number);
  const regularWorkers = own.workforceState.factories.reduce((sum, f) => sum + f.regularHeadcount, 0);
  const salesHeadcount = own.salesForceHiringState.headcount;

  const backlogByProduct = (["hoso", "pd", "vap"] as const).map((product) => ({
    product,
    outstanding: own.contracts
      .filter((c) => c.product === product)
      .reduce((sum, c) => sum + (c.outstandingQuantity as unknown as number), 0),
    finishedGoods: own.finishedGoodsLots
      .filter((l) => l.product === product)
      .reduce((sum, l) => sum + (l.remainingQuantity as unknown as number), 0),
  }));

  return (
    <div
      /* 【環境バナーとの重なり】画面上部には sticky な環境バナー（z-[100]）が常駐する。
         上端に寄せると、このダイアログの見出しと「閉じる」がバナーの下へ潜って
         操作できなくなるため、バナーの高さぶんだけ余白を取る。 */
      className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/95 px-3 pb-4 pt-14 sm:px-6 sm:pt-16"
      role="dialog"
      aria-modal="true"
      aria-label="はじめにお読みください"
      data-testid="play-intro"
      data-mode={mode}
    >
      <div className="mx-auto max-w-3xl space-y-3 pb-24">
        <header className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-lg font-bold tracking-tight text-slate-100">
              {mode === "firstVisit" ? "はじめにお読みください" : "遊び方と基本の目安"}
            </h2>
            <p className="mt-0.5 text-[11px] text-slate-400">
              {context.companyDisplayName}（{context.companyId}） ／ Turn {context.turn}（{context.period}）
            </p>
          </div>
          {canClose ? (
            <button
              type="button"
              onClick={close}
              data-testid="play-intro-close"
              className="rounded bg-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-100 hover:bg-slate-600"
            >
              閉じて画面へ戻る
            </button>
          ) : null}
        </header>

        {/* --- §3 歩留まり前提：折りたたまず最初に出す --- */}
        <YieldAssumptionCard />

        {!yieldAcknowledged ? (
          <div className="rounded-lg border border-slate-600 bg-slate-900 p-3" data-testid="play-intro-yield-ack">
            <p className="text-xs leading-relaxed text-slate-200">
              先へ進む前に、上の前提を確認してください。詳しい説明はあとから読めますが、この確認だけは必要です。
            </p>
            <button
              type="button"
              onClick={acknowledgeYield}
              data-testid="play-intro-yield-ack-button"
              className="mt-2 rounded bg-amber-700 px-4 py-2 text-sm font-semibold text-amber-50 hover:bg-amber-600"
            >
              歩留まり100％の前提を確認しました
            </button>
          </div>
        ) : (
          <p className="text-[11px] text-emerald-300" data-testid="play-intro-yield-acknowledged">
            歩留まり100％の前提を確認済みです。
            {ackPersisted ? "" : "（この端末には記録できませんでした。次に開いたときにもう一度確認をお願いします。）"}
          </p>
        )}

        {/* --- §4A ゲームの全体像 --- */}
        <Disclosure title="1. このゲームは何をするのか" testId="play-intro-overview" defaultOpen={mode === "firstVisit"}>
          <ul className="space-y-1.5 text-xs leading-relaxed text-slate-200">
            <li>・あなたはベトナムのエビ加工・輸出会社の経営チームです。</li>
            <li>・原料を買う → 工場で加工する → 売って納品する → 代金を回収する、という流れを回します。</li>
            <li>・1Turn＝1四半期（3か月）です。いまは Turn {context.turn}（{context.period}）です。</li>
            {/* 【PLAYER-INTRO-1 §4A】終了Turnは、確定している場合だけ出す。
                進行中のRunでは受講者画面がこの値を受け取っていないため、
                推測した数字を出さずに「取得できていない」と書く。 */}
            {context.gameEndTurn !== null ? (
              <li>・このゲームは全 {context.gameEndTurn} Turn です。</li>
            ) : (
              <li>・何Turnで終わるかは、この画面では取得できていません。進行役（GM）にご確認ください。</li>
            )}
            <li>・各社が意思決定を提出し、進行役（GM）がそろったことを確認してTurnを進めます。</li>
            <li>・成長・利益・資金繰りの3つを結びつけて判断します。どれか1つだけを追うとうまくいきません。</li>
          </ul>
          <div className="mt-2 rounded border border-slate-700 bg-slate-950/40 p-2">
            <p className="text-[11px] font-semibold text-slate-200">扱う3つの商品</p>
            <ul className="mt-1 space-y-1 text-[11px] leading-relaxed text-slate-300">
              <li>
                ・<strong>HOSO</strong>（頭・殻付き）… 加工の手間がいちばん少なく、同じ人数でいちばん多く扱えます。
              </li>
              <li>
                ・<strong>PD</strong>（殻むき・背わた除去）… HOSOより生産も営業も手間がかかります。
              </li>
              <li>
                ・<strong>VAP</strong>（付加価値加工品）… 手間がもっとも大きく、同じ人数で扱える数量は少なくなります。
              </li>
            </ul>
            <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">
              具体的に何倍の手間になるかは「経営の基本目安」に数値で出しています。
            </p>
          </div>
        </Disclosure>

        {/* --- §4B あなたの会社 --- */}
        <Disclosure title="2. あなたの会社のいまの状態" testId="play-intro-company" defaultOpen={mode === "firstVisit"}>
          <p className="text-[11px] text-slate-400">
            Turn {context.turn}（{context.period}）の意思決定を始める時点の値です。金額はUSD、数量はHOSO換算トンです。
          </p>
          {isMidGameJoin ? (
            <p className="mt-1.5 rounded border border-sky-800 bg-sky-950/30 p-2 text-[11px] leading-relaxed text-sky-200">
              あなたはゲームの途中（Turn {context.turn}）から参加しています。ここに出ているのは
              <strong>いまの状態</strong>です。Turn 1 からやり直すわけではありません。
            </p>
          ) : null}
          <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
            <Fact label="会社名" value={`${context.companyDisplayName}（${context.companyId}）`} />
            <Fact label="現在Turn／四半期" value={`Turn ${context.turn} ／ ${context.period}`} />
            <Fact label="現金" value={usd(cash)} />
            <Fact label="短期借入残高" value={shortTerm === null ? "未取得（確定した四半期がまだありません）" : usd(shortTerm)} />
            <Fact label="長期借入残高" value={longTerm === null ? "未取得（確定した四半期がまだありません）" : usd(longTerm)} />
            <Fact label="常用Worker（工場の作業者）" value={`${regularWorkers.toLocaleString()} 人`} />
            <Fact label="営業人員（当期に配員できる人数）" value={`${salesHeadcount.toLocaleString()} 人`} />
            <Fact label="工場の数" value={`${own.workforceState.factories.length.toLocaleString()} 拠点`} />
          </dl>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[320px] text-left text-[11px]">
              <caption className="pb-1 text-left text-[11px] text-slate-400">
                商品別の受注残（まだ納めていない契約）と完成品在庫
              </caption>
              <thead>
                <tr className="border-b border-slate-700 text-slate-400">
                  <th scope="col" className="py-1 pr-2 font-medium">商品</th>
                  <th scope="col" className="py-1 pr-2 text-right font-medium">受注残</th>
                  <th scope="col" className="py-1 text-right font-medium">完成品在庫</th>
                </tr>
              </thead>
              <tbody>
                {backlogByProduct.map((row) => (
                  <tr key={row.product} className="border-b border-slate-800">
                    <th scope="row" className="py-1 pr-2 font-normal text-slate-200">
                      {row.product.toUpperCase()}
                    </th>
                    <td className="py-1 pr-2 text-right font-mono text-slate-100">{tons(row.outstanding)}</td>
                    <td className="py-1 text-right font-mono text-slate-100">{tons(row.finishedGoods)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">
            受注残は「納期までに納めると約束した、まだ納めていない量」です。遅れている量ではありません。
            工場や市場ごとの内訳は Inventory タブと Overview タブで確認できます。
          </p>
        </Disclosure>

        {/* --- §4C 利益と現金 --- */}
        <Disclosure title="3. 利益と現金は別のもの" testId="play-intro-finance">
          <ul className="space-y-1.5 text-xs leading-relaxed text-slate-200">
            <li>
              ・<strong>PL（損益計算書）</strong>…… その四半期の利益
            </li>
            <li>
              ・<strong>BS（貸借対照表）</strong>…… 現在持っている資産と負債
            </li>
            <li>
              ・<strong>CF（キャッシュフロー計算書）</strong>…… その四半期に現金が増減した理由
            </li>
          </ul>
          <ul className="mt-2 space-y-1.5 text-[11px] leading-relaxed text-slate-300">
            <li>・売上を計上した四半期に、代金がそのまま現金になるとはかぎりません。</li>
            <li>・原料や在庫への支出が先に出ると、利益が黒字でも現金が足りなくなることがあります。</li>
            <li>・借入は現金と負債を同時に増やします。売上ではありません。</li>
            <li>・返済の元本は負債が減るだけで費用になりません。利息は費用になります。この2つは扱いが違います。</li>
            <li>・設備投資は、お金を払う時期・工事が終わる時期・能力が実際に使えるようになる時期・減価償却が始まる時期がそれぞれずれます。</li>
          </ul>
          <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
            実際にどの四半期にいくら動いたかは、Overview タブの前Turnのふりかえりと、FINANCE の画面で確認してください。
          </p>
        </Disclosure>

        {/* --- 追加仕様: Standard AI の初期入力 --- */}
        <Disclosure title="4. 入力欄にはAIの案が入っています" testId="play-intro-ai-draft" defaultOpen={mode === "firstVisit"}>
          {AI_DRAFT_EXPLANATION.map((line) => (
            <p key={line} className="mt-1.5 text-xs leading-relaxed text-slate-200 first:mt-0">
              {line}
            </p>
          ))}
          <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
            なお、どの数字がAIの案のままで、どこをあなたが変えたかを画面が区別して表示することはできません。
            変更した内容は、提出前の最終確認画面でまとめて確認してください。
          </p>
        </Disclosure>

        {/* --- 追加仕様: 最初の2Turnの進め方 --- */}
        <Disclosure title="5. おすすめの進め方：まず2四半期、AI案で経営を体験する" testId="play-intro-practice" defaultOpen={mode === "firstVisit"}>
          <p className="text-[11px] leading-relaxed text-amber-200">
            これは<strong>おすすめの練習手順</strong>です。最初から自分で数字を変えてもかまいません。変更が禁止されているわけではありません。
          </p>
          <ol className="mt-2 space-y-2.5 text-[11px] leading-relaxed text-slate-200">
            <li>
              <strong>1回目の意思決定</strong>
              <br />
              ニュース、自社の状態、歩留まり100％の前提、人数・能力・費用の目安をひととおり確認します。
              入力欄に入っているAIの案を最終確認画面で読み、原則そのまま提出します。あとは進行役がTurnを進めます。
            </li>
            <li>
              <strong>1回目の結果を読む</strong>
              <br />
              AIが何を決め、実際に何が起きたかを確かめます。
              <ul className="mt-1 space-y-0.5 pl-3 text-slate-300">
                <li>・売りたかった量、成約した量、実際に納めた量の違い（Overview タブ）</li>
                <li>・商品別の生産量、受注残、完成品在庫（Overview・Inventory タブ）</li>
                <li>・設備・原料・人員のどこが足りなくて生産が止まったか（Overview タブの生産のふりかえり）</li>
                <li>・利益と現金がどう動いたか、なぜ違う動きになったか（Overview タブ、FINANCE の画面）</li>
                <li>・借入や投資が希望どおり実行されたか（FINANCE・INVESTMENT の画面）</li>
              </ul>
            </li>
            <li>
              <strong>2回目の意思決定とふりかえり</strong>
              <br />
              次のAI案も確認して、原則そのまま提出します。2四半期分の結果を並べて、AI案が何を狙っていたのか、
              うまくいった点と直したい点を考えます。
            </li>
            <li>
              <strong>3回目から自分の判断を加える</strong>
              <br />
              価格、販売量、商品の組み合わせ、原料の買い方、人員などについて、
              「何を変え、その結果どうなると予想したか」を決めてから変更します。
              はじめは変える箇所を1〜2か所に絞ると、結果との関係がはっきり分かります。
            </li>
          </ol>
          <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
            「2四半期ぶんの結果を見る」という意味です。画面に出ているTurn番号が1・2になるということではありません
            {isMidGameJoin ? `（あなたは Turn ${context.turn} から参加しているため、Turn ${context.turn} と Turn ${context.turn + 1} が最初の2回になります）` : ""}。
          </p>
        </Disclosure>

        {/* --- §7 意思決定の進め方 --- */}
        <Disclosure title="6. 意思決定の進め方" testId="play-intro-steps">
          <ol className="space-y-1.5 text-xs leading-relaxed text-slate-200">
            <li>1. ニュースと自社の状況を確認する（Overview・Market タブ）</li>
            <li>2. 商品別の受注残と完成品在庫を確認する（Inventory タブ）</li>
            <li>3. 販売・生産・原料・人員のつじつまが合っているか確かめる（Decision タブ）</li>
            <li>4. 投資と資金調達を、資金の見通しに照らして検討する</li>
            <li>5. 「意思決定を確認」から最終確認画面で見直す</li>
            <li>6. 提出して、進行役がTurnを進めるのを待つ</li>
          </ol>
          <p className="mt-2 text-[11px] leading-relaxed text-amber-200">
            受注残を放っておいて利益率の高い商品だけを作る、能力の目安だけを見て販売量や生産量を決める、
            といった進め方はおすすめしません。約束した納期と、実際に使える設備・原料・人員から考えてください。
          </p>
        </Disclosure>

        {/* --- §5 経営の基本目安 --- */}
        <Disclosure title="7. 経営の基本目安（人数・能力・費用）" testId="play-intro-baselines" defaultOpen={initialSection === "baselines"}>
          <ManagementBaselinesPanel context={context} />
        </Disclosure>

        <div className="sticky bottom-0 -mx-3 border-t border-slate-700 bg-slate-950/95 px-3 py-2.5 sm:-mx-6 sm:px-6">
          {canClose ? (
            <button
              type="button"
              onClick={close}
              data-testid="play-intro-close-bottom"
              className="w-full rounded bg-sky-700 px-4 py-2.5 text-sm font-semibold text-slate-50 hover:bg-sky-600"
            >
              画面へ戻る（この説明はあとから「遊び方」で開けます）
            </button>
          ) : (
            <p className="text-center text-[11px] text-slate-400">
              上の「歩留まり100％の前提を確認しました」を押すと先へ進めます。
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function Fact({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-slate-800 py-1">
      <dt className="text-[11px] text-slate-400">{label}</dt>
      <dd className="font-mono text-xs text-slate-100">{value}</dd>
    </div>
  );
}

/** 再訪時に導入を出さないための判定（画面側が初回だけ自動表示するために使う）。 */
export function shouldAutoOpenIntro(context: PlayerDecisionContext): boolean {
  return !hasSeenIntro(context.simulationRunId) || !hasAcknowledgedYieldAssumption(context.simulationRunId);
}
