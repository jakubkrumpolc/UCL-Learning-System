/* Scribe: record speech, show the transcript live, and keep it. Talks to server/scribe.py through serve.py. */
(function () {
  const SUPPORTED_RATES = [8000, 16000, 22050, 24000, 44100, 48000];
  // Compressed formats the browser may record in, for the copy saved to the folder.
  const RECORDER_TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'];
  const SAVE_KEY = 'scribe-save-to-folder';
  const $ = (id) => document.getElementById(id);

  const ui = {
    list: $('session-list'),
    search: $('search'),
    title: $('title'),
    actions: $('session-actions'),
    exportTxt: $('export-txt'),
    exportMd: $('export-md'),
    language: $('language'),
    diarize: $('diarize'),
    save: $('save-toggle'),
    reveal: $('reveal-btn'),
    record: $('record-btn'),
    timer: $('timer'),
    liveCost: $('live-cost'),
    meter: $('meter-fill'),
    status: $('status'),
    transcript: $('transcript'),
    empty: $('empty'),
    segments: $('segments'),
    partial: $('partial'),
    settings: $('settings-btn'),
  };

  let state = 'idle'; // idle | connecting | live | stopping
  let sessionId = null;
  let segments = [];
  let audio = null; // { ctx, stream, node }
  let socket = null;
  let timerHandle = null;
  let settings = { has_key: false }; // from the local server; Settings itself is settings.html
  let usage = null;

  // ---------- helpers ----------

  function fmtTime(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const mm = String(m).padStart(2, '0'), ss = String(sec).padStart(2, '0');
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  function fmtMoney(usd) {
    if (usd > 0 && usd < 0.01) return `$${usd.toFixed(3)}`;
    return `$${usd.toFixed(2)}`;
  }

  function fmtDuration(seconds) {
    if (seconds < 60) return `${Math.round(seconds)} s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
    return `${(seconds / 3600).toFixed(1)} h`;
  }

  function fmtDate(iso) {
    return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function showStatus(message, isError = false) {
    ui.status.hidden = !message;
    ui.status.textContent = message || '';
    ui.status.classList.toggle('error', isError);
  }

  async function api(path, options = {}) {
    const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.status === 204 ? null : res.json();
  }

  function nearBottom() {
    const t = ui.transcript;
    return t.scrollHeight - t.scrollTop - t.clientHeight < 80;
  }

  function noteItem(text) {
    const li = document.createElement('li');
    li.className = 'sc-none';
    li.textContent = text;
    return li;
  }

  // ---------- rendering ----------

  function renderSegment(seg) {
    const li = document.createElement('li');
    const ts = document.createElement('span');
    ts.className = 'sc-ts';
    ts.textContent = fmtTime(seg.start_ms);
    const body = document.createElement('span');
    if (seg.speaker) {
      const chip = document.createElement('span');
      chip.className = 'sc-speaker';
      chip.textContent = seg.speaker;
      body.append(chip);
    }
    body.append(document.createTextNode(seg.text));
    li.append(ts, body);
    return li;
  }

  function renderTranscript() {
    ui.segments.replaceChildren(...segments.map(renderSegment));
    ui.empty.hidden = segments.length > 0 || state !== 'idle' || sessionId !== null;
  }

  function appendSegment(seg) {
    const stick = nearBottom();
    segments.push(seg);
    ui.segments.append(renderSegment(seg));
    ui.empty.hidden = true;
    if (stick) ui.transcript.scrollTop = ui.transcript.scrollHeight;
  }

  function setPartial(text) {
    const stick = nearBottom();
    ui.partial.textContent = text;
    if (stick) ui.transcript.scrollTop = ui.transcript.scrollHeight;
  }

  function setSessionHeader(session) {
    ui.title.value = session ? session.title : 'New recording';
    ui.title.disabled = !session;
    ui.actions.hidden = !session;
    $('session-head').hidden = !session;
    if (session) {
      ui.exportTxt.href = `/api/sessions/${session.id}/export?format=txt`;
      ui.exportMd.href = `/api/sessions/${session.id}/export?format=md`;
    }
    ui.reveal.hidden = !(session && (session.transcript_path || session.audio_path));
  }

  function setRecordButton() {
    const labels = { idle: 'Start', connecting: 'Connecting', live: 'Stop', stopping: 'Finishing' };
    $('record-label').textContent = labels[state];
    ui.record.classList.toggle('live', state === 'live');
    ui.record.disabled = state === 'connecting' || state === 'stopping';
    ui.language.disabled = ui.diarize.disabled = state !== 'idle';
    // Leaving the page would end the recording, so Settings opens in a new tab until it's over.
    ui.settings.target = state === 'idle' ? '' : '_blank';
    ui.settings.title = state === 'idle' ? 'Settings' : 'Settings (opens in a new tab while recording)';
    updateSaveToggle();
  }

  function canSave() {
    return Boolean(settings.save_transcript || settings.save_audio);
  }

  // "Save to folder" is read when a recording starts, and stays fixed until it ends.
  function updateSaveToggle() {
    ui.save.disabled = state !== 'idle' || !canSave();
    const what = [settings.save_transcript && 'transcript', settings.save_audio && 'audio'].filter(Boolean).join(' and ');
    $('save-control').title = canSave() ? `Saves the ${what} to ${settings.save_dir}` : 'Turn on saving in Settings first';
  }

  async function loadSessions() {
    const q = ui.search.value.trim();
    const sessions = await api(`/api/sessions${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    if (!sessions.length) {
      ui.list.replaceChildren(noteItem(q ? 'No matches.' : 'No recordings yet.'));
      return;
    }
    ui.list.replaceChildren(...sessions.map((s) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sc-session';
      btn.dataset.id = s.id;
      if (s.id === sessionId) btn.setAttribute('aria-current', 'true');
      const title = document.createElement('span');
      title.className = 'sc-name';
      title.textContent = s.title;
      const meta = document.createElement('span');
      meta.className = 'sc-meta';
      const spent = s.audio_seconds > 0 ? ` · ${fmtDuration(s.audio_seconds)} · ${fmtMoney(s.cost_usd)}` : '';
      meta.textContent = `${fmtDate(s.started_at)} · ${s.segment_count} lines${spent}${s.ended_at ? '' : ' · live'}`;
      const preview = document.createElement('span');
      preview.className = 'sc-preview';
      preview.textContent = s.preview || '—';
      btn.append(title, meta, preview);
      li.append(btn);
      return li;
    }));
  }

  async function openSession(id) {
    const data = await api(`/api/sessions/${id}`);
    sessionId = data.id;
    segments = data.segments;
    setSessionHeader(data);
    setPartial('');
    showStatus('');
    renderTranscript();
    ui.timer.textContent = data.audio_seconds ? fmtTime(data.audio_seconds * 1000) : '00:00';
    showLiveCost(data.audio_seconds ? data.cost_usd : null);
    loadSessions();
  }

  function showLiveCost(usd) {
    ui.liveCost.hidden = usd === null;
    if (usd !== null) ui.liveCost.textContent = fmtMoney(usd);
  }

  function newSession() {
    sessionId = null;
    segments = [];
    setSessionHeader(null);
    setPartial('');
    showStatus('');
    ui.timer.textContent = '00:00';
    showLiveCost(null);
    renderTranscript();
    loadSessions();
  }

  // ---------- recording ----------

  function recorderType() {
    if (!window.MediaRecorder) return '';
    return RECORDER_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) || '';
  }

  // The folder copy of the audio is compressed by the browser and sent a second at a time,
  // so a recording cut off early still keeps what came before.
  let fileRecorder = null; // { recorder, stopped, chain }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(',') + 1));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  function startFileRecorder() {
    const type = recorderType();
    if (!type) return;
    const recorder = new MediaRecorder(audio.stream, { mimeType: type, audioBitsPerSecond: 32000 });
    const entry = { recorder, chain: Promise.resolve() };
    recorder.ondataavailable = ({ data }) => {
      if (!data.size) return;
      entry.chain = entry.chain
        .then(() => blobToBase64(data))
        .then((chunk) => {
          if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'audio-file', data: chunk }));
        })
        .catch(() => {});
    };
    entry.stopped = new Promise((resolve) => { recorder.onstop = resolve; });
    recorder.start(1000);
    fileRecorder = entry;
  }

  // Stop recording the folder copy, and wait until its last piece has been sent.
  async function stopFileRecorder() {
    const entry = fileRecorder;
    fileRecorder = null;
    if (!entry) return;
    if (entry.recorder.state !== 'inactive') entry.recorder.stop();
    await entry.stopped;
    await entry.chain;
  }

  async function startAudio() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    let ctx = new AudioContext();
    if (!SUPPORTED_RATES.includes(ctx.sampleRate)) {
      await ctx.close();
      ctx = new AudioContext({ sampleRate: 16000 });
    }
    await ctx.audioWorklet.addModule('assets/pcm-worklet.js');
    const node = new AudioWorkletNode(ctx, 'pcm-capture');
    return { ctx, stream, node };
  }

  function connectAudio() {
    const { ctx, stream, node } = audio;
    const source = ctx.createMediaStreamSource(stream);
    const mute = ctx.createGain();
    mute.gain.value = 0; // keep the graph pulling audio without playing it back
    source.connect(node);
    node.connect(mute).connect(ctx.destination);
    node.port.onmessage = ({ data }) => {
      if (socket && socket.readyState === WebSocket.OPEN && state === 'live') socket.send(data.pcm);
      ui.meter.style.width = `${Math.min(100, data.level * 140)}%`;
    };
  }

  function stopAudio() {
    if (!audio) return;
    audio.node.port.onmessage = null;
    audio.stream.getTracks().forEach((t) => t.stop());
    audio.ctx.close();
    audio = null;
    ui.meter.style.width = '0';
  }

  async function start() {
    state = 'connecting';
    setRecordButton();
    showStatus('');
    try {
      audio = await startAudio();
    } catch (err) {
      state = 'idle';
      setRecordButton();
      showStatus(`Microphone unavailable: ${err.message}`, true);
      return;
    }

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${proto}://${location.host}/ws/transcribe`);
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => socket.send(JSON.stringify({
      type: 'start',
      sample_rate: audio.ctx.sampleRate,
      language: ui.language.value,
      diarize: ui.diarize.checked,
      save: ui.save.checked && canSave(),
      audio_type: recorderType(),
    }));
    socket.onmessage = (e) => onServerMessage(JSON.parse(e.data));
    socket.onclose = () => finish();
  }

  async function stop() {
    if (state !== 'live') return;
    state = 'stopping';
    setRecordButton();
    await stopFileRecorder();
    stopAudio();
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'stop' }));
  }

  function finish() {
    if (fileRecorder && fileRecorder.recorder.state !== 'inactive') fileRecorder.recorder.stop();
    fileRecorder = null;
    stopAudio();
    clearInterval(timerHandle);
    socket = null;
    if (state === 'connecting' && !ui.status.classList.contains('error')) {
      showStatus('Lost connection to the local server.', true);
    }
    state = 'idle';
    setRecordButton();
    setPartial('');
    loadSessions();
    loadUsage();
  }

  function onServerMessage(msg) {
    switch (msg.type) {
      case 'ready': {
        state = 'live';
        sessionId = msg.session.id;
        segments = [];
        setSessionHeader(msg.session);
        renderTranscript();
        connectAudio();
        if (msg.saving && msg.saving.audio === 'recorder') startFileRecorder();
        setRecordButton();
        const t0 = Date.now();
        const pricePerMs = msg.price_per_hour / 3600000;
        ui.timer.textContent = '00:00';
        showLiveCost(0);
        timerHandle = setInterval(() => {
          const elapsed = Date.now() - t0;
          ui.timer.textContent = fmtTime(elapsed);
          showLiveCost(elapsed * pricePerMs);
        }, 500);
        loadSessions();
        break;
      }
      case 'partial':
        setPartial(msg.text);
        break;
      case 'final':
        appendSegment(msg.segment);
        break;
      case 'done':
        showStatus('');
        showLiveCost(msg.usage.cost_usd);
        ui.timer.textContent = fmtTime(msg.usage.audio_seconds * 1000);
        if (msg.saved && msg.saved.problem) showStatus(msg.saved.problem, true);
        else if (msg.saved) showStatus(`Saved to ${msg.saved.folder}: ${msg.saved.files.join(' and ')}.`);
        break;
      case 'save-error':
        showStatus(msg.message, true); // the recording carries on; Scribe's own copy is fine
        break;
      case 'error':
        showStatus(msg.message, true);
        if (state === 'live') stop();
        break;
    }
  }

  // ---------- events ----------

  try {
    ui.save.checked = localStorage.getItem(SAVE_KEY) !== 'off';
  } catch (err) {
    // storage blocked: keep the default (on)
  }
  ui.save.addEventListener('change', () => {
    try {
      localStorage.setItem(SAVE_KEY, ui.save.checked ? 'on' : 'off');
    } catch (err) {
      // storage blocked: the choice still applies until the page reloads
    }
  });

  ui.reveal.addEventListener('click', async () => {
    try {
      await api(`/api/sessions/${sessionId}/reveal`, { method: 'POST' });
    } catch (err) {
      showStatus('The saved files have been moved or deleted.', true);
    }
  });

  ui.record.addEventListener('click', () => {
    if (state !== 'idle') return stop();
    if (!settings.has_key) return location.assign('settings.html?from=scribe');
    const budget = usage && usage.monthly_budget;
    if (budget && usage.month.cost >= budget &&
        !confirm(`You've spent about ${fmtMoney(usage.month.cost)} this month, which reaches your ${fmtMoney(budget)} budget. Start anyway?`)) {
      return;
    }
    start();
  });
  $('new-btn').addEventListener('click', () => state === 'idle' && newSession());

  ui.list.addEventListener('click', (e) => {
    const item = e.target.closest('[data-id]');
    if (!item) return;
    if (state !== 'idle') return showStatus('Stop the current recording before opening another one.');
    openSession(Number(item.dataset.id));
  });

  let searchTimer;
  ui.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadSessions, 250);
  });

  ui.title.addEventListener('change', async () => {
    const title = ui.title.value.trim();
    if (!sessionId || !title) return;
    await api(`/api/sessions/${sessionId}`, { method: 'PATCH', body: JSON.stringify({ title }) });
    loadSessions();
  });
  ui.title.addEventListener('keydown', (e) => e.key === 'Enter' && ui.title.blur());

  $('copy-btn').addEventListener('click', async () => {
    const text = segments.map((s) => `[${fmtTime(s.start_ms)}]${s.speaker ? ` ${s.speaker}:` : ''} ${s.text}`).join('\n');
    await navigator.clipboard.writeText(text);
    showStatus('Transcript copied to clipboard.');
    setTimeout(() => showStatus(''), 2000);
  });

  $('delete-btn').addEventListener('click', async () => {
    if (!sessionId || state !== 'idle') return;
    if (!confirm("Delete this transcript from Scribe? This can't be undone. Files already saved to your folder are kept.")) return;
    await api(`/api/sessions/${sessionId}`, { method: 'DELETE' });
    newSession();
  });

  // ---------- settings (the portal's Settings page, settings.html) ----------

  function showSettings() {
    $('no-key').hidden = settings.has_key;
    updateSaveToggle();
  }

  // Settings saved in another tab, or this page shown again with Back: use what's saved now.
  async function reloadSettings() {
    if (!$('offline').hidden) return;
    try {
      settings = await api('/api/settings');
    } catch (err) {
      return; // the server has stopped: keep what's shown
    }
    showSettings();
    loadUsage();
  }

  window.addEventListener('storage', (e) => e.key === 'ucl-cs-settings-saved' && reloadSettings());
  window.addEventListener('pageshow', (e) => e.persisted && reloadSettings());

  window.addEventListener('beforeunload', (e) => {
    if (state === 'idle') return;
    e.preventDefault();
    e.returnValue = '';
  });

  // ---------- usage ----------

  async function loadUsage() {
    usage = await api('/api/usage');
    const { month, monthly_budget: budget } = usage;
    const card = $('usage-card');
    $('usage-month').textContent = fmtMoney(month.cost);
    $('usage-bar-wrap').hidden = !budget;
    card.classList.toggle('over', Boolean(budget) && month.cost >= budget);
    if (budget) {
      $('usage-bar').style.width = `${Math.min(100, (month.cost / budget) * 100)}%`;
      $('usage-sub').textContent = `${fmtMoney(month.cost)} of ${fmtMoney(budget)} budget · ${fmtDuration(month.seconds)}`;
    } else {
      $('usage-sub').textContent = `${fmtDuration(month.seconds)} transcribed · estimate`;
    }
  }

  function openUsage() {
    for (const period of ['today', 'month', 'total']) {
      $(`u-${period}-cost`).textContent = fmtMoney(usage[period].cost);
      $(`u-${period}-time`).textContent = `${fmtDuration(usage[period].seconds)} · ${usage[period].sessions} recordings`;
    }
    const budget = usage.monthly_budget;
    const budgetLine = $('u-budget');
    budgetLine.hidden = !budget;
    if (budget) {
      const left = budget - usage.month.cost;
      budgetLine.textContent = left >= 0
        ? `${fmtMoney(left)} left of your ${fmtMoney(budget)} monthly budget.`
        : `${fmtMoney(-left)} over your ${fmtMoney(budget)} monthly budget.`;
      budgetLine.classList.toggle('over', left < 0);
    }
    $('u-price').textContent = fmtMoney(usage.price_per_hour);

    const rows = usage.days.map((d) => {
      const tr = document.createElement('tr');
      const day = new Date(`${d.day}T00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
      for (const text of [day, d.sessions, fmtDuration(d.seconds), fmtMoney(d.cost)]) {
        const td = document.createElement('td');
        td.textContent = text;
        tr.append(td);
      }
      return tr;
    });
    if (!rows.length) {
      const tr = document.createElement('tr');
      tr.className = 'empty-row';
      tr.innerHTML = '<td colspan="4">No recordings in the last 30 days.</td>';
      rows.push(tr);
    }
    $('u-days').replaceChildren(...rows);
    $('usage').showModal();
  }

  $('usage-card').addEventListener('click', async () => {
    await loadUsage();
    openUsage();
  });
  $('usage-close').addEventListener('click', () => $('usage').close());

  // ---------- start up ----------

  // Opened as a file, or served by something other than start.py.
  function showOffline() {
    $('offline').hidden = false;
    ui.empty.hidden = true;
    ui.record.disabled = ui.language.disabled = ui.diarize.disabled = ui.save.disabled = true;
    $('new-btn').disabled = ui.search.disabled = true;
    $('usage-card').hidden = true;
    ui.list.replaceChildren(noteItem('Your recordings show here once the local server is running.'));
  }

  async function init() {
    setRecordButton();
    if (location.protocol === 'file:') return showOffline();
    try {
      settings = await api('/api/settings');
    } catch (err) {
      return showOffline();
    }
    showSettings();
    loadSessions();
    loadUsage();
  }

  init();
})();
