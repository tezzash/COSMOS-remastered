import * as THREE from 'three';
import { SILENCE_END, SILENCE_START, clamp, smoothstep } from '../../data/chapters';
import { buildHyderabadHipparcosStarfield } from '../hipparcos';
import { type ParallaxInput, type ParallaxOptions, writeParallaxOffset } from '../parallax';
import {
  BIG_BANG_FRAGMENT_SHADER,
  BIG_BANG_VERTEX_SHADER,
  GEODESIC_SINGULARITY_FRAGMENT_SHADER,
  GEODESIC_SINGULARITY_VERTEX_SHADER,
  GOD_RAYS_FRAGMENT_SHADER,
  GOD_RAYS_VERTEX_SHADER,
  MILKY_WAY_SKY_FRAGMENT_SHADER,
  MILKY_WAY_SKY_VERTEX_SHADER,
  NEAR_DEBRIS_FRAGMENT_SHADER,
  NEAR_DEBRIS_VERTEX_SHADER,
  NEBULA_FRAGMENT_SHADER,
  NEBULA_VERTEX_SHADER,
  STARFIELD_FRAGMENT_SHADER,
  STARFIELD_VERTEX_SHADER,
  createNebulaCloudTexture,
  createSoftGlowTexture,
} from '../shaders';

const _parallaxTarget = new THREE.Vector3();

function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Global deep-space environment shared continuously across all chapters:
 * - Three parallax blackbody starfield layers with 4-point telescope diffraction spikes
 * - Ultra-near spatial micro-dust & bokeh debris layer (highest parallax depth factor)
 * - Volumetric self-shadowed nebula clouds tinted deep midnight blue, violet & ancient gold
 * - Three distant inclined spiral galaxies
 * - Opening Prologue Gargantua-inspired relativistic accretion disk & curl-noise Big Bang
 * - Persistent Guiding Star anchor with crepuscular god-rays weaving through every chapter
 */
export class CosmicEnvironment {
  public readonly root = new THREE.Group();
  public readonly guidingStar = new THREE.Group();

  private readonly starMaterials: THREE.ShaderMaterial[] = [];
  private readonly starfieldLayers: Array<{ mat: THREE.ShaderMaterial; depthFactor: number }> = [];
  private readonly hipparcosPoints: THREE.Points;
  private readonly hipparcosMat: THREE.ShaderMaterial;
  private readonly hipparcosCount: number;
  private readonly nearDebrisMat: THREE.ShaderMaterial;
  private readonly nearDebrisDepthFactor = 0.92;
  private readonly nebulaMeshes: THREE.Mesh[] = [];
  private readonly nebulaMaterials: THREE.ShaderMaterial[] = [];
  private readonly galaxies: THREE.Points[] = [];
  private readonly bigBangGroup = new THREE.Group();
  private readonly bigBangMat: THREE.ShaderMaterial;
  private readonly singularityGeodesicMat: THREE.ShaderMaterial;
  private readonly singularitySphere: THREE.Mesh;
  private readonly singularityCore: THREE.Sprite;
  private readonly singularityHalo: THREE.Sprite;
  private readonly guidingCore: THREE.Sprite;
  private readonly guidingHalo: THREE.Sprite;
  private readonly guidingRaysMesh: THREE.Mesh;
  private readonly guidingRaysMat: THREE.ShaderMaterial;
  private readonly guidingLight: THREE.PointLight;
  private readonly milkyWaySphere: THREE.Mesh;
  private readonly milkyWayMat: THREE.ShaderMaterial;
  private readonly disposables: Array<{ dispose: () => void }> = [];

  private milkyWayTexture: THREE.Texture | null = null;
  private milkyWayLoaded = false;
  private disposed = false;

  constructor(isMobile: boolean, pixelRatio: number, maxAnisotropy = 4) {
    const rand = seededRandom(20021125);
    const scaleFactor = isMobile ? 0.55 : 1.0;

    // 0. Deep-space 4K Milky Way Celestial Sphere (follows camera; dark-cinema contrast-crushed)
    const skyFallbackData = new Uint8Array([1, 2, 6, 255]);
    const skyFallbackTex = new THREE.DataTexture(skyFallbackData, 1, 1);
    skyFallbackTex.needsUpdate = true;

    const skyGeo = new THREE.SphereGeometry(460, 48, 32);
    this.milkyWayMat = new THREE.ShaderMaterial({
      vertexShader: MILKY_WAY_SKY_VERTEX_SHADER,
      fragmentShader: MILKY_WAY_SKY_FRAGMENT_SHADER,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uMap: { value: skyFallbackTex },
        uOpacity: { value: 0 },
      },
    });
    this.milkyWaySphere = new THREE.Mesh(skyGeo, this.milkyWayMat);
    this.milkyWaySphere.renderOrder = -10;
    this.milkyWaySphere.frustumCulled = false;
    this.milkyWaySphere.rotation.set(0.38, -0.65, 0.24);
    this.root.add(this.milkyWaySphere);
    this.disposables.push(skyFallbackTex, skyGeo, this.milkyWayMat);

    const skyLoader = new THREE.TextureLoader();
    skyLoader.load('/textures/milky_way_4k.jpg', (tex) => {
      if (this.disposed) {
        tex.dispose();
        return;
      }
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = maxAnisotropy;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = true;
      tex.needsUpdate = true;
      this.milkyWayMat.uniforms.uMap.value = tex;
      this.singularityGeodesicMat.uniforms.uMilkyWayMap.value = tex;
      this.singularityGeodesicMat.uniforms.uHasMilkyWay.value = 1.0;
      this.milkyWayTexture = tex;
      this.disposables.push(tex);
      this.milkyWayLoaded = true;
    });

    // 0b. Real Astronomical Hipparcos / Gaia Star Catalog Vault (~9,000 stars on desktop,
    //     4,800 on mobile) oriented precisely to the Hyderabad sky on 25 November 2002
    const hipCount = isMobile ? 4800 : 9000;
    const hipData = buildHyderabadHipparcosStarfield(hipCount, 385);
    this.hipparcosCount = hipData.count;
    const hipGeo = new THREE.BufferGeometry();
    hipGeo.setAttribute('position', new THREE.BufferAttribute(hipData.positions, 3));
    hipGeo.setAttribute('aScale', new THREE.BufferAttribute(hipData.scales, 1));
    hipGeo.setAttribute('aPhase', new THREE.BufferAttribute(hipData.phases, 1));
    hipGeo.setAttribute('aColor', new THREE.BufferAttribute(hipData.colors, 3));

    this.hipparcosMat = new THREE.ShaderMaterial({
      vertexShader: STARFIELD_VERTEX_SHADER,
      fragmentShader: STARFIELD_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: pixelRatio },
        uOpacity: { value: 0 },
        uBurst: { value: 0 },
        uParallaxOffset: { value: new THREE.Vector3() },
        uVelocityStretch: { value: 0 },
      },
    });
    this.hipparcosPoints = new THREE.Points(hipGeo, this.hipparcosMat);
    this.hipparcosPoints.frustumCulled = false;
    this.hipparcosPoints.renderOrder = -8;
    this.root.add(this.hipparcosPoints);
    this.starMaterials.push(this.hipparcosMat);
    this.disposables.push(hipGeo, this.hipparcosMat);

    // 1. Multi-layer parallax corridor starfields spanning the entire Z corridor (+60 to -620)
    // Ordered far -> mid -> near with increasing depthFactor so distant stars move slower
    const layers = [
      { count: Math.round(1400 * scaleFactor), radiusMin: 85, radiusMax: 240, sizeMin: 1.0, sizeMax: 2.9, depthFactor: 0.1 },
      { count: Math.round(1200 * scaleFactor), radiusMin: 40, radiusMax: 130, sizeMin: 1.4, sizeMax: 3.7, depthFactor: 0.28 },
      { count: Math.round(480 * scaleFactor), radiusMin: 18, radiusMax: 72, sizeMin: 2.1, sizeMax: 4.8, depthFactor: 0.56 },
    ];

    // True Planckian blackbody spectral star palette (O -> B -> A/F -> G -> K -> M)
    const palette = [
      new THREE.Color('#9bb8ff'), // O-type deep sapphire blue
      new THREE.Color('#cadcff'), // B/A-type luminous blue-white
      new THREE.Color('#f7f9ff'), // F-type crisp astronomical white
      new THREE.Color('#fff2d6'), // G-type warm solar cream
      new THREE.Color('#ffd194'), // K-type restrained amber gold
      new THREE.Color('#ffae68'), // M-type subtle ember gold
      new THREE.Color('#cbbcff'), // Pale celestial violet star
    ];

    layers.forEach((layer) => {
      const geo = new THREE.BufferGeometry();
      const positions = new Float32Array(layer.count * 3);
      const scales = new Float32Array(layer.count);
      const phases = new Float32Array(layer.count);
      const colors = new Float32Array(layer.count * 3);

      for (let i = 0; i < layer.count; i++) {
        const theta = rand() * Math.PI * 2;
        const r = layer.radiusMin + Math.pow(rand(), 0.72) * (layer.radiusMax - layer.radiusMin);
        const z = 75 - rand() * 720;
        positions[i * 3] = Math.cos(theta) * r;
        positions[i * 3 + 1] = Math.sin(theta) * r * 0.72;
        positions[i * 3 + 2] = z;

        // Power-law stellar magnitude distribution: most pinpoint, rare bright diffraction stars
        scales[i] = layer.sizeMin + Math.pow(rand(), 2.65) * (layer.sizeMax - layer.sizeMin);
        phases[i] = rand();

        const col = palette[Math.floor(rand() * palette.length)];
        colors[i * 3] = col.r;
        colors[i * 3 + 1] = col.g;
        colors[i * 3 + 2] = col.b;
      }

      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('aScale', new THREE.BufferAttribute(scales, 1));
      geo.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
      geo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));

      const mat = new THREE.ShaderMaterial({
        vertexShader: STARFIELD_VERTEX_SHADER,
        fragmentShader: STARFIELD_FRAGMENT_SHADER,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uTime: { value: 0 },
          uPixelRatio: { value: pixelRatio },
          uOpacity: { value: 0 },
          uBurst: { value: 0 },
          uParallaxOffset: { value: new THREE.Vector3() },
          uVelocityStretch: { value: 0 },
        },
      });

      const pts = new THREE.Points(geo, mat);
      pts.frustumCulled = false;
      this.root.add(pts);
      this.starMaterials.push(mat);
      this.starfieldLayers.push({ mat, depthFactor: layer.depthFactor });
      this.disposables.push(geo, mat);
    });

    // 1b. Ultra-near spatial micro-dust & ice-crystal debris layer (highest parallax factor 0.92)
    // Wraps seamlessly around the camera so foreground bokeh scale cues persist across every chapter
    const debrisCount = Math.round(210 * scaleFactor);
    const debrisGeo = new THREE.BufferGeometry();
    const dPos = new Float32Array(debrisCount * 3);
    const dScale = new Float32Array(debrisCount);
    const dPhase = new Float32Array(debrisCount);
    const dCol = new Float32Array(debrisCount * 3);
    const debrisPalette = [
      new THREE.Color('#fff1d4'),
      new THREE.Color('#c8dcff'),
      new THREE.Color('#e8c78a'),
      new THREE.Color('#b6a8e8'),
    ];
    for (let i = 0; i < debrisCount; i++) {
      dPos[i * 3] = (rand() - 0.5) * 34.0;
      dPos[i * 3 + 1] = (rand() - 0.5) * 22.0;
      dPos[i * 3 + 2] = (rand() - 0.5) * 36.0;
      dScale[i] = 1.2 + Math.pow(rand(), 1.8) * 3.4;
      dPhase[i] = rand();
      const c = debrisPalette[Math.floor(rand() * debrisPalette.length)];
      dCol[i * 3] = c.r;
      dCol[i * 3 + 1] = c.g;
      dCol[i * 3 + 2] = c.b;
    }
    debrisGeo.setAttribute('position', new THREE.BufferAttribute(dPos, 3));
    debrisGeo.setAttribute('aScale', new THREE.BufferAttribute(dScale, 1));
    debrisGeo.setAttribute('aPhase', new THREE.BufferAttribute(dPhase, 1));
    debrisGeo.setAttribute('aColor', new THREE.BufferAttribute(dCol, 3));

    this.nearDebrisMat = new THREE.ShaderMaterial({
      vertexShader: NEAR_DEBRIS_VERTEX_SHADER,
      fragmentShader: NEAR_DEBRIS_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: pixelRatio },
        uOpacity: { value: 0 },
        uCameraPos: { value: new THREE.Vector3(0, 0.3, 18) },
        uParallaxOffset: { value: new THREE.Vector3() },
        uEarthCenter: { value: new THREE.Vector3(0, 0, -90) },
        uEarthRadius: { value: 8.2 },
        uSunDir: { value: new THREE.Vector3(-0.78, 0.28, 0.55).normalize() },
        uEclipseActive: { value: 0 },
      },
    });
    const debrisPoints = new THREE.Points(debrisGeo, this.nearDebrisMat);
    debrisPoints.frustumCulled = false;
    this.root.add(debrisPoints);
    this.disposables.push(debrisGeo, this.nearDebrisMat);

    // 2. Volumetric self-shadowed nebula clouds distributed along the journey (restrained, moody deep-space density)
    const nebulaConfigs = [
      { pos: [-22, 10, -28], scale: 98, seed: 1.3, cA: '#0f2559', cB: '#382068', cG: '#a87d3c', op: 0.36, depth: 0.24 },
      { pos: [30, -12, -125], scale: 118, seed: 3.7, cA: '#0d2659', cB: '#2f1e5c', cG: '#ad8240', op: 0.30, depth: 0.34 },
      { pos: [-28, 14, -210], scale: 124, seed: 6.2, cA: '#101f52', cB: '#3b216b', cG: '#ad8848', op: 0.28, depth: 0.28 },
      { pos: [26, 8, -310], scale: 128, seed: 9.4, cA: '#0f2257', cB: '#402475', cG: '#b5904f', op: 0.32, depth: 0.38 },
      { pos: [-20, -8, -455], scale: 135, seed: 12.1, cA: '#0e224a', cB: '#311f5c', cG: '#b08b4c', op: 0.26, depth: 0.22 },
      { pos: [0, 4, -565], scale: 168, seed: 15.8, cA: '#0e2048', cB: '#362266', cG: '#bf9c5a', op: 0.34, depth: 0.3 },
    ];

    const planeGeo = new THREE.PlaneGeometry(1, 1);
    this.disposables.push(planeGeo);

    nebulaConfigs.forEach((cfg) => {
      const tex = createNebulaCloudTexture(cfg.seed, cfg.cA, cfg.cB, cfg.cG, 512);
      const mat = new THREE.ShaderMaterial({
        vertexShader: NEBULA_VERTEX_SHADER,
        fragmentShader: NEBULA_FRAGMENT_SHADER,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        uniforms: {
          uOpacity: { value: 0 },
          uMap: { value: tex },
          uLightDir: { value: new THREE.Vector2(-0.6, 0.5).normalize() },
          uTime: { value: 0 },
        },
      });
      mat.userData.baseOpacity = cfg.op;
      const mesh = new THREE.Mesh(planeGeo, mat);
      mesh.position.set(cfg.pos[0], cfg.pos[1], cfg.pos[2]);
      mesh.scale.set(cfg.scale, cfg.scale * 0.72, 1);
      mesh.rotation.z = cfg.seed * 0.4;
      mesh.userData.basePos = new THREE.Vector3(cfg.pos[0], cfg.pos[1], cfg.pos[2]);
      mesh.userData.depthFactor = cfg.depth;
      this.root.add(mesh);
      this.nebulaMeshes.push(mesh);
      this.nebulaMaterials.push(mat);
      this.disposables.push(tex, mat);
    });

    // 3. Distant spiral galaxies for genuine Interstellar-scale depth
    const galaxySpecs = [
      { pos: [-48, 22, -52], radius: 22, tilt: [0.68, 0.25, -0.3], arms: 3, tint: '#d8b46d', depth: 0.12 },
      { pos: [52, -18, -195], radius: 26, tilt: [0.95, -0.4, 0.4], arms: 4, tint: '#8caeff', depth: 0.18 },
      { pos: [-46, 26, -545], radius: 34, tilt: [0.75, 0.35, 0.2], arms: 3, tint: '#e4c27c', depth: 0.14 },
    ];

    galaxySpecs.forEach((spec, idx) => {
      const count = Math.round(950 * scaleFactor);
      const gGeo = new THREE.BufferGeometry();
      const posArr = new Float32Array(count * 3);
      const scaleArr = new Float32Array(count);
      const phaseArr = new Float32Array(count);
      const colArr = new Float32Array(count * 3);

      const coreCol = new THREE.Color('#fff2d4');
      const armCol = new THREE.Color(spec.tint);
      const edgeCol = new THREE.Color('#3e4c9c');
      const tmp = new THREE.Color();

      for (let i = 0; i < count; i++) {
        const radiusRatio = Math.pow(rand(), 1.45);
        const r = radiusRatio * spec.radius;
        const armAngle = ((i % spec.arms) / spec.arms) * Math.PI * 2;
        const spinAngle = r * 0.32;
        const spread = (rand() - 0.5) * (0.45 + radiusRatio * 2.1);

        posArr[i * 3] = Math.cos(armAngle + spinAngle) * r + spread;
        posArr[i * 3 + 1] = (rand() - 0.5) * (1.8 * (1 - radiusRatio * 0.7));
        posArr[i * 3 + 2] = Math.sin(armAngle + spinAngle) * r + spread;

        scaleArr[i] = 1.3 + (1 - radiusRatio) * 2.4;
        phaseArr[i] = rand();

        if (radiusRatio < 0.28) {
          tmp.lerpColors(coreCol, armCol, radiusRatio / 0.28);
        } else {
          tmp.lerpColors(armCol, edgeCol, (radiusRatio - 0.28) / 0.72);
        }
        colArr[i * 3] = tmp.r;
        colArr[i * 3 + 1] = tmp.g;
        colArr[i * 3 + 2] = tmp.b;
      }

      gGeo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
      gGeo.setAttribute('aScale', new THREE.BufferAttribute(scaleArr, 1));
      gGeo.setAttribute('aPhase', new THREE.BufferAttribute(phaseArr, 1));
      gGeo.setAttribute('aColor', new THREE.BufferAttribute(colArr, 3));

      const gMat = new THREE.ShaderMaterial({
        vertexShader: STARFIELD_VERTEX_SHADER,
        fragmentShader: STARFIELD_FRAGMENT_SHADER,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uTime: { value: 0 },
          uPixelRatio: { value: pixelRatio },
          uOpacity: { value: 0 },
          uBurst: { value: 0 },
          uParallaxOffset: { value: new THREE.Vector3() },
          uVelocityStretch: { value: 0 },
        },
      });
      const galaxy = new THREE.Points(gGeo, gMat);
      galaxy.position.set(spec.pos[0], spec.pos[1], spec.pos[2]);
      galaxy.rotation.set(spec.tilt[0], spec.tilt[1], spec.tilt[2]);
      galaxy.userData.spinRate = idx % 2 === 0 ? 0.045 : -0.035;
      galaxy.userData.basePos = new THREE.Vector3(spec.pos[0], spec.pos[1], spec.pos[2]);
      galaxy.userData.depthFactor = spec.depth;
      this.root.add(galaxy);
      this.galaxies.push(galaxy);
      this.starMaterials.push(gMat);
      this.disposables.push(gGeo, gMat);
    });

    // 4. Prologue: Gargantua-inspired Relativistic Accretion Portal + Curl-Noise Big Bang
    const bbCount = Math.round(2400 * scaleFactor);
    const bbGeo = new THREE.BufferGeometry();
    const bbPos = new Float32Array(bbCount * 3);
    const bbDir = new Float32Array(bbCount * 3);
    const bbSpeed = new Float32Array(bbCount);
    const bbSize = new Float32Array(bbCount);
    const bbCol = new Float32Array(bbCount * 3);

    const bbColors = [
      new THREE.Color('#fff7e6'),
      new THREE.Color('#f0c878'),
      new THREE.Color('#8bb4ff'),
      new THREE.Color('#7a5cc7'),
    ];

    for (let i = 0; i < bbCount; i++) {
      const u = rand() * 2 - 1;
      const phi = rand() * Math.PI * 2;
      const sqrtOneMinusU2 = Math.sqrt(1 - u * u);
      bbDir[i * 3] = sqrtOneMinusU2 * Math.cos(phi);
      bbDir[i * 3 + 1] = u * 0.58;
      bbDir[i * 3 + 2] = sqrtOneMinusU2 * Math.sin(phi);

      bbSpeed[i] = 0.25 + Math.pow(rand(), 0.9) * 0.95;
      bbSize[i] = 1.4 + rand() * 3.0;

      const c = bbColors[Math.floor(rand() * bbColors.length)];
      bbCol[i * 3] = c.r;
      bbCol[i * 3 + 1] = c.g;
      bbCol[i * 3 + 2] = c.b;
    }

    bbGeo.setAttribute('position', new THREE.BufferAttribute(bbPos, 3));
    bbGeo.setAttribute('aDirection', new THREE.BufferAttribute(bbDir, 3));
    bbGeo.setAttribute('aSpeed', new THREE.BufferAttribute(bbSpeed, 1));
    bbGeo.setAttribute('aSize', new THREE.BufferAttribute(bbSize, 1));
    bbGeo.setAttribute('aColor', new THREE.BufferAttribute(bbCol, 3));

    this.bigBangMat = new THREE.ShaderMaterial({
      vertexShader: BIG_BANG_VERTEX_SHADER,
      fragmentShader: BIG_BANG_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uExpansion: { value: 0 },
        uTime: { value: 0 },
        uPixelRatio: { value: pixelRatio },
        uOpacity: { value: 0 },
      },
    });
    const bbPoints = new THREE.Points(bbGeo, this.bigBangMat);
    bbPoints.frustumCulled = false;
    this.bigBangGroup.add(bbPoints);

    // True Geodesic Raymarched Schwarzschild/Kerr Singularity & Volumetric Accretion Disk
    const geodesicGeo = new THREE.SphereGeometry(18.0, 42, 30);
    this.singularityGeodesicMat = new THREE.ShaderMaterial({
      vertexShader: GEODESIC_SINGULARITY_VERTEX_SHADER,
      fragmentShader: GEODESIC_SINGULARITY_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide,
      uniforms: {
        uCenter: { value: new THREE.Vector3(0, 0, 0) },
        uHorizonRadius: { value: 1.25 },
        uDiskOuterRadius: { value: 11.4 },
        uTime: { value: 0 },
        uOpacity: { value: 0 },
        uSpin: { value: 0.85 },
        uInnerColor: { value: new THREE.Color('#fff5dc') },
        uOuterColor: { value: new THREE.Color('#c8762e') },
        uMilkyWayMap: { value: skyFallbackTex },
        uHasMilkyWay: { value: 0.0 },
      },
    });
    this.singularitySphere = new THREE.Mesh(geodesicGeo, this.singularityGeodesicMat);
    this.singularitySphere.renderOrder = 2;
    this.bigBangGroup.add(this.singularitySphere);
    this.disposables.push(geodesicGeo, this.singularityGeodesicMat);

    const glowTex = createSoftGlowTexture('#ffffff', '#f5d288');
    const haloTex = createSoftGlowTexture('#ffe8b5', '#8763c7');
    this.disposables.push(bbGeo, this.bigBangMat, glowTex, haloTex);

    const coreMat = new THREE.SpriteMaterial({
      map: glowTex,
      color: 0xfff5db,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.singularityCore = new THREE.Sprite(coreMat);
    this.bigBangGroup.add(this.singularityCore);

    const haloMat = new THREE.SpriteMaterial({
      map: haloTex,
      color: 0xd9b3ff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.singularityHalo = new THREE.Sprite(haloMat);
    this.bigBangGroup.add(this.singularityHalo);
    this.root.add(this.bigBangGroup);
    this.disposables.push(coreMat, haloMat);

    // 5. Persistent Guiding Star thread with volumetric crepuscular god-rays
    const gCoreMat = new THREE.SpriteMaterial({
      map: glowTex,
      color: 0xfff4d6,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const gHaloMat = new THREE.SpriteMaterial({
      map: haloTex,
      color: 0xe8c070,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.guidingCore = new THREE.Sprite(gCoreMat);
    this.guidingHalo = new THREE.Sprite(gHaloMat);

    const raysGeo = new THREE.PlaneGeometry(1, 1);
    this.guidingRaysMat = new THREE.ShaderMaterial({
      vertexShader: GOD_RAYS_VERTEX_SHADER,
      fragmentShader: GOD_RAYS_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uIntensity: { value: 0 },
        uColor: { value: new THREE.Color('#f7d594') },
      },
    });
    this.guidingRaysMesh = new THREE.Mesh(raysGeo, this.guidingRaysMat);
    this.guidingLight = new THREE.PointLight(0xf6d58f, 2.2, 42, 1.8);
    this.guidingStar.add(this.guidingCore, this.guidingHalo, this.guidingRaysMesh, this.guidingLight);
    this.root.add(this.guidingStar);
    this.disposables.push(gCoreMat, gHaloMat, raysGeo, this.guidingRaysMat);
  }

  public update(
    filmTime: number,
    elapsed: number,
    delta: number,
    hasEntered: boolean,
    guidingTarget: THREE.Vector3,
    guidingScale: number,
    cameraQuaternion?: THREE.Quaternion,
  ): void {
    const entryReveal = hasEntered ? 1 : 0.22;

    const firstLight = smoothstep(0.3, 5.0, filmTime);
    const expansion = smoothstep(9.0, 42.0, filmTime);
    const starsWake = hasEntered ? smoothstep(7.0, 22.0, filmTime) : 0.38;

    const silenceDip =
      smoothstep(SILENCE_START - 1.5, SILENCE_START + 0.6, filmTime) *
      (1 - smoothstep(SILENCE_END, SILENCE_END + 2.8, filmTime));
    const cosmosVisibility = clamp((starsWake * 0.92 + 0.08 * entryReveal) * (1 - silenceDip * 0.92), 0.03, 1);

    for (let i = 0; i < this.starMaterials.length; i++) {
      const mat = this.starMaterials[i];
      mat.uniforms.uTime.value = elapsed;
      mat.uniforms.uOpacity.value = cosmosVisibility;
      mat.uniforms.uBurst.value = smoothstep(370.2, 375.5, filmTime) * 0.25;
    }

    // Restrained dark-cinema 4K Milky Way backdrop (keeps obsidian black floor; dips during silence)
    const skyReveal = hasEntered ? smoothstep(9.0, 24.0, filmTime) : 0.22;
    this.milkyWayMat.uniforms.uOpacity.value =
      (this.milkyWayLoaded ? 0.42 : 0.0) * skyReveal * (1 - silenceDip * 0.94);

    // Update ultra-near spatial dust motes + Earth eclipse cone during Chapter I
    const earthPresence =
      smoothstep(54, 62, filmTime) * (1 - smoothstep(104, 112, filmTime));
    const earthQuiet =
      1 -
      smoothstep(65, 76, filmTime) * (1 - smoothstep(102, 110, filmTime)) * 0.65;
    this.nearDebrisMat.uniforms.uTime.value = elapsed;
    this.nearDebrisMat.uniforms.uOpacity.value =
      (hasEntered ? 0.34 : 0.16) * cosmosVisibility * earthQuiet;
    this.nearDebrisMat.uniforms.uEclipseActive.value = earthPresence;

    // Volumetric self-shadowed nebulae
    const lightAngle = elapsed * 0.05 + filmTime * 0.01;
    const lx = Math.cos(lightAngle);
    const ly = Math.sin(lightAngle);
    for (let i = 0; i < this.nebulaMaterials.length; i++) {
      const mat = this.nebulaMaterials[i];
      const baseOp = mat.userData.baseOpacity as number;
      mat.uniforms.uOpacity.value =
        baseOp * cosmosVisibility * smoothstep(6.0, 22.0, filmTime + (hasEntered ? 0 : 18));
      mat.uniforms.uTime.value = elapsed;
      (mat.uniforms.uLightDir.value as THREE.Vector2).set(lx, ly);
    }

    // Chapter V is a night sky seen from Earth: no anchor-star 'sun' and no galaxy clutter beside the Moon
    const quietHours = smoothstep(286.5, 292.5, filmTime) * (1 - smoothstep(333.5, 338.5, filmTime));

    for (let i = 0; i < this.galaxies.length; i++) {
      const g = this.galaxies[i];
      g.rotation.y += delta * (g.userData.spinRate as number);
      if (quietHours > 0) {
        (g.material as THREE.ShaderMaterial).uniforms.uOpacity.value *= 1 - quietHours;
      }
    }

    // Update Prologue Geodesic Raymarched Singularity & Curl-Noise Big Bang
    const prologueFadeOut = 1 - smoothstep(46.0, 62.0, filmTime);
    this.bigBangGroup.visible = prologueFadeOut > 0.005 || !hasEntered;
    if (this.bigBangGroup.visible) {
      const idleBreath = !hasEntered ? 0.36 + 0.08 * Math.sin(elapsed * 0.9) : 0;
      // Keep central sprite very subtle when geodesic black hole horizon is visible
      const diskEnvelope = hasEntered
        ? smoothstep(0.8, 7.0, filmTime) * (1 - smoothstep(28.0, 44.0, filmTime))
        : 0.45;
      const coreOp = hasEntered
        ? firstLight * prologueFadeOut * (1 - expansion * 0.72) * (1 - diskEnvelope * 0.75) * 0.48
        : idleBreath * 0.35;
      const coreScale = hasEntered
        ? 0.35 + firstLight * 1.4 + Math.sin(expansion * Math.PI) * 2.1
        : 1.2 + 0.14 * Math.sin(elapsed * 0.8);

      this.singularityCore.material.opacity = coreOp;
      this.singularityCore.scale.set(coreScale, coreScale, 1);

      this.singularityHalo.material.opacity = coreOp * 0.28;
      this.singularityHalo.scale.set(coreScale * 2.4, coreScale * 2.4, 1);

      this.singularitySphere.visible = diskEnvelope > 0.01;
      if (this.singularitySphere.visible) {
        const radiusScale = hasEntered ? 0.58 + smoothstep(1.0, 18.0, filmTime) * 0.56 : 0.72;
        this.singularityGeodesicMat.uniforms.uTime.value = elapsed;
        this.singularityGeodesicMat.uniforms.uOpacity.value = diskEnvelope * 0.96;
        this.singularityGeodesicMat.uniforms.uHorizonRadius.value = 1.85 * radiusScale;
        this.singularityGeodesicMat.uniforms.uDiskOuterRadius.value = 9.8 * radiusScale;
      }

      this.bigBangMat.uniforms.uTime.value = elapsed;
      this.bigBangMat.uniforms.uExpansion.value = hasEntered ? expansion : 0.14;
      this.bigBangMat.uniforms.uOpacity.value = hasEntered
        ? smoothstep(8.2, 13.5, filmTime) * prologueFadeOut * 0.72
        : 0.16;
    }

    // Smoothly guide the recurring anchor star across scenes (snap on large timeline seeks)
    if (this.guidingStar.position.distanceToSquared(guidingTarget) > 900) {
      this.guidingStar.position.copy(guidingTarget);
    } else {
      this.guidingStar.position.lerp(guidingTarget, 1 - Math.exp(-3.4 * Math.min(delta, 0.1)));
    }
    const pulse = 1 + 0.08 * Math.sin(elapsed * 2.3);
    const s = guidingScale * pulse;
    this.guidingCore.scale.set(s, s, 1);
    this.guidingHalo.scale.set(s * 2.7, s * 2.7, 1);

    // From Chapter IV on, each scene supplies its own focal star (cluster eyes, the house lamp, the dying star)
    const starVis = (hasEntered ? smoothstep(5.5, 11.0, filmTime) : 0) * (1 - quietHours) * (1 - smoothstep(226.0, 231.0, filmTime));
    this.guidingCore.material.opacity = starVis * 0.85;
    this.guidingHalo.material.opacity = starVis * 0.34;
    this.guidingLight.intensity = starVis * 1.25;

    // Delicate crepuscular volumetric god-rays radiating subtly behind the Guiding Star
    if (cameraQuaternion) {
      this.guidingRaysMesh.quaternion.copy(cameraQuaternion);
    }
    const rayScale = s * 4.8;
    this.guidingRaysMesh.scale.set(rayScale, rayScale, 1);
    this.guidingRaysMat.uniforms.uTime.value = elapsed;
    this.guidingRaysMat.uniforms.uIntensity.value = starVis * (0.14 + silenceDip * 0.16);
  }

  /**
   * Shifts distant stars, mid-field stars, near stars, nebulae, spiral galaxies,
   * and ultra-near foreground micro-debris proportionally to their depthFactor
   * based on camera movement and pointer drift.
   */
  public applyParallax(
    input: ParallaxInput,
    delta: number,
    options: ParallaxOptions,
  ): void {
    const damp = 1 - Math.exp(-4.8 * Math.min(delta, 0.1));
    const speed = Math.hypot(
      input.cameraVelocity.x,
      input.cameraVelocity.y,
      input.cameraVelocity.z,
    );
    const velocityStretch = options.reducedMotion ? 0 : clamp((speed - 2.5) / 14.0, 0, 1);

    // 1. GPU-driven starfield layers (far 0.10 -> mid 0.28 -> near 0.56)
    for (let i = 0; i < this.starfieldLayers.length; i++) {
      const layer = this.starfieldLayers[i];
      writeParallaxOffset(_parallaxTarget, input, layer.depthFactor, options);
      const current = layer.mat.uniforms.uParallaxOffset.value as THREE.Vector3;
      current.lerp(_parallaxTarget, damp);
      layer.mat.uniforms.uVelocityStretch.value = THREE.MathUtils.lerp(
        layer.mat.uniforms.uVelocityStretch.value as number,
        velocityStretch * (0.35 + layer.depthFactor),
        damp,
      );
    }

    // 2. Ultra-near spatial micro-dust & bokeh debris layer (depthFactor 0.92 — fastest parallax)
    writeParallaxOffset(_parallaxTarget, input, this.nearDebrisDepthFactor, options);
    const debrisCurrent = this.nearDebrisMat.uniforms.uParallaxOffset.value as THREE.Vector3;
    debrisCurrent.lerp(_parallaxTarget, damp);
    (this.nearDebrisMat.uniforms.uCameraPos.value as THREE.Vector3).set(
      input.cameraPos.x,
      input.cameraPos.y,
      input.cameraPos.z,
    );

    // Keep the 4K Milky Way sphere & Hyderabad 25 Nov 2002 Hipparcos Vault centered on the camera
    this.milkyWaySphere.position.set(
      input.cameraPos.x,
      input.cameraPos.y,
      input.cameraPos.z,
    );
    this.hipparcosPoints.position.set(
      input.cameraPos.x,
      input.cameraPos.y,
      input.cameraPos.z,
    );
    const ptrAtten = options.reducedMotion ? 0 : 0.028 * options.silenceDamp;
    this.milkyWaySphere.rotation.y = THREE.MathUtils.lerp(
      this.milkyWaySphere.rotation.y,
      -0.65 - input.pointerOffset.x * ptrAtten,
      damp,
    );
    this.milkyWaySphere.rotation.x = THREE.MathUtils.lerp(
      this.milkyWaySphere.rotation.x,
      0.38 + input.pointerOffset.y * ptrAtten * 0.7,
      damp,
    );
    this.hipparcosPoints.rotation.y = THREE.MathUtils.lerp(
      this.hipparcosPoints.rotation.y,
      -input.pointerOffset.x * ptrAtten,
      damp,
    );
    this.hipparcosPoints.rotation.x = THREE.MathUtils.lerp(
      this.hipparcosPoints.rotation.x,
      input.pointerOffset.y * ptrAtten * 0.7,
      damp,
    );

    // 3. Volumetric self-shadowed nebula planes shifted relative to corridor base positions
    for (let i = 0; i < this.nebulaMeshes.length; i++) {
      const mesh = this.nebulaMeshes[i];
      const basePos = mesh.userData.basePos as THREE.Vector3;
      const depth = mesh.userData.depthFactor as number;
      writeParallaxOffset(_parallaxTarget, input, depth, options);
      _parallaxTarget.add(basePos);
      mesh.position.lerp(_parallaxTarget, damp);
    }

    // 4. Distant spiral galaxies shift subtly to anchor monumental background scale
    for (let i = 0; i < this.galaxies.length; i++) {
      const galaxy = this.galaxies[i];
      const basePos = galaxy.userData.basePos as THREE.Vector3;
      const depth = galaxy.userData.depthFactor as number;
      writeParallaxOffset(_parallaxTarget, input, depth, options);
      _parallaxTarget.add(basePos);
      galaxy.position.lerp(_parallaxTarget, damp);
    }
  }

  public getNearParallaxMagnitude(): number {
    const near = this.starfieldLayers[this.starfieldLayers.length - 1];
    if (!near) return 0;
    return (near.mat.uniforms.uParallaxOffset.value as THREE.Vector3).length();
  }

  public getDebrisParallaxMagnitude(): number {
    return (this.nearDebrisMat.uniforms.uParallaxOffset.value as THREE.Vector3).length();
  }

  public getLoadedTextureCount(): number {
    return this.milkyWayLoaded ? 1 : 0;
  }

  public getMilkyWayTexture(): THREE.Texture | null {
    return this.milkyWayTexture;
  }

  public getHipparcosStarCount(): number {
    return this.hipparcosCount;
  }

  public dispose(): void {
    this.disposed = true;
    this.disposables.forEach((d) => d.dispose());
  }
}
