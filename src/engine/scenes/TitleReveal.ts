import * as THREE from 'three';
import {
  SHOOTING_STAR_TIME,
  SILENCE_END,
  SILENCE_START,
  clamp,
  getChapterWeight,
  smoothstep,
} from '../../data/chapters';
import {
  BINARY_STAR_FRAGMENT_SHADER,
  BINARY_STAR_VERTEX_SHADER,
  createNeutralGlowTexture,
  createSoftGlowTexture,
  createStarDiffractionTexture,
} from '../shaders';

/**
 * Final Chapter: The Revelation (centered at 0, 0, -515).
 * The life and death of a massive star, compressed from millennia into one minute:
 * 1. 335..350  A red supergiant boils inside the dusty shells it has already shed.
 * 2. 350..362  Its core runs out of fuel: the envelope swells, pulsates and dims unevenly.
 * 3. 362.6..365 Core collapse; only the hot collapsed core remains through the silence.
 * 4. 370.5     Shock breakout flash, a light echo racing across the old dust shells.
 * 5. 371..405  A supernova remnant: decelerating filamentary ejecta glowing in hydrogen (red),
 *              oxygen (teal) and sulfur (gold), a faint forward shock, swept-up circumstellar gas,
 *              and a spinning neutron star feeding a pulsar wind nebula at the centre.
 * 6. 387       A meteor crossing the closing frame.
 */

const ELEMENT_COLORS = {
  hydrogen: new THREE.Color('#ff4f45'),
  nitrogen: new THREE.Color('#ff7a5c'),
  sulfur: new THREE.Color('#ffb44e'),
  oxygen: new THREE.Color('#4fd8c6'),
  hot: new THREE.Color('#f2f4ff'),
};

const EJECTA_VERTEX_SHADER = /* glsl */ `
  attribute vec3 aDir;
  attribute float aRad;
  attribute vec3 aColor;
  attribute float aSize;
  uniform float uShellR;
  uniform float uHeat;
  uniform float uPixelRatio;
  varying vec3 vColor;
  void main() {
    vec3 p = aDir * aRad * uShellR;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * uPixelRatio * (300.0 / max(-mv.z, 1.0));
    vColor = mix(aColor, vec3(0.9, 0.93, 1.0), uHeat);
  }
`;

const SOFT_POINT_FRAGMENT_SHADER = /* glsl */ `
  uniform float uOpacity;
  varying vec3 vColor;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d2 = dot(c, c) * 4.0;
    float a = (exp(-d2 * 10.0) + 0.08 * exp(-d2 * 2.5)) * uOpacity;
    if (a < 0.003) discard;
    gl_FragColor = vec4(vColor, a);
  }
`;

// Circumstellar dust shed by the supergiant: dim reflection before, swept up and glowing after the shock
const CSM_VERTEX_SHADER = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  uniform float uShockR;
  uniform float uEchoR;
  uniform float uEcho;
  uniform float uDust;
  uniform float uPixelRatio;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float r = length(position);
    vec3 dir = position / max(r, 0.001);
    float shocked = step(r, uShockR);
    vec3 p = mix(position, dir * max(r, uShockR * 0.96), shocked);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * uPixelRatio * (300.0 / max(-mv.z, 1.0));
    float echoD = r - uEchoR;
    float echo = exp(-echoD * echoD * 0.9) * uEcho;
    vColor = mix(aColor, vec3(1.0, 0.42, 0.4), shocked);
    vColor = mix(vColor, vec3(1.0, 0.92, 0.8), clamp(echo, 0.0, 1.0));
    vAlpha = uDust * (1.0 - shocked) + shocked * 0.35 + echo * 1.0;
  }
`;

const CSM_FRAGMENT_SHADER = /* glsl */ `
  uniform float uOpacity;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d2 = dot(c, c) * 4.0;
    float a = exp(-d2 * 3.0) * (1.0 - smoothstep(0.7, 1.0, d2)) * vAlpha * uOpacity;
    if (a < 0.003) discard;
    gl_FragColor = vec4(vColor, a);
  }
`;

const RIM_VERTEX_SHADER = /* glsl */ `
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vN = normalize(mat3(modelMatrix) * normal);
    vV = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const RIM_FRAGMENT_SHADER = /* glsl */ `
  uniform float uOpacity;
  uniform vec3 uColor;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    float rim = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 5.0);
    float a = rim * uOpacity;
    if (a < 0.003) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

const BEAM_VERTEX_SHADER = /* glsl */ `
  varying float vAlong;
  void main() {
    vAlong = uv.y;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const BEAM_FRAGMENT_SHADER = /* glsl */ `
  uniform float uOpacity;
  varying float vAlong;
  void main() {
    float a = pow(1.0 - vAlong, 2.5) * uOpacity;
    if (a < 0.003) discard;
    gl_FragColor = vec4(vec3(0.78, 0.86, 1.0), a);
  }
`;

function makeNoise3(seed: number) {
  const hash = (x: number, y: number, z: number) => {
    let h = (x * 374761393 + y * 668265263 + z * 2147483647 + seed * 144665) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const fade = (t: number) => t * t * (3 - 2 * t);
  return (x: number, y: number, z: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const zi = Math.floor(z);
    const xf = fade(x - xi);
    const yf = fade(y - yi);
    const zf = fade(z - zi);
    const l = THREE.MathUtils.lerp;
    return l(
      l(l(hash(xi, yi, zi), hash(xi + 1, yi, zi), xf), l(hash(xi, yi + 1, zi), hash(xi + 1, yi + 1, zi), xf), yf),
      l(
        l(hash(xi, yi, zi + 1), hash(xi + 1, yi, zi + 1), xf),
        l(hash(xi, yi + 1, zi + 1), hash(xi + 1, yi + 1, zi + 1), xf),
        yf,
      ),
      zf,
    );
  };
}

export class TitleReveal {
  public readonly root = new THREE.Group();

  private readonly starGroup = new THREE.Group();
  private readonly starMat: THREE.ShaderMaterial;
  private readonly starCoronaMat: THREE.SpriteMaterial;
  private readonly starCorona: THREE.Sprite;
  private readonly collapsedCoreMat: THREE.SpriteMaterial;
  private readonly flashMat: THREE.SpriteMaterial;
  private readonly flash: THREE.Sprite;
  private readonly csmMat: THREE.ShaderMaterial;
  private readonly remnantGroup = new THREE.Group();
  private readonly ejectaMat: THREE.ShaderMaterial;
  private readonly shockMat: THREE.ShaderMaterial;
  private readonly shockMesh: THREE.Mesh;
  private readonly pwnMat: THREE.ShaderMaterial;
  private readonly pwnPoints: THREE.Points;
  private readonly pwnGlowMat: THREE.SpriteMaterial;
  private readonly pwnGlow: THREE.Sprite;
  private readonly pulsarGroup = new THREE.Group();
  private readonly pulsarSpin = new THREE.Group();
  private readonly pulsarCoreMat: THREE.SpriteMaterial;
  private readonly beamMat: THREE.ShaderMaterial;
  private readonly shootingStarGroup = new THREE.Group();
  private readonly shootingHead: THREE.Sprite;
  private readonly shootingTail: THREE.Line;
  private readonly shootingTailPositions: Float32Array;
  private readonly disposables: Array<{ dispose: () => void }> = [];

  constructor(isMobile: boolean, pixelRatio: number) {
    this.root.position.set(0, 0, -515);

    const scaleFactor = isMobile ? 0.5 : 1.0;
    let s = 25112002;
    const rand = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    const gauss = () => Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-6))) * Math.cos(Math.PI * 2 * rand());
    const randomDir = (out: THREE.Vector3) => {
      const u = rand() * 2 - 1;
      const phi = rand() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      return out.set(r * Math.cos(phi), u, r * Math.sin(phi));
    };
    const noise = makeNoise3(7);
    const glowTex = createNeutralGlowTexture();
    const diffTex = createStarDiffractionTexture(192);
    this.disposables.push(glowTex, diffTex);
    const additiveSprite = (map: THREE.Texture, color: number) =>
      new THREE.SpriteMaterial({
        map,
        color,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });

    // 1. Red supergiant: cool, convective, enormous
    const starGeo = new THREE.SphereGeometry(2.6, 64, 48);
    this.starMat = new THREE.ShaderMaterial({
      vertexShader: BINARY_STAR_VERTEX_SHADER,
      fragmentShader: BINARY_STAR_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: true,
      uniforms: {
        uTime: { value: 0 },
        uOpacity: { value: 0 },
        uCoreColor: { value: new THREE.Color('#ffd0a0') },
        uMidColor: { value: new THREE.Color('#c4441c') },
        uRimColor: { value: new THREE.Color('#ff7a3c') },
        uSeed: { value: 3.9 },
      },
    });
    this.starGroup.add(new THREE.Mesh(starGeo, this.starMat));
    this.starCoronaMat = additiveSprite(glowTex, 0xff6a30);
    this.starCorona = new THREE.Sprite(this.starCoronaMat);
    this.starCorona.scale.set(13, 13, 1);
    this.starGroup.add(this.starCorona);
    this.root.add(this.starGroup);
    this.disposables.push(starGeo, this.starMat, this.starCoronaMat);

    // Collapsed core left alone through the silence
    this.collapsedCoreMat = additiveSprite(diffTex, 0xfff0dc);
    const collapsedCore = new THREE.Sprite(this.collapsedCoreMat);
    collapsedCore.scale.set(1.6, 1.6, 1);
    this.root.add(collapsedCore);
    this.disposables.push(this.collapsedCoreMat);

    // 2. Circumstellar shells: clumpy dust the star shed over its last millennia
    const csmCount = Math.round(2600 * scaleFactor);
    const csmPos = new Float32Array(csmCount * 3);
    const csmCol = new Float32Array(csmCount * 3);
    const csmSize = new Float32Array(csmCount);
    const dir = new THREE.Vector3();
    const dust = [new THREE.Color('#5a2c1c'), new THREE.Color('#7a3e24'), new THREE.Color('#4a2a26')];
    let csmN = 0;
    for (let i = 0, n = 0; n < csmCount && i < csmCount * 40; i++, csmN = n) {
      randomDir(dir);
      const clump = noise(dir.x * 2.2 + 4, dir.y * 2.2, dir.z * 2.2);
      if (rand() > clump * clump * 1.6) continue;
      const shell = rand() < 0.55 ? 6.5 : 10.5;
      const r = shell + gauss() * 1.1;
      csmPos[n * 3] = dir.x * r;
      csmPos[n * 3 + 1] = dir.y * r * 0.9;
      csmPos[n * 3 + 2] = dir.z * r;
      const c = dust[n % dust.length];
      csmCol[n * 3] = c.r;
      csmCol[n * 3 + 1] = c.g;
      csmCol[n * 3 + 2] = c.b;
      csmSize[n] = 1.4 + rand() * 2.6;
      n++;
    }
    const csmGeo = new THREE.BufferGeometry();
    csmGeo.setAttribute('position', new THREE.BufferAttribute(csmPos, 3));
    csmGeo.setAttribute('aColor', new THREE.BufferAttribute(csmCol, 3));
    csmGeo.setAttribute('aSize', new THREE.BufferAttribute(csmSize, 1));
    csmGeo.setDrawRange(0, csmN);
    this.csmMat = new THREE.ShaderMaterial({
      vertexShader: CSM_VERTEX_SHADER,
      fragmentShader: CSM_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uShockR: { value: 0 },
        uEchoR: { value: -100 },
        uEcho: { value: 0 },
        uDust: { value: 0.3 },
        uOpacity: { value: 0 },
        uPixelRatio: { value: pixelRatio },
      },
    });
    const csmPoints = new THREE.Points(csmGeo, this.csmMat);
    csmPoints.frustumCulled = false;
    this.root.add(csmPoints);
    this.disposables.push(csmGeo, this.csmMat);

    // 3. Shock breakout flash
    this.flashMat = additiveSprite(glowTex, 0xdfe8ff);
    this.flash = new THREE.Sprite(this.flashMat);
    this.root.add(this.flash);
    this.disposables.push(this.flashMat);

    // 4. Filamentary ejecta: Rayleigh-Taylor fingers, stratified by element
    const ejectaCount = Math.round(12000 * scaleFactor);
    const eDir = new Float32Array(ejectaCount * 3);
    const eRad = new Float32Array(ejectaCount);
    const eCol = new Float32Array(ejectaCount * 3);
    const eSize = new Float32Array(ejectaCount);
    let ejectaN = 0;
    for (let i = 0, n = 0; n < ejectaCount && i < ejectaCount * 80; i++, ejectaN = n) {
      randomDir(dir);
      const q = noise(dir.x * 3.2 + 11, dir.y * 3.2, dir.z * 3.2) * 0.65 +
        noise(dir.x * 7.5, dir.y * 7.5 + 5, dir.z * 7.5) * 0.35;
      const ridge = 1 - Math.abs(q * 2 - 1);
      if (rand() > Math.pow(ridge, 22) * 1.1) continue;
      const finger = Math.pow(rand(), 4) * 0.4;
      const rad = 0.98 - finger + (noise(dir.x * 1.6, dir.y * 1.6, dir.z * 1.6 + 9) - 0.5) * 0.16;
      eDir[n * 3] = dir.x * 1.04;
      eDir[n * 3 + 1] = dir.y * 0.94;
      eDir[n * 3 + 2] = dir.z;
      eRad[n] = rad;
      // Outer layers are hydrogen-rich; inner, deeper material carries oxygen and sulfur
      const depth = (0.98 - rad) / 0.4 + (rand() - 0.5) * 0.35;
      const c =
        depth < 0.25
          ? rand() < 0.75 ? ELEMENT_COLORS.hydrogen : ELEMENT_COLORS.nitrogen
          : depth < 0.55
            ? rand() < 0.6 ? ELEMENT_COLORS.sulfur : ELEMENT_COLORS.hydrogen
            : ELEMENT_COLORS.oxygen;
      const b = 0.55 + rand() * 0.45;
      eCol[n * 3] = c.r * b;
      eCol[n * 3 + 1] = c.g * b;
      eCol[n * 3 + 2] = c.b * b;
      eSize[n] = 0.45 + Math.pow(rand(), 4) * 1.6;
      n++;
    }
    const ejectaGeo = new THREE.BufferGeometry();
    ejectaGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ejectaCount * 3), 3));
    ejectaGeo.setAttribute('aDir', new THREE.BufferAttribute(eDir, 3));
    ejectaGeo.setAttribute('aRad', new THREE.BufferAttribute(eRad, 1));
    ejectaGeo.setAttribute('aColor', new THREE.BufferAttribute(eCol, 3));
    ejectaGeo.setAttribute('aSize', new THREE.BufferAttribute(eSize, 1));
    ejectaGeo.setDrawRange(0, ejectaN);
    this.ejectaMat = new THREE.ShaderMaterial({
      vertexShader: EJECTA_VERTEX_SHADER,
      fragmentShader: SOFT_POINT_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uShellR: { value: 0 },
        uHeat: { value: 1 },
        uOpacity: { value: 0 },
        uPixelRatio: { value: pixelRatio },
      },
    });
    const ejecta = new THREE.Points(ejectaGeo, this.ejectaMat);
    ejecta.frustumCulled = false;
    this.remnantGroup.add(ejecta);
    this.disposables.push(ejectaGeo, this.ejectaMat);

    // Faint forward shock running ahead of the ejecta
    const shockGeo = new THREE.SphereGeometry(1, 64, 40);
    this.shockMat = new THREE.ShaderMaterial({
      vertexShader: RIM_VERTEX_SHADER,
      fragmentShader: RIM_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uOpacity: { value: 0 },
        uColor: { value: new THREE.Color('#8fb4ff') },
      },
    });
    this.shockMesh = new THREE.Mesh(shockGeo, this.shockMat);
    this.remnantGroup.add(this.shockMesh);
    this.disposables.push(shockGeo, this.shockMat);

    // 5. Pulsar wind nebula: diffuse synchrotron glow around the newborn neutron star
    const pwnCount = Math.round(1800 * scaleFactor);
    const pPos = new Float32Array(pwnCount * 3);
    const pCol = new Float32Array(pwnCount * 3);
    const pSize = new Float32Array(pwnCount);
    const synchrotron = new THREE.Color('#9fb0ff');
    for (let i = 0; i < pwnCount; i++) {
      randomDir(dir);
      const r = Math.abs(gauss()) * 0.38;
      pPos[i * 3] = dir.x * r * 1.25;
      pPos[i * 3 + 1] = dir.y * r;
      pPos[i * 3 + 2] = dir.z * r;
      const b = 0.5 + rand() * 0.5;
      pCol[i * 3] = synchrotron.r * b;
      pCol[i * 3 + 1] = synchrotron.g * b;
      pCol[i * 3 + 2] = synchrotron.b * b;
      pSize[i] = 1.2 + rand() * 2.4;
    }
    const pwnGeo = new THREE.BufferGeometry();
    pwnGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
    pwnGeo.setAttribute('aColor', new THREE.BufferAttribute(pCol, 3));
    pwnGeo.setAttribute('aSize', new THREE.BufferAttribute(pSize, 1));
    this.pwnMat = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aSize;
        uniform float uPixelRatio;
        varying vec3 vColor;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * uPixelRatio * (300.0 / max(-mv.z, 1.0));
          vColor = aColor;
        }
      `,
      fragmentShader: SOFT_POINT_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uOpacity: { value: 0 }, uPixelRatio: { value: pixelRatio } },
    });
    this.pwnPoints = new THREE.Points(pwnGeo, this.pwnMat);
    this.pwnPoints.frustumCulled = false;
    this.remnantGroup.add(this.pwnPoints);
    this.pwnGlowMat = additiveSprite(glowTex, 0x7f95ff);
    this.pwnGlow = new THREE.Sprite(this.pwnGlowMat);
    this.remnantGroup.add(this.pwnGlow);
    this.disposables.push(pwnGeo, this.pwnMat, this.pwnGlowMat);

    // 6. Neutron star: a pinpoint whose magnetic-axis beams sweep around a tilted spin axis
    this.pulsarCoreMat = additiveSprite(diffTex, 0xeef2ff);
    const pulsarCore = new THREE.Sprite(this.pulsarCoreMat);
    pulsarCore.scale.set(1.1, 1.1, 1);
    const beamGeo = new THREE.CylinderGeometry(0.32, 0.01, 7, 24, 1, true);
    beamGeo.translate(0, 3.5, 0);
    this.beamMat = new THREE.ShaderMaterial({
      vertexShader: BEAM_VERTEX_SHADER,
      fragmentShader: BEAM_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: { uOpacity: { value: 0 } },
    });
    const magneticAxis = new THREE.Group();
    magneticAxis.rotation.z = 0.6;
    const beamA = new THREE.Mesh(beamGeo, this.beamMat);
    const beamB = new THREE.Mesh(beamGeo, this.beamMat);
    beamB.rotation.z = Math.PI;
    magneticAxis.add(beamA, beamB);
    this.pulsarSpin.add(magneticAxis);
    this.pulsarGroup.add(this.pulsarSpin, pulsarCore);
    this.pulsarGroup.rotation.set(0.35, 0, -0.4);
    this.remnantGroup.add(this.pulsarGroup);
    this.disposables.push(this.pulsarCoreMat, beamGeo, this.beamMat);
    this.root.add(this.remnantGroup);

    // 7. Meteor crossing the closing frame (387s..392s)
    const meteorTex = createSoftGlowTexture('#fff8e6', '#ecc372');
    const headMat = additiveSprite(meteorTex, 0xfff8e2);
    this.shootingHead = new THREE.Sprite(headMat);
    this.shootingHead.scale.set(2.2, 2.2, 1);
    const tailCount = 24;
    this.shootingTailPositions = new Float32Array(tailCount * 3);
    const tailGeo = new THREE.BufferGeometry();
    tailGeo.setAttribute('position', new THREE.BufferAttribute(this.shootingTailPositions, 3));
    const tailMat = new THREE.LineBasicMaterial({
      color: 0xf7d894,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
    });
    this.shootingTail = new THREE.Line(tailGeo, tailMat);
    this.shootingStarGroup.add(this.shootingHead, this.shootingTail);
    this.root.add(this.shootingStarGroup);
    this.disposables.push(meteorTex, headMat, tailGeo, tailMat);
  }

  public update(filmTime: number, elapsed: number): void {
    const weight = getChapterWeight(filmTime, 335, 415, 6.5, 4);
    this.root.visible = weight > 0.004;
    if (!this.root.visible) return;

    // Supergiant: steady boil, then swelling pulsations, then core collapse just before the silence
    const swell = smoothstep(350, 361.5, filmTime);
    const collapse = smoothstep(362.6, 364.9, filmTime);
    const pulsation = 1 + swell * 0.05 * Math.sin(elapsed * 1.4) + swell * 0.025 * Math.sin(elapsed * 3.1 + 1.3);
    const starScale = (1 + swell * 0.32) * pulsation * THREE.MathUtils.lerp(1, 0.05, collapse * collapse);
    const starVis = weight * (1 - smoothstep(364.4, 365.1, filmTime));
    this.starGroup.visible = starVis > 0.004;
    this.starGroup.scale.setScalar(starScale);
    this.starMat.uniforms.uTime.value = elapsed * (0.5 + swell * 0.6);
    this.starMat.uniforms.uOpacity.value = starVis;
    // Uneven dimming as the envelope pulsates and dust condenses in front of it
    const dimming = 1 - swell * 0.38 * (0.5 + 0.5 * Math.sin(elapsed * 0.55));
    this.starCoronaMat.opacity = starVis * 0.42 * dimming * (1 + collapse * 0.8);

    const silence = smoothstep(SILENCE_START - 1.5, SILENCE_START + 0.4, filmTime) *
      (1 - smoothstep(SILENCE_END, SILENCE_END + 2.0, filmTime));
    const coreVis = smoothstep(363.6, 364.9, filmTime) * (1 - smoothstep(SILENCE_END, SILENCE_END + 0.35, filmTime));
    this.collapsedCoreMat.opacity = coreVis * weight * (0.78 + 0.06 * Math.sin(elapsed * 2.0));

    // Explosion timeline
    const dt = filmTime - SILENCE_END;
    const exploded = dt > 0;
    const shellR = exploded ? 6.0 * (1 - Math.exp(-dt / 5.0)) + 0.03 * dt : 0;

    const flash = exploded ? smoothstep(0, 0.3, dt) * Math.exp(-Math.max(dt - 0.3, 0) / 1.4) : 0;
    this.flash.visible = flash > 0.004;
    this.flash.scale.setScalar(5 + 34 * smoothstep(0, 2.2, dt));
    this.flashMat.color.setRGB(0.88 + 0.12 * smoothstep(0, 3, dt), 0.91, 1.0 - 0.25 * smoothstep(0, 3, dt));
    this.flashMat.opacity = flash * weight;

    // Dusty shells: dimly lit by the giant, crossed by the light echo, then swept up by the shock
    this.csmMat.uniforms.uShockR.value = shellR * 1.07;
    this.csmMat.uniforms.uEchoR.value = exploded ? dt * 7.0 : -100;
    this.csmMat.uniforms.uEcho.value = exploded ? Math.exp(-dt / 2.5) : 0;
    this.csmMat.uniforms.uDust.value = 0.16 * (1 - collapse * 0.5);
    this.csmMat.uniforms.uOpacity.value = weight * (1 - silence * 0.85) * (exploded ? 0.65 : 0.55);

    this.remnantGroup.visible = exploded;
    if (exploded) {
      this.remnantGroup.rotation.y = elapsed * 0.012;
      const remnantVis = smoothstep(0.05, 1.0, dt) * weight;
      this.ejectaMat.uniforms.uShellR.value = shellR;
      this.ejectaMat.uniforms.uHeat.value = Math.exp(-dt / 2.6);
      this.ejectaMat.uniforms.uOpacity.value = remnantVis * (0.3 + 0.3 * Math.exp(-dt / 2.0));
      this.shockMesh.scale.setScalar(Math.max(shellR * 1.07, 0.01));
      this.shockMat.uniforms.uOpacity.value = remnantVis * (0.32 + 0.4 * Math.exp(-dt / 3));

      const pwnVis = smoothstep(2.5, 9.0, dt) * weight;
      this.pwnPoints.scale.setScalar(Math.max(shellR * 0.55, 0.01));
      this.pwnMat.uniforms.uOpacity.value = pwnVis * 0.09;
      this.pwnGlow.scale.setScalar(shellR * 0.75);
      this.pwnGlowMat.opacity = pwnVis * 0.1;

      const pulsarVis = smoothstep(2.0, 6.0, dt) * weight;
      const blink = 0.8 + 0.2 * Math.max(0, Math.sin(elapsed * 9.0));
      this.pulsarCoreMat.opacity = pulsarVis * blink;
      this.pulsarSpin.rotation.y = elapsed * 1.1;
      this.beamMat.uniforms.uOpacity.value = pulsarVis * 0.09;
    }

    // Meteor crossing the upper sky (387s..392.2s)
    const shootP = clamp((filmTime - SHOOTING_STAR_TIME) / 5.2, 0, 1);
    const shootVis = shootP > 0 && shootP < 1 ? Math.sin(shootP * Math.PI) : 0;
    this.shootingHead.material.opacity = shootVis;
    (this.shootingTail.material as THREE.LineBasicMaterial).opacity = shootVis * 0.72;
    this.shootingStarGroup.visible = shootVis > 0.005;

    if (shootVis > 0.005) {
      const startX = -26;
      const endX = 28;
      const startY = 14.5;
      const endY = 4.2;
      const z = 4;
      const hx = THREE.MathUtils.lerp(startX, endX, shootP);
      const hy = THREE.MathUtils.lerp(startY, endY, shootP) - Math.sin(shootP * Math.PI) * 1.4;
      this.shootingHead.position.set(hx, hy, z);
      const count = this.shootingTailPositions.length / 3;
      for (let i = 0; i < count; i++) {
        const tp = clamp(shootP - (i / count) * 0.16, 0, 1);
        this.shootingTailPositions[i * 3] = THREE.MathUtils.lerp(startX, endX, tp);
        this.shootingTailPositions[i * 3 + 1] =
          THREE.MathUtils.lerp(startY, endY, tp) - Math.sin(tp * Math.PI) * 1.4;
        this.shootingTailPositions[i * 3 + 2] = z;
      }
      this.shootingTail.geometry.attributes.position.needsUpdate = true;
    }
  }

  public dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
