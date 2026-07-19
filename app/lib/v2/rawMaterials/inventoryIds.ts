// ShrimpX V2 — 国内原料・輸入・養殖・原料在庫モジュール ロットID生成（Phase 5）
//
// 国内買付・輸入・自社養殖のいずれの調達源でも同じ形式で決定論的なlotIdを
// 生成する（Phase4のbuildContractIdと同じ考え方）。sequenceは呼び出し側が
// 同一四半期・同一調達源内で衝突しないよう採番する連番（複数ロットが同じ
// company×period×originCountryの組み合わせで生成される場合に一意性を保つ）。

import { PeriodV2 } from "../core/period";
import { CountryId } from "../market/types";
import { RawMaterialSource } from "./types";

export function buildLotId(source: RawMaterialSource, companyId: string, period: PeriodV2, originCountry: CountryId, sequence: number): string {
  return `RM-${source}-${period}-${originCountry}-${companyId}-${sequence}`;
}
