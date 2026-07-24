// ShrimpX V2 — 初期成約（前期成約）機能の受入確認テスト
//
// 【回収の背景】/root/shrimpx（メイン作業ツリー）に未コミットのまま残っていた
// 「初期成約」機能（app/lib/v2/companyLab/initialContracts.ts と、それを
// initializeCompanyLabへ接続するrunner.tsの差分）を、develop/v2（2741ab6）から
// 作成したfeatureブランチへ回収するにあたり、三宅さんから明示的に指示された
// 以下10項目の不変条件を検証する：
//   1. 初期売掛金と初期成約が二重計上されない
//   2. 初期売掛金の回収が売上高・利益を発生させない
//   3. 初期成約は契約履行時に初めて売上として認識される
//   4. 成約時単価が履行時にも維持される
//   5. 契約数量・納期・製品・市場・単価が既存スキーマに適合する
//   6. 5社すべてで初期化できる
//   7. baseline 32ターンを完走できる
//   8. 永続化・再開・resume equivalenceを壊さない
//      （resumeEquivalence.test.ts・companyLabQuarterFlowService.test.ts側で
//      既にinitializeCompanyLab経由で検証されており、本ファイルでは重複させない）
//   9. initializeCompanyLabを利用する既存テストに想定外の影響がない
//      （全1340件のうち本ファイル追加前の既存分がすべて成功することで確認済み）
//   10. contractsが空であることを前提にしたテストが残っていないか
//      （grep調査済み。initializeCompanyLabの出力を対象にした
//      `contracts.length === 0` 相当のテストは存在しない。sales/*.test.ts・
//      atomicCommit.test.ts等の`contracts: []`はいずれも本関数と無関係な
//      独立フィクスチャであることを確認済み）

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initializeCompanyLab,
  buildCompanyOwnState,
  buildPublicMarketInfo,
  advanceCompanyLabQuarter,
  runCompanyLabWithAutoPolicyForAllCompanies,
} from "../runner";
import { generateAutoPolicyDecision } from "../autoPolicy";
import { generateInitialContracts } from "../initialContracts";
import { resolveScenarioDefinition } from "../../industryLab/cli/scenarioAliases";
import { initializeScenario, getScenarioTurnInput } from "../../scenario";
import { previousPeriod, PeriodV2 } from "../../core/period";
import { unwrapUnit } from "../../core/units";
import { INITIAL_FINANCE_FIXTURES_V1 } from "../../finance/initialState";
import { CompanyLabConfig, CompanyDecisionInput, CompanyLabState } from "../types";

const SEED = "initial-contracts-accept-001";
const ALL_COMPANY_IDS = ["BAL", "MASS", "JPQ", "VAP", "CONSV"] as const;

function baselineConfig(turns: number): CompanyLabConfig {
  return { scenarioId: "baseline", mode: "canonical", seed: SEED, turns };
}

function startPeriodFor(seed: string): PeriodV2 {
  const def = resolveScenarioDefinition("baseline");
  if (!def) throw new Error("baseline scenario not found");
  const scenarioState = initializeScenario(def, "canonical", seed);
  return getScenarioTurnInput(scenarioState, 1).period;
}

function buildAutoDecisionsForAll(
  state: CompanyLabState,
  fixtures: ReturnType<typeof initializeCompanyLab>["fixtures"]
): Record<string, CompanyDecisionInput> {
  const publicInfo = buildPublicMarketInfo(state);
  const decisions: Record<string, CompanyDecisionInput> = {};
  for (const fixture of fixtures) {
    const ownState = buildCompanyOwnState(state, fixture);
    decisions[fixture.companyId] = generateAutoPolicyDecision(fixture, ownState, publicInfo, state.currentPeriod, state.scenarioState.currentTurn);
  }
  return decisions;
}

// --- 5・6. 5社すべてで初期化でき、契約数量・納期・製品・市場・単価が既存スキーマに適合する ---

test("初期成約: 5社すべてに設定され、既存SalesContractスキーマに適合する（数量・単価は非負のブランド型として構築済み）", () => {
  const startPeriod = startPeriodFor(SEED);
  const contracts = generateInitialContracts(startPeriod);

  assert.ok(contracts.length > 0, "初期成約が1件も生成されていません");

  const seenCompanies = new Set<string>();
  for (const c of contracts) {
    seenCompanies.add(c.companyId);
    assert.equal(typeof c.contractId, "string");
    assert.ok(c.contractId.length > 0);
    assert.ok(["CN", "US", "EU", "JP", "OTHER"].includes(c.market), `不正な市場: ${c.market}`);
    assert.ok(["hoso", "pd", "vap"].includes(c.product), `不正な商品: ${c.product}`);
    assert.equal(c.status, "open", "初期成約は生成直後は必ずopenであるべき");
    assert.equal(unwrapUnit(c.originalQuantity), unwrapUnit(c.outstandingQuantity), "生成直後は当初数量=未履行数量であるべき");
    assert.ok(unwrapUnit(c.originalQuantity) > 0, "初期成約の数量は正であるべき");
    assert.ok(unwrapUnit(c.unitPrice) > 0, "初期成約の単価は正であるべき");
    assert.equal(c.contractedPeriod, previousPeriod(startPeriod), "初期成約の成約期は開始期の前期であるべき");
    // 納期は必ず開始期より後（＝当期Q1には未出荷の契約として設計されている）
    assert.ok(c.dueDate.localeCompare(startPeriod) > 0, `初期成約の納期(${c.dueDate})が開始期(${startPeriod})以前になっています`);
  }
  for (const companyId of ALL_COMPANY_IDS) {
    assert.ok(seenCompanies.has(companyId), `会社${companyId}の初期成約が存在しません`);
  }
});

test("initializeCompanyLab: 初期成約を含めて5社すべてで例外を投げずに初期化できる", () => {
  const { state, fixtures } = initializeCompanyLab(baselineConfig(4));
  assert.equal(fixtures.length, 5);
  const companiesWithContracts = new Set(state.contracts.map((c) => c.companyId));
  for (const companyId of ALL_COMPANY_IDS) {
    assert.ok(companiesWithContracts.has(companyId), `初期化直後にstate.contractsへ会社${companyId}の契約がありません`);
  }
});

// --- 1. 初期売掛金と初期成約が二重計上されない（構造的検証） ---

test("二重計上防止: 初期化直後、初期成約は財務上のreceivables（売掛金）には一切含まれない（未履行のため未計上）", () => {
  const { state } = initializeCompanyLab(baselineConfig(4));
  assert.equal(state.financeState.companies.length, 5);

  for (const company of state.financeState.companies) {
    // 初期化直後のreceivablesは「初期売掛金（前期以前の販売、Q1回収予定）」1件のみで、
    // sourceRefが"initial:pre-game-sales"であることを確認する。初期成約由来の
    // receivablesは(まだ履行されていないため)一切存在しないはずである。
    for (const r of company.receivables) {
      assert.equal(r.sourceRef, "initial:pre-game-sales", `会社${company.companyId}のreceivablesに想定外のsourceRef: ${r.sourceRef}`);
    }
    const fixture = INITIAL_FINANCE_FIXTURES_V1.find((f) => f.companyId === company.companyId)!;
    const expectedCount = fixture.initialAccountsReceivable > 0 ? 1 : 0;
    assert.equal(company.receivables.length, expectedCount, `会社${company.companyId}の初期receivables件数が想定外です`);
  }

  // 初期成約の合計金額と、初期売掛金の金額は、それぞれ独立した数値であり
  // （初期成約側は営業力・工場能力からの積み上げ、初期売掛金側はINITIAL_FINANCE_FIXTURES_V1の
  // 固定値）、一方から他方が機械的に導出されていないことを確認する。
  const startPeriod = startPeriodFor(SEED);
  const contracts = generateInitialContracts(startPeriod);
  for (const companyId of ALL_COMPANY_IDS) {
    const contractTotal = contracts
      .filter((c) => c.companyId === companyId)
      .reduce((sum, c) => sum + unwrapUnit(c.originalQuantity) * unwrapUnit(c.unitPrice) * 1000, 0);
    const fixture = INITIAL_FINANCE_FIXTURES_V1.find((f) => f.companyId === companyId)!;
    assert.notEqual(
      Math.round(contractTotal),
      fixture.initialAccountsReceivable,
      `会社${companyId}: 初期成約合計($${contractTotal})が初期売掛金($${fixture.initialAccountsReceivable})と偶然一致しています。二重計上でないか要確認`
    );
  }
});

// --- 2・3. 初期売掛金の回収は売上高・利益を発生させず、初期成約は履行時にのみ売上認識される ---

test("会計整合性: Q1のgrossRevenueは、実際の履行実績(fulfillmentUsage)×成約単価の合計と厳密に一致する（初期売掛金の回収による水増しがない）", () => {
  const { state: initState, fixtures } = initializeCompanyLab(baselineConfig(2));
  const decisions = buildAutoDecisionsForAll(initState, fixtures);
  const nextState = advanceCompanyLabQuarter(initState, fixtures, decisions);
  const t1 = nextState.history[0];

  const contractPriceById = new Map<string, number>();
  for (const c of initState.contracts) contractPriceById.set(c.contractId, unwrapUnit(c.unitPrice));
  for (const c of t1.salesRecord.newContracts) contractPriceById.set(c.contractId, unwrapUnit(c.unitPrice));

  for (const companyId of ALL_COMPANY_IDS) {
    const usage = t1.fulfillmentPlan.usage.filter((u) => u.companyId === companyId);
    let expectedGrossRevenue = 0;
    for (const u of usage) {
      const price = contractPriceById.get(u.contractId);
      assert.ok(price !== undefined, `履行実績の契約単価が見つかりません: ${u.contractId}`);
      expectedGrossRevenue += unwrapUnit(u.quantity) * (price as number) * 1000;
    }
    const fr = t1.financialResults.find((f) => f.companyId === companyId)!;
    const actualGrossRevenue = fr.profitAndLoss.grossRevenue as number;
    assert.ok(
      Math.abs(actualGrossRevenue - expectedGrossRevenue) < 1,
      `会社${companyId}: grossRevenue(${actualGrossRevenue})が履行実績からの期待値(${expectedGrossRevenue})と一致しません。` +
        `初期売掛金の回収（残高の一部）が売上高へ混入している可能性があります`
    );
  }
});

test("会計整合性: 初期売掛金（sourceRef=initial:pre-game-sales）はQ1決算後、receivablesから消え（回収済み）ている", () => {
  const { state: initState, fixtures } = initializeCompanyLab(baselineConfig(2));
  const decisions = buildAutoDecisionsForAll(initState, fixtures);
  const nextState = advanceCompanyLabQuarter(initState, fixtures, decisions);

  for (const company of nextState.financeState.companies) {
    const stillHasInitialAr = company.receivables.some((r) => r.sourceRef === "initial:pre-game-sales");
    assert.equal(stillHasInitialAr, false, `会社${company.companyId}: 初期売掛金がQ1末時点でまだreceivablesに残っています（回収予定期はstartPeriodのはず）`);
  }
});

// --- 4. 成約時単価が履行時にも維持される ---

test("成約時単価の維持: 初期成約が履行された場合、履行時のunitPrice参照は生成時の値と完全一致する（履行時の再計算・改定がない）", () => {
  const startPeriod = startPeriodFor(SEED);
  const initialContracts = generateInitialContracts(startPeriod);
  const priceAtCreation = new Map<string, number>();
  for (const c of initialContracts) priceAtCreation.set(c.contractId, unwrapUnit(c.unitPrice));

  // baselineは全社32ターンだが、初期成約はcontractedPeriodがFIFOで最優先されるため、
  // 数ターン以内に履行が始まる想定。8ターン走らせて履行の有無を確認する。
  const { state: initState, fixtures } = initializeCompanyLab(baselineConfig(8));
  let state = initState;
  let fulfilledAnyInitialContract = false;
  for (let turn = 1; turn <= 8; turn++) {
    const decisions = buildAutoDecisionsForAll(state, fixtures);
    state = advanceCompanyLabQuarter(state, fixtures, decisions);
    const record = state.history[state.history.length - 1];
    for (const u of record.fulfillmentPlan.usage) {
      const creationPrice = priceAtCreation.get(u.contractId);
      if (creationPrice === undefined) continue; // 初期成約以外（当期生成分）
      fulfilledAnyInitialContract = true;
      const contract = state.contracts.find((c) => c.contractId === u.contractId);
      assert.ok(contract, `履行された初期成約が状態内に見当たりません: ${u.contractId}`);
      assert.equal(
        unwrapUnit(contract!.unitPrice),
        creationPrice,
        `初期成約${u.contractId}の単価が履行後に変化しています（生成時=${creationPrice}, 現在=${unwrapUnit(contract!.unitPrice)}）`
      );
    }
  }
  assert.ok(fulfilledAnyInitialContract, "8ターン以内に初期成約が1件も履行されておらず、単価維持の検証ができていません");
});

// --- 7. baseline 32ターンを完走できる ---

test("baseline 32ターン: 初期成約を含めても、5社全社が例外を投げずに最終ターンまで完走し、isCompleteになる", () => {
  const result = runCompanyLabWithAutoPolicyForAllCompanies(baselineConfig(32), generateAutoPolicyDecision);
  // runCompanyLabWithAutoPolicyForAllCompanies内部はwhile(!state.isComplete)ループのため、
  // history.length===32まで到達していること自体が「例外を投げずに32ターン完走した」証明になる。
  assert.equal(result.history.length, 32);
  // 最終ターンの5社財務結果が全て有限値であること（NaN・Infinityの伝播がないこと）の簡易確認
  const last = result.history[result.history.length - 1];
  for (const fr of last.financialResults) {
    assert.ok(Number.isFinite(fr.balanceSheet.cash as number), `会社${fr.companyId}の最終現金が有限値ではありません`);
    assert.ok(Number.isFinite(fr.profitAndLoss.netIncome as number), `会社${fr.companyId}の最終純利益が有限値ではありません`);
  }
});
