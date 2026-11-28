'use strict';

window.QzuMedia = (() => {
  const barCount = 48;
  const speeds = [1, 1.25, 1.5, 2];
  const make = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
  };

  function timestamp(seconds) {
    const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
    return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
  }

  async function extractWaveform(blob) {
    const Audio = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Audio) return null;
    const context = new Audio(1, 1, 16000);
    const buffer = await context.decodeAudioData(await blob.arrayBuffer());
    const samples = buffer.getChannelData(0);
    const stride = Math.max(1, Math.ceil(samples.length / barCount));
    const peaks = new Float32Array(barCount);
    let max = 0;
    for (let i = 0; i < samples.length; i++) {
      const index = Math.floor(i / stride);
      peaks[index] = Math.max(peaks[index], Math.abs(samples[i]));
      max = Math.max(max, peaks[index]);
    }
    if (max > 0.005) for (let i = 0; i < peaks.length; i++) peaks[i] /= max;
    return peaks;
  }

  function voicePlayer(source, { duration } = {}) {
    const element = make('div', 'qzu-voice-player');
    const audio = make('audio');
    const toolbar = make('div', 'qzu-voice-toolbar');
    const play = make('button', 'secondary-button qzu-voice-play', 'Play');
    const speed = make('select', 'qzu-voice-speed');
    const timeline = make('div', 'qzu-voice-timeline');
    const wave = make('canvas', 'qzu-voice-track');
    const seek = make('input', 'qzu-voice-seek');
    const clock = make('span', 'qzu-voice-time');
    const status = make('p', 'qzu-media-alert');
    status.setAttribute('role', 'status');
    status.hidden = true;
    speed.setAttribute('aria-label', 'Playback speed');
    for (const rate of speeds) {
      const option = make('option', '', rate + '×');
      option.value = rate;
      speed.append(option);
    }
    seek.type = 'range';
    seek.min = '0';
    seek.max = '1000';
    seek.value = '0';
    seek.disabled = true;
    seek.setAttribute('aria-label', 'Seek voice message');
    wave.width = 360;
    wave.height = 44;
    wave.setAttribute('aria-hidden', 'true');
    play.type = 'button';
    audio.hidden = true;
    audio.preload = 'metadata';
    const url = source instanceof Blob ? URL.createObjectURL(source) : '';
    const knownDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
    let disposed = false;
    let analyzed = false;
    let failed = false;
    let peaks;
    let lastPosition = -1;

    function draw(position) {
      const ctx = wave.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, wave.width, wave.height);
      const color = getComputedStyle(wave).color || '#a6474d';
      for (let i = 0; i < barCount; i++) {
        const h = 4 + (peaks?.[i] || 0) * 34;
        ctx.globalAlpha = i / barCount < position ? 1 : 0.35;
        ctx.fillStyle = color;
        ctx.fillRect(i * wave.width / barCount + 1, (wave.height - h) / 2, 4, h);
      }
    }

    const totalTime = () => Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : knownDuration;
    function update() {
      if (disposed) return;
      const total = totalTime();
      const position = total ? Math.min(1, audio.currentTime / total) : 0;
      if (!seek.matches(':active')) seek.value = Math.round(position * 1000);
      seek.disabled = failed || !total || !audio.seekable.length;
      clock.textContent = timestamp(audio.currentTime) + ' / ' + (total ? timestamp(total) : '—:—');
      seek.setAttribute('aria-valuetext', clock.textContent);
      play.textContent = audio.paused ? 'Play' : 'Pause';
      play.disabled = failed;
      if (position !== lastPosition) {
        draw(position);
        lastPosition = position;
      }
      if (!analyzed && source instanceof Blob && total > 0 && total <= 120 && source.size <= 2 * 1024 * 1024) {
        analyzed = true;
        extractWaveform(source).then(values => {
          if (disposed) return;
          peaks = values;
          draw(lastPosition);
        }).catch(() => {});
      }
    }

    function showError(message) {
      status.textContent = message;
      status.hidden = false;
    }

    play.addEventListener('click', () => {
      if (!audio.paused) {
        audio.pause();
        return;
      }
      audio.play().catch(() => {
        if (!disposed) showError('Playback could not start. Try again.');
      });
    });
    speed.addEventListener('change', () => { audio.playbackRate = Number(speed.value); });
    seek.addEventListener('input', () => {
      const end = audio.seekable.length ? audio.seekable.end(audio.seekable.length - 1) : 0;
      if (end > 0) audio.currentTime = Math.min(end, totalTime() * Number(seek.value) / 1000);
      update();
    });
    audio.addEventListener('play', () => { status.hidden = true; update(); });
    for (const type of ['loadedmetadata', 'durationchange', 'timeupdate', 'progress', 'pause', 'ended']) audio.addEventListener(type, update);
    audio.addEventListener('error', () => {
      if (disposed) return;
      failed = true;
      showError('This recording could not be played.');
      update();
    });
    toolbar.append(play, clock, speed);
    timeline.append(wave, seek);
    element.append(toolbar, timeline, status, audio);
    audio.src = url || source;
    update();
    requestAnimationFrame(() => { if (!disposed) draw(lastPosition); });

    function dispose() {
      if (disposed) return;
      disposed = true;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      if (url) URL.revokeObjectURL(url);
      peaks = null;
      wave.width = 0;
      wave.height = 0;
    }

    return { element, dispose };
  }

  return Object.freeze({ voicePlayer });
})();
