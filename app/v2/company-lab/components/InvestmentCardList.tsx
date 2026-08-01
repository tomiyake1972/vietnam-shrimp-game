// ShrimpX V2 — Phase 8D-2 設備投資カード（再設計版）
//
// investmentPlanningViewModel.ts が算出済みの値を描画するだけで、計算を一切持たない。
// カード上には判断に直結する主要項目だけを出し、詳細は <details> で折りたためる。
//
// 【禁止事項】
//   - 投資額・工期・能力増加量・保守費・スペース係数をここへ書かない。
//   - 未実装の効果を、実装済みの効果と同じ並びで見せない。
//   - 算定できない投資回収を、それらしい数字で埋めない。

import { InvestmentCardViewModel } from "../investmentPlanningViewModel";
import { CapitalProjectType } from "../../../lib/v2/capex";
import { INFO_VALUE_CLASS, INFO_VALUE_STRONG_CLASS, NO_VALUE_TEXT } from "./panelStyles";

interface InvestmentCardListProps {
  readonly cards: readonly InvestmentCardViewModel[];
  readonly currentCashUsd: number;
  readonly draftPaymentThisQuarterUsd: number;
  readonly isDuplicate: (projectType: CapitalProjectType) => boolean;
  readonly onAdd: (projectType: CapitalProjectType) => void;
  readonly disabled: boolean;
  /**
   * 【Test15新設】案件種別ごとの追加ブロック理由（例: 新工場建設の4工場上限）。
   * 文字列を返すとその種別の「ドラフトへ追加」ボタンがdisabledになり、理由が表示される。
   * 省略時・undefined返却時はブロックしない（既存の挙動を変えない）。
   */
  readonly extraBlockedReasonByType?: (projectType: CapitalProjectType) => string | undefined;
}

function usd(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function tons(value: number): string {
  return `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })} t`;
}

function units(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function Field(props: { readonly label: string; readonly value: string; readonly emphasis?: boolean; readonly tone?: "warn" | "bad" | "good" }) {
  const toneClass =
    props.tone === "bad" ? "text-rose-300" : props.tone === "warn" ? "text-amber-300" : props.tone === "good" ? "text-teal-300" : undefined;
  return (
    <div className="flex flex-col">
      <span className="text-[10px] text-gray-500">{props.label}</span>
      <span className={`text-[11px] ${toneClass ?? (props.emphasis ? INFO_VALUE_STRONG_CLASS : INFO_VALUE_CLASS)}`}>{props.value}</span>
    </div>
  );
}

export default function InvestmentCardList(props: InvestmentCardListProps) {
  const { cards, disabled } = props;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
      {cards.map((card) => {
        const c = card.candidate;
        const affordable = props.currentCashUsd - props.draftPaymentThisQuarterUsd >= c.thisQuarterExpectedPaymentUsd;
        const duplicate = props.isDuplicate(card.projectType);
        const extraBlockedReason = props.extraBlockedReasonByType?.(card.projectType);

        return (
          <div key={card.projectType} className="bg-gray-900/60 border border-gray-700/60 rounded-lg px-3 py-2 space-y-2">
            {/* 見出し */}
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-xs font-semibold text-gray-100">{c.displayName}</div>
                <p className="text-[11px] text-gray-400 mt-0.5">{card.description}</p>
              </div>
              <button
                type="button"
                disabled={disabled || extraBlockedReason !== undefined}
                onClick={() => props.onAdd(card.projectType)}
                className="shrink-0 text-[11px] px-2 py-1 rounded bg-sky-900/70 border border-sky-500/70 text-sky-50 hover:bg-sky-800/70 disabled:opacity-50 disabled:bg-gray-800 disabled:border-gray-600 disabled:text-gray-400"
              >
                ドラフトへ追加
              </button>
            </div>

            {extraBlockedReason !== undefined && (
              <div className="bg-amber-950/40 border border-amber-700/50 rounded px-2 py-1 text-[10px] text-amber-200">{extraBlockedReason}</div>
            )}

            {/* 主要項目 */}
            <div className="grid grid-cols-3 gap-x-3 gap-y-1.5">
              <Field label="投資額" value={usd(c.totalInvestmentUsd)} emphasis />
              <Field label="建設期間" value={`${c.constructionQuarters}四半期`} />
              <Field label="今期の支払予定" value={usd(c.thisQuarterExpectedPaymentUsd)} tone={affordable ? undefined : "warn"} />

              <Field label="現在の能力" value={card.currentCapacityTons !== undefined ? tons(card.currentCapacityTons) : NO_VALUE_TEXT} />
              <Field label="追加能力" value={card.capacityIncreaseTons > 0 ? `+${tons(card.capacityIncreaseTons)}` : NO_VALUE_TEXT} />
              <Field
                label="投資完成後能力"
                value={card.capacityAfterTons !== undefined ? tons(card.capacityAfterTons) : NO_VALUE_TEXT}
                emphasis
              />

              <Field label="必要工場スペース" value={units(card.requiredSpaceUnits)} tone={card.fitsInFactorySpace ? undefined : "bad"} />
              <Field
                label="完成後のスペース使用率"
                value={card.spaceUtilizationRateAfter !== undefined ? `${(card.spaceUtilizationRateAfter * 100).toFixed(1)}%` : NO_VALUE_TEXT}
                tone={card.fitsInFactorySpace ? undefined : "bad"}
              />
              <Field
                label="追加で必要なWorker"
                value={card.additionalRequiredHeadcount > 0 ? `${card.additionalRequiredHeadcount.toLocaleString("en-US")}人` : NO_VALUE_TEXT}
              />

              <Field
                label="追加四半期人件費"
                value={card.additionalQuarterlyLaborCostUsd > 0 ? usd(card.additionalQuarterlyLaborCostUsd) : NO_VALUE_TEXT}
              />
              <Field label="四半期保守費（稼働後）" value={usd(c.quarterlyMaintenanceCostUsd)} />
              <Field label="四半期減価償却（稼働後）" value={usd(c.quarterlyTotalDepreciationUsd)} />

              <Field
                label="投資完成後に処理できる追加量"
                value={card.incrementalProcessableTonsPerQuarter > 0 ? `+${tons(card.incrementalProcessableTonsPerQuarter)}／四半期` : NO_VALUE_TEXT}
                emphasis={card.incrementalProcessableTonsPerQuarter > 0}
                tone={card.incrementalProcessableTonsPerQuarter > 0 ? "good" : undefined}
              />
              <Field label="主なボトルネック" value={card.primaryBottleneckLabel ?? "制約なし"} />
              <Field
                label="概算投資回収年数"
                value={
                  card.payback.isComputable && card.payback.paybackYears !== undefined
                    ? `約${card.payback.paybackYears.toFixed(1)}年`
                    : "現在の実装では算定対象外"
                }
                emphasis={card.payback.isComputable}
              />
            </div>

            {/* 当期には使えないことの明示 */}
            <div className="text-[10px] text-gray-500">{card.notAvailableThisQuarterNote}</div>

            {/* 効果が無い場合の理由 */}
            {card.noEffectReason !== undefined && (
              <div className="bg-gray-800/60 border border-gray-700/60 rounded px-2 py-1 text-[10px] text-gray-400">{card.noEffectReason}</div>
            )}

            {/* スペース不足 */}
            {!card.fitsInFactorySpace && (
              <div className="bg-rose-950/40 border border-rose-700/50 rounded px-2 py-1 text-[10px] text-rose-200">
                工場スペースが {units(card.spaceShortfallUnits)} 不足しています（必要 {units(card.requiredSpaceUnits)} / 空き{" "}
                {units(card.freeSpaceUnitsBefore)}）。このまま提出しても、この案件は承認されません。
              </div>
            )}

            {duplicate && (
              <div className="bg-amber-950/40 border border-amber-700/50 rounded px-2 py-1 text-[10px] text-amber-200">
                今期のドラフトに同じ種別の案件がすでに含まれています。
              </div>
            )}

            {/* 詳細（折りたたみ） */}
            <details>
              <summary className="text-[10px] text-teal-400 hover:text-teal-300 cursor-pointer">
                支払予定・投資回収の前提・実装済み／未実装の効果
              </summary>
              <div className="mt-1 space-y-2">
                <div>
                  <div className="text-[10px] text-gray-500">分割支払予定</div>
                  <div className="text-[11px] text-gray-400">
                    {c.paymentScheduleUsd.map((v, i) => `${i + 1}回目 ${usd(v)}`).join(" ／ ")}
                  </div>
                </div>

                <div>
                  <div className="text-[10px] text-gray-500">投資回収の算定</div>
                  <div className="text-[11px] text-gray-400">{card.payback.formulaText}</div>
                  {card.payback.isComputable ? (
                    <ul className="mt-0.5 space-y-0.5">
                      <li className="text-[10px] text-gray-500">
                        実績限界利益: ${card.payback.contributionMarginUsdPerTon?.toFixed(2)} / 販売トン
                      </li>
                      <li className="text-[10px] text-gray-500">
                        増分限界利益: {usd(card.payback.incrementalContributionUsdPerQuarter ?? 0)} / 四半期
                      </li>
                      <li className="text-[10px] text-gray-500">
                        増分Worker人件費: −{usd(card.payback.incrementalLaborCostUsdPerQuarter)} / 四半期（
                        {card.payback.incrementalRegularHeadcount.toLocaleString("en-US")}人）
                      </li>
                      <li className="text-[10px] text-gray-500">
                        増分保守費: −{usd(card.payback.incrementalMaintenanceUsdPerQuarter)} / 四半期
                      </li>
                      <li className="text-[10px] text-gray-500">
                        増分キャッシュフロー: {usd(card.payback.incrementalCashFlowUsdPerQuarter ?? 0)} / 四半期
                      </li>
                    </ul>
                  ) : (
                    <div className="text-[10px] text-amber-300 mt-0.5">{card.payback.notComputableReason}</div>
                  )}
                  <ul className="mt-0.5 space-y-0.5">
                    {card.payback.assumptionTexts.map((t, i) => (
                      <li key={i} className="text-[10px] text-gray-500">
                        ・{t}
                      </li>
                    ))}
                  </ul>
                  <p className="text-[10px] text-teal-400/90 mt-1">{card.payback.doubleCountingNote}</p>
                </div>

                <div>
                  <div className="text-[10px] text-teal-400">実装済みの効果（エンジンへ接続済み）</div>
                  <ul className="mt-0.5 space-y-0.5">
                    {card.effectDisclosure.implementedEffects.map((t, i) => (
                      <li key={i} className="text-[10px] text-gray-400">
                        ・{t}
                      </li>
                    ))}
                  </ul>
                </div>

                {card.effectDisclosure.notImplementedEffects.length > 0 && (
                  <div className="bg-amber-950/30 border border-amber-800/50 rounded px-2 py-1">
                    <div className="text-[10px] text-amber-300">未実装の効果（現時点ではエンジンへ未接続）</div>
                    <ul className="mt-0.5 space-y-0.5">
                      {card.effectDisclosure.notImplementedEffects.map((t, i) => (
                        <li key={i} className="text-[10px] text-amber-200">
                          ・{t}
                        </li>
                      ))}
                    </ul>
                    {card.effectDisclosure.notImplementedNote !== undefined && (
                      <p className="text-[10px] text-amber-200/80 mt-1">{card.effectDisclosure.notImplementedNote}</p>
                    )}
                  </div>
                )}
              </div>
            </details>
          </div>
        );
      })}
    </div>
  );
}
