// ShrimpX V2 — Phase SAI-3A: 判断記録基盤 — 四半期開始時状態のキャプチャ
//
// 【方針】standardAi/policy.ts の createStandardAiProvider() は既に「AIが提出した
// 意思決定＋診断情報」を副作用なしで収集できる（SAI-1.5で追加済み）。本モジュールは
// これをさらに薄くラップし、意思決定生成の「直前」に渡される引数
// （fixture・ownState・publicInfo・period・turn）をそのまま保存するだけの
// デコレータを追加する。標準AI・quarter runner側のロジック・計算は一切変更しない
// （引数を読み取って配列へpushするだけ）。

import { CompanyDecisionProvider, CompanyFixture, CompanyOwnState, PublicMarketInfo } from "../../types";
import { PeriodV2 } from "../../../core/period";
import { createStandardAiProvider, StandardAiProviderOptions, StandardAiQuarterDiagnostics } from "../policy";

/** 1社・1四半期ぶんの「意思決定生成直前」に渡された入力一式（=四半期開始時点で
 *  標準AIが参照できた情報の全体。判断記録のセクションAを組み立てる材料）。 */
export interface QuarterStartCapture {
  readonly companyId: string;
  readonly turn: number;
  readonly period: PeriodV2;
  readonly fixture: CompanyFixture;
  readonly ownState: CompanyOwnState;
  readonly publicInfo: PublicMarketInfo;
}

export interface InstrumentedStandardAiRun {
  readonly provider: CompanyDecisionProvider;
  readonly quarterStartCaptures: readonly QuarterStartCapture[];
  readonly diagnostics: readonly StandardAiQuarterDiagnostics[];
}

/**
 * createStandardAiProvider()が返すproviderをさらにラップし、意思決定生成の
 * 直前に渡された(fixture, ownState, publicInfo, period, turn)を副作用として
 * 配列へ記録する。返り値（意思決定そのもの）は一切変更しない
 * （標準AIの挙動・決定論性に影響しない）。
 */
export function createInstrumentedStandardAiRun(
  /** 【SAI-4追加】省略時=undefinedなら従来どおり（既存の全出力・全テストへの影響ゼロ）。 */
  options: StandardAiProviderOptions = {}
): InstrumentedStandardAiRun {
  const { provider: baseProvider, diagnostics } = createStandardAiProvider(options);
  const quarterStartCaptures: QuarterStartCapture[] = [];

  const provider: CompanyDecisionProvider = (fixture, ownState, publicInfo, period, turn) => {
    quarterStartCaptures.push({ companyId: fixture.companyId, turn, period, fixture, ownState, publicInfo });
    return baseProvider(fixture, ownState, publicInfo, period, turn);
  };

  return { provider, quarterStartCaptures, diagnostics };
}
