// background.js

const STATE_BY_TAB = new Map();
const RUNNING_WORKFLOWS = new Map();

const STORAGE_KEY_EXTRACTED = 'sse_extractedData';
const STORAGE_KEY_SAVED_AT = 'sse_savedAt';
const STORAGE_KEY_JOB = 'sse_job';

function storageGet(keys) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(keys, (res) => resolve(res || {}));
    } catch {
      resolve({});
    }
  });
}

function storageSet(obj) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set(obj, () => resolve());
    } catch {
      resolve();
    }
  });
}

function storageRemove(keys) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.remove(keys, () => resolve());
    } catch {
      resolve();
    }
  });
}

function nowIso() {
  return new Date().toISOString();
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseHumanCountToNumber(s) {
  const text = String(s || '').trim();
  if (!text) return null;
  // Examples: "1,234" "1.2K" "12K" "3M"
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

async function waitForTabComplete(tabId, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return;
    await sleep(200);
  }
}

async function sendToTab(tabId, message) {
  // Ensure the content script is ready.
  for (let i = 0; i < 25; i++) {
    try {
      const ping = await chrome.tabs.sendMessage(tabId, { type: 'x_ping' });
      if (ping?.ok) break;
    } catch {
      // Content script might not be injected yet.
      await sleep(450);
    }
  }
  return chrome.tabs.sendMessage(tabId, message);
}

function stateFor(tabId) {
  if (!STATE_BY_TAB.has(tabId)) {
    STATE_BY_TAB.set(tabId, {
      startedAt: nowIso(),
      status: 'idle',
      log: [],
      cancelRequested: false,
      data: {
        main: null,
        quotes: [],
        quoteDetails: [],
        reposts: [],
      },
    });
  }
  return STATE_BY_TAB.get(tabId);
}

const PERSIST_TIMER_BY_TAB = new Map();
function schedulePersistState(tabId) {
  if (PERSIST_TIMER_BY_TAB.has(tabId)) return;
  const t = setTimeout(async () => {
    PERSIST_TIMER_BY_TAB.delete(tabId);
    try {
      const st = stateFor(tabId);
      await storageSet({ [`sse_state_${tabId}`]: st });
    } catch {
      // ignore
    }
  }, 600);
  PERSIST_TIMER_BY_TAB.set(tabId, t);
}

function pushLog(tabId, message) {
  const st = stateFor(tabId);
  st.log.push({ at: nowIso(), message });
  // Keep log bounded.
  if (st.log.length > 500) st.log.splice(0, st.log.length - 500);
  schedulePersistState(tabId);
}

function assertNotCancelled(tabId) {
  const st = stateFor(tabId);
  if (st.cancelRequested) {
    const err = new Error('Cancelled');
    err.code = 'CANCELLED';
    throw err;
  }
}

function dedupeByKey(items, getKey) {
  const out = [];
  const seen = new Set();
  for (const item of items || []) {
    const key = getKey(item);
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function mergeByKey(existing, incoming, getKey) {
  const map = new Map();
  for (const item of existing || []) {
    const key = getKey(item);
    if (!key) continue;
    if (!map.has(key)) map.set(key, item);
  }
  for (const item of incoming || []) {
    const key = getKey(item);
    if (!key) continue;
    if (!map.has(key)) map.set(key, item);
  }
  return Array.from(map.values());
}

function makeQuotesUrl(tweetUrl) {
  const u = new URL(normalizeUrl(tweetUrl));
  u.pathname = u.pathname.replace(/\/?$/, '') + '/quotes';
  return u.toString();
}

function makeRetweetsUrl(tweetUrl) {
  const u = new URL(normalizeUrl(tweetUrl));
  u.pathname = u.pathname.replace(/\/?$/, '') + '/retweets';
  return u.toString();
}

async function openBackgroundTab(url, openerTabId) {
  const tab = await chrome.tabs.create({ url, active: false, openerTabId });
  await waitForTabComplete(tab.id, 45000);
  // Give the page a moment to hydrate/react-render before we start scrolling/collecting.
  await sleep(2200);
  return tab.id;
}

async function activateTab(tabId) {
  try {
    await chrome.tabs.update(tabId, { active: true });
  } catch {
    // ignore
  }
  // Allow the tab to become foreground and resume timers/network.
  await sleep(450);
}

async function runWithTabActive(tabId, fallbackReturnTabId, fn) {
  let prevActiveId = null;
  try {
    const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    prevActiveId = activeTabs?.[0]?.id ?? null;
  } catch {
    prevActiveId = null;
  }

  await activateTab(tabId);
  try {
    return await fn();
  } finally {
    // Best effort: return focus to whichever tab was active before.
    const returnTo = prevActiveId || fallbackReturnTabId;
    if (returnTo && returnTo !== tabId) {
      try {
        await chrome.tabs.update(returnTo, { active: true });
      } catch {
        // ignore
      }
    }
  }
}

async function reloadTab(tabId) {
  try {
    await chrome.tabs.reload(tabId);
  } catch {
    // ignore
  }
  await waitForTabComplete(tabId, 45000);
  await sleep(2000);
}

async function diagnoseTab(tabId) {
  try {
    const res = await sendToTab(tabId, { type: 'x_diagnose' });
    return res?.ok ? res : { ok: false, error: res?.error || 'diagnose failed' };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

async function waitForContent(tabId, selector, { timeoutMs = 45000, minCount = 1 } = {}) {
  try {
    const res = await sendToTab(tabId, {
      type: 'x_wait_for',
      selector,
      minCount,
      timeoutMs,
      pollMs: 600,
    });
    return res;
  } catch (e) {
    return { ok: false, error: e?.message || String(e), count: 0 };
  }
}

async function withRetries(fn, { attempts = 3, baseDelayMs = 1500, tabId, label } = {}) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn(i);
    } catch (e) {
      lastErr = e;
      if (tabId && label) pushLog(tabId, `${label} failed (attempt ${i + 1}/${attempts}): ${e?.message || String(e)}`);
      await sleep(baseDelayMs * (i + 1));
    }
  }
  throw lastErr || new Error('Failed after retries');
}

async function closeTab(tabId) {
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    // ignore
  }
}

async function runXWorkflow(tabId, tweetUrl, options) {
  const st = stateFor(tabId);
  st.status = 'running';
  st.cancelRequested = false;
  st.data = { main: null, quotes: [], quoteDetails: [], reposts: [] };
  st.options = options;

  async function persistAndFinish({ status = 'done' } = {}) {
    st.status = status;
    schedulePersistState(tabId);

    // Persist results for the popup to restore even if it was closed.
    const existing = await storageGet([STORAGE_KEY_EXTRACTED]);
    const prev = existing?.[STORAGE_KEY_EXTRACTED] || {};
    const next = {
      facebook: Array.isArray(prev.facebook) ? prev.facebook : [],
      x: Array.isArray(prev.x) ? prev.x : [],
    };
    // Store raw workflow data; popup flattens/normalizes.
    next.x = [{ __workflow: 'x', data: st.data, savedAt: nowIso() }];

    await storageSet({
      [STORAGE_KEY_EXTRACTED]: next,
      [STORAGE_KEY_SAVED_AT]: nowIso(),
      [STORAGE_KEY_JOB]: {
        platform: 'x',
        tabId,
        tweetUrl,
        status,
        startedAt: st.startedAt,
        updatedAt: nowIso(),
      }
    });

    return st.data;
  }

  await storageSet({
    [STORAGE_KEY_JOB]: {
      platform: 'x',
      tabId,
      tweetUrl,
      status: 'running',
      startedAt: st.startedAt,
      updatedAt: nowIso(),
    }
  });
  schedulePersistState(tabId);

  pushLog(tabId, `Starting X workflow for: ${tweetUrl}`);
  assertNotCancelled(tabId);

  // 1) Extract main tweet data from current tab.
  pushLog(tabId, 'Extracting main post...');
  assertNotCancelled(tabId);
  // Wait for at least one tweet to render.
  const mainWait = await waitForContent(tabId, 'article[data-testid="tweet"] time', { timeoutMs: 45000, minCount: 1 });
  if (!mainWait?.ok) pushLog(tabId, `Main tweet wait warning: ${mainWait?.error || 'timeout'}`);

  const mainResp = await withRetries(
    () => sendToTab(tabId, { type: 'x_extract_main' }),
    { attempts: 3, baseDelayMs: 1200, tabId, label: 'Main extract' }
  );
  if (!mainResp?.ok) throw new Error(mainResp?.error || 'Failed to extract main post');
  st.data.main = mainResp.data;
  if (!st.data.main) throw new Error('Main post not found (not loaded or blocked by login)');
  const combinedUpper = Number.isFinite(st.data.main?.combinedRepostsAndQuotesCount)
    ? st.data.main.combinedRepostsAndQuotesCount
    : parseHumanCountToNumber(st.data.main?.repostCount);
  const separatedRepostsUpper = Number.isFinite(st.data.main?.repostsCount) ? st.data.main.repostsCount : null;
  const separatedQuotesUpper = Number.isFinite(st.data.main?.quotesCount) ? st.data.main.quotesCount : null;

  if (combinedUpper != null) pushLog(tabId, `Main combined (reposts+quotes) upper-bound: ~${combinedUpper}`);
  if (separatedRepostsUpper != null) pushLog(tabId, `Main reposts upper-bound: ~${separatedRepostsUpper}`);
  if (separatedQuotesUpper != null) pushLog(tabId, `Main quotes upper-bound: ~${separatedQuotesUpper}`);
  pushLog(tabId, 'Main post extracted');

  // Fast path: if X UI shows 0 quotes and 0 reposts, skip heavy steps.
  // (Never skip quotes just because reposts are 0.)
  const fastSkipEnabled = options?.fastSkipEngagementIfNoReposts !== false;
  const shouldSkipEngagement =
    fastSkipEnabled &&
    ((combinedUpper === 0) || (separatedRepostsUpper === 0 && separatedQuotesUpper === 0));
  if (shouldSkipEngagement) {
    pushLog(tabId, 'Fast-skip engagement: quotes=0 and reposts=0; skipping quotes/retweets.');
    pushLog(tabId, 'Workflow complete');
    return await persistAndFinish({ status: 'done' });
  }

  const scrollOptions = {
    // Keep defaults fast; content script has adaptive delays and will slow down only when stalled.
    maxScrolls: 120,
    settleLoops: 6,
    delayMs: 950,
    ...(options?.scroll || {}),
  };

  // Use a single adaptive pass by default; content script stops when progress stalls.
  const collectPasses = Number.isFinite(options?.collectPasses) ? options.collectPasses : 1;
  const perPassScroll = {
    ...scrollOptions,
    maxScrolls: Math.max(10, Math.floor((Number(scrollOptions.maxScrolls) || 0) / collectPasses)),
  };

  // 2) Collect quotes list from /quotes (background tab).
  // Skip entirely if the UI says there are 0 quotes.
  assertNotCancelled(tabId);
  if (separatedQuotesUpper === 0) {
    pushLog(tabId, 'Quotes: UI count is 0; skipping quotes step.');
    st.data.quotes = [];
  } else {
    const quotesUrl = makeQuotesUrl(tweetUrl);
    pushLog(tabId, `Opening quotes: ${quotesUrl}`);
    const quotesTabId = await openBackgroundTab(quotesUrl, tabId);

    // Quick early-exit: if the quotes page explicitly says there are no quotes, do not reload/retry.
    const diagPre = await diagnoseTab(quotesTabId);
    if (diagPre?.ok && diagPre.flags?.noQuotes) {
      pushLog(tabId, 'Quotes: X indicates there are no quotes; skipping quotes step.');
      st.data.quotes = [];
      await closeTab(quotesTabId);
    } else {

      // Quotes can be flaky on X; prefer short waits + retries over one long wait.
      const smallEngagement = Number.isFinite(combinedUpper) && combinedUpper > 0 && combinedUpper <= 20;
      let quotesWait = await waitForContent(
        quotesTabId,
        'article[data-testid="tweet"]',
        { timeoutMs: smallEngagement ? 8000 : 18000, minCount: 1 }
      );

      if (!quotesWait?.ok) {
        const diag1 = await diagnoseTab(quotesTabId);
        pushLog(tabId, `Quotes not ready: ${quotesWait?.error || 'timeout'} (count=${quotesWait?.count || 0})`);
        if (diag1?.ok) pushLog(tabId, `Quotes diagnose: tweets=${diag1.tweetCount} flags=${JSON.stringify(diag1.flags || {})}`);

        // If X explicitly indicates there are no quotes, stop immediately.
        if (diag1?.ok && diag1.flags?.noQuotes) {
          pushLog(tabId, 'Quotes: X indicates there are no quotes; proceeding without quotes.');
        } else {
          // Retry only when it looks like a transient render issue.
          // For small engagement counts, do not spend time reloading multiple times.
          const maxAttempts = smallEngagement ? 0 : 2;
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            pushLog(tabId, `Reloading quotes tab (attempt ${attempt}/${maxAttempts})...`);
            await reloadTab(quotesTabId);
            quotesWait = await waitForContent(quotesTabId, 'article[data-testid="tweet"]', { timeoutMs: 20000, minCount: 1 });
            if (quotesWait?.ok) break;
            const di = await diagnoseTab(quotesTabId);
            if (di?.ok) pushLog(tabId, `Quotes diagnose(after reload): tweets=${di.tweetCount} flags=${JSON.stringify(di.flags || {})}`);
            if (di?.ok && (di.flags?.loginWall || di.flags?.unavailable || di.flags?.noQuotes)) break;
          }
        }
      }

      if (!quotesWait?.ok) {
        const diagFinal = await diagnoseTab(quotesTabId);
        pushLog(tabId, `Quotes still unavailable; proceeding without quotes.`);
        if (diagFinal?.ok) pushLog(tabId, `Quotes final diagnose: tweets=${diagFinal.tweetCount} flags=${JSON.stringify(diagFinal.flags || {})}`);
      }

      st.data.quotes = [];
      pushLog(tabId, 'Quotes: activating tab + scrolling+collecting (avoids background throttling)...');

    const smallQuotes =
      (Number.isFinite(separatedQuotesUpper) && separatedQuotesUpper > 0 && separatedQuotesUpper <= 20) ||
      (Number.isFinite(combinedUpper) && combinedUpper > 0 && combinedUpper <= 20);
    const quotesSettings = {
      // Keep it fast; stop when no new quotes arrive for a short window.
      // When a small target is known, stop as soon as we hit it.
      // If we have a separated quotes upper-bound, stop exactly at it.
      targetCount: Number.isFinite(separatedQuotesUpper) && separatedQuotesUpper > 0 ? separatedQuotesUpper : null,
      maxScrolls: smallQuotes ? 140 : Math.max(2000, Number(scrollOptions.maxScrolls) || 0),
      settleLoops: smallQuotes ? 14 : Math.max(70, Number(scrollOptions.settleLoops) || 0),
      delayMs: smallQuotes ? 420 : Math.max(420, Math.min(900, Number(scrollOptions.delayMs) || 0)),
      stallTimeoutMs: smallQuotes ? 4500 : 12000,
      // Safety only; stallTimeoutMs should end earlier when fully loaded.
      maxDurationMs: Number.isFinite(options?.maxQuotesDurationMs) ? options.maxQuotesDurationMs : (4 * 60 * 1000),
    };

    const quotesResp = await runWithTabActive(quotesTabId, tabId, async () =>
    withRetries(
      () => sendToTab(quotesTabId, {
        type: 'x_scroll_collect_quotes',
        parentTweetUrl: tweetUrl,
        options: quotesSettings,
      }),
      { attempts: 3, baseDelayMs: 1500, tabId, label: 'Quotes scroll+collect' }
    )
  );

    if (!quotesResp?.ok) {
      pushLog(tabId, `Quotes scroll+collect warning: ${quotesResp?.error || 'unknown'}; falling back to single collect.`);
      const fallback = await sendToTab(quotesTabId, { type: 'x_collect_quotes', parentTweetUrl: tweetUrl });
      if (fallback?.ok) {
        st.data.quotes = dedupeByKey(fallback.data || [], (q) => q.tweetUrl);
      }
    } else {
      if (quotesResp?.meta?.seen != null) {
        pushLog(
          tabId,
          `Quotes meta: seen=${quotesResp.meta.seen}` +
            (quotesResp.meta.targetCount ? ` target=${quotesResp.meta.targetCount}` : '') +
            (quotesResp.meta.durationMs ? ` durationMs=${quotesResp.meta.durationMs}` : '')
        );
      }
      st.data.quotes = dedupeByKey(quotesResp.data || [], (q) => q.tweetUrl);
    }

      // If quotes tab never loaded tweets, don't pretend we "collected".
      if (st.data.quotes.length === 0 && !quotesWait?.ok) {
      pushLog(tabId, `Collected 0 quotes (quotes page did not render tweets)`);
      } else {
      pushLog(tabId, `Collected ${st.data.quotes.length} quotes (deduped)`);
      }
      await closeTab(quotesTabId);
    }
  }

  // 3) Drill into each quote tweet in its own background tab.
  assertNotCancelled(tabId);
  // Quote-detail tabs are optional enrichment and can add a lot of time.
  // Default: metadata-only (0). User can override via options.maxQuoteDetails.
  const defaultMaxQuoteDetails = 0;
  const maxQuoteDetails = Number.isFinite(options?.maxQuoteDetails)
    ? Math.max(0, options.maxQuoteDetails)
    : defaultMaxQuoteDetails;
  const quoteUrls = st.data.quotes.map(q => q.tweetUrl).filter(Boolean);
  const uniqueQuoteUrls = Array.from(new Set(quoteUrls)).slice(0, maxQuoteDetails);
  if (uniqueQuoteUrls.length === 0) {
    pushLog(tabId, 'Skipping quote-detail tabs (maxQuoteDetails=0)');
  } else {
    pushLog(tabId, `Opening ${uniqueQuoteUrls.length} quote tweet tabs for details...`);
  }

  for (let i = 0; i < uniqueQuoteUrls.length; i++) {
    assertNotCancelled(tabId);
    const qUrl = uniqueQuoteUrls[i];
    pushLog(tabId, `Quote detail ${i + 1}/${uniqueQuoteUrls.length}: ${qUrl}`);
    const qTabId = await openBackgroundTab(qUrl, tabId);
    // Quote detail pages can be slow/flaky; keep it snappy.
    let qWait = await waitForContent(qTabId, 'article[data-testid="tweet"] time', { timeoutMs: 15000, minCount: 1 });
    if (!qWait?.ok) {
      pushLog(tabId, `Quote detail not ready: ${qWait?.error || 'timeout'}; reloading once...`);
      await reloadTab(qTabId);
      qWait = await waitForContent(qTabId, 'article[data-testid="tweet"] time', { timeoutMs: 15000, minCount: 1 });
    }
    if (!qWait?.ok) pushLog(tabId, `Quote detail wait warning: ${qWait?.error || 'timeout'} (skipping details)`);

    if (qWait?.ok) {
      const qMain = await withRetries(
        () => sendToTab(qTabId, { type: 'x_extract_main' }),
        { attempts: 2, baseDelayMs: 900, tabId, label: 'Quote detail extract' }
      );
      if (qMain?.ok && qMain.data) {
        st.data.quoteDetails.push({ ...qMain.data, kind: 'QUOTE_DETAIL', parentTweetUrl: tweetUrl });
      } else {
        pushLog(tabId, `Quote detail warning: ${qMain?.error || 'no data'}`);
      }
    }
    await closeTab(qTabId);
    // Gentle pacing
    await sleep(180);
  }

  // 4) Collect retweeters list from /retweets.
  assertNotCancelled(tabId);
  const retweetsUrl = makeRetweetsUrl(tweetUrl);
  pushLog(tabId, `Opening retweets: ${retweetsUrl}`);
  const repostsTabId = await openBackgroundTab(retweetsUrl, tabId);

  // Derive retweets target:
  // - If X exposes separate reposts count, use it.
  // - Else, if we have combined count, subtract quotes (prefer separated quotes, else collected quotes length).
  const quotesForDerivation = Number.isFinite(separatedQuotesUpper) ? separatedQuotesUpper : (st.data.quotes?.length || 0);
  const derivedRepostsUpper = Number.isFinite(combinedUpper) ? Math.max(0, combinedUpper - quotesForDerivation) : null;
  const retweetsUpper = Number.isFinite(separatedRepostsUpper) ? separatedRepostsUpper : derivedRepostsUpper;

  if (retweetsUpper === 0) {
    pushLog(tabId, 'Retweets: UI count is 0; skipping retweeters step.');
    st.data.reposts = [];
    await closeTab(repostsTabId);
  } else {

  const smallEngagement = Number.isFinite(combinedUpper) && combinedUpper > 0 && combinedUpper <= 20;
  let retWait = await waitForContent(repostsTabId, '[data-testid="UserCell"]', { timeoutMs: smallEngagement ? 8000 : 18000, minCount: 1 });
  if (!retWait?.ok) {
    const diag = await diagnoseTab(repostsTabId);
    pushLog(tabId, `Retweets not ready: ${retWait?.error || 'timeout'} (count=${retWait?.count || 0})`);
    if (diag?.ok) pushLog(tabId, `Retweets diagnose: users=${diag.userCellCount} flags=${JSON.stringify(diag.flags || {})}`);

    if (diag?.ok && diag.flags?.noReposts) {
      pushLog(tabId, 'Retweets: X indicates there are no reposts; skipping retweeters step.');
      st.data.reposts = [];
      await closeTab(repostsTabId);
    } else {
      pushLog(tabId, 'Reloading retweets tab (attempt 1/1)...');
      await reloadTab(repostsTabId);
      retWait = await waitForContent(repostsTabId, '[data-testid="UserCell"]', { timeoutMs: 20000, minCount: 1 });
    }
  }

  if (!retWait?.ok) {
    // If we already closed the tab due to noReposts, stop here.
    if (st.data.reposts.length === 0) {
      // continue
    }
  }

  if (!retWait?.ok) {
    const diagFinal = await diagnoseTab(repostsTabId);
    pushLog(tabId, 'Retweets still unavailable; proceeding with whatever loads.');
    if (diagFinal?.ok) pushLog(tabId, `Retweets final diagnose: users=${diagFinal.userCellCount} flags=${JSON.stringify(diagFinal.flags || {})}`);
  }

  st.data.reposts = [];
  pushLog(tabId, 'Retweets: activating tab + scrolling+collecting (avoids background throttling)...');
  for (let pass = 0; pass < collectPasses; pass++) {
    assertNotCancelled(tabId);
    pushLog(tabId, `Retweets pass ${pass + 1}/${collectPasses}: scrolling+collecting...`);
    const smallReposts =
      (Number.isFinite(retweetsUpper) && retweetsUpper > 0 && retweetsUpper <= 20) ||
      (Number.isFinite(combinedUpper) && combinedUpper > 0 && combinedUpper <= 20);
    const repostTarget = Number.isFinite(retweetsUpper) && retweetsUpper > 0
      ? (retweetsUpper <= 100 ? retweetsUpper : Math.floor(retweetsUpper * 0.985))
      : null;

    const repostSettings = {
      // Retweeters list is virtualized; do not rely on DOM count.
      maxScrolls: smallReposts ? 140 : Math.max(2500, perPassScroll.maxScrolls * 10),
      // Be more tolerant of virtualization stalls; X often swaps the same ~40 DOM nodes.
      settleLoops: smallReposts ? 12 : Math.max(80, perPassScroll.settleLoops * 6),
      delayMs: smallReposts ? 520 : Math.max(520, Math.min(950, perPassScroll.delayMs)),
      // Upper bound: if we ever reach it, we can stop immediately.
      targetCount: repostTarget,
      stallTimeoutMs: smallReposts ? 4500 : 15000,
      // Safety only; stallTimeoutMs should end earlier when fully loaded.
      maxDurationMs: Number.isFinite(options?.maxRetweetsDurationMs) ? options.maxRetweetsDurationMs : (5 * 60 * 1000),
    };

    const repostsResp = await runWithTabActive(repostsTabId, tabId, async () =>
      withRetries(
        () => sendToTab(repostsTabId, {
          type: 'x_scroll_collect_retweeters',
          parentTweetUrl: tweetUrl,
          options: repostSettings,
        }),
        { attempts: 3, baseDelayMs: 1500, tabId, label: 'Retweets scroll+collect' }
      )
    );
    if (!repostsResp?.ok) throw new Error(repostsResp?.error || 'Failed to collect retweeters');

    if (repostsResp?.meta?.seen != null) {
      pushLog(
        tabId,
        `Retweets meta: seen=${repostsResp.meta.seen}` +
          (repostsResp.meta.targetCount ? ` target=${repostsResp.meta.targetCount}` : '') +
          (repostsResp.meta.durationMs ? ` durationMs=${repostsResp.meta.durationMs}` : '')
      );
    }

    if ((repostsResp.data || []).length === 0) {
      pushLog(tabId, 'Retweets collect returned 0; waiting a bit and retrying...');
      await sleep(2500);
      const retry = await sendToTab(repostsTabId, { type: 'x_collect_retweeters', parentTweetUrl: tweetUrl });
      if (retry?.ok && Array.isArray(retry.data) && retry.data.length > 0) {
        repostsResp.data = retry.data;
      }
    }

    const before = st.data.reposts.length;
    st.data.reposts = mergeByKey(st.data.reposts, repostsResp.data || [], (r) => r.username);
    st.data.reposts = dedupeByKey(st.data.reposts, (r) => r.username);
    const after = st.data.reposts.length;
    pushLog(tabId, `Retweets pass ${pass + 1}: ${before} -> ${after}`);
    if (after === before) {
      // For big repost lists, a single stall can be transient; give it one more pass.
      const bigHint = Number.isFinite(retweetsUpper)
        ? retweetsUpper
        : (Number.isFinite(combinedUpper) ? combinedUpper : null);
      if (!(bigHint && bigHint >= 200) || pass >= 1) break;
    }
  }
  pushLog(tabId, `Collected ${st.data.reposts.length} retweeters (deduped)`);
  await closeTab(repostsTabId);
  }

  // Final: dedupe quoteDetails by tweetUrl for stability.
  st.data.quoteDetails = dedupeByKey(st.data.quoteDetails || [], (q) => q.tweetUrl);

  pushLog(tabId, 'Workflow complete');
  return await persistAndFinish({ status: 'done' });
}

async function startXWorkflow(tabId, tweetUrl, options) {
  const st = stateFor(tabId);
  if (RUNNING_WORKFLOWS.has(tabId)) {
    return { ok: true, status: st.status || 'running' };
  }

  st.startedAt = nowIso();
  st.status = 'running';
  st.cancelRequested = false;
  st.log = [];
  st.data = { main: null, quotes: [], quoteDetails: [], reposts: [] };
  schedulePersistState(tabId);

  const p = (async () => {
    try {
      await runXWorkflow(tabId, tweetUrl, options);
    } catch (e) {
      const st2 = stateFor(tabId);
      if (e?.code === 'CANCELLED') {
        st2.status = 'cancelled';
        pushLog(tabId, 'Workflow cancelled');
      } else {
        st2.status = 'error';
        pushLog(tabId, `Workflow error: ${e?.message || String(e)}`);
      }
      await storageSet({
        [STORAGE_KEY_JOB]: {
          platform: 'x',
          tabId,
          tweetUrl,
          status: st2.status,
          startedAt: st2.startedAt,
          updatedAt: nowIso(),
          error: e?.message || String(e),
        }
      });
      schedulePersistState(tabId);
    } finally {
      RUNNING_WORKFLOWS.delete(tabId);
    }
  })();

  RUNNING_WORKFLOWS.set(tabId, p);
  return { ok: true, status: 'started' };
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('Social Share Extractor Installed');
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (!message || !message.type) {
        sendResponse({ ok: false, error: 'Invalid message' });
        return;
      }

      if (message.type === 'x_ready') {
        // content script loaded
        const tabId = sender?.tab?.id;
        if (tabId) pushLog(tabId, `Content script ready: ${message.url || ''}`);
        sendResponse({ ok: true });
        return;
      }

      if (message.type === 'x_start_workflow') {
        const tabId = message.tabId || sender?.tab?.id;
        if (!tabId) throw new Error('No tabId provided');
        const tweetUrl = message.tweetUrl;
        if (!tweetUrl) throw new Error('tweetUrl missing');
        const res = await startXWorkflow(tabId, tweetUrl, message.options || {});
        sendResponse(res);
        return;
      }

      // Back-compat: if old popup calls x_run_workflow, start async and return current state.
      if (message.type === 'x_run_workflow') {
        const tabId = message.tabId || sender?.tab?.id;
        if (!tabId) throw new Error('No tabId provided');
        const tweetUrl = message.tweetUrl;
        if (!tweetUrl) throw new Error('tweetUrl missing');
        await startXWorkflow(tabId, tweetUrl, message.options || {});
        const st = stateFor(tabId);
        sendResponse({ ok: true, state: st });
        return;
      }

      if (message.type === 'x_get_state') {
        const tabId = message.tabId || sender?.tab?.id;
        if (!tabId) throw new Error('No tabId provided');
        const st = stateFor(tabId);
        sendResponse({ ok: true, state: st });
        return;
      }

      if (message.type === 'sse_reset_all') {
        const tabId = message.tabId || sender?.tab?.id;
        if (tabId) {
          const st = stateFor(tabId);
          st.cancelRequested = true;
          schedulePersistState(tabId);
        }
        // Also clear persisted per-tab state/logs.
        try {
          const all = await new Promise((resolve) => {
            chrome.storage.local.get(null, (res) => resolve(res || {}));
          });
          const stateKeys = Object.keys(all).filter((k) => k.startsWith('sse_state_'));
          if (stateKeys.length > 0) await storageRemove(stateKeys);
        } catch {
          // ignore
        }

        await storageRemove([STORAGE_KEY_EXTRACTED, STORAGE_KEY_SAVED_AT, STORAGE_KEY_JOB]);
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();

  return true;
});
