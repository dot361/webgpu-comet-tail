# Comet Simulator

Interactive, browser-based **comet dust-tail** simulator built with **Babylon.js**. When available it uses **WebGPU compute** for particle integration + rendering (via a dedicated WebGPU overlay canvas), with a **CPU/WebGL fallback**.

This README documents the architecture, physics, UI, and how to run/extend the project.

---

## Table of contents
1. [Quick start](#quick-start)
2. [What you get](#what-you-get)
3. [How it works (high level)](#how-it-works-high-level)
4. [Coordinate frames, units & time](#coordinate-frames-units--time)
5. [Physics & numerics](#physics--numerics)
   - [Planet ephemerides](#planet-ephemerides)
   - [Comet propagation](#comet-propagation)
   - [Activity law & fading](#activity-law--fading)
   - [Dust grains (β) and dynamics](#dust-grains-β-and-dynamics)
   - [GPU vs CPU paths](#gpu-vs-cpu-paths)
   - [Synchrones, syndynes, PA and RA/Dec export](#synchrones-syndynes-pa-and-radec-export)
6. [User interface](#user-interface)
   - [Controls & inputs](#controls--inputs)
   - [Keyboard shortcuts](#keyboard-shortcuts)
   - [Presets](#presets)
7. [Performance tips](#performance-tips)
8. [Validation & sanity checks](#validation--sanity-checks)
9. [License](#license--credits)

---

## Quick start

### Requirements
- A recent **Chromium-based** browser for WebGPU (Chrome / Edge).
- WebGPU requires a **secure context** (`http://localhost` or `https://…`). `file://` won’t expose WebGPU.

> Firefox/Safari: may work only with experimental flags and/or partial support. If WebGPU is unavailable, the simulator automatically falls back to WebGL + CPU.

### Run
Open `index.html` through `http://localhost:…`.

### Runtime switches
Use query params:

- `?force=webgl` → skip WebGPU init and use WebGL (CPU particles).
- `?force=cpu` → still use WebGPU rendering if available, but disable **compute** (forces CPU integration).

A small badge at top-right shows the active mode:
- `GPU: WebGPU (Compute ON)` – compute shader integration + overlay rendering
- `GPU: WebGPU (Compute OFF)` – WebGPU rendering, but particles integrated on CPU
- `GPU: WebGL (Compute OFF)` – full fallback

---

## What you get

### Scene & time
- 3D solar-system backdrop: Sun, planets, orbit lines, starfield.
- Comet orbit rendering from classical elements: \(e, q, i, \Omega, \omega, T\).
- Timeline control in **Julian Days (JD)**:
  - Real-time simulation advance with speed slider
  - Pause/resume
  - When paused: scrub the timeline and click **Update Position** to jump

### Dust + visuals
- Dust grains modeled with per-particle **β** (radiation pressure ratio), affecting the effective solar gravity.
- Interactive **β gradation curve** editor (spline-like control points) to shape the β distribution.
- Particle color visualization modes:
  - none / white
  - by β
  - by age
  - by distance from nucleus
  - by relative velocity vs comet

### Diagnostics tools
- Generate and draw **Synchrones** and **Syndynes** at the current paused epoch.
- Compute **position angle (PA)** for a synchrone (and also the antisolar PA) in the console.
- Export synchrone/syndyne samples as **CSV** with **RA/Dec** (geocentric, from Earth) + comet RA/Dec.

### Presets & interaction
- Presets: **67P**, **C/2024 E1**, **133P**, **3I/ATLAS**.
- Clickable preset comet meshes (if present in the scene) can activate a preset.
- On-screen counters for **FPS**, **particles**, and activity values.

---

## How it works (high level)

1. **Engine selection**  
   Try WebGPU (secure context + `navigator.gpu`). If unavailable or `?force=webgl`, fall back to Babylon WebGL engine. Compute is enabled only if WebGPU caps report compute support.

2. **Scene & UI**  
   Babylon builds the scene. HTML overlay provides inputs/sliders/buttons. A separate overlay `<canvas>` uses `webgpu` context for GPU particle rendering.

3. **Time (JD)**  
   Internal time is Julian Days (`simulationTimeJD`). Simulation speed scales how fast JD advances. When paused, timeline scrubbing is enabled, and **Update Position** applies the new epoch and resets particle state.

4. **Comet state**  
   From the orbital elements, the perihelion state is built in orbital plane coordinates (PQW), rotated into inertial IJK, then propagated to the current JD using **universal variables**.

5. **Particles**  
   Each frame emits particles based on an activity law (scaled by cumulative exposure fading). GPU or CPU path updates particle states and draws them.

---

## Coordinate frames, units & time

### Frames
- **Primary frame**: heliocentric inertial (IJK).
- Orbital plane vectors are rotated PQW → IJK with the standard 3-1-3 rotation sequence (Ω, i, ω).

### Units
- Physical state is in **meters** and **seconds**.
- \( \text{AU} = 1.495978707\times10^{11}\ \text{m}\)
- \( \mu_\odot = 1.32712440018\times10^{20}\ \text{m}^3/\text{s}^2\)
- **Scene scaling**: positions are multiplied by `SCALE = 1e-10` before rendering.

Derived:
- `MU_SCENE = GMsun * SCALE^3` (used in WGSL compute).

### Time
- Simulation clock uses **Julian Days**.
- `SECONDS_PER_DAY = 86400`.
- Display helpers:
  - `jdToDateString(jd)` (YYYY-MM-DD)
  - `julianDayToDate(jd)` (full UTC date+time display)

---

## Physics & numerics

### Planet ephemerides
- Planets are drawn on fixed Keplerian ellipses referenced to J2000.
- Mean anomaly is advanced with \(n=\sqrt{\mu/a^3}\) and Kepler’s equation is solved via Newton iterations.
- No perturbations: visually plausible orbits, not precision ephemerides.

### Activity law & fading
Emission rate is driven by:
- **Activity law**:
- **Cumulative exposure fading**:
  - Exposure integrates roughly, while the comet is within `ACTIVE_R_AU` (default 3 AU).
  - `ageFactor = 2^{-\text{exposure}/\text{halfLife}}` where halfLife is `activityHalfLifeInput` in “exposure-days” (e-days).

Displayed on HUD:
- `Q: …`
- `decay: …%`

### GPU vs CPU paths

#### GPU path (WebGPU compute + overlay render)
- Storage buffers:
  - `posLife[i] = (x,y,z, lifeSecondsRemaining)`
  - `velBeta[i] = (vx,vy,vz, beta)`
- Compute shader integrates with velocity-Verlet (kick-drift-kick) and adaptive sub-stepping:
- Rendering uses a WebGPU render pipeline drawing a camera-facing quad per particle (6 vertices per particle) with alpha blending.
- GPU visual modes are implemented in WGSL:
  - β rainbow mapping
  - age gradient
  - distance gradient
  - relative velocity rainbow

#### CPU path (WebGL or forced CPU)
- Each particle slot stores:
  - `t0JD`, `r0_m`, `v0_mps`, `mu`, `lifeSeconds`, `beta`
- Propagation:
  - If `mu > 0`: universal variables propagation
  - If `mu <= 0`: linear drift
- Rendering:
  - small Babylon meshes with alpha fade by remaining lifetime
  - same visualization modes as GPU path implemented in JS

### Synchrones, syndynes, PA and RA/Dec export

These tools are designed for qualitative diagnostics.

#### Synchrones
- A **synchrone** holds emission time fixed (relative offset in days from the paused observation epoch) while varying β.
- Generated by:
  - Choose `emissionOffsetsDays` (e.g. `-120,-60,-30,-10`)
  - Choose `betaValues` (e.g. `0.01,0.05,0.1,0.3,0.7`)
  - For each offset, compute comet state at emission time, then propagate dust to observation time using \(\mu_\text{eff}\).

#### Syndynes
- A **syndyne** holds β fixed while varying emission time offsets.

#### Position angle (PA)
- `computePAFromSynchrone()` estimates a PA from a synchrone polyline by:
  - converting from ecliptic to equatorial (fixed obliquity)
  - projecting synchrone direction into the plane of the sky
  - measuring angle from celestial north through east
- Console prints PA per synchrone line and the antisolar PA.

#### CSV export (RA/Dec)
- Export button writes a CSV containing:
  - type (`synchrone` or `syndyne`)
  - epochJD
  - (dDays, beta, pointIndex)
  - point RA/Dec (geocentric from Earth)
  - comet RA/Dec at epoch

> Tip: Pause the sim first. Syn/syd generation + export are disabled while running.

---

## User interface

### Controls & inputs

**Left overlay**
- Orbital elements: `e, q(AU), i, Ω, ω, T(JD)`
- Activity:
  - `n` and `k`
  - activity decay half-life (e-days)
- Particles:
  - lifetime (days)
  - particle count (per second baseline)
  - particle color mode
- Camera locking input:
  - x/y/z and unit selector (AU / m / km)
- Synchrone/syndyne inputs:
  - days offsets list
  - beta list

**Right side / floating buttons**
- Axis snap: X / Y / Z
- Toggle Orbit Visibility
- Focus on Comet
- Update Position (enabled only when paused)
- Preset buttons (67P, C/2024 E1, 133P, 3I/ATLAS)
- Camera locks:
  - Lock camera position (J2000-style input position)
  - Lock camera to Earth (camera position follows Earth)
  - When locked, “Focus/Track” toggles whether the locked camera tracks the comet.

**Bottom bar**
- Timeline JD offset from J2000.
- Slider enabled only when paused.

**HUD**
- GPU badge
- Pause/Resume
- FPS, particle count
- Activity Q and decay

### Keyboard shortcuts
- **Space** – Pause/Resume
- **Shift+A / Shift+D** – decrease/increase simulation speed
- **U** – Update Position (apply paused timeline date)
- **F** – Focus/Unfocus camera (or Track Comet when camera is locked)
- **O** – Toggle comet orbit line
- **X / Y / Z** – snap view axes
- **L** – lock/unlock camera position (J2000 input)
- **E** – lock/unlock camera to Earth

### Presets
Coded into `loadComet(id)`:
- **67P/Churyumov–Gerasimenko**: `e=0.64090813, q=1.24326564 AU, i=7.0403°, Ω=50.1356°, ω=12.7983°, T=2457247.5887 JD`
- **C/2024 E1**: `e=1.00048372, q=0.56171583 AU, i=75.2181°, Ω=108.3886°, ω=243.6516°, T=2461060.9651 JD`
- **133P/Elst–Pizarro**: `e=0.15637284, q=2.67049635 AU, i=1.3898°, Ω=160.0995°, ω=131.9019°, T=2460440.7000 JD`
- **3I/ATLAS**: `e=6.13941774, q=1.35638454 AU, i=175.1131°, Ω=322.1568°, ω=128.0105°, T=2460977.9814 JD`

---

## Performance tips
- Prefer **WebGPU (Compute ON)**.
- Reduce:
  - Particle count (per sec)
  - Lifetime (days)
- Avoid extremely large max particle counts if your GPU is memory-limited.
- CPU path draws many meshes → much heavier than GPU quads.

---

## Validation & sanity checks

1. **β effect**
   - Increase β range and observe broader, more strongly curved structures.

2. **Activity scaling**
   - Increase `n` and confirm that emission concentrates strongly near perihelion.

3. **Exposure fading**
   - Reduce half-life and confirm tail weakens sooner after sustained time.

4. **Synchrones/syndynes**
   - Generate both at the same paused epoch:
     - synchrones should fan across β at fixed emission ages
     - syndynes should show curves for fixed β across emission time

5. **PA sanity (qualitative)**
   - Compare synchrone PA values against the antisolar PA printed in console.

---

## Extending the simulator

### Add a new comet preset
Edit the `comets` object inside `loadComet(id)`.

## Credits
Free for any use (including commercial). Credit is appreciated but not required.

Credit:
Miks Balodis (RTU Engineering Highschool student). Supervised by Mg. sc. comp. Gints Jasmonts and Prof. Andris Slavinskis.
