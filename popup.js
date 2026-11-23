document.addEventListener('DOMContentLoaded', function () {
  const randomIntervalRadio = document.getElementById('randomInterval');
  const fixedIntervalRadio = document.getElementById('fixedInterval');
  const randomOptions = document.getElementById('randomOptions');
  const fixedOptions = document.getElementById('fixedOptions');
  const countdownCard = document.getElementById('countdownCard');
  const countdownTime = document.getElementById('countdownTime');
  const reloadCounter = document.getElementById('reloadCounter');
  const statusCard = document.getElementById('statusCard');
  const statusText = document.getElementById('statusText');
  const limitReloadsCheckbox = document.getElementById('limitReloads');
  const limitGroup = document.getElementById('limitGroup');

  let countdownInterval = null;
  let currentTabId = null;
  let saveTimeout = null;

  // Auto-save all form fields so they survive popup close/reopen
  function autoSaveSettings() {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(function () {
      if (!currentTabId) return;
      var storageKey = 'tab_' + currentTabId + '_settings';
      var settings = {
        urls: document.getElementById('urls').value,
        minInterval: parseInt(document.getElementById('minInterval').value) || 30,
        maxInterval: parseInt(document.getElementById('maxInterval').value) || 60,
        fixedIntervalValue: parseInt(document.getElementById('fixedIntervalValue').value) || 45,
        intervalType: randomIntervalRadio.checked ? 'random' : 'fixed',
        hardRefresh: document.getElementById('hardRefresh').checked,
        pauseOnClick: document.getElementById('pauseOnClick').checked,
        urlSelection: document.getElementById('sequentialSelection').checked ? 'sequential' : 'random',
        limitReloads: limitReloadsCheckbox.checked,
        maxReloads: parseInt(document.getElementById('maxReloads').value) || 10
      };
      chrome.storage.local.set({ [storageKey]: settings });
    }, 300);
  }

  function isValidUrl(string) {
    try {
      const url = new URL(string);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  // Get current tab ID
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (tabs[0]) {
      currentTabId = tabs[0].id;
      loadSettingsForTab(currentTabId);
      checkSessionStatus(currentTabId);
    }
  });

  function loadSettingsForTab(tabId) {
    const storageKey = 'tab_' + tabId + '_settings';

    chrome.storage.local.get([storageKey], function (result) {
      const settings = result[storageKey] || {};

      if (settings.urls != null) {
        document.getElementById('urls').value = settings.urls;
      }
      if (settings.minInterval != null) {
        document.getElementById('minInterval').value = settings.minInterval;
      }
      if (settings.maxInterval != null) {
        document.getElementById('maxInterval').value = settings.maxInterval;
      }
      if (settings.fixedIntervalValue != null) {
        document.getElementById('fixedIntervalValue').value = settings.fixedIntervalValue;
      }
      if (settings.intervalType === 'fixed') {
        fixedIntervalRadio.checked = true;
        toggleIntervalOptions();
      }
      if (settings.hardRefresh) {
        document.getElementById('hardRefresh').checked = settings.hardRefresh;
      }
      if (settings.pauseOnClick) {
        document.getElementById('pauseOnClick').checked = settings.pauseOnClick;
      }
      if (settings.urlSelection === 'sequential') {
        document.getElementById('sequentialSelection').checked = true;
      }
      if (settings.limitReloads) {
        limitReloadsCheckbox.checked = settings.limitReloads;
        toggleLimitGroup();
      }
      if (settings.maxReloads != null) {
        document.getElementById('maxReloads').value = settings.maxReloads;
      }
    });
  }

  function checkSessionStatus(tabId) {
    chrome.runtime.sendMessage({
      action: 'getSessionStatus',
      tabId: tabId
    }, function (response) {
      if (chrome.runtime.lastError) return;

      if (response && response.isRunning) {
        updateStatus(true);
        startCountdownUpdates();
      } else {
        updateStatus(false);
      }
    });
  }

  function toggleIntervalOptions() {
    if (randomIntervalRadio.checked) {
      randomOptions.classList.remove('disabled');
      fixedOptions.classList.add('disabled');
    } else {
      randomOptions.classList.add('disabled');
      fixedOptions.classList.remove('disabled');
    }
  }

  function toggleLimitGroup() {
    if (limitReloadsCheckbox.checked) {
      limitGroup.classList.remove('disabled');
    } else {
      limitGroup.classList.add('disabled');
    }
  }

  randomIntervalRadio.addEventListener('change', toggleIntervalOptions);
  fixedIntervalRadio.addEventListener('change', toggleIntervalOptions);
  limitReloadsCheckbox.addEventListener('change', toggleLimitGroup);

  // Auto-save on any form change
  document.getElementById('urls').addEventListener('input', autoSaveSettings);
  document.getElementById('minInterval').addEventListener('input', autoSaveSettings);
  document.getElementById('maxInterval').addEventListener('input', autoSaveSettings);
  document.getElementById('fixedIntervalValue').addEventListener('input', autoSaveSettings);
  document.getElementById('maxReloads').addEventListener('input', autoSaveSettings);
  randomIntervalRadio.addEventListener('change', autoSaveSettings);
  fixedIntervalRadio.addEventListener('change', autoSaveSettings);
  document.getElementById('hardRefresh').addEventListener('change', autoSaveSettings);
  document.getElementById('pauseOnClick').addEventListener('change', autoSaveSettings);
  document.getElementById('randomSelection').addEventListener('change', autoSaveSettings);
  document.getElementById('sequentialSelection').addEventListener('change', autoSaveSettings);
  limitReloadsCheckbox.addEventListener('change', autoSaveSettings);

  // Start button
  document.getElementById('start').addEventListener('click', function () {
    if (!currentTabId) {
      alert('Could not get current tab ID');
      return;
    }

    let urls = document.getElementById('urls').value.trim();
    const minInterval = parseInt(document.getElementById('minInterval').value);
    const maxInterval = parseInt(document.getElementById('maxInterval').value);
    const fixedIntervalValue = parseInt(document.getElementById('fixedIntervalValue').value);
    const intervalType = randomIntervalRadio.checked ? 'random' : 'fixed';
    const hardRefresh = document.getElementById('hardRefresh').checked;
    const pauseOnClick = document.getElementById('pauseOnClick').checked;
    const urlSelection = document.getElementById('sequentialSelection').checked ? 'sequential' : 'random';
    const limitReloads = limitReloadsCheckbox.checked;
    const maxReloads = parseInt(document.getElementById('maxReloads').value);

    // Auto-fill with current tab URL if empty
    if (!urls) {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (tabs[0] && tabs[0].url) {
          if (!isValidUrl(tabs[0].url)) {
            alert('Current tab URL is not a valid HTTP/HTTPS URL.');
            return;
          }
          urls = tabs[0].url;
          document.getElementById('urls').value = urls;
          doStart(urls, minInterval, maxInterval, fixedIntervalValue, intervalType, hardRefresh, pauseOnClick, urlSelection, limitReloads, maxReloads);
        } else {
          alert('Could not get current tab URL. Please enter a URL manually.');
        }
      });
      return;
    }

    // Validate URLs
    const urlList = urls.split('\n').filter(function (u) { return u.trim(); });
    for (let i = 0; i < urlList.length; i++) {
      var trimmed = urlList[i].trim();
      if (!isValidUrl(trimmed)) {
        alert('Invalid URL: ' + trimmed + '\nURLs must start with http:// or https://');
        return;
      }
    }

    doStart(urls, minInterval, maxInterval, fixedIntervalValue, intervalType, hardRefresh, pauseOnClick, urlSelection, limitReloads, maxReloads);
  });

  function doStart(urls, minInterval, maxInterval, fixedIntervalValue, intervalType, hardRefresh, pauseOnClick, urlSelection, limitReloads, maxReloads) {
    // Validate intervals
    if (intervalType === 'random') {
      if (isNaN(minInterval) || minInterval < 1) {
        alert('Minimum interval must be at least 1 second');
        return;
      }
      if (isNaN(maxInterval) || maxInterval < 1) {
        alert('Maximum interval must be at least 1 second');
        return;
      }
      if (minInterval > maxInterval) {
        alert('Min interval must be less than or equal to max interval');
        return;
      }
    } else {
      if (isNaN(fixedIntervalValue) || fixedIntervalValue < 1) {
        alert('Fixed interval must be at least 1 second');
        return;
      }
    }

    if (limitReloads && (isNaN(maxReloads) || maxReloads < 1)) {
      alert('Maximum reloads must be at least 1');
      return;
    }

    // Save settings for this tab
    const storageKey = 'tab_' + currentTabId + '_settings';
    const settings = {
      urls: urls,
      minInterval: minInterval,
      maxInterval: maxInterval,
      fixedIntervalValue: fixedIntervalValue,
      intervalType: intervalType,
      hardRefresh: hardRefresh,
      pauseOnClick: pauseOnClick,
      urlSelection: urlSelection,
      limitReloads: limitReloads,
      maxReloads: maxReloads
    };
    chrome.storage.local.set({ [storageKey]: settings });

    // Send start message
    chrome.runtime.sendMessage({
      action: 'start',
      tabId: currentTabId,
      urls: urls.split('\n').filter(function (url) { return url.trim(); }),
      minInterval: minInterval,
      maxInterval: maxInterval,
      fixedIntervalValue: fixedIntervalValue,
      intervalType: intervalType,
      hardRefresh: hardRefresh,
      pauseOnClick: pauseOnClick,
      urlSelection: urlSelection,
      limitReloads: limitReloads,
      maxReloads: maxReloads
    });

    updateStatus(true);
    startCountdownUpdates();
  }

  // Stop button
  document.getElementById('stop').addEventListener('click', function () {
    if (!currentTabId) return;

    chrome.runtime.sendMessage({
      action: 'stop',
      tabId: currentTabId
    });
    updateStatus(false);
    stopCountdownUpdates();
  });

  function startCountdownUpdates() {
    stopCountdownUpdates();
    updateCountdown();
    countdownInterval = setInterval(updateCountdown, 500);
  }

  function stopCountdownUpdates() {
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
    countdownCard.classList.remove('active');
  }

  function updateCountdown() {
    if (!currentTabId) return;

    chrome.runtime.sendMessage({
      action: 'getCountdown',
      tabId: currentTabId
    }, function (response) {
      if (chrome.runtime.lastError) return;

      if (response && response.isRunning && response.countdown != null) {
        var seconds = Math.ceil(response.countdown / 1000);
        countdownTime.textContent = seconds;
        countdownCard.classList.add('active');

        if (response.limitReloads && response.reloadCount != null && response.maxReloads != null) {
          reloadCounter.textContent = 'Reloads: ' + response.reloadCount + ' / ' + response.maxReloads;
        } else {
          reloadCounter.textContent = '';
        }
      } else {
        countdownCard.classList.remove('active');
        // Detect session end (e.g., reload limit reached)
        if (!response || !response.isRunning) {
          updateStatus(false);
          stopCountdownUpdates();
        }
      }
    });
  }

  function updateStatus(isRunning) {
    if (isRunning) {
      statusText.textContent = 'Running';
      statusCard.classList.remove('stopped');
      statusCard.classList.add('running');
    } else {
      statusText.textContent = 'Stopped';
      statusCard.classList.remove('running');
      statusCard.classList.add('stopped');
    }
  }
});
