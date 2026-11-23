import { SILENCE_END, SILENCE_START, clamp, smoothstep } from '../data/chapters';

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface ParallaxInput {
  cameraPos: Vec3Like;
  cameraVelocity: Vec3Like;
  pointerOffset: { x: number; y: number };
}

export interface ParallaxOptions {
  reducedMotion: boolean;
  silenceDamp: number;
}

export interface BloomParams {
  strength: number;
  radius: number;
  threshold: number;
}

export interface CinemaOpticsParams {
  exposure: number;
  lensStrength: number;
  anamorphicIntensity: number;
  bokehStrength: number;
  chromaticIntensity: number;
  halationStrength: number;
}

const MAX_LATERAL_SHIFT = 22.0;
const MAX_VERTICAL_SHIFT = 16.0;
const MAX_DEPTH_SHIFT = 14.0;

/**
 * Computes a depth-scaled 3D parallax offset for a cosmic layer (distant stars,
 * mid-field stars, nebulae, or near-field micro-debris) driven by camera movement
 * and pointer drift.
 */
export function writeParallaxOffset(
  out: Vec3Like,
  input: ParallaxInput,
  depthFactor: number,
  options: ParallaxOptions,
): Vec3Like {
  const depth = Math.max(0, depthFactor);
  const motionAttenuation = options.reducedMotion ? 0.14 : 1.0;
  const silenceAttenuation = clamp(options.silenceDamp, 0, 1);
  const scale = depth * motionAttenuation * silenceAttenuation;

  if (scale <= 0) {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    return out;
  }

  const rawX =
    (-input.cameraPos.x * 0.42 -
      input.cameraVelocity.x * 0.58 -
      input.pointerOffset.x * 5.4) *
    scale;
  const rawY =
    (-input.cameraPos.y * 0.36 -
      input.cameraVelocity.y * 0.5 -
      input.pointerOffset.y * 3.8) *
    scale;
  const rawZ = -input.cameraVelocity.z * 0.48 * scale;

  out.x = clamp(rawX, -MAX_LATERAL_SHIFT, MAX_LATERAL_SHIFT) + 0;
  out.y = clamp(rawY, -MAX_VERTICAL_SHIFT, MAX_VERTICAL_SHIFT) + 0;
  out.z = clamp(rawZ, -MAX_DEPTH_SHIFT, MAX_DEPTH_SHIFT) + 0;
  return out;
}

export function computeParallaxOffset(
  input: ParallaxInput,
  depthFactor: number,
  options: ParallaxOptions,
): Vec3Like {
  return writeParallaxOffset({ x: 0, y: 0, z: 0 }, input, depthFactor, options);
}

function interpolateStops(
  t: number,
  stops: ReadonlyArray<readonly [number, number]>,
): number {
  let idx = 0;
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) {
      idx = i;
      break;
    }
  }
  const a = stops[idx];
  const b = stops[Math.min(idx + 1, stops.length - 1)];
  const span = Math.max(0.001, b[0] - a[0]);
  const w = smoothstep(0, 1, (t - a[0]) / span);
  return a[1] + (b[1] - a[1]) * w;
}

/**
 * Subtle, dark-void-preserving Unreal-style Gaussian bloom profile:
 * High HalfFloat HDR luminance thresholds (0.62–0.80) guarantee zero bleed into
 * the obsidian void or faint Milky Way dust, while silky wider radii (0.56–0.72)
 * let bright distant star cores, the Sun, and the Sagittarius anchor glow with
 * an ethereal theatrical halo without washing out contrast.
 */
export function computeBloomParams(filmTime: number): BloomParams {
  const t = clamp(filmTime, 0, 405);

  const stops: ReadonlyArray<readonly [number, number, number, number]> = [
    [0, 0.34, 0.62, 0.68], // Prologue singularity & distant pinpoint stars
    [22, 0.40, 0.66, 0.64], // Big Bang expansion (crisp filaments, dark obsidian void)
    [55, 0.28, 0.58, 0.74], // Approach toward Solar System
    [76, 0.24, 0.56, 0.80], // Chapter I: Earth & Hyderabad (strictly Sun, dawn limb & bright stars)
    [110, 0.34, 0.64, 0.68], // Chapter II: Sequential Sagittarius constellation stars
    [175, 0.38, 0.66, 0.64], // Chapter III: Living star network filaments
    [225, 0.36, 0.64, 0.66], // Chapter IV: Monumental Yin-Yang equilibrium
    [285, 0.26, 0.58, 0.76], // Chapter V: Quiet Hours sanctuary (intimate window glow)
    [335, 0.36, 0.64, 0.66], // Final Chapter: Relativistic convergence begins
    [362, 0.42, 0.68, 0.62], // Tightening convergence before silence
    [SILENCE_START, 0.28, 0.60, 0.72], // Hard cosmic silence (pure solitary star)
    [SILENCE_END, 0.30, 0.62, 0.70], // Breath before reveal ignition
    [373.5, 0.72, 0.78, 0.48], // Earned supernova reveal peak
    [382, 0.36, 0.64, 0.66], // Warm restrained post-reveal afterglow
    [405, 0.32, 0.62, 0.68], // Closing hold
  ];

  let idx = 0;
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) {
      idx = i;
      break;
    }
  }

  const a = stops[idx];
  const b = stops[Math.min(idx + 1, stops.length - 1)];
  const span = Math.max(0.001, b[0] - a[0]);
  const w = smoothstep(0, 1, (t - a[0]) / span);

  return {
    strength: a[1] + (b[1] - a[1]) * w,
    radius: a[2] + (b[2] - a[2]) * w,
    threshold: a[3] + (b[3] - a[3]) * w,
  };
}

/**
 * Restrained theatrical dynamic HDR exposure curve (0.72–0.92 baseline):
 * Keeps deep space truly dark and high-contrast, letting light feel rare and
 * sacred, with an earned controlled iris bloom (1.28) strictly at the supernova reveal.
 */
export function computeDynamicExposure(filmTime: number): number {
  const t = clamp(filmTime, 0, 405);
  return interpolateStops(t, [
    [0, 0.78],
    [14, 0.88], // Prologue singularity & accretion ring
    [45, 0.82],
    [76, 0.80], // Crisp high-contrast orbital Earth daylight/night terminator
    [135, 0.84], // Chapter II constellation figure
    [200, 0.85], // Chapter III living star network
    [255, 0.83], // Chapter IV Yin-Yang equilibrium
    [305, 0.90], // Chapter V iris gently adapts in dim quiet sanctuary
    [332, 0.94], // Soft dawn warmth behind sanctuary
    [358, 0.86], // Convergence tightening
    [SILENCE_START, 0.72], // Deep ink-black silence
    [SILENCE_END - 0.3, 0.82], // Dark-adapted iris right before ignition
    [SILENCE_END + 1.1, 1.28], // Earned supernova iris bloom (controlled, non-blown-out)
    [376.5, 0.86], // Settling into rich golden contrast behind title
    [405, 0.82],
  ]);
}

/**
 * Computes restrained IMAX 70mm optical post-processing parameters and dedicated
 * peripheral chromatic aberration intensity driven by chapter mood and camera dive speed.
 */
export function computeCinemaOptics(
  filmTime: number,
  cameraSpeed: number,
  reducedMotion: boolean,
): CinemaOpticsParams {
  const t = clamp(filmTime, 0, 405);

  // Relativistic gravitational lensing around the Prologue singularity only (a star does not visibly lens)
  const prologueLens =
    smoothstep(1.5, 9.0, t) * (1 - smoothstep(26.0, 42.0, t)) * 0.78;
  const lensStrength = clamp(
    prologueLens * (reducedMotion ? 0.45 : 1.0),
    0,
    1,
  );

  // Restrained horizontal anamorphic streak flares (never distracting or constant)
  const anamorphicIntensity = interpolateStops(t, [
    [0, 0.08],
    [12, 0.32], // Singularity photon ring flare
    [48, 0.10],
    [68, 0.38], // Distant Sun flare in Chapter I
    [104, 0.12],
    [145, 0.14], // Constellation figure heart star
    [200, 0.18], // Network anchor
    [255, 0.08], // Star-cluster taijitu (no central point source)
    [310, 0.08], // Quiet sanctuary (minimal optical artifacts)
    [360, 0.2], // Dying red supergiant
    [SILENCE_START + 1.0, 0.18], // Pure solitary star
    [SILENCE_END + 1.2, 0.68], // Supernova anamorphic sweep
    [382, 0.22],
    [405, 0.14],
  ]);

  const bokehStrength = interpolateStops(t, [
    [0, 0.14],
    [76, 0.28],
    [140, 0.34],
    [200, 0.20],
    [255, 0.26],
    [312, 0.40],
    [365, 0.20],
    [385, 0.24],
    [405, 0.20],
  ]);

  // Dedicated screen-space peripheral chromatic aberration intensity:
  // Baseline subtle 70mm anamorphic edge dispersion + gentle boost during camera dives & relativistic portals
  const speedNorm = clamp(cameraSpeed / 14.0, 0, 1);
  const baseCa = reducedMotion ? 0.0018 : 0.0038;
  const chromaticIntensity =
    baseCa +
    (reducedMotion ? 0 : speedNorm * 0.0034 + lensStrength * 0.0022);

  // Subtle highlight halation strictly for ultra-bright peaks
  const halationStrength = 0.06 + anamorphicIntensity * 0.14;

  return {
    exposure: computeDynamicExposure(t),
    lensStrength,
    anamorphicIntensity,
    bokehStrength,
    chromaticIntensity,
    halationStrength,
  };
}
