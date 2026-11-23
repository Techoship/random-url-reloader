// Session management with persistence for MV3 service worker reliability
const STORAGE_KEY = 'reloader_sessions';
let tabSessions = {};
let initDone = false;

const initPromise = init();

async function init() {
  await restoreSessions();
  await cleanupOrphanedStorage();
  initDone = true;
}

async function ensureInit() {
  if (!initDone) await initPromise;
}

// Restore sessions after service worker restart
async function restoreSessions() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const saved = data[STORAGE_KEY] || {};

  for (const [tabIdStr, session] of Object.entries(saved)) {
    const tabId = parseInt(tabIdStr);

    try {
      await chrome.tabs.get(tabId);
    } catch {
      continue; // Tab no longer exists
    }

    tabSessions[tabId] = { ...session, timeoutId: null };

    if (session.nextReloadTime) {
      const remaining = session.nextReloadTime - Date.now();
      if (remaining <= 0) {
        performReload(tabId);
      } else {
        setupTimers(tabId, remaining);
      }
    }
  }
}

// Remove orphaned tab_*_settings keys from storage
async function cleanupOrphanedStorage() {
  const allData = await chrome.storage.local.get(null);
  const keysToRemove = [];

  for (const key of Object.keys(allData)) {
    if (key.startsWith('tab_') && key.endsWith('_settings')) {
      const tabId = parseInt(key.slice(4, -9));
      try {
        await chrome.tabs.get(tabId);
      } catch {
        keysToRemove.push(key);
      }
    }
  }

  if (keysToRemove.length > 0) {
    await chrome.storage.local.remove(keysToRemove);
  }
}

// Persist sessions to storage (strips non-serializable timeoutId)
async function persistSessions() {
  const toSave = {};
  for (const [tabId, session] of Object.entries(tabSessions)) {
    const { timeoutId, ...rest } = session;
    toSave[tabId] = rest;
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: toSave });
}

// --- Message handling ---

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  handleMessage(request, sender).then(sendResponse);
  return true; // Keep channel open for async response
});

async function handleMessage(request, sender) {
  await ensureInit();

  switch (request.action) {
    case 'start': {
      const tabId = request.tabId;

      // Stop any existing session for this tab
      if (tabSessions[tabId]) {
        stopSession(tabId);
      }

      tabSessions[tabId] = {
        urls: request.urls,
        minInterval: request.minInterval * 1000,
        maxInterval: request.maxInterval * 1000,
        fixedIntervalValue: request.fixedIntervalValue * 1000,
        intervalType: request.intervalType,
        hardRefresh: request.hardRefresh,
        pauseOnClick: request.pauseOnClick,
        urlSelection: request.urlSelection,
        limitReloads: request.limitReloads,
        maxReloads: request.maxReloads,
        reloadCount: 0,
        currentUrlIndex: 0,
        nextReloadTime: null,
        timeoutId: null
      };

      scheduleNextReload(tabId);
      notifyTab(tabId);
      return { success: true };
    }

    case 'stop':
      stopSession(request.tabId);
      notifyTab(request.tabId);
      return { success: true };

    case 'getCountdown': {
      const session = tabSessions[request.tabId];
      if (session && session.nextReloadTime) {
        return {
          countdown: Math.max(0, session.nextReloadTime - Date.now()),
          reloadCount: session.reloadCount,
          maxReloads: session.maxReloads,
          limitReloads: session.limitReloads,
          isRunning: true,
          pauseOnClick: session.pauseOnClick
        };
      }
      return { countdown: null, isRunning: false };
    }

    case 'pageClicked': {
      const session = tabSessions[request.tabId];
      if (session && session.pauseOnClick) {
        stopSession(request.tabId);
        notifyTab(request.tabId);
      }
      return {};
    }

    case 'getSessionStatus': {
      const session = tabSessions[request.tabId];
      return {
        isRunning: !!session && !!session.nextReloadTime,
        session: session || null
      };
    }

    case 'getCurrentTabInfo':
      return { tabId: sender.tab ? sender.tab.id : null };

    default:
      return {};
  }
}

// --- Scheduling ---

function getNextInterval(session) {
  if (session.intervalType === 'fixed') {
    return session.fixedIntervalValue;
  }
  return Math.floor(Math.random() * (session.maxInterval - session.minInterval + 1)) + session.minInterval;
}

function scheduleNextReload(tabId) {
  const session = tabSessions[tabId];
  if (!session) return;

  const interval = getNextInterval(session);
  session.nextReloadTime = Date.now() + interval;

  setupTimers(tabId, interval);
  persistSessions();
}

function setupTimers(tabId, delay) {
  const session = tabSessions[tabId];
  if (!session) return;

  if (session.timeoutId) {
    clearTimeout(session.timeoutId);
  }

  const actualDelay = Math.max(0, delay);

  // Primary: setTimeout for precise timing while SW is alive
  session.timeoutId = setTimeout(() => {
    chrome.alarms.clear(`reload-${tabId}`);
    performReload(tabId);
  }, actualDelay);

  // Backup: chrome.alarms survives service worker suspension
  chrome.alarms.create(`reload-${tabId}`, {
    when: Date.now() + actualDelay
  });
}

// --- Reload execution ---

async function performReload(tabId) {
  const session = tabSessions[tabId];
  if (!session || !session.nextReloadTime) return;

  // Guard against double-fire (setTimeout + alarm race)
  session.nextReloadTime = null;

  if (session.urls.length === 0) return;

  // Check reload limit
  if (session.limitReloads && session.reloadCount >= session.maxReloads) {
    const { reloadCount, maxReloads } = session;
    stopSession(tabId);
    chrome.tabs.sendMessage(tabId, {
      action: 'reloadCompleted',
      reloadCount,
      maxReloads
    }).catch(() => {});
    return;
  }

  // Pick next URL
  let targetUrl;
  if (session.urlSelection === 'sequential') {
    targetUrl = session.urls[session.currentUrlIndex];
    session.currentUrlIndex = (session.currentUrlIndex + 1) % session.urls.length;
  } else {
    targetUrl = session.urls[Math.floor(Math.random() * session.urls.length)];
  }

  try {
    const tab = await chrome.tabs.get(tabId);

    if (tab.url === targetUrl) {
      await chrome.tabs.reload(tabId, { bypassCache: !!session.hardRefresh });
    } else {
      await chrome.tabs.update(tabId, { url: targetUrl });
    }

    // Increment only after successful reload
    session.reloadCount++;
    scheduleNextReload(tabId);
    notifyTab(tabId);
  } catch {
    // Tab no longer exists
    stopSession(tabId);
  }
}

// --- Session cleanup ---

function stopSession(tabId) {
  const session = tabSessions[tabId];

  if (session && session.timeoutId) {
    clearTimeout(session.timeoutId);
  }

  delete tabSessions[tabId];
  chrome.alarms.clear(`reload-${tabId}`);
  chrome.storage.local.remove(`tab_${tabId}_settings`);
  persistSessions();
}

function notifyTab(tabId) {
  const session = tabSessions[tabId];

  chrome.tabs.sendMessage(tabId, {
    action: 'updateCountdown',
    nextReloadTime: session ? session.nextReloadTime : null,
    pauseOnClick: session ? session.pauseOnClick : false,
    reloadCount: session ? session.reloadCount : 0,
    maxReloads: session ? session.maxReloads : 0,
    limitReloads: session ? session.limitReloads : false
  }).catch(() => {});
}

// --- Alarm handler (backup for service worker restart) ---

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith('reload-')) return;

  await ensureInit();

  const tabId = parseInt(alarm.name.slice(7));
  const session = tabSessions[tabId];

  if (!session || !session.nextReloadTime) return;

  // Cancel the setTimeout since alarm fired first (or SW restarted)
  if (session.timeoutId) {
    clearTimeout(session.timeoutId);
    session.timeoutId = null;
  }

  performReload(tabId);
});

// --- Tab lifecycle ---

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ensureInit();

  if (tabSessions[tabId]) {
    stopSession(tabId);
  }
  chrome.storage.local.remove(`tab_${tabId}_settings`);
});

chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
  await ensureInit();

  if (tabSessions[removedTabId]) {
    const session = tabSessions[removedTabId];

    if (session.timeoutId) {
      clearTimeout(session.timeoutId);
      session.timeoutId = null;
    }

    chrome.alarms.clear(`reload-${removedTabId}`);
    delete tabSessions[removedTabId];

    tabSessions[addedTabId] = session;

    if (session.nextReloadTime) {
      const remaining = Math.max(0, session.nextReloadTime - Date.now());
      setupTimers(addedTabId, remaining);
    }

    persistSessions();
  }
});
