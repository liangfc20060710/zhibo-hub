export class ApiError extends Error {
  constructor(message, { code = 'REQUEST_FAILED', status = 0 } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

async function request(path, { method = 'GET', body = null, timeout = 30000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(path, {
      method,
      headers: body == null ? {} : { 'Content-Type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      const error = payload?.error ?? {};
      throw new ApiError(error.message ?? `请求失败 · HTTP ${response.status}`, {
        code: error.code ?? 'REQUEST_FAILED',
        status: response.status
      });
    }
    return payload;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new ApiError('请求超时，内核仍在运行，请稍后重试', { code: 'TIMEOUT' });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const post = (path, body = null, timeout) => request(path, { method: 'POST', body, timeout });

export const api = {
  state: () => request('/api/state'),
  health: () => request('/api/health'),
  prepare: () => post('/api/prepare', null, 60000),
  startLive: () => post('/api/live/start'),
  pauseLive: () => post('/api/live/pause'),
  resumeLive: () => post('/api/live/resume'),
  stopLive: () => post('/api/live/stop'),
  danmaku: (text, extra = {}) => post('/api/danmaku', { text, ...extra }),
  scenario: (type) => post('/api/scenario', { type }, 60000),
  review: () => post('/api/review', null, 60000),
  fault: (agent, action = 'offline') => post('/api/fault', { agent, action }),
  hotplug: (payload) => post('/api/tools/hotplug', payload),
  removeTool: (name) => post('/api/tools/remove', { name }),
  callTool: (name, args = {}) => post('/api/tools/call', { name, args }, 60000),
  stress: (events = 800) => post('/api/stress', { events }, 120000),
  chat: (message, mode = 'cmd') => post('/api/chat', { message, mode }, 90000),
  acceptance: (force = false) => request(`/api/acceptance${force ? '?force=1' : ''}`, { timeout: 120000 }),
  reset: () => post('/api/reset'),
  trace: (id) => request(`/api/trace/${encodeURIComponent(id)}`),
  getLlmConfig: () => request('/api/llm/config'),
  updateLlmConfig: (payload) => post('/api/llm/config', payload)
};

export const EVENT_SOURCE_URL = '/api/events';
