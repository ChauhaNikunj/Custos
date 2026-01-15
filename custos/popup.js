// popup.js - CUSTOS

// Slider value mapping (0-4 maps to [off, 1, 3, 5, 10])
const INTERVAL_MAP = [0, 1, 3, 5, 10];

document.addEventListener("DOMContentLoaded", async () => {
  loadSettings();
  loadStats();
  loadBlacklist();
  loadHistory();

  // Auto-refresh stats every 2 seconds
  setInterval(loadStats, 2000);

  // Auto-refresh history every 5 seconds
  setInterval(loadHistory, 5000);
});

// Load current settings
async function loadSettings() {
  const data = await chrome.storage.local.get([
    "autoGroup", 
    "autoEjectOnUrlChange",
    "sweepInterval", 
    "groupingMode"
  ]);
  
  document.getElementById("autoToggle").checked = data.autoGroup !== false;
  document.getElementById("ejectToggle").checked = data.autoEjectOnUrlChange !== false;
  document.getElementById("groupingMode").value = data.groupingMode || "semantic";
  
  const interval = data.sweepInterval || 3;
  const sliderValue = INTERVAL_MAP.indexOf(interval);
  document.getElementById("intervalSlider").value = sliderValue !== -1 ? sliderValue : 2;
  updateIntervalDisplay(interval);
  
  updateStatusMode(data.autoGroup !== false, data.groupingMode || "semantic");
}

// Load tab statistics
async function loadStats() {
  chrome.runtime.sendMessage({ action: "get_stats" }, (stats) => {
    if (stats) {
      document.getElementById("totalTabs").textContent = stats.total || 0;
      document.getElementById("groupedTabs").textContent = stats.grouped || 0;
      document.getElementById("ungroupedTabs").textContent = stats.ungrouped || 0;
    }
  });
}

// Load blacklist
async function loadBlacklist() {
  const { blacklist = [] } = await chrome.storage.local.get("blacklist");
  const container = document.getElementById("blacklistTags");
  container.innerHTML = "";
  
  if (blacklist.length === 0) {
    container.innerHTML = '<li class="empty-msg">No domains ignored</li>';
    return;
  }
  
  blacklist.forEach(domain => {
    const li = document.createElement("li");
    li.className = "tag";
    li.innerHTML = `${domain} <span class="remove">×</span>`;
    li.querySelector(".remove").addEventListener("click", () => removeDomain(domain));
    container.appendChild(li);
  });
}

// Load history
async function loadHistory() {
  const { history = [] } = await chrome.storage.local.get("history");
  const list = document.getElementById("historyList");
  list.innerHTML = "";
  
  if (history.length === 0) {
    list.innerHTML = '<li class="empty-msg">No recent activity</li>';
    return;
  }
  
  history.forEach(entry => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="time">${entry.time}</span> ${entry.msg}`;
    list.appendChild(li);
  });
}

// Update status display
function updateStatusMode(isActive, mode) {
  const statusEl = document.getElementById("statusMode");
  if (!isActive) {
    statusEl.textContent = "Paused";
    statusEl.style.color = "#ff4444";
  } else {
    const modeText = mode === "semantic" ? "AI Mode Active" : "Domain Mode Active";
    statusEl.textContent = modeText;
    statusEl.style.color = "#00ffcc";
  }
}

// Update interval display
function updateIntervalDisplay(minutes) {
  const display = document.getElementById("intervalValue");
  if (minutes === 0) {
    display.textContent = "Off";
    display.style.color = "#ff4444";
  } else {
    display.textContent = `${minutes} min`;
    display.style.color = "#00f2ff";
  }
}

// EVENT LISTENERS

// Auto-grouping toggle
document.getElementById("autoToggle").addEventListener("change", async (e) => {
  const isEnabled = e.target.checked;
  await chrome.storage.local.set({ autoGroup: isEnabled });
  
  const { groupingMode } = await chrome.storage.local.get("groupingMode");
  updateStatusMode(isEnabled, groupingMode || "semantic");
  
  showFeedback(isEnabled ? "Auto-grouping enabled" : "Auto-grouping paused");
});

// Eject toggle
document.getElementById("ejectToggle").addEventListener("change", async (e) => {
  const isEnabled = e.target.checked;
  await chrome.storage.local.set({ autoEjectOnUrlChange: isEnabled });
  showFeedback(isEnabled ? "URL ejection enabled" : "URL ejection disabled");
});

// Grouping mode
document.getElementById("groupingMode").addEventListener("change", async (e) => {
  const mode = e.target.value;
  await chrome.storage.local.set({ groupingMode: mode });
  
  const { autoGroup } = await chrome.storage.local.get("autoGroup");
  updateStatusMode(autoGroup !== false, mode);
  
  showFeedback(mode === "semantic" ? "Switched to AI mode" : "Switched to domain mode");
});

// Interval slider
document.getElementById("intervalSlider").addEventListener("input", async (e) => {
  const sliderValue = parseInt(e.target.value);
  const minutes = INTERVAL_MAP[sliderValue];
  
  updateIntervalDisplay(minutes);
  await chrome.storage.local.set({ sweepInterval: minutes });
  
  chrome.runtime.sendMessage({ 
    action: "update_interval", 
    minutes: minutes 
  });
  
  showFeedback(minutes === 0 ? "Auto-sweep disabled" : `Interval set to ${minutes} min`);
});

// Manual sweep
document.getElementById("groupNowBtn").addEventListener("click", async () => {
  const btn = document.getElementById("groupNowBtn");
  btn.classList.add("processing");
  btn.textContent = "Processing...";
  
  chrome.runtime.sendMessage({ action: "manual_sweep" }, () => {
    btn.classList.remove("processing");
    btn.innerHTML = '<span class="btn-icon">⚡</span> Manual Sweep';
    showFeedback("Sweep complete!");
    setTimeout(loadStats, 500);
    setTimeout(loadHistory, 500);
  });
});

// Collapse all groups
document.getElementById("collapseBtn").addEventListener("click", async () => {
  const groups = await chrome.tabGroups.query({ windowId: chrome.windows.WINDOW_ID_CURRENT });
  groups.forEach(group => {
    chrome.tabGroups.update(group.id, { collapsed: true });
  });
  showFeedback("All groups collapsed");
});

// Undo
document.getElementById("undoBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "undo_last" }, (result) => {
    if (result && result.success) {
      showFeedback(result.message);
      setTimeout(loadStats, 500);
      setTimeout(loadHistory, 500);
    } else {
      showFeedback(result?.message || "Nothing to undo");
    }
  });
});

// Find duplicates
document.getElementById("findDuplicatesBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "find_duplicates" }, (result) => {
    if (result && result.duplicates) {
      displayDuplicates(result.duplicates, result.totalDuplicates);
    }
  });
});

// Close duplicates
document.getElementById("closeDuplicatesBtn").addEventListener("click", () => {
  if (confirm("Close all duplicate tabs? (Keeps one copy of each)")) {
    chrome.runtime.sendMessage({ action: "close_duplicates" }, () => {
      showFeedback("Duplicates closed");
      document.getElementById("closeDuplicatesBtn").style.display = "none";
      document.getElementById("duplicateList").innerHTML = "";
      document.getElementById("duplicateCount").textContent = "0";
      setTimeout(loadStats, 500);
    });
  }
});

// Add to blacklist
document.getElementById("addBlacklistBtn").addEventListener("click", async () => {
  const input = document.getElementById("blacklistInput");
  const domain = input.value.trim().toLowerCase();
  
  if (!domain) return;
  
  const { blacklist = [] } = await chrome.storage.local.get("blacklist");
  
  if (blacklist.includes(domain)) {
    showFeedback("Already in ignore list");
    return;
  }
  
  blacklist.push(domain);
  await chrome.storage.local.set({ blacklist });
  chrome.runtime.sendMessage({ action: "blacklist_updated" });
  
  input.value = "";
  loadBlacklist();
  showFeedback(`Added ${domain} to ignore list`);
});

// Remove from blacklist
async function removeDomain(domain) {
  const { blacklist = [] } = await chrome.storage.local.get("blacklist");
  const updated = blacklist.filter(d => d !== domain);
  await chrome.storage.local.set({ blacklist: updated });
  chrome.runtime.sendMessage({ action: "blacklist_updated" });
  loadBlacklist();
  showFeedback(`Removed ${domain}`);
}

// Display duplicates
function displayDuplicates(duplicates, totalCount) {
  const list = document.getElementById("duplicateList");
  const badge = document.getElementById("duplicateCount");
  const closeBtn = document.getElementById("closeDuplicatesBtn");
  
  badge.textContent = totalCount;
  list.innerHTML = "";
  
  if (duplicates.length === 0) {
    list.innerHTML = '<div class="empty-msg">No duplicates found</div>';
    closeBtn.style.display = "none";
    return;
  }
  
  closeBtn.style.display = "block";
  
  duplicates.forEach(dup => {
    const div = document.createElement("div");
    div.className = "duplicate-item";
    div.innerHTML = `
      <span class="dup-count">×${dup.count}</span>
      <span class="dup-title">${dup.title || dup.url}</span>
    `;
    list.appendChild(div);
  });
}

// Feedback message
function showFeedback(message) {
  const footer = document.getElementById("feedback");
  footer.textContent = message;
  footer.style.color = "#00ffcc";
  
  setTimeout(() => {
    footer.textContent = "Ready to organize your chaos.";
    footer.style.color = "#666";
  }, 3000);
}