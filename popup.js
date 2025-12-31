// popup.js

let extractedData = {
  facebook: [],
  x: []
};

document.addEventListener('DOMContentLoaded', () => {
  const extractBtn = document.getElementById('extractBtn');
  const clearBtn = document.getElementById('clearBtn');
  const statusEl = document.getElementById('status');
  const resultsEl = document.getElementById('results');
  
  // UI Handlers
  extractBtn.addEventListener('click', async () => {
    extractBtn.disabled = true;
    showStatus('Injecting script... DO NOT CLOSE THIS POPUP.', 'info');

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      if (!tab.url.includes('facebook.com') && !tab.url.includes('x.com')) {
        throw new Error('Please go to Facebook or X/Twitter');
      }

      showStatus('Extracting... Auto-scrolling and hovering. This takes time to be accurate.', 'info');

      // Execute the "Console Script" logic inside the tab
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: runExtractionOnPage,
        args: [tab.url.includes('facebook.com') ? 'facebook' : 'x']
      });

      if (!results || !results[0] || !results[0].result) {
        throw new Error('Script returned no data. Ensure the dialog is open.');
      }

      const data = results[0].result;
      
      if (tab.url.includes('facebook.com')) extractedData.facebook = data;
      else extractedData.x = data;

      renderResults();
      showStatus(`Success! Found ${data.length} shares.`, 'success');

    } catch (error) {
      console.error(error);
      showStatus(error.message, 'error');
    } finally {
      extractBtn.disabled = false;
    }
  });

  clearBtn.addEventListener('click', () => {
    extractedData = { facebook: [], x: [] };
    renderResults();
    showStatus('', 'info');
  });

  document.getElementById('copyAll').addEventListener('click', () => {
    const all = [...extractedData.facebook, ...extractedData.x];
    const csv = "Name\tTime\tLink\n" + all.map(r => `${r.name}\t${r.time}\t${r.url}`).join("\n");
    navigator.clipboard.writeText(csv);
    showStatus('Copied to clipboard!', 'success');
  });
});

function renderResults() {
  const list = [...extractedData.facebook, ...extractedData.x];
  const container = document.getElementById('results');
  
  if (list.length === 0) {
    container.innerHTML = '<div class="empty-state">No data yet</div>';
    return;
  }

  container.innerHTML = list.map(item => `
    <div class="share-card" style="border-bottom:1px solid #eee; padding:8px;">
      <div style="font-weight:bold">${escapeHtml(item.name)}</div>
      <div style="color:#2e7d32">🕒 ${escapeHtml(item.time)}</div>
      <div style="font-size:0.85em"><a href="${item.url}" target="_blank">View Post</a></div>
    </div>
  `).join('');
}

function showStatus(msg, type) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status ' + type;
  el.style.display = msg ? 'block' : 'none';
}

function escapeHtml(text) {
  if(!text) return '';
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ======================================================
// MAIN EXTRACTION LOGIC
// ======================================================
async function runExtractionOnPage(platform) {
  if (platform !== 'facebook') {
    // Simple X/Twitter Logic
    const items = [];
    document.querySelectorAll('[data-testid="tweet"]').forEach(t => {
      const time = t.querySelector('time')?.getAttribute('datetime');
      const name = t.querySelector('[data-testid="User-Name"]')?.textContent;
      const link = t.querySelector('a[href*="/status/"]')?.href;
      if(name) items.push({ name, time: time || "Unknown", url: link || "" });
    });
    return items;
  }

  // --- FACEBOOK LOGIC ---
  const results = [];
  const processedIds = new Set();
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const DATE_REGEX = /[A-Z][a-z]+ \d{1,2} [A-Z][a-z]+ \d{4} at \d{1,2}:\d{2}|[A-Z][a-z]+, [A-Z][a-z]+ \d{1,2}, \d{4}/;

  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) return [];

  // Identify Scroll Container
  let scrollableDiv = Array.from(dialog.querySelectorAll('div')).find(d => {
      const s = window.getComputedStyle(d);
      return s.overflowY === 'auto' || s.overflowY === 'scroll';
  });
  if (!scrollableDiv) scrollableDiv = dialog;

  // 1. Setup Observer
  let foundTooltipText = null;
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const text = (node.innerText || "").trim();
          if (DATE_REGEX.test(text)) {
            foundTooltipText = text.match(DATE_REGEX)[0];
          }
        }
      }
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
    
    for(let i = 0; i < 3; i++) {
        await wait(50); 
        const moveOpts = { ...opts, clientX: x + i };
        element.dispatchEvent(new PointerEvent('pointermove', moveOpts));
        element.dispatchEvent(new MouseEvent('mousemove', moveOpts));
    }
  }

  // 3. MAIN LOOP
  // We keep running until the scroll mechanism explicitly tells us to stop
  let isScrollingFinished = false;
  
  while (!isScrollingFinished) {
    const rows = Array.from(dialog.querySelectorAll('[data-ad-rendering-role="profile_name"]'));

    for (const row of rows) {
        // --- Name Extraction (User > Group) ---
        let name = "Unknown";
        const headerLinks = Array.from(row.querySelectorAll('a'));
        
        if (headerLinks.length > 0) {
            name = headerLinks[0].textContent.trim();
            if (headerLinks.length > 1) {
                const groupName = headerLinks[1].textContent.trim();
                if (groupName && groupName !== name) {
                    name = `${name} > ${groupName}`;
                }
            }
        } else {
            const nameEl = row.querySelector('strong') || row.querySelector('span');
            if (nameEl) name = nameEl.textContent.trim();
        }

        // Duplicate Check
        const profileLinkEl = row.closest('a') || row.querySelector('a');
        const profileHref = profileLinkEl ? profileLinkEl.href.split('?')[0] : '';
        const uniqueId = name + profileHref;
        
        if (processedIds.has(uniqueId)) continue;

        // --- Link Finding ---
        let timestampLink = null;
        let parent = row.parentElement;

        for (let k = 0; k < 10 && parent; k++) {
            const links = Array.from(parent.querySelectorAll('a[href]'));
            const isGenericGroupLink = (href) => href.includes('/groups/') && !href.includes('/posts/') && !href.includes('/permalink/');

            let candidate = links.find(l => {
                const h = l.href;
                const isPost = h.includes('/posts/') || h.includes('/permalink/') || h.includes('/photo') || h.includes('/video');
                return isPost && !h.includes(profileHref);
            });
            
            if (!candidate) {
                candidate = links.find(l => {
                    const aria = l.getAttribute('aria-label');
                    return aria && /\d{4}/.test(aria) && !l.href.includes(profileHref) && !isGenericGroupLink(l.href);
                });
            }

            if (!candidate) {
                candidate = links.find(l => 
                    l.href && 
                    l.href.length > 25 && 
                    !l.href.includes(profileHref) && 
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

            await triggerDeepHover(timestampLink);

            let attempts = 0;
            while(!foundTooltipText && attempts < 15) {
                await wait(100);
                attempts++;
            }

            if (foundTooltipText) {
                timestampLink.style.border = "2px solid #0f0";
                results.push({ name, time: foundTooltipText, url: timestampLink.href });
            } else {
                timestampLink.style.border = "2px solid orange";
                const fallback = timestampLink.getAttribute('aria-label') || "Hover failed";
                results.push({ name, time: fallback, url: timestampLink.href });
            }

            setTimeout(() => { timestampLink.style.border = originalBorder; }, 500);
        } else {
            results.push({ name, time: "Hidden/Privacy", url: "" });
        }

        processedIds.add(uniqueId);
        // Small delay so UI doesn't freeze
        await wait(50);
    }

    // --- ENHANCED PERSISTENT SCROLL LOGIC ---
    if (scrollableDiv) {
        const previousHeight = scrollableDiv.scrollHeight;
        
        // Scroll to absolute bottom
        scrollableDiv.scrollTop = scrollableDiv.scrollHeight;
        
        // Wait for potential network request
        await wait(2000);

        // Check if height increased
        if (scrollableDiv.scrollHeight > previousHeight) {
            console.log("New content loaded...");
            continue; // Go back to extracting
        } 
        
        // If height didn't change, we try 2 more times (Double Tap)
        // because sometimes the first scroll event is consumed by a spinner
        console.log("Height didn't change, retrying scroll...");
        await wait(1500);
        scrollableDiv.scrollTop = scrollableDiv.scrollHeight; // Force again
        await wait(1500);
        
        if (scrollableDiv.scrollHeight > previousHeight) {
             console.log("New content loaded on retry...");
             continue;
        }
        
        // Third and final try
        console.log("Still no change, final retry...");
        await wait(1500);
        scrollableDiv.scrollTop = scrollableDiv.scrollHeight;
        await wait(1500);

        if (scrollableDiv.scrollHeight <= previousHeight) {
             console.log("Reached end of list.");
             isScrollingFinished = true;
        }
    } else {
        // No scrollable container found, break immediately
        isScrollingFinished = true;
    }
  }

  observer.disconnect();
  return results;
}