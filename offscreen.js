import { apiError, languages } from './config.js';
let session;
const output = document.querySelector('#translated');
function publish(s, patch) {
  if (session !== s) return;
  Object.assign(s.state, patch);
  chrome.runtime.sendMessage({ target: 'worker', type: 'audio-state', state: s.state }).catch(() => {});
}
async function cleanup(s) {
  if (!s || s.closed) return;
  s.closed = true;
  clearTimeout(s.timeout);
  clearTimeout(s.disconnected);
  clearTimeout(s.transcriptTimer);
  s.abort.abort();
  s.pc?.close();
  s.stream?.getTracks().forEach(track => track.stop());
  output.pause();
  output.srcObject = null;
  await s.context?.close().catch(() => {});
}
async function fail(s, message) {
  if (s.closed) return;
  await cleanup(s);
  publish(s, { phase: 'error', message });
}
function mix(options) {
  if (session?.gain) session.gain.gain.setTargetAtTime(options.original / 100, session.context.currentTime, 0.02);
  output.volume = options.translated / 100;
}
async function start(message) {
  const s = session = { closed: false, abort: new AbortController(), state: { phase: 'connecting', message: 'Capturing this tab…', tabId: message.tabId, title: message.title, options: message.options, transcript: '' } };
  s.timeout = setTimeout(() => fail(s, 'Audio connection timed out. Stop and try again.'), 25000);
  try {
    s.stream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId } }, video: false });
    if (s.closed) { s.stream.getTracks().forEach(t => t.stop()); return; }
    s.context = new AudioContext({ latencyHint: 'interactive' });
    s.gain = s.context.createGain();
    s.context.createMediaStreamSource(s.stream).connect(s.gain).connect(s.context.destination);
    mix(message.options);
    await s.context.resume();
    const pc = s.pc = new RTCPeerConnection();
    // Send the raw capture, BEFORE the local volume mixer. English playback is
    // in this offscreen document, not the source tab, so it cannot feed back.
    s.stream.getAudioTracks().forEach(track => {
      pc.addTrack(track, s.stream);
      track.addEventListener('ended', () => fail(s, 'Tab capture ended. Start again to reconnect.'));
    });
    pc.ontrack = ({ streams, track }) => {
      if (s.closed) return;
      output.srcObject = streams[0] || new MediaStream([track]);
      output.play().catch(() => fail(s, 'Chrome blocked translated playback. Stop and start again.'));
    };
    pc.onconnectionstatechange = () => {
      if (s.closed) return;
      if (pc.connectionState === 'connected') {
        clearTimeout(s.timeout); clearTimeout(s.disconnected);
        publish(s, { phase: 'live', message: `Listening · ${languages[message.options.sourceLanguage || 'ko'].name} → English` });
      } else if (pc.connectionState === 'failed') fail(s, 'Audio connection failed. Check your network and start again.');
      else if (pc.connectionState === 'disconnected') {
        publish(s, { message: 'Connection interrupted…' });
        clearTimeout(s.disconnected);
        s.disconnected = setTimeout(() => fail(s, 'Audio connection lost. Start again.'), 8000);
      }
    };
    const events = pc.createDataChannel('oai-events');
    events.onclose = () => { if (!s.closed) fail(s, 'Translation session ended. Start again to continue.'); };
    events.onmessage = ({ data }) => {
      if (s.closed) return;
      let event;
      try { event = JSON.parse(data); } catch { return; }
      if (event.type === 'error') { fail(s, 'Translation service error. Try restarting or switching modes.'); return; }
      if (event.type === 'response.done' && event.response?.status === 'failed') { fail(s, 'Voice generation failed. Check your API limits and retry.'); return; }
      if (event.type === 'session.closed') { fail(s, 'Translation session ended. Start again.'); return; }
      if (['session.output_transcript.delta', 'response.output_audio_transcript.delta'].includes(event.type)) {
        s.state.transcript = (s.state.transcript + event.delta).slice(-1600);
        if (!s.transcriptTimer) s.transcriptTimer = setTimeout(() => { s.transcriptTimer = null; publish(s, {}); }, 150);
      }
      if (event.type === 'response.output_audio_transcript.done') s.state.transcript += '\n';
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const response = await fetch(`https://api.openai.com/v1${message.path}/calls`, { method: 'POST', headers: { Authorization: `Bearer ${message.secret}`, 'Content-Type': 'application/sdp' }, body: offer.sdp, signal: s.abort.signal });
    if (!response.ok) throw new Error(apiError(response.status));
    await pc.setRemoteDescription({ type: 'answer', sdp: await response.text() });
  } catch (error) { if (!s.closed) await fail(s, error.message || 'Could not capture tab audio.'); }
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || message.target !== 'audio') return;
  if (message.type === 'start') {
    if (session && !session.closed) { reply({ error: 'Audio already running.' }); return; }
    void start(message);
  } else if (message.type === 'mix') mix(message.options);
  reply({ ok: true });
});
