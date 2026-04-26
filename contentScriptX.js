// contentScriptX.js

(function () {
  const log = (...args) => console.log('[SSE:X]', ...args);

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitForSelectorCount(selector, minCount = 1, timeoutMs = 30000, pollMs = 500) {
    const start = Date.now();
    const root = getPrimaryRoot();
    while (Date.now() - start < timeoutMs) {
      const count = root.querySelectorAll(selector).length;
      if (count >= minCount) return { ok: true, count };
      await wait(pollMs);
    }
    const count = getPrimaryRoot().querySelectorAll(selector).length;
    return { ok: false, count, error: `Timeout waiting for selector: ${selector}` };
  }

  function getPrimaryRoot() {
    return (
      document.querySelector('div[data-testid="primaryColumn"]') ||
      document.querySelector('main') ||
      document.body
    );
  }

  function isWhoToFollowContext(el) {
    if (!el) return false;
    if (el.closest('aside')) return true;

    // X frequently uses headings/labels like "Who to follow" for suggestions modules.
    const section = el.closest('section');
    if (section) {
      const aria = (section.getAttribute('aria-label') || '').trim();
      if (/who to follow/i.test(aria)) return true;
      const heading = section.querySelector('h2, h3');
      const headingText = (heading?.textContent || '').trim();
      if (/who to follow/i.test(headingText)) return true;
    }

    const labeled = el.closest('[aria-label]');
    const label = (labeled?.getAttribute('aria-label') || '').trim();
    if (/who to follow/i.test(label)) return true;

    // Fallback: sometimes the module is a container with visible text.
    const containerText = (section?.textContent || '').slice(0, 2000);
    if (/who to follow/i.test(containerText)) return true;

    return false;
  }

  function normalizeUrl(url) {
    try {
      const u = new URL(url);
      u.hash = '';
      u.search = '';
      return u.toString();
    } catch {
      return url;
    }
  }

  function getStatusIdFromPath(pathname) {
    const match = (pathname || '').match(/\/status\/(\d+)/);
    return match ? match[1] : null;
  }

  function findTweetArticleForStatusId(statusId) {
    const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    if (!statusId) return articles[0] || null;

    for (const article of articles) {
      const link = article.querySelector(`a[href*="/status/${statusId}"]`);
      if (link) return article;
    }

    // Fallback: sometimes the link is not inside the article yet.
    return articles[0] || null;
  }

  function extractUserFromTweet(article) {
    const userName = article.querySelector('[data-testid="User-Name"]');
    if (!userName) return { displayName: null, username: null, profileUrl: null };

    const links = userName.querySelectorAll('a');
    const displayName = links[0]?.textContent?.trim() || null;
    const profileUrl = links[0]?.href || null;
    const username = links[1]?.textContent?.trim() || null;
    return { displayName, username, profileUrl };
  }

  function extractTextFromTweet(article) {
    const text = article.querySelector('[data-testid="tweetText"]');
    return text ? text.textContent.trim() : null;
  }

  function extractTimeFromTweet(article) {
    const time = article.querySelector('time');
    if (!time) return { timestamp: null, timestampText: null };
    return {
      timestamp: time.getAttribute('datetime'),
      timestampText: time.textContent.trim(),
    };
  }

  function extractCountFromButton(article, testId) {
    const btn = article.querySelector(`[data-testid="${testId}"]`) || article.querySelector(`[data-testid="un${testId}"]`);
    const aria = btn?.getAttribute('aria-label') || '';
    const match = aria.match(/^(\d+[\d,\.]*(?:[km])?)/i);
    return match ? match[1] : null;
  }

  function extractViewsFromTweet(article) {
    const parseViews = (s) => {
      const text = String(s || '').replace(/\s+/g, ' ').trim();
      // Examples:
      // "7,154 Views" or "7,154 Views. View post analytics"
      const m = text.match(/(\d+[\d,\.]*(?:\s*[km])?)\s+Views\b/i);
      return m ? m[1].replace(/\s+/g, '') : null;
    };

    // 1) Best source: analytics link/button aria-label.
    const analytics =
      article.querySelector('a[href*="/analytics"]') ||
      article.querySelector('[aria-label*="Views"]') ||
      article.querySelector('a[aria-label*="Views"]') ||
      article.querySelector('div[aria-label*="Views"]');
    const aria = analytics?.getAttribute?.('aria-label');
    const fromAria = parseViews(aria);
    if (fromAria) return fromAria;

    // 2) Near the time row ("9:12 PM · Nov 26, 2024 · 7,154 Views").
    const timeEl = article.querySelector('time');
    if (timeEl) {
      const row = timeEl.closest('div');
      const rowText = parseViews(row?.textContent);
      if (rowText) return rowText;
      const parentText = parseViews(row?.parentElement?.textContent);
      if (parentText) return parentText;
      const grandParentText = parseViews(row?.parentElement?.parentElement?.textContent);
      if (grandParentText) return grandParentText;
    }

    // 3) Fallback: within the article text itself.
    return parseViews(article.innerText);
  }

  function parseHumanCountToNumber(s) {
    const text = String(s || '').trim();
    if (!text) return null;
    const m = text.match(/^(\d+(?:[\.,]\d+)?)(\s*[kKmM])?$/);
    if (!m) {
      const digits = text.replace(/[^0-9]/g, '');
      return digits ? Number(digits) : null;
    }
    const base = Number(String(m[1]).replace(',', '.'));
    if (!Number.isFinite(base)) return null;
    const suf = (m[2] || '').trim().toLowerCase();
    if (suf === 'k') return Math.round(base * 1000);
    if (suf === 'm') return Math.round(base * 1000000);
    return Math.round(base);
  }

  function extractEngagementCountsFromTabs() {
    const root = getPrimaryRoot();
    const tabs = Array.from(root.querySelectorAll('[role="tab"]'));
    const pickCount = (tab) => {
      const aria = (tab?.getAttribute?.('aria-label') || '').replace(/\s+/g, ' ').trim();
      const txt = (tab?.textContent || '').replace(/\s+/g, ' ').trim();
      const combined = `${aria} ${txt}`.replace(/\s+/g, ' ').trim();
      // Find the first count-like token (supports 1,234 / 1.2K / 3M)
      const m = combined.match(/(\d+[\d,\.]*(?:\s*[kKmM])?)/);
      return {
        combined,
        countText: m ? m[1] : null,
        count: m ? parseHumanCountToNumber(m[1]) : null,
      };
    };

    let reposts = null;
    let quotes = null;
    let repostsRaw = null;
    let quotesRaw = null;

    for (const t of tabs) {
      const text = (t?.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (/reposts|retweets/i.test(text)) {
        const p = pickCount(t);
        reposts = p.count;
        repostsRaw = p.combined;
      }
      if (/quotes/i.test(text)) {
        const p = pickCount(t);
        quotes = p.count;
        quotesRaw = p.combined;
      }
    }

    return {
      repostsCount: Number.isFinite(reposts) ? reposts : null,
      quotesCount: Number.isFinite(quotes) ? quotes : null,
      raw: {
        reposts: repostsRaw,
        quotes: quotesRaw,
      },
    };
  }

  function clickRoleTabMatching(regex) {
    try {
      const root = getPrimaryRoot();
      const tabs = Array.from(root.querySelectorAll('[role="tab"]'))
        .filter((t) => t && t.textContent);
      for (const t of tabs) {
        const text = (t.textContent || '').replace(/\s+/g, ' ').trim();
        if (regex.test(text)) {
          try { t.click(); } catch { /* ignore */ }
          return true;
        }
      }
    } catch {
      // ignore
    }
    return false;
  }

  function extractMainTweetData() {
    const url = new URL(window.location.href);
    const statusId = getStatusIdFromPath(url.pathname);
    const article = findTweetArticleForStatusId(statusId);
    if (!article) return null;

    const extractEngagementCountsFromArticle = () => {
      const parseNumberFromText = (s) => {
        const text = String(s || '').replace(/\s+/g, ' ').trim();
        if (!text) return null;
        // Prefer a leading count.
        const m = text.match(/^(\d+[\d,\.]*(?:\s*[kKmM])?)/);
        return m ? m[1] : null;
      };

      const pickCountFromLink = (a) => {
        if (!a) return null;
        // Typical structure: <a ...><span>229</span><span>Reposts</span></a>
        const spans = Array.from(a.querySelectorAll('span'));
        for (const sp of spans) {
          const t = (sp.textContent || '').trim();
          const numText = parseNumberFromText(t);
          if (numText) {
            const n = parseHumanCountToNumber(numText);
            return Number.isFinite(n) ? { countText: numText, count: n } : { countText: numText, count: null };
          }
        }

        // Fallback: parse from aria-label/textContent.
        const aria = (a.getAttribute('aria-label') || '').trim();
        const numText = parseNumberFromText(aria) || parseNumberFromText(a.textContent);
        if (!numText) return null;
        const n = parseHumanCountToNumber(numText);
        return Number.isFinite(n) ? { countText: numText, count: n } : { countText: numText, count: null };
      };

      const out = {
        quotesCount: null,
        quotesCountText: null,
        repostsCount: null,
        repostsCountText: null,
      };

      // Look for engagement links in the tweet page (not in action buttons row).
      const links = Array.from(article.querySelectorAll('a[href]'));
      for (const a of links) {
        const href = a.getAttribute('href') || '';
        if (!href) continue;

        if (!out.quotesCountText && /\/quotes(?:\b|\?|$)/i.test(href)) {
          const p = pickCountFromLink(a);
          if (p?.countText) {
            out.quotesCountText = p.countText;
            out.quotesCount = Number.isFinite(p.count) ? p.count : null;
          }
        }

        if (!out.repostsCountText && /\/retweets(?:\b|\?|$)/i.test(href)) {
          const p = pickCountFromLink(a);
          if (p?.countText) {
            out.repostsCountText = p.countText;
            out.repostsCount = Number.isFinite(p.count) ? p.count : null;
          }
        }

        if (out.quotesCountText && out.repostsCountText) break;
      }

      return out;
    };

    const { timestamp, timestampText } = extractTimeFromTweet(article);
    const { displayName, username, profileUrl } = extractUserFromTweet(article);
    const engagementCounts = extractEngagementCountsFromArticle();

    // The retweet/repost button count on the tweet action row is commonly a combined count
    // (reposts + quote posts). We store it separately as a reliable upper-bound.
    const combinedRepostsAndQuotesCountText = extractCountFromButton(article, 'retweet');
    const combinedRepostsAndQuotesCount = parseHumanCountToNumber(combinedRepostsAndQuotesCountText);

    return {
      kind: 'MAIN_POST',
      tweetUrl: normalizeUrl(window.location.href),
      statusId,
      timestamp,
      timestampText,
      displayName,
      username,
      profileUrl,
      tweetText: extractTextFromTweet(article),
      replyCount: extractCountFromButton(article, 'reply'),
      repostCount: combinedRepostsAndQuotesCountText,
      combinedRepostsAndQuotesCountText,
      combinedRepostsAndQuotesCount: Number.isFinite(combinedRepostsAndQuotesCount) ? combinedRepostsAndQuotesCount : null,
      // Prefer the tweet-page engagement row counts when present (used as an upper-bound target).
      repostsCount: engagementCounts.repostsCount,
      repostsCountText: engagementCounts.repostsCountText,
      quotesCount: engagementCounts.quotesCount,
      quotesCountText: engagementCounts.quotesCountText,
      likeCount: extractCountFromButton(article, 'like'),
      viewCount: extractViewsFromTweet(article),
    };
  }

  async function autoScrollToBottom({ maxScrolls = 18, settleLoops = 3, delayMs = 1700 } = {}) {
    const root = getPrimaryRoot();
    const stabilizeSelector = arguments[0]?.stabilizeSelector;
    const stabilizeMode = arguments[0]?.stabilizeMode || 'count';
    const returnToTop = arguments[0]?.returnToTop !== false;

    const computeSignature = (selector, limit = 14) => {
      if (!selector) return '';
      const nodes = Array.from(root.querySelectorAll(selector)).slice(0, limit);
      return nodes
        .map((n) => {
          // Prefer stable ids when available.
          const testId = n.getAttribute?.('data-testid') || '';
          if (testId) return testId;
          const a = n.querySelector?.('a[href]')?.getAttribute?.('href') || '';
          return (a || n.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        })
        .join('|');
    };

    const clickLoadMoreButtons = () => {
      const candidates = Array.from(root.querySelectorAll('div[role="button"], button'));
      for (const btn of candidates) {
        const t = (btn.textContent || '').trim();
        if (!t) continue;
        if (/show more|retry|try again|load more/i.test(t)) {
          try { btn.click(); } catch { /* ignore */ }
        }
      }
    };

    let noChange = 0;
    let lastCount = stabilizeSelector ? root.querySelectorAll(stabilizeSelector).length : -1;
    let lastSig = stabilizeSelector ? computeSignature(stabilizeSelector) : '';
    let lastHeight = Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0);

    for (let i = 0; i < maxScrolls && noChange < settleLoops; i++) {
      // Use incremental scroll; X lists are often virtualized.
      window.scrollBy(0, Math.max(500, Math.floor(window.innerHeight * 0.9)));
      if (i % 4 === 3) {
        // Occasionally jump to bottom to trigger loaders.
        const h = Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0);
        window.scrollTo(0, h);
      }

      await wait(delayMs);
      clickLoadMoreButtons();
      await wait(300);

      const newHeight = Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0);
      const newCount = stabilizeSelector ? root.querySelectorAll(stabilizeSelector).length : -1;
      const newSig = stabilizeSelector ? computeSignature(stabilizeSelector) : '';

      if (stabilizeSelector) {
        if (stabilizeMode === 'signature') {
          if (newSig && newSig === lastSig) noChange++;
          else noChange = 0;
          lastSig = newSig;
        } else {
          if (newCount <= lastCount) noChange++;
          else noChange = 0;
          lastCount = newCount;
        }
      } else {
        if (newHeight === lastHeight) noChange++;
        else noChange = 0;
        lastHeight = newHeight;
      }
    }

    if (returnToTop) {
      window.scrollTo(0, 0);
      await wait(350);
    }
  }

  async function scrollAndCollectRetweeters({
    parentTweetUrl,
    maxScrolls = 140,
    settleLoops = 22,
    delayMs = 1200,
    targetCount = null,
    maxDurationMs = 2 * 60 * 1000,
    stallTimeoutMs = 15000,
  } = {}) {
    const primary = getPrimaryRoot();
    // Some X variants render lists outside primaryColumn; fallback to document.
    const root = primary.querySelector('[data-testid="UserCell"]') ? primary : document;
    const seen = new Map();

    const clickLoadMoreButtons = () => {
      const candidates = Array.from(root.querySelectorAll('div[role="button"], button'));
      for (const btn of candidates) {
        const t = (btn.textContent || '').trim();
        if (!t) continue;
        if (/show more|retry|try again|load more|see more|view more/i.test(t)) {
          try { btn.click(); } catch { /* ignore */ }
        }
      }
    };

    const isScrollable = (el) => {
      if (!el) return false;
      try {
        const s = window.getComputedStyle(el);
        const scrollY = s.overflowY === 'auto' || s.overflowY === 'scroll';
        return scrollY && el.scrollHeight > el.clientHeight + 50;
      } catch {
        return false;
      }
    };

    const getScrollContainer = () => {
      // Best: nearest scrollable ancestor of a visible user row.
      const firstCell = root.querySelector('[data-testid="UserCell"]');
      if (firstCell) {
        let cur = firstCell.parentElement;
        while (cur && cur !== document.body) {
          if (isScrollable(cur)) return cur;
          cur = cur.parentElement;
        }
      }

      // Next: timeline-ish containers.
      const timeline =
        root.querySelector('div[aria-label^="Timeline:"]') ||
        root.querySelector('section[aria-label^="Timeline:"]');
      if (timeline && isScrollable(timeline)) return timeline;

      // Fallback: largest scrollable inside our root.
      const candidates = Array.from(root.querySelectorAll('div, section')).filter(isScrollable);
      if (candidates.length > 0) {
        return candidates.reduce((a, b) => (a.scrollHeight > b.scrollHeight ? a : b));
      }

      return document.scrollingElement || document.documentElement || document.body;
    };

    const scrollStep = (container, stepPx) => {
      try {
        if (!container) {
          window.scrollBy(0, stepPx);
          return;
        }
        const isDoc = container === document.scrollingElement || container === document.documentElement || container === document.body;
        if (isDoc) {
          window.scrollBy(0, stepPx);
          return;
        }
        container.scrollTop = Math.min(container.scrollTop + stepPx, container.scrollHeight);
      } catch {
        try { window.scrollBy(0, stepPx); } catch { /* ignore */ }
      }
    };

    const scrollToBottom = (container) => {
      try {
        const isDoc = container === document.scrollingElement || container === document.documentElement || container === document.body;
        if (isDoc) {
          const h = Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0);
          window.scrollTo(0, h);
          return;
        }
        container.scrollTop = container.scrollHeight;
      } catch {
        const h = Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0);
        try { window.scrollTo(0, h); } catch { /* ignore */ }
      }
    };

    const signatureForUserCells = (limit = 8) => {
      const all = Array.from(root.querySelectorAll('[data-testid="UserCell"]'));
      const head = all.slice(0, limit);
      const tail = all.length > limit ? all.slice(-limit) : [];
      const cells = head.concat(tail);
      const parts = [];
      for (const cell of cells) {
        const avatar = cell.querySelector('[data-testid^="UserAvatar-Container-"]');
        const testId = avatar?.getAttribute('data-testid') || '';
        if (testId) {
          parts.push(testId);
          continue;
        }
        const handle = Array.from(cell.querySelectorAll('span')).map(s => (s.textContent || '').trim()).find(t => t.startsWith('@'));
        parts.push(handle || (cell.textContent || '').trim().slice(0, 30));
      }
      return parts.join('|');
    };

    const scrollByLastCell = async () => {
      const cells = Array.from(root.querySelectorAll('[data-testid="UserCell"]'));
      const last = cells[cells.length - 1];
      if (last && typeof last.scrollIntoView === 'function') {
        try {
          last.scrollIntoView({ block: 'end' });
          return true;
        } catch {
          // ignore
        }
      }
      return false;
    };

    // Ensure we're on the actual "Reposts/Retweets" list tab (X sometimes renders a different tab view).
    clickRoleTabMatching(/reposts|retweets/i);

    let noProgress = 0;
    let lastSig = signatureForUserCells();
    let lastSeenCount = 0;
    const start = Date.now();
    let lastProgressAt = Date.now();

    // Adaptive pacing: fast when list is progressing, slower only when it stalls.
    let dynamicDelayMs = Math.max(450, Math.min(1400, Number(delayMs) || 1200));

    const toFiniteTarget = () => {
      const n = Number(targetCount);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const target = toFiniteTarget();
    const container = getScrollContainer();

    // For tiny target counts, don't require many iterations before considering a stall.
    const minIterationsBeforeStallBreak = target && target <= 20 ? 2 : 8;

    for (let i = 0; i < maxScrolls && noProgress < settleLoops; i++) {
      const now = Date.now();
      if (now - start > maxDurationMs) break;
      if (now - lastProgressAt > stallTimeoutMs && i > minIterationsBeforeStallBreak) break;

      // Collect what is currently rendered.
      const batch = collectRetweeters({ parentTweetUrl });
      for (const item of batch) {
        if (!item?.username) continue;
        if (!seen.has(item.username)) seen.set(item.username, item);
      }

      if (target && seen.size >= target) break;

      const currentSeen = seen.size;
      const sigNow = signatureForUserCells();

      const progressed = (currentSeen > lastSeenCount) || (sigNow && sigNow !== lastSig);
      if (!progressed) noProgress++;
      else noProgress = 0;

      if (progressed) lastProgressAt = Date.now();

      if (progressed) {
        dynamicDelayMs = Math.max(450, Math.floor(dynamicDelayMs * 0.75));
      } else {
        dynamicDelayMs = Math.min(2200, Math.floor(dynamicDelayMs * 1.2) + 80);
      }

      lastSeenCount = currentSeen;
      lastSig = sigNow;

      // Scroll down (virtualized list): prefer moving the last visible row into view.
      // This tends to trigger the list virtualization more reliably than scrollTop math.
      const didScrollIntoView = await scrollByLastCell();
      if (!didScrollIntoView) {
        const step = Math.max(700, Math.floor(window.innerHeight * 0.95));
        scrollStep(container, step);
        if (i % 6 === 5) scrollToBottom(container);
      } else if (i % 10 === 9) {
        // Occasionally force a bottom jump to shake loose loaders.
        scrollToBottom(container);
      }

      // Give the virtual list time to swap nodes in.
      await wait(dynamicDelayMs);
      clickLoadMoreButtons();
      await wait(180);
    }

    // Final collect after the last scroll.
    const finalBatch = collectRetweeters({ parentTweetUrl });
    for (const item of finalBatch) {
      if (!item?.username) continue;
      if (!seen.has(item.username)) seen.set(item.username, item);
    }

    return {
      ok: true,
      meta: {
        maxScrolls,
        settleLoops,
        stallTimeoutMs,
        delayMs: dynamicDelayMs,
        seen: seen.size,
        targetCount: target || null,
        durationMs: Date.now() - start,
      },
      data: Array.from(seen.values()),
    };
  }

  async function scrollAndCollectQuotes({
    parentTweetUrl,
    maxScrolls = 180,
    settleLoops = 22,
    delayMs = 1100,
    targetCount = null,
    maxDurationMs = 90 * 1000,
    stallTimeoutMs = 12000,
  } = {}) {
      // Ensure we're on the "Quotes" list tab if tabs are present.
      clickRoleTabMatching(/quotes/i);

    const primary = getPrimaryRoot();
    const root = primary.querySelector('article[data-testid="tweet"]') ? primary : document;
    const seen = new Map();

    const clickLoadMoreButtons = () => {
      const candidates = Array.from(root.querySelectorAll('div[role="button"], button'));
      for (const btn of candidates) {
        const t = (btn.textContent || '').trim();
        if (!t) continue;
        if (/show more|retry|try again|load more|see more|view more/i.test(t)) {
          try { btn.click(); } catch { /* ignore */ }
        }
      }
    };

    const isScrollable = (el) => {
      if (!el) return false;
      try {
        const s = window.getComputedStyle(el);
        const scrollY = s.overflowY === 'auto' || s.overflowY === 'scroll';
        return scrollY && el.scrollHeight > el.clientHeight + 50;
      } catch {
        return false;
      }
    };

    const getScrollContainer = () => {
      const firstTweet = root.querySelector('article[data-testid="tweet"]');
      if (firstTweet) {
        let cur = firstTweet.parentElement;
        while (cur && cur !== document.body) {
          if (isScrollable(cur)) return cur;
          cur = cur.parentElement;
        }
      }

      const timeline =
        root.querySelector('div[aria-label^="Timeline:"]') ||
        root.querySelector('section[aria-label^="Timeline:"]');
      if (timeline && isScrollable(timeline)) return timeline;

      const candidates = Array.from(root.querySelectorAll('div, section')).filter(isScrollable);
      if (candidates.length > 0) return candidates.reduce((a, b) => (a.scrollHeight > b.scrollHeight ? a : b));

      return document.scrollingElement || document.documentElement || document.body;
    };

    const scrollToBottom = (container) => {
      try {
        const isDoc = container === document.scrollingElement || container === document.documentElement || container === document.body;
        if (isDoc) {
          const h = Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0);
          window.scrollTo(0, h);
          return;
        }
        container.scrollTop = container.scrollHeight;
      } catch {
        const h = Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0);
        try { window.scrollTo(0, h); } catch { /* ignore */ }
      }
    };

    const signatureForTweets = (limit = 6) => {
      const all = Array.from(root.querySelectorAll('article[data-testid="tweet"]'));
      const head = all.slice(0, limit);
      const tail = all.length > limit ? all.slice(-limit) : [];
      const tweets = head.concat(tail);
      const parts = [];
      for (const tweet of tweets) {
        const a = tweet.querySelector('a[href*="/status/"]');
        const href = a?.getAttribute('href') || a?.href || '';
        const time = tweet.querySelector('time')?.getAttribute('datetime') || '';
        parts.push(`${href}|${time}`.slice(0, 140));
      }
      return parts.join('||');
    };

    const scrollByLastTweet = async () => {
      const tweets = Array.from(root.querySelectorAll('article[data-testid="tweet"]'));
      const last = tweets[tweets.length - 1];
      if (last && typeof last.scrollIntoView === 'function') {
        try {
          last.scrollIntoView({ block: 'end' });
          return true;
        } catch {
          // ignore
        }
      }
      return false;
    };

    const toFiniteTarget = () => {
      const n = Number(targetCount);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const target = toFiniteTarget();

    const minIterationsBeforeStallBreak = target && target <= 20 ? 2 : 10;

    let noProgress = 0;
    let lastSig = signatureForTweets();
    let lastSeenCount = 0;
    const start = Date.now();
    let lastProgressAt = Date.now();
    const container = getScrollContainer();

    // Adaptive pacing: fast while new quotes appear; slow down only if X stalls.
    let dynamicDelayMs = Math.max(350, Math.min(1300, Number(delayMs) || 1100));

    for (let i = 0; i < maxScrolls && noProgress < settleLoops; i++) {
      const now = Date.now();
      if (now - start > maxDurationMs) break;
      if (now - lastProgressAt > stallTimeoutMs && i > minIterationsBeforeStallBreak) break;

      const batch = collectQuotes({ parentTweetUrl });
      for (const item of batch) {
        if (!item?.tweetUrl) continue;
        if (!seen.has(item.tweetUrl)) seen.set(item.tweetUrl, item);
      }

      if (target && seen.size >= target) break;

      const currentSeen = seen.size;
      const sigNow = signatureForTweets();
      const progressed = (currentSeen > lastSeenCount) || (sigNow && sigNow !== lastSig);
      if (!progressed) noProgress++;
      else noProgress = 0;

      if (progressed) lastProgressAt = Date.now();

      if (progressed) {
        dynamicDelayMs = Math.max(350, Math.floor(dynamicDelayMs * 0.72));
      } else {
        dynamicDelayMs = Math.min(2000, Math.floor(dynamicDelayMs * 1.18) + 70);
      }
      lastSeenCount = currentSeen;
      lastSig = sigNow;

      const didScroll = await scrollByLastTweet();
      if (!didScroll) {
        scrollToBottom(container);
      } else if (i % 10 === 9) {
        scrollToBottom(container);
      }

      await wait(dynamicDelayMs);
      clickLoadMoreButtons();
      await wait(160);
    }

    const finalBatch = collectQuotes({ parentTweetUrl });
    for (const item of finalBatch) {
      if (!item?.tweetUrl) continue;
      if (!seen.has(item.tweetUrl)) seen.set(item.tweetUrl, item);
    }

    return {
      ok: true,
      meta: {
        maxScrolls,
        settleLoops,
        stallTimeoutMs,
        delayMs: dynamicDelayMs,
        seen: seen.size,
        targetCount: target || null,
        durationMs: Date.now() - start,
      },
      data: Array.from(seen.values()),
    };
  }

  function collectQuotes({ parentTweetUrl }) {
    const parentStatusId = getStatusIdFromPath(new URL(parentTweetUrl).pathname);

    const quoteItems = [];
    const root = getPrimaryRoot();
    const tweets = Array.from(root.querySelectorAll('article[data-testid="tweet"]'));

    for (let index = 0; index < tweets.length; index++) {
      const tweet = tweets[index];

      // Avoid picking up tweets from suggestion modules if any render in the column.
      if (isWhoToFollowContext(tweet)) continue;

      const link = tweet.querySelector('a[href*="/status/"]');
      const tweetUrl = link?.href ? normalizeUrl(link.href) : null;

      // Skip the parent tweet if it appears on the quotes page.
      if (tweetUrl && parentStatusId && tweetUrl.includes(`/status/${parentStatusId}`)) {
        continue;
      }

      const { timestamp, timestampText } = extractTimeFromTweet(tweet);
      const { displayName, username, profileUrl } = extractUserFromTweet(tweet);
      const tweetText = extractTextFromTweet(tweet);

      if (!tweetUrl || (!displayName && !username)) continue;

      quoteItems.push({
        kind: 'QUOTE',
        index: quoteItems.length,
        parentTweetUrl,
        tweetUrl,
        timestamp,
        timestampText,
        displayName,
        username,
        profileUrl,
        tweetText,
        replyCount: extractCountFromButton(tweet, 'reply'),
        repostCount: extractCountFromButton(tweet, 'retweet'),
        likeCount: extractCountFromButton(tweet, 'like'),
        viewCount: extractViewsFromTweet(tweet),
      });
    }

    return quoteItems;
  }

  function collectRetweeters({ parentTweetUrl }) {
    const items = [];
    const primary = getPrimaryRoot();
    const root = primary.querySelector('[data-testid="UserCell"]') ? primary : document;
    const cells = Array.from(root.querySelectorAll('[data-testid="UserCell"]'));

    const extractHandleFromUrl = (href) => {
      if (!href) return null;
      try {
        const u = new URL(href, location.href);
        if (!/^(x\.com|twitter\.com)$/.test(u.hostname) && !u.hostname.endsWith('.x.com') && !u.hostname.endsWith('.twitter.com')) return null;
        const p = (u.pathname || '').split('/').filter(Boolean);
        const h = p[0];
        if (!h) return null;
        // Exclude non-handle routes.
        if (/^(i|home|explore|notifications|messages|settings|search|compose|intent)$/.test(h)) return null;
        if (h === 'status' || h === 'hashtag') return null;
        if (!/^[A-Za-z0-9_]{1,30}$/.test(h)) return null;
        return '@' + h;
      } catch {
        return null;
      }
    };

    for (let index = 0; index < cells.length; index++) {
      const cell = cells[index];

      // Exclude the "Who to follow" suggestions module.
      if (isWhoToFollowContext(cell)) continue;

      const avatar = cell.querySelector('[data-testid^="UserAvatar-Container-"]');
      let username = null;
      let profileUrl = null;

      const testId = avatar?.getAttribute('data-testid') || '';
      const match = testId.match(/UserAvatar-Container-(.+)/);
      if (match) {
        username = '@' + match[1];
        profileUrl = `https://x.com/${match[1]}`;
      }

      // Fallback 1: find @handle text.
      if (!username) {
        const handleText = Array.from(cell.querySelectorAll('span'))
          .map((s) => (s.textContent || '').trim())
          .find((t) => t && t.startsWith('@') && t.length > 1 && t.length < 40);
        if (handleText) username = handleText;
      }

      // Fallback 2: infer from profile link.
      if (!username || !profileUrl) {
        const a = cell.querySelector('a[href^="/"], a[href^="https://x.com/"], a[href^="https://twitter.com/"]');
        const inferred = extractHandleFromUrl(a?.href);
        if (inferred && !username) username = inferred;
        if (inferred && !profileUrl) profileUrl = `https://x.com/${inferred.replace(/^@/, '')}`;
      }

      let displayName = null;
      const spans = cell.querySelectorAll('span');
      for (const span of spans) {
        const t = (span.textContent || '').trim();
        if (!t || t.startsWith('@')) continue;
        if (t.length > 0 && t.length < 100) {
          displayName = t;
          break;
        }
      }

      if (!username) continue;

      items.push({
        kind: 'REPOST',
        index: items.length,
        parentTweetUrl,
        timestamp: null,
        timestampText: null,
        note: 'Repost timestamps are not present in the X/Twitter retweeters list DOM.',
        username,
        displayName,
        profileUrl,
      });
    }

    return items;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      try {
        if (!message || !message.type) {
          sendResponse({ ok: false, error: 'Invalid message' });
          return;
        }

        if (message.type === 'x_ping') {
          sendResponse({ ok: true, url: window.location.href });
          return;
        }

        if (message.type === 'x_extract_main') {
          const data = extractMainTweetData();
          sendResponse({ ok: true, data });
          return;
        }

        if (message.type === 'x_get_engagement_counts') {
          const data = extractEngagementCountsFromTabs();
          sendResponse({ ok: true, data });
          return;
        }

        if (message.type === 'x_scroll') {
          await autoScrollToBottom(message.options || {});
          sendResponse({ ok: true });
          return;
        }

        if (message.type === 'x_wait_for') {
          const selector = message.selector;
          const minCount = Number.isFinite(message.minCount) ? message.minCount : 1;
          const timeoutMs = Number.isFinite(message.timeoutMs) ? message.timeoutMs : 30000;
          const pollMs = Number.isFinite(message.pollMs) ? message.pollMs : 500;
          if (!selector) throw new Error('selector missing');
          const res = await waitForSelectorCount(selector, minCount, timeoutMs, pollMs);
          sendResponse(res);
          return;
        }

        if (message.type === 'x_diagnose') {
          const root = getPrimaryRoot();
          const text = (root?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
          const lowered = text.toLowerCase();

          const hasTweets = root.querySelectorAll('article[data-testid="tweet"]').length;
          const hasUsers = root.querySelectorAll('[data-testid="UserCell"]').length;

          const flags = {
            loginWall: /log in|sign in|create account/i.test(text),
            somethingWrong: /something went wrong/i.test(text),
            tryReloading: /try reloading|retry/i.test(text),
            unavailable: /post is unavailable|tweet is unavailable|this post is unavailable|this tweet is unavailable/i.test(text),
            noQuotes: /no one has quoted|no quotes yet|be the first to quote/i.test(text),
            noReposts: /no one has reposted|no reposts yet|no one has retweeted|no retweets yet/i.test(text),
          };

          sendResponse({
            ok: true,
            url: window.location.href,
            tweetCount: hasTweets,
            userCellCount: hasUsers,
            flags,
            snippet: lowered.slice(0, 800),
          });
          return;
        }

        if (message.type === 'x_collect_quotes') {
          const parentTweetUrl = message.parentTweetUrl;
          if (!parentTweetUrl) throw new Error('parentTweetUrl missing');
          const data = collectQuotes({ parentTweetUrl });
          sendResponse({ ok: true, data });
          return;
        }

        if (message.type === 'x_scroll_collect_quotes') {
          const parentTweetUrl = message.parentTweetUrl;
          if (!parentTweetUrl) throw new Error('parentTweetUrl missing');
          const opts = message.options || {};
          const res = await scrollAndCollectQuotes({ parentTweetUrl, ...opts });
          sendResponse(res);
          return;
        }

        if (message.type === 'x_collect_retweeters') {
          const parentTweetUrl = message.parentTweetUrl;
          if (!parentTweetUrl) throw new Error('parentTweetUrl missing');
          const data = collectRetweeters({ parentTweetUrl });
          sendResponse({ ok: true, data });
          return;
        }

        if (message.type === 'x_scroll_collect_retweeters') {
          const parentTweetUrl = message.parentTweetUrl;
          if (!parentTweetUrl) throw new Error('parentTweetUrl missing');
          const opts = message.options || {};
          const res = await scrollAndCollectRetweeters({ parentTweetUrl, ...opts });
          sendResponse(res);
          return;
        }

        sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();

    // Required to keep sendResponse alive for async.
    return true;
  });

  // Let background know we're alive.
  try {
    chrome.runtime.sendMessage({ type: 'x_ready', url: window.location.href });
  } catch {
    // ignore
  }

  log('content script loaded');
})();
