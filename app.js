(() => {
  const PUBLIC_ROOM_ID = "public-live-map";
  const UPDATE_INTERVAL_MS = 5_000;

  const myStatusEl = document.getElementById("myStatusBadge");
  const distanceListEl = document.getElementById("distanceList");
  const loadingSkeletonEl = document.getElementById("loadingSkeleton");
  const distanceModalEl = document.getElementById("distanceModal");
  const distanceModalOpenBtn = document.getElementById("distanceModalOpenBtn");
  const distanceModalCloseBtn = document.getElementById("distanceModalCloseBtn");
  const distanceModalBackdrop = document.getElementById("distanceModalBackdrop");

  let app;
  let db;
  let auth;
  let userId = "";
  let nickname = "";
  let map;
  let markers = new Map();
  let positionsRef = null;
  let shareEnabled = false;
  let intervalHandle = null;
  let latestPeople = {};
  let wasSharingBeforeHidden = false;

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
    hideSkeleton();
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
    distanceModalOpenBtn.addEventListener("click", openDistanceModal);
    distanceModalCloseBtn.addEventListener("click", closeDistanceModal);
    distanceModalBackdrop.addEventListener("click", closeDistanceModal);
    document.addEventListener("visibilitychange", handleVisibilityChange);
  }

  async function joinPublicRoom() {
    positionsRef = db.ref(`rooms/${PUBLIC_ROOM_ID}/positions`);

    await db.ref(`rooms/${PUBLIC_ROOM_ID}/members/${userId}`).set({
      nickname,
      joinedAt: firebase.database.ServerValue.TIMESTAMP
    });

    db.ref(`rooms/${PUBLIC_ROOM_ID}/members/${userId}`).onDisconnect().remove();
    db.ref(`rooms/${PUBLIC_ROOM_ID}/positions/${userId}`).onDisconnect().remove();

    positionsRef.on("value", (snapshot) => {
      const people = snapshot.val() || {};
      latestPeople = people;
      renderPeople(people);
      renderDistances(people);
    }, (error) => {
      updateStatus(`위치 동기화 실패: ${error.message}`, "error");
    });

    shareEnabled = true;
  }

  function resetUpdateLoop() {
    clearInterval(intervalHandle);
    intervalHandle = null;
    if (!shareEnabled || !positionsRef) {
      return;
    }
    const interval = UPDATE_INTERVAL_MS;
    intervalHandle = setInterval(() => {
      pushCurrentLocation().catch((err) => {
        updateStatus(`위치 업데이트 실패: ${err.message}`);
      });
    }, interval);
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
        animateMarkerTo(markers.get(id).marker, latlng, 350);
      }

      const ageSec = getAgeSeconds(item.updatedAt);
      const opacity = ageSec > 180 ? 0.45 : ageSec > 60 ? 0.7 : 1;
      markers.get(id).marker.setOpacity(opacity);
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
      distanceListEl.innerHTML = "<div class=\"distance-card empty\">내 위치가 아직 없습니다. 위치 공유를 시작하세요.</div>";
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
        distM,
        updatedAt: person.updatedAt,
        accuracy: person.accuracy
      });
    }

    if (entries.length === 0) {
      distanceListEl.innerHTML = "<div class=\"distance-card empty\">다른 멤버의 위치를 기다리는 중입니다.</div>";
      return;
    }

    entries.sort((a, b) => a.distM - b.distM);
    distanceListEl.innerHTML = entries.map((item) => {
      const ageSec = getAgeSeconds(item.updatedAt);
      const status = getFreshnessStatus(ageSec);
      return `<div class="distance-card">
        <div class="name">${escapeHtml(item.name)} · ${formatDistance(item.distM)}</div>
        <div class="meta">마지막 업데이트 ${formatElapsed(ageSec)}</div>
        <div class="status"><span class="badge ${status.className}">${status.label}</span></div>
        <div class="submeta"><span class="badge badge-info">GPS ±${formatAccuracy(item.accuracy)}</span></div>
      </div>`;
    }).join("");
  }

  function animateMarkerTo(marker, targetLatLng, durationMs) {
    const start = marker.getPosition();
    const sLat = start.getLat();
    const sLng = start.getLng();
    const eLat = targetLatLng.getLat();
    const eLng = targetLatLng.getLng();
    const t0 = performance.now();

    function step(now) {
      const p = Math.min(1, (now - t0) / durationMs);
      const eased = 1 - Math.pow(1 - p, 3);
      const curLat = sLat + (eLat - sLat) * eased;
      const curLng = sLng + (eLng - sLng) * eased;
      marker.setPosition(new kakao.maps.LatLng(curLat, curLng));
      if (p < 1) {
        requestAnimationFrame(step);
      }
    }
    requestAnimationFrame(step);
  }

  function openDistanceModal() {
    distanceModalEl.classList.remove("hidden");
  }

  function closeDistanceModal() {
    distanceModalEl.classList.add("hidden");
  }


  function hideSkeleton() {
    if (loadingSkeletonEl) {
      loadingSkeletonEl.classList.add("hidden");
    }
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

  function formatAccuracy(accuracy) {
    if (typeof accuracy !== "number" || !Number.isFinite(accuracy)) {
      return "-";
    }
    return `${Math.round(accuracy)}m`;
  }

  function getAgeSeconds(updatedAt) {
    if (!updatedAt || typeof updatedAt !== "number") {
      return Number.POSITIVE_INFINITY;
    }
    return Math.max(0, Math.floor((Date.now() - updatedAt) / 1000));
  }

  function getFreshnessStatus(ageSec) {
    if (!Number.isFinite(ageSec)) {
      return { className: "badge-offline", label: "오프라인" };
    }
    if (ageSec <= 60) {
      return { className: "badge-success", label: "정상" };
    }
    if (ageSec <= 180) {
      return { className: "badge-stale", label: "위치 오래됨" };
    }
    return { className: "badge-offline", label: "오프라인" };
  }

  function formatElapsed(ageSec) {
    if (!Number.isFinite(ageSec)) {
      return "정보 없음";
    }
    if (ageSec < 60) {
      return `${ageSec}초 전`;
    }
    const min = Math.floor(ageSec / 60);
    return `${min}분 전`;
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
      wasSharingBeforeHidden = true;
      shareEnabled = false;
      clearInterval(intervalHandle);
      intervalHandle = null;
      db.ref(`rooms/${PUBLIC_ROOM_ID}/positions/${userId}`).remove();
      updateStatus("탭 비활성화: 위치 공유 중지", "offline");
    } else if (!document.hidden) {
      if (wasSharingBeforeHidden) {
        wasSharingBeforeHidden = false;
        shareEnabled = true;
        pushCurrentLocation().catch(() => {});
        resetUpdateLoop();
        updateStatus("탭 활성화: 위치 공유 재개", "success");
      } else if (shareEnabled) {
        updateStatus("탭 활성화: 위치 전송 재개");
        resetUpdateLoop();
        renderDistances(latestPeople);
      }
    }
  }

  function updateStatus(message, status = "neutral") {
    if (!myStatusEl) {
      return;
    }
    myStatusEl.textContent = message;
    myStatusEl.className = `badge ${getStatusBadgeClass(status, message)}`;
  }

  function getStatusBadgeClass(status, message) {
    if (status === "error" || message.includes("실패")) {
      return "badge-error";
    }
    if (status === "offline" || message.includes("중지") || message.includes("일시중지")) {
      return "badge-offline";
    }
    if (status === "stale") {
      return "badge-stale";
    }
    if (status === "success" || message.includes("활성화") || message.includes("연결")) {
      return "badge-success";
    }
    return "badge-neutral";
  }

  init().catch((err) => {
    console.error(err);
    updateStatus(`초기화 실패: ${err.message}`);
    alert(`초기화 실패: ${err.message}\nconfig.js 설정을 확인하세요.`);
  });
})();
