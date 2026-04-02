const MIN_TITLE_LENGTH = 12;
const MAX_TITLE_LENGTH = 180;
const PROCESS_CONCURRENCY = 3;
const OBSERVER_ROOT_MARGIN = "500px 0px";
const MUTATION_DEBOUNCE_MS = 150;
const STYLE_ID = "dehype-summary-style";

const PROFILE_SELECTORS = {
  youtube: [
    "ytd-rich-item-renderer a#video-title",
    "ytd-video-renderer a#video-title",
    "ytd-grid-video-renderer a#video-title",
    "ytd-compact-video-renderer a#video-title",
    "ytd-playlist-video-renderer a#video-title",
    "h1.ytd-watch-metadata yt-formatted-string",
    "ytd-reel-item-renderer #video-title"
  ],
  cnn: [
    ".container__headline-text",
    ".headline__text",
    ".card-title",
    "h2.container__headline",
    "h3.container__headline"
  ],
  verge: [
    ".duet--article--headline a",
    ".duet--title",
    ".c-entry-box--compact__title a",
    "h2 a[data-analytics-link='article']",
    "h3 a[data-analytics-link='article']"
  ]
};

const GENERIC_FALLBACK_SELECTORS = ["main h1", "main h2", "main h3", "article h1", "article h2", "article h3"];

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

const isValidHeadline = (text) => text.length >= MIN_TITLE_LENGTH && text.length <= MAX_TITLE_LENGTH;

const detectProfile = () => {
  const host = window.location.hostname;
  if (host.includes("youtube.com")) return "youtube";
  if (host.includes("cnn.com")) return "cnn";
  if (host.includes("theverge.com")) return "verge";
  return "generic";
};

const getActiveSelectors = () => PROFILE_SELECTORS[detectProfile()] || [];

const ensureStyle = () => {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .dehype-summary {
      display: block;
      margin-top: 4px;
      padding: 2px 8px;
      border-left: 2px solid #0ea5e9;
      border-radius: 6px;
      font-size: 12px;
      line-height: 1.35;
      letter-spacing: 0.01em;
      background: rgba(148, 163, 184, 0.18);
      color: #334155;
      opacity: 0.92;
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

const matchesAnySelector = (element, selectors) => selectors.some((selector) => element.matches(selector));

const collectFromRoot = (root, selectors, outputSet) => {
  if (!(root instanceof Element || root instanceof Document)) return;
  if (root instanceof Element && matchesAnySelector(root, selectors)) outputSet.add(root);
  for (const selector of selectors) {
    root.querySelectorAll(selector).forEach((node) => outputSet.add(node));
  }
};

const collectCandidates = (root = document) => {
  const candidates = new Set();
  const selectors = getActiveSelectors();
  collectFromRoot(root, selectors, candidates);

  if (selectors.length > 0 && candidates.size > 0) {
    return Array.from(candidates);
  }

  const genericCandidates = new Set();
  collectFromRoot(root, GENERIC_FALLBACK_SELECTORS, genericCandidates);
  return Array.from(genericCandidates);
};

const getDirectText = (element) =>
  normalizeText(
    Array.from(element.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent || "")
      .join(" ")
  );

const findNearestTextNode = (rootElement) => {
  const queue = [rootElement];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!(current instanceof Element)) continue;
    if (current.dataset.dehypeSummary === "1") continue;

    const directText = getDirectText(current);
    const leafText = current.children.length === 0 ? normalizeText(current.textContent || "") : "";
    const candidateText = directText || leafText;
    if (isValidHeadline(candidateText)) {
      return { textNode: current, text: candidateText };
    }

    queue.push(...current.children);
  }

  return null;
};

const getTargetId = (element) => {
  if (!element.dataset.dehypeTargetId) {
    targetCounter += 1;
    element.dataset.dehypeTargetId = `dehype-${targetCounter}`;
  }
  return element.dataset.dehypeTargetId;
};

const getSummaryNode = (textNode) => {
  const targetId = getTargetId(textNode);
  const host = textNode.parentElement || textNode;
  return host.querySelector(`.dehype-summary[data-target-id="${targetId}"]`);
};

const shouldProcess = (textNode, text) => {
  if (!deHypeEnabled) return false;
  if (!textNode.isConnected) return false;
  if (!isValidHeadline(text)) return false;
  if (textNode.closest(".dehype-summary")) return false;

  const processedKey = textNode.dataset.dehypeProcessedText || "";
  const normalizedKey = text.toLowerCase();
  if (processedKey === normalizedKey && getSummaryNode(textNode)) return false;

  return true;
};

const upsertSummary = (textNode, summaryText, source = "api") => {
  if (!summaryText || !textNode?.isConnected) return;
  ensureStyle();

  const targetId = getTargetId(textNode);
  let summaryNode = getSummaryNode(textNode);

  if (!summaryNode) {
    summaryNode = document.createElement("div");
    summaryNode.className = "dehype-summary";
    summaryNode.dataset.dehypeSummary = "1";
    summaryNode.dataset.targetId = targetId;
    textNode.insertAdjacentElement("afterend", summaryNode);
  }

  summaryNode.textContent = summaryText;
  summaryNode.dataset.source = source;
  textNode.dataset.dehypeProcessedText = normalizeText(textNode.textContent || "").toLowerCase();
};

const requestRewrite = (text) =>
  new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "DEHYPE_REQUEST", text }, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response || !response.ok) return reject(new Error(response?.error || "De-hype failed"));
      resolve(response);
    });
  });

const processCandidate = async (element) => {
  const detail = findNearestTextNode(element);
  if (!detail) return;
  const { textNode, text } = detail;

  if (!shouldProcess(textNode, text)) return;

  try {
    const response = await requestRewrite(text);
    if (response?.text) {
      upsertSummary(textNode, response.text, response.source || "api");
    }
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

const scan = (root = document) => {
  if (!deHypeEnabled) return;
  const candidates = collectCandidates(root);
  candidates.forEach(observeCandidate);
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
    return;
  }
  scan(document);
});

const mutationObserver = new MutationObserver((mutations) => {
  if (!deHypeEnabled) return;
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (!(node instanceof Element)) continue;
      scheduleMutationScan(node);
    }
  }
});

const startMutationObserver = () => {
  if (!document.body) return;
  mutationObserver.observe(document.body, { childList: true, subtree: true });
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startMutationObserver, { once: true });
} else {
  startMutationObserver();
}
