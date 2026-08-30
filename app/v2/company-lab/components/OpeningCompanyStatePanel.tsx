// ShrimpX V2 — Company Lab 手動観察テスト向け追加パネル
//
// 【追加の経緯】三宅さんの手動観察テストで、turn 1（初回の意思決定前）は
// 「直近の四半期結果」セクション自体が存在せず、貸借対照表（現金・借入余力・
// AR・AP等）が画面のどこにも一括表示されないという指摘を受けた。既存の
// DecisionEditor内には現金等の断片的な参照値が意思決定領域ごとに散在しているが、
// 会社の期首状態をひとめで把握できる場所がなかったため、Standard AIの判断ロジック
// 本体には一切触れず、既存のCompanyOwnState（前四半期末までの状態、真実の唯一の
// ソース）をそのまま転記するだけの、読み取り専用の要約パネルを追加した。
//
// 【2026-08-01 追加】三宅さんの2回目の手動観察テストで、①自己資本（純資産）を
// 含まない簡易BSでは会社の財政状態が理解できない、②工場能力・Worker生産力・
// 営業人員のカバー範囲・工場増設と財務のルール（リンクで可）・実際のAR/AP決済
// サイトと借入返済スケジュール・原料在庫の利用可能時期、が分からないという指摘を
// 受けた。これらはいずれもStandard AIの判断ロジックが実際に参照している既存の
// フィクスチャ・エンジン関数から読み取れる値であり、本パネルはそれらを
// app/lib/v2/companyLab/openingStateSummary.ts の純粋関数へ渡して集計するだけ
// （値の推定・再計算は一切行わない。同じ関数をAI自身も使っている）。

import { Fragment } from "react";
import { CompanyFixture, CompanyOwnState } from "../../../lib/v2/companyLab/types";
import {
  computeBacklogByMarketProduct,
  computeFactoryCapacitySummaries,
  computeFinishedGoodsByProduct,
  computeLaborProductivityByProduct,
  computeOpeningBalanceSheetSummary,
  computeSalesForceCapacitySummary,
  groupRawMaterialLotsByAvailability,
  periodLabel,
  summarizeSettlementLag,
} from "../../../lib/v2/companyLab/openingStateSummary";
import { DEMAND_MARKET_NAMES } from "../../industry-lab/components/chartColors";
import CollapsibleSection from "./CollapsibleSection";

export interface OpeningCompanyStatePanelProps {
  readonly ownState: CompanyOwnState;
  readonly fixture: CompanyFixture;
  readonly turn: number;
}

function formatUsd(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function formatTons(value: number): string {
  return `${Math.round(value * 10) / 10} t`;
}

const PRODUCT_LABEL: Record<string, string> = { hoso: "HOSO", pd: "PD", vap: "VAP" };

export default function OpeningCompanyStatePanel({ ownState, fixture, turn }: OpeningCompanyStatePanelProps) {
  const bs = computeOpeningBalanceSheetSummary(ownState);

  const backlogTons = ownState.contracts.reduce((sum, c) => sum + (c.outstandingQuantity as number), 0);
  const backlogByMarketProduct = computeBacklogByMarketProduct(ownState.contracts, ownState.companyId);
  const rawMaterialGroups = groupRawMaterialLotsByAvailability(ownState.rawMaterialLots, ownState.companyId);
  const rawMaterialTotalTons = rawMaterialGroups.reduce((sum, g) => sum + g.quantityTons, 0);
  const finishedGoodsByProduct = computeFinishedGoodsByProduct(ownState.finishedGoodsLots, ownState.companyId);
  const finishedGoodsTons = finishedGoodsByProduct.reduce((sum, g) => sum + g.quantityTons, 0);

  const activeLoans = ownState.financingState.loanPortfolio.loans.filter((l) => l.status !== "closed");

  const items: ReadonlyArray<{ label: string; value: string }> = [
    { label: "現金", value: formatUsd(bs.cashUsd) },
    { label: "売掛金（AR）合計", value: `${formatUsd(bs.receivablesUsd)}（${ownState.financeState.receivables.length}件）` },
    { label: "買掛金（AP）合計", value: `${formatUsd(bs.payablesUsd)}（${ownState.financeState.payables.length}件）` },
    { label: "借入残高（元本合計）", value: `${formatUsd(bs.loanPortfolioPrincipalUsd)}（${activeLoans.length}件）` },
    { label: "未払利息", value: formatUsd(bs.accruedInterestPayableUsd) },
    { label: "利益剰余金", value: formatUsd(bs.retainedEarningsUsd) },
    { label: "受注残（未履行契約）", value: formatTons(backlogTons) },
    { label: "原料在庫（合計）", value: formatTons(rawMaterialTotalTons) },
    { label: "完成品在庫", value: formatTons(finishedGoodsTons) },
  ];

  const bsTotals: ReadonlyArray<{ label: string; value: string; strong?: boolean }> = [
    { label: "総資産", value: formatUsd(bs.totalAssetsUsd), strong: true },
    { label: "総負債", value: formatUsd(bs.totalLiabilitiesUsd) },
    { label: "純資産（自己資本 = 資本金 + 利益剰余金）", value: formatUsd(bs.totalEquityUsd), strong: true },
  ];

  const receivableLag = summarizeSettlementLag(ownState.financeState.receivables);
  const payableLag = summarizeSettlementLag(ownState.financeState.payables);

  const factoryCapacities = computeFactoryCapacitySummaries(fixture.factories);
  const laborProductivity = computeLaborProductivityByProduct(fixture.workerBaseline);
  const salesForceCapacity = computeSalesForceCapacitySummary(fixture.salesForceHeadcountTotal);

  return (
    <div className="space-y-4 text-sm">
      <p className="text-xs text-gray-400">
        turn {turn} 開始時点（前四半期末までの確定値。借入余力の上限は当期の銀行審査結果として四半期処理後に判明する）。
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2">
        {items.map((item) => (
          <div key={item.label} className="flex justify-between sm:block">
            <span className="text-gray-400">{item.label}</span>
            <span className="sm:block font-medium">{item.value}</span>
          </div>
        ))}
      </div>

      <div className="border-t border-gray-700/60 pt-3" data-testid="finished-goods-by-product">
        <h4 className="text-xs font-semibold text-gray-300 mb-1">製品在庫（商品別）</h4>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1">
          {finishedGoodsByProduct.map((g) => (
            <div key={g.product} className="flex justify-between sm:block" data-testid={`finished-goods-${g.product}`}>
              <span className="text-gray-400">{PRODUCT_LABEL[g.product] ?? g.product}</span>
              <span className="sm:block font-medium">{formatTons(g.quantityTons)}</span>
            </div>
          ))}
          <div className="flex justify-between sm:block" data-testid="finished-goods-total">
            <span className="text-gray-400">合計</span>
            <span className="sm:block font-semibold">{formatTons(finishedGoodsTons)}</span>
          </div>
        </div>
      </div>

      <div className="border-t border-gray-700/60 pt-3">
        <h4 className="text-xs font-semibold text-gray-300 mb-1">受注残（未履行契約）の内訳（市場×商品別）</h4>
        {backlogByMarketProduct.length === 0 ? (
          <p className="text-[11px] text-gray-500">現在、未履行の契約はありません。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-gray-400 text-left">
                  <th className="pr-2 py-1">市場</th>
                  <th className="pr-2 py-1">商品</th>
                  <th className="pr-2 py-1">未履行数量</th>
                  <th className="pr-2 py-1">件数</th>
                  <th className="pr-2 py-1">最短納期</th>
                </tr>
              </thead>
              <tbody>
                {backlogByMarketProduct.map((g) => (
                  <tr key={`${g.market}-${g.product}`} className="border-t border-gray-700/60">
                    <td className="pr-2 py-1">
                      {DEMAND_MARKET_NAMES[g.market]}（{g.market}）
                    </td>
                    <td className="pr-2 py-1">{PRODUCT_LABEL[g.product] ?? g.product}</td>
                    <td className="pr-2 py-1">{formatTons(g.outstandingTons)}</td>
                    <td className="pr-2 py-1">{g.contractCount}件</td>
                    <td className="pr-2 py-1">{g.nearestDueDateLabel}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="border-t border-gray-700/60 pt-3">
        <p className="text-xs text-gray-400 mb-2">
          簡易貸借対照表（期首時点。現金・在庫・固定資産等の合計 = 総資産。借入・買掛金等の合計 = 総負債。
          総資産－総負債＝純資産（自己資本）が構造上一致する）。
          {bs.constructionInProgressUsd === 0 ? "" : `建設中の設備投資（未完成・${formatUsd(bs.constructionInProgressUsd)}）を含む。`}
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-2">
          {bsTotals.map((row) => (
            <div key={row.label} className="flex justify-between sm:block">
              <span className="text-gray-400">{row.label}</span>
              <span className={`sm:block ${row.strong ? "font-semibold text-teal-200" : "font-medium"}`}>{row.value}</span>
            </div>
          ))}
        </div>
        {bs.loanPortfolioMismatchUsd >= 1 && (
          <p className="text-xs text-amber-300 mt-2">
            注意: 借入ポートフォリオ集計（{formatUsd(bs.loanPortfolioPrincipalUsd)}）と会社財務状態側の借入残高
            （{formatUsd(bs.shortTermLoansUsd + bs.longTermLoansUsd)}）に差異（{formatUsd(bs.loanPortfolioMismatchUsd)}）があります。
          </p>
        )}
      </div>

      <CollapsibleSection title="参考情報（工場能力・労働生産性・営業体制・財務ルール等）" tone="info" defaultOpen={false} testId="opening-reference-info-section">
        <div className="space-y-4">
          {/* ① 工場能力 */}
          <div>
            <h4 className="text-xs font-semibold text-gray-300 mb-1">① 工場の能力（名目 vs 実効）</h4>
            <p className="text-[11px] text-gray-500 mb-1">
              名目能力はStandard AIが判断時に参照する値、実効能力は実際にエンジンが生産配分で使う値
              （基準稼働率×設備利用可能率を適用した後の値。工場設定により変わり、常に0.9×0.95とは限らない）。
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-gray-400 text-left">
                    <th className="pr-2 py-1">工場</th>
                    <th className="pr-2 py-1">区分</th>
                    <th className="pr-2 py-1">共通原料処理</th>
                    <th className="pr-2 py-1">HOSO</th>
                    <th className="pr-2 py-1">PD</th>
                    <th className="pr-2 py-1">VAP</th>
                    <th className="pr-2 py-1">凍結・包装</th>
                  </tr>
                </thead>
                <tbody>
                  {factoryCapacities.map((f) => (
                    <Fragment key={f.factoryId}>
                      <tr className="border-t border-gray-700/60">
                        <td className="pr-2 py-1" rowSpan={2}>
                          {f.factoryId}
                        </td>
                        <td className="pr-2 py-1 text-gray-400">名目</td>
                        <td className="pr-2 py-1">{formatTons(f.nominal.commonProcessing)}</td>
                        <td className="pr-2 py-1">{formatTons(f.nominal.hoso)}</td>
                        <td className="pr-2 py-1">{formatTons(f.nominal.pd)}</td>
                        <td className="pr-2 py-1">{formatTons(f.nominal.vap)}</td>
                        <td className="pr-2 py-1">{formatTons(f.nominal.freezingPackaging)}</td>
                      </tr>
                      <tr className="border-t border-gray-800/60">
                        <td className="pr-2 py-1 text-gray-400">実効</td>
                        <td className="pr-2 py-1">{formatTons(f.effective.commonProcessing)}</td>
                        <td className="pr-2 py-1">{formatTons(f.effective.hoso)}</td>
                        <td className="pr-2 py-1">{formatTons(f.effective.pd)}</td>
                        <td className="pr-2 py-1">{formatTons(f.effective.vap)}</td>
                        <td className="pr-2 py-1">{formatTons(f.effective.freezingPackaging)}</td>
                      </tr>
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* ② Worker1人あたり生産力 */}
          <div>
            <h4 className="text-xs font-semibold text-gray-300 mb-1">② 正社員Worker 1人あたりの生産力（商品別）</h4>
            <p className="text-[11px] text-gray-500 mb-1">
              1人あたりトン/四半期 = 基礎効率(6t、production/parameters.ts) × 出勤率 × 商品別技能水準。
              残業・設備能力の上限は加味しない参考値（実際の生産はこれと設備能力の両方で制約される）。
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-gray-400 text-left">
                    <th className="pr-2 py-1">工場</th>
                    <th className="pr-2 py-1">商品</th>
                    <th className="pr-2 py-1">技能水準</th>
                    <th className="pr-2 py-1">出勤率</th>
                    <th className="pr-2 py-1">1人あたり生産力</th>
                  </tr>
                </thead>
                <tbody>
                  {laborProductivity.map((e) => (
                    <tr key={`${e.factoryId}-${e.product}`} className="border-t border-gray-700/60">
                      <td className="pr-2 py-1">{e.factoryId}</td>
                      <td className="pr-2 py-1">{PRODUCT_LABEL[e.product] ?? e.product}</td>
                      <td className="pr-2 py-1">{Math.round(e.skillLevel * 100)}%</td>
                      <td className="pr-2 py-1">{Math.round(e.attendanceRate * 100)}%</td>
                      <td className="pr-2 py-1">{formatTons(e.tonsPerRegularWorker)}/人</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* ③ 営業人員のカバー範囲 */}
          <div>
            <h4 className="text-xs font-semibold text-gray-300 mb-1">③ 現在の営業人数と処理能力・カバレッジ目安</h4>
            <p className="text-[11px] text-gray-500">
              現在の営業人員総数: <span className="font-medium text-gray-200">{salesForceCapacity.headcountTotal}人</span>。
              現在の人員による処理能力（成約量の上限の一因子）: <span className="font-medium text-gray-200">{formatTons(salesForceCapacity.currentProcessingCapacityTons)}</span>相当、
              市場カバレッジ: <span className="font-medium text-gray-200">{Math.round(salesForceCapacity.coverageScore * 100)}%</span>。
              もう1人増やした場合の限界増分は約{formatTons(salesForceCapacity.marginalCapacityTonsForOneMoreHeadcount)}
              （逓減曲線のため、増員するほど1人あたりの追加効果は小さくなる）。
            </p>
          </div>

          {/* ④ 工場増設ルール（リンク） */}
          <div>
            <h4 className="text-xs font-semibold text-gray-300 mb-1">④ 工場増設の基本ルール</h4>
            <p className="text-[11px] text-gray-500">
              設備投資（新規案件の提案・支払スケジュール・完成後の固定資産振替）のロジックは
              <code className="text-gray-400"> app/lib/v2/capex/** </code>
              （特に <code className="text-gray-400">capex/projectLifecycle.ts</code>・<code className="text-gray-400">capex/parameters.ts</code>）を参照。
            </p>
          </div>

          {/* ⑤ 財務ルール（リンク＋実データ） */}
          <div>
            <h4 className="text-xs font-semibold text-gray-300 mb-1">⑤ 財務ルール・現行のAR/AP決済サイト・借入返済スケジュール</h4>
            <p className="text-[11px] text-gray-500 mb-1">
              資金繰り・与信・利息計算の詳細ロジックは <code className="text-gray-400">app/lib/v2/financing/**</code>
              （<code className="text-gray-400">financing/bankUnderwriting.ts</code>・<code className="text-gray-400">financing/liquidityClose.ts</code>）を参照。
            </p>
            <ul className="text-[11px] text-gray-300 space-y-1 mb-2">
              <li>
                売掛金（AR）決済サイト:{" "}
                {receivableLag === null
                  ? "現在、売掛金がありません。"
                  : receivableLag.allSame
                    ? `概ね発生から${receivableLag.minQuarters}四半期後に決済（${receivableLag.count}件すべて共通）。`
                    : `発生から${receivableLag.minQuarters}〜${receivableLag.maxQuarters}四半期後（${receivableLag.count}件、決済サイトが一律ではありません）。`}
              </li>
              <li>
                買掛金（AP）決済サイト:{" "}
                {payableLag === null
                  ? "現在、買掛金がありません。"
                  : payableLag.allSame
                    ? `概ね発生から${payableLag.minQuarters}四半期後に決済（${payableLag.count}件すべて共通）。`
                    : `発生から${payableLag.minQuarters}〜${payableLag.maxQuarters}四半期後（${payableLag.count}件、決済サイトが一律ではありません）。`}
              </li>
            </ul>
            {activeLoans.length === 0 ? (
              <p className="text-[11px] text-gray-500">現在、返済中の借入はありません。</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="text-gray-400 text-left">
                      <th className="pr-2 py-1">種別</th>
                      <th className="pr-2 py-1">元本残高</th>
                      <th className="pr-2 py-1">年利率</th>
                      <th className="pr-2 py-1">返済方式</th>
                      <th className="pr-2 py-1">満期</th>
                      <th className="pr-2 py-1">1回あたり元本返済額</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeLoans.map((l) => (
                      <tr key={l.loanId} className="border-t border-gray-700/60">
                        <td className="pr-2 py-1">{l.loanType}</td>
                        <td className="pr-2 py-1">{formatUsd(l.currentPrincipalUsd)}</td>
                        <td className="pr-2 py-1">{(l.annualInterestRate * 100).toFixed(2)}%</td>
                        <td className="pr-2 py-1">{l.repaymentMethod === "equalPrincipal" ? "元金均等" : "満期一括"}</td>
                        <td className="pr-2 py-1">{periodLabel(l.maturityPeriod)}</td>
                        <td className="pr-2 py-1">
                          {l.repaymentMethod === "equalPrincipal" ? formatUsd(l.equalPrincipalInstallmentUsd) : "（満期に一括）"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ⑥ 原料在庫の利用可能時期 */}
          <div>
            <h4 className="text-xs font-semibold text-gray-300 mb-1">⑥ 原料在庫の利用可能時期（輸送中・養殖中を含む）</h4>
            {rawMaterialGroups.length === 0 ? (
              <p className="text-[11px] text-gray-500">現在、原料在庫はありません。</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="text-gray-400 text-left">
                      <th className="pr-2 py-1">利用可能開始</th>
                      <th className="pr-2 py-1">数量</th>
                      <th className="pr-2 py-1">ロット数</th>
                      <th className="pr-2 py-1">状態</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rawMaterialGroups.map((g) => (
                      <tr key={g.availableFromPeriod} className="border-t border-gray-700/60">
                        <td className="pr-2 py-1">{g.availableFromLabel}</td>
                        <td className="pr-2 py-1">{formatTons(g.quantityTons)}</td>
                        <td className="pr-2 py-1">{g.lotCount}</td>
                        <td className="pr-2 py-1">{g.statuses.join(" / ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </CollapsibleSection>
    </div>
  );
}
