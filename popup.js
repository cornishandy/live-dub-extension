import { settings, languages } from './config.js';
const $ = id => document.getElementById(id);
let current = settings();
let settingsVersion = 0;
let initGeneration = 0;
let busy = false;
let hasKey = false;
async function send(type, extra = {}) {
  const response = await chrome.runtime.sendMessage({ target: 'worker', type, ...extra });
  if (response?.error) throw new Error(response.error);
  return response;
}
function error(e) { $('error').textContent = e.message || String(e); }
function renderMode() {
  $('sourceNative').textContent = languages[current.sourceLanguage].native;
  $('sourceName').textContent = languages[current.sourceLanguage].name;
  $('sourceLanguageHint').hidden = current.mode !== 'continuous';
  $('voiceRow').hidden = current.mode !== 'voice';
  $('modeHint').textContent = current.mode === 'voice' ? 'Natural AI voices. Waits for short pauses; may lag during continuous dialogue. Stop to change voices.' : 'Streams translations as speech arrives. Voice follows each speaker’s tone and pitch.';
}
function render(state) {
  const running = ['live', 'connecting'].includes(state.phase);
  const interrupted = state.phase === 'live' && state.message === 'Connection interrupted…';
  const needsKey = state.phase === 'idle' && !hasKey;
  document.body.dataset.phase = interrupted ? 'interrupted' : state.phase;
  $('phase').textContent = interrupted ? 'Interrupted' : needsKey ? 'API key needed' : { idle: 'Ready', live: 'Live translation', connecting: 'Connecting', error: 'Needs attention' }[state.phase] || 'Ready';
  $('status').textContent = needsKey ? 'Add your OpenAI API key under API connection to start translating.' : state.message;
  $('source').textContent = running ? state.title || 'Selected tab' : '';
  $('start').disabled = running || busy || !hasKey;
  $('stop').disabled = !running && !busy;
  $('mode').disabled = running || busy;
  $('voice').disabled = running || busy;
  $('sourceLanguage').disabled = running || busy;
  $('transcript').textContent = state.transcript || 'Translated words will appear here.';
  $('transcript').scrollTop = $('transcript').scrollHeight;
  $('keyStatus').textContent = hasKey ? 'Saved key' : 'Key needed';
  $('forgetKey').disabled = !hasKey;
}
async function init() {
  if (!globalThis.chrome?.runtime?.id) {
    $('error').textContent = 'Preview only. Load this folder as an unpacked Chrome extension to translate.';
    $('start').disabled = true;
    for (const id of ['key', 'saveKey', 'forgetKey']) $(id).disabled = true;
    return;
  }
  const version = settingsVersion;
  const generation = ++initGeneration;
  const result = await send('state');
  if (generation !== initGeneration) return;
  if (version === settingsVersion) {
    current = result.settings;
    for (const name of ['original', 'translated', 'mode', 'voice', 'sourceLanguage']) $(name).value = current[name];
    for (const name of ['original', 'translated']) $(name + 'Value').textContent = current[name] + '%';
  }
  hasKey = result.hasKey;
  $('setup').open = !hasKey;
  renderMode(); render(result.state);
}
for (const name of ['original', 'translated', 'mode', 'voice', 'sourceLanguage']) {
  $(name).addEventListener(name === 'original' || name === 'translated' ? 'input' : 'change', async () => {
    settingsVersion++;
    current = settings({ ...current, [name]: $(name).value });
    if (name === 'original' || name === 'translated') $(name + 'Value').textContent = current[name] + '%';
    renderMode();
    try { await send('settings', { settings: current }); } catch (e) { error(e); }
  });
}
$('key').addEventListener('input', () => { $('keyError').textContent = ''; });
$('saveKey').onclick = async () => {
  try {
    const key = $('key').value.trim();
    if (!key) throw new Error('Paste your API key into this field.');
    await send('key', { key });
  } catch (e) {
    $('keyError').textContent = e.message || String(e);
    return;
  }
  $('key').value = ''; $('keyError').textContent = '';
  try { await init(); $('setup').open = false; } catch (e) { error(e); }
};
$('forgetKey').onclick = async () => { try { await send('stop'); await send('key', { key: '' }); await init(); } catch (e) { error(e); } };
$('start').onclick = async () => {
  busy = true; $('start').disabled = true; $('error').textContent = '';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('Select the video tab first.');
    await send('start', { tabId: tab.id });
  } catch (e) { error(e); }
  finally { busy = false; await init().catch(error); }
};
$('stop').onclick = async () => { try { await send('stop'); busy = false; await init(); } catch (e) { error(e); } };
if (globalThis.chrome?.storage) chrome.storage.onChanged.addListener((changes, area) => { if (area === 'session' && changes.state) render(changes.state.newValue); });
init().catch(error);
