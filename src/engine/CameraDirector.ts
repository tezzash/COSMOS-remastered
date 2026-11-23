import * as THREE from 'three';
import { FILM_DURATION, SILENCE_START, clamp, smoothstep } from '../data/chapters';

interface CameraKeyframe {
  t: number;
  pos: [number, number, number];
  look: [number, number, number];
  fov: number;
}

/**
 * Continuous cinematic camera path across the entire 405-second cosmic journey.
 * Zero hard cuts: every chapter flows organically along the -Z cosmic corridor
 * with motivated orbits, subtle altitude shifts, and focal-length breathing.
 */
const KEYFRAMES: CameraKeyframe[] = [
  // PROLOGUE (0..55): Singularity -> Big Bang expansion -> spiral galaxy dive
  { t: 0, pos: [0, 0.3, 18], look: [0, 0, 0], fov: 48 },
  { t: 10, pos: [1.5, 0.8, 28], look: [0, 0, 0], fov: 52 },
  { t: 25, pos: [6.5, 3.2, 34], look: [0, 0.5, -8], fov: 54 },
  { t: 42, pos: [3.2, 2.2, 10], look: [-2, 0.5, -45], fov: 52 },
  { t: 54, pos: [-8, 4.5, -46], look: [-6, 1.5, -86], fov: 48 },

  // CHAPTER I (55..110): Sun -> Earth approach -> Hyderabad sunrise -> birth star rises off the limb
  { t: 62, pos: [-16, 6.2, -62], look: [0, 0, -90], fov: 45 },
  { t: 76, pos: [9.5, 3.8, -68], look: [0.5, 0.5, -90], fov: 44 },
  { t: 92, pos: [11.2, 2.6, -77.5], look: [1.5, 1.2, -90], fov: 42 },
  { t: 101, pos: [9.0, 4.4, -73.5], look: [2.5, 2.4, -92], fov: 43 },
  { t: 108, pos: [4.2, 5.4, -100], look: [0.5, 4.0, -132], fov: 46 },

  // CHAPTER II (110..175): Graceful orbital framing of the sequential Sagittarius constellation
  { t: 118, pos: [0, 4.3, -146], look: [0, 4.5, -175], fov: 46 },
  { t: 136, pos: [8.5, 5.2, -149], look: [0, 4.5, -175], fov: 45 },
  { t: 155, pos: [-8.2, 4.8, -149], look: [0, 4.6, -175], fov: 46 },
  { t: 166, pos: [-2.5, 4.6, -152], look: [0, 4.6, -175], fov: 44 },
  { t: 174, pos: [0, 3.5, -196], look: [0, 1.5, -245], fov: 50 },

  // CHAPTER III (175..225): Pull out into the monumental living star network
  { t: 185, pos: [2.5, 2.8, -218], look: [0, 0, -255], fov: 52 },
  { t: 200, pos: [-8.5, 5.2, -222], look: [0, 0, -255], fov: 54 },
  { t: 214, pos: [-3.5, 7.5, -226], look: [0, 0, -255], fov: 56 },
  { t: 224, pos: [0, 2.5, -280], look: [0, 0, -340], fov: 50 },

  // CHAPTER IV (225..285): Two cosmic forces orbiting into monumental 3D Yin-Yang
  { t: 236, pos: [18, 6.5, -304], look: [0, 0, -340], fov: 48 },
  { t: 254, pos: [-16, 4.5, -308], look: [0, 0, -340], fov: 47 },
  { t: 270, pos: [0.5, 12.5, -304], look: [0, 0, -340], fov: 46 },
  { t: 282, pos: [0, 3.0, -366], look: [0, -1.0, -425], fov: 46 },

  // CHAPTER V (285..335): Quiet hours — slow descent to peaceful planet & softly lit window
  { t: 292, pos: [3.0, 2.4, -394], look: [0, -1.6, -425], fov: 43 },
  { t: 299.5, pos: [1.4, 0.6, -406], look: [-1.6, -4.4, -425.5], fov: 38 },
  { t: 303, pos: [0.4, -1.0, -411], look: [-1.4, -1.6, -427], fov: 34 },
  { t: 308, pos: [1.6, -1.05, -412.5], look: [-0.6, -1.0, -427], fov: 36 },
  { t: 318, pos: [0.6, -1.15, -414.5], look: [-1.0, -0.95, -427], fov: 33 },
  { t: 326, pos: [-0.2, -1.1, -416.5], look: [-0.8, -0.9, -427], fov: 31 },
  { t: 331, pos: [0.4, 1.4, -418], look: [0.4, 0.4, -440], fov: 40 },
  { t: 336, pos: [0, 3.2, -448], look: [0, 0, -515], fov: 48 },

  // FINAL CHAPTER (335..405): Convergence vortex -> pullback -> silence -> solitary star -> ISHA constellation
  { t: 348, pos: [9.5, 5.5, -476], look: [0, 0, -515], fov: 50 },
  { t: 362, pos: [-3.0, 2.0, -468], look: [0, 0, -515], fov: 54 },
  { t: 366, pos: [0, 0.2, -482], look: [0, 0, -515], fov: 44 },
  { t: 371, pos: [0, 0.1, -481], look: [0, 0.2, -515], fov: 45 },
  { t: 380, pos: [0, 1.2, -474], look: [0, 2.2, -515], fov: 50 },
  { t: 405, pos: [0, 1.6, -468], look: [0, 2.4, -515], fov: 52 },
];

const _desiredPos = new THREE.Vector3();
const _desiredLook = new THREE.Vector3();
const _currentLook = new THREE.Vector3(0, 0, 0);

function catmullRom(
  out: THREE.Vector3,
  p0: readonly number[],
  p1: readonly number[],
  p2: readonly number[],
  p3: readonly number[],
  t: number,
): THREE.Vector3 {
  const t2 = t * t;
  const t3 = t2 * t;
  const c = (i: number) =>
    0.5 *
    (2 * p1[i] +
      (-p0[i] + p2[i]) * t +
      (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2 +
      (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t3);
  return out.set(c(0), c(1), c(2));
}

// Keyframes are framed for 16:9. On narrower screens (portrait phones) widen the vertical FOV
// so most of the 16:9 horizontal framing survives instead of cropping subjects off the sides.
const REFERENCE_ASPECT = 16 / 9;
function adaptFovToAspect(fov: number, aspect: number): number {
  if (!(aspect > 0) || aspect >= REFERENCE_ASPECT) return fov;
  const halfV = THREE.MathUtils.degToRad(fov) / 2;
  const halfH = Math.atan(Math.tan(halfV) * REFERENCE_ASPECT);
  const widened = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(halfH) / aspect));
  return Math.min(THREE.MathUtils.lerp(fov, widened, 0.8), 92);
}

export class CameraDirector {
  private initialized = false;
  private pointerX = 0;
  private pointerY = 0;
  private smoothPtrX = 0;
  private smoothPtrY = 0;

  public setPointerOffset(ndcX: number, ndcY: number): void {
    this.pointerX = clamp(ndcX, -1, 1);
    this.pointerY = clamp(ndcY, -1, 1);
  }

  public getSmoothedPointer(out: THREE.Vector2): THREE.Vector2 {
    return out.set(this.smoothPtrX, this.smoothPtrY);
  }

  public snapToTime(camera: THREE.PerspectiveCamera, timeSec: number): void {
    this.initialized = false;
    this.update(camera, timeSec, 0.016, false);
  }

  public update(
    camera: THREE.PerspectiveCamera,
    timeSec: number,
    delta: number,
    reducedMotion: boolean,
  ): void {
    const t = clamp(timeSec, 0, FILM_DURATION);

    // Find bracketing keyframes
    let idx = 0;
    for (let i = 0; i < KEYFRAMES.length - 1; i++) {
      if (t >= KEYFRAMES[i].t && t <= KEYFRAMES[i + 1].t) {
        idx = i;
        break;
      }
    }
    const k0 = KEYFRAMES[idx];
    const k1 = KEYFRAMES[Math.min(idx + 1, KEYFRAMES.length - 1)];
    const km = KEYFRAMES[Math.max(idx - 1, 0)];
    const k2 = KEYFRAMES[Math.min(idx + 2, KEYFRAMES.length - 1)];
    const segLen = Math.max(0.001, k1.t - k0.t);
    // Gentle ease keeps the dolly weighted while Catmull-Rom tangents avoid stop-start at every key
    const rawT = clamp((t - k0.t) / segLen, 0, 1);
    const localT = THREE.MathUtils.lerp(rawT, smoothstep(0, 1, rawT), 0.35);

    catmullRom(_desiredPos, km.pos, k0.pos, k1.pos, k2.pos, localT);
    catmullRom(_desiredLook, km.look, k0.look, k1.look, k2.look, localT);

    // Subtle human-breathing parallax (muted during silence & reduced motion)
    const silenceDamp = 1 - smoothstep(SILENCE_START - 1.5, SILENCE_START + 0.5, t) * 0.85;
    const parallaxScale = reducedMotion ? 0 : 1.15 * silenceDamp;

    const ptrAlpha = 1 - Math.exp(-3.5 * delta);
    this.smoothPtrX += (this.pointerX - this.smoothPtrX) * ptrAlpha;
    this.smoothPtrY += (this.pointerY - this.smoothPtrY) * ptrAlpha;

    _desiredPos.x += this.smoothPtrX * parallaxScale;
    _desiredPos.y += this.smoothPtrY * parallaxScale * 0.65;

    const targetFov = adaptFovToAspect(THREE.MathUtils.lerp(k0.fov, k1.fov, localT), camera.aspect);

    if (!this.initialized || reducedMotion) {
      camera.position.copy(_desiredPos);
      _currentLook.copy(_desiredLook);
      camera.fov = targetFov;
      camera.updateProjectionMatrix();
      camera.lookAt(_currentLook);
      this.initialized = true;
      return;
    }

    // Exponential damping for weighty, cinematic camera glide
    const dampAlpha = 1 - Math.exp(-2.8 * Math.min(delta, 0.1));
    camera.position.lerp(_desiredPos, dampAlpha);
    _currentLook.lerp(_desiredLook, dampAlpha);

    if (Math.abs(camera.fov - targetFov) > 0.02) {
      camera.fov = THREE.MathUtils.lerp(camera.fov, targetFov, dampAlpha);
      camera.updateProjectionMatrix();
    }

    camera.lookAt(_currentLook);
  }
}
