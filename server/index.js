// ── 키퍼의 방 (Keeper's Parlor) — 단독 실행 서버 ────────────────
// ST 서버 플러그인으로 쓸 때는 저장소 루트의 index.js가 진입점이다.
const express = require('express');
const { attach } = require('./app');

const PORT = process.env.PORT || 4020;
const app = express();
attach(app);

app.listen(PORT, () => {
  console.log(`⚿ 키퍼의 방 — http://localhost:${PORT}`);
});
