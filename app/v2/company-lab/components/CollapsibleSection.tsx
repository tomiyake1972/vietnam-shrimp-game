// ShrimpX V2 — 会社経営統合テスト環境 折りたたみ可能なセクション（共通コンポーネント）
//
// プレイヤーからの要望「画面が縦長になっていくので、各情報は折りたためるように
// 設定してください」に対する、画面全体で唯一の折りたたみ実装である。
//
// 【既定は「閉じている」】2026-08-08、プレイヤーの要望により defaultOpen の既定を
// true→false へ変更した。画面を開いた直後は全セクションがたたまれた状態になる。
// 意思決定編集以外のセクションは元から defaultOpen={false} を明示していたため、
// この変更で挙動が変わるのは DecisionEditor の13セクションだけである。
//
// 【なぜ native <details> なのか】
//   useStateで開閉を持つと、PlayerScreenClientが
//     key={`${labId}:${currentTurn}:${revision}:${phase}:${draftUpdatedAt}`}
//   でコンポーネントツリーを作り直す設計（下書き保存・提出・四半期処理のたびに
//   remountされる）のため、保存ボタンを押すだけで全セクションの開閉状態が
//   初期値へ戻ってしまう。<details>のopenはDOM側の状態であり、Reactは
//   openプロップの値が前回レンダーと変わらないかぎり再設定しないため、
//   同一マウント中の再レンダーでプレイヤーの開閉操作が巻き戻されない。
//   加えてJSを必要とせず、キーボード操作・スクリーンリーダー対応も標準で得られる。
//   （DecisionEditorの償却説明部分で既に<details>を使っている前例に揃える。）
//
// 【禁止事項】
//   - このコンポーネントを経由せずに、セクションごとの独自の折りたたみ実装を書かない。
//   - 色クラスを直接書かない（エリア種別の色はpanelStyles.tsのAREA_TONESのみ）。

import { ReactNode } from "react";
import { AREA_TONES, AreaTone } from "./panelStyles";

export interface CollapsibleSectionProps {
  readonly title: string;
  /** 見出し下の補足説明（任意）。折りたたみを開いたときだけ見える位置に置く。 */
  readonly description?: string;
  /** 入力エリアか情報エリアか（色分けの根拠）。 */
  readonly tone: AreaTone;
  /**
   * 初期状態で開いているか（既定: **閉じている**）。
   *
   * 【2026-08-08 既定をtrue→falseへ変更】turn5時点で意思決定編集のセクションが13個あり、
   * 全部開いた状態で画面を開くと、どこに何があるか一覧できないほど縦に長くなっていた。
   * プレイヤーの要望により「開いたときは全部たたまれている」を既定にする。
   *
   * 見出し行には summaryRight（営業人員 配分済み◯人／保管使用率◯% 等）が出るため、
   * たたんだままでも各セクションの状態は読める。
   */
  readonly defaultOpen?: boolean;
  /** 見出し行の右端に出す要約情報（折りたたんだままでも読めるようにするための一行）。 */
  readonly summaryRight?: ReactNode;
  readonly children: ReactNode;
  /** テスト用の識別子。 */
  readonly testId?: string;
}

export default function CollapsibleSection(props: CollapsibleSectionProps) {
  const tone = AREA_TONES[props.tone];
  return (
    <details
      open={props.defaultOpen ?? false}
      data-testid={props.testId}
      data-area-tone={props.tone}
      className={`group rounded-xl ${tone.section}`}
    >
      <summary className="flex flex-wrap items-center gap-2 px-3 py-2 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="text-gray-500 text-[10px] transition-transform group-open:rotate-90">
          ▶
        </span>
        <h3 className={`text-sm font-semibold ${tone.heading}`}>{props.title}</h3>
        <span className={`text-[10px] rounded px-1.5 py-0.5 ${tone.badge}`}>{tone.label}</span>
        {props.summaryRight !== undefined && <span className="text-[11px] text-gray-400 ml-auto">{props.summaryRight}</span>}
      </summary>
      <div className="px-3 pb-3 space-y-2">
        {props.description !== undefined && <p className="text-[11px] text-gray-400">{props.description}</p>}
        {props.children}
      </div>
    </details>
  );
}

/** 入力エリア・情報エリアの色の意味を示す凡例（画面上部に一度だけ置く）。 */
export function AreaToneLegend() {
  return (
    <div className="flex flex-wrap items-center gap-3 text-[11px] text-gray-400">
      <span>色の見方:</span>
      {(["input", "info"] as const).map((toneKey) => {
        const tone = AREA_TONES[toneKey];
        return (
          <span key={toneKey} className="flex items-center gap-1.5">
            <span aria-hidden className={`inline-block w-3.5 h-3.5 rounded ${tone.swatch}`} />
            {tone.label}
            <span className="text-gray-500">{toneKey === "input" ? "（値を入力する）" : "（読むだけ）"}</span>
          </span>
        );
      })}
      <span className="text-gray-500">各セクションは折りたたまれています。見出しの ▶ を押すと開閉できます。</span>
    </div>
  );
}
