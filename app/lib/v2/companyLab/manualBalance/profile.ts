// ShrimpX V2 — Balance Profile（固定Turnスケジュール型バランスモデル・BALANCE-PROFILE-1）
//
// 【目的】MANUAL-BALANCE-1 の ManualBalanceSchedule（販売市場価格指数・原料市場価格指数・
// 配当性向のTurn別設定）を、名前付きで保存・再利用できるようにする。
// 全社Standard AIの32Turn Runを、Balance Profileだけ差し替えて比較実行するための仕組み。
//
// 【Balance Profile は Scenario ではない】Scenario定義へ指数を書き込まない。
// 1つのテストRunは Scenario + Seed + Sales Model + Balance Profile + source commit
// で再現できる、という関係に保つ。
//
// 【第二のSSoTを作らない】実際にTurnごとへ適用される値の解決は、これまでどおり
// manualBalance/overrides.ts の resolveManualBalanceForTurn だけが行う。
// このファイルは「ManualBalanceSchedule を名前付きで持ち運ぶ入れ物」であり、
// 指数解決Engineを新しく持たない。
//
// 【Profileは予定、実績は別】Profileが持つのは「これから適用する予定のschedule」。
// そのRunで実際に適用された値の正本は SimulationSession.manualBalanceApplied である
// （Profileを後から編集しても過去Runの実績は動かない）。

import type { ManualBalanceSchedule } from "./overrides";
import { resolveManualBalanceForTurn } from "./overrides";
import { parseManualBalanceScheduleEntry } from "./portable";

/**
 * Balance Profile の仕様版。Profileの構造や意味が変わったときだけ上げる。
 * 取り込み側が未知の版を黙って解釈しないための印。
 */
export const BALANCE_PROFILE_SPEC_VERSION = "balance-profile-v1";

/** Run作成時にProfileを選ばなかった（＝手動補正なし）ことを表す固定ID。 */
export const NEUTRAL_BALANCE_PROFILE_ID = "neutral";
export const NEUTRAL_BALANCE_PROFILE_NAME = "Neutral（手動補正なし）";

export interface BalanceProfile {
  /** 安定した識別子。表示名の変更では変わらない。 */
  readonly profileId: string;
  /** 表示名。IDとしては使わない（同名のProfileが複数あり得る）。 */
  readonly profileName: string;
  readonly description: string;
  readonly specVersion: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** このProfileを切り出した元のRun（手動設定から保存した場合）。 */
  readonly createdFromRunId?: string;
  /**
   * このProfileを**作成したアプリ**のcommit。
   *
   * 【Runの計算commitではない】そのProfileを使ったRunがどのcommitで計算されたかは、
   * Run側の calculationCommitHistory（simulation/calculationCommit.ts）が持つ。
   * 混同すると、別のdeployで回したRunの結果をProfile作成時のcommitで説明してしまう。
   * 取得できない場合は "UNKNOWN" を入れ、推測で埋めない。
   */
  readonly sourceCommit?: string;
  /**
   * このProfileを切り出した元Runの、切り出し時点で最後に計算に使われたcommit。
   * 元Runが複数commitにまたがっていた場合は「最後に計算したcommit」であり、
   * 元Runの全Turnを代表しない。履歴が無ければ省略する（推測で埋めない）。
   */
  readonly sourceRunCalculationCommit?: string;
  readonly sourceScenarioId?: string;
  readonly sourceSeed?: string;
  readonly sourceSalesModelId?: string;
  /** 適用予定のTurn別スケジュール（実適用の解決は overrides.ts が行う）。 */
  readonly schedule: ManualBalanceSchedule;
}

/**
 * 手動補正なしのProfile。
 * 【重要】scheduleは空配列であり、Runへ適用するときは
 * balanceProfileScheduleForRun が undefined を返す＝configへキー自体を作らない。
 */
export function neutralBalanceProfile(now: string): BalanceProfile {
  return {
    profileId: NEUTRAL_BALANCE_PROFILE_ID,
    profileName: NEUTRAL_BALANCE_PROFILE_NAME,
    description: "手動補正を一切行わない既定のProfile。既存Runと完全に同一の挙動になる。",
    specVersion: BALANCE_PROFILE_SPEC_VERSION,
    createdAt: now,
    updatedAt: now,
    schedule: [],
  };
}

export function isNeutralBalanceProfile(profile: BalanceProfile | null | undefined): boolean {
  if (!profile) return true;
  return profile.profileId === NEUTRAL_BALANCE_PROFILE_ID || profile.schedule.length === 0;
}

/**
 * Run開始時にconfigへコピーするschedule。
 *
 * 【Neutralはキー自体を作らない】空スケジュールで undefined を返すことで、
 * createSimulationSession が conditional spread により
 * config.manualBalanceOverrides を**書き込まない**。これにより
 * 「Profile未選択のRun」は既存Runとビット単位で同一のconfigになる。
 */
export function balanceProfileScheduleForRun(profile: BalanceProfile | null | undefined): ManualBalanceSchedule | undefined {
  if (!profile || profile.schedule.length === 0) return undefined;
  return profile.schedule;
}

/**
 * scheduleの内容から安定した指紋を作る（非暗号・FNV-1a 32bit）。
 *
 * 【独自の暗号基盤は作らない】用途は「同じ内容かどうかの目視照合」だけであり、
 * 改竄検知ではない。衝突耐性より「同じ入力なら常に同じ短い文字列」を優先する。
 * recordedAt を含めると保存のたびに変わってしまうため、**適用に効く項目だけ**を
 * 正規化して対象にする（kind / 対象Turn / 3設定値）。
 */
export function balanceProfileFingerprint(schedule: ManualBalanceSchedule): string {
  const canonical = schedule
    .map((entry) => {
      if (entry.kind === "release") return `r:${entry.effectiveFromTurn}`;
      const s = entry.settings;
      const dividend = s.dividendPayout.kind === "specified" ? String(s.dividendPayout.payoutRatio) : "-";
      const sales = s.salesPriceIndex === undefined ? "-" : String(s.salesPriceIndex);
      const raw = s.rawMarketPriceIndex === undefined ? "-" : String(s.rawMarketPriceIndex);
      const turn = entry.kind === "perTurn" ? entry.turn : entry.effectiveFromTurn;
      return `${entry.kind === "perTurn" ? "p" : "c"}:${turn}:${dividend}:${sales}:${raw}`;
    })
    .sort()
    .join("|");

  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// --- Run側へ残す由来情報 ---------------------------------------------------

/**
 * そのRunがどのProfileから始まったかの記録。
 *
 * 【予定であって実績ではない】ここに残るのは「Run開始時にコピー元となったProfile」
 * であり、その後GMが手動で設定を変えた場合も**この値は変わらない**。
 * 実際に各Turnへ適用された値は SimulationSession.manualBalanceApplied を見る。
 */
export interface AppliedBalanceProfileRef {
  readonly appliedBalanceProfileId: string;
  readonly appliedBalanceProfileName: string;
  readonly appliedBalanceProfileSpecVersion: string;
  /** コピーした時点のscheduleの指紋。手動変更の有無を照合するのに使う。 */
  readonly appliedBalanceProfileFingerprint: string;
}

export function buildAppliedBalanceProfileRef(profile: BalanceProfile): AppliedBalanceProfileRef {
  return {
    appliedBalanceProfileId: profile.profileId,
    appliedBalanceProfileName: profile.profileName,
    appliedBalanceProfileSpecVersion: profile.specVersion,
    appliedBalanceProfileFingerprint: balanceProfileFingerprint(profile.schedule),
  };
}

/**
 * 現在のRunのscheduleが、開始時にコピーしたProfileから手で変更されているか。
 *
 * 【Profileへ自動反映しない】この判定はあくまで表示用である。Runの手動変更を
 * Profile本体へ書き戻す経路は作らない（明示的な「Profileとして保存」操作だけが
 * Profileを更新する）。
 */
export function isScheduleDriftedFromProfile(
  ref: AppliedBalanceProfileRef | null | undefined,
  currentSchedule: ManualBalanceSchedule | undefined
): boolean {
  if (!ref) return false;
  return balanceProfileFingerprint(currentSchedule ?? []) !== ref.appliedBalanceProfileFingerprint;
}

/**
 * 進行中のRunへProfileを再適用したscheduleを返す（純粋関数）。
 *
 * 【過去Turnを絶対に変更しない】fromTurn（＝次の未実行Turn）より前を対象にする
 * エントリは一切作らない。まずfromTurnで解除を1件入れて、それまでに入れた手修正を
 * fromTurn以降について無効化し、そのうえでProfileのうち fromTurn 以降に効く
 * エントリだけを積み直す。確定済みTurnの記録・結果は書き換わらない。
 *
 * 【Profile本体は変更しない】この関数はRun側のscheduleを作るだけで、
 * 引数のprofileには触れない。
 */
export function reapplyProfileScheduleFromTurn(
  currentSchedule: ManualBalanceSchedule | undefined,
  profile: BalanceProfile,
  fromTurn: number,
  recordedAt: string
): ManualBalanceSchedule {
  const base = currentSchedule ?? [];
  const release: ManualBalanceSchedule = [
    { kind: "release", effectiveFromTurn: fromTurn, source: "MANUAL_OVERRIDE", recordedAt },
  ];

  /**
   * 【解除より厳密に後の時刻にする】resolveManualBalanceForTurn は
   * 「解除より**後に**記録されたエントリだけを有効」とみなす（厳密比較）。
   * 解除と積み直すエントリを同じ時刻にすると、積み直した側がすべて
   * 解除済み扱いになり、再適用したのに手動補正なしへ戻ってしまう。
   * 同一操作の中での実際の順序（解除 → 積み直し）をそのまま時刻へ反映する。
   */
  const reappliedAt = addOneMillisecond(recordedAt);

  /**
   * fromTurn 以降を対象にするエントリは、Profileが持つ形のまま積み直す。
   *
   * 【全部を fromTurn へ引き上げてはいけない】fromTurnより前から続く継続設定を
   * すべて effectiveFromTurn=fromTurn へ引き上げると、Profileのブロック構造
   * （Turn1-4 / 5-8 / 9- のような切り替え）が同じ effectiveFromTurn へ潰れ、
   * どのブロックが fromTurn を支配していたのかが失われる。
   * fromTurn より後のブロック境界はそのまま保つ。
   */
  const laterEntries = profile.schedule
    .filter((entry) => {
      if (entry.kind === "perTurn") return entry.turn >= fromTurn;
      if (entry.kind === "release") return entry.effectiveFromTurn > fromTurn;
      return entry.effectiveFromTurn > fromTurn;
    })
    .map((entry) => ({ ...entry, recordedAt: reappliedAt }));

  /**
   * fromTurn 時点でProfileが解決する設定を、fromTurnから有効な継続設定として1件だけ入れる。
   * これで「fromTurnを支配していたブロック」が正しく復元される
   * （解決には実適用と同じ resolveManualBalanceForTurn を使い、独自解釈をしない）。
   * Profileがその時点で何も指定していなければ何も入れない（解除のまま）。
   */
  const governing = resolveManualBalanceForTurn(profile.schedule, fromTurn);
  const governingEntry: ManualBalanceSchedule =
    governing.appliedSource.kind === "none"
      ? []
      : [
          {
            kind: "continuing",
            effectiveFromTurn: fromTurn,
            settings: governing.settings,
            source: "MANUAL_OVERRIDE",
            recordedAt: reappliedAt,
          },
        ];

  return [...base, ...release, ...governingEntry, ...laterEntries];
}

/**
 * ISO8601の時刻を1ミリ秒進める。解析できない文字列はそのまま返す
 * （捏造した時刻を作らない。その場合は呼び出し側の順序保証が効かないだけ）。
 */
function addOneMillisecond(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  return new Date(parsed + 1).toISOString();
}

// --- export / import -------------------------------------------------------

export interface BalanceProfileDocument {
  readonly format: "shrimpx-v2-balance-profile";
  readonly formatVersion: 1;
  readonly exportedAt: string;
  readonly profile: BalanceProfile;
}

export function buildBalanceProfileDocument(profile: BalanceProfile, exportedAt: string): BalanceProfileDocument {
  return { format: "shrimpx-v2-balance-profile", formatVersion: 1, exportedAt, profile };
}

/** 取り込み時に、作成元条件と現在の条件が違う点。 */
export interface BalanceProfileConditionDifference {
  readonly field: "specVersion" | "sourceScenarioId" | "sourceSeed" | "sourceSalesModelId" | "sourceCommit";
  readonly imported: string;
  readonly current: string;
}

/** 取り込み時に照合する現在の条件。 */
export interface BalanceProfileCurrentConditions {
  readonly specVersion: string;
  readonly scenarioId: string;
  readonly seed: string;
  readonly salesModelId: string | null;
  readonly sourceCommit: string;
}

export type BalanceProfileImportResult =
  | {
      readonly ok: true;
      readonly profile: BalanceProfile;
      /**
       * 空でなければ、別条件で作られたProfileを取り込もうとしている。
       * 【自動拒否しない】別Scenarioへ意図的に同じProfileを適用する運用があるため、
       * 警告として返すだけにする。採否は人が決める。
       */
      readonly conditionDifferences: readonly BalanceProfileConditionDifference[];
    }
  | { readonly ok: false; readonly error: string };

function readOptionalString(value: unknown): string | undefined | "invalid" {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  return "invalid";
}

export function parseBalanceProfileDocument(
  json: string,
  current: BalanceProfileCurrentConditions
): BalanceProfileImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: "JSONとして読み取れませんでした。" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, error: "Balance Profileのファイルではありません。" };
  }
  const p = parsed as Record<string, unknown>;
  if (p.format !== "shrimpx-v2-balance-profile") {
    return { ok: false, error: "Balance Profileのファイルではありません（formatが一致しません）。" };
  }
  if (p.formatVersion !== 1) {
    return { ok: false, error: `未知のformatVersionです（このアプリが読めるのは1のみ）: ${String(p.formatVersion)}` };
  }
  if (typeof p.profile !== "object" || p.profile === null) {
    return { ok: false, error: "profileが含まれていません。" };
  }
  const r = p.profile as Record<string, unknown>;

  if (typeof r.profileId !== "string" || r.profileId.trim() === "") {
    return { ok: false, error: "profileIdが不正です。" };
  }
  if (typeof r.profileName !== "string" || r.profileName.trim() === "") {
    return { ok: false, error: "profileNameが不正です。" };
  }
  if (typeof r.specVersion !== "string") {
    return { ok: false, error: "specVersionが不正です。" };
  }
  const description = typeof r.description === "string" ? r.description : "";
  const createdAt = typeof r.createdAt === "string" ? r.createdAt : "";
  const updatedAt = typeof r.updatedAt === "string" ? r.updatedAt : createdAt;

  const optionals = {
    createdFromRunId: readOptionalString(r.createdFromRunId),
    sourceCommit: readOptionalString(r.sourceCommit),
    sourceRunCalculationCommit: readOptionalString(r.sourceRunCalculationCommit),
    sourceScenarioId: readOptionalString(r.sourceScenarioId),
    sourceSeed: readOptionalString(r.sourceSeed),
    sourceSalesModelId: readOptionalString(r.sourceSalesModelId),
  };
  for (const [key, value] of Object.entries(optionals)) {
    if (value === "invalid") return { ok: false, error: `${key}が不正です。` };
  }

  if (!Array.isArray(r.schedule)) {
    return { ok: false, error: "scheduleが配列ではありません。" };
  }
  // 【共有パーサー】Manual Balance の持ち出し／取り込みとまったく同じ検証を通す
  // （Profile用に第二の検証を作らない）。1件でも壊れていれば全体を拒否する。
  const schedule = [];
  for (const [index, rawEntry] of r.schedule.entries()) {
    const entry = parseManualBalanceScheduleEntry(rawEntry);
    if (!entry) {
      return { ok: false, error: `schedule[${index}] を読み取れませんでした。ファイル全体を取り込みません。` };
    }
    schedule.push(entry);
  }

  const profile: BalanceProfile = {
    profileId: r.profileId,
    profileName: r.profileName,
    description,
    specVersion: r.specVersion,
    createdAt,
    updatedAt,
    ...(optionals.createdFromRunId !== undefined ? { createdFromRunId: optionals.createdFromRunId } : {}),
    ...(optionals.sourceCommit !== undefined ? { sourceCommit: optionals.sourceCommit } : {}),
    ...(optionals.sourceRunCalculationCommit !== undefined
      ? { sourceRunCalculationCommit: optionals.sourceRunCalculationCommit }
      : {}),
    ...(optionals.sourceScenarioId !== undefined ? { sourceScenarioId: optionals.sourceScenarioId } : {}),
    ...(optionals.sourceSeed !== undefined ? { sourceSeed: optionals.sourceSeed } : {}),
    ...(optionals.sourceSalesModelId !== undefined ? { sourceSalesModelId: optionals.sourceSalesModelId } : {}),
    schedule,
  };

  const conditionDifferences: BalanceProfileConditionDifference[] = [];
  const compare = (
    field: BalanceProfileConditionDifference["field"],
    imported: string | undefined | null,
    cur: string | undefined | null
  ): void => {
    // 作成元が記録されていないProfileは「違う」とは言えないため、差分に数えない。
    if (imported === undefined || imported === null) return;
    const a = imported;
    const b = cur ?? "(未指定)";
    if (a !== b) conditionDifferences.push({ field, imported: a, current: b });
  };
  compare("specVersion", profile.specVersion, current.specVersion);
  compare("sourceScenarioId", profile.sourceScenarioId, current.scenarioId);
  compare("sourceSeed", profile.sourceSeed, current.seed);
  compare("sourceSalesModelId", profile.sourceSalesModelId, current.salesModelId);
  compare("sourceCommit", profile.sourceCommit, current.sourceCommit);

  return { ok: true, profile, conditionDifferences };
}
