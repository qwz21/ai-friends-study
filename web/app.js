/* 친구와 이야기해요 — 1학년 인공지능 판단 근거 조사용 웹앱
 * 흐름: 시작(학생 ID) → 사전 조사 → 세션1 가 친구 → 세션2 나 친구 → 세션3 다 친구
 * 각 세션: 친구 체험 → "인공지능일까요?" → "왜 그렇게 생각했어요?"(교사 기록 + 녹음)
 */
(() => {
  const C = window.APP_CONFIG;
  const K = window.CONTENT;
  const DEMO = !C.API_URL;
  const $app = document.getElementById("app");

  const state = {
    studentId: "",
    inSession: false,
  };

  // ── 유틸 ────────────────────────────────────
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const nowIso = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const stamp = () => nowIso().replace(/[-: ]/g, "").slice(2, 12); // yyMMddHHmm

  function toast(msg, ms = 2500) {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.hidden = true), ms);
  }

  function render(html) {
    if (window.speechSynthesis) speechSynthesis.cancel();
    $app.innerHTML = html;
    window.scrollTo(0, 0);
    updateTopbar();
  }
  const q = (sel) => $app.querySelector(sel);
  const qa = (sel) => [...$app.querySelectorAll(sel)];

  // localStorage는 막혀 있을 수 있으므로 항상 try/catch
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 저장 공간 없음 */ }
    },
  };

  // ── 서버(Apps Script) 통신 ─────────────────────
  async function api(action, body = {}) {
    if (DEMO) return demoApi(action, body);
    // text/plain으로 보내야 CORS 사전요청 없이 Apps Script에 전달됨
    const res = await fetch(C.API_URL, {
      method: "POST",
      body: JSON.stringify({ action, token: C.APP_TOKEN, ...body }),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || "서버 오류");
    return json;
  }

  async function demoApi(action, body) {
    await sleep(300);
    if (action === "save") return { ok: true };
    if (action === "upload") return { ok: true, url: `연습모드:${body.filename}` };
    if (action === "chat") {
      await sleep(800 + Math.random() * 1500);
      const n = body.history.length;
      return { ok: true, say: n === 0 ? "안녕! 나는 다 친구야. 오늘 뭐 하고 싶어?" : `(연습) "${body.history[n - 1].content}"라고 했구나!`, cards: [{ text: "그림 그리기", icon: "🎨" }, { text: "공놀이", icon: "⚽" }, { text: "노래", icon: "🎵" }, { text: "몰라", icon: "" }] };
    }
    return { ok: true };
  }

  // 저장: 이 기기에 백업 → 서버 전송 → 실패하면 대기열
  async function saveRecord(sheet, row) {
    row = { ...row, 앱버전: C.APP_VERSION || "" };
    const backup = store.get("backup", []);
    backup.push({ sheet, row });
    store.set("backup", backup);
    try {
      await api("save", { sheet, row });
    } catch (e) {
      const pending = store.get("pending", []);
      pending.push({ sheet, row });
      store.set("pending", pending);
      toast("시트 저장 실패 — 이 기기에 보관했어요. 나중에 다시 보내기를 눌러 주세요.", 4000);
    }
    updateTopbar();
  }

  async function flushPending() {
    const pending = store.get("pending", []);
    if (!pending.length) return 0;
    const left = [];
    for (const item of pending) {
      try { await api("save", item); } catch { left.push(item); }
    }
    store.set("pending", left);
    updateTopbar();
    return pending.length - left.length;
  }

  function updateTopbar() {
    document.getElementById("tb-id").textContent = state.studentId ? `학생 ${state.studentId}` : "";
    const n = store.get("pending", []).length;
    const el = document.getElementById("tb-status");
    el.textContent = DEMO ? "연습 모드 (시트로 보내지 않음)" : n ? `미전송 ${n}건` : "";
    el.className = DEMO || n ? "warn" : "";
  }

  // ── 음성(TTS) ───────────────────────────────
  let voice = null;
  function pickVoice() {
    const voices = speechSynthesis.getVoices();
    voice = (C.TTS_VOICE_NAME && voices.find((v) => v.name === C.TTS_VOICE_NAME)) ||
      voices.find((v) => v.lang && v.lang.replace("_", "-").startsWith("ko")) || null;
  }
  if (window.speechSynthesis) {
    pickVoice();
    speechSynthesis.onvoiceschanged = pickVoice;
  }
  function speak(text) {
    return new Promise((resolve) => {
      if (!window.speechSynthesis) return resolve();
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "ko-KR";
      u.rate = C.TTS_RATE;
      if (voice) u.voice = voice;
      // 일부 기기에서 onend가 오지 않아도 멈추지 않도록 시간 제한
      const limit = setTimeout(resolve, 1500 + text.length * 250);
      u.onend = u.onerror = () => { clearTimeout(limit); resolve(); };
      speechSynthesis.speak(u);
    });
  }

  // ── 녹음 ────────────────────────────────────
  // 화면에 녹음기를 붙이고, 업로드된 링크를 recs[key]에 저장
  function recorderHTML(key) {
    return `<div class="row">
      <button class="btn rec" data-rec="${key}">🎙 녹음</button>
      <span class="rec-status" data-recstatus="${key}">녹음 전</span>
    </div>`;
  }

  function attachRecorder(key, label, recs) {
    const btn = q(`[data-rec="${key}"]`);
    const status = q(`[data-recstatus="${key}"]`);
    let rec = null, chunks = [], started = 0, timer = null, lastBlob = null, lastName = "";

    if (!navigator.mediaDevices || !window.MediaRecorder) {
      btn.disabled = true;
      status.textContent = "이 기기/주소에서는 녹음을 쓸 수 없어요 (https 필요)";
      status.className = "rec-status err";
      return;
    }

    const setStatus = (text, cls = "") => { status.textContent = text; status.className = `rec-status ${cls}`; };

    async function upload() {
      setStatus("올리는 중…");
      try {
        const data = await blobToBase64(lastBlob);
        const res = await api("upload", { filename: lastName, mimeType: lastBlob.type, data });
        recs[key] = res.url;
        setStatus(`저장됨 ✓ (${Math.round((Date.now() - started) / 1000)}초 녹음)`, "ok");
        btn.textContent = "🎙 다시 녹음";
      } catch (e) {
        setStatus("올리기 실패 — 눌러서 다시 시도", "err");
        status.onclick = () => { status.onclick = null; upload(); };
        // 실패해도 파일은 남기기: 기기에 내려받기
        downloadBlob(lastBlob, lastName);
      }
    }

    btn.onclick = async () => {
      if (rec && rec.state === "recording") { rec.stop(); return; }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        rec = new MediaRecorder(stream);
        chunks = [];
        rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        rec.onstop = () => {
          clearInterval(timer);
          stream.getTracks().forEach((t) => t.stop());
          const type = rec.mimeType || "audio/webm";
          const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
          lastBlob = new Blob(chunks, { type });
          lastName = `${state.studentId}_${label}_${stamp()}.${ext}`;
          btn.classList.add("rec");
          upload();
        };
        rec.start();
        started = Date.now();
        btn.textContent = "⏹ 멈춤";
        timer = setInterval(() => {
          const s = Math.round((Date.now() - started) / 1000);
          setStatus(`● 녹음 중 ${s}초`, "err");
          if (s >= C.MAX_RECORD_SEC) rec.stop();
        }, 500);
      } catch (e) {
        setStatus("마이크를 쓸 수 없어요. 브라우저에서 마이크를 허용해 주세요.", "err");
      }
    };
    // 화면을 떠날 때 녹음 중이면 멈춤
    return () => rec && rec.state === "recording" && rec.stop();
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1]);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }
  function downloadBlob(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ── 화면 깨우기 / 나가기 방지 ───────────────────
  let wakeLock = null;
  async function keepAwake() {
    try { wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* 지원 안 함 */ }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.inSession) keepAwake();
  });
  window.addEventListener("beforeunload", (e) => {
    if (state.inSession) { e.preventDefault(); e.returnValue = ""; }
  });

  // ════════════════════════════════════════════
  // 시작 화면 (연구자용)
  // ════════════════════════════════════════════
  function startScreen() {
    state.inSession = false;
    const pending = store.get("pending", []).length;
    render(`
      <div class="panel">
        <h1>친구와 이야기해요 <span class="small">연구자 화면</span></h1>
        ${DEMO ? `<p class="mode-demo">연습 모드입니다. config.js에 API_URL을 넣어야 시트에 저장돼요.</p>` : ""}
        <label for="sid">학생 ID (이름 대신 번호, 예: 1-03)</label>
        <input id="sid" type="text" autocomplete="off" value="${esc(state.studentId)}" placeholder="1-03">
        <button class="btn big" data-go="bg">사전 조사부터 시작</button>
        <div class="grid2">
          <button class="btn ghost" data-go="1">세션 1 · 가 친구</button>
          <button class="btn ghost" data-go="2">세션 2 · 나 친구</button>
          <button class="btn ghost" data-go="3">세션 3 · 다 친구</button>
          <button class="btn ghost" id="voice-test">🔊 목소리 확인</button>
        </div>
        <p class="small">목소리: ${esc(voice ? voice.name : "기기 기본 한국어")} · 대기 시간 ${C.RESPONSE_DELAY_MS / 1000}초</p>
        <div class="row">
          ${pending ? `<button class="btn" id="flush">미전송 ${pending}건 다시 보내기</button>` : ""}
          <button class="btn ghost" id="backup">이 기기 백업 내려받기</button>
        </div>
      </div>`);

    qa("[data-go]").forEach((b) => (b.onclick = () => {
      const id = q("#sid").value.trim();
      if (!id) { toast("학생 ID를 먼저 입력해 주세요."); q("#sid").focus(); return; }
      state.studentId = id;
      keepAwake();
      const go = b.dataset.go;
      if (go === "bg") backgroundFlow();
      else sessionIntro(Number(go));
    }));
    q("#voice-test").onclick = () => speak("안녕! 만나서 반가워.");
    q("#backup").onclick = () => {
      const blob = new Blob([JSON.stringify(store.get("backup", []), null, 2)], { type: "application/json" });
      downloadBlob(blob, `백업_${stamp()}.json`);
    };
    if (q("#flush")) q("#flush").onclick = async () => {
      const n = await flushPending();
      toast(`${n}건 보냈어요.`);
      startScreen();
    };
  }

  // ════════════════════════════════════════════
  // 사전 조사
  // ════════════════════════════════════════════
  function backgroundFlow() {
    state.inSession = true;
    const answers = {};
    const recs = {};
    const items = K.background;
    let i = 0;
    let stopRec = null;

    const visible = (item) => !item.showIf || answers[item.showIf.id] === item.showIf.equals;

    function next() {
      stopRec && stopRec();
      stopRec = null;
      i++;
      while (i < items.length && !visible(items[i])) i++;
      if (i >= items.length) return finish();
      show();
    }
    function back() {
      stopRec && stopRec();
      let j = i - 1;
      while (j >= 0 && !visible(items[j])) j--;
      if (j < 0) return startScreen();
      i = j;
      show();
    }
    const navHTML = `<div class="nav"><button class="btn ghost" data-nav="back">← 이전</button></div>`;

    function show() {
      const item = items[i];
      if (item.type === "choice") {
        render(`
          <p class="kid-q">${esc(item.q)}</p>
          <div class="choices">
            ${item.options.map((o) => `<button class="choice ${answers[item.id] === o ? "selected" : ""}" data-v="${esc(o)}">${esc(o)}</button>`).join("")}
          </div>${navHTML}`);
        qa(".choice").forEach((b) => (b.onclick = () => { answers[item.id] = b.dataset.v; next(); }));
      } else if (item.type === "experience") {
        const pic = item.img ? `<img src="${esc(item.img)}" alt="">` : `<div class="icon">${item.icon}</div>`;
        render(`
          <p class="kid-q">${esc(item.q)}</p>
          <div class="exp-card">${pic}<div class="label">${esc(item.label)}</div>${item.sub ? `<p class="kid-sub">${esc(item.sub)}</p>` : ""}</div>
          <div class="choices">
            ${K.experienceOptions.map((o) => `<button class="choice ${answers[item.id] === o ? "selected" : ""}" data-v="${esc(o)}">${esc(o)}</button>`).join("")}
          </div>${navHTML}`);
        qa(".choice").forEach((b) => (b.onclick = () => { answers[item.id] = b.dataset.v; next(); }));
      } else if (item.type === "open") {
        render(`
          <p class="kid-q">${esc(item.q)}</p>
          <div class="teacher">
            <h3>연구자 기록 — 아이가 한 말을 그대로 적어 주세요</h3>
            <textarea id="t">${esc(answers[item.id] || "")}</textarea>
            ${recorderHTML(item.id)}
          </div>
          <div class="nav">
            <button class="btn ghost" data-nav="back">← 이전</button>
            <button class="btn big" id="ok">다음 →</button>
          </div>`);
        stopRec = attachRecorder(item.id, `사전_${item.id}`, recs);
        if (recs[item.id]) { q(`[data-recstatus="${item.id}"]`).textContent = "저장됨 ✓"; q(`[data-recstatus="${item.id}"]`).className = "rec-status ok"; }
        q("#ok").onclick = () => { answers[item.id] = q("#t").value.trim(); next(); };
      }
      const bk = q('[data-nav="back"]');
      if (bk) bk.onclick = back;
    }

    async function finish() {
      const row = { 학생ID: state.studentId, 저장시각: nowIso() };
      for (const item of items) {
        if (!visible(item)) continue;
        if (item.type === "open") {
          row[`${item.id}_교사기록`] = answers[item.id] || "";
          row[`${item.id}_녹음`] = recs[item.id] || "";
        } else {
          row[item.id] = answers[item.id] || "";
        }
      }
      render(`<p class="kid-q">잘했어요!</p><p class="small">저장 중…</p>`);
      await saveRecord("사전조사", row);
      sessionIntro(1);
    }

    i = 0;
    show();
  }

  // ════════════════════════════════════════════
  // 세션
  // ════════════════════════════════════════════
  function sessionIntro(n) {
    state.inSession = true;
    const f = K.friends[n - 1];
    render(`
      <p class="kid-sub">세션 ${n}</p>
      <p class="kid-q">${esc(f.name)}를\n만나 볼까요?</p>
      <div class="nav">
        <button class="btn ghost" id="home">처음 화면</button>
        <button class="btn big" id="go">시작 ▶</button>
      </div>`);
    q("#home").onclick = startScreen;
    q("#go").onclick = () => friendSession(n);
  }

  // 얼굴 두 개: 평소(웃는 얼굴) / 생각 중(눈을 위로 굴리고 입을 다문 얼굴) — 세 친구 모두 같음
  const AVATAR_SVG = `
    <svg class="face-normal" viewBox="0 0 100 100" aria-hidden="true">
      <circle cx="35" cy="42" r="7" fill="#2b2b2b"/><circle cx="65" cy="42" r="7" fill="#2b2b2b"/>
      <path d="M32 64 Q50 78 68 64" stroke="#2b2b2b" stroke-width="6" fill="none" stroke-linecap="round"/></svg>
    <svg class="face-think" viewBox="0 0 100 100" aria-hidden="true">
      <path d="M26 30 L42 27" stroke="#2b2b2b" stroke-width="4" stroke-linecap="round"/>
      <path d="M58 25 L74 30" stroke="#2b2b2b" stroke-width="4" stroke-linecap="round"/>
      <circle cx="35" cy="42" r="8" fill="#fff" stroke="#2b2b2b" stroke-width="3"/><circle cx="65" cy="42" r="8" fill="#fff" stroke="#2b2b2b" stroke-width="3"/>
      <circle class="pupil" cx="38" cy="38" r="4" fill="#2b2b2b"/><circle class="pupil" cx="68" cy="38" r="4" fill="#2b2b2b"/>
      <path d="M42 68 Q50 64 58 68" stroke="#2b2b2b" stroke-width="5" fill="none" stroke-linecap="round"/></svg>
    <span class="think-cloud" aria-hidden="true"><i></i><i></i><b>?</b></span>`;

  // 세 친구가 같은 화면·같은 대기 시간·같은 목소리를 쓰도록 공통 엔진에서 처리
  function friendSession(n) {
    const f = K.friends[n - 1];
    const log = [];
    const t0 = Date.now();
    const latencies = [];
    let errors = 0;
    let busy = false;

    render(`
      <div class="friend-wrap" style="--friend:${f.color};--friend-line:${f.line}">
        <div class="friend-head">
          <div><div class="avatar" id="av">${AVATAR_SVG}</div><div class="friend-name">${esc(f.name)}</div></div>
          <div class="bubble" id="bubble"></div>
        </div>
        <div class="child-line" id="child"></div>
        <div class="cards" id="cards"></div>
      </div>
      <button class="btn end-btn" id="end">체험 끝 ▶</button>`);

    const $bubble = q("#bubble"), $cards = q("#cards"), $child = q("#child"), $av = q("#av");
    const addLog = (who, text) => log.push({ t: Math.round((Date.now() - t0) / 1000), who, text });

    function thinking() {
      $bubble.innerHTML = `<span class="dots"><span></span><span></span><span></span></span>`;
      $cards.classList.add("waiting");
      $av.classList.add("thinking");
    }

    async function friendSays(text, cards, calcLayout = false) {
      addLog("친구", text);
      $bubble.textContent = text;
      $av.classList.remove("thinking");
      $cards.className = `cards ${calcLayout ? "calc" : "choice4"}`;
      if (calcLayout) {
        $cards.innerHTML = cards.map((c, k) => `<button class="card ${/^[+−=]$|지우기/.test(c.text) ? "op" : ""}" data-k="${k}">${esc(c.text)}</button>`).join("");
      } else {
        // 대화 카드: 카드 + 옆의 스피커 버튼(누르면 카드 글자를 읽어 줌)
        $cards.innerHTML = cards.map((c, k) => `
          <div class="card-wrap">
            <button class="card" data-k="${k}">${c.icon ? `<span class="pic">${esc(c.icon)}</span>` : ""}${esc(c.text)}</button>
            <button class="say-btn" data-say="${k}" aria-label="${esc(c.text)} 듣기">🔊</button>
          </div>`).join("");
      }
      $av.classList.add("talking");
      speak(text).then(() => $av.classList.remove("talking"));
    }

    // 모든 대답은 최소 RESPONSE_DELAY_MS 뒤에 나옴
    async function respond(getReply) {
      busy = true;
      thinking();
      const start = Date.now();
      let reply;
      try {
        reply = await getReply();
      } catch (e) {
        errors++;
        reply = { say: "다시 한번 눌러 줄래?", cards: lastCards };
        addLog("오류", String(e.message || e));
      }
      const took = Date.now() - start;
      latencies.push(took);
      if (took < C.RESPONSE_DELAY_MS) await sleep(C.RESPONSE_DELAY_MS - took);
      // 카드는 "글자" 또는 {text, icon} — 하나로 맞춤
      lastCards = reply.cards.map((c) => (typeof c === "string" ? { text: c, icon: "" } : { text: String(c.text), icon: c.icon || "" }));
      await friendSays(reply.say, lastCards, reply.calc);
      busy = false;
    }
    let lastCards = [];

    // ── 가 친구: 계산기 ──
    const CALC_CARDS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "+", "−", "=", "지우기"];
    let expr = "";
    function calcReply() {
      const m = expr.match(/^(\d{1,2})([+−])(\d{1,2})$/);
      if (!m) return { say: "숫자, 더하기나 빼기, 숫자를 차례로 누르고 = 를 눌러 줘.", cards: CALC_CARDS, calc: true };
      const a = Number(m[1]), b = Number(m[3]);
      const plus = m[2] === "+";
      const r = plus ? a + b : a - b;
      // 예: "3 더하기 4는 7이야." / "9 빼기 5는 4야."
      return { say: `${a} ${plus ? "더하기" : "빼기"} ${b}${josaEun(b)} ${r}${josaIya(r)}.`, cards: CALC_CARDS, calc: true };
    }
    function onCalcTap(c) {
      if (c === "지우기") { expr = ""; $child.textContent = ""; return; }
      if (c === "=") {
        addLog("아이", `${expr}=`);
        $child.textContent = `${expr} =`;
        const reply = calcReply();
        expr = "";
        respond(async () => reply);
        return;
      }
      if (/[+−]/.test(c) && (!expr || /[+−]/.test(expr))) return;
      if (/\d/.test(c) && /\d\d$/.test(expr)) return;
      expr += c;
      $child.textContent = expr;
    }

    // ── 나 친구: 정해진 갈래 ──
    let node = K.tree.start;
    function treeReply(nodeId) {
      const nd = K.tree.nodes[nodeId];
      return { say: nd.say, cards: nd.cards.map((c) => ({ text: c[0], icon: c[2] || "" })) };
    }

    // ── 다 친구: 실시간 생성 ──
    const history = [];
    let usedModel = "";
    async function genReply(childText) {
      if (childText !== null) history.push({ role: "user", content: childText });
      const res = await api("chat", { history });
      if (res.model) usedModel = res.model;
      const cards = (res.cards || []).slice(0, 4);
      history.push({ role: "assistant", content: JSON.stringify({ say: res.say, cards }) });
      return { say: res.say, cards };
    }

    let listenCount = 0;
    $cards.onclick = (e) => {
      const sayBtn = e.target.closest(".say-btn");
      if (sayBtn) {
        listenCount++;
        speak(lastCards[Number(sayBtn.dataset.say)].text);
        return;
      }
      const btn = e.target.closest(".card");
      if (!btn || busy) return;
      const label = lastCards[Number(btn.dataset.k)].text;
      if (f.type === "calc") return onCalcTap(label);
      addLog("아이", label);
      $child.textContent = label;
      if (f.type === "tree") {
        const nd = K.tree.nodes[node];
        node = nd.cards.find((c) => c[0] === label)[1];
        respond(async () => treeReply(node));
      } else {
        respond(() => genReply(label));
      }
    };

    // 첫 인사
    if (f.type === "calc") respond(async () => ({ say: f.greeting, cards: CALC_CARDS, calc: true }));
    else if (f.type === "tree") respond(async () => treeReply(node));
    else respond(() => genReply(null));

    // 실수 방지: 3초 안에 한 번 더 눌러야 끝남
    let endArmed = false;
    q("#end").onclick = () => {
      const endBtn = q("#end");
      if (!endArmed) {
        endArmed = true;
        endBtn.textContent = "한 번 더 누르면 끝";
        setTimeout(() => { endArmed = false; if (endBtn.isConnected) endBtn.textContent = "체험 끝 ▶"; }, 3000);
        return;
      }
      speechSynthesis?.cancel();
      const childTurns = log.filter((l) => l.who === "아이").length;
      judgeScreen(n, {
        시작시각: new Date(t0).toLocaleString("sv-SE").slice(0, 19),
        체험시간_초: Math.round((Date.now() - t0) / 1000),
        아이_입력횟수: childTurns,
        설정_대기시간_ms: C.RESPONSE_DELAY_MS,
        실제_처리시간_최대ms: latencies.length ? Math.max(...latencies) : 0,
        오류횟수: errors,
        ...(f.type !== "calc" ? { 카드듣기_횟수: listenCount } : {}),
        ...(f.type === "gen" ? { AI모델: usedModel } : {}),
        대화기록: log.map((l) => `[${l.t}s] ${l.who}: ${l.text}`).join("\n"),
      });
    };
  }

  // 숫자 읽기의 받침에 따라 조사 고르기 (이·사·오·구로 끝나면 받침 없음)
  const noBatchim = (n) => [2, 4, 5, 9].includes(Math.abs(n) % 10);
  const josaIya = (n) => (noBatchim(n) ? "야" : "이야");
  const josaEun = (n) => (noBatchim(n) ? "는" : "은");

  function judgeScreen(n, sessionData) {
    const f = K.friends[n - 1];
    const cls = { 그렇다: "yes", 아니다: "no", 모르겠다: "unsure" };
    render(`
      <p class="kid-q">${esc(K.judgeQuestion(f.name))}</p>
      <div class="choices">
        ${K.judgeOptions.map((o) => `<button class="choice ${cls[o.value]}" data-v="${o.value}">${esc(o.label)}</button>`).join("")}
      </div>`);
    qa(".choice").forEach((b) => (b.onclick = () => reasonScreen(n, sessionData, b.dataset.v)));
  }

  function reasonScreen(n, sessionData, judgment) {
    const f = K.friends[n - 1];
    const recs = {};
    render(`
      <p class="kid-q">${esc(K.reasonQuestion)}</p>
      <div class="teacher">
        <h3>연구자 기록 — 판단: <b>${esc(judgment)}</b> · 아이가 한 말을 그대로 적어 주세요</h3>
        <textarea id="reason"></textarea>
        ${recorderHTML("reason")}
        <h3>연구자 메모 (선택)</h3>
        <textarea id="memo" style="min-height:60px"></textarea>
      </div>
      <div class="nav">
        <button class="btn ghost" id="rejudge">← 판단 다시 고르기</button>
        <button class="btn big" id="save">저장하고 다음 →</button>
      </div>`);
    const stopRec = attachRecorder("reason", `세션${n}_이유`, recs);
    q("#rejudge").onclick = () => { stopRec && stopRec(); judgeScreen(n, sessionData); };
    q("#save").onclick = async () => {
      const status = q('[data-recstatus="reason"]').textContent;
      if (status.includes("녹음 중") || status.includes("올리는 중")) { toast("녹음이 끝나고 저장될 때까지 기다려 주세요."); return; }
      const row = {
        학생ID: state.studentId,
        저장시각: nowIso(),
        세션: n,
        친구: f.name,
        판단: judgment,
        이유_교사기록: q("#reason").value.trim(),
        이유_녹음: recs.reason || "",
        연구자메모: q("#memo").value.trim(),
        ...sessionData,
      };
      render(`<p class="kid-q">고마워요!</p><p class="small">저장 중…</p>`);
      await saveRecord(`세션${n}`, row);
      if (n < 3) sessionIntro(n + 1);
      else doneScreen();
    };
  }

  function doneScreen() {
    state.inSession = false;
    render(`
      <p class="kid-q">모두 끝났어요!\n정말 잘했어요 👏</p>
      <div class="nav"><button class="btn" id="home">다음 학생 (처음 화면)</button></div>`);
    q("#home").onclick = () => { state.studentId = ""; startScreen(); };
  }

  // ── 시작 ──
  if (!DEMO) flushPending();
  startScreen();
})();
