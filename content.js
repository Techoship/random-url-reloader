(function () {
  let countdownInterval = null;
  let statusPollInterval = null;
  let nextReloadTime = null;
  let countdownElement = null;
  let pauseOnClick = false;
  let clickListener = null;
  let myTabId = null;
  let active = false;

  function isContextValid() {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }

  // Promise-based message sending that resolves null on failure (never hangs)
  function safeSendMessage(message) {
    return new Promise((resolve) => {
      if (!isContextValid()) {
        resolve(null);
        return;
      }

      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(response);
        });
      } catch {
        resolve(null);
      }
    });
  }

  async function initialize() {
    if (!isContextValid()) return;

    const response = await safeSendMessage({ action: 'getCurrentTabInfo' });
    if (!response || !response.tabId) return;

    myTabId = response.tabId;
    await checkAndUpdateSession();
  }

  async function checkAndUpdateSession() {
    if (!myTabId || !isContextValid()) return;

    const response = await safeSendMessage({
      action: 'getCountdown',
      tabId: myTabId
    });

    if (!response) return;

    if (response.isRunning && response.countdown > 0) {
      nextReloadTime = Date.now() + response.countdown;
      pauseOnClick = response.pauseOnClick || false;

      if (!active) {
        active = true;
        createCountdownElement();
        startCountdownDisplay();
        startStatusPolling();
      }

      if (pauseOnClick && !clickListener) {
        enablePauseOnClick();
      } else if (!pauseOnClick && clickListener) {
        disablePauseOnClick();
      }

      updateCounterInfo(response);
    } else {
      deactivate();
    }
  }

  // Only poll when a session is active (every 2s instead of 500ms on all pages)
  function startStatusPolling() {
    stopStatusPolling();
    statusPollInterval = setInterval(() => {
      if (!isContextValid()) {
        cleanup();
        return;
      }
      checkAndUpdateSession();
    }, 2000);
  }

  function stopStatusPolling() {
    if (statusPollInterval) {
      clearInterval(statusPollInterval);
      statusPollInterval = null;
    }
  }

  function deactivate() {
    active = false;
    removeCountdownElement();
    stopStatusPolling();
  }

  // --- DOM creation (no innerHTML) ---

  function createCountdownElement() {
    const existing = document.getElementById('reloader-countdown');
    if (existing) existing.remove();

    countdownElement = document.createElement('div');
    countdownElement.id = 'reloader-countdown';

    const icon = document.createElement('div');
    icon.className = 'countdown-icon';

    const content = document.createElement('div');
    content.className = 'countdown-content';

    const text = document.createElement('div');
    text.className = 'countdown-text';
    text.textContent = 'Next reload';

    const number = document.createElement('div');
    number.className = 'countdown-number';

    const timeSpan = document.createElement('span');
    timeSpan.id = 'reloader-countdown-time';
    timeSpan.textContent = '--';

    number.appendChild(timeSpan);
    number.appendChild(document.createTextNode('s'));

    const info = document.createElement('div');
    info.className = 'countdown-info';
    info.id = 'reloader-countdown-info';

    content.appendChild(text);
    content.appendChild(number);
    content.appendChild(info);

    countdownElement.appendChild(icon);
    countdownElement.appendChild(content);

    document.body.appendChild(countdownElement);
  }

  function removeCountdownElement() {
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }

    if (countdownElement && document.body.contains(countdownElement)) {
      countdownElement.remove();
      countdownElement = null;
    }

    disablePauseOnClick();
  }

  // Update countdown display at 250ms (sufficient for whole-second display)
  function startCountdownDisplay() {
    if (countdownInterval) clearInterval(countdownInterval);

    updateCountdownDisplay();
    countdownInterval = setInterval(() => {
      if (!isContextValid()) {
        cleanup();
        return;
      }
      updateCountdownDisplay();
    }, 250);
  }

  function updateCountdownDisplay() {
    if (!nextReloadTime || !countdownElement) return;

    const seconds = Math.max(0, Math.ceil((nextReloadTime - Date.now()) / 1000));
    const timeSpan = document.getElementById('reloader-countdown-time');
    if (timeSpan) timeSpan.textContent = seconds;
  }

  function updateCounterInfo(response) {
    const infoSpan = document.getElementById('reloader-countdown-info');
    if (!infoSpan) return;

    if (response.limitReloads) {
      infoSpan.textContent = response.reloadCount + ' / ' + response.maxReloads;
    } else {
      infoSpan.textContent = '';
    }
  }

  // --- Pause on click ---

  function enablePauseOnClick() {
    if (clickListener) return;

    clickListener = function (e) {
      if (e.target.closest('#reloader-countdown')) return;

      if (myTabId && isContextValid()) {
        safeSendMessage({ action: 'pageClicked', tabId: myTabId });
      }

      deactivate();
      showNotification('reloader-paused-notification', '\u23F8', 'Reloader Paused', 2000);
    };

    document.addEventListener('click', clickListener, true);
  }

  function disablePauseOnClick() {
    if (clickListener) {
      document.removeEventListener('click', clickListener, true);
      clickListener = null;
    }
  }

  // --- Notifications (no innerHTML) ---

  function showNotification(id, iconChar, text, duration) {
    const notification = document.createElement('div');
    notification.id = id;

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;align-items:center;gap:10px';

    const iconSpan = document.createElement('span');
    iconSpan.style.fontSize = '20px';
    iconSpan.textContent = iconChar;

    const textSpan = document.createElement('span');
    textSpan.textContent = text;

    wrapper.appendChild(iconSpan);
    wrapper.appendChild(textSpan);
    notification.appendChild(wrapper);
    document.body.appendChild(notification);

    setTimeout(() => {
      if (notification && document.body.contains(notification)) {
        notification.style.opacity = '0';
        setTimeout(() => {
          if (notification && document.body.contains(notification)) {
            notification.remove();
          }
        }, 300);
      }
    }, duration);
  }

  function cleanup() {
    deactivate();
  }

  // --- Message listener ---

  chrome.runtime.onMessage.addListener((request) => {
    if (!isContextValid()) return;

    if (request.action === 'updateCountdown') {
      if (request.nextReloadTime) {
        nextReloadTime = request.nextReloadTime;
        pauseOnClick = request.pauseOnClick || false;

        if (!active) {
          active = true;
          createCountdownElement();
          startCountdownDisplay();
          startStatusPolling();
        }

        if (pauseOnClick && !clickListener) {
          enablePauseOnClick();
        } else if (!pauseOnClick && clickListener) {
          disablePauseOnClick();
        }

        updateCounterInfo(request);
      } else {
        deactivate();
      }
    } else if (request.action === 'reloadCompleted') {
      deactivate();
      showNotification(
        'reloader-completed-notification',
        '\u2714',
        'Completed ' + request.reloadCount + ' reloads',
        3000
      );
    }
  });

  // --- Lifecycle ---

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && active && isContextValid()) {
      checkAndUpdateSession();
    }
  });

  window.addEventListener('beforeunload', cleanup);
  window.addEventListener('pagehide', cleanup);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
  } else {
    initialize();
  }
})();
