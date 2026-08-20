// ShrimpX V2 — Independent Player Flow: GM Console用 Player Seat client API呼び出し
//
// app/api/v2/management/player-seats/**への薄いfetchラッパー。既存のGM/admin
// セッションCookie（ブラウザが自動送信）で認証される。新しい計算・状態は持たない。

export interface PlayerSeatStatus {
  readonly companyId: string;
  readonly displayName: string;
  readonly controlMode: "STANDARD_AI" | "PLAYER";
  readonly hasSeat: boolean;
  readonly joinIssued: boolean;
  readonly joined: boolean;
  readonly hasSubmittedThisTurn: boolean;
  readonly lastSubmittedTurn: number | null;
  readonly lastSubmittedAt: string | null;
}

export interface PlayerSeatListResponse {
  readonly runId: string;
  readonly currentTurn: number | null;
  readonly gameEndedAt: string | null;
  readonly companies: readonly PlayerSeatStatus[];
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<{ readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: string }> {
  try {
    const response = await fetch(url, init);
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const message = body && typeof body === "object" && "error" in body ? (body as { error?: { message?: string } }).error?.message : undefined;
      return { ok: false, error: message ?? `HTTP ${response.status}` };
    }
    return { ok: true, data: body as T };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function listPlayerSeats(runId: string) {
  return fetchJson<PlayerSeatListResponse>(`/api/v2/management/player-seats/${encodeURIComponent(runId)}`);
}

export function issueOrRegeneratePlayerJoinLink(runId: string, companyId: string) {
  return fetchJson<{ readonly runId: string; readonly companyId: string; readonly joinUrl: string; readonly issuedAt: string }>(
    `/api/v2/management/player-seats/${encodeURIComponent(runId)}/${encodeURIComponent(companyId)}`,
    { method: "POST" }
  );
}

export function revokePlayerSeat(runId: string, companyId: string) {
  return fetchJson<{ readonly runId: string; readonly companyId: string; readonly revoked: boolean }>(
    `/api/v2/management/player-seats/${encodeURIComponent(runId)}/${encodeURIComponent(companyId)}`,
    { method: "DELETE" }
  );
}

/** GM代理操作（「この会社を操作」経由の確定）のたびに、Seat側の副次記録だけを追いつかせる。 */
export function recordGmProxySubmission(runId: string, companyId: string, turn: number) {
  return fetchJson<{ readonly runId: string; readonly companyId: string; readonly lastSubmittedTurn: number | null }>(
    `/api/v2/management/player-seats/${encodeURIComponent(runId)}/${encodeURIComponent(companyId)}/record-submission`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ turn }) }
  );
}
