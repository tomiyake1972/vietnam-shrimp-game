"use client";

// ShrimpX V2 — 提出前の最終確認画面（UI-TRIAL-1 §5）
//
// 入力 →「意思決定を確認」→ この画面 →「この内容で確定／提出」→ 成功表示
//
// 【両PLAYER経路で同じ画面を使う】Management Console内PLAYER（確定）と
// Independent Player（提出）で文言だけを変え、一覧の作り方・検証・「修正する」の
// 挙動は共通にする。別のUIを作らない。
//
// 【この画面を開いただけでは何も起きない】サーバーへの提出・確定・Turn進行は
// commitLabel のボタンを押したときだけ。表示のための取得も行わない
// （BW-1 の条件付き取得・非表示時停止・重複防止へ影響しない）。
//
// 【表示は下書きそのもの】一覧は buildDecisionSummary（提出される下書きを読むだけの
// 純粋関数）が作る。Standard AI の影の判断や前期実績を提出値として混ぜない。

import { DecisionSummary, SUMMARY_NATURE_LABELS, SummaryNature, SummaryValueState } from "../../decisionSummary";
import { DecisionStudioScreenKey } from "./DecisionStudioNavigation";
import { AREA_TONES } from "../panelStyles";

/** 経路ごとの文言。保存・権限・Turn進行のルールは呼び出し側がそのまま持つ。 */
export interface DecisionConfirmationCopy {
  /** 画面見出し（例: 「提出内容の最終確認」）。 */
  readonly heading: string;
  /** 確定/提出ボタンの文言（例: 「この内容で提出」「この内容で確定」）。 */
  readonly commitLabel: string;
  /** 実行中のボタン文言（例: 「提出中…」）。 */
  readonly committingLabel: string;
  /** 画面上部の説明。 */
  readonly description: string;
}

export interface DecisionConfirmationScreenProps {
  readonly summary: DecisionSummary;
  readonly companyName: string;
  readonly companyId: string;
  /** 対象Turn／四半期（計画と実績を混同させないため必ず表示する）。 */
  readonly turnLabel: string;
  readonly copy: DecisionConfirmationCopy;
  /** 共通検証の結果。1件以上あるときは確定/提出ボタンを押せない。 */
  readonly validationErrors: readonly string[];
  /** 入力画面へ戻る（分野ごとの「修正する」と、画面上部の「入力へ戻る」）。 */
  readonly onEdit: (screen: DecisionStudioScreenKey) => void;
  readonly onBack: () => void;
  readonly onCommit: () => void;
  readonly committing: boolean;
  readonly commitError: string | null;
  /**
   * 確認後に状況が変わった（Turnが進んだ・提出済みになった・適用設定が変わった）。
   * このときは古い内容を提出させず、再確認へ誘導する。
   */
  readonly staleNotice?: string | null;
}

const VALUE_STATE_NOTE: Readonly<Record<SummaryValueState, string | undefined>> = {
  value: undefined,
  zero: "0（明示）",
  unset: "指定なし",
  invalid: "未入力",
};

function natureClass(nature: SummaryNature): string {
  switch (nature) {
    case "application":
      return "bg-amber-900/60 text-amber-200 border border-amber-700/60";
    case "plan":
      return "bg-sky-900/60 text-sky-200 border border-sky-700/60";
    case "fixed":
      return "bg-gray-800 text-gray-300 border border-gray-600/70";
    default:
      return "bg-emerald-900/50 text-emerald-200 border border-emerald-700/50";
  }
}

export default function DecisionConfirmationScreen({
  summary,
  companyName,
  companyId,
  turnLabel,
  copy,
  validationErrors,
  onEdit,
  onBack,
  onCommit,
  committing,
  commitError,
  staleNotice,
}: DecisionConfirmationScreenProps) {
  const blocked = validationErrors.length > 0 || Boolean(staleNotice);

  return (
    <div className="space-y-3" data-testid="decision-confirmation-screen">
      {/* 会社名・対象Turn。どの会社のどのTurnを提出するのかを最初に出す。 */}
      <div className={`rounded-xl px-3 py-2 ${AREA_TONES.input.section}`} data-testid="decision-confirmation-header">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className={`text-sm font-semibold ${AREA_TONES.input.heading}`}>{copy.heading}</h2>
            <p className="mt-0.5 text-[11px] text-sky-200/80">
              <span data-testid="decision-confirmation-company">
                {companyName}（{companyId}）
              </span>
              <span className="mx-1 text-sky-500">/</span>
              <span data-testid="decision-confirmation-turn">{turnLabel}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={onBack}
            data-testid="decision-confirmation-back"
            className="rounded border border-sky-700/70 bg-sky-900/40 px-3 py-1.5 text-xs text-sky-100 hover:bg-sky-800/50"
          >
            入力へ戻る
          </button>
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-sky-100/80">{copy.description}</p>
        <p className="mt-1 text-[11px] text-amber-300" data-testid="decision-confirmation-not-submitted-yet">
          この画面を開いただけでは、まだ何も提出されていません。
        </p>
      </div>

      {/* 確認中に状況が変わった場合 */}
      {staleNotice ? (
        <div className="rounded-lg border border-amber-700/60 bg-amber-950/40 px-3 py-2 text-xs text-amber-200" role="alert" data-testid="decision-confirmation-stale">
          {staleNotice}
        </div>
      ) : null}

      {/* 共通検証のエラー（項目名と理由） */}
      {validationErrors.length > 0 ? (
        <div className="rounded-lg border border-rose-700/60 bg-rose-950/40 px-3 py-2" role="alert" data-testid="decision-confirmation-validation-errors">
          <h3 className="text-xs font-semibold text-rose-200">この内容では提出できません（入力は保持しています）</h3>
          <ul className="mt-1 space-y-0.5">
            {validationErrors.map((message, index) => (
              <li key={index} className="text-[11px] text-rose-200" data-testid="decision-confirmation-validation-error-item">
                ・{message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* 提出されない行がある場合の注意 */}
      {summary.notSubmittedNotes.length > 0 ? (
        <div className="rounded-lg border border-amber-700/50 bg-amber-950/30 px-3 py-2" data-testid="decision-confirmation-not-submitted-notes">
          <h3 className="text-xs font-semibold text-amber-200">提出されない行があります</h3>
          <ul className="mt-1 space-y-0.5">
            {summary.notSubmittedNotes.map((note, index) => (
              <li key={index} className="text-[11px] text-amber-200">
                ・{note}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* 分野ごとの一覧 */}
      {summary.sections.map((section) => (
        <section
          key={section.key}
          className="rounded-xl border border-gray-700/60 bg-gray-900/50"
          data-testid={`decision-confirmation-section-${section.key}`}
          data-section-title={section.title}
        >
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-700/60 px-3 py-2">
            <h3 className="text-xs font-semibold text-gray-200">{section.title}</h3>
            <button
              type="button"
              onClick={() => onEdit(section.screen)}
              data-testid={`decision-confirmation-edit-${section.key}`}
              className="rounded border border-sky-700/70 bg-sky-900/40 px-2 py-1 text-[11px] text-sky-100 hover:bg-sky-800/50"
            >
              修正する
            </button>
          </header>
          <div className="px-3 py-2">
            {section.items.length === 0 ? (
              <p className="text-[11px] text-gray-400">{section.emptyNote ?? "この分野の提出項目はありません。"}</p>
            ) : (
              <table className="min-w-full text-xs">
                <tbody>
                  {section.items.map((item, index) => (
                    <tr
                      key={`${item.label}-${item.target ?? ""}-${index}`}
                      className={`border-t border-gray-800 ${item.submitted ? "" : "opacity-70"}`}
                      data-testid={`decision-confirmation-item-${section.key}-${index}`}
                      data-submitted={item.submitted ? "true" : "false"}
                      data-value-state={item.state}
                    >
                      <td className="py-1 pr-3 align-top text-gray-400">
                        {item.label}
                        {item.target !== undefined && (
                          <span className="ml-1 rounded bg-gray-800 px-1 py-[1px] text-[10px] text-gray-300">{item.target}</span>
                        )}
                      </td>
                      <td className="py-1 pr-3 align-top text-right tabular-nums text-gray-100">
                        <span data-testid={`decision-confirmation-value-${section.key}-${index}`}>{item.value}</span>
                        {item.unit !== undefined && <span className="ml-0.5 text-gray-400">{item.unit}</span>}
                        {VALUE_STATE_NOTE[item.state] !== undefined && (
                          <span className={`ml-1 text-[10px] ${item.state === "invalid" ? "text-rose-300" : "text-gray-500"}`}>
                            {VALUE_STATE_NOTE[item.state]}
                          </span>
                        )}
                      </td>
                      <td className="py-1 pr-3 align-top">
                        <span className={`whitespace-nowrap rounded px-1 py-[1px] text-[10px] ${natureClass(item.nature)}`} data-nature={item.nature}>
                          {SUMMARY_NATURE_LABELS[item.nature]}
                        </span>
                      </td>
                      <td className="py-1 align-top text-[10px] leading-tight text-gray-400">
                        {item.submitted ? null : <span className="mr-1 text-amber-300">提出されません</span>}
                        {item.note}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      ))}

      {/* 合計（提出値をそのまま足せるものだけ） */}
      <section className="rounded-xl border border-gray-700/60 bg-gray-900/50 px-3 py-2" data-testid="decision-confirmation-totals">
        <h3 className="text-xs font-semibold text-gray-200">合計</h3>
        <p className="mt-0.5 text-[10px] text-gray-500">提出する値をそのまま足した合計だけを出しています（資金の予測は作っていません）。</p>
        <dl className="mt-1 space-y-1">
          {summary.totals.map((total) => (
            <div key={total.label} className="flex flex-wrap items-baseline justify-between gap-2">
              <dt className="text-[11px] text-gray-400">{total.label}</dt>
              <dd className="text-xs font-semibold tabular-nums text-gray-100">{total.value}</dd>
              {total.note !== undefined && <p className="w-full text-[10px] text-gray-500">{total.note}</p>}
            </div>
          ))}
        </dl>
      </section>

      {/* 入力経路が無い意思決定（黙って欠落させない） */}
      {summary.noInputPathNotes.length > 0 ? (
        <section className="rounded-xl border border-gray-700/60 bg-gray-900/40 px-3 py-2" data-testid="decision-confirmation-no-input-path">
          <h3 className="text-xs font-semibold text-gray-300">この画面からは提出できない意思決定</h3>
          <ul className="mt-1 space-y-0.5">
            {summary.noInputPathNotes.map((note, index) => (
              <li key={index} className="text-[11px] leading-relaxed text-gray-400">
                ・{note}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* 確定／提出 */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {commitError ? (
          <p className="mr-auto text-[11px] text-rose-300" role="alert" data-testid="decision-confirmation-commit-error">
            {commitError}
          </p>
        ) : null}
        <button
          type="button"
          onClick={onBack}
          data-testid="decision-confirmation-back-bottom"
          className="rounded border border-gray-600 bg-gray-800 px-3 py-1.5 text-xs text-gray-100 hover:bg-gray-700"
        >
          入力へ戻る
        </button>
        <button
          type="button"
          onClick={onCommit}
          /* 二重クリックによる重複送信を防ぐ（実行中は押せない）。 */
          disabled={committing || blocked}
          data-testid="decision-confirmation-commit"
          className="rounded bg-emerald-700 px-4 py-1.5 text-sm font-semibold text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {committing ? copy.committingLabel : copy.commitLabel}
        </button>
      </div>
    </div>
  );
}
