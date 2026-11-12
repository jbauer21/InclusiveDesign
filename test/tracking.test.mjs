import test from 'node:test';
import assert from 'node:assert/strict';
import { Calibration, ExerciseTracker, AngleSmoother, LandmarkSmoother, fullyInFrame, anglesFor, rawAngle, referenceAngle, makeRanges } from '../src/tracking.js';
import { demoPose } from '../src/demo.js';

const keys = ['leftElbow'];
const exercise = { joints: keys, tolerance: 5, ranges: makeRanges({leftElbow:95},{leftElbow:145},keys) };
function tick(tracker, angle, time, duration=700) {
  let result;
  for(let t=time;t<=time+duration;t+=50) result=tracker.update(angle===null?null:{leftElbow:angle},t);
  return result;
}
function calibrateUntil(calibration, from, to, angle=95, inFrame=true) {
  let result;
  for(let time=from;time<=to;time+=100) {
    result=calibration.update({time,inFrame,angles:{leftElbow:angle}});
    if(result.capture)return {...result,time};
  }
  return result;
}

test('full-body framing requires hands, feet, confidence, head room, and one person',()=>{
  assert.equal(fullyInFrame(demoPose('start')),true);
  assert.equal(fullyInFrame(demoPose('outside')),false);
  assert.equal(fullyInFrame([]),false);
  assert.equal(fullyInFrame([...demoPose('start'),...demoPose('start')]),false);
  for(const i of [0,11,15,16,27,28]) {
    const poses=demoPose('start');poses[0][i].visibility=.1;
    assert.equal(fullyInFrame(poses),false,`low-confidence point ${i}`);
  }
  const croppedHead=demoPose('start');croppedHead[0][0].y=.04;
  assert.equal(fullyInFrame(croppedHead),false);
  for (const foot of [[29,31],[30,32]]) {
    const poses=demoPose('start');foot.forEach(i=>poses[0][i].visibility=.1);
    assert.equal(fullyInFrame(poses),false);
  }
});

test('aspect-correct joint angles and signed bends for all supported joints',()=>{
  const result=anglesFor(demoPose('end')[0],['leftElbow','rightElbow','leftKnee','rightKnee'],640,480);
  for(const value of Object.values(result))assert.ok(Math.abs(Math.abs(value)-145)<.001);
  const points=demoPose('start')[0];
  points[11]={x:.5,y:.25,visibility:1};points[13]={x:.5,y:.5,visibility:1};points[15]={x:.75,y:.5,visibility:1};
  assert.equal(rawAngle(points,'leftElbow',1600,900),90);
  points[15]={x:.6,y:.5-(1600*.1/900),visibility:1};
  assert.ok(Math.abs(rawAngle(points,'leftElbow',1600,900)-45)<.001);
});

test('occluded and foreshortened joints produce no usable angle',()=>{
  const points=demoPose('start')[0];points[15].visibility=.2;
  assert.equal(anglesFor(points,keys,640,480),null);
  points[15]={...points[13]};
  assert.equal(anglesFor(points,keys,640,480),null);
});

test('straight-line crossing remains above 180 rather than folding backwards',()=>{
  assert.equal(referenceAngle(-175,160),185);
  assert.equal(referenceAngle(175,-160),185);
  const ranges=makeRanges({leftElbow:160},{leftElbow:-175},keys);
  assert.deepEqual(ranges.leftElbow,{startRaw:160,start:160,end:185,min:160,max:185});
});

test('calibration requires steady framing followed by a full five-second countdown',()=>{
  const c=new Calibration(keys);
  const before=calibrateUntil(c,0,5600);
  assert.equal(before.capture,undefined);assert.equal(before.countdown,1);
  const captured=calibrateUntil(c,5700,5700);
  assert.equal(captured.capture,'start');assert.equal(c.stage,'end');
});

test('sustained loss of framing restarts the five-second countdown',()=>{
  const c=new Calibration(keys);
  calibrateUntil(c,0,4000);
  const pause=c.update({time:4100,inFrame:false,angles:{leftElbow:95}});
  assert.equal(pause.paused,true);assert.equal(pause.countdown,2);
  const reset=calibrateUntil(c,4200,4600,95,false);assert.equal(reset.restarted,true);
  assert.equal(calibrateUntil(c,4700,10300).capture,undefined);
  assert.equal(calibrateUntil(c,10400,10400).capture,'start');
});

test('motion during countdown restarts capture instead of photographing movement',()=>{
  const c=new Calibration(keys);calibrateUntil(c,0,4000);
  let restarted=false, capture;
  for(let time=4100;time<12000;time+=100) {
    const result=c.update({time,inFrame:true,angles:{leftElbow:120}});
    restarted ||= !!result.restarted;
    if(result.capture){capture={...result,time};break;}
  }
  assert.equal(restarted,true);assert.ok(capture.time>9800);assert.equal(capture.capture,'start');
});

test('redundant ear or single foot landmark confidence cannot flicker framing',()=>{
  const poses=demoPose('start');
  for(const i of [7,8,29,30])poses[0][i].visibility=.1;
  assert.equal(fullyInFrame(poses),true);
  poses[0][31].x=-.1;
  assert.equal(fullyInFrame(poses),false);
});

test('brief confidence dips keep the countdown visible and do not count lost time',()=>{
  const c=new Calibration(keys);calibrateUntil(c,0,3000);
  const lost=c.update({time:3100,inFrame:false,angles:null});
  assert.equal(lost.countdown,3);assert.equal(lost.paused,true);
  const resumed=c.update({time:3200,inFrame:true,angles:{leftElbow:95}});
  assert.equal(resumed.countdown,3);assert.equal(resumed.restarted,undefined);
  assert.equal(calibrateUntil(c,3300,5700).capture,undefined);
  assert.equal(calibrateUntil(c,5800,5900).capture,'start');
});

test('realistic jitter and intermittent confidence loss still finish calibration',()=>{
  const c=new Calibration(keys);let capture;let entered=false;let smallest=5;
  for(let time=0;time<12000;time+=65) {
    const bad=time>1000&&Math.floor(time/65)%11===0;
    const angle=95+6*Math.sin(time/91)+(Math.floor(time/65)%17===0?12:0);
    const result=c.update({time,inFrame:!bad,angles:bad?null:{leftElbow:angle}});
    if(result.capture){capture=result;break;}
    if(result.countdown){entered=true;assert.ok(result.countdown<=smallest);smallest=result.countdown;}
    if(entered)assert.ok(result.countdown,'countdown must not disappear for short jitter/dropouts');
    assert.notEqual(result.restarted,true);
  }
  assert.equal(capture?.capture,'start');
  assert.ok(Math.abs(c.start.leftElbow-95)<5);
});

test('never capture an absent pose at countdown expiry, even within the grace window',()=>{
  const c=new Calibration(keys);calibrateUntil(c,0,5600);
  for(let time=5700;time<=6000;time+=100) {
    const result=c.update({time,inFrame:false,angles:null});
    assert.equal(result.capture,undefined);assert.equal(result.countdown,1);
  }
  assert.equal(calibrateUntil(c,6100,6300).capture,undefined);
  assert.equal(calibrateUntil(c,6400,6400).capture,'start');
});

test('a fresh angle outlier at expiry cannot become the reference photo',()=>{
  const c=new Calibration(keys);calibrateUntil(c,0,5600);
  assert.equal(c.update({time:5700,inFrame:true,angles:{leftElbow:140}}).capture,undefined);
  assert.equal(calibrateUntil(c,5800,5900).capture,undefined);
  assert.equal(calibrateUntil(c,6000,6100).capture,'start');
  assert.ok(Math.abs(c.start.leftElbow-95)<1);
});

test('angular smoothing preserves direction around the 180-degree boundary',()=>{
  const filter=new AngleSmoother(keys);
  let angle;
  for(let time=0;time<=1200;time+=65)angle=filter.update({leftElbow:time%130===0?179:-179},time).leftElbow;
  assert.ok(angle>175&&angle<185);
});

test('overlay smoothing dampens jitter without carrying forward missing or low-confidence joints',()=>{
  const smoother=new LandmarkSmoother();
  const p=demoPose('start')[0];smoother.update(p,0);
  const moved=structuredClone(p);moved[13].x+=.05;
  const smoothed=smoother.update(moved,65);
  assert.ok(smoothed[13].x>p[13].x&&smoothed[13].x<moved[13].x);
  moved[13].visibility=.1;assert.equal(smoother.update(moved,130)[13].visibility,.1);
  assert.equal(smoother.update(null,195),null);
  assert.equal(smoother.update(p,260)[13].x,p[13].x);
});

test('shoulder measurement changes during lateral raises while elbow measurement stays fixed',()=>{
  const p=demoPose('start')[0];
  p[23]={x:.5,y:.7,visibility:1};p[11]={x:.5,y:.3,visibility:1};
  p[13]={x:.51,y:.5,visibility:1};p[15]={x:.52,y:.7,visibility:1};
  const start=anglesFor(p,['leftShoulder','leftElbow'],640,480);
  p[13]={x:.7,y:.31,visibility:1};p[15]={x:.9,y:.32,visibility:1};
  const end=anglesFor(p,['leftShoulder','leftElbow'],640,480);
  assert.ok(Math.abs(end.leftShoulder-start.leftShoulder)>75);
  assert.ok(Math.abs(referenceAngle(end.leftElbow,start.leftElbow)-Math.abs(start.leftElbow))<1);
});

test('stale video cannot complete a countdown on its next frame',()=>{
  const c=new Calibration(keys);calibrateUntil(c,0,4000);
  const result=c.update({time:20000,inFrame:true,angles:{leftElbow:95}});
  assert.equal(result.capture,undefined);assert.equal(result.countdown,undefined);
});

test('end capture waits for transition time and a distinct pose, with no second click',()=>{
  const c=new Calibration(keys);calibrateUntil(c,0,5700);
  assert.equal(calibrateUntil(c,5800,12100,145).countdown,undefined);
  assert.equal(calibrateUntil(c,12200,15000,95).capture,undefined);
  const end=calibrateUntil(c,15100,23000,145);
  assert.equal(end.capture,'end');assert.equal(c.stage,'done');
  assert.ok(end.time>=20800&&end.time<=23000);
  assert.equal(c.update({time:end.time+100,inFrame:true,angles:{leftElbow:145}}).capture,undefined);
});

test('a complete start-end-start counts exactly once, while holding start does not',()=>{
  const t=new ExerciseTracker(exercise);
  tick(t,95,0);assert.equal(t.phase,'to-end');
  tick(t,145,750);assert.equal(t.phase,'to-start');
  const result=tick(t,95,1500);assert.equal(result.reps,1);
  tick(t,95,2250,3000);assert.equal(t.reps,1);
});

test('starting at end, partial movements, and one-frame endpoint glitches do not count',()=>{
  const t=new ExerciseTracker(exercise);
  tick(t,145,0);tick(t,95,750);tick(t,120,1500);tick(t,95,2250);
  assert.equal(t.reps,0);
  t.update({leftElbow:145},3000);tick(t,95,3050);assert.equal(t.reps,0);
});

test('lost tracking discards an incomplete rep and clears stale warnings',()=>{
  const t=new ExerciseTracker(exercise);
  tick(t,95,0);tick(t,145,750);tick(t,170,1500);
  assert.ok(t.activeWarnings.size);
  t.update(null,2250);assert.equal(t.activeWarnings.size,0);
  tick(t,95,2300);assert.equal(t.reps,0);
  tick(t,145,3050);tick(t,95,3800);assert.equal(t.reps,1);
});

test('range warnings debounce, clear on return, and retain completed flagged reps',()=>{
  const t=new ExerciseTracker(exercise);
  tick(t,95,0);tick(t,145,750);
  const warning=tick(t,170,1500);assert.deepEqual(warning.warnings,keys);
  const result=tick(t,95,2250);assert.equal(result.reps,1);assert.equal(t.flaggedReps,1);assert.deepEqual(result.warnings,[]);
});

test('brief angle noise does not trigger warning',()=>{
  const t=new ExerciseTracker(exercise);tick(t,95,0);
  t.update({leftElbow:170},750);tick(t,95,800);assert.equal(t.activeWarnings.size,0);
});

test('decreasing exercises work and both ends of the saved range are monitored',()=>{
  const e={...exercise,ranges:makeRanges({leftElbow:145},{leftElbow:95},keys)};
  const t=new ExerciseTracker(e);tick(t,145,0);tick(t,95,750);tick(t,145,1500);assert.equal(t.reps,1);
  assert.deepEqual(tick(t,75,2250).warnings,keys);
});

test('multiple selected joints must all reach the endpoint',()=>{
  const joints=['leftElbow','rightElbow'];
  const e={joints,tolerance:5,ranges:makeRanges({leftElbow:95,rightElbow:-95},{leftElbow:145,rightElbow:-145},joints)};
  const t=new ExerciseTracker(e);
  for(let time=0;time<=700;time+=50)t.update({leftElbow:95,rightElbow:-95},time);
  for(let time=750;time<=1500;time+=50)t.update({leftElbow:145,rightElbow:-95},time);
  assert.equal(t.phase,'to-end');
  assert.equal(t.update({leftElbow:145},1550).reliable,false);
});

test('pausing resets partial motion but preserves completed repetitions',()=>{
  const t=new ExerciseTracker(exercise);tick(t,95,0);tick(t,145,750);tick(t,95,1500);
  assert.equal(t.reps,1);t.resetMotion();tick(t,145,2250);tick(t,95,3000);assert.equal(t.reps,1);
});
