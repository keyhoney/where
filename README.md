# Jeju Meet Tracker (Skeleton)

카카오 지도 + Firebase Realtime Database 기반의 위치 공유 웹앱 기초 골격입니다.

## 구현된 요구사항

- 접속 시 자동으로 공개 지도 방 참여 (방 코드 입력 없음)
- 닉네임 입력 없이 익명 식별자 자동 부여
- 기본 위치 업데이트 주기: 60초
- 아무나 모임 모드 버튼 클릭 가능
- 모임 모드 동작: 5분 동안 2초 주기 전환
- 5분 종료 후 자동으로 기본 60초 주기로 복귀
- 내 기준 다른 멤버와의 거리 표시

## 1) Firebase 설정

1. Firebase 프로젝트 생성
2. Authentication > Sign-in method > Anonymous 활성화
3. Realtime Database 생성
4. Database > Rules 탭에서 `firebase-rules.json` 내용으로 교체 후 Publish

`firebase-rules.json`은 다음을 강제합니다.

- 익명 로그인(auth) 사용자만 접근 가능
- 해당 방의 `members`에 등록된 사용자만 읽기 가능
- 위치(`positions`)는 본인 UID 경로에만 쓰기 가능
- 모임 모드(`mode`)는 필드 형식과 최대 지속시간(5분) 검증

## 2) Kakao 설정

1. Kakao Developers에서 앱 생성
2. JavaScript 키 발급
3. Web 플랫폼 도메인 등록 (로컬 테스트 포함)

## 3) config.js 입력

`config.example.js`를 복사해 `config.js`를 만든 뒤 실제 값으로 교체하세요.

PowerShell 예시:

```powershell
Copy-Item .\config.example.js .\config.js
```

## 4) 실행

정적 파일 서버로 실행해야 위치 권한을 안정적으로 받을 수 있습니다.

PowerShell 예시:

```powershell
python -m http.server 5500
```

브라우저에서 `http://localhost:5500` 접속

## 참고

- iOS Safari는 백그라운드 위치 추적 제약이 큽니다.
- 탭 비활성화 시 전송을 멈추는 로직이 포함되어 있습니다.
- 필요 시 방 코드 검증/비밀번호 필드를 추가해 참여를 더 엄격히 제한하세요.
