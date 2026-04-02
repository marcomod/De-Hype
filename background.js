const SYSTEM_PROMPT =
  "You are an anti-clickbait assistant. Rewrite the headline into one neutral, factual sentence between 8 and 12 words. Remove hype, caps lock, emojis, and sensational framing.";
const MODEL = "gpt-4o-mini";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const CACHE_LIMIT = 500;
const REQUEST_TIMEOUT_MS = 12000;
const DEFAULT_DAILY_BUDGET = 120;
const MIN_DAILY_BUDGET = 10;
const MAX_DAILY_BUDGET = 5000;

const CACHE_KEY = "deHypeCache";
const COUNTER_KEY = "deHypeDailyCounter";
const BUDGET_KEY = "deHypeBudget";
const STATS_KEY = "deHypeStats";
const LAST_ERROR_KEY = "deHypeLastError";
const SEEN_KEY = "deHypeDailySeen";
const API_BACKOFF_KEY = "deHypeApiBackoff";
const API_BACKOFF_MS = 3 * 60 * 1000;

const pendingByKey = new Map();

const HYPE_PATTERNS = [
  /\b(you won't believe)\b/gi,
  /\b(shocking|insane|mind[- ]blowing|unbelievable)\b/gi,
  /\b(epic|must[- ]see|goes viral|game[- ]changer)\b/gi,
  /\b(what happens next|this changes everything)\b/gi,
  /\b(breaking)\b/gi
];

const normalizeText = (value = "") => value.replace(/\s+/g, " ").trim();

const toDayKey = (date = new Date()) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const sanitizeBudgetLimit = (limit) => {
  const parsed = Number(limit);
  if (!Number.isFinite(parsed)) return DEFAULT_DAILY_BUDGET;
  return Math.max(MIN_DAILY_BUDGET, Math.min(MAX_DAILY_BUDGET, Math.round(parsed)));
};

const hashText = (text) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    hash >>>= 0;
  }
  return hash.toString(16);
};

const finalizeSummary = (candidate = "", fallbackSource = "") => {
  let text = normalizeText(String(candidate).replace(/["“”'‘’`]/g, ""));
  const firstSentence = text
    .split(/[.!?]/)
    .map((part) => normalizeText(part))
    .find((part) => part.split(/\s+/).filter(Boolean).length >= 6);
  if (firstSentence) text = firstSentence;
  text = text.replace(/[!?]{2,}/g, ".");
  text = text.replace(/\s+\./g, ".");
  if (!text) text = normalizeText(fallbackSource);

  let words = text.split(/\s+/).filter(Boolean);
  if (words.length > 16) words = words.slice(0, 16);

  if (words.length < 8) {
    const fallbackWords = heuristicRewrite(fallbackSource)
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    words = words.concat(fallbackWords).slice(0, 12);
  }

  if (words.length === 0) words = ["reported", "update", "with", "limited", "public", "details"];
  const sentence = words.join(" ");
  const normalizedSentence = sentence.charAt(0).toUpperCase() + sentence.slice(1);
  return normalizedSentence.endsWith(".") ? normalizedSentence : `${normalizedSentence}.`;
};

const safeErrorMessage = (error) => {
  const message = error?.message || String(error || "unknown_error");
  return message.slice(0, 240);
};

const classifyOpenAIError = (status, responseBody = "") => {
  if (status === 429 && responseBody.includes("insufficient_quota")) return "insufficient_quota";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "upstream_error";
  if (status === 401) return "auth_error";
  if (status === 403) return "forbidden";
  return "api_error";
};

const getApiKey = async () => {
  const { openaiApiKey } = await chrome.storage.local.get("openaiApiKey");
  if (!openaiApiKey) {
    const error = new Error("Missing OpenAI API key. Set chrome.storage.local.openaiApiKey first.");
    error.code = "missing_key";
    throw error;
  }
  return openaiApiKey;
};

const defaultBudgetState = () => ({
  date: toDayKey(),
  limit: DEFAULT_DAILY_BUDGET,
  used: 0
});

const defaultStatsState = () => ({
  date: toDayKey(),
  api: 0,
  cache: 0,
  fallback: 0,
  skipped: 0
});

const defaultSeenState = () => ({
  date: toDayKey(),
  seen: {}
});

const getBudgetState = async () => {
  const stored = (await chrome.storage.local.get(BUDGET_KEY))[BUDGET_KEY];
  if (!stored) return defaultBudgetState();

  const today = toDayKey();
  const normalized = {
    date: stored.date === today ? stored.date : today,
    limit: sanitizeBudgetLimit(stored.limit),
    used: stored.date === today ? Math.max(0, Number(stored.used) || 0) : 0
  };

  if (normalized.used > normalized.limit) normalized.used = normalized.limit;
  return normalized;
};

const persistBudgetState = async (budgetState) => {
  await chrome.storage.local.set({ [BUDGET_KEY]: budgetState });
};

const setBudgetLimit = async (limit) => {
  const current = await getBudgetState();
  const next = {
    ...current,
    limit: sanitizeBudgetLimit(limit)
  };
  if (next.used > next.limit) next.used = next.limit;
  await persistBudgetState(next);
  return next;
};

const consumeBudgetToken = async () => {
  const budget = await getBudgetState();
  if (budget.used >= budget.limit) return null;
  const next = { ...budget, used: budget.used + 1 };
  await persistBudgetState(next);
  return next;
};

const refundBudgetToken = async () => {
  const budget = await getBudgetState();
  if (budget.used <= 0) return budget;
  const next = { ...budget, used: budget.used - 1 };
  await persistBudgetState(next);
  return next;
};

const getStatsState = async () => {
  const stored = (await chrome.storage.local.get(STATS_KEY))[STATS_KEY];
  if (!stored) return defaultStatsState();
  const today = toDayKey();
  if (stored.date !== today) return defaultStatsState();

  return {
    date: today,
    api: Number(stored.api) || 0,
    cache: Number(stored.cache) || 0,
    fallback: Number(stored.fallback) || 0,
    skipped: Number(stored.skipped) || 0
  };
};

const incrementStat = async (key) => {
  const stats = await getStatsState();
  if (!Object.prototype.hasOwnProperty.call(stats, key)) return;
  const next = { ...stats, [key]: (stats[key] || 0) + 1 };
  await chrome.storage.local.set({ [STATS_KEY]: next });
};

const incrementCounter = async () => {
  const state = (await chrome.storage.local.get(COUNTER_KEY))[COUNTER_KEY] || {
    date: toDayKey(),
    count: 0
  };

  const today = toDayKey();
  const next = state.date === today ? { ...state, count: (state.count || 0) + 1 } : { date: today, count: 1 };
  await chrome.storage.local.set({ [COUNTER_KEY]: next });
};

const getSeenState = async () => {
  const stored = (await chrome.storage.local.get(SEEN_KEY))[SEEN_KEY];
  if (!stored || typeof stored !== "object") return defaultSeenState();
  const today = toDayKey();
  if (stored.date !== today) return defaultSeenState();

  return {
    date: today,
    seen: stored.seen && typeof stored.seen === "object" ? stored.seen : {}
  };
};

const markTitleSeen = async (normalizedText) => {
  const state = await getSeenState();
  const key = hashText(normalizedText);
  if (state.seen[key]) return false;
  state.seen[key] = 1;
  await chrome.storage.local.set({ [SEEN_KEY]: state });
  return true;
};

const incrementCounterForTitle = async (normalizedText) => {
  const isNew = await markTitleSeen(normalizedText);
  if (!isNew) return false;
  await incrementCounter();
  return true;
};

const getCounter = async () => {
  const state = (await chrome.storage.local.get(COUNTER_KEY))[COUNTER_KEY];
  if (!state || state.date !== toDayKey()) return 0;
  return state.count || 0;
};

const setLastError = async (code, message) => {
  await chrome.storage.local.set({
    [LAST_ERROR_KEY]: {
      code: code || "api_error",
      message: (message || "Unknown error").slice(0, 240),
      at: Date.now()
    }
  });
};

const clearLastError = async () => {
  await chrome.storage.local.set({ [LAST_ERROR_KEY]: null });
};

const getLastError = async () => (await chrome.storage.local.get(LAST_ERROR_KEY))[LAST_ERROR_KEY] || null;

const getActiveApiBackoff = async () => {
  const state = (await chrome.storage.local.get(API_BACKOFF_KEY))[API_BACKOFF_KEY];
  if (!state || typeof state.until !== "number") return null;
  if (state.until <= Date.now()) {
    await chrome.storage.local.set({ [API_BACKOFF_KEY]: null });
    return null;
  }
  return state;
};

const setApiBackoff = async (code) => {
  await chrome.storage.local.set({
    [API_BACKOFF_KEY]: {
      code: code || "api_error",
      until: Date.now() + API_BACKOFF_MS
    }
  });
};

const clearApiBackoff = async () => {
  await chrome.storage.local.set({ [API_BACKOFF_KEY]: null });
};

const getCachedRewrite = async (normalizedText) => {
  const cachedBag = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY] || {};
  const key = hashText(normalizedText);
  const entry = cachedBag[key];
  if (!entry) return null;

  if (Date.now() - entry.at > CACHE_TTL_MS) {
    delete cachedBag[key];
    await chrome.storage.local.set({ [CACHE_KEY]: cachedBag });
    return null;
  }

  return entry;
};

const setCachedRewrite = async (normalizedText, rewrittenText, source = "api") => {
  const cache = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY] || {};
  const key = hashText(normalizedText);

  cache[key] = {
    rewritten: rewrittenText,
    source,
    at: Date.now()
  };

  const entries = Object.entries(cache);
  if (entries.length > CACHE_LIMIT) {
    entries.sort((a, b) => a[1].at - b[1].at);
    for (let i = 0; i < entries.length - CACHE_LIMIT; i++) {
      delete cache[entries[i][0]];
    }
  }

  await chrome.storage.local.set({ [CACHE_KEY]: cache });
};

const heuristicRewrite = (title) => {
  let text = normalizeText(title || "");

  text = text.replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}]/gu, " ");
  text = text.replace(/[!?]{2,}/g, " ");
  text = text.replace(/\.{2,}/g, " ");
  text = text.replace(/\b([A-Z]{4,})\b/g, (token) => token.toLowerCase());
  for (const pattern of HYPE_PATTERNS) {
    text = text.replace(pattern, " ");
  }
  text = text.replace(/[^\p{L}\p{N}\s'-]/gu, " ");
  text = normalizeText(text.toLowerCase());

  const words = text.split(/\s+/).filter(Boolean).slice(0, 10);
  if (words.length === 0) return "Reported update with limited public details.";
  while (words.length < 8) words.push("details");

  const sentence = words.join(" ");
  const normalizedSentence = sentence.charAt(0).toUpperCase() + sentence.slice(1);
  return normalizedSentence.endsWith(".") ? normalizedSentence : `${normalizedSentence}.`;
};

const callOpenAI = async (title) => {
  const apiKey = await getApiKey();
  const payload = {
    model: MODEL,
    temperature: 0.2,
    max_tokens: 48,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: title }
    ]
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!response.ok) {
      const body = await response.text();
      const error = new Error(`OpenAI error ${response.status}: ${body}`);
      error.code = classifyOpenAIError(response.status, body);
      throw error;
    }

    const body = await response.json();
    const raw = body?.choices?.[0]?.message?.content || "";
    return finalizeSummary(raw, title);
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error("OpenAI request timed out");
      timeoutError.code = "timeout";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
};

const processDehypeRequest = async (rawText) => {
  const normalized = normalizeText(rawText);
  if (!normalized) {
    await incrementStat("skipped");
    return { text: "", source: "skipped", reason: "empty_title" };
  }

  const cacheKeyInput = normalized.toLowerCase();
  const dedupeKey = hashText(cacheKeyInput);
  if (pendingByKey.has(dedupeKey)) return pendingByKey.get(dedupeKey);

  const promise = (async () => {
    const cached = await getCachedRewrite(cacheKeyInput);
    if (cached?.rewritten) {
      await incrementCounterForTitle(cacheKeyInput);
      await incrementStat("cache");
      return { text: cached.rewritten, source: "cache" };
    }

    const activeBackoff = await getActiveApiBackoff();
    if (activeBackoff) {
      const fallback = heuristicRewrite(normalized);
      await incrementCounterForTitle(cacheKeyInput);
      await incrementStat("fallback");
      return { text: fallback, source: "fallback", reason: activeBackoff.code || "api_backoff" };
    }

    const consumedBudget = await consumeBudgetToken();
    if (!consumedBudget) {
      const budgetFallback = heuristicRewrite(normalized);
      await incrementCounterForTitle(cacheKeyInput);
      await incrementStat("fallback");
      await incrementStat("skipped");
      return { text: budgetFallback, source: "budget", reason: "budget_reached" };
    }

    try {
      const rewritten = await callOpenAI(normalized);
      await setCachedRewrite(cacheKeyInput, rewritten, "api");
      await incrementCounterForTitle(cacheKeyInput);
      await incrementStat("api");
      await clearLastError();
      await clearApiBackoff();
      return { text: rewritten, source: "api" };
    } catch (error) {
      await refundBudgetToken();
      const fallback = heuristicRewrite(normalized);
      await incrementCounterForTitle(cacheKeyInput);
      await incrementStat("fallback");
      const errorCode = error?.code || "api_error";
      await setLastError(errorCode, safeErrorMessage(error));
      if (["insufficient_quota", "rate_limited", "auth_error", "forbidden", "missing_key", "timeout"].includes(errorCode)) {
        await setApiBackoff(errorCode);
      }
      return { text: fallback, source: "fallback", reason: errorCode };
    }
  })();

  pendingByKey.set(dedupeKey, promise);
  try {
    return await promise;
  } finally {
    pendingByKey.delete(dedupeKey);
  }
};

const getState = async () => {
  const { deHypeEnabled } = await chrome.storage.local.get("deHypeEnabled");
  const count = await getCounter();
  const budget = await getBudgetState();
  const statsRaw = await getStatsState();
  const lastError = await getLastError();

  return {
    enabled: deHypeEnabled !== false,
    count,
    budgetRemaining: Math.max(0, budget.limit - budget.used),
    budgetLimit: budget.limit,
    stats: {
      api: statsRaw.api,
      cache: statsRaw.cache,
      fallback: statsRaw.fallback,
      skipped: statsRaw.skipped
    },
    lastError
  };
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) return false;

  if (message.type === "DEHYPE_REQUEST") {
    processDehypeRequest(message.text)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: safeErrorMessage(error) }));
    return true;
  }

  if (message.type === "GET_STATUS") {
    getState()
      .then((state) => sendResponse({ ok: true, ...state }))
      .catch((error) => sendResponse({ ok: false, error: safeErrorMessage(error) }));
    return true;
  }

  if (message.type === "SET_ENABLED") {
    chrome.storage.local
      .set({ deHypeEnabled: !!message.enabled })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: safeErrorMessage(error) }));
    return true;
  }

  if (message.type === "SET_BUDGET_LIMIT") {
    setBudgetLimit(message.limit)
      .then((budget) =>
        sendResponse({
          ok: true,
          budgetLimit: budget.limit,
          budgetRemaining: Math.max(0, budget.limit - budget.used)
        })
      )
      .catch((error) => sendResponse({ ok: false, error: safeErrorMessage(error) }));
    return true;
  }

  if (message.type === "GET_COUNTER") {
    getCounter()
      .then((value) => sendResponse({ ok: true, count: value }))
      .catch((error) => sendResponse({ ok: false, error: safeErrorMessage(error) }));
    return true;
  }

  return false;
});
