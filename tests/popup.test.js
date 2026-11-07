import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { settings, languages, apiError } from '../config.js';
const html = await readFile(new URL('../popup.html', import.meta.url), 'utf8');
const source = (await readFile(new URL('../popup.js', import.meta.url), 'utf8')).replace(/^import .*\n/, '');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function popup({ hasKey = false, phase = 'idle', message = 'Ready when you are.', stateReply = data => data } = {}) {
  const elements = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, {
    value: '', textContent: '', disabled: false, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; },
  }]));
  let changed;
  const data = { settings: settings(), hasKey, state: { phase, message, title: 'Test tab', transcript: '' } };
  const failures = {};
  const calls = [];
  const chrome = {
    runtime: { id: 'test', sendMessage: async m => {
      calls.push(m);
      if (failures[m.type]) return { error: failures[m.type] };
      if (m.type === 'state') return stateReply(structuredClone(data));
      if (m.type === 'key') data.hasKey = !!m.key;
      if (m.type === 'stop') data.state = { phase: 'idle', message: 'Stopped. Original audio restored.' };
      return { ok: true };
    } },
    storage: { onChanged: { addListener: fn => { changed = fn; } } },
    tabs: { query: async () => [{ id: 1 }] },
  };
  const body = { dataset: {} };
  vm.runInNewContext(source, { settings, languages, chrome, document: { body, getElementById: id => elements[id] } });
  await tick();
  return { elements, body, failures, data, calls, update(state) { data.state = state; changed({ state: { newValue: state } }, 'session'); } };
}
test('idle without key directs setup, saving and forgetting restore the correct controls', async () => {
  const p = await popup(), e = p.elements;
  assert.equal(e.phase.textContent, 'API key needed');
  assert.equal(e.status.textContent, 'Add your OpenAI API key under API connection to start translating.');
  assert.equal(e.start.disabled, true);
  assert.equal(e.forgetKey.disabled, true);
  assert.equal(e.setup.open, true);
  e.key.value = 'test-key'; await e.saveKey.onclick();
  assert.equal(e.phase.textContent, 'Ready');
  assert.equal(e.keyStatus.textContent, 'Saved key');
  assert.equal(e.start.disabled, false);
  assert.equal(e.forgetKey.disabled, false);
  assert.equal(e.setup.open, false);
  await e.forgetKey.onclick();
  assert.equal(e.phase.textContent, 'API key needed');
  assert.equal(e.forgetKey.disabled, true);
  assert.equal(e.start.disabled, true);
  assert.equal(e.setup.open, true);
});
test('missing key never masks error, connecting or live messages', async () => {
  for (const [phase, label] of [['error', 'Needs attention'], ['connecting', 'Connecting'], ['live', 'Live translation']]) {
    const { elements: e } = await popup({ phase, message: 'Original status' });
    assert.equal(e.phase.textContent, label);
    assert.equal(e.status.textContent, 'Original status');
  }
});
test('empty and failed Use key errors stay by input and clear on edit or success', async () => {
  const { elements: e, failures, calls } = await popup();
  e.error.textContent = 'Unrelated operation failed';
  await e.saveKey.onclick();
  assert.equal(e.keyError.textContent, 'Paste your API key into this field.');
  assert.equal(calls.some(m => m.type === 'key'), false);
  e.key.value = 'test-key'; e.key.listeners.input();
  assert.equal(e.keyError.textContent, '');
  failures.key = 'Could not save key'; await e.saveKey.onclick();
  assert.equal(e.keyError.textContent, 'Could not save key');
  assert.equal(e.key.value, 'test-key');
  assert.equal(e.setup.open, true);
  delete failures.key; await e.saveKey.onclick();
  assert.equal(e.keyError.textContent, '');
  assert.equal(e.key.value, '');
  assert.equal(e.error.textContent, 'Unrelated operation failed');
});
test('non-key failures retain global alert placement', async () => {
  const { elements: e, failures } = await popup({ hasKey: true });
  failures.start = 'Start failed'; await e.start.onclick();
  assert.equal(e.error.textContent, 'Start failed');
  assert.equal(e.keyError.textContent, '');
  failures.state = 'Could not refresh state';
  e.key.value = 'test-key'; await e.saveKey.onclick();
  assert.equal(e.error.textContent, 'Could not refresh state');
  assert.equal(e.keyError.textContent, '');
});
test('interruption is presentation only and recovers to live or error', async () => {
  const p = await popup({ hasKey: true, phase: 'live', message: 'Connection interrupted…' }), e = p.elements;
  assert.equal(e.phase.textContent, 'Interrupted');
  assert.equal(p.body.dataset.phase, 'interrupted');
  assert.equal(p.data.state.phase, 'live');
  assert.equal(e.start.disabled, true);
  assert.equal(e.stop.disabled, false);
  assert.equal(e.mode.disabled, true);
  p.update({ phase: 'live', message: 'Listening · Korean → English' });
  assert.equal(e.phase.textContent, 'Live translation');
  assert.equal(p.body.dataset.phase, 'live');
  p.update({ phase: 'error', message: 'Audio connection lost. Start again.' });
  assert.equal(e.phase.textContent, 'Needs attention');
  assert.equal(e.start.disabled, false);
  assert.equal(e.stop.disabled, true);
  p.update({ phase: 'connecting', message: 'Connection interrupted…' });
  assert.equal(e.phase.textContent, 'Connecting');
});
test('key alert follows input; storage helper and transcript match accepted wording', () => {
  assert.match(html, /<input id="key"[^>]*aria-describedby="keyError"[^>]*><p id="keyError" role="alert"><\/p>/);
  assert.match(html, /Your key will be saved on this computer inside the extension until you click Forget key\. Sent only to OpenAI\. API billing is separate from ChatGPT\./);
  assert.match(html, /<summary>English transcript<\/summary>/);
});
test('model access recovery names the visible translation style control', () => {
  for (const status of [403, 404]) assert.equal(apiError(status), 'Your API project may not have access to this model. Try the other translation style.');
});

test('source language explanation sits between the source selector and translation style', () => {
  assert.match(html, /<select id="sourceLanguage">[\s\S]*?<\/select><p class="hint" id="sourceLanguageHint">Continuous detects the language automatically\. This selection applies to Choose a voice\.<\/p><label class="modeLabel"/);
});
test('continuous to voice and back retains source choice, existing mode hints and listening status', async () => {
  const p = await popup({ hasKey: true }), e = p.elements;
  const continuousHint = 'Streams translations as speech arrives. Voice follows each speaker’s tone and pitch.';
  const voiceHint = 'Natural AI voices. Waits for short pauses; may lag during continuous dialogue. Stop to change voices.';
  assert.equal(e.sourceLanguageHint.hidden, false);
  assert.equal(e.modeHint.textContent, continuousHint);
  e.sourceLanguage.value = 'ja';
  await e.sourceLanguage.listeners.change();
  for (const mode of ['voice', 'continuous']) {
    e.mode.value = mode;
    await e.mode.listeners.change();
    assert.equal(e.sourceLanguageHint.hidden, mode !== 'continuous');
    assert.equal(e.voiceRow.hidden, mode !== 'voice');
    assert.equal(e.modeHint.textContent, mode === 'voice' ? voiceHint : continuousHint);
    assert.equal(e.sourceLanguage.value, 'ja');
    assert.equal(e.sourceName.textContent, 'Japanese');
    assert.equal(e.sourceNative.textContent, '日本語');
    assert.equal(e.sourceLanguage.disabled, false);
    assert.equal(e.phase.textContent, 'Ready');
    assert.equal(e.status.textContent, 'Ready when you are.');
    assert.equal(e.error.textContent || '', '');
    const saved = p.calls.filter(m => m.type === 'settings').at(-1).settings;
    assert.equal(saved.sourceLanguage, 'ja');
    assert.equal(saved.mode, mode);
  }
  p.update({ phase: 'live', message: 'Listening · Japanese → English', title: 'Test tab' });
  assert.equal(e.phase.textContent, 'Live translation');
  assert.equal(e.status.textContent, 'Listening · Japanese → English');
  assert.equal(e.sourceLanguage.disabled, true);
  assert.equal(e.mode.disabled, true);
  assert.equal(e.sourceLanguageHint.hidden, false);
  assert.equal(e.modeHint.textContent, continuousHint);
});

test('late state reply retains every user setting edit and still renders state and key', async () => {
  for (const [name, value] of [['original', '5'], ['translated', '0'], ['mode', 'voice'], ['sourceLanguage', 'ja'], ['voice', 'ash']]) {
    let release;
    const p = await popup({ hasKey: true, phase: 'connecting', message: 'Connecting test', stateReply: data => new Promise(resolve => { release = () => resolve(data); }) });
    const e = p.elements;
    e[name].value = value;
    await e[name].listeners[name === 'original' || name === 'translated' ? 'input' : 'change']();
    release(); await tick();
    assert.equal(e[name].value, value);
    if (name === 'original' || name === 'translated') assert.equal(e[name + 'Value'].textContent, value + '%');
    assert.equal(e.sourceLanguageHint.hidden, name === 'mode');
    assert.equal(e.phase.textContent, 'Connecting');
    assert.equal(e.status.textContent, 'Connecting test');
    assert.equal(e.keyStatus.textContent, 'Saved key');
    assert.equal(e.setup.open, false);
    assert.equal(e.mode.disabled, true);
    assert.equal(e.original.disabled, false);
    assert.equal(e.translated.disabled, false);
    // A later edit must also start from the preserved current settings.
    e.translated.value = '45'; await e.translated.listeners.input();
    const saved = p.calls.filter(m => m.type === 'settings').at(-1).settings;
    assert.equal(saved[name], name === 'translated' ? 45 : settings({ [name]: value })[name]);
  }
});
test('refresh after Stop preserves an overlapping slider edit and renders removed key', async () => {
  let release, hold = false;
  const p = await popup({ hasKey: true, stateReply: data => hold ? new Promise(resolve => { release = () => resolve(data); }) : data });
  hold = true; p.data.hasKey = false;
  const pending = p.elements.stop.onclick(); await tick();
  p.elements.original.value = '5'; await p.elements.original.listeners.input();
  release(); await pending;
  assert.equal(p.elements.original.value, '5');
  assert.equal(p.elements.originalValue.textContent, '5%');
  assert.equal(p.elements.phase.textContent, 'API key needed');
  assert.equal(p.elements.keyStatus.textContent, 'Key needed');
  assert.equal(p.elements.setup.open, true);
});

test('older initial live reply cannot overwrite the newer Stop refresh', async () => {
  let release;
  let requests = 0;
  const p = await popup({ phase: 'live', stateReply: data => ++requests === 1
    ? new Promise(resolve => { release = () => resolve(data); }) : data });
  const e = p.elements;
  p.update({ phase: 'live', message: 'Listening · Japanese → English', title: 'Test tab' });
  assert.equal(e.stop.disabled, false);
  p.data.settings = settings({ original: 5, translated: 45, mode: 'voice', sourceLanguage: 'ja', voice: 'ash' });
  p.data.hasKey = true;
  await e.stop.onclick();
  assert.equal(requests, 2);
  const assertLatest = () => {
    assert.equal(p.data.state.phase, 'idle');
    assert.equal(p.body.dataset.phase, 'idle');
    assert.equal(e.phase.textContent, 'Ready');
    assert.equal(e.status.textContent, 'Stopped. Original audio restored.');
    assert.equal(e.start.disabled, false);
    assert.equal(e.stop.disabled, true);
    assert.equal(e.keyStatus.textContent, 'Saved key');
    assert.equal(e.forgetKey.disabled, false);
    assert.equal(e.setup.open, false);
    for (const name of ['original', 'translated', 'mode', 'voice', 'sourceLanguage']) {
      assert.equal(e[name].value, p.data.settings[name]);
    }
    assert.equal(e.originalValue.textContent, '5%');
    assert.equal(e.translatedValue.textContent, '45%');
    assert.equal(e.sourceLanguageHint.hidden, true);
    assert.equal(e.voiceRow.hidden, false);
    assert.equal(e.sourceName.textContent, 'Japanese');
  };
  assertLatest();
  release(); await tick();
  assertLatest();
  e.translated.value = '55'; await e.translated.listeners.input();
  const saved = p.calls.filter(m => m.type === 'settings').at(-1).settings;
  assert.deepEqual(saved, settings({ ...p.data.settings, translated: 55 }));
});

test('storage push wins over a pending session snapshot while RPC initializes other fields', async () => {
  let release;
  let requests = 0;
  const initialSettings = settings({ original: 5, translated: 45, mode: 'voice', sourceLanguage: 'ja', voice: 'ash' });
  const p = await popup({ hasKey: true, phase: 'live', stateReply: data => ++requests === 1
    ? new Promise(resolve => { release = () => resolve({ ...data, settings: initialSettings }); }) : data });
  const e = p.elements;
  p.update({ phase: 'error', message: 'Audio session failed', title: 'Test tab', transcript: 'Latest words' });
  assert.equal(e.phase.textContent, 'Needs attention');
  assert.equal(e.start.disabled, true); // Key initialization is still pending.
  release(); await tick();
  assert.equal(p.data.state.phase, 'error');
  assert.equal(p.body.dataset.phase, 'error');
  assert.equal(e.phase.textContent, 'Needs attention');
  assert.equal(e.status.textContent, 'Audio session failed');
  assert.equal(e.transcript.textContent, 'Latest words');
  assert.equal(e.start.disabled, false);
  assert.equal(e.stop.disabled, true);
  assert.equal(e.keyStatus.textContent, 'Saved key');
  assert.equal(e.forgetKey.disabled, false);
  assert.equal(e.setup.open, false);
  for (const name of ['original', 'translated', 'mode', 'voice', 'sourceLanguage']) {
    assert.equal(e[name].value, initialSettings[name]);
  }
  for (const name of ['mode', 'voice', 'sourceLanguage']) assert.equal(e[name].disabled, false);
  assert.equal(e.originalValue.textContent, '5%');
  assert.equal(e.translatedValue.textContent, '45%');
  assert.equal(e.sourceLanguageHint.hidden, true);
  assert.equal(e.voiceRow.hidden, false);
  assert.equal(e.sourceName.textContent, 'Japanese');
  assert.equal(e.sourceNative.textContent, '日本語');
  assert.equal(e.modeHint.textContent, 'Natural AI voices. Waits for short pauses; may lag during continuous dialogue. Stop to change voices.');
  e.translated.value = '55'; await e.translated.listeners.input();
  assert.deepEqual(p.calls.filter(m => m.type === 'settings').at(-1).settings, settings({ ...initialSettings, translated: 55 }));

  // A push preceding a fresh request must not pin the popup to that state forever.
  await e.stop.onclick();
  assert.equal(e.phase.textContent, 'Ready');
  assert.equal(e.status.textContent, 'Stopped. Original audio restored.');
  assert.equal(e.start.disabled, false);
  // With no push since this request, the latest RPC session snapshot wins again.
  p.data.state = { phase: 'live', message: 'Listening · Japanese → English', title: 'New tab' };
  e.key.value = 'test-key'; await e.saveKey.onclick();
  assert.equal(requests, 3);
  assert.equal(e.phase.textContent, 'Live translation');
  assert.equal(e.status.textContent, 'Listening · Japanese → English');
  assert.equal(e.source.textContent, 'New tab');
  assert.equal(e.start.disabled, true);
  assert.equal(e.stop.disabled, false);
});
