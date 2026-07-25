// ShrimpX V2 — 会社経営統合テスト環境 プレイ画面の共通スタイル契約
//
// プレイヤーからの要望「入力するべきエリアと、情報エリアは色を変えてわかりやすく
// してください」に対する、画面全体で唯一の色の取り決め（カラーコントラクト）である。
//
// 【方針】
//   入力エリア（プレイヤーが値を書き込む場所）＝ 青系（sky）
//   情報エリア（読むだけの場所）             ＝ 灰系（gray）
//   の2系統だけに限定する。3系統目を増やすと「色に意味がある」という手掛かり自体が
//   薄れるため、警告（amber）・エラー（rose）は既存どおり個別の状態表現として扱い、
//   エリア種別の色分けとは混ぜない。
//
// 【禁止事項】
//   - 各Reactコンポーネントの中で、入力欄や情報ブロックの色クラスを直接書かない
//     （必ずこのファイルの定数を参照する）。色が散在すると、片方だけ変えた結果
//     「入力欄なのに情報色」という誤解を生む画面が容易に発生する。
//   - この2系統以外の色をエリア種別の意味で追加しない。

/** エリア種別。 */
export type AreaTone = "input" | "info";

export interface AreaToneStyle {
  /** 凡例・バッジに表示する日本語名。 */
  readonly label: string;
  /** セクション外枠（背景＋境界線）。 */
  readonly section: string;
  /** セクション見出しの文字色。 */
  readonly heading: string;
  /** セクション見出し横のエリア種別バッジ。 */
  readonly badge: string;
  /** 凡例の色見本。 */
  readonly swatch: string;
}

export const AREA_TONES: Readonly<Record<AreaTone, AreaToneStyle>> = {
  input: {
    label: "入力エリア",
    section: "bg-sky-950/40 border border-sky-800/60",
    heading: "text-sky-100",
    badge: "bg-sky-900/70 text-sky-200 border border-sky-700/70",
    swatch: "bg-sky-900/70 border border-sky-500/70",
  },
  info: {
    label: "情報エリア",
    section: "bg-gray-900/50 border border-gray-700/60",
    heading: "text-gray-200",
    badge: "bg-gray-800 text-gray-300 border border-gray-600/70",
    swatch: "bg-gray-800 border border-gray-600/70",
  },
};

/**
 * 入力コントロール（input / select / checkbox）の共通クラス。
 * 「ここは書き込む場所」であることを、枠線と背景の両方で示す。
 */
export const INPUT_CONTROL_CLASS =
  "bg-sky-900/70 border border-sky-500/70 rounded px-2 py-1 text-sm text-sky-50 " +
  "focus:outline-none focus:border-sky-300 focus:ring-1 focus:ring-sky-400 " +
  "disabled:opacity-50 disabled:bg-gray-800 disabled:border-gray-600 disabled:text-gray-400";

/** 入力欄に対するソフト警告（値は受け付けるが確認を促す）。エリア色分けとは独立の状態表現。 */
export const INPUT_CONTROL_WARN_CLASS = "border-amber-500 ring-1 ring-amber-500";

/** 情報テーブルの見出し行。 */
export const INFO_TABLE_HEAD_CLASS = "text-gray-400 text-left";

/** 情報テーブルの行区切り。 */
export const INFO_TABLE_ROW_CLASS = "border-t border-gray-700/60";

/** 情報として表示するだけの数値セル（入力欄と見間違えないよう、意図的に彩度を落とす）。 */
export const INFO_VALUE_CLASS = "text-gray-400";

/** 情報として強調したい数値（当期の能力など、判断の主役になる値）。 */
export const INFO_VALUE_STRONG_CLASS = "text-gray-100 font-medium";

/** 値が存在しないことの表示（0で埋めない）。 */
export const NO_VALUE_TEXT = "－";
