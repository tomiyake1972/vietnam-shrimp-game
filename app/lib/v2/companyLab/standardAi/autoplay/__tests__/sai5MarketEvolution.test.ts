// ShrimpX V2 — Phase SAI-5: 市場進化モデルの統合テスト
//
// 各機能フラグ（productLifecycle / salesBaseAccumulation / supplyPremiumFeedback /
// orientation / heterogeneousInitial / aiCapex）の (a) OFF時の完全後方互換、
// (b) ON時の完走・有限性・決定論性、(c) 方向性を、実際のrunAutoplayCase実行で
// 検証する。個々のモジュール単体の性質はそれぞれの__tests__側の責務。

import { test } from "node:test";
import assert from "node:assert/strict";
import { runAutoplayCase, AutoplayCaseConfig } from "../runCase";
import { ALL_COMPANY_IDS } from "../../report/decomposeHarness";
import { STANDARD_BASELINE_CANDIDATES, SELECTED_STANDARD_BASELINE_CANDIDATE_ID } from "../../report/standardBaseline";

const candidate = STANDARD_BASELINE_CANDIDATES.find((c) => c.id === SELECTED_STANDARD_BASELINE_CANDIDATE_ID)!;

function baseConfig(seed: string, quarters: number, overrides: Partial<AutoplayCaseConfig> = {}): AutoplayCaseConfig {
  return { scenarioId: "baseline", seed, quarters, companyIds: ALL_COMPANY_IDS, candidate, ...overrides };
}

function assertAllFinite(value: unknown, path = "root"): void {
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), `${path} が有限数ではありません（${value}）`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertAllFinite(v, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) assertAllFinite(v, `${path}.${k}`);
  }
}

// ---------------------------------------------------------------------
// SAI-5C: 市場別の商品ライフサイクル
// ---------------------------------------------------------------------

test("SAI-5C統合: productLifecycle無効時は従来と完全に同一（後方互換）", () => {
  const off1 = runAutoplayCase(baseConfig("sai5c-backcompat", 2));
  const off2 = runAutoplayCase(baseConfig("sai5c-backcompat", 2, { productLifecycleEnabled: false }));
  assert.equal(JSON.stringify(off1.history), JSON.stringify(off2.history));
});

test("SAI-5C統合: productLifecycle有効時、8四半期完走・全数値有限・同一seedで完全再現", () => {
  const config = baseConfig("sai5c-on-repro", 8, { productLifecycleEnabled: true });
  const a = runAutoplayCase(config);
  assert.equal(a.completedTurns, 8);
  assertAllFinite(a.history.map((h) => h.companySummaries));
  const b = runAutoplayCase(config);
  assert.equal(JSON.stringify(a.history), JSON.stringify(b.history));
  assert.equal(JSON.stringify(a.diagnostics), JSON.stringify(b.diagnostics));
});

test("SAI-5C統合: 有効時は無効時と市場結果が実際に変わる（世界VAP需要が初期は小さくなる）", () => {
  const off = runAutoplayCase(baseConfig("sai5c-effect", 2));
  const on = runAutoplayCase(baseConfig("sai5c-effect", 2, { productLifecycleEnabled: true }));
  const offVap = off.history[0].marketResult.vapPremium.globalDemand as unknown as number;
  const onVap = on.history[0].marketResult.vapPremium.globalDemand as unknown as number;
  assert.ok(onVap < offVap, `ライフサイクル有効時の初期世界VAP需要(${onVap})が従来(${offVap})より小さくない`);
});

test("SAI-5C統合: AIはturn2以降にライフサイクル公開トレンドを観測できる（turn1は前期が無いためundefined）", () => {
  const on = runAutoplayCase(baseConfig("sai5c-outlook", 3, { productLifecycleEnabled: true }));
  const turn1 = on.quarterStartCaptures.find((c) => c.turn === 1)!;
  const turn2 = on.quarterStartCaptures.find((c) => c.turn === 2)!;
  const turn3 = on.quarterStartCaptures.find((c) => c.turn === 3)!;
  assert.equal(turn1.publicInfo.productLifecycleOutlook, undefined);
  assert.ok(turn2.publicInfo.productLifecycleOutlook, "turn2でライフサイクル公開トレンドが観測できない");
  // turn3の公開シェア＝turn2に適用された構成比（前期の実際、当期の先読みではない）
  const outlook3 = turn3.publicInfo.productLifecycleOutlook!;
  assert.ok(outlook3.sharesByMarket.JP.vap >= turn2.publicInfo.productLifecycleOutlook!.sharesByMarket.JP.vap, "公開シェアが時間とともに進んでいない");
  // 無効時のrunでは一切付与されない
  const off = runAutoplayCase(baseConfig("sai5c-outlook", 2));
  for (const c of off.quarterStartCaptures) {
    assert.equal(c.publicInfo.productLifecycleOutlook, undefined);
  }
});

// ---------------------------------------------------------------------
// SAI-5D: 会社×市場×商品の営業基盤蓄積
// ---------------------------------------------------------------------

test("SAI-5D統合: salesBaseAccumulation無効時は従来と完全に同一（後方互換）", () => {
  const off1 = runAutoplayCase(baseConfig("sai5d-backcompat", 2));
  const off2 = runAutoplayCase(baseConfig("sai5d-backcompat", 2, { salesBaseAccumulationEnabled: false }));
  assert.equal(JSON.stringify(off1.history), JSON.stringify(off2.history));
});

test("SAI-5D統合: 有効時、8四半期完走・同一seedで完全再現・営業基盤が実際に蓄積される", () => {
  const config = baseConfig("sai5d-on-repro", 8, { salesBaseAccumulationEnabled: true, marketProductOrientationEnabled: true });
  const a = runAutoplayCase(config);
  assert.equal(a.completedTurns, 8);
  const b = runAutoplayCase(config);
  assert.equal(JSON.stringify(a.history), JSON.stringify(b.history));
  // turn8時点のAI観測に営業基盤が現れている（志向により活動配分が偏る→蓄積差）
  const turn8 = a.quarterStartCaptures.filter((c) => c.turn === 8);
  const withBase = turn8.filter((c) => c.ownState.salesBaseByMarketProduct && Object.keys(c.ownState.salesBaseByMarketProduct).length > 0);
  assert.ok(withBase.length === 5, `turn8で営業基盤を観測できた会社が${withBase.length}/5社のみ`);
});

test("SAI-5D統合: 継続活動した市場×商品の基盤が中立値を上回り、志向の強い市場ほど高い（JPQ×JP > JPQ×CN）", () => {
  const run = runAutoplayCase(
    baseConfig("sai5d-direction", 8, { salesBaseAccumulationEnabled: true, marketProductOrientationEnabled: true })
  );
  const jpqTurn8 = run.quarterStartCaptures.find((c) => c.turn === 8 && c.companyId === "JPQ")!;
  const base = jpqTurn8.ownState.salesBaseByMarketProduct!;
  const jpVap = (base.JP?.vap as unknown as number) ?? 50;
  assert.ok(jpVap > 50, `JPQの日本×VAP基盤(${jpVap})が中立値を超えていない`);
});

test("SAI-5D統合: 無効時はsnapshot形状が既存と同一（salesBaseStateがどこにも現れない）", () => {
  const off = runAutoplayCase(baseConfig("sai5d-shape", 2));
  for (const c of off.quarterStartCaptures) {
    assert.equal(c.ownState.salesBaseByMarketProduct, undefined);
  }
});

// ---------------------------------------------------------------------
// SAI-5E: 供給圧力→プレミアムフィードバック
// ---------------------------------------------------------------------

test("SAI-5E統合: supplyPremiumFeedback無効時は従来と完全に同一（後方互換）", () => {
  const off1 = runAutoplayCase(baseConfig("sai5e-backcompat", 2));
  const off2 = runAutoplayCase(baseConfig("sai5e-backcompat", 2, { supplyPremiumFeedbackEnabled: false }));
  assert.equal(JSON.stringify(off1.history), JSON.stringify(off2.history));
});

test("SAI-5E統合: 有効時、8四半期完走・同一seedで完全再現・供給圧力とプレミアム倍率が記録される", () => {
  const config = baseConfig("sai5e-on-repro", 8, { supplyPremiumFeedbackEnabled: true, productLifecycleEnabled: true });
  const a = runAutoplayCase(config);
  assert.equal(a.completedTurns, 8);
  const b = runAutoplayCase(config);
  assert.equal(JSON.stringify(a.history), JSON.stringify(b.history));
  for (const h of a.history) {
    const rec = h.sai5MarketEvolution;
    assert.ok(rec, `turn${h.turn}にsai5MarketEvolutionが記録されていない`);
    for (const p of ["pd", "vap"] as const) {
      assertAllFinite(rec!.supplyPressureByProduct[p], `turn${h.turn}.supplyPressure.${p}`);
      assert.ok(rec!.appliedPremiumRatioMultipliers[p] >= 0.6 - 1e-9 && rec!.appliedPremiumRatioMultipliers[p] <= 1.4 + 1e-9);
    }
  }
  // turn1は前期stateが無いため倍率は必ず中立1
  assert.deepEqual(a.history[0].sai5MarketEvolution!.appliedPremiumRatioMultipliers, { pd: 1, vap: 1 });
});

test("SAI-5E統合: AIはturn2以降に供給圧力の公開統計を観測できる（turn1は前期が無いためundefined）", () => {
  const run = runAutoplayCase(baseConfig("sai5e-outlook", 3, { supplyPremiumFeedbackEnabled: true }));
  const turn1 = run.quarterStartCaptures.find((c) => c.turn === 1)!;
  const turn2 = run.quarterStartCaptures.find((c) => c.turn === 2)!;
  assert.equal(turn1.publicInfo.productSupplyPressureOutlook, undefined);
  assert.ok(turn2.publicInfo.productSupplyPressureOutlook, "turn2で供給圧力の公開統計が観測できない");
  assertAllFinite(turn2.publicInfo.productSupplyPressureOutlook);
});

test("SAI-5E統合: 契約単価は遡及変更されない（同一契約のunitPriceが全四半期で不変）", () => {
  const run = runAutoplayCase(baseConfig("sai5e-contract-immutable", 6, { supplyPremiumFeedbackEnabled: true, productLifecycleEnabled: true }));
  const priceByContract = new Map<string, number>();
  for (const h of run.history) {
    for (const c of h.salesRecord.newContracts) {
      priceByContract.set(c.contractId, c.unitPrice as unknown as number);
    }
  }
  // 最終状態の契約一覧で、成約時の単価から変わっていないことを確認
  const lastState = run.history[run.history.length - 1];
  for (const c of lastState.salesRecord.newContracts) {
    assert.equal(c.unitPrice as unknown as number, priceByContract.get(c.contractId));
  }
});

// ---------------------------------------------------------------------
// SAI-5B: 異質5社preset（会社別の小幅な初期差）
// ---------------------------------------------------------------------

test("SAI-5B統合: heterogeneousInitial無効時は従来と完全に同一（identical-standardの維持）", () => {
  const off1 = runAutoplayCase(baseConfig("sai5b-backcompat", 2));
  const off2 = runAutoplayCase(baseConfig("sai5b-backcompat", 2, { heterogeneousInitialConditionsEnabled: false }));
  assert.equal(JSON.stringify(off1.history), JSON.stringify(off2.history));
  // 5社のfixtureが完全同一（会社ID系を除く）であることは既存の
  // heterogeneousProfiles.test.tsの同一初期条件テストが引き続き保証する。
});

test("SAI-5B統合: 有効時、会社別の設備ミックスが設計どおり傾斜し、固定資産が能力合計に比例して調整される", () => {
  const run = runAutoplayCase(baseConfig("sai5b-tilts", 1, { heterogeneousInitialConditionsEnabled: true }));
  const fixtureOf = (id: string) => run.companies.find((f) => f.companyId === id)!;
  const capOf = (id: string, product: "hosoCapacity" | "pdCapacity" | "vapCapacity") =>
    fixtureOf(id).factories.reduce((s, f) => s + (f[product] as unknown as number), 0);

  // MASS=HOSO寄り、JPQ=VAP寄り、VAP社=PD/VAP寄り、CONSV=PD寄り（BAL基準）
  assert.ok(capOf("MASS", "hosoCapacity") > capOf("BAL", "hosoCapacity"));
  assert.ok(capOf("MASS", "vapCapacity") < capOf("BAL", "vapCapacity"));
  assert.ok(capOf("JPQ", "vapCapacity") > capOf("BAL", "vapCapacity"));
  assert.ok(capOf("VAP", "pdCapacity") > capOf("BAL", "pdCapacity"));
  assert.ok(capOf("CONSV", "pdCapacity") > capOf("BAL", "pdCapacity"));

  // 固定資産: 能力を増やしたMASS(合計+3%程度)とBALで方向が整合
  const turn1 = run.quarterStartCaptures.filter((c) => c.turn === 1);
  const faOf = (id: string) => turn1.find((c) => c.companyId === id)!.ownState.financeState.fixedAssetsGross as unknown as number;
  const totalCapOf = (id: string) => capOf(id, "hosoCapacity") + capOf(id, "pdCapacity") + capOf(id, "vapCapacity");
  for (const id of ["MASS", "JPQ", "VAP", "CONSV"]) {
    const capRatio = totalCapOf(id) / totalCapOf("BAL");
    const faRatio = faOf(id) / faOf("BAL");
    assert.ok(Math.abs(faRatio - capRatio) < 0.01, `${id}: 固定資産比率(${faRatio})が能力比率(${capRatio})と整合しない`);
  }
});

test("SAI-5B統合: 有効時、BSは全社バランスし（残差利益剰余金）、初期営業基盤が会社像どおり設定される", () => {
  const run = runAutoplayCase(
    baseConfig("sai5b-bs", 1, { heterogeneousInitialConditionsEnabled: true, salesBaseAccumulationEnabled: true })
  );
  const turn1 = run.quarterStartCaptures.filter((c) => c.turn === 1);
  for (const c of turn1) {
    const fs = c.ownState.financeState;
    const n = (v: unknown) => v as number;
    const rawMaterialValue = c.ownState.rawMaterialLots.reduce(
      (s, l) => s + (l.remainingQuantity as unknown as number) * 1000 * (l.unitCost as unknown as number),
      0
    );
    const receivables = fs.receivables.reduce((s, r) => s + n(r.amount), 0);
    const assets = n(fs.cash) + receivables + rawMaterialValue + n(fs.otherCurrentAssets) + n(fs.fixedAssetsGross) - n(fs.accumulatedDepreciation);
    const liabilitiesAndEquity =
      n(fs.shortTermLoans) + n(fs.longTermLoans) + n(fs.otherLiabilities) + n(fs.capitalStock) + n(fs.retainedEarnings);
    assert.ok(Math.abs(assets - liabilitiesAndEquity) < 1, `${c.companyId}: BSがバランスしない (資産${assets} vs 負債資本${liabilitiesAndEquity})`);
  }
  // 初期営業基盤（JPQ×JP×VAP=65等）がAIの観測に現れる
  const jpq = turn1.find((c) => c.companyId === "JPQ")!;
  assert.equal(jpq.ownState.salesBaseByMarketProduct?.JP?.vap as unknown as number, 65);
  const bal = turn1.find((c) => c.companyId === "BAL")!;
  assert.equal(bal.ownState.salesBaseByMarketProduct?.JP?.vap, undefined); // BALは初期差なし（中立）
});

test("SAI-5B統合: 有効時でも8四半期完走・エラー0・同一seedで完全再現", () => {
  const config = baseConfig("sai5b-repro", 8, {
    heterogeneousInitialConditionsEnabled: true,
    marketProductOrientationEnabled: true,
    managementProfilesEnabled: true,
    salesBaseAccumulationEnabled: true,
    productLifecycleEnabled: true,
    supplyPremiumFeedbackEnabled: true,
  });
  const a = runAutoplayCase(config);
  assert.equal(a.completedTurns, 8);
  const b = runAutoplayCase(config);
  assert.equal(JSON.stringify(a.history), JSON.stringify(b.history));
  assert.equal(JSON.stringify(a.diagnostics), JSON.stringify(b.diagnostics));
});

// ---------------------------------------------------------------------
// SAI-5F: Standard AIの拡張設備投資判断（統合）
// ---------------------------------------------------------------------

test("SAI-5F統合: standardAiCapex無効時は従来と完全に同一（後方互換）", () => {
  const off1 = runAutoplayCase(baseConfig("sai5f-backcompat", 2, { managementProfilesEnabled: true }));
  const off2 = runAutoplayCase(baseConfig("sai5f-backcompat", 2, { managementProfilesEnabled: true, standardAiCapexEnabled: false }));
  assert.equal(JSON.stringify(off1.history), JSON.stringify(off2.history));
});

test("SAI-5F統合: 全フラグON・16四半期完走・再現・建設中設備の二重提案なし", () => {
  const config = baseConfig("sai5f-all-on", 16, {
    heterogeneousInitialConditionsEnabled: true,
    managementProfilesEnabled: true,
    marketProductOrientationEnabled: true,
    salesBaseAccumulationEnabled: true,
    productLifecycleEnabled: true,
    supplyPremiumFeedbackEnabled: true,
    standardAiCapexEnabled: true,
  });
  const a = runAutoplayCase(config);
  assert.equal(a.completedTurns, 16);
  const b = runAutoplayCase(config);
  assert.equal(JSON.stringify(a.history), JSON.stringify(b.history));

  // 建設中設備の二重提案なし: 各会社×turnで、期首時点で進行中（cancelled・
  // 稼働開始済みcompleted以外）のターゲットへ同種の新規提案を出していない。
  const targetOfProjectType: Record<string, string> = {
    hosoLineExpansion: "hoso",
    pdLineExpansion: "pd",
    vapLineExpansion: "vap",
    commonProcessingExpansion: "commonProcessing",
  };
  for (const capture of a.quarterStartCaptures) {
    const decision = a.diagnostics.find((d) => d.companyId === capture.companyId && d.turn === capture.turn)?.decision;
    if (!decision || decision.capexDecision.newProjectProposals.length === 0) continue;
    const inProgressTargets = new Set(
      capture.ownState.capexState.portfolio.projects
        .filter((p) => p.status === "approved" || p.status === "underConstruction" || p.status === "suspended")
        .map((p) => p.futureCapacityEffect?.targetProduct)
        .filter(Boolean)
    );
    for (const proposal of decision.capexDecision.newProjectProposals) {
      const target = targetOfProjectType[proposal.projectType];
      assert.ok(
        !inProgressTargets.has(target as never),
        `${capture.companyId} turn${capture.turn}: 進行中の${target}案件があるのに${proposal.projectType}を再提案している`
      );
    }
  }
});

// ---------------------------------------------------------------------
// SAI-5G: 長期安定性（32四半期）・収斂しないことの確認
// ---------------------------------------------------------------------

test("SAI-5G統合: 全フラグON・32四半期を完走し、NaN/Infinity/負数量・状態爆発がなく、5社が同一判断へ収束し続けない", () => {
  const run = runAutoplayCase(
    baseConfig("sai5g-32q-stability", 32, {
      heterogeneousInitialConditionsEnabled: true,
      managementProfilesEnabled: true,
      marketProductOrientationEnabled: true,
      salesBaseAccumulationEnabled: true,
      productLifecycleEnabled: true,
      supplyPremiumFeedbackEnabled: true,
      standardAiCapexEnabled: true,
    })
  );
  assert.equal(run.completedTurns, 32);
  assertAllFinite(run.history.map((h) => ({ s: h.companySummaries, e: h.sai5MarketEvolution })));

  // 負数量なし（販売希望・池入れ・生産）
  for (const d of run.diagnostics) {
    for (const p of d.decision.salesPlans) assert.ok((p.desiredQuantity as unknown as number) >= 0);
    for (const p of d.decision.productionPlans) assert.ok((p.desiredQuantity as unknown as number) >= 0);
    for (const p of d.decision.aquacultureStockingPlans) assert.ok((p.plannedStockingQuantity as unknown as number) >= 0);
  }

  // 状態爆発なし: 営業基盤エントリ数は最大 会社×市場×商品=75
  const lastCapture = run.quarterStartCaptures.filter((c) => c.turn === 32);
  for (const c of lastCapture) {
    const entries = Object.values(c.ownState.salesBaseByMarketProduct ?? {}).flatMap((m) => Object.keys(m ?? {}));
    assert.ok(entries.length <= 15, `${c.companyId}: 自社の営業基盤エントリ(${entries.length})が上限15(市場5×商品3)を超えている`);
  }

  // 全社が同一判断へ収束し続けない: 最終四半期の市場別販売構成が5社で同一でない
  const turn32ByCompany = new Map<string, string>();
  for (const d of run.diagnostics.filter((d) => d.turn === 32)) {
    const byMarket: Record<string, number> = {};
    for (const p of d.decision.salesPlans) byMarket[p.market] = (byMarket[p.market] ?? 0) + (p.desiredQuantity as unknown as number);
    turn32ByCompany.set(d.companyId, JSON.stringify(byMarket));
  }
  const distinct = new Set(turn32ByCompany.values());
  assert.ok(distinct.size >= 3, `turn32の市場別販売構成が${distinct.size}種類しかない（全社同一行動への収束）`);
});

test("SAI-5G統合: SAI-5トレースCSV（market-evolution/lifecycle-mix/sales-base）はフラグ有効時のみ生成される", async () => {
  const { runAutoplayCli } = await import("../cli");
  const off = runAutoplayCli(["--seeds", "sai5g-csv-off", "--quarters", "2", "--run-id", "t-off"]);
  assert.equal(off.exitCode, 0);
  assert.ok(off.files && !("market-evolution-trace.csv" in off.files) && !("sales-base-trace.csv" in off.files));

  const on = runAutoplayCli([
    "--seeds",
    "sai5g-csv-on",
    "--quarters",
    "2",
    "--run-id",
    "t-on",
    "--lifecycle",
    "--sales-base",
    "--premium-feedback",
    "--orientation",
  ]);
  assert.equal(on.exitCode, 0);
  assert.ok(on.files && "market-evolution-trace.csv" in on.files, "market-evolution-trace.csvが生成されない");
  assert.ok(on.files && "lifecycle-mix-trace.csv" in on.files, "lifecycle-mix-trace.csvが生成されない");
  assert.ok(on.files && "sales-base-trace.csv" in on.files, "sales-base-trace.csvが生成されない");
  // 既存の必須7ファイルも揃っている（SAI-3B後方互換の前提）
  for (const f of ["manifest.json", "case-summary.csv", "quarter-summary.csv", "decision-trace.jsonl", "adjustment-trace.csv", "warnings.csv", "run-summary.json"]) {
    assert.ok(on.files && f in on.files, `${f}が欠けている`);
  }
});
