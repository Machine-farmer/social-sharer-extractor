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
  const statsEl = document.getElementById('stats');
  const tabsEl = document.getElementById('tabs');
  const exportOptionsEl = document.getElementById('exportOptions');

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
    extractBtn.disabled = true;
    showStatus('Injecting script... DO NOT CLOSE THIS POPUP.', 'info');

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      if (!tab.url) throw new Error("Cannot access this page");

      const isFacebook = tab.url.includes('facebook.com');
      const isX = tab.url.includes('twitter.com') || tab.url.includes('x.com');

      if (!isFacebook && !isX) throw new Error("Please navigate to Facebook or X/Twitter");

      showStatus('Extracting... Auto-scrolling and hovering. This takes time to be accurate.', 'info');

      // Execute the extraction script
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: runExtractionOnPage,
        args: [isFacebook ? 'facebook' : 'x']
      });

      if (!results || !results[0] || !results[0].result) {
        throw new Error("Script returned no data. Ensure the dialog is open.");
      }

      const data = results[0].result;
      
      if (data.length === 0) {
        showStatus('No share data found. Ensure the shares dialog is open.', 'error');
        extractBtn.disabled = false;
        return;
      }

      if (isFacebook) extractedData.facebook = data;
      else extractedData.x = data;
      
      updateStats();
      renderResults('all');
      showStatus(`Success! Found ${data.length} shares.`, 'success');
      
      // Show export controls
      if (statsEl) statsEl.style.display = 'flex';
      if (tabsEl) tabsEl.style.display = 'flex';
      if (exportOptionsEl) exportOptionsEl.style.display = 'flex';
      
    } catch (error) {
      console.error('Extraction error:', error);
      showStatus(`Error: ${error.message}`, 'error');
    }

    extractBtn.disabled = false;
  });

  // Clear button
  clearBtn.addEventListener('click', () => {
    extractedData = { facebook: [], x: [] };
    updateStats();
    renderResults('all');
    if (statsEl) statsEl.style.display = 'none';
    if (tabsEl) tabsEl.style.display = 'none';
    if (exportOptionsEl) exportOptionsEl.style.display = 'none';
    showStatus('', 'info');
  });

  // --- EXPORT HANDLERS ---

  // Export JSON
  document.getElementById('exportJSON').addEventListener('click', () => {
    const all = [...extractedData.facebook, ...extractedData.x];
    downloadFile(JSON.stringify(all, null, 2), 'shares.json', 'application/json');
  });

  // Export CSV (Comma Separated for File)
  document.getElementById('exportCSV').addEventListener('click', () => {
    const all = [...extractedData.facebook, ...extractedData.x];
    const csvContent = formatData(all, true, ","); // Use comma for file
    downloadFile(csvContent, 'shares.csv', 'text/csv');
  });

  // Copy to Clipboard (Tab Separated for Paste)
  document.getElementById('copyAll').addEventListener('click', async () => {
    const all = [...extractedData.facebook, ...extractedData.x];
    const tsvContent = formatData(all, false, "\t"); // Use TAB for clipboard columns
    await navigator.clipboard.writeText(tsvContent);
    showStatus('Data copied! Ready to paste into Excel/Sheets.', 'success');
    setTimeout(() => showStatus('', 'info'), 3000);
  });
});

// Data Formatter (Supports CSV and TSV)
function formatData(data, includeHeader, delimiter) {
  const columns = ['Username', 'Time', 'iso_time', 'profile_link', 'group_link', 'post_link'];
  
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

    return [
      sanitize(row.username),
      sanitize(row.time),
      sanitize(row.isoTime),
      sanitize(row.profileUrl),
      sanitize(row.groupUrl),
      sanitize(row.postUrl)
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

  if (data.length === 0) {
    resultsEl.innerHTML = `<div class="empty-state">No results yet.</div>`;
    return;
  }

  resultsEl.innerHTML = data.map(item => `
    <div class="share-card">
      <div class="name">${escapeHtml(item.username)}</div>
      <div class="time">🕐 ${escapeHtml(item.time)}</div>
      <div class="link">📄 <a href="${item.postUrl}" target="_blank">View Post</a></div>
      ${item.groupUrl ? `<div class="link" style="color:#666">👥 Group: <a href="${item.groupUrl}" target="_blank">Link</a></div>` : ''}
    </div>
  `).join('');
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
    
    for(let i = 0; i < 3; i++) {
        await wait(50); 
        const moveOpts = { ...opts, clientX: x + i };
        element.dispatchEvent(new PointerEvent('pointermove', moveOpts));
        element.dispatchEvent(new MouseEvent('mousemove', moveOpts));
    }
  }

  // 3. Extraction Loop
  let noNewDataCount = 0;
  let safetyCount = 0;
  let isScrollingFinished = false;

  while (!isScrollingFinished && safetyCount < 200) {
    const rows = Array.from(dialog.querySelectorAll('[data-ad-rendering-role="profile_name"]'));
    let newItemsInPass = 0;

    for (const row of rows) {
        // -- DATA FIELDS --
        let username = "Unknown";
        let groupUrl = "";
        let profileUrl = "";

        const headerLinks = Array.from(row.querySelectorAll('a'));
        
        if (headerLinks.length > 0) {
            // First link is User
            const userLink = headerLinks[0];
            username = userLink.textContent.trim();
            profileUrl = userLink.href.split('?')[0];

            // Second link (if exists and different) is Group
            if (headerLinks.length > 1) {
                const potentialGroup = headerLinks[1];
                if (potentialGroup.textContent.trim() !== username) {
                    groupUrl = potentialGroup.href.split('?')[0];
                }
            }
        } else {
            const nameEl = row.querySelector('strong') || row.querySelector('span');
            if (nameEl) username = nameEl.textContent.trim();
        }

        const uniqueId = username + profileUrl;
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
                return isPost && !h.includes(profileUrl);
            });
            
            if (!candidate) {
                candidate = links.find(l => {
                    const aria = l.getAttribute('aria-label');
                    return aria && /\d{4}/.test(aria) && !l.href.includes(profileUrl) && !isGenericGroupLink(l.href);
                });
            }

            if (!candidate) {
                candidate = links.find(l => 
                    l.href && 
                    l.href.length > 25 && 
                    !l.href.includes(profileUrl) && 
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
            while(!foundTooltipText && attempts < 20) {
                await wait(100);
                attempts++;
            }

            let finalTime = foundTooltipText;
            let isoTime = "";
            let postUrl = timestampLink.href.split('?')[0];

            if (finalTime) {
                timestampLink.style.border = "2px solid #0f0";
                try { isoTime = new Date(finalTime).toISOString(); } catch(e){}
            } else {
                timestampLink.style.border = "2px solid orange";
                finalTime = timestampLink.getAttribute('aria-label') || "Hover failed";
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

    // --- SCROLL LOGIC ---
    if (newItemsInPass === 0) noNewDataCount++;
    else noNewDataCount = 0;

    const hasPrivacyText = dialog.innerText.includes("Some posts may not appear here");

    if (scrollableDiv) {
        const previousHeight = scrollableDiv.scrollHeight;
        
        // Scroll to absolute bottom
        scrollableDiv.scrollTop = scrollableDiv.scrollHeight;
        await wait(2000); 

        if (scrollableDiv.scrollHeight > previousHeight) {
            console.log("New content loaded...");
            continue;
        } 
        
        // Double Tap
        await wait(1500);
        scrollableDiv.scrollTop = scrollableDiv.scrollHeight;
        await wait(1500);
        
        if (scrollableDiv.scrollHeight > previousHeight) continue;

        // Final check
        if (hasPrivacyText || (scrollableDiv.scrollHeight <= previousHeight && noNewDataCount > 1)) {
            console.log("End of list reached.");
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

    const headerLinks = Array.from(row.querySelectorAll('a'));
    
    if (headerLinks.length > 0) {
      const userLink = headerLinks[0];
      username = userLink.textContent.trim();
      profileUrl = userLink.href.split('?')[0];

      if (headerLinks.length > 1) {
        const potentialGroup = headerLinks[1];
        if (potentialGroup.textContent.trim() !== username) {
          groupUrl = potentialGroup.href.split('?')[0];
        }
      }
    } else {
      const nameEl = row.querySelector('strong') || row.querySelector('span');
      if (nameEl) username = nameEl.textContent.trim();
    }

    const uniqueId = username + profileUrl;
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
        return isPost && !h.includes(profileUrl);
      });
      
      if (!candidate) {
        candidate = links.find(l => {
          const aria = l.getAttribute('aria-label');
          return aria && /\d{4}/.test(aria) && !l.href.includes(profileUrl) && !isGenericGroupLink(l.href);
        });
      }

      if (!candidate) {
        candidate = links.find(l => 
          l.href && 
          l.href.length > 25 && 
          !l.href.includes(profileUrl) && 
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
      while(!foundTooltipText && attempts < 20) {
        await wait(100);
        attempts++;
      }

      let finalTime = foundTooltipText;
      let isoTime = "";
      let postUrl = timestampLink.href.split('?')[0];

      if (finalTime) {
        timestampLink.style.border = "2px solid #0f0";
        try { isoTime = new Date(finalTime).toISOString(); } catch(e){}
      } else {
        timestampLink.style.border = "2px solid orange";
        finalTime = timestampLink.getAttribute('aria-label') || "Hover failed";
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