// ShrimpX V2 — 32Q Management Console Phase 2: Simulation Run ストア（クライアント側）
//
// 【この層が解決する2つの課題（Phase 1の最大の残課題）】
//   A. ブラウザをリロードすると Simulation 結果が消える
//   B. Management Console と Analysis が同じ Simulation Run を共有していない
//
// どちらも「実行結果が simulationRunId を持つ1つの保存物になっていない」ことが原因
// だったため、保存・読み出し・現在選択中の実行の管理をこの1モジュールへ集約する。
// Console と Analysis は**同じ関数**を通してのみ Simulation Run に触れる。
//
// 【保存先は2系統。どちらに保存されたかを必ず呼び出し側へ返す】
//   server  … /api/v2/simulation-runs（Redis）。他のブラウザ・他の端末からも読める。
//   browser … このブラウザの localStorage。サーバー保存が使えない環境でも
//             リロードで消えないようにするための確実な足場。
// サーバー保存が失敗したことを黙って握りつぶさない（画面に保存先を出す）。

import { StoredSimulationRun, SimulationRunSummary } from "../../../lib/v2/companyLab/simulation/persistence/types";

/** localStorage のキー空間（他機能と衝突させない）。 */
const RUN_KEY_PREFIX = "shrimpx:v2:simulationRun:";
const INDEX_KEY = "shrimpx:v2:simulationRun:index";
const ACTIVE_RUN_KEY = "shrimpx:v2:simulationRun:active";

/**
 * ブラウザ内に残す実行数の上限。
 * 32Q 1本の保存物は実測で約2MBあり（scripts/simulationRunPayloadSize.ts）、
 * localStorage の一般的な上限（オリジンあたり約5MB）に対して余裕を持たせる必要がある。
 * 上限を超えた場合は古い実行から本体ごと消す。
 */
export const BROWSER_RUN_RETENTION_LIMIT = 2;

export type SimulationRunStorageLocation = "server" | "browser";

export interface SaveSimulationRunResult {
  readonly savedTo: readonly SimulationRunStorageLocation[];
  /** サーバー保存を試みて失敗した場合の理由（成功時・未試行時は null）。 */
  readonly serverError: string | null;
  /** ブラウザ保存に失敗した場合の理由（容量超過など。成功時は null）。 */
  readonly browserError: string | null;
}

function hasWindow(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

// ---------------------------------------------------------------------
// 1. ブラウザ保存
// ---------------------------------------------------------------------

function readBrowserIndex(): SimulationRunSummary[] {
  if (!hasWindow()) return [];
  try {
    const raw = window.localStorage.getItem(INDEX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SimulationRunSummary[]) : [];
  } catch {
    return [];
  }
}

function writeBrowserIndex(summaries: readonly SimulationRunSummary[]): void {
  if (!hasWindow()) return;
  window.localStorage.setItem(INDEX_KEY, JSON.stringify(summaries));
}

function summaryOf(stored: StoredSimulationRun): SimulationRunSummary {
  return {
    simulationRunId: stored.run.simulationRunId,
    scenarioId: stored.run.scenarioId,
    seed: stored.run.seed,
    requestedTurns: stored.run.requestedTurns,
    completedTurns: stored.run.completedTurns,
    stopReason: stored.run.stopReason,
    startedAt: stored.run.startedAt,
    completedAt: stored.run.completedAt,
    savedAt: stored.savedAt,
    gameParameterVersion: stored.run.gameParameterVersion,
    standardAiVersion: stored.run.standardAiVersion,
  };
}

/**
 * ブラウザへ保存する。容量超過（QuotaExceededError）で失敗した場合は、
 * **黙って諦めない** — 古い実行を消して再試行し、それでも入らなければ理由を返す。
 */
function saveToBrowser(stored: StoredSimulationRun): string | null {
  if (!hasWindow()) return "このブラウザには保存できません（localStorage が使えません）";
  const id = stored.run.simulationRunId;
  const payload = JSON.stringify(stored);

  const index = readBrowserIndex().filter((s) => s.simulationRunId !== id);
  index.unshift(summaryOf(stored));
  // 上限を超えた古い実行は本体ごと消す（index だけ消して本体を残すと孤児になる）。
  for (const evicted of index.slice(BROWSER_RUN_RETENTION_LIMIT)) {
    window.localStorage.removeItem(RUN_KEY_PREFIX + evicted.simulationRunId);
  }
  const kept = index.slice(0, BROWSER_RUN_RETENTION_LIMIT);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      window.localStorage.setItem(RUN_KEY_PREFIX + id, payload);
      writeBrowserIndex(kept);
      return null;
    } catch (e) {
      // 1回目の失敗では、今回保存する1本を除く既存の実行をすべて捨てて再試行する。
      if (attempt === 0) {
        for (const other of kept.filter((s) => s.simulationRunId !== id)) {
          window.localStorage.removeItem(RUN_KEY_PREFIX + other.simulationRunId);
        }
        writeBrowserIndex(kept.filter((s) => s.simulationRunId === id));
        continue;
      }
      return `ブラウザ保存に失敗しました（${e instanceof Error ? e.name : String(e)}。保存物は約${Math.round(payload.length / 1024)}KBです）`;
    }
  }
  return null;
}

function loadFromBrowser(simulationRunId: string): StoredSimulationRun | null {
  if (!hasWindow()) return null;
  try {
    const raw = window.localStorage.getItem(RUN_KEY_PREFIX + simulationRunId);
    if (!raw) return null;
    return JSON.parse(raw) as StoredSimulationRun;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// 2. サーバー保存（使えない環境では静かに諦めず、理由を返す）
// ---------------------------------------------------------------------

async function saveToServer(stored: StoredSimulationRun): Promise<string | null> {
  try {
    const response = await fetch("/api/v2/simulation-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(stored),
    });
    if (!response.ok) return `サーバー保存に失敗しました（HTTP ${response.status}）`;
    return null;
  } catch (e) {
    return `サーバー保存に到達できませんでした（${e instanceof Error ? e.message : String(e)}）`;
  }
}

async function loadFromServer(simulationRunId: string): Promise<StoredSimulationRun | null> {
  try {
    const response = await fetch(`/api/v2/simulation-runs/${encodeURIComponent(simulationRunId)}`);
    if (!response.ok) return null;
    return (await response.json()) as StoredSimulationRun;
  } catch {
    return null;
  }
}

async function listFromServer(): Promise<readonly SimulationRunSummary[]> {
  try {
    const response = await fetch("/api/v2/simulation-runs");
    if (!response.ok) return [];
    const body = (await response.json()) as { runs?: SimulationRunSummary[] };
    return body.runs ?? [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------
// 3. 公開API（Console と Analysis はここだけを使う）
// ---------------------------------------------------------------------

/**
 * Simulation Run を保存する。
 * ブラウザ保存を**必ず**行い、そのうえでサーバー保存を試みる
 * （サーバーが使えない環境でもリロードで結果が消えないことを保証するため）。
 */
export async function saveSimulationRun(stored: StoredSimulationRun): Promise<SaveSimulationRunResult> {
  const browserError = saveToBrowser(stored);
  const serverError = await saveToServer(stored);
  const savedTo: SimulationRunStorageLocation[] = [];
  if (browserError === null) savedTo.push("browser");
  if (serverError === null) savedTo.push("server");
  return { savedTo, serverError, browserError };
}

/**
 * Simulation Run を読み込む。
 * ブラウザ保存を先に見る（同じ端末で回した直後は必ずここにある＝最速で確実）。
 * 無ければサーバーから取りに行く（別端末で保存された実行を開ける）。
 */
export async function loadSimulationRun(simulationRunId: string): Promise<StoredSimulationRun | null> {
  return loadFromBrowser(simulationRunId) ?? (await loadFromServer(simulationRunId));
}

/**
 * 保存済み実行の一覧（Run selector 用）。
 * ブラウザ保存とサーバー保存を simulationRunId で統合し、保存が新しい順に並べる。
 * 同じ実行が両方にある場合はブラウザ側の要約を採る（同じ内容であり、往復を減らす）。
 */
export async function listSimulationRuns(): Promise<readonly SimulationRunSummary[]> {
  const browser = readBrowserIndex();
  const server = await listFromServer();
  const merged = new Map<string, SimulationRunSummary>();
  for (const s of server) merged.set(s.simulationRunId, s);
  for (const b of browser) merged.set(b.simulationRunId, b);
  return [...merged.values()].sort((a, b) => (a.savedAt === b.savedAt ? a.simulationRunId.localeCompare(b.simulationRunId) : a.savedAt < b.savedAt ? 1 : -1));
}

/** 現在選択中の Simulation Run。Console と Analysis はこれで同じ実行を見る。 */
export function getActiveSimulationRunId(): string | null {
  if (!hasWindow()) return null;
  return window.localStorage.getItem(ACTIVE_RUN_KEY);
}

export function setActiveSimulationRunId(simulationRunId: string): void {
  if (!hasWindow()) return;
  window.localStorage.setItem(ACTIVE_RUN_KEY, simulationRunId);
}

export function clearActiveSimulationRunId(): void {
  if (!hasWindow()) return;
  window.localStorage.removeItem(ACTIVE_RUN_KEY);
}

/**
 * URLの `?run=` を最優先、無ければ現在選択中の実行を返す。
 * Analysis へのリンクに run を付けておけば、**A/B比較のために2つのタブで
 * 別々の実行を開いても互いに壊れない**（選択状態がURL側にあるため）。
 */
export function resolveRequestedRunId(search: string | null | undefined): string | null {
  if (search) {
    const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
    const fromUrl = params.get("run");
    if (fromUrl) return fromUrl;
  }
  return getActiveSimulationRunId();
}
