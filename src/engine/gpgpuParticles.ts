import * as THREE from 'three';
import { clamp, smoothstep } from '../data/chapters';

const SIM_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/**
 * GPGPU Ping-Pong FBO Fluid & Gravitational Attractor Advection Shader:
 * Evolves 100,000+ particle positions continuously on the GPU in 16-bit HalfFloat textures,
 * responding to divergence-free 3D curl-noise, chapter gravitational attractors
 * (Prologue Singularity, Chapter IV Yin-Yang twin cores, Final Convergence),
 * cursor 3D turbulence, and live Web Audio sub-bass transients.
 */
const SIM_POSITION_FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D tPositions;
  uniform sampler2D tHome;
  uniform float uTime;
  uniform float uDelta;
  uniform float uMode; // 0 = Prologue Big Bang, 1 = Ch IV Yin-Yang, 2 = Final Convergence
  uniform float uProgress;
  uniform vec3 uCursorWorld;
  uniform float uCursorActive;
  uniform float uAudioBass;

  varying vec2 vUv;

  vec3 curlField(vec3 p, float t) {
    vec3 q = p * 0.16 + vec3(t * 0.12, -t * 0.10, t * 0.09);
    float s1 = sin(q.y * 2.1 + cos(q.z * 1.7 + t * 0.35));
    float s2 = cos(q.z * 2.3 - sin(q.x * 1.9 - t * 0.28));
    float s3 = sin(q.x * 2.0 + cos(q.y * 1.8 + t * 0.31));
    return vec3(
      cos(q.y * 1.6 + s2) - sin(q.z * 1.5 - s3),
      cos(q.z * 1.6 + s3) - sin(q.x * 1.5 - s1),
      cos(q.x * 1.6 + s1) - sin(q.y * 1.5 - s2)
    );
  }

  void main() {
    vec4 state = texture2D(tPositions, vUv);
    vec4 home = texture2D(tHome, vUv);
    vec3 pos = state.xyz;
    float seed = home.w;

    float dt = clamp(uDelta, 0.001, 0.05);
    vec3 curl = curlField(pos, uTime * 0.65);

    vec3 target = home.xyz;
    if (uMode < 0.5) {
      // Prologue: swirling primordial filaments expanding outward from the singularity
      float radius = 4.5 + uProgress * 42.0 * (0.45 + seed * 0.85);
      float ang = uTime * 0.18 + seed * 6.2831 + uProgress * 1.4;
      vec3 dir = normalize(home.xyz + vec3(0.0001));
      mat2 rot = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
      dir.xz = rot * dir.xz;
      target = dir * radius;
    } else if (uMode < 1.5) {
      // Chapter IV Celestial Equilibrium: true 3D Bernoulli figure-eight (∞) lemniscate
      // plasma stream looping around both binary star foci and crossing Lagrange L1
      float dir = seed > 0.35 ? 1.0 : -1.0;
      float theta = uTime * 0.36 * dir + fract(seed * 31.7) * 6.2831853;
      float s = sin(theta);
      float c = cos(theta);
      float denom = 1.0 + s * s;
      float span = 12.6 + (fract(seed * 17.3) - 0.5) * 2.6;
      float x8 = (span * c) / denom;
      float y8 = ((span * s * c) / denom) * 0.94;
      float z8 = sin(2.0 * theta) * 1.65 + (fract(seed * 53.1) - 0.5) * 1.8;
      // Rotate gently in sync with the binary orbital dance
      float orb = uTime * 0.145;
      float co = cos(orb);
      float so = sin(orb);
      target = vec3(x8 * co - z8 * so, y8, x8 * so + z8 * co);
    } else {
      // Final Convergence & Supernova release
      float inward = mix(30.0, 2.2, clamp(uProgress * 1.15, 0.0, 1.0));
      float burst = smoothstep(0.78, 1.0, uProgress) * 36.0;
      float ang = uTime * 0.45 + seed * 12.566;
      vec3 dir = normalize(home.xyz + vec3(0.0001));
      mat2 rot = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
      dir.xy = rot * dir.xy;
      target = dir * (inward + burst * (0.4 + seed * 0.7));
    }

    // Spring-pull toward gravitational attractor + divergence-free curl advection + audio bass pulse
    vec3 toTarget = target - pos;
    float bassBoost = 1.0 + uAudioBass * 1.35;
    vec3 vel = toTarget * 2.15 + curl * (1.85 * bassBoost);

    // Subtle interactive cursor 3D gravitational eddy
    if (uCursorActive > 0.01) {
      vec3 toCursor = pos - uCursorWorld;
      float dist = length(toCursor) + 0.8;
      float eddy = exp(-dist * 0.14) * uCursorActive * 5.5;
      vec3 swirlDir = normalize(cross(toCursor, vec3(0.0, 0.0, 1.0)) + vec3(0.001));
      vel += swirlDir * eddy;
    }

    pos += vel * dt;
    gl_FragColor = vec4(pos, seed);
  }
`;

const GPGPU_RENDER_VERTEX_SHADER = /* glsl */ `
  attribute vec2 aRefUv;
  attribute float aScale;
  attribute vec3 aColor;

  uniform sampler2D tPositions;
  uniform float uPixelRatio;
  uniform float uOpacity;
  uniform float uAudioBass;

  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vec4 state = texture2D(tPositions, aRefUv);
    vec3 pos = state.xyz;

    vColor = aColor;
    vAlpha = uOpacity * (0.55 + 0.45 * fract(state.w * 13.7));

    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    float dist = max(8.0, -mvPosition.z);
    float bassScale = 1.0 + uAudioBass * 0.25;
    gl_PointSize = clamp(aScale * bassScale * uPixelRatio * (56.0 / dist), 1.0, 6.5);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const GPGPU_RENDER_FRAGMENT_SHADER = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    float d = length(uv);
    if (d > 0.5) discard;
    float core = exp(-d * d * 42.0);
    gl_FragColor = vec4(vColor * (core * 0.95), clamp(core * vAlpha * 0.52, 0.0, 0.65));
  }
`;

/**
 * GPGPU Ping-Pong FBO Curl-Noise Fluid & Gravitational Particle Simulation.
 * Runs 102,400 particles (320x320) on desktop GPUs and 36,864 (192x192) on mobile
 * completely on GPU ping-pong HalfFloat textures with zero CPU loop overhead.
 * Gracefully pauses ping-pong passes on CPU SwiftShader software WebGL.
 */
export class GpgpuCosmicFluid {
  public readonly root = new THREE.Group();
  public readonly particleCount: number;

  private readonly isSoftwareGl: boolean;
  private readonly simSize: number;
  private readonly simScene: THREE.Scene;
  private readonly simCamera: THREE.OrthographicCamera;
  private readonly simMat: THREE.ShaderMaterial;
  private readonly simMesh: THREE.Mesh;
  private readonly homeTex: THREE.DataTexture;
  private readonly rtA: THREE.WebGLRenderTarget;
  private readonly rtB: THREE.WebGLRenderTarget;
  private readonly renderMat: THREE.ShaderMaterial;
  private readonly points: THREE.Points;
  private readonly disposables: Array<{ dispose: () => void }> = [];

  private useAAsSource = true;
  private initialized = false;
  private activeAnchorZ = 0;

  constructor(isMobile: boolean, isSoftwareGl: boolean, pixelRatio: number) {
    this.isSoftwareGl = isSoftwareGl;
    // 320x320 = 102,400 GPU-simulated particles on desktop GPU; 192x192 on mobile
    this.simSize = isSoftwareGl ? 64 : isMobile ? 192 : 320;
    this.particleCount = this.simSize * this.simSize;

    // Seed initial particle home distribution on a unit/spherical manifold
    let s = 20021125;
    const rand = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };

    const homeData = new Float32Array(this.particleCount * 4);
    const refUvs = new Float32Array(this.particleCount * 2);
    const dummyPos = new Float32Array(this.particleCount * 3);
    const scales = new Float32Array(this.particleCount);
    const colors = new Float32Array(this.particleCount * 3);

    const palette = [
      new THREE.Color('#fff5dd'),
      new THREE.Color('#e8be72'),
      new THREE.Color('#7ca8ff'),
      new THREE.Color('#8e6de6'),
    ];

    for (let y = 0; y < this.simSize; y++) {
      for (let x = 0; x < this.simSize; x++) {
        const i = y * this.simSize + x;
        const u = rand() * 2 - 1;
        const phi = rand() * Math.PI * 2;
        const r = Math.sqrt(1 - u * u);
        const rad = 5.0 + rand() * 14.0;
        const px = r * Math.cos(phi) * rad;
        const py = u * 0.62 * rad;
        const pz = r * Math.sin(phi) * rad;

        homeData[i * 4] = px;
        homeData[i * 4 + 1] = py;
        homeData[i * 4 + 2] = pz;
        homeData[i * 4 + 3] = rand();

        refUvs[i * 2] = (x + 0.5) / this.simSize;
        refUvs[i * 2 + 1] = (y + 0.5) / this.simSize;

        dummyPos[i * 3] = px;
        dummyPos[i * 3 + 1] = py;
        dummyPos[i * 3 + 2] = pz;

        scales[i] = 1.0 + Math.pow(rand(), 2.2) * 2.2;
        const c = palette[Math.floor(rand() * palette.length)];
        colors[i * 3] = c.r;
        colors[i * 3 + 1] = c.g;
        colors[i * 3 + 2] = c.b;
      }
    }

    this.homeTex = new THREE.DataTexture(
      homeData,
      this.simSize,
      this.simSize,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    this.homeTex.minFilter = THREE.NearestFilter;
    this.homeTex.magFilter = THREE.NearestFilter;
    this.homeTex.needsUpdate = true;

    const rtOpts: THREE.RenderTargetOptions = {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
    };
    this.rtA = new THREE.WebGLRenderTarget(this.simSize, this.simSize, rtOpts);
    this.rtB = new THREE.WebGLRenderTarget(this.simSize, this.simSize, rtOpts);

    this.simScene = new THREE.Scene();
    this.simCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quadGeo = new THREE.PlaneGeometry(2, 2);
    this.simMat = new THREE.ShaderMaterial({
      vertexShader: SIM_VERTEX_SHADER,
      fragmentShader: SIM_POSITION_FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tPositions: { value: this.homeTex },
        tHome: { value: this.homeTex },
        uTime: { value: 0 },
        uDelta: { value: 0.016 },
        uMode: { value: 0 },
        uProgress: { value: 0 },
        uCursorWorld: { value: new THREE.Vector3() },
        uCursorActive: { value: 0 },
        uAudioBass: { value: 0 },
      },
    });
    this.simMesh = new THREE.Mesh(quadGeo, this.simMat);
    this.simScene.add(this.simMesh);

    const ptsGeo = new THREE.BufferGeometry();
    ptsGeo.setAttribute('position', new THREE.BufferAttribute(dummyPos, 3));
    ptsGeo.setAttribute('aRefUv', new THREE.BufferAttribute(refUvs, 2));
    ptsGeo.setAttribute('aScale', new THREE.BufferAttribute(scales, 1));
    ptsGeo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));

    this.renderMat = new THREE.ShaderMaterial({
      vertexShader: GPGPU_RENDER_VERTEX_SHADER,
      fragmentShader: GPGPU_RENDER_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        tPositions: { value: this.homeTex },
        uPixelRatio: { value: pixelRatio },
        uOpacity: { value: 0 },
        uAudioBass: { value: 0 },
      },
    });
    this.points = new THREE.Points(ptsGeo, this.renderMat);
    this.points.frustumCulled = false;
    this.root.add(this.points);

    this.disposables.push(
      this.homeTex,
      this.rtA,
      this.rtB,
      quadGeo,
      this.simMat,
      ptsGeo,
      this.renderMat,
    );
  }

  public update(
    renderer: THREE.WebGLRenderer,
    filmTime: number,
    elapsed: number,
    delta: number,
    hasEntered: boolean,
    pointerNdc: THREE.Vector2,
    audioBass: number,
  ): void {
    // Active only during the Prologue Big Bang (0..54): Chapter IV and the finale are star-cluster
    // and supernova scenes whose structure must not be overdrawn by the fluid swarm
    const prologueW = hasEntered
      ? smoothstep(6.0, 14.0, filmTime) * (1 - smoothstep(42.0, 56.0, filmTime))
      : 0.25;
    const mode = 0;
    const progress = smoothstep(8.0, 44.0, filmTime);
    const anchorZ = 0;
    const opacity = prologueW > 0.01 ? prologueW * 0.44 : 0;

    this.root.visible = opacity > 0.008 && !this.isSoftwareGl;
    if (!this.root.visible) {
      // Re-seed from the singularity the next time the swarm becomes visible (e.g. on replay)
      this.initialized = false;
      return;
    }

    if (Math.abs(anchorZ - this.activeAnchorZ) > 50) {
      this.activeAnchorZ = anchorZ;
      this.initialized = false;
    }
    this.root.position.set(0, 0, anchorZ);

    // Step GPU ping-pong position FBO
    const srcTex = this.initialized
      ? this.useAAsSource
        ? this.rtA.texture
        : this.rtB.texture
      : this.homeTex;
    const dstRT = this.useAAsSource ? this.rtB : this.rtA;

    this.simMat.uniforms.tPositions.value = srcTex;
    this.simMat.uniforms.uTime.value = elapsed;
    this.simMat.uniforms.uDelta.value = delta;
    this.simMat.uniforms.uMode.value = mode;
    this.simMat.uniforms.uProgress.value = progress;
    (this.simMat.uniforms.uCursorWorld.value as THREE.Vector3).set(
      pointerNdc.x * 16.0,
      pointerNdc.y * 10.0,
      0,
    );
    this.simMat.uniforms.uCursorActive.value = pointerNdc.length() > 0.02 ? 1.0 : 0.0;
    this.simMat.uniforms.uAudioBass.value = clamp(audioBass, 0, 1);

    const prevRT = renderer.getRenderTarget();
    renderer.setRenderTarget(dstRT);
    renderer.render(this.simScene, this.simCamera);
    renderer.setRenderTarget(prevRT);

    this.renderMat.uniforms.tPositions.value = dstRT.texture;
    this.renderMat.uniforms.uOpacity.value = opacity;
    this.renderMat.uniforms.uAudioBass.value = clamp(audioBass, 0, 1);

    this.useAAsSource = !this.useAAsSource;
    this.initialized = true;
  }

  public dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
