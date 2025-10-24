// Rubik’s Cube Simulation — 3x3, Vanilla JS, 2D Net Rendering
// Faces: U, R, F, D, L, B — each 3x3 (indices 0..8)
const COLORS = {
  U: "#ffffff", // white
  D: "#f2d000", // yellow
  F: "#00a04b", // green
  B: "#2345ff", // blue
  L: "#ff7a00", // orange
  R: "#e02020"  // red
};

const faceNames = ["U","R","F","D","L","B"];

// cube state initializer
function solvedCube(){
  return {
    U: Array(9).fill("U"),
    R: Array(9).fill("R"),
    F: Array(9).fill("F"),
    D: Array(9).fill("D"),
    L: Array(9).fill("L"),
    B: Array(9).fill("B")
  };
}

let cube = solvedCube();
let history = [];  // applied moves
let future = [];   // redo stack
let moveCount = 0;

// timer
let startTime = null;
let timerId = null;

const elTimer = document.getElementById("timer");
const elMoveCount = document.getElementById("move-count");
const elHistory = document.getElementById("history");
const elScramble = document.getElementById("scramble");
const elReset = document.getElementById("reset");
const elUndo = document.getElementById("undo");
const elRedo = document.getElementById("redo");
const elCube = document.getElementById("cube");
const ctx = elCube.getContext("2d");
const elLastScramble = document.getElementById("last-scramble");

// --- Drawing (2D Net) ---
// Layout (each face 3x3 squares)
//        [U]
// [L] [F] [R] [B]
//        [D]
const TILE = 36;
const GAP = 2;
const facePos = {
  U: {x: TILE*3 + GAP*3, y: GAP},
  L: {x: GAP, y: TILE*3 + GAP*3},
  F: {x: TILE*3 + GAP*3, y: TILE*3 + GAP*3},
  R: {x: TILE*6 + GAP*5, y: TILE*3 + GAP*3},
  B: {x: TILE*9 + GAP*7, y: TILE*3 + GAP*3},
  D: {x: TILE*3 + GAP*3, y: TILE*6 + GAP*5}
};

function drawFace(faceKey){
  const face = cube[faceKey];
  const pos = facePos[faceKey];
  for(let r=0;r<3;r++){
    for(let c=0;c<3;c++){
      const idx = r*3 + c;
      const code = face[idx];
      const color = COLORS[code];
      const x = pos.x + c*(TILE+GAP);
      const y = pos.y + r*(TILE+GAP);
      // tile
      ctx.fillStyle = color;
      ctx.fillRect(x, y, TILE, TILE);
      ctx.strokeStyle = "#00000033";
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, TILE, TILE);
    }
  }
  // face label
  ctx.fillStyle = "#93a4c1";
  ctx.font = "14px system-ui, -apple-system, Segoe UI, Roboto";
  ctx.fillText(faceKey, pos.x, pos.y - 6);
}

function drawCube(){
  ctx.clearRect(0,0,elCube.width, elCube.height);
  ["U","L","F","R","B","D"].forEach(drawFace);
}

// --- Move logic ---
function rotateFace(faceArr, times=1){
  // clockwise rotation (times = 1 or 3)
  for(let t=0;t<times;t++){
    const a = faceArr.slice();
    faceArr[0]=a[6]; faceArr[1]=a[3]; faceArr[2]=a[0];
    faceArr[3]=a[7]; faceArr[4]=a[4]; faceArr[5]=a[1];
    faceArr[6]=a[8]; faceArr[7]=a[5]; faceArr[8]=a[2];
  }
}

function move_U(times=1){
  for(let t=0;t<times;t++){
    rotateFace(cube.U, 1);
    // F[0..2] -> R[0..2] -> B[0..2] -> L[0..2]
    const F = cube.F.slice(0,3);
    cube.F.splice(0,3, ...cube.R.slice(0,3));
    cube.R.splice(0,3, ...cube.B.slice(0,3));
    cube.B.splice(0,3, ...cube.L.slice(0,3));
    cube.L.splice(0,3, ...F);
  }
}
function move_D(times=1){
  for(let t=0;t<times;t++){
    rotateFace(cube.D, 1);
    const F = cube.F.slice(6,9);
    cube.F.splice(6,3, ...cube.L.slice(6,9));
    cube.L.splice(6,3, ...cube.B.slice(6,9));
    cube.B.splice(6,3, ...cube.R.slice(6,9));
    cube.R.splice(6,3, ...F);
  }
}
function move_R(times=1){
  for(let t=0;t<times;t++){
    rotateFace(cube.R, 1);
    const U2=[cube.U[2],cube.U[5],cube.U[8]];
    cube.U[2]=cube.F[2]; cube.U[5]=cube.F[5]; cube.U[8]=cube.F[8];
    cube.F[2]=cube.D[2]; cube.F[5]=cube.D[5]; cube.F[8]=cube.D[8];
    cube.D[2]=cube.B[6]; cube.D[5]=cube.B[3]; cube.D[8]=cube.B[0];
    cube.B[0]=U2[0]; cube.B[3]=U2[1]; cube.B[6]=U2[2];
  }
}
function move_L(times=1){
  for(let t=0;t<times;t++){
    rotateFace(cube.L, 1);
    const U0=[cube.U[0],cube.U[3],cube.U[6]];
    cube.U[0]=cube.B[8]; cube.U[3]=cube.B[5]; cube.U[6]=cube.B[2];
    cube.B[8]=cube.D[0]; cube.B[5]=cube.D[3]; cube.B[2]=cube.D[6];
    cube.D[0]=cube.F[0]; cube.D[3]=cube.F[3]; cube.D[6]=cube.F[6];
    cube.F[0]=U0[0]; cube.F[3]=U0[1]; cube.F[6]=U0[2];
  }
}
function move_F(times=1){
  for(let t=0;t<times;t++){
    rotateFace(cube.F, 1);
    const Ubot=[cube.U[6],cube.U[7],cube.U[8]];
    cube.U[6]=cube.L[8]; cube.U[7]=cube.L[5]; cube.U[8]=cube.L[2];
    cube.L[2]=cube.D[0]; cube.L[5]=cube.D[1]; cube.L[8]=cube.D[2];
    cube.D[0]=cube.R[6]; cube.D[1]=cube.R[3]; cube.D[2]=cube.R[0];
    cube.R[0]=Ubot[0]; cube.R[3]=Ubot[1]; cube.R[6]=Ubot[2];
  }
}
function move_B(times=1){
  for(let t=0;t<times;t++){
    rotateFace(cube.B, 1);
    const Utop=[cube.U[0],cube.U[1],cube.U[2]];
    cube.U[0]=cube.R[2]; cube.U[1]=cube.R[5]; cube.U[2]=cube.R[8];
    cube.R[2]=cube.D[8]; cube.R[5]=cube.D[7]; cube.R[8]=cube.D[6];
    cube.D[6]=cube.L[0]; cube.D[7]=cube.L[3]; cube.D[8]=cube.L[6];
    cube.L[0]=Utop[2]; cube.L[3]=Utop[1]; cube.L[6]=Utop[0];
  }
}

const MOVE_FUNCS = {
  "U": () => move_U(1),
  "U2": () => move_U(2),
  "U'": () => move_U(3),
  "D": () => move_D(1),
  "D2": () => move_D(2),
  "D'": () => move_D(3),
  "R": () => move_R(1),
  "R2": () => move_R(2),
  "R'": () => move_R(3),
  "L": () => move_L(1),
  "L2": () => move_L(2),
  "L'": () => move_L(3),
  "F": () => move_F(1),
  "F2": () => move_F(2),
  "F'": () => move_F(3),
  "B": () => move_B(1),
  "B2": () => move_B(2),
  "B'": () => move_B(3)
};

// --- Helpers ---
function isSolved(c){
  return faceNames.every(fn => c[fn].every(x => x===fn));
}

function applyMove(mv, pushHistory=true){
  if(!MOVE_FUNCS[mv]) return;
  MOVE_FUNCS[mv]();
  if(pushHistory){
    history.push(mv);
    future.length = 0;
    moveCount++;
    updateHistory();
    startTimerIfNeeded();
    if(isSolved(cube)){
      stopTimer();
      toast("Çözüldü! 🎉", true);
    }
  }
  drawCube();
  elMoveCount.textContent = moveCount;
}

function updateHistory(){
  elHistory.textContent = history.join(" ");
}

function toast(msg, success=false){
  const div = document.createElement("div");
  div.textContent = msg;
  div.style.position = "fixed";
  div.style.right = "12px";
  div.style.bottom = "12px";
  div.style.padding = "10px 14px";
  div.style.borderRadius = "10px";
  div.style.border = "1px solid #1f2937";
  div.style.background = success ? "#063e2f" : "#172036";
  div.style.color = "#e5e7eb";
  div.style.boxShadow = "0 10px 24px rgba(0,0,0,.3)";
  document.body.appendChild(div);
  setTimeout(()=>div.remove(), 1500);
}

// --- Scramble ---
const BASIC_MOVES = ["U","D","L","R","F","B"];
function randomScramble(n=25){
  let s = [];
  let prev = "";
  for(let i=0;i<n;i++){
    let m;
    do { m = BASIC_MOVES[Math.floor(Math.random()*BASIC_MOVES.length)]; }
    while(prev && m[0]===prev[0]); // avoid same axis consecutively
    prev = m;
    const r = Math.random();
    if(r<0.33) m+="'";
    else if(r<0.66) m+="2";
    s.push(m);
  }
  return s;
}

function doScramble(n=25){
  const seq = randomScramble(n);
  seq.forEach(m => applyMove(m, true));
  elLastScramble.textContent = seq.join(" ");
}

// --- Undo / Redo ---
function undo(){
  if(history.length===0) return;
  const last = history.pop();
  const inv = invertMove(last);
  future.push(last);
  MOVE_FUNCS[inv]();
  moveCount++;
  updateHistory();
  drawCube();
  elMoveCount.textContent = moveCount;
}
function redo(){
  if(future.length===0) return;
  const mv = future.pop();
  applyMove(mv, true);
}
function invertMove(m){
  if(m.endsWith("2")) return m; // self-inverse
  if(m.endsWith("'")) return m.slice(0,-1);
  return m+"'";
}

// --- Timer ---
function fmt(ms){
  const total = Math.floor(ms/10);
  const cs = total%100;
  const s = Math.floor(total/100)%60;
  const m = Math.floor(total/6000);
  return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}.${String(cs).padStart(2,"0")}`;
}
function startTimerIfNeeded(){
  if(startTime!==null) return;
  startTime = performance.now();
  timerId = setInterval(()=>{
    const now = performance.now();
    elTimer.textContent = fmt(now-startTime);
  }, 30);
}
function stopTimer(){
  if(timerId){
    clearInterval(timerId);
    timerId = null;
  }
}

// --- Reset ---
function resetCube(){
  cube = solvedCube();
  history = [];
  future = [];
  moveCount = 0;
  startTime = null;
  stopTimer();
  elTimer.textContent = "00:00.00";
  elMoveCount.textContent = "0";
  elHistory.textContent = "";
  drawCube();
}

// --- Events ---
document.querySelectorAll("[data-move]").forEach(btn=>{
  btn.addEventListener("click", ()=>{
    const mv = btn.getAttribute("data-move");
    applyMove(mv, true);
  });
});

elScramble.addEventListener("click", ()=>{
  resetCube();
  doScramble(25);
  startTimerIfNeeded();
});

elReset.addEventListener("click", resetCube);
elUndo.addEventListener("click", undo);
elRedo.addEventListener("click", redo);

// Keyboard: U,D,L,R,F,B; Shift adds prime; pressing "2" after a move makes it 2 (buffered)
let keyBuffer = null;
document.addEventListener("keydown", (e)=>{
  const k = e.key.toUpperCase();
  if("UDLRFB".includes(k)){
    keyBuffer = k;
    let mv = k;
    if(e.shiftKey) mv += "'";
    applyMove(mv, true);
  } else if(k==="2" && keyBuffer){
    // apply an extra to make it 2 (we can simply apply same face again)
    const face = keyBuffer;
    // last applied was face or face'
    applyMove(face, true);
    keyBuffer = null;
  } else {
    keyBuffer = null;
  }
});

// init
drawCube();
