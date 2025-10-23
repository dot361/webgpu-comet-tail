async function startSimulation() {


//-----------------------------SETUP--------------------------------
//Initialize rendering engine (WebGPU if available else WebGL)
//Create the scene and expose a small GPU status badge


const canvas = document.getElementById("renderCanvas");
let engine;
let hasCompute = false;
let gpuStatusEl = document.getElementById("gpuStatus");

function setBadge(text, bg, border) {
  gpuStatusEl.textContent = text;
  gpuStatusEl.style.background = bg;
  gpuStatusEl.style.borderColor = border;
}

const FORCE_MODE = (new URLSearchParams(location.search).get("force") || "").toLowerCase();

async function tryInitWebGPU() {
  if (FORCE_MODE === "webgl") {
    console.warn("[CometSim] FORCE=webgl -> skipping WebGPU init.");
    return null;
  }

  if (!window.isSecureContext) {
    console.warn("[CometSim] Not a secure context:", location.protocol, "— WebGPU is disabled.");
    return null;
  }
  if (!("gpu" in navigator)) {
    console.warn("[CometSim] navigator.gpu missing — browser doesn’t expose WebGPU.");
    return null;
  }

  try {
    const wgpu = new BABYLON.WebGPUEngine(canvas, { antialiasing: true });
    await wgpu.initAsync();

    const caps = wgpu.getCaps?.() || {};
    hasCompute = !!(caps.supportComputeShaders || caps.supportCompute);
    return wgpu;
  } catch (err) {
    console.warn("[CometSim] WebGPU init failed:", err);
    return null;
  }
}

let wgpu = await tryInitWebGPU();
if (wgpu) {
  engine = wgpu;

  if (FORCE_MODE === "cpu") {
    console.warn("[CometSim] FORCE=cpu -> disabling compute on WebGPU engine.");
    hasCompute = false;
  }

  setBadge(
    hasCompute ? "GPU: WebGPU (Compute ON)" : "GPU: WebGPU (Compute OFF)",
    hasCompute ? "#0b3d0b" : "#3d2f0b",
    hasCompute ? "#0f0"   : "#fd0"
  );
} else {
  console.warn("[CometSim] Using WebGL fallback.");
  engine = new BABYLON.Engine(canvas, true);
  hasCompute = false;
  setBadge("GPU: WebGL (Compute OFF)", "#3d0b0b", "#f33");
}

window.__engineHasCompute = hasCompute;
window.__engineIsWebGPU  = (engine && engine.getClassName?.() === "WebGPUEngine");

const scene = new BABYLON.Scene(engine);
scene.clearColor = new BABYLON.Color3(0.02, 0.02, 0.08);
const useCompute = (engine instanceof BABYLON.WebGPUEngine) && hasCompute;


//---------------------------TIME SETUP-----------------------------------
//Time is tracked in Julian Days (JD)
//The UI lets you slide on the timeline when paused
//The simulation speed scales how fast JD advances


let simulationTimeJD = 2451544.5;
let simulationSpeed = 1;
let uiAccum = 0;

const UI_PERIOD = 0.15;
const timelineSlider = document.getElementById("timelineSlider");
const timelineLabel = document.getElementById("timelineLabel");
const updateViewBtn = document.getElementById("updateViewBtn");
const baseJD = 2451544.5;

timelineSlider.addEventListener("input", () => {
  const jd = baseJD + parseInt(timelineSlider.value);
  timelineLabel.textContent = `Date: ${jdToDateString(jd)}`;
});

function updateTimelineUIState() {
  if (isPaused) {
    timelineSlider.disabled = false;
    updateViewBtn.disabled = false;
  } else {
    timelineSlider.disabled = true;
    updateViewBtn.disabled = true;
  }
}

updateViewBtn.addEventListener("click", () => {
  const selectedJD = baseJD + parseInt(timelineSlider.value);
  simulationTimeJD = selectedJD;

const cs = cometStateAtJD(simulationTimeJD);
comet.position.copyFrom(cs.r_scene);

const earthPos = getPlanetPosition(simulationTimeJD, earthEl);
earthMesh.position.copyFrom(earthPos);

  tailParticles.length = 0;
for (let i = 0; i < particleMeshes.length; i++) particleMeshes[i].setEnabled(false);

  if (rawParticles) {
    rawParticles.clear();
  }
  cpuSlots.fill(undefined);
  gpuWriteCursor = 0;
  maxUsed = 0;
  expiryByIndex.fill(0);
  simSeconds = 0;
});

function jdToDateString(jd) {
  const JD_UNIX_EPOCH_OFFSET = 2440587.5;
  const date = new Date((jd - JD_UNIX_EPOCH_OFFSET) * 86400000);
  return date.toISOString().split("T")[0];
}

  const timeDisplay = document.getElementById('simTimeDisplay');

  function julianDayToDate(jd) {
    let Z = Math.floor(jd + 0.5);
    let F = (jd + 0.5) - Z;
    let A = Z;

    if (Z >= 2299161) {
      let alpha = Math.floor((Z - 1867216.25) / 36524.25);
      A += 1 + alpha - Math.floor(alpha / 4);
    }

    let B = A + 1524;
    let C = Math.floor((B - 122.1) / 365.25);
    let D = Math.floor(365.25 * C);
    let E = Math.floor((B - D) / 30.6001);

    let day = B - D - Math.floor(30.6001 * E) + F;
    let month = (E < 14) ? E - 1 : E - 13;
    let year = (month > 2) ? C - 4716 : C - 4715;

    let dayFraction = day - Math.floor(day);
    let totalSeconds = Math.round(dayFraction * 86400);

    let hours = Math.floor(totalSeconds / 3600);
    let minutes = Math.floor((totalSeconds % 3600) / 60);
    let seconds = totalSeconds % 60;

    return {
      year,
      month,
      day: Math.floor(day),
      hours,
      minutes,
      seconds
    };
  }

  function updateTimeDisplay(jd) {
    const dt = julianDayToDate(jd);
    
    const pad = (n) => n.toString().padStart(2, '0');
  
    timeDisplay.innerText = 
      `${dt.year}/${pad(dt.month)}/${pad(dt.day)} ` +
      `${pad(dt.hours)}:${pad(dt.minutes)}:${pad(dt.seconds)} UTC`;
  }


//----------------------------------CAMERA------------------------------------
//Rotate camera
//"Focus on Comet" button setup
//Helpers to snap to principal axes


  const camera = new BABYLON.ArcRotateCamera("orbitCamera", Math.PI / 2, Math.PI / 3, 100, BABYLON.Vector3.Zero(), scene);
  camera.maxZ = 1e9;
  camera.minZ = 0.1;
  camera.attachControl(canvas, true);
  camera.wheelDeltaPercentage = 0.005;

  let isCameraFocused = false;
  let lastCameraTarget = camera.target.clone();
  let lastCameraRadius = camera.radius;

  camera.panningSensibility = 300;

function setFocusOnComet(on) {
  isCameraFocused = on;
  toggleFocusBtn.textContent = on ? "Unfocus Camera" : "Focus on Comet";

  if (on && cometMesh) {
    lastCameraTarget = camera.target.clone();
    lastCameraRadius = camera.radius;

    camera.lockedTarget = cometMesh;
    camera.radius = Math.max(2, Math.min(camera.radius, 1e6));
    if (!Number.isFinite(camera.beta) || camera.beta <= 0) camera.beta = Math.PI/3;
  } else {
    camera.lockedTarget = null;
    camera.setTarget(lastCameraTarget);
    camera.radius = lastCameraRadius;
  }
}

toggleFocusBtn.onclick = () => setFocusOnComet(!isCameraFocused);

function setViewAxis(axis) {
  if (isCameraFocused) return;

  const distance = camera.radius;
  const target = BABYLON.Vector3.Zero();

  switch (axis) {
    case 'X':
      camera.alpha = 0;
      camera.beta = Math.PI / 2;
      break;
    case 'Y':
      camera.alpha = 0;
      camera.beta = 0.0001;
      break;
    case 'Z':
      camera.alpha = Math.PI / 2;
      camera.beta = Math.PI / 2;
      break;
  }
  camera.radius = distance;
  camera.setTarget(target);
  lastCameraTarget = camera.target.clone();
}


//---------------------------------------ELEMENTS---------------------------------------
//Define unit constants and Earth orbital parameters
//Draw Planet orbits
//Draw Planets, Sun and star field


//PLANETS


const AU = 1.495978707e11;
const SECONDS_PER_DAY = 86400;
const DEG = Math.PI / 180;
const SCALE = 1e-10;
const GMsun = 1.32712440018e20;
const MU_SCENE = GMsun * Math.pow(SCALE, 3);

const ui = BABYLON.GUI.AdvancedDynamicTexture.CreateFullscreenUI("ui");

function addLabel(mesh, text, opts = {}) {
  const rect = new BABYLON.GUI.Rectangle();
  rect.background = "transparent";
  rect.thickness = 0;
  rect.paddingLeft = "6px";
  rect.paddingRight = "6px";
  ui.addControl(rect);
  rect.linkWithMesh(mesh);
  rect.linkOffsetX = opts.offsetX ?? 18;
  rect.linkOffsetY = opts.offsetY ?? -18;

  const tb = new BABYLON.GUI.TextBlock();
  tb.text = text;
  tb.color = opts.color ?? "#cfd8ff";
  tb.fontSize = opts.fontSize ?? 14;
  tb.outlineWidth = 2;
  tb.outlineColor = "#000000";
  rect.addControl(tb);
  return rect;
}

let currentCometSource = "user";
let currentCometName = null;

function cometClassCode(e, a_AU, i_deg) {
  if (e >= 1.0) return "HYP";
  const P = Math.pow(a_AU, 1.5);
  if (P < 20 && i_deg < 40) return "SP";
  if (P < 200) return "HT";
  return "LP";
}

function userModelLabel(e, a_AU, q_AU, i_deg) {
  const code = cometClassCode(e, a_AU, i_deg);
  return `User model · ${code} · q ${q_AU.toFixed(2)} AU`;
}

function cometClassCode(e, a_AU, i_deg) {
  if (e >= 1.0) return "HYP";
  const P = Math.pow(a_AU, 1.5);
  if (P < 20 && i_deg < 40) return "SP";
  if (P < 200) return "HT";
  return "LP";
}

function ensureCometLabel(mesh, text, opts = {}) {
  if (mesh._cometLabel) return mesh._cometLabel;

  const nameFromMeta = mesh.metadata?.cometName;
  const nameFromMesh = mesh.name && mesh.name !== "comet" ? mesh.name : null;
  const finalText = nameFromMeta || nameFromMesh || text;

  const lbl = addLabel(mesh, finalText, {
    color: "#ffd7a8",
    fontSize: 16,
    offsetY: -24,
    ...opts
  });
  mesh._cometLabel = lbl;
  return lbl;
}

function labelPresetComets(scene) {
  const presets = scene.meshes.filter(
    m => m !== cometMesh && m.name.toLowerCase().includes("comet")
  );
  for (const m of presets) {
    const text = m.metadata?.cometName || (m.name !== "comet" ? m.name : null);
    ensureCometLabel(m, text || "Comet");
  }
}

const PRESET_FINDERS = [
  { key: "67p",      id: "67P",     name: "67P/Churyumov–Gerasimenko" },
  { key: "c2024e1",  id: "C2024E1", name: "C/2024 E1" },
  { key: "133p",     id: "133P",    name: "133P/Elst–Pizarro" },
  { key: "3i",       id: "3I",      name: "3I/ATLAS" }
];

for (const f of PRESET_FINDERS) {
  const mesh = scene.meshes.find(m =>
    m !== cometMesh &&
    m.name.toLowerCase().includes("comet") &&
    m.name.toLowerCase().includes(f.key)
  );
  if (!mesh) continue;
  mesh.metadata = mesh.metadata || {};
  mesh.metadata.presetId = f.id;
  mesh.metadata.cometName = mesh.metadata.cometName || f.name;
  ensureCometLabel(mesh, mesh.metadata.cometName);
}

scene.onPointerObservable.add((pi) => {
  if (pi.type !== BABYLON.PointerEventTypes.POINTERPICK) return;
  const picked = pi.pickInfo?.pickedMesh;
  if (!picked || picked === cometMesh) return;

  const pid = picked.metadata?.presetId;
  if (pid && typeof window.loadComet === "function") {
    window.loadComet(pid);
    window.switchToPreset?.(picked.metadata?.cometName || pid);
  }
});

function applyElementsToUI(elts) {
  if (elts.e !== undefined) eccentricityInput.value = String(elts.e);
  if (elts.q_AU !== undefined) perihelionInput.value   = String(elts.q_AU);
  if (elts.i_deg !== undefined) inclinationInput.value  = String(elts.i_deg);
  if (elts.Omega_deg !== undefined) longitudeAscendingNodeInput.value = String(elts.Omega_deg);
  if (elts.omega_deg !== undefined) argumentPerihelionInput.value = String(elts.omega_deg);
  if (elts.t0_JD !== undefined) perihelionDateInput.value = String(elts.t0_JD);

  updateOrbitParameters();
}

function activatePresetComet(mesh) {
  const name = mesh.metadata?.cometName || mesh.name || "Comet";
  const elts = mesh.metadata?.elts;
  if (!elts) {
    console.warn("[CometSim] Preset comet clicked but no metadata.elts found on:", mesh.name);
    return;
  }

  currentCometSource = "preset";
  currentCometName   = name;

  applyElementsToUI(elts);

  if (customCometLabel) {
    const tb = customCometLabel.children?.find?.(c => c instanceof BABYLON.GUI.TextBlock);
    if (tb) tb.text = currentCometName;
  }

  setFocusOnComet(true);
}

function keplerSolveE(M, e) {
  let E = M;
  for (let k = 0; k < 12; k++) {
    const f  = E - e * Math.sin(E) - M;
    const fp = 1 - e * Math.cos(E);
    const dE = -f / fp;
    E += dE;
    if (Math.abs(dE) < 1e-12) break;
  }
  return E;
}

function getPlanetPosition(jd, el) {

  const a_m = el.a * AU;
  const n   = Math.sqrt(GMsun / (a_m * a_m * a_m));
  const t   = (jd - 2451545.0) * SECONDS_PER_DAY;

  let M = el.M0 + n * t;
  M = ((M % (2*Math.PI)) + 2*Math.PI) % (2*Math.PI);

  const E = keplerSolveE(M, el.e);
  const cosE = Math.cos(E), sinE = Math.sin(E);

  const x_orb = a_m * (cosE - el.e);
  const y_orb = a_m * Math.sqrt(1 - el.e*el.e) * sinE;

  const cO = Math.cos(el.Omega), sO = Math.sin(el.Omega);
  const ci = Math.cos(el.i),     si = Math.sin(el.i);
  const co = Math.cos(el.omega), so = Math.sin(el.omega);

  const xp =  co * x_orb - so * y_orb;
  const yp =  so * x_orb + co * y_orb;
  const xpp = xp;
  const ypp = ci * yp;
  const zpp = si * yp;

  const X = cO * xpp - sO * ypp;
  const Y = sO * xpp + cO * ypp;
  const Z = zpp;

  return new BABYLON.Vector3(X * SCALE, Y * SCALE, Z * SCALE);
}

function drawPlanetOrbit(scene, el, segments = 1024, color = new BABYLON.Color3(0.6, 0.7, 0.9)) {
  const pts = [];
  for (let j = 0; j <= segments; j++) {
    const nu = -Math.PI + (2*Math.PI*j)/segments;
    const p  = el.a * AU * (1 - el.e*el.e);
    const r  = p / (1 + el.e * Math.cos(nu));

    const x_orb = r * Math.cos(nu);
    const y_orb = r * Math.sin(nu);

    const cO = Math.cos(el.Omega), sO = Math.sin(el.Omega);
    const ci = Math.cos(el.i),     si = Math.sin(el.i);
    const co = Math.cos(el.omega), so = Math.sin(el.omega);

    const xp =  co*x_orb - so*y_orb;
    const yp =  so*x_orb + co*y_orb;
    const xpp = xp;
    const ypp = ci*yp;
    const zpp = si*yp;

    const X = cO*xpp - sO*ypp;
    const Y = sO*xpp + cO*ypp;
    const Z = zpp;

    pts.push(new BABYLON.Vector3(X * SCALE, Y * SCALE, Z * SCALE));
  }

  const line = BABYLON.MeshBuilder.CreateLines("orbit-"+(el.name||"p"), { points: pts }, scene);
  line.color = color;
  line.isPickable = false;
  return line;
}

const PLANET_ELTS_DEG = [
  // name,        a(AU),      e,        i,        Ω,         ω,         M0
  ["Mercury",   0.387098,  0.205630,  7.00487,  48.33167,  77.45645, 252.25084],
  ["Venus",     0.723332,  0.006772,  3.39471,  76.68069, 131.53298, 181.97973],
  ["Earth",     1.000000,  0.016710,  0.00005, -11.26064, 102.94719, 100.46435],
  ["Mars",      1.523679,  0.093400,  1.85000,  49.55809, 286.50200, 355.45332],
  ["Jupiter",   5.20260,   0.048498,  1.30300, 100.55615,  14.75385,  34.40438],
  ["Saturn",    9.55490,   0.055508,  2.48900, 113.71504,  92.43194,  49.94432],
  ["Uranus",   19.21840,   0.046295,  0.77300,  74.00600, 170.96424, 313.23218],
  ["Neptune",  30.11039,   0.008988,  1.77000, 131.78400,  44.97135, 304.88003],
];

const PLANET_ELTS = PLANET_ELTS_DEG.map(([name,a,e,i,Omega,omega,M0]) => ({
  name, a, e,
  i:     i     * DEG,
  Omega: Omega * DEG,
  omega: omega * DEG,
  M0:    M0    * DEG
}));

const planetColors = {
  Mercury: new BABYLON.Color3(0.65, 0.66, 0.68),
  Venus:   new BABYLON.Color3(0.95, 0.85, 0.6),
  Earth:   new BABYLON.Color3(0.2, 0.5, 1.0),
  Mars:    new BABYLON.Color3(1.0, 0.45, 0.3),
  Jupiter: new BABYLON.Color3(0.65, 0.45, 0.25),
  Saturn:  new BABYLON.Color3(0.95, 0.9, 0.7),
  Uranus:  new BABYLON.Color3(0.7, 0.9, 1.0),
  Neptune: new BABYLON.Color3(0.6, 0.7, 1.0),
};

const planetSizes = {
  Mercury: 0.10, Venus: 0.18, Earth: 0.20, Mars: 0.15,
  Jupiter: 0.50, Saturn: 0.45, Uranus: 0.35, Neptune: 0.34,
};

const planets = [];

for (const el of PLANET_ELTS) {
  if (el.name === "Earth") continue;

  const baseColor = planetColors[el.name] ?? new BABYLON.Color3(0.6, 0.7, 0.9);
  const orbitColor = baseColor;
  const orbitLine = drawPlanetOrbit(scene, el, 1200, orbitColor);
  const size = planetSizes[el.name] ?? 0.2;
  const mesh = BABYLON.MeshBuilder.CreateSphere("pl-"+el.name, { diameter: size }, scene);
  const mat = new BABYLON.StandardMaterial("mat-"+el.name, scene);
  mat.diffuseColor  = baseColor;
  mat.emissiveColor = baseColor.scale(0.15);
  mesh.material = mat;

  mesh.position = getPlanetPosition(simulationTimeJD, el);

  const lbl = addLabel(mesh, el.name, { color: baseColor.toHexString() });

  planets.push({ name: el.name, el, mesh, label: lbl, orbitLine });
}

const earthEl = PLANET_ELTS.find(p => p.name === "Earth");
const earthMesh = BABYLON.MeshBuilder.CreateSphere("earth", { diameter: 0.2 }, scene);
const earthMaterial = new BABYLON.StandardMaterial("earthMat", scene);
earthMaterial.diffuseColor  = planetColors.Earth;
earthMaterial.emissiveColor = planetColors.Earth.scale(0.15);
earthMesh.material = earthMaterial;
earthMesh.position = getPlanetPosition(simulationTimeJD, earthEl);

const earthLabel = addLabel(earthMesh, "Earth", {
  color: planetColors.Earth.toHexString(),
  offsetX: 18,
  offsetY: -18,
});

drawPlanetOrbit(scene, earthEl, 1200, planetColors.Earth);


//SUN


  const sun = BABYLON.MeshBuilder.CreateSphere("sun", { diameter: 0.8 }, scene);
  const sunMat = new BABYLON.StandardMaterial("sunMat", scene);
  sunMat.emissiveColor = new BABYLON.Color3(1, 1, 0.5);
  sun.material = sunMat;
  const glow = new BABYLON.GlowLayer("glow", scene);
  glow.referenceMeshToUseItsOwnMaterial(sun);
  glow.intensity = 1.2;


//STAR FIELD


function createStarfield(scene, starCount = 8000, radius = 15000) {
  const pcs = new BABYLON.PointsCloudSystem("starfield", 1, scene);

  pcs.addPoints(starCount, (p) => {
    const theta = Math.random() * 2 * Math.PI;
    const phi = Math.acos(2 * Math.random() - 1);
    const x = radius * Math.sin(phi) * Math.cos(theta);
    const y = radius * Math.sin(phi) * Math.sin(theta);
    const z = radius * Math.cos(phi);

    p.position = new BABYLON.Vector3(x, y, z);
    p.color = new BABYLON.Color4(1, 1, 1, 1);
  });

  pcs.buildMeshAsync().then((mesh) => {
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.isPickable = false;
    mesh.infiniteDistance = true;
    mesh.renderingGroupId = 0;
    if (mesh.material) {
      mesh.material.pointSize = 2.0;
      mesh.material.disableLighting = true;
      mesh.material.backFaceCulling = false;
      mesh.material.disableDepthWrite = true;
    }
  });
}

createStarfield(scene);


//--------------------------------------COMET-----------------------------------------------
//Read comet orbital elements from UI inputs
//Define physics constants and functions to compute comet's and earth's positions


  const eccentricityInput = document.getElementById("eccentricityInput");
  const perihelionInput = document.getElementById("perihelionInput");
  const inclinationInput = document.getElementById("inclinationInput");
  const longitudeAscendingNodeInput = document.getElementById("longitudeAscendingNodeInput");
  const argumentPerihelionInput = document.getElementById("argumentPerihelionInput");
  const perihelionDateInput = document.getElementById("perihelionDateInput");
  const activityHalfLifeInput = document.getElementById("activityHalfLifeInput");
  const visModeSelect = document.getElementById("visModeSelect");

  let fadeHalfLifeEDays = parseFloat(activityHalfLifeInput?.value) || 1500;
  let e = parseFloat(eccentricityInput.value);
  let q = parseFloat(perihelionInput.value) * AU;
  let a = q / (1 - e);
  let i = parseFloat(inclinationInput.value) * DEG;
  let omega = parseFloat(argumentPerihelionInput.value) * DEG;
  let Omega = parseFloat(longitudeAscendingNodeInput.value) * DEG;
  let t0 = parseFloat(perihelionDateInput.value);
  let visMode = 'none';
  let velocityScale = 1.0;


//-------------------------------------COMETS ORBIT---------------------------------------------
//Draw the comet’s orbit curve and "Toggle orbit" button setup
//Create the comet mesh


let orbitLine = null;

function drawOrbit(scene, segments = 800) {
  if (orbitLine) orbitLine.dispose();

  const points = [];
  const RMAX = 50 * AU;
  const p = a * (1 - e * e);

  let nuMin, nuMax;

  if (e < 1) {
    nuMin = -Math.PI;
    nuMax =  Math.PI;
  } else if (Math.abs(e - 1) < 1e-12) {
    const pPar = 2 * q;
    const c = Math.min(1, Math.max(-1, (pPar / RMAX) - 1));
    const nuCap = Math.acos(c);
    const eps = 1e-3;
    nuMin = -Math.min(nuCap, Math.PI - eps);
    nuMax =  Math.min(nuCap, Math.PI - eps);
  } else {
    const nuAsym = Math.acos(-1 / e);
    const cNeeded = (p / RMAX) - 1;
    let nuR = 0;
    if (e > 0) {
      const arg = Math.min(1, Math.max(-1, cNeeded / e));
      nuR = Math.acos(arg);
    }
    const eps = 1e-3;
    const nuCap = Math.min(nuAsym - eps, nuR || (nuAsym - eps));
    nuMin = -nuCap;
    nuMax =  nuCap;
  }

  for (let j = 0; j <= segments; j++) {
    const nu = nuMin + (nuMax - nuMin) * (j / segments);
    const denom = 1 + e * Math.cos(nu);
    if (denom <= 0) continue;
    const r = (Math.abs(e - 1) < 1e-12)
      ? (2 * q) / denom
      : p / denom;

    if (!isFinite(r) || r > RMAX) continue;

    const x_orb = r * Math.cos(nu);
    const y_orb = r * Math.sin(nu);

    const cO = Math.cos(Omega), sO = Math.sin(Omega);
    const co = Math.cos(omega), so = Math.sin(omega);
    const ci = Math.cos(i),     si = Math.sin(i);

    const xp =  co * x_orb - so * y_orb;
    const yp =  so * x_orb + co * y_orb;

    const xpp = xp;
    const ypp = ci * yp;
    const zpp = si * yp;

    const X = cO * xpp - sO * ypp;
    const Y = sO * xpp + cO * ypp;
    const Z = zpp;

    points.push(new BABYLON.Vector3(X * SCALE, Y * SCALE, Z * SCALE));
  }

  orbitLine = BABYLON.MeshBuilder.CreateLines("orbitPath", { points }, scene);
  orbitLine.color = new BABYLON.Color3(0.8, 0.8, 0.8);
  orbitLine.isPickable = false;
}

  drawOrbit(scene);

  document.getElementById("toggleOrbitBtn").addEventListener("click", () => {
    if (orbitLine) {
      orbitLine.setEnabled(!orbitLine.isEnabled());
    }
  });

  const cometPos = new BABYLON.Vector3(
  -0.02449938703,
  -0.07948059791,
  -0.00387641697
);
  let cometMesh = null;
  const comet = BABYLON.MeshBuilder.CreateSphere("comet", { diameter: 0.2 }, scene);
  cometMesh = comet;
  cometMesh.position = cometPos;
  const cometMaterial = new BABYLON.StandardMaterial("cometMat", scene);
  cometMaterial.diffuseColor = new BABYLON.Color3(0.7, 0.7, 0.7);
  cometMaterial.emissiveColor = new BABYLON.Color3(0.1, 0.1, 0.1);
  cometMesh.material = cometMaterial;

let customCometLabel = ensureCometLabel(
  cometMesh,
  userModelLabel(e, a / AU, q / AU, i / DEG)
);

function setActiveCometLabelText(text) {
  if (!customCometLabel) return;
  const tb = customCometLabel.children?.find?.(c => c instanceof BABYLON.GUI.TextBlock);
  if (tb) tb.text = text;
}

window.switchToPreset = function(name) {
  currentCometSource = "preset";
  currentCometName = name || "Comet";
  setActiveCometLabelText(currentCometName);
};

window.switchToUser = function() {
  currentCometSource = "user";
  currentCometName = null;
  setActiveCometLabelText(userModelLabel(e, a / AU, q / AU, i / DEG));
};

labelPresetComets(scene);

if (typeof window.loadComet === "function") {
  window._skipInitialFocus = true;
  setTimeout(() => {
    window.loadComet("67P");
    window.switchToPreset?.("67P/Churyumov–Gerasimenko");
  }, 100);
}

scene.onPointerObservable.add((pi) => {
  if (pi.type !== BABYLON.PointerEventTypes.POINTERPICK) return;
  const picked = pi.pickInfo?.pickedMesh;
  if (!picked || picked === cometMesh) return;

  const isPreset = !!(picked.metadata?.cometName && picked.metadata?.elts);
  if (isPreset) {
    activatePresetComet(picked);
  }
});

  window.updateOrbitParameters = updateOrbitParameters;

const betaUI = {
  canvas: document.getElementById('betaCurveCanvas'),
  resetBtn: document.getElementById('betaCurveReset'),
  gridToggle: document.getElementById('betaCurveGridToggle'),
  tipEl: document.getElementById('betaCurveTip'),
  ctx: null,
  pts: makeExpPts(),
  dragging: -1,
  R: 9,
  grid: true,
  pdf: new Float32Array(512),
  cdf: new Float32Array(512),
  enabled: true,
  pad: { l: 44, r: 14, t: 16, b: 36 },
  dpr: Math.max(1, Math.min(2.5, window.devicePixelRatio || 1)),
};

betaUI.domain = { x0: 0, xn: 1 };

function recomputeDomain() {
  const P = betaUI.pts.slice().sort((a,b)=>a.x-b.x);
  betaUI.domain.x0 = P[0].x;
  betaUI.domain.xn = P[P.length-1].x;
}

function valueAt(x, pts = betaUI.pts) {
  const P  = pts.slice().sort((a,b)=>a.x-b.x);
  const xs = P.map(p=>p.x), ys = P.map(p=>p.y);

  if (x < xs[0] || x > xs[xs.length-1]) return null;

  let i = 1;
  while (i < xs.length-1 && xs[i] < x) i++;
  const i0 = Math.max(0, i-2), i1 = i-1, i2 = i, i3 = Math.min(xs.length-1, i+1);

  const x1 = xs[i1], x2 = xs[i2];
  const u  = (x2 === x1) ? 0 : (x - x1) / (x2 - x1);

  const y0 = ys[i0], y1 = ys[i1], y2 = ys[i2], y3 = ys[i3];
  const y  = catmullRom(y0, y1, y2, y3, Math.min(1, Math.max(0, u)));
  return Math.max(0, Math.min(1, y));
}

function plotRect() {
  const { l, r, t, b } = betaUI.pad;
  const W = betaUI.canvas.width, H = betaUI.canvas.height;
  return { x0: l, y0: t, x1: W - r, y1: H - b, w: W - l - r, h: H - t - b };
}
function cx(x) { const pr = plotRect(); return pr.x0 + x * pr.w; }
function cy(y) { const pr = plotRect(); return pr.y1 - y * pr.h; }
function ix(px){ const pr = plotRect(); return Math.min(1, Math.max(0, (px - pr.x0) / pr.w)); }
function iy(py){ const pr = plotRect(); return Math.min(1, Math.max(0, 1 - (py - pr.y0) / pr.h)); }

(function initBetaCurve() {
  if (!betaUI.canvas) return;
  betaUI.ctx = betaUI.canvas.getContext('2d');
  recomputeDomain();
  drawBetaCurve();

  betaUI.canvas.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup',   onUp);
  betaUI.resetBtn?.addEventListener('click', () => {
    betaUI.pts = [
      { x: 0.00, y: 0.70 },
      { x: 0.25, y: 0.10 },
      { x: 0.60, y: 0.60 },
      { x: 1.00, y: 0.95 }
    ];
    recomputeDomain();
    drawBetaCurve();
  });

  rebuildBetaTables();
})();

function drawBetaCurve() {
  const { ctx, pts, R } = betaUI;
  if (!ctx) return;

  const W = ctx.canvas.width;
  const H = ctx.canvas.height;

  ctx.clearRect(0, 0, W, H);

  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;

  const nTicks = 10;
  for (let t = 0; t <= nTicks; t++) {
    const x = t / nTicks;
    const y = t / nTicks;

    ctx.beginPath();
    ctx.moveTo(cx(x), cy(0));
    ctx.lineTo(cx(x), cy(1));
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(cx(0), cy(y));
    ctx.lineTo(cx(1), cy(y));
    ctx.stroke();
  }

  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let t = 0; t <= nTicks; t++) {
    const x = t / nTicks;
    ctx.fillText(x.toFixed(1), cx(x), H - 12);
  }

  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let t = 0; t <= nTicks; t++) {
    const y = t / nTicks;
    ctx.fillText(y.toFixed(1), 30, cy(y));
  }
  ctx.restore();

  const P = betaUI.pts.slice().sort((a,b)=>a.x-b.x);
  if (P.length >= 2) {
    const x0 = P[0].x;
    const xn = P[P.length - 1].x;

    const s = 160;
    ctx.beginPath();
    let penDown = false;
    for (let k = 0; k <= s; k++) {
      const x = x0 + (xn - x0) * (k / s);
      const p = sampleCurve(betaUI.pts, x);
      const X = cx(x), Y = cy(p.y);
      if (!penDown) { ctx.moveTo(X, Y); penDown = true; }
      else          { ctx.lineTo(X, Y); }
    }
    ctx.strokeStyle = '#c7c7c7ff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    ctx.beginPath();
    ctx.arc(cx(p.x), cy(p.y), R, 0, Math.PI * 2);
    ctx.fillStyle = '#bebebeff';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#474747ff';
    ctx.stroke();
  }
}

function makeExpPts() {
  const k = 2.2;
  const f = (x) => (Math.exp(k * x) - 1) / (Math.exp(k) - 1);
  const xs = [0.00, 0.33, 0.66, 1.00];
  return xs.map(x => ({ x, y: f(x) }));
}

function sampleCurve(pts, t) {
  const P  = pts.slice().sort((a,b)=>a.x-b.x);
  const xs = P.map(p=>p.x), ys = P.map(p=>p.y);

  const x = Math.min(1, Math.max(0, t));

  if (x <= xs[0]) return { x, y: Math.max(0, Math.min(1, ys[0])) };
  if (x >= xs[xs.length-1]) return { x, y: Math.max(0, Math.min(1, ys[ys.length-1])) };

  let i = 1;
  while (i < xs.length-1 && xs[i] < x) i++;
  const i0 = Math.max(0, i-2), i1 = i-1, i2 = i, i3 = Math.min(xs.length-1, i+1);

  const x1 = xs[i1], x2 = xs[i2];
  const u = (x2 === x1) ? 0 : (x - x1) / (x2 - x1);

  const y0 = ys[i0], y1 = ys[i1], y2 = ys[i2], y3 = ys[i3];
  const y  = catmullRom(y0, y1, y2, y3, Math.min(1, Math.max(0, u)));

  return { x, y: Math.max(0, Math.min(1, y)) };
}

function catmullRom(p0,p1,p2,p3,t) {
  const t2 = t*t, t3 = t2*t;
  return 0.5*((2*p1) + (-p0+p2)*t + (2*p0-5*p1+4*p2-p3)*t2 + (-p0+3*p1-3*p2+p3)*t3);
}

function hitTest(px, py) {
  for (let i = 0; i < betaUI.pts.length; i++) {
    const p = betaUI.pts[i];
    recomputeDomain();
    const dx = cx(p.x) - px, dy = cy(p.y) - py;
    if (dx*dx + dy*dy <= betaUI.R*betaUI.R*2) return i;
  }
  return -1;
}

function onDown(e) {
  const rect = betaUI.canvas.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  betaUI.dragging = hitTest(x, y);
  if (betaUI.dragging >= 0) e.preventDefault();
}

function onMove(e) {
  if (betaUI.dragging < 0) return;
  const rect = betaUI.canvas.getBoundingClientRect();
  const x = ix(e.clientX - rect.left);
  const y = iy(e.clientY - rect.top);

  const i = betaUI.dragging;
  const L = (i===0) ? 0   : betaUI.pts[i-1].x + 0.001;
  const R = (i===betaUI.pts.length-1) ? 1 : betaUI.pts[i+1].x - 0.001;

  betaUI.pts[i].x = Math.min(Math.max(x, L), R);
  betaUI.pts[i].y = Math.min(Math.max(y, 0), 1);

  recomputeDomain();
  drawBetaCurve();
  rebuildBetaTables();
}

function onUp() { 
  if (betaUI.dragging >= 0) {
    betaUI.dragging = -1; 
    rebuildBetaTables();
  }
}

function rebuildBetaTables() {
  const N = betaUI.pdf.length;
  recomputeDomain();
  const { x0, xn } = betaUI.domain;

  let sum = 0;
  for (let i = 0; i < N; i++) {
    const x = i / (N - 1);
    const y = valueAt(x);
    const w = (y === null) ? 0 : Math.max(0, y);
    betaUI.pdf[i] = w;
    sum += w;
  }

  if (sum <= 0 && xn > x0) {
    for (let i = 0; i < N; i++) {
      const x = i / (N - 1);
      betaUI.pdf[i] = (x >= x0 && x <= xn) ? 1 : 0;
    }
    sum = (xn - x0) * (N - 1);
  }

  if (sum > 0) {
    for (let i = 0; i < N; i++) betaUI.pdf[i] /= sum;
  }

  let acc = 0;
  for (let i = 0; i < N; i++) {
    acc += betaUI.pdf[i];
    betaUI.cdf[i] = acc;
  }
  betaUI.cdf[N-1] = 1.0;
}

function sampleBetaFromCurve(u) {
  if (!betaUI.enabled || !betaUI.cdf) return Math.min(1, Math.max(0, u));

  const N = betaUI.cdf.length;
  const { x0, xn } = betaUI.domain;

  if (N < 2 || betaUI.cdf[N-1] <= 0 || !(betaUI.cdf[N-1] <= 1)) {
    const uu = Math.min(1, Math.max(0, u));
    return x0 + uu * Math.max(0, xn - x0);
  }

  let lo = 0, hi = N - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (betaUI.cdf[mid] >= u) hi = mid; else lo = mid + 1;
  }
  const i = lo;
  const c0 = (i === 0) ? 0 : betaUI.cdf[i-1];
  const c1 = betaUI.cdf[i];
  const t  = (c1 > c0) ? (u - c0) / (c1 - c0) : 0;
  const x0s = (i === 0) ? 0 : (i-1) / (N - 1);
  const x1s = i / (N - 1);
  const x   = x0s + t * (x1s - x0s);

  return Math.min(xn, Math.max(x0, x));
}


//-----------------------------------------PARTICLES----------------------------------------------
//Define particle and ejection parameters
//Set up WGSL shaders
//Compute and render particles


const V0_EJECTION_MS = 400;
const EXP_BETA = 0.5;
const EXP_RH = -0.5;
const EXP_COSZ = 2.0;
const ACTIVE_R_AU = 3.0;

let cumulativeExposure = 0;
function resetExposure() { cumulativeExposure = 0; }

async function setupRawParticles(engine, parentCanvas, MAX_PARTICLES) {
  if (!(engine instanceof BABYLON.WebGPUEngine)) return null;

  const device = engine._device;
  const format = navigator.gpu.getPreferredCanvasFormat();
  const overlay = document.createElement('canvas');
  overlay.id = 'particleOverlay';
  overlay.style.position = 'absolute';
  overlay.style.inset = '0';
  overlay.style.pointerEvents = 'none';
  overlay.style.zIndex = '1';
  const holder = parentCanvas.parentNode || document.body;
  if (getComputedStyle(holder).position === 'static') holder.style.position = 'relative';
  holder.appendChild(overlay);

  const ctx = overlay.getContext('webgpu');

function resize() {
  const rw = engine.getRenderWidth(true);
  const rh = engine.getRenderHeight(true);

  overlay.width  = rw;
  overlay.height = rh;

  overlay.style.width  = canvas.style.width  || `${canvas.clientWidth}px`;
  overlay.style.height = canvas.style.height || `${canvas.clientHeight}px`;

  ctx.configure({ device, format, alphaMode: 'premultiplied' });
}
resize();

engine.onResizeObservable.add(resize);

const WGSL_COMPUTE = `
struct SimParams {
  dtSeconds : f32,
  maxCount  : u32,
  muScene   : f32,
  _pad1     : u32,
};

@group(0) @binding(0) var<storage, read_write> posLife : array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> velBeta : array<vec4<f32>>;
@group(0) @binding(2) var<uniform> sim : SimParams;

fn accel(r: vec3<f32>, muScene: f32, beta: f32) -> vec3<f32> {
  let r2    = max(1e-18, dot(r, r));
  let invR  = inverseSqrt(r2);
  let invR3 = invR * invR * invR;
  let muEff = muScene * max(0.0, 1.0 - clamp(beta, 0.0, 1.0));
  return -muEff * r * invR3;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= sim.maxCount) { return; }

  var p  = posLife[i];
  if (p.w <= 0.0) { return; }

  var vb = velBeta[i];
  var r  = p.xyz;
  var v  = vb.xyz;
  let b  = vb.w;

  let dt = sim.dtSeconds;
  if (dt <= 0.0) {
    posLife[i] = vec4<f32>(r, p.w);
    velBeta[i] = vec4<f32>(v, b);
    return;
  }

  let rmag  = max(1e-6, length(r));
  let muEst = sim.muScene * max(1e-4, 1.0 - 0.5 * clamp(b, 0.0, 1.0));
  let tDyn  = sqrt((rmag * rmag * rmag) / muEst);
  let hMax  = 0.05 * tDyn;
  var steps = i32(ceil(dt / hMax));
  if (steps < 1) { steps = 1; }
  if (steps > 8) { steps = 8; }
  let h = dt / f32(steps);

  var a = accel(r, sim.muScene, b);
  v = v + a * (0.5 * h);
  for (var s = 0; s < steps; s = s + 1) {
    r = r + v * h;
    a = accel(r, sim.muScene, b);
    if (s + 1 < steps) {
      v = v + a * h;
    }
  }
  v = v + a * (0.5 * h);

  let life = max(p.w - dt, 0.0);
  posLife[i] = vec4<f32>(r, life);
  velBeta[i] = vec4<f32>(v, b);
}
`;

const WGSL_RENDER = `
struct Globals {
  viewProj    : mat4x4<f32>,

  lifeFadeInv : f32,
  visMode     : u32,
  pointPx     : f32,
  _pad0       : f32, 
  screenSize  : vec2<f32>,
  _pad1       : vec2<f32>,
  cometVel    : vec4<f32>,
  _pad2       : vec4<f32>,
};

@group(0) @binding(0) var<uniform> globals : Globals;
@group(0) @binding(1) var<storage, read> posLife : array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> velBeta : array<vec4<f32>>;

struct VSOut {
  @builtin(position) Position : vec4<f32>,
  @location(0) life : f32,
  @location(1) @interpolate(flat) pid : u32,
  @location(2) corner : vec2<f32>,
};

fn cornerOf(v : u32) -> vec2<f32> {
  let c = v % 6u;
  switch (c) {
    case 0u: { return vec2<f32>(-1.0, -1.0); }
    case 1u: { return vec2<f32>( 1.0, -1.0); }
    case 2u: { return vec2<f32>( 1.0,  1.0); }
    case 3u: { return vec2<f32>(-1.0, -1.0); }
    case 4u: { return vec2<f32>( 1.0,  1.0); }
    default:{ return vec2<f32>(-1.0,  1.0); }
  }
}

@vertex
fn vs_main(@builtin(vertex_index) vid : u32) -> VSOut {
  var out : VSOut;

  let pid = vid / 6u;
  let c   = cornerOf(vid);

  let p = posLife[pid];
  if (p.w <= 0.0) {
    out.Position = vec4<f32>(2.0, 2.0, 2.0, 1.0);
    out.life = 0.0;
    out.pid = pid;
    out.corner = c;
    return out;
  }

  var clip = globals.viewProj * vec4<f32>(p.xyz, 1.0);
  let sx_ndc = (globals.pointPx / globals.screenSize.x) * 2.0;
  let sy_ndc = (globals.pointPx / globals.screenSize.y) * 2.0;
  clip.x += sx_ndc * 0.5 * c.x * clip.w;
  clip.y += sy_ndc * 0.5 * c.y * clip.w;

  out.Position = clip;
  out.life  = p.w;
  out.pid   = pid;
  out.corner = c;
  return out;
}

fn hsv2rgb(h: f32, s: f32, v: f32) -> vec3<f32> {
  let c = v * s;
  let hp = h * 6.0;
  let x = c * (1.0 - abs((hp % 2.0) - 1.0));
  var r = 0.0; var g = 0.0; var b = 0.0;

  if      (hp < 1.0) { r=c; g=x; b=0.0; }
  else if (hp < 2.0) { r=x; g=c; b=0.0; }
  else if (hp < 3.0) { r=0.0; g=c; b=x; }
  else if (hp < 4.0) { r=0.0; g=x; b=c; }
  else if (hp < 5.0) { r=x; g=0.0; b=c; }
  else               { r=c; g=0.0; b=x; }

  let m = v - c;
  return vec3<f32>(r+m, g+m, b+m);
}

fn rainbow(u: f32) -> vec3<f32> {
  let uu = clamp(u, 0.0, 1.0);
  return hsv2rgb((1.0 - uu) * 0.7, 1.0, 1.0);
}

@fragment
fn fs_main(
  @location(0) life : f32,
  @location(1) @interpolate(flat) pid : u32
) -> @location(0) vec4<f32> {
  let a = clamp(life * globals.lifeFadeInv, 0.0, 1.0);
  if (a <= 0.0) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
  }

  let vb = velBeta[pid];

  var rgb : vec3<f32>;
  switch (globals.visMode) {
    case 2u: { // beta
      let b = clamp(vb.w, 0.0, 1.0);
      rgb = rainbow(pow(b, 0.6));
    }
    default: {
      rgb = vec3<f32>(1.0, 1.0, 1.0);
    }
  }
  return vec4<f32>(rgb, a);
}
`;

  const stride = 16;
  const posLifeGPU = device.createBuffer({
    size: MAX_PARTICLES * stride,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
const velBetaGPU = device.createBuffer({
  size: MAX_PARTICLES * 16,
  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
});

const zeroPL = new Float32Array(MAX_PARTICLES * 4);
device.queue.writeBuffer(posLifeGPU, 0, zeroPL);
device.queue.writeBuffer(velBetaGPU, 0, zeroPL);

function clear() {
  device.queue.writeBuffer(posLifeGPU, 0, zeroPL);
  device.queue.writeBuffer(velBetaGPU, 0, zeroPL);
}

  const simUBO = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

const globalsUBO = device.createBuffer({
  size: 144,
  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
});

  const computePipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: device.createShaderModule({ code: WGSL_COMPUTE }), entryPoint: 'main' }
  });

const renderPipeline = device.createRenderPipeline({
  layout: 'auto',
  vertex:   { module: device.createShaderModule({ code: WGSL_RENDER }), entryPoint: 'vs_main' },
  fragment: { module: device.createShaderModule({ code: WGSL_RENDER }), entryPoint: 'fs_main',
    targets: [{ format, blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                                 alpha: { srcFactor: 'one',       dstFactor: 'one-minus-src-alpha', operation: 'add' } } }]
  },
  primitive: { topology: 'triangle-list' }
});

  const computeBG = device.createBindGroup({
    layout: computePipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: posLifeGPU } },
      { binding: 1, resource: { buffer: velBetaGPU } },
      { binding: 2, resource: { buffer: simUBO     } },
    ]
  });

const renderBG = device.createBindGroup({
  layout: renderPipeline.getBindGroupLayout(0),
  entries: [
    { binding: 0, resource: { buffer: globalsUBO } },
    { binding: 1, resource: { buffer: posLifeGPU } },
    { binding: 2, resource: { buffer: velBetaGPU } },
  ]
});

const seedScratch = new Float32Array(4);
function seed(index, pos, vel, lifeSeconds, beta) {
  const off = index * 16;

  seedScratch[0] = pos.x; seedScratch[1] = pos.y; seedScratch[2] = pos.z; seedScratch[3] = lifeSeconds;
  device.queue.writeBuffer(posLifeGPU, off, seedScratch.buffer);

  seedScratch[0] = vel.x; seedScratch[1] = vel.y; seedScratch[2] = vel.z; seedScratch[3] = beta;
  device.queue.writeBuffer(velBetaGPU, off, seedScratch.buffer);
}

  function update(dtSeconds, maxCount, viewProjMatrixFloat32Array, cometVel_scene) {
device.queue.writeBuffer(simUBO, 0, new Float32Array([dtSeconds]));
device.queue.writeBuffer(simUBO, 4, new Uint32Array([maxCount >>> 0]));
device.queue.writeBuffer(simUBO, 8, new Float32Array([MU_SCENE]));
device.queue.writeBuffer(globalsUBO, 0, viewProjMatrixFloat32Array);


const lifeFadeInv = 1 / Math.max(1e-6, baseLifetime * SECONDS_PER_DAY);
const rw = engine.getRenderWidth(true);
const rh = engine.getRenderHeight(true);

const modeIndex =
  visMode === 'beta' ? 2 :
  0;

const POINT_PX = 3.0;

device.queue.writeBuffer(globalsUBO, 0,  viewProjMatrixFloat32Array);
device.queue.writeBuffer(globalsUBO, 64, new Float32Array([lifeFadeInv]));
device.queue.writeBuffer(globalsUBO, 68, new Uint32Array([modeIndex]));
device.queue.writeBuffer(globalsUBO, 72, new Float32Array([POINT_PX]));
device.queue.writeBuffer(globalsUBO, 80, new Float32Array([rw, rh]));

device.queue.writeBuffer(globalsUBO, 96, new Float32Array([
  cometVel_scene.x, cometVel_scene.y, cometVel_scene.z, 0
]));

    const enc = device.createCommandEncoder();

    {
      const pass = enc.beginComputePass();
      pass.setPipeline(computePipeline);
      pass.setBindGroup(0, computeBG);
      pass.dispatchWorkgroups(Math.ceil(maxCount / 64));
      pass.end();
    }

    {
      const tex = ctx.getCurrentTexture();
      const view = tex.createView();
      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view,
          loadOp: 'clear',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          storeOp: 'store'
        }]
      });
      pass.setPipeline(renderPipeline);
      pass.setBindGroup(0, renderBG);
      pass.draw(maxCount * 6, 1, 0, 0);

      pass.end();
    }

    device.queue.submit([enc.finish()]);
  }

return { seed, update, resize, clear, max: MAX_PARTICLES };
}

function stumpffC(z) {
  if (Math.abs(z) < 1e-8) return 0.5 - z/24 + (z*z)/720 - (z*z*z)/40320;
  if (z > 0) {
    const s = Math.sqrt(z);
    return (1 - Math.cos(s)) / z;
  } else {
    const s = Math.sqrt(-z);
    return (Math.cosh(s) - 1) / (-z);
  }
}

function stumpffS(z) {
  if (Math.abs(z) < 1e-8) return 1/6 - z/120 + (z*z)/5040 - (z*z*z)/362880;
  if (z > 0) {
    const s = Math.sqrt(z);
    return (s - Math.sin(s)) / (s*s*s);
  } else {
    const s = Math.sqrt(-z);
    return (Math.sinh(s) - s) / (s*s*s);
  }
}

function keplerUniversalPropagate(r0, v0, dt, mu) {
  if (!isFinite(dt) || dt === 0) return { r: r0.clone(), v: v0.clone() };

  const r0mag = r0.length();
  const v0mag = v0.length();
  const vr0   = BABYLON.Vector3.Dot(r0, v0) / Math.max(1e-12, r0mag);
  const alpha = 2/Math.max(1e-12, r0mag) - (v0mag*v0mag)/mu;

  let x;
  if (Math.abs(alpha) > 1e-12) x = Math.sqrt(mu) * Math.abs(alpha) * Math.abs(dt);
  else                         x = Math.sqrt(mu) * Math.abs(dt) / Math.max(1e-12, r0mag);
  if (dt < 0) x = -x;

  const sqrtMu = Math.sqrt(mu);
  for (let it = 0; it < 60; it++) {
    const z = alpha * x * x;
    const C = stumpffC(z);
    const S = stumpffS(z);

    const F  = r0mag*vr0/sqrtMu * x*x*C + (1 - alpha*r0mag)*x*x*x*S + r0mag*x - sqrtMu*dt;
    const dF = r0mag*vr0/sqrtMu * x*(1 - z*S) + (1 - alpha*r0mag)*x*x*C + r0mag;

    const dx = -F / dF;
    x += dx;
    if (Math.abs(dx) < 1e-10) break;
  }

  const z = alpha * x * x;
  const C = stumpffC(z);
  const S = stumpffS(z);
  const f = 1 - (x*x / r0mag) * C;
  const g = dt - (x*x*x / sqrtMu) * S;
  const r = r0.scale(f).add(v0.scale(g));
  const rmag = r.length();
  const fdot = (sqrtMu / (rmag * r0mag)) * (z*S - 1) * x;
  const gdot = 1 - (x*x / rmag) * C;
  const v = r0.scale(fdot).add(v0.scale(gdot));

  if (![r.x,r.y,r.z,v.x,v.y,v.z].every(Number.isFinite)) {
    const rb = r0.add(v0.scale(dt));
    return { r: rb, v: v0.clone() };
  }
  return { r, v };
}

  const tailParticles = [];
  const MAX_PARTICLES_GPU = 100000;
  const MAX_PARTICLES_CPU = 5000;
  const MAX_PARTICLES = useCompute ? MAX_PARTICLES_GPU : MAX_PARTICLES_CPU;

  const cpuSlots = new Array(MAX_PARTICLES);

  const particleLifetimeInput = document.getElementById("particleLifetimeInput");
  const particleCountInput = document.getElementById("particleCountInput");
  const activityExponentInput = document.getElementById("activityExponentInput");
  const activityScaleInput = document.getElementById("activityScaleInput");
    
  let baseLifetime = parseFloat(particleLifetimeInput.value);
  let particleCountPerSec = parseInt(particleCountInput.value);
  let activityN = parseFloat(activityExponentInput?.value ?? 2) || 2;
  let activityK = parseFloat(activityScaleInput?.value ?? 1)   || 1;

  fadeHalfLifeEDays = parseFloat(activityHalfLifeInput.value);
  if (!isFinite(fadeHalfLifeEDays) || fadeHalfLifeEDays <= 0) fadeHalfLifeEDays = 1500;

  const rawParticles = useCompute ? await setupRawParticles(engine, canvas, MAX_PARTICLES) : null;

  if (rawParticles) rawParticles.clear();

function seedParticleAt(index, r_scene, v_scene_per_s, lifeSeconds, beta) {
  if (rawParticles) {
    rawParticles.seed(index, r_scene, v_scene_per_s, lifeSeconds, beta);
  }
}

function sampleConeDirection(axis, halfAngleRad) {
  const zAxis = axis.clone().normalize();
  const tmp = Math.abs(zAxis.x) < 0.99 ? new BABYLON.Vector3(1,0,0) : new BABYLON.Vector3(0,1,0);
  const xAxis = BABYLON.Vector3.Cross(tmp, zAxis).normalize();
  const yAxis = BABYLON.Vector3.Cross(zAxis, xAxis).normalize();
  const u = Math.random();
  const v = Math.random();
  const cosPhi = 1 - u * (1 - Math.cos(halfAngleRad));
  const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi));
  const theta = 2 * Math.PI * v;

  return zAxis.scale(cosPhi)
    .add(xAxis.scale(sinPhi * Math.cos(theta)))
    .add(yAxis.scale(sinPhi * Math.sin(theta)))
    .normalize();
}

function rotPQWtoIJK(v, Omega, i, omega) {
  const cO = Math.cos(Omega), sO = Math.sin(Omega);
  const ci = Math.cos(i),     si = Math.sin(i);
  const co = Math.cos(omega), so = Math.sin(omega);

  let x = co*v.x - so*v.y;
  let y = so*v.x + co*v.y;
  let z = v.z;

  let x2 = x;
  let y2 = ci*y - si*z;
  let z2 = si*y + ci*z;

  return new BABYLON.Vector3(
    cO*x2 - sO*y2,
    sO*x2 + cO*y2,
    z2
  );
}

function cometStateAtJD(jd) {
  const e_ = e;
  const mu = GMsun;
  const q_m = q;
  const dt = (jd - t0) * SECONDS_PER_DAY;
  const r0_pf = new BABYLON.Vector3(q_m, 0, 0);
  const v0_pf = new BABYLON.Vector3(0, Math.sqrt(mu * (1 + e_) / q_m), 0);
  const r0 = rotPQWtoIJK(r0_pf, Omega, i, omega);
  const v0 = rotPQWtoIJK(v0_pf, Omega, i, omega);
  const { r, v } = keplerUniversalPropagate(r0, v0, dt, mu);

  return {
    r_scene: r.scale(SCALE),
    v_scene_per_s: v.scale(SCALE),
    rh_AU: r.length() / AU
  };
}

let gpuWriteCursor = 0;
let simSeconds = 0;

const expiryByIndex = new Float32Array(MAX_PARTICLES);
let maxUsed = 0;

function createTailParticle(timeNowJD) {
  if (gpuWriteCursor >= MAX_PARTICLES) gpuWriteCursor = 0;

  const cs = cometStateAtJD(timeNowJD);
  const cometPos_scene = cs.r_scene;
  const cometVel_scene = cs.v_scene_per_s;
  const rhAU = cs.rh_AU;
  const sunward_scene = cometPos_scene.clone().scale(-1).normalize();
  const n_scene = sampleCosinePowerHemisphere(sunward_scene, K_COS_Z);
  const surface_scene = cometPos_scene.add(n_scene.scale(R_EMIT_SCENE));
  const dir_scene = sampleConeDirection(n_scene, (EJECT_CONE_DEG * Math.PI) / 180);
  const beta = generateBeta();
  const cosZ = Math.max(BABYLON.Vector3.Dot(n_scene, sunward_scene), 0);

  const emissionSpeed_mps =
    V0_EJECTION_MS *
    Math.pow(Math.max(beta, 1e-6), EXP_BETA) *
    Math.pow(Math.max(rhAU, 1e-6), EXP_RH) *
    Math.pow(Math.max(cosZ, 1e-3), EXP_COSZ);

  const emissionVel_scene = dir_scene.scale(emissionSpeed_mps * SCALE);
  const v_scene = cometVel_scene.add(emissionVel_scene);
  const r0_scene = surface_scene;

  const lifeSeconds = (baseLifetime / velocityScale) * SECONDS_PER_DAY;

  if (rawParticles) {
    if (gpuWriteCursor >= MAX_PARTICLES) gpuWriteCursor = 0;

    let tries = 0;
    while (tries < MAX_PARTICLES && expiryByIndex[gpuWriteCursor] > simSeconds) {
      gpuWriteCursor = (gpuWriteCursor + 1) % MAX_PARTICLES;
      tries++;
    }
    if (tries === MAX_PARTICLES) return;

    const idx = gpuWriteCursor;
    expiryByIndex[idx] = simSeconds + lifeSeconds;
    gpuWriteCursor = (gpuWriteCursor + 1) % MAX_PARTICLES;
    if (idx + 1 > maxUsed) maxUsed = idx + 1;

    seedParticleAt(idx, r0_scene, v_scene, lifeSeconds, beta);
  } else {

  if (gpuWriteCursor >= MAX_PARTICLES) gpuWriteCursor = 0;

  let tries = 0;
  while (tries < MAX_PARTICLES && expiryByIndex[gpuWriteCursor] > simSeconds) {
    gpuWriteCursor = (gpuWriteCursor + 1) % MAX_PARTICLES;
    tries++;
  }

  if (tries === MAX_PARTICLES) return;

  const idx = gpuWriteCursor;
  const r0_m   = r0_scene.scale(1 / SCALE);
  const v0_mps = v_scene.scale(1 / SCALE);
  const mu_p   = GMsun * Math.max(1 - beta, 0);

  const lifeSeconds = (baseLifetime / velocityScale) * SECONDS_PER_DAY;

  cpuSlots[idx] = { t0JD: timeNowJD, r0_m, v0_mps, mu: mu_p, lifeSeconds, beta };
  expiryByIndex[idx] = simSeconds + lifeSeconds;
  gpuWriteCursor = (gpuWriteCursor + 1) % MAX_PARTICLES;
  if (idx + 1 > maxUsed) maxUsed = idx + 1;

  const mesh = particleMeshes[idx];
  mesh.position.copyFrom(r0_scene);
  mesh.setEnabled(true);
  if (mesh.material) mesh.material.alpha = 0.5;
}}

function generateBeta(min, max, skew) {
  if (betaUI && betaUI.enabled) {
  const b = sampleBetaFromCurve(Math.random());
    if (min === 0 && max === 1) return b;
  return Math.min(1, Math.max(0, b));
  }

  if (min === max) return min;
  let u = Math.random();
  if (skew !== 0) {
    const k = 1 + Math.abs(skew);
    u = (skew < 0) ? 1 - Math.pow(1 - u, k) : Math.pow(u, k);
  }
  return min + u * (max - min);
}

const NUCLEUS_RADIUS_KM = 1.0;
const R_EMIT_SCENE = (NUCLEUS_RADIUS_KM * 1000) * SCALE;
const EJECT_CONE_DEG = 30;
const K_COS_Z = 1.0;

function sampleCosinePowerHemisphere(axis, k) {
  const zAxis = axis.clone().normalize();
  const tmp = Math.abs(zAxis.x) < 0.99 ? new BABYLON.Vector3(1,0,0) : new BABYLON.Vector3(0,1,0);
  const xAxis = BABYLON.Vector3.Cross(tmp, zAxis).normalize();
  const yAxis = BABYLON.Vector3.Cross(zAxis, xAxis).normalize();

  const u = Math.random();
  const v = Math.random();
  const cosTheta = Math.pow(u, 1 / (k + 1));
  const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta*cosTheta));
  const phi = 2 * Math.PI * v;

  return zAxis.scale(cosTheta)
    .add(xAxis.scale(sinTheta * Math.cos(phi)))
    .add(yAxis.scale(sinTheta * Math.sin(phi)))
    .normalize();
}


//------------------------------------USER INTERFACE---------------------------------
//Wire up speed slider, pause button, and all input fields.
//Rebuild orbit parameters when inputs change
//Set up keyboard shortcuts


const velocitySlider = document.getElementById("velocitySlider");
const velocityValueLabel = document.getElementById("velocityValue");

velocitySlider.addEventListener("input", () => {
  const sliderValue = parseInt(velocitySlider.value);
  
  simulationSpeed = 0.8 * Math.pow(2, sliderValue / 4);

  velocityValueLabel.textContent = simulationSpeed.toFixed(2) + "×";
});

visModeSelect?.addEventListener('change', () => { visMode = visModeSelect.value; });

function hsvToRgb(h, s, v) {
  let c = v * s, x = c * (1 - Math.abs(((h * 6) % 2) - 1)), m = v - c;
  let r=0,g=0,b=0;
  if      (h < 1/6) { r=c; g=x; b=0; }
  else if (h < 2/6) { r=x; g=c; b=0; }
  else if (h < 3/6) { r=0; g=c; b=x; }
  else if (h < 4/6) { r=0; g=x; b=c; }
  else if (h < 5/6) { r=x; g=0; b=c; }
  else              { r=c; g=0; b=x; }
  return new BABYLON.Color3(r+m, g+m, b+m);
}

function colorFromUnit(u) {
  const clamp = (x)=>Math.max(0,Math.min(1,x));
  u = clamp(u);
  const rgb = hsvToRgb((1.0 - u) * 0.7, 1.0, 1.0);
  return rgb;
}

const fpsCounter = document.getElementById("fpsCounter");
const particleCounter = document.getElementById("particleCounter");

function updateOrbitParameters() {
  e = parseFloat(eccentricityInput.value);
  q = parseFloat(perihelionInput.value) * AU;
  i = parseFloat(inclinationInput.value) * DEG;
  Omega = parseFloat(longitudeAscendingNodeInput.value) * DEG;
  omega = parseFloat(argumentPerihelionInput.value) * DEG;
  t0 = parseFloat(perihelionDateInput.value);
  activityN = parseFloat(activityExponentInput.value);
  activityK = parseFloat(activityScaleInput.value);

  fadeHalfLifeEDays = parseFloat(activityHalfLifeInput.value);
  if (!isFinite(fadeHalfLifeEDays) || fadeHalfLifeEDays <= 0) fadeHalfLifeEDays = 1500;

  a = q / (1 - e);

  if (orbitLine) orbitLine.dispose();
  drawOrbit(scene);

  baseLifetime  = parseFloat(particleLifetimeInput.value);
  particleCountPerSec = parseFloat(particleCountInput.value) || 1;
  particleCountPerSec = Math.max(0.01, particleCountPerSec);

  if (customCometLabel) {
    const tb = customCometLabel.children?.find?.(c => c instanceof BABYLON.GUI.TextBlock);
    if (tb) {
      if (currentCometSource === "user" || !currentCometName) {
        tb.text = userModelLabel(e, a / AU, q / AU, i / DEG);
      } else {
        tb.text = currentCometName;
      }
    }
  }

  if (!isFinite(activityN)) activityN = 2;
  if (!isFinite(activityK)) activityK = 1;
  activityN = Math.max(0, Math.min(6, activityN));
  activityK = Math.max(0, activityK);

  resetExposure();
}

window.updateOrbitParameters = updateOrbitParameters;

[
  eccentricityInput,
  perihelionInput, 
  inclinationInput,
  longitudeAscendingNodeInput,
  argumentPerihelionInput,
  perihelionDateInput,
  particleLifetimeInput,
  particleCountInput,
  activityExponentInput,
  activityScaleInput,
  activityHalfLifeInput
].forEach(input => {
  input.addEventListener("input", () => {
    window.switchToUser?.();
    updateOrbitParameters();
  });
});

let isPaused = false;
const pauseBtn = document.getElementById("pauseBtn");

pauseBtn.addEventListener("click", () => {
  
  isPaused = !isPaused;
  pauseBtn.textContent = isPaused ? "Resume" : "Pause";
    updateTimelineUIState();
});

  const particleMeshes = [];

if (!useCompute) {
  for (let i = 0; i < MAX_PARTICLES; i++) {
    const mesh = BABYLON.MeshBuilder.CreateIcoSphere("tailParticle", { radius: 0.05, subdivisions: 2 }, scene);
    const mat = new BABYLON.StandardMaterial("tailMat", scene);
    mat.emissiveColor = new BABYLON.Color3(1, 1, 1);
    mat.diffuseColor  = new BABYLON.Color3(0.6, 0.6, 0.6);
    mat.alpha = 0.5;
    mesh.material = mat;
    mesh.setEnabled(false);
    particleMeshes.push(mesh);
  }
}

function setSimTime(jd, opts = {}) {
  const { resetParticles = true, focus = true } = opts;

  simulationTimeJD = jd;

  timelineSlider.value = String(Math.floor(jd - baseJD));
  timelineLabel.textContent = `Date: ${jdToDateString(jd)}`;
  updateTimeDisplay(jd);

  const cs = cometStateAtJD(jd);
  comet.position.copyFrom(cs.r_scene);
  earthMesh.position.copyFrom(getPlanetPosition(jd, earthEl));

  if (resetParticles) {
    tailParticles.length = 0;
    for (let i = 0; i < particleMeshes.length; i++) particleMeshes[i].setEnabled(false);
    if (rawParticles) rawParticles.clear();
    gpuWriteCursor = 0;
    maxUsed = 0;
    expiryByIndex.fill(0);
    simSeconds = 0;
    resetExposure();
  }

  if (focus) setFocusOnComet(true);
}
window.setSimTime = setSimTime;

window.addEventListener("resize", () => {
  engine.resize();
  if (rawParticles) rawParticles.resize();
});

if (rawParticles) {
  scene.onAfterRenderObservable.add(() => {
    const dtSeconds = isPaused ? 0 : (engine.getDeltaTime() / 1000) * simulationSpeed;
    const vpF32 = new Float32Array(scene.getTransformMatrix().m);
    const cs_now_for_gpu = cometStateAtJD(simulationTimeJD);
    rawParticles.update(dtSeconds, Math.max(1, maxUsed), vpF32, cs_now_for_gpu.v_scene_per_s);
  });
}

(function setupShortcuts() {
  function isTypingTarget(el) {
    return el && (
      el.tagName === 'INPUT' ||
      el.tagName === 'TEXTAREA' ||
      el.isContentEditable
    );
  }

  const velocitySlider = document.getElementById("velocitySlider");
  function nudgeSpeed(delta) {
    if (!velocitySlider) return;
    const min = Number(velocitySlider.min ?? -24);
    const max = Number(velocitySlider.max ??  24);
    const cur = Number(velocitySlider.value || 0);
    const next = Math.max(min, Math.min(max, cur + delta));
    if (next !== cur) {
      velocitySlider.value = String(next);
      velocitySlider.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function toggleCometOrbit() {
    if (window.orbitLine) window.orbitLine.setEnabled(!window.orbitLine.isEnabled());
    else document.getElementById("toggleOrbitBtn")?.click();
  }

  function toggleFocus() {
    if (typeof window.setFocusOnComet === 'function') {
      window.setFocusOnComet(!window.isCameraFocused);
    } else {
      document.getElementById("toggleFocusBtn")?.click();
    }
  }

  function snapAxis(ax) {
    if (typeof window.setViewAxis === 'function') window.setViewAxis(ax);
  }

  function updateTimelineView() {
    document.getElementById("updateViewBtn")?.click();
  }

  function togglePause() {
    document.getElementById("pauseBtn")?.click();
  }

  document.addEventListener('keydown', (e) => {
    if (isTypingTarget(e.target)) return;

    switch (e.key) {
      case ' ':
        e.preventDefault();
        togglePause();
        return;

      case 'a': case 'A':
        if (e.shiftKey) { e.preventDefault(); nudgeSpeed(-1); }
        return;
      case 'd': case 'D':
        if (e.shiftKey) { e.preventDefault(); nudgeSpeed(+1); }
        return;

      case 'u': case 'U':
        e.preventDefault();
        updateTimelineView();
        return;

      case 'f': case 'F':
        e.preventDefault();
        toggleFocus();
        return;

      case 'x': case 'X':
        e.preventDefault(); snapAxis('X'); return;
      case 'y': case 'Y':
        e.preventDefault(); snapAxis('Y'); return;
      case 'z': case 'Z':
        e.preventDefault(); snapAxis('Z'); return;

      case 'o': case 'O':
        e.preventDefault();
        toggleCometOrbit();
        return;

    }
  });
})();


//-----------------------------RENDER LOOP-------------------------------
//Advance simulated time
//Update timeline labels and time
//Recompute comet position
//Emit particles based on interval logic
//Update Earth position
//Update FPS/particle counters
//Render the Babylon scene


engine.runRenderLoop(() => {
  if (!isPaused) {

const dtSeconds = (engine.getDeltaTime() / 1000) * simulationSpeed;
if (!isPaused) {
  simSeconds += dtSeconds;
}

const dtDays = dtSeconds / SECONDS_PER_DAY;
const rAU_now = Math.max(1e-3, comet.position.length() / (SCALE * AU));

if (rAU_now <= ACTIVE_R_AU) {
  cumulativeExposure += dtDays / (rAU_now * rAU_now);
}

const ageFactor = Math.exp(-Math.LN2 * (cumulativeExposure / Math.max(1e-6, fadeHalfLifeEDays)));

simulationTimeJD += simulationSpeed * (engine.getDeltaTime() / 1000) / 86400;

uiAccum += engine.getDeltaTime() / 1000;
if (uiAccum >= UI_PERIOD) {
  timelineSlider.value = Math.floor(simulationTimeJD - baseJD);
  timelineLabel.textContent = `Date: ${jdToDateString(simulationTimeJD)}`;
  updateTimeDisplay(simulationTimeJD);

  fpsCounter.textContent = "FPS: " + engine.getFps().toFixed(0);

  if (hasCompute) {
    let active = 0;
    for (let i = 0; i < maxUsed; i++) {
      if (expiryByIndex[i] > simSeconds) active++;
    }
    particleCounter.textContent = "Particles (GPU): " + active;
  } else {
  let active = 0;
  for (let i = 0; i < maxUsed; i++) {
    if (expiryByIndex[i] > simSeconds && cpuSlots[i]) active++;
  }
  particleCounter.textContent = "Particles (CPU): " + active;
}
  uiAccum = 0;
}

const MAX_BIRTHS_PER_FRAME_AT_1_AU = Math.max(0, parseFloat(particleCountInput.value) || 0);
const cs_now = cometStateAtJD(simulationTimeJD);
const cometVel_scene = cs_now.v_scene_per_s;
const cometVel_mps = cometVel_scene.scale(1 / SCALE);
comet.position.copyFrom(cs_now.r_scene);
const rAU = comet.position.length() / (SCALE * AU);
const rSafe = Math.max(1e-3, rAU);
const Q = Math.max(0, activityK) * ageFactor / Math.pow(rSafe, Math.max(0, activityN));
const scale = Math.min(1, Q);
const targetBPF = MAX_BIRTHS_PER_FRAME_AT_1_AU * scale;
const boxQ = document.getElementById("actBoxQ");
const boxDecay = document.getElementById("actBoxDecay");

if (boxQ) boxQ.textContent = `Q: ${Q.toFixed(3)}`;
if (boxDecay) boxDecay.textContent = `decay: ${(ageFactor * 100).toFixed(1)}%`;

window.emitCarry = (typeof window.emitCarry !== "undefined") ? window.emitCarry : 0;
window.emitCarry += targetBPF;

let births = Math.floor(window.emitCarry);
window.emitCarry -= births;

const HARD_CAP = 512;
if (births > HARD_CAP) births = HARD_CAP;

if (!isPaused && births > 0) {
  const emitJD = simulationTimeJD - (dtSeconds / SECONDS_PER_DAY);
  for (let i = 0; i < births; i++) {
    createTailParticle(emitJD);
}}

while (tailParticles.length &&
  (simulationTimeJD - tailParticles[0].t0JD) > tailParticles[0].lifetimeDays) {
    tailParticles.shift();
}

if (!useCompute) {
  for (let i = 0; i < maxUsed; i++) {
    const alive = (expiryByIndex[i] > simSeconds) && cpuSlots[i];
    const mesh = particleMeshes[i];

    if (!alive) {
      if (mesh.isEnabled()) mesh.setEnabled(false);
      continue;
    }

    const slot = cpuSlots[i];
    const dt = (simulationTimeJD - slot.t0JD) * SECONDS_PER_DAY;

    let rScene, v_mps;
    if (dt <= 0) {
      rScene = slot.r0_m.scale(SCALE);
      v_mps  = slot.v0_mps;
    } else if (slot.mu <= 0) {
      rScene = slot.r0_m.add(slot.v0_mps.scale(dt)).scale(SCALE);
      v_mps  = slot.v0_mps;
    } else {
      const rv = keplerUniversalPropagate(slot.r0_m, slot.v0_mps, dt, slot.mu);
      rScene = rv.r.scale(SCALE);
      v_mps  = rv.v;
    }

    mesh.position.copyFrom(rScene);

    const lifeLeft = Math.max(0, expiryByIndex[i] - simSeconds);
    const lifeFrac = Math.max(0, Math.min(1, lifeLeft / slot.lifeSeconds));
    if (mesh.material) mesh.material.alpha = 0.5 * lifeFrac;

switch (visMode) {
  case 'none': {
    if (mesh.material) mesh.material.emissiveColor = new BABYLON.Color3(1,1,1);
    break;
  }
  case 'beta': {
    const b = Math.max(0, Math.min(1, slot.beta ?? 0));
    const u = Math.pow(b, 0.6);
    if (mesh.material) mesh.material.emissiveColor = colorFromUnit(u);
    break;
  }
}

    if (!mesh.isEnabled()) mesh.setEnabled(true);
  }
}

for (const p of planets) {
  const pos = getPlanetPosition(simulationTimeJD, p.el);
  p.mesh.position.copyFrom(pos);
}

const earthPos = getPlanetPosition(simulationTimeJD, earthEl);
earthMesh.position.copyFrom(earthPos);
}

  scene.render();
});

  window.setViewAxis = setViewAxis;
}

