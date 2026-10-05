/**
 * 친구와 이야기해요 — 저장 서버 (구글 시트에 붙은 Apps Script)
 *
 * 하는 일
 *  - save   : 응답 한 줄을 시트 탭(사전조사/세션1/세션2/세션3)에 추가
 *  - upload : 녹음 파일을 드라이브 "친구와이야기해요_녹음" 폴더에 저장하고 링크 반환
 *  - chat   : 다 친구 대답 생성 (Claude API)
 *
 * 스크립트 속성 (프로젝트 설정 → 스크립트 속성)
 *  - ANTHROPIC_API_KEY : Claude API 키 (필수, 다 친구용)
 *  - APP_TOKEN         : (선택) 웹앱 config.js의 APP_TOKEN과 같은 값
 *  - MODEL             : (선택) 다 친구 모델. 비우면 claude-sonnet-5
 *                        예) claude-haiku-4-5, claude-sonnet-5 — 바꾸고 재배포할 필요 없음
 *  - AUDIO_FOLDER_ID   : (자동) setup() 실행 시 만들어짐
 */

const DEFAULT_MODEL = 'claude-sonnet-5';

// 다 친구 지시문 — 나 친구와 말투·길이를 맞추고, 정체를 밝히지 않게 함
const SYSTEM_PROMPT = [
  '너는 "다 친구"야. 한국 초등학교 1학년(만 7살) 아이와 태블릿에서 카드로 대화해.',
  '아이는 글자를 쓰지 않고, 네가 준 카드 중 하나를 눌러서 대답해.',
  '',
  '대답 규칙',
  '- say: 반말로 1~2문장, 40자 안팎. 1학년이 아는 쉬운 낱말만 써.',
  '- 아이가 누른 카드 내용에 맞게 대답하고, 앞에서 나온 이야기를 기억해서 이어 가.',
  '- 같은 말을 되풀이하지 말고 매번 조금씩 다르게 말해.',
  '- 처음 시작할 때는 "안녕! 나는 다 친구야."로 인사하고, 좋아하는 것(동물, 놀이, 간식 등)을 물어봐.',
  '- cards: 아이가 다음에 누를 만한 대답 카드 정확히 4개. 서로 다른 방향의 대답이 되게 골라.. text는 2~8글자.',
  '- 각 카드의 icon: text를 바로 알아볼 수 있는 이모지 1개. 구체적인 사물·동물·음식·장소일 때만 넣고,',
  '  "응", "아니", "몰라", "왜?"처럼 그림으로 나타내기 애매하면 빈 문자열("")로 둬.',
  '  로봇·컴퓨터·전자기기 그림(🤖💻📱 등)은 쓰지 마.',
  '',
  '지켜야 할 것',
  '- 네가 무엇인지(사람, 로봇, 컴퓨터, 프로그램, 인공지능 등) 절대 말하지 마. "인공지능", "AI"라는 말도 쓰지 마.',
  '  누구냐고 물으면 "나는 다 친구야."라고만 해.',
  '- say에는 이모지, 영어, 어려운 한자어를 쓰지 마.',
  '- 이름, 학교, 사는 곳 같은 개인 정보는 묻지 마.',
  '- 무섭거나 슬프거나 어른스러운 이야기는 하지 마. 아이가 그런 쪽으로 가면 부드럽게 다른 즐거운 이야기로 돌려.',
].join('\n');

const REPLY_SCHEMA = {
  type: 'object',
  properties: {
    say: { type: 'string' },
    cards: {
      type: 'array',
      items: {
        type: 'object',
        properties: { text: { type: 'string' }, icon: { type: 'string' } },
        required: ['text', 'icon'],
        additionalProperties: false,
      },
    },
  },
  required: ['say', 'cards'],
  additionalProperties: false,
};

// ── 진입점 ─────────────────────────────────────
function doPost(e) {
  let out;
  try {
    const req = JSON.parse(e.postData.contents);
    checkToken_(req.token);
    switch (req.action) {
      case 'save': out = saveRow_(req.sheet, req.row); break;
      case 'upload': out = uploadAudio_(req.filename, req.mimeType, req.data); break;
      case 'chat': out = chat_(req.history || []); break;
      case 'ping': out = { ok: true }; break;
      default: throw new Error('알 수 없는 요청: ' + req.action);
    }
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return ContentService.createTextOutput('친구와 이야기해요 서버가 켜져 있어요.');
}

function checkToken_(token) {
  const expected = PropertiesService.getScriptProperties().getProperty('APP_TOKEN');
  if (expected && token !== expected) throw new Error('토큰이 맞지 않아요');
}

// ── 시트 저장 ──────────────────────────────────
const ALLOWED_SHEETS = ['사전조사', '세션1', '세션2', '세션3'];

function saveRow_(sheetName, row) {
  if (ALLOWED_SHEETS.indexOf(sheetName) < 0) throw new Error('잘못된 시트: ' + sheetName);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);

    // 머리글: 처음 보는 항목은 오른쪽에 열을 추가
    let headers = sheet.getLastColumn() ? sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0] : [];
    const keys = Object.keys(row);
    const missing = keys.filter(k => headers.indexOf(k) < 0);
    if (missing.length) {
      headers = headers.concat(missing);
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }

    const values = headers.map(h => safeCell_(row[h]));
    sheet.appendRow(values);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

// 교사가 "="로 시작하는 글을 적어도 수식으로 바뀌지 않게
function safeCell_(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string' && /^[=+\-@]/.test(v)) return "'" + v;
  return v;
}

// ── 녹음 저장 ──────────────────────────────────
function uploadAudio_(filename, mimeType, base64) {
  if (!base64) throw new Error('녹음 데이터가 없어요');
  const name = String(filename || 'recording.webm').replace(/[\\/:*?"<>|]/g, '_');
  const blob = Utilities.newBlob(Utilities.base64Decode(base64), mimeType || 'audio/webm', name);
  const file = getAudioFolder_().createFile(blob);
  return { ok: true, url: file.getUrl(), id: file.getId() };
}

function getAudioFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('AUDIO_FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* 지워졌으면 새로 만듦 */ }
  }
  const folder = DriveApp.createFolder('친구와이야기해요_녹음');
  props.setProperty('AUDIO_FOLDER_ID', folder.getId());
  return folder;
}

// ── 다 친구 (Claude API) ─────────────────────────
function chat_(history) {
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty('ANTHROPIC_API_KEY');
  if (!key) throw new Error('ANTHROPIC_API_KEY가 설정되지 않았어요');
  const model = props.getProperty('MODEL') || DEFAULT_MODEL;

  // 웹앱에서 온 대화 기록: user=아이가 누른 카드, assistant=이전 대답(JSON)
  const messages = history
    .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map(m => ({ role: m.role, content: m.content }));
  if (!messages.length || messages[0].role !== 'user') {
    messages.unshift({ role: 'user', content: '(아이가 화면을 켰어. 먼저 인사해 줘.)' });
  }
  if (messages[messages.length - 1].role !== 'user') {
    messages.push({ role: 'user', content: '(아이가 가만히 있어. 이어서 말해 줘.)' });
  }

  const payload = {
    model: model,
    max_tokens: 2000,
    system: SYSTEM_PROMPT,
    output_config: { format: { type: 'json_schema', schema: REPLY_SCHEMA } },
    messages: messages,
  };
  const headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  if (model.indexOf('haiku') < 0) {
    payload.output_config.effort = 'low'; // 짧은 대답이라 빠르게 (Haiku는 effort 미지원)
  }
  if (model.indexOf('opus-5') >= 0) {
    payload.fallbacks = 'default'; // 안전 판단으로 거절되면 서버에서 다른 모델로 다시 시도
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
  }

  const started = Date.now();
  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: headers,
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const code = res.getResponseCode();
  const body = JSON.parse(res.getContentText());
  if (code !== 200) throw new Error('Claude API 오류 ' + code + ': ' + (body.error && body.error.message));
  if (body.stop_reason === 'refusal') throw new Error('대답이 거절되었어요');

  const text = (body.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const reply = JSON.parse(text);
  return {
    ok: true,
    say: String(reply.say || ''),
    cards: (reply.cards || []).slice(0, 4).map(c => ({ text: String(c.text || ''), icon: String(c.icon || '') })),
    model: body.model,
    ms: Date.now() - started,
  };
}

// ── 시트 메뉴: 편집기를 열지 않고 키 넣기·시험하기 ──────────
function onOpen() {
  SpreadsheetApp.getUi().createMenu('친구 웹앱')
    .addItem('① Claude API 키 넣기', 'menuSetKey')
    .addItem('② 다 친구 연결 시험', 'menuTest')
    .addSeparator()
    .addItem('녹음 폴더 열기 주소', 'menuShowFolder')
    .addToUi();
}

function menuSetKey() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('Claude API 키 넣기',
    'console.anthropic.com에서 만든 키를 붙여넣으세요.\n(sk-ant-api03- 로 시작)\n\n키는 이 시트의 스크립트 속성에만 저장됩니다.',
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const key = res.getResponseText().trim();
  if (!/^sk-ant-/.test(key)) {
    ui.alert('키 모양이 아니에요', 'sk-ant- 로 시작하는 키를 붙여넣어 주세요.', ui.ButtonSet.OK);
    return;
  }
  PropertiesService.getScriptProperties().setProperty('ANTHROPIC_API_KEY', key);
  setup();
  ui.alert('저장했어요', '이제 메뉴의 ② 다 친구 연결 시험을 눌러 보세요.', ui.ButtonSet.OK);
}

function menuTest() {
  const ui = SpreadsheetApp.getUi();
  try {
    const r = chat_([]);
    ui.alert('연결 성공 ✓',
      '다 친구: ' + r.say + '\n카드: ' + r.cards.map(c => c.icon + c.text).join(' / ') +
      '\n\n모델 ' + r.model + ' · ' + (r.ms / 1000).toFixed(1) + '초', ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('연결 실패', String(e.message || e), ui.ButtonSet.OK);
  }
}

function menuShowFolder() {
  SpreadsheetApp.getUi().alert('녹음 폴더', getAudioFolder_().getUrl(), SpreadsheetApp.getUi().ButtonSet.OK);
}

// ── 설치·점검용 (편집기에서 직접 실행) ───────────────
/** 처음 한 번 실행: 권한 승인 + 녹음 폴더 만들기 + 탭 만들기 */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ALLOWED_SHEETS.forEach(n => ss.getSheetByName(n) || ss.insertSheet(n));
  const folder = getAudioFolder_();
  Logger.log('녹음 폴더: ' + folder.getUrl());
  UrlFetchApp.getRequest('https://api.anthropic.com'); // 외부 요청 권한 승인용
}

/** 모델 비교: 같은 대화 흐름을 여러 모델로 돌려 대답과 걸린 시간을 로그에 찍음 */
function compareModels() {
  const props = PropertiesService.getScriptProperties();
  const saved = props.getProperty('MODEL');
  const picks = ['고양이', '잠을 많이 자', '아까 뭐라고 했지?'];
  ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5'].forEach(m => {
    props.setProperty('MODEL', m);
    const history = [];
    Logger.log('===== ' + m);
    for (let i = 0; i <= picks.length; i++) {
      const r = chat_(history);
      Logger.log((r.ms / 1000).toFixed(1) + '초  ' + r.say + '  [' + r.cards.map(c => c.icon + c.text).join(' / ') + ']');
      history.push({ role: 'assistant', content: JSON.stringify({ say: r.say, cards: r.cards }) });
      if (i < picks.length) history.push({ role: 'user', content: picks[i] });
    }
  });
  if (saved) props.setProperty('MODEL', saved); else props.deleteProperty('MODEL');
}

/** API 키 점검: 다 친구 첫 인사를 한 번 받아 봄 */
function testChat() {
  const r1 = chat_([]);
  Logger.log(JSON.stringify(r1));
  const r2 = chat_([
    { role: 'assistant', content: JSON.stringify({ say: r1.say, cards: r1.cards }) },
    { role: 'user', content: r1.cards[0].text },
  ]);
  Logger.log(JSON.stringify(r2));
}
