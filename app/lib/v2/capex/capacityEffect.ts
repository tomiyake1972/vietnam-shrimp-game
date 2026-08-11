// ShrimpX V2 — 設備投資モジュール 操業効果（能力増加・固定保守費）
// （Phase 8B-2B新設、Phase 8B-2Cで責務を整理）
//
// 完成した設備投資案件を、実際の生産能力・固定保守費へ接続する純粋関数群。
// 新規capex資産の減価償却（建物・機械コンポーネント別定額法）は、Phase 8B-2Cで
// capex/depreciation.tsへ分離した（本ファイルはcomputeOperationalStartPeriod・
// isCapexProjectOperationalAtという共通の「稼働開始判定」ロジックだけを提供し、
// depreciation.tsはそれをそのまま再利用する。判定ロジックを2箇所に複製しない）。
//
// 実装指示§8「累計能力増加・当期減価償却費・累計capex減価償却の別台帳・当期
// 保守費・操業中フラグは永続化しない」に従い、以下だけを唯一の真実として
// 毎期再導出する:
//   - CapitalProject.projectType（テンプレート参照キー）
//   - CapitalProject.status（"completed"のみ対象）
//   - CapitalProject.completedPeriod（稼働開始四半期の算出起点）
//   - CapitalProject.capitalizedAmountUsd（保守費の算出基準額）
//   - CapitalProject.futureCapacityEffect（承認時スナップショット。targetProduct・
//     capacityIncreaseTonsPerQuarter・readinessQuartersAfterCompletion）
//   - capex/parameters.tsの案件種別別テンプレート（maintenanceRatePerQuarter。
//     実装指示§4「耐用年数は案件固有の永続フィールドにはせず、テンプレート値
//     から導出」と同じ方針を保守費率にも適用）
//   - 現在四半期（period引数）
// 能力増加・新規資産減価償却・固定保守費の開始四半期はすべて同一の
// operationalStartPeriodへ統一する（実装指示§3.2、Phase 8B-2Cでも変更なし）。

import { nextPeriod, PeriodV2, toYearQuarter } from "../core/period";
import { hosoEqTons, unwrapUnit } from "../core/units";
import { CompanyId } from "../sales/types";
import { Factory } from "../production/types";
import { resolveFactoryColdStorageCapacityTons } from "../production/coldStorage";
import { CapexParameters } from "./parameters";
import { CapexState, CapitalProject } from "./types";

// ---------------------------------------------------------------------
// 期間演算（financing/initialPortfolio.ts・financing/bankUnderwriting.tsの
// addQuarters、production/loadMetrics.tsのquartersBetweenと同じローカル実装
// パターンを踏襲。共通ユーティリティへ抽出しない既存の慣例に従う）。
// ---------------------------------------------------------------------

function addQuarters(p: PeriodV2, quarters: number): PeriodV2 {
  let result = p;
  for (let i = 0; i < quarters; i++) result = nextPeriod(result);
  return result;
}

function quartersBetween(from: PeriodV2, to: PeriodV2): number {
  const a = toYearQuarter(from);
  const b = toYearQuarter(to);
  return (b.year * 4 + b.quarter) - (a.year * 4 + a.quarter);
}

/**
 * 稼働開始四半期を算出する（実装指示§3.2、文字列比較せずPeriodV2演算のみで
 * 導出）。operationalStartPeriod = completedPeriodの翌四半期 + readiness。
 * 例: 2016Q2に完成・readiness=0 → 2016Q3から。readiness=1 → 2016Q4から。
 */
export function computeOperationalStartPeriod(completedPeriod: PeriodV2, readinessQuartersAfterCompletion: number): PeriodV2 {
  return addQuarters(nextPeriod(completedPeriod), readinessQuartersAfterCompletion);
}

/**
 * period時点でこの案件がすでに稼働開始しているか（period >= operationalStartPeriod）。
 * 能力増加・固定保守費（本ファイル）・新規capex資産の減価償却（capex/depreciation.ts）
 * のすべてが、この同一の判定関数を共有する（実装指示§3.2の「同一のoperationalStartPeriod
 * へ統一する」を、判定ロジックの重複を作らずに保証する）。
 */
export function isCapexProjectOperationalAt(project: CapitalProject, period: PeriodV2): boolean {
  if (project.status !== "completed" || project.completedPeriod === undefined) return false;
  const readiness = project.futureCapacityEffect?.readinessQuartersAfterCompletion ?? 0;
  const opStart = computeOperationalStartPeriod(project.completedPeriod, readiness);
  return quartersBetween(opStart, period) >= 0;
}

// ---------------------------------------------------------------------
// 1. 能力増加（実装指示§3.1・§3.3・§3.4）
// ---------------------------------------------------------------------

/**
 * 会社1社ぶんの、稼働開始済み案件による累計能力増加（Factoryの各能力プールへの加算量）。
 *
 * 【Phase 8D-5】coldStorage を追加した。freezingPackaging は「凍結・包装処理能力」
 * （フロー、トン/四半期）、coldStorage は「冷凍・冷蔵保管能力」（ストック、同時保管
 * 可能トン）であり、単位も意味も異なる。生産エンジンの上限として使われるのは
 * freezingPackaging だけである（coldStorage は強制制約未接続）。
 */
export interface CapexCapacityEffect {
  readonly commonProcessing: number;
  readonly hoso: number;
  readonly pd: number;
  readonly vap: number;
  readonly freezingPackaging: number;
  readonly coldStorage: number;
}

/**
 * 1社の投資案件ポートフォリオから、period時点で稼働開始済みの案件ぶんだけを
 * 対象に、targetProduct別の累計能力増加を算出する（実装指示§3.3の要件を
 * すべて満たす）:
 *   - 建設中・停止・取消案件は加算しない（isCapexProjectOperationalAtが
 *     status==="completed"以外を除外）。
 *   - completedでも操業開始前なら加算しない（isCapexProjectOperationalAtの期間判定）。
 *   - 複数案件は累積する（reduce）。
 *   - HOSO/PD/VAPライン増設はcommonProcessingCapacityを増加させない
 *     （targetProductがそれぞれ独立しており、hosoLineExpansion等の
 *     futureCapacityEffect.targetProductは"hoso"等であって"commonProcessing"
 *     ではないため、テンプレート定義自体が混線しない構造になっている）。
 */
export function computeCapacityEffectForCompany(
  projects: readonly CapitalProject[],
  period: PeriodV2
): CapexCapacityEffect {
  let commonProcessing = 0;
  let hoso = 0;
  let pd = 0;
  let vap = 0;
  let freezingPackaging = 0;
  let coldStorage = 0;

  for (const project of projects) {
    if (!isCapexProjectOperationalAt(project, period)) continue;
    const effect = project.futureCapacityEffect;
    if (!effect || effect.targetProduct === undefined || effect.capacityIncreaseTonsPerQuarter === undefined) continue;
    const amount = effect.capacityIncreaseTonsPerQuarter;
    if (amount === 0) continue;
    switch (effect.targetProduct) {
      case "hoso":
        hoso += amount;
        break;
      case "pd":
        pd += amount;
        break;
      case "vap":
        vap += amount;
        break;
      case "commonProcessing":
        commonProcessing += amount;
        break;
      case "freezingPackaging":
        freezingPackaging += amount;
        break;
      case "coldStorage":
        coldStorage += amount;
        break;
    }
  }

  return { commonProcessing, hoso, pd, vap, freezingPackaging, coldStorage };
}

/**
 * 【複数工場CAPEX Targeting修正】computeCapacityEffectForCompanyと同じ判定条件
 * （稼働開始済み・target/増加量が揃っている）で、project.targetFactoryIdごとに
 * 累計効果を分ける版。targetFactoryIdが無い案件（pdMechanization/newFactoryConstruction
 * 以外の従来案件で、まだプレイヤー/AIがfactoryを指定していないもの）は
 * primaryFactoryIdへ寄せる（既存の「主工場（最初の工場）」規則を後方互換として維持）。
 */
export function computeCapacityEffectByFactoryForCompany(
  projects: readonly CapitalProject[],
  period: PeriodV2,
  primaryFactoryId: string
): ReadonlyMap<string, CapexCapacityEffect> {
  const byFactory = new Map<string, CapexCapacityEffect>();
  const zero = (): CapexCapacityEffect => ({ commonProcessing: 0, hoso: 0, pd: 0, vap: 0, freezingPackaging: 0, coldStorage: 0 });

  for (const project of projects) {
    if (!isCapexProjectOperationalAt(project, period)) continue;
    const effect = project.futureCapacityEffect;
    if (!effect || effect.targetProduct === undefined || effect.capacityIncreaseTonsPerQuarter === undefined) continue;
    const amount = effect.capacityIncreaseTonsPerQuarter;
    if (amount === 0) continue;
    const factoryId = project.targetFactoryId ?? primaryFactoryId;
    const current = byFactory.get(factoryId) ?? zero();
    const next = { ...current };
    switch (effect.targetProduct) {
      case "hoso":
        byFactory.set(factoryId, { ...next, hoso: next.hoso + amount });
        break;
      case "pd":
        byFactory.set(factoryId, { ...next, pd: next.pd + amount });
        break;
      case "vap":
        byFactory.set(factoryId, { ...next, vap: next.vap + amount });
        break;
      case "commonProcessing":
        byFactory.set(factoryId, { ...next, commonProcessing: next.commonProcessing + amount });
        break;
      case "freezingPackaging":
        byFactory.set(factoryId, { ...next, freezingPackaging: next.freezingPackaging + amount });
        break;
      case "coldStorage":
        byFactory.set(factoryId, { ...next, coldStorage: next.coldStorage + amount });
        break;
    }
  }

  return byFactory;
}

/**
 * 【Test16】HOSO加工能力の明示的な上限（HOSO換算t/四半期）。
 *
 * HOSOは「低加工度・大量処理・薄利高回転型」の商品として、投資で能力を積み上げられる
 * 設計になっている（初期8,000t、1回の投資で+4,000t）。ただし無制限には増やせない。
 *
 * 共通処理能力（30,000t）も実質的な総量上限として効くが、それだけに頼ると
 * 「HOSO専用能力がいくらでも大きくなり、PD/VAPを削れば際限なくHOSOを作れる」
 * ように読めてしまう。HOSO専用能力そのものの上限をここで明示する。
 *
 * 24,000t = 初期8,000t + 4,000t × 4回（投資総額 32M USD）。
 */
/**
 * HOSO加工能力の明示的な上限（トン/四半期）。
 *
 * 【重要・変更時の必須確認事項（2026-08-09・Test16 Stage E）】
 * この値は商品集中生産効率カーブ（production/concentration.ts）と
 * **数学的に結び付いている**。集中係数に下限を設けていないため、必要Worker総数
 *   required ∝ quantity × concentrationFactor(quantity)
 * は上に凸の二次関数になり、HOSOでは 24,000t が頂点になる
 * （peakLaborQuantityTons("hoso") === 24,000）。
 * それを超えると「たくさん作るほど必要人数が減る」という逆転領域へ入る。
 *
 * 現在は上限と頂点が一致しているため逆転領域へは入らない。
 * **この上限を24,000tより上へ変更する場合は、集中カーブ（下限の要否・傾き）も
 * 同時に再設計しなければならない。** 片方だけ変えてはならない。
 */
export const MAX_HOSO_CAPACITY_TONS = 24_000;

/**
 * 基礎Factory fixture（元のcompanyLab/fixtures.tsの静的値、mutationしない）＋
 * 当該会社の稼働開始済み累計能力増加、から当期の実効Factory[]を再構成する
 * （実装指示§3.3）。
 *   - 元fixtureをmutationしない（新しいオブジェクトへスプレッドするのみ）。
 *   - 会社IDを厳密に区別する（companyIdでグルーピング）。
 *   - 他社設備へ効果を加えない（他社のfactoryはcapexState.companiesの
 *     該当エントリを参照しないため影響しない）。
 *   - 【複数工場CAPEX Targeting修正】投資案件はCapitalProject.targetFactoryIdを
 *     持ちうる（capex/types.ts参照）。targetFactoryIdが設定されていればその
 *     Factoryへ、未設定（factoryを未指定のまま提出した従来案件）なら
 *     その会社の最初の工場（factoryId昇順、＝主工場）へ累計効果を加算する
 *     （単一工場企業・従来案件の挙動は変えない後方互換ルール）。
 */
export function applyCapexCapacityToFactories(
  factories: readonly Factory[],
  capexState: CapexState,
  period: PeriodV2
): readonly Factory[] {
  const primaryFactoryIdByCompany = new Map<CompanyId, string>();
  for (const f of factories) {
    if (!primaryFactoryIdByCompany.has(f.companyId)) primaryFactoryIdByCompany.set(f.companyId, f.factoryId);
  }

  const effectByCompanyAndFactory = new Map<CompanyId, ReadonlyMap<string, CapexCapacityEffect>>();
  for (const company of capexState.companies) {
    const primaryFactoryId = primaryFactoryIdByCompany.get(company.companyId);
    if (primaryFactoryId === undefined) continue; // この会社のFactoryが1件も無い（fixture未整備等）。
    effectByCompanyAndFactory.set(company.companyId, computeCapacityEffectByFactoryForCompany(company.portfolio.projects, period, primaryFactoryId));
  }

  return factories.map((f) => {
    const effect = effectByCompanyAndFactory.get(f.companyId)?.get(f.factoryId);
    if (!effect) return f;
    if (
      effect.commonProcessing === 0 &&
      effect.hoso === 0 &&
      effect.pd === 0 &&
      effect.vap === 0 &&
      effect.freezingPackaging === 0 &&
      effect.coldStorage === 0
    ) {
      return f;
    }
    return {
      ...f,
      commonProcessingCapacity: hosoEqTons(unwrapUnit(f.commonProcessingCapacity) + effect.commonProcessing),
      // 【Test16】HOSO能力には明示的な上限がある（MAX_HOSO_CAPACITY_TONS）。
      // 共通処理能力が実質的な総量上限として効くが、それとは別に
      // 「HOSO専用能力そのものが24,000tを超えない」ことをここで保証する。
      // 上限に達した後の投資は能力を増やさない（投資判断側で上限を見るのは
      // 別の責務であり、ここは最終的な安全弁として機能する）。
      hosoCapacity: hosoEqTons(Math.min(MAX_HOSO_CAPACITY_TONS, unwrapUnit(f.hosoCapacity) + effect.hoso)),
      pdCapacity: hosoEqTons(unwrapUnit(f.pdCapacity) + effect.pd),
      vapCapacity: hosoEqTons(unwrapUnit(f.vapCapacity) + effect.vap),
      freezingPackagingCapacity: hosoEqTons(unwrapUnit(f.freezingPackagingCapacity) + effect.freezingPackaging),
      // 【Phase 8D-5】保管能力（ストック）。基礎値はFactoryに明示されていない場合が
      // あるため（Phase 8D以前に作られたラボ）、必ず resolveFactoryColdStorageCapacityTons
      // を経由して基礎値を解決してから加算する。基礎値の導出は決定論的なので、
      // 「当期の値 − 基礎Factoryの値」で増加ぶんを分解する既存の表示層の方法も
      // そのまま成立する。
      coldStorageCapacity: hosoEqTons(resolveFactoryColdStorageCapacityTons(f) + effect.coldStorage),
    };
  });
}

// ---------------------------------------------------------------------
// 2. 固定保守費（実装指示§5。Phase 8B-2Cでも計算式は変更していない）
// ---------------------------------------------------------------------

/**
 * 1社の投資案件ポートフォリオから、period当期の稼働中案件による固定保守費
 * 合計を算出する（実装指示§5の要件をすべて満たす）:
 *   - 稼働前は0。
 *   - 操業開始後は生産量ゼロでも発生（productionAcutalsに一切依存しない）。
 *   - 耐用年数を超えても継続（減価償却と異なり打ち切らない。保守は資産の
 *     簿価ではなく物理的な稼働状態に紐づく費用のため）。
 */
export function computeCapexMaintenanceCostUsd(
  projects: readonly CapitalProject[],
  params: CapexParameters,
  period: PeriodV2
): number {
  let total = 0;
  for (const project of projects) {
    if (project.status !== "completed" || project.completedPeriod === undefined || project.capitalizedAmountUsd === undefined) continue;
    if (!isCapexProjectOperationalAt(project, period)) continue;
    const template = params.templatesByType[project.projectType];
    total += project.capitalizedAmountUsd * template.maintenanceRatePerQuarter;
  }
  return total;
}
