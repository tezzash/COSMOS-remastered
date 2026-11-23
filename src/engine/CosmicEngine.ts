import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import {
  CHAPTERS,
  FILM_DURATION,
  SILENCE_END,
  SILENCE_START,
  clamp,
  getChapterAtTime,
  smoothstep,
} from '../data/chapters';
import { CameraDirector } from './CameraDirector';
import { CHROMATIC_ABERRATION_SHADER } from './chromaticAberrationPass';
import { CINEMA_OPTICS_SHADER, createLensDustTexture } from './cinemaPass';
import { computeCinemaPresentation } from './cinemaPresentation';
import { computeChapterLutWeights } from './colorGrading';
import { GpgpuCosmicFluid } from './gpgpuParticles';
import {
  type GravitationalLensState,
  computeChapterTransitionLens,
} from './gravitationalLens';
import { GravitationalLensPass } from './gravitationalLensPass';
import { LutColorGradePass } from './lutPass';
import {
  type ParallaxInput,
  type ParallaxOptions,
  computeBloomParams,
  computeCinemaOptics,
} from './parallax';
import { CelestialEquilibrium } from './scenes/CelestialEquilibrium';
import { ConstellationFigure } from './scenes/ConstellationFigure';
import { ConstellationNetwork } from './scenes/ConstellationNetwork';
import { CosmicDriftField } from './scenes/CosmicDriftField';
import { CosmicEnvironment } from './scenes/CosmicEnvironment';
import { EarthSequence } from './scenes/EarthSequence';
import { QuietHoursSequence } from './scenes/QuietHoursSequence';
import { StellarNucleosynthesis } from './scenes/StellarNucleosynthesis';
import { TitleReveal } from './scenes/TitleReveal';
import {
  type TaaJitterOffset,
  computeTaaBlendFactor,
  computeTaaJitter,
} from './taa';
import { TaaResolvePass } from './taaPass';
import { ShutterMotionBlurPass, VelocityBufferRenderer } from './velocityPass';

export interface EngineCallbacks {
  onTimeUpdate: (timeSec: number, connectionCount: number, birthStarLaunched: boolean) => void;
  onFilmComplete: () => void;
  onBirthStarTriggered: () => void;
  onNetworkImpulse: (connections: number, spatialPos?: readonly [number, number, number]) => void;
  onNucleosynthesisBurst?: (intensity: number) => void;
  onChapterTransition?: (chapterIndex: number) => void;
  onSpatialAnchor?: (relX: number, relY: number, relZ: number) => void;
  getAudioBass?: () => number;
  onContextLost: () => void;
}

const _guidingTarget = new THREE.Vector3();
const _targetFogColor = new THREE.Color();
const _nextFogColor = new THREE.Color();
const _raycaster = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _prevCameraPos = new THREE.Vector3();
const _instCameraVel = new THREE.Vector3();
const _smoothCameraVel = new THREE.Vector3();
const _smoothedPointer = new THREE.Vector2();
const _projWorldPos = new THREE.Vector3();
const _parallaxInput: ParallaxInput = {
  cameraPos: { x: 0, y: 0, z: 0 },
  cameraVelocity: { x: 0, y: 0, z: 0 },
  pointerOffset: { x: 0, y: 0 },
};
const _parallaxOptions: ParallaxOptions = {
  reducedMotion: false,
  silenceDamp: 1,
};
const _taaJitter: TaaJitterOffset = {
  pixelX: 0,
  pixelY: 0,
  ndcX: 0,
  ndcY: 0,
};

function detectSoftwareGl(): boolean {
  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('hq') === '1') {
    return false;
  }
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param) ?? '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return true;
  }
}

export function isWebGLAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

export class CosmicEngine {
  private readonly container: HTMLElement;
  private readonly callbacks: EngineCallbacks;
  private readonly isSoftwareGl: boolean;
  private readonly isMobile: boolean;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly composerRT: THREE.WebGLRenderTarget;
  private readonly composer: EffectComposer;
  private readonly velocityBuffer: VelocityBufferRenderer;
  private readonly taaPass: TaaResolvePass;
  private readonly shutterBlurPass: ShutterMotionBlurPass;
  private readonly bloomPass: UnrealBloomPass;
  private readonly gravitationalLensPass: GravitationalLensPass;
  private readonly cinemaPass: ShaderPass;
  private readonly lensDustTex: THREE.CanvasTexture;
  private readonly chromaticPass: ShaderPass;
  private readonly lutPass: LutColorGradePass;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly fog: THREE.FogExp2;
  private readonly keyLight: THREE.DirectionalLight;
  private readonly hemiLight: THREE.HemisphereLight;
  private readonly envRT: THREE.WebGLRenderTarget;

  private readonly cameraDirector = new CameraDirector();
  private readonly cosmicEnv: CosmicEnvironment;
  private readonly cosmicDrift: CosmicDriftField;
  private readonly gpgpuFluid: GpgpuCosmicFluid;
  private readonly earthSeq: EarthSequence;
  private readonly figureSeq: ConstellationFigure;
  private readonly networkSeq: ConstellationNetwork;
  private readonly equilibriumSeq: CelestialEquilibrium;
  private readonly quietSeq: QuietHoursSequence;
  private readonly revealSeq: TitleReveal;
  private readonly nucleosynthesis: StellarNucleosynthesis;

  private readonly pixelRatio: number;
  private filmTime = 0;
  private elapsed = 0;
  private hasEntered = false;
  private isPlaying = false;
  private reducedMotion = false;
  private cinemaMode = false;
  private completedFired = false;

  private frameId = 0;
  private lastPerfTime = 0;
  private lastHudSync = 0;
  private cadenceAccumulator = 0;
  private taaFrameIndex = 0;
  private taaNeedsReset = true;
  private lastTaaBlend = 0;
  private lastLutLabel = 'cosmosCool';
  private lastChapterIndex = 0;
  private chapterSeekWarpPulse = 0;
  private lastGravLensState: GravitationalLensState = computeChapterTransitionLens(0, 0);
  private syncedRevealMilkyWay = false;
  private disposed = false;

  constructor(
    container: HTMLElement,
    callbacks: EngineCallbacks,
    initialState?: { entered: boolean; timeSec: number },
  ) {
    this.container = container;
    this.callbacks = callbacks;
    this.isSoftwareGl = detectSoftwareGl();
    this.isMobile = window.innerWidth < 768;
    if (initialState) {
      this.hasEntered = initialState.entered;
      this.isPlaying = initialState.entered;
      this.filmTime = clamp(initialState.timeSec, 0, FILM_DURATION);
    }

    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;
    const pixelRatio = this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    this.pixelRatio = pixelRatio;

    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isSoftwareGl,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.82;
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height);
    this.renderer.shadowMap.enabled = !this.isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.renderer.domElement.setAttribute('data-testid', 'cosmic-canvas');
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#010206');
    this.fog = new THREE.FogExp2('#010206', 0.0044);
    this.scene.fog = this.fog;

    // Restrained studio PBR reflections so brushed metals catch sharp highlights without flat wash
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = 0.36;
    pmrem.dispose();

    this.camera = new THREE.PerspectiveCamera(48, width / Math.max(1, height), 0.1, 900);
    this.camera.position.set(0, 0.3, 18);

    // High-contrast 3-point celestial lighting rig (true dark-space key/fill ratio)
    this.keyLight = new THREE.DirectionalLight(0xffdca4, 1.55);
    this.keyLight.position.set(-40, 20, -45);
    this.scene.add(this.keyLight);

    this.hemiLight = new THREE.HemisphereLight(0x3a5596, 0x05070f, 0.32);
    this.scene.add(this.hemiLight);

    const rimLight = new THREE.DirectionalLight(0x6950b5, 0.42);
    rimLight.position.set(30, -10, -350);
    this.scene.add(rimLight);

    const maxAnisotropy = this.renderer.capabilities.getMaxAnisotropy();

    // Instantiate all continuous chapters + 100k+ GPGPU fluid simulation in one shared cosmic world
    this.cosmicEnv = new CosmicEnvironment(this.isMobile, pixelRatio, maxAnisotropy);
    this.cosmicDrift = new CosmicDriftField(this.isMobile, pixelRatio);
    this.gpgpuFluid = new GpgpuCosmicFluid(this.isMobile, this.isSoftwareGl, pixelRatio);
    this.earthSeq = new EarthSequence(maxAnisotropy);
    this.figureSeq = new ConstellationFigure();
    this.networkSeq = new ConstellationNetwork(this.isMobile);
    this.equilibriumSeq = new CelestialEquilibrium(this.isMobile, pixelRatio);
    this.quietSeq = new QuietHoursSequence(maxAnisotropy);
    this.revealSeq = new TitleReveal(this.isMobile, pixelRatio);
    this.nucleosynthesis = new StellarNucleosynthesis(this.isMobile, pixelRatio);

    this.scene.add(
      this.cosmicEnv.root,
      this.cosmicDrift.root,
      this.gpgpuFluid.root,
      this.earthSeq.root,
      this.figureSeq.root,
      this.networkSeq.root,
      this.equilibriumSeq.root,
      this.quietSeq.root,
      this.revealSeq.root,
      this.nucleosynthesis.root,
    );
    this.renderer.domElement.dataset.chapter4Visual = 'celestial-equilibrium-figure8';
    this.renderer.domElement.dataset.figure8Particles = String(this.equilibriumSeq.curlParticleCount);
    this.renderer.domElement.dataset.cosmicDriftStars = String(this.cosmicDrift.starCount);
    this.renderer.domElement.dataset.nucleosynthesisParticles = String(
      this.nucleosynthesis.totalParticleCount,
    );

    // 16-bit HalfFloat HDR Hollywood Studio Post-Processing Pipeline:
    // Half-Res Velocity Buffer -> Render (Halton-jittered) -> Velocity-Reprojected TAA Resolve ->
    // 180° Shutter Motion Blur -> Subtle HDR Bloom -> 70mm Cinema Optics (Lens Dust, Hex Ghosts,
    // Shadow-Only Blue-Noise Grain, Focal Rack) -> Chromatic Aberration -> ACES Output ->
    // 32×32×32 Chapter-Specific Kodak 2383 3D LUT Color Grade
    const initialBloom = computeBloomParams(this.filmTime);
    const aspect = width / Math.max(1, height);
    const rtW = Math.max(1, Math.floor(width * pixelRatio));
    const rtH = Math.max(1, Math.floor(height * pixelRatio));
    this.velocityBuffer = new VelocityBufferRenderer(width, height, pixelRatio);
    this.composerRT = new THREE.WebGLRenderTarget(rtW, rtH, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      type: THREE.HalfFloatType,
    });
    this.composer = new EffectComposer(this.renderer, this.composerRT);
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.taaPass = new TaaResolvePass(width, height, pixelRatio, this.velocityBuffer.texture);
    this.composer.addPass(this.taaPass);
    this.shutterBlurPass = new ShutterMotionBlurPass(this.velocityBuffer.texture);
    this.composer.addPass(this.shutterBlurPass);
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(width, height),
      initialBloom.strength,
      initialBloom.radius,
      initialBloom.threshold,
    );
    this.composer.addPass(this.bloomPass);
    this.gravitationalLensPass = new GravitationalLensPass(aspect);
    this.composer.addPass(this.gravitationalLensPass);
    this.lensDustTex = createLensDustTexture(512);
    this.cinemaPass = new ShaderPass(CINEMA_OPTICS_SHADER);
    this.cinemaPass.uniforms.uAspect.value = aspect;
    this.cinemaPass.uniforms.tLensDust.value = this.lensDustTex;
    this.cinemaPass.uniforms.uHasLensDust.value = 1.0;
    this.composer.addPass(this.cinemaPass);
    this.chromaticPass = new ShaderPass(CHROMATIC_ABERRATION_SHADER);
    this.chromaticPass.uniforms.uAspect.value = aspect;
    this.composer.addPass(this.chromaticPass);
    this.composer.addPass(new OutputPass());
    this.lutPass = new LutColorGradePass();
    this.composer.addPass(this.lutPass);

    if (!this.isSoftwareGl) {
      this.renderer.compile(this.scene, this.camera);
    }

    if (this.hasEntered) {
      this.cameraDirector.snapToTime(this.camera, this.filmTime);
    }
    _prevCameraPos.copy(this.camera.position);
    _smoothCameraVel.set(0, 0, 0);

    this.bindEvents();
    this.lastPerfTime = performance.now();
    this.tick();
  }

  private bindEvents(): void {
    window.addEventListener('resize', this.handleResize);
    this.renderer.domElement.addEventListener('pointermove', this.handlePointerMove);
    this.renderer.domElement.addEventListener('pointerdown', this.handlePointerDown);
    this.renderer.domElement.addEventListener('webglcontextlost', this.handleContextLost);
  }

  private handleContextLost = (e: Event): void => {
    e.preventDefault();
    this.callbacks.onContextLost();
  };

  private handleResize = (): void => {
    if (this.disposed) return;
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    const aspect = w / Math.max(1, h);
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.velocityBuffer.setSize(w, h, this.pixelRatio);
    this.bloomPass.resolution.set(w, h);
    this.gravitationalLensPass.setAspect(aspect);
    this.cinemaPass.uniforms.uAspect.value = aspect;
    this.chromaticPass.uniforms.uAspect.value = aspect;
    this.taaNeedsReset = true;
    this.taaPass.resetHistory();
  };

  private updatePointerNdc(clientX: number, clientY: number): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    _ndc.x = ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    _ndc.y = -(((clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1);
  }

  private handlePointerMove = (e: PointerEvent): void => {
    this.updatePointerNdc(e.clientX, e.clientY);
    this.cameraDirector.setPointerOffset(_ndc.x, _ndc.y);

    // Chapter III persistent living star network interaction on pointer/touch glide
    if (this.hasEntered && this.filmTime >= 172 && this.filmTime <= 228) {
      const lit = this.networkSeq.handlePointerImpulse(_ndc.x, _ndc.y, this.camera, this.elapsed);
      if (lit > 0) {
        this.callbacks.onNetworkImpulse(this.networkSeq.getConnectionCount(), [
          _ndc.x * 6.0,
          _ndc.y * 3.5,
          -5.0,
        ]);
      }
    }
  };

  private handlePointerDown = (e: PointerEvent): void => {
    if (!this.hasEntered) return;
    this.updatePointerNdc(e.clientX, e.clientY);

    // Chapter I interactive birth star particle click/tap -> ignite Stellar Nucleosynthesis burst
    if (this.filmTime >= 75 && this.filmTime <= 109) {
      _raycaster.setFromCamera(_ndc, this.camera);
      const hits = _raycaster.intersectObject(this.earthSeq.interactiveStarHitbox, false);
      if (hits.length > 0 && this.earthSeq.triggerBirthStar()) {
        this.earthSeq.getBirthStarWorldPosition(_projWorldPos);
        this.nucleosynthesis.spawnBurst([_projWorldPos.x, _projWorldPos.y, _projWorldPos.z], 0.76, 6.8, 5.2);
        this.callbacks.onBirthStarTriggered();
      }
    }

    // Chapter III click/tap impulse -> localized Stellar Nucleosynthesis spark burst
    if (this.filmTime >= 172 && this.filmTime <= 228) {
      const lit = this.networkSeq.handlePointerImpulse(_ndc.x, _ndc.y, this.camera, this.elapsed);
      if (lit > 0) {
        this.nucleosynthesis.spawnBurst([_ndc.x * 9.0, _ndc.y * 5.0, -255], 0.82, 11.5, 4.2);
        this.callbacks.onNetworkImpulse(this.networkSeq.getConnectionCount(), [
          _ndc.x * 6.0,
          _ndc.y * 3.5,
          -5.0,
        ]);
      }
    }
  };

  private snapCameraClean(timeSec: number): void {
    this.cameraDirector.snapToTime(this.camera, timeSec);
    _prevCameraPos.copy(this.camera.position);
    _smoothCameraVel.set(0, 0, 0);
    this.taaNeedsReset = true;
    this.taaPass.resetHistory();
    this.velocityBuffer.resetHistory();
  }

  public enterUniverse(startAtTime = 0): void {
    this.hasEntered = true;
    this.isPlaying = true;
    this.completedFired = false;
    this.filmTime = clamp(startAtTime, 0, FILM_DURATION);
    this.snapCameraClean(this.filmTime);
    this.syncHud(true);
  }

  public setPlaying(playing: boolean): void {
    this.isPlaying = playing;
  }

  public setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
  }

  public setCinemaMode(enabled: boolean): void {
    this.cinemaMode = enabled;
    this.cadenceAccumulator = 0;
    this.syncHud(true);
  }

  public seekTo(timeSec: number): void {
    const prevChapter = getChapterAtTime(this.filmTime).index;
    this.filmTime = clamp(timeSec, 0, FILM_DURATION);
    const nextChapter = getChapterAtTime(this.filmTime).index;
    if (nextChapter !== prevChapter) {
      this.chapterSeekWarpPulse = 0.92;
      this.lastChapterIndex = nextChapter;
      this.callbacks.onChapterTransition?.(nextChapter);
    }
    if (this.filmTime < FILM_DURATION - 0.5) {
      this.completedFired = false;
    }
    this.snapCameraClean(this.filmTime);
    this.syncHud(true);
  }

  public replay(): void {
    this.earthSeq.resetInteraction();
    this.completedFired = false;
    this.hasEntered = true;
    this.isPlaying = true;
    this.filmTime = 0;
    this.snapCameraClean(0);
    this.syncHud(true);
  }

  public triggerBirthStarAccessible(): boolean {
    const ok = this.earthSeq.triggerBirthStar();
    if (ok) {
      this.earthSeq.getBirthStarWorldPosition(_projWorldPos);
      this.nucleosynthesis.spawnBurst([_projWorldPos.x, _projWorldPos.y, _projWorldPos.z], 0.76, 6.8, 5.2);
      this.callbacks.onBirthStarTriggered();
      this.syncHud(true);
    }
    return ok;
  }

  public triggerNetworkPulseAccessible(): number {
    const lit = this.networkSeq.triggerAccessiblePulse();
    if (lit > 0) {
      this.nucleosynthesis.spawnBurst([0, 0.5, -255], 0.88, 13.0, 4.6);
      this.callbacks.onNetworkImpulse(this.networkSeq.getConnectionCount());
      this.syncHud(true);
    }
    return lit;
  }

  private computeGuidingStarState(t: number): number {
    // One continuous luminous anchor star threading through every single act
    if (t < 55) {
      // Emerges from Big Bang and glides toward Solar System
      const p = smoothstep(8, 55, t);
      _guidingTarget.set(
        THREE.MathUtils.lerp(0, -14, p),
        THREE.MathUtils.lerp(0, 6, p),
        THREE.MathUtils.lerp(0, -68, p),
      );
      return 1.6;
    }
    if (t < 110) {
      // Orbits gently near Earth & rises toward Chapter II
      const p = smoothstep(55, 110, t);
      _guidingTarget.set(
        THREE.MathUtils.lerp(-14, 0, p),
        THREE.MathUtils.lerp(6, 6.5, p),
        THREE.MathUtils.lerp(-68, -172, p * p),
      );
      return 1.35;
    }
    if (t < 175) {
      // Rests at Kaus Media, the luminous heart of Sagittarius where bow and arrow meet
      _guidingTarget.set(1.55, 4.75, -174.62);
      return 1.35;
    }
    if (t < 225) {
      // Becomes the pulsing gravitational origin of Chapter III
      _guidingTarget.set(0, 0, -255);
      return 2.1;
    }
    if (t < 285) {
      // Bridges the center of the Yin-Yang harmonic S-curve
      _guidingTarget.set(0, 0, -340);
      return 1.65;
    }
    if (t < 335) {
      // Hovers calmly outside the Chapter V sanctuary window like a quiet evening star
      _guidingTarget.set(3.2, 2.8, -428);
      return 1.25;
    }
    // Final Chapter: settles dead-center in cosmic silence, then blossoms at the reveal
    _guidingTarget.set(0, 0, -515);
    const silenceHold = smoothstep(SILENCE_START - 1.5, SILENCE_START + 0.5, t);
    const postBurst = smoothstep(SILENCE_END, SILENCE_END + 3.2, t);
    return 1.8 + silenceHold * 1.6 - postBurst * 1.1;
  }

  private syncHud(force = false): void {
    const now = performance.now();
    if (!force && now - this.lastHudSync < 120) return;
    this.lastHudSync = now;
    const canvas = this.renderer.domElement;
    canvas.dataset.bloomStrength = this.bloomPass.strength.toFixed(2);
    canvas.dataset.bloomThreshold = this.bloomPass.threshold.toFixed(2);
    canvas.dataset.taaActive = this.isSoftwareGl ? 'software-fallback' : 'active';
    canvas.dataset.taaBlend = this.lastTaaBlend.toFixed(2);
    canvas.dataset.velocityBuffer = this.isSoftwareGl ? 'software-fallback' : 'half-res-active';
    canvas.dataset.lutGrade = this.lastLutLabel;
    canvas.dataset.hipparcosStars = String(this.cosmicEnv.getHipparcosStarCount());
    canvas.dataset.gpgpuParticles = String(this.gpgpuFluid.particleCount);
    canvas.dataset.cinemaMode = this.cinemaMode ? 'imax-24fps' : 'native';
    canvas.dataset.parallaxShift = this.cosmicEnv.getNearParallaxMagnitude().toFixed(2);
    canvas.dataset.debrisShift = this.cosmicEnv.getDebrisParallaxMagnitude().toFixed(2);
    const driftState = this.cosmicDrift.getState();
    canvas.dataset.cosmicDriftOpacity = driftState.opacity.toFixed(3);
    canvas.dataset.cosmicDriftScroll = Math.hypot(driftState.scrollX, driftState.scrollY, driftState.scrollZ).toFixed(2);
    canvas.dataset.nucleosynthesisBursts = String(this.nucleosynthesis.getTotalSpawnedBursts());
    canvas.dataset.nucleosynthesisActive = String(this.nucleosynthesis.getActiveBurstCount());
    canvas.dataset.gravLensStrength = this.lastGravLensState.strength.toFixed(3);
    canvas.dataset.gravLensTransition = String(this.lastGravLensState.transitionIndex);
    canvas.dataset.exposure = this.renderer.toneMappingExposure.toFixed(2);
    canvas.dataset.chromaticIntensity = (
      this.chromaticPass.uniforms.uIntensity.value as number
    ).toFixed(4);
    canvas.dataset.sagittariusEdges = String(this.figureSeq.getCompletedEdgesCount());
    canvas.dataset.texturesLoaded = `${
      this.earthSeq.getLoadedTextureCount() + this.cosmicEnv.getLoadedTextureCount()
    }/7`;
    this.callbacks.onTimeUpdate(
      this.filmTime,
      this.networkSeq.getConnectionCount(),
      this.earthSeq.isBirthStarTriggered(),
    );
  }

  private afterDraw(cb: () => void): void {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    if (gl && typeof gl.fenceSync === 'function') {
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      const poll = () => {
        if (this.disposed) {
          if (sync) gl.deleteSync(sync);
          return;
        }
        const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
        if (state === gl.UNSIGNALED) {
          this.frameId = window.setTimeout(poll, 5);
        } else {
          if (sync) gl.deleteSync(sync);
          this.frameId = window.setTimeout(cb, 80);
        }
      };
      this.frameId = window.setTimeout(poll, 5);
    } else {
      this.frameId = window.setTimeout(cb, 80);
    }
  }

  private tick = (): void => {
    if (this.disposed) return;

    const now = performance.now();
    const rawDelta = (now - this.lastPerfTime) / 1000;
    this.lastPerfTime = now;
    const delta = clamp(rawDelta, 0.001, 0.2);

    const motionScale = this.reducedMotion ? 0.25 : 1.0;
    this.elapsed += delta * motionScale;

    if (this.hasEntered && this.isPlaying) {
      this.filmTime = Math.min(FILM_DURATION, this.filmTime + delta);
      if (this.filmTime >= FILM_DURATION && !this.completedFired) {
        this.completedFired = true;
        this.isPlaying = false;
        this.callbacks.onFilmComplete();
      }
    }

    // Smooth atmospheric fog & background tinting per chapter
    const activeChapter = getChapterAtTime(this.filmTime);
    if (this.hasEntered && activeChapter.index !== this.lastChapterIndex) {
      this.lastChapterIndex = activeChapter.index;
      this.callbacks.onChapterTransition?.(activeChapter.index);
    }
    const nextChapter = CHAPTERS[Math.min(activeChapter.index + 1, CHAPTERS.length - 1)];
    const blendToNext = smoothstep(activeChapter.end - 6, activeChapter.end, this.filmTime);

    _nextFogColor.set(nextChapter.fogColor);
    _targetFogColor.set(activeChapter.fogColor).lerp(_nextFogColor, blendToNext);
    const fogAlpha = 1 - Math.exp(-2.0 * delta);
    this.fog.color.lerp(_targetFogColor, fogAlpha);
    if (this.scene.background instanceof THREE.Color) {
      this.scene.background.lerp(_targetFogColor, fogAlpha);
    }
    this.fog.density = THREE.MathUtils.lerp(
      this.fog.density,
      THREE.MathUtils.lerp(activeChapter.fogDensity, nextChapter.fogDensity, blendToNext),
      fogAlpha,
    );

    // Update continuous camera choreography
    this.cameraDirector.update(this.camera, this.filmTime, delta, this.reducedMotion);

    // Compute smooth camera velocity & apply depth-based parallax to starfields, nebulae & galaxies
    const invDelta = 1 / Math.max(delta, 0.008);
    _instCameraVel
      .copy(this.camera.position)
      .sub(_prevCameraPos)
      .multiplyScalar(invDelta);
    _prevCameraPos.copy(this.camera.position);
    const velAlpha = 1 - Math.exp(-5.0 * delta);
    _smoothCameraVel.lerp(_instCameraVel, velAlpha);

    this.cameraDirector.getSmoothedPointer(_smoothedPointer);
    const silenceDip =
      smoothstep(SILENCE_START - 1.5, SILENCE_START + 0.5, this.filmTime) *
      (1 - smoothstep(SILENCE_END, SILENCE_END + 2.0, this.filmTime));
    _parallaxInput.cameraPos.x = this.camera.position.x;
    _parallaxInput.cameraPos.y = this.camera.position.y;
    _parallaxInput.cameraPos.z = this.camera.position.z;
    _parallaxInput.cameraVelocity.x = _smoothCameraVel.x;
    _parallaxInput.cameraVelocity.y = _smoothCameraVel.y;
    _parallaxInput.cameraVelocity.z = _smoothCameraVel.z;
    _parallaxInput.pointerOffset.x = _smoothedPointer.x;
    _parallaxInput.pointerOffset.y = _smoothedPointer.y;
    _parallaxOptions.reducedMotion = this.reducedMotion;
    _parallaxOptions.silenceDamp = 1 - silenceDip * 0.85;

    // Update Guiding Star & all 7 continuous scene layers
    const guidingScale = this.computeGuidingStarState(this.filmTime);
    this.cosmicEnv.update(
      this.filmTime,
      this.elapsed,
      delta,
      this.hasEntered,
      _guidingTarget,
      guidingScale,
      this.camera.quaternion,
    );
    this.cosmicEnv.applyParallax(_parallaxInput, delta, _parallaxOptions);
    this.cosmicDrift.update(
      this.filmTime,
      this.elapsed,
      delta,
      this.hasEntered,
      this.reducedMotion,
      _parallaxInput,
      _parallaxOptions,
    );
    this.earthSeq.update(this.filmTime, this.elapsed, delta);
    this.figureSeq.update(this.filmTime, this.elapsed);
    this.networkSeq.update(this.filmTime, this.elapsed);
    this.equilibriumSeq.update(this.filmTime, this.elapsed);
    this.quietSeq.update(this.filmTime, this.elapsed);
    this.revealSeq.update(this.filmTime, this.elapsed);
    this.nucleosynthesis.update(
      this.filmTime,
      this.elapsed,
      delta,
      this.camera.quaternion,
      this.hasEntered,
      (intensity) => this.callbacks.onNucleosynthesisBurst?.(intensity),
    );

    // Share loaded 4K Milky Way texture with Final Convergence geodesic black hole
    if (!this.syncedRevealMilkyWay) {
      const mwTex = this.cosmicEnv.getMilkyWayTexture();
      if (mwTex) {
        this.revealSeq.setMilkyWayTexture(mwTex);
        this.syncedRevealMilkyWay = true;
      }
    }

    // Update 100k+ GPGPU ping-pong fluid simulation with cursor & live audio bass
    const audioBass = this.callbacks.getAudioBass ? this.callbacks.getAudioBass() : 0;
    this.gpgpuFluid.update(
      this.renderer,
      this.filmTime,
      this.elapsed,
      delta,
      this.hasEntered,
      _smoothedPointer,
      audioBass,
    );

    // Push live 3D Guiding Star camera-relative coordinates to HRTF binaural panner
    if (this.callbacks.onSpatialAnchor) {
      _projWorldPos.copy(this.cosmicEnv.guidingStar.position).sub(this.camera.position);
      this.callbacks.onSpatialAnchor(
        _projWorldPos.x * 0.25,
        _projWorldPos.y * 0.25,
        -Math.max(2.5, Math.abs(_projWorldPos.z) * 0.2),
      );
    }

    // Chapter-adaptive Unreal-style Gaussian bloom & real-time dynamic HDR exposure
    const bloomTarget = computeBloomParams(this.filmTime);
    this.bloomPass.strength = THREE.MathUtils.damp(
      this.bloomPass.strength,
      bloomTarget.strength,
      4.0,
      delta,
    );
    this.bloomPass.radius = THREE.MathUtils.damp(
      this.bloomPass.radius,
      bloomTarget.radius,
      4.0,
      delta,
    );
    this.bloomPass.threshold = THREE.MathUtils.damp(
      this.bloomPass.threshold,
      bloomTarget.threshold,
      4.0,
      delta,
    );

    const camSpeed = _smoothCameraVel.length();
    const optics = computeCinemaOptics(this.filmTime, camSpeed, this.reducedMotion);
    const presentation = computeCinemaPresentation(
      this.filmTime,
      this.cinemaMode,
      this.reducedMotion,
    );
    const lutWeights = computeChapterLutWeights(this.filmTime);
    this.lastLutLabel = lutWeights.activeLabel;
    this.lutPass.setWeights(lutWeights);
    this.shutterBlurPass.setShutterScale(this.reducedMotion ? 0.0 : this.cinemaMode ? 0.52 : 0.36);

    // Chapter-transition Gravitational Lens shader pass (subtle Schwarzschild light bending)
    if (this.chapterSeekWarpPulse > 0.001) {
      this.chapterSeekWarpPulse = Math.max(0, this.chapterSeekWarpPulse - delta * 0.52);
    }
    const gravLens = computeChapterTransitionLens(this.filmTime, this.chapterSeekWarpPulse);
    this.lastGravLensState = gravLens;
    this.gravitationalLensPass.applyState(gravLens, this.elapsed);

    this.renderer.toneMappingExposure = THREE.MathUtils.damp(
      this.renderer.toneMappingExposure,
      optics.exposure,
      4.2,
      delta,
    );

    // Project gravitational lens anchor & primary anamorphic flare source into screen UV [0..1]
    this.camera.updateMatrixWorld();
    const uCinema = this.cinemaPass.uniforms;
    uCinema.uTime.value = this.elapsed;
    uCinema.uFrameIndex.value = this.taaFrameIndex;
    uCinema.uFocalRack.value = THREE.MathUtils.damp(
      uCinema.uFocalRack.value as number,
      presentation.focalRackStrength,
      4.2,
      delta,
    );
    uCinema.uLensStrength.value = THREE.MathUtils.damp(
      uCinema.uLensStrength.value as number,
      optics.lensStrength,
      4.5,
      delta,
    );
    uCinema.uAnamorphicIntensity.value = THREE.MathUtils.damp(
      uCinema.uAnamorphicIntensity.value as number,
      optics.anamorphicIntensity,
      4.5,
      delta,
    );
    uCinema.uBokehStrength.value = THREE.MathUtils.damp(
      uCinema.uBokehStrength.value as number,
      optics.bokehStrength,
      4.0,
      delta,
    );
    uCinema.uHalationStrength.value = THREE.MathUtils.damp(
      uCinema.uHalationStrength.value as number,
      optics.halationStrength,
      4.0,
      delta,
    );

    // Update dedicated screen-space peripheral chromatic aberration pass
    this.chromaticPass.uniforms.uIntensity.value = THREE.MathUtils.damp(
      this.chromaticPass.uniforms.uIntensity.value as number,
      optics.chromaticIntensity,
      5.0,
      delta,
    );

    // Gravitational lensing center: Prologue Singularity (0,0,0) or Final Convergence (0,0,-515)
    if (this.filmTime < 120) {
      _projWorldPos.set(0, 0, 0);
    } else {
      _projWorldPos.set(0, 0, -515);
    }
    _projWorldPos.project(this.camera);
    (uCinema.uLensCenter.value as THREE.Vector2).set(
      _projWorldPos.x * 0.5 + 0.5,
      _projWorldPos.y * 0.5 + 0.5,
    );

    // Anamorphic 70mm streak + lens dust / hexagonal ghost source
    if (this.filmTime >= 52 && this.filmTime <= 106) {
      this.earthSeq.getSunWorldPosition(_projWorldPos);
    } else if (this.filmTime < 44) {
      _projWorldPos.set(0, 0, 0);
    } else {
      _projWorldPos.copy(this.cosmicEnv.guidingStar.position);
    }
    _projWorldPos.project(this.camera);
    // The anchor star is hidden through Chapter V's night, so its flare must not linger there either
    const quietHoursNight = this.filmTime > 289 && this.filmTime < 335;
    const inFront = _projWorldPos.z < 1.0 && !quietHoursNight;
    (uCinema.uFlareCenter.value as THREE.Vector2).set(
      inFront ? _projWorldPos.x * 0.5 + 0.5 : -2.0,
      inFront ? _projWorldPos.y * 0.5 + 0.5 : -2.0,
    );

    // Temporal Anti-Aliasing (TAA) motion-adaptive blend & Halton(2,3) sub-pixel projection jitter
    const taaBlend = computeTaaBlendFactor(camSpeed, this.reducedMotion, this.taaNeedsReset);
    this.lastTaaBlend = taaBlend;
    this.taaPass.setBlendFactor(taaBlend);

    // Optional 24fps filmic shutter cadence pacing in Cinema Presentation mode (GPU only)
    let shouldPresent = true;
    if (!this.isSoftwareGl && presentation.cadenceFps > 0 && !this.taaNeedsReset) {
      this.cadenceAccumulator += delta;
      const frameStep = 1 / presentation.cadenceFps;
      if (this.cadenceAccumulator < frameStep) {
        shouldPresent = false;
      } else {
        this.cadenceAccumulator %= frameStep;
      }
    }

    if (shouldPresent) {
      if (this.isSoftwareGl) {
        this.renderer.render(this.scene, this.camera);
      } else {
        // 1. Render lightweight half-res per-object + sky screen-space velocity buffer (unjittered)
        this.velocityBuffer.render(this.renderer, this.scene, this.camera);

        // 2. Apply Halton(2,3) sub-pixel jitter strictly around EffectComposer pass
        const renderW = Math.max(1, this.renderer.domElement.width);
        const renderH = Math.max(1, this.renderer.domElement.height);
        computeTaaJitter(this.taaFrameIndex++, renderW, renderH, _taaJitter);

        const origProj8 = this.camera.projectionMatrix.elements[8];
        const origProj9 = this.camera.projectionMatrix.elements[9];
        this.camera.projectionMatrix.elements[8] = origProj8 + _taaJitter.ndcX;
        this.camera.projectionMatrix.elements[9] = origProj9 + _taaJitter.ndcY;
        this.composer.render();
        // Immediately restore unjittered projection for raycasting & optics
        this.camera.projectionMatrix.elements[8] = origProj8;
        this.camera.projectionMatrix.elements[9] = origProj9;
      }
      this.taaNeedsReset = false;
    }
    this.syncHud(false);

    if (this.isSoftwareGl) {
      this.afterDraw(this.tick);
    } else {
      this.frameId = requestAnimationFrame(this.tick);
    }
  };

  public dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    clearTimeout(this.frameId);

    window.removeEventListener('resize', this.handleResize);
    this.renderer.domElement.removeEventListener('pointermove', this.handlePointerMove);
    this.renderer.domElement.removeEventListener('pointerdown', this.handlePointerDown);
    this.renderer.domElement.removeEventListener('webglcontextlost', this.handleContextLost);

    this.cosmicEnv.dispose();
    this.cosmicDrift.dispose();
    this.gpgpuFluid.dispose();
    this.earthSeq.dispose();
    this.figureSeq.dispose();
    this.networkSeq.dispose();
    this.equilibriumSeq.dispose();
    this.quietSeq.dispose();
    this.revealSeq.dispose();
    this.nucleosynthesis.dispose();
    this.lutPass.dispose();
    this.chromaticPass.dispose();
    this.cinemaPass.dispose();
    this.lensDustTex.dispose();
    this.gravitationalLensPass.dispose();
    this.bloomPass.dispose();
    this.shutterBlurPass.dispose();
    this.taaPass.dispose();
    this.velocityBuffer.dispose();
    this.composer.dispose();
    this.composerRT.dispose();
    this.envRT.dispose();
    this.renderer.dispose();

    if (this.renderer.domElement.parentNode === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
