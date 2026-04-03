const MODEL = "gpt-4o-mini";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const CACHE_LIMIT = 700;
const REQUEST_TIMEOUT_MS = 12000;
const DEFAULT_DAILY_BUDGET = 120;
const MIN_DAILY_BUDGET = 10;
const MAX_DAILY_BUDGET = 5000;
const API_BACKOFF_MS = 3 * 60 * 1000;

const ENABLED_KEY = "deHypeEnabled";
const CACHE_KEY = "deHypeCache";
const COUNTER_KEY = "deHypeDailyCounter";
const BUDGET_KEY = "deHypeBudget";
const STATS_KEY = "deHypeStats";
const LAST_ERROR_KEY = "deHypeLastError";
const SEEN_KEY = "deHypeDailySeen";
const API_BACKOFF_KEY = "deHypeApiBackoff";
const MODE_KEY = "deHypeMode";
const SITE_TOGGLES_KEY = "deHypeSiteToggles";
const DEMO_MODE_KEY = "deHypeDemoMode";
const SESSION_RECAP_KEY = "deHypeSessionRecap";

const MODES = ["subtle", "balanced", "aggressive"];
const DEFAULT_MODE = "balanced";
const DEFAULT_SITE_TOGGLES = {
  youtube: true,
  cnn: true,
  verge: true,
  generic: true
};

const MODE_WORD_TARGET = {
  subtle: 12,
  balanced: 10,
  aggressive: 8
};

const MODE_WORD_MIN = {
  subtle: 9,
  balanced: 8,
  aggressive: 7
};

const MODE_PROMPT_WINDOW = {
  subtle: "10-14 words",
  balanced: "8-12 words",
  aggressive: "6-10 words"
};

const TRAILING_FRAGMENT_WORDS = new Set([
  "and",
  "or",
  "to",
  "for",
  "with",
  "without",
  "of",
  "in",
  "on",
  "at",
  "about",
  "from",
  "into",
  "across",
  "over",
  "under",
  "after",
  "before",
  "during"
]);

const HYPE_TERM_DEFS = [
  { term: "you won't believe", pattern: /\byou won'?t believe\b/gi },
  { term: "shocking", pattern: /\bshocking\b/gi },
  { term: "insane", pattern: /\binsane\b/gi },
  { term: "mind blowing", pattern: /\bmind[- ]blowing\b/gi },
  { term: "unbelievable", pattern: /\bunbelievable\b/gi },
  { term: "epic", pattern: /\bepic\b/gi },
  { term: "must see", pattern: /\bmust[- ]see\b/gi },
  { term: "goes viral", pattern: /\bgoes viral\b/gi },
  { term: "game changer", pattern: /\bgame[- ]changer\b/gi },
  { term: "changes everything", pattern: /\bchanges everything\b/gi },
  { term: "what happens next", pattern: /\bwhat happens next\b/gi },
  { term: "breaking", pattern: /\bbreaking\b/gi },
  { term: "jaw dropping", pattern: /\bjaw[- ]dropping\b/gi },
  { term: "secret", pattern: /\bsecret\b/gi },
  { term: "exposed", pattern: /\bexposed\b/gi },
  { term: "stuns", pattern: /\bstuns?\b/gi },
  { term: "destroys", pattern: /\bdestroys?\b/gi }
];

const pendingByKey = new Map();
const pausedTabs = new Set();

const normalizeText = (value = "") => value.replace(/\s+/g, " ").trim();

const toDayKey = (date = new Date()) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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

const safeErrorMessage = (error) => {
  const message = error?.message || String(error || "unknown_error");
  return message.slice(0, 240);
};

const sanitizeBudgetLimit = (limit) => {
  const parsed = Number(limit);
  if (!Number.isFinite(parsed)) return DEFAULT_DAILY_BUDGET;
  return Math.max(MIN_DAILY_BUDGET, Math.min(MAX_DAILY_BUDGET, Math.round(parsed)));
};

const sanitizeMode = (value) => (MODES.includes(value) ? value : DEFAULT_MODE);

const sanitizeSiteToggles = (value) => ({
  youtube: value?.youtube !== false,
  cnn: value?.cnn !== false,
  verge: value?.verge !== false,
  generic: value?.generic !== false
});

const countPatternMatches = (text, pattern) => {
  const regex = new RegExp(pattern.source, pattern.flags);
  const matches = String(text || "").match(regex);
  return matches ? matches.length : 0;
};

const scoreHeadline = (headline = "") => {
  const raw = String(headline);
  const normalized = normalizeText(raw);
  if (!normalized) return 0;

  const words = normalized.split(/\s+/).filter(Boolean);
  let score = 6;

  const uppercaseWords = words.filter(
    (word) => /[A-Z]/.test(word) && word === word.toUpperCase() && word.length >= 3
  ).length;
  score += Math.min(24, uppercaseWords * 7);

  const exclamationCount = (raw.match(/!/g) || []).length;
  score += Math.min(14, exclamationCount * 4);

  const questionCount = (raw.match(/\?/g) || []).length;
  score += Math.min(8, questionCount * 2);

  const emojiCount = (raw.match(/[\p{Extended_Pictographic}]/gu) || []).length;
  score += Math.min(12, emojiCount * 3);

  let hypeHits = 0;
  for (const def of HYPE_TERM_DEFS) {
    const matches = countPatternMatches(raw, def.pattern);
    if (matches > 0) hypeHits += Math.min(matches, 2);
  }
  score += Math.min(42, hypeHits * 7);

  if (normalized.length > 100) score += 4;
  if (/\b(exclusive|urgent|chaos|meltdown)\b/i.test(raw)) score += 8;

  return Math.max(0, Math.min(100, Math.round(score)));
};

const collectRemovedTerms = (original, summary) => {
  const originalText = String(original || "");
  const summaryNorm = normalizeText(String(summary || "").toLowerCase()).replace(/[’']/g, "");

  const removed = [];
  for (const def of HYPE_TERM_DEFS) {
    if (countPatternMatches(originalText, def.pattern) === 0) continue;
    const termNorm = def.term.replace(/[’']/g, "");
    if (!summaryNorm.includes(termNorm) && !removed.includes(def.term)) {
      removed.push(def.term);
    }
  }

  const hadCaps = /\b[A-Z]{4,}\b/.test(originalText);
  const hasCapsNow = /\b[A-Z]{4,}\b/.test(summary || "");
  if (hadCaps && !hasCapsNow && !removed.includes("all-caps tone")) removed.push("all-caps tone");

  return removed.slice(0, 5);
};

const enforceSentenceEnding = (value) => {
  const text = normalizeText(value);
  if (!text) return "";
  if (/[.!?]$/.test(text)) return text;
  return `${text}.`;
};

const finalizeSummary = (candidate = "", fallbackSource = "", mode = DEFAULT_MODE) => {
  const maxWordsByMode = {
    subtle: 16,
    balanced: 14,
    aggressive: 12
  };

  let text = String(candidate || "").replace(/["“”'‘’`]/g, " ");
  text = text.replace(/\s+/g, " ").trim();

  if (!text) text = heuristicRewrite(fallbackSource, mode);

  const sentenceCandidates = text
    .split(/[\n\r]+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((line) => normalizeText(line))
    .filter(Boolean);

  const bestSentence =
    sentenceCandidates.find((line) => line.split(/\s+/).filter(Boolean).length >= MODE_WORD_MIN[mode]) ||
    sentenceCandidates[0] ||
    text;

  let words = normalizeText(bestSentence)
    .split(/\s+/)
    .filter(Boolean);

  const maxWords = maxWordsByMode[mode] || maxWordsByMode[DEFAULT_MODE];
  if (words.length > maxWords) words = words.slice(0, maxWords);
  if (words.length < MODE_WORD_MIN[mode]) {
    const filler = heuristicRewrite(fallbackSource, mode)
      .toLowerCase()
      .replace(/[.!?]+$/, "")
      .split(/\s+/)
      .filter(Boolean);
    words = words.concat(filler).slice(0, maxWords);
  }

  if (words.length === 0) {
    words = "reported update with limited public details".split(" ");
  }

  const sentence = words.join(" ");
  const capped = sentence.charAt(0).toUpperCase() + sentence.slice(1);
  return enforceSentenceEnding(capped);
};

const isCompleteSummary = (summary, mode = DEFAULT_MODE) => {
  const text = normalizeText(summary || "");
  if (!text) return false;
  if (!/[.!?]$/.test(text)) return false;
  if (/(\.\.\.|…)$/.test(text)) return false;

  const words = text.replace(/[.!?]+$/, "").split(/\s+/).filter(Boolean);
  if (words.length < MODE_WORD_MIN[mode]) return false;

  const tail = words[words.length - 1]?.toLowerCase();
  if (TRAILING_FRAGMENT_WORDS.has(tail)) return false;

  if (/[,:;]$/.test(text)) return false;
  return true;
};

const removeHypePatterns = (text) => {
  let result = String(text || "");
  for (const def of HYPE_TERM_DEFS) {
    result = result.replace(def.pattern, " ");
  }
  return result;
};

const heuristicRewrite = (headline, mode = DEFAULT_MODE) => {
  const normalizedMode = sanitizeMode(mode);
  let text = normalizeText(String(headline || ""));

  text = text.replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}]/gu, " ");
  text = text.replace(/[!?]{2,}/g, " ");
  text = text.replace(/\.{2,}/g, " ");
  text = removeHypePatterns(text);
  text = text.replace(/[“”"`]/g, " ");
  text = text.replace(/[^\p{L}\p{N}\s'-]/gu, " ");
  text = normalizeText(text.toLowerCase());

  let words = text.split(/\s+/).filter(Boolean);
  const target = MODE_WORD_TARGET[normalizedMode];
  const minWords = MODE_WORD_MIN[normalizedMode];

  if (words.length === 0) {
    words = "reported update with limited publicly available details".split(" ");
  }

  words = words.slice(0, target);
  const filler = ["reported", "update", "with", "public", "details", "available", "today"];
  let fillerIndex = 0;
  while (words.length < minWords) {
    words.push(filler[fillerIndex % filler.length]);
    fillerIndex += 1;
  }

  const sentence = words.join(" ");
  const capped = sentence.charAt(0).toUpperCase() + sentence.slice(1);
  return enforceSentenceEnding(capped);
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

const buildSystemPrompt = (mode = DEFAULT_MODE, strict = false) => {
  const targetWindow = MODE_PROMPT_WINDOW[mode] || MODE_PROMPT_WINDOW[DEFAULT_MODE];
  const strictTail = strict
    ? "Return exactly one complete sentence. No fragments, no lists, no labels. End with a period."
    : "Return one neutral sentence only.";

  return [
    "You are an anti-clickbait assistant.",
    `Rewrite the headline into a boring, factual sentence (${targetWindow}).`,
    "Remove hyperbole, caps lock, emojis, and sensational framing.",
    strictTail
  ].join(" ");
};

const callOpenAIOnce = async (title, systemPrompt) => {
  const apiKey = await getApiKey();
  const payload = {
    model: MODEL,
    temperature: 0.2,
    max_tokens: 64,
    messages: [
      { role: "system", content: systemPrompt },
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
    return body?.choices?.[0]?.message?.content || "";
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

const callOpenAI = async (title, mode = DEFAULT_MODE) => {
  const normalizedMode = sanitizeMode(mode);

  const first = await callOpenAIOnce(title, buildSystemPrompt(normalizedMode, false));
  const firstSummary = finalizeSummary(first, title, normalizedMode);
  if (isCompleteSummary(firstSummary, normalizedMode)) return firstSummary;

  const second = await callOpenAIOnce(title, buildSystemPrompt(normalizedMode, true));
  const secondSummary = finalizeSummary(second, title, normalizedMode);
  if (isCompleteSummary(secondSummary, normalizedMode)) return secondSummary;

  const error = new Error("Model returned incomplete summary");
  error.code = "invalid_output";
  throw error;
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

const defaultSessionRecapState = () => ({
  date: toDayKey(),
  rewrites: 0,
  totalReduction: 0,
  sourceCounts: {
    api: 0,
    cache: 0,
    fallback: 0
  },
  removedTermCounts: {},
  biggestDrops: []
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

const getMode = async () => {
  const stored = (await chrome.storage.local.get(MODE_KEY))[MODE_KEY];
  return sanitizeMode(stored);
};

const setMode = async (mode) => {
  const normalized = sanitizeMode(mode);
  await chrome.storage.local.set({ [MODE_KEY]: normalized });
  return normalized;
};

const getSiteToggles = async () => {
  const stored = (await chrome.storage.local.get(SITE_TOGGLES_KEY))[SITE_TOGGLES_KEY];
  return sanitizeSiteToggles(stored || DEFAULT_SITE_TOGGLES);
};

const setSiteToggles = async (siteToggles) => {
  const normalized = sanitizeSiteToggles(siteToggles);
  await chrome.storage.local.set({ [SITE_TOGGLES_KEY]: normalized });
  return normalized;
};

const getDemoMode = async () => {
  const stored = (await chrome.storage.local.get(DEMO_MODE_KEY))[DEMO_MODE_KEY];
  return stored === true;
};

const setDemoMode = async (enabled) => {
  const normalized = enabled === true;
  await chrome.storage.local.set({ [DEMO_MODE_KEY]: normalized });
  return normalized;
};

const getSessionRecapState = async () => {
  const stored = (await chrome.storage.local.get(SESSION_RECAP_KEY))[SESSION_RECAP_KEY];
  if (!stored || typeof stored !== "object") return defaultSessionRecapState();
  const today = toDayKey();
  if (stored.date !== today) return defaultSessionRecapState();

  return {
    date: today,
    rewrites: Number(stored.rewrites) || 0,
    totalReduction: Number(stored.totalReduction) || 0,
    sourceCounts: {
      api: Number(stored.sourceCounts?.api) || 0,
      cache: Number(stored.sourceCounts?.cache) || 0,
      fallback: Number(stored.sourceCounts?.fallback) || 0
    },
    removedTermCounts:
      stored.removedTermCounts && typeof stored.removedTermCounts === "object"
        ? stored.removedTermCounts
        : {},
    biggestDrops: Array.isArray(stored.biggestDrops) ? stored.biggestDrops : []
  };
};

const persistSessionRecapState = async (state) => {
  await chrome.storage.local.set({ [SESSION_RECAP_KEY]: state });
};

const normalizeSourceForRecap = (source) => {
  if (source === "api") return "api";
  if (source === "cache") return "cache";
  return "fallback";
};

const updateSessionRecap = async (result) => {
  if (!result?.summary) return;

  const recap = await getSessionRecapState();
  const drop = Math.max(0, Number(result.scoreBefore || 0) - Number(result.scoreAfter || 0));
  recap.rewrites += 1;
  recap.totalReduction += drop;

  const sourceKey = normalizeSourceForRecap(result.source);
  recap.sourceCounts[sourceKey] = (recap.sourceCounts[sourceKey] || 0) + 1;

  const terms = Array.isArray(result.removedTerms) ? result.removedTerms : [];
  for (const term of terms) {
    recap.removedTermCounts[term] = (Number(recap.removedTermCounts[term]) || 0) + 1;
  }

  if (drop > 0) {
    const nextEntry = {
      drop,
      original: String(result.original || "").slice(0, 140),
      summary: String(result.summary || "").slice(0, 140)
    };

    recap.biggestDrops = [...recap.biggestDrops, nextEntry]
      .sort((a, b) => Number(b.drop || 0) - Number(a.drop || 0))
      .slice(0, 5);
  }

  await persistSessionRecapState(recap);
};

const summarizeSessionRecap = (recap) => {
  const topRemovedTerms = Object.entries(recap.removedTermCounts || {})
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
    .slice(0, 5)
    .map(([term, count]) => ({ term, count: Number(count) || 0 }));

  return {
    rewrites: recap.rewrites || 0,
    averageReduction: recap.rewrites ? Math.round((recap.totalReduction / recap.rewrites) * 10) / 10 : 0,
    sourceCounts: {
      api: Number(recap.sourceCounts?.api) || 0,
      cache: Number(recap.sourceCounts?.cache) || 0,
      fallback: Number(recap.sourceCounts?.fallback) || 0
    },
    topRemovedTerms,
    biggestDrops: Array.isArray(recap.biggestDrops) ? recap.biggestDrops.slice(0, 3) : []
  };
};

const getCachedRewrite = async (cacheInput) => {
  const cache = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY] || {};
  const key = hashText(cacheInput);
  const entry = cache[key];
  if (!entry) return null;

  if (Date.now() - Number(entry.at || 0) > CACHE_TTL_MS) {
    delete cache[key];
    await chrome.storage.local.set({ [CACHE_KEY]: cache });
    return null;
  }

  if (!entry.summary) return null;
  return entry;
};

const setCachedRewrite = async (cacheInput, entry) => {
  const cache = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY] || {};
  const key = hashText(cacheInput);

  cache[key] = {
    summary: entry.summary,
    source: entry.source,
    mode: entry.mode,
    at: Date.now()
  };

  const entries = Object.entries(cache);
  if (entries.length > CACHE_LIMIT) {
    entries.sort((a, b) => Number(a[1].at || 0) - Number(b[1].at || 0));
    for (let i = 0; i < entries.length - CACHE_LIMIT; i++) {
      delete cache[entries[i][0]];
    }
  }

  await chrome.storage.local.set({ [CACHE_KEY]: cache });
};

const buildResultPayload = ({ original, summary, source, mode, reason }) => {
  const normalizedMode = sanitizeMode(mode);
  const completedSummary = isCompleteSummary(summary, normalizedMode)
    ? finalizeSummary(summary, original, normalizedMode)
    : heuristicRewrite(original, normalizedMode);

  const scoreBefore = scoreHeadline(original);
  const scoreAfter = scoreHeadline(completedSummary);
  const removedTerms = collectRemovedTerms(original, completedSummary);

  return {
    original,
    summary: completedSummary,
    text: completedSummary,
    source,
    mode: normalizedMode,
    reason,
    scoreBefore,
    scoreAfter,
    removedTerms
  };
};

const processDehypeRequest = async (rawText) => {
  const original = normalizeText(rawText);
  const mode = await getMode();
  const demoMode = await getDemoMode();

  if (!original) {
    await incrementStat("skipped");
    return buildResultPayload({
      original: "",
      summary: "",
      source: "fallback",
      mode,
      reason: "empty_title"
    });
  }

  const normalizedTitle = original.toLowerCase();
  const cacheInput = `${mode}|${demoMode ? "demo" : "live"}|${normalizedTitle}`;
  const dedupeKey = hashText(cacheInput);

  if (pendingByKey.has(dedupeKey)) return pendingByKey.get(dedupeKey);

  const promise = (async () => {
    const cached = await getCachedRewrite(cacheInput);
    if (cached?.summary) {
      const cachedPayload = buildResultPayload({
        original,
        summary: cached.summary,
        source: "cache",
        mode,
        reason: "cache_hit"
      });
      await incrementCounterForTitle(normalizedTitle);
      await incrementStat("cache");
      await updateSessionRecap(cachedPayload);
      return cachedPayload;
    }

    let source = "api";
    let reason = null;
    let summary = "";

    if (demoMode) {
      summary = heuristicRewrite(original, mode);
      source = "fallback";
      reason = "demo_mode";
    } else {
      const activeBackoff = await getActiveApiBackoff();
      if (activeBackoff) {
        summary = heuristicRewrite(original, mode);
        source = "fallback";
        reason = activeBackoff.code || "api_backoff";
      } else {
        const consumedBudget = await consumeBudgetToken();
        if (!consumedBudget) {
          summary = heuristicRewrite(original, mode);
          source = "fallback";
          reason = "budget_reached";
          await incrementStat("skipped");
        } else {
          try {
            summary = await callOpenAI(original, mode);
            source = "api";
            reason = null;
            await clearLastError();
            await clearApiBackoff();
          } catch (error) {
            await refundBudgetToken();
            source = "fallback";
            reason = error?.code || "api_error";
            summary = heuristicRewrite(original, mode);
            await setLastError(reason, safeErrorMessage(error));

            if (
              [
                "insufficient_quota",
                "rate_limited",
                "auth_error",
                "forbidden",
                "missing_key",
                "timeout"
              ].includes(reason)
            ) {
              await setApiBackoff(reason);
            }
          }
        }
      }
    }

    const payload = buildResultPayload({ original, summary, source, mode, reason });

    await setCachedRewrite(cacheInput, {
      summary: payload.summary,
      source: payload.source,
      mode: payload.mode
    });

    await incrementCounterForTitle(normalizedTitle);

    if (payload.source === "api") await incrementStat("api");
    if (payload.source === "fallback") await incrementStat("fallback");

    await updateSessionRecap(payload);
    return payload;
  })();

  pendingByKey.set(dedupeKey, promise);
  try {
    return await promise;
  } finally {
    pendingByKey.delete(dedupeKey);
  }
};

const getSessionRecap = async () => summarizeSessionRecap(await getSessionRecapState());

const getState = async () => {
  const { [ENABLED_KEY]: enabledValue } = await chrome.storage.local.get(ENABLED_KEY);
  const count = await getCounter();
  const budget = await getBudgetState();
  const statsRaw = await getStatsState();
  const lastError = await getLastError();
  const mode = await getMode();
  const siteToggles = await getSiteToggles();
  const demoMode = await getDemoMode();
  const sessionRecap = await getSessionRecap();

  return {
    enabled: enabledValue !== false,
    count,
    budgetRemaining: Math.max(0, budget.limit - budget.used),
    budgetLimit: budget.limit,
    stats: {
      api: statsRaw.api,
      cache: statsRaw.cache,
      fallback: statsRaw.fallback,
      skipped: statsRaw.skipped
    },
    lastError,
    mode,
    demoMode,
    siteToggles,
    sessionRecap
  };
};

const isTabPaused = (tabId) => pausedTabs.has(tabId);

const setTabPaused = async (tabId, paused) => {
  if (!Number.isInteger(tabId)) return false;

  if (paused) pausedTabs.add(tabId);
  else pausedTabs.delete(tabId);

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "TAB_PAUSE_STATE",
      paused: pausedTabs.has(tabId)
    });
  } catch (_error) {
    // Ignore missing content-script errors.
  }

  return pausedTabs.has(tabId);
};

const getActiveTabId = async () => {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs?.[0]?.id;
    return Number.isInteger(tabId) ? tabId : null;
  } catch (_error) {
    return null;
  }
};

chrome.tabs.onRemoved.addListener((tabId) => {
  pausedTabs.delete(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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

  if (message.type === "GET_SESSION_RECAP") {
    getSessionRecap()
      .then((sessionRecap) => sendResponse({ ok: true, sessionRecap }))
      .catch((error) => sendResponse({ ok: false, error: safeErrorMessage(error) }));
    return true;
  }

  if (message.type === "SET_ENABLED") {
    chrome.storage.local
      .set({ [ENABLED_KEY]: !!message.enabled })
      .then(() => sendResponse({ ok: true, enabled: !!message.enabled }))
      .catch((error) => sendResponse({ ok: false, error: safeErrorMessage(error) }));
    return true;
  }

  if (message.type === "SET_MODE") {
    setMode(message.mode)
      .then((mode) => sendResponse({ ok: true, mode }))
      .catch((error) => sendResponse({ ok: false, error: safeErrorMessage(error) }));
    return true;
  }

  if (message.type === "SET_SITE_TOGGLES") {
    setSiteToggles(message.siteToggles)
      .then((siteToggles) => sendResponse({ ok: true, siteToggles }))
      .catch((error) => sendResponse({ ok: false, error: safeErrorMessage(error) }));
    return true;
  }

  if (message.type === "SET_DEMO_MODE") {
    setDemoMode(message.enabled)
      .then((demoMode) => sendResponse({ ok: true, demoMode }))
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

  if (message.type === "SET_TAB_PAUSED") {
    setTabPaused(Number(message.tabId), !!message.paused)
      .then((paused) => sendResponse({ ok: true, paused }))
      .catch((error) => sendResponse({ ok: false, error: safeErrorMessage(error) }));
    return true;
  }

  if (message.type === "GET_TAB_PAUSED") {
    const tabId = Number(message.tabId);
    sendResponse({ ok: true, paused: Number.isInteger(tabId) ? isTabPaused(tabId) : false });
    return false;
  }

  if (message.type === "GET_TAB_STATE") {
    const senderTabId = sender?.tab?.id;
    sendResponse({ ok: true, paused: Number.isInteger(senderTabId) ? isTabPaused(senderTabId) : false });
    return false;
  }

  return false;
});

if (chrome.commands?.onCommand) {
  chrome.commands.onCommand.addListener(async (command, tab) => {
    try {
      if (command === "toggle-dehype") {
        const current = (await chrome.storage.local.get(ENABLED_KEY))[ENABLED_KEY] !== false;
        await chrome.storage.local.set({ [ENABLED_KEY]: !current });
        return;
      }

      if (command === "toggle-demo-mode") {
        const current = await getDemoMode();
        await setDemoMode(!current);
        return;
      }

      if (command === "toggle-tab-pause") {
        let tabId = tab?.id;
        if (!Number.isInteger(tabId)) tabId = await getActiveTabId();
        if (!Number.isInteger(tabId)) return;
        await setTabPaused(tabId, !isTabPaused(tabId));
      }
    } catch (_error) {
      // no-op
    }
  });
}
