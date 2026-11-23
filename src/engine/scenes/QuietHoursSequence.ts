import * as THREE from 'three';
import { getChapterWeight, smoothstep } from '../../data/chapters';
import { createSoftGlowTexture } from '../shaders';

const NIGHT_EARTH_VERTEX = /* glsl */ `
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

const NIGHT_EARTH_FRAGMENT = /* glsl */ `
  uniform sampler2D uDay;
  uniform sampler2D uNight;
  uniform vec3 uSunDir;
  uniform float uOpacity;
  uniform float uDawn;
  uniform float uHasTex;
  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  void main() {
    vec3 n = normalize(vWorldNormal);
    vec3 v = normalize(cameraPosition - vWorldPos);
    float d = dot(n, uSunDir);
    float day = smoothstep(-0.06, 0.32, d);

    vec3 dayTex = mix(vec3(0.05, 0.08, 0.14), texture2D(uDay, vUv).rgb, uHasTex);
    vec3 nightTex = mix(vec3(0.0), texture2D(uNight, vUv).rgb, uHasTex);

    vec3 moonlit = dayTex * vec3(0.42, 0.52, 0.85) * 0.055;
    vec3 sunlit = dayTex * (1.25 * day);
    float lum = dot(nightTex, vec3(0.299, 0.587, 0.114));
    vec3 cities = vec3(1.0, 0.72, 0.38) * pow(lum, 1.35) * 3.6 * (1.0 - day);

    float terminator = exp(-pow(d * 6.5, 2.0));
    vec3 dawnBand = vec3(1.0, 0.42, 0.16) * terminator * (0.1 + 0.32 * uDawn);

    float rim = pow(1.0 - max(dot(n, v), 0.0), 3.2);
    vec3 rimCol = mix(vec3(0.16, 0.32, 0.85), vec3(1.0, 0.62, 0.32), smoothstep(-0.35, 0.3, d));

    vec3 col = moonlit + sunlit + cities + dawnBand + rimCol * rim * 0.75;
    gl_FragColor = vec4(col, uOpacity);
  }
`;

const ATMOSPHERE_SHELL_VERTEX = /* glsl */ `
  varying vec3 vViewNormal;
  varying vec3 vWorldNormal;
  void main() {
    vViewNormal = normalize(normalMatrix * normal);
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const ATMOSPHERE_SHELL_FRAGMENT = /* glsl */ `
  uniform vec3 uSunDir;
  uniform float uIntensity;
  uniform float uDawn;
  varying vec3 vViewNormal;
  varying vec3 vWorldNormal;
  void main() {
    // Back faces: k = 0 at the outer edge of the shell, ~0.29 at the planet limb
    float k = -vViewNormal.z;
    float glow = pow(smoothstep(0.0, 0.28, k), 1.6) * (1.0 - smoothstep(0.28, 0.42, k)) * 1.6;
    float sunSide = smoothstep(-0.4, 0.6, dot(normalize(vWorldNormal), uSunDir));
    vec3 col = mix(vec3(0.18, 0.38, 1.0), vec3(1.0, 0.56, 0.24), sunSide * (0.35 + 0.65 * uDawn));
    float a = glow * uIntensity * (0.55 + sunSide * (0.6 + 1.4 * uDawn));
    gl_FragColor = vec4(col * a, a);
  }
`;

const AURORA_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const AURORA_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    float x = vUv.x * 46.0;
    float curtain = 0.55 + 0.45 * sin(x + uTime * 0.35 + sin(x * 0.37 - uTime * 0.21) * 2.4);
    curtain *= 0.6 + 0.4 * sin(x * 2.7 - uTime * 0.6);
    float vertical = smoothstep(0.0, 0.12, vUv.y) * pow(1.0 - vUv.y, 1.8);
    vec3 col = mix(vec3(0.15, 0.95, 0.55), vec3(0.55, 0.3, 0.95), smoothstep(0.35, 1.0, vUv.y));
    float a = curtain * vertical * uOpacity;
    gl_FragColor = vec4(col * a, a);
  }
`;

const MOON_FRAGMENT = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uSunDir;
  uniform float uOpacity;
  uniform float uHasTex;
  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  void main() {
    vec3 tex = mix(vec3(0.55), texture2D(uMap, vUv).rgb, uHasTex);
    float l = smoothstep(-0.05, 0.4, dot(normalize(vWorldNormal), uSunDir));
    vec3 col = tex * (0.025 + 1.15 * l);
    gl_FragColor = vec4(col, uOpacity);
  }
`;

const PLANET_RADIUS = 15;
const PLANET_CENTER = new THREE.Vector3(0, -17, -6);
const SUN_NIGHT = new THREE.Vector3(0.9, -0.42, -1.2).normalize();
const SUN_DAWN = new THREE.Vector3(1.0, 0.02, -0.75).normalize();

/**
 * Chapter V: Even Stars Have Quiet Hours (centered at 0, -2, -425).
 * Shot 1: Earth's night side from orbit, with city lights, an auroral oval, a crescent Moon and
 * one warm light still burning. Shot 2: the camera descends to that light, a cottage on a
 * moonlit hill where a figure at a desk stops working, looks up, and rests as dawn arrives.
 */
export class QuietHoursSequence {
  public readonly root = new THREE.Group();

  private readonly earth: THREE.Mesh;
  private readonly earthMat: THREE.ShaderMaterial;
  private readonly atmoMat: THREE.ShaderMaterial;
  private readonly auroraMat: THREE.ShaderMaterial;
  private readonly moonMat: THREE.ShaderMaterial;
  private readonly sunGlow: THREE.Sprite;
  private readonly sunCore: THREE.Sprite;
  private readonly beacon: THREE.Sprite;
  private readonly quietMotes: THREE.Points;
  private readonly sunDir = new THREE.Vector3();
  private readonly orbitGroup = new THREE.Group();
  private readonly groundGroup = new THREE.Group();
  private readonly groundMats: Array<{ mat: THREE.Material & { opacity: number }; base: number }> = [];
  private readonly skyGlowMat: THREE.ShaderMaterial;
  private readonly windowGlowMat: THREE.MeshBasicMaterial;
  private readonly windowSpill: THREE.Sprite;
  private readonly lampGlow: THREE.Sprite;
  private readonly torsoPivot = new THREE.Group();
  private readonly headPivot = new THREE.Group();
  private readonly armPivot = new THREE.Group();
  private readonly fireflies: THREE.Points;
  private readonly diveClouds: THREE.Sprite[] = [];
  private readonly disposables: Array<{ dispose: () => void }> = [];

  constructor(maxAnisotropy: number) {
    this.root.position.set(0, -2, -425);

    const loader = new THREE.TextureLoader();
    const load = (url: string, onReady: (tex: THREE.Texture) => void) =>
      loader.load(url, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = maxAnisotropy;
        this.disposables.push(tex);
        onReady(tex);
      });

    // 1. Night-side Earth
    this.earthMat = new THREE.ShaderMaterial({
      uniforms: {
        uDay: { value: null },
        uNight: { value: null },
        uSunDir: { value: SUN_NIGHT.clone() },
        uOpacity: { value: 0 },
        uDawn: { value: 0 },
        uHasTex: { value: 0 },
      },
      vertexShader: NIGHT_EARTH_VERTEX,
      fragmentShader: NIGHT_EARTH_FRAGMENT,
      transparent: true,
    });
    let texReady = 0;
    const markReady = () => {
      texReady++;
      if (texReady === 2) this.earthMat.uniforms.uHasTex.value = 1;
    };
    load('/textures/earth_day_4k.jpg', (tex) => {
      this.earthMat.uniforms.uDay.value = tex;
      markReady();
    });
    load('/textures/earth_night_4k.jpg', (tex) => {
      this.earthMat.uniforms.uNight.value = tex;
      markReady();
    });

    const earthGeo = new THREE.SphereGeometry(PLANET_RADIUS, 128, 96);
    this.earth = new THREE.Mesh(earthGeo, this.earthMat);
    this.earth.position.copy(PLANET_CENTER);
    this.earth.rotation.set(0.42, -1.9, 0.08);
    this.orbitGroup.add(this.earth);

    // 2. Atmospheric limb
    this.atmoMat = new THREE.ShaderMaterial({
      uniforms: {
        uSunDir: { value: SUN_NIGHT.clone() },
        uIntensity: { value: 0 },
        uDawn: { value: 0 },
      },
      vertexShader: ATMOSPHERE_SHELL_VERTEX,
      fragmentShader: ATMOSPHERE_SHELL_FRAGMENT,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const atmoGeo = new THREE.SphereGeometry(PLANET_RADIUS * 1.045, 96, 64);
    const atmo = new THREE.Mesh(atmoGeo, this.atmoMat);
    atmo.position.copy(PLANET_CENTER);
    this.orbitGroup.add(atmo);

    // 3. Auroral oval hugging the polar cap
    this.auroraMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uOpacity: { value: 0 } },
      vertexShader: AURORA_VERTEX,
      fragmentShader: AURORA_FRAGMENT,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const lat = THREE.MathUtils.degToRad(68);
    const auroraGeo = new THREE.CylinderGeometry(
      PLANET_RADIUS * Math.cos(lat) * 1.04,
      PLANET_RADIUS * Math.cos(lat),
      1.5,
      160,
      1,
      true,
    );
    const aurora = new THREE.Mesh(auroraGeo, this.auroraMat);
    aurora.position.set(0, PLANET_RADIUS * Math.sin(lat) + 0.7, 0);
    const auroraPivot = new THREE.Group();
    auroraPivot.position.copy(PLANET_CENTER);
    auroraPivot.rotation.set(-0.5, 0, 0.22);
    auroraPivot.add(aurora);
    this.orbitGroup.add(auroraPivot);
    this.root.add(this.orbitGroup);

    // 4. Crescent Moon
    this.moonMat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: null },
        uSunDir: { value: SUN_NIGHT.clone() },
        uOpacity: { value: 0 },
        uHasTex: { value: 0 },
      },
      vertexShader: NIGHT_EARTH_VERTEX,
      fragmentShader: MOON_FRAGMENT,
      transparent: true,
    });
    load('/textures/moon_4k.jpg', (tex) => {
      this.moonMat.uniforms.uMap.value = tex;
      this.moonMat.uniforms.uHasTex.value = 1;
    });
    const moonGeo = new THREE.SphereGeometry(1.05, 64, 48);
    const moon = new THREE.Mesh(moonGeo, this.moonMat);
    moon.position.set(-10.5, 7.2, -26);
    this.root.add(moon);

    // 5. Sun rising behind the limb
    const sunGlowTex = createSoftGlowTexture('#fff3dc', '#ff9a4a', 'rgba(0,0,0,0)', 256);
    const sunGlowMat = new THREE.SpriteMaterial({
      map: sunGlowTex,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0,
    });
    this.sunGlow = new THREE.Sprite(sunGlowMat);
    this.sunGlow.position.set(13.5, -2.6, -40);
    this.root.add(this.sunGlow);

    const sunCoreTex = createSoftGlowTexture('#ffffff', '#fff1d0', 'rgba(0,0,0,0)', 128);
    const sunCoreMat = new THREE.SpriteMaterial({
      map: sunCoreTex,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0,
    });
    this.sunCore = new THREE.Sprite(sunCoreMat);
    this.sunCore.position.copy(this.sunGlow.position);
    this.root.add(this.sunCore);

    // 6. One warm light still burning on the night side (rotates with Earth)
    const beaconTex = createSoftGlowTexture('#fffaf0', '#ffc46b', 'rgba(0,0,0,0)', 128);
    const beaconMat = new THREE.SpriteMaterial({
      map: beaconTex,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0,
    });
    this.beacon = new THREE.Sprite(beaconMat);
    const beaconWorldDir = new THREE.Vector3(-0.12, 0.93, 0.35).normalize();
    const invRot = new THREE.Quaternion().setFromEuler(this.earth.rotation).invert();
    this.beacon.position.copy(beaconWorldDir.applyQuaternion(invRot).multiplyScalar(PLANET_RADIUS * 1.004));
    this.earth.add(this.beacon);

    // 6b. Descent through the night: moonlit cloud wisps, underlit amber by the town, stream past the
    // lens while the camera dives from orbit toward the one light still on (bridges the two shots).
    const cloudTex = createSoftGlowTexture('#c9d4f2', '#4c5c86', 'rgba(0,0,0,0)', 128);
    const cityTex = createSoftGlowTexture('#ffd9a0', '#c46a2a', 'rgba(0,0,0,0)', 128);
    this.disposables.push(cloudTex, cityTex);
    const diveA = new THREE.Vector3(1.8, 3.0, 21);
    const diveB = new THREE.Vector3(0.2, 0.4, 12.5);
    for (let i = 0; i < 18; i++) {
      const warm = i % 3 === 0;
      const mat = new THREE.SpriteMaterial({
        map: warm ? cityTex : cloudTex,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        opacity: 0,
      });
      this.disposables.push(mat);
      const sprite = new THREE.Sprite(mat);
      const f = (i + 0.5) / 18;
      const side = i % 2 === 0 ? 1 : -1;
      sprite.position.lerpVectors(diveA, diveB, f);
      sprite.position.x += side * (0.7 + ((i * 37) % 11) / 8);
      sprite.position.y += (((i * 53) % 9) / 9 - 0.5) * 1.6 - (warm ? 0.6 : 0);
      const sc = warm ? 0.9 + ((i * 17) % 5) / 6 : 1.8 + ((i * 29) % 7) / 3;
      sprite.scale.set(sc * 1.8, sc, 1);
      sprite.userData.base = warm ? 0.32 : 0.2;
      this.root.add(sprite);
      this.diveClouds.push(sprite);
    }

    // 7. Ground-level sanctuary: the one light still on. A cottage on a moonlit hill, a warm
    // window, and a person at a desk who slowly learns to stop, look up, and rest.
    const skyGlowGeo = new THREE.PlaneGeometry(140, 34);
    this.skyGlowMat = new THREE.ShaderMaterial({
      uniforms: { uOpacity: { value: 0 }, uDawn: { value: 0 } },
      vertexShader: AURORA_VERTEX,
      fragmentShader: /* glsl */ `
        uniform float uOpacity;
        uniform float uDawn;
        varying vec2 vUv;
        void main() {
          float h = vUv.y;
          float band = exp(-h * mix(6.5, 4.0, uDawn));
          float side = smoothstep(0.15, 0.85, vUv.x);
          vec3 night = vec3(0.12, 0.2, 0.42);
          vec3 dawn = mix(vec3(0.95, 0.42, 0.18), vec3(1.0, 0.72, 0.42), h * 1.6);
          vec3 col = mix(night, dawn, uDawn * (0.35 + 0.65 * side));
          float a = band * uOpacity * (0.9 + 0.5 * uDawn * side);
          gl_FragColor = vec4(col * a, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const skyGlow = new THREE.Mesh(skyGlowGeo, this.skyGlowMat);
    skyGlow.position.set(0, 5, -34);
    this.groundGroup.add(skyGlow);

    const silhouette = (hex: number, base = 1) => {
      const mat = new THREE.MeshBasicMaterial({ color: hex, transparent: true, opacity: 0 });
      this.groundMats.push({ mat, base });
      this.disposables.push(mat);
      return mat;
    };
    const hillMat = silhouette(0x04060c);
    const houseMat = silhouette(0x0c1222);
    const trimMat = silhouette(0x151c30);
    const inkMat = silhouette(0x010102);

    const hillGeo = new THREE.SphereGeometry(40, 96, 48);
    const hill = new THREE.Mesh(hillGeo, hillMat);
    hill.position.set(0, -40, -6);
    this.groundGroup.add(hill);

    // Cottage: extruded gabled profile, chimney, eaves, door
    const house = new THREE.Group();
    house.position.set(-1.6, -0.28, -2);
    house.rotation.y = 0.22;
    const profile = new THREE.Shape();
    profile.moveTo(-1.3, 0);
    profile.lineTo(1.3, 0);
    profile.lineTo(1.3, 1.6);
    profile.lineTo(0, 2.55);
    profile.lineTo(-1.3, 1.6);
    profile.closePath();
    const bodyGeo = new THREE.ExtrudeGeometry(profile, { depth: 2.2, bevelEnabled: false });
    bodyGeo.translate(0, 0, -1.1);
    bodyGeo.rotateY(Math.PI / 2);
    house.add(new THREE.Mesh(bodyGeo, houseMat));

    const roofGeo = new THREE.BoxGeometry(2.62, 0.07, 1.78);
    const roofL = new THREE.Mesh(roofGeo, trimMat);
    roofL.position.set(0, 2.1, 0.66);
    roofL.rotation.x = Math.atan2(0.95, 1.3);
    const roofR = roofL.clone();
    roofR.position.z = -0.66;
    roofR.rotation.x = -roofL.rotation.x;
    house.add(roofL, roofR);

    const chimneyGeo = new THREE.BoxGeometry(0.28, 0.75, 0.28);
    const chimney = new THREE.Mesh(chimneyGeo, houseMat);
    chimney.position.set(-0.55, 2.35, -0.5);
    house.add(chimney);

    // Long wall facing the camera (+z) carries the window and the desk scene
    const front = new THREE.Group();
    front.position.set(0, 0, 1.301);
    house.add(front);

    const winW = 1.3;
    const winH = 0.95;
    const winGeo = new THREE.PlaneGeometry(winW, winH);
    this.windowGlowMat = new THREE.MeshBasicMaterial({
      color: 0xffb867,
      transparent: true,
      opacity: 0,
      toneMapped: false,
    });
    this.disposables.push(this.windowGlowMat);
    const win = new THREE.Mesh(winGeo, this.windowGlowMat);
    win.position.set(-0.25, 1.0, 0.002);
    front.add(win);

    const doorGeo = new THREE.PlaneGeometry(0.46, 0.92);
    const door = new THREE.Mesh(doorGeo, trimMat);
    door.position.set(0.72, 0.46, 0.003);
    front.add(door);

    // Person in profile at the desk, facing left toward a small lamp and an open book
    const person = new THREE.Group();
    person.position.set(-0.02, 0.6, 0.006);
    person.scale.setScalar(1.3);
    win.parent!.add(person);

    const deskGeo = new THREE.PlaneGeometry(0.62, 0.035);
    const desk = new THREE.Mesh(deskGeo, inkMat);
    desk.position.set(-0.34, 0.06, 0);
    person.add(desk);

    const bookShape = new THREE.Shape();
    bookShape.moveTo(-0.52, 0.078);
    bookShape.lineTo(-0.36, 0.078);
    bookShape.lineTo(-0.3, 0.11);
    bookShape.lineTo(-0.46, 0.11);
    bookShape.closePath();
    const bookGeo = new THREE.ShapeGeometry(bookShape);
    person.add(new THREE.Mesh(bookGeo, inkMat));

    const lampShape = new THREE.Shape();
    lampShape.moveTo(-0.63, 0.078);
    lampShape.lineTo(-0.57, 0.078);
    lampShape.lineTo(-0.595, 0.09);
    lampShape.lineTo(-0.595, 0.24);
    lampShape.lineTo(-0.55, 0.27);
    lampShape.lineTo(-0.52, 0.22);
    lampShape.lineTo(-0.6, 0.22);
    lampShape.lineTo(-0.605, 0.09);
    lampShape.closePath();
    const lampGeo = new THREE.ShapeGeometry(lampShape);
    person.add(new THREE.Mesh(lampGeo, inkMat));

    const chairGeo = new THREE.PlaneGeometry(0.035, 0.32);
    const chairBack = new THREE.Mesh(chairGeo, inkMat);
    chairBack.position.set(0.13, 0.1, -0.001);
    chairBack.rotation.z = -0.12;
    person.add(chairBack);

    // Hip pivot -> torso -> head / arm, so posture can change smoothly
    this.torsoPivot.position.set(0.02, -0.04, 0);
    person.add(this.torsoPivot);
    const torsoShape = new THREE.Shape();
    torsoShape.moveTo(-0.07, 0);
    torsoShape.quadraticCurveTo(-0.085, 0.16, -0.055, 0.27);
    torsoShape.quadraticCurveTo(0.0, 0.31, 0.055, 0.27);
    torsoShape.quadraticCurveTo(0.08, 0.14, 0.07, 0);
    torsoShape.closePath();
    const torsoGeo = new THREE.ShapeGeometry(torsoShape, 12);
    this.torsoPivot.add(new THREE.Mesh(torsoGeo, inkMat));

    this.headPivot.position.set(-0.005, 0.29, 0);
    this.torsoPivot.add(this.headPivot);
    const neckGeo = new THREE.PlaneGeometry(0.035, 0.06);
    const neck = new THREE.Mesh(neckGeo, inkMat);
    neck.position.set(0, 0.015, 0);
    this.headPivot.add(neck);
    const headShape = new THREE.Shape();
    headShape.absarc(0, 0.085, 0.062, 0, Math.PI * 2, false);
    const headGeo = new THREE.ShapeGeometry(headShape, 24);
    this.headPivot.add(new THREE.Mesh(headGeo, inkMat));
    const noseShape = new THREE.Shape();
    noseShape.moveTo(-0.055, 0.1);
    noseShape.lineTo(-0.078, 0.078);
    noseShape.lineTo(-0.052, 0.07);
    noseShape.closePath();
    const noseGeo = new THREE.ShapeGeometry(noseShape);
    this.headPivot.add(new THREE.Mesh(noseGeo, inkMat));
    const bunShape = new THREE.Shape();
    bunShape.absarc(0.06, 0.115, 0.032, 0, Math.PI * 2, false);
    const bunGeo = new THREE.ShapeGeometry(bunShape, 16);
    this.headPivot.add(new THREE.Mesh(bunGeo, inkMat));

    this.armPivot.position.set(-0.02, 0.24, 0);
    this.torsoPivot.add(this.armPivot);
    const armGeo = new THREE.PlaneGeometry(0.2, 0.034);
    armGeo.translate(-0.1, 0, 0);
    const arm = new THREE.Mesh(armGeo, inkMat);
    this.armPivot.add(arm);

    // Window mullions drawn last so they frame the figure
    const mullionV = new THREE.PlaneGeometry(0.035, winH);
    const mullionH = new THREE.PlaneGeometry(winW, 0.035);
    const frameGeoH = new THREE.PlaneGeometry(winW + 0.1, 0.06);
    const frameGeoV = new THREE.PlaneGeometry(0.06, winH + 0.1);
    const addFrame = (geo: THREE.PlaneGeometry, x: number, y: number) => {
      const m = new THREE.Mesh(geo, trimMat);
      m.position.set(win.position.x + x, win.position.y + y, 0.01);
      front.add(m);
    };
    addFrame(mullionV, 0, 0);
    addFrame(mullionH, 0, 0.12);
    addFrame(frameGeoH, 0, winH / 2 + 0.02);
    addFrame(frameGeoH, 0, -winH / 2 - 0.02);
    addFrame(frameGeoV, -winW / 2 - 0.02, 0);
    addFrame(frameGeoV, winW / 2 + 0.02, 0);

    const spillTex = createSoftGlowTexture('#ffe2b0', '#ff9c45', 'rgba(0,0,0,0)', 128);
    const spillMat = new THREE.SpriteMaterial({
      map: spillTex,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0,
    });
    this.windowSpill = new THREE.Sprite(spillMat);
    this.windowSpill.position.set(win.position.x, win.position.y, 0.35);
    this.windowSpill.scale.set(1.9, 1.4, 1);
    front.add(this.windowSpill);

    const lampMat = spillMat.clone();
    this.lampGlow = new THREE.Sprite(lampMat);
    this.lampGlow.position.set(win.position.x - 0.5, win.position.y - 0.12, 0.05);
    this.lampGlow.scale.setScalar(0.38);
    front.add(this.lampGlow);

    this.groundGroup.add(house);

    // Lone tree on the hill
    const treeShape = new THREE.Shape();
    treeShape.moveTo(-0.06, 0);
    treeShape.lineTo(0.06, 0);
    treeShape.lineTo(0.05, 0.7);
    const tiers = 5;
    for (let i = 0; i < tiers; i++) {
      const y = 0.7 + i * 0.48;
      const w = 0.95 - i * 0.17;
      treeShape.lineTo(w, y);
      treeShape.lineTo(0.08, y + 0.32);
    }
    treeShape.lineTo(0, 0.7 + tiers * 0.48 + 0.25);
    for (let i = tiers - 1; i >= 0; i--) {
      const y = 0.7 + i * 0.48;
      const w = 0.95 - i * 0.17;
      treeShape.lineTo(-0.08, y + 0.32);
      treeShape.lineTo(-w, y);
    }
    treeShape.lineTo(-0.05, 0.7);
    treeShape.closePath();
    const treeGeo = new THREE.ShapeGeometry(treeShape);
    const tree = new THREE.Mesh(treeGeo, hillMat);
    tree.position.set(1.9, -0.3, -3.2);
    tree.scale.setScalar(0.92);
    this.groundGroup.add(tree);
    const tree2 = new THREE.Mesh(treeGeo, hillMat);
    tree2.position.set(2.75, -0.45, -4.4);
    tree2.scale.setScalar(0.62);
    this.groundGroup.add(tree2);

    // Fireflies drifting near the cottage
    const flyCount = 46;
    const flyPos = new Float32Array(flyCount * 3);
    let fs = 7741;
    const frand = () => {
      fs = (fs * 1664525 + 1013904223) >>> 0;
      return fs / 4294967296;
    };
    for (let i = 0; i < flyCount; i++) {
      flyPos[i * 3] = -4 + frand() * 8;
      flyPos[i * 3 + 1] = 0.1 + frand() * 1.6;
      flyPos[i * 3 + 2] = -3 + frand() * 5;
    }
    const flyGeo = new THREE.BufferGeometry();
    flyGeo.setAttribute('position', new THREE.BufferAttribute(flyPos, 3));
    const flyMat = new THREE.PointsMaterial({
      color: 0xffd58a,
      size: 0.06,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.fireflies = new THREE.Points(flyGeo, flyMat);
    this.groundGroup.add(this.fireflies);

    this.groundGroup.visible = false;
    this.root.add(this.groundGroup);
    this.disposables.push(
      skyGlowGeo,
      this.skyGlowMat,
      hillGeo,
      bodyGeo,
      roofGeo,
      chimneyGeo,
      winGeo,
      doorGeo,
      deskGeo,
      bookGeo,
      lampGeo,
      chairGeo,
      torsoGeo,
      neckGeo,
      headGeo,
      noseGeo,
      bunGeo,
      armGeo,
      mullionV,
      mullionH,
      frameGeoH,
      frameGeoV,
      spillTex,
      spillMat,
      lampMat,
      treeGeo,
      flyGeo,
      flyMat,
    );

    // 8. Drifting quiet motes
    const moteCount = 260;
    const motePos = new Float32Array(moteCount * 3);
    let seed = 52731;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < moteCount; i++) {
      motePos[i * 3] = (rand() - 0.5) * 40;
      motePos[i * 3 + 1] = rand() * 14 - 2;
      motePos[i * 3 + 2] = (rand() - 0.5) * 30 - 4;
    }
    const moteGeo = new THREE.BufferGeometry();
    moteGeo.setAttribute('position', new THREE.BufferAttribute(motePos, 3));
    const moteMat = new THREE.PointsMaterial({
      color: 0xbfd2ff,
      size: 0.05,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.quietMotes = new THREE.Points(moteGeo, moteMat);
    this.root.add(this.quietMotes);

    this.disposables.push(
      earthGeo,
      this.earthMat,
      atmoGeo,
      this.atmoMat,
      auroraGeo,
      this.auroraMat,
      moonGeo,
      this.moonMat,
      sunGlowTex,
      sunGlowMat,
      sunCoreTex,
      sunCoreMat,
      beaconTex,
      beaconMat,
      moteGeo,
      moteMat,
    );
  }

  public update(filmTime: number, elapsed: number): void {
    const weight = getChapterWeight(filmTime, 285, 335, 6.5, 6.5);
    this.root.visible = weight > 0.004;
    if (!this.root.visible) return;

    // Sunrise sweeps over the limb in the closing seconds of Chapter V
    const dawn = smoothstep(320, 334, filmTime);
    this.sunDir.lerpVectors(SUN_NIGHT, SUN_DAWN, dawn).normalize();

    // Shot 1 (285..303): the night side from orbit. Shot 2 (302..335): down to the one light still on.
    const orbitVis = 1 - smoothstep(301.2, 304.0, filmTime);
    const groundVis = smoothstep(301.0, 304.6, filmTime);

    const descent = smoothstep(298.6, 300.8, filmTime) * (1 - smoothstep(303.4, 305.2, filmTime)) * weight;
    for (let i = 0; i < this.diveClouds.length; i++) {
      const c = this.diveClouds[i];
      c.visible = descent > 0.004;
      c.material.opacity = descent * (c.userData.base as number);
    }
    this.orbitGroup.visible = orbitVis > 0.004;
    this.groundGroup.visible = groundVis > 0.004;
    this.earthMat.depthWrite = orbitVis > 0.98;

    this.earth.rotation.y = -1.9 + elapsed * 0.0035;

    const eu = this.earthMat.uniforms;
    eu.uOpacity.value = weight * orbitVis;
    eu.uDawn.value = dawn;
    eu.uSunDir.value.copy(this.sunDir);

    const au = this.atmoMat.uniforms;
    au.uIntensity.value = 1.35 * weight * orbitVis;
    au.uDawn.value = dawn;
    au.uSunDir.value.copy(this.sunDir);

    this.auroraMat.uniforms.uTime.value = elapsed;
    this.auroraMat.uniforms.uOpacity.value =
      (0.32 + 0.12 * Math.sin(elapsed * 0.4)) * (1 - dawn * 0.75) * weight * orbitVis;

    this.moonMat.uniforms.uOpacity.value = weight;
    this.moonMat.uniforms.uSunDir.value.copy(this.sunDir);

    const rise = smoothstep(0, 1, dawn);
    this.sunGlow.position.y = -3.4 + rise * 5.2;
    this.sunCore.position.y = this.sunGlow.position.y;
    this.sunGlow.material.opacity = rise * 0.8 * weight;
    const glowScale = 6 + rise * 12;
    this.sunGlow.scale.set(glowScale * 1.6, glowScale, 1);
    this.sunCore.material.opacity = smoothstep(0.35, 1, dawn) * weight;
    this.sunCore.scale.setScalar(1.0 + rise * 1.2);

    const breath = 0.5 + 0.5 * Math.sin(elapsed * 0.9);
    const dive = smoothstep(297.5, 303.2, filmTime);
    this.beacon.material.opacity = (0.75 + 0.25 * breath) * weight * orbitVis;
    this.beacon.scale.setScalar(0.42 + breath * 0.14 + dive * 1.6);

    if (this.groundGroup.visible) this.updateSanctuary(filmTime, elapsed, weight * groundVis, dawn);

    this.quietMotes.rotation.y = elapsed * 0.01;
    (this.quietMotes.material as THREE.PointsMaterial).opacity = 0.38 * weight;
  }

  private updateSanctuary(filmTime: number, elapsed: number, vis: number, dawn: number): void {
    for (const { mat, base } of this.groundMats) mat.opacity = base * vis;
    this.skyGlowMat.uniforms.uOpacity.value = vis;
    this.skyGlowMat.uniforms.uDawn.value = dawn;

    // Posture beats follow the narration:
    // 302.5 "determined to do all of it" -> hunched, writing
    // 305.3 "you don't have to..."        -> pen stops, sits back
    // 318.8 "even the stars..."           -> turns up toward the window and the sky
    // 325.2 "a little rest..."            -> lamp off, settles, watches the sunrise
    const sitBack = smoothstep(306.5, 311.5, filmTime);
    const lookUp = smoothstep(318.6, 322.5, filmTime);
    const rest = smoothstep(325.5, 331, filmTime);
    const writing = 1 - sitBack;

    const breath = Math.sin(elapsed * 1.1) * 0.012;
    this.torsoPivot.rotation.z = THREE.MathUtils.lerp(0.3, -0.06, sitBack) - rest * 0.06 + breath;
    this.headPivot.rotation.z =
      THREE.MathUtils.lerp(0.32, 0.02, sitBack) - lookUp * 0.42 + rest * 0.16 +
      writing * Math.sin(elapsed * 0.9) * 0.03;
    this.armPivot.rotation.z =
      THREE.MathUtils.lerp(0.95, 1.45, sitBack) +
      writing * Math.sin(elapsed * 5.2) * 0.06 +
      rest * 0.1;

    const lampOn = 1 - smoothstep(325.5, 327.5, filmTime);
    const flicker = 0.96 + 0.04 * Math.sin(elapsed * 7.3) * Math.sin(elapsed * 3.1);
    this.windowGlowMat.opacity = vis * (0.6 + 0.3 * lampOn) * flicker;
    this.windowGlowMat.color.setRGB(0.62 + lampOn * 0.2, 0.36 + lampOn * 0.12, 0.16 + lampOn * 0.04);
    this.lampGlow.material.opacity = vis * lampOn * 0.55 * flicker;
    this.windowSpill.material.opacity = vis * (0.18 + 0.16 * lampOn);

    this.fireflies.rotation.y = Math.sin(elapsed * 0.05) * 0.3;
    this.fireflies.position.y = Math.sin(elapsed * 0.4) * 0.08;
    (this.fireflies.material as THREE.PointsMaterial).opacity =
      vis * (0.5 + 0.4 * Math.sin(elapsed * 2.3)) * (1 - dawn * 0.8);
  }

  public dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
