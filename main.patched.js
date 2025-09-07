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

async function tryInitWebGPU() {
  if (!window.isSecureContext) {
    console.warn("[CometSim] Not a secure context:", location.protocol, "— WebGPU is disabled by the browser.");
    return null;
  }

  if (!("gpu" in navigator)) {
    console.warn("[CometSim] navigator.gpu is missing — browser doesn’t expose WebGPU.");
    return null;
  }

  let wgpu;
  try {
    wgpu = new BABYLON.WebGPUEngine(canvas, { antialiasing: true });
    await wgpu.initAsync();
  } catch (err) {
    console.warn("[CometSim] WebGPU init failed; falling back to WebGL.", err);
    return null;
  }

  const caps = wgpu.getCaps?.() || {};
  hasCompute = !!(caps.supportComputeShaders || caps.supportCompute);

  return wgpu;
}

try {
  const wgpu = await tryInitWebGPU();
  if (wgpu) {
    engine = wgpu;
    console.log("[CometSim] WebGPU enabled. Compute:", hasCompute);
    setBadge(
      hasCompute ? "GPU: WebGPU (Compute ON)" : "GPU: WebGPU (Compute OFF)",
      hasCompute ? "#0b3d0b" : "#3d2f0b",
      hasCompute ? "#0f0" : "#fd0"
    );
  } else {
    throw new Error("WebGPU not supported");
  }
} catch (e) {
  console.warn("[CometSim] Falling back to WebGL. Reason:", e && e.message);
  engine = new BABYLON.Engine(canvas, true);
  hasCompute = false;
  setBadge("GPU: WebGL (Compute OFF)", "#3d0b0b", "#f33");
}

window.__engineHasCompute = hasCompute;
window.__engineIsWebGPU = (engine && engine.getClassName?.() === "WebGPUEngine");

const scene = new BABYLON.Scene(engine);
scene.clearColor = new BABYLON.Color3(0.02, 0.02, 0.08);


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

  const cometPos = getCometState(getTimeSincePerihelionJD(simulationTimeJD));
  comet.position.copyFrom(cometPos);

  const earthPos = getEarthPosition(simulationTimeJD);
  earthMesh.position.copyFrom(earthPos);

  tailParticles.length = 0;
for (let i = 0; i < particleMeshes.length; i++) particleMeshes[i].setEnabled(false);

  if (rawParticles) {
    rawParticles.clear();
  }
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

  function updateTimeDisplay(jd) {
    timeDisplay.innerText = `Time: ${jd.toFixed(2)}`;
  }

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

function setFocusOnComet(on) {
  isCameraFocused = on;
  toggleFocusBtn.textContent = on ? "Unfocus Camera" : "Focus on Comet";

  if (on && cometMesh) {
    lastCameraTarget = camera.target.clone();
    lastCameraRadius = camera.radius;

    camera.lockedTarget = cometMesh;
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
//Draw Earth orbit
//Draw Earth, Sun and star field


//EARTH


const AU = 1.495978707e11;
const SECONDS_PER_DAY = 86400;

const DEG = Math.PI / 180;
const SCALE = 1e-10;

const earthPos = new BABYLON.Vector3(
  -0.00262790375,
   0.01445101985,
   0.00000302525
);

const earthE = 0.0167;
const earthA = 1 * AU;
const earthI = 0 * DEG;
const earthOmega = 102.9372 * DEG;
const earthOmegaCap = 0 * DEG;
const earthT0 = 2451545.0;
const earthM0 = 0;

const earthMesh = BABYLON.MeshBuilder.CreateSphere("earth", { diameter: 0.2 }, scene);
earthMesh.position = earthPos;
const earthMaterial = new BABYLON.StandardMaterial("earthMat", scene);
earthMaterial.diffuseColor = new BABYLON.Color3(0.2, 0.5, 1);
earthMaterial.emissiveColor = new BABYLON.Color3(0.05, 0.1, 0.2);
earthMesh.material = earthMaterial;

function drawEarthOrbit(scene, segments = 400) {
  const orbitPoints = [];

  for (let j = 0; j <= segments; j++) {
    const theta = -Math.PI + (2 * Math.PI * j) / segments;
    const r = earthA * (1 - earthE * earthE) / (1 + earthE * Math.cos(theta));
    const x_orb = r * Math.cos(theta);
    const y_orb = r * Math.sin(theta);

    const x = x_orb * (Math.cos(earthOmegaCap) * Math.cos(earthOmega) -
                       Math.sin(earthOmegaCap) * Math.sin(earthOmega) * Math.cos(earthI)) -
              y_orb * (Math.cos(earthOmegaCap) * Math.sin(earthOmega) +
                       Math.sin(earthOmegaCap) * Math.cos(earthOmega) * Math.cos(earthI));
    const y = x_orb * (Math.sin(earthOmegaCap) * Math.cos(earthOmega) +
                       Math.cos(earthOmegaCap) * Math.sin(earthOmega) * Math.cos(earthI)) +
              y_orb * (-Math.sin(earthOmegaCap) * Math.sin(earthOmega) +
                       Math.cos(earthOmegaCap) * Math.cos(earthOmega) * Math.cos(earthI));
    const z = x_orb * Math.sin(earthI) * Math.sin(earthOmega) +
              y_orb * Math.sin(earthI) * Math.cos(earthOmega);

    orbitPoints.push(new BABYLON.Vector3(x * SCALE, y * SCALE, z * SCALE));
  }

  const earthOrbitLine = BABYLON.MeshBuilder.CreateLines("earthOrbit", {
    points: orbitPoints,
    updatable: false,
  }, scene);
  earthOrbitLine.color = new BABYLON.Color3(0.3, 0.6, 1);
  earthOrbitLine.isPickable = false;
}

drawEarthOrbit(scene);


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
    mesh.material.pointSize = 2.0;
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
  const betaMinInput = document.getElementById("betaMinInput");
  const betaMaxInput = document.getElementById("betaMaxInput");
  const betaSkewInput = document.getElementById("betaSkewInput");

  let betaMin = parseFloat(betaMinInput.value);
  let betaMax = parseFloat(betaMaxInput.value);
  let betaSkew = parseFloat(betaSkewInput.value);

  const GMsun = 1.32712440018e20;
  const GM_sun_AU = 0.0002959122082855911;
  const MU_SCENE = GMsun * Math.pow(SCALE, 3);

  let e = parseFloat(eccentricityInput.value);
  let q = parseFloat(perihelionInput.value) * AU;
  let a = q / (1 - e);

  let q_AU = q / AU;
  let a_AU = q_AU / (1 - e);

  let i = parseFloat(inclinationInput.value) * DEG;
  let omega = parseFloat(argumentPerihelionInput.value) * DEG;
  let Omega = parseFloat(longitudeAscendingNodeInput.value) * DEG;
  let t0 = parseFloat(perihelionDateInput.value);
  const M0 = 0;

  let velocityScale = 1.0;

  function getCometState(t) {
    const n = Math.sqrt(GMsun / Math.pow(a, 3));
    let M = M0 + n * t;
    M = M % (2 * Math.PI);

    let E = M;
    for (let k = 0; k < 10; k++) {
      E = M + e * Math.sin(E);
    }

    const nu = 2 * Math.atan2(
      Math.sqrt(1 + e) * Math.sin(E / 2),
      Math.sqrt(1 - e) * Math.cos(E / 2)
    );

    const r = a * (1 - e * e) / (1 + e * Math.cos(nu));
    const x_orb = r * Math.cos(nu);
    const y_orb = r * Math.sin(nu);

    const x = x_orb * (Math.cos(Omega) * Math.cos(omega) - Math.sin(Omega) * Math.sin(omega) * Math.cos(i)) -
              y_orb * (Math.cos(Omega) * Math.sin(omega) + Math.sin(Omega) * Math.cos(omega) * Math.cos(i));
    const y = x_orb * (Math.sin(Omega) * Math.cos(omega) + Math.cos(Omega) * Math.sin(omega) * Math.cos(i)) +
              y_orb * (-Math.sin(Omega) * Math.sin(omega) + Math.cos(Omega) * Math.cos(omega) * Math.cos(i));
    const z = x_orb * (Math.sin(i) * Math.sin(omega)) + y_orb * (Math.sin(i) * Math.cos(omega));

    return new BABYLON.Vector3(x * SCALE, y * SCALE, z * SCALE);
  }

function getEarthPosition(jd) {
  const n = Math.sqrt(GMsun / Math.pow(earthA, 3));
  const t = (jd - earthT0) * 86400;
  let M = earthM0 + n * t;
  M = M % (2 * Math.PI);

  let E = M;
  for (let k = 0; k < 10; k++) {
    E = M + earthE * Math.sin(E);
  }

  const nu = 2 * Math.atan2(
    Math.sqrt(1 + earthE) * Math.sin(E / 2),
    Math.sqrt(1 - earthE) * Math.cos(E / 2)
  );

  const r = earthA * (1 - earthE * earthE) / (1 + earthE * Math.cos(nu));
  const x_orb = r * Math.cos(nu);
  const y_orb = r * Math.sin(nu);

  const x = x_orb * (Math.cos(earthOmegaCap) * Math.cos(earthOmega) -
                     Math.sin(earthOmegaCap) * Math.sin(earthOmega) * Math.cos(earthI)) -
            y_orb * (Math.cos(earthOmegaCap) * Math.sin(earthOmega) +
                     Math.sin(earthOmegaCap) * Math.cos(earthOmega) * Math.cos(earthI));
  const y = x_orb * (Math.sin(earthOmegaCap) * Math.cos(earthOmega) +
                     Math.cos(earthOmegaCap) * Math.sin(earthOmega) * Math.cos(earthI)) +
            y_orb * (-Math.sin(earthOmegaCap) * Math.sin(earthOmega) +
                     Math.cos(earthOmegaCap) * Math.cos(earthOmega) * Math.cos(earthI));
  const z = x_orb * Math.sin(earthI) * Math.sin(earthOmega) +
            y_orb * Math.sin(earthI) * Math.cos(earthOmega);

  return new BABYLON.Vector3(x * SCALE, y * SCALE, z * SCALE);
}


//-------------------------------------COMETS ORBIT---------------------------------------------
//Draw the comet’s orbit curve and "Toggle orbit" button setup
//Create the comet mesh


let orbitLine = null;

function drawOrbit(scene, segments = 800) {
  if (orbitLine) {
    orbitLine.dispose();
  }

  const orbitPoints = [];

  for (let j = 0; j <= segments; j++) {
    const theta = -Math.PI + (2 * Math.PI * j) / segments;
    const r = a * (1 - e * e) / (1 + e * Math.cos(theta));
    const x_orb = r * Math.cos(theta);
    const y_orb = r * Math.sin(theta);
    const x = x_orb * (Math.cos(Omega) * Math.cos(omega) - Math.sin(Omega) * Math.sin(omega) * Math.cos(i)) -
              y_orb * (Math.cos(Omega) * Math.sin(omega) + Math.sin(Omega) * Math.cos(omega) * Math.cos(i));
    const y = x_orb * (Math.sin(Omega) * Math.cos(omega) + Math.cos(Omega) * Math.sin(omega) * Math.cos(i)) +
              y_orb * (-Math.sin(Omega) * Math.sin(omega) + Math.cos(Omega) * Math.cos(omega) * Math.cos(i));
    const z = x_orb * (Math.sin(i) * Math.sin(omega)) + y_orb * (Math.sin(i) * Math.cos(omega));

    orbitPoints.push(new BABYLON.Vector3(x * SCALE, y * SCALE, z * SCALE));
  }

  orbitLine = BABYLON.MeshBuilder.CreateLines("orbitPath", {
    points: orbitPoints,
    updatable: false,
  }, scene);
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

  window.updateOrbitParameters = updateOrbitParameters;


//-----------------------------------------PARTICLES----------------------------------------------
//Define particle and ejection parameters
//Set up WGSL shaders
//Compute and render particles


const V0_EJECTION_MS = 400;
const EXP_BETA = 0.5;
const EXP_RH = -0.5;
const EXP_COSZ = 1.0;

const EJECTION_CONE_DEG = 90;

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
  dtSeconds: f32,
  maxCount: u32,
  muScene: f32,
  _pad1: u32,
};

@group(0) @binding(0) var<storage, read_write> posLife : array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> velBeta : array<vec4<f32>>;
@group(0) @binding(2) var<uniform> sim : SimParams;

fn accel(r: vec3<f32>, muScene: f32, beta: f32) -> vec3<f32> {
  let r2   = max(1e-18, dot(r, r));
  let invR = inverseSqrt(r2);
  let invR3= invR * invR * invR;
  let mu   = muScene * max(0.0, 1.0 - clamp(beta, 0.0, 1.0));
  return -mu * r * invR3;
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

  let a0 = accel(r, sim.muScene, b);
  v = v + a0 * sim.dtSeconds;
  r = r + v  * sim.dtSeconds;

  let life = max(p.w - sim.dtSeconds, 0.0);

  posLife[i] = vec4<f32>(r, life);
  velBeta[i] = vec4<f32>(v, b);
}
`;

  const WGSL_RENDER = `
struct Globals {
  viewProj : mat4x4<f32>,
  lifeFadeInv : f32,       // 1 / lifeSeconds
  _pad0 : vec3<f32>,       // align to 16 bytes
};
@group(0) @binding(0) var<uniform> globals : Globals;
@group(0) @binding(1) var<storage, read> posLife : array<vec4<f32>>;

struct VSOut {
  @builtin(position) Position : vec4<f32>,
  @location(0) life : f32,
};

@vertex
fn vs_main(@builtin(vertex_index) vid : u32) -> VSOut {
  var out : VSOut;
  let p = posLife[vid];
  if (p.w <= 0.0) {
    out.Position = vec4<f32>(2.0, 2.0, 2.0, 1.0);
    out.life = 0.0;
    return out;
  }
  out.Position = globals.viewProj * vec4<f32>(p.xyz, 1.0);
  out.life = p.w;                 // seconds remaining
  return out;
}

@fragment
fn fs_main(@location(0) life: f32) -> @location(0) vec4<f32> {
  let a = clamp(life * globals.lifeFadeInv, 0.0, 1.0);  // fade over full lifetime
  return vec4<f32>(1.0, 1.0, 1.0, a);
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
    size: 96,
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
      targets: [{
        format,
        blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one',       dstFactor: 'one-minus-src-alpha', operation: 'add' },
        }
      }]
    },
    primitive: { topology: 'point-list' }
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

  function update(dtSeconds, maxCount, viewProjMatrixFloat32Array) {
device.queue.writeBuffer(simUBO, 0, new Float32Array([dtSeconds]));
device.queue.writeBuffer(simUBO, 4, new Uint32Array([maxCount >>> 0]));
device.queue.writeBuffer(simUBO, 8, new Float32Array([MU_SCENE]));

    const lifeFadeInv = 1 / Math.max(1e-6, baseLifetime * SECONDS_PER_DAY);
    device.queue.writeBuffer(globalsUBO, 0,  viewProjMatrixFloat32Array);           // 64 bytes
    device.queue.writeBuffer(globalsUBO, 64, new Float32Array([lifeFadeInv, 0, 0, 0]));
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
      pass.draw(maxCount, 1, 0, 0);
      pass.end();
    }

    device.queue.submit([enc.finish()]);
  }

return { seed, update, resize, clear, max: MAX_PARTICLES };
}

function stumpffC(z) {
  if (Math.abs(z) < 1e-8) return 1/2 - z/24 + z*z/720 - z*z*z/40320;
  return (1 - Math.cos(Math.sqrt(z))) / z;
}
function stumpffS(z) {
  if (Math.abs(z) < 1e-8) return 1/6 - z/120 + z*z/5040 - z*z*z/362880;
  const s = Math.sqrt(z);
  return (s - Math.sin(s)) / (s*s*s);
}

function keplerUniversalPropagate(r0, v0, dt, mu) {
  const r0mag = r0.length();
  const v0mag = v0.length();
  const vr0 = BABYLON.Vector3.Dot(r0, v0) / r0mag;
  const alpha = 2 / r0mag - (v0mag * v0mag) / mu;

  let x;
  if (Math.abs(alpha) > 1e-12) {
    x = Math.sqrt(mu) * Math.abs(alpha) * dt;
  } else {
    x = Math.sqrt(mu) * dt / r0mag;
  }

  const sqrtMu = Math.sqrt(mu);
  for (let it = 0; it < 50; it++) {
    const z = alpha * x * x;
    const C = stumpffC(z);
    const S = stumpffS(z);

    const F = r0mag * vr0 / sqrtMu * x * x * C
            + (1 - alpha * r0mag) * x * x * x * S
            + r0mag * x
            - sqrtMu * dt;

    const dF = r0mag * vr0 / sqrtMu * x * (1 - z * S)
             + (1 - alpha * r0mag) * x * x * C
             + r0mag;

    const dx = -F / dF;
    x += dx;
    if (Math.abs(dx) < 1e-8) break;
  }

  const z = alpha * x * x;
  const C = stumpffC(z);
  const S = stumpffS(z);
  const f = 1 - (x * x / r0mag) * C;
  const g = dt - (x * x * x / sqrtMu) * S;
  const r = r0.scale(f).add(v0.scale(g));
  const rmag = r.length();
  const fdot = (sqrtMu / (rmag * r0mag)) * (z * S - 1) * x;
  const gdot = 1 - (x * x / rmag) * C;
  const v = r0.scale(fdot).add(v0.scale(gdot));
  return { r, v };
}
  const tailParticles = [];
  const MAX_PARTICLES = 100000;

  // const particleSizeInput = document.getElementById("particleSizeInput");
  const particleLifetimeInput = document.getElementById("particleLifetimeInput");
  const particleCountInput = document.getElementById("particleCountInput");
  const activityExponentInput = document.getElementById("activityExponentInput");
  const activityScaleInput    = document.getElementById("activityScaleInput");
    
  // let particleSize = parseFloat(particleSizeInput.value);
  let baseLifetime = parseFloat(particleLifetimeInput.value);
  let particleCountPerSec = parseInt(particleCountInput.value);
  let baseEmitInterval = 1000 / particleCountPerSec;
  let activityN = parseFloat(activityExponentInput?.value ?? 2) || 2; // exponent n
  let activityK = parseFloat(activityScaleInput?.value ?? 1)   || 1; // scale k


  const engineIsWGPU = engine instanceof BABYLON.WebGPUEngine;
  const rawParticles = engineIsWGPU ? await setupRawParticles(engine, canvas, MAX_PARTICLES) : null;
  if (rawParticles) rawParticles.clear();

function seedParticleAt(index, r_scene, v_scene_per_s, lifeSeconds, beta) {
  if (rawParticles) {
    rawParticles.seed(index, r_scene, v_scene_per_s, lifeSeconds, beta);
  }
}

function sampleConeDirection(axis, halfAngleRad) {
  const zAxis = axis.clone().normalize();
  const tmp   = Math.abs(zAxis.x) < 0.99 ? new BABYLON.Vector3(1,0,0) : new BABYLON.Vector3(0,1,0);
  const xAxis = BABYLON.Vector3.Cross(tmp, zAxis).normalize();
  const yAxis = BABYLON.Vector3.Cross(zAxis, xAxis).normalize();
  const u = Math.random();
  const v = Math.random();
  const cosPhi = 1 - u * (1 - Math.cos(halfAngleRad));
  const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi));
  const theta  = 2 * Math.PI * v;

  return zAxis.scale(cosPhi)
    .add(xAxis.scale(sinPhi * Math.cos(theta)))
    .add(yAxis.scale(sinPhi * Math.sin(theta)))
    .normalize();
}

function getCometVelocity(t) {
  const t_days = t / 86400;
  const n = Math.sqrt(GM_sun_AU / Math.pow(a_AU, 3));
  let M = (M0 + n * t_days) % (2 * Math.PI);
  if (M < 0) M += 2 * Math.PI;

  let E = M;
  for (let k = 0; k < 10; k++) {
    E = M + e * Math.sin(E);
  }

  const nu = 2 * Math.atan2(
    Math.sqrt(1 + e) * Math.sin(E * 0.5),
    Math.sqrt(1 - e) * Math.cos(E * 0.5)
  );

  const h = Math.sqrt(GM_sun_AU * a_AU * (1 - e * e));
  const vx_orb = -(GM_sun_AU / h) * Math.sin(nu);
  const vy_orb =  (GM_sun_AU / h) * (e + Math.cos(nu));

  const cO = Math.cos(Omega), sO = Math.sin(Omega);
  const co = Math.cos(omega), so = Math.sin(omega);
  const ci = Math.cos(i),     si = Math.sin(i);

  const vx =
    vx_orb * ( cO*co - sO*so*ci ) - vy_orb * ( cO*so + sO*co*ci );
  const vy =
    vx_orb * ( sO*co + cO*so*ci ) + vy_orb * ( -sO*so + cO*co*ci );
  const vz =
    vx_orb * ( si*so ) + vy_orb * ( si*co );

  return new BABYLON.Vector3(vx, vy, vz).scale(AU / SECONDS_PER_DAY);
}

let gpuWriteCursor = 0;
let simSeconds = 0;

const expiryByIndex = new Float32Array(MAX_PARTICLES);
let maxUsed = 0;

function getTimeSincePerihelionJD(jd) {
  return (jd - t0) * 86400;
}

function createTailParticle(timeNowJD) {
  if (gpuWriteCursor >= MAX_PARTICLES) gpuWriteCursor = 0;

  const tSincePerihelion = getTimeSincePerihelionJD(timeNowJD);
  if (!isFinite(tSincePerihelion)) return;

  const cometPos_scene = getCometState(tSincePerihelion);
  const cometVel_mps   = getCometVelocity(tSincePerihelion);
  const cometVel_scene = cometVel_mps.scale(SCALE);

  const antiSolar_scene = cometPos_scene.clone().normalize();
  const coneHalfAngle   = (EJECTION_CONE_DEG * Math.PI) / 180;
  const dir_scene       = sampleConeDirection(antiSolar_scene, coneHalfAngle);

  const rhAU = cometPos_scene.length() / (SCALE * AU);

  const beta = generateBeta(betaMin, betaMax, betaSkew);

  const cosZ = Math.max(BABYLON.Vector3.Dot(dir_scene, antiSolar_scene), 0);
  const emissionSpeed_mps =
    V0_EJECTION_MS *
    Math.pow(Math.max(beta, 1e-6), EXP_BETA) *
    Math.pow(Math.max(rhAU, 1e-6), EXP_RH) *
    Math.pow(Math.max(cosZ, 1e-3), EXP_COSZ);

  const emissionVel_scene = dir_scene.scale(emissionSpeed_mps * SCALE);
  const v_scene = cometVel_scene.add(emissionVel_scene);
  const lifeSeconds = (baseLifetime / velocityScale) * SECONDS_PER_DAY;

let tries = 0;
while (tries < MAX_PARTICLES && expiryByIndex[gpuWriteCursor] > simSeconds) {
  gpuWriteCursor = (gpuWriteCursor + 1) % MAX_PARTICLES;
  tries++;
}
if (tries === MAX_PARTICLES) {
  return;
}

const idx = gpuWriteCursor;
expiryByIndex[idx] = simSeconds + lifeSeconds;
gpuWriteCursor = (gpuWriteCursor + 1) % MAX_PARTICLES;
if (idx + 1 > maxUsed) maxUsed = idx + 1;

seedParticleAt(idx, cometPos_scene, v_scene, lifeSeconds, beta);
}

function generateBeta(min, max, skew) {
  if (min === max) return min;
  let u = Math.random();
  if (skew !== 0) {
    const k = 1 + Math.abs(skew);
    u = (skew < 0) ? 1 - Math.pow(1 - u, k) : Math.pow(u, k);
  }
  return min + u * (max - min);
}


//------------------------------------USER INTERFACE---------------------------------
//Wire up speed slider, pause button, and all input fields.
//Rebuild orbit parameters when inputs change


const velocitySlider = document.getElementById("velocitySlider");
const velocityValueLabel = document.getElementById("velocityValue");

velocitySlider.addEventListener("input", () => {
  const sliderValue = parseInt(velocitySlider.value);
  
  simulationSpeed = 0.8 * Math.pow(2, sliderValue / 4);

  velocityValueLabel.textContent = simulationSpeed.toFixed(2) + "×";
});

const fpsCounter = document.getElementById("fpsCounter");
const particleCounter = document.getElementById("particleCounter");

function updateOrbitParameters() {
  e = parseFloat(eccentricityInput.value);
  q = parseFloat(perihelionInput.value) * AU;
  i = parseFloat(inclinationInput.value) * DEG;
  Omega = parseFloat(longitudeAscendingNodeInput.value) * DEG;
  omega = parseFloat(argumentPerihelionInput.value) * DEG;
  t0 = parseFloat(perihelionDateInput.value);

  betaMin = parseFloat(betaMinInput.value);
  betaMax = parseFloat(betaMaxInput.value);
  betaSkew = parseFloat(betaSkewInput.value);


  activityN = parseFloat(activityExponentInput.value);
  activityK = parseFloat(activityScaleInput.value);

  betaMin = Math.min(Math.max(betaMin, 0), 1);
  betaMax = Math.min(Math.max(betaMax, 0), 1);
if (betaMax < betaMin) [betaMin, betaMax] = [betaMax, betaMin];

  a = q / (1 - e);
  averageOrbitalSpeed = Math.sqrt(GMsun / a);

  if (orbitLine) orbitLine.dispose();
  drawOrbit(scene);

  // particleSize  = parseFloat(particleSizeInput.value);
  baseLifetime  = parseFloat(particleLifetimeInput.value);   // days

  particleCountPerSec = parseFloat(particleCountInput.value) || 1;
  particleCountPerSec = Math.max(0.01, particleCountPerSec);
  baseEmitInterval = 1000 / particleCountPerSec;
  lastEmitSim = simSeconds;


  if (!isFinite(activityN)) activityN = 2;
  if (!isFinite(activityK)) activityK = 1;
  activityN = Math.max(0, Math.min(6, activityN)); // clamp 0..6
  activityK = Math.max(0, activityK);              // no negative activity

  // for (let mesh of particleMeshes) {
  //   mesh.scaling.set(particleSize, particleSize, particleSize);
  // }
}

window.updateOrbitParameters = updateOrbitParameters;

[
  eccentricityInput,
  perihelionInput,
  inclinationInput,
  longitudeAscendingNodeInput,
  argumentPerihelionInput,
  perihelionDateInput,
  betaMinInput,
  betaMaxInput,
  betaSkewInput,
  // particleSizeInput,
  particleLifetimeInput,
  particleCountInput,
  activityExponentInput, 
  activityScaleInput
].forEach(input => {
  input.addEventListener("input", updateOrbitParameters);
});

let isPaused = false;
const pauseBtn = document.getElementById("pauseBtn");

pauseBtn.addEventListener("click", () => {
  
  isPaused = !isPaused;
  pauseBtn.textContent = isPaused ? "Resume" : "Pause";
    updateTimelineUIState();
});

function getDustPositionKepler(p, currentJD) {
  const dt = (currentJD - p.t0JD) * SECONDS_PER_DAY;
  if (dt < 0) return p.r0_m.scale(SCALE);
  if (p.mu <= 0) {
    const r_ballistic = p.r0_m.add(p.v0_mps.scale(dt));
    return r_ballistic.scale(SCALE);
  }
  const prop = keplerUniversalPropagate(p.r0_m, p.v0_mps, dt, p.mu);
  return prop.r.scale(SCALE);
}
  const particleMeshes = [];

if (!hasCompute) {
  for (let i = 0; i < MAX_PARTICLES; i++) {
    const mesh = BABYLON.MeshBuilder.CreateIcoSphere("tailParticle", { radius: 0.5, subdivisions: 2 }, scene);
    // mesh.scaling.set(particleSize, particleSize, particleSize);

    const mat = new BABYLON.StandardMaterial("tailMat", scene);
    mat.emissiveColor = new BABYLON.Color3(1, 1, 1);
    mat.diffuseColor  = new BABYLON.Color3(0.6, 0.6, 0.6);
    mat.alpha = 0.5;

    mesh.material = mat;
    mesh.setEnabled(false);
    particleMeshes.push(mesh);
  }
}

window.addEventListener("resize", () => {
  engine.resize();
  if (rawParticles) rawParticles.resize();
});

if (rawParticles) {
  scene.onAfterRenderObservable.add(() => {
    const dtSeconds = isPaused ? 0 : (engine.getDeltaTime() / 1000) * simulationSpeed;
    const vpF32 = new Float32Array(scene.getTransformMatrix().m);
    rawParticles.update(dtSeconds, Math.max(1, maxUsed), vpF32);
  });
}

let lastEmitSim = 0;


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
    drawCount = active;
    particleCounter.textContent = "Particles (GPU): " + active;
  } else {
    particleCounter.textContent = "Particles: " + tailParticles.length;
  }

  uiAccum = 0;
}
    const cometPos = getCometState(getTimeSincePerihelionJD(simulationTimeJD));
    comet.position.copyFrom(cometPos);
// PREV:
// const emitIntervalSeconds = (baseEmitInterval / 1000) / simulationSpeed;
// if (!isPaused && (simSeconds - lastEmitSim) >= emitIntervalSeconds) {
//   createTailParticle(simulationTimeJD);
//   lastEmitSim = simSeconds;
// }
// NEW:
// how many you’ll allow per frame
// --- births-per-frame emitter with Q(r) = 1/r^2 ---
// Reinterpret slider: "Max births per frame at 1 AU"
const MAX_BIRTHS_PER_FRAME_AT_1_AU = Math.max(0, parseFloat(particleCountInput.value) || 0);

// Distance r in AU (comet–Sun)
const rAU   = comet.position.length() / (SCALE * AU);
const rSafe = Math.max(1e-3, rAU);

// Activity scale Q = 1/r^2, clamped so we never exceed the slider at perihelion
// const Q = 1 / (rSafe * rSafe *rSafe *rSafe);
const Q = Math.max(0, activityK) / Math.pow(rSafe, Math.max(0, activityN));

const scale = Math.min(1, Q);  // clamp: <= 1

// Target births this frame
const targetBPF = MAX_BIRTHS_PER_FRAME_AT_1_AU * scale;

// Accumulate fractional births so the average matches the target
window.emitCarry = (typeof window.emitCarry !== "undefined") ? window.emitCarry : 0;
window.emitCarry += targetBPF;

let births = Math.floor(window.emitCarry);
window.emitCarry -= births;

// Optional hard safety cap so a crazy slider value doesn't spike
const HARD_CAP = 512;
if (births > HARD_CAP) births = HARD_CAP;

// Spawn births *at now* (no intra-frame spread -> no "line" artifact)
if (!isPaused && births > 0) {
  for (let i = 0; i < births; i++) {
    createTailParticle(simulationTimeJD, simSeconds); // uses per-particle birth for expiry
  }
}



while (tailParticles.length &&
  (simulationTimeJD - tailParticles[0].t0JD) > tailParticles[0].lifetimeDays) {
    tailParticles.shift();
}

if (!hasCompute) {
  for (let i = 0; i < tailParticles.length; i++) {
    const p = tailParticles[i];
    const pos = getDustPositionKepler(p, simulationTimeJD);
    particleMeshes[i].position.copyFrom(pos);
    particleMeshes[i].setEnabled(true);
  }
  for (let i = tailParticles.length; i < particleMeshes.length; i++) {
    particleMeshes[i].setEnabled(false);
  }
}

const earthPos = getEarthPosition(simulationTimeJD);
earthMesh.position.copyFrom(earthPos); 
}

  scene.render();
});

  window.addEventListener("resize", () => {
    engine.resize();
  });
  window.setViewAxis = setViewAxis;
}
