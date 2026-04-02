import { useEffect, useMemo, useState } from "react";

const DEFAULT_STATS = { api: 0, cache: 0, fallback: 0, skipped: 0 };

export default function App() {
  const [enabled, setEnabled] = useState(true);
  const [count, setCount] = useState(0);
  const [budgetLimit, setBudgetLimit] = useState(120);
  const [budgetRemaining, setBudgetRemaining] = useState(120);
  const [stats, setStats] = useState(DEFAULT_STATS);
  const [lastError, setLastError] = useState(null);
  const [isSavingBudget, setIsSavingBudget] = useState(false);

  const health = useMemo(() => {
    if (budgetRemaining <= 0) return { label: "Budget Reached", tone: "bg-amber-400/20 text-amber-200 border-amber-300/40" };
    if (lastError) return { label: "Fallback Mode", tone: "bg-orange-400/20 text-orange-200 border-orange-300/40" };
    return { label: "API Active", tone: "bg-emerald-400/20 text-emerald-200 border-emerald-300/40" };
  }, [budgetRemaining, lastError]);

  useEffect(() => {
    if (!chrome?.runtime) return undefined;

    const refreshStatus = () => {
      chrome.runtime.sendMessage({ type: "GET_STATUS" }, (resp) => {
        if (chrome.runtime.lastError || !resp?.ok) return;
        setEnabled(!!resp.enabled);
        setCount(Number(resp.count) || 0);
        setBudgetLimit(Number(resp.budgetLimit) || 120);
        setBudgetRemaining(Number(resp.budgetRemaining) || 0);
        setStats(resp.stats || DEFAULT_STATS);
        setLastError(resp.lastError || null);
      });
    };

    const onStorageChanged = (_changes, area) => {
      if (area !== "local") return;
      refreshStatus();
    };

    refreshStatus();
    chrome.storage.onChanged.addListener(onStorageChanged);
    const poll = setInterval(refreshStatus, 4000);

    return () => {
      chrome.storage.onChanged.removeListener(onStorageChanged);
      clearInterval(poll);
    };
  }, []);

  const toggle = () => {
    const next = !enabled;
    setEnabled(next);
    chrome.runtime.sendMessage({ type: "SET_ENABLED", enabled: next });
  };

  const saveBudget = () => {
    const nextLimit = Number(budgetLimit);
    if (!Number.isFinite(nextLimit)) return;

    setIsSavingBudget(true);
    chrome.runtime.sendMessage({ type: "SET_BUDGET_LIMIT", limit: nextLimit }, (resp) => {
      setIsSavingBudget(false);
      if (chrome.runtime.lastError || !resp?.ok) return;
      setBudgetLimit(Number(resp.budgetLimit) || nextLimit);
      setBudgetRemaining(Number(resp.budgetRemaining) || 0);
    });
  };

  const errorPreview = lastError?.message ? `${lastError.code}: ${lastError.message}` : "No recent errors";

  return (
    <div className="w-96 min-h-[360px] rounded-2xl border border-slate-700 bg-gradient-to-br from-slate-950 via-slate-900 to-slate-800 p-4 text-slate-100">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-wide">De-Hype v2</h1>
          <p className="text-sm text-slate-300">Practical headline de-clickbaiting</p>
        </div>
        <span className={`rounded-md border px-2 py-1 text-xs font-medium ${health.tone}`}>{health.label}</span>
      </div>

      <div className="mt-4 rounded-xl border border-slate-600 bg-black/30 p-3">
        <div className="flex items-center justify-between">
          <span className="text-sm">Enable De-Hype</span>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={toggle}
            className="relative inline-flex h-7 w-14 items-center rounded-full bg-slate-600 transition-colors focus:outline-none focus:ring-2 focus:ring-cyan-300"
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${enabled ? "translate-x-8" : "translate-x-1"}`}
            />
          </button>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-4 gap-2 text-center">
        <div className="rounded-lg border border-slate-700 bg-slate-900/70 p-2">
          <div className="text-[10px] uppercase tracking-wide text-slate-400">Today</div>
          <div className="mt-1 text-lg font-semibold">{count}</div>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-900/70 p-2">
          <div className="text-[10px] uppercase tracking-wide text-slate-400">API</div>
          <div className="mt-1 text-lg font-semibold text-cyan-300">{stats.api || 0}</div>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-900/70 p-2">
          <div className="text-[10px] uppercase tracking-wide text-slate-400">Cache</div>
          <div className="mt-1 text-lg font-semibold text-emerald-300">{stats.cache || 0}</div>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-900/70 p-2">
          <div className="text-[10px] uppercase tracking-wide text-slate-400">Fallback</div>
          <div className="mt-1 text-lg font-semibold text-amber-300">{stats.fallback || 0}</div>
        </div>
      </div>

      <div className="mt-3 rounded-xl border border-slate-700 bg-slate-900/60 p-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-400">Daily API Budget</div>
            <div className="text-sm text-slate-200">{budgetRemaining} requests left today</div>
          </div>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <input
            type="number"
            min="10"
            max="5000"
            value={budgetLimit}
            onChange={(event) => setBudgetLimit(event.target.value)}
            className="w-24 rounded-md border border-slate-600 bg-slate-950 px-2 py-1 text-sm text-slate-100 focus:border-cyan-400 focus:outline-none"
          />
          <button
            type="button"
            onClick={saveBudget}
            className="rounded-md border border-cyan-300/50 bg-cyan-500/20 px-3 py-1 text-xs font-semibold text-cyan-100 hover:bg-cyan-500/30"
          >
            {isSavingBudget ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      <div className="mt-3 rounded-xl border border-slate-700 bg-black/25 p-3">
        <div className="text-[11px] uppercase tracking-wide text-slate-400">Last Error</div>
        <div className="mt-1 line-clamp-3 text-xs text-slate-200">{errorPreview}</div>
      </div>
    </div>
  );
}
