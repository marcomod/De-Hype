const MIN_TITLE_LENGTH = 12;
const MAX_TITLE_LENGTH = 180;
const PROCESS_CONCURRENCY = 3;
const OBSERVER_ROOT_MARGIN = "500px 0px";
const MUTATION_DEBOUNCE_MS = 150;
const STYLE_ID = "dehype-summary-style";

const PROFILE_SELECTORS = {
  youtube: [
    "ytd-rich-item-renderer a#video-title",
    "ytd-rich-grid-media a#video-title",
    "ytd-video-renderer a#video-title",
    "ytd-grid-video-renderer a#video-title",
    "ytd-compact-video-renderer a#video-title",
    "ytd-playlist-video-renderer a#video-title",
    "ytd-reel-item-renderer #video-title",
    "a#video-title-link",
    "yt-formatted-string#video-title",
    "h1.ytd-watch-metadata yt-formatted-string"
  ],
  cnn: [
    ".container__headline-text",
    ".headline__text",
    ".card-title",
    "h2.container__headline",
    "h3.container__headline",
    ".headline"
  ],
  verge: [
    ".duet--article--headline a",
    ".duet--title",
    ".c-entry-box--compact__title a",
    "h2 a[data-analytics-link='article']",
    "h3 a[data-analytics-link='article']",
    "h2.c-entry-box--compact__title a",
    "h2.c-entry-box--compact__title",
    "a[data-chorus-optimize-field='hed']"
  ]
};

const GENERIC_FALLBACK_SELECTORS = ["main h1", "main h2", "main h3", "article h1", "article h2", "article h3"];
const TEXT_NODE_SELECTORS = "a#video-title, h1, h2, h3, a, yt-formatted-string, span";
const YOUTUBE_CARD_SELECTORS =
  "ytd-rich-item-renderer, ytd-rich-grid-media, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer, ytd-playlist-video-renderer, ytd-reel-item-renderer, ytd-watch-metadata";

const DEFAULT_SITE_TOGGLES = {
  youtube: true,
  cnn: true,
  verge: true,
  generic: true
};

let deHypeEnabled = true;
let tabPaused = false;
let currentMode = "balanced";
let siteToggles = { ...DEFAULT_SITE_TOGGLES };

let targetCounter = 0;
let activeCount = 0;
let mutationTimer = null;

const processingQueue = [];
const queuedElements = new Set();
const inflightElements = new Set();
const observedElements = new Set();
const mutationRoots = new Set();

const normalizeText = (value = "") => value.replace(/\s+/g, " ").trim();

const detectProfile = () => {
  const host = window.location.hostname;
  if (host.includes("youtube.com")) return "youtube";
  if (host.includes("cnn.com")) return "cnn";
  if (host.includes("theverge.com")) return "verge";
  return "generic";
};

const isValidHeadline = (text) => {
  const words = text.split(/\s+/).filter(Boolean);
  return text.length >= MIN_TITLE_LENGTH && text.length <= MAX_TITLE_LENGTH && words.length >= 4;
};

const isProfileEnabled = () => {
  const profile = detectProfile();
  return siteToggles[profile] !== false;
};

const isFeatureActive = () => deHypeEnabled && !tabPaused && isProfileEnabled();

const getSelectorPlan = () => {
  const profile = detectProfile();
  return {
    profile,
    primary: PROFILE_SELECTORS[profile] || [],
    fallback: GENERIC_FALLBACK_SELECTORS
  };
};

const ensureStyle = () => {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .dehype-compare {
      display: block;
      margin-top: 6px;
      padding: 8px;
      border: 1px solid rgba(148, 163, 184, 0.35);
      border-left: 3px solid #0ea5e9;
      border-radius: 8px;
      background: rgba(248, 250, 252, 0.92);
      color: #0f172a;
      font-size: 12px;
      line-height: 1.35;
      letter-spacing: 0.01em;
      max-width: 100%;
      white-space: normal !important;
      text-overflow: clip !important;
      overflow: visible !important;
      -webkit-line-clamp: unset !important;
      box-sizing: border-box;
    }

    .dehype-compare[data-source="cache"] {
      border-left-color: #22c55e;
    }

    .dehype-compare[data-source="fallback"],
    .dehype-compare[data-source="budget"] {
      border-left-color: #f59e0b;
    }

    .dehype-summary-text {
      color: #0f172a;
      word-break: break-word;
      overflow: visible !important;
      text-overflow: clip !important;
      white-space: normal !important;
      -webkit-line-clamp: unset !important;
    }

    html[dark] .dehype-compare,
    ytd-app[dark] .dehype-compare,
    body[data-theme="dark"] .dehype-compare {
      background: rgba(2, 6, 23, 0.88);
      color: #e2e8f0;
      border-color: rgba(71, 85, 105, 0.5);
    }

    html[dark] .dehype-summary-text,
    ytd-app[dark] .dehype-summary-text,
    body[data-theme="dark"] .dehype-summary-text {
      color: #e2e8f0;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
};

const isClippingContainer = (element) => {
  if (!(element instanceof Element)) return false;
  const style = getComputedStyle(element);
  const lineClamp = Number.parseInt(style.webkitLineClamp || "", 10);
  if (Number.isFinite(lineClamp) && lineClamp > 0) return true;
  if (style.textOverflow === "ellipsis") return true;

  const overflowValues = `${style.overflow} ${style.overflowY} ${style.overflowX}`;
  if (/(hidden|clip)/.test(overflowValues)) {
    if (style.display.includes("-webkit-box")) return true;
    if (style.maxHeight !== "none") return true;
  }

  return false;
};

const toAnchorId = (element) => {
  if (!element.dataset.dehypeAnchorId) {
    targetCounter += 1;
    element.dataset.dehypeAnchorId = `dehype-${targetCounter}`;
  }
  return element.dataset.dehypeAnchorId;
};

const scoreTextNode = (node, text) => {
  let score = text.length;
  if (node.matches("a#video-title")) score += 90;
  if (node.matches("a#video-title-link")) score += 90;
  if (node.matches("h1, h2, h3")) score += 45;
  if (node.matches("yt-formatted-string#video-title")) score += 80;
  if (node.matches("a")) score += 18;
  return score;
};

const extractBestTitleNode = (candidate) => {
  const nodes = [];

  if (candidate.matches(TEXT_NODE_SELECTORS)) nodes.push(candidate);
  candidate.querySelectorAll(TEXT_NODE_SELECTORS).forEach((node) => nodes.push(node));

  let best = null;
  for (const node of nodes) {
    if (!(node instanceof Element)) continue;
    if (node.closest(".dehype-compare")) continue;
    const text = normalizeText(node.textContent || "");
    if (!isValidHeadline(text)) continue;

    const nodeScore = scoreTextNode(node, text);
    if (!best || nodeScore > best.score) {
      best = { node, text, score: nodeScore };
    }
  }

  return best ? { textNode: best.node, text: best.text } : null;
};

const escapeClipping = (node) => {
  if (!(node instanceof Element)) return null;
  let anchor = node;
  let hops = 0;

  while (anchor.parentElement && hops < 8 && isClippingContainer(anchor.parentElement)) {
    anchor = anchor.parentElement;
    hops += 1;
  }

  if (anchor.tagName === "A" && anchor.parentElement) return anchor.parentElement;
  return anchor;
};

const resolveInsertAnchor = (candidate, textNode) => {
  const profile = detectProfile();

  if (profile === "youtube") {
    const watchTitle = textNode.closest("h1.ytd-watch-metadata, #title h1, ytd-watch-metadata");
    if (watchTitle instanceof Element) {
      return { node: watchTitle, mode: "after" };
    }

    const titleWrapper = textNode.closest("#title-wrapper, #title, h3, #video-title");
    if (titleWrapper instanceof Element) {
      return { node: titleWrapper, mode: "after" };
    }

    const card = candidate.closest(YOUTUBE_CARD_SELECTORS);
    const meta = card?.querySelector("#meta, #details, #dismissible");
    if (meta instanceof Element) {
      return { node: meta, mode: "append" };
    }
  }

  if (profile === "verge") {
    const vergeTitle = textNode.closest(".duet--article--headline, .duet--title, .c-entry-box--compact__title, h1, h2, h3");
    if (vergeTitle instanceof Element) {
      return { node: vergeTitle, mode: "after" };
    }
  }

  const semantic = textNode.closest("h1, h2, h3, a, yt-formatted-string, .container__headline, .headline");
  const anchor = escapeClipping(semantic || textNode);
  return { node: anchor || textNode, mode: "after" };
};

const getCompareNode = (anchorNode, mode) => {
  const anchorId = toAnchorId(anchorNode);

  if (mode === "append") {
    return anchorNode.querySelector(`.dehype-compare[data-anchor-id="${anchorId}"]`);
  }

  const directNext = anchorNode.nextElementSibling;
  if (directNext && directNext.classList.contains("dehype-compare") && directNext.dataset.anchorId === anchorId) {
    return directNext;
  }

  const parent = anchorNode.parentElement;
  if (!parent) return null;
  return parent.querySelector(`.dehype-compare[data-anchor-id="${anchorId}"]`);
};

const resolveCandidate = (candidate) => {
  if (!(candidate instanceof Element)) return null;
  if (candidate.closest(".dehype-compare")) return null;

  const extracted = extractBestTitleNode(candidate);
  if (!extracted) return null;

  const { textNode, text } = extracted;
  const anchor = resolveInsertAnchor(candidate, textNode);
  if (!anchor?.node?.isConnected) return null;

  return {
    text,
    anchorNode: anchor.node,
    mode: anchor.mode
  };
};

const shouldProcess = (resolved) => {
  if (!resolved?.anchorNode?.isConnected) return false;
  if (!isFeatureActive()) return false;
  if (!isValidHeadline(resolved.text)) return false;

  const existing = getCompareNode(resolved.anchorNode, resolved.mode);
  const previousRaw = resolved.anchorNode.dataset.dehypeRawText || "";
  if (existing && previousRaw && resolved.text.length < previousRaw.length * 0.85) return false;

  const signature = `${currentMode}|${resolved.text.toLowerCase()}`;
  const processedSignature = resolved.anchorNode.dataset.dehypeProcessedSignature || "";
  if (existing && signature === processedSignature) return false;

  return true;
};

const upsertCompareBlock = (resolved, payload) => {
  if (!payload?.summary || !resolved?.anchorNode?.isConnected) return;
  ensureStyle();

  const { anchorNode, mode, text } = resolved;
  const anchorId = toAnchorId(anchorNode);
  let block = getCompareNode(anchorNode, mode);

  if (!block) {
    block = document.createElement("div");
    block.className = "dehype-compare";
    block.dataset.dehypeSummary = "1";
    block.dataset.anchorId = anchorId;

    if (mode === "append") anchorNode.appendChild(block);
    else anchorNode.insertAdjacentElement("afterend", block);
  }

  block.dataset.source = payload.source || "fallback";
  block.textContent = "";

  const summaryNode = document.createElement("div");
  summaryNode.className = "dehype-summary-text";
  summaryNode.textContent = payload.summary;
  block.appendChild(summaryNode);

  anchorNode.dataset.dehypeRawText = text;
  anchorNode.dataset.dehypeProcessedSignature = `${currentMode}|${text.toLowerCase()}`;
};

const requestRewrite = (text) =>
  new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "DEHYPE_REQUEST", text }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (!response || !response.ok) {
        reject(new Error(response?.error || "De-hype failed"));
        return;
      }

      resolve(response);
    });
  });

const processCandidate = async (candidate) => {
  const resolved = resolveCandidate(candidate);
  if (!resolved || !shouldProcess(resolved)) return;

  try {
    const response = await requestRewrite(resolved.text);
    if (!response?.summary) return;
    upsertCompareBlock(resolved, response);
  } catch (error) {
    console.debug("[De-Hype] Rewrite failed:", error?.message || error);
  }
};

const processQueue = () => {
  while (activeCount < PROCESS_CONCURRENCY && processingQueue.length > 0) {
    const element = processingQueue.shift();
    queuedElements.delete(element);

    if (!element?.isConnected) continue;
    if (!isFeatureActive()) break;

    activeCount += 1;
    inflightElements.add(element);

    processCandidate(element)
      .catch(() => {})
      .finally(() => {
        activeCount -= 1;
        inflightElements.delete(element);
        processQueue();
      });
  }
};

const enqueueCandidate = (element) => {
  if (!isFeatureActive()) return;
  if (!(element instanceof Element)) return;
  if (queuedElements.has(element) || inflightElements.has(element)) return;

  queuedElements.add(element);
  processingQueue.push(element);
  processQueue();
};

const intersectionObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting || entry.intersectionRatio > 0) {
        intersectionObserver.unobserve(entry.target);
        observedElements.delete(entry.target);
        enqueueCandidate(entry.target);
      }
    }
  },
  { rootMargin: OBSERVER_ROOT_MARGIN, threshold: 0.01 }
);

const observeCandidate = (element) => {
  if (!(element instanceof Element)) return;
  if (observedElements.has(element)) return;
  observedElements.add(element);
  intersectionObserver.observe(element);
};

const collectCandidates = (root = document) => {
  if (!(root instanceof Element || root instanceof Document)) return [];

  const plan = getSelectorPlan();
  const result = new Set();

  const collectBySelectors = (selectors) => {
    for (const selector of selectors) {
      if (root instanceof Element && root.matches(selector)) result.add(root);
      root.querySelectorAll(selector).forEach((node) => result.add(node));
    }
  };

  if (plan.primary.length > 0) {
    collectBySelectors(plan.primary);
    if (result.size > 0) return Array.from(result);
  }

  collectBySelectors(plan.fallback);
  return Array.from(result);
};

const scan = (root = document) => {
  if (!isFeatureActive()) return;
  collectCandidates(root).forEach(observeCandidate);
};

const flushMutationRoots = () => {
  mutationTimer = null;
  const roots = Array.from(mutationRoots);
  mutationRoots.clear();
  roots.forEach((root) => scan(root));
};

const scheduleMutationScan = (root) => {
  if (!(root instanceof Element || root instanceof Document)) return;
  mutationRoots.add(root);
  if (mutationTimer) return;
  mutationTimer = setTimeout(flushMutationRoots, MUTATION_DEBOUNCE_MS);
};

const clearProcessing = () => {
  processingQueue.length = 0;
  queuedElements.clear();
  inflightElements.clear();
  observedElements.clear();
  mutationRoots.clear();
  intersectionObserver.disconnect();
};

const clearInjectedSummaries = () => {
  document.querySelectorAll(".dehype-compare[data-dehype-summary='1']").forEach((node) => node.remove());
  document.querySelectorAll("[data-dehype-processed-signature]").forEach((node) => node.removeAttribute("data-dehype-processed-signature"));
  document.querySelectorAll("[data-dehype-raw-text]").forEach((node) => node.removeAttribute("data-dehype-raw-text"));
  document.querySelectorAll("[data-dehype-anchor-id]").forEach((node) => node.removeAttribute("data-dehype-anchor-id"));
};

const requestTabState = () =>
  new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_TAB_STATE" }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        resolve({ paused: false });
        return;
      }
      resolve({ paused: !!response.paused });
    });
  });

const refreshRuntimeSettings = async () => {
  const state = await chrome.storage.local.get(["deHypeEnabled", "deHypeMode", "deHypeSiteToggles"]);
  deHypeEnabled = state.deHypeEnabled !== false;
  currentMode = typeof state.deHypeMode === "string" ? state.deHypeMode : "balanced";
  siteToggles = {
    youtube: state.deHypeSiteToggles?.youtube !== false,
    cnn: state.deHypeSiteToggles?.cnn !== false,
    verge: state.deHypeSiteToggles?.verge !== false,
    generic: state.deHypeSiteToggles?.generic !== false
  };

  const tabState = await requestTabState();
  tabPaused = tabState.paused === true;
};

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;

  let needsRescan = false;
  let modeChanged = false;

  if (Object.prototype.hasOwnProperty.call(changes, "deHypeEnabled")) {
    deHypeEnabled = changes.deHypeEnabled.newValue !== false;
    needsRescan = true;
  }

  if (Object.prototype.hasOwnProperty.call(changes, "deHypeSiteToggles")) {
    siteToggles = {
      youtube: changes.deHypeSiteToggles.newValue?.youtube !== false,
      cnn: changes.deHypeSiteToggles.newValue?.cnn !== false,
      verge: changes.deHypeSiteToggles.newValue?.verge !== false,
      generic: changes.deHypeSiteToggles.newValue?.generic !== false
    };
    needsRescan = true;
  }

  if (Object.prototype.hasOwnProperty.call(changes, "deHypeMode")) {
    currentMode = typeof changes.deHypeMode.newValue === "string" ? changes.deHypeMode.newValue : "balanced";
    modeChanged = true;
    needsRescan = true;
  }

  if (!needsRescan) return;

  if (modeChanged) {
    clearInjectedSummaries();
  }

  clearProcessing();
  if (isFeatureActive()) scan(document);
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== "TAB_PAUSE_STATE") return false;

  tabPaused = message.paused === true;
  clearProcessing();
  if (isFeatureActive()) scan(document);
  return false;
});

const mutationObserver = new MutationObserver((mutations) => {
  if (!isFeatureActive()) return;

  for (const mutation of mutations) {
    if (mutation.type === "childList") {
      for (const node of mutation.addedNodes) {
        if (node instanceof Element) scheduleMutationScan(node);
      }
    }

    if (mutation.type === "characterData") {
      const parent = mutation.target?.parentElement;
      if (parent instanceof Element) scheduleMutationScan(parent);
    }
  }
});

const startMutationObserver = () => {
  if (!document.body) return;
  mutationObserver.observe(document.body, {
    childList: true,
    characterData: true,
    subtree: true
  });
};

const initialize = async () => {
  await refreshRuntimeSettings();
  if (isFeatureActive()) scan(document);
  startMutationObserver();
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initialize, { once: true });
} else {
  initialize();
}
