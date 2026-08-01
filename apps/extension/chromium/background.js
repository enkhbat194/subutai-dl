const api = globalThis.browser ?? globalThis.chrome;
const HOST_NAME = 'com.subutai.download_manager';
const REQUEST_TTL_MS = 30_000;
const MAX_RECENT_REQUESTS = 500;
const recentRequests = new Map();

function browserSource() {
  if (api.runtime.getURL('').startsWith('moz-extension:')) return 'firefox';
  return navigator.userAgent.includes('Edg/') ? 'edge' : 'chrome';
}

function safeUrl(value) {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:', 'ftp:', 'sftp:'].includes(parsed.protocol) ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function cleanFilename(value) {
  if (!value) return undefined;
  const pieces = value.replaceAll('\\', '/').split('/');
  const name = pieces.at(-1)?.trim();
  return name ? name.slice(0, 255) : undefined;
}

function pruneRecentRequests() {
  const cutoff = Date.now() - REQUEST_TTL_MS;
  for (const [key, value] of recentRequests) {
    if (value.time < cutoff) recentRequests.delete(key);
  }
  while (recentRequests.size > MAX_RECENT_REQUESTS) {
    recentRequests.delete(recentRequests.keys().next().value);
  }
}

function rememberRequest(details) {
  if (!details.url || !details.requestHeaders) return;
  const headers = {};
  for (const header of details.requestHeaders) {
    if (!header.name || typeof header.value !== 'string') continue;
    headers[header.name] = header.value;
  }
  recentRequests.set(details.url, {
    url: details.url,
    tabId: details.tabId,
    time: Date.now(),
    headers,
  });
  pruneRecentRequests();
}

try {
  api.webRequest.onBeforeSendHeaders.addListener(
    rememberRequest,
    { urls: ['<all_urls>'] },
    ['requestHeaders', 'extraHeaders'],
  );
} catch {
  api.webRequest.onBeforeSendHeaders.addListener(
    rememberRequest,
    { urls: ['<all_urls>'] },
    ['requestHeaders'],
  );
}

async function getSettings() {
  const stored = await api.storage.local.get({
    interceptionEnabled: true,
    connections: 16,
    showNotifications: true,
  });
  return {
    interceptionEnabled: stored.interceptionEnabled !== false,
    connections: Math.max(1, Math.min(16, Number(stored.connections) || 16)),
    showNotifications: stored.showNotifications !== false,
  };
}

async function collectHeaders(url, tabId, sourcePageUrl, extraHeaders = {}) {
  pruneRecentRequests();
  const target = new URL(url);
  let remembered = recentRequests.get(url);
  if (!remembered) {
    remembered = [...recentRequests.values()]
      .filter((entry) => entry.tabId === tabId && (() => {
        try { return new URL(entry.url).origin === target.origin; } catch { return false; }
      })())
      .sort((a, b) => b.time - a.time)[0];
  }

  const headers = { ...(remembered?.headers ?? {}), ...extraHeaders };
  try {
    const cookies = await api.cookies.getAll({ url });
    if (cookies.length > 0) headers.Cookie = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  } catch {
    // A browser may deny cookies for a restricted URL. The download can still proceed without them.
  }

  if (sourcePageUrl && !headers.Referer && !headers.referer) headers.Referer = sourcePageUrl;
  if (!headers['User-Agent'] && !headers['user-agent']) headers['User-Agent'] = navigator.userAgent;

  const cleaned = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string') continue;
    const safeName = name.trim();
    const safeValue = value.replace(/[\r\n]+/g, ' ').trim();
    if (!safeName || !safeValue || /[\r\n:]/.test(safeName)) continue;
    cleaned[safeName] = safeValue.slice(0, 16_384);
  }
  return cleaned;
}

async function notify(title, message) {
  const settings = await getSettings();
  if (!settings.showNotifications) return;
  try {
    await api.notifications.create({
      type: 'basic',
      iconUrl: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="%2307111f"/><path d="M32 11v31m0 0L20 30m12 12 12-12M15 50h34" stroke="%23f5b942" stroke-width="6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      title,
      message,
    });
  } catch {
    // Notifications are optional.
  }
}

async function sendToSubutai({ url, filename, tabId = -1, sourcePageUrl, extraHeaders }) {
  const safe = safeUrl(url);
  if (!safe) throw new Error('Дэмжигдэх URL биш байна.');
  const settings = await getSettings();
  const headers = await collectHeaders(safe, tabId, sourcePageUrl, extraHeaders);
  const payload = {
    type: 'enqueue',
    requestId: crypto.randomUUID(),
    url: safe,
    filename: cleanFilename(filename),
    headers,
    source: browserSource(),
    sourcePageUrl,
    connections: settings.connections,
  };
  const response = await api.runtime.sendNativeMessage(HOST_NAME, payload);
  if (!response?.ok) throw new Error(response?.error || 'Subutai desktop app хариу өгсөнгүй.');
  return response;
}

async function interceptDownload(item) {
  const settings = await getSettings();
  if (!settings.interceptionEnabled || item.byExtensionId === api.runtime.id) return;
  const url = safeUrl(item.finalUrl || item.url);
  if (!url) return;

  try {
    await api.downloads.cancel(item.id);
    await sendToSubutai({
      url,
      filename: item.filename,
      tabId: -1,
      sourcePageUrl: item.referrer || undefined,
      extraHeaders: item.referrer ? { Referer: item.referrer } : undefined,
    });
    await api.downloads.erase({ id: item.id });
  } catch (error) {
    await notify('Subutai', error instanceof Error ? error.message : String(error));
  }
}

api.downloads.onCreated.addListener((item) => {
  void interceptDownload(item);
});

async function createContextMenus() {
  await api.contextMenus.removeAll();
  api.contextMenus.create({ id: 'subutai-link', title: 'Subutai-аар холбоос татах', contexts: ['link'] });
  api.contextMenus.create({ id: 'subutai-media', title: 'Subutai-аар медиа татах', contexts: ['video', 'audio', 'image'] });
  api.contextMenus.create({ id: 'subutai-page', title: 'Энэ хуудсыг Subutai-д нээх', contexts: ['page'] });
  api.contextMenus.create({ id: 'subutai-selection', title: 'Сонгосон URL-уудыг Subutai-аар татах', contexts: ['selection'] });
}

api.runtime.onInstalled.addListener(() => {
  void createContextMenus();
});
api.runtime.onStartup?.addListener(() => {
  void createContextMenus();
});

api.contextMenus.onClicked.addListener((info, tab) => {
  void (async () => {
    try {
      const sourcePageUrl = info.pageUrl || tab?.url;
      if (info.menuItemId === 'subutai-link' && info.linkUrl) {
        await sendToSubutai({ url: info.linkUrl, tabId: tab?.id, sourcePageUrl });
      } else if (info.menuItemId === 'subutai-media' && info.srcUrl) {
        await sendToSubutai({ url: info.srcUrl, tabId: tab?.id, sourcePageUrl });
      } else if (info.menuItemId === 'subutai-page' && sourcePageUrl) {
        await sendToSubutai({ url: sourcePageUrl, tabId: tab?.id, sourcePageUrl });
      } else if (info.menuItemId === 'subutai-selection' && info.selectionText) {
        const urls = [...new Set(info.selectionText.match(/https?:\/\/[^\s<>"']+/g) ?? [])].slice(0, 100);
        for (const url of urls) await sendToSubutai({ url, tabId: tab?.id, sourcePageUrl });
      }
    } catch (error) {
      await notify('Subutai', error instanceof Error ? error.message : String(error));
    }
  })();
});

api.runtime.onMessage.addListener((message) => {
  if (message?.type === 'get-settings') return getSettings();
  if (message?.type === 'set-settings') {
    return api.storage.local.set({
      interceptionEnabled: message.interceptionEnabled !== false,
      connections: Math.max(1, Math.min(16, Number(message.connections) || 16)),
      showNotifications: message.showNotifications !== false,
    }).then(getSettings);
  }
  if (message?.type === 'ping') {
    return api.runtime.sendNativeMessage(HOST_NAME, { type: 'ping', requestId: crypto.randomUUID() });
  }
  if (message?.type === 'download-current-tab') {
    return api.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
      if (!tab?.url) throw new Error('Идэвхтэй хуудасны URL олдсонгүй.');
      return sendToSubutai({ url: tab.url, tabId: tab.id, sourcePageUrl: tab.url });
    });
  }
  return undefined;
});
