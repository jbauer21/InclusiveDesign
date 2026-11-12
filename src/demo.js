// Synthetic geometry for class demonstrations and repeatable testing only.
export function demoPose(mode) {
  if (mode === 'lost') return [];
  const p = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.15, z: 0, visibility: 0.99, presence: 0.99 }));
  const put = (i,x,y) => Object.assign(p[i], {x,y});
  put(0,.5,.12); put(7,.47,.13); put(8,.53,.13);
  put(11,.4,.28); put(12,.6,.28); put(13,.31,.4); put(14,.69,.4);
  put(23,.43,.55); put(24,.57,.55); put(25,.40,.72); put(26,.60,.72);
  const degrees = mode === 'end' ? 145 : mode === 'past' ? 170 : 95;
  for (const [a,b,c,side] of [[11,13,15,1],[12,14,16,-1],[23,25,27,1],[24,26,28,-1]]) {
    const ux=(p[a].x-p[b].x)*640, uy=(p[a].y-p[b].y)*480;
    const len=Math.hypot(ux,uy); const r=degrees*Math.PI/180*side;
    const limb = b < 20 ? 90 : 78;
    put(c,p[b].x+(ux*Math.cos(r)-uy*Math.sin(r))/len*limb/640,p[b].y+(ux*Math.sin(r)+uy*Math.cos(r))/len*limb/480);
  }
  // Rotate each whole arm as well, so shoulder calibration can be demonstrated
  // without changing the elbow's independently specified bend.
  const shoulderTurn = mode === 'end' ? 35 : mode === 'past' ? 50 : 0;
  for (const [shoulder,elbow,wrist,side] of [[11,13,15,1],[12,14,16,-1]]) {
    const r=shoulderTurn*Math.PI/180*side;
    for (const i of [elbow,wrist]) {
      const x=(p[i].x-p[shoulder].x)*640,y=(p[i].y-p[shoulder].y)*480;
      put(i,p[shoulder].x+(x*Math.cos(r)-y*Math.sin(r))/640,p[shoulder].y+(x*Math.sin(r)+y*Math.cos(r))/480);
    }
  }
  for (const [ankle,heel,toe] of [[27,29,31],[28,30,32]]) {put(heel,p[ankle].x,p[ankle].y+.018);put(toe,p[ankle].x+.035,p[ankle].y+.028);}
  if (mode === 'outside') p[15].x = -.1;
  return [p];
}
