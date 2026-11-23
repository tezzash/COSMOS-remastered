import * as THREE from 'three';
import { GLSL_PLANETARY_ECLIPSE } from './eclipse';

/**
 * Shared GLSL analytical 3D curl-noise helper for GPU fluid turbulence
 * (used in Prologue Big Bang filaments and Chapter IV Yin-Yang fluid crescent).
 */
const GLSL_CURL_NOISE = /* glsl */ `
  vec3 hash33(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yxx) * p.zyx) * 2.0 - 1.0;
  }

  // Smooth trigonometric pseudo-curl field: divergence-free, GPU-fast, zero branching
  vec3 curlField(vec3 p, float t) {
    vec3 q = p * 0.24 + vec3(t * 0.18, -t * 0.14, t * 0.11);
    float s1 = sin(q.y * 2.1 + cos(q.z * 1.7 + t * 0.35));
    float s2 = cos(q.z * 2.3 - sin(q.x * 1.9 - t * 0.28));
    float s3 = sin(q.x * 2.0 + cos(q.y * 1.8 + t * 0.31));
    vec3 primary = vec3(
      cos(q.y * 1.6 + s2) - sin(q.z * 1.5 - s3),
      cos(q.z * 1.6 + s3) - sin(q.x * 1.5 - s1),
      cos(q.x * 1.6 + s1) - sin(q.y * 1.5 - s2)
    );
    vec3 detail = vec3(
      sin(q.z * 3.7 + t * 0.5),
      cos(q.x * 3.5 - t * 0.45),
      sin(q.y * 3.9 + t * 0.4)
    ) * 0.28;
    return primary + detail;
  }
`;

export const STARFIELD_VERTEX_SHADER = /* glsl */ `
  attribute float aScale;
  attribute float aPhase;
  attribute vec3 aColor;

  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uOpacity;
  uniform float uBurst;
  uniform vec3 uParallaxOffset;
  uniform float uVelocityStretch;

  varying vec3 vColor;
  varying float vAlpha;
  varying float vSpike;
  varying float vStretch;

  void main() {
    vColor = aColor;
    vec3 pos = position;

    // Gentle astronomical scintillation without frantic flashing
    float twinkle = 0.78 + 0.22 * sin(uTime * 1.15 + aPhase * 6.2831);
    vAlpha = twinkle * uOpacity;

    // Top magnitude-1 stars carry crisp 4-point Hubble/JWST diffraction spikes
    vSpike = smoothstep(2.9, 4.4, aScale);
    vStretch = clamp(uVelocityStretch, 0.0, 1.0);

    // Optional subtle expansion pull during cosmic transitions
    pos *= (1.0 + uBurst * 0.08);

    // Depth-based parallax shift driven by camera movement
    pos += uParallaxOffset;

    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    float dist = max(12.0, -mvPosition.z);
    float spikePad = 1.0 + vSpike * 0.85;
    gl_PointSize = clamp(aScale * spikePad * uPixelRatio * (108.0 / dist), 1.2, 16.5);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

export const STARFIELD_FRAGMENT_SHADER = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  varying float vSpike;
  varying float vStretch;

  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    // Subtle motion-streak elongation during rapid camera dives
    vec2 stretchedUv = vec2(uv.x, uv.y / (1.0 + vStretch * 0.55));
    float d = length(stretchedUv);
    if (d > 0.5) discard;

    // Crisp pinpoint blackbody astronomical core with tight, restrained halo
    float core = exp(-d * d * 96.0);
    float halo = pow(max(0.0, 1.0 - d * 2.0), 4.4) * 0.20;

    // Delicate 4-point telescope diffraction spikes strictly on top magnitude-1 stars
    float spikeX = exp(-abs(uv.y) * 68.0) * exp(-abs(uv.x) * 7.2);
    float spikeY = exp(-abs(uv.x) * 68.0) * exp(-abs(uv.y) * 7.2);
    float spikes = (spikeX + spikeY) * vSpike * 0.42;

    // Selective HalfFloat HDR peak strictly on bright star cores so high-threshold bloom
    // gives distant stars an ethereal glow without ever lifting the dark space floor
    float hdrCoreBoost = smoothstep(0.55, 0.98, core) * (0.32 + vSpike * 0.62);
    float intensity = core + halo + spikes;
    vec3 col = mix(vColor, vec3(1.0, 0.98, 0.94), clamp(core * 0.72 + spikes * 0.25, 0.0, 1.0));
    vec3 hdrRadiance = col * (intensity * 0.84 + hdrCoreBoost);
    gl_FragColor = vec4(hdrRadiance, clamp(intensity * vAlpha * 0.88, 0.0, 0.96));
  }
`;

/**
 * Ultra-near spatial micro-dust & ice-crystal debris layer (3–18 units from lens).
 * Wraps seamlessly around the moving camera cell so tactile foreground parallax
 * scale cues persist across the entire 620-unit cosmic corridor, rendered as
 * shallow-focus optical bokeh discs catching warm rim light.
 */
export const NEAR_DEBRIS_VERTEX_SHADER = /* glsl */ `
  attribute float aScale;
  attribute float aPhase;
  attribute vec3 aColor;

  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uOpacity;
  uniform vec3 uCameraPos;
  uniform vec3 uParallaxOffset;

  varying vec3 vColor;
  varying float vAlpha;
  varying float vBokehSoftness;
  varying vec3 vWorldPos;

  void main() {
    vColor = aColor;

    // Wrap particles inside a 34x22x36 local volume centered continuously on the camera
    vec3 boxSize = vec3(34.0, 22.0, 36.0);
    vec3 drift = vec3(
      sin(uTime * 0.14 + aPhase * 6.2831) * 0.9,
      cos(uTime * 0.11 + aPhase * 5.1) * 0.65,
      uTime * 0.25
    );
    vec3 shifted = position + drift + uParallaxOffset - uCameraPos;
    vec3 wrapped = mod(shifted + boxSize * 0.5, boxSize) - boxSize * 0.5;
    vec3 worldPos = wrapped + uCameraPos;
    vWorldPos = worldPos;

    vec4 mvPosition = modelViewMatrix * vec4(worldPos, 1.0);
    float dist = -mvPosition.z;

    // Fade smoothly near the lens (avoid popping) and at the back of the near-field box
    float nearFade = smoothstep(2.2, 6.0, dist);
    float farFade = 1.0 - smoothstep(14.0, 22.0, dist);
    float shimmer = 0.68 + 0.32 * sin(uTime * 0.85 + aPhase * 6.2831);
    vAlpha = nearFade * farFade * shimmer * uOpacity;

    // Closer motes become softer, larger shallow-focus optical bokeh discs
    vBokehSoftness = 1.0 - smoothstep(3.0, 15.0, dist);

    float safeDist = max(2.2, dist);
    gl_PointSize = clamp(aScale * uPixelRatio * (46.0 / safeDist), 2.0, 26.0);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

export const NEAR_DEBRIS_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uEarthCenter;
  uniform float uEarthRadius;
  uniform vec3 uSunDir;
  uniform float uEclipseActive;

  varying vec3 vColor;
  varying float vAlpha;
  varying float vBokehSoftness;
  varying vec3 vWorldPos;

  ${GLSL_PLANETARY_ECLIPSE}

  void main() {
    if (vAlpha < 0.005) discard;
    vec2 uv = gl_PointCoord - vec2(0.5);
    // Subtle hexagonal 70mm aperture shape blended with circular bokeh
    vec2 q = abs(uv);
    float hex = max(q.x * 0.866025 + q.y * 0.5, q.y) * 2.0;
    float circ = length(uv) * 2.0;
    float r = mix(circ, hex, 0.35 * vBokehSoftness);
    if (r > 1.0) discard;

    // Authentic restrained optical bokeh disc: subtle glowing interior + fine outer rim
    float disc = smoothstep(1.0, mix(0.18, 0.72, vBokehSoftness), r);
    float bokehRim = exp(-pow((r - 0.78) * 6.5, 2.0)) * 0.22 * vBokehSoftness;
    float crispCore = exp(-circ * circ * 12.0) * (1.0 - vBokehSoftness * 0.75);
    float intensity = disc * 0.34 + bokehRim + crispCore * 0.48;

    vec3 col = vColor;
    float eclipseDim = 1.0;
    if (uEclipseActive > 0.01) {
      vec3 ec = computePlanetaryEclipse(vWorldPos, uEarthCenter, uEarthRadius, uSunDir);
      eclipseDim = mix(1.0, 0.14 + 0.86 * ec.x, uEclipseActive);
      col = mix(col, vec3(0.95, 0.42, 0.20), ec.y * 0.65 * uEclipseActive);
    }

    gl_FragColor = vec4(col * intensity * 0.72 * eclipseDim, clamp(intensity * vAlpha * eclipseDim, 0.0, 0.46));
  }
`;

export function createNebulaCloudTexture(
  seed: number,
  colorA: string,
  colorB: string,
  colorGold: string,
  size = 512,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, size, size);
    let s = Math.floor(seed * 9973) + 1337;
    const rand = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };

    const drawLayer = (count: number, hex: string, minR: number, maxR: number, alpha: number) => {
      const c = new THREE.Color(hex);
      const rgb = `${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}`;
      for (let i = 0; i < count; i++) {
        const angle = rand() * Math.PI * 2;
        const dist = Math.pow(rand(), 0.72) * (size * 0.34);
        const cx = size * 0.5 + Math.cos(angle) * dist;
        const cy = size * 0.5 + Math.sin(angle) * dist * 0.78;
        const r = minR + rand() * (maxR - minR);
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        grad.addColorStop(0, `rgba(${rgb}, ${alpha})`);
        grad.addColorStop(0.45, `rgba(${rgb}, ${alpha * 0.42})`);
        grad.addColorStop(1, `rgba(${rgb}, 0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    ctx.globalCompositeOperation = 'lighter';
    drawLayer(24, colorA, size * 0.14, size * 0.34, 0.24);
    drawLayer(20, colorB, size * 0.1, size * 0.28, 0.2);
    drawLayer(12, colorGold, size * 0.05, size * 0.16, 0.16);

    for (let i = 0; i < 7; i++) {
      const c = new THREE.Color(i % 2 === 0 ? colorGold : colorB);
      const rgb = `${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}`;
      ctx.strokeStyle = `rgba(${rgb}, 0.09)`;
      ctx.lineWidth = 8 + rand() * 14;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(size * (0.2 + rand() * 0.2), size * (0.3 + rand() * 0.4));
      ctx.bezierCurveTo(
        size * (0.35 + rand() * 0.2),
        size * (0.2 + rand() * 0.6),
        size * (0.55 + rand() * 0.2),
        size * (0.2 + rand() * 0.6),
        size * (0.68 + rand() * 0.18),
        size * (0.3 + rand() * 0.4),
      );
      ctx.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export const NEBULA_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * Volumetric self-shadowed nebula shader: samples optical thickness along the
 * light vector to carve deep shadowy dust lanes and warm sunlit backlit rims.
 */
export const NEBULA_FRAGMENT_SHADER = /* glsl */ `
  uniform float uOpacity;
  uniform sampler2D uMap;
  uniform vec2 uLightDir;
  uniform float uTime;

  varying vec2 vUv;

  void main() {
    // Gentle internal drift so nebula gas subtly breathes
    vec2 driftUv = vUv + vec2(sin(uTime * 0.06 + vUv.y * 3.0), cos(uTime * 0.05 + vUv.x * 3.0)) * 0.008;
    vec4 tex = texture2D(uMap, clamp(driftUv, 0.0, 1.0));
    if (tex.a < 0.004) discard;

    // Directional self-shadowing sample toward the celestial light source
    vec2 shadowUv = clamp(driftUv + uLightDir * 0.042, 0.0, 1.0);
    float occluder = texture2D(uMap, shadowUv).a;
    float selfShadow = clamp(1.0 - occluder * 0.68, 0.24, 1.0);

    // Subtle warm sunlit rim scatter without washing out deep-space blackness
    float sunlitEdge = clamp(tex.a - occluder * 0.88, 0.0, 1.0);
    vec3 rimGlow = vec3(0.95, 0.76, 0.48) * sunlitEdge * 0.18;

    vec3 col = tex.rgb * (0.48 + 0.32 * selfShadow) + rimGlow;
    gl_FragColor = vec4(col, tex.a * uOpacity);
  }
`;

/**
 * Crepuscular volumetric god-rays billboard shader for the Sun & Guiding Star.
 */
export const GOD_RAYS_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const GOD_RAYS_FRAGMENT_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uIntensity;
  uniform vec3 uColor;
  varying vec2 vUv;

  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    if (r > 1.0) discard;

    float angle = atan(p.y, p.x);
    float rayA = pow(0.5 + 0.5 * sin(angle * 9.0 + uTime * 0.16), 2.8);
    float rayB = pow(0.5 + 0.5 * cos(angle * 15.0 - uTime * 0.11 + 1.2), 3.4);
    float rayC = pow(0.5 + 0.5 * sin(angle * 5.0 + uTime * 0.07), 2.0);
    float rays = rayA * 0.45 + rayB * 0.35 + rayC * 0.25;

    float radialFalloff = pow(max(0.0, 1.0 - r), 2.8) * smoothstep(0.05, 0.24, r);
    float alpha = rays * radialFalloff * uIntensity;
    gl_FragColor = vec4(uColor * (0.78 + rays * 0.28), clamp(alpha, 0.0, 0.42));
  }
`;

/**
 * Gargantua-inspired Relativistic Accretion Disk & Photon-Ring Shader:
 * Preserves a crisp obsidian event-horizon shadow inside the photon sphere
 * framed by a fine, high-contrast Keplerian golden-amber ring.
 */
export const ACCRETION_DISK_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const ACCRETION_DISK_FRAGMENT_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uOpacity;
  uniform vec3 uInnerColor;
  uniform vec3 uOuterColor;
  varying vec2 vUv;

  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    if (r > 1.0 || r < 0.22) discard;

    float angle = atan(p.y, p.x);

    // Keplerian differential swirl
    float swirl1 = sin(angle * 4.0 - uTime * 1.15 + 14.0 / (r + 0.18));
    float swirl2 = cos(angle * 7.0 - uTime * 1.65 + 22.0 / (r + 0.24));
    float filaments = 0.54 + 0.26 * swirl1 + 0.20 * swirl2;

    // Razor-crisp relativistic photon ring bordering the dark event-horizon shadow
    float photonRing = exp(-pow((r - 0.29) * 34.0, 2.0)) * 0.92;
    float diskBody = smoothstep(0.24, 0.36, r) * pow(max(0.0, 1.0 - r), 2.45);

    // Relativistic Doppler beaming: subtle hot-vs-cool orbital asymmetry
    float doppler = 0.68 + 0.36 * cos(angle + 0.45);
    vec3 baseCol = mix(uInnerColor, uOuterColor, smoothstep(0.29, 0.82, r));
    vec3 dopplerTint = mix(vec3(0.76, 0.62, 0.92), vec3(1.0, 0.94, 0.82), doppler * 0.72);

    float intensity = (diskBody * filaments * 0.68 + photonRing) * doppler;
    vec3 col = baseCol * dopplerTint * (0.76 + photonRing * 0.48);
    gl_FragColor = vec4(col * intensity, clamp(intensity * uOpacity, 0.0, 0.92));
  }
`;

export const BIG_BANG_VERTEX_SHADER = /* glsl */ `
  attribute vec3 aDirection;
  attribute float aSpeed;
  attribute float aSize;
  attribute vec3 aColor;

  uniform float uExpansion;
  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uOpacity;

  varying vec3 vColor;
  varying float vAlpha;

  ${GLSL_CURL_NOISE}

  void main() {
    vColor = aColor;
    // Swirl + radial primordial expansion + GPU 3D curl-noise filament currents
    float angle = uExpansion * 1.35 * (0.4 + aSpeed * 0.6);
    float c = cos(angle);
    float s = sin(angle);
    vec3 dir = aDirection;
    dir.xz = mat2(c, -s, s, c) * dir.xz;

    float radius = pow(uExpansion, 0.82) * (12.0 + aSpeed * 58.0);
    vec3 pos = dir * radius;
    vec3 curl = curlField(pos * 0.14, uTime * 0.65);
    pos += curl * (1.85 * uExpansion * (0.4 + aSpeed * 0.6));

    vAlpha = uOpacity * (0.45 + 0.55 * (1.0 - smoothstep(0.75, 1.0, uExpansion) * 0.45));

    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    float dist = max(6.0, -mvPosition.z);
    gl_PointSize = clamp(aSize * uPixelRatio * (112.0 / dist), 1.2, 14.0);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

export const BIG_BANG_FRAGMENT_SHADER = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    float d = length(uv);
    if (d > 0.5) discard;
    float glow = exp(-d * d * 28.0);
    gl_FragColor = vec4(vColor * glow * 0.92, glow * vAlpha * 0.85);
  }
`;

/**
 * GPU 3D Curl-Noise Fluid Particle Shader for Chapter IV Yin-Yang fluid crescent:
 * thousands of particles swirl in coherent, ink-in-water celestial currents.
 */
export const CURL_FLUID_VERTEX_SHADER = /* glsl */ `
  attribute float aScale;
  attribute float aPhase;
  attribute vec3 aColor;

  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uOpacity;
  uniform float uTurbulence;

  varying vec3 vColor;
  varying float vAlpha;
  varying float vSpike;
  varying float vStretch;

  ${GLSL_CURL_NOISE}

  void main() {
    vColor = aColor;
    vec3 pos = position;

    // Coherent 3D curl-noise flow keeping particles sculpted inside the Yin-Yang crescent
    vec3 flow = curlField(pos * 0.34 + vec3(0.0, aPhase * 1.8, 0.0), uTime * 0.55);
    float radialKeep = smoothstep(14.5, 9.0, length(pos.xy));
    pos += flow * (0.85 * uTurbulence * (0.35 + 0.65 * radialKeep));

    float twinkle = 0.76 + 0.24 * sin(uTime * 1.35 + aPhase * 6.2831);
    vAlpha = twinkle * uOpacity;
    vSpike = smoothstep(3.6, 4.5, aScale) * 0.45;
    vStretch = 0.0;

    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    float dist = max(10.0, -mvPosition.z);
    gl_PointSize = clamp(aScale * uPixelRatio * (108.0 / dist), 1.3, 11.5);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

/**
 * Physically Based Planetary Surface Shader for Chapter I Earth:
 * - Albedo continents & oceans + subtle relief shading
 * - Fresnel specular sun-glint strictly over oceans (uOceanMask)
 * - Soft drifting cloud-deck shadows projected onto the surface
 * - Golden night-side city lights (India / Hyderabad / world) fading smoothly across dawn terminator
 * - Subtle Rayleigh atmospheric veil toward the limb
 */
export const EARTH_SURFACE_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying vec3 vWorldTangent;
  varying vec3 vWorldBitangent;
  varying vec3 vWorldPos;

  void main() {
    vUv = uv;
    mat3 worldMat3 = mat3(modelMatrix);
    vec3 objN = normalize(normal);
    // Exact analytical equirectangular spherical tangent along +longitude (dP/du)
    vec3 rawT = vec3(position.z, 0.0, -position.x);
    vec3 objT = length(rawT) > 0.0001 ? normalize(rawT) : vec3(1.0, 0.0, 0.0);
    vec3 objB = normalize(cross(objN, objT));

    vWorldNormal = normalize(worldMat3 * objN);
    vWorldTangent = normalize(worldMat3 * objT);
    vWorldBitangent = normalize(worldMat3 * objB);

    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

export const EARTH_SURFACE_FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uAlbedoMap;
  uniform sampler2D uOceanMaskMap;
  uniform sampler2D uNightLightsMap;
  uniform sampler2D uCloudMap;
  uniform sampler2D uNormalMap;
  uniform float uNormalScale;
  uniform vec3 uSunDir;
  uniform float uCloudOffset;
  uniform float uOpacity;

  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying vec3 vWorldTangent;
  varying vec3 vWorldBitangent;
  varying vec3 vWorldPos;

  void main() {
    vec3 geomN = normalize(vWorldNormal);
    vec3 T = normalize(vWorldTangent);
    vec3 B = normalize(vWorldBitangent);

    // 4K topographic normal-map perturbation for razor-sharp mountain ridges across the terminator
    vec3 mapN = texture2D(uNormalMap, vUv).xyz * 2.0 - 1.0;
    vec3 N = normalize(T * (mapN.x * uNormalScale) + B * (mapN.y * uNormalScale) + geomN * max(0.25, mapN.z));

    vec3 L = normalize(uSunDir);
    vec3 V = normalize(cameraPosition - vWorldPos);
    vec3 H = normalize(L + V);

    vec3 albedo = texture2D(uAlbedoMap, vUv).rgb;
    float oceanMask = texture2D(uOceanMaskMap, vUv).r;
    vec3 nightLights = texture2D(uNightLightsMap, vUv).rgb;

    // 4K grayscale cloud-deck shadow offset slightly opposite solar direction
    vec2 cloudUv = vec2(fract(vUv.x + uCloudOffset - 0.006), clamp(vUv.y - 0.004, 0.0, 1.0));
    float cloudDensity = texture2D(uCloudMap, cloudUv).r;
    float cloudShadow = 1.0 - smoothstep(0.12, 0.85, cloudDensity) * 0.48;

    // Smooth terminator driven by macro sphere normal; fine relief driven by 4K perturbed normal
    float macroNdotL = dot(geomN, L);
    float microNdotL = dot(N, L);
    float dayFactor = smoothstep(-0.14, 0.24, macroNdotL);
    float twilightBand = exp(-pow((macroNdotL + 0.025) * 5.6, 2.0));
    float nightFactor = smoothstep(0.08, -0.20, macroNdotL);

    // High-contrast sunlit continents & oceans with crisp micro-topography
    float diffuse = max(microNdotL, 0.0) * smoothstep(-0.18, 0.06, macroNdotL);
    vec3 sunTint = mix(vec3(1.0, 0.96, 0.91), vec3(1.0, 0.56, 0.24), twilightBand * 0.72);
    vec3 dayColor = albedo * (0.018 + 1.05 * diffuse) * sunTint * cloudShadow;

    // Sharp Fresnel solar ocean sun-glint strictly on coastline-masked water
    float fresnel = pow(1.0 - max(dot(geomN, V), 0.0), 3.4);
    float spec = pow(max(dot(N, H), 0.0), 86.0) * oceanMask * (0.45 + 0.55 * fresnel) * dayFactor * cloudShadow;
    vec3 glintColor = mix(vec3(1.0, 0.94, 0.82), vec3(1.0, 0.64, 0.30), twilightBand) * spec * 0.92;

    // Deep obsidian night hemisphere + contrast-shaped 4K satellite city networks
    vec3 nightAmbient = albedo * vec3(0.018, 0.032, 0.07) * nightFactor;
    vec3 crispCities = pow(max(nightLights, vec3(0.0)), vec3(1.16));
    vec3 cityGlow = crispCities * vec3(1.08, 0.94, 0.76) * (nightFactor * 1.28 + twilightBand * 0.42);

    // Subtle Rayleigh atmospheric scatter creeping along the orbital limb
    float limb = pow(1.0 - max(dot(geomN, V), 0.0), 4.0);
    vec3 limbScatter = mix(vec3(0.20, 0.50, 0.96), vec3(0.98, 0.58, 0.24), twilightBand * 0.82) * limb * (0.06 + 0.40 * dayFactor);

    vec3 finalCol = dayColor + glintColor + nightAmbient + cityGlow + limbScatter;
    gl_FragColor = vec4(finalCol, uOpacity);
  }
`;

/**
 * 4K Deep-Space Milky Way Celestial Sphere Shader:
 * Crushes background floor to true obsidian while revealing authentic galactic dust lanes
 * and razor-sharp pinpoint deep-field stars with restrained theatrical brightness.
 */
export const MILKY_WAY_SKY_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const MILKY_WAY_SKY_FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uOpacity;
  varying vec2 vUv;

  void main() {
    vec3 raw = texture2D(uMap, vUv).rgb;
    // Contrast-shape to preserve deep obsidian space and sharp galactic dust lanes
    vec3 shaped = pow(max(raw, vec3(0.0)), vec3(1.52));
    // Subtle cinema color grade: cool deep-space indigo with restrained warm galactic core
    vec3 graded = shaped * vec3(0.76, 0.82, 0.98) + vec3(0.14, 0.08, 0.02) * pow(max(raw.r - raw.b, 0.0), 1.4);
    gl_FragColor = vec4(graded * uOpacity, 1.0);
  }
`;

export const ATMOSPHERE_VERTEX_SHADER = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vWorldPos;

  void main() {
    vNormal = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

/**
 * Upgraded Rayleigh + Mie Planetary Atmosphere Shader:
 * Deep Rayleigh sapphire daytime limb + forward-scattered Mie golden dawn halo.
 */
export const ATMOSPHERE_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uSunDir;
  uniform vec3 uDayColor;
  uniform vec3 uSunriseColor;
  uniform float uIntensity;

  varying vec3 vNormal;
  varying vec3 vWorldPos;

  void main() {
    vec3 N = normalize(vNormal);
    vec3 L = normalize(uSunDir);
    vec3 V = normalize(cameraPosition - vWorldPos);

    // On BackSide sphere, -dot(V, N) is 0 at the outer silhouette edge and increases inward
    // toward the planetary limb, yielding a smooth exponential atmosphere fading cleanly to space.
    float backFacing = clamp(-dot(V, N), 0.0, 1.0);
    float outerFade = pow(backFacing, 2.6) * smoothstep(0.0, 0.28, backFacing);

    float sunDot = dot(N, L);
    float dayFactor = smoothstep(-0.32, 0.52, sunDot);
    float terminator = exp(-pow((sunDot + 0.04) * 3.8, 2.0));

    // Mie forward-scattering golden glow along the sunlit dawn limb
    float cosTheta = max(dot(-V, L), 0.0);
    float miePhase = pow(cosTheta, 5.0) * 0.55;

    vec3 rayleigh = mix(uDayColor * 0.25, uDayColor, dayFactor);
    vec3 col = mix(rayleigh, uSunriseColor, clamp(terminator * 0.85 + miePhase * 0.45, 0.0, 1.0));
    col += uSunriseColor * miePhase * outerFade * 0.65;

    float alpha = outerFade * (0.22 + 0.78 * max(dayFactor, terminator) + miePhase * 0.25) * uIntensity;
    gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.92));
  }
`;

export const SUN_CORONA_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const SUN_CORONA_FRAGMENT_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uIntensity;
  varying vec2 vUv;

  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    if (r > 1.0) discard;

    float angle = atan(p.y, p.x);
    float rays = 0.86 + 0.14 * sin(angle * 7.0 + uTime * 0.4) * cos(angle * 11.0 - uTime * 0.3);
    float core = exp(-r * r * 20.0);
    float corona = pow(max(0.0, 1.0 - r), 3.0) * rays * 0.9;

    vec3 innerCol = vec3(1.0, 0.97, 0.88);
    vec3 outerCol = vec3(0.98, 0.64, 0.24);
    vec3 col = mix(outerCol, innerCol, clamp(core * 1.45, 0.0, 1.0));
    float alpha = clamp((core + corona) * uIntensity, 0.0, 1.0);
    gl_FragColor = vec4(col * (1.1 + core * 0.85), alpha);
  }
`;

export const FLUID_RIBBON_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  uniform float uTime;

  void main() {
    vUv = uv;
    vec3 pos = position;
    pos += normal * (sin(uv.x * 16.0 + uTime * 1.4) * 0.16 + cos(uv.y * 10.0 - uTime * 0.9) * 0.08);
    vNormal = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(pos, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

export const FLUID_RIBBON_FRAGMENT_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uOpacity;
  uniform vec3 uPrimaryColor;
  uniform vec3 uSecondaryColor;

  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vWorldPos;

  void main() {
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float fresnel = pow(1.0 - abs(dot(viewDir, vNormal)), 2.0);
    float stream = 0.5 + 0.5 * sin(vUv.x * 22.0 - uTime * 1.8 + sin(vUv.y * 8.0));
    vec3 col = mix(uPrimaryColor, uSecondaryColor, stream * 0.65 + fresnel * 0.45);
    float alpha = (0.24 + 0.46 * fresnel + 0.14 * stream) * uOpacity;
    gl_FragColor = vec4(col * 0.82, alpha);
  }
`;

/**
 * Chapter III Curved Star-Bridge Energy Filament Shader:
 * Sends delicate luminous traveling pulse packets along each persistent Bézier bridge.
 */
export const FILAMENT_VERTEX_SHADER = /* glsl */ `
  attribute float aProgress;
  attribute float aPhase;
  attribute vec3 aColor;

  varying float vProgress;
  varying float vPhase;
  varying vec3 vColor;

  void main() {
    vProgress = aProgress;
    vPhase = aPhase;
    vColor = aColor;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const FILAMENT_FRAGMENT_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uOpacity;

  varying float vProgress;
  varying float vPhase;
  varying vec3 vColor;

  void main() {
    float packetPos = fract(uTime * 0.42 + vPhase);
    float dist = abs(vProgress - packetPos);
    dist = min(dist, 1.0 - dist);
    float pulse = exp(-dist * dist * 65.0);

    float wave = 0.68 + 0.32 * sin(vProgress * 9.42 - uTime * 1.8 + vPhase * 6.2831);

    vec3 col = mix(vColor, vec3(1.0, 0.95, 0.82), pulse * 0.72);
    float alpha = (0.26 * wave + 0.54 * pulse) * uOpacity;
    gl_FragColor = vec4(col * (0.82 + pulse * 0.68), clamp(alpha, 0.0, 0.9));
  }
`;

export function createSoftGlowTexture(
  innerHex = '#fff6df',
  midHex = '#e6bd70',
  outerHex = 'rgba(0,0,0,0)',
  size = 128,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const half = size / 2;
    const grad = ctx.createRadialGradient(half, half, 0, half, half, half);
    grad.addColorStop(0, innerHex);
    grad.addColorStop(0.22, midHex);
    grad.addColorStop(0.55, 'rgba(218, 174, 96, 0.16)');
    grad.addColorStop(1, outerHex);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Untinted radial falloff for sprites that take their colour from the material. */
export function createNeutralGlowTexture(size = 128): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const half = size / 2;
    const grad = ctx.createRadialGradient(half, half, 0, half, half, half);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.18, 'rgba(255,255,255,0.55)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.12)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Crisp 4-point telescope diffraction star sprite for sharp constellation stars
 * and leading connection sparks.
 */
export function createStarDiffractionTexture(size = 192): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const half = size / 2;
    ctx.clearRect(0, 0, size, size);

    // Tight soft atmospheric halo
    const halo = ctx.createRadialGradient(half, half, 0, half, half, half * 0.72);
    halo.addColorStop(0, 'rgba(255, 252, 242, 0.98)');
    halo.addColorStop(0.11, 'rgba(255, 234, 188, 0.72)');
    halo.addColorStop(0.32, 'rgba(220, 184, 118, 0.16)');
    halo.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, size, size);

    // Fine 4-point Hubble-style diffraction needles
    ctx.globalCompositeOperation = 'lighter';
    const drawSpike = (horiz: boolean) => {
      const grad = horiz
        ? ctx.createLinearGradient(0, half, size, half)
        : ctx.createLinearGradient(half, 0, half, size);
      grad.addColorStop(0, 'rgba(255, 245, 220, 0)');
      grad.addColorStop(0.35, 'rgba(255, 238, 200, 0.18)');
      grad.addColorStop(0.5, 'rgba(255, 255, 255, 0.92)');
      grad.addColorStop(0.65, 'rgba(255, 238, 200, 0.18)');
      grad.addColorStop(1, 'rgba(255, 245, 220, 0)');
      ctx.fillStyle = grad;
      if (horiz) {
        ctx.fillRect(0, half - 1.35, size, 2.7);
      } else {
        ctx.fillRect(half - 1.35, 0, 2.7, size);
      }
    };
    drawSpike(true);
    drawSpike(false);

    // Razor-sharp white-hot pinpoint core
    const core = ctx.createRadialGradient(half, half, 0, half, half, half * 0.14);
    core.addColorStop(0, 'rgba(255, 255, 255, 1.0)');
    core.addColorStop(0.55, 'rgba(255, 248, 230, 0.75)');
    core.addColorStop(1, 'rgba(255, 240, 200, 0)');
    ctx.fillStyle = core;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * True General-Relativistic Geodesic Raymarched Singularity & Volumetric Accretion Disk:
 * Integrates Schwarzschild/Kerr photon trajectories inside a bounding sphere, bending
 * light over and under the obsidian event horizon to produce authentic upper/lower
 * Einstein lensing arches, Doppler-beamed Keplerian plasma, and warped 4K Milky Way starlight.
 */
export const GEODESIC_SINGULARITY_VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorldPos;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

export const GEODESIC_SINGULARITY_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uCenter;
  uniform float uHorizonRadius;
  uniform float uDiskOuterRadius;
  uniform float uTime;
  uniform float uOpacity;
  uniform float uSpin;
  uniform vec3 uInnerColor;
  uniform vec3 uOuterColor;
  uniform sampler2D uMilkyWayMap;
  uniform float uHasMilkyWay;

  varying vec3 vWorldPos;

  vec3 sampleEquirect(vec3 dir) {
    vec3 d = normalize(dir);
    float u = atan(d.z, d.x) / 6.2831853 + 0.5;
    float v = asin(clamp(d.y, -1.0, 1.0)) / 3.14159265 + 0.5;
    vec3 raw = texture2D(uMilkyWayMap, vec2(u, v)).rgb;
    vec3 shaped = pow(max(raw, vec3(0.0)), vec3(1.55));
    return shaped * vec3(0.76, 0.84, 1.0) * 0.55;
  }

  // Tilted accretion plane normal so we see iconic Gargantua upper & lower lensed arches
  // plus sweeping horizontal equatorial plasma wings
  vec3 toDiskSpace(vec3 p) {
    float c1 = 0.978;
    float s1 = 0.208; // ~12 deg inclination
    vec3 q = vec3(p.x, p.y * c1 - p.z * s1, p.y * s1 + p.z * c1);
    float c2 = 0.991;
    float s2 = 0.131; // subtle cinematic roll
    return vec3(q.x * c2 - q.y * s2, q.x * s2 + q.y * c2, q.z);
  }

  float hash21(vec2 p) {
    return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
  }

  void main() {
    if (uOpacity < 0.005) discard;

    vec3 ro = cameraPosition - uCenter;
    vec3 rd = normalize(vWorldPos - cameraPosition);

    // Outer integration sphere generously larger than disk so wings never clip
    float boundR = uDiskOuterRadius * 1.42;
    float b = dot(ro, rd);
    float c = dot(ro, ro) - boundR * boundR;
    float disc = b * b - c;
    if (disc < 0.0) discard;
    float sqrtDisc = sqrt(disc);
    float tEnter = max(0.0, -b - sqrtDisc);
    float tExit = -b + sqrtDisc;
    if (tExit <= 0.0) discard;

    // Tiny IGN initial step jitter prevents any radial quantization artifacts
    float jitter = hash21(gl_FragCoord.xy);
    vec3 pos = ro + rd * (tEnter + jitter * uHorizonRadius * 0.06);
    vec3 vel = rd;
    float rs = uHorizonRadius;
    float rsSq = rs * rs;

    // Conserved Schwarzschild specific angular momentum squared h^2 = |r x v|^2
    vec3 hVec = cross(pos, vel);
    float h2 = dot(hVec, hVec);

    vec3 accum = vec3(0.0);
    float alphaAccum = 0.0;
    bool captured = false;
    float minR = 1e5;

    const int STEPS = 52;
    for (int i = 0; i < STEPS; i++) {
      float r2 = dot(pos, pos);
      float r = sqrt(r2);
      minR = min(minR, r);

      if (r < rs * 1.02) {
        captured = true;
        break;
      }
      if (r > boundR * 1.05 && dot(pos, vel) > 0.0) {
        break;
      }

      // Smooth adaptive step: ultra-fine near photon sphere (1.5 Rs), efficient outside
      float dt = clamp(r * 0.115, rs * 0.10, uDiskOuterRadius * 0.11);

      vec3 prevPos = pos;
      float invR5 = 1.0 / max(r2 * r2 * r, 0.0001);
      vec3 accel = -1.5 * rs * h2 * pos * invR5;
      // Subtle Kerr spin frame-dragging torque
      accel += cross(vec3(0.0, uSpin, 0.0), vel) * (rsSq / max(r2 * r, 0.01)) * 0.15;

      vel = normalize(vel + accel * dt);
      pos += vel * dt;

      // Exact equatorial plane-crossing intersection (zero discrete stepping rings!)
      vec3 p0 = toDiskSpace(prevPos);
      vec3 p1 = toDiskSpace(pos);
      if (p0.y * p1.y <= 0.0) {
        float frac = clamp(abs(p0.y) / max(abs(p0.y - p1.y), 0.0001), 0.0, 1.0);
        vec3 hit = mix(p0, p1, frac);
        float diskR = length(hit.xz);

        float innerEdge = rs * 1.78;
        if (diskR > innerEdge && diskR < uDiskOuterRadius) {
          float radNorm = (diskR - innerEdge) / max(0.001, uDiskOuterRadius - innerEdge);
          float angle = atan(hit.z, hit.x);

          // Continuous multi-octave Keplerian plasma filaments (smooth, non-banded)
          float logR = log(max(diskR / innerEdge, 1.001));
          float spiral1 = sin(angle * 2.0 - uTime * 1.15 + logR * 7.8);
          float spiral2 = cos(angle * 5.0 - uTime * 1.85 + logR * 13.5);
          float spiral3 = sin(angle * 8.0 - uTime * 2.45 + logR * 21.0);
          float fineStreaks = 0.56 + 0.24 * spiral1 + 0.14 * spiral2 + 0.08 * spiral3;
          float radialFilaments = 0.72 + 0.28 * sin(logR * 18.0 - uTime * 0.75);
          float density = clamp(fineStreaks * radialFilaments, 0.12, 1.25);

          // Crisp ISCO inner brightening & silky wide outer feathering
          float innerGlow = exp(-radNorm * 7.5) * 0.85;
          float radialEnv = smoothstep(0.0, 0.07, radNorm) * pow(max(0.0, 1.0 - radNorm), 1.75);

          // Relativistic Doppler beaming (left approaching limb white-gold, receding ember)
          vec3 tangent = normalize(vec3(-hit.z, 0.0, hit.x));
          float doppler = clamp(0.72 + 0.52 * dot(tangent, -vel), 0.26, 1.55);

          vec3 baseCol = mix(uInnerColor, uOuterColor, smoothstep(0.04, 0.72, radNorm));
          vec3 dopplerCol = mix(vec3(0.84, 0.40, 0.20), vec3(1.0, 0.97, 0.90), clamp(doppler * 0.74, 0.0, 1.0));
          float sampleAlpha = clamp((density * radialEnv + innerGlow * 0.35) * 0.92, 0.0, 0.96);

          accum += baseCol * dopplerCol * doppler * sampleAlpha * (1.0 - alphaAccum) * 1.38;
          alphaAccum = clamp(alphaAccum + sampleAlpha * 0.78, 0.0, 0.98);
        }
      }
    }

    // Razor-thin relativistic photon sphere ring at r = 1.5 Rs
    float photonRing = exp(-pow((minR - rs * 1.50) / (rs * 0.075), 2.0)) * 0.88;
    accum += mix(uInnerColor, vec3(1.0, 0.95, 0.82), 0.58) * photonRing * (1.0 - alphaAccum * 0.40);

    // Bent 4K Milky Way Einstein-ring refraction for escaping rays near the black hole
    float deflection = 1.0 - clamp(dot(rd, vel), -1.0, 1.0);
    float lensingHaloMask = smoothstep(0.012, 0.18, deflection);
    vec3 finalCol = accum;
    float finalAlpha = clamp(alphaAccum + photonRing * 0.75, 0.0, 1.0);

    if (captured) {
      // Pure obsidian event horizon swallowing background stars behind it
      finalCol = accum;
      finalAlpha = 1.0;
    } else if (uHasMilkyWay > 0.5 && lensingHaloMask > 0.01) {
      vec3 bentSky = sampleEquirect(vel);
      finalCol += bentSky * (1.0 - alphaAccum) * lensingHaloMask * 1.05;
      finalAlpha = max(finalAlpha, lensingHaloMask * 0.65);
    }

    // Ultra-soft outer sphere feathering well beyond the accretion disk radius
    float radialEdge = length(cross(ro, rd)) / boundR;
    float outerFade = 1.0 - smoothstep(0.78, 0.99, radialEdge);

    gl_FragColor = vec4(finalCol * uOpacity * outerFade, clamp(finalAlpha * uOpacity * outerFade, 0.0, 1.0));
  }
`;

/**
 * Volumetric 3D Raymarched Earth Cloud Deck & Twilight Henyey-Greenstein Scattering:
 * Traces 8 IGN-dithered parallax-altitude slices through the 4K cloud field, computes
 * directional optical self-shadowing along the solar vector, and applies physical
 * Henyey-Greenstein forward scattering so clouds along the Hyderabad dawn limb glow deep burnt-orange.
 */
export const VOLUMETRIC_CLOUDS_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;
  varying vec3 vWorldTangent;
  varying vec3 vWorldBitangent;

  void main() {
    vUv = uv;
    mat3 worldMat3 = mat3(modelMatrix);
    vec3 objN = normalize(normal);
    vec3 rawT = vec3(position.z, 0.0, -position.x);
    vec3 objT = length(rawT) > 0.0001 ? normalize(rawT) : vec3(1.0, 0.0, 0.0);
    vec3 objB = normalize(cross(objN, objT));

    vWorldNormal = normalize(worldMat3 * objN);
    vWorldTangent = normalize(worldMat3 * objT);
    vWorldBitangent = normalize(worldMat3 * objB);

    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

export const VOLUMETRIC_CLOUDS_FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uCloudMap;
  uniform vec3 uSunDir;
  uniform float uCloudOffset;
  uniform float uOpacity;

  varying vec2 vUv;
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;
  varying vec3 vWorldTangent;
  varying vec3 vWorldBitangent;

  // Physical Henyey-Greenstein forward scattering phase function (g = 0.62 for cumulus droplets)
  float henyeyGreenstein(float cosTheta, float g) {
    float g2 = g * g;
    float denom = max(0.05, 1.0 + g2 - 2.0 * g * cosTheta);
    return (1.0 - g2) / (4.0 * 3.14159265 * pow(denom, 1.5));
  }

  // Interleaved Gradient Noise to eliminate slice stair-stepping on volumetric cumulus
  float ignNoise(vec2 p) {
    return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
  }

  void main() {
    vec3 N = normalize(vWorldNormal);
    vec3 T = normalize(vWorldTangent);
    vec3 B = normalize(vWorldBitangent);
    vec3 L = normalize(uSunDir);
    vec3 V = normalize(cameraPosition - vWorldPos);

    // Clamp grazing tangent projection so cumulus layers stay cohesive and never detach at the limb
    float ndotv = max(0.42, dot(N, V));
    vec2 viewTan = clamp(vec2(dot(V, T), dot(V, B)) / ndotv, vec2(-1.65), vec2(1.65));
    vec2 sunTan = vec2(dot(L, T), dot(L, B));

    float jitter = ignNoise(gl_FragCoord.xy);
    float totalDensity = 0.0;
    float lightEnergy = 0.0;
    float transmittance = 1.0;

    // 8 IGN-dithered volumetric cumulus altitude slices
    for (int i = 0; i < 8; i++) {
      float h = (float(i) + jitter) / 8.0; // 0 = cloud top, 1 = cloud base
      vec2 parallaxUv = vec2(
        fract(vUv.x + uCloudOffset - viewTan.x * h * 0.0024),
        clamp(vUv.y - viewTan.y * h * 0.0017, 0.002, 0.998)
      );
      float raw = texture2D(uCloudMap, parallaxUv).r;
      // Sculpt crisp cumulus puff tops (denser near base, soft wispy crowns at altitude)
      float sliceDens = smoothstep(0.14 + (1.0 - h) * 0.16, 0.88, raw) * (0.18 + 0.09 * (1.0 - h));

      if (sliceDens > 0.004) {
        // Directional self-shadowing sample stepped toward the Sun
        vec2 shadowUv = vec2(
          fract(parallaxUv.x + sunTan.x * 0.0052),
          clamp(parallaxUv.y + sunTan.y * 0.0036, 0.002, 0.998)
        );
        float occluder = texture2D(uCloudMap, shadowUv).r;
        float selfShadow = exp(-occluder * (1.42 + h * 1.05));

        lightEnergy += sliceDens * transmittance * (0.36 + 0.64 * selfShadow);
        transmittance *= exp(-sliceDens * 1.38);
        totalDensity += sliceDens;
      }
    }

    float alpha = clamp((1.0 - transmittance) * 1.15, 0.0, 0.92);
    if (alpha < 0.008) discard;

    float ndotl = dot(N, L);
    float dayFactor = smoothstep(-0.18, 0.30, ndotl);
    float twilight = exp(-pow((ndotl + 0.03) * 5.2, 2.0));
    float nightFactor = smoothstep(0.06, -0.22, ndotl);

    // Henyey-Greenstein forward scattering along dawn terminator (burnt-orange / amber glow)
    float cosTheta = dot(-V, L);
    float hgPhase = clamp(henyeyGreenstein(cosTheta, 0.62) * 0.95, 0.0, 1.35);

    vec3 dayCloud = vec3(0.95, 0.97, 1.0) * (0.24 + 0.86 * lightEnergy / max(0.08, totalDensity));
    vec3 twilightScatter = vec3(1.0, 0.44, 0.14) * (0.55 + hgPhase * 0.85) * twilight;
    vec3 nightCloud = vec3(0.025, 0.042, 0.085) * nightFactor;

    vec3 col = dayCloud * dayFactor + twilightScatter + nightCloud;
    gl_FragColor = vec4(col, alpha * uOpacity * (0.24 + 0.76 * max(dayFactor, twilight)));
  }
`;

/**
 * 4K Moon Shader with Dynamic Analytical Earth Eclipse Shadow (Umbra, Copper Penumbra, Earthshine).
 */
export const MOON_ECLIPSE_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;

  void main() {
    vUv = uv;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

export const MOON_ECLIPSE_FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uSunDir;
  uniform vec3 uEarthCenter;
  uniform float uEarthRadius;
  uniform float uOpacity;

  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;

  ${GLSL_PLANETARY_ECLIPSE}

  void main() {
    vec3 N = normalize(vWorldNormal);
    vec3 L = normalize(uSunDir);
    vec3 V = normalize(cameraPosition - vWorldPos);

    vec3 albedo = texture2D(uMap, vUv).rgb;
    // Subtle micro-crater relief derivative from 4K lunar luminance
    float eps = 0.0008;
    float hC = dot(albedo, vec3(0.333));
    float hX = dot(texture2D(uMap, vUv + vec2(eps, 0.0)).rgb, vec3(0.333));
    float hY = dot(texture2D(uMap, vUv + vec2(0.0, eps)).rgb, vec3(0.333));
    vec3 perturbedN = normalize(N + vec3((hC - hX) * 2.4, (hC - hY) * 2.4, 0.0));

    // Oren-Nayar-like dusty regolith diffuse
    float ndotl = max(dot(perturbedN, L), 0.0);
    float diffuse = pow(ndotl, 0.88);

    // Analytical Earth umbra / copper penumbra / sapphire Earthshine
    vec3 ec = computePlanetaryEclipse(vWorldPos, uEarthCenter, uEarthRadius, uSunDir);
    float sunVis = ec.x;
    float copperRim = ec.y;
    float earthshineAmt = ec.z;

    // Earthshine illuminates the hemisphere facing Earth with cool ocean-reflected blue light
    vec3 toEarth = normalize(uEarthCenter - vWorldPos);
    float earthFacing = max(dot(N, toEarth), 0.0);
    vec3 earthshineCol = albedo * vec3(0.10, 0.18, 0.34) * (0.35 + 0.65 * earthFacing) * (0.28 + 0.72 * earthshineAmt);

    vec3 sunlit = albedo * vec3(1.0, 0.98, 0.94) * diffuse * sunVis * 1.08;
    vec3 copperEclipse = albedo * vec3(0.88, 0.30, 0.10) * diffuse * copperRim * 0.68;

    // Subtle grazing horizon rim
    float rim = pow(1.0 - max(dot(N, V), 0.0), 4.0) * max(ndotl, 0.15) * 0.12;
    vec3 col = sunlit + copperEclipse + earthshineCol + vec3(0.45, 0.55, 0.75) * rim;
    gl_FragColor = vec4(col, uOpacity);
  }
`;

/**
 * Celestial Astrolabe Ring Shader with Brushed-Metal Specular + Dynamic Earth Eclipse Shadow Cone:
 * Rings cast smoothly into Earth's dark night cone with a warm copper penumbra rim!
 */
export const ASTROLABE_ECLIPSE_VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;

  void main() {
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

export const ASTROLABE_ECLIPSE_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uSunDir;
  uniform vec3 uEarthCenter;
  uniform float uEarthRadius;
  uniform float uOpacity;

  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;

  ${GLSL_PLANETARY_ECLIPSE}

  void main() {
    vec3 N = normalize(vWorldNormal);
    vec3 L = normalize(uSunDir);
    vec3 V = normalize(cameraPosition - vWorldPos);
    vec3 H = normalize(L + V);

    float ndotl = 0.25 + 0.75 * max(dot(N, L), 0.0);
    float spec = pow(max(dot(N, H), 0.0), 42.0) * 0.85;
    float fresnel = pow(1.0 - abs(dot(N, V)), 2.5) * 0.35;

    vec3 ec = computePlanetaryEclipse(vWorldPos, uEarthCenter, uEarthRadius, uSunDir);
    float sunVis = ec.x;
    float copperRim = ec.y;
    float earthshine = ec.z;

    vec3 lit = uColor * (ndotl + fresnel) + vec3(1.0, 0.95, 0.85) * spec;
    vec3 umbraCol = uColor * vec3(0.08, 0.13, 0.24) * (0.45 + 0.55 * earthshine);
    vec3 copperEdge = vec3(0.96, 0.42, 0.16) * copperRim * 0.65;

    vec3 col = mix(umbraCol, lit, sunVis) + copperEdge;
    float alpha = uOpacity * (0.28 + 0.72 * sunVis + copperRim * 0.2);
    gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.95));
  }
`;

/**
 * Chapter IV Twin Binary Star Photosphere Shader:
 * Procedural 3D spherical boiling plasma granulation, differential convective swirls,
 * physical astrophysical limb darkening, and incandescent Fresnel coronal rim.
 */
export const BINARY_STAR_VERTEX_SHADER = /* glsl */ `
  varying vec3 vObjNormal;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;

  void main() {
    vObjNormal = normalize(position);
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

export const BINARY_STAR_FRAGMENT_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uOpacity;
  uniform vec3 uCoreColor;
  uniform vec3 uMidColor;
  uniform vec3 uRimColor;
  uniform float uSeed;

  varying vec3 vObjNormal;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;

  float hash31(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  float noise3(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash31(i + vec3(0, 0, 0));
    float n100 = hash31(i + vec3(1, 0, 0));
    float n010 = hash31(i + vec3(0, 1, 0));
    float n110 = hash31(i + vec3(1, 1, 0));
    float n001 = hash31(i + vec3(0, 0, 1));
    float n101 = hash31(i + vec3(1, 0, 1));
    float n011 = hash31(i + vec3(0, 1, 1));
    float n111 = hash31(i + vec3(1, 1, 1));
    float nx00 = mix(n000, n100, f.x);
    float nx10 = mix(n010, n110, f.x);
    float nx01 = mix(n001, n101, f.x);
    float nx11 = mix(n011, n111, f.x);
    return mix(mix(nx00, nx10, f.y), mix(nx01, nx11, f.y), f.z);
  }

  float fbm3(vec3 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
      v += a * noise3(p);
      p = p * 2.04 + vec3(1.7, -1.2, 0.9);
      a *= 0.5;
    }
    return v;
  }

  void main() {
    if (uOpacity < 0.005) discard;

    vec3 N = normalize(vWorldNormal);
    vec3 V = normalize(cameraPosition - vWorldPos);
    float ndotv = max(0.0, dot(N, V));

    // Domain-warped convective plasma granules rotating across the photosphere
    vec3 p = normalize(vObjNormal) * 3.1 + vec3(uSeed, uTime * 0.14, -uTime * 0.11);
    float warp = fbm3(p * 1.15);
    float cells = fbm3(p * 2.1 + vec3(warp * 1.45, -warp * 1.1, uTime * 0.18));
    float fineVeins = smoothstep(0.46, 0.82, fbm3(p * 4.4 - vec3(uTime * 0.25, warp, 0.0)));

    // Astrophysical limb darkening + crisp Fresnel coronal edge
    float limbDark = pow(ndotv, 0.42);
    float fresnel = pow(1.0 - ndotv, 2.8);

    float heat = clamp(cells * 0.85 + fineVeins * 0.42, 0.0, 1.0);
    vec3 surf = mix(uMidColor * 0.52, uMidColor * 1.12, smoothstep(0.18, 0.68, heat));
    surf = mix(surf, uCoreColor * 1.25, smoothstep(0.62, 0.96, heat) * (0.45 + 0.55 * limbDark));
    surf *= (0.48 + 0.62 * limbDark);

    // Incandescent coronal atmosphere at the star limb
    vec3 corona = uRimColor * fresnel * (1.25 + 0.35 * sin(uTime * 1.4 + uSeed));
    vec3 col = surf + corona;

    gl_FragColor = vec4(col, uOpacity);
  }
`;

/**
 * Roche-Lobe Gravitational Tidal Plasma Bridge Shader:
 * Streams luminous plasma continuously between the Golden Sovereign Star and the
 * Sapphire-Violet Dreamer Star across the Lagrange L1 equilibrium bridge.
 */
export const TIDAL_BRIDGE_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewDir;

  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vNormal = normalize(mat3(modelMatrix) * normal);
    vViewDir = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

export const TIDAL_BRIDGE_FRAGMENT_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uOpacity;
  uniform float uFlowDir;
  uniform vec3 uGoldColor;
  uniform vec3 uVioletColor;

  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewDir;

  void main() {
    if (uOpacity < 0.004) discard;

    // Seamless closed-loop angular coordinate (theta = 0..2pi around the figure-eight ∞)
    // theta = 0: Golden Star lobe (+1), theta = pi/2 & 3pi/2: Lagrange L1 saddle (0), theta = pi: Violet Star lobe (-1)
    float theta = vUv.x * 6.2831853;
    float lobeAxis = cos(theta); // +1 gold lobe -> 0 at L1 -> -1 violet lobe

    // Cylindrical edge softness (luminous volumetric plasma core, gossamer outer sheath)
    float edgeSoft = pow(abs(dot(normalize(vNormal), normalize(vViewDir))), 1.3);

    // Periodic integer-frequency plasma filaments so u=0 and u=1 join with ZERO seam!
    float flowA = theta * 4.0 - uTime * 2.2 * uFlowDir;
    float flowB = theta * 7.0 - uTime * 3.1 * uFlowDir;
    float strandA = 0.5 + 0.5 * sin(flowA + sin(vUv.y * 12.56637) * 1.6);
    float strandB = 0.5 + 0.5 * cos(flowB - vUv.y * 6.2831853);
    float filament = pow(clamp(strandA * 0.65 + strandB * 0.45, 0.0, 1.0), 1.45);

    // Smooth harmonic color grading across the figure-eight: solar gold <-> incandescent pearl L1 <-> sapphire-violet
    float sideMix = smoothstep(-0.85, 0.85, lobeAxis);
    float l1Glow = exp(-pow(lobeAxis * 3.6, 2.0));
    vec3 baseCol = mix(uVioletColor, uGoldColor, sideMix);
    baseCol = mix(baseCol, vec3(0.98, 0.96, 1.0), l1Glow * 0.55);

    float intensity = (0.24 + 0.76 * filament + l1Glow * 0.45) * (0.22 + 0.78 * edgeSoft);
    gl_FragColor = vec4(baseCol * intensity * 1.32, clamp(intensity * uOpacity, 0.0, 0.90));
  }
`;

/**
 * Relativistic Gravitational-Wave Harmonic Ripple Disk Shader:
 * Renders delicate twin-arm logarithmic spacetime ripples radiating outward from the
 * orbiting binary stars — warm amber-gold along Star I's wake and cool indigo-violet
 * along Star II's wake, melting seamlessly into obsidian space.
 */
export const GRAV_WAVE_DISK_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const GRAV_WAVE_DISK_FRAGMENT_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uOpacity;
  uniform float uConverge;

  varying vec2 vUv;

  void main() {
    if (uOpacity < 0.004) discard;

    vec2 p = (vUv - 0.5) * 2.0;
    float r = length(p);
    if (r > 1.0 || r < 0.04) discard;

    float angle = atan(p.y, p.x);

    // Classic quadrupole binary gravitational-wave double spiral (m = 2 harmonic)
    float spiralPhase = 2.0 * angle - r * 22.0 + uTime * 1.45;
    float waveCrest = pow(0.5 + 0.5 * cos(spiralPhase), 3.6);
    float fineHarmonic = pow(0.5 + 0.5 * cos(2.0 * angle - r * 44.0 + uTime * 2.1), 5.0) * 0.45;

    // Split polarity so the twin spiral arms subtly echo gold & sapphire-violet
    float armSplit = 0.5 + 0.5 * sin(angle - r * 11.0 + uTime * 0.725);
    vec3 goldWave = vec3(0.92, 0.72, 0.36);
    vec3 violetWave = vec3(0.42, 0.52, 0.96);
    vec3 col = mix(violetWave, goldWave, armSplit);

    // Inner barycenter clearance + silky exponential outer falloff (zero hard disk rim!)
    float radialEnv = smoothstep(0.08, 0.24, r) * pow(max(0.0, 1.0 - r), 2.15);
    float energy = (waveCrest * 0.65 + fineHarmonic) * radialEnv * (0.28 + 0.72 * uConverge);

    // Delicate orbital resonance rings at golden ratio intervals
    float resRing = (exp(-pow((r - 0.36) * 42.0, 2.0)) + exp(-pow((r - 0.62) * 48.0, 2.0))) * 0.16 * radialEnv;

    vec3 finalCol = col * (energy * 0.52 + resRing);
    float alpha = clamp((energy * 0.58 + resRing) * uOpacity, 0.0, 0.72);
    gl_FragColor = vec4(finalCol, alpha);
  }
`;


