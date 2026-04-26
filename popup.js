// popup.js

const POPUP_BUILD_ID = '2026-03-13-01';

const STORAGE_KEY_EXTRACTED = 'sse_extractedData';
const STORAGE_KEY_SAVED_AT = 'sse_savedAt';

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

let extractedData = {
  facebook: [],
  x: []
};

let livePollTimer = null;

function stopLivePolling() {
  if (livePollTimer) {
    clearInterval(livePollTimer);
    livePollTimer = null;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const uiLog = (message) => {
    try {
      const el = document.getElementById('debugLog');
      if (!el) return;
      const line = `[${new Date().toISOString()}] ${message}`;
      if (!el.textContent || el.textContent.trim() === '(no logs yet)') {
        el.textContent = line;
      } else {
        el.textContent += `\n${line}`;
      }
    } catch {
      // ignore
    }
  };

  try {
    const jsIndicator = document.getElementById('jsIndicator');
    if (jsIndicator) jsIndicator.textContent = `JS: loaded (${POPUP_BUILD_ID})`;
  } catch {
    // ignore
  }

  uiLog(`Popup loaded (build ${POPUP_BUILD_ID})`);

  // Surface popup errors inside the UI (otherwise it looks like "nothing happens").
  try {
    window.addEventListener('error', (e) => {
      const message = e?.message || 'Unknown error';
      uiLog(`window.error: ${message}`);
      showStatus(`Popup error: ${message}`, 'error');
    });
    window.addEventListener('unhandledrejection', (e) => {
      const reason = e?.reason;
      const message = (reason && (reason.message || String(reason))) || 'Unknown promise rejection';
      uiLog(`unhandledrejection: ${message}`);
      showStatus(`Popup error: ${message}`, 'error');
    });
  } catch {
    // ignore
  }

  const extractBtn = document.getElementById('extractBtn');
  const clearBtn = document.getElementById('clearBtn');
  const resetBtn = document.getElementById('resetBtn');
  const xMaxQuoteDetailsEl = document.getElementById('xMaxQuoteDetails');
  const xMaxQuotesMinutesEl = document.getElementById('xMaxQuotesMinutes');
  const xMaxRetweetsMinutesEl = document.getElementById('xMaxRetweetsMinutes');
  const statusEl = document.getElementById('status');
  const resultsEl = document.getElementById('results');
  const statsEl = document.getElementById('stats');
  const tabsEl = document.getElementById('tabs');
  const exportOptionsEl = document.getElementById('exportOptions');

  if (!extractBtn || !clearBtn || !resetBtn || !statusEl || !resultsEl) {
    uiLog('Popup wiring error: missing required DOM nodes');
    return;
  }

  const setDebugLogText = (text) => {
    try {
      const el = document.getElementById('debugLog');
      if (!el) return;
      el.textContent = text || '(no logs yet)';
    } catch {
      // ignore
    }
  };

  const renderLiveState = (job, state) => {
    if (!job) return;
    const status = job.status || state?.status || 'idle';

    const quotes = state?.data?.quotes?.length || 0;
    const quoteDetails = state?.data?.quoteDetails?.length || 0;
    const reposts = state?.data?.reposts?.length || 0;

    const lastLog = Array.isArray(state?.log) && state.log.length ? state.log[state.log.length - 1].message : '';
    if (status === 'running') {
      showStatus(`⏳ Running… quotes=${quotes}, quote-details=${quoteDetails}, retweeters=${reposts}${lastLog ? ` • ${lastLog}` : ''}`, 'info');
    } else if (status === 'done') {
      showStatus(`✅ Done. quotes=${quotes}, quote-details=${quoteDetails}, retweeters=${reposts}`, 'success');
    } else if (status === 'error') {
      showStatus(`Error: ${job.error || lastLog || 'Unknown error'}`, 'error');
    } else if (status === 'cancelled') {
      showStatus('Cancelled.', 'error');
    }

    if (Array.isArray(state?.log) && state.log.length) {
      const lines = state.log.slice(-250).map((l) => `[${l.at}] ${l.message}`).join('\n');
      setDebugLogText(lines);
    }
  };

  const refreshFromBackground = async () => {
    const jobRes = await storageGet(['sse_job']);
    const job = jobRes?.sse_job || null;
    if (!job?.tabId) return;

    // Show the latest persisted state immediately (works even if popup was closed).
    const persisted = await storageGet([`sse_state_${job.tabId}`]);
    const persistedState = persisted?.[`sse_state_${job.tabId}`];
    if (persistedState) renderLiveState(job, persistedState);

    // If job finished, load the persisted results.
    if (job.status === 'done') {
      const saved = await storageGet([STORAGE_KEY_EXTRACTED, STORAGE_KEY_SAVED_AT]);
      const restored = saved?.[STORAGE_KEY_EXTRACTED];
      if (restored && typeof restored === 'object') {
        const fb = Array.isArray(restored.facebook) ? restored.facebook : [];
        let xRows = Array.isArray(restored.x) ? restored.x : [];
        if (xRows.length === 1 && xRows[0]?.__workflow === 'x' && xRows[0]?.data) {
          xRows = flattenXWorkflowData(xRows[0].data);
        }
        extractedData = { facebook: fb, x: xRows };
        updateStats();
        renderResults('all');
        if (statsEl) statsEl.style.display = 'flex';
        if (tabsEl) tabsEl.style.display = 'flex';
        if (exportOptionsEl) exportOptionsEl.style.display = 'flex';
      }
    }

    stopLivePolling();
    if (job.status === 'running') {
      livePollTimer = setInterval(async () => {
        try {
          const st = await chrome.runtime.sendMessage({ type: 'x_get_state', tabId: job.tabId });
          if (st?.ok && st.state) {
            // Refresh job snapshot too (it contains status/error).
            const jobNow = (await storageGet(['sse_job']))?.sse_job || job;
            renderLiveState(jobNow, st.state);

            if (st.state.status === 'done' || st.state.status === 'error' || st.state.status === 'cancelled') {
              stopLivePolling();
              await refreshFromBackground();
            }
          }
        } catch (e) {
          uiLog(`Live poll error: ${e?.message || String(e)}`);
        }
      }, 1200);
    }
  };

  const clampInt = (v, { min = 0, max = 9999 } = {}) => {
    const n = Number.parseInt(String(v ?? '').trim(), 10);
    if (!Number.isFinite(n)) return min;
    return Math.max(min, Math.min(max, n));
  };

  const readXOptionsFromUi = () => {
    const maxQuoteDetails = clampInt(xMaxQuoteDetailsEl?.value, { min: 0, max: 5000 });
    const maxQuotesMinutes = clampInt(xMaxQuotesMinutesEl?.value, { min: 1, max: 20 });
    const maxRetweetsMinutes = clampInt(xMaxRetweetsMinutesEl?.value, { min: 1, max: 30 });
    return {
      maxQuoteDetails,
      maxQuotesDurationMs: maxQuotesMinutes * 60 * 1000,
      maxRetweetsDurationMs: maxRetweetsMinutes * 60 * 1000,
    };
  };

  const persistXOptions = async () => {
    try {
      await storageSet({ sse_x_options: readXOptionsFromUi() });
    } catch {
      // ignore
    }
  };

  const restoreXOptions = async () => {
    try {
      const saved = await storageGet(['sse_x_options']);
      const opts = saved?.sse_x_options;
      if (!opts) return;
      if (xMaxQuoteDetailsEl) xMaxQuoteDetailsEl.value = String(clampInt(opts.maxQuoteDetails, { min: 0, max: 5000 }));
      if (xMaxQuotesMinutesEl) xMaxQuotesMinutesEl.value = String(clampInt(Math.round((opts.maxQuotesDurationMs || 0) / 60000) || 1, { min: 1, max: 20 }));
      if (xMaxRetweetsMinutesEl) xMaxRetweetsMinutesEl.value = String(clampInt(Math.round((opts.maxRetweetsDurationMs || 0) / 60000) || 1, { min: 1, max: 30 }));
    } catch {
      // ignore
    }
  };

  if (xMaxQuoteDetailsEl) xMaxQuoteDetailsEl.addEventListener('change', persistXOptions);
  if (xMaxQuotesMinutesEl) xMaxQuotesMinutesEl.addEventListener('change', persistXOptions);
  if (xMaxRetweetsMinutesEl) xMaxRetweetsMinutesEl.addEventListener('change', persistXOptions);

  // Restore persisted results so popup is effectively stateful.
  (async () => {
    const saved = await storageGet([STORAGE_KEY_EXTRACTED, STORAGE_KEY_SAVED_AT]);
    const restored = saved?.[STORAGE_KEY_EXTRACTED];
    if (restored && typeof restored === 'object') {
      const fb = Array.isArray(restored.facebook) ? restored.facebook : [];

      // X may be stored either as flattened rows or as a raw workflow wrapper.
      let xRows = Array.isArray(restored.x) ? restored.x : [];
      if (xRows.length === 1 && xRows[0]?.__workflow === 'x' && xRows[0]?.data) {
        xRows = flattenXWorkflowData(xRows[0].data);
      }

      extractedData = { facebook: fb, x: xRows };

      const total = extractedData.facebook.length + extractedData.x.length;
      if (total > 0) {
        uiLog(`Restored ${total} saved results (${saved?.[STORAGE_KEY_SAVED_AT] || 'unknown time'})`);
        updateStats();
        renderResults('all');
        if (statsEl) statsEl.style.display = 'flex';
        if (tabsEl) tabsEl.style.display = 'flex';
        if (exportOptionsEl) exportOptionsEl.style.display = 'flex';
      }
    }

    await restoreXOptions();

    // Always show background progress/logs (even if no results yet).
    await refreshFromBackground();
  })();

  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderResults(btn.dataset.tab);
    });
  });

  // Extract button
  extractBtn.addEventListener('click', async () => {
    uiLog('Extract clicked');
    extractBtn.disabled = true;
    showStatus('Injecting script... DO NOT CLOSE THIS POPUP.', 'info');

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      if (!tab.url) throw new Error("Cannot access this page");

      uiLog(`Active tab: ${tab.url}`);

      const isFacebook = tab.url.includes('facebook.com');
      const isX = tab.url.includes('twitter.com') || tab.url.includes('x.com');

      if (!isFacebook && !isX) throw new Error("Please navigate to Facebook or X/Twitter");

      let data;

      if (isFacebook) {
        uiLog('Platform: Facebook');
        showStatus('Extracting Facebook shares... Auto-scrolling and hovering. This takes time.', 'info');

        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: runExtractionOnPage,
          args: ['facebook']
        });

        if (!results || !results[0]) {
          throw new Error('No response from page script. Ensure the shares dialog is open.');
        }
        if (results[0].error) {
          const message = results[0].error.message || String(results[0].error);
          throw new Error(`Facebook extraction failed: ${message}`);
        }
        data = results[0].result;
      } else {
        uiLog('Platform: X/Twitter');
        showStatus('🤖 Starting X/Twitter workflow in background (you can close the popup)...', 'info');

        const tweetUrl = tab.url.split('?')[0];
        const xOpts = readXOptionsFromUi();
        uiLog(`X options: maxQuoteDetails=${xOpts.maxQuoteDetails}, maxQuotesMinutes=${Math.round(xOpts.maxQuotesDurationMs / 60000)}, maxRetweetsMinutes=${Math.round(xOpts.maxRetweetsDurationMs / 60000)}`);

        const workflowOptions = {
          maxQuoteDetails: xOpts.maxQuoteDetails,
          maxQuotesDurationMs: xOpts.maxQuotesDurationMs,
          maxRetweetsDurationMs: xOpts.maxRetweetsDurationMs,
          scroll: { maxScrolls: 18, settleLoops: 3, delayMs: 1700 }
        };

        // Start async workflow in background. Do not wait for completion.
        const start = await chrome.runtime.sendMessage({
          type: 'x_start_workflow',
          tabId: tab.id,
          tweetUrl,
          options: workflowOptions
        });

        if (!start?.ok) throw new Error(start?.error || 'Failed to start X workflow');

        // Immediately switch UI into live mode; do not block waiting for completion.
        await refreshFromBackground();
        data = [];
      }

      if (!Array.isArray(data)) {
        throw new Error(`Unexpected extraction result type: ${typeof data}`);
      }
      
      if (data.length === 0) {
        if (isFacebook) {
          showStatus('No share data found. Ensure the shares dialog is open.', 'error');
          extractBtn.disabled = false;
          return;
        }
        // X: background workflow is running; live status/logs handle UX.
        extractBtn.disabled = false;
        return;
      }

      if (isFacebook) extractedData.facebook = data;
      else extractedData.x = data;

      // Persist results so they survive popup close/tab switching.
      // (X background also persists; this keeps the shape consistent for restore.)
      await storageSet({
        [STORAGE_KEY_EXTRACTED]: extractedData,
        [STORAGE_KEY_SAVED_AT]: new Date().toISOString(),
      });
      
      updateStats();
      renderResults('all');
      showStatus(`Success! Found ${data.length} shares.`, 'success');
      
      // Show export controls
      if (statsEl) statsEl.style.display = 'flex';
      if (tabsEl) tabsEl.style.display = 'flex';
      if (exportOptionsEl) exportOptionsEl.style.display = 'flex';
      
    } catch (error) {
      console.error('Extraction error:', error);
      uiLog(`Catch: ${error?.message || String(error)}`);
      showStatus(`Error: ${error.message}`, 'error');
    }

    extractBtn.disabled = false;
  });

  // Clear button
  clearBtn.addEventListener('click', async () => {
    extractedData = { facebook: [], x: [] };
    await storageSet({
      [STORAGE_KEY_EXTRACTED]: extractedData,
      [STORAGE_KEY_SAVED_AT]: new Date().toISOString(),
    });
    updateStats();
    renderResults('all');
    if (statsEl) statsEl.style.display = 'none';
    if (tabsEl) tabsEl.style.display = 'none';
    if (exportOptionsEl) exportOptionsEl.style.display = 'none';
    showStatus('', 'info');
  });

  // Reset button: clears persisted + in-memory data.
  resetBtn.addEventListener('click', async () => {
    stopLivePolling();
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) await chrome.runtime.sendMessage({ type: 'sse_reset_all', tabId: tab.id });
    } catch {
      // ignore
    }
    await storageRemove([STORAGE_KEY_EXTRACTED, STORAGE_KEY_SAVED_AT]);
    extractedData = { facebook: [], x: [] };
    updateStats();
    renderResults('all');
    if (statsEl) statsEl.style.display = 'none';
    if (tabsEl) tabsEl.style.display = 'none';
    if (exportOptionsEl) exportOptionsEl.style.display = 'none';
    showStatus('Reset complete. Ready for a fresh run.', 'success');
    setTimeout(() => showStatus('', 'info'), 2000);
  });

  // --- EXPORT HANDLERS ---

  // Export JSON
  document.getElementById('exportJSON').addEventListener('click', () => {
    const all = [...extractedData.facebook, ...extractedData.x];
    const rows = all.map(toExcelRow);
    downloadFile(JSON.stringify(rows, null, 2), 'shares.json', 'application/json');
  });

  // Export CSV (Comma Separated for File)
  document.getElementById('exportCSV').addEventListener('click', () => {
    const all = [...extractedData.facebook, ...extractedData.x];
    const csvContent = formatData(all, true, ","); // Use comma for file
    downloadFile(csvContent, 'shares.csv', 'text/csv');
  });

  // Copy to Clipboard (Tab Separated for Paste)
  const getMainPostRows = () => {
    // Main post is an X-only concept in this extension.
    const x = Array.isArray(extractedData?.x) ? extractedData.x : [];
    return x.filter(r => (r?.type || r?.kind) === 'MAIN_POST');
  };

  const getOtherRows = () => {
    const fb = Array.isArray(extractedData?.facebook) ? extractedData.facebook : [];
    const x = Array.isArray(extractedData?.x) ? extractedData.x : [];
    const xOthers = x.filter(r => (r?.type || r?.kind) !== 'MAIN_POST');
    return [...fb, ...xOthers];
  };

  document.getElementById('copyMain')?.addEventListener('click', async () => {
    const main = getMainPostRows();
    if (!main.length) {
      showStatus('No MAIN_POST found to copy.', 'error');
      setTimeout(() => showStatus('', 'info'), 2500);
      return;
    }
    const tsvContent = formatData(main, false, "\t"); // Use TAB for clipboard columns
    await navigator.clipboard.writeText(tsvContent);
    showStatus('Main post copied!', 'success');
    setTimeout(() => showStatus('', 'info'), 2500);
  });

  document.getElementById('copyOthers')?.addEventListener('click', async () => {
    const others = getOtherRows();
    if (!others.length) {
      showStatus('No other rows found to copy.', 'error');
      setTimeout(() => showStatus('', 'info'), 2500);
      return;
    }
    const tsvContent = formatData(others, false, "\t"); // Use TAB for clipboard columns
    await navigator.clipboard.writeText(tsvContent);
    showStatus('Other rows copied! Ready to paste into Excel/Sheets.', 'success');
    setTimeout(() => showStatus('', 'info'), 3000);
  });
});

function toExcelRow(item) {
  const username = item?.username ? String(item.username) : '';
  const viewCount = item?.viewCount ? String(item.viewCount) : '';

  const userIdLink = item?.profileUrl ? String(item.profileUrl) : '';

  // Prefer an actual post URL when present; for repost rows we may only have a profile URL.
  // If workflow attached a mainTweetUrl/parentTweetUrl, prefer that for post link.
  const postLink =
    (item?.tweetUrl ? String(item.tweetUrl) : '') ||
    (item?.type === 'REPOST' && item?.mainTweetUrl ? String(item.mainTweetUrl) : '') ||
    (item?.type === 'REPOST' && item?.parentTweetUrl ? String(item.parentTweetUrl) : '') ||
    (item?.postUrl ? String(item.postUrl) : '');

  // Export Time should be ISO when available (e.g., 2024-08-05T18:00:00.000Z).
  // UI can still show a human-readable string via `item.time`.
  const isoTime =
    (item?.isoTime ? String(item.isoTime) : '') ||
    (item?.timestamp ? String(item.timestamp) : '') ||
    (item?.iso_time ? String(item.iso_time) : '');

  const time = isoTime || (item?.time ? String(item.time) : '');

  return {
    username,
    viewCount,
    userIdLink,
    postLink,
    time,
  };
}

function flattenXWorkflowData(data) {
  if (!data) return [];
  const out = [];

  const mainTweetUrl = data?.main?.tweetUrl || data?.main?.postUrl || null;

  const pushNormalized = (item) => {
    const normalized = normalizeXItemForUiAndExport(
      mainTweetUrl ? { ...item, mainTweetUrl } : item
    );
    if (normalized) out.push(normalized);
  };

  // Merge QUOTE_DETAIL into QUOTE by tweetUrl to avoid duplicates.
  const quotes = Array.isArray(data.quotes) ? data.quotes : [];
  const quoteDetails = Array.isArray(data.quoteDetails) ? data.quoteDetails : [];
  const detailByUrl = new Map();
  for (const d of quoteDetails) {
    const url = d?.tweetUrl;
    if (url && !detailByUrl.has(url)) detailByUrl.set(url, d);
  }
  const mergedQuotes = quotes.map((q) => {
    const d = q?.tweetUrl ? detailByUrl.get(q.tweetUrl) : null;
    if (!d) return q;
    // Prefer details for counts/views/text if present, keep quote timestamp.
    return {
      ...d,
      ...q,
      kind: 'QUOTE',
    };
  });

  if (data.main) pushNormalized(data.main);
  mergedQuotes.forEach(pushNormalized);
  // Only include quoteDetails that weren't present in quotes list.
  for (const d of quoteDetails) {
    if (d?.tweetUrl && quotes.some(q => q?.tweetUrl === d.tweetUrl)) continue;
    pushNormalized(d);
  }
  if (Array.isArray(data.reposts)) data.reposts.forEach(pushNormalized);

  // Final dedupe for safety (by postUrl if present, else by profileUrl+type+username).
  const seen = new Set();
  const deduped = [];
  for (const item of out) {
    const key = item?.postUrl ? `url:${item.postUrl}` : `fallback:${item?.type}:${item?.profileUrl}:${item?.username}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function normalizeXItemForUiAndExport(item) {
  if (!item || typeof item !== 'object') return null;

  const type = item.type || item.kind || null;
  const tweetUrl = item.tweetUrl || item.postUrl || null;
  const profileUrl = item.profileUrl || null;
  const timestamp = item.timestamp || item.isoTime || null;
  const timestampText = item.timestampText || null;
  const viewCount = item.viewCount ?? null;

  // For the existing UI/export pipeline, we always provide:
  // username, time, isoTime, profileUrl, groupUrl, postUrl
  const username = item.username || (item.handle ? String(item.handle) : '') || '';
  const displayName = item.displayName || '';

  // Prefer tweet link for tweet/quote items; profile link for reposters.
  const bestLink =
    (type === 'REPOST' ? profileUrl : tweetUrl) ||
    tweetUrl ||
    profileUrl ||
    '';

  const timeText =
    timestampText ||
    timestamp ||
    item.note ||
    (type === 'REPOST' ? 'N/A (no repost timestamps on X retweeters list)' : 'Unknown');

  // Hard rule: retweeter rows do NOT have views or timestamps.
  // X/Twitter retweeters list does not provide these, so showing them would be misleading.
  const isRepost = type === 'REPOST';

  return {
    // Used by some Twitter renderers in older iterations
    type: type || 'X_ITEM',
    // Keep original fields for debugging
    ...item,

    // Canonical fields used by existing UI/export
    username: displayName && username ? `${displayName} ${username}` : (displayName || username || 'Unknown'),
    time: isRepost ? (item.note || 'N/A (no repost timestamps on X retweeters list)') : timeText,
    isoTime: isRepost ? '' : (timestamp || ''),
    viewCount: isRepost ? '' : (viewCount || ''),
    profileUrl: profileUrl || '',
    groupUrl: '',
    postUrl: bestLink || ''
  };
}

// ======================================================
// X/TWITTER EXTRACTION ENGINE (Injected into Page)
// NOTE: Must be self-contained for chrome.scripting.executeScript.
// ======================================================
async function runTwitterAutomation() {
  const results = [];
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const log = (msg) => {
    console.log(`[TWITTER] ${msg}`);
    return msg;
  };

  const autoScrollToBottom = async () => {
    let lastHeight = Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0);
    let noChangeCount = 0;
    const maxScrolls = 16;
    let scrollCount = 0;

    while (scrollCount < maxScrolls && noChangeCount < 3) {
      const height = Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0);
      window.scrollTo(0, height);
      await wait(1600);

      const newHeight = Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0);
      if (newHeight === lastHeight) noChangeCount++;
      else noChangeCount = 0;
      lastHeight = newHeight;
      scrollCount++;
    }

    window.scrollTo(0, 0);
    await wait(250);
  };

  const extractMainPostData = () => {
    const mainTweet = document.querySelector('article[data-testid="tweet"]');
    if (!mainTweet) return null;

    const data = {
      type: 'MAIN_POST',
      timestamp: null,
      timestampText: null,
      viewCount: null,
      repostCount: null,
      likeCount: null,
      replyCount: null,
      username: null,
      displayName: null,
      tweetText: null,
      tweetUrl: window.location.href.split('?')[0],
      profileUrl: null
    };

    const time = mainTweet.querySelector('time');
    if (time) {
      data.timestamp = time.getAttribute('datetime');
      data.timestampText = time.textContent.trim();
    }

    const userName = mainTweet.querySelector('[data-testid="User-Name"]');
    if (userName) {
      const links = userName.querySelectorAll('a');
      if (links[0]) {
        data.displayName = links[0].textContent.trim();
        data.profileUrl = links[0].href;
      }
      if (links[1]) {
        data.username = links[1].textContent.trim();
      }
    }

    const text = mainTweet.querySelector('[data-testid="tweetText"]');
    if (text) data.tweetText = text.textContent.trim();

    const allText = mainTweet.innerText.toLowerCase();
    const viewMatch = allText.match(/(\d+[\d,\.]*(?:[km])?)\s*views?/i);
    if (viewMatch) data.viewCount = viewMatch[1];

    const repostBtn = mainTweet.querySelector('[data-testid="retweet"]');
    if (repostBtn) {
      const aria = repostBtn.getAttribute('aria-label');
      const match = aria?.match(/^(\d+[\d,\.]*(?:[km])?)/i);
      if (match) data.repostCount = match[1];
    }

    const likeBtn = mainTweet.querySelector('[data-testid="like"]') || mainTweet.querySelector('[data-testid="unlike"]');
    if (likeBtn) {
      const aria = likeBtn.getAttribute('aria-label');
      const match = aria?.match(/^(\d+[\d,\.]*(?:[km])?)/i);
      if (match) data.likeCount = match[1];
    }

    const replyBtn = mainTweet.querySelector('[data-testid="reply"]');
    if (replyBtn) {
      const aria = replyBtn.getAttribute('aria-label');
      const match = aria?.match(/^(\d+[\d,\.]*(?:[km])?)/i);
      if (match) data.replyCount = match[1];
    }

    return data;
  };

  const extractAllQuotes = () => {
    const quoteResults = [];
    const tweets = document.querySelectorAll('article[data-testid="tweet"]');
    tweets.forEach((tweet, index) => {
      const data = {
        type: 'QUOTE',
        index,
        timestamp: null,
        timestampText: null,
        username: null,
        displayName: null,
        tweetText: null,
        tweetUrl: null,
        profileUrl: null
      };

      const time = tweet.querySelector('time');
      if (time) {
        data.timestamp = time.getAttribute('datetime');
        data.timestampText = time.textContent.trim();
      }

      const userName = tweet.querySelector('[data-testid="User-Name"]');
      if (userName) {
        const links = userName.querySelectorAll('a');
        if (links[0]) {
          data.displayName = links[0].textContent.trim();
          data.profileUrl = links[0].href;
        }
        if (links[1]) data.username = links[1].textContent.trim();
      }

      const text = tweet.querySelector('[data-testid="tweetText"]');
      if (text) data.tweetText = text.textContent.trim();

      const link = tweet.querySelector('a[href*="/status/"]');
      if (link) data.tweetUrl = link.href.split('?')[0];

      if (data.username || data.displayName) quoteResults.push(data);
    });
    return quoteResults;
  };

  const extractAllReposts = () => {
    const repostResults = [];
    const userCells = document.querySelectorAll('[data-testid="UserCell"]');
    userCells.forEach((cell, index) => {
      const data = {
        type: 'REPOST',
        index,
        timestamp: 'N/A (X/Twitter does not provide repost timestamps in the retweeters list DOM)',
        username: null,
        displayName: null,
        profileUrl: null
      };

      const avatar = cell.querySelector('[data-testid^="UserAvatar-Container-"]');
      if (avatar) {
        const testId = avatar.getAttribute('data-testid');
        const match = testId?.match(/UserAvatar-Container-(.+)/);
        if (match) {
          data.username = '@' + match[1];
          data.profileUrl = `https://x.com/${match[1]}`;
        }
      }

      const spans = cell.querySelectorAll('span');
      for (const span of spans) {
        const text = span.textContent.trim();
        if (text && !text.startsWith('@') && text.length > 0 && text.length < 100) {
          data.displayName = text;
          break;
        }
      }

      if (data.username) repostResults.push(data);
    });
    return repostResults;
  };

  log('=== START ===');
  const url = new URL(window.location.href);
  const host = (url.hostname || '').toLowerCase();
  const isXHost = host === 'x.com' || host.endsWith('.x.com');
  const isTwitterHost = host === 'twitter.com' || host.endsWith('.twitter.com');
  if (!isXHost && !isTwitterHost) throw new Error('Not on X/Twitter');

  const path = url.pathname || '';
  const isTweetLikePath = /\/status\/\d+/.test(path) || /\/i\/(web\/)?status\/\d+/.test(path);
  if (!isTweetLikePath) throw new Error('Open a tweet URL (must include /status/<id>)');

  const isQuotesPage = path.includes('/quotes');
  const isRepostsPage = path.includes('/retweets') || path.includes('/retweeters');

  if (isQuotesPage) {
    await autoScrollToBottom();
    await wait(800);
    results.push(...extractAllQuotes());
    return results;
  }

  if (isRepostsPage) {
    await autoScrollToBottom();
    await wait(800);
    results.push(...extractAllReposts());
    return results;
  }

  const main = extractMainPostData();
  if (!main) throw new Error('Could not find tweet article (not loaded or blocked by login)');
  results.push(main);
  return results;
}

// Data Formatter (Supports CSV and TSV)
function formatData(data, includeHeader, delimiter) {
  const columns = ['Username', 'View Count', 'User ID Link', 'Post Link', 'Time'];
  
  let output = "";
  if (includeHeader) {
    output += columns.join(delimiter) + "\n";
  }

  output += data.map(row => {
    // Sanitize fields (escape quotes if needed)
    const sanitize = (str) => {
      let s = String(str || '');
      // If data contains the delimiter, newlines, or quotes, wrap it in quotes
      if (s.includes(delimiter) || s.includes('"') || s.includes('\n')) {
        s = `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };

    const excelRow = toExcelRow(row);

    return [
      sanitize(excelRow.username),
      sanitize(excelRow.viewCount),
      sanitize(excelRow.userIdLink),
      sanitize(excelRow.postLink),
      sanitize(excelRow.time)
    ].join(delimiter);
  }).join("\n");

  return output;
}

function downloadFile(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// UI Helpers
function showStatus(message, type) {
  const statusEl = document.getElementById('status');
  statusEl.textContent = message;
  statusEl.className = 'status';
  if (message) {
    statusEl.classList.add('show');
    if (type) statusEl.classList.add(type);
  }
}

function updateStats() {
  const total = extractedData.facebook.length + extractedData.x.length;
  const fbCount = document.getElementById('fbCount');
  const xCount = document.getElementById('xCount');
  const totalCount = document.getElementById('totalCount');

  if(fbCount) fbCount.textContent = extractedData.facebook.length;
  if(xCount) xCount.textContent = extractedData.x.length;
  if(totalCount) totalCount.textContent = total;
}

function renderResults(filter) {
  const resultsEl = document.getElementById('results');
  let data = [];

  if (!filter || filter === 'all' || filter === 'facebook') data = data.concat(extractedData.facebook);
  if (!filter || filter === 'all' || filter === 'x') data = data.concat(extractedData.x);

  // Keep MAIN_POST at top as a separate section (X only).
  const mainPosts = data.filter(r => (r?.type || r?.kind) === 'MAIN_POST');
  const others = data.filter(r => (r?.type || r?.kind) !== 'MAIN_POST');

  if (data.length === 0) {
    resultsEl.innerHTML = `<div class="empty-state">No results yet.</div>`;
    return;
  }

  const sectionTitle = (text) => `
    <div style="font-size:11px; color:#65676b; margin:10px 0 6px; text-transform:uppercase; letter-spacing:0.4px;">${escapeHtml(text)}</div>
  `;

  const renderCard = (item) => {
    const href = (item && (item.postUrl || item.tweetUrl || item.profileUrl)) ? String(item.postUrl || item.tweetUrl || item.profileUrl) : '';
    const safeHref = href === 'undefined' || href === 'null' ? '' : href;
    const linkLabel = item?.type === 'REPOST' ? 'View Profile' : 'View Post';
    const views = item?.viewCount ? String(item.viewCount) : '';

    return `
      <div class="share-card">
        <div class="name">${escapeHtml(item.username)}</div>
        <div class="time">🕐 ${escapeHtml(item.time)}</div>
        ${views ? `<div class="time">👁️ ${escapeHtml(views)} Views</div>` : ''}
        ${safeHref ? `<div class="link">📄 <a href="${escapeHtml(safeHref)}" target="_blank">${linkLabel}</a></div>` : ''}
        ${item.groupUrl ? `<div class="link" style="color:#666">👥 Group: <a href="${escapeHtml(item.groupUrl)}" target="_blank">Link</a></div>` : ''}
      </div>
    `;
  };

  let html = '';
  if (mainPosts.length) {
    html += sectionTitle('Main Post');
    html += mainPosts.map(renderCard).join('');
  }
  if (others.length) {
    html += sectionTitle('Others');
    html += others.map(renderCard).join('');
  }
  resultsEl.innerHTML = html;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

// ======================================================
// EXTRACTION ENGINE (Injected into Page)
// ======================================================
async function runExtractionOnPage(platform) {
  const results = [];
  const processedIds = new Set();
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const DATE_REGEX = /[A-Z][a-z]+ \d{1,2} [A-Z][a-z]+ \d{4} at \d{1,2}:\d{2}|[A-Z][a-z]+, [A-Z][a-z]+ \d{1,2}, \d{4}/;

  function safeParseIsoTime(timeText) {
    if (!timeText) return "";
    try {
      const d = new Date(timeText);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    } catch (e) {}
    return "";
  }

  function sanitizeFacebookUrl(rawHref) {
    if (!rawHref) return "";
    try {
      const url = new URL(rawHref, location.href);
      url.hash = "";

      const preserveQueryForPaths = new Set(["/profile.php", "/permalink.php", "/story.php", "/photo.php", "/video.php"]);
      const shouldPreserveQuery = preserveQueryForPaths.has(url.pathname);

      const allowList = new Set();
      if (url.pathname === "/profile.php") {
        allowList.add("id");
      } else if (url.pathname === "/permalink.php") {
        allowList.add("id");
        allowList.add("story_fbid");
      } else if (url.pathname === "/story.php") {
        allowList.add("story_fbid");
        allowList.add("id");
      } else if (url.pathname === "/photo.php") {
        allowList.add("fbid");
        allowList.add("set");
        allowList.add("id");
      } else if (url.pathname === "/video.php") {
        allowList.add("v");
        allowList.add("id");
      }

      if (shouldPreserveQuery) {
        // Drop common tracking params while preserving identifiers.
        const next = new URLSearchParams();
        for (const [k, v] of url.searchParams.entries()) {
          if (allowList.size > 0) {
            if (allowList.has(k)) next.append(k, v);
          } else {
            // fallback: keep nothing (shouldn't happen for preserved paths)
          }
        }
        url.search = next.toString();
      } else {
        // Most FB URLs: query is largely tracking; strip it.
        url.search = "";
      }

      return url.toString();
    } catch (e) {
      return String(rawHref).split('#')[0];
    }
  }

  function getTimestampFromLink(link) {
    if (!link) return "";

    const candidates = [];
    const a = (link.getAttribute('aria-label') || '').trim();
    if (a) candidates.push(a);

    const spanAria = link.querySelector('span[aria-label]')?.getAttribute('aria-label');
    if (spanAria) candidates.push(String(spanAria).trim());

    const abbrTitle = link.querySelector('abbr')?.getAttribute('title');
    if (abbrTitle) candidates.push(String(abbrTitle).trim());

    const timeEl = link.querySelector('time');
    const timeDt = (timeEl?.getAttribute('datetime') || timeEl?.dateTime || '').trim();
    if (timeDt) candidates.push(timeDt);

    // As a last resort (may be relative like "1d")
    const txt = (link.textContent || '').trim();
    if (txt && txt.length <= 16) candidates.push(txt);

    return candidates[0] || "";
  }

  // --- X/Twitter Logic ---
  if (platform !== 'facebook') {
    document.querySelectorAll('[data-testid="tweet"]').forEach(t => {
      const time = t.querySelector('time')?.getAttribute('datetime');
      const name = t.querySelector('[data-testid="User-Name"]')?.textContent;
      const link = t.querySelector('a[href*="/status/"]')?.href;
      if(name) {
        results.push({ 
            username: name, 
            time: time || "Unknown", 
            isoTime: time || "", 
            profileUrl: "", 
            groupUrl: "", 
            postUrl: link || "" 
        });
      }
    });
    return results;
  }

  // --- FACEBOOK LOGIC ---
  
  // ============================================
  // FIXED: Prioritized dialog detection for "People who shared this"
  // ============================================
  const allDialogs = document.querySelectorAll('[role="dialog"]');
  let dialog = null;

  // Log all dialogs for debugging
  console.log("=== SHARE EXTRACTOR - DIALOG DETECTION ===");
  console.log(`Found ${allDialogs.length} dialogs on page`);
  allDialogs.forEach((d, i) => {
    const label = d.getAttribute('aria-label') || '(no label)';
    const hasProfiles = d.querySelectorAll('[data-ad-rendering-role="profile_name"]').length;
    const h2Text = d.querySelector('h2')?.textContent || '(no h2)';
    console.log(`Dialog ${i}: aria-label="${label}" | h2="${h2Text}" | profiles: ${hasProfiles}`);
  });

  // PRIORITY 1: Exact match for "People who shared this" aria-label
  for (const d of allDialogs) {
    const ariaLabel = (d.getAttribute('aria-label') || '').toLowerCase();
    if (ariaLabel === 'people who shared this') {
      dialog = d;
      console.log("✅ EXACT MATCH: Found 'People who shared this' dialog via aria-label");
      break;
    }
  }

  // PRIORITY 2: Check h2 heading text for exact match
  if (!dialog) {
    for (const d of allDialogs) {
      const h2 = d.querySelector('h2');
      const h2Text = (h2?.textContent || '').toLowerCase().trim();
      if (h2Text === 'people who shared this' || h2Text.includes('people who shared')) {
        dialog = d;
        console.log("✅ H2 EXACT MATCH: Found dialog with h2:", h2Text);
        break;
      }
    }
  }

  // PRIORITY 3: Check for span with "People who shared this" text
  if (!dialog) {
    for (const d of allDialogs) {
      const spans = d.querySelectorAll('span');
      for (const span of spans) {
        const text = (span.textContent || '').toLowerCase().trim();
        if (text === 'people who shared this') {
          dialog = d;
          console.log("✅ SPAN MATCH: Found dialog with span text:", text);
          break;
        }
      }
      if (dialog) break;
    }
  }

  // PRIORITY 4: Partial match in aria-label for shares-related text
  if (!dialog) {
    const ariaMatches = ['shared this', 'who shared', 'shares', 'reposts'];
    for (const d of allDialogs) {
      const ariaLabel = (d.getAttribute('aria-label') || '').toLowerCase();
      if (ariaMatches.some(kw => ariaLabel.includes(kw))) {
        dialog = d;
        console.log("✅ ARIA PARTIAL MATCH: Found dialog with aria-label:", ariaLabel);
        break;
      }
    }
  }

  // PRIORITY 5: Dialog with profile_name elements AND "Some posts may not appear" text
  // This text appears at bottom of shares dialog
  if (!dialog) {
    for (const d of allDialogs) {
      const hasProfileNames = d.querySelectorAll('[data-ad-rendering-role="profile_name"]').length > 0;
      const innerText = d.innerText || '';
      const hasPrivacyNote = innerText.includes('Some posts may not appear here');
      
      if (hasProfileNames && hasPrivacyNote) {
        dialog = d;
        console.log("✅ PRIVACY NOTE MATCH: Found dialog with profile_names + privacy notice");
        break;
      }
    }
  }

  // PRIORITY 6: Dialog with profile_name elements (likely shares list)
  if (!dialog) {
    // Skip dialogs that are clearly not the shares dialog
    const skipKeywords = [
      'notification', 'notifications', 'menu', 'search',
      'messenger', 'chat', 'message', 'compose', 'create', 
      'story', 'stories', 'reel', 'reels', 'live'
    ];
    
    for (const d of allDialogs) {
      const ariaLabel = (d.getAttribute('aria-label') || '').toLowerCase();
      const shouldSkip = skipKeywords.some(kw => ariaLabel.includes(kw));
      if (shouldSkip) continue;
      
      const profileCount = d.querySelectorAll('[data-ad-rendering-role="profile_name"]').length;
      if (profileCount > 0) {
        dialog = d;
        console.log("✅ PROFILE MATCH: Found dialog with", profileCount, "profile_name elements");
        break;
      }
    }
  }

  // PRIORITY 7: Last resort - any visible dialog not in skip list
  if (!dialog) {
    const skipKeywords = [
      'notification', 'notifications', 'menu', 'search',
      'messenger', 'chat', 'message', 'compose', 'create'
    ];
    
    for (const d of allDialogs) {
      const ariaLabel = (d.getAttribute('aria-label') || '').toLowerCase();
      const shouldSkip = skipKeywords.some(kw => ariaLabel.includes(kw));
      
      // Check if dialog is visible
      const rect = d.getBoundingClientRect();
      const isVisible = rect.width > 0 && rect.height > 0;
      
      if (!shouldSkip && isVisible) {
        dialog = d;
        console.log("⚠️ FALLBACK: Using visible dialog:", ariaLabel || "(no aria-label)");
        break;
      }
    }
  }

  if (!dialog) {
    console.error("❌ NO SUITABLE DIALOG FOUND");
    console.log("Make sure the 'People who shared this' popup is open!");
    return [];
  }

  console.log("=== USING DIALOG ===");
  console.log("aria-label:", dialog.getAttribute('aria-label'));
  console.log("h2 text:", dialog.querySelector('h2')?.textContent);

  // Identify Scroll Container - look for the scrollable area INSIDE the dialog
  let scrollableDiv = null;
  
  // First, try to find the specific scrollable container in the shares dialog
  const potentialScrollers = Array.from(dialog.querySelectorAll('div')).filter(d => {
    const s = window.getComputedStyle(d);
    const hasScroll = s.overflowY === 'auto' || s.overflowY === 'scroll';
    const hasHeight = d.scrollHeight > d.clientHeight;
    return hasScroll && hasHeight;
  });
  
  // Pick the one with the most content (largest scrollHeight)
  if (potentialScrollers.length > 0) {
    scrollableDiv = potentialScrollers.reduce((a, b) => 
      a.scrollHeight > b.scrollHeight ? a : b
    );
    console.log("Found scrollable container with height:", scrollableDiv.scrollHeight);
  }
  
  if (!scrollableDiv) {
    // Fallback: any div with overflow auto/scroll
    scrollableDiv = Array.from(dialog.querySelectorAll('div')).find(d => {
      const s = window.getComputedStyle(d);
      return s.overflowY === 'auto' || s.overflowY === 'scroll';
    });
  }
  
  if (!scrollableDiv) scrollableDiv = dialog;
  console.log("Scroll container:", scrollableDiv.className.substring(0, 50) + "...");

  // If user manually scrolled to the end before running, virtualization means we only see the tail.
  // Reset to top so we can collect everything consistently.
  try {
    scrollableDiv.scrollTop = 0;
  } catch (e) {}
  await wait(1200);

  // 1. Setup Tooltip Observer
  let foundTooltipText = null;
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach(node => {
        if (node.nodeType === 1) {
          const text = (node.innerText || "").trim();
          if (DATE_REGEX.test(text)) {
            foundTooltipText = text.match(DATE_REGEX)[0];
          }
        }
      });
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // 2. Nuclear Hover
  async function triggerDeepHover(element) {
    if (!element) return;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    element.focus({ preventScroll: true });
    
    const rect = element.getBoundingClientRect();
    const x = rect.left + (rect.width / 2);
    const y = rect.top + (rect.height / 2);

    const opts = {
      bubbles: true, cancelable: true, view: window,
      clientX: x, clientY: y, screenX: x, screenY: y,
      pointerType: 'mouse', button: 0, buttons: 1
    };

    element.dispatchEvent(new PointerEvent('pointerover', opts));
    element.dispatchEvent(new PointerEvent('pointerenter', opts));
    element.dispatchEvent(new MouseEvent('mouseover', opts));
    element.dispatchEvent(new MouseEvent('mouseenter', opts));
    
    for (let i = 0; i < 6; i++) {
      await wait(60);
      const moveOpts = { ...opts, clientX: x + i, clientY: y + (i % 2) };
      element.dispatchEvent(new PointerEvent('pointermove', moveOpts));
      element.dispatchEvent(new MouseEvent('mousemove', moveOpts));
    }
  }

  // 3. Extraction Loop
  let noProgressStreak = 0;
  let safetyCount = 0;
  let isScrollingFinished = false;

  const startTime = Date.now();
  let lastProcessedSize = 0;

  function getVisibleRowSignature() {
    const rows = Array.from(dialog.querySelectorAll('[data-ad-rendering-role="profile_name"]')).slice(0, 10);
    return rows.map(r => (r.textContent || '').trim().slice(0, 80)).join('|');
  }

  async function waitForSignatureChange(prevSig, timeoutMs) {
    const start = Date.now();
    let sig = prevSig;
    while (Date.now() - start < timeoutMs) {
      sig = getVisibleRowSignature();
      if (sig && sig !== prevSig) return sig;
      await wait(250);
    }
    return sig;
  }

  function isAtBottom() {
    if (!scrollableDiv) return true;
    return (scrollableDiv.scrollTop + scrollableDiv.clientHeight) >= (scrollableDiv.scrollHeight - 4);
  }

  function isPrivacyNoteLikelyReached() {
    const privacyEl = Array.from(dialog.querySelectorAll('span,div')).find(n =>
      (n.textContent || '').includes('Some posts may not appear here')
    );
    if (!privacyEl || !scrollableDiv) return false;
    try {
      const pr = privacyEl.getBoundingClientRect();
      const cr = scrollableDiv.getBoundingClientRect();
      // Only treat it as end-of-list if it's within/near the visible scroll viewport.
      return pr.top >= (cr.top - 24) && pr.bottom <= (cr.bottom + 24);
    } catch (e) {
      return false;
    }
  }

  while (!isScrollingFinished && safetyCount < 600) {
    const rows = Array.from(dialog.querySelectorAll('[data-ad-rendering-role="profile_name"]'));
    let newItemsInPass = 0;

    for (const row of rows) {
        // -- DATA FIELDS --
        let username = "Unknown";
        let groupUrl = "";
        let profileUrl = "";

        const headerLinks = Array.from(row.querySelectorAll('a[href]')).filter(a => !!a.href);
        
        if (headerLinks.length > 0) {
            // First link is User
            const userLink = headerLinks[0];
            username = userLink.textContent.trim();
            profileUrl = sanitizeFacebookUrl(userLink.href);

            // Second link (if exists and different) is Group
            if (headerLinks.length > 1) {
                const potentialGroup = headerLinks[1];
                if (potentialGroup.textContent.trim() !== username) {
                  groupUrl = sanitizeFacebookUrl(potentialGroup.href);
                }
            }
        } else {
            const nameEl = row.querySelector('strong') || row.querySelector('span');
            if (nameEl) username = nameEl.textContent.trim();
        }

        const uniqueId = `${username}|${profileUrl}|${groupUrl}`;
        if (processedIds.has(uniqueId)) continue;

        // -- FIND TIMESTAMP LINK --
        let timestampLink = null;
        let parent = row.parentElement;

        // Depth 10 for deep group nesting
        for (let k = 0; k < 10 && parent; k++) {
            const links = Array.from(parent.querySelectorAll('a[href]'));
            const isGenericGroupLink = (href) => href.includes('/groups/') && !href.includes('/posts/') && !href.includes('/permalink/');

            let candidate = links.find(l => {
                const h = l.href;
                const isPost = h.includes('/posts/') || h.includes('/permalink/') || h.includes('/photo') || h.includes('/video');
                // Ensure it's not the profile link
              return isPost && (!profileUrl || !h.includes(profileUrl));
            });
            
            if (!candidate) {
                candidate = links.find(l => {
                    const aria = l.getAttribute('aria-label');
                return aria && /\d{4}/.test(aria) && (!profileUrl || !l.href.includes(profileUrl)) && !isGenericGroupLink(l.href);
                });
            }

            if (!candidate) {
                candidate = links.find(l => 
                    l.href && 
                    l.href.length > 25 && 
                (!profileUrl || !l.href.includes(profileUrl)) && 
                    !isGenericGroupLink(l.href) &&
                    !l.textContent.includes("Comment")
                );
            }

            if (candidate) {
                timestampLink = candidate;
                break;
            }
            parent = parent.parentElement;
        }

        if (timestampLink) {
            foundTooltipText = null;
            const originalBorder = timestampLink.style.border;
            timestampLink.style.border = "2px solid blue";

          // Prefer aria-label / abbr / time[datetime] (more reliable than hover tooltips).
          let finalTime = getTimestampFromLink(timestampLink);
          if (!finalTime || finalTime.length < 4) {
            await triggerDeepHover(timestampLink);

            let attempts = 0;
            // Slower pages need longer; still keep it bounded.
            while (!foundTooltipText && attempts < 45) {
            await wait(120);
            attempts++;
            }
            finalTime = foundTooltipText || getTimestampFromLink(timestampLink) || "Hover failed";
          }

          let isoTime = safeParseIsoTime(finalTime);
          let postUrl = sanitizeFacebookUrl(timestampLink.href);

          if (finalTime && finalTime !== "Hover failed") {
                timestampLink.style.border = "2px solid #0f0";
            } else {
                timestampLink.style.border = "2px solid orange";
                finalTime = timestampLink.getAttribute('aria-label') || "Hover failed";
            isoTime = safeParseIsoTime(finalTime);
            }

            results.push({ 
                username, 
                time: finalTime, 
                isoTime, 
                profileUrl, 
                groupUrl, 
                postUrl 
            });

            setTimeout(() => { timestampLink.style.border = originalBorder; }, 500);
        } else {
            results.push({ 
                username, 
                time: "Hidden/Privacy", 
                isoTime: "", 
                profileUrl, 
                groupUrl, 
                postUrl: "" 
            });
        }

        processedIds.add(uniqueId);
        newItemsInPass++;
        await wait(50);
    }

    // --- SCROLL LOGIC (virtualized + slow-load friendly) ---
    const progressed = processedIds.size > lastProcessedSize;
    lastProcessedSize = processedIds.size;
    if (!progressed && newItemsInPass === 0) noProgressStreak++;
    else noProgressStreak = 0;

    if (scrollableDiv) {
      const prevSig = getVisibleRowSignature();

      // Step-scroll instead of jumping to absolute bottom. Jumping can skip virtualized segments.
      const step = Math.max(240, Math.floor(scrollableDiv.clientHeight * 0.85));
      scrollableDiv.scrollTop = Math.min(scrollableDiv.scrollTop + step, scrollableDiv.scrollHeight);

      // Wait longer when FB is slow so we don't mis-detect end-of-list.
      await waitForSignatureChange(prevSig, progressed ? 2500 : 6500);
      await wait(300);

      const hitMaxTime = (Date.now() - startTime) > (8 * 60 * 1000);
      const likelyEnd = (noProgressStreak >= 5) && (isAtBottom() || isPrivacyNoteLikelyReached());

      if (hitMaxTime) {
        console.log("Stopping: max time reached.");
        isScrollingFinished = true;
      } else if (likelyEnd) {
        console.log("End of list reached (stabilized).", { noProgressStreak });
        isScrollingFinished = true;
      }
    } else {
      isScrollingFinished = true;
    }
    safetyCount++;
  }

  // Wait for any final content to load after scrolling ends
  await wait(1500);
  
  // One more scroll to absolute bottom to ensure all content is visible
  if (scrollableDiv) {
    scrollableDiv.scrollTop = scrollableDiv.scrollHeight;
    await wait(1000);
  }
  
  // ============================================
  // FINAL PASS: Extract any remaining profiles after scroll ends
  // ============================================
  console.log("Running final extraction pass...");
  const finalRows = Array.from(dialog.querySelectorAll('[data-ad-rendering-role="profile_name"]'));
  
  for (const row of finalRows) {
    let username = "Unknown";
    let groupUrl = "";
    let profileUrl = "";

    const headerLinks = Array.from(row.querySelectorAll('a[href]')).filter(a => !!a.href);
    
    if (headerLinks.length > 0) {
      const userLink = headerLinks[0];
      username = userLink.textContent.trim();
      profileUrl = sanitizeFacebookUrl(userLink.href);

      if (headerLinks.length > 1) {
        const potentialGroup = headerLinks[1];
        if (potentialGroup.textContent.trim() !== username) {
          groupUrl = sanitizeFacebookUrl(potentialGroup.href);
        }
      }
    } else {
      const nameEl = row.querySelector('strong') || row.querySelector('span');
      if (nameEl) username = nameEl.textContent.trim();
    }

    const uniqueId = `${username}|${profileUrl}|${groupUrl}`;
    if (processedIds.has(uniqueId)) continue;

    // Find timestamp link
    let timestampLink = null;
    let parent = row.parentElement;

    for (let k = 0; k < 10 && parent; k++) {
      const links = Array.from(parent.querySelectorAll('a[href]'));
      const isGenericGroupLink = (href) => href.includes('/groups/') && !href.includes('/posts/') && !href.includes('/permalink/');

      let candidate = links.find(l => {
        const h = l.href;
        const isPost = h.includes('/posts/') || h.includes('/permalink/') || h.includes('/photo') || h.includes('/video');
        return isPost && (!profileUrl || !h.includes(profileUrl));
      });
      
      if (!candidate) {
        candidate = links.find(l => {
          const aria = l.getAttribute('aria-label');
          return aria && /\d{4}/.test(aria) && (!profileUrl || !l.href.includes(profileUrl)) && !isGenericGroupLink(l.href);
        });
      }

      if (!candidate) {
        candidate = links.find(l => 
          l.href && 
          l.href.length > 25 && 
          (!profileUrl || !l.href.includes(profileUrl)) && 
          !isGenericGroupLink(l.href) &&
          !l.textContent.includes("Comment")
        );
      }

      if (candidate) {
        timestampLink = candidate;
        break;
      }
      parent = parent.parentElement;
    }

    if (timestampLink) {
      foundTooltipText = null;
      const originalBorder = timestampLink.style.border;
      timestampLink.style.border = "2px solid blue";

      let finalTime = getTimestampFromLink(timestampLink);
      if (!finalTime || finalTime.length < 4) {
        await triggerDeepHover(timestampLink);

        let attempts = 0;
        while(!foundTooltipText && attempts < 45) {
          await wait(120);
          attempts++;
        }
        finalTime = foundTooltipText || getTimestampFromLink(timestampLink) || "Hover failed";
      }

      let isoTime = safeParseIsoTime(finalTime);
      let postUrl = sanitizeFacebookUrl(timestampLink.href);

      if (finalTime && finalTime !== "Hover failed") {
        timestampLink.style.border = "2px solid #0f0";
      } else {
        timestampLink.style.border = "2px solid orange";
        finalTime = timestampLink.getAttribute('aria-label') || "Hover failed";
        isoTime = safeParseIsoTime(finalTime);
      }

      results.push({ 
        username, 
        time: finalTime, 
        isoTime, 
        profileUrl, 
        groupUrl, 
        postUrl 
      });

      setTimeout(() => { timestampLink.style.border = originalBorder; }, 500);
    } else {
      results.push({ 
        username, 
        time: "Hidden/Privacy", 
        isoTime: "", 
        profileUrl, 
        groupUrl, 
        postUrl: "" 
      });
    }

    processedIds.add(uniqueId);
    console.log("Final pass found:", username);
    await wait(50);
  }

  observer.disconnect();
  console.log(`=== EXTRACTION COMPLETE: ${results.length} shares found ===`);
  return results;
}