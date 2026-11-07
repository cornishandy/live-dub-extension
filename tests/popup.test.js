import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { settings, languages, apiError } from '../config.js';
const html = await readFile(new URL('../popup.html', import.meta.url), 'utf8');
const source = (await readFile(new URL('../popup.js', import.meta.url), 'utf8')).replace(/^import .*\n/, '');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function popup({ hasKey = false, phase = 'idle', message = 'Ready when you are.' } = {}) {
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
      if (m.type === 'state') return data;
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
