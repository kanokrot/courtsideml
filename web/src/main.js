import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import curryCsvUrl from '../../data/processed/stephen_curry_2025.csv?url';
import paigeCsvUrl from '../../data/processed/paige_bueckers_2025.csv?url';
import './style.css';

const GRID = { xMin: -25, xMax: 25, zMin: 0, zMax: 50, cell: 5, cols: 10, rows: 10 };
const PLAYER = {
  curry: { name: 'Stephen Curry', league: 'NBA', season: '2025', arc: 23.75, csv: curryCsvUrl, color: '#f1c36a' },
  paige: { name: 'Paige Bueckers', league: 'WNBA', season: '2025', arc: 22.15, csv: paigeCsvUrl, color: '#b7f35c' },
};
const PALETTE = { low: new THREE.Color('#fa7467'), mid: new THREE.Color('#efbd69'), high: new THREE.Color('#b7f35c') };
const $ = (selector) => document.querySelector(selector);
const canvas = $('#court-canvas');
const fallbackCanvas = $('#fallback-canvas');
const stage = $('#court-stage');
const tooltip = $('#tooltip');
const loadingState = $('#loading-state');
const playerSelect = $('#player-select');
const resultFilter = $('#result-filter');
const rangeFilter = $('#range-filter');
const periodFilter = $('#period-filter');
const state = {
  player: 'curry', rows: [], bins: [], filtered: [], selectedBin: null,
  view: '3d', renderer: null, scene: null, camera: null, controls: null,
  bars: null, arcLines: null, raycaster: new THREE.Raycaster(), pointer: new THREE.Vector2(),
  fallbackReason: '', frame: 0, reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
};

function parseCsv(source) {
  const records = [];
  let row = [], value = '', quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { value += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(value); value = ''; }
    else if (char === '\n') { row.push(value.replace(/\r$/, '')); records.push(row); row = []; value = ''; }
    else value += char;
  }
  if (value.length || row.length) { row.push(value.replace(/\r$/, '')); records.push(row); }
  const [header, ...lines] = records;
  return lines.filter((line) => line.length === header.length).map((line) => {
    const item = Object.fromEntries(header.map((key, index) => [key, line[index]]));
    return {
      x: Number(item.LOC_X) / 10,
      z: Number(item.LOC_Y) / 10,
      distance: Number(item.SHOT_DISTANCE),
      made: Number(item.SHOT_MADE_FLAG) === 1,
      period: Number(item.period_number),
      type: item.type_text || 'Shot',
      clock: item.clock_display_value || '',
      game: item.game_id || '',
    };
  }).filter((shot) => Number.isFinite(shot.x) && Number.isFinite(shot.z) && Number.isFinite(shot.distance));
}

async function loadPlayer(key) {
  const response = await fetch(PLAYER[key].csv);
  if (!response.ok) throw new Error(`Could not load ${PLAYER[key].name} shot data (${response.status})`);
  state.rows = parseCsv(await response.text());
  state.player = key;
}

function filteredShots() {
  const player = PLAYER[state.player];
  const result = resultFilter.value;
  const area = rangeFilter.value;
  const period = periodFilter.value;
  return state.rows.filter((shot) => {
    if (result === 'made' && !shot.made) return false;
    if (result === 'missed' && shot.made) return false;
    if (period !== 'all' && (Number(period) === 5 ? shot.period < 5 : shot.period !== Number(period))) return false;
    if (area === 'rim' && shot.distance >= 8) return false;
    if (area === 'paint' && (shot.distance < 8 || shot.distance >= 16)) return false;
    if (area === 'mid' && (shot.distance < 16 || shot.distance >= player.arc)) return false;
    if (area === 'three' && shot.distance < player.arc) return false;
    return true;
  });
}

function getBinIndex(x, z) {
  const col = Math.floor((x - GRID.xMin) / GRID.cell);
  const row = Math.floor((z - GRID.zMin) / GRID.cell);
  if (col < 0 || col >= GRID.cols || row < 0 || row >= GRID.rows) return -1;
  return row * GRID.cols + col;
}

function aggregate(shots) {
  const bins = Array.from({ length: GRID.cols * GRID.rows }, (_, index) => ({
    index, row: Math.floor(index / GRID.cols), col: index % GRID.cols,
    attempts: 0, made: 0, centerX: GRID.xMin + (index % GRID.cols + 0.5) * GRID.cell,
    centerZ: GRID.zMin + (Math.floor(index / GRID.cols) + 0.5) * GRID.cell,
  }));
  for (const shot of shots) {
    const index = getBinIndex(shot.x, shot.z);
    if (index < 0) continue;
    bins[index].attempts += 1;
    bins[index].made += Number(shot.made);
  }
  return bins.map((bin) => ({ ...bin, fg: bin.attempts ? bin.made / bin.attempts : 0 }));
}

function colorAt(fg, low, high) {
  const t = THREE.MathUtils.clamp(fg, low, high);
  const scaled = (t - low) / (high - low || 1);
  return scaled < 0.5
    ? PALETTE.low.clone().lerp(PALETTE.mid, scaled * 2)
    : PALETTE.mid.clone().lerp(PALETTE.high, (scaled - 0.5) * 2);
}

function scaleExtent(bins) {
  const values = bins.filter((bin) => bin.attempts > 0).map((bin) => bin.fg).sort((a, b) => a - b);
  if (!values.length) return [0, 1];
  const at = (fraction) => values[Math.min(values.length - 1, Math.floor((values.length - 1) * fraction))];
  let low = at(0.08), high = at(0.92);
  if (high - low < 0.08) { low = Math.max(0, low - 0.04); high = Math.min(1, high + 0.04); }
  if (high === low) high = Math.min(1, low + 0.1);
  return [low, high];
}

function updateSummary(shots, bins) {
  const made = shots.reduce((sum, shot) => sum + Number(shot.made), 0);
  const accuracy = shots.length ? made / shots.length : 0;
  const hottest = bins.reduce((best, bin) => bin.attempts > best.attempts ? bin : best, bins[0]);
  $('#fg-value').textContent = `${(accuracy * 100).toFixed(1)}%`;
  $('#fg-record').textContent = `${made.toLocaleString()} MADE / ${shots.length.toLocaleString()} ATTEMPTS`;
  $('#attempts-value').textContent = shots.length.toLocaleString();
  $('#made-value').textContent = made.toLocaleString();
  $('#hot-zone-value').textContent = hottest?.attempts ? `${hottest.attempts} SHOTS` : '—';
  $('#hot-zone-foot').textContent = hottest?.attempts ? `${formatRange(hottest)} ZONE` : 'NO SHOTS IN VIEW';
  $('#player-heading').textContent = PLAYER[state.player].name;
  document.title = `${PLAYER[state.player].name} — Courtside 3D`;
  $('#data-source').textContent = `${PLAYER[state.player].league} ${PLAYER[state.player].season} regular-season data. Attempts beyond the half-court line appear in the final strip; shot paths and release height are not included.`;
}

function formatRange(bin) {
  const x0 = GRID.xMin + bin.col * GRID.cell;
  const x1 = x0 + GRID.cell;
  const z0 = GRID.zMin + bin.row * GRID.cell;
  const z1 = z0 + GRID.cell;
  return `X ${x0} TO ${x1} FT · ${z0} TO ${z1} FT FROM HOOP`;
}

function updateInspector(bin) {
  state.selectedBin = bin?.index ?? null;
  $('#selected-title').textContent = bin ? `${formatRange(bin)}` : 'Select a court zone';
  $('#selected-attempts').textContent = bin ? bin.attempts.toLocaleString() : '—';
  $('#selected-made').textContent = bin ? bin.made.toLocaleString() : '—';
  $('#selected-fg').textContent = bin?.attempts ? `${(bin.fg * 100).toFixed(1)}%` : bin ? '0.0%' : '—';
  if (bin) showTooltip(bin, null, null, true);
  drawFallback();
  render3d();
}

function showTooltip(bin, x, y, pinned = false) {
  tooltip.innerHTML = `<span class="tooltip-title">${formatRange(bin)}</span><span class="tooltip-main"><span>${bin.attempts} ATTEMPTS</span><span>${(bin.fg * 100).toFixed(1)}%</span></span><span class="tooltip-meta"><span>${bin.made} MADE</span><span>${bin.attempts - bin.made} MISSED</span>${pinned ? '<span>SELECTED</span>' : ''}</span>`;
  tooltip.hidden = false;
  if (Number.isFinite(x) && Number.isFinite(y)) {
    const rect = stage.getBoundingClientRect();
    const left = Math.min(rect.width - tooltip.offsetWidth - 10, Math.max(10, x - rect.left + 14));
    const top = Math.min(rect.height - tooltip.offsetHeight - 10, Math.max(10, y - rect.top + 14));
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
    tooltip.style.bottom = 'auto';
  } else {
    tooltip.style.left = '16px';
    tooltip.style.bottom = '16px';
    tooltip.style.top = 'auto';
  }
}

function hideTooltip() {
  if (state.selectedBin === null) tooltip.hidden = true;
}

function makeLine(points, color, opacity = 1, width = 1) {
  const geometry = new THREE.BufferGeometry().setFromPoints(points.map(([x, z]) => new THREE.Vector3(x, 0.035, z)));
  const material = new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity, linewidth: width });
  const line = new THREE.Line(geometry, material);
  state.scene.add(line);
  return line;
}

function makeArc(radius, start, end, segments = 64, centerX = 0, centerZ = 0) {
  const points = [];
  for (let i = 0; i <= segments; i += 1) {
    const angle = start + ((end - start) * i) / segments;
    points.push([centerX + Math.cos(angle) * radius, centerZ + Math.sin(angle) * radius]);
  }
  return points;
}

function buildCourt() {
  state.scene = new THREE.Scene();
  state.scene.background = new THREE.Color('#091510');
  state.scene.fog = new THREE.Fog('#091510', 70, 145);
  state.scene.add(new THREE.HemisphereLight('#b8d4c0', '#10271d', 2.2));
  const key = new THREE.DirectionalLight('#f2dba4', 2.5);
  key.position.set(-22, 40, 15);
  state.scene.add(key);
  const fill = new THREE.DirectionalLight('#7fb38a', 1.35);
  fill.position.set(24, 20, 38);
  state.scene.add(fill);

  const floor = new THREE.Mesh(new THREE.BoxGeometry(180, 0.5, 180), new THREE.MeshStandardMaterial({ color: '#101c17', roughness: 0.96 }));
  floor.position.set(0, -0.55, 20);
  state.scene.add(floor);
  const court = new THREE.Mesh(new THREE.BoxGeometry(50, 0.16, 47), new THREE.MeshStandardMaterial({ color: '#204935', roughness: 0.84, metalness: 0.02 }));
  court.position.set(0, -0.22, 18.75);
  state.scene.add(court);

  const line = '#d1caa8';
  const faint = '#91ae91';
  const x0 = -25, x1 = 25, z0 = -4.75, z1 = 42.25;
  makeLine([[x0,z0],[x1,z0],[x1,z1],[x0,z1],[x0,z0]], line, 0.88);
  makeLine([[-8,z0],[-8,10.25],[8,10.25],[8,z0]], line, 0.8);
  makeLine([[-6,z0],[-6,10.25],[6,10.25],[6,z0]], faint, 0.45);
  makeLine(makeArc(6, 0, Math.PI, 48, 0, 10.25), line, 0.8);
  makeLine(makeArc(6, Math.PI, Math.PI * 2, 48, 0, 10.25), line, 0.45);
  makeLine(makeArc(4, 0, Math.PI, 48, 0, 0), line, 0.76);
  drawThreePointArc();
  makeLine([[-25,42.25],[25,42.25]], faint, 0.45);
  makeLine(makeArc(6, 0, Math.PI * 2, 54, 0, 0), '#e6dba9', 0.62);
  makeLine([[-3,-1.7],[3,-1.7]], '#e6dba9', 0.75, 2);
  const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.75, 0.08, 8, 32), new THREE.MeshStandardMaterial({ color: '#f0b965', emissive: '#583813', emissiveIntensity: 0.45, roughness: 0.42 }));
  hoop.rotation.x = Math.PI / 2;
  hoop.position.set(0, 0.32, 0);
  state.scene.add(hoop);
  const board = new THREE.Mesh(new THREE.BoxGeometry(6, 1.2, 0.18), new THREE.MeshStandardMaterial({ color: '#d7decb', roughness: 0.5, metalness: 0.12 }));
  board.position.set(0, 1.3, -1.3);
  state.scene.add(board);

  for (let i = 0; i <= GRID.cols; i += 1) {
    const x = GRID.xMin + i * GRID.cell;
    makeLine([[x,0],[x,GRID.zMax]], faint, 0.13);
  }
  for (let i = 0; i <= GRID.rows; i += 1) {
    const z = GRID.zMin + i * GRID.cell;
    makeLine([[GRID.xMin,z],[GRID.xMax,z]], faint, 0.13);
  }

  state.camera = new THREE.PerspectiveCamera(37, 1, 0.1, 220);
  state.camera.position.set(36, 43, -43);
  state.camera.lookAt(0, 0, 19);
  state.controls = new OrbitControls(state.camera, canvas);
  state.controls.target.set(0, 0, 19);
  state.controls.enablePan = false;
  state.controls.enableDamping = !state.reducedMotion;
  state.controls.dampingFactor = 0.08;
  state.controls.minDistance = 39;
  state.controls.maxDistance = 112;
  state.controls.minPolarAngle = 0.34;
  state.controls.maxPolarAngle = 1.36;
  state.controls.minAzimuthAngle = -2.65;
  state.controls.maxAzimuthAngle = 2.65;
  state.controls.addEventListener('change', scheduleRender);
}

function drawThreePointArc() {
  if (state.arcLines) {
    state.scene.remove(state.arcLines);
    state.arcLines.traverse((item) => { item.geometry?.dispose(); item.material?.dispose(); });
  }
  const { arc } = PLAYER[state.player];
  const corner = state.player === 'curry' ? 22 : 21.65;
  const cornerZ = Math.sqrt(Math.max(0, arc ** 2 - corner ** 2));
  const group = new THREE.Group();
  const addLine = (points) => {
    const geometry = new THREE.BufferGeometry().setFromPoints(points.map(([x, z]) => new THREE.Vector3(x, 0.035, z)));
    group.add(new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: '#d1caa8', transparent: true, opacity: 0.82 })));
  };
  addLine([[-corner, -4.75], [-corner, cornerZ]]);
  addLine([[corner, -4.75], [corner, cornerZ]]);
  const angle = Math.atan2(cornerZ, corner);
  addLine(makeArc(arc, angle, Math.PI - angle, 82));
  state.scene.add(group);
  state.arcLines = group;
}

function scheduleRender() {
  if (state.frame || !state.renderer || state.view !== '3d') return;
  state.frame = requestAnimationFrame(() => {
    state.frame = 0;
    state.controls?.update();
    render3d();
  });
}

function render3d() {
  if (state.renderer && state.scene && state.camera && state.view === '3d') state.renderer.render(state.scene, state.camera);
}

function drawBars(bins) {
  if (state.bars) {
    state.scene.remove(state.bars);
    state.bars.geometry.dispose();
    state.bars.material.dispose();
    state.bars = null;
  }
  const active = bins.filter((bin) => bin.attempts > 0);
  if (!active.length) { render3d(); return; }
  const max = Math.max(...active.map((bin) => bin.attempts));
  const [low, high] = scaleExtent(active);
  const geometry = new THREE.BoxGeometry(3.55, 1, 3.55);
  const material = new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0.08, emissive: '#132016', emissiveIntensity: 0.19 });
  const bars = new THREE.InstancedMesh(geometry, material, active.length);
  bars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  active.forEach((bin, id) => {
    const height = 0.16 + (bin.attempts / max) * 8.5;
    position.set(bin.centerX, height / 2 + 0.04, bin.centerZ);
    scale.set(1, height, 1);
    matrix.compose(position, quaternion, scale);
    bars.setMatrixAt(id, matrix);
    bars.setColorAt(id, colorAt(bin.fg, low, high));
    bin.instanceId = id;
  });
  bars.count = active.length;
  bars.userData.bins = active;
  bars.instanceMatrix.needsUpdate = true;
  if (bars.instanceColor) bars.instanceColor.needsUpdate = true;
  state.scene.add(bars);
  state.bars = bars;
  render3d();
}

function fitRenderer() {
  const rect = stage.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  if (state.view === '2d') { drawFallbackCourt(); return; }
  if (!state.renderer) return;
  state.renderer.setSize(rect.width, rect.height, false);
  state.camera.aspect = rect.width / rect.height;
  state.camera.updateProjectionMatrix();
  render3d();
}

function init3d() {
  const observer = new ResizeObserver(() => {
    if (state.view === '2d') drawFallbackCourt();
    else fitRenderer();
  });
  observer.observe(stage);
  window.addEventListener('resize', () => {
    if (state.view === '2d') drawFallbackCourt();
    else fitRenderer();
  }, { passive: true });
  try {
    state.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'low-power' });
    state.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    state.renderer.outputColorSpace = THREE.SRGBColorSpace;
    state.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    state.renderer.toneMappingExposure = 1.05;
    buildCourt();
    canvas.addEventListener('pointermove', onScenePointerMove);
    canvas.addEventListener('pointerleave', hideTooltip);
    canvas.addEventListener('click', onSceneClick);
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      switchView('2d', 'WebGL paused — showing 2D fallback.');
    });
    fitRenderer();
  } catch (error) {
    console.error(error);
    switchView('2d', 'WebGL is unavailable — showing 2D fallback.');
  }
}

function pickBin(event) {
  if (!state.renderer || !state.bars || !state.bars.userData.bins?.length) return null;
  const rect = canvas.getBoundingClientRect();
  state.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  state.raycaster.setFromCamera(state.pointer, state.camera);
  const hit = state.raycaster.intersectObject(state.bars, false)[0];
  return hit ? state.bars.userData.bins[hit.instanceId] : null;
}

function onScenePointerMove(event) {
  if (event.buttons) return;
  const bin = pickBin(event);
  if (!bin) { hideTooltip(); canvas.style.cursor = 'grab'; return; }
  canvas.style.cursor = 'pointer';
  showTooltip(bin, event.clientX, event.clientY, state.selectedBin === bin.index);
}

function onSceneClick(event) {
  const bin = pickBin(event);
  if (bin) updateInspector(bin);
}

function drawFallbackCourt() {
  const ctx = fallbackCanvas.getContext('2d');
  if (!ctx) return;
  const width = fallbackCanvas.clientWidth, height = fallbackCanvas.clientHeight;
  if (!width || !height) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  fallbackCanvas.width = Math.round(width * dpr);
  fallbackCanvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#091510'; ctx.fillRect(0, 0, width, height);
  const pad = Math.max(32, width * 0.09);
  const fieldW = width - pad * 2;
  const fieldH = Math.min(height - pad * 2, fieldW * 0.92);
  const left = (width - fieldW) / 2;
  const top = Math.max(pad, (height - fieldH) / 2);
  const cellW = fieldW / GRID.cols, cellH = fieldH / GRID.rows;
  ctx.fillStyle = '#204935'; ctx.fillRect(left, top, fieldW, fieldH);
  ctx.strokeStyle = 'rgba(221,220,184,.7)'; ctx.lineWidth = 1;
  ctx.strokeRect(left, top, fieldW, fieldH);
  ctx.strokeStyle = 'rgba(209,202,168,.8)';
  const keyX = left + fieldW * 0.34, keyW = fieldW * 0.32;
  ctx.strokeRect(keyX, top + fieldH - fieldH * (15 / GRID.zMax), keyW, fieldH * (15 / GRID.zMax));
  ctx.beginPath(); ctx.arc(left + fieldW / 2, top + fieldH, fieldW * (4 / 50) / 2, Math.PI, Math.PI * 2); ctx.stroke();
  const arc = PLAYER[state.player].arc;
  const corner = state.player === 'curry' ? 22 : 21.65;
  const cornerZ = Math.sqrt(Math.max(0, arc ** 2 - corner ** 2));
  const cornerAngle = Math.asin(cornerZ / arc);
  ctx.beginPath();
  ctx.moveTo(left + fieldW * (GRID.xMax - corner) / (GRID.xMax - GRID.xMin), top + fieldH - fieldH * (cornerZ / GRID.zMax));
  ctx.lineTo(left + fieldW * (GRID.xMax - corner) / (GRID.xMax - GRID.xMin), top + fieldH);
  ctx.moveTo(left + fieldW * (GRID.xMax + corner) / (GRID.xMax - GRID.xMin), top + fieldH - fieldH * (cornerZ / GRID.zMax));
  ctx.lineTo(left + fieldW * (GRID.xMax + corner) / (GRID.xMax - GRID.xMin), top + fieldH);
  ctx.stroke();
  ctx.beginPath(); ctx.arc(left + fieldW / 2, top + fieldH, fieldW * (arc / 50), Math.PI + cornerAngle, Math.PI * 2 - cornerAngle); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(left, top + fieldH * (GRID.zMax - 42.25) / GRID.zMax); ctx.lineTo(left + fieldW, top + fieldH * (GRID.zMax - 42.25) / GRID.zMax); ctx.stroke();
  const active = state.bins.filter((bin) => bin.attempts > 0);
  const [low, high] = scaleExtent(active);
  for (const bin of state.bins) {
    if (!bin.attempts) continue;
    const x = left + bin.col * cellW, y = top + fieldH - (bin.row + 1) * cellH;
    const c = colorAt(bin.fg, low, high);
    ctx.globalAlpha = 1;
    ctx.fillStyle = `#${c.getHexString()}`;
    ctx.fillRect(x + 1.5, y + 1.5, cellW - 3, cellH - 3);
    {
      ctx.globalAlpha = 1; ctx.fillStyle = '#07110f'; ctx.font = `600 ${Math.max(7, Math.min(12, cellW * 0.29))}px Consolas, monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(bin.attempts), x + cellW / 2, y + cellH / 2);
    }
  }
  ctx.globalAlpha = 1;
  fallbackCanvas.dataset.plot = JSON.stringify({ left, top, fieldW, fieldH, cellW, cellH });
}

function drawFallback() {
  if (state.view !== '2d') return;
  drawFallbackCourt();
}

function fallbackBinAt(event) {
  let plot;
  try { plot = JSON.parse(fallbackCanvas.dataset.plot || 'null'); } catch { return null; }
  if (!plot) return null;
  const rect = fallbackCanvas.getBoundingClientRect();
  const x = event.clientX - rect.left, y = event.clientY - rect.top;
  const col = Math.floor((x - plot.left) / plot.cellW);
  const rowFromTop = Math.floor((y - plot.top) / plot.cellH);
  const row = GRID.rows - 1 - rowFromTop;
  if (col < 0 || col >= GRID.cols || row < 0 || row >= GRID.rows) return null;
  return state.bins[row * GRID.cols + col];
}

function onFallbackPointer(event) {
  const bin = fallbackBinAt(event);
  if (!bin) { hideTooltip(); return; }
  showTooltip(bin, event.clientX, event.clientY, state.selectedBin === bin.index);
}

function switchView(view, message = '') {
  state.view = view;
  const is2d = view === '2d';
  canvas.hidden = is2d;
  fallbackCanvas.hidden = !is2d;
  $('#view-toggle').textContent = is2d ? 'Switch to 3D' : 'Switch to 2D';
  $('#view-toggle').setAttribute('aria-pressed', String(is2d));
  $('#view-label').textContent = is2d ? '2D FALLBACK' : '3D COURT';
  $('#encoding-label').innerHTML = is2d
    ? 'TILE COLOR = FG% <i class="caption-separator">·</i> LABEL = ATTEMPTS'
    : 'HEIGHT = ATTEMPTS <i class="caption-separator">·</i> COLOR = FG%';
  $('#render-status').textContent = message || (is2d ? '2D court map · colors show FG% · numbers show attempts' : 'Drag to orbit · scroll to zoom · select a bar for details');
  if (is2d) {
    tooltip.hidden = true;
    drawFallback();
  } else {
    fitRenderer();
    render3d();
  }
}

function renderData() {
  state.filtered = filteredShots();
  state.bins = aggregate(state.filtered);
  updateSummary(state.filtered, state.bins);
  drawBars(state.bins);
  drawFallback();
  renderDataTable(state.bins);
  if (state.selectedBin !== null) updateInspector(state.bins[state.selectedBin]);
  else {
    $('#selected-title').textContent = 'Select a court zone';
    $('#selected-attempts').textContent = '—';
    $('#selected-made').textContent = '—';
    $('#selected-fg').textContent = '—';
  }
  $('#render-status').textContent = state.view === '2d'
    ? '2D court map · colors show FG% · numbers show attempts'
    : 'Drag to orbit · scroll to zoom · select a bar for details';
}

function renderDataTable(bins) {
  const rows = Array.from({ length: GRID.rows }, (_, rowIndex) => {
    const row = GRID.rows - rowIndex - 1;
    const cells = Array.from({ length: GRID.cols }, (_, col) => {
      const bin = bins[row * GRID.cols + col];
      const x0 = GRID.xMin + col * GRID.cell, z0 = GRID.zMin + row * GRID.cell;
      const label = `X ${x0} to ${x0 + GRID.cell} ft, ${z0} to ${z0 + GRID.cell} ft from hoop: ${bin.attempts} attempts, ${bin.made} made, ${(bin.fg * 100).toFixed(1)} percent`;
      return `<td><button class="table-cell" type="button" data-bin="${bin.index}" aria-label="${label}">${bin.attempts} · ${(bin.fg * 100).toFixed(1)}%</button></td>`;
    }).join('');
    return `<tr><th scope="row">${row * GRID.cell}–${(row + 1) * GRID.cell} ft from hoop</th>${cells}</tr>`;
  }).join('');
  $('#data-table-wrap').innerHTML = `<table><caption>Attempts and FG% by 5 ft zone. Read each row from the far end of the half court toward the hoop.</caption><thead><tr><th scope="col">Distance</th>${Array.from({ length: GRID.cols }, (_, col) => `<th scope="col">X ${GRID.xMin + col * GRID.cell} to ${GRID.xMin + (col + 1) * GRID.cell} ft</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
  $('#data-table-wrap').querySelector('table').addEventListener('click', (event) => {
    const button = event.target.closest('[data-bin]');
    if (button) updateInspector(state.bins[Number(button.dataset.bin)]);
  }, { once: true });
}

function setReducedMotion(enabled) {
  state.reducedMotion = enabled;
  document.documentElement.dataset.reducedMotion = String(enabled);
  $('#motion-toggle').setAttribute('aria-pressed', String(enabled));
  $('#motion-toggle').innerHTML = `Motion: <span>${enabled ? 'Reduced' : 'Full'}</span>`;
  if (state.controls) {
    state.controls.enableDamping = !enabled;
    state.controls.update();
    render3d();
  }
}

function bindControls() {
  playerSelect.addEventListener('change', async () => {
    loadingState.hidden = false;
    try {
      await loadPlayer(playerSelect.value);
      if (state.scene) drawThreePointArc();
      state.selectedBin = null;
      tooltip.hidden = true;
      updateInspector(null);
      renderData();
    } catch (error) { showLoadError(error); }
    finally { loadingState.hidden = true; }
  });
  [resultFilter, rangeFilter, periodFilter].forEach((select) => select.addEventListener('change', () => {
    state.selectedBin = null;
    tooltip.hidden = true;
    renderData();
  }));
  $('#reset-filters').addEventListener('click', () => {
    resultFilter.value = 'all'; rangeFilter.value = 'all'; periodFilter.value = 'all';
    state.selectedBin = null; tooltip.hidden = true; renderData();
  });
  $('#view-toggle').addEventListener('click', () => switchView(state.view === '3d' ? '2d' : '3d'));
  $('#reset-view').addEventListener('click', () => {
    state.controls?.reset();
    state.controls?.update();
    render3d();
  });
  $('#motion-toggle').addEventListener('click', () => setReducedMotion(!state.reducedMotion));
  fallbackCanvas.addEventListener('pointermove', onFallbackPointer);
  fallbackCanvas.addEventListener('pointerleave', hideTooltip);
  fallbackCanvas.addEventListener('click', (event) => {
    const bin = fallbackBinAt(event);
    if (bin) updateInspector(bin);
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { state.selectedBin = null; tooltip.hidden = true; updateInspector(null); }
  });
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  motionQuery.addEventListener?.('change', (event) => setReducedMotion(event.matches));
}

function showLoadError(error) {
  console.error(error);
  loadingState.innerHTML = '<strong>Shot data could not be loaded.</strong><span>Refresh the page or check the static data files.</span>';
  loadingState.hidden = false;
  $('#render-status').textContent = 'Data unavailable';
}

async function start() {
  bindControls();
  setReducedMotion(state.reducedMotion);
  init3d();
  try {
    await loadPlayer(state.player);
    renderData();
    loadingState.hidden = true;
  } catch (error) { showLoadError(error); }
}

start();
