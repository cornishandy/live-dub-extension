import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { settings, sessionRequest, apiError, languages } from '../config.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
async function worker(fetchImpl = async () => ({ ok: true, json: async () => ({ value: 'ephemeral-test-token' }) })) {
  let listener, documentOpen = false;
  const memory = {}, local = {}, messages = [], captures = [];
  const area = data => ({ get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(k => [k, data[k]])), set: async values => Object.assign(data, values), remove: async k => { delete data[k]; } });
  const chrome = {
    runtime: { id: 'test', getURL: path => 'chrome-extension://test/' + path, getContexts: async () => documentOpen ? [{}] : [], onMessage: { addListener: fn => { listener = fn; } }, sendMessage: async m => { messages.push(m); return { ok: true }; } },
    storage: { session: area(memory), local: area(local) },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    offscreen: { createDocument: async () => { documentOpen = true; }, closeDocument: async () => { documentOpen = false; } },
    tabs: { get: async id => ({ id, url: 'https://www.youtube.com/watch?v=test', title: 'Test video' }), onRemoved: { addListener: () => {} }, onUpdated: { addListener: () => {} } },
    tabCapture: { getMediaStreamId: async options => { captures.push(options); return 'stream-test'; } },
  };
  vm.runInNewContext((await readFile(new URL('../background.js', import.meta.url), 'utf8')).replace(/^import .*\n/, ''), { chrome, settings, sessionRequest, apiError, languages, fetch: fetchImpl, AbortController, setTimeout, clearTimeout });
  return { memory, local, messages, captures, chrome, open: () => documentOpen, send: m => new Promise(resolve => listener({ target: 'worker', ...m }, { id: 'test' }, resolve)) };
}
test('volume bounds and supported modes/voices', () => {
  assert.deepEqual(settings({ original: -50, translated: 200, mode: 'bad', voice: 'bad' }), { original: 0, translated: 100, mode: 'continuous', voice: 'marin', sourceLanguage: 'ko' });
  assert.equal(settings({ original: 'not a number' }).original, 20);
  assert.equal(sessionRequest(settings()).session.audio.output.language, 'en');
  const voice = sessionRequest(settings({ mode: 'voice', voice: 'cedar' }));
  assert.equal(voice.session.audio.output.voice, 'cedar');
  assert.equal(voice.session.audio.input.turn_detection.interrupt_response, false);
});
test('no key prevents network and capture', async () => {
  const w = await worker(() => { throw new Error('Unexpected network request'); });
  assert.match((await w.send({ type: 'start', tabId: 1 })).error, /API key/);
  assert.equal(w.captures.length, 0);
});
test('successful start passes only short-lived token to audio, stop releases capture', async () => {
  const w = await worker();
  await w.send({ type: 'key', key: 'private-test-key' });
  assert.equal((await w.send({ type: 'start', tabId: 1 })).ok, true);
  assert.equal(w.open(), true);
  assert.equal(w.messages[0].secret, 'ephemeral-test-token');
  assert.equal(JSON.stringify(w.messages).includes('private-test-key'), false);
  assert.equal(w.local.apiKey, undefined);
  await w.send({ type: 'stop' });
  assert.equal(w.open(), false);
  assert.equal(w.memory.state.phase, 'idle');
});
test('401 never captures audio and shows actionable failure', async () => {
  const w = await worker(async () => ({ ok: false, status: 401 }));
  await w.send({ type: 'key', key: 'invalid' });
  await w.send({ type: 'start', tabId: 1 });
  assert.equal(w.captures.length, 0);
  assert.equal(w.memory.state.phase, 'error');
  assert.match(w.memory.state.message, /key rejected/);
});
test('stop during authentication cannot later restart capture', async () => {
  let finish;
  const w = await worker(() => new Promise(resolve => { finish = resolve; }));
  await w.send({ type: 'key', key: 'test' });
  const pending = w.send({ type: 'start', tabId: 1 });
  await tick();
  await w.send({ type: 'stop' });
  finish({ ok: true, json: async () => ({ value: 'late-token' }) });
  await pending;
  assert.equal(w.captures.length, 0);
  assert.equal(w.memory.state.phase, 'idle');
});
test('rapid double start creates only one connection', async () => {
  const w = await worker();
  await w.send({ type: 'key', key: 'test' });
  const results = await Promise.all([w.send({ type: 'start', tabId: 1 }), w.send({ type: 'start', tabId: 1 })]);
  assert.equal(results.filter(r => r.error).length, 1);
  assert.equal(w.captures.length, 1);
  await w.send({ type: 'stop' });
});
test('capture failure closes offscreen and restores idle audio lifecycle', async () => {
  const w = await worker();
  w.chrome.tabCapture.getMediaStreamId = async () => { throw new Error('Capture denied'); };
  await w.send({ type: 'key', key: 'test' });
  await w.send({ type: 'start', tabId: 1 });
  assert.equal(w.open(), false);
  assert.match(w.memory.state.message, /Capture denied/);
});
test('offscreen mixer leaves outgoing source track untouched and closes it on failure', async () => {
  let listener, pc, stopped = false, closed = false, gainValue;
  const notices = [];
  const track = { stop: () => { stopped = true; }, addEventListener: () => {} };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  const output = { play: async () => {}, pause: () => {} };
  class AudioContext {
    currentTime = 0;
    destination = {};
    createGain() { return { gain: { setTargetAtTime: v => { gainValue = v; } }, connect: () => {} }; }
    createMediaStreamSource(s) { assert.equal(s, stream); return { connect: gain => gain }; }
    async resume() {}
    async close() { closed = true; }
  }
  class RTCPeerConnection {
    constructor() { pc = this; }
    addTrack(t) { assert.equal(t, track); }
    createDataChannel() { this.events = {}; return this.events; }
    async createOffer() { return { sdp: 'offer' }; }
    async setLocalDescription() {}
    async setRemoteDescription() { this.connectionState = 'connected'; this.onconnectionstatechange(); }
    close() {}
  }
  const chrome = { runtime: { id: 'test', onMessage: { addListener: fn => { listener = fn; } }, sendMessage: async m => notices.push(m) } };
  vm.runInNewContext((await readFile(new URL('../offscreen.js', import.meta.url), 'utf8')).replace(/^import .*\n/, ''), {
    chrome, apiError, languages, document: { querySelector: () => output }, navigator: { mediaDevices: { getUserMedia: async constraints => { assert.equal(constraints.audio.mandatory.chromeMediaSource, 'tab'); return stream; } } },
    AudioContext, RTCPeerConnection, AbortController, setTimeout, clearTimeout,
    fetch: async () => ({ ok: true, text: async () => 'answer' }),
  });
  listener({ target: 'audio', type: 'start', path: '/realtime/translations', streamId: 'test', secret: 'ephemeral', options: settings(), tabId: 1 }, { id: 'test' }, () => {});
  await tick();
  assert.equal(notices.at(-1).state.phase, 'live');
  listener({ target: 'audio', type: 'mix', options: settings({ original: 0, translated: 45 }) }, { id: 'test' }, () => {});
  assert.equal(gainValue, 0);
  assert.equal(output.volume, 0.45);
  assert.equal(track.enabled, undefined);
  pc.connectionState = 'failed'; pc.onconnectionstatechange();
  await tick();
  assert.equal(stopped, true); assert.equal(closed, true);
  assert.equal(notices.at(-1).state.phase, 'error');
});

test('Japanese selection survives normalization and sets the interpreter language', () => {
  const options = settings({ sourceLanguage: 'ja', mode: 'voice', voice: 'ash' });
  assert.equal(options.sourceLanguage, 'ja');
  const spec = sessionRequest(options);
  assert.match(spec.session.instructions, /Japanese-to-English/);
  assert.match(spec.session.instructions, /incoming Japanese speech/);
  assert.doesNotMatch(spec.session.instructions, /Korean/);
  assert.equal(spec.session.audio.output.voice, 'ash');
  assert.equal(settings({ sourceLanguage: 'unknown' }).sourceLanguage, 'ko');
  assert.equal(settings({ sourceLanguage: 'toString' }).sourceLanguage, 'ko');
});
test('continuous translation auto-detects source and always requests English output', () => {
  for (const sourceLanguage of ['ko', 'ja']) {
    const spec = sessionRequest(settings({ sourceLanguage }));
    assert.equal(spec.path, '/realtime/translations');
    assert.deepEqual(spec.session.audio, { output: { language: 'en' } });
  }
});
test('Japanese preference reaches both API configuration and capture document', async () => {
  let requested;
  const w = await worker(async (url, init) => {
    requested = JSON.parse(init.body);
    return { ok: true, json: async () => ({ value: 'test-token' }) };
  });
  await w.send({ type: 'settings', settings: { sourceLanguage: 'ja', mode: 'voice' } });
  await w.send({ type: 'key', key: 'test' });
  await w.send({ type: 'start', tabId: 1 });
  assert.match(requested.session.instructions, /Japanese-to-English/);
  assert.equal(w.messages.at(-1).options.sourceLanguage, 'ja');
  await w.send({ type: 'stop' });
});
