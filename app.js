const BASE_NAME = 'Moving + Packing 2026';
const TABLE = 'Containers';
const ROOMS = 'Destination Room';
const API = 'https://api.airtable.com/v0';
// Boxes also carry product barcodes. Only accept our own labels.
const BOX_ID = /^[A-Z]{2}[0-9]+$/;
// Only loaded when the browser has no native Code 128 detector (e.g. Safari).
const POLYFILL =
    'https://cdn.jsdelivr.net/npm/barcode-detector@3.2.2/dist/es/ponyfill.js';
const CAMERA = {
  video: {facingMode: 'environment', width: {ideal: 1920}, height: {ideal: 1080}},
};
// Each sound is a list of [frequency in Hz, duration in s] tones.
const SOUNDS = {
  scan: [[1800, 0.08]],
  accept: [[660, 0.04], [990, 0.04]],
  reject: [[180, 0.08]],
  warn: [[1200, 0.02], [600, 0.02], [1200, 0.02], [600, 0.02]],
};
// A box often stays in view after review. Skip it until it leaves the view.
const IGNORE_MS = 2000;

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Not all detectors read white-on-black labels, so every other frame is
// inverted before detection.
const invertContext = document.createElement('canvas').getContext('2d');

let token = localStorage.getItem('airtableToken');
let baseId;
let detector;
let audio;
let stream;
let field;
let value;
let label;
let ignored;
// Lists of box records by code, loaded when the action starts.
let boxes;
// Box codes accepted since the action started.
let accepted;
// Updates not yet saved in Airtable. Failed updates stay for a retry.
let queue = JSON.parse(localStorage.getItem('queue') ?? '[]');
let submitting = false;
let invertNext = false;
let lastBoxes;

function show(id) {
  for (const section of document.querySelectorAll('body > section')) {
    section.hidden = section.id !== id;
  }
}

async function airtable(path, options) {
  const response = await fetch(`${API}/${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = body.error;
    throw new Error(error?.message ?? error?.type ?? error ?? response.status);
  }
  return body;
}

async function init() {
  renderQueue();
  if (!token) {
    show('setup');
    return;
  }
  try {
    // These rarely change, so they are fetched only once per token.
    baseId = await cached('baseId', findBase);
    const rooms = await cached('rooms', loadRooms);
    $('room').replaceChildren(
        ...rooms.map(({id, name}) => new Option(name, id)));
    show('actions');
  } catch (error) {
    $('setup-error').textContent = error.message;
    show('setup');
  }
}

async function cached(key, load) {
  const stored = localStorage.getItem(key);
  if (stored) return JSON.parse(stored);
  const result = await load();
  localStorage.setItem(key, JSON.stringify(result));
  return result;
}

async function findBase() {
  const {bases} = await airtable('meta/bases');
  const id = bases.find((base) => base.name === BASE_NAME)?.id;
  if (!id) throw new Error(`Base "${BASE_NAME}" not found.`);
  return id;
}

async function loadRooms() {
  const params = new URLSearchParams({
    'fields[]': 'Name',
    'sort[0][field]': 'Name',
  });
  const {records} = await airtable(`${baseId}/${ROOMS}?${params}`);
  return records.map(({id, fields}) => ({id, name: fields.Name}));
}

async function createDetector() {
  const formats = await globalThis.BarcodeDetector?.getSupportedFormats();
  const Detector = formats?.includes('code_128') ?
      BarcodeDetector :
      (await import(POLYFILL)).BarcodeDetector;
  return new Detector({formats: ['code_128']});
}

function beep(name) {
  let time = audio.currentTime;
  for (const [frequency, duration] of SOUNDS[name]) {
    const oscillator = new OscillatorNode(audio, {type: 'square', frequency});
    oscillator.connect(new GainNode(audio, {gain: 0.1}))
        .connect(audio.destination);
    oscillator.start(time);
    time += duration;
    oscillator.stop(time);
  }
}

async function startScanning(fieldName, fieldValue, actionLabel) {
  field = fieldName;
  value = fieldValue;
  label = actionLabel;
  ignored = {};
  accepted = new Set();
  lastBoxes = [];
  // iOS only plays audio from a context that a user gesture started.
  audio ??= new AudioContext();
  audio.resume();
  $('action-label').textContent = label;
  $('log').replaceChildren();
  showLasers([]);
  $('torch').hidden = true;
  $('torch').ariaPressed = 'false';
  show('scanner');
  try {
    boxes = await loadBoxes();
    detector ??= await createDetector();
    stream = await navigator.mediaDevices.getUserMedia(CAMERA);
    // The user can tap Done while the camera starts.
    if ($('scanner').hidden) return stopScanning();
    $('video').srcObject = stream;
    await $('video').play();
    const [track] = stream.getVideoTracks();
    $('torch').hidden = !track.getCapabilities?.().torch;
    await scan(stream);
  } catch (error) {
    alert(error.message);
    stopScanning();
  }
}

function stopScanning() {
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  show('actions');
}

async function scan(activeStream) {
  while (true) {
    const code = await detectBoxId();
    if (stream !== activeStream) return;
    if (code) await review(code);
    await sleep(100);
  }
}

async function detectBoxId() {
  const video = $('video');
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
  const now = Date.now();
  const frame = invertNext ? invertedFrame(video) : video;
  invertNext = !invertNext;
  const boxes = (await detector.detect(frame))
      .filter(({rawValue}) => BOX_ID.test(rawValue));
  // A label often shows up in only the normal or only the inverted frames, so
  // show lasers on the labels of the last two frames.
  const shown = new Map(
      [...lastBoxes, ...boxes].map((box) => [box.rawValue, box]));
  showLasers([...shown.values()]);
  lastBoxes = boxes;
  for (const {rawValue} of boxes) {
    if (rawValue === ignored.code && now - ignored.seenAt < IGNORE_MS) {
      ignored.seenAt = now;
      continue;
    }
    return rawValue;
  }
  return null;
}

function invertedFrame(video) {
  const {canvas} = invertContext;
  // Resizing also resets the context state.
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  invertContext.drawImage(video, 0, 0);
  invertContext.globalCompositeOperation = 'difference';
  invertContext.fillStyle = 'white';
  invertContext.fillRect(0, 0, canvas.width, canvas.height);
  return canvas;
}

function showLasers(barcodes) {
  const video = $('video');
  $('laser').setAttribute(
      'viewBox', `0 0 ${video.videoWidth} ${video.videoHeight}`);
  const path = (barcode) =>
      `M${laser(barcode).map(({x, y}) => `${x},${y}`).join(' ')}`;
  $('laser').firstElementChild.setAttribute('d', barcodes.map(path).join(''));
}

// The polyfill reads one row of pixels at a time. Its corners are the ends of
// the first and last rows it read, so only its sides follow the bars. Returns
// the ends of a line across the bars through the middle of the barcode.
function laser({cornerPoints: [tl, tr, br, bl]}) {
  const rotation = new DOMMatrix().rotateFromVector(
      bl.x - tl.x + br.x - tr.x, bl.y - tl.y + br.y - tr.y);
  const unrotation = rotation.inverse();
  const points = [tl, tr, br, bl].map((p) => unrotation.transformPoint(p));
  const xs = points.map(({x}) => x);
  const ys = points.map(({y}) => y);
  const x = (Math.min(...xs) + Math.max(...xs)) / 2;
  const [minY, maxY] = [Math.min(...ys), Math.max(...ys)];
  // Like a laser, the line runs a bit past both ends.
  const overshoot = (maxY - minY) / 10;
  return [minY - overshoot, maxY + overshoot]
      .map((y) => rotation.transformPoint({x, y}));
}

async function review(code) {
  // Holds the image so that the boxes stay on their barcodes.
  $('video').pause();
  beep(accepted.has(code) ? 'warn' : 'scan');
  $('box-code').textContent = code;
  $('reject').disabled = false;
  // Stopping now would leave this review open.
  $('done').disabled = true;
  const decided = new Promise((resolve) => {
    $('reject').onclick = () => resolve('reject');
    $('accept').onclick = () => resolve('accept');
  });

  let record;
  try {
    record = findBox(code);
    $('box-name').textContent = record.fields['Contents (short)'] ?? '';
    $('box-type').textContent = record.fields['Container Type'] ?? '';
    // Checkbox values are true. Link values are lists of record IDs.
    if (String(record.fields[field]) === String(value)) {
      $('box-note').textContent = 'Already marked.';
    }
    $('accept').disabled = false;
  } catch (error) {
    $('box-name').textContent = '';
    $('box-note').textContent = error.message;
  }

  const choice = await decided;
  $('video').play();
  clearReview();
  ignored = {code, seenAt: Date.now()};
  if (choice === 'accept') {
    beep('accept');
    accepted.add(code);
    mark(code, record);
  } else {
    beep('reject');
  }
}

function clearReview() {
  for (const id of ['box-code', 'box-name', 'box-type', 'box-note']) {
    $(id).textContent = '';
  }
  $('reject').disabled = true;
  $('accept').disabled = true;
  $('done').disabled = false;
}

async function loadBoxes() {
  const params = new URLSearchParams();
  for (const name of ['Code', 'Contents (short)', 'Container Type', field]) {
    params.append('fields[]', name);
  }
  const records = [];
  // Each call returns up to 100 records, plus an offset for the next page.
  let offset;
  do {
    if (offset) params.set('offset', offset);
    const page = await airtable(`${baseId}/${TABLE}?${params}`);
    records.push(...page.records);
    offset = page.offset;
  } while (offset);
  return Object.groupBy(records, (record) => record.fields.Code);
}

function findBox(code) {
  const records = boxes[code] ?? [];
  if (records.length === 0) throw new Error('No box has this code.');
  if (records.length > 1) throw new Error('More than one box has this code.');
  return records[0];
}

function mark(code, record) {
  const name = record.fields['Contents (short)'] ?? '';
  const item = document.createElement('li');
  item.className = 'pending';
  item.textContent = `${code} ${name}`;
  $('log').prepend(item);
  $('count').textContent = `${$('log').children.length} confirmed`;
  record.fields[field] = value;
  // A later update of the same field replaces an earlier one.
  queue = queue.filter(
      (update) => update.id !== record.id || update.field !== field);
  queue.push({id: record.id, code, name, field, value, label});
  saveQueue();
}

function saveQueue() {
  localStorage.setItem('queue', JSON.stringify(queue));
  renderQueue();
}

function renderQueue() {
  $('show-queue').textContent = `Queued updates (${queue.length})`;
  $('queue-empty').hidden = queue.length > 0;
  $('queue-list').replaceChildren(...queue.map((update) => {
    const item = document.createElement('li');
    item.className = update.error ? 'failed' : 'pending';
    item.textContent = `${update.code} ${update.name}: ${update.label}`;
    if (update.error) item.textContent += ` (${update.error})`;
    return item;
  }));
  $('queue-submit').disabled = submitting || queue.length === 0;
  $('queue-submit').textContent = submitting ? 'Submitting…' : 'Submit';
}

async function submitQueue() {
  if (submitting) return;
  submitting = true;
  renderQueue();
  const byRecord = Object.entries(Object.groupBy(queue, (update) => update.id));
  // Airtable updates at most 10 records per call.
  for (let i = 0; i < byRecord.length; i += 10) {
    const batch = byRecord.slice(i, i + 10);
    const sent = batch.flatMap(([, updates]) => updates);
    const records = batch.map(([id, updates]) => ({
      id,
      fields: Object.fromEntries(
          updates.map((update) => [update.field, update.value])),
    }));
    try {
      await airtable(`${baseId}/${TABLE}`, {
        method: 'PATCH',
        body: JSON.stringify({records}),
      });
      queue = queue.filter((update) => !sent.includes(update));
    } catch (error) {
      for (const update of sent) update.error = error.message;
    }
    saveQueue();
    // Stays under the limit of 5 calls per second.
    await sleep(200);
  }
  submitting = false;
  renderQueue();
}

function revealToken(reveal) {
  $('token-value').textContent = token;
  $('token-value').hidden = !reveal;
  $('reveal').textContent = reveal ? 'Hide token' : 'Show token';
}

$('token-form').onsubmit = (event) => {
  event.preventDefault();
  token = $('token').value.trim();
  localStorage.setItem('airtableToken', token);
  $('setup-error').textContent = '';
  init();
};

$('forget').onclick = () => $('forget-dialog').showModal();

$('forget-confirm').onclick = () => {
  localStorage.removeItem('airtableToken');
  localStorage.removeItem('baseId');
  localStorage.removeItem('rooms');
  token = null;
  revealToken(false);
  show('setup');
};

$('reveal').onclick = () => revealToken($('token-value').hidden);

for (const button of document.querySelectorAll('[data-field]')) {
  button.onclick =
      () => startScanning(button.dataset.field, true, button.textContent);
}

$('record-room').onclick = () => $('room-dialog').showModal();

$('show-queue').onclick = () => $('queue-dialog').showModal();

$('queue-submit').onclick = submitQueue;

// Starts in the click handler, as iOS only plays audio after a user gesture.
$('room-start').onclick = () => {
  const room = $('room').selectedOptions[0];
  if (!room) return;
  startScanning('Final Location', [room.value], `Mark as in ${room.text}`);
};

$('torch').onclick = async () => {
  const on = $('torch').ariaPressed !== 'true';
  const [track] = stream.getVideoTracks();
  try {
    await track.applyConstraints({advanced: [{torch: on}]});
    $('torch').ariaPressed = String(on);
  } catch (error) {
    alert(error.message);
  }
};

$('done').onclick = () => {
  stopScanning();
  submitQueue();
};

init();
