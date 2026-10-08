// ShrimpX V2 — INT-1 §2A: 意思決定画面で商品別受注残を確認できるようにする
//
// 【これは情報の欠落ではなく導線の問題だった（調査結果）】
// 市場×商品別の受注残テーブルは既に OpeningCompanyStatePanel（Decision→情報 画面）に
// 存在していた。しかし販売数量・生産数量を決める SALES / PRODUCTION 画面からは
// 情報画面へ移動しないと見られず、意思決定の最中に参照できなかった。
// さらに既存テーブルは「未履行数量」と「最短納期」までで、納期超過の分離が無かった。
//
// 【新しい計算を作らない】集計は aiManagementMeeting/backlogSemantics.ts の
// computeBacklogSemantics（既存のSSoT）をそのまま使う。このモジュールは
// SalesContract.dueDate と outstandingQuantity だけから Healthy Forward /
// Due This Turn / Overdue を分離し、server-side で status を確定している。
// ここでは渡された値を並べるだけで、しきい値判定・再分類・警告生成を一切行わない。
//
// 【受注残と完成品在庫を混同させない】このパネルは受注残だけを扱う。
// 在庫で充足できるかどうかの判断はプレイヤーが行うものであり、
// 「在庫や納期で充足できる分を無視した警告」はここで作らない。

import { BacklogDueStatus, BacklogSemantics } from "../../../lib/v2/companyLab/aiManagementMeeting/backlogSemantics";
import { DEMAND_MARKET_NAMES } from "../../industry-lab/components/chartColors";
import CollapsibleSection from "./CollapsibleSection";

const PRODUCT_LABEL: Readonly<Record<string, string>> = { hoso: "HOSO", pd: "PD", vap: "VAP" };

/** status は server-side で確定済み。ここでは文字へ写すだけで再判定しない。 */
const STATUS_LABEL: Readonly<Record<BacklogDueStatus, string>> = {
  OVERDUE: "納期超過",
  DUE_THIS_TURN: "当期納期",
  FUTURE_DUE: "将来納期",
  MIXED: "混在",
};

const STATUS_TONE: Readonly<Record<BacklogDueStatus, string>> = {
  OVERDUE: "text-amber-300",
  DUE_THIS_TURN: "text-sky-300",
  FUTURE_DUE: "text-gray-400",
  MIXED: "text-gray-300",
};

const tons = (n: number): string => `${Math.round(n).toLocaleString()}t`;

export default function BacklogByProductPanel(props: {
  readonly backlog: BacklogSemantics;
  /** 見出しに添える補足（画面ごとに「販売計画の参考」「生産計画の参考」等を出す）。 */
  readonly context: string;
  readonly testIdPrefix: string;
}) {
  const { backlog, context, testIdPrefix } = props;
  return (
    <CollapsibleSection
      title="受注残（未履行の確定受注）— 商品別"
      description={`${context} 受注残は「売る約束をして、まだ届けていない量」です。完成品在庫とは別の量です。納期が来ていない分（将来納期）は、存在するだけでは納期遅延ではありません。`}
      tone="info"
      testId={`${testIdPrefix}-backlog-section`}
      summaryRight={`受注残 ${tons(backlog.totalTons)}（うち納期超過 ${tons(backlog.overdueTons)}）`}
    >
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]" data-testid={`${testIdPrefix}-backlog-by-product`}>
          <thead>
            <tr className="text-left text-gray-400">
              <th className="pr-3 py-1">商品</th>
              <th className="pr-3 py-1 text-right">受注残 合計</th>
              <th className="pr-3 py-1 text-right">納期超過</th>
              <th className="pr-3 py-1 text-right">当期納期</th>
              <th className="pr-3 py-1 text-right">将来納期</th>
              <th className="pr-3 py-1">状態</th>
            </tr>
          </thead>
          <tbody>
            {backlog.byProduct.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-1 text-gray-500" data-testid={`${testIdPrefix}-backlog-by-product-empty`}>
                  現在、未履行の確定受注はありません。
                </td>
              </tr>
            ) : (
              backlog.byProduct.map((p) => (
                <tr key={p.product} className="border-t border-gray-700/60" data-testid={`${testIdPrefix}-backlog-product-${p.product}`}>
                  <td className="pr-3 py-1 font-medium">{PRODUCT_LABEL[p.product] ?? p.product}</td>
                  <td className="pr-3 py-1 text-right tabular-nums">{tons(p.totalTons)}</td>
                  <td className="pr-3 py-1 text-right tabular-nums">{tons(p.overdueTons)}</td>
                  <td className="pr-3 py-1 text-right tabular-nums">{tons(p.dueThisTurnTons)}</td>
                  <td className="pr-3 py-1 text-right tabular-nums">{tons(p.healthyForwardTons)}</td>
                  <td className={`pr-3 py-1 ${STATUS_TONE[p.status]}`}>{STATUS_LABEL[p.status]}</td>
                </tr>
              ))
            )}
            {backlog.byProduct.length > 0 ? (
              <tr className="border-t border-gray-600 font-semibold" data-testid={`${testIdPrefix}-backlog-total`}>
                <td className="pr-3 py-1">合計</td>
                <td className="pr-3 py-1 text-right tabular-nums">{tons(backlog.totalTons)}</td>
                <td className="pr-3 py-1 text-right tabular-nums">{tons(backlog.overdueTons)}</td>
                <td className="pr-3 py-1 text-right tabular-nums">{tons(backlog.dueThisTurnTons)}</td>
                <td className="pr-3 py-1 text-right tabular-nums">{tons(backlog.healthyForwardTons)}</td>
                <td className={`pr-3 py-1 ${STATUS_TONE[backlog.status]}`}>{STATUS_LABEL[backlog.status]}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {backlog.byMarketProduct.length > 0 ? (
        <div className="mt-3 overflow-x-auto">
          <h4 className="mb-1 text-xs font-semibold text-gray-300">市場×商品別（受注残の多い順・上位）</h4>
          <table className="w-full text-[11px]" data-testid={`${testIdPrefix}-backlog-by-market-product`}>
            <thead>
              <tr className="text-left text-gray-400">
                <th className="pr-3 py-1">市場</th>
                <th className="pr-3 py-1">商品</th>
                <th className="pr-3 py-1 text-right">受注残</th>
                <th className="pr-3 py-1 text-right">納期超過</th>
                <th className="pr-3 py-1">最短納期</th>
                <th className="pr-3 py-1">状態</th>
              </tr>
            </thead>
            <tbody>
              {backlog.byMarketProduct.map((g) => (
                <tr key={`${g.market}-${g.product}`} className="border-t border-gray-700/60">
                  <td className="pr-3 py-1">
                    {DEMAND_MARKET_NAMES[g.market]}（{g.market}）
                  </td>
                  <td className="pr-3 py-1">{PRODUCT_LABEL[g.product] ?? g.product}</td>
                  <td className="pr-3 py-1 text-right tabular-nums">{tons(g.totalTons)}</td>
                  <td className="pr-3 py-1 text-right tabular-nums">{tons(g.overdueTons)}</td>
                  <td className="pr-3 py-1">{g.earliestDueLabel}</td>
                  <td className={`pr-3 py-1 ${STATUS_TONE[g.status]}`}>{STATUS_LABEL[g.status]}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-[10px] text-gray-500">
            同じ市場×商品の内訳は受注残の多い順の上位のみを表示します。全件は Decision→情報 画面の「受注残（未履行契約）の内訳（市場×商品別）」で確認できます。
          </p>
        </div>
      ) : null}
    </CollapsibleSection>
  );
}
