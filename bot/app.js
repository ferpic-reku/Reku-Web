(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  let session = null;
  let busy = false;
  let sendingMessage = false;
  let recorder = null;
  let stream = null;
  let recordTimer = null;
  let pendingAudio = null;
  let audioContext = null;
  let voiceTimer = null;
  let audibleSamples = 0;
  let discardRecording = false;
  let pendingMessage = null;
  let available = false;
  let visitEnded = false;
  let accessMessage = '';
  const welcome = [
    'Hola, bienvenido a Reku. Necesitamos que nos cuentes el motivo de tu consulta: si es una lesión o una dolencia que venís arrastrando, cómo empezó, en qué zona, cuánto te duele del 1 al 10 y desde hace cuánto tiempo.',
    'Podés escribirlo o, si te resulta más cómodo, mandar un audio.',
  ];
  const showError = (message = '') => { $('error').textContent = message; $('error').hidden = !message; };
  const api = async (path, body) => {
    const response = await fetch(`/api/bot/${path}`, {
      credentials: 'same-origin', cache: 'no-store',
      ...(body ? { method: 'POST', body: body instanceof FormData ? body : JSON.stringify(body), headers: body instanceof FormData ? {} : { 'Content-Type': 'application/json' } } : {}),
      signal: AbortSignal.timeout(125_000),
    });
    const data = await response.json().catch(() => { throw new Error('No pudimos conectar con el asistente. Intentá de nuevo en unos segundos.'); });
    if (!response.ok) throw new Error(data.error || 'No pudimos completar la solicitud. Intentá de nuevo.');
    return data;
  };
  const updateControls = () => {
    const recording = recorder?.state === 'recording';
    $('cancel-recording').hidden = !recording;
    $('send').hidden = Boolean(recording);
    $('send').disabled = busy || recording || !$('message').value.trim();
    $('message').disabled = (busy && !sendingMessage) || recording;
    $('record').disabled = busy;
    $('retry-audio').disabled = busy || recording;
    $('discard-audio').disabled = busy || recording;
    $('start').disabled = busy || !available || !$('consent').checked;
    $('typing').hidden = !busy || !session;
  };
  const setBusy = (value) => { busy = value; updateControls(); };
  const renderMessages = (messages) => {
    $('messages').replaceChildren();
    for (const message of messages) {
      const bubble = document.createElement('p');
      bubble.className = `bubble ${message.role === 'user' ? 'user' : ''}`;
      const label = document.createElement('span');
      label.className = 'message-label';
      label.textContent = message.role === 'user' ? 'VOS' : 'REKU';
      bubble.append(label, document.createTextNode(message.text));
      $('messages').append(bubble);
    }
    $('messages').scrollTop = $('messages').scrollHeight;
  };
  const brandPage = (brand) => {
    const cobranded = brand.cobranded && /^\/uploads\/agreements\/[\w.-]+$/.test(brand.logo_url || '');
    document.body.classList.toggle('cobranded', Boolean(cobranded));
    $('agreement-logo').hidden = !cobranded;
    if (cobranded) { $('agreement-logo').src = '/api/bot/logo'; $('agreement-logo').alt = brand.name; }
    $('brand-caption').textContent = brand.slug ? `${brand.name} · Telerehabilitación con Reku` : 'Reku · Telerehabilitación con acompañamiento profesional';
  };
  const render = () => {
    $('access-notice').hidden = !accessMessage;
    $('access-notice').textContent = accessMessage;
    $('messages').hidden = Boolean(accessMessage);
    renderMessages(session?.messages || welcome.map(text => ({ role: 'assistant', text })));
    $('start-panel').hidden = Boolean(session) || Boolean(accessMessage);
    const done = session && session.status !== 'collecting';
    $('composer').hidden = !session || done;
    $('result').hidden = !done;
    $('chat-status').textContent = done ? 'Tu relato quedó resumido' : 'Te acompañamos antes de la consulta';
    if (session) brandPage(session.brand);
    if (done) {
      $('result-title').textContent = session.status === 'partial' ? 'Tu informe parcial está listo' : 'Tu informe está listo';
      $('result').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    updateControls();
  };
  const clearAudio = () => {
    pendingAudio = null;
    $('audio-retry').hidden = true;
  };
  $('consent').addEventListener('change', updateControls);
  $('start').addEventListener('click', async () => {
    setBusy(true); showError();
    try {
      const created = (await api('session', { consent: true })).session;
      if (visitEnded) { closeSession(created); return; }
      session = created; render(); $('message').focus();
    }
    catch (error) { showError(error.message); }
    finally { setBusy(false); }
  });
  $('message').addEventListener('input', updateControls);
  $('message').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$('send').disabled) $('composer').requestSubmit(); }
  });
  const sendMessage = async (text, { fromAudio = false } = {}) => {
    sendingMessage = true;
    setBusy(true); showError();
    if (!pendingMessage || pendingMessage.text !== text || pendingMessage.version !== session.version) pendingMessage = { text, requestId: crypto.randomUUID(), version: session.version, instanceId: session.instanceId };
    renderMessages([...session.messages, { role: 'user', text }]);
    if (!fromAudio) $('message').value = '';
    updateControls(); $('message').focus();
    try {
      const updated = (await api('message', pendingMessage)).session;
      if (visitEnded) return;
      session = updated;
      const decisions = (session.followupDiagnostics || []).filter(item => item.turn === session.version);
      if (decisions.length) console.info('Reku: control de preguntas adicionales', { diagnosticId: session.diagnosticId, decisions });
      pendingMessage = null;
      render();
    } catch (error) {
      if (visitEnded) return;
      if (!fromAudio) $('message').value = [text, $('message').value].filter(Boolean).join('\n\n');
      renderMessages(session.messages); showError(error.message);
      if (fromAudio) throw error;
    }
    finally { sendingMessage = false; setBusy(false); }
  };
  $('composer').addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = $('message').value.trim();
    if (!text || busy || !session) return;
    await sendMessage(text);
  });
  const sendAudio = async () => {
    if (!pendingAudio || busy || recorder?.state === 'recording' || !session) return;
    const audio = pendingAudio;
    if (audio.file.size > 8 * 1024 * 1024) { showError('El audio debe pesar menos de 8 MB.'); return; }
    setBusy(true); showError(); $('audio-retry').hidden = true;
    try {
      if (!audio.text) {
        const form = new FormData(); form.append('audio', audio.file, audio.file.name || 'consulta.webm');
        const result = await api('transcribe', form);
        const text = typeof result.text === 'string' ? result.text.trim() : '';
        if (!text || text.length > 12000) throw new Error('No pudimos entender el audio. Probá grabar nuevamente.');
        audio.text = text;
      }
      if (visitEnded) return;
      await sendMessage(audio.text, { fromAudio: true });
      clearAudio();
    } catch (error) { if (!visitEnded) { showError(error.message); $('audio-retry').hidden = false; } }
    finally { setBusy(false); $('message').focus(); }
  };
  const closeAudioMeter = () => {
    clearInterval(voiceTimer);
    audioContext?.close().catch(() => {}); audioContext = null;
  };
  const stopRecording = (discard = false) => {
    discardRecording = discard;
    if (recorder?.state === 'recording') { setBusy(true); recorder.stop(); }
    stream?.getTracks().forEach(track => track.stop());
    closeAudioMeter();
    clearInterval(recordTimer); $('recording-note').hidden = true;
    $('record-label').textContent = 'Grabar audio'; $('record').classList.remove('recording');
    $('record').setAttribute('aria-label', 'Grabar audio');
    $('record').setAttribute('title', 'Grabar audio');
    updateControls();
  };
  $('record').addEventListener('click', async () => {
    if (recorder?.state === 'recording') { stopRecording(); return; }
    if (busy) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { showError('Este navegador no permite grabar. Podés escribir tu mensaje.'); return; }
    showError(); $('record').disabled = true;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) throw new Error('AUDIO_METER_UNAVAILABLE');
      audioContext = new AudioContext();
      await audioContext.resume();
      const analyser = audioContext.createAnalyser(); analyser.fftSize = 2048;
      audioContext.createMediaStreamSource(stream).connect(analyser);
      const samples = new Float32Array(analyser.fftSize); audibleSamples = 0;
      voiceTimer = setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
        if (rms > 0.008) audibleSamples++;
      }, 50);
      const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(t => MediaRecorder.isTypeSupported(t));
      recorder = new MediaRecorder(stream, { audioBitsPerSecond: 64000, ...(type ? { mimeType: type } : {}) });
      const chunks = []; discardRecording = false;
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = async () => {
        setBusy(false);
        if (!discardRecording && audibleSamples < 5) {
          showError('No detectamos voz. Tocá Grabar audio y probá nuevamente.');
        } else if (!discardRecording && chunks.length) {
          const mime = recorder.mimeType.split(';')[0];
          pendingAudio = { file: new File(chunks, `consulta.${mime.includes('mp4') ? 'm4a' : 'webm'}`, { type: mime }), text: '' };
          await sendAudio();
        }
      };
      recorder.onerror = () => { stopRecording(true); showError('No pudimos grabar. Podés intentar de nuevo o escribir tu mensaje.'); };
      recorder.start();
      const startedAt = Date.now(); $('timer').textContent = '0:00';
      recordTimer = setInterval(() => {
        const seconds = Math.floor((Date.now() - startedAt) / 1000);
        $('timer').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
        if (seconds >= 240) stopRecording();
      }, 500);
      $('recording-note').hidden = false; $('record-label').textContent = 'Enviar'; $('record').classList.add('recording');
      $('record').setAttribute('aria-label', 'Enviar audio');
      $('record').setAttribute('title', 'Enviar audio');
    } catch { closeAudioMeter(); stream?.getTracks().forEach(track => track.stop()); showError('No pudimos iniciar la grabación. Revisá el permiso del micrófono o escribí tu mensaje.'); }
    finally { updateControls(); }
  });
  $('cancel-recording').addEventListener('click', () => stopRecording(true));
  $('retry-audio').addEventListener('click', sendAudio);
  $('discard-audio').addEventListener('click', () => { if (busy) return; clearAudio(); showError(); updateControls(); });
  $('download').addEventListener('click', async () => {
    $('download').disabled = true; showError();
    try {
      const response = await fetch('/api/bot/report', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error((await response.json()).error);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a'); link.href = url; link.download = 'reku-motivo-de-consulta.pdf'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (error) { showError(error.message || 'No pudimos descargar el informe.'); }
    finally { $('download').disabled = false; }
  });
  const closeSession = (current) => {
    if (!current?.instanceId) return;
    const body = JSON.stringify({ instanceId: current.instanceId });
    try {
      if (navigator.sendBeacon?.('/api/bot/close', new Blob([body], { type: 'application/json' }))) return;
      fetch('/api/bot/close', { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/json' }, body }).catch(() => {});
    } catch { /* On abrupt exit, the next visit resets it; TTL is a final fallback. */ }
  };
  window.addEventListener('pagehide', () => {
    visitEnded = true;
    available = false;
    closeSession(session);
    stopRecording(true); clearAudio(); pendingMessage = null; session = null;
    $('message').value = ''; $('consent').checked = false;
    render();
  });
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
  const init = async () => {
    render();
    try {
      const linkToken = new URLSearchParams((location.hash || '').slice(1)).get('appointment');
      if (linkToken !== null) {
        // Private access tokens never remain in navigation/history or query URLs.
        history.replaceState(null, '', location.pathname + location.search);
        try { await api('access', { token: linkToken }); }
        catch (error) { accessMessage = error.message; available = false; render(); return; }
      }
      await api('reset', {});
      if (visitEnded) return;
      const context = await api('context');
      if (visitEnded) return;
      accessMessage = context.access?.allowed === false ? context.access.message : '';
      available = context.available && !accessMessage; brandPage(context.brand);
      session = null; $('message').value = ''; $('consent').checked = false; render();
      if (!available && !accessMessage) showError('El asistente todavía no está disponible.');
    } catch (error) { showError(error.message || 'No pudimos iniciar el asistente. Recargá la página.'); }
  };
  init();
})();
