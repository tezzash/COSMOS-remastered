import * as THREE from 'three';
import { getChapterWeight, smoothstep } from '../../data/chapters';
import { createNeutralGlowTexture, createStarDiffractionTexture } from '../shaders';

/**
 * Chapter IV: Two Halves of a Strange Equilibrium (centered at 0, 0, -340).
 *
 * Two star clusters in a mutual orbit whose tidal stretching draws them into a taijitu:
 * - An old, evenly packed gold cluster (cool K/G stars, smooth core) — "precise, structured".
 * - A young, clumpy blue cluster (hot O/B/A stars, H II and reflection gas) — "unpredictable".
 * Each cluster is a comma-shaped tidal teardrop whose dense core hosts one star of the
 * opposite population: a blue straggler in the old cluster, a red supergiant in the young one.
 * A thin star-poor lane traces the S-shaped boundary where the two potentials balance.
 */

const R = 10;
const GOLD_HEAD = new THREE.Vector2(0, R / 2);
const BLUE_HEAD = new THREE.Vector2(0, -R / 2);
const GOLD_START = new THREE.Vector2(13.5, 4.5);
const BLUE_START = new THREE.Vector2(-13.5, -4.5);

const CLUSTER_VERTEX_SHADER = /* glsl */ `
  attribute vec3 aStart;
  attribute vec3 aColor;
  attribute float aSize;
  attribute vec3 aSeed; // x: formation delay, y: twinkle phase, z: side (0 gold, 1 blue)
  uniform float uForm;
  uniform float uTime;
  uniform float uGoldVis;
  uniform float uBlueVis;
  uniform float uPixelRatio;
  uniform float uSizeScale;
  uniform float uTwinkle;
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    float f = clamp((uForm - aSeed.x * 0.32) / 0.68, 0.0, 1.0);
    f = f * f * (3.0 - 2.0 * f);
    vec3 p = mix(aStart, position, f);
    // While merging, the clusters still swing around their shared barycentre
    float ang = (1.0 - f) * 1.9;
    float c = cos(ang);
    float s = sin(ang);
    p.xy = mat2(c, s, -s, c) * p.xy;
    // Young cluster members carry a little more velocity dispersion
    p += aSeed.z * 0.07 * vec3(sin(uTime * 0.7 + aSeed.y * 31.0), cos(uTime * 0.6 + aSeed.y * 17.0), 0.0);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * uSizeScale * uPixelRatio * (300.0 / max(-mv.z, 1.0));

    float tw = 1.0 - uTwinkle * (0.5 + 0.5 * sin(uTime * (1.3 + aSeed.y * 2.6) + aSeed.y * 40.0));
    vAlpha = mix(uGoldVis, uBlueVis, aSeed.z) * tw;
    vColor = aColor;
  }
`;

const CLUSTER_FRAGMENT_SHADER = /* glsl */ `
  uniform float uOpacity;
  uniform float uSoft;
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d2 = dot(c, c) * 4.0;
    float star = exp(-d2 * 16.0);
    float gas = exp(-d2 * 2.6) * (1.0 - smoothstep(0.7, 1.0, d2));
    float a = mix(star, gas, uSoft) * vAlpha * uOpacity;
    if (a < 0.003) discard;
    gl_FragColor = vec4(vColor, a);
  }
`;

/** True when a point of the disk belongs to the gold (old) cluster's half of the taijitu. */
function isGoldSide(x: number, y: number): boolean {
  const r2 = (R / 2) * (R / 2);
  if (x * x + (y - R / 2) * (y - R / 2) < r2) return true;
  if (x * x + (y + R / 2) * (y + R / 2) < r2) return false;
  return x > 0;
}

/** Distance to the S-shaped boundary (two opposed semicircular arcs). */
function distanceToS(x: number, y: number): number {
  const arc = (cy: number, leftHalf: boolean) => {
    if (leftHalf ? x <= 0 : x >= 0) return Math.abs(Math.hypot(x, y - cy) - R / 2);
    return Math.min(Math.hypot(x, y - cy - R / 2), Math.hypot(x, y - cy + R / 2));
  };
  return Math.min(arc(R / 2, true), arc(-R / 2, false));
}

export class CelestialEquilibrium {
  public readonly root = new THREE.Group();
  public readonly starCount: number;

  private readonly disk = new THREE.Group();
  private readonly starMat: THREE.ShaderMaterial;
  private readonly gasMat: THREE.ShaderMaterial;
  private readonly eyes: Array<{
    group: THREE.Group;
    core: THREE.SpriteMaterial;
    glow: THREE.SpriteMaterial;
    target: THREE.Vector2;
    start: THREE.Vector2;
    gold: boolean;
  }> = [];
  private readonly disposables: Array<{ dispose: () => void }> = [];

  constructor(isMobile: boolean, pixelRatio: number) {
    this.root.position.set(0, 0, -340);

    let seed = 4204;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const gauss = () => {
      const u = Math.max(rand(), 1e-6);
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(Math.PI * 2 * rand());
    };

    // Sub-clumps give the young cluster its patchy, still-forming look
    const blueClumps: THREE.Vector2[] = [];
    while (blueClumps.length < 9) {
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * R * 0.92;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      if (!isGoldSide(x, y)) blueClumps.push(new THREE.Vector2(x, y));
    }

    const density = (x: number, y: number, gold: boolean): number => {
      const head = gold ? GOLD_HEAD : BLUE_HEAD;
      const dh = Math.hypot(x - head.x, y - head.y);
      const sigma = gold ? 0.26 * R : 0.32 * R;
      let w = (gold ? 0.55 : 0.45) + 0.75 * Math.exp(-(dh * dh) / (2 * sigma * sigma));
      if (!gold) {
        let clump = 0;
        for (const c of blueClumps) {
          const d = Math.hypot(x - c.x, y - c.y);
          clump = Math.max(clump, Math.exp(-(d * d) / (2 * (0.11 * R) ** 2)));
        }
        w *= 0.5 + 1.1 * clump;
      }
      if (dh < 0.11 * R) w *= 0.5;
      w *= 0.06 + 0.94 * smoothstep(0.02 * R, 0.13 * R, distanceToS(x, y));
      w *= 1 - smoothstep(0.84 * R, 1.08 * R, Math.hypot(x, y));
      return w;
    };

    const goldPalette = ['#ffb070', '#ffc98a', '#ffdcab', '#ffeacc', '#fff4e2', '#ff9a62'].map((c) => new THREE.Color(c));
    const bluePalette = ['#9db4ff', '#aabfff', '#c2d2ff', '#dbe5ff', '#f2f5ff', '#8aa6ff'].map((c) => new THREE.Color(c));

    const buildLayer = (count: number, gas: boolean) => {
      const pos = new Float32Array(count * 3);
      const start = new Float32Array(count * 3);
      const col = new Float32Array(count * 3);
      const size = new Float32Array(count);
      const seeds = new Float32Array(count * 3);
      let n = 0;
      let guard = 0;
      while (n < count && guard < count * 60) {
        guard++;
        const a = rand() * Math.PI * 2;
        const r = Math.sqrt(rand()) * R * 1.1;
        const x = Math.cos(a) * r;
        const y = Math.sin(a) * r;
        const gold = isGoldSide(x, y);
        if (rand() * 1.45 > density(x, y, gold)) continue;

        const head = gold ? GOLD_HEAD : BLUE_HEAD;
        const dh = Math.hypot(x - head.x, y - head.y);
        const core = Math.exp(-(dh * dh) / (2 * (0.3 * R) ** 2));
        const z = gauss() * (gas ? 0.6 + 1.6 * core : 0.3 + 1.3 * core);
        pos[n * 3] = x;
        pos[n * 3 + 1] = y;
        pos[n * 3 + 2] = z;

        // Before the tidal encounter each cluster is a compact, rounder swarm
        const origin = gold ? GOLD_START : BLUE_START;
        const k = gold ? 0.5 : 0.6;
        start[n * 3] = origin.x + (x - head.x) * k + gauss() * (gold ? 1.0 : 1.6);
        start[n * 3 + 1] = origin.y + (y - head.y) * k + gauss() * (gold ? 1.0 : 1.6);
        start[n * 3 + 2] = z * 0.7;

        let c: THREE.Color;
        if (gas) {
          c = gold
            ? new THREE.Color('#8a5a2c')
            : rand() < 0.22
              ? new THREE.Color('#9a3552')
              : new THREE.Color('#2c4aa8');
          size[n] = 9 + rand() * 12;
        } else {
          const pal = gold ? goldPalette : bluePalette;
          c = pal[Math.floor(rand() * pal.length)].clone();
          // A small minority of each population belongs to the other temperature class
          if (rand() < 0.04) c = (gold ? bluePalette : goldPalette)[Math.floor(rand() * 6)].clone();
          const bright = Math.pow(rand(), 9);
          size[n] = 0.38 + bright * 3.0 + core * 0.15;
          c.multiplyScalar(0.75 + bright * 0.5);
        }
        col[n * 3] = c.r;
        col[n * 3 + 1] = c.g;
        col[n * 3 + 2] = c.b;
        seeds[n * 3] = rand();
        seeds[n * 3 + 1] = rand();
        seeds[n * 3 + 2] = gold ? 0 : 1;
        n++;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('aStart', new THREE.BufferAttribute(start, 3));
      geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
      geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
      geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
      geo.setDrawRange(0, n);
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 30);
      return { geo, n };
    };

    const makeMat = (soft: number, sizeScale: number, twinkle: number) =>
      new THREE.ShaderMaterial({
        vertexShader: CLUSTER_VERTEX_SHADER,
        fragmentShader: CLUSTER_FRAGMENT_SHADER,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uForm: { value: 0 },
          uTime: { value: 0 },
          uGoldVis: { value: 0 },
          uBlueVis: { value: 0 },
          uPixelRatio: { value: pixelRatio },
          uSizeScale: { value: sizeScale },
          uTwinkle: { value: twinkle },
          uOpacity: { value: 0 },
          uSoft: { value: soft },
        },
      });

    const gasLayer = buildLayer(isMobile ? 420 : 900, true);
    this.gasMat = makeMat(1, 1, 0);
    const gasPoints = new THREE.Points(gasLayer.geo, this.gasMat);
    gasPoints.frustumCulled = false;

    const starLayer = buildLayer(isMobile ? 7000 : 16000, false);
    this.starCount = starLayer.n;
    this.starMat = makeMat(0, 1, 0.22);
    const starPoints = new THREE.Points(starLayer.geo, this.starMat);
    starPoints.frustumCulled = false;
    this.disk.add(gasPoints, starPoints);
    this.disposables.push(gasLayer.geo, starLayer.geo, this.gasMat, this.starMat);

    // The two "eyes": a blue straggler inside the old cluster, a red supergiant inside the young one
    const diffTex = createStarDiffractionTexture(192);
    const glowTex = createNeutralGlowTexture();
    this.disposables.push(diffTex, glowTex);
    const eyeSpecs = [
      { target: GOLD_HEAD, start: GOLD_START, core: 0xdce8ff, glow: 0x5f8cff, gold: true },
      { target: BLUE_HEAD, start: BLUE_START, core: 0xffc59a, glow: 0xff6a2e, gold: false },
    ];
    for (const spec of eyeSpecs) {
      const group = new THREE.Group();
      const glow = new THREE.SpriteMaterial({
        map: glowTex,
        color: spec.glow,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const core = new THREE.SpriteMaterial({
        map: diffTex,
        color: spec.core,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const glowSprite = new THREE.Sprite(glow);
      glowSprite.scale.set(3.6, 3.6, 1);
      const coreSprite = new THREE.Sprite(core);
      coreSprite.scale.set(2.6, 2.6, 1);
      group.add(glowSprite, coreSprite);
      this.disk.add(group);
      this.eyes.push({ group, core, glow, target: spec.target, start: spec.start, gold: spec.gold });
      this.disposables.push(glow, core);
    }

    this.root.add(this.disk);
  }

  public update(filmTime: number, elapsed: number): void {
    const weight = getChapterWeight(filmTime, 225, 285, 6.5, 6.5);
    this.root.visible = weight > 0.004;
    if (!this.root.visible) return;

    // 228.5: the old cluster appears ("precise"); 233: the young one ("unpredictable")
    // 237..258: tidal capture draws both into the taijitu; 258..279: balanced co-rotation
    const goldVis = smoothstep(227.5, 232.0, filmTime);
    const blueVis = smoothstep(232.5, 237.0, filmTime);
    const form = smoothstep(237.0, 259.0, filmTime);
    const dissolve = smoothstep(279.0, 285.0, filmTime);
    const opacity = weight * (1 - dissolve * 0.9);

    this.disk.rotation.set(-0.16, 0.08, -(filmTime - 225) * 0.028);

    for (const mat of [this.starMat, this.gasMat]) {
      mat.uniforms.uForm.value = form;
      mat.uniforms.uTime.value = elapsed;
      mat.uniforms.uGoldVis.value = goldVis;
      mat.uniforms.uBlueVis.value = blueVis;
    }
    this.starMat.uniforms.uOpacity.value = opacity * (0.3 + 0.12 * form);
    this.gasMat.uniforms.uOpacity.value = opacity * (0.02 + 0.02 * form);

    // Eyes follow the same capture path as their host cores
    const f = form * form * (3 - 2 * form);
    const ang = (1 - f) * 1.9;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    for (const eye of this.eyes) {
      const x = THREE.MathUtils.lerp(eye.start.x, eye.target.x, f);
      const y = THREE.MathUtils.lerp(eye.start.y, eye.target.y, f);
      eye.group.position.set(c * x - s * y, s * x + c * y, 0.4);
      const vis = (eye.gold ? goldVis : blueVis) * opacity * (0.55 + 0.45 * form);
      const pulse = eye.gold ? 1 : 0.92 + 0.08 * Math.sin(elapsed * 0.9);
      eye.core.opacity = vis * pulse;
      eye.glow.opacity = vis * 0.55 * pulse;
    }
  }

  public dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
