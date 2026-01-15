// background.js - CUSTOS with URL Change Ejection (Fixed)

const STOP_WORDS = new Set([
  'home', 'page', 'login', 'search', 'google', 'index', 'dashboard', 
  'welcome', 'portal', 'navigation', 'html', 'php', 'youtube', 'video', 
  'watch', 'https', 'http', 'www', 'com', 'org', 'net', 'query', 'results', 
  'view', 'brave', 'bing', 'yahoo', 'duckduckgo', 'tab', 'browser'
]);

const MAX_CONCURRENT_SCANS = 5;
const SCAN_TIMEOUT = 1500;
const SIMILARITY_THRESHOLD = 0.25;

// INITIALIZATION
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ 
    autoGroup: true,
    autoEjectOnUrlChange: true,
    history: [],
    blacklist: [],
    userGroupedTabs: [],
    sweepInterval: 3,
    groupingMode: 'semantic',
    minGroupSize: 2,
    lastAction: null
  });
  logHistory("Custos initialized and ready");
  console.log("✓ Custos Sentinel Initialized");
  updateAlarm(3);
});

// TAB URL CHANGE MONITOR
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url && tab.groupId !== -1) {
    try {
      const settings = await chrome.storage.local.get(['autoEjectOnUrlChange', 'userGroupedTabs']);
      const userGroupedTabs = new Set(settings.userGroupedTabs || []);
      
      if (settings.autoEjectOnUrlChange === false) return;
      if (userGroupedTabs.has(tabId)) return;
      
      await chrome.tabs.ungroup([tabId]);
      console.log(`🚀 Ejected tab "${tab.title}" due to URL change`);
      logHistory(`Ejected: ${tab.title?.slice(0, 30)}...`);
    } catch (e) {
      console.error("Failed to eject tab:", e);
    }
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "custosTidy") {
    tidyTabs();
  }
});

// MESSAGE HANDLING
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "manual_sweep") {
    tidyTabs().then(() => {
      sendResponse({ status: "Complete" });
    }).catch(err => {
      sendResponse({ status: "Error", error: err.message });
    });
    return true;
  }
  
  if (msg.action === "blacklist_updated") {
    logHistory("Blacklist updated");
    sendResponse({ status: "OK" });
    return false;
  }
  
  if (msg.action === "update_interval") {
    updateAlarm(msg.minutes);
    sendResponse({ status: "Alarm updated" });
    return false;
  }
  
  if (msg.action === "find_duplicates") {
    findDuplicates().then(result => {
      sendResponse(result);
    }).catch(err => {
      sendResponse({ duplicates: [], totalDuplicates: 0, error: err.message });
    });
    return true;
  }
  
  if (msg.action === "close_duplicates") {
    closeDuplicates().then(() => {
      sendResponse({ status: "Duplicates closed" });
    }).catch(err => {
      sendResponse({ status: "Error", error: err.message });
    });
    return true;
  }
  
  if (msg.action === "undo_last") {
    undoLastAction().then(result => {
      sendResponse(result);
    }).catch(err => {
      sendResponse({ success: false, message: err.message });
    });
    return true;
  }
  
  if (msg.action === "get_stats") {
    getTabStats().then(stats => {
      sendResponse(stats);
    }).catch(err => {
      sendResponse(null);
    });
    return true;
  }
});

// HISTORY LOGGING
async function logHistory(message) {
  try {
    const { history = [] } = await chrome.storage.local.get("history");
    const timestamp = new Date().toLocaleTimeString('en-US', { 
      hour: '2-digit', 
      minute: '2-digit' 
    });
    
    const newEntry = { time: timestamp, msg: message };
    const updated = [newEntry, ...history].slice(0, 10);
    
    await chrome.storage.local.set({ history: updated });
  } catch (e) {
    console.error("History logging failed:", e);
  }
}

// DEEP SCANNER
async function getTabVector(tab) {
  let bodyText = "";
  
  if (tab.url?.startsWith('http') && tab.status === 'complete') {
    try {
      const timeout = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Timeout')), SCAN_TIMEOUT)
      );
      
      const injection = chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const tempBody = document.body.cloneNode(true);
          const noise = tempBody.querySelectorAll('nav, footer, script, style, noscript, header, aside');
          noise.forEach(el => el.remove());
          return tempBody.innerText.toLowerCase().slice(0, 8000);
        }
      });

      const [{ result }] = await Promise.race([injection, timeout]);
      bodyText = result || "";
    } catch (e) {
      // Silently fail for individual tabs
    }
  }

  const titleWords = (tab.title || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/);
  const pageWords = bodyText.replace(/[^a-z0-9\s]/g, " ").split(/\s+/);
  
  let domainName = "";
  try { 
    domainName = new URL(tab.url).hostname.replace('www.', '').split('.')[0]; 
  } catch(e) {}
  
  const urlPath = (tab.url || "").toLowerCase().split(/[\/\-\._\?&=]/);
  
  const vector = {};
  const processWords = (wordList, weight) => {
    wordList.forEach(word => {
      if (word.length > 3 && !STOP_WORDS.has(word) && isNaN(word) && word !== domainName) {
        vector[word] = (vector[word] || 0) + weight;
      }
    });
  };

  processWords(titleWords, 5.0);
  processWords(urlPath, 1.5);
  processWords(pageWords, 0.5);

  return vector;
}

// SIMILARITY CALCULATION
function calculateSimilarity(v1, v2) {
  const allWords = new Set([...Object.keys(v1), ...Object.keys(v2)]);
  
  let dotProduct = 0;
  let magnitude1 = 0;
  let magnitude2 = 0;
  
  for (let word of allWords) {
    const val1 = v1[word] || 0;
    const val2 = v2[word] || 0;
    
    dotProduct += val1 * val2;
    magnitude1 += val1 * val1;
    magnitude2 += val2 * val2;
  }
  
  const denominator = Math.sqrt(magnitude1) * Math.sqrt(magnitude2);
  if (denominator === 0) return 0;
  
  return dotProduct / denominator;
}

// CONCURRENCY LIMITER
async function processBatch(tabs, batchSize = MAX_CONCURRENT_SCANS) {
  const results = [];
  for (let i = 0; i < tabs.length; i += batchSize) {
    const batch = tabs.slice(i, i + batchSize);
    const batchPromises = batch.map(async (tab) => {
      const vector = await getTabVector(tab);
      return { tab, vector };
    });
    const batchResults = await Promise.allSettled(batchPromises);
    results.push(...batchResults);
  }
  return results;
}

// MAIN GROUPING ENGINE
async function tidyTabs() {
  console.log("🔍 Custos: Starting intelligent sweep...");
  
  try {
    const settings = await chrome.storage.local.get([
      "autoGroup", "blacklist", "userGroupedTabs", "groupingMode", "minGroupSize"
    ]);
    
    if (settings.autoGroup === false) {
      console.log("⏸ Auto-grouping paused");
      return;
    }

    if (settings.groupingMode === 'domain') {
      await groupByDomain();
      return;
    }

    const blacklist = settings.blacklist || [];
    const userGroupedTabs = new Set(settings.userGroupedTabs || []);
    const minGroupSize = settings.minGroupSize || 2;
    const allTabs = await chrome.tabs.query({ currentWindow: true, pinned: false });
    
    const processableTabs = allTabs.filter(t => {
      if (!t.url?.startsWith('http')) return false;
      if (userGroupedTabs.has(t.id)) return false;
      
      try {
        const domain = new URL(t.url).hostname;
        return !blacklist.some(blocked => domain.includes(blocked));
      } catch(e) {
        return false;
      }
    });

    const ungroupedTabs = processableTabs.filter(t => t.groupId === -1);
    const autoGroupedTabs = processableTabs.filter(t => t.groupId !== -1);

    if (ungroupedTabs.length === 0) {
      console.log("ℹ No ungrouped tabs to process");
      return;
    }

    logHistory(`Analyzing ${ungroupedTabs.length} ungrouped tabs...`);

    // FIX: Properly query groups and handle as array
    const allWindows = await chrome.windows.getAll();
    const currentWindow = allWindows.find(w => w.focused) || allWindows[0];
    const existingGroups = await chrome.tabGroups.query({ windowId: currentWindow.id });
    const groupVectors = new Map();

    // Build vectors for existing groups
    if (Array.isArray(existingGroups)) {
      for (const group of existingGroups) {
        const groupTabs = autoGroupedTabs.filter(t => t.groupId === group.id);
        if (groupTabs.length > 0) {
          const tabVectorPromises = groupTabs.map(tab => getTabVector(tab));
          const vectors = await Promise.all(tabVectorPromises);
          
          const mergedVector = {};
          vectors.forEach(vec => {
            Object.keys(vec).forEach(word => {
              mergedVector[word] = (mergedVector[word] || 0) + vec[word];
            });
          });
          
          groupVectors.set(group.id, { vector: mergedVector, title: group.title, tabs: groupTabs });
        }
      }
    }

    // BATCHED PARALLEL PROCESSING
    const results = await processBatch(ungroupedTabs);
    const tabData = results
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value);

    console.log(`✓ Scanned ${tabData.length}/${ungroupedTabs.length} tabs successfully`);

    let processedIds = new Set();
    let groupsCreated = 0;
    let tabsAddedToExisting = 0;

    // STEP 1: Add ungrouped tabs to existing groups
    for (const entry of tabData) {
      if (processedIds.has(entry.tab.id)) continue;

      let bestMatch = null;
      let bestScore = 0;

      for (const [groupId, groupData] of groupVectors) {
        const score = calculateSimilarity(entry.vector, groupData.vector);
        if (score > SIMILARITY_THRESHOLD && score > bestScore) {
          bestScore = score;
          bestMatch = groupId;
        }
      }

      if (bestMatch !== null) {
        try {
          await chrome.tabs.group({ tabIds: [entry.tab.id], groupId: bestMatch });
          processedIds.add(entry.tab.id);
          tabsAddedToExisting++;
          
          await chrome.storage.local.set({
            lastAction: {
              type: "tab_added",
              tabId: entry.tab.id,
              groupId: bestMatch,
              timestamp: Date.now()
            }
          });
          
          console.log(`✓ Added "${entry.tab.title}" to existing group (similarity: ${bestScore.toFixed(2)})`);
        } catch (e) {
          console.error(`Failed to add tab to group:`, e);
        }
      }
    }

    // STEP 2: CLUSTERING
    const remainingTabData = tabData.filter(entry => !processedIds.has(entry.tab.id));

    for (let i = 0; i < remainingTabData.length; i++) {
      const entryA = remainingTabData[i];
      if (processedIds.has(entryA.tab.id)) continue;

      let cluster = [entryA.tab.id];
      let sharedVectorPool = { ...entryA.vector };

      for (let j = i + 1; j < remainingTabData.length; j++) {
        const entryB = remainingTabData[j];
        if (processedIds.has(entryB.tab.id)) continue;

        const score = calculateSimilarity(entryA.vector, entryB.vector);
        
        if (score > SIMILARITY_THRESHOLD) {
          cluster.push(entryB.tab.id);
          
          Object.keys(sharedVectorPool).forEach(word => {
            if (!entryB.vector[word]) delete sharedVectorPool[word];
          });
        }
      }

      if (cluster.length >= minGroupSize) {
        const bestLabel = Object.keys(sharedVectorPool)
          .filter(word => !STOP_WORDS.has(word))
          .sort((a, b) => (sharedVectorPool[b] * b.length) - (sharedVectorPool[a] * a.length))[0];
        
        const label = (bestLabel && bestLabel.length > 2) 
          ? bestLabel.charAt(0).toUpperCase() + bestLabel.slice(1)
          : "Research";

        try {
          const newGroupId = await chrome.tabs.group({ tabIds: cluster });
          await chrome.tabGroups.update(newGroupId, { 
            title: label, 
            color: getRandomColor() 
          });
          
          cluster.forEach(id => processedIds.add(id));
          groupsCreated++;
          
          await chrome.storage.local.set({
            lastAction: {
              type: "group_created",
              tabIds: cluster,
              groupName: label,
              groupId: newGroupId,
              timestamp: Date.now()
            }
          });
          
          console.log(`✓ Created group: ${label} (${cluster.length} tabs)`);
        } catch (e) {
          console.error(`Failed to create group ${label}:`, e);
        }
      }
    }

    if (tabsAddedToExisting > 0) {
      logHistory(`Added ${tabsAddedToExisting} tab${tabsAddedToExisting > 1 ? 's' : ''} to existing groups`);
    }
    if (groupsCreated > 0) {
      logHistory(`Created ${groupsCreated} new group${groupsCreated > 1 ? 's' : ''}`);
    }
    if (tabsAddedToExisting === 0 && groupsCreated === 0) {
      logHistory("No similar tabs found");
    }

  } catch (e) {
    console.error("❌ Custos Error:", e);
    logHistory("Error during sweep");
  }
}

function getRandomColor() {
  const colors = ["blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
  return colors[Math.floor(Math.random() * colors.length)];
}

// ALARM MANAGEMENT
function updateAlarm(minutes) {
  chrome.alarms.clear("custosTidy", () => {
    if (minutes > 0) {
      chrome.alarms.create("custosTidy", { periodInMinutes: minutes });
      console.log(`⏰ Alarm set to ${minutes} minutes`);
    } else {
      console.log("⏰ Auto-sweep disabled");
    }
  });
}

// DUPLICATE TAB DETECTION
async function findDuplicates() {
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const urlMap = new Map();
    const duplicates = [];
    
    tabs.forEach(tab => {
      if (!tab.url) return;
      
      if (urlMap.has(tab.url)) {
        urlMap.get(tab.url).push(tab);
      } else {
        urlMap.set(tab.url, [tab]);
      }
    });
    
    urlMap.forEach((tabList, url) => {
      if (tabList.length > 1) {
        duplicates.push({
          url: url,
          count: tabList.length,
          tabs: tabList,
          title: tabList[0].title
        });
      }
    });
    
    return { 
      duplicates: duplicates,
      totalDuplicates: duplicates.reduce((sum, d) => sum + d.count - 1, 0)
    };
  } catch (e) {
    console.error("Duplicate detection failed:", e);
    return { duplicates: [], totalDuplicates: 0 };
  }
}

async function closeDuplicates() {
  try {
    const { duplicates } = await findDuplicates();
    let closedCount = 0;
    
    for (const dup of duplicates) {
      const toClose = dup.tabs.slice(1).map(t => t.id);
      if (toClose.length > 0) {
        await chrome.tabs.remove(toClose);
        closedCount += toClose.length;
      }
    }
    
    logHistory(`Closed ${closedCount} duplicate tab${closedCount > 1 ? 's' : ''}`);
    return { closedCount };
  } catch (e) {
    console.error("Failed to close duplicates:", e);
    return { closedCount: 0 };
  }
}

// UNDO FUNCTIONALITY - FIX: Check if tabs still exist
async function undoLastAction() {
  try {
    const { lastAction } = await chrome.storage.local.get("lastAction");
    
    if (!lastAction) {
      return { success: false, message: "No action to undo" };
    }
    
    if (lastAction.type === "group_created") {
      // Check if tabs still exist
      const existingTabs = await chrome.tabs.query({ currentWindow: true });
      const existingTabIds = new Set(existingTabs.map(t => t.id));
      const validTabIds = lastAction.tabIds.filter(id => existingTabIds.has(id));
      
      if (validTabIds.length === 0) {
        await chrome.storage.local.set({ lastAction: null });
        return { success: false, message: "Tabs no longer exist" };
      }
      
      await chrome.tabs.ungroup(validTabIds);
      await chrome.storage.local.set({ lastAction: null });
      logHistory(`Undid: ${lastAction.groupName}`);
      return { success: true, message: `Ungrouped ${lastAction.groupName}` };
    }
    
    if (lastAction.type === "tab_added") {
      // Check if tab still exists
      try {
        const tab = await chrome.tabs.get(lastAction.tabId);
        await chrome.tabs.ungroup([lastAction.tabId]);
        await chrome.storage.local.set({ lastAction: null });
        logHistory("Undid: Tab addition");
        return { success: true, message: "Tab removed from group" };
      } catch (e) {
        await chrome.storage.local.set({ lastAction: null });
        return { success: false, message: "Tab no longer exists" };
      }
    }
    
    return { success: false, message: "Cannot undo this action" };
  } catch (e) {
    console.error("Undo failed:", e);
    await chrome.storage.local.set({ lastAction: null });
    return { success: false, message: "Undo failed: " + e.message };
  }
}

// TAB STATISTICS - FIX: Handle query result properly
async function getTabStats() {
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const allWindows = await chrome.windows.getAll();
    const currentWindow = allWindows.find(w => w.focused) || allWindows[0];
    const groups = await chrome.tabGroups.query({ windowId: currentWindow.id });
    
    const grouped = tabs.filter(t => t.groupId !== -1);
    const ungrouped = tabs.filter(t => t.groupId === -1 && !t.pinned);
    const pinned = tabs.filter(t => t.pinned);
    
    const domainMap = new Map();
    tabs.forEach(tab => {
      try {
        const domain = new URL(tab.url).hostname.replace('www.', '');
        domainMap.set(domain, (domainMap.get(domain) || 0) + 1);
      } catch(e) {}
    });
    
    const topDomains = Array.from(domainMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([domain, count]) => ({ domain, count }));
    
    return {
      total: tabs.length,
      grouped: grouped.length,
      ungrouped: ungrouped.length,
      pinned: pinned.length,
      groupCount: Array.isArray(groups) ? groups.length : 0,
      topDomains: topDomains
    };
  } catch (e) {
    console.error("Stats failed:", e);
    return null;
  }
}

// DOMAIN-BASED GROUPING
async function groupByDomain() {
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true, pinned: false });
    const ungrouped = tabs.filter(t => t.groupId === -1 && t.url?.startsWith('http'));
    
    const domainMap = new Map();
    
    ungrouped.forEach(tab => {
      try {
        const domain = new URL(tab.url).hostname.replace('www.', '').split('.')[0];
        if (!domainMap.has(domain)) {
          domainMap.set(domain, []);
        }
        domainMap.get(domain).push(tab.id);
      } catch(e) {}
    });
    
    let groupsCreated = 0;
    
    for (const [domain, tabIds] of domainMap) {
      if (tabIds.length >= 2) {
        const groupId = await chrome.tabs.group({ tabIds });
        await chrome.tabGroups.update(groupId, {
          title: domain.charAt(0).toUpperCase() + domain.slice(1),
          color: getRandomColor()
        });
        groupsCreated++;
      }
    }
    
    logHistory(`Domain mode: Created ${groupsCreated} groups`);
    return groupsCreated;
  } catch (e) {
    console.error("Domain grouping failed:", e);
    return 0;
  }
}