// ShrimpX V2 — 会社経営統合テスト環境（Phase 6.2） 意思決定編集パネル
//
// プレイヤー操作会社1社ぶんの当期意思決定（販売計画・国内原料買付・輸入・養殖・
// 生産計画・ワーカー配置）を編集する。初期値は generateAutoPolicyDecision の
// 出力（decisionDraft.tsのbuildInitialDraftで網羅グリッドへ変換したもの）。
// 数量・人数の負値・NaNは入力時点で0へ丸める（ハードエラー防止）。能力・在庫・
// 未履行残高などの参考情報を隣に表示し、明らかな入力ミス（過大な希望量等）は
// 警告表示のみ行い、送信はブロックしない（ソフト警告）。計算ロジックは
// 一切持たない（表示・編集のみ）。

import { unwrapUnit } from "../../../lib/v2/core/units";
import { CompanyFixture, CompanyOwnState } from "../../../lib/v2/companyLab";
import { formatHosoEqTons } from "../../../lib/v2/industryLab/ui/formatters";
import { CompanyDecisionDraft } from "../decisionDraft";

interface DecisionEditorProps {
  readonly fixture: CompanyFixture;
  readonly ownState: CompanyOwnState;
  readonly draft: CompanyDecisionDraft;
  readonly onChange: (next: CompanyDecisionDraft) => void;
  readonly disabled: boolean;
}

function toSafeNumber(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function toSafeRatioNumber(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function NumberCell(props: { readonly value: number; readonly onChange: (n: number) => void; readonly disabled: boolean; readonly step?: number; readonly warn?: boolean }) {
  return (
    <input
      type="number"
      min={0}
      step={props.step ?? 1}
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => props.onChange(toSafeNumber(e.target.value))}
      className={`w-24 bg-gray-700 rounded px-2 py-1 text-sm text-gray-100 disabled:opacity-50 ${props.warn ? "ring-1 ring-amber-500" : ""}`}
    />
  );
}

function RatioCell(props: { readonly value: number; readonly onChange: (n: number) => void; readonly disabled: boolean }) {
  return (
    <input
      type="number"
      min={0}
      max={1}
      step={0.05}
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => props.onChange(toSafeRatioNumber(e.target.value))}
      className="w-20 bg-gray-700 rounded px-2 py-1 text-sm text-gray-100 disabled:opacity-50"
    />
  );
}

function PriceAdjustmentCell(props: { readonly value: number; readonly onChange: (n: number) => void; readonly disabled: boolean }) {
  return (
    <input
      type="number"
      step={0.01}
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => {
        const n = Number(e.target.value);
        props.onChange(Number.isFinite(n) ? n : 0);
      }}
      className="w-24 bg-gray-700 rounded px-2 py-1 text-sm text-gray-100 disabled:opacity-50"
    />
  );
}

export default function DecisionEditor(props: DecisionEditorProps) {
  const { fixture, ownState, draft, onChange, disabled } = props;

  const rawMaterialInventory = ownState.rawMaterialLots
    .filter((l) => l.status === "available")
    .reduce((sum, l) => sum + unwrapUnit(l.remainingQuantity), 0);
  const outstandingBacklog = ownState.contracts
    .filter((c) => c.status === "open" || c.status === "partiallyFulfilled" || c.status === "overdue")
    .reduce((sum, c) => sum + unwrapUnit(c.outstandingQuantity), 0);

  const factoryById = new Map(fixture.factories.map((f) => [f.factoryId, f]));

  return (
    <div className="space-y-5">
      <div className="text-xs text-gray-400 bg-gray-900/60 rounded-lg px-3 py-2">
        参考情報: 原料在庫（利用可能） {formatHosoEqTons(rawMaterialInventory)} / 未履行契約残高 {formatHosoEqTons(outstandingBacklog)}
        {disabled && <span className="ml-2 text-amber-400">この四半期はすでに進行済みです。編集内容は次の四半期に反映されます。</span>}
      </div>

      {/* 販売計画 */}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-gray-200">販売計画（市場×商品）</h3>
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs text-gray-300">
            <thead>
              <tr className="text-gray-400 text-left">
                <th className="pr-3 py-1">市場</th>
                <th className="pr-3 py-1">商品</th>
                <th className="pr-3 py-1">販売希望量(t)</th>
                <th className="pr-3 py-1">価格調整($/kg)</th>
                <th className="pr-3 py-1">営業人員</th>
              </tr>
            </thead>
            <tbody>
              {draft.salesPlans.map((row, idx) => (
                <tr key={`${row.market}-${row.product}`} className="border-t border-gray-700/60">
                  <td className="pr-3 py-1">{row.market}</td>
                  <td className="pr-3 py-1 uppercase">{row.product}</td>
                  <td className="pr-3 py-1">
                    <NumberCell
                      value={row.desiredQuantity}
                      disabled={disabled}
                      warn={row.desiredQuantity > fixture.salesForceHeadcountTotal * 500}
                      onChange={(n) => {
                        const next = [...draft.salesPlans];
                        next[idx] = { ...row, desiredQuantity: n };
                        onChange({ ...draft, salesPlans: next });
                      }}
                    />
                  </td>
                  <td className="pr-3 py-1">
                    <PriceAdjustmentCell
                      value={row.priceAdjustmentUsdPerHosoEqKg}
                      disabled={disabled}
                      onChange={(n) => {
                        const next = [...draft.salesPlans];
                        next[idx] = { ...row, priceAdjustmentUsdPerHosoEqKg: n };
                        onChange({ ...draft, salesPlans: next });
                      }}
                    />
                  </td>
                  <td className="pr-3 py-1">
                    <NumberCell
                      value={row.salesForceHeadcount}
                      disabled={disabled}
                      onChange={(n) => {
                        const next = [...draft.salesPlans];
                        next[idx] = { ...row, salesForceHeadcount: Math.round(n) };
                        onChange({ ...draft, salesPlans: next });
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 国内原料買付 */}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-gray-200">国内原料買付</h3>
        <div className="flex flex-wrap gap-4 text-xs text-gray-300">
          <label className="flex flex-col gap-1">
            買付希望量(t)
            <NumberCell
              value={draft.domesticPurchase.desiredQuantity}
              disabled={disabled}
              warn={draft.domesticPurchase.desiredQuantity > 20000}
              onChange={(n) => onChange({ ...draft, domesticPurchase: { ...draft.domesticPurchase, desiredQuantity: n } })}
            />
          </label>
          <label className="flex flex-col gap-1">
            価格調整($/kg)
            <PriceAdjustmentCell
              value={draft.domesticPurchase.priceAdjustmentUsdPerHosoEqKg}
              disabled={disabled}
              onChange={(n) => onChange({ ...draft, domesticPurchase: { ...draft.domesticPurchase, priceAdjustmentUsdPerHosoEqKg: n } })}
            />
          </label>
          <label className="flex flex-col gap-1">
            調達人員
            <NumberCell
              value={draft.domesticPurchase.procurementHeadcount}
              disabled={disabled}
              onChange={(n) => onChange({ ...draft, domesticPurchase: { ...draft.domesticPurchase, procurementHeadcount: Math.round(n) } })}
            />
          </label>
        </div>
      </section>

      {/* 輸入 */}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-gray-200">輸入（原産国別）</h3>
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs text-gray-300">
            <thead>
              <tr className="text-gray-400 text-left">
                <th className="pr-3 py-1">原産国</th>
                <th className="pr-3 py-1">発注量(t)</th>
                <th className="pr-3 py-1">リードタイム(ターン)</th>
              </tr>
            </thead>
            <tbody>
              {draft.importOrders.map((row, idx) => (
                <tr key={row.originCountry} className="border-t border-gray-700/60">
                  <td className="pr-3 py-1">{row.originCountry}</td>
                  <td className="pr-3 py-1">
                    <NumberCell
                      value={row.orderedQuantity}
                      disabled={disabled}
                      onChange={(n) => {
                        const next = [...draft.importOrders];
                        next[idx] = { ...row, orderedQuantity: n };
                        onChange({ ...draft, importOrders: next });
                      }}
                    />
                  </td>
                  <td className="pr-3 py-1">
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={row.leadTimeTurns ?? ""}
                      disabled={disabled}
                      placeholder="標準"
                      onChange={(e) => {
                        const raw = e.target.value;
                        const next = [...draft.importOrders];
                        next[idx] = { ...row, leadTimeTurns: raw === "" ? undefined : Math.max(1, Math.round(Number(raw) || 1)) };
                        onChange({ ...draft, importOrders: next });
                      }}
                      className="w-20 bg-gray-700 rounded px-2 py-1 text-sm text-gray-100 disabled:opacity-50"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 養殖 */}
      {draft.aquacultureStockingPlans.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-gray-200">
            養殖（自社養殖能力上限: {formatHosoEqTons(fixture.aquacultureCapacity)}）
          </h3>
          <div className="flex flex-wrap gap-4 text-xs text-gray-300">
            <label className="flex flex-col gap-1">
              池入れ予定量(t)
              <NumberCell
                value={draft.aquacultureStockingPlans[0].plannedStockingQuantity}
                disabled={disabled}
                warn={draft.aquacultureStockingPlans[0].plannedStockingQuantity > unwrapUnit(fixture.aquacultureCapacity)}
                onChange={(n) =>
                  onChange({
                    ...draft,
                    aquacultureStockingPlans: [{ ...draft.aquacultureStockingPlans[0], plannedStockingQuantity: n }],
                  })
                }
              />
            </label>
            <label className="flex flex-col gap-1">
              養殖強度(0〜1)
              <RatioCell
                value={draft.aquacultureStockingPlans[0].aquacultureIntensity}
                disabled={disabled}
                onChange={(n) =>
                  onChange({
                    ...draft,
                    aquacultureStockingPlans: [{ ...draft.aquacultureStockingPlans[0], aquacultureIntensity: n }],
                  })
                }
              />
            </label>
            <label className="flex flex-col gap-1">
              バイオセキュリティ(0〜1)
              <RatioCell
                value={draft.aquacultureStockingPlans[0].bioSecurityLevel}
                disabled={disabled}
                onChange={(n) =>
                  onChange({
                    ...draft,
                    aquacultureStockingPlans: [{ ...draft.aquacultureStockingPlans[0], bioSecurityLevel: n }],
                  })
                }
              />
            </label>
          </div>
        </section>
      )}

      {/* 生産計画 */}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-gray-200">生産計画（工場×商品）</h3>
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs text-gray-300">
            <thead>
              <tr className="text-gray-400 text-left">
                <th className="pr-3 py-1">工場</th>
                <th className="pr-3 py-1">商品</th>
                <th className="pr-3 py-1">商品別能力(t)</th>
                <th className="pr-3 py-1">生産希望量(t)</th>
                <th className="pr-3 py-1">優先度(小=優先)</th>
              </tr>
            </thead>
            <tbody>
              {draft.productionPlans.map((row, idx) => {
                const f = factoryById.get(row.factoryId);
                const capacity = f ? (row.product === "hoso" ? f.hosoCapacity : row.product === "pd" ? f.pdCapacity : f.vapCapacity) : undefined;
                const capacityNum = capacity ? unwrapUnit(capacity) : 0;
                return (
                  <tr key={`${row.factoryId}-${row.product}`} className="border-t border-gray-700/60">
                    <td className="pr-3 py-1">{row.factoryId}</td>
                    <td className="pr-3 py-1 uppercase">{row.product}</td>
                    <td className="pr-3 py-1 text-gray-500">{capacity ? formatHosoEqTons(capacity) : "—"}</td>
                    <td className="pr-3 py-1">
                      <NumberCell
                        value={row.desiredQuantity}
                        disabled={disabled}
                        warn={row.desiredQuantity > capacityNum * 1.5}
                        onChange={(n) => {
                          const next = [...draft.productionPlans];
                          next[idx] = { ...row, desiredQuantity: n };
                          onChange({ ...draft, productionPlans: next });
                        }}
                      />
                    </td>
                    <td className="pr-3 py-1">
                      <NumberCell
                        value={row.priority}
                        disabled={disabled}
                        onChange={(n) => {
                          const next = [...draft.productionPlans];
                          next[idx] = { ...row, priority: Math.round(n) };
                          onChange({ ...draft, productionPlans: next });
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* ワーカー配置 */}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-gray-200">ワーカー配置（工場ごと）</h3>
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs text-gray-300">
            <thead>
              <tr className="text-gray-400 text-left">
                <th className="pr-3 py-1">工場</th>
                <th className="pr-3 py-1">常用人数</th>
                <th className="pr-3 py-1">臨時人数</th>
                <th className="pr-3 py-1">残業率(0〜1)</th>
              </tr>
            </thead>
            <tbody>
              {draft.workerAssignments.map((row, idx) => (
                <tr key={row.factoryId} className="border-t border-gray-700/60">
                  <td className="pr-3 py-1">{row.factoryId}</td>
                  <td className="pr-3 py-1">
                    <NumberCell
                      value={row.regularHeadcount}
                      disabled={disabled}
                      onChange={(n) => {
                        const next = [...draft.workerAssignments];
                        next[idx] = { ...row, regularHeadcount: Math.round(n) };
                        onChange({ ...draft, workerAssignments: next });
                      }}
                    />
                  </td>
                  <td className="pr-3 py-1">
                    <NumberCell
                      value={row.temporaryHeadcount}
                      disabled={disabled}
                      onChange={(n) => {
                        const next = [...draft.workerAssignments];
                        next[idx] = { ...row, temporaryHeadcount: Math.round(n) };
                        onChange({ ...draft, workerAssignments: next });
                      }}
                    />
                  </td>
                  <td className="pr-3 py-1">
                    <RatioCell
                      value={row.overtimeRate}
                      disabled={disabled}
                      onChange={(n) => {
                        const next = [...draft.workerAssignments];
                        next[idx] = { ...row, overtimeRate: n };
                        onChange({ ...draft, workerAssignments: next });
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
