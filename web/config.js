// 웹앱 설정 — 배포 후 API_URL만 채우면 됩니다.
window.APP_CONFIG = {
  // 화면을 고칠 때마다 올려 주세요. 시트의 모든 줄에 함께 기록됩니다 (어느 버전으로 조사했는지 확인용).
  APP_VERSION: "pilot-8",

  // Apps Script 웹앱 배포 URL (https://script.google.com/macros/s/.../exec)
  // 비워 두면 "연습 모드": 시트로 보내지 않고 이 기기에만 저장, 다 친구는 가짜 대답을 씁니다.
  API_URL: "https://script.google.com/macros/s/AKfycbzF0PpFoCFRdscTbxubKgbpo1IpgpkaZyv4cCPh1ft0zIfOreOhTV3axR8TQWbpNVZR/exec",

  // Apps Script 스크립트 속성 APP_TOKEN과 같은 값 (설정하지 않았으면 비워 둠)
  APP_TOKEN: "",

  // 세 친구 공통 대기 시간(ms). 카드를 누른 뒤 이 시간이 지나야 대답합니다.
  // 다 친구는 카드가 보이는 순간 4가지 대답을 미리 받아 두므로 보통 이 시간 안에 준비됩니다.
  // 미리 받기 전에 아이가 너무 빨리 누르면 더 걸릴 수 있고, 그 횟수는 시트 "설정초과_횟수"에 기록됩니다.
  RESPONSE_DELAY_MS: 2500,

  // 음성 (세 친구 모두 같은 목소리)
  TTS_RATE: 0.95,
  TTS_VOICE_NAME: "", // 비우면 기기의 첫 번째 한국어 목소리

  // 녹음 최대 길이(초)
  MAX_RECORD_SEC: 120,
};
