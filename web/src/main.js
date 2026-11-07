import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import curryCsvUrl from '../../data/processed/stephen_curry_2025.csv?url';
import paigeCsvUrl from '../../data/processed/paige_bueckers_2025.csv?url';
import './style.css';

const GRID = { xMin: -25, xMax: 25, zMin: 0, zMax: 50, cell: 5, cols: 10, rows: 10 };
const KDE = { cols: 97, rows: 97, xMin: GRID.xMin, xMax: GRID.xMax, zMin: GRID.zMin, zMax: GRID.zMax, bandwidth: 3.2, maxHeight: 12 };
KDE.stepX = (KDE.xMax - KDE.xMin) / (KDE.cols - 1);
KDE.stepZ = (KDE.zMax - KDE.zMin) / (KDE.rows - 1);
const REPLAY = { maxConcurrent: 5, flightMs: 1150, intervalMs: 620, ballRadius: 0.39 };
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
  fullSurface: null, surface: null, referencePeak: 0,
  view: '3d', renderer: null, scene: null, camera: null, controls: null,
  surfaceMesh: null, arcLines: null, composer: null, bloomPass: null,
  raycaster: new THREE.Raycaster(), pointer: new THREE.Vector2(),
  fallbackReason: '', frame: 0, reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  replay: { mesh: null, shots: [], active: [], playing: false, cursor: 0, currentIndex: -1, speed: 2, elapsed: 0, nextAt: 0, lastFrame: 0, raf: 0, flashAt: -Infinity, stationary: null, goalLight: null, hoopMaterial: null, flashMesh: null },
};
const replayTransform = new THREE.Object3D();

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
  return lines.filter((line) => line.length === header.length).map((line, sourceIndex) => {
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
      sourceIndex,
    };
  }).filter((shot) => Number.isFinite(shot.x) && Number.isFinite(shot.z) && Number.isFinite(shot.distance));
}

async function loadPlayer(key) {
  const response = await fetch(PLAYER[key].csv);
  if (!response.ok) throw new Error(`Could not load ${PLAYER[key].name} shot data (${response.status})`);
  state.rows = parseCsv(await response.text());
  state.player = key;
  state.fullSurface = estimateKDE(state.rows);
  state.referencePeak = state.fullSurface.maxDensity;
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

function colorAt(fg, min = 0, max = 1) {
  const accuracy = THREE.MathUtils.clamp((fg - min) / Math.max(0.01, max - min), 0, 1);
  return accuracy < 0.5
    ? PALETTE.low.clone().lerp(PALETTE.mid, accuracy * 2)
    : PALETTE.mid.clone().lerp(PALETTE.high, (accuracy - 0.5) * 2);
}

function estimateKDE(shots) {
  const size = KDE.cols * KDE.rows;
  const weight = new Float32Array(size);
  const madeWeight = new Float32Array(size);
  const density = new Float32Array(size);
  const fg = new Float32Array(size);
  const overallFG = shots.length ? shots.reduce((sum, shot) => sum + Number(shot.made), 0) / shots.length : 0;
  const radiusX = Math.ceil((KDE.bandwidth * 3) / KDE.stepX);
  const radiusZ = Math.ceil((KDE.bandwidth * 3) / KDE.stepZ);
  const inverseBandwidthSquared = 0.5 / (KDE.bandwidth * KDE.bandwidth);
  const estimatedZoneArea = 25 / (2 * Math.PI * KDE.bandwidth * KDE.bandwidth);
  let maxDensity = 0;

  for (const shot of shots) {
    if (shot.x < KDE.xMin || shot.x > KDE.xMax || shot.z < KDE.zMin || shot.z > KDE.zMax) continue;
    const centerX = Math.round((shot.x - KDE.xMin) / KDE.stepX);
    const centerZ = Math.round((shot.z - KDE.zMin) / KDE.stepZ);
    for (let z = Math.max(0, centerZ - radiusZ); z <= Math.min(KDE.rows - 1, centerZ + radiusZ); z += 1) {
      const sceneZ = KDE.zMin + z * KDE.stepZ;
      const dz = sceneZ - shot.z;
      for (let x = Math.max(0, centerX - radiusX); x <= Math.min(KDE.cols - 1, centerX + radiusX); x += 1) {
        const sceneX = KDE.xMin + x * KDE.stepX;
        const dx = sceneX - shot.x;
        const squaredDistance = dx * dx + dz * dz;
        const kernelWeight = Math.exp(-squaredDistance * inverseBandwidthSquared);
        const index = z * KDE.cols + x;
        weight[index] += kernelWeight;
        if (shot.made) madeWeight[index] += kernelWeight;
      }
    }
  }

  for (let i = 0; i < size; i += 1) {
    density[i] = weight[i] * estimatedZoneArea;
    // A light prior keeps color from swinging on the fringe where very few kernels overlap.
    fg[i] = (madeWeight[i] + overallFG * 1.5) / (weight[i] + 1.5);
    if (density[i] > maxDensity) maxDensity = density[i];
  }
  const activeAccuracy = [];
  for (let i = 0; i < size; i += 1) {
    if (density[i] >= maxDensity * 0.08) activeAccuracy.push(fg[i]);
  }
  activeAccuracy.sort((a, b) => a - b);
  const quantile = (fraction) => activeAccuracy.length
    ? activeAccuracy[Math.min(activeAccuracy.length - 1, Math.floor((activeAccuracy.length - 1) * fraction))]
    : overallFG;
  let colorMin = quantile(0.08), colorMax = quantile(0.92);
  if (colorMax - colorMin < 0.12) {
    const midpoint = (colorMin + colorMax) / 2;
    colorMin = Math.max(0, midpoint - 0.06);
    colorMax = Math.min(1, midpoint + 0.06);
  }
  return { density, fg, maxDensity, overallFG, colorMin, colorMax, shots: shots.length };
}

function updateAccuracyLegend(surface) {
  const min = surface?.colorMin ?? 0;
  const max = surface?.colorMax ?? 1;
  const ticks = $('#fg-ticks');
  ticks.innerHTML = `<span>${Math.round(min * 100)}%</span><span>${Math.round(((min + max) / 2) * 100)}%</span><span>${Math.round(max * 100)}%</span>`;
  $('.color-legend').setAttribute('aria-label', `Color scale: ${Math.round(min * 100)} percent in coral, ${Math.round(((min + max) / 2) * 100)} percent in gold, ${Math.round(max * 100)} percent in mint`);
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
  $('#data-source').textContent = `Gaussian KDE · 3.2 ft bandwidth · height is scaled to this player's full-season peak. Source records do not include ball paths or release height.`;
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

function showTooltip(bin, x, y, pinned = false, local = null) {
  const localReading = local
    ? `<span class="tooltip-density">${local.density.toFixed(1)} EST. ATTEMPTS / 25 FT² <i>·</i> LOCAL FG ${(local.fg * 100).toFixed(1)}%</span>`
    : '';
  tooltip.innerHTML = `<span class="tooltip-title">${formatRange(bin)}</span><span class="tooltip-main"><span>${bin.attempts} ATTEMPTS</span><span>${(bin.fg * 100).toFixed(1)}%</span></span><span class="tooltip-meta"><span>${bin.made} MADE</span><span>${bin.attempts - bin.made} MISSED</span>${pinned ? '<span>SELECTED</span>' : ''}</span>${localReading}`;
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

function makeBasketballTexture() {
  const textureCanvas = document.createElement('canvas');
  textureCanvas.width = 512;
  textureCanvas.height = 256;
  const context = textureCanvas.getContext('2d');
  const leather = context.createRadialGradient(164, 58, 12, 256, 128, 285);
  leather.addColorStop(0, '#ffb255');
  leather.addColorStop(0.48, '#ee812b');
  leather.addColorStop(1, '#bd5017');
  context.fillStyle = leather;
  context.fillRect(0, 0, textureCanvas.width, textureCanvas.height);
  context.strokeStyle = '#28201b';
  context.lineWidth = 9;
  context.lineCap = 'round';
  context.beginPath();
  context.moveTo(0, 128); context.bezierCurveTo(165, 105, 347, 151, 512, 128);
  context.moveTo(256, 0); context.bezierCurveTo(220, 70, 292, 184, 256, 256);
  context.moveTo(128, 0); context.bezierCurveTo(180, 76, 180, 180, 128, 256);
  context.moveTo(384, 0); context.bezierCurveTo(332, 76, 332, 180, 384, 256);
  context.stroke();
  const texture = new THREE.CanvasTexture(textureCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createReplayBallInstances() {
  const geometry = new THREE.SphereGeometry(REPLAY.ballRadius, 28, 20);
  const texture = makeBasketballTexture();
  const material = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false });
  const mesh = new THREE.InstancedMesh(geometry, material, REPLAY.maxConcurrent);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  for (let slot = 0; slot < REPLAY.maxConcurrent; slot += 1) {
    replayTransform.position.set(0, -100, 0);
    replayTransform.scale.setScalar(0);
    replayTransform.updateMatrix();
    mesh.setMatrixAt(slot, replayTransform.matrix);
  }
  state.scene.add(mesh);
  state.replay.mesh = mesh;
}

function setReplayBall(slot, position, rotationY = 0) {
  const mesh = state.replay.mesh;
  if (!mesh) return;
  if (!position) {
    replayTransform.position.set(0, -100, 0);
    replayTransform.scale.setScalar(0);
    replayTransform.rotation.set(0, 0, 0);
  } else {
    replayTransform.position.copy(position);
    replayTransform.scale.setScalar(1);
    replayTransform.rotation.set(rotationY * 0.7, rotationY, rotationY * 0.35);
  }
  replayTransform.updateMatrix();
  mesh.setMatrixAt(slot, replayTransform.matrix);
  mesh.instanceMatrix.needsUpdate = true;
}

function buildCourt() {
  state.scene = new THREE.Scene();
  state.scene.background = new THREE.Color('#070b10');
  state.scene.fog = new THREE.Fog('#070b10', 76, 150);
  state.scene.add(new THREE.HemisphereLight('#8297a0', '#11181d', 0.62));
  const fill = new THREE.DirectionalLight('#7e9ca3', 0.42);
  fill.position.set(22, 26, 38);
  state.scene.add(fill);

  for (const [x, z, color] of [[-16, 14, '#ffe2b0'], [0, 20, '#fff0cb'], [16, 14, '#ffe2b0']]) {
    const target = new THREE.Object3D();
    target.position.set(0, 0, 18.75);
    state.scene.add(target);
    const spotlight = new THREE.SpotLight(color, 300, 105, Math.PI / 5.4, 0.72, 2);
    spotlight.position.set(x, 31, z);
    spotlight.target = target;
    state.scene.add(spotlight);
    const fixture = new THREE.Mesh(new THREE.SphereGeometry(0.48, 12, 8), new THREE.MeshBasicMaterial({ color: '#ffe5b5', toneMapped: false }));
    fixture.position.set(x, 31.3, z);
    state.scene.add(fixture);
  }
  state.replay.goalLight = new THREE.PointLight('#ffbd72', 22, 24, 2);
  state.replay.goalLight.position.set(0, 3.5, 0.5);
  state.scene.add(state.replay.goalLight);

  const floor = new THREE.Mesh(new THREE.BoxGeometry(180, 0.5, 180), new THREE.MeshStandardMaterial({ color: '#11171b', roughness: 0.96 }));
  floor.position.set(0, -0.55, 20);
  state.scene.add(floor);
  const court = new THREE.Mesh(new THREE.BoxGeometry(50, 0.16, 55.5), new THREE.MeshStandardMaterial({ color: '#91613a', emissive: '#281306', emissiveIntensity: 0.32, roughness: 0.62, metalness: 0.01 }));
  court.position.set(0, -0.22, 22.5);
  state.scene.add(court);
  const plankDepth = 55.5 / 13;
  for (let index = 0; index < 13; index += 1) {
    const plank = new THREE.Mesh(
      new THREE.BoxGeometry(49.88, 0.012, plankDepth - 0.045),
      new THREE.MeshStandardMaterial({ color: '#b17a4d', emissive: '#47240e', emissiveIntensity: 0.24, roughness: 0.58, metalness: 0.01 }),
    );
    plank.position.set(0, -0.135, -5.25 + plankDepth * (index + 0.5));
    state.scene.add(plank);
  }

  const line = '#d1caa8';
  const faint = '#caa57d';
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
  const hoopMaterial = new THREE.MeshStandardMaterial({ color: '#f0b965', emissive: '#583813', emissiveIntensity: 0.45, roughness: 0.42 });
  const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.75, 0.08, 8, 32), hoopMaterial);
  hoop.rotation.x = Math.PI / 2;
  hoop.position.set(0, 0.32, 0);
  state.scene.add(hoop);
  state.replay.hoopMaterial = hoopMaterial;
  const net = new THREE.Mesh(
    new THREE.CylinderGeometry(0.62, 0.34, 0.95, 16, 4, true),
    new THREE.MeshBasicMaterial({ color: '#e5e1d2', wireframe: true, transparent: true, opacity: 0.5 }),
  );
  net.position.set(0, -0.16, 0);
  state.scene.add(net);
  const board = new THREE.Mesh(new THREE.BoxGeometry(6, 1.5, 0.18), new THREE.MeshStandardMaterial({ color: '#d7decb', roughness: 0.5, metalness: 0.12 }));
  board.position.set(0, 1.3, -1.3);
  state.scene.add(board);
  const targetSquare = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.85, 0.035), new THREE.MeshBasicMaterial({ color: '#acb9a9', wireframe: true, transparent: true, opacity: 0.75 }));
  targetSquare.position.set(0, 0.75, -1.19);
  state.scene.add(targetSquare);
  const support = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.2, 3.2, 10), new THREE.MeshStandardMaterial({ color: '#28333a', metalness: 0.72, roughness: 0.38 }));
  support.position.set(0, 1.35, -3.05);
  state.scene.add(support);
  const supportArm = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 1.8), new THREE.MeshStandardMaterial({ color: '#364148', metalness: 0.7, roughness: 0.4 }));
  supportArm.position.set(0, 2.75, -2.35);
  state.scene.add(supportArm);
  const flashMaterial = new THREE.MeshBasicMaterial({ color: '#fff0a6', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const flashMesh = new THREE.Mesh(new THREE.TorusGeometry(0.78, 0.045, 8, 36), flashMaterial);
  flashMesh.rotation.x = Math.PI / 2;
  flashMesh.position.set(0, 0.39, 0);
  state.scene.add(flashMesh);
  state.replay.flashMesh = flashMesh;
  createReplayBallInstances();

  for (let i = 0; i <= GRID.cols; i += 1) {
    const x = GRID.xMin + i * GRID.cell;
    makeLine([[x,0],[x,GRID.zMax]], faint, 0.13);
  }
  for (let i = 0; i <= GRID.rows; i += 1) {
    const z = GRID.zMin + i * GRID.cell;
    makeLine([[GRID.xMin,z],[GRID.xMax,z]], faint, 0.10);
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
  if (state.composer && state.scene && state.camera && state.view === '3d') state.composer.render();
}

function drawSurface(surface) {
  if (state.surfaceMesh) {
    state.scene.remove(state.surfaceMesh);
    state.surfaceMesh.geometry.dispose();
    state.surfaceMesh.material.dispose();
    state.surfaceMesh = null;
  }
  if (!surface || surface.maxDensity <= 0 || state.referencePeak <= 0) { render3d(); return; }

  const positions = new Float32Array(KDE.cols * KDE.rows * 3);
  const colors = new Float32Array(KDE.cols * KDE.rows * 3);
  const maxHeight = KDE.maxHeight;
  const lowCut = surface.maxDensity * 0.008;
  for (let z = 0; z < KDE.rows; z += 1) {
    for (let x = 0; x < KDE.cols; x += 1) {
      const index = z * KDE.cols + x;
      const density = surface.density[index];
      const height = Math.min(maxHeight, (density / state.referencePeak) * maxHeight);
      const color = colorAt(surface.fg[index], surface.colorMin, surface.colorMax);
      const offset = index * 3;
      positions[offset] = KDE.xMin + x * KDE.stepX;
      positions[offset + 1] = 0.08 + height;
      positions[offset + 2] = KDE.zMin + z * KDE.stepZ;
      colors[offset] = color.r;
      colors[offset + 1] = color.g;
      colors[offset + 2] = color.b;
    }
  }
  const indices = [];
  for (let z = 0; z < KDE.rows - 1; z += 1) {
    for (let x = 0; x < KDE.cols - 1; x += 1) {
      const a = z * KDE.cols + x;
      const b = a + 1;
      const c = a + KDE.cols;
      const d = c + 1;
      const cellPeak = Math.max(surface.density[a], surface.density[b], surface.density[c], surface.density[d]);
      if (cellPeak < lowCut) continue;
      indices.push(a, c, b, b, c, d);
    }
  }
  if (!indices.length) { render3d(); return; }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  const material = new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.78,
    depthWrite: false, toneMapped: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.surface = surface;
  mesh.userData.threshold = lowCut;
  state.scene.add(mesh);
  state.surfaceMesh = mesh;
  render3d();
}

function fitRenderer() {
  const rect = stage.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  if (state.view === '2d') { drawFallbackCourt(); return; }
  if (!state.renderer) return;
  state.composer?.setSize(rect.width, rect.height);
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
    state.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.3));
    state.renderer.outputColorSpace = THREE.SRGBColorSpace;
    state.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    state.renderer.toneMappingExposure = 1.12;
    buildCourt();
    state.composer = new EffectComposer(state.renderer);
    state.composer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.3));
    state.composer.addPass(new RenderPass(state.scene, state.camera));
    state.bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.5, 0.5, 0.7);
    state.composer.addPass(state.bloomPass);
    state.composer.addPass(new OutputPass());
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

function sampleSurface(x, z) {
  const col = THREE.MathUtils.clamp(Math.round((x - KDE.xMin) / KDE.stepX), 0, KDE.cols - 1);
  const row = THREE.MathUtils.clamp(Math.round((z - KDE.zMin) / KDE.stepZ), 0, KDE.rows - 1);
  const index = row * KDE.cols + col;
  const zoneX = THREE.MathUtils.clamp(x, GRID.xMin, GRID.xMax - 0.001);
  const zoneZ = THREE.MathUtils.clamp(z, GRID.zMin, GRID.zMax - 0.001);
  const binIndex = getBinIndex(zoneX, zoneZ);
  if (binIndex < 0 || !state.surface) return null;
  return { bin: state.bins[binIndex], density: state.surface.density[index], fg: state.surface.fg[index], x, z };
}

function pickSurface(event) {
  if (!state.renderer || !state.surfaceMesh || !state.surfaceMesh.geometry.index) return null;
  const rect = canvas.getBoundingClientRect();
  state.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  state.raycaster.setFromCamera(state.pointer, state.camera);
  const hit = state.raycaster.intersectObject(state.surfaceMesh, false)[0];
  return hit ? sampleSurface(hit.point.x, hit.point.z) : null;
}

function onScenePointerMove(event) {
  if (event.buttons) return;
  const sample = pickSurface(event);
  if (!sample) { hideTooltip(); canvas.style.cursor = 'grab'; return; }
  canvas.style.cursor = 'pointer';
  showTooltip(sample.bin, event.clientX, event.clientY, state.selectedBin === sample.bin.index, sample);
}

function onSceneClick(event) {
  const sample = pickSurface(event);
  if (!sample) return;
  updateInspector(sample.bin);
  showTooltip(sample.bin, event.clientX, event.clientY, true, sample);
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
  ctx.fillStyle = '#58402e'; ctx.fillRect(left, top, fieldW, fieldH);
  if (state.surface && state.referencePeak > 0) {
    const tileW = fieldW / (KDE.cols - 1);
    const tileH = fieldH / (KDE.rows - 1);
    for (let row = 0; row < KDE.rows; row += 1) {
      for (let col = 0; col < KDE.cols; col += 1) {
        const index = row * KDE.cols + col;
        const relativeDensity = state.surface.density[index] / state.referencePeak;
        if (relativeDensity < 0.008) continue;
        const color = colorAt(state.surface.fg[index], state.surface.colorMin, state.surface.colorMax);
        const x = left + col * tileW;
        const y = top + fieldH - row * tileH - tileH;
        ctx.globalAlpha = Math.min(0.9, 0.12 + relativeDensity * 0.78);
        ctx.fillStyle = `#${color.getHexString()}`;
        ctx.fillRect(x, y, tileW + 0.6, tileH + 0.6);
      }
    }
    ctx.globalAlpha = 1;
  }
  ctx.strokeStyle = 'rgba(222,185,139,.11)'; ctx.lineWidth = 0.6;
  for (let plank = 1; plank < 13; plank += 1) {
    const y = top + fieldH - (plank * (47 / 13) / GRID.zMax) * fieldH;
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + fieldW, y); ctx.stroke();
  }
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
  ctx.globalAlpha = 1;
  fallbackCanvas.dataset.plot = JSON.stringify({ left, top, fieldW, fieldH });
}

function drawFallback() {
  if (state.view !== '2d') return;
  drawFallbackCourt();
}

function fallbackSampleAt(event) {
  let plot;
  try { plot = JSON.parse(fallbackCanvas.dataset.plot || 'null'); } catch { return null; }
  if (!plot) return null;
  const rect = fallbackCanvas.getBoundingClientRect();
  const x = event.clientX - rect.left, y = event.clientY - rect.top;
  if (x < plot.left || x > plot.left + plot.fieldW || y < plot.top || y > plot.top + plot.fieldH) return null;
  const sceneX = KDE.xMin + ((x - plot.left) / plot.fieldW) * (KDE.xMax - KDE.xMin);
  const sceneZ = KDE.zMax - ((y - plot.top) / plot.fieldH) * (KDE.zMax - KDE.zMin);
  return sampleSurface(sceneX, sceneZ);
}

function onFallbackPointer(event) {
  const sample = fallbackSampleAt(event);
  if (!sample) { hideTooltip(); return; }
  showTooltip(sample.bin, event.clientX, event.clientY, state.selectedBin === sample.bin.index, sample);
}

function switchView(view, message = '') {
  state.view = view;
  const is2d = view === '2d';
  if (is2d) {
    pauseReplay(false);
    clearReplayBalls();
  }
  canvas.hidden = is2d;
  fallbackCanvas.hidden = !is2d;
  $('#view-toggle').textContent = is2d ? 'Switch to 3D' : 'Switch to 2D';
  $('#view-toggle').setAttribute('aria-pressed', String(is2d));
  $('#view-label').textContent = is2d ? '2D FALLBACK' : '3D COURT';
  $('#encoding-label').innerHTML = is2d
    ? 'HUE = LOCAL FG% <i class="caption-separator">·</i> INTENSITY = DENSITY'
    : 'HEIGHT = SHOT DENSITY <i class="caption-separator">·</i> COLOR = LOCAL FG%';
  $('#render-status').textContent = message || (is2d ? '2D density map · tap a location for local values' : 'Drag to orbit · scroll to zoom · select the surface for local values');
  updateReplayControls();
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
  setReplayShots(state.filtered);
  const hasFilters = resultFilter.value !== 'all' || rangeFilter.value !== 'all' || periodFilter.value !== 'all';
  state.surface = !hasFilters && state.fullSurface ? state.fullSurface : estimateKDE(state.filtered);
  updateAccuracyLegend(state.surface);
  updateSummary(state.filtered, state.bins);
  drawSurface(state.surface);
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
    ? '2D density map · tap a location for local values'
    : 'Drag to orbit · scroll to zoom · select the surface for local values';
}

function secondsRemaining(clock) {
  const match = /^(\d+):(\d{2})$/.exec(String(clock || '').trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function orderedReplayShots(shots) {
  const gameOrder = new Map();
  for (const shot of shots) {
    if (!gameOrder.has(shot.game)) gameOrder.set(shot.game, gameOrder.size);
  }
  return shots.map((shot) => ({ ...shot, gameOrder: gameOrder.get(shot.game) }))
    .sort((a, b) => {
      if (a.gameOrder !== b.gameOrder) return a.gameOrder - b.gameOrder;
      const aPeriod = Number.isFinite(a.period) ? a.period : Number.POSITIVE_INFINITY;
      const bPeriod = Number.isFinite(b.period) ? b.period : Number.POSITIVE_INFINITY;
      if (aPeriod !== bPeriod) return aPeriod - bPeriod;
      const aClock = secondsRemaining(a.clock), bClock = secondsRemaining(b.clock);
      if (aClock !== null && bClock !== null && aClock !== bClock) return bClock - aClock;
      return a.sourceIndex - b.sourceIndex;
    });
}

function replayShotLabel(shot) {
  const game = String(shot.gameOrder + 1).padStart(2, '0');
  const period = Number.isFinite(shot.period) ? `Q${shot.period}` : 'PERIOD N/A';
  const time = shot.clock || 'TIME N/A';
  return `GAME ${game} · ${period} · ${time} · ${shot.made ? 'MADE' : 'MISSED'}`;
}

function updateReplayControls() {
  const replay = state.replay;
  const count = replay.shots.length;
  const displayedIndex = replay.currentIndex;
  $('#replay-play').textContent = replay.playing ? 'Pause replay' : 'Play replay';
  $('#replay-play').setAttribute('aria-label', replay.playing ? 'Pause shot replay' : 'Play shot replay');
  $('#replay-play').disabled = state.reducedMotion || state.view !== '3d' || !count;
  $('#replay-previous').disabled = state.view !== '3d' || !count;
  $('#replay-next').disabled = state.view !== '3d' || !count;
  $('#replay-speed').disabled = !count;
  $('#replay-counter').textContent = `${displayedIndex >= 0 ? displayedIndex + 1 : 0} / ${count.toLocaleString()} SHOTS`;
  const label = displayedIndex >= 0 ? replayShotLabel(replay.shots[displayedIndex]) : '';
  let status;
  if (!count) status = 'No shots match the current filters.';
  else if (state.reducedMotion) status = 'Reduced motion is on · step through shots without flight animation.';
  else if (state.view !== '3d') status = 'Switch to the 3D view to play simulated flights.';
  else if (replay.playing) status = label || 'Starting replay…';
  else if (replay.cursor >= count && !replay.active.length) status = 'Replay complete · press Play to start again.';
  else if (label) status = `${label} · paused`;
  else status = 'Ready · ordered by game, period, and clock time.';
  $('#replay-status').textContent = status;
  const progress = $('#replay-progress');
  progress.setAttribute('aria-valuemax', String(count));
  progress.setAttribute('aria-valuenow', String(displayedIndex >= 0 ? displayedIndex + 1 : 0));
  $('#replay-progress-bar').style.width = `${count ? ((displayedIndex + 1) / count) * 100 : 0}%`;
}

function clearReplayBalls() {
  state.replay.active = [];
  state.replay.stationary = null;
  for (let slot = 0; slot < REPLAY.maxConcurrent; slot += 1) setReplayBall(slot, null);
}

function setReplayShots(shots) {
  pauseReplay(false);
  clearReplayBalls();
  state.replay.shots = orderedReplayShots(shots);
  state.replay.cursor = 0;
  state.replay.currentIndex = -1;
  state.replay.elapsed = 0;
  state.replay.nextAt = 0;
  state.replay.flashAt = -Infinity;
  updateReplayControls();
}

function pauseReplay(refresh = true) {
  const replay = state.replay;
  replay.playing = false;
  replay.lastFrame = 0;
  if (replay.raf) cancelAnimationFrame(replay.raf);
  replay.raf = 0;
  replay.flashAt = -Infinity;
  updateReplayEffect();
  if (refresh && $('#replay-play')) updateReplayControls();
}

function sampleSurfaceHeight(x, z) {
  if (!state.surface || !state.referencePeak) return 0.08;
  const col = THREE.MathUtils.clamp(Math.round((x - KDE.xMin) / KDE.stepX), 0, KDE.cols - 1);
  const row = THREE.MathUtils.clamp(Math.round((z - KDE.zMin) / KDE.stepZ), 0, KDE.rows - 1);
  const density = state.surface.density[row * KDE.cols + col];
  return 0.08 + Math.min(KDE.maxHeight, (density / state.referencePeak) * KDE.maxHeight);
}

function stepReplay(direction) {
  const replay = state.replay;
  if (!replay.shots.length || state.view !== '3d') return;
  pauseReplay(false);
  clearReplayBalls();
  const length = replay.shots.length;
  const index = direction > 0
    ? replay.cursor % length
    : (replay.cursor > 0 ? replay.cursor - 2 : length - 1 + length) % length;
  const shot = replay.shots[index];
  replay.currentIndex = index;
  replay.cursor = index + 1;
  replay.stationary = shot;
  setReplayBall(0, new THREE.Vector3(shot.x, sampleSurfaceHeight(shot.x, shot.z) + REPLAY.ballRadius, shot.z));
  updateReplayControls();
  render3d();
}

function playReplay() {
  const replay = state.replay;
  if (replay.playing) {
    pauseReplay();
    return;
  }
  if (state.reducedMotion || state.view !== '3d' || !replay.shots.length) return;
  if (replay.cursor >= replay.shots.length && !replay.active.length) {
    clearReplayBalls();
    replay.cursor = 0;
    replay.currentIndex = -1;
    replay.elapsed = 0;
    replay.nextAt = 0;
  }
  replay.playing = true;
  replay.lastFrame = 0;
  replay.nextAt = replay.active.length ? replay.nextAt : replay.elapsed;
  updateReplayControls();
  scheduleReplayFrame();
}

function positionForShot(shot, simProgress) {
  const surfaceY = sampleSurfaceHeight(shot.x, shot.z);
  const start = new THREE.Vector3(shot.x, surfaceY + REPLAY.ballRadius, shot.z);
  const missSide = (shot.sourceIndex % 2 ? 1 : -1) * (shot.x < 0 ? -1 : 1);
  const impact = shot.made
    ? new THREE.Vector3(0, 0.32, 0)
    : new THREE.Vector3(missSide * 0.91, 0.32, 0.08);
  const rebound = new THREE.Vector3(missSide * 1.78, 1.22, 0.58);
  const flightFraction = shot.made ? 0.83 : 0.78;
  const horizontalDistance = Math.hypot(shot.x - impact.x, shot.z - impact.z);
  const arcHeight = Math.max(3.2, horizontalDistance * 0.28 + 2.1);
  if (simProgress <= flightFraction) {
    const t = simProgress / flightFraction;
    const position = start.clone().lerp(impact, t);
    position.y = THREE.MathUtils.lerp(start.y, impact.y, t) + 4 * t * (1 - t) * arcHeight;
    return position;
  }
  const t = (simProgress - flightFraction) / (1 - flightFraction);
  if (shot.made) return new THREE.Vector3(0, THREE.MathUtils.lerp(0.32, -0.56, t), 0);
  const position = impact.clone().lerp(rebound, t);
  position.y += 4 * t * (1 - t) * 0.9;
  return position;
}

function updateReplayFrame(now) {
  const replay = state.replay;
  replay.raf = 0;
  const delta = replay.lastFrame ? Math.min(80, now - replay.lastFrame) : 16.7;
  replay.lastFrame = now;
  if (replay.playing) {
    replay.elapsed += delta * replay.speed;
    while (replay.cursor < replay.shots.length && replay.elapsed >= replay.nextAt && replay.active.length < REPLAY.maxConcurrent) {
      const shotIndex = replay.cursor++;
      const slot = Array.from({ length: REPLAY.maxConcurrent }, (_, index) => index).find((index) => !replay.active.some((flight) => flight.slot === index));
      if (slot === undefined) break;
      replay.active.push({ shot: replay.shots[shotIndex], slot, startAt: replay.elapsed });
      replay.currentIndex = shotIndex;
      replay.nextAt = replay.elapsed + REPLAY.intervalMs;
      updateReplayControls();
    }
    const remaining = [];
    for (const flight of replay.active) {
      const progress = (replay.elapsed - flight.startAt) / REPLAY.flightMs;
      if (progress >= 1) {
        setReplayBall(flight.slot, null);
        if (flight.shot.made) replay.flashAt = now;
      } else {
        const position = positionForShot(flight.shot, THREE.MathUtils.clamp(progress, 0, 1));
        setReplayBall(flight.slot, position, progress * Math.PI * 8);
        remaining.push(flight);
      }
    }
    replay.active = remaining;
    if (replay.cursor >= replay.shots.length && !replay.active.length) {
      replay.playing = false;
      updateReplayControls();
    }
  }
  updateReplayEffect(now);
  state.controls?.update();
  render3d();
  if (replay.playing || now - replay.flashAt < 360) scheduleReplayFrame();
  else replay.lastFrame = 0;
}

function updateReplayEffect(now = performance.now()) {
  const replay = state.replay;
  if (!replay.flashMesh || !replay.goalLight || !replay.hoopMaterial) return;
  const age = now - replay.flashAt;
  if (age >= 0 && age < 360 && !state.reducedMotion) {
    const progress = age / 360;
    replay.flashMesh.material.opacity = (1 - progress) * 0.9;
    replay.flashMesh.scale.setScalar(1 + progress * 1.35);
    replay.goalLight.intensity = 22 + (1 - progress) * 180;
    replay.hoopMaterial.emissiveIntensity = 0.45 + (1 - progress) * 2.6;
  } else {
    replay.flashMesh.material.opacity = 0;
    replay.flashMesh.scale.setScalar(1);
    replay.goalLight.intensity = 22;
    replay.hoopMaterial.emissiveIntensity = 0.45;
  }
}

function scheduleReplayFrame() {
  if (!state.replay.raf) state.replay.raf = requestAnimationFrame(updateReplayFrame);
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
  if (enabled) {
    pauseReplay(false);
    clearReplayBalls();
    updateReplayEffect();
  }
  updateReplayControls();
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
  $('#replay-play').addEventListener('click', playReplay);
  $('#replay-previous').addEventListener('click', () => stepReplay(-1));
  $('#replay-next').addEventListener('click', () => stepReplay(1));
  $('#replay-speed').addEventListener('change', () => {
    state.replay.speed = Number($('#replay-speed').value);
  });
  fallbackCanvas.addEventListener('pointermove', onFallbackPointer);
  fallbackCanvas.addEventListener('pointerleave', hideTooltip);
  fallbackCanvas.addEventListener('click', (event) => {
    const sample = fallbackSampleAt(event);
    if (!sample) return;
    updateInspector(sample.bin);
    showTooltip(sample.bin, event.clientX, event.clientY, true, sample);
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
