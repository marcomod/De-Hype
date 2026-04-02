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

let deHypeEnabled = true;
let targetCounter = 0;
let activeCount = 0;
let mutationTimer = null;

const processingQueue = [];
const queuedElements = new Set();
const inflightElements = new Set();
const observedElements = new Set();
const mutationRoots = new Set();

const normalizeText = (value = "") => value.replace(/\s+/g, " ").trim();
const isValidHeadline = (text) => {
  const words = text.split(/\s+/).filter(Boolean);
  return text.length >= MIN_TITLE_LENGTH && text.length <= MAX_TITLE_LENGTH && words.length >= 4;
};

const detectProfile = () => {
  const host = window.location.hostname;
  if (host.includes("youtube.com")) return "youtube";
  if (host.includes("cnn.com")) return "cnn";
  if (host.includes("theverge.com")) return "verge";
  return "generic";
};

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
    .dehype-summary {
      display: block;
      margin-top: 6px;
      padding: 4px 8px;
      border-left: 2px solid #0ea5e9;
      border-radius: 6px;
      font-size: 12px;
      line-height: 1.35;
      letter-spacing: 0.01em;
      background: rgba(148, 163, 184, 0.18);
      color: #334155;
      opacity: 0.95;
      word-break: break-word;
      max-width: 100%;
      white-space: normal !important;
      text-overflow: clip !important;
      overflow: visible !important;
      -webkit-line-clamp: unset !important;
    }
    .dehype-summary[data-source="cache"] {
      border-left-color: #22c55e;
    }
    .dehype-summary[data-source="fallback"],
    .dehype-summary[data-source="budget"] {
      border-left-color: #f59e0b;
    }
    html[dark] .dehype-summary,
    ytd-app[dark] .dehype-summary,
    body[data-theme="dark"] .dehype-summary {
      color: #e2e8f0;
      background: rgba(15, 23, 42, 0.78);
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
    if (style.height !== "auto" && style.height !== "0px") return true;
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
  if (node.matches("a#video-title")) score += 80;
  if (node.matches("h1, h2, h3")) score += 40;
  if (node.matches("a")) score += 20;
  return score;
};

const extractBestTitleNode = (candidate) => {
  const nodes = [];

  if (candidate.matches(TEXT_NODE_SELECTORS)) nodes.push(candidate);
  candidate.querySelectorAll(TEXT_NODE_SELECTORS).forEach((node) => nodes.push(node));

  let best = null;
  for (const node of nodes) {
    if (!(node instanceof Element)) continue;
    if (node.closest(".dehype-summary")) continue;
    const text = normalizeText(node.textContent || "");
    if (!isValidHeadline(text)) continue;
    const candidateScore = scoreTextNode(node, text);
    if (!best || candidateScore > best.score) {
      best = { node, text, score: candidateScore };
    }
  }

  return best ? { textNode: best.node, text: best.text } : null;
};

const escapeClipping = (node) => {
  if (!(node instanceof Element)) return null;
  let anchor = node;
  let hops = 0;
  while (anchor.parentElement && hops < 10 && isClippingContainer(anchor.parentElement)) {
    anchor = anchor.parentElement;
    hops += 1;
  }
  if (anchor.tagName === "A" && anchor.parentElement) {
    return anchor.parentElement;
  }
  return anchor;
};

const resolveInsertAnchor = (candidate, textNode) => {
  const profile = detectProfile();

  if (profile === "youtube") {
    const card = candidate.closest(YOUTUBE_CARD_SELECTORS);
    if (card) {
      const metaContainer = card.querySelector("#meta, #details, #title-wrapper, #top-row");
      if (metaContainer instanceof Element && !isClippingContainer(metaContainer)) {
        return { node: metaContainer, mode: "append" };
      }
    }
  }

  const semantic = textNode.closest("h1, h2, h3, a, yt-formatted-string, .duet--title, .container__headline, .headline");
  const anchor = escapeClipping(semantic || textNode);
  return { node: anchor || textNode, mode: "after" };
};

const getSummaryNode = (anchorNode, mode) => {
  const anchorId = toAnchorId(anchorNode);
  if (mode === "append") {
    return anchorNode.querySelector(`.dehype-summary[data-anchor-id="${anchorId}"]`);
  }
  const directNext = anchorNode.nextElementSibling;
  if (directNext && directNext.classList.contains("dehype-summary") && directNext.dataset.anchorId === anchorId) {
    return directNext;
  }
  const parent = anchorNode.parentElement;
  if (!parent) return null;
  return parent.querySelector(`.dehype-summary[data-anchor-id="${anchorId}"]`);
};

const resolveCandidate = (candidate) => {
  if (!(candidate instanceof Element)) return null;
  if (candidate.closest(".dehype-summary")) return null;

  const extracted = extractBestTitleNode(candidate);
  if (!extracted) return null;

  const { textNode, text } = extracted;
  const anchor = resolveInsertAnchor(candidate, textNode);
  if (!anchor?.node?.isConnected) return null;

  return { text, anchorNode: anchor.node, mode: anchor.mode };
};

const shouldProcess = (resolved) => {
  if (!deHypeEnabled) return false;
  if (!resolved?.anchorNode?.isConnected) return false;
  if (!isValidHeadline(resolved.text)) return false;

  const processed = resolved.anchorNode.dataset.dehypeProcessedText || "";
  const normalized = resolved.text.toLowerCase();
  const previousRaw = resolved.anchorNode.dataset.dehypeRawText || "";
  const existingSummary = getSummaryNode(resolved.anchorNode, resolved.mode);

  if (existingSummary && previousRaw && resolved.text.length < previousRaw.length * 0.85) return false;
  if (processed === normalized && getSummaryNode(resolved.anchorNode, resolved.mode)) return false;
  return true;
};

const upsertSummary = (resolved, summaryText, source) => {
  if (!summaryText || !resolved?.anchorNode?.isConnected) return;
  ensureStyle();

  const { anchorNode, mode, text } = resolved;
  const anchorId = toAnchorId(anchorNode);
  let summaryNode = getSummaryNode(anchorNode, mode);

  if (!summaryNode) {
    summaryNode = document.createElement("div");
    summaryNode.className = "dehype-summary";
    summaryNode.dataset.dehypeSummary = "1";
    summaryNode.dataset.anchorId = anchorId;
    if (mode === "append") {
      anchorNode.appendChild(summaryNode);
    } else {
      anchorNode.insertAdjacentElement("afterend", summaryNode);
    }
  }

  summaryNode.textContent = summaryText;
  summaryNode.dataset.source = source || "api";
  anchorNode.dataset.dehypeProcessedText = text.toLowerCase();
  anchorNode.dataset.dehypeRawText = text;
};

const requestRewrite = (text) =>
  new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "DEHYPE_REQUEST", text }, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response || !response.ok) return reject(new Error(response?.error || "De-hype failed"));
      resolve(response);
    });
  });

const processCandidate = async (candidate) => {
  const resolved = resolveCandidate(candidate);
  if (!resolved || !shouldProcess(resolved)) return;

  try {
    const response = await requestRewrite(resolved.text);
    if (response?.text) upsertSummary(resolved, response.text, response.source);
  } catch (error) {
    console.debug("[De-Hype] Rewrite failed:", error?.message || error);
  }
};

const processQueue = () => {
  while (activeCount < PROCESS_CONCURRENCY && processingQueue.length > 0) {
    const element = processingQueue.shift();
    queuedElements.delete(element);
    if (!element?.isConnected) continue;
    if (!deHypeEnabled) break;

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
  if (!deHypeEnabled) return;
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
  if (!deHypeEnabled) return;
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

const clearInjectedSummaries = () => {
  document.querySelectorAll(".dehype-summary[data-dehype-summary='1']").forEach((node) => node.remove());
  document.querySelectorAll("[data-dehype-processed-text]").forEach((node) => node.removeAttribute("data-dehype-processed-text"));
  document.querySelectorAll("[data-dehype-raw-text]").forEach((node) => node.removeAttribute("data-dehype-raw-text"));
  document.querySelectorAll("[data-dehype-anchor-id]").forEach((node) => node.removeAttribute("data-dehype-anchor-id"));
};

const clearProcessing = () => {
  processingQueue.length = 0;
  queuedElements.clear();
  inflightElements.clear();
  intersectionObserver.disconnect();
  observedElements.clear();
};

chrome.storage.local.get(["deHypeEnabled"]).then((state) => {
  deHypeEnabled = state.deHypeEnabled !== false;
  if (deHypeEnabled) scan(document);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!Object.prototype.hasOwnProperty.call(changes, "deHypeEnabled")) return;

  deHypeEnabled = changes.deHypeEnabled.newValue;
  if (!deHypeEnabled) {
    clearProcessing();
    clearInjectedSummaries();
    return;
  }
  scan(document);
});

const mutationObserver = new MutationObserver((mutations) => {
  if (!deHypeEnabled) return;
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

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startMutationObserver, { once: true });
} else {
  startMutationObserver();
}
