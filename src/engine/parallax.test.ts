import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeBloomParams,
  computeCinemaOptics,
  computeDynamicExposure,
  computeParallaxOffset,
  writeParallaxOffset,
} from './parallax.ts';

test('near-field debris shifts strictly faster than near, mid, and distant star layers', () => {
  const input = {
    cameraPos: { x: 10, y: 4, z: -120 },
    cameraVelocity: { x: 2.4, y: -1.2, z: -6.0 },
    pointerOffset: { x: 0.45, y: -0.3 },
  };
  const opts = { reducedMotion: false, silenceDamp: 1 };

  const far = computeParallaxOffset(input, 0.1, opts);
  const mid = computeParallaxOffset(input, 0.28, opts);
  const near = computeParallaxOffset(input, 0.56, opts);
  const debris = computeParallaxOffset(input, 0.92, opts);

  assert.ok(
    Math.abs(debris.x) > Math.abs(near.x) &&
      Math.abs(near.x) > Math.abs(mid.x) &&
      Math.abs(mid.x) > Math.abs(far.x),
  );
  assert.ok(
    Math.abs(debris.y) > Math.abs(near.y) &&
      Math.abs(near.y) > Math.abs(mid.y) &&
      Math.abs(mid.y) > Math.abs(far.y),
  );
  assert.ok(
    Math.abs(debris.z) > Math.abs(near.z) &&
      Math.abs(near.z) > Math.abs(mid.z) &&
      Math.abs(mid.z) > Math.abs(far.z),
  );
  assert.ok(debris.x < 0);
  assert.ok(debris.z > 0);
});

test('zero camera movement and pointer offset produces zero parallax shift', () => {
  const res = computeParallaxOffset(
    {
      cameraPos: { x: 0, y: 0, z: -200 },
      cameraVelocity: { x: 0, y: 0, z: 0 },
      pointerOffset: { x: 0, y: 0 },
    },
    0.92,
    { reducedMotion: false, silenceDamp: 1 },
  );
  assert.equal(res.x, 0);
  assert.equal(res.y, 0);
  assert.equal(res.z, 0);
});

test('reducedMotion and silenceDamp attenuate parallax cleanly and output stays clamped', () => {
  const extremeInput = {
    cameraPos: { x: 500, y: -500, z: -500 },
    cameraVelocity: { x: 200, y: -200, z: -400 },
    pointerOffset: { x: 1, y: -1 },
  };

  const full = computeParallaxOffset(extremeInput, 0.92, { reducedMotion: false, silenceDamp: 1 });
  assert.ok(Math.abs(full.x) <= 22);
  assert.ok(Math.abs(full.y) <= 16);
  assert.ok(Math.abs(full.z) <= 14);

  const moderateInput = {
    cameraPos: { x: 8, y: 3, z: -100 },
    cameraVelocity: { x: 1.5, y: 0.5, z: -4 },
    pointerOffset: { x: 0.5, y: 0.25 },
  };
  const normal = computeParallaxOffset(moderateInput, 0.5, { reducedMotion: false, silenceDamp: 1 });
  const reduced = computeParallaxOffset(moderateInput, 0.5, { reducedMotion: true, silenceDamp: 1 });
  const silent = computeParallaxOffset(moderateInput, 0.5, { reducedMotion: false, silenceDamp: 0 });

  assert.ok(Math.abs(reduced.x) < Math.abs(normal.x) * 0.25);
  assert.equal(silent.x, 0);
  assert.equal(silent.y, 0);
  assert.equal(silent.z, 0);

  const scratch = { x: 99, y: 99, z: 99 };
  const ret = writeParallaxOffset(scratch, moderateInput, 0.5, {
    reducedMotion: false,
    silenceDamp: 1,
  });
  assert.equal(ret, scratch);
  assert.equal(scratch.x, normal.x);
});

test('computeBloomParams stays cinema-restrained with high dark-void thresholds and peaks strictly at supernova', () => {
  const prologue = computeBloomParams(22);
  const earth = computeBloomParams(76);
  const yinyang = computeBloomParams(250);
  const silence = computeBloomParams(367);
  const supernova = computeBloomParams(373.5);
  const closing = computeBloomParams(400);

  // Restrained baseline: never washes out dark void; high thresholds isolate bright star cores & focal lights
  assert.ok(prologue.strength <= 0.42 && prologue.threshold >= 0.62 && prologue.radius >= 0.55);
  assert.ok(earth.strength < prologue.strength && earth.threshold >= 0.78 && earth.radius >= 0.55);
  assert.ok(yinyang.strength <= 0.40 && yinyang.threshold >= 0.64 && yinyang.radius >= 0.55);

  // Supernova reveal earns the peak bloom, then settles back down
  assert.ok(silence.strength < supernova.strength);
  assert.ok(supernova.strength > prologue.strength && supernova.strength <= 0.76);
  assert.ok(closing.strength < supernova.strength && closing.strength > earth.strength);
});

test('dynamic exposure stays dark-cinema balanced and peripheral chromatic aberration scales with speed & lensing', () => {
  const earthExp = computeDynamicExposure(76);
  const quietExp = computeDynamicExposure(315);
  const silenceExp = computeDynamicExposure(365);
  const flashExp = computeDynamicExposure(371.6);
  const settleExp = computeDynamicExposure(390);

  // Dark theatrical exposure baseline (< 1.0) with earned controlled supernova peak
  assert.ok(earthExp >= 0.72 && earthExp <= 0.88);
  assert.ok(quietExp > earthExp && quietExp <= 0.96);
  assert.ok(silenceExp < earthExp);
  assert.ok(flashExp > 1.15 && flashExp <= 1.35);
  assert.ok(settleExp < flashExp && settleExp < 0.92);

  // Chromatic aberration responds smoothly to camera dive velocity & gravitational lensing
  const slowCalm = computeCinemaOptics(76, 0, false);
  const fastDive = computeCinemaOptics(50, 14, false);
  const singularityLens = computeCinemaOptics(8, 2, false);
  const reduced = computeCinemaOptics(50, 14, true);

  assert.ok(slowCalm.chromaticIntensity > 0.002 && slowCalm.chromaticIntensity < 0.006);
  assert.ok(fastDive.chromaticIntensity > slowCalm.chromaticIntensity);
  assert.ok(singularityLens.chromaticIntensity > slowCalm.chromaticIntensity);
  assert.ok(reduced.chromaticIntensity < slowCalm.chromaticIntensity);
});
