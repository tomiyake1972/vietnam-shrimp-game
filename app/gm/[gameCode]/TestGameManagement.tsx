"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SnapshotSummary } from "../../lib/gameTypes";

const TOKEN_STORAGE_KEY = "stagingAdminToken";

interface Props {
  gameCode: string;
  onChanged: () => void;
}

type ConfirmStep = null | "reset" | "delete" | { type: "restore"; snapshotId: string; label: string };

export default function TestGameManagement({ gameCode, onChanged }: Props) {
  const router = useRouter();
  const [adminToken, setAdminToken] = useState(() =>
    typeof window === "undefined" ? "" : sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? ""
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmStep, setConfirmStep] = useState<ConfirmStep>(null);
  const [deleteConfirmInput, setDeleteConfirmInput] = useState("");
  const [cloneMode, setCloneMode] = useState<"current" | "initial">("current");
  const [cloneSeedMode, setCloneSeedMode] = useState<"same" | "new">("new");
  const [snapshotLabel, setSnapshotLabel] = useState("");
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // 管理トークンはReact state + sessionStorageのみで保持し、localStorageや
  // GameSession・Redisには一切保存しない。画面再読み込みで消えても構わない。
  function updateToken(value: string) {
    setAdminToken(value);
    if (value) sessionStorage.setItem(TOKEN_STORAGE_KEY, value);
    else sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  }

  async function loadSnapshots() {
    const res = await fetch(`/api/game/${gameCode}/snapshots`);
    if (res.ok) {
      const data = await res.json();
      setSnapshots(data.snapshots ?? []);
    }
  }

  useEffect(() => {
    fetch(`/api/game/${gameCode}/snapshots`).then((r) => (r.ok ? r.json() : null)).then((data) => {
      if (data) setSnapshots(data.snapshots ?? []);
    });
  }, [gameCode]);

  async function adminRequest(url: string, options: RequestInit = {}): Promise<{ ok: boolean; data: unknown }> {
    const res = await fetch(url, {
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        Authorization: `Bearer ${adminToken}`,
      },
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
  }

  async function handleReset() {
    setBusy("reset");
    setMessage(null);
    try {
      const { ok, data } = await adminRequest(`/api/game/${gameCode}/admin/reset`, { method: "POST" });
      if (!ok) {
        setMessage({ type: "error", text: (data as { error?: string })?.error || "初期化に失敗しました" });
        return;
      }
      setMessage({ type: "success", text: "ゲームを初期状態に戻しました。" });
      setConfirmStep(null);
      onChanged();
      loadSnapshots();
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete() {
    setBusy("delete");
    setMessage(null);
    try {
      const { ok, data } = await adminRequest(`/api/game/${gameCode}/admin`, {
        method: "DELETE",
        body: JSON.stringify({ confirmGameCode: deleteConfirmInput }),
      });
      if (!ok) {
        setMessage({ type: "error", text: (data as { error?: string })?.error || "削除に失敗しました" });
        return;
      }
      router.push("/gm");
    } finally {
      setBusy(null);
    }
  }

  async function handleClone() {
    setBusy("clone");
    setMessage(null);
    try {
      const { ok, data } = await adminRequest(`/api/game/${gameCode}/admin/clone`, {
        method: "POST",
        body: JSON.stringify({ mode: cloneMode, seedMode: cloneSeedMode }),
      });
      if (!ok) {
        setMessage({ type: "error", text: (data as { error?: string })?.error || "複製に失敗しました" });
        return;
      }
      const newCode = (data as { gameCode: string }).gameCode;
      setMessage({ type: "success", text: `複製が完了しました（新ゲームコード: ${newCode}）` });
    } finally {
      setBusy(null);
    }
  }

  async function handleCreateSnapshot() {
    setBusy("snapshot-create");
    setMessage(null);
    try {
      const { ok, data } = await adminRequest(`/api/game/${gameCode}/snapshots`, {
        method: "POST",
        body: JSON.stringify({ label: snapshotLabel }),
      });
      if (!ok) {
        setMessage({ type: "error", text: (data as { error?: string })?.error || "保存に失敗しました" });
        return;
      }
      setMessage({ type: "success", text: "現在の状態を保存しました。" });
      setSnapshotLabel("");
      loadSnapshots();
    } finally {
      setBusy(null);
    }
  }

  async function handleRestore(snapshotId: string) {
    setBusy(`restore-${snapshotId}`);
    setMessage(null);
    try {
      const { ok, data } = await adminRequest(`/api/game/${gameCode}/snapshots/${snapshotId}/restore`, { method: "POST" });
      if (!ok) {
        setMessage({ type: "error", text: (data as { error?: string })?.error || "復元に失敗しました" });
        return;
      }
      setMessage({ type: "success", text: "スナップショットへ復元しました。" });
      setConfirmStep(null);
      onChanged();
      loadSnapshots();
    } finally {
      setBusy(null);
    }
  }

  async function handleDeleteSnapshot(snapshotId: string) {
    setBusy(`snapshot-delete-${snapshotId}`);
    setMessage(null);
    try {
      const { ok, data } = await adminRequest(`/api/game/${gameCode}/snapshots/${snapshotId}`, { method: "DELETE" });
      if (!ok) {
        setMessage({ type: "error", text: (data as { error?: string })?.error || "削除に失敗しました" });
        return;
      }
      loadSnapshots();
    } finally {
      setBusy(null);
    }
  }

  const isBusy = busy !== null;

  return (
    <div className="bg-gray-800 rounded-2xl p-6 mb-6 border border-red-900/50">
      <h2 className="text-lg font-semibold mb-1">⚠️ テストゲーム管理</h2>
      <p className="text-xs text-gray-400 mb-4">破壊的な操作です。管理トークンを入力してから実行してください。</p>

      <div className="mb-4">
        <label className="block text-xs text-gray-400 mb-1">管理トークン</label>
        <input
          type="password"
          value={adminToken}
          onChange={(e) => updateToken(e.target.value)}
          placeholder="STAGING_ADMIN_TOKEN"
          autoComplete="off"
          className="w-full bg-gray-700 rounded-lg px-3 py-2 text-sm font-mono"
        />
      </div>

      {message && (
        <div className={`mb-4 rounded-lg px-3 py-2 text-sm ${message.type === "success" ? "bg-green-900/40 text-green-400" : "bg-red-900/40 text-red-400"}`}>
          {message.text}
        </div>
      )}

      <div className="flex flex-wrap gap-2 mb-4">
        <button
          onClick={() => setConfirmStep("reset")}
          disabled={isBusy}
          className="px-4 py-2 bg-orange-700 hover:bg-orange-600 rounded-lg text-sm font-semibold disabled:opacity-50"
        >
          初期状態に戻す
        </button>
        <button
          onClick={() => { setConfirmStep(null); handleClone(); }}
          disabled={isBusy}
          className="px-4 py-2 bg-blue-700 hover:bg-blue-600 rounded-lg text-sm font-semibold disabled:opacity-50"
        >
          {busy === "clone" ? "複製中..." : "このゲームを複製"}
        </button>
        <button
          onClick={() => { setDeleteConfirmInput(""); setConfirmStep("delete"); }}
          disabled={isBusy}
          className="px-4 py-2 bg-red-800 hover:bg-red-700 rounded-lg text-sm font-semibold disabled:opacity-50"
        >
          このテストゲームを削除
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-2 text-xs text-gray-400">
        <span>複製方式:</span>
        <label className="flex items-center gap-1">
          <input type="radio" checked={cloneMode === "current"} onChange={() => setCloneMode("current")} /> 現在の状態
        </label>
        <label className="flex items-center gap-1">
          <input type="radio" checked={cloneMode === "initial"} onChange={() => setCloneMode("initial")} /> 初期状態
        </label>
        <span className="ml-3">乱数シード:</span>
        <label className="flex items-center gap-1">
          <input type="radio" checked={cloneSeedMode === "same"} onChange={() => setCloneSeedMode("same")} /> 同じシード
        </label>
        <label className="flex items-center gap-1">
          <input type="radio" checked={cloneSeedMode === "new"} onChange={() => setCloneSeedMode("new")} /> 新しいシード
        </label>
      </div>

      {confirmStep === "reset" && (
        <div className="bg-orange-900/30 border border-orange-700 rounded-xl p-4 mb-4 text-sm">
          <p className="mb-1">ゲームコード <span className="font-bold text-yellow-400">{gameCode}</span> を初期状態に戻します。</p>
          <p className="text-gray-400 mb-3">意思決定とターン結果は削除されます。スナップショットは維持されます。</p>
          <div className="flex gap-2">
            <button onClick={() => setConfirmStep(null)} disabled={isBusy} className="px-3 py-1.5 bg-gray-700 rounded-lg text-sm">キャンセル</button>
            <button onClick={handleReset} disabled={isBusy} className="px-3 py-1.5 bg-orange-700 hover:bg-orange-600 rounded-lg text-sm font-semibold disabled:opacity-50">
              {busy === "reset" ? "実行中..." : "実行する"}
            </button>
          </div>
        </div>
      )}

      {confirmStep === "delete" && (
        <div className="bg-red-900/30 border border-red-700 rounded-xl p-4 mb-4 text-sm">
          <p className="mb-2">確認のためゲームコード <span className="font-bold text-yellow-400">{gameCode}</span> を入力してください。</p>
          <input
            type="text"
            value={deleteConfirmInput}
            onChange={(e) => setDeleteConfirmInput(e.target.value.toUpperCase())}
            className="w-full bg-gray-700 rounded-lg px-3 py-2 text-sm font-mono tracking-widest mb-3"
            placeholder={gameCode}
          />
          <div className="flex gap-2">
            <button onClick={() => setConfirmStep(null)} disabled={isBusy} className="px-3 py-1.5 bg-gray-700 rounded-lg text-sm">キャンセル</button>
            <button
              onClick={handleDelete}
              disabled={isBusy || deleteConfirmInput !== gameCode}
              className="px-3 py-1.5 bg-red-700 hover:bg-red-600 rounded-lg text-sm font-semibold disabled:opacity-50"
            >
              {busy === "delete" ? "削除中..." : "削除する"}
            </button>
          </div>
        </div>
      )}

      <div className="border-t border-gray-700 pt-4 mt-2">
        <h3 className="text-sm font-semibold mb-2">現在の状態を保存</h3>
        <div className="flex flex-wrap gap-2 mb-4">
          <input
            type="text"
            value={snapshotLabel}
            onChange={(e) => setSnapshotLabel(e.target.value)}
            placeholder="ラベル（省略可、例：Q2開始前）"
            maxLength={100}
            className="flex-1 min-w-[200px] bg-gray-700 rounded-lg px-3 py-2 text-sm"
          />
          <button
            onClick={handleCreateSnapshot}
            disabled={isBusy}
            className="px-4 py-2 bg-green-700 hover:bg-green-600 rounded-lg text-sm font-semibold disabled:opacity-50"
          >
            {busy === "snapshot-create" ? "保存中..." : "現在の状態を保存"}
          </button>
        </div>

        <h3 className="text-sm font-semibold mb-2">スナップショット一覧（{snapshots.length}/20）</h3>
        {snapshots.length === 0 ? (
          <p className="text-xs text-gray-500">保存されたスナップショットはありません。</p>
        ) : (
          <div className="space-y-2">
            {snapshots.map((s) => (
              <div key={s.id} className="bg-gray-700/60 rounded-lg px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm">
                    <span className="font-semibold">{s.label || "（ラベルなし）"}</span>
                    <span className="text-gray-400 text-xs ml-2">{s.year}年Q{s.quarter}・F{s.phase}</span>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setConfirmStep({ type: "restore", snapshotId: s.id, label: s.label })}
                      disabled={isBusy}
                      className="text-xs px-3 py-1 bg-blue-700 hover:bg-blue-600 rounded disabled:opacity-50"
                    >
                      この状態に戻す
                    </button>
                    <button
                      onClick={() => handleDeleteSnapshot(s.id)}
                      disabled={isBusy}
                      className="text-xs px-3 py-1 bg-gray-600 hover:bg-gray-500 rounded disabled:opacity-50"
                    >
                      {busy === `snapshot-delete-${s.id}` ? "削除中..." : "削除"}
                    </button>
                  </div>
                </div>
                <div className="text-xs text-gray-500 mt-1">保存日時: {new Date(s.createdAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}</div>
                {confirmStep !== null && typeof confirmStep === "object" && confirmStep.snapshotId === s.id && (
                  <div className="bg-blue-900/30 border border-blue-700 rounded-lg p-3 mt-2 text-xs">
                    <p className="mb-2">現在の状態は自動保存された後、選択したスナップショット（{s.label || "（ラベルなし）"}）へ戻ります。</p>
                    <div className="flex gap-2">
                      <button onClick={() => setConfirmStep(null)} disabled={isBusy} className="px-3 py-1 bg-gray-700 rounded">キャンセル</button>
                      <button onClick={() => handleRestore(s.id)} disabled={isBusy} className="px-3 py-1 bg-blue-700 hover:bg-blue-600 rounded font-semibold disabled:opacity-50">
                        {busy === `restore-${s.id}` ? "復元中..." : "復元する"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="text-xs text-gray-500 mt-4">
        <Link href="/gm" className="underline hover:text-gray-300">← GMコンソールへ戻る</Link>
      </p>
    </div>
  );
}
