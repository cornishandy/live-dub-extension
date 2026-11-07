import { settings, sessionRequest, apiError } from './config.js';
let generation = 0;
let starting = false;
let request;
let creating;
const offscreenURL = chrome.runtime.getURL('offscreen.html');
const idle = { phase: 'idle', message: 'Ready when you are.', transcript: '', tabId: null };
async function publish(state) {
  await chrome.storage.session.set({ state });
  await chrome.action.setBadgeText({ text: state.phase === 'live' ? 'EN' : state.phase === 'connecting' ? '…' : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#56ddba' });
}
async function exists() {
  return (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [offscreenURL] })).length > 0;
}
async function ensureOffscreen() {
  if (await exists()) return;
  if (!creating) creating = chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['USER_MEDIA'], justification: 'Capture the selected tab and play original and translated audio with separate volume controls.' }).finally(() => { creating = null; });
  await creating;
}
async function stop(message = 'Stopped. Original audio restored.') {
  generation++;
  starting = false;
  request?.abort();
  if (creating) await creating;
  if (await exists()) await chrome.offscreen.closeDocument();
  await publish({ ...idle, message });
}
async function start(tabId) {
  if (starting) throw new Error('A connection is already starting.');
  starting = true;
  const ticket = ++generation;
  let stored, tab, options;
  try {
    stored = { ...(await chrome.storage.session.get('state')), ...(await chrome.storage.local.get('apiKey')) };
    if (['live', 'connecting'].includes(stored.state?.phase)) throw new Error('Stop the current session first.');
    if (!stored.apiKey) throw new Error('Enter your OpenAI API key first.');
    tab = await chrome.tabs.get(tabId);
    if (!/^https?:\/\//.test(tab.url || '')) throw new Error('Open your video in a regular website tab first.');
    options = settings((await chrome.storage.local.get('settings')).settings);
  } catch (error) { if (ticket === generation) starting = false; throw error; }
  if (ticket !== generation) return;
  await publish({ ...idle, phase: 'connecting', message: 'Connecting to the audio service…', tabId, title: tab.title, options });
  try {
    const spec = sessionRequest(options);
    const controller = new AbortController();
    request = controller;
    const timeout = setTimeout(() => controller.abort(), 20000);
    let response;
    try {
      response = await fetch(`https://api.openai.com/v1${spec.path}/client_secrets`, {
        method: 'POST', headers: { Authorization: `Bearer ${stored.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: spec.session }), signal: controller.signal,
      });
    } finally { clearTimeout(timeout); }
    if (!response.ok) throw new Error(apiError(response.status));
    const { value: secret } = await response.json();
    if (!secret) throw new Error('The audio service did not return a session token.');
    if (ticket !== generation) return;
    await ensureOffscreen();
    if (ticket !== generation) return;
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    const volumes = settings((await chrome.storage.local.get('settings')).settings);
    if (ticket !== generation) return;
    // Keep the session configuration matched to its token; only the mix is live.
    options = { ...options, original: volumes.original, translated: volumes.translated };
    const result = await chrome.runtime.sendMessage({ target: 'audio', type: 'start', streamId, secret, path: spec.path, options, tabId, title: tab.title });
    if (!result?.ok) throw new Error(result?.error || 'Could not start audio capture.');
  } catch (error) {
    if (ticket === generation) {
      await stop();
      await publish({ ...idle, phase: 'error', message: error.name === 'AbortError' ? 'Connection timed out. Check your network and retry.' : error.message });
    }
  } finally { if (ticket === generation) starting = false; }
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || message.target !== 'worker') return;
  const run = async () => {
    if (message.type === 'state') {
      const result = { ...(await chrome.storage.session.get('state')), ...(await chrome.storage.local.get('apiKey')) };
      if (!starting && ['live', 'connecting'].includes(result.state?.phase) && !(await exists())) {
        result.state = { ...idle, message: 'Audio session ended. Start again to reconnect.' };
        await publish(result.state);
      }
      return { state: result.state || idle, hasKey: Boolean(result.apiKey), settings: settings((await chrome.storage.local.get('settings')).settings) };
    }
    if (message.type === 'key') {
      if (message.key) await chrome.storage.local.set({ apiKey: message.key.trim() });
      else await chrome.storage.local.remove('apiKey');
      await chrome.storage.session.remove('apiKey');
    } else if (message.type === 'settings') {
      const options = settings(message.settings);
      await chrome.storage.local.set({ settings: options });
      if (await exists()) await chrome.runtime.sendMessage({ target: 'audio', type: 'mix', options });
    } else if (message.type === 'start') {
      await start(message.tabId);
    } else if (message.type === 'stop') {
      await stop();
    } else if (message.type === 'audio-state' && sender.url === offscreenURL) {
      await publish(message.state);
      if (message.state.phase === 'error' || message.state.phase === 'idle') {
        if (await exists()) await chrome.offscreen.closeDocument();
      }
    }
    return { ok: true };
  };
  run().then(reply).catch(error => reply({ error: error.message }));
  return true;
});
chrome.tabs.onRemoved.addListener(async tabId => {
  const { state } = await chrome.storage.session.get('state');
  if (state?.tabId === tabId) await stop('Video tab closed.');
});
chrome.tabs.onUpdated.addListener(async (tabId, change) => {
  if (!change.url) return;
  const { state } = await chrome.storage.session.get('state');
  if (state?.tabId === tabId) await stop('Page changed. Start again to translate this video.');
});
