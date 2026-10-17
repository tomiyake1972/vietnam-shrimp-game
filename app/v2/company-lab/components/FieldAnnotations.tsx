// ShrimpX V2 — 入力欄と参照情報を見分けるための共通注記（UI-TRIAL-1 §4）
//
// 【なぜ必要か】予行演習の準備で「どこを入力するか／何を提出するか」が分かりにくい、
// という指摘を受けた。色だけでは足りない（色の意味を知らない人には伝わらない）ため、
// 文言・見出し・配置を併用する。その表現をここに1か所だけ置き、各画面はこれを使う。
//
// 色の取り決め自体は既存の panelStyles.ts（AREA_TONES / INPUT_CONTROL_CLASS）が
// 唯一の正であり、このファイルは色を新しく定義しない。
//
// 【禁止事項】
//   - 参照値をここ以外の見た目で「入力欄のように」描かない。
//   - 参照の種別（前期実績・現在の状態・参考値・自動計算値）を増やさない。
//     4種で足りない表示が出てきた場合は、その表示自体を見直す。

import { ReactNode } from "react";
import { AREA_TONES, INFO_VALUE_CLASS, NO_VALUE_TEXT } from "./panelStyles";

/**
 * 参照情報の種別。計画と実績、対象Turnの混同を防ぐために必ずどれかを明示する。
 *   actual     … 確定した過去の数字（前期実績）
 *   current    … いまの状態（当期開始時点の在庫・人員・残高など）
 *   reference  … 参考値（前提が変われば変わる。約束ではない）
 *   derived    … 入力から自動計算した値（入力ではないので編集できない）
 */
export type ReferenceKind = "actual" | "current" | "reference" | "derived";

interface ReferenceKindStyle {
  readonly label: string;
  readonly hint: string;
}

export const REFERENCE_KINDS: Readonly<Record<ReferenceKind, ReferenceKindStyle>> = {
  actual: { label: "前期実績", hint: "確定した過去の数字です。" },
  current: { label: "現在の状態", hint: "当期開始時点の状態です。" },
  reference: { label: "参考値", hint: "前提が変われば変わります。約束された値ではありません。" },
  derived: { label: "自動計算値", hint: "入力から自動で計算した値です。直接は編集できません。" },
};

/** 参照種別のラベル（文言そのもの。入力欄の近くに置く小さなバッジ）。 */
export function ReferenceBadge({ kind, testId }: { readonly kind: ReferenceKind; readonly testId?: string }) {
  const style = REFERENCE_KINDS[kind];
  return (
    <span
      data-testid={testId}
      data-reference-kind={kind}
      title={style.hint}
      className={`whitespace-nowrap rounded px-1 py-[1px] text-[10px] ${AREA_TONES.info.badge}`}
    >
      {style.label}
    </span>
  );
}

/**
 * 参照値の1行表示。「ラベル（種別） 値」の形に固定する。
 * 値は意図的に彩度を落とし（INFO_VALUE_CLASS）、枠線も背景も付けない
 * ＝入力欄には見えない。
 */
export function ReferenceValue({
  label,
  kind,
  value,
  unit,
  testId,
}: {
  readonly label: string;
  readonly kind: ReferenceKind;
  readonly value: ReactNode;
  readonly unit?: string;
  readonly testId?: string;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-1 text-[11px] leading-tight" data-testid={testId} data-reference-kind={kind}>
      <span className="text-gray-400">{label}</span>
      <ReferenceBadge kind={kind} />
      <span className={`tabular-nums ${INFO_VALUE_CLASS}`}>
        {value === null || value === undefined || value === "" ? NO_VALUE_TEXT : value}
        {unit !== undefined && value !== null && value !== undefined && value !== "" ? <span className="ml-0.5 text-gray-500">{unit}</span> : null}
      </span>
    </div>
  );
}

/**
 * 入力欄の見出し。項目名・単位・対象（市場／商品／工場）を必ず書く。
 * 「人数」だけでは何の人数か分からない、という指摘への対応。
 */
export function InputFieldLabel({
  name,
  unit,
  target,
  htmlFor,
  testId,
  children,
}: {
  readonly name: string;
  readonly unit?: string;
  /** 対象（例: "CN市場"、"CN × HOSO"、"第1工場"）。狭い画面でも所属が分かるように必ず書く。 */
  readonly target?: string;
  readonly htmlFor?: string;
  readonly testId?: string;
  /** 補足説明（任意）。 */
  readonly children?: ReactNode;
}) {
  return (
    <label htmlFor={htmlFor} className="block text-[11px] leading-tight" data-testid={testId}>
      <span className={`font-medium ${AREA_TONES.input.heading}`}>{name}</span>
      {unit !== undefined && <span className="ml-1 text-gray-400">（{unit}）</span>}
      {target !== undefined && (
        <span className="ml-1 rounded bg-sky-900/50 px-1 py-[1px] text-[10px] text-sky-200" data-testid={testId ? `${testId}-target` : undefined}>
          {target}
        </span>
      )}
      {children !== undefined && <span className="mt-0.5 block text-[10px] text-gray-400">{children}</span>}
    </label>
  );
}

/**
 * 表の見出しセルに「この列は入力か参照か」を書く。
 *
 * 1行の中に入力列と読み取り専用列が混ざる表（工場別のワーカー配置など）では、
 * 値の見た目（彩度）だけでは列の性質が伝わらない。見出しに文言で書く。
 */
export function ColumnHeader({
  name,
  unit,
  kind,
  testId,
}: {
  readonly name: string;
  readonly unit?: string;
  /** "input" なら入力列、それ以外は参照列の種別。 */
  readonly kind: "input" | ReferenceKind;
  readonly testId?: string;
}) {
  const isInput = kind === "input";
  return (
    <span className="inline-flex flex-col items-start gap-0.5" data-testid={testId} data-column-kind={kind}>
      <span className={isInput ? AREA_TONES.input.heading : "text-gray-400"}>
        {name}
        {unit !== undefined && <span className="ml-0.5 text-gray-500">（{unit}）</span>}
      </span>
      {isInput ? (
        <span className={`whitespace-nowrap rounded px-1 py-[1px] text-[10px] ${AREA_TONES.input.badge}`}>入力</span>
      ) : (
        <ReferenceBadge kind={kind} />
      )}
    </span>
  );
}

/**
 * 入力エリアの先頭に置く見出し。「ここから下は自分が決めて提出する欄」だと分かるようにする。
 * 画面ごとに1回だけ使う（セクションごとに繰り返さない）。
 */
export function DecisionAreaHeading({
  turnLabel,
  description,
  testId,
}: {
  /** 対象Turn／四半期（計画と実績の混同を防ぐため必ず書く）。 */
  readonly turnLabel: string;
  readonly description?: string;
  readonly testId?: string;
}) {
  return (
    <div className={`rounded-lg px-3 py-2 ${AREA_TONES.input.section}`} data-testid={testId ?? "decision-area-heading"}>
      <h2 className={`text-sm font-semibold ${AREA_TONES.input.heading}`}>
        今期の意思決定
        <span className="ml-2 rounded bg-sky-900/70 px-1.5 py-0.5 text-[10px] text-sky-200" data-testid="decision-area-heading-turn">
          {turnLabel}
        </span>
      </h2>
      <p className="mt-1 text-[11px] leading-relaxed text-sky-200/80">
        {description ?? "この見出しより下の青い枠が、あなたが入力して提出する欄です。灰色の枠は読むだけの情報です。"}
      </p>
    </div>
  );
}

/**
 * AI初期提案の説明。初期値が入っている理由と、提出済みではないことを明示する。
 *
 * 【推測で由来を表示しない】項目ごとに「AI由来／手動由来」を出すには変更履歴が必要で、
 * 現在の下書き（CompanyDecisionDraft）はそれを持たない。持たないものを推測して
 * 表示しない、という指示に従い、ここでは画面単位の事実だけを述べる。
 */
export function AiInitialProposalNote({ testId }: { readonly testId?: string }) {
  return (
    <p className={`rounded-lg px-3 py-2 text-[11px] leading-relaxed ${AREA_TONES.info.section} text-gray-300`} data-testid={testId ?? "ai-initial-proposal-note"}>
      入力欄には <strong className="text-gray-100">AI提案を初期入力済み</strong> です。そのまま使っても、書き換えても構いません。
      <span className="ml-1 text-amber-300">まだ提出していません。</span>
      提出は「意思決定を確認」→ 最終確認画面 で行います。
      {/* 【PLAYER-INTRO-1】初参加者が「AI案＝正解」と受け取らないよう、保証しない旨を明示する。 */}
      <span className="ml-1 text-gray-400">
        この案は標準的な経営判断のたたき台であり、最適な判断や平均順位・利益を保証するものではありません。
        （どの項目をAIが入れ、どこを自分で変えたかの記録は保存していないため、項目ごとの由来は表示しません。）
      </span>
    </p>
  );
}
