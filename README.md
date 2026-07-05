# 키퍼의 방 (Keeper's Parlor)

**AI 키퍼가 진행하는 1인용 시나리오 RPG 가상 테이블탑.**

시나리오를 넣으면 AI가 분석해서 키퍼(게임 마스터)가 되고, 나레이션과 NPC를 연기하며
실제 주사위(서버 RNG)로 판정을 굴려가면서 세션을 진행한다.
Call of Cthulhu 7판부터 미연시·육성 시뮬·추리물까지 — 시나리오가 정의하는 대로 굴러간다.

## 주요 기능

- **시나리오**: 텍스트/파일(txt·md·PDF) 추가 → AI 분석(장면·판정·진상 구조화) / **✨ AI 작가**가 주제만 받아 인터뷰·주사위를 거쳐 직접 집필 (진상은 비밀) / `.kp.json` 내보내기·가져오기로 공유
- **탐사자**: 자동 생성, 직접 입력, SillyTavern 페르소나·캐릭터 임포트 (AI가 카드를 읽고 캐릭터성에 맞는 시트 생성, 멀티 캐릭터 카드 지원)
- **플레이**: 내 판정은 내가 굴림(🎲) + 밀어붙이기/행운 소모(7e), 스탯 분배 패널, 리롤(피드백 수정)·되돌리기, 다이어제틱 패널(쪽지·폰 화면 등 극중 오브젝트 HTML 렌더), 세션 기억(롤링 요약), 일시적 광기 자동 처리
- **SillyTavern 연동**: 커넥션 프로필로 LLM 호출(API 키 재사용), 페르소나 커넥션 필터, 로어북·CHARM 메모리 주입, 프리셋 스타일 가이드(항목별 on/off)
- **테마 5종** + 서술 문체(소설체/경어체)·글자 크기·진행 템포 설정

## 설치·사용

**→ [설치설명서.md](설치설명서.md)** — 설치부터 기능 하나하나까지 전부 정리돼 있다.

요약:
```bash
# ST 있는 서버 (권장)
cd ~ && git clone https://github.com/siltax03-crypto/keepers-parlor keepers-parlor
cd keepers-parlor/server && npm install
cp ../st-plugin/index.js ~/SillyTavern/plugins/keepers-parlor.js   # ST 플러그인
mkdir -p ~/SillyTavern/data/default-user/extensions/keepers-parlor
cp ../st-ext/* ~/SillyTavern/data/default-user/extensions/keepers-parlor/
pm2 start ~/keepers-parlor/server/index.js --name keepers-parlor
# config.yaml: enableServerPlugins: true → ST 재시작 → http://<서버IP>:4020
```

ST 없이도 됨: `cd server && npm install && npm start` → http://localhost:4020 (Gemini/Claude 키 직접 입력)

## 구조

```
server/            게임 서버 (Express, 포트 4020)
  src/keeper.js    턴 오케스트레이션: LLM ↔ 주사위 ↔ 상태
  src/compiler.js  시나리오 → 구조화 JSON (비밀 정보 분리)
  src/prompts.js   키퍼/컴파일러/작가 프롬프트
  src/coc.js       탐사자 시트 (특성치·기능·파생치)
  src/dice.js      주사위 엔진 (d100, 보너스/패널티, SAN, 대항)
  src/st-reader.js SillyTavern 데이터 리더
  data/            플레이 데이터 (자동 생성, git 밖)
public/            게임 화면 (로비 + 플레이)
st-plugin/         ST 서버 플러그인 (상태/재시작/업데이트)
st-ext/            ST 확장 (런처·관리 버튼)
```

## 핵심 설계

- **주사위는 서버가 굴린다.** LLM은 판정을 요청만 하고, 실제 RNG 결과를 받아 서술한다.
- **비밀 격리.** 진상·KP정보는 keeper 전용 필드로 분리되어 플레이어 화면에 절대 노출되지 않는다.
- **상태는 서버가 관리.** HP/SAN/커스텀 수치/상태이상/인벤토리를 세션에 저장하고 매 턴 주입한다.
- **플레이어 주권.** 내 캐릭터의 행동·판정·밀어붙이기는 전부 내 손으로. 키퍼는 대필하지 않는다.
