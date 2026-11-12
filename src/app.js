import { JOINTS, CONNECTIONS, visible, fullyInFrame, anglesFor, makeRanges, Calibration, ExerciseTracker, LandmarkSmoother } from './tracking.js';
import { emptyData, loadData, saveData } from './storage.js';
import { demoPose } from './demo.js';

const $ = id => document.getElementById(id);
const video = $('video'), canvas = $('overlay'), ctx = canvas.getContext('2d');
let data = emptyData(), storageReady = true;
let mode = 'off', stream, model, cameraEpoch = 0, cameraBusy = false;
let calibration = null, draft = null, session = null, workoutItems = [];
let lastFrame = 0, lastVideoTime = -1, lastDraw = 0, lastCountdown = '', lastWarning = 0;
let currentPage = 'calibrate', simulation = 'start';
const overlaySmoother = new LandmarkSmoother();

function node(tag, text, className) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (className) n.className = className;
  return n;
}
function action(text, handler) { const b = node('button', text); b.type = 'button'; b.addEventListener('click', handler); return b; }
function notify(text, error = false) { $('message').textContent = text; $('message').className = error ? 'error' : ''; $('message').hidden = !text; }
function cue(text) { if ($('cue').textContent !== text) $('cue').textContent = text; }
function speak(text, interrupt = true) {
  if (!$('audio').checked || !('speechSynthesis' in window)) return;
  if (interrupt) speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1;
  speechSynthesis.speak(utterance);
}
function clearAlert() { $('alert').hidden = true; $('alert-joints').hidden = true; }
function clearCountdown() { $('countdown').hidden = true; $('countdown').classList.remove('paused'); lastCountdown = ''; }
function selectedJoints() { return [...document.querySelectorAll('[name="joint"]:checked')].map(n => n.value); }
function locked() { return !!calibration || !!session; }
function showPage(page) {
  if (locked() && page !== currentPage) { notify('Finish or cancel the current calibration or workout first.'); return; }
  currentPage = page;
  for (const b of document.querySelectorAll('[data-page]')) {
    if (b.dataset.page === page) b.setAttribute('aria-current','page'); else b.removeAttribute('aria-current');
  }
  for (const name of ['calibrate','exercises','workout']) $('page-' + name).hidden = name !== page;
  $('camera-panel').hidden = page === 'exercises';
  notify('');
}
function updateInputControls() {
  $('camera-start').disabled = cameraBusy || mode === 'camera' || locked();
  $('camera-stop').disabled = mode === 'off' && !cameraBusy;
  $('camera-facing').disabled = mode !== 'off' || cameraBusy || locked();
  $('demo-start').disabled = locked() || mode === 'demo' || cameraBusy;
  $('demo-controls').hidden = mode !== 'demo';
  $('simulation-badge').hidden = mode !== 'demo';
  $('camera-placeholder').hidden = mode !== 'off';
  $('camera-status').textContent = cameraBusy ? 'Loading…' : mode === 'camera' ? 'Live' : mode === 'demo' ? 'Simulation' : 'Off';
}
function cancelCalibration() {
  calibration = null; draft = null; clearCountdown();
  $('review').hidden = true;
  $('calibration-settings').disabled = false;
  $('calibrate-start').hidden = false;
  $('calibrate-cancel').hidden = true;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  cue('Place your whole body in frame, then begin calibration.');
  updateInputControls();
}
function stopInput() {
  overlaySmoother.reset();
  cameraEpoch++;
  stream?.getTracks().forEach(track => track.stop()); stream = null;
  video.srcObject = null; mode = 'off'; cameraBusy = false;
  ctx.clearRect(0,0,canvas.width,canvas.height);
  clearAlert(); clearCountdown();
  if (calibration) cancelCalibration();
  if (session) pauseSession(true);
  updateInputControls();
  cue('Camera is off. Enable it when you are ready.');
}

async function enableCamera() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    notify('Camera access requires localhost or an HTTPS page. Open this app at http://localhost:5173 on this computer.',true); return false;
  }
  stopInput();
  const epoch = ++cameraEpoch;
  cameraBusy = true; updateInputControls(); notify('');
  cue('Allow camera access. Loading the pose tracker may take a moment.');
  try {
    const cameraStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: $('camera-facing').value }, width: { ideal: 1280 }, height: { ideal: 960 } } });
    if (epoch !== cameraEpoch) { cameraStream.getTracks().forEach(t => t.stop()); return false; }
    stream = cameraStream; video.srcObject = stream; await video.play();
    if (!model) {
      const { FilesetResolver, PoseLandmarker } = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/vision_bundle.mjs');
      const vision = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm');
      const options = {
        baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task', delegate: 'GPU' },
        runningMode: 'VIDEO', numPoses: 2, minPoseDetectionConfidence: 0.6, minPosePresenceConfidence: 0.6, minTrackingConfidence: 0.6,
      };
      try { model = await PoseLandmarker.createFromOptions(vision, options); }
      catch { options.baseOptions.delegate = 'CPU'; model = await PoseLandmarker.createFromOptions(vision, options); }
    }
    if (epoch !== cameraEpoch) return false;
    mode = 'camera'; cameraBusy = false; lastVideoTime = -1; lastFrame = performance.now();
    for (const track of stream.getVideoTracks()) track.addEventListener('ended', () => {
      if (epoch === cameraEpoch) { stopInput(); notify('Camera disconnected. Reconnect it and enable the camera again.',true); }
    });
    updateInputControls(); cue('Camera ready. Keep one person fully in frame.');
    return true;
  } catch (error) {
    if (epoch !== cameraEpoch) return false;
    stopInput();
    const reason = error.name === 'NotAllowedError' ? 'Camera permission was denied. Allow it in your browser settings and try again.' : error.name === 'NotFoundError' ? 'No camera was found. Connect a webcam or try a device with a camera.' : error.name === 'NotReadableError' ? 'The camera is busy or unavailable. Close other camera apps and try again.' : 'Could not load the camera or pose model. Check your connection to jsDelivr and Google model storage, then retry.';
    notify(reason,true); return false;
  }
}

function drawPose(context, points, width, height, warnings = [], selected = []) {
  context.lineWidth = Math.max(2,width/260);
  for (const [a,b] of CONNECTIONS) {
    if (!visible(points?.[a]) || !visible(points?.[b])) continue;
    context.strokeStyle = '#6ce8d5'; context.beginPath(); context.moveTo(points[a].x*width,points[a].y*height); context.lineTo(points[b].x*width,points[b].y*height); context.stroke();
  }
  for (const [key, joint] of Object.entries(JOINTS)) {
    const p = points?.[joint.points[1]]; if (!visible(p)) continue;
    const warning = warnings.includes(key);
    context.fillStyle = warning ? '#ef3340' : selected.includes(key) ? '#ffd45b' : '#6ce8d5';
    context.strokeStyle = '#101e26'; context.lineWidth = 2;
    context.beginPath(); context.arc(p.x*width,p.y*height,warning?Math.max(15,width/28):Math.max(6,width/80),0,Math.PI*2); context.fill(); context.stroke();
    if (warning) {
      context.fillStyle = 'white'; context.font = `bold ${Math.max(20,width/32)}px system-ui`; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText('!',p.x*width,p.y*height);
    }
  }
}
function snapshot(points, width, height) {
  const c = document.createElement('canvas'); c.width = 640; c.height = Math.round(640*height/width);
  const context = c.getContext('2d');
  if ($('mirror').checked) { context.translate(c.width,0); context.scale(-1,1); }
  if (mode === 'camera') context.drawImage(video,0,0,c.width,c.height);
  else { context.fillStyle='#172b34';context.fillRect(0,0,c.width,c.height); }
  drawPose(context,points,c.width,c.height,[],draft.joints);
  return { image: c.toDataURL('image/jpeg',0.78), landmarks: points.map(p => ({x:p.x,y:p.y,z:p.z,visibility:p.visibility,presence:p.presence})), width, height, capturedAt: new Date().toISOString() };
}
function photos(parent, exercise) {
  parent.replaceChildren();
  for (const position of ['start','end']) {
    const f = node('figure'); const img = node('img');
    img.src = exercise[position].image; img.alt = `${exercise.name}: ${position} position with tracked joints`;
    f.append(img,node('figcaption',position === 'start' ? 'Start position' : 'Approved end position')); parent.append(f);
  }
}

async function beginCalibration(event) {
  event?.preventDefault();
  if (!$('calibration-form').reportValidity()) return;
  const keys = selectedJoints();
  if (!keys.length) { notify('Select at least one joint.',true); return; }
  if (mode === 'off' && !(await enableCamera())) return;
  draft = { id: crypto.randomUUID(), name: $('exercise-name').value.trim(), joints: keys, tolerance: Number($('tolerance').value), simulated: mode === 'demo', createdAt: new Date().toISOString() };
  if (!draft.name) { notify('Enter an exercise name.',true); return; }
  calibration = new Calibration(keys); lastCountdown = ''; clearAlert(); notify('');
  $('review').hidden = true; $('calibration-settings').disabled = true;
  $('calibrate-start').hidden = true; $('calibrate-cancel').hidden = false;
  cue('Take your start position with your whole body in frame.');
  speak('Take your start position. Keep your whole body in frame, including your hands and feet. Hold still for the countdown.');
  updateInputControls();
}
function processCalibration(poses, width, height, time) {
  const points = poses.length === 1 ? poses[0] : null;
  const result = calibration.update({ time, inFrame: fullyInFrame(poses), angles: anglesFor(points,draft.joints,width,height) });
  cue(poses.length > 1 ? 'Only one person should be visible. Countdown paused.' : result.message);
  if (result.countdown) {
    $('countdown').hidden = false; $('countdown').textContent = result.countdown;
    $('countdown').classList.toggle('paused', !!result.paused);
    const key = result.stage + result.countdown;
    if (!result.paused && lastCountdown !== key) { speak(String(result.countdown)); lastCountdown = key; }
  } else {
    if (lastCountdown && result.restarted) speak('Countdown restarted. Hold still with your whole body visible.');
    clearCountdown();
  }
  if (result.capture) {
    draft[result.capture] = snapshot(points,width,height);
    draft[result.capture].rawAngles = { ...calibration[result.capture] };
    if (result.capture === 'start') speak('Start captured. Move to your approved end position. You have time to move. Hold still for the next countdown.');
    else {
      draft.ranges = makeRanges(calibration.start,calibration.end,draft.joints);
      photos($('capture-photos'),draft);
      $('range-summary').textContent = draft.joints.map(k => `${JOINTS[k].label}: ${Math.round(draft.ranges[k].start)}° → ${Math.round(draft.ranges[k].end)}°`).join(' · ');
      $('review').hidden = false;
      speak('End captured. Both pictures are ready. Return to the screen to review and save your exercise.');
    }
  }
}

async function persist(next, success) {
  if (!storageReady) { notify('Browser storage is unavailable. Enable site storage and reload before saving.',true); return false; }
  try { await saveData(next); data = next; renderLibrary(); notify(success); return true; }
  catch { notify('Could not save. Browser storage may be full or blocked. Your current capture is still here; free space and try again.',true); return false; }
}
function renderLibrary() {
  $('exercise-count').textContent = data.exercises.length;
  const list = $('exercise-list'); list.replaceChildren();
  if (!data.exercises.length) list.append(node('p','No exercises yet. Calibrate your first exercise to get started.'));
  for (const exercise of data.exercises) {
    const card = node('article',undefined,'card'); card.append(node('h3',exercise.name + (exercise.simulated?' (simulated)':'')));
    const images = node('div',undefined,'photos'); photos(images,exercise); card.append(images);
    card.append(node('p',exercise.joints.map(k=>JOINTS[k].label).join(', ') + ` · ${exercise.tolerance}° alert tolerance`));
    card.append(action('Remove exercise',async () => {
      if (!confirm(`Remove “${exercise.name}” and any saved workouts that use it?`)) return;
      await persist({...data,exercises:data.exercises.filter(e=>e.id!==exercise.id),workouts:data.workouts.filter(w=>!w.items.some(i=>i.exerciseId===exercise.id))},'Exercise removed.');
      workoutItems=workoutItems.filter(i=>i.exerciseId!==exercise.id);renderWorkoutItems();
    })); list.append(card);
  }
  const picker = $('exercise-picker'), previous = picker.value; picker.replaceChildren();
  if (!data.exercises.length) { const opt = node('option','Calibrate an exercise first'); opt.value='';picker.append(opt); }
  for (const e of data.exercises) { const opt=node('option',e.name+(e.simulated?' (simulated)':''));opt.value=e.id;picker.append(opt); }
  if (data.exercises.some(e=>e.id===previous)) picker.value=previous;
  $('add-to-workout').disabled = !data.exercises.length;
  const workouts = $('workout-list'); workouts.replaceChildren();
  if (!data.workouts.length) workouts.append(node('p','No saved workouts yet. Add exercises above, then save.'));
  for (const w of data.workouts) {
    const card = node('article',undefined,'card');card.append(node('h3',w.name));
    card.append(node('p',w.items.map(i=>`${data.exercises.find(e=>e.id===i.exerciseId)?.name || 'Missing exercise'} × ${i.reps}`).join(' → ')));
    const controls=node('div',undefined,'row');
    const start=action('Start workout',()=>startWorkout(w));start.disabled=!!session;controls.append(start);
    const remove=action('Remove workout',async()=>{if(confirm(`Remove “${w.name}”?`))await persist({...data,workouts:data.workouts.filter(x=>x.id!==w.id)},'Workout removed.');});remove.disabled=!!session;controls.append(remove);card.append(controls);workouts.append(card);
  }
}
function renderWorkoutItems() {
  const list=$('workout-items');list.replaceChildren();
  workoutItems.forEach((item,index)=>{
    const li=node('li',`${data.exercises.find(e=>e.id===item.exerciseId)?.name} · ${item.reps} reps`);
    const controls=node('div',undefined,'row');
    const up=action('Move up',()=>{[workoutItems[index-1],workoutItems[index]]=[workoutItems[index],workoutItems[index-1]];renderWorkoutItems();});up.disabled=index===0;
    const down=action('Move down',()=>{[workoutItems[index+1],workoutItems[index]]=[workoutItems[index],workoutItems[index+1]];renderWorkoutItems();});down.disabled=index===workoutItems.length-1;
    const remove=action('Remove',()=>{workoutItems.splice(index,1);renderWorkoutItems();});
    for (const b of [up,down,remove]) b.setAttribute('aria-label',`${b.textContent} exercise ${index+1}`);
    controls.append(up,down,remove);li.append(controls);list.append(li);
  });
}
function currentExercise() { return data.exercises.find(e=>e.id===session.workout.items[session.index].exerciseId); }
function currentTarget() { return session.workout.items[session.index].reps; }
function prepareExercise() {
  session.tracker=new ExerciseTracker(currentExercise());session.paused=false;session.complete=false;
  $('session-exercise').textContent=currentExercise().name;
  $('session-progress').textContent=`Exercise ${session.index+1} of ${session.workout.items.length} · start → end → start`;
  $('session-reps').textContent=`0 / ${currentTarget()} reps`;$('live-reps').textContent=$('session-reps').textContent;
  $('pause').textContent='Pause';$('pause').disabled=false;$('next-exercise').disabled=true;
  $('next-exercise').textContent=session.index===session.workout.items.length-1?'Finish workout':'Next exercise';
  photos($('session-references'),currentExercise());clearAlert();
  speak(`${currentExercise().name}. Take your start position. Target ${currentTarget()} repetitions.`);
}
async function startWorkout(workout) {
  if (session) return;
  const exercises=workout.items.map(i=>data.exercises.find(e=>e.id===i.exerciseId));
  if (exercises.some(e=>!e)) {notify('This workout has a missing exercise. Build it again.',true);return;}
  if (new Set(exercises.map(e=>e.simulated)).size>1) {notify('Keep simulated and camera exercises in separate workouts.',true);return;}
  if (exercises[0].simulated && mode!=='demo') {notify('This is a simulated workout. Select “Use simulated input” before starting.',true);return;}
  if (!exercises[0].simulated && mode==='demo') {notify('Enable the real camera to use these calibrated exercises.',true);return;}
  if (mode==='off' && !(await enableCamera())) return;
  session={workout:structuredClone(workout),index:0,results:[],tracker:null,paused:false,complete:false};
  $('session').hidden=false;$('session-summary').hidden=true;$('live-reps').hidden=false;
  $('workout-settings').disabled=true;$('save-workout').disabled=true;
  prepareExercise();renderLibrary();updateInputControls();notify('');
}
function pauseSession(forcePause=false) {
  if (!session || session.complete) return;
  session.paused=forcePause||!session.paused;session.tracker.resetMotion();clearAlert();
  $('pause').textContent=session.paused?'Resume':'Pause';
  cue(session.paused?'Workout paused. Return to your start position before resuming.':'Return to your start position.');
  speak(session.paused?'Workout paused.':'Resuming. Return to your start position.');
}
function finishSession() {
  if (!session) return;
  const results=[...session.results,{name:currentExercise().name,reps:session.tracker.reps,flagged:session.tracker.flaggedReps}];
  $('session-summary-text').textContent=results.map(r=>`${r.name}: ${r.reps} reps (${r.flagged} with a range alert)`).join(' · ');
  session=null;$('session').hidden=true;$('session-summary').hidden=false;$('live-reps').hidden=true;
  $('workout-settings').disabled=false;$('save-workout').disabled=false;
  clearAlert();cue('Session finished.');speak('Session finished.');renderLibrary();updateInputControls();
}
function processWorkout(poses,width,height,time) {
  if (session.paused) {cue('Workout paused. Resume when you are ready.');return [];}
  if (session.complete) {cue('Target reached. Rest, then continue when ready.');return [];}
  const exercise=currentExercise();
  const raw=poses.length===1?anglesFor(poses[0],exercise.joints,width,height):null;
  const result=session.tracker.update(raw,time);
  if (!result.reliable) {clearAlert();cue('Tracking unclear. Reps paused. Keep the selected joints visible; return to start.');return [];}
  $('alert').hidden=!result.warnings.length;$('alert-joints').hidden=!result.warnings.length;
  if (result.warnings.length) {
    $('alert-joints').textContent=result.warnings.map(k=>JOINTS[k].label).join(', ');
    if (time-lastWarning>4500) {speak('Potential Hyperextension Detected. '+result.warnings.map(k=>JOINTS[k].label).join(', '));lastWarning=time;}
  }
  cue(result.phase==='find-start'?'Hold your start position.':result.phase==='to-end'?'Move toward your approved end position.':'Return to your start position to complete the rep.');
  if (result.counted) {
    $('session-reps').textContent=`${result.reps} / ${currentTarget()} reps`;$('live-reps').textContent=$('session-reps').textContent;
    if (!result.warnings.length) speak(`${result.reps}`);
    if (result.reps>=currentTarget()) {session.complete=true;$('next-exercise').disabled=false;$('pause').disabled=true;clearAlert();cue('Target reached. Rest, then continue when ready.');speak('Target reached. Rest, then continue when you are ready.');return [];}
  }
  return result.warnings;
}

function consumeFrame(poses,width,height,time) {
  if (canvas.width!==width||canvas.height!==height) {canvas.width=width;canvas.height=height;$('camera-frame').style.aspectRatio=`${width}/${height}`;}
  ctx.clearRect(0,0,width,height);
  if (mode==='demo') {ctx.fillStyle='#172b34';ctx.fillRect(0,0,width,height);}
  let warnings=[];
  if (calibration) processCalibration(poses,width,height,time);
  else if (session) warnings=processWorkout(poses,width,height,time);
  else if (mode!=='off') cue(fullyInFrame(poses)?'Whole body visible. Ready for calibration or a workout.':poses.length>1?'Only one person should be visible.':'Step back until your head, hands, and feet are visible.');
  const keys=calibration?draft.joints:session?currentExercise().joints:[];
  const drawingPoints = overlaySmoother.update(poses.length === 1 ? poses[0] : null, time);
  if(drawingPoints)drawPose(ctx,drawingPoints,width,height,warnings,keys);
}
function frame(time) {
  requestAnimationFrame(frame);
  if(document.hidden||time-lastDraw<65)return;
  if(mode==='demo') {lastDraw=time;lastFrame=time;consumeFrame(demoPose(simulation),640,480,time);return;}
  if(mode!=='camera'||!model||video.readyState<2||video.currentTime===lastVideoTime)return;
  lastDraw=time;lastVideoTime=video.currentTime;
  try {const result=model.detectForVideo(video,time);lastFrame=performance.now();consumeFrame(result.landmarks,video.videoWidth,video.videoHeight,lastFrame);}
  catch {stopInput();notify('Pose tracking stopped unexpectedly. Enable the camera again to retry.',true);model?.close();model=null;}
}

for(const [key,joint] of Object.entries(JOINTS)) {
  const label=node('label',undefined,'check');const input=node('input');input.type='checkbox';input.name='joint';input.value=key;input.checked=key==='leftElbow';label.append(input,document.createTextNode(joint.label));$('joint-options').append(label);
}
for(const b of document.querySelectorAll('[data-page]'))b.addEventListener('click',()=>showPage(b.dataset.page));
$('camera-start').addEventListener('click',enableCamera);
$('camera-stop').addEventListener('click',stopInput);
$('mirror').addEventListener('change',()=>$('camera-frame').classList.toggle('mirrored',$('mirror').checked));
$('camera-frame').classList.add('mirrored');
$('audio').addEventListener('change',()=>{if(!$('audio').checked&&'speechSynthesis'in window)speechSynthesis.cancel();else speak('Spoken guidance enabled.');});
$('demo-start').addEventListener('click',()=>{stopInput();mode='demo';simulation='start';updateInputControls();notify('Simulated input is active. Use the pose buttons to test calibration and reps.');});
for(const b of document.querySelectorAll('[data-pose]'))b.addEventListener('click',()=>{simulation=b.dataset.pose;});
$('calibration-form').addEventListener('submit',beginCalibration);
$('calibrate-cancel').addEventListener('click',cancelCalibration);
$('retake').addEventListener('click',()=>{cancelCalibration();beginCalibration();});
$('save-exercise').addEventListener('click',async()=>{
  if(!draft?.end||calibration?.stage!=='done')return;
  $('save-exercise').disabled=true;
  if(await persist({...data,exercises:[...data.exercises,structuredClone(draft)]},'Exercise saved.')){cancelCalibration();showPage('exercises');notify('Exercise saved. You can now add it to a workout.');}
  $('save-exercise').disabled=false;
});
$('add-exercise').addEventListener('click',()=>showPage('calibrate'));
$('add-to-workout').addEventListener('click',()=>{
  const exerciseId=$('exercise-picker').value,reps=Number($('rep-target').value);
  if(!exerciseId||!Number.isInteger(reps)||reps<1||reps>200){notify('Choose an exercise and a whole-number target from 1 to 200.',true);return;}
  const exercise=data.exercises.find(e=>e.id===exerciseId);
  if(workoutItems.some(i=>data.exercises.find(e=>e.id===i.exerciseId).simulated!==exercise.simulated)){notify('Keep camera exercises and simulated exercises in separate workouts.',true);return;}
  workoutItems.push({exerciseId,reps});renderWorkoutItems();notify('');
});
$('workout-form').addEventListener('submit',async event=>{
  event.preventDefault();const name=$('workout-name').value.trim();
  if(!name||!workoutItems.length){notify('Name your workout and add at least one exercise.',true);return;}
  $('save-workout').disabled=true;
  if(await persist({...data,workouts:[...data.workouts,{id:crypto.randomUUID(),name,items:structuredClone(workoutItems)}]},'Workout saved.')){workoutItems=[];renderWorkoutItems();$('workout-name').value='';}
  $('save-workout').disabled=false;
});
$('pause').addEventListener('click',async()=>{if(mode==='off'&&!(await enableCamera()))return;pauseSession();});
$('next-exercise').addEventListener('click',()=>{
  if(!session?.complete)return;
  if(session.index===session.workout.items.length-1){finishSession();return;}
  session.results.push({name:currentExercise().name,reps:session.tracker.reps,flagged:session.tracker.flaggedReps});session.index++;prepareExercise();
});
$('end-workout').addEventListener('click',finishSession);
document.addEventListener('visibilitychange',()=>{
  if(document.hidden){calibration?.resetHold();clearCountdown();if(session)pauseSession(true);if('speechSynthesis'in window)speechSynthesis.cancel();}
});
window.addEventListener('pagehide',()=>{stream?.getTracks().forEach(t=>t.stop());if('speechSynthesis'in window)speechSynthesis.cancel();});
setInterval(()=>{if(mode==='camera'&&!document.hidden&&performance.now()-lastFrame>1000)consumeFrame([],video.videoWidth||640,video.videoHeight||480,performance.now());},500);
try{data=await loadData();}catch{storageReady=false;notify('Browser storage is unavailable. You can test tracking, but cannot save until site storage is enabled.',true);}
renderLibrary();updateInputControls();requestAnimationFrame(frame);
