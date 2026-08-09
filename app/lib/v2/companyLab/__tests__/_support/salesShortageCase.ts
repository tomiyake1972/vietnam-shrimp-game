// ShrimpX V2 — テスト support: 「営業が制約になっている状況」を意図的に作る
//
// 【なぜ必要か（2026-08-08・Test16）】
// Test16でゲームの初期営業人数が全社60人になった。これは意図した変更であり、
// 「序盤から営業不足を埋めるだけのゲームにしない」という設計目的そのものである。
//
// 一方で、既存テストの中には
//   ・営業基盤の差が成約シェアの差を生む（SAI-5因果）
//   ・需要が多い環境ほど設備稼働率が高い（NFPC-4）
// のように、**営業が制約であること**を暗黙の前提にして因果を検証しているものがある。
// 営業60人ではこれらの前提が成立せず、供給側が先に効くため因果が見えなくなる。
//
// 【指示Oへの対応】
// 期待値を機械的に書き換えると「そのテストが何を守っていたのか」が失われる。
// そこで、これらのテストには**専用に営業人数を低く固定した世界**を与え、
// 「営業不足ケース」として独立させる。ゲームの初期値が今後どう変わっても、
// これらのテストが検証している因果関係は壊れない。
//
// 【この値の根拠】Test16以前のBALの初期営業人数（18人）。
// 「営業が確実にボトルネックになる水準」の代表値として使う。

import { CompanyFixture, CompanyLabState } from "../../types";

/** 営業不足ケースで使う営業人員数（全社共通）。 */
export const SALES_SHORTAGE_CASE_HEADCOUNT = 18;

/**
 * initializeCompanyLab の戻り値を「営業不足ケース」へ変換する。
 *
 * fixture の静的な基準人数と、state が持つ実際の配分可能人数の**両方**を
 * 下げる必要がある（前者だけだと state 側の60人がそのまま使われる）。
 *
 * ゲームのパラメータ・エンジンには一切触れない。テスト用の入力データを
 * 差し替えるだけの純粋な変換である。
 */
export function asSalesShortageCase<T extends { readonly state: CompanyLabState; readonly fixtures: readonly CompanyFixture[] }>(
  input: T,
  headcount: number = SALES_SHORTAGE_CASE_HEADCOUNT
): { readonly state: CompanyLabState; readonly fixtures: readonly CompanyFixture[] } {
  const fixtures = input.fixtures.map((f) => ({ ...f, salesForceHeadcountTotal: headcount }));
  const state: CompanyLabState = {
    ...input.state,
    salesForceHiringState: {
      companies: input.fixtures.map((f) => ({ companyId: f.companyId, headcount })),
    },
  };
  return { state, fixtures };
}
