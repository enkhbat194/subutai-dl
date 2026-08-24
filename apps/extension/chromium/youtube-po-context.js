const subutaiBrowserApi = globalThis.browser ?? globalThis.chrome;
const SUBUTAI_YOUTUBE_CONTEXT_TTL_MS = 120_000;
const SUBUTAI_YOUTUBE_CONTEXT_MAX = 32;
const SUBUTAI_PO_TOKEN_HEADER = 'X-Subutai-YouTube-Po-Token';
const SUBUTAI_VISITOR_DATA_HEADER = 'X-Subutai-YouTube-Visitor-Data';
const subutaiYouTubeContexts = [];

function subutaiPruneYouTubeContexts() {
  const cutoff = Date.now() - SUBUTAI_YOUTUBE_CONTEXT_TTL_MS;
  while (subutaiYouTubeContexts.length > 0 && subutaiYouTubeContexts[0].time < cutoff) {
    subutaiYouTubeContexts.shift();
  }
  while (subutaiYouTubeContexts.length > SUBUTAI_YOUTUBE_CONTEXT_MAX) {
    subutaiYouTubeContexts.shift();
  }
}

function subutaiDecodeRequestBody(requestBody) {
  const raw = requestBody?.raw;
  if (!Array.isArray(raw) || raw.length === 0) return '';
  try {
    const decoder = new TextDecoder('utf-8');
    let result = '';
    for (const part of raw) {
      if (!part?.bytes) continue;
      result += decoder.decode(new Uint8Array(part.bytes), { stream: true });
    }
    result += decoder.decode();
    return result;
  } catch {
    return '';
  }
}

function subutaiRememberYouTubePlayerRequest(details) {
  if (!Number.isInteger(details.tabId) || details.tabId < 0) return;
  const bodyText = subutaiDecodeRequestBody(details.requestBody);
  if (!bodyText) return;
  try {
    const payload = JSON.parse(bodyText);
    const poToken = typeof payload?.serviceIntegrityDimensions?.poToken === 'string'
      ? payload.serviceIntegrityDimensions.poToken.trim()
      : '';
    const visitorData = typeof payload?.context?.client?.visitorData === 'string'
      ? payload.context.client.visitorData.trim()
      : '';
    const videoId = typeof payload?.videoId === 'string' ? payload.videoId.trim() : '';
    if (!poToken && !visitorData) return;
    subutaiYouTubeContexts.push({
      tabId: details.tabId,
      time: Date.now(),
      videoId,
      poToken: poToken.slice(0, 4096),
      visitorData: visitorData.slice(0, 4096),
    });
    subutaiPruneYouTubeContexts();
  } catch {
    // Player request bodies can change shape; malformed or unrelated bodies are ignored.
  }
}

function subutaiYouTubeVideoId(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    if (host === 'youtu.be') return parsed.pathname.split('/').filter(Boolean)[0] ?? '';
    if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com')) {
      const direct = parsed.searchParams.get('v');
      if (direct) return direct;
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (['shorts', 'embed', 'live'].includes(parts[0] ?? '')) return parts[1] ?? '';
    }
  } catch {
    // Non-URL payloads are ignored.
  }
  return '';
}

function subutaiIsYouTubeUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'youtu.be'
      || host === 'youtube.com'
      || host.endsWith('.youtube.com')
      || host === 'youtube-nocookie.com'
      || host.endsWith('.youtube-nocookie.com');
  } catch {
    return false;
  }
}

function subutaiAugmentNativePayload(payload) {
  if (!payload || payload.type !== 'enqueue') return payload;
  const sourceUrl = typeof payload.sourcePageUrl === 'string' && payload.sourcePageUrl
    ? payload.sourcePageUrl
    : payload.url;
  if (typeof sourceUrl !== 'string' || !subutaiIsYouTubeUrl(sourceUrl)) return payload;

  subutaiPruneYouTubeContexts();
  const videoId = subutaiYouTubeVideoId(sourceUrl) || subutaiYouTubeVideoId(payload.url ?? '');
  const candidates = [...subutaiYouTubeContexts].reverse();
  const context = (videoId && candidates.find((entry) => entry.videoId === videoId)) || candidates[0];
  if (!context) return payload;

  const headers = { ...(payload.headers ?? {}) };
  if (context.poToken && !headers[SUBUTAI_PO_TOKEN_HEADER]) headers[SUBUTAI_PO_TOKEN_HEADER] = context.poToken;
  if (context.visitorData && !headers[SUBUTAI_VISITOR_DATA_HEADER]) headers[SUBUTAI_VISITOR_DATA_HEADER] = context.visitorData;
  return { ...payload, headers };
}

try {
  subutaiBrowserApi.webRequest.onBeforeRequest.addListener(
    subutaiRememberYouTubePlayerRequest,
    {
      urls: [
        '*://*.youtube.com/youtubei/v1/player*',
        '*://youtubei.googleapis.com/youtubei/v1/player*',
      ],
    },
    ['requestBody'],
  );
} catch {
  // Request-body capture is an optional acceleration path; existing provider/browser fallbacks remain available.
}

try {
  const originalSendNativeMessage = subutaiBrowserApi.runtime.sendNativeMessage.bind(subutaiBrowserApi.runtime);
  subutaiBrowserApi.runtime.sendNativeMessage = function subutaiSendNativeMessage(hostName, payload, ...rest) {
    const nextPayload = hostName === 'com.subutai.download_manager'
      ? subutaiAugmentNativePayload(payload)
      : payload;
    return originalSendNativeMessage(hostName, nextPayload, ...rest);
  };
} catch {
  // If a browser makes the API method non-writable, ordinary Subutai native messaging continues unchanged.
}
