/* UCL CS Learning System: the Settings page (settings.html). The theme is kept in this browser by portal.js; everything else is saved by the local server. */
(function () {
  const SAVED_KEY = 'ucl-cs-settings-saved'; // tells other open pages, such as Scribe, to reload the settings
  const UNSAVED = 'You have unsaved changes.';
  const $ = (id) => document.getElementById(id);

  const ui = {
    form: $('ps-form'),
    offline: $('ps-offline'),
    xai: $('xai'),
    saving: $('saving'),
    bar: $('ps-bar'),
    intro: $('ps-intro'),
    key: $('ps-key'),
    model: $('ps-model'),
    custom: $('ps-model-custom'),
    modelsNote: $('ps-models-note'),
    price: $('ps-price'),
    budget: $('ps-budget'),
    test: $('ps-test'),
    testResult: $('ps-test-result'),
    folder: $('ps-folder'),
    choose: $('ps-choose'),
    folderResult: $('ps-folder-result'),
    saveTranscript: $('ps-save-transcript'),
    saveAudio: $('ps-save-audio'),
    transcriptFormat: $('ps-transcript-format'),
    audioFormat: $('ps-audio-format'),
    status: $('ps-status'),
    back: $('ps-back'),
    discard: $('ps-discard'),
    save: $('ps-save'),
  };

  const fromScribe = new URLSearchParams(location.search).get('from') === 'scribe';
  let server = null; // settings from the local server, or null if this page can't reach it
  let saved = ''; // the form as last loaded or saved, to spot unsaved changes
  let busy = false;
  let modelsRequest = 0;

  async function send(path, method, body) {
    const options = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) options.body = JSON.stringify(body);
    const res = await fetch(path, options);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
    return data;
  }

  function setStatus(el, message, kind = '') {
    el.textContent = message;
    el.className = `ui-result ${kind}`;
    if (el === ui.status) pinBar();
  }

  // The save bar sits after the form, and stays in view while there's something to save or say.
  function pinBar() {
    ui.bar.classList.toggle('pinned', dirty() || Boolean(ui.status.textContent));
  }

  // ---------- appearance ----------

  const themeRadios = document.querySelectorAll('input[name=ps-theme]');

  function showTheme() {
    const theme = window.portal.theme();
    themeRadios.forEach((radio) => { radio.checked = radio.value === theme; });
  }

  themeRadios.forEach((radio) => radio.addEventListener('change', () => window.portal.setTheme(radio.value)));
  document.addEventListener('portal:theme', showTheme); // the moon/sun button, or another tab
  showTheme();

  // ---------- xAI and saving: the form ----------

  function chosenModel() {
    const value = ui.model.value;
    return value === '__custom' ? ui.custom.value.trim() : value;
  }

  function renderModels(models, chosen) {
    const options = [['', 'Latest (xAI default)'], ...models.map((m) => [m, m]), ['__custom', 'Custom…']];
    ui.model.replaceChildren(...options.map(([value, label]) => new Option(label, value)));
    const isCustom = Boolean(chosen) && !models.includes(chosen);
    ui.model.value = isCustom ? '__custom' : chosen;
    ui.custom.value = isCustom ? chosen : ui.custom.value;
    ui.custom.hidden = !isCustom;
  }

  async function loadModels(refresh) {
    const id = ++modelsRequest;
    ui.modelsNote.textContent = 'Checking which models your key can use…';
    const body = { refresh };
    const key = ui.key.value.trim();
    if (key) body.api_key = key;
    try {
      const result = await send('/api/models', 'POST', body);
      if (id !== modelsRequest) return;
      renderModels(result.models, chosenModel());
      ui.modelsNote.textContent = result.message;
    } catch (err) {
      if (id === modelsRequest) ui.modelsNote.textContent = `Couldn’t check the models: ${err.message}`;
    }
  }

  function settingsBody(everything) {
    const body = { model: chosenModel() };
    if (everything) {
      body.price_per_hour = ui.price.value || 0;
      body.monthly_budget = ui.budget.value || 0;
      body.save_dir = ui.folder.value.trim();
      body.save_transcript = ui.saveTranscript.checked;
      body.save_audio = ui.saveAudio.checked;
      body.transcript_format = ui.transcriptFormat.value;
      body.audio_format = ui.audioFormat.value;
    }
    const key = ui.key.value.trim();
    if (key) body.api_key = key;
    return body;
  }

  function dirty() {
    return server !== null && JSON.stringify(settingsBody(true)) !== saved;
  }

  function syncFormats() {
    ui.transcriptFormat.disabled = !ui.saveTranscript.checked;
    ui.audioFormat.disabled = !ui.saveAudio.checked;
  }

  function updateBar(edited) {
    const changed = dirty();
    ui.save.disabled = busy || !changed;
    ui.discard.hidden = !changed;
    if (!edited && ui.status.classList.contains('error')) return pinBar(); // a failed save stays up until the next edit
    if (changed) setStatus(ui.status, UNSAVED);
    else if (ui.status.textContent === UNSAVED) setStatus(ui.status, '');
    pinBar();
  }

  // Put the server's settings into the form. The key field stays blank: the browser only ever sees its last 4 characters.
  function fill() {
    ui.intro.hidden = server.has_key;
    ui.key.value = '';
    ui.key.placeholder = server.has_key ? `Saved key ending ${server.key_hint.slice(1)} (leave blank to keep it)` : 'xai-…';
    ui.custom.value = '';
    renderModels(server.known_models, server.model);
    ui.price.value = server.price_per_hour;
    ui.budget.value = server.monthly_budget || '';
    ui.folder.value = server.save_dir;
    ui.saveTranscript.checked = server.save_transcript;
    ui.saveAudio.checked = server.save_audio;
    ui.transcriptFormat.value = server.transcript_format;
    ui.audioFormat.value = server.audio_format;
    syncFormats();
    saved = JSON.stringify(settingsBody(true));
    updateBar();
  }

  async function withBusy(resultEl, fn) {
    busy = true;
    ui.test.disabled = ui.save.disabled = true;
    try {
      await fn();
    } catch (err) {
      setStatus(resultEl, err.message, 'error');
    } finally {
      busy = false;
      ui.test.disabled = false;
      updateBar();
    }
  }

  ui.form.addEventListener('input', () => updateBar(true));
  ui.form.addEventListener('change', () => updateBar(true));
  ui.saveTranscript.addEventListener('change', syncFormats);
  ui.saveAudio.addEventListener('change', syncFormats);

  ui.model.addEventListener('change', () => {
    ui.custom.hidden = ui.model.value !== '__custom';
    if (!ui.custom.hidden) ui.custom.focus();
  });
  // A newly pasted key may unlock different models.
  ui.key.addEventListener('change', () => ui.key.value.trim().length >= 10 && loadModels(false));

  ui.test.addEventListener('click', () => withBusy(ui.testResult, async () => {
    setStatus(ui.testResult, 'Testing…');
    const result = await send('/api/settings/test', 'POST', settingsBody(false));
    setStatus(ui.testResult, result.message, result.ok ? 'ok' : 'error');
    if (result.ok) loadModels(true);
  }));

  // The server runs on this computer, so it can show the system's own folder picker.
  ui.choose.addEventListener('click', async () => {
    ui.choose.disabled = true;
    setStatus(ui.folderResult, 'Pick a folder in the window that opened. It may be behind this one.');
    try {
      const result = await send('/api/folder/choose', 'POST', { initial: ui.folder.value.trim() });
      if (result.path) ui.folder.value = result.path;
      setStatus(ui.folderResult, '');
    } catch (err) {
      setStatus(ui.folderResult, err.message, 'error');
    } finally {
      ui.choose.disabled = false;
      updateBar(true);
    }
  });

  ui.discard.addEventListener('click', () => {
    setStatus(ui.status, '');
    fill();
    setStatus(ui.testResult, '');
    setStatus(ui.folderResult, '');
  });

  // Save changes, or Enter in any field.
  ui.form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy || !dirty()) return;
    withBusy(ui.status, async () => {
      if (ui.model.value === '__custom' && !chosenModel()) throw new Error('Enter a model name, or pick another option.');
      server = await send('/api/settings', 'PUT', settingsBody(true));
      fill();
      setStatus(ui.status, fromScribe && server.has_key ? 'Saved. Scribe is ready to record.' : 'Saved.', 'ok');
      try {
        localStorage.setItem(SAVED_KEY, String(Date.now()));
      } catch (err) {
        // storage blocked: other open pages pick the changes up when they reload
      }
    });
  });

  window.addEventListener('beforeunload', (e) => {
    if (!dirty()) return;
    e.preventDefault();
    e.returnValue = '';
  });

  async function load() {
    try {
      server = location.protocol === 'file:' ? null : await send('/api/settings', 'GET');
    } catch (err) {
      server = null;
    }
    ui.offline.hidden = Boolean(server);
    ui.xai.hidden = ui.saving.hidden = ui.bar.hidden = !server;
    ui.back.hidden = !fromScribe;
    if (!server) return;
    fill();
    if (!server.has_key) ui.key.focus();
    else loadModels(false);
  }

  // Saved in another tab: show it here too, unless this tab has its own unsaved changes.
  window.addEventListener('storage', async (e) => {
    if (e.key !== SAVED_KEY || dirty()) return;
    try {
      server = await send('/api/settings', 'GET');
      fill();
    } catch (err) {
      // the server has stopped: keep what's shown
    }
  });

  load();
})();
