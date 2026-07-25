// ShrimpX V2 — 会社経営統合テスト環境 折りたたみ可能なセクション（共通コンポーネント）
//
// プレイヤーからの要望「画面が縦長になっていくので、各情報は折りたためるように
// 設定してください」に対する、画面全体で唯一の折りたたみ実装である。
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
  /** 初期状態で開いているか（既定: 開いている）。 */
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
      open={props.defaultOpen ?? true}
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
      <span className="text-gray-500">見出しの ▶ を押すと各セクションを折りたためます。</span>
    </div>
  );
}
