# Inclusive Design exercise prototype

A bare-bones browser application for hands-free start/end calibration, personal joint ranges, saved exercises, ordered workouts, joint highlighting, and repetition counting. Supports left/right shoulders, elbows, and knees. No account, backend, build tool, or npm install is required.

## Run

Install Node.js 18 or newer, open a terminal in this directory, and run:

```sh
npm start
```

Open **http://localhost:5173** in Chrome, Edge, or Safari and allow the camera when requested. `npm run dev` is an alias. If port 5173 is busy, use `PORT=5174 npm start` and open the printed address. Keep the terminal running; Control-C stops it. On macOS, `Start Prototype.command` is a double-click launcher.

The server binds only to your own computer. For an actual phone, serve these same static files over trusted HTTPS and open that HTTPS address on the phone. An ordinary HTTP LAN address will not grant camera access. This project does not set up phone hosting or a tunnel.

The first camera launch loads a pinned MediaPipe JavaScript/WASM runtime from jsDelivr and Google's official pose model from Google Cloud Storage. Internet access to those hosts is required. Camera frames are processed in the browser, with no frame upload in this application's code. The default browser speech voice may use a system speech service; you can turn spoken guidance off. There is no microphone access.

## Use

1. Enable the camera, choose front/rear before enabling if needed, and position it to see your whole body. Keep the bend of the selected joint visible. Avoid having another person in frame.
2. Name the exercise, select the moving shoulders/elbows/knees, and choose an alert tolerance (default 5 degrees). For lateral raises, select the shoulders; a mostly straight elbow does not change angle enough to represent the arm raise.
3. Choose **Begin hands-free calibration** once, then move away from the device. Audio is enabled by default. Allow the initial camera permission prompt before stepping away.
4. Hold the start pose. When head, hands, feet, and major body landmarks are visible with sufficient confidence, the app waits briefly for stability and counts down five seconds of reliable tracking. Brief confidence dips pause the countdown at its current number. Sustained movement or lost framing restarts it. The capture waits for a fresh, clear frame; it never photographs a missing pose just because a timer expired.
5. After the first capture, the app gives a spoken cue and at least 6.5 seconds to move to the therapist-approved end pose. It waits for a distinct, steady pose, then runs another five-second countdown automatically. There is no second capture button.
6. Return to review both pictures and save. Retake both if necessary. Therapist approval is assumed; there is no confirmation checkbox.
7. On **Workout**, name a routine, add saved exercises with target reps, reorder them, and save it. Start a saved workout and hold its start position.
8. A rep requires **start → end → start** with a brief hold at each endpoint. The app highlights affected joints in red with an exclamation mark and displays/speaks **Potential Hyperextension Detected** when an estimate remains outside the saved range plus tolerance. Completed reps with alerts still count. At the target, rest as needed and select **Next exercise** or **Finish workout**.

Turning the camera off or switching tabs pauses the workout. Resume from the start position. Poor joint confidence suspends judgments and resets any incomplete repetition, while preserving completed reps. Camera-off during calibration cancels the capture flow.

## Camera-free demonstration

Open **Camera-free test → Use simulated input**. Name an exercise and start calibration; leave **Start pose** selected until the first capture, then click **End pose**. Save, create a workout, and switch **Start pose → End pose → Start pose** (hold each about one second) to count reps. **Past limit** triggers an alert. **Out of frame** resets calibration; **Tracking lost** suspends workout tracking.

Simulated records are labeled and kept separate from real-camera workouts. The simulation is a deterministic software demonstration, not evidence of camera or clinical accuracy.

## What the prototype measures

- MediaPipe Pose Landmarker provides body landmarks. Angles use the actual image width and height to correct aspect ratio.
- The signed bend angle is normalized to the start pose and unwrapped around 180 degrees, retaining direction when crossing a straight joint. This is a **2D screen-plane estimate**; it is not a validated anatomical or 3D range-of-motion measurement.
- Only selected shoulders/elbows/knees are compared with their saved range. Shoulder angles use hip → shoulder → elbow, relative to the torso. Other landmarks are drawn but are not given calibrated range judgments.
- Start and end must differ by at least 15 degrees for **every selected joint**, preventing overlapping rep targets. This is an engineering constraint for this prototype, not a movement prescription. Do not exceed your approved movement to satisfy it. Small-range/isometric exercises need a different tracking design.
- A warning needs 200 ms beyond the range; a small hysteresis reduces flicker. Angles are smoothed. Repetition endpoints require a 250 ms hold. These engineering defaults are not clinically validated thresholds.
- Calibration uses a five-sample median and a 180 ms exponential angle filter. Stability allows 8 degrees of filtered variation; movement lasting 300 ms or tracking loss lasting 500 ms restarts acquisition. Invalid frames add no countdown time. A 250 ms clear-frame period is required before capture. This calibration steadiness allowance is separate from the exercise's alert tolerance, which is unchanged.
- The displayed skeleton uses a separate 90 ms smoothing filter. This visual filter does not supply the confidence, framing, or workout-alert measurements. Redundant ear and heel/toe estimates no longer all have to be confidently visible: each foot still needs a visible landmark, and confidently out-of-frame feet fail the check.
- Full-body framing is estimated from visible landmarks with a margin; it can be wrong. Occlusion, loose clothing, foreshortening, lighting, left/right swaps, and changing viewpoint can cause missed or incorrect alerts. Keep the original body orientation and camera placement. Changing the preview mirror does not change the measurement coordinates.
- This class prototype cannot diagnose hyperextension or confirm safe exercise. Two reference pictures cannot establish safe limits for every intermediate movement or camera view.

## Storage

IndexedDB stores exercise names, photos with joint overlays, landmarks, calibration angles, and workouts in this browser on this device. Workout video is not recorded; session counts are temporary. A new browser/profile, a changed origin/port, or clearing site data will not retain the same saved records. Storage failures are reported without discarding the current capture.

## Checks

```sh
npm test
```

The tests cover framing, aspect-correct angles, crossing 180 degrees, full five-second countdowns, frame loss/motion resets, automatic second capture, rep order, partial reps, warning debounce, reversed movement, and multiple joints. Live-camera accuracy still requires testing with the intended person, exercise, camera, and therapist-approved poses.

Source: [Google's MediaPipe Pose Landmarker web guide](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker/web_js). SDK pinned to `@mediapipe/tasks-vision@0.10.21`; lite model float16 version 1.

## Files

- `index.html`, `style.css`: minimal responsive interface.
- `src/app.js`: camera, calibration UI, alerts, workouts, and audio.
- `src/tracking.js`: framing checks, angle math, capture and repetition state machines.
- `src/storage.js`: browser-local persistence.
- `src/demo.js`: explicitly simulated input.
- `server.mjs`: dependency-free local development server.
- `test/tracking.test.mjs`: deterministic tracking tests.

## Build verification notes

JavaScript syntax and automated logic tests can run without camera access. The implementation environment restricts opening a local listening port and downloading dependencies, so local server/browser operation and the real MediaPipe camera path must be verified after launching on your computer. No clinical accuracy claim is made.
