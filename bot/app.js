(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const query = new URLSearchParams(location.search);
  const suffix = query.has('form') ? `?form=${encodeURIComponent(query.get('form'))}` : '';
  let session = null;
  let busy = false;
  let recorder = null;
  let stream = null;
  let recordTimer = null;
  let audioUrl = null;
  let discardRecording = false;
  let pendingMessage = null;
  let available = false;
  const welcome = [
    'Hola, bienvenido a Reku. Necesitamos que nos cuentes el motivo de tu consulta: si es una lesión o una dolencia que venís arrastrando, cómo empezó, en qué zona, cuánto te duele del 1 al 10 y desde hace cuánto tiempo.',
    'Podés escribirlo o, si te resulta más cómodo, mandar un audio.',
  ];
  const showError = (message = '') => { $('error').textContent = message; $('error').hidden = !message; };
  const api = async (path, body) => {
    const response = await fetch(`/api/bot/${path}${suffix}`, {
      credentials: 'same-origin', cache: 'no-store',
      ...(body ? { method: 'POST', body: body instanceof FormData ? body : JSON.stringify(body), headers: body instanceof FormData ? {} : { 'Content-Type': 'application/json' } } : {}),
      signal: AbortSignal.timeout(75_000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'No pudimos completar la solicitud. Intentá de nuevo.');
    return data;
  };
  const updateControls = () => {
    const recording = recorder?.state === 'recording';
    $('send').disabled = busy || recording || !$('message').value.trim();
    $('message').disabled = busy || recording;
    $('record').disabled = busy;
    $('attach').disabled = busy || recording;
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
    if (cobranded) { $('agreement-logo').src = `/api/bot/logo${suffix}`; $('agreement-logo').alt = brand.name; }
    $('brand-caption').textContent = brand.slug ? `${brand.name} · Telerehabilitación con Reku` : 'Reku · Telerehabilitación con acompañamiento profesional';
  };
  const row = (list, label, value) => {
    const dt = document.createElement('dt'); dt.textContent = label;
    const dd = document.createElement('dd'); dd.textContent = value || 'No informado';
    list.append(dt, dd);
  };
  const render = () => {
    renderMessages(session?.messages || welcome.map(text => ({ role: 'assistant', text })));
    $('start-panel').hidden = Boolean(session);
    const done = session && session.status !== 'collecting';
    $('composer').hidden = !session || done;
    $('result').hidden = !done;
    $('step-talk').classList.toggle('active', !session?.version);
    $('step-detail').classList.toggle('active', Boolean(session?.version && !done));
    $('step-report').classList.toggle('active', Boolean(done));
    $('chat-status').textContent = done ? 'Tu relato quedó resumido' : 'Te acompañamos antes de la consulta';
    if (session) brandPage(session.brand);
    if (done) {
      $('result-title').textContent = session.status === 'urgent' ? 'Priorizá una evaluación presencial' : session.status === 'partial' ? 'Tu informe parcial está disponible' : 'Ya está listo tu informe';
      $('summary').replaceChildren();
      session.data.complaints.forEach((item, index) => {
        if (session.data.complaints.length > 1) { const h = document.createElement('h4'); h.textContent = `Motivo ${index + 1}`; $('summary').append(h); }
        const list = document.createElement('dl');
        row(list, 'Motivo', item.reason);
        row(list, 'Zona', [item.location, item.side].filter(Boolean).join(' · '));
        row(list, 'Desde cuándo', item.onset);
        row(list, 'Cómo empezó', item.mechanism);
        row(list, 'Dolor actual', item.pain !== null ? `${item.pain}/10` : item.painNote);
        $('summary').append(list);
      });
      $('result').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    updateControls();
  };
  const clearAudio = () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = null;
    $('audio-preview').removeAttribute('src');
    $('audio-review').hidden = true;
  };
  $('consent').addEventListener('change', updateControls);
  $('start').addEventListener('click', async () => {
    setBusy(true); showError();
    try { session = (await api('session', { consent: true })).session; render(); $('message').focus(); }
    catch (error) { showError(error.message); }
    finally { setBusy(false); }
  });
  $('message').addEventListener('input', updateControls);
  $('message').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$('send').disabled) $('composer').requestSubmit(); }
  });
  $('composer').addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = $('message').value.trim();
    if (!text || busy || !session) return;
    setBusy(true); showError();
    if (!pendingMessage || pendingMessage.text !== text || pendingMessage.version !== session.version) pendingMessage = { text, requestId: crypto.randomUUID(), version: session.version, instanceId: session.instanceId };
    renderMessages([...session.messages, { role: 'user', text }]);
    try {
      session = (await api('message', pendingMessage)).session;
      pendingMessage = null;
      $('message').value = ''; clearAudio(); render();
    } catch (error) { renderMessages(session.messages); showError(error.message); }
    finally { setBusy(false); }
  });
  const transcribe = async (file) => {
    if (file.size > 8 * 1024 * 1024) { showError('El audio debe pesar menos de 8 MB.'); return; }
    setBusy(true); showError(); clearAudio();
    try {
      const form = new FormData(); form.append('audio', file, file.name || 'consulta.webm');
      const { text } = await api('transcribe', form);
      const combined = [$('message').value.trim(), text].filter(Boolean).join('\n');
      if (combined.length > 4000) throw new Error('El texto y el audio juntos superan los 4000 caracteres. Enviá primero el texto y después el audio.');
      $('message').value = combined;
      audioUrl = URL.createObjectURL(file); $('audio-preview').src = audioUrl;
      $('audio-review').hidden = false;
    } catch (error) { showError(error.message); }
    finally { setBusy(false); $('message').focus(); }
  };
  $('attach').addEventListener('click', () => $('audio-file').click());
  $('audio-file').addEventListener('change', async () => {
    const file = $('audio-file').files[0]; $('audio-file').value = '';
    if (file) await transcribe(file);
  });
  const stopRecording = (discard = false) => {
    discardRecording = discard;
    if (recorder?.state === 'recording') recorder.stop();
    stream?.getTracks().forEach(track => track.stop());
    clearInterval(recordTimer); $('recording-note').hidden = true;
    $('record-label').textContent = 'Grabar audio'; $('record').classList.remove('recording');
    $('record').setAttribute('aria-label', 'Grabar audio');
    updateControls();
  };
  $('record').addEventListener('click', async () => {
    if (recorder?.state === 'recording') { stopRecording(); return; }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { showError('Este navegador no permite grabar. Podés adjuntar un audio o escribir.'); return; }
    showError(); $('record').disabled = true;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(t => MediaRecorder.isTypeSupported(t));
      recorder = new MediaRecorder(stream, type ? { mimeType: type } : {});
      const chunks = []; discardRecording = false;
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = () => {
        if (!discardRecording && chunks.length) {
          const mime = recorder.mimeType.split(';')[0];
          transcribe(new File(chunks, `consulta.${mime.includes('mp4') ? 'm4a' : 'webm'}`, { type: mime }));
        }
      };
      recorder.onerror = () => { stopRecording(true); showError('No pudimos grabar. Podés adjuntar un audio o escribir.'); };
      recorder.start();
      const startedAt = Date.now(); $('timer').textContent = '0:00';
      recordTimer = setInterval(() => {
        const seconds = Math.floor((Date.now() - startedAt) / 1000);
        $('timer').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
        if (seconds >= 120) stopRecording();
      }, 500);
      $('recording-note').hidden = false; $('record-label').textContent = 'Detener'; $('record').classList.add('recording');
      $('record').setAttribute('aria-label', 'Detener grabación');
    } catch { stream?.getTracks().forEach(track => track.stop()); showError('No pudimos acceder al micrófono. Revisá el permiso del navegador o adjuntá un audio.'); }
    finally { updateControls(); }
  });
  $('cancel-recording').addEventListener('click', () => stopRecording(true));
  $('discard-audio').addEventListener('click', () => { clearAudio(); $('message').value = ''; updateControls(); });
  $('download').addEventListener('click', async () => {
    $('download').disabled = true; showError();
    try {
      const response = await fetch(`/api/bot/report${suffix}`, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error((await response.json()).error);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a'); link.href = url; link.download = 'reku-motivo-de-consulta.pdf'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (error) { showError(error.message || 'No pudimos descargar el informe.'); }
    finally { $('download').disabled = false; }
  });
  $('restart').addEventListener('click', () => { session = null; pendingMessage = null; $('consent').checked = false; $('message').value = ''; clearAudio(); render(); showError(); });
  window.addEventListener('pagehide', () => { stopRecording(true); clearAudio(); });
  const init = async () => {
    render();
    try {
      const context = await api('context'); available = context.available; brandPage(context.brand);
      session = (await api('session')).session; render();
      if (!available) showError('El asistente todavía no está disponible.');
    } catch (error) { showError(error.message || 'No pudimos iniciar el asistente. Recargá la página.'); }
  };
  init();
})();
