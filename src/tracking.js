export const JOINTS = {
  leftShoulder: { label: 'Left shoulder', points: [23, 11, 13] },
  rightShoulder: { label: 'Right shoulder', points: [24, 12, 14] },
  leftElbow: { label: 'Left elbow', points: [11, 13, 15] },
  rightElbow: { label: 'Right elbow', points: [12, 14, 16] },
  leftKnee: { label: 'Left knee', points: [23, 25, 27] },
  rightKnee: { label: 'Right knee', points: [24, 26, 28] },
};
export const BODY_POINTS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
export const CONNECTIONS = [[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28],[27,29],[29,31],[27,31],[28,30],[30,32],[28,32]];
export const MIN_SPAN = 15;

export function visible(point, margin = 0.015) {
  return !!point && Number.isFinite(point.x) && Number.isFinite(point.y) &&
    (point.visibility ?? 0) >= 0.55 && (point.presence ?? 1) >= 0.55 &&
    point.x > margin && point.x < 1 - margin && point.y > margin && point.y < 1 - margin;
}

export function fullyInFrame(poses) {
  if (!poses || poses.length !== 1) return false;
  const p = poses[0];
  if (!BODY_POINTS.every(i => visible(p[i], 0.025))) return false;
  // Ears and individual heel/toe estimates are often occluded. Require a
  // visible foot on each side, without requiring every redundant landmark.
  for (const foot of [[29, 31], [30, 32]]) {
    if (!foot.some(i => visible(p[i], 0.025))) return false;
    if (foot.some(i => (p[i]?.visibility ?? 0) >= 0.55 &&
      (p[i].x <= 0.015 || p[i].x >= 0.985 || p[i].y <= 0.015 || p[i].y >= 0.985))) return false;
  }
  // Leave approximate room above the face for the top of the head.
  const shoulderY = (p[11].y + p[12].y) / 2;
  return p[0].y - Math.abs(shoulderY - p[0].y) * 0.6 > 0.015;
}

// Signed screen-plane angle. Scale x/y by the actual video dimensions;
// normalized coordinates alone distort angles in non-square video.
export function rawAngle(landmarks, key, width, height) {
  const points = JOINTS[key]?.points;
  if (!points || !points.every(i => visible(landmarks?.[i]))) return null;
  const [a, b, c] = points.map(i => landmarks[i]);
  const u = { x: (a.x - b.x) * width, y: (a.y - b.y) * height };
  const v = { x: (c.x - b.x) * width, y: (c.y - b.y) * height };
  // Foreshortened or coincident landmarks cannot support an angle estimate.
  if (Math.hypot(u.x, u.y) < Math.min(width, height) * 0.025 || Math.hypot(v.x, v.y) < Math.min(width, height) * 0.025) return null;
  return Math.atan2(u.x * v.y - u.y * v.x, u.x * v.x + u.y * v.y) * 180 / Math.PI;
}

export function unwrap(angle, anchor) {
  return anchor + ((angle - anchor + 540) % 360 + 360) % 360 - 180;
}

// Preserve the bend direction from calibration, including crossing 180°.
// A plain acos angle would fold back and miss movement past straight.
export function referenceAngle(raw, startRaw) {
  return unwrap(raw * (Math.sign(startRaw) || 1), Math.abs(startRaw));
}

export function anglesFor(landmarks, keys, width, height) {
  const angles = {};
  for (const key of keys) {
    const angle = rawAngle(landmarks, key, width, height);
    if (angle === null) return null;
    angles[key] = angle;
  }
  return angles;
}

export function makeRanges(start, end, keys) {
  return Object.fromEntries(keys.map(key => {
    const a = Math.abs(start[key]);
    const b = referenceAngle(end[key], start[key]);
    return [key, { startRaw: start[key], start: a, end: b, min: Math.min(a, b), max: Math.max(a, b) }];
  }));
}

// A short median rejects isolated angle spikes; a time-based exponential
// filter removes smaller jitter. Unwrap first so ±180° never averages to 0°.
export class AngleSmoother {
  constructor(keys) { this.keys = keys; this.samples = []; this.values = null; this.lastTime = null; }
  update(angles, time) {
    const dt = this.lastTime === null ? 0 : time - this.lastTime;
    this.lastTime = time;
    const anchor = this.values || angles;
    const unwrapped = Object.fromEntries(this.keys.map(k => [k, unwrap(angles[k], anchor[k])]));
    this.samples = [...this.samples.filter(s => time - s.time <= 350), {time, angles: unwrapped}].slice(-5);
    const alpha = 1 - Math.exp(-Math.min(dt, 200) / 180);
    const values = {};
    for (const k of this.keys) {
      const sorted = this.samples.map(s => unwrap(s.angles[k], anchor[k])).sort((a,b) => a-b);
      const median = sorted[Math.floor(sorted.length / 2)];
      values[k] = this.values ? this.values[k] + alpha * (median - this.values[k]) : median;
    }
    this.values = values;
    return {...values};
  }
}

// Smooth the visual overlay only. Confidence, framing, and alert decisions
// continue to use fresh observations; never invent a missing joint.
export class LandmarkSmoother {
  constructor() { this.reset(); }
  reset() { this.points = null; this.lastTime = null; }
  update(points, time) {
    if (!points) { this.reset(); return null; }
    const dt = this.lastTime === null ? 0 : time - this.lastTime;
    if (dt > 750) this.points = null;
    const alpha = 1 - Math.exp(-dt / 90);
    this.points = points.map((p,i) => {
      const previous = this.points?.[i];
      if (!visible(p) || !visible(previous)) return {...p};
      return {...p, x: previous.x + alpha * (p.x - previous.x), y: previous.y + alpha * (p.y - previous.y)};
    });
    this.lastTime = time;
    return this.points;
  }
}

export class Calibration {
  constructor(keys) {
    this.keys = keys;
    this.stage = 'start';
    this.start = null;
    this.end = null;
    this.readyAt = 0;
    this.lastTime = null;
    this.resetHold();
  }
  resetHold() {
    this.baseline = null; this.stableMs = 0; this.countMs = null;
    this.badSince = null; this.wasEligible = false; this.freshMs = 0;
    this.filter = new AngleSmoother(this.keys);
  }
  remaining() { return Math.max(1, Math.ceil((5000 - this.countMs) / 1000)); }
  pause(time, message, grace = 500) {
    this.wasEligible = false; this.freshMs = 0;
    if (this.badSince === null) this.badSince = time;
    if (time - this.badSince >= grace) {
      const restarted = this.countMs !== null;
      this.resetHold();
      return {stage: this.stage, restarted, message};
    }
    return {stage: this.stage, paused: true, countdown: this.countMs === null ? undefined : this.remaining(), message};
  }
  update({ time, inFrame, angles }) {
    if (this.stage === 'done') return { stage: 'done', message: 'Both positions captured. Review and save your exercise.' };
    const gap = this.lastTime === null ? 0 : time - this.lastTime;
    if (gap > 750 || gap < 0) this.resetHold();
    const dt = Math.max(0, Math.min(gap, 250));
    this.lastTime = time;
    if (time < this.readyAt) return { stage: this.stage, message: 'Start captured. Move to your approved end position.' };
    if (!inFrame || !angles || !this.keys.every(k => Number.isFinite(angles[k]))) {
      return this.pause(time, 'Keep your whole body visible, including hands and feet. Brief tracking dips pause the countdown.');
    }
    const smoothed = this.filter.update(angles, time);
    if (this.stage === 'end' && this.keys.some(k => Math.abs(unwrap(smoothed[k], this.start[k]) - this.start[k]) < MIN_SPAN)) {
      return this.pause(time, 'Move to your approved end pose. Each selected joint needs a distinct start and end position.');
    }
    if (!this.baseline) this.baseline = {...smoothed};
    if (this.keys.some(k => Math.abs(unwrap(smoothed[k], this.baseline[k]) - this.baseline[k]) > 8)) {
      return this.pause(time, `Hold your ${this.stage} position still. Countdown pauses while you move.`, 300);
    }
    this.badSince = null;
    const advance = this.wasEligible ? dt : 0;
    this.wasEligible = true;
    const fresh = this.keys.every(k => Math.abs(unwrap(angles[k], smoothed[k]) - smoothed[k]) <= 8);
    this.freshMs = fresh ? this.freshMs + advance : 0;
    if (this.countMs === null) {
      this.stableMs += advance;
      if (this.stableMs < 700) return {stage: this.stage, message: `Hold your ${this.stage} position still.`};
      this.countMs = 0;
      this.baseline = {...smoothed};
    } else this.countMs = Math.min(5000, this.countMs + advance);
    if (this.countMs < 5000 || this.freshMs < 250) {
      const remaining = this.remaining();
      return {stage: this.stage, countdown: remaining, paused: this.countMs === 5000,
        message: this.countMs === 5000 ? 'Hold still. Waiting for a clear frame to take the picture.' : `Hold your ${this.stage} position. Photo in ${remaining}.`};
    }
    const captured = this.stage;
    this[captured] = {...smoothed};
    this.stage = captured === 'start' ? 'end' : 'done';
    this.readyAt = time + 6500;
    this.resetHold();
    return { stage: this.stage, capture: captured, message: captured === 'start' ? 'Start captured. Move to your approved end position.' : 'Both positions captured. Review and save your exercise.' };
  }
}

export class ExerciseTracker {
  constructor(exercise) {
    this.exercise = exercise;
    this.reps = 0;
    this.flaggedReps = 0;
    this.lastTime = null;
    this.resetMotion();
  }
  resetMotion() {
    this.phase = 'find-start'; this.dwellSince = null;
    this.smoothed = {}; this.warningSince = {}; this.activeWarnings = new Set();
    this.repFlagged = false;
  }
  update(raw, time) {
    const keys = this.exercise.joints;
    if (this.lastTime !== null && time - this.lastTime > 750) this.resetMotion();
    const dt = this.lastTime === null ? 100 : Math.max(0, time - this.lastTime);
    this.lastTime = time;
    if (!raw || !keys.every(k => Number.isFinite(raw[k]))) {
      this.resetMotion();
      return { reliable: false, reps: this.reps, phase: this.phase, warnings: [], counted: false, angles: {} };
    }
    const alpha = 1 - Math.exp(-dt / 100);
    for (const key of keys) {
      const range = this.exercise.ranges[key];
      const value = referenceAngle(raw[key], range.startRaw);
      this.smoothed[key] = this.smoothed[key] === undefined ? value : this.smoothed[key] + alpha * (value - this.smoothed[key]);
      const a = this.smoothed[key];
      const t = this.exercise.tolerance;
      const outside = a < range.min - t || a > range.max + t;
      if (outside) {
        if (this.warningSince[key] === undefined) this.warningSince[key] = time;
        if (time - this.warningSince[key] >= 200) this.activeWarnings.add(key);
      } else {
        delete this.warningSince[key];
        if (a >= range.min - Math.max(0, t - 2) && a <= range.max + Math.max(0, t - 2)) this.activeWarnings.delete(key);
      }
    }
    if (this.activeWarnings.size && this.phase !== 'find-start') this.repFlagged = true;
    const near = endpoint => keys.every(key => {
      const r = this.exercise.ranges[key];
      const targetTolerance = Math.min(8, (r.max - r.min) * 0.22);
      return Math.abs(this.smoothed[key] - r[endpoint]) <= targetTolerance;
    });
    const target = this.phase === 'to-end' ? 'end' : 'start';
    let counted = false;
    if (near(target)) {
      if (this.dwellSince === null) this.dwellSince = time;
      if (time - this.dwellSince >= 250) {
        this.dwellSince = null;
        if (this.phase === 'find-start') { this.phase = 'to-end'; this.repFlagged = false; }
        else if (this.phase === 'to-end') this.phase = 'to-start';
        else { this.reps++; counted = true; if (this.repFlagged) this.flaggedReps++; this.repFlagged = false; this.phase = 'to-end'; }
      }
    } else this.dwellSince = null;
    return { reliable: true, reps: this.reps, phase: this.phase, warnings: [...this.activeWarnings], counted, angles: { ...this.smoothed } };
  }
}
