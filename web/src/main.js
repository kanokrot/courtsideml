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
const REPLAY = { maxConcurrent: 5, intervalMs: 1200, prelaunchMs: 500, ballRadius: 0.39, maxParticles: 28, trailLength: 9 };
const PLAYER = {
  curry: { name: 'Stephen Curry', league: 'NBA', season: '2025', arc: 23.75, cornerX: 22, csv: curryCsvUrl, color: '#f1c36a' },
  paige: { name: 'Paige Bueckers', league: 'WNBA', season: '2025', arc: 22.15, cornerX: 21.67, csv: paigeCsvUrl, color: '#b7f35c' },
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
  view: '3d', mode: 'replay', renderer: null, scene: null, camera: null, controls: null,
  surfaceMesh: null, arcLines: null, composer: null, bloomPass: null,
  raycaster: new THREE.Raycaster(), pointer: new THREE.Vector2(),
  fallbackReason: '', frame: 0, reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  replay: { mesh: null, shots: [], active: [], playing: false, cursor: 0, currentIndex: -1, speed: 2, elapsed: 0, nextAt: 0, lastFrame: 0, raf: 0, flashAt: -Infinity, flashColor: '#8cff9d', stationary: null, goalLight: null, hoopMaterial: null, hoop: null, netMesh: null, flashMesh: null, trailMesh: null, sourceRings: null, sourceBeams: null, markerMade: null, markerMissed: null, markerMadeCount: 0, markerMissedCount: 0, particleMesh: null, particles: [], particleCursor: 0, markers: [], keepMarkers: true, followShot: false, cameraPreset: 'broadcast', rimShakeAt: -Infinity, netPulseAt: -Infinity },
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
      id: `${item.game_id || 'game'}-${sourceIndex}`,
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
  const line = makeCourtStrip(points, color, opacity, 0.2 * width);
  state.scene.add(line);
  return line;
}

function makeDashedLine(points, color, opacity = 1) {
  const line = makeCourtStrip(points, color, opacity, 0.12, [0.55, 0.32]);
  state.scene.add(line);
  return line;
}

function makeCourtStrip(points, color, opacity = 1, width = 0.14, dash = null) {
  const vertices = [];
  const indices = [];
  let pathDistance = 0;
  for (let segment = 0; segment < points.length - 1; segment += 1) {
    const [x0, z0] = points[segment], [x1, z1] = points[segment + 1];
    const dx = x1 - x0, dz = z1 - z0;
    const length = Math.hypot(dx, dz);
    if (!length) continue;
    const nx = -dz / length * width / 2, nz = dx / length * width / 2;
    const sections = [];
    if (!dash) sections.push([0, length]);
    else {
      let cursor = 0;
      const cycle = dash[0] + dash[1];
      let phase = (cycle - (pathDistance % cycle)) % cycle;
      while (cursor < length) {
        if (phase < dash[0]) {
          const end = Math.min(length, cursor + dash[0] - phase);
          sections.push([cursor, end]);
          cursor = end;
          phase = dash[0];
        } else {
          const step = Math.min(length - cursor, cycle - phase);
          cursor += step;
          phase = 0;
        }
      }
    }
    for (const [start, end] of sections) {
      if (end - start < 0.035) continue;
      const ax = x0 + dx * start / length, az = z0 + dz * start / length;
      const bx = x0 + dx * end / length, bz = z0 + dz * end / length;
      const base = vertices.length / 3;
      vertices.push(ax + nx, 0.045, az + nz, ax - nx, 0.045, az - nz, bx + nx, 0.045, bz + nz, bx - nx, 0.045, bz - nz);
      indices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
    }
    pathDistance += length;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, side: THREE.DoubleSide, toneMapped: false }));
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

function makeInstancePool(geometry, material, capacity) {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  for (let slot = 0; slot < capacity; slot += 1) {
    replayTransform.position.set(0, -100, 0);
    replayTransform.rotation.set(0, 0, 0);
    replayTransform.scale.setScalar(0);
    replayTransform.updateMatrix();
    mesh.setMatrixAt(slot, replayTransform.matrix);
  }
  state.scene.add(mesh);
  return mesh;
}

function writeInstance(mesh, slot, position, scale, rotation = null, color = null) {
  if (!mesh) return;
  if (!position) {
    replayTransform.position.set(0, -100, 0);
    replayTransform.rotation.set(0, 0, 0);
    replayTransform.scale.setScalar(0);
  } else {
    replayTransform.position.copy(position);
    replayTransform.scale.copy(scale);
    if (rotation) replayTransform.rotation.copy(rotation);
    else replayTransform.rotation.set(0, 0, 0);
  }
  replayTransform.updateMatrix();
  mesh.setMatrixAt(slot, replayTransform.matrix);
  if (color && mesh.setColorAt) mesh.setColorAt(slot, color);
  mesh.instanceMatrix.needsUpdate = true;
  if (color && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}

function createReplayBallInstances() {
  const geometry = new THREE.SphereGeometry(REPLAY.ballRadius, 28, 20);
  const texture = makeBasketballTexture();
  const material = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false });
  state.replay.mesh = makeInstancePool(geometry, material, REPLAY.maxConcurrent);
  state.replay.sourceRings = makeInstancePool(
    new THREE.TorusGeometry(0.44, 0.045, 6, 22),
    new THREE.MeshBasicMaterial({ color: '#ffffff', vertexColors: true, transparent: true, opacity: 0.86, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    REPLAY.maxConcurrent,
  );
  state.replay.sourceBeams = makeInstancePool(
    new THREE.CylinderGeometry(0.018, 0.018, 1, 6),
    new THREE.MeshBasicMaterial({ color: '#ffffff', vertexColors: true, transparent: true, opacity: 0.45, depthWrite: false, toneMapped: false }),
    REPLAY.maxConcurrent,
  );
  state.replay.trailMesh = makeInstancePool(
    new THREE.SphereGeometry(0.075, 8, 6),
    new THREE.MeshBasicMaterial({ color: '#f2a34a', transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    REPLAY.maxConcurrent * REPLAY.trailLength,
  );
  const markerCapacity = 1600;
  const markerGeometry = new THREE.RingGeometry(0.2, 0.4, 22);
  const markerMaterial = new THREE.MeshBasicMaterial({ color: '#9dff8c', transparent: true, opacity: 0.62, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
  state.replay.markerMade = makeInstancePool(markerGeometry, markerMaterial, markerCapacity);
  state.replay.markerMissed = makeInstancePool(
    markerGeometry,
    new THREE.MeshBasicMaterial({ color: '#ff7868', transparent: true, opacity: 0.38, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }),
    markerCapacity,
  );
  state.replay.particleMesh = makeInstancePool(
    new THREE.SphereGeometry(0.08, 8, 6),
    new THREE.MeshBasicMaterial({ color: '#ffffff', vertexColors: true, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    REPLAY.maxParticles,
  );
  state.replay.particles = Array(REPLAY.maxParticles).fill(null);
}

function setReplayBall(slot, position, rotationY = 0) {
  writeInstance(state.replay.mesh, slot, position, new THREE.Vector3(1, 1, 1), new THREE.Euler(rotationY * 0.7, rotationY, rotationY * 0.35));
}

function buildCourt() {
  state.scene = new THREE.Scene();
  state.scene.background = new THREE.Color('#070b10');
  state.scene.fog = new THREE.Fog('#070b10', 112, 220);
  state.scene.add(new THREE.HemisphereLight('#9aabb1', '#21170f', 0.7));
  const fill = new THREE.DirectionalLight('#8aa5aa', 0.48);
  fill.position.set(-24, 32, 46);
  state.scene.add(fill);

  for (const [x, z, color] of [[-16, 14, '#ffe2b0'], [0, 20, '#fff0cb'], [16, 14, '#ffe2b0']]) {
    const target = new THREE.Object3D();
    target.position.set(0, 0, 18.75);
    state.scene.add(target);
    const spotlight = new THREE.SpotLight(color, 220, 118, Math.PI / 5.4, 0.72, 2);
    spotlight.position.set(x, 32, z);
    spotlight.target = target;
    state.scene.add(spotlight);
  }
  state.replay.goalLight = new THREE.PointLight('#ffbd72', 18, 26, 2);
  state.replay.goalLight.position.set(0, 12.5, 0.5);
  state.scene.add(state.replay.goalLight);

  const floor = new THREE.Mesh(new THREE.BoxGeometry(180, 0.5, 180), new THREE.MeshStandardMaterial({ color: '#11171b', roughness: 0.96 }));
  floor.position.set(0, -0.55, 20);
  state.scene.add(floor);
  const court = new THREE.Mesh(new THREE.BoxGeometry(50, 0.16, 47), new THREE.MeshStandardMaterial({ color: '#91613a', emissive: '#281306', emissiveIntensity: 0.32, roughness: 0.62, metalness: 0.01 }));
  court.position.set(0, -0.22, 18.75);
  state.scene.add(court);
  const plankDepth = 47 / 13;
  for (let index = 0; index < 13; index += 1) {
    const plank = new THREE.Mesh(
      new THREE.BoxGeometry(49.88, 0.012, plankDepth - 0.045),
      new THREE.MeshStandardMaterial({ color: '#b17a4d', emissive: '#47240e', emissiveIntensity: 0.24, roughness: 0.58, metalness: 0.01 }),
    );
    plank.position.set(0, -0.135, -4.75 + plankDepth * (index + 0.5));
    state.scene.add(plank);
  }

  const line = '#eef0d1';
  const faint = '#c6ad84';
  const x0 = -25, x1 = 25, z0 = -4.75, z1 = 42.25;
  makeLine([[x0,z0],[x1,z0],[x1,z1],[x0,z1],[x0,z0]], line, 0.9);
  makeLine([[-8,z0],[-8,10.25],[8,10.25],[8,z0]], line, 0.86);
  makeLine(makeArc(6, 0, Math.PI, 48, 0, 10.25), line, 0.82);
  makeDashedLine(makeArc(6, Math.PI, Math.PI * 2, 48, 0, 10.25), faint, 0.62);
  makeLine(makeArc(4, 0, Math.PI, 48, 0, 0), line, 0.8);
  drawThreePointArc();
  makeLine(makeArc(6, Math.PI, Math.PI * 2, 54, 0, 42.25), faint, 0.66);

  const hoopMaterial = new THREE.MeshStandardMaterial({ color: '#ff8a32', emissive: '#e95a0b', emissiveIntensity: 0.85, roughness: 0.42, toneMapped: false });
  const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.75, 0.08, 8, 40), hoopMaterial);
  hoop.rotation.x = Math.PI / 2;
  hoop.position.set(0, 10, 0);
  state.scene.add(hoop);
  state.replay.hoopMaterial = hoopMaterial;
  state.replay.hoop = hoop;
  const net = new THREE.Mesh(
    new THREE.CylinderGeometry(0.62, 0.34, 1.25, 18, 5, true),
    new THREE.MeshBasicMaterial({ color: '#f0eddf', wireframe: true, transparent: true, opacity: 0.64, toneMapped: false }),
  );
  net.position.set(0, 9.38, 0);
  state.scene.add(net);
  state.replay.netMesh = net;
  const board = new THREE.Mesh(new THREE.BoxGeometry(6, 3.5, 0.16), new THREE.MeshPhysicalMaterial({ color: '#c9e5dc', transparent: true, opacity: 0.22, roughness: 0.2, metalness: 0.08, side: THREE.DoubleSide }));
  board.position.set(0, 10.75, -1.35);
  state.scene.add(board);
  const boardFrame = new THREE.LineSegments(
    new THREE.EdgesGeometry(board.geometry),
    new THREE.LineBasicMaterial({ color: '#d9f2ec', transparent: true, opacity: 0.92, toneMapped: false }),
  );
  boardFrame.position.copy(board.position);
  state.scene.add(boardFrame);
  const targetSquare = new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.25, 0.035), new THREE.MeshBasicMaterial({ color: '#e6ebd5', wireframe: true, transparent: true, opacity: 0.84, toneMapped: false }));
  targetSquare.position.set(0, 10.2, -1.24);
  state.scene.add(targetSquare);
  const support = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.2, 10, 10), new THREE.MeshStandardMaterial({ color: '#28333a', metalness: 0.72, roughness: 0.38 }));
  support.position.set(0, 5, -3.05);
  state.scene.add(support);
  const supportArm = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 1.8), new THREE.MeshStandardMaterial({ color: '#364148', metalness: 0.7, roughness: 0.4 }));
  supportArm.position.set(0, 10.1, -2.35);
  state.scene.add(supportArm);
  const flashMaterial = new THREE.MeshBasicMaterial({ color: '#8cff9d', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const flashMesh = new THREE.Mesh(new THREE.TorusGeometry(0.82, 0.05, 8, 40), flashMaterial);
  flashMesh.rotation.x = Math.PI / 2;
  flashMesh.position.set(0, 10.08, 0);
  state.scene.add(flashMesh);
  state.replay.flashMesh = flashMesh;
  createReplayBallInstances();

  state.camera = new THREE.PerspectiveCamera(46, 1, 0.1, 240);
  state.controls = new OrbitControls(state.camera, canvas);
  state.controls.enablePan = false;
  state.controls.enableDamping = !state.reducedMotion;
  state.controls.dampingFactor = 0.08;
  state.controls.minDistance = 34;
  state.controls.maxDistance = 142;
  state.controls.minPolarAngle = 0.12;
  state.controls.maxPolarAngle = Math.PI / 2 - 0.025;
  state.controls.minAzimuthAngle = -Math.PI;
  state.controls.maxAzimuthAngle = Math.PI;
  state.controls.addEventListener('change', () => {
    updateCallout(state.replay.stationary || state.replay.active[0]?.shot);
    scheduleRender();
  });
  applyCameraPreset('broadcast', true);
}

function drawThreePointArc() {
  if (state.arcLines) {
    state.scene.remove(state.arcLines);
    state.arcLines.traverse((item) => { item.geometry?.dispose(); item.material?.dispose(); });
  }
  const { arc, cornerX: corner } = PLAYER[state.player];
  const cornerZ = Math.sqrt(Math.max(0, arc ** 2 - corner ** 2));
  const group = new THREE.Group();
  const addLine = (points) => {
    group.add(makeCourtStrip(points, '#d1caa8', 0.9, 0.2));
  };
  addLine([[-corner, -4.75], [-corner, cornerZ]]);
  addLine([[corner, -4.75], [corner, cornerZ]]);
  const angle = Math.atan2(cornerZ, corner);
  addLine(makeArc(arc, angle, Math.PI - angle, 82));
  state.scene.add(group);
  state.arcLines = group;
}

function applyCameraPreset(name, initial = false) {
  if (!state.camera || !state.controls) return;
  const presets = {
    broadcast: { position: new THREE.Vector3(-48, 72, 66), target: new THREE.Vector3(0, 8, 0), up: new THREE.Vector3(0, 1, 0) },
    behind: { position: new THREE.Vector3(0, 24, -36), target: new THREE.Vector3(0, 9, 20), up: new THREE.Vector3(0, 1, 0) },
    top: { position: new THREE.Vector3(0, 86, 19), target: new THREE.Vector3(0, 0, 19), up: new THREE.Vector3(0, 0, 1) },
  };
  const preset = presets[name] || presets.broadcast;
  state.replay.cameraPreset = name in presets ? name : 'broadcast';
  state.camera.up.copy(preset.up);
  state.controls.target.copy(preset.target);
  state.camera.position.copy(preset.position);
  state.camera.lookAt(preset.target);
  state.controls.update();
  state.controls.saveState();
  for (const button of document.querySelectorAll('[data-camera]')) {
    const active = button.dataset.camera === state.replay.cameraPreset;
    button.setAttribute('aria-pressed', String(active));
  }
  updateCallout(state.replay.stationary);
  if (!initial) render3d();
}

function scheduleRender() {
  if (state.frame || !state.renderer || state.view !== '3d' || document.hidden) return;
  state.frame = requestAnimationFrame(() => {
    state.frame = 0;
    state.controls?.update();
    render3d();
  });
}

function render3d() {
  if (state.composer && state.scene && state.camera && state.view === '3d' && !document.hidden) state.composer.render();
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
  const colors = new Float32Array(KDE.cols * KDE.rows * 4);
  const maxHeight = KDE.maxHeight;
  const lowCut = surface.maxDensity * 0.001;
  const heatLow = new THREE.Color('#174c68');
  const heatHigh = new THREE.Color('#91e4d0');
  for (let z = 0; z < KDE.rows; z += 1) {
    for (let x = 0; x < KDE.cols; x += 1) {
      const index = z * KDE.cols + x;
      const density = surface.density[index];
      const height = Math.min(maxHeight, (density / state.referencePeak) * maxHeight);
      const relativeDensity = density / state.referencePeak;
      const edge = THREE.MathUtils.smoothstep(relativeDensity, 0.002, 0.09);
      const color = state.mode === 'heatmap'
        ? heatLow.clone().lerp(heatHigh, THREE.MathUtils.clamp(relativeDensity, 0, 1))
        : colorAt(surface.fg[index], surface.colorMin, surface.colorMax);
      const offset = index * 4;
      positions[offset] = KDE.xMin + x * KDE.stepX;
      positions[offset + 1] = 0.08 + height;
      positions[offset + 2] = KDE.zMin + z * KDE.stepZ;
      colors[offset] = color.r;
      colors[offset + 1] = color.g;
      colors[offset + 2] = color.b;
      colors[offset + 3] = edge * 0.82;
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
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  const material = new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: state.mode === 'heatmap' ? 0.72 : 0.78,
    depthWrite: false, toneMapped: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.surface = surface;
  mesh.userData.threshold = lowCut;
  mesh.visible = state.mode === 'heatmap';
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
  state.camera.fov = rect.width < 700 ? 54 : 46;
  state.camera.updateProjectionMatrix();
  render3d();
}

function init3d() {
  const observer = new ResizeObserver(() => {
    if (state.view === '2d') drawFallbackCourt();
    else fitRenderer();
  });
  observer.observe(stage);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (state.replay.raf) cancelAnimationFrame(state.replay.raf);
      state.replay.raf = 0;
      if (state.frame) cancelAnimationFrame(state.frame);
      state.frame = 0;
      state.replay.lastFrame = 0;
    } else if (state.replay.playing) scheduleReplayFrame();
    else render3d();
  });
  window.addEventListener('resize', () => {
    if (state.view === '2d') drawFallbackCourt();
    else fitRenderer();
  }, { passive: true });
  try {
    state.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'low-power' });
    state.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    state.renderer.outputColorSpace = THREE.SRGBColorSpace;
    state.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    state.renderer.toneMappingExposure = 1.12;
    buildCourt();
    state.composer = new EffectComposer(state.renderer);
    state.composer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    state.composer.addPass(new RenderPass(state.scene, state.camera));
    state.bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.22, 0.34, 0.9);
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
  if (state.mode !== 'heatmap' || !state.renderer || !state.surfaceMesh || !state.surfaceMesh.geometry.index) return null;
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
  const { cornerX: corner } = PLAYER[state.player];
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
  $('#view-toggle').textContent = is2d ? 'Return to 3D' : '2D fallback';
  $('#view-toggle').setAttribute('aria-pressed', String(is2d));
  $('#view-label').textContent = is2d ? '2D FALLBACK' : (state.mode === 'heatmap' ? 'HEATMAP' : 'SHOT REPLAY');
  $('#encoding-label').innerHTML = is2d
    ? '2D FALLBACK <i class="caption-separator">·</i> DENSITY + FG% BY ZONE'
    : state.mode === 'heatmap'
      ? 'HEIGHT = SHOT DENSITY <i class="caption-separator">·</i> COLOR = SHOT VOLUME'
      : 'SHOT ORIGIN + OUTCOME <i class="caption-separator">·</i> BALL PATH IS SIMULATED';
  $('#render-status').textContent = message || (is2d ? '2D court map · tap a location for local values' : (state.mode === 'heatmap' ? 'Heatmap · height and hue show shot density; FG% remains in zone values.' : 'Shot replay · use Play, Next, or drag the timeline.'));
  $('#replay-hud').hidden = state.mode !== 'replay' || is2d;
  $('#replay-panel').hidden = state.mode !== 'replay';
  if (state.surfaceMesh) state.surfaceMesh.visible = !is2d && state.mode === 'heatmap';
  for (const mesh of [state.replay.markerMade, state.replay.markerMissed]) if (mesh) mesh.visible = !is2d && state.mode === 'replay' && state.replay.keepMarkers;
  updateReplayControls();
  if (is2d) {
    tooltip.hidden = true;
    drawFallback();
  } else {
    fitRenderer();
    render3d();
  }
}

function setMode(mode) {
  state.mode = mode === 'heatmap' ? 'heatmap' : 'replay';
  if (state.mode === 'heatmap') {
    pauseReplay(false);
    clearReplayBalls();
  }
  for (const button of document.querySelectorAll('[data-mode]')) {
    const active = button.dataset.mode === state.mode;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  $('#view-label').textContent = state.view === '2d' ? '2D FALLBACK' : (state.mode === 'heatmap' ? 'HEATMAP' : 'SHOT REPLAY');
  $('#encoding-label').innerHTML = state.mode === 'heatmap'
    ? 'HEIGHT = SHOT DENSITY <i class="caption-separator">·</i> COLOR = SHOT VOLUME'
    : 'SHOT ORIGIN + OUTCOME <i class="caption-separator">·</i> BALL PATH IS SIMULATED';
  $('#chart-eyebrow').textContent = state.mode === 'heatmap' ? 'SHOT HEATMAP' : 'SHOT REPLAY';
  $('#chart-title').textContent = state.mode === 'heatmap' ? 'Where shots were taken' : 'One shot at a time';
  $('#data-source').textContent = state.mode === 'heatmap'
    ? 'A 3.2 ft Gaussian KDE estimates shot volume from recorded locations. FG% is listed per zone.'
    : 'Shot locations and results come from the dataset. Release height and the animated arc are simulated.';
  $('#render-status').textContent = state.mode === 'heatmap'
    ? 'Heatmap · height and hue show shot density; FG% remains in zone values.'
    : 'Shot replay · use Play, Next, or drag the timeline.';
  if (state.surfaceMesh) state.surfaceMesh.visible = state.view === '3d' && state.mode === 'heatmap';
  for (const mesh of [state.replay.markerMade, state.replay.markerMissed]) if (mesh) mesh.visible = state.view === '3d' && state.mode === 'replay' && state.replay.keepMarkers;
  $('#fg-legend-block').hidden = true;
  $('#heatmap-legend').hidden = state.mode !== 'heatmap';
  $('#replay-legend').hidden = state.mode !== 'replay';
  $('#replay-panel').hidden = state.mode !== 'replay';
  $('#follow-control').hidden = state.mode === 'heatmap';
  $('#replay-hud').hidden = state.mode !== 'replay' || state.view !== '3d';
  updateReplayControls();
  if (state.view === '2d') drawFallbackCourt();
  render3d();
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
    : state.mode === 'heatmap'
      ? 'Heatmap · height and hue show shot density; FG% remains in zone values.'
      : 'Shot replay · use Play, Next, or drag the timeline.';
}

function secondsRemaining(clock) {
  const match = /^(\d+):(\d{2})$/.exec(String(clock || '').trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function orderedReplayShots(shots) {
  const gameOrder = new Map();
  const games = [...new Set(shots.map((shot) => shot.game))];
  const numericGameIds = games.every((game) => /^\d+$/.test(game));
  if (numericGameIds) games.sort((a, b) => Number(a) - Number(b));
  else games.sort((a, b) => Math.min(...shots.filter((shot) => shot.game === a).map((shot) => shot.sourceIndex)) - Math.min(...shots.filter((shot) => shot.game === b).map((shot) => shot.sourceIndex)));
  games.forEach((game, index) => gameOrder.set(game, index));
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
  const period = Number.isFinite(shot.period) ? `Q${shot.period}` : 'PERIOD N/A';
  return `GAME ${shot.game || String(shot.gameOrder + 1).padStart(2, '0')} · ${period} · ${shot.clock || 'TIME N/A'} · ${shot.made ? 'MADE' : 'MISSED'}`;
}

function updateReplayHUD() {
  const replay = state.replay;
  const index = replay.currentIndex;
  const shot = index >= 0 ? replay.shots[index] : null;
  const count = replay.shots.length;
  const made = shot ? replay.shots.slice(0, index + 1).reduce((total, item) => total + Number(item.made), 0) : 0;
  const attempts = shot ? index + 1 : 0;
  const fg = attempts ? `${(made * 100 / attempts).toFixed(1)}%` : '—';
  $('#hud-counter').textContent = `${shot ? index + 1 : 0} / ${count.toLocaleString()}`;
  $('#hud-game-time').textContent = shot ? replayShotLabel(shot) : 'READY · SELECT PLAY';
  $('#hud-result').textContent = shot ? (shot.made ? 'MADE' : 'MISSED') : 'READY';
  $('#hud-result').classList.toggle('is-made', !!shot?.made);
  $('#hud-result').classList.toggle('is-missed', !!shot && !shot.made);
  $('#hud-shot').textContent = shot ? `${shot.distance.toFixed(1)} FT · ${shot.type}` : 'DISTANCE — · TYPE —';
  $('#hud-cumulative').textContent = `MADE ${made.toLocaleString()} / ${attempts.toLocaleString()} · FG ${fg}`;
  $('#replay-hud').hidden = state.mode !== 'replay' || state.view !== '3d';
}

function updateReplayControls() {
  const replay = state.replay;
  const count = replay.shots.length;
  const index = replay.currentIndex;
  const usable = state.view === '3d' && state.mode === 'replay' && count > 0;
  $('#replay-play').textContent = replay.playing ? 'Pause replay' : 'Play replay';
  $('#replay-play').setAttribute('aria-label', replay.playing ? 'Pause shot replay' : 'Play shot replay');
  $('#replay-play').disabled = state.reducedMotion || !usable;
  $('#replay-previous').disabled = !usable;
  $('#replay-next').disabled = !usable;
  $('#replay-speed').disabled = !count;
  $('#replay-scrubber').disabled = !usable;
  $('#replay-scrubber').max = String(Math.max(0, count - 1));
  $('#replay-scrubber').value = String(Math.max(0, index));
  $('#replay-scrubber').setAttribute('aria-valuetext', index >= 0 ? replayShotLabel(replay.shots[index]) : 'No shot selected');
  $('#replay-counter').textContent = `${index >= 0 ? index + 1 : 0} / ${count.toLocaleString()} SHOTS`;
  const label = index >= 0 ? replayShotLabel(replay.shots[index]) : '';
  let status;
  if (!count) status = 'No shots match the current filters.';
  else if (state.reducedMotion) status = 'Reduced motion is on · use Previous or Next to inspect shots without flight animation.';
  else if (state.mode === 'heatmap') status = 'Heatmap mode · select Replay to play simulated flights.';
  else if (state.view !== '3d') status = 'Switch to the 3D view to play simulated flights.';
  else if (replay.playing) status = label || 'Starting replay…';
  else if (replay.cursor >= count && !replay.active.length) status = 'Replay complete · press Play to start again.';
  else if (label) status = `${label} · paused`;
  else status = 'Ready · ordered by game, period, and clock time.';
  $('#replay-status').textContent = status;
  const selected = index >= 0 ? replay.shots[index] : null;
  $('#replay-status').setAttribute('aria-label', selected ? `${replayShotLabel(selected)}. ${status}` : status);
  updateReplayHUD();
}

function clearMarkers() {
  const replay = state.replay;
  replay.markers = [];
  replay.markerMadeCount = 0;
  replay.markerMissedCount = 0;
  for (let index = 0; index < 1600; index += 1) {
    writeInstance(replay.markerMade, index, null, new THREE.Vector3(1, 1, 1));
    writeInstance(replay.markerMissed, index, null, new THREE.Vector3(1, 1, 1));
  }
}

function clearReplayBalls() {
  const replay = state.replay;
  replay.active = [];
  replay.stationary = null;
  for (let slot = 0; slot < REPLAY.maxConcurrent; slot += 1) {
    setReplayBall(slot, null);
    writeInstance(replay.sourceRings, slot, null, new THREE.Vector3(1, 1, 1));
    writeInstance(replay.sourceBeams, slot, null, new THREE.Vector3(1, 1, 1));
  }
  for (let index = 0; index < REPLAY.maxConcurrent * REPLAY.trailLength; index += 1) {
    writeInstance(replay.trailMesh, index, null, new THREE.Vector3(1, 1, 1));
  }
  replay.particles.fill(null);
  for (let index = 0; index < REPLAY.maxParticles; index += 1) writeInstance(replay.particleMesh, index, null, new THREE.Vector3(1, 1, 1));
  $('#shot-callout').hidden = true;
  replay.flashAt = -Infinity;
  updateReplayEffect();
}

function setReplayShots(shots) {
  pauseReplay(false);
  clearReplayBalls();
  clearMarkers();
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

function shotStartHeight(shot) {
  return shot.distance <= 8 ? 6 : 7;
}

function shotHash(shot) {
  let hash = 2166136261;
  for (const char of shot.id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

function missImpact(shot) {
  const hash = shotHash(shot);
  const side = hash & 1 ? 1 : -1;
  const offset = 0.6 + ((hash >>> 1) % 5) * 0.1;
  const pattern = (hash >>> 4) % 5;
  if (pattern === 0) return { type: 'front rim', point: new THREE.Vector3(side * 0.22, 10, offset) };
  if (pattern === 1) return { type: 'back rim', point: new THREE.Vector3(side * 0.22, 10, -offset) };
  if (pattern === 2) return { type: 'left rim', point: new THREE.Vector3(-offset, 10, 0) };
  if (pattern === 3) return { type: 'right rim', point: new THREE.Vector3(offset, 10, 0) };
  return { type: 'backboard', point: new THREE.Vector3(side * 0.4, 11.3, -1.43) };
}

function addShotMarker(shot) {
  const replay = state.replay;
  if (!replay.keepMarkers) return;
  const made = shot.made;
  const slot = made ? replay.markerMadeCount++ : replay.markerMissedCount++;
  const mesh = made ? replay.markerMade : replay.markerMissed;
  if (slot >= 1600) return;
  const rotation = new THREE.Euler(-Math.PI / 2, 0, 0);
  writeInstance(mesh, slot, new THREE.Vector3(shot.x, 0.025, shot.z), new THREE.Vector3(1, 1, 1), rotation);
  replay.markers.push({ x: shot.x, z: shot.z, made });
  mesh.visible = state.mode === 'replay' && state.view === '3d' && replay.keepMarkers;
}

function updateCallout(shot) {
  const callout = $('#shot-callout');
  if (!shot || state.mode !== 'replay' || state.view !== '3d') { callout.hidden = true; return; }
  const point = new THREE.Vector3(shot.x, shotStartHeight(shot), shot.z).project(state.camera);
  const rect = stage.getBoundingClientRect();
  const left = (point.x * 0.5 + 0.5) * rect.width;
  const top = (-point.y * 0.5 + 0.5) * rect.height;
  if (point.z < -1 || point.z > 1 || left < 12 || left > rect.width - 160 || top < 35 || top > rect.height - 30) { callout.hidden = true; return; }
  callout.textContent = `${shot.distance.toFixed(1)} FT · ${shot.type}`;
  callout.style.left = `${left + 12}px`;
  callout.style.top = `${top - 14}px`;
  callout.hidden = false;
}

function stepReplay(direction) {
  const replay = state.replay;
  if (!replay.shots.length || state.view !== '3d' || state.mode !== 'replay') return;
  pauseReplay(false);
  clearReplayBalls();
  const length = replay.shots.length;
  const index = replay.currentIndex < 0
    ? (direction > 0 ? 0 : length - 1)
    : (replay.currentIndex + direction + length) % length;
  const shot = replay.shots[index];
  replay.currentIndex = index;
  replay.cursor = index;
  replay.stationary = shot;
  if (state.reducedMotion) addShotMarker(shot);
  else setReplayBall(0, new THREE.Vector3(shot.x, shotStartHeight(shot), shot.z));
  updateCallout(shot);
  updateReplayControls();
  render3d();
}

function seekReplay(index) {
  const replay = state.replay;
  if (!replay.shots.length) return;
  pauseReplay(false);
  clearReplayBalls();
  const shotIndex = THREE.MathUtils.clamp(Math.round(index), 0, replay.shots.length - 1);
  const shot = replay.shots[shotIndex];
  replay.currentIndex = shotIndex;
  replay.cursor = shotIndex;
  replay.stationary = shot;
  if (state.reducedMotion) addShotMarker(shot);
  else setReplayBall(0, new THREE.Vector3(shot.x, shotStartHeight(shot), shot.z));
  updateCallout(shot);
  updateReplayControls();
  render3d();
}

function playReplay() {
  const replay = state.replay;
  if (replay.playing) { pauseReplay(); return; }
  if (state.reducedMotion || state.view !== '3d' || state.mode !== 'replay' || !replay.shots.length) return;
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

function createFlight(shot, shotIndex, slot, now) {
  const hit = shot.made ? null : missImpact(shot);
  const impact = shot.made ? new THREE.Vector3(0, 10, 0) : hit.point;
  const radial = new THREE.Vector3(impact.x, 0, impact.z);
  if (radial.lengthSq() < 0.01) radial.set(shot.x < 0 ? -1 : 1, 0, 0);
  radial.normalize();
  const rebound = hit?.type === 'backboard'
    ? new THREE.Vector3(impact.x * 0.8, 8.8, 0.8)
    : impact.clone().add(new THREE.Vector3(radial.x * 1.6, -1.0, radial.z * 1.6));
  const flightSeconds = THREE.MathUtils.clamp(0.7 + 0.025 * shot.distance, 0.8, 1.6);
  return {
    shot, shotIndex, slot, startAt: now, flightMs: flightSeconds * 1000,
    start: new THREE.Vector3(shot.x, shotStartHeight(shot), shot.z), impact, rebound,
    variant: hit?.type || 'made', arcHeight: THREE.MathUtils.clamp(2.5 + 0.12 * shot.distance, 3, 9), trail: [],
  };
}

function flightPosition(flight, progress) {
  if (progress < 0.78) {
    const t = progress / 0.78;
    const position = flight.start.clone().lerp(flight.impact, t);
    position.y = THREE.MathUtils.lerp(flight.start.y, flight.impact.y, t) + 4 * flight.arcHeight * t * (1 - t);
    return position;
  }
  const t = (progress - 0.78) / 0.22;
  if (flight.shot.made) return new THREE.Vector3(0, 10 - 9.6 * t * t, 0);
  if (t < 0.5) {
    const bounce = t * 2;
    const position = flight.impact.clone().lerp(flight.rebound, bounce);
    position.y = THREE.MathUtils.lerp(flight.impact.y, flight.rebound.y, bounce) + 4.5 * bounce * (1 - bounce);
    return position;
  }
  const drop = (t - 0.5) * 2;
  return new THREE.Vector3(flight.rebound.x, THREE.MathUtils.lerp(flight.rebound.y, REPLAY.ballRadius, drop) + 4 * 0.55 * drop * (1 - drop), flight.rebound.z + drop * 0.35);
}

function updateTrails(flight, position) {
  flight.trail.push(position.clone());
  if (flight.trail.length > REPLAY.trailLength) flight.trail.shift();
  const startSlot = flight.slot * REPLAY.trailLength;
  for (let i = 0; i < REPLAY.trailLength; i += 1) {
    const trailIndex = Math.max(0, flight.trail.length - REPLAY.trailLength + i);
    const trailPoint = i < REPLAY.trailLength - flight.trail.length ? null : flight.trail[trailIndex];
    const fade = (i + 1) / REPLAY.trailLength;
    writeInstance(state.replay.trailMesh, startSlot + i, trailPoint, new THREE.Vector3(fade, fade, fade));
  }
}

function emitParticles(flight, atMade, now) {
  const replay = state.replay;
  const hash = shotHash(flight.shot);
  const count = atMade ? 16 : 8;
  const origin = atMade ? new THREE.Vector3(0, 10.15, 0) : flight.impact.clone();
  const tint = new THREE.Color(atMade ? '#8cff9d' : '#ff615d');
  for (let index = 0; index < count; index += 1) {
    const slot = replay.particleCursor++ % REPLAY.maxParticles;
    const angle = (Math.PI * 2 * index) / count + ((hash & 255) / 255) * 0.35;
    const speed = 0.8 + ((hash >>> (index % 16)) & 7) * 0.13;
    replay.particles[slot] = {
      start: origin.clone(), startAt: now, life: 0.42 + (index % 4) * 0.06,
      velocity: new THREE.Vector3(Math.cos(angle) * speed, 1.1 + (index % 5) * 0.28, Math.sin(angle) * speed), color: tint.clone(),
    };
    writeInstance(replay.particleMesh, slot, origin, new THREE.Vector3(1, 1, 1), null, tint);
  }
}

function updateParticles() {
  const replay = state.replay;
  for (let slot = 0; slot < replay.particles.length; slot += 1) {
    const particle = replay.particles[slot];
    if (!particle) { writeInstance(replay.particleMesh, slot, null, new THREE.Vector3(1, 1, 1)); continue; }
    const age = (performance.now() - particle.startAt) / 1000;
    const progress = age / particle.life;
    if (progress >= 1) {
      replay.particles[slot] = null;
      writeInstance(replay.particleMesh, slot, null, new THREE.Vector3(1, 1, 1));
    } else {
      const position = particle.start.clone().addScaledVector(particle.velocity, age);
      position.y -= 4.5 * age * age;
      const scale = Math.max(0.03, 1 - progress);
      writeInstance(replay.particleMesh, slot, position, new THREE.Vector3(scale, scale, scale));
    }
  }
}

function updateShotOrigins() {
  const replay = state.replay;
  let calloutShot = null;
  for (const flight of replay.active) {
    const age = replay.elapsed - flight.startAt;
    const slot = flight.slot;
    if (age < REPLAY.prelaunchMs) {
      const pulse = 1 + 0.55 * Math.sin(Math.PI * age / REPLAY.prelaunchMs);
      const tint = new THREE.Color(flight.shot.made ? '#82ff9a' : '#ff7065');
      const ringRotation = new THREE.Euler(-Math.PI / 2, 0, 0);
      writeInstance(replay.sourceRings, slot, new THREE.Vector3(flight.shot.x, 0.045, flight.shot.z), new THREE.Vector3(pulse, pulse, pulse), ringRotation, tint);
      const height = shotStartHeight(flight.shot);
      writeInstance(replay.sourceBeams, slot, new THREE.Vector3(flight.shot.x, height / 2, flight.shot.z), new THREE.Vector3(1, height, 1), null, tint);
      if (!calloutShot) calloutShot = flight.shot;
    } else {
      writeInstance(replay.sourceRings, slot, null, new THREE.Vector3(1, 1, 1));
      writeInstance(replay.sourceBeams, slot, null, new THREE.Vector3(1, 1, 1));
    }
  }
  updateCallout(calloutShot);
}

function followActiveShot() {
  const replay = state.replay;
  if (!replay.followShot || state.reducedMotion || !replay.active.length) return;
  const flight = replay.active.find((item) => replay.elapsed - item.startAt >= REPLAY.prelaunchMs);
  if (!flight) return;
  const age = replay.elapsed - flight.startAt - REPLAY.prelaunchMs;
  const progress = THREE.MathUtils.clamp(age / flight.flightMs, 0, 1);
  const ball = flightPosition(flight, progress);
  const target = new THREE.Vector3(ball.x * 0.15, 7 + ball.y * 0.08, 18 + ball.z * 0.12);
  const offset = state.camera.position.clone().sub(state.controls.target);
  state.controls.target.lerp(target, 0.025);
  state.camera.position.copy(state.controls.target).add(offset);
}

function updateReplayFeedback(now) {
  const replay = state.replay;
  const madeFlashAge = now - replay.flashAt;
  if (madeFlashAge >= 0 && madeFlashAge < 520 && !state.reducedMotion) {
    const progress = madeFlashAge / 520;
    replay.flashMesh.material.color.set(replay.flashColor);
    replay.flashMesh.material.opacity = (1 - progress) * 0.36;
    replay.flashMesh.scale.setScalar(1 + progress * 1.3);
    replay.goalLight.color.set(replay.flashColor);
    replay.goalLight.intensity = 18 + (1 - progress) * 26;
    replay.hoopMaterial.emissiveIntensity = 0.85 + (1 - progress) * 0.7;
  } else {
    replay.flashMesh.material.opacity = 0;
    replay.flashMesh.scale.setScalar(1);
    replay.goalLight.color.set('#ffbd72');
    replay.goalLight.intensity = 18;
    replay.hoopMaterial.emissiveIntensity = 0.85;
  }
  const netAge = now - replay.netPulseAt;
  replay.netMesh.scale.y = netAge >= 0 && netAge < 520 ? 1 + 0.16 * Math.sin(Math.PI * netAge / 520) : 1;
  const rimAge = now - replay.rimShakeAt;
  replay.hoop.rotation.z = rimAge >= 0 && rimAge < 220 ? 0.035 * Math.sin(Math.PI * rimAge / 220) : 0;
}

function updateReplayFrame(now) {
  const replay = state.replay;
  replay.raf = 0;
  if (document.hidden) { replay.lastFrame = 0; return; }
  const delta = replay.lastFrame ? Math.min(80, now - replay.lastFrame) : 16.7;
  replay.lastFrame = now;
  if (replay.playing) {
    replay.elapsed += delta * replay.speed;
    while (replay.cursor < replay.shots.length && replay.elapsed >= replay.nextAt && replay.active.length < REPLAY.maxConcurrent) {
      const shotIndex = replay.cursor++;
      const slot = Array.from({ length: REPLAY.maxConcurrent }, (_, index) => index).find((index) => !replay.active.some((flight) => flight.slot === index));
      if (slot === undefined) break;
      replay.active.push(createFlight(replay.shots[shotIndex], shotIndex, slot, replay.elapsed));
      replay.currentIndex = shotIndex;
      replay.nextAt = replay.elapsed + REPLAY.intervalMs;
      updateReplayControls();
    }
    const remaining = [];
    for (const flight of replay.active) {
      const age = replay.elapsed - flight.startAt;
      if (age < REPLAY.prelaunchMs) { remaining.push(flight); continue; }
      const elapsedFlight = age - REPLAY.prelaunchMs;
      const progress = elapsedFlight / flight.flightMs;
      if (progress >= 1) {
        setReplayBall(flight.slot, null);
        for (let trail = 0; trail < REPLAY.trailLength; trail += 1) writeInstance(replay.trailMesh, flight.slot * REPLAY.trailLength + trail, null, new THREE.Vector3(1, 1, 1));
        if (flight.shot.made) {
          replay.flashAt = now;
          replay.flashColor = '#8cff9d';
          replay.netPulseAt = now;
          emitParticles(flight, true, now);
        } else {
          replay.rimShakeAt = now;
          emitParticles(flight, false, now);
        }
        addShotMarker(flight.shot);
      } else {
        const position = flightPosition(flight, THREE.MathUtils.clamp(progress, 0, 1));
        const ageSeconds = elapsedFlight / 1000;
        setReplayBall(flight.slot, position, ageSeconds * 7.5);
        updateTrails(flight, position);
        remaining.push(flight);
      }
    }
    replay.active = remaining;
    if (replay.cursor >= replay.shots.length && !replay.active.length) {
      replay.playing = false;
      updateReplayControls();
    }
  }
  updateParticles();
  updateShotOrigins();
  updateReplayFeedback(now);
  followActiveShot();
  state.controls?.update();
  render3d();
  if (replay.playing || now - replay.flashAt < 520 || now - replay.netPulseAt < 520 || now - replay.rimShakeAt < 220 || replay.particles.some(Boolean)) scheduleReplayFrame();
  else replay.lastFrame = 0;
}

function updateReplayEffect(now = performance.now()) {
  if (!state.replay.flashMesh || !state.replay.goalLight || !state.replay.hoopMaterial) return;
  updateReplayFeedback(now);
}

function scheduleReplayFrame() {
  if (!document.hidden && !state.replay.raf) state.replay.raf = requestAnimationFrame(updateReplayFrame);
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
  });
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
  document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));
  document.querySelectorAll('[data-camera]').forEach((button) => button.addEventListener('click', () => applyCameraPreset(button.dataset.camera)));
  $('#replay-follow').addEventListener('change', (event) => { state.replay.followShot = event.target.checked; });
  $('#replay-markers').addEventListener('change', (event) => {
    state.replay.keepMarkers = event.target.checked;
    for (const mesh of [state.replay.markerMade, state.replay.markerMissed]) if (mesh) mesh.visible = event.target.checked && state.mode === 'replay' && state.view === '3d';
    render3d();
  });
  $('#replay-scrubber').addEventListener('input', (event) => seekReplay(Number(event.target.value)));
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
    const target = event.target;
    const typing = target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(target.tagName));
    if (!typing && state.mode === 'replay' && state.view === '3d') {
      if (event.code === 'Space') { event.preventDefault(); playReplay(); return; }
      if (event.key === 'ArrowLeft') { event.preventDefault(); stepReplay(-1); return; }
      if (event.key === 'ArrowRight') { event.preventDefault(); stepReplay(1); return; }
      if (/^[1-4]$/.test(event.key)) {
        const speeds = [0.5, 1, 2, 4];
        state.replay.speed = speeds[Number(event.key) - 1];
        $('#replay-speed').value = String(state.replay.speed);
        return;
      }
    }
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
  setMode('replay');
  try {
    await loadPlayer(state.player);
    renderData();
    loadingState.hidden = true;
  } catch (error) { showLoadError(error); }
}

start();
