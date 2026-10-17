"use client";

// ShrimpX V2 — PLAYER-INTRO-1 §5/§6: 「経営の基本目安」の表示
//
// 【計算を持たない】数値はすべて app/lib/v2/player/intro/managementBaselines.ts が
// Engine の関数・パラメータから取り出したものをそのまま並べる。このファイルに
// 係数・単価・式を一切書かない。
//
// 【保証として見せない】各項目には必ず condition（その値が成立する条件）を併記し、
// 成約量・生産量・借入可能額の保証として読めないようにする。
//
// 【同じ能力を重複計上しない】営業能力は1つのプールであり、商品別の数値は
// kind="singleProductOnly" の条件付き値としてのみ表示する。

import { useMemo, useState } from "react";
import type { Product } from "../../../lib/v2/market/types";
import {
  BaselineItem,
  TEMPORARY_WORKER_LIMITATION_NOTE,
  TEMPORARY_WORKER_REALITY_NOTE,
  buildHeadcountChangeRules,
  buildLaborCostBaselines,
  buildSalesBaselines,
  buildWorkerBaselines,
  productLabel,
} from "../../../lib/v2/player/intro/managementBaselines";
import { buildQualityDiscardNote, YIELD_ASSUMPTION_SHORT_NOTE } from "../../../lib/v2/player/intro/yieldAssumption";
import { buildPdMechanizationStatusByFactory } from "../../../lib/v2/companyLab/pdMechanizationState";
import { WORKFORCE_EXPLANATION_TEXT, WORKFORCE_NOT_MODELED_NOTE } from "../../../lib/v2/companyLab/workforce";
import type { PlayerDecisionContext } from "../../../lib/v2/player/decisionContext";

const DASH = "－";

function formatValue(item: BaselineItem): string {
  if (item.value === null || !Number.isFinite(item.value)) return DASH;
  const abs = Math.abs(item.value);
  // 単位が USD のものは整数、比率・係数は小数2桁、数量は小数1桁で丸めて読みやすくする。
  if (item.unit.startsWith("USD")) return `${Math.round(item.value).toLocaleString()} ${item.unit}`;
  if (abs < 10) return `${item.value.toFixed(2)} ${item.unit}`;
  return `${item.value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${item.unit}`;
}

/** 値の性質を、色だけに頼らず文字で示す（§8 アクセシビリティ）。 */
const KIND_LABELS: Readonly<Record<BaselineItem["kind"], string>> = {
  baseParameter: "基礎値",
  currentCondition: "いまの条件での目安",
  singleProductOnly: "その商品だけを扱った場合",
  hardLimit: "上限",
};

function Row({ item }: { readonly item: BaselineItem }) {
  return (
    <div className="border-t border-slate-800 py-2 first:border-t-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-xs text-slate-300">{item.label}</span>
        <span className="font-mono text-sm font-semibold text-slate-100">{formatValue(item)}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        <span className="rounded border border-slate-600 px-1.5 py-0.5 text-[10px] text-slate-300">{KIND_LABELS[item.kind]}</span>
        <span className="text-[11px] leading-snug text-slate-400">{item.condition}</span>
      </div>
    </div>
  );
}

function Section({
  title,
  lead,
  children,
  testId,
}: {
  readonly title: string;
  readonly lead?: string;
  readonly children: React.ReactNode;
  readonly testId?: string;
}) {
  return (
    <section className="rounded-lg border border-slate-700 bg-slate-900/50 p-3" data-testid={testId}>
      <h3 className="text-sm font-semibold text-slate-100">{title}</h3>
      {lead ? <p className="mt-1 text-[11px] leading-relaxed text-slate-400">{lead}</p> : null}
      <div className="mt-2">{children}</div>
    </section>
  );
}

export interface ManagementBaselinesProps {
  readonly context: PlayerDecisionContext;
}

/**
 * 営業・Worker・人件費の目安を、Engine の値から組み立てる。
 * 画面コンポーネントが複数（導入・意思決定中のヒント）あるため、組み立ては
 * このフックに1本化して二重計算を避ける。
 */
function useBaselines(context: PlayerDecisionContext) {
  return useMemo(() => {
    const own = context.ownState;
    const salesHeadcount = own.salesForceHiringState.headcount;
    // 展開市場数は、公開情報が持つ市場別需要の市場数から数える
    // （companyWideWithFragmentation モデルのときだけ効く。現行の companyWide では
    //  罰則係数が無いため値に影響しない）。取得できない場合は 1 として扱い、
    //  能力を水増ししない方向へ倒す。
    const marketCount = Math.max(1, new Set(context.marketView.cells.map((c) => c.market)).size);

    const regularHeadcount = own.workforceState.factories.reduce((sum, f) => sum + f.regularHeadcount, 0);

    // 【工場別のPD省人化条件】Engine と同じ関数だけを使って工場別の実効PD係数を求める。
    // 稼働率は Player レスポンスが持つ pdUtilizationByFactory から同じ形へ戻す
    // （新しい推定はしない。エントリが無い工場は Engine の既定値になる）。
    const pdStatusByFactory = buildPdMechanizationStatusByFactory(
      // CompanyOwnState は自社ぶんの CompanyCapexState しか持たないため、
      // Engine 関数が要求する CapexState の形（会社の配列）へ包み直すだけ。
      { companies: [own.capexState] },
      { entries: own.pdUtilizationByFactory.map((e) => ({ ...e, companyId: own.companyId })) },
      context.period
    );

    const perFactoryWorker = own.workforceState.factories.map((f) => {
      const override = pdStatusByFactory.get(f.factoryId)?.effectivePdCoefficient;
      return {
        factoryId: f.factoryId,
        regularHeadcount: f.regularHeadcount,
        hasPdMechanization: override !== undefined,
        baselines: buildWorkerBaselines({
          coefficientOverrideByProduct: override !== undefined ? { pd: override } : undefined,
          factoryLabel: override !== undefined ? f.factoryId : undefined,
        }),
      };
    });

    return {
      sales: buildSalesBaselines({ currentSalesHeadcount: salesHeadcount, marketCount }),
      salesHeadcount,
      worker: buildWorkerBaselines({}),
      perFactoryWorker,
      headcountRules: buildHeadcountChangeRules({
        currentSalesHeadcount: salesHeadcount,
        financeParams: context.costProjection.financeParameters,
      }),
      laborCost: buildLaborCostBaselines({
        currentRegularHeadcount: regularHeadcount,
        // 臨時Workerは当期の意思決定で決まるため、現在人数としては0から試算する。
        currentTemporaryHeadcount: 0,
        financeParams: context.costProjection.financeParameters,
        // costProjection.financeParameters は当Turnの費用指数を適用済みの実効値である。
        isIndexApplied: true,
      }),
      regularHeadcount,
    };
  }, [context]);
}

/**
 * 【§6】意思決定中に参照する短いヒント。
 * 画面（SALES / WORKER / PRODUCTION / PROCUREMENT）ごとに、その場で必要な
 * 1〜3行だけを出し、詳細は「経営の基本目安」へ送る。
 */
export function BaselineHint({
  context,
  screen,
  onOpenDetails,
}: {
  readonly context: PlayerDecisionContext;
  readonly screen: "sales" | "worker" | "production" | "procurement" | "info" | "investment" | "finance";
  readonly onOpenDetails: () => void;
}) {
  const b = useBaselines(context);
  const lines: string[] = [];

  if (screen === "sales") {
    const perHead = (p: Product) => b.sales.byProduct.find((r) => r.product === p)?.perHeadTons.value;
    lines.push(
      `営業1人あたりの目安は HOSO ${fmt0(perHead("hoso"))}t / PD ${fmt0(perHead("pd"))}t / VAP ${fmt0(perHead("vap"))}t（いずれも／人／四半期）です。`
    );
    lines.push("ただし3つを足して同時には売れません。同じ営業人員がHOSO・PD・VAPを分け合うため、それぞれの目安に対する割合の合計が100%以内に収まるかで考えてください。");
    lines.push("営業人員の増減は次の四半期から反映されます。実際の成約量は価格・需要・競争にも左右されるため、この目安は成約の保証ではありません。");
    } else if (screen === "worker") {
    const hoso = b.worker.byProduct.find((r) => r.product === "hoso")?.regularPerHead.value;
    const pd = b.worker.byProduct.find((r) => r.product === "pd")?.regularPerHead.value;
    const vap = b.worker.byProduct.find((r) => r.product === "vap")?.regularPerHead.value;
    lines.push(
      `常用Worker 1人あたりの生産量の目安（残業なし・その商品だけを担当した場合）は HOSO ${fmt(hoso)}t / PD ${fmt(pd)}t / VAP ${fmt(vap)}t（いずれも／人／四半期）です。`
    );
    const reg = b.laborCost.workerTypeComparison.find((c) => c.workerType === "regular");
    const tmp = b.laborCost.workerTypeComparison.find((c) => c.workerType === "temporary");
    lines.push(
      `常用Worker 1人の四半期費用は ${fmt0(reg?.costPerHead.value)} USD、臨時Workerは ${fmt0(tmp?.costPerHead.value)} USD です（このTurnに適用される値）。`
    );
    lines.push(
      `ただし1トンあたりで見ると 常用 ${fmt0(reg?.costPerTon.value)} USD／t に対して 臨時 ${fmt0(tmp?.costPerTon.value)} USD／t です。臨時は単価が安いぶん1人あたりの生産量も少ないため、トンあたりでは割高になります。`
    );
    lines.push("Workerの増減はこの四半期からすぐ反映されます。ただし設備や原料が足りなければ、人数を増やしても生産量は増えません。");
    lines.push(TEMPORARY_WORKER_LIMITATION_NOTE);
  } else if (screen === "production") {
    lines.push(YIELD_ASSUMPTION_SHORT_NOTE);
    lines.push("生産できる量は、原料・工場共通工程・冷凍/包装・商品別設備・労働のうち、いちばん小さいものが上限になります。人数×1人あたり能力がそのまま生産量になるわけではありません。");
  } else if (screen === "procurement") {
    lines.push(YIELD_ASSUMPTION_SHORT_NOTE);
    lines.push("原料は、発注した四半期にそのまま使えるとはかぎりません。支払いと到着・利用開始の時期がずれるため、現金の動きと数量の動きを別に見てください。");
  }

  if (lines.length === 0) return null;

  return (
    <div
      className="mb-2 rounded-lg border border-sky-800/60 bg-sky-950/20 p-2.5"
      data-testid={`play-baseline-hint-${screen}`}
      aria-label="この画面で役に立つ目安"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] font-semibold text-sky-200">この画面で役に立つ目安</span>
        <button
          type="button"
          onClick={onOpenDetails}
          className="rounded border border-sky-700 px-2 py-0.5 text-[11px] text-sky-200 hover:bg-sky-900/40"
          data-testid={`play-baseline-hint-open-${screen}`}
        >
          経営の基本目安をひらく
        </button>
      </div>
      <ul className="mt-1.5 space-y-1">
        {lines.map((line) => (
          <li key={line} className="text-[11px] leading-relaxed text-slate-300">
            ・{line}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 整数で読みやすく（人数・トン・USD の見出し用）。 */
function fmt0(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? DASH : Math.round(v).toLocaleString();
}

function fmt(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? DASH : v.toFixed(2);
}

/** 【§5・§6】詳細版。導入からも、意思決定中からも同じものを開く。 */
export function ManagementBaselinesPanel({ context }: ManagementBaselinesProps) {
  const b = useBaselines(context);
  const [showPerFactory, setShowPerFactory] = useState(false);
  const factoriesWithMechanization = b.perFactoryWorker.filter((f) => f.hasPdMechanization);

  return (
    <div className="space-y-3" data-testid="play-management-baselines">
      <p className="text-[11px] leading-relaxed text-amber-200">
        ここに出ている数字は<strong>目安</strong>です。成約量・生産量・借入可能額を保証するものではありません。
        実際の結果は、価格・需要・競争・設備・原料・資金の状況で変わります。
      </p>

      {/* --- A. 営業 --- */}
      <Section
        title="営業：1人あたり何トン売れるか"
        testId="play-baselines-sales"
        lead={
          `いまの営業人員は ${b.sales.currentSalesHeadcount.toLocaleString()}人です。` +
          "営業人員は市場ごとに配員します（商品ごとに別の人数を割り当てる仕組みではありません）。"
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[320px] text-left text-[11px]">
            <caption className="pb-1 text-left text-[11px] text-slate-400">
              その商品<strong>だけ</strong>を売った場合の目安
            </caption>
            <thead>
              <tr className="border-b border-slate-700 text-slate-400">
                <th scope="col" className="py-1 pr-2 font-medium">商品</th>
                <th scope="col" className="py-1 pr-2 text-right font-medium">営業1人あたり</th>
                <th scope="col" className="py-1 pr-2 text-right font-medium">1人増やすと</th>
                <th scope="col" className="py-1 text-right font-medium">会社全体</th>
              </tr>
            </thead>
            <tbody>
              {b.sales.byProduct.map((row) => (
                <tr key={row.product} className="border-b border-slate-800">
                  <th scope="row" className="py-1.5 pr-2 font-normal text-slate-200">
                    {productLabel(row.product)}
                  </th>
                  <td className="py-1.5 pr-2 text-right font-mono text-slate-100">{fmt0(row.perHeadTons.value)} t</td>
                  <td className="py-1.5 pr-2 text-right font-mono text-slate-300">+{fmt0(row.addedPerHeadTons.value)} t</td>
                  <td className="py-1.5 text-right font-mono text-slate-100">{fmt0(row.companyTotalTons.value)} t</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-1 text-[11px] text-slate-400">単位はいずれも t／四半期（「営業1人あたり」「1人増やすと」は 1人あたり）です。</p>

        <p className="mt-2 rounded border border-amber-700/60 bg-amber-950/20 p-2 text-[11px] font-semibold leading-relaxed text-amber-200">
          この3つを足して同時に売ることはできません。HOSO担当・PD担当と人を分けているわけではなく、同じ営業人員が3商品を分け合います。
        </p>
        <p className="mt-1.5 text-[11px] leading-relaxed text-slate-300">{b.sales.mixedSalesRule}</p>

        <div className="mt-2 rounded border border-slate-700 bg-slate-950/40 p-2">
          <p className="text-[11px] font-semibold text-slate-200">商品ごとの営業の手間</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-slate-400">
            同じ1トンを売る手間を HOSO を1とすると、
            {b.sales.byProduct.map((r) => ` ${productLabel(r.product)} ${r.effortRelativeToHoso}`).join(" ：")}。
            VAPは手間がかかるぶん、同じ人数で扱える数量が少なくなります。
          </p>
        </div>

        <div className="mt-2">
          <Row item={b.sales.baselineTonsAtZeroHeadcount} />
        </div>

        <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
          すでにある受注残への対応も、新しい販売活動と同じ営業人員が担います。受注残が多い四半期は、新規の販売に回せる余力が小さくなります。
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
          実際に売れる量は、価格・需要・競争の状況でも変わります。ここの数字は「営業人員の面から見た上限の目安」であって、成約の保証ではありません。
        </p>
      </Section>

      {/* --- B. Worker --- */}
      <Section
        title="Worker：一人あたりどれだけ作れるか"
        testId="play-baselines-worker"
        lead="残業なしの基準労働時間で、その商品だけを担当した場合の1人あたり生産量です。常用と臨時で能力が違います。"
      >
        {b.worker.byProduct.map((row) => (
          <div key={row.product} className="border-t border-slate-800 py-2 first:border-t-0">
            <p className="text-xs font-semibold text-slate-200">
              {productLabel(row.product)}（労働集約度 {row.laborIntensityCoefficient}）
            </p>
            <Row item={row.regularPerHead} />
            <Row item={row.temporaryPerHead} />
          </div>
        ))}
        <Row item={b.worker.overtimeRateCap} />
        <Row item={b.worker.overtimeEfficiencyFactor} />
        <p className="mt-2 text-[11px] leading-relaxed text-amber-200">
          労働面で作れても、設備や原料が足りなければ生産できません。生産量の上限は、原料・工場共通工程・冷凍/包装・商品別設備・労働の
          <strong>いちばん小さいもの</strong>で決まります。
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
          同じ工場のWorkerは、HOSO・PD・VAPで共通の人員プールです。複数商品を同時に作る場合、人員も労働時間も分け合います。
        </p>

        {b.perFactoryWorker.length > 1 || factoriesWithMechanization.length > 0 ? (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setShowPerFactory((v) => !v)}
              aria-expanded={showPerFactory}
              className="rounded border border-slate-600 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-800"
              data-testid="play-baselines-worker-per-factory-toggle"
            >
              {showPerFactory ? "工場別の条件を閉じる" : `工場別の条件を見る（${b.perFactoryWorker.length}工場）`}
            </button>
            {showPerFactory ? (
              <div className="mt-2 space-y-2" data-testid="play-baselines-worker-per-factory">
                {b.perFactoryWorker.map((f) => (
                  <div key={f.factoryId} className="rounded border border-slate-700 bg-slate-950/40 p-2">
                    <p className="text-[11px] font-semibold text-slate-200">
                      {f.factoryId}（常用 {f.regularHeadcount.toLocaleString()}人）
                      {f.hasPdMechanization ? " ／ PD省人化投資が稼働中" : ""}
                    </p>
                    {f.baselines.byProduct.map((row) => (
                      <Row key={row.product} item={row.regularPerHead} />
                    ))}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </Section>

      {/* --- C. 増減員 --- */}
      <Section title="人を増やす・減らすとどうなるか" testId="play-baselines-headcount">
        {b.headcountRules.map((rule) => (
          <div key={rule.subject} className="border-t border-slate-800 py-2 first:border-t-0">
            <p className="text-xs font-semibold text-slate-200">{rule.label}</p>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-300">
              <span className="text-slate-400">反映の時期：</span>
              {rule.effectiveTiming}
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-300">
              <span className="text-slate-400">減らすとき：</span>
              {rule.layoffRule}
            </p>
            {rule.hireLimitPerQuarter ? <Row item={rule.hireLimitPerQuarter} /> : null}
            {rule.oneTimeCost ? <Row item={rule.oneTimeCost} /> : null}
            <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{rule.notModeled}</p>
          </div>
        ))}
        <p className="mt-2 text-[11px] leading-relaxed text-amber-200">
          人数を減らせば必ず利益が良くなる、ということはありません。能力に余裕があるときは費用が減りますが、
          足りなくなると生産・販売・納品が間に合わなくなります。
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-400">{WORKFORCE_EXPLANATION_TEXT}</p>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{WORKFORCE_NOT_MODELED_NOTE}</p>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
          営業の「市場への配員」と「営業人員の採用」は別の操作です。配員は今いる人数の振り分け、採用は人数そのものを増やすことです。
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
          原料・設備・需要のどれかが先に足りなくなっている（ボトルネックになっている）ときは、人を増やしても成果は増えません。
        </p>
      </Section>

      {/* --- D. 人件費 --- */}
      <Section
        title="人件費の目安"
        testId="play-baselines-labor-cost"
        lead="下の単価は、このTurnに実際に適用される値です（シナリオの費用指数を適用済み。指数そのものや将来の値は表示しません）。"
      >
        {/* 常用 と 臨時 は「単価」だけでは比べられないため、1トンあたりで並べる。 */}
        <div className="overflow-x-auto rounded border border-slate-700 bg-slate-950/40 p-2">
          <p className="text-[11px] font-semibold text-slate-200">常用Worker と 臨時Worker の違い（お金の面）</p>
          <table className="mt-1.5 w-full min-w-[300px] text-left text-[11px]">
            <thead>
              <tr className="border-b border-slate-700 text-slate-400">
                <th scope="col" className="py-1 pr-2 font-medium">　</th>
                {b.laborCost.workerTypeComparison.map((c) => (
                  <th key={c.workerType} scope="col" className="py-1 pr-2 text-right font-medium text-slate-200">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-slate-800">
                <th scope="row" className="py-1.5 pr-2 font-normal text-slate-300">1人あたり四半期費用</th>
                {b.laborCost.workerTypeComparison.map((c) => (
                  <td key={c.workerType} className="py-1.5 pr-2 text-right font-mono text-slate-100">
                    {fmt0(c.costPerHead.value)} USD
                  </td>
                ))}
              </tr>
              <tr className="border-b border-slate-800">
                <th scope="row" className="py-1.5 pr-2 font-normal text-slate-300">1人あたり生産量（HOSO）</th>
                {b.laborCost.workerTypeComparison.map((c) => (
                  <td key={c.workerType} className="py-1.5 pr-2 text-right font-mono text-slate-100">
                    {fmt(c.tonsPerHead.value)} t
                  </td>
                ))}
              </tr>
              <tr className="border-b border-slate-800 bg-slate-900/60">
                <th scope="row" className="py-1.5 pr-2 font-semibold text-amber-200">1トンあたりの人件費</th>
                {b.laborCost.workerTypeComparison.map((c) => (
                  <td key={c.workerType} className="py-1.5 pr-2 text-right font-mono font-semibold text-amber-200">
                    {fmt0(c.costPerTon.value)} USD／t
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
          <p className="mt-1.5 text-[11px] leading-relaxed text-amber-200">
            臨時Workerは1人あたりの単価は安いものの、1人あたりの生産量も少ないため、
            <strong>1トンあたりで見ると常用より割高</strong>になります。単価だけで判断しないでください。
          </p>
          <p className="mt-1 text-[11px] text-slate-500">HOSO を担当した場合・残業なしの基準値どうしの比較です。</p>
          {/* 【このバージョンの制約】受講者が自分で気づいたときに説明と食い違わないよう、
              臨時雇用の意味が薄いという事実をそのまま書く。 */}
          <div
            className="mt-2 rounded border border-amber-700/60 bg-amber-950/20 p-2"
            data-testid="play-baselines-temporary-worker-note"
          >
            <p className="text-[11px] font-semibold leading-relaxed text-amber-200">{TEMPORARY_WORKER_LIMITATION_NOTE}</p>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-300">{TEMPORARY_WORKER_REALITY_NOTE}</p>
          </div>
          {b.laborCost.workerTypeComparison.map((c) => (
            <div key={c.workerType} className="mt-1.5">
              <p className="text-[11px] font-semibold text-slate-200">{c.label}</p>
              <ul className="mt-0.5 space-y-0.5">
                {c.notes.map((n) => (
                  <li key={n} className="text-[11px] leading-relaxed text-slate-400">
                    ・{n}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <Row item={b.laborCost.regularWorkerPerHead} />
        <Row item={b.laborCost.temporaryWorkerPerHead} />
        <Row item={b.laborCost.overtimePremiumFactor} />
        <Row item={b.laborCost.salesForcePerHead} />
        <Row item={b.laborCost.procurementPerHead} />
        <div className="mt-2 rounded border border-slate-700 bg-slate-950/40 p-2">
          <p className="text-[11px] font-semibold text-slate-200">人数に関係なく発生する費用（一人あたり人件費には含めません）</p>
          <div className="mt-1">
            {b.laborCost.headcountIndependentFixed.map((item) => (
              <Row key={item.label} item={item} />
            ))}
          </div>
        </div>
        <div className="mt-2 rounded border border-slate-700 bg-slate-950/40 p-2">
          <p className="text-[11px] font-semibold text-slate-200">いまの人数での四半期人件費の試算</p>
          <p className="mt-1 font-mono text-sm text-slate-100">
            {Math.round(b.laborCost.currentQuarterEstimate.totalCostUsd).toLocaleString()} USD／四半期
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
            常用Worker {b.regularHeadcount.toLocaleString()}人ぶんです。
            <strong>残業費は含みません</strong>（残業率は四半期の実績が確定するまで決まらないためです）。
            臨時Workerはこの四半期の意思決定で決めるため、ここでは0人として計算しています。
          </p>
        </div>
      </Section>

      {/* --- E. そのほか --- */}
      <Section title="そのほか、計画のときに気をつけること" testId="play-baselines-other">
        <ul className="space-y-1.5 text-[11px] leading-relaxed text-slate-300">
          <li>・{YIELD_ASSUMPTION_SHORT_NOTE}</li>
          <li>・{buildQualityDiscardNote()}</li>
          <li>・原料の「発注」「支払い」「到着して使えるようになる時期」はそれぞれ別です。現在の在庫と入荷予定は Inventory タブで確認してください。</li>
          <li>・売った代金がすぐ現金になるとはかぎりません。売上と現金回収の時期は Overview タブの前Turnのふりかえりで確認できます。</li>
          <li>・設備投資は、支払いの時期・工期・稼働を始める時期・能力が出そろう時期がそれぞれずれます。投資の画面に出ている工期をそのまま見てください。</li>
          <li>・借入は現金と負債の両方を増やします。売上ではありません。返済の元本と利息は扱いが違います（元本は負債が減るだけ、利息は費用になります）。</li>
          <li>・配当は FINANCE の画面で入力します。年度末（Q4）には、管理者が指定した配当性向にもとづく年度の精算が行われることがあります。</li>
        </ul>
      </Section>
    </div>
  );
}
