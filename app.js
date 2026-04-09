(() => {
  const PUBLIC_ROOM_ID = "public-live-map";
  const DEFAULT_INTERVAL_MS = 60_000;
  const MEETING_INTERVAL_MS = 2_000;
  const MEETING_DURATION_MS = 5 * 60_000;

  const shareToggleBtn = document.getElementById("shareToggleBtn");
  const meetingBtn = document.getElementById("meetingBtn");
  const myStatusEl = document.getElementById("myStatus");
  const currentIntervalEl = document.getElementById("currentInterval");
  const meetingRemainEl = document.getElementById("meetingRemain");
  const distanceListEl = document.getElementById("distanceList");

  let app;
  let db;
  let auth;
  let userId = "";
  let nickname = "";
  let map;
  let markers = new Map();
  let positionsRef = null;
  let modeRef = null;
  let shareEnabled = false;
  let intervalHandle = null;
  let meetingTickHandle = null;
  let latestPeople = {};
  let currentMode = {
    isMeeting: false,
    startedAt: 0,
    endsAt: 0,
    triggeredBy: ""
  };

  async function init() {
    validateConfig();
    await loadKakaoMapSDK(window.APP_CONFIG.kakaoAppKey);
    initFirebase();
    await signIn();
    nickname = `게스트-${userId.slice(0, 6)}`;
    setupMap();
    bindEvents();
    await joinPublicRoom();
    await pushCurrentLocation();
    resetUpdateLoop();
    updateStatus("공개 지도에 자동 연결됨");
  }

  function validateConfig() {
    if (!window.APP_CONFIG) {
      throw new Error("APP_CONFIG가 없습니다. config.js를 확인하세요.");
    }
    if (!window.APP_CONFIG.kakaoAppKey) {
      throw new Error("kakaoAppKey가 비어 있습니다.");
    }
    if (!window.APP_CONFIG.firebase || !window.APP_CONFIG.firebase.apiKey) {
      throw new Error("Firebase 설정이 비어 있습니다.");
    }
  }

  function loadKakaoMapSDK(appKey) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(appKey)}&autoload=false`;
      script.onload = () => {
        window.kakao.maps.load(resolve);
      };
      script.onerror = () => reject(new Error("Kakao SDK 로드 실패"));
      document.head.appendChild(script);
    });
  }

  function initFirebase() {
    app = firebase.initializeApp(window.APP_CONFIG.firebase);
    db = firebase.database(app);
    auth = firebase.auth(app);
  }

  async function signIn() {
    const cred = await auth.signInAnonymously();
    userId = cred.user.uid;
  }

  function setupMap() {
    const mapContainer = document.getElementById("map");
    map = new kakao.maps.Map(mapContainer, {
      center: new kakao.maps.LatLng(33.4996, 126.5312),
      level: 8
    });
  }

  function bindEvents() {
    shareToggleBtn.addEventListener("click", toggleSharing);
    meetingBtn.addEventListener("click", triggerMeetingMode);
    document.addEventListener("visibilitychange", handleVisibilityChange);
  }

  async function joinPublicRoom() {
    positionsRef = db.ref(`rooms/${PUBLIC_ROOM_ID}/positions`);
    modeRef = db.ref(`rooms/${PUBLIC_ROOM_ID}/mode`);

    modeRef.on("value", (snapshot) => {
      const mode = snapshot.val();
      if (!mode) {
        currentMode = { isMeeting: false, startedAt: 0, endsAt: 0, triggeredBy: "" };
      } else {
        currentMode = mode;
      }
      updateModeUI();
      resetUpdateLoop();
    });

    positionsRef.on("value", (snapshot) => {
      const people = snapshot.val() || {};
      latestPeople = people;
      renderPeople(people);
      renderDistances(people);
    });

    await db.ref(`rooms/${PUBLIC_ROOM_ID}/members/${userId}`).set({
      nickname,
      joinedAt: firebase.database.ServerValue.TIMESTAMP
    });

    db.ref(`rooms/${PUBLIC_ROOM_ID}/members/${userId}`).onDisconnect().remove();
    db.ref(`rooms/${PUBLIC_ROOM_ID}/positions/${userId}`).onDisconnect().remove();

    shareEnabled = true;
    shareToggleBtn.textContent = "위치 공유 중지";
  }

  async function toggleSharing() {
    shareEnabled = !shareEnabled;
    shareToggleBtn.textContent = shareEnabled ? "위치 공유 중지" : "위치 공유 시작";
    if (shareEnabled) {
      updateStatus("위치 공유 활성화");
      await pushCurrentLocation();
      resetUpdateLoop();
    } else {
      updateStatus("위치 공유 비활성화");
      clearInterval(intervalHandle);
      intervalHandle = null;
      await db.ref(`rooms/${PUBLIC_ROOM_ID}/positions/${userId}`).remove();
    }
  }

  async function triggerMeetingMode() {
    if (!modeRef) {
      return;
    }
    const now = Date.now();
    const nextMode = {
      isMeeting: true,
      startedAt: now,
      endsAt: now + MEETING_DURATION_MS,
      triggeredBy: nickname || userId
    };
    await modeRef.set(nextMode);
    updateStatus(`모임 모드 시작: 요청자 ${nextMode.triggeredBy}`);
  }

  function resetUpdateLoop() {
    clearInterval(intervalHandle);
    intervalHandle = null;
    if (!shareEnabled || !positionsRef) {
      currentIntervalEl.textContent = "-";
      return;
    }
    const interval = isMeetingActive() ? MEETING_INTERVAL_MS : DEFAULT_INTERVAL_MS;
    currentIntervalEl.textContent = `${interval / 1000}초`;
    intervalHandle = setInterval(() => {
      pushCurrentLocation().catch((err) => {
        updateStatus(`위치 업데이트 실패: ${err.message}`);
      });
    }, interval);
  }

  function isMeetingActive() {
    return Boolean(currentMode.isMeeting && currentMode.endsAt && currentMode.endsAt > Date.now());
  }

  function updateModeUI() {
    clearInterval(meetingTickHandle);
    meetingTickHandle = null;

    if (!isMeetingActive()) {
      meetingRemainEl.textContent = "없음";
      if (currentMode.isMeeting && currentMode.endsAt <= Date.now() && modeRef) {
        modeRef.set({
          isMeeting: false,
          startedAt: currentMode.startedAt || 0,
          endsAt: currentMode.endsAt || 0,
          triggeredBy: currentMode.triggeredBy || ""
        });
      }
      return;
    }

    meetingTickHandle = setInterval(() => {
      const remainMs = Math.max(0, currentMode.endsAt - Date.now());
      const remainSec = Math.floor(remainMs / 1000);
      meetingRemainEl.textContent = `${remainSec}초`;
      if (remainMs <= 0) {
        clearInterval(meetingTickHandle);
        meetingTickHandle = null;
      }
    }, 500);
  }

  async function pushCurrentLocation() {
    if (!positionsRef) {
      return;
    }
    const pos = await getCurrentPosition();
    await db.ref(`rooms/${PUBLIC_ROOM_ID}/positions/${userId}`).set({
      nickname,
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      accuracy: pos.coords.accuracy ?? null,
      updatedAt: firebase.database.ServerValue.TIMESTAMP
    });
    if (map) {
      map.panTo(new kakao.maps.LatLng(pos.coords.latitude, pos.coords.longitude));
    }
  }

  function getCurrentPosition() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error("이 브라우저는 Geolocation을 지원하지 않습니다."));
        return;
      }
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 0
      });
    });
  }

  function renderPeople(people) {
    const seen = new Set(Object.keys(people));
    for (const [id, item] of Object.entries(people)) {
      if (!item || typeof item.lat !== "number" || typeof item.lng !== "number") {
        continue;
      }
      const latlng = new kakao.maps.LatLng(item.lat, item.lng);
      if (!markers.has(id)) {
        const marker = new kakao.maps.Marker({ position: latlng });
        marker.setMap(map);
        const info = new kakao.maps.InfoWindow({
          content: `<div style="padding:6px 8px;font-size:12px;">${escapeHtml(item.nickname || "익명")}</div>`
        });
        info.open(map, marker);
        markers.set(id, { marker, info });
      } else {
        markers.get(id).marker.setPosition(latlng);
      }
    }

    for (const [id, markerPack] of markers.entries()) {
      if (!seen.has(id)) {
        markerPack.info.close();
        markerPack.marker.setMap(null);
        markers.delete(id);
      }
    }
  }

  function renderDistances(people) {
    if (!distanceListEl) {
      return;
    }
    const me = people[userId];
    if (!me || typeof me.lat !== "number" || typeof me.lng !== "number") {
      distanceListEl.innerHTML = "<li>내 위치가 아직 없습니다. 위치 공유를 시작하세요.</li>";
      return;
    }

    const entries = [];
    for (const [id, person] of Object.entries(people)) {
      if (id === userId) {
        continue;
      }
      if (!person || typeof person.lat !== "number" || typeof person.lng !== "number") {
        continue;
      }
      const distM = calcDistanceMeters(me.lat, me.lng, person.lat, person.lng);
      entries.push({
        name: person.nickname || "익명",
        distM
      });
    }

    if (entries.length === 0) {
      distanceListEl.innerHTML = "<li>다른 멤버의 위치를 기다리는 중입니다.</li>";
      return;
    }

    entries.sort((a, b) => a.distM - b.distM);
    distanceListEl.innerHTML = entries
      .map((item) => `<li>${escapeHtml(item.name)}: ${formatDistance(item.distM)}</li>`)
      .join("");
  }

  function calcDistanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const p1 = toRad(lat1);
    const p2 = toRad(lat2);
    const dp = toRad(lat2 - lat1);
    const dl = toRad(lon2 - lon1);
    const a = Math.sin(dp / 2) * Math.sin(dp / 2)
      + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  function toRad(v) {
    return (v * Math.PI) / 180;
  }

  function formatDistance(meters) {
    if (meters < 1000) {
      return `${Math.round(meters)}m`;
    }
    return `${(meters / 1000).toFixed(2)}km`;
  }

  function escapeHtml(text) {
    return String(text)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll("\"", "&quot;")
      .replaceAll("'", "&#39;");
  }

  function handleVisibilityChange() {
    if (document.hidden && shareEnabled) {
      updateStatus("탭 비활성화: 위치 전송 일시중지");
      clearInterval(intervalHandle);
      intervalHandle = null;
    } else if (!document.hidden && shareEnabled) {
      updateStatus("탭 활성화: 위치 전송 재개");
      resetUpdateLoop();
      renderDistances(latestPeople);
    }
  }

  function updateStatus(message) {
    myStatusEl.textContent = message;
  }

  init().catch((err) => {
    console.error(err);
    updateStatus(`초기화 실패: ${err.message}`);
    alert(`초기화 실패: ${err.message}\nconfig.js 설정을 확인하세요.`);
  });
})();
