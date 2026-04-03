import { useEffect, useMemo, useState } from "react";

const DEFAULT_STATS = { api: 0, cache: 0, fallback: 0, skipped: 0 };
const DEFAULT_SITE_TOGGLES = { youtube: true, cnn: true, verge: true, generic: true };
const DEFAULT_RECAP = {
  rewrites: 0,
  averageReduction: 0,
  sourceCounts: { api: 0, cache: 0, fallback: 0 },
  topRemovedTerms: [],
  biggestDrops: []
};

const modeOptions = [
  { value: "subtle", label: "Subtle" },
  { value: "balanced", label: "Balanced" },
  { value: "aggressive", label: "Aggressive" }
];

const siteLabels = {
  youtube: "YouTube",
  cnn: "CNN",
  verge: "The Verge",
  generic: "Generic"
};

const sendRuntimeMessage = (message) =>
  new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: "No response" });
    });
  });

const getActiveTabId = () =>
  new Promise((resolve) => {
    if (!chrome.tabs?.query) {
      resolve(null);
      return;
    }

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs?.[0]?.id;
      resolve(Number.isInteger(tabId) ? tabId : null);
    });
  });

export default function App() {
  const [enabled, setEnabled] = useState(true);
  const [count, setCount] = useState(0);
  const [budgetLimit, setBudgetLimit] = useState(120);
  const [budgetRemaining, setBudgetRemaining] = useState(120);
  const [stats, setStats] = useState(DEFAULT_STATS);
  const [lastError, setLastError] = useState(null);

  const [mode, setMode] = useState("balanced");
  const [demoMode, setDemoMode] = useState(false);
  const [siteToggles, setSiteToggles] = useState(DEFAULT_SITE_TOGGLES);
  const [sessionRecap, setSessionRecap] = useState(DEFAULT_RECAP);

  const [activeTabId, setActiveTabId] = useState(null);
  const [tabPaused, setTabPaused] = useState(false);
  const [copyState, setCopyState] = useState("");

  const [isSavingBudget, setIsSavingBudget] = useState(false);

  const health = useMemo(() => {
    if (!enabled) {
      return { label: "Disabled", tone: "bg-slate-400/20 text-slate-200 border-slate-300/40" };
    }
    if (demoMode) {
      return { label: "Demo Mode", tone: "bg-indigo-400/20 text-indigo-200 border-indigo-300/40" };
    }
    if (budgetRemaining <= 0 || lastError) {
      return { label: "Fallback Mode", tone: "bg-amber-400/20 text-amber-200 border-amber-300/40" };
    }
    return { label: "Live API", tone: "bg-emerald-400/20 text-emerald-200 border-emerald-300/40" };
  }, [enabled, demoMode, budgetRemaining, lastError]);

  useEffect(() => {
    if (!chrome?.runtime) return undefined;

    let mounted = true;

    const refreshStatus = async () => {
      const statusResp = await sendRuntimeMessage({ type: "GET_STATUS" });
      if (!mounted || !statusResp?.ok) return;

      setEnabled(!!statusResp.enabled);
      setCount(Number(statusResp.count) || 0);
      setBudgetLimit(Number(statusResp.budgetLimit) || 120);
      setBudgetRemaining(Number(statusResp.budgetRemaining) || 0);
      setStats(statusResp.stats || DEFAULT_STATS);
      setLastError(statusResp.lastError || null);
      setMode(statusResp.mode || "balanced");
      setDemoMode(statusResp.demoMode === true);
      setSiteToggles(statusResp.siteToggles || DEFAULT_SITE_TOGGLES);
      setSessionRecap(statusResp.sessionRecap || DEFAULT_RECAP);

      const tabId = await getActiveTabId();
      if (!mounted) return;
      setActiveTabId(tabId);

      if (Number.isInteger(tabId)) {
        const tabResp = await sendRuntimeMessage({ type: "GET_TAB_PAUSED", tabId });
        if (!mounted) return;
        setTabPaused(tabResp?.ok && tabResp.paused === true);
      } else {
        setTabPaused(false);
      }
    };

    const onStorageChanged = (_changes, area) => {
      if (area !== "local") return;
      refreshStatus();
    };

    refreshStatus();
    chrome.storage.onChanged.addListener(onStorageChanged);
    const poll = setInterval(refreshStatus, 3500);

    return () => {
      mounted = false;
      chrome.storage.onChanged.removeListener(onStorageChanged);
      clearInterval(poll);
    };
  }, []);

  const toggleEnabled = async () => {
    const next = !enabled;
    setEnabled(next);
    await sendRuntimeMessage({ type: "SET_ENABLED", enabled: next });
  };

  const updateMode = async (nextMode) => {
    setMode(nextMode);
    await sendRuntimeMessage({ type: "SET_MODE", mode: nextMode });
  };

  const toggleDemoMode = async () => {
    const next = !demoMode;
    setDemoMode(next);
    await sendRuntimeMessage({ type: "SET_DEMO_MODE", enabled: next });
  };

  const toggleSite = async (site) => {
    const next = { ...siteToggles, [site]: !siteToggles[site] };
    setSiteToggles(next);
    await sendRuntimeMessage({ type: "SET_SITE_TOGGLES", siteToggles: next });
  };

  const saveBudget = async () => {
    const nextLimit = Number(budgetLimit);
    if (!Number.isFinite(nextLimit)) return;

    setIsSavingBudget(true);
    const response = await sendRuntimeMessage({ type: "SET_BUDGET_LIMIT", limit: nextLimit });
    setIsSavingBudget(false);

    if (!response?.ok) return;
    setBudgetLimit(Number(response.budgetLimit) || nextLimit);
    setBudgetRemaining(Number(response.budgetRemaining) || 0);
  };

  const toggleTabPause = async () => {
    if (!Number.isInteger(activeTabId)) return;
    const nextPaused = !tabPaused;
    setTabPaused(nextPaused);

    const response = await sendRuntimeMessage({
      type: "SET_TAB_PAUSED",
      tabId: activeTabId,
      paused: nextPaused
    });

    if (!response?.ok) {
      setTabPaused(!nextPaused);
      return;
    }

    setTabPaused(response.paused === true);
  };

  const buildNarrativeSummary = () => {
    const topTerms = (sessionRecap.topRemovedTerms || [])
      .slice(0, 3)
      .map((entry) => `${entry.term} (${entry.count})`)
      .join(", ");

    const biggest = (sessionRecap.biggestDrops || [])[0];

    const lines = [
      `De-Hype session recap: rewrote ${sessionRecap.rewrites || 0} headlines.`,
      `Average hype reduction: ${sessionRecap.averageReduction || 0} points.`,
      `Source split -> API: ${sessionRecap.sourceCounts?.api || 0}, Cache: ${sessionRecap.sourceCounts?.cache || 0}, Fallback: ${sessionRecap.sourceCounts?.fallback || 0}.`
    ];

    if (topTerms) lines.push(`Top removed hype terms: ${topTerms}.`);
    if (biggest) lines.push(`Biggest drop: ${biggest.drop} points (${biggest.original} -> ${biggest.summary}).`);

    return lines.join(" ");
  };

  const copyRecap = async () => {
    const summary = buildNarrativeSummary();
    try {
      await navigator.clipboard.writeText(summary);
      setCopyState("Copied");
      setTimeout(() => setCopyState(""), 1300);
    } catch (_error) {
      setCopyState("Copy failed");
      setTimeout(() => setCopyState(""), 1300);
    }
  };

  const errorPreview = lastError?.message ? `${lastError.code}: ${lastError.message}` : "No recent errors";

  return (
    <div className="w-[430px] min-h-[520px] rounded-2xl border border-slate-700 bg-gradient-to-br from-slate-950 via-slate-900 to-slate-800 p-4 text-slate-100">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-wide">De-Hype v3</h1>
          <p className="text-sm text-slate-300">Before/after clickbait intelligence layer</p>
        </div>
        <span className={`rounded-md border px-2 py-1 text-xs font-medium ${health.tone}`}>{health.label}</span>
      </div>

      <div className="mt-4 grid grid-cols-4 gap-2 text-center">
        <div className="rounded-lg border border-slate-700 bg-slate-900/70 p-2">
          <div className="text-[10px] uppercase tracking-wide text-slate-400">Today</div>
          <div className="mt-1 text-lg font-semibold">{count}</div>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-900/70 p-2">
          <div className="text-[10px] uppercase tracking-wide text-slate-400">Session</div>
          <div className="mt-1 text-lg font-semibold text-cyan-300">{sessionRecap.rewrites || 0}</div>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-900/70 p-2">
          <div className="text-[10px] uppercase tracking-wide text-slate-400">Avg Drop</div>
          <div className="mt-1 text-lg font-semibold text-emerald-300">{sessionRecap.averageReduction || 0}</div>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-900/70 p-2">
          <div className="text-[10px] uppercase tracking-wide text-slate-400">Fallback</div>
          <div className="mt-1 text-lg font-semibold text-amber-300">{sessionRecap.sourceCounts?.fallback || stats.fallback || 0}</div>
        </div>
      </div>

      <div className="mt-3 rounded-xl border border-slate-600 bg-black/30 p-3">
        <div className="flex items-center justify-between">
          <span className="text-sm">Enable De-Hype</span>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={toggleEnabled}
            className="relative inline-flex h-7 w-14 items-center rounded-full bg-slate-600 transition-colors focus:outline-none focus:ring-2 focus:ring-cyan-300"
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${enabled ? "translate-x-8" : "translate-x-1"}`}
            />
          </button>
        </div>

        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-sm">Demo Mode</span>
          <button
            type="button"
            onClick={toggleDemoMode}
            className={`rounded-md border px-3 py-1 text-xs font-semibold ${
              demoMode
                ? "border-indigo-300/60 bg-indigo-500/25 text-indigo-100"
                : "border-slate-500/60 bg-slate-700/40 text-slate-100"
            }`}
          >
            {demoMode ? "On" : "Off"}
          </button>
        </div>

        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-sm">Pause This Tab</span>
          <button
            type="button"
            onClick={toggleTabPause}
            disabled={!Number.isInteger(activeTabId)}
            className={`rounded-md border px-3 py-1 text-xs font-semibold ${
              tabPaused
                ? "border-amber-300/60 bg-amber-500/20 text-amber-100"
                : "border-cyan-300/50 bg-cyan-500/20 text-cyan-100"
            } disabled:cursor-not-allowed disabled:opacity-60`}
          >
            {tabPaused ? "Paused" : "Active"}
          </button>
        </div>
      </div>

      <div className="mt-3 rounded-xl border border-slate-700 bg-slate-900/60 p-3">
        <div className="text-xs uppercase tracking-wide text-slate-400">Rewrite Mode</div>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {modeOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => updateMode(option.value)}
              className={`rounded-md border px-2 py-1 text-xs font-semibold ${
                mode === option.value
                  ? "border-cyan-300/70 bg-cyan-500/25 text-cyan-100"
                  : "border-slate-600 bg-slate-800/70 text-slate-200"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3 rounded-xl border border-slate-700 bg-slate-900/60 p-3">
        <div className="text-xs uppercase tracking-wide text-slate-400">Site Toggles</div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {Object.keys(siteLabels).map((site) => (
            <button
              key={site}
              type="button"
              onClick={() => toggleSite(site)}
              className={`rounded-md border px-2 py-1 text-xs font-semibold ${
                siteToggles[site]
                  ? "border-emerald-300/60 bg-emerald-500/20 text-emerald-100"
                  : "border-slate-600 bg-slate-800/70 text-slate-300"
              }`}
            >
              {siteLabels[site]}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3 rounded-xl border border-slate-700 bg-slate-900/60 p-3">
        <div className="text-xs uppercase tracking-wide text-slate-400">Daily API Budget</div>
        <div className="mt-1 text-sm text-slate-200">{budgetRemaining} requests left today</div>
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
        <div className="flex items-center justify-between">
          <div className="text-[11px] uppercase tracking-wide text-slate-400">Session Recap</div>
          <button
            type="button"
            onClick={copyRecap}
            className="rounded-md border border-violet-300/50 bg-violet-500/20 px-2 py-1 text-[11px] font-semibold text-violet-100"
          >
            {copyState || "Copy Demo Summary"}
          </button>
        </div>

        <div className="mt-2 text-xs text-slate-200">
          API {sessionRecap.sourceCounts?.api || stats.api || 0} • Cache {sessionRecap.sourceCounts?.cache || stats.cache || 0} • Fallback {sessionRecap.sourceCounts?.fallback || stats.fallback || 0}
        </div>

        <div className="mt-2 text-xs text-slate-300">
          Top removed: {(sessionRecap.topRemovedTerms || []).slice(0, 3).map((term) => `${term.term} (${term.count})`).join(", ") || "None yet"}
        </div>

        <div className="mt-2 text-xs text-slate-300">
          Biggest drop: {(sessionRecap.biggestDrops || [])[0]?.drop ? `${sessionRecap.biggestDrops[0].drop} points` : "None yet"}
        </div>
      </div>

      <div className="mt-3 rounded-xl border border-slate-700 bg-black/25 p-3">
        <div className="text-[11px] uppercase tracking-wide text-slate-400">Last Error</div>
        <div className="mt-1 text-xs text-slate-200">{errorPreview}</div>
      </div>

      <div className="mt-3 text-[11px] text-slate-400">
        Shortcuts: Ctrl/Cmd+Shift+Y toggle De-Hype, Ctrl/Cmd+Shift+D toggle Demo Mode, Ctrl/Cmd+Shift+P pause current tab.
      </div>
    </div>
  );
}
