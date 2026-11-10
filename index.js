// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from sogud/mygo-cloudmusic (originally egoist/mygo-cloudmusic).
// See THIRD_PARTY_NOTICES.md for the source revision and scope of the port.
// MyGo Music supplies host and fetch; this module has no Node dependencies.

const SITE = "https://music.163.com";
const EAPI = "https://interfacepc.music.163.com";
// Protocol key shared by the upstream client, not a user's credential.
const EAPI_KEY = "e82ckenh8dichen8";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const EAPI_UA = "NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)";
const PAGE_SIZE = 30;
const PODCAST_LIMIT = 30;
// A page name carries the hot-podcast offset. Bound it so a made-up page
// cannot ask for an arbitrarily deep list.
const PODCAST_OFFSET_LIMIT = 10000;
const PLAYLIST_LIMIT = 1000;
const PRIVATE_RADAR = "3136952023";
const COOKIE_NAMES = ["MUSIC_U", "__csrf", "NMTID"];
// Quality order the host understands, and NetEase's names for it. Asking goes
// down one level at a time, never past standard, never into a trial.
const STREAM_LEVELS = { standard: "standard", high: "exhigh", lossless: "lossless" };
const LOWER_QUALITY = { lossless: "high", high: "standard", standard: null };
const QUALITY_NAMES = { standard: "标准音质", high: "高音质", lossless: "无损" };
// One request, and one retry of a failure that may have been a moment's.
const STREAM_ATTEMPTS = 2;
const STREAM_RETRY_MS = 1000;
// Requests that share this plugin's fetch path keep a hard timeout. The stream
// path shortens it to the time left in its own budget.
const REQUEST_TIMEOUT_MS = 12000;
// A refused source request says the next one should not leave immediately:
// NetEase prefetch and the real play often ask back to back.
const STREAM_COOLDOWN_MS = 2000;
// Reuse a successful source only long enough to join a prefetch with the play
// that follows it. The host already caches the audio itself.
const STREAM_CACHE_TTL_MS = 15000;
const STREAM_CACHE_LIMIT = 12;
// MyGo stops a plugin call after 30 seconds. Keep cooldown, retries and the
// account check inside this budget so the host still has room to react.
const STREAM_BUDGET_MS = 25000;
// A shared account check must finish on its own, not on the budget of whichever
// 401 happened to start it. A waiter with less time stops waiting; the check
// keeps running for the other callers.
const PROBE_TIMEOUT_MS = 10000;
// The last attempts kept for reading later, as a ring.
const DIAGNOSTIC_LIMIT = 20;
// A content 401 does not prove the login expired. One account check answers
// for every 401 in this window, so a song the account may not open does not
// add a request per refusal.
const SESSION_PROBE_MS = 30000;

// MyGo 0.1.6 loads a module while holding the storage mutex. Host calls must
// happen inside an exported action, never during module initialization.
let session = null;
let epoch = 0;
let profileCheckedAt = 0;
let likedCache = null;
// The last answer to "does this session still have an account", and the check
// still running, both keyed by the generation they were asked in.
let probeRecord = null;
let probeRun = null;
const pendingStreams = new Map();
// Shared by every stream request: a refusal pauses the next source fetch, but
// never an unrelated API call.
let streamCooldownUntil = 0;
// Short reuse of a successful source, keyed by session, song and the quality
// that was asked for. The value keeps the quality the response proved.
const streamCache = new Map();
let discoveryCovers = null;
let heartState = null;
let pendingHeart = null;

function currentSession() {
  if (!session) session = host.storage.get("session") || { cookies: {}, profile: null };
  return session;
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// A failure the next attempt may not have: a timeout, a refused request, or a
// server error. Nothing else is marked, so a missing source is never retried
// as if waiting would fix it, and a moment's failure is never answered by
// asking for a lower quality.
function transientFailure(message, neteaseCode, retryAfterMs) {
  const error = new Error(message);
  error.transient = true;
  if (neteaseCode !== undefined) error.neteaseCode = neteaseCode;
  if (retryAfterMs > 0) error.retryAfterMs = retryAfterMs;
  return error;
}

// A deadline is not a server answer: stopping here keeps the host's own
// timeout out of play, and never turns a wait into a different quality.
function deadlineFailure(message = "网易云取源已用完本次等待预算，请稍后重试") {
  const error = new Error(message);
  error.deadline = true;
  return error;
}

// A refusal this plugin does not classify further. Keep the number so the
// diagnostic names it, and keep the session: one layer's code is not proof
// that the login ended.
function neteaseRefusal(neteaseCode, message) {
  const error = new Error(message);
  error.neteaseCode = neteaseCode;
  return error;
}

// The same moment of refusal also arrives inside a song's record when the
// transport succeeded. Another level asks the same server for the same song,
// so only waiting can change this answer.
function transientCode(code) {
  return code === 429 || (code >= 500 && code <= 599);
}

function httpFailure(status, retryAfterMs) {
  const error = new Error(`网易云请求失败（HTTP ${status}）`);
  error.transient = status >= 500 || status === 429;
  // Record the status for the diagnostics. Retry policy stays as it was.
  error.neteaseCode = status;
  if (retryAfterMs > 0) error.retryAfterMs = retryAfterMs;
  return error;
}

// Retry-After is either delta-seconds or an HTTP-date. Anything else is not a
// usable instruction and must not become a guessed wait.
function retryAfterDelay(headers) {
  if (!headers || typeof headers.get !== "function") return 0;
  let value;
  try { value = headers.get("retry-after"); } catch { return 0; }
  if (typeof value !== "string" || !value.trim()) return 0;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

function idOf(value) {
  const id = String(value);
  if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0) {
    throw new Error("无效的网易云音乐 ID");
  }
  return id;
}

// Lists from NetEase can omit an ID or send one this plugin cannot open. Keep
// a usable ID as a string, and let the caller leave the item out instead of
// handing the host "undefined" or an empty ID.
function externalID(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : "";
  }
  if (typeof value !== "string") return "";
  const id = value.trim();
  return /^\d+$/.test(id) && Number.isSafeInteger(Number(id)) && Number(id) > 0 ? id : "";
}

function pageOffset(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function secureURL(value) {
  return typeof value === "string" ? value.replace(/^http:\/\//, "https://") : "";
}

// MyGo Music 0.1.20+ replaces {size} (including URL-encoded braces) with the
// pixels needed by each view. Ask NetEase's image CDN to resize before the
// download, instead of fetching and decoding an original for a small row.
function artworkURL(value) {
  const picture = secureURL(value);
  if (!picture) return "";
  try {
    const url = new URL(picture);
    if (url.protocol !== "https:" || !/^p\d+\.music\.126\.net$/.test(url.hostname) ||
        url.port || url.username || url.password) return picture;
    // Set just the resize parameter, preserving other query values and the
    // fragment. Audio and external image services keep their original URLs.
    url.searchParams.set("param", "{size}y{size}");
    return url.toString();
  } catch {
    return picture;
  }
}

function deviceID() {
  let id = host.storage.get("deviceId");
  if (!id) {
    // This is an install identifier, never a credential or encryption key.
    id = Array.from({ length: 52 }, () => Math.floor(Math.random() * 16).toString(16)).join("").toUpperCase();
    host.storage.set("deviceId", id);
  }
  return id;
}

function cookieHeader(cookies) {
  return COOKIE_NAMES.filter((key) => cookies[key]).map((key) => `${key}=${cookies[key]}`).join("; ");
}

function acceptCookies(response, cookies) {
  // moejs supplies getSetCookie(): do not split a combined header on commas,
  // because an Expires attribute itself contains a comma.
  for (const line of response.headers.getSetCookie()) {
    const pair = line.split(";", 1)[0];
    const separator = pair.indexOf("=");
    const name = pair.slice(0, separator).trim();
    if (separator < 1 || !COOKIE_NAMES.includes(name)) continue;
    const value = pair.slice(separator + 1);
    const maxAge = /;\s*max-age\s*=\s*(-?\d+)/i.exec(line);
    const expires = /;\s*expires\s*=\s*([^;]+)/i.exec(line);
    const expired = maxAge ? Number(maxAge[1]) <= 0 : expires && Date.parse(expires[1]) <= Date.now();
    if (!value || expired) delete cookies[name];
    else cookies[name] = value;
  }
}

function persistSession() {
  if (session.cookies.MUSIC_U) host.storage.set("session", session);
  else host.storage.remove("session");
}

function clearSession() {
  epoch++;
  session = { cookies: {}, profile: null };
  profileCheckedAt = 0;
  probeRecord = null;
  probeRun = null;
  likedCache = null;
  pendingStreams.clear();
  // A source cached for the old session must never answer for the next one.
  streamCache.clear();
  heartState = null;
  pendingHeart = null;
  host.storage.remove("session");
}

// `persist` and `signOut` let a 401 take the server's cookie update without
// acting on it: losing MUSIC_U there is answered by the account check below,
// not by an immediate sign-out. Every other response keeps both defaults.
function acceptResponseCookies(response, activeSession, { persist = true, signOut = true } = {}) {
  const wasSignedIn = !!activeSession.cookies.MUSIC_U;
  acceptCookies(response, activeSession.cookies);
  if (activeSession !== session) return;
  if (signOut && wasSignedIn && !activeSession.cookies.MUSIC_U) {
    clearSession();
    throw fail("signIn", "网易云登录状态已失效，请重新登录");
  }
  if (persist) persistSession();
}

async function request(path, params = {}, options = {}) {
  const activeSession = options.session || currentSession();
  const startedEpoch = epoch;
  let url;
  const headers = { "User-Agent": UA, Referer: `${SITE}/` };
  const init = { headers, redirect: "error" };
  if (options.eapi) {
    const now = Date.now();
    const header = {
      osver: "Microsoft-Windows-10-Professional-build-19045-64bit",
      deviceId: deviceID(), os: "pc", appver: "3.1.17.204416",
      versioncode: "140", mobilename: "", buildver: String(Math.floor(now / 1000)),
      resolution: "1920x1080", channel: "netease",
      requestId: `${now}_${String(Math.floor(Math.random() * 1000)).padStart(4, "0")}`,
      __csrf: "", ...activeSession.cookies,
    };
    const text = JSON.stringify({ ...params, header, e_r: false });
    const digest = host.crypto.md5(`nobody${path}use${text}md5forencrypt`);
    const encrypted = host.crypto.aesEcbEncrypt(EAPI_KEY, `${path}-36cd479b6b5-${text}-36cd479b6b5-${digest}`);
    url = EAPI + path.replace(/^\/api\//, "/eapi/");
    init.method = "POST";
    init.body = `params=${encrypted.toUpperCase()}`;
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    headers["User-Agent"] = EAPI_UA;
    headers.Cookie = Object.keys(header).map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(header[key])}`).join("; ");
  } else {
    url = SITE + path;
    if (options.form !== undefined) {
      init.method = "POST";
      init.body = options.form;
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    } else {
      const query = new URLSearchParams(params).toString();
      if (query) url += `?${query}`;
    }
    const cookie = cookieHeader(activeSession.cookies);
    if (cookie) headers.Cookie = cookie;
  }
  const controller = new AbortController();
  // A stream request may carry an absolute deadline. Never wait past it, and
  // never let the shared 12s timeout consume budget that is already gone.
  const remaining = options.deadline === undefined ? REQUEST_TIMEOUT_MS : options.deadline - Date.now();
  if (remaining <= 0) throw deadlineFailure();
  const timer = setTimeout(() => controller.abort(), Math.min(REQUEST_TIMEOUT_MS, remaining));
  init.signal = controller.signal;
  let response, body;
  try {
    response = await fetch(url, init);
    if (!response.ok) throw httpFailure(response.status, retryAfterDelay(response.headers));
    body = await response.json();
  } catch (error) {
    if (controller.signal.aborted) {
      if (options.deadline !== undefined && Date.now() >= options.deadline) throw deadlineFailure();
      throw transientFailure("网易云请求超时，请稍后重试");
    }
    // Never put response bodies, request headers or login cookies in errors.
    if (response && !response.ok) throw error;
    throw transientFailure("无法读取网易云音乐，请检查网络及系统代理后重试");
  } finally {
    clearTimeout(timer);
  }
  if (startedEpoch !== epoch) throw new Error("账号状态已改变，请重试");
  if (!body || typeof body !== "object") throw new Error("网易云返回了无效数据");
  const code = Number(body.code);
  const allowed = options.codes || [200];
  const retryAfter = retryAfterDelay(response.headers);
  // A read-only request never answers with a cookie update: it asks a question
  // and leaves the session exactly as it found it.
  const readOnly = !!options.readOnly;
  if (!allowed.includes(code)) {
    // NetEase answers 401 both for content this account may not open and for
    // a login that really expired. Keep the cookie update, then ask the account
    // endpoint which one it is; only 301 and 302 say it outright.
    if (code === 401) {
      if (readOnly) throw fail("unavailable", "当前账号无权访问该内容");
      acceptResponseCookies(response, activeSession, { persist: false, signOut: false });
      if (await sessionExpired(activeSession, startedEpoch, options.deadline)) {
        if (activeSession === session && startedEpoch === epoch) clearSession();
        throw fail("signIn", "请重新登录网易云音乐");
      }
      throw fail("unavailable", "当前账号无权访问该内容");
    }
    if ([301, 302].includes(code)) {
      if (!readOnly && activeSession === session) clearSession();
      throw fail("signIn", "请重新登录网易云音乐");
    }
    if (code === 460 || code === -460) {
      // A refused response can still renew NMTID. Keep the server's cookie
      // update for the same device/account retry, including session expiry.
      if (!readOnly) acceptResponseCookies(response, activeSession);
      throw transientFailure(`网易云暂时拒绝了请求（${code}），请稍后重试`, code, retryAfter);
    }
    if (code === 405) throw transientFailure("网易云暂时限制了请求，请稍后再试", 405, retryAfter);
    // Throttling and server errors travel as a top-level code too. Mark them
    // transient exactly like the 460 above, keep the number, and let the caller
    // retry at the same level: a moment's failure is never a lower quality.
    if (transientCode(code)) {
      throw transientFailure(`网易云暂时无法返回结果（${code}），请稍后重试`, code, retryAfter);
    }
    // An unlisted code keeps its number for the diagnostics and its current
    // handling: it is not marked transient, so no new retry and no lower level.
    const unexpected = new Error(`网易云接口返回错误（${Number.isFinite(code) ? code : "未知"}）`);
    if (Number.isFinite(code)) unexpected.neteaseCode = code;
    throw unexpected;
  }
  if (!readOnly) acceptResponseCookies(response, activeSession);
  return body;
}

// One account check answers every content 401 for the next SESSION_PROBE_MS.
// Wait for a shared promise only as long as this caller's budget allows. The
// promise itself keeps running: one caller running out of time must not cancel
// a check that another caller is still waiting for.
function beforeDeadline(promise, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(deadlineFailure());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(deadlineFailure()), remaining);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function sessionExpired(activeSession, generation, deadline) {
  // Concurrent refusals share the check that is already running; the finished
  // check is released by identity, so the window really expires and a later
  // expiry is checked again instead of reusing the first answer.
  const saved = probeRecord;
  // A cached answer belongs to the credential it was asked with: once the
  // cookie is gone, the answer no longer describes this session.
  if (saved && saved.session === activeSession && saved.generation === generation &&
      Date.now() - saved.at < SESSION_PROBE_MS && activeSession.cookies.MUSIC_U) {
    return saved.expired;
  }
  if (deadline !== undefined && deadline <= Date.now()) throw deadlineFailure();
  let pending = probeRun;
  if (!pending || pending.session !== activeSession || pending.generation !== generation) {
    const run = { session: activeSession, generation };
    run.promise = probeSession(activeSession, generation).finally(() => {
      // Release by identity so a later expiry starts a fresh check.
      if (probeRun === run) probeRun = null;
    });
    pending = run;
    probeRun = run;
  }
  const answer = deadline === undefined ? await pending.promise : await beforeDeadline(pending.promise, deadline);
  return answer === true;
}

async function probeSession(activeSession, generation) {
  let expired;
  try {
    // profileFor is read-only here: a check that cannot finish changes nothing.
    // Give the shared check its own timeout, not the first waiter's budget.
    expired = !(await profileFor(activeSession, {
      readOnly: true, deadline: Date.now() + PROBE_TIMEOUT_MS,
    }));
  } catch {
    // A timeout, a network error, a 460, or an answer without a usable account
    // says nothing about the login. Do not cache it: another 401 must be able
    // to ask again instead of reusing an unfinished answer.
    return null;
  }
  // A check that finished after the session or the generation changed must not
  // answer for whichever session is current now.
  if (activeSession !== session || generation !== epoch) return null;
  probeRecord = { session: activeSession, generation, at: Date.now(), expired };
  return expired;
}

const eapi = (path, params, options = {}) => request(path, params, { ...options, eapi: true });

function toArtist(artist = {}) {
  return { id: String(artist.id || ""), name: artist.name || "", imageUrl: artworkURL(artist.img1v1Url || artist.picUrl) };
}

function toAlbum(album = {}) {
  const date = Number(album.publishTime);
  return {
    id: String(album.id || ""), name: album.name || "", imageUrl: artworkURL(album.picUrl),
    artists: (album.artists || (album.artist ? [album.artist] : [])).map(toArtist),
    released: date > 0 ? new Date(date).toISOString().slice(0, 10) : "",
  };
}

function toTrack(track) {
  const privilege = track.privilege;
  return {
    id: String(track.id), name: track.name || "",
    artists: (track.ar || track.artists || []).map(toArtist),
    album: toAlbum(track.al || track.album), duration: track.dt || track.duration || 0,
    url: `${SITE}/song?id=${track.id}`,
    unavailable: privilege ? privilege.st < 0 || privilege.pl <= 0 : track.fee === 1 || track.fee === 4,
  };
}

function toPlaylist(playlist) {
  return {
    id: String(playlist.id), name: playlist.name || "",
    imageUrl: artworkURL(playlist.coverImgUrl || playlist.picUrl),
    description: playlist.description || "", owner: playlist.creator?.nickname || "",
    trackCount: playlist.trackCount || 0, saved: !!playlist.subscribed,
    fixed: Number(playlist.specialType) === 5,
    mine: !!session?.profile && String(playlist.creator?.userId) === session.profile.id,
  };
}

function toShow(show) {
  const id = externalID(show?.id);
  if (!id) return null;
  return {
    id, name: show.name || "", imageUrl: artworkURL(show.picUrl),
    description: show.desc || show.rcmdtext || "", publisher: show.dj?.nickname || "",
    episodeCount: show.programCount || 0, subscribed: !!show.subed,
  };
}

function toShows(items) {
  if (!Array.isArray(items)) throw new Error("网易云返回了无效的播客列表，请稍后重试");
  const seen = new Set();
  return items.map(toShow).filter(show => {
    if (!show || seen.has(show.id)) return false;
    seen.add(show.id);
    return true;
  });
}

function toEpisode(program, show) {
  const programID = idOf(program.id);
  const audioID = program.mainSong?.id ? idOf(program.mainSong.id) : null;
  const published = new Date(Number(program.createTime));
  return {
    // Keep the program ID for comments and the audio ID for playback. Missing
    // audio stays visible so the host's next offset still counts this episode.
    id: `program:${programID}${audioID ? ":" + audioID : ""}`,
    name: program.name || "", showId: String(show.id),
    artists: show.dj?.nickname ? [{ id: "", name: show.dj.nickname }] : [],
    album: { id: "", name: show.name || "", imageUrl: artworkURL(program.coverUrl || show.picUrl) },
    duration: program.duration || program.mainSong?.duration || 0,
    description: program.description || "",
    published: published.getTime() > 0 ? published.toISOString().slice(0, 10) : "",
    url: `${SITE}/program?id=${programID}`, unavailable: !audioID,
  };
}

function trackIdentity(value) {
  const match = /^program:(\d+)(?::(\d+))?$/.exec(String(value));
  if (match) {
    const program = idOf(match[1]);
    return { program, audio: match[2] ? idOf(match[2]) : null, thread: `A_DJ_1_${program}` };
  }
  const audio = idOf(value);
  return { audio, thread: `R_SO_4_${audio}` };
}

function toComment(comment) {
  const quote = (comment.beReplied || []).map(reply =>
    `${reply.user?.nickname || ""}：${reply.content || ""}`).join("\n");
  return {
    id: String(comment.commentId), author: comment.user?.nickname || "",
    avatarUrl: artworkURL(comment.user?.avatarUrl),
    text: (comment.content || "") + (quote ? `\n\n回复：${quote}` : ""),
    time: comment.time || 0, likes: comment.likedCount || 0, liked: !!comment.liked,
  };
}

async function songDetails(ids, originals = [], options = {}) {
  if (!ids.length) return [];
  const batches = [];
  for (let offset = 0; offset < ids.length; offset += 400) {
    batches.push(ids.slice(offset, offset + 400));
  }
  const results = await Promise.all(batches.map(async (batch) => {
    const data = await eapi("/api/v3/song/detail", { c: JSON.stringify(batch.map((id) => ({ id: Number(idOf(id)) }))) }, options);
    const privileges = new Map((data.privileges || []).map((p) => [String(p.id), p]));
    return (data.songs || []).map((song) => ({ ...song, privilege: privileges.get(String(song.id)) || song.privilege }));
  }));
  const byID = new Map(results.flat().map((song) => [String(song.id), song]));
  const fallback = new Map(originals.map((song) => [String(song.id), song]));
  // MyGo advances offset by the number of returned tracks. Keep a slot for
  // every requested ID, including songs removed from the detail response.
  return ids.map((id) => byID.get(String(id)) || {
    ...(fallback.get(String(id)) || { id, name: "歌曲暂不可用" }),
    privilege: { st: -1, pl: 0 },
  });
}

async function profileFor(activeSession, options = {}) {
  const data = await request("/api/nuser/account/get", {}, { session: activeSession, ...options });
  // The cookie is the account: an in-memory deletion means this session has no
  // account left, however the endpoint answers the request it carried.
  if (!activeSession.cookies.MUSIC_U) return null;
  const profile = data.profile;
  if (!profile) return null;
  const id = Number(profile.userId);
  // An answer without a usable account ID is neither an account nor proof that
  // the login ended. Report it as an error: never cache it, never act on it.
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("网易云未返回有效的账号信息");
  return { id: String(id), name: profile.nickname || "", imageUrl: artworkURL(profile.avatarUrl) };
}

export async function account() {
  const activeSession = currentSession();
  // A cached profile belongs to a session that still holds its credential.
  if (!activeSession.cookies.MUSIC_U) return null;
  if (activeSession.profile && Date.now() - profileCheckedAt < 60000) return activeSession.profile;
  try {
    const profile = await profileFor(activeSession);
    // A QR login can finish without another epoch change. Do not apply the
    // previous account's profile or sign-out to that newly accepted session.
    if (activeSession !== session) throw new Error("账号状态已改变，请重试");
    if (!profile) { clearSession(); return null; }
    activeSession.profile = profile;
    profileCheckedAt = Date.now();
    persistSession();
    return profile;
  } catch (error) {
    if (error.code === "signIn") return null;
    throw error;
  }
}

async function requireAccount() {
  const profile = await account();
  if (!profile) throw fail("signIn", "请先扫码登录网易云音乐");
  return profile;
}

export async function signIn() {
  const startedEpoch = ++epoch;
  const pending = { cookies: {}, profile: null };
  host.signInPrompt({ text: "正在生成网易云音乐登录二维码…" });
  const key = await eapi("/api/login/qrcode/unikey", { type: 3 }, { session: pending });
  if (!key.unikey) throw new Error("网易云未返回登录二维码，请稍后重试");
  const qr = `${SITE}/login?codekey=${encodeURIComponent(key.unikey)}`;
  host.signInPrompt({ qr, text: "请用网易云音乐手机 App 扫码，并在手机上确认登录" });
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline && startedEpoch === epoch) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (startedEpoch !== epoch) break;
    const result = await eapi("/api/login/qrcode/client/login", { key: key.unikey, type: 3 }, {
      session: pending, codes: [800, 801, 802, 803],
    });
    if (result.code === 800) throw new Error("二维码已过期，请重新点击登录");
    if (result.code === 802) host.signInPrompt({ qr, text: "已扫码，请在手机上确认登录" });
    if (result.code === 803) {
      if (!pending.cookies.MUSIC_U) throw new Error("网易云未返回有效会话，请重新扫码登录");
      pending.profile = await profileFor(pending);
      if (!pending.profile) throw new Error("无法读取已登录账号，请重新扫码");
      if (startedEpoch !== epoch) break;
      session = pending;
      heartState = null;
      pendingHeart = null;
      probeRecord = null;
      probeRun = null;
      profileCheckedAt = Date.now();
      likedCache = null;
      persistSession();
      host.signInPrompt({ text: "登录成功" });
      return pending.profile;
    }
  }
  throw new Error("登录已取消或超时，请重新点击登录");
}

export function signOut() {
  // Forget this plugin's session. Do not affect other NetEase clients.
  clearSession();
}

export async function search({ query, kind = "tracks", offset = 0 }) {
  const types = {
    tracks: [1, "songs", "songCount", toTrack], albums: [10, "albums", "albumCount", toAlbum],
    artists: [100, "artists", "artistCount", toArtist], playlists: [1000, "playlists", "playlistCount", toPlaylist],
    shows: [1009, "djRadios", "djRadiosCount", toShow],
  };
  const type = types[kind];
  if (!type) throw fail("unsupported", "支持歌曲、专辑、歌手、歌单和播客搜索");
  const text = String(query || "").trim();
  if (!text) return { [kind]: [], more: false };
  offset = pageOffset(offset);
  const data = await request("/api/cloudsearch/pc", { s: text, type: type[0], limit: PAGE_SIZE, offset, total: "true" });
  const result = data.result || {};
  const items = result[type[1]] || [];
  const records = kind === "tracks" ? await songDetails(items.map((song) => song.id), items) : items;
  return { [kind]: records.map(type[3]).filter(Boolean), more: items.length > 0 && offset + items.length < (result[type[2]] || 0) };
}

// The host's suggest contract is a ranked list of strings, while NetEase
// answers groups by kind. Flatten them in NetEase's order, drop blanks and
// repeats, and cap the list the host shows. The host already ignores a late
// answer once the query changed, so no extra request sequence is kept here.
export async function suggest({ query }) {
  const text = String(query || "").trim();
  if (!text) return [];
  const data = await request("/api/search/suggest/web", { s: text });
  const result = data.result || {};
  const names = kind => Array.isArray(result[kind]) ? result[kind].map(item => item?.name) : [];
  const groups = {
    songs: names("songs"), artists: names("artists"),
    albums: names("albums"), playlists: names("playlists"),
  };
  const order = Array.isArray(result.order) ? result.order : [];
  const seen = new Set();
  const suggestions = [];
  for (const kind of [...order, "songs", "artists", "albums", "playlists"]) {
    if (!Array.isArray(groups[kind])) continue;
    for (const name of groups[kind]) {
      const candidate = typeof name === "string" ? name.trim() : "";
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      suggestions.push(candidate);
      if (suggestions.length >= 10) return suggestions;
    }
  }
  return suggestions;
}

async function discoveryPlaylists() {
  const data = await request("/api/personalized/playlist", { limit: 24 });
  const playlists = (data.result || []).map(toPlaylist);
  // Decorative artwork for navigation, not a preview of private recommendations.
  discoveryCovers = playlists.map(item => item.imageUrl).filter(Boolean);
  return playlists;
}

function discoveryCover(index) {
  return discoveryCovers?.length ? discoveryCovers[index % discoveryCovers.length] : "";
}

async function discoverySection() {
  try {
    return { title: "推荐歌单", playlists: await discoveryPlaylists() };
  } catch (error) {
    // Authentication failures still reach the host's sign-in flow. Optional
    // recommendations and cover art must not hide the navigation or radio.
    if (error.code === "signIn") throw error;
    return {
      title: "推荐歌单", empty: "推荐歌单暂时无法加载，点击「查看全部」重试；其他入口仍可使用。",
      morePage: "discovery",
    };
  }
}

async function recommendedPodcasts() {
  const data = await request("/api/djradio/recommend/v1");
  return toShows(data.djRadios);
}

async function hotPodcasts(offset) {
  const data = await request("/api/djradio/hot/v1", { limit: PODCAST_LIMIT, offset });
  return { shows: toShows(data.djRadios), more: data.hasMore === true && data.djRadios.length > 0 };
}

// The host's Browse page has no offset of its own. Encode the hot list's
// offset in the page name, and parse only a non-negative, bounded integer.
function podcastHotOffset(page) {
  const match = /^podcasts:hot:(\d+)$/.exec(page);
  if (!match) return null;
  const offset = Number(match[1]);
  return Number.isSafeInteger(offset) && offset >= 0 && offset <= PODCAST_OFFSET_LIMIT ? offset : null;
}

export async function home() {
  const recommendations = await discoverySection();
  return {
    title: "发现音乐", subtitle: "网易云音乐 · 发现喜欢的音乐",
    sections: [
      { title: "为你推荐", links: [
        { title: "每日推荐", subtitle: "每天更新，为你推荐好音乐", page: "daily", imageUrl: discoveryCover(0) },
        { title: "私人雷达", subtitle: "发现属于你的音乐", page: "radar", imageUrl: discoveryCover(1) },
        { title: "个性化歌单", subtitle: "网易云为你推荐的歌单", page: "recommendations", imageUrl: discoveryCover(2) },
      ] },
      { title: "播客发现", links: [
        { title: "推荐播客", subtitle: "网易云为你推荐的播客", page: "podcasts:recommend", imageUrl: discoveryCover(3) },
        { title: "热门播客", subtitle: "按热度浏览，可翻页", page: "podcasts:hot:0", imageUrl: discoveryCover(4) },
      ] },
      { title: "私人漫游", stations: stationList() },
      recommendations,
    ],
  };
}

export async function browse({ page }) {
  if (page === "discovery") {
    return { title: "推荐歌单", sections: [{ playlists: await discoveryPlaylists(), empty: "暂时没有推荐歌单" }] };
  }
  if (page === "radar") {
    // NetEase's dynamic playlist is selected for the signed-in listener.
    // Never label its anonymous response as someone's personal radar.
    await requireAccount();
    const radar = await playlist({ id: PRIVATE_RADAR });
    return { title: "私人雷达", subtitle: radar.name, sections: [{ tracks: radar.tracks }] };
  }
  if (page === "daily") {
    await requireAccount();
    const data = await request("/api/v3/discovery/recommend/songs");
    const songs = data.data?.dailySongs || [];
    return { title: "每日推荐", sections: [{ tracks: (await songDetails(songs.map(song => song.id), songs)).map(toTrack) }] };
  }
  if (page === "recommendations") {
    await requireAccount();
    const data = await request("/api/v1/discovery/recommend/resource");
    return { title: "个性化歌单", sections: [{ playlists: (data.recommend || []).map(toPlaylist) }] };
  }
  if (page === "podcasts:recommend") {
    return {
      title: "推荐播客", subtitle: "网易云为你推荐的播客",
      sections: [{ shows: await recommendedPodcasts(), empty: "暂时没有推荐播客" }],
    };
  }
  const hotOffset = podcastHotOffset(page);
  if (hotOffset !== null) {
    const { shows, more } = await hotPodcasts(hotOffset);
    const current = Math.floor(hotOffset / PODCAST_LIMIT) + 1;
    const links = [];
    if (hotOffset > 0) {
      links.push({
        title: "上一页", subtitle: `第 ${Math.max(1, Math.ceil(hotOffset / PODCAST_LIMIT))} 页`,
        page: `podcasts:hot:${Math.max(0, hotOffset - PODCAST_LIMIT)}`,
      });
    }
    const next = hotOffset + PODCAST_LIMIT;
    if (more && next <= PODCAST_OFFSET_LIMIT) {
      links.push({ title: "下一页", subtitle: `第 ${current + 1} 页`, page: `podcasts:hot:${next}` });
    }
    return {
      title: "热门播客", subtitle: `第 ${current} 页`,
      sections: [
        { shows, empty: "暂时没有热门播客" },
        ...(links.length ? [{ title: "翻页", links }] : []),
      ],
    };
  }
  if (page !== "charts") throw fail("unsupported", "没有这个页面");
  const data = await request("/api/toplist/detail");
  return { title: "排行榜", sections: [{ playlists: (data.list || []).map(toPlaylist) }] };
}

export async function playlists() {
  const profile = await account();
  if (!profile) return [];
  // Return all pages instead of silently dropping subscriptions after 200.
  const result = [];
  for (let offset = 0; ; offset += 200) {
    const data = await request("/api/user/playlist", { uid: profile.id, limit: 200, offset });
    const items = data.playlist || [];
    result.push(...items.map(toPlaylist));
    if (!data.more || items.length < 200) return result;
    if (offset >= 1800) throw new Error("账号歌单超过首版支持的 2000 个，暂时无法完整加载");
  }
}

export async function playlist({ id }) {
  const data = await request("/api/v6/playlist/detail", { id: idOf(id), n: PLAYLIST_LIMIT });
  if (!data.playlist) throw fail("unavailable", "歌单不存在或当前账号无权访问");
  const source = data.playlist;
  const ids = (source.trackIds || source.tracks || []).slice(0, PLAYLIST_LIMIT).map((track) => track.id);
  const result = toPlaylist(source);
  result.tracks = (await songDetails(ids, source.tracks || [])).map(toTrack);
  if (source.trackCount > PLAYLIST_LIMIT) {
    result.description += `\n本版本载入前 ${PLAYLIST_LIMIT} 首（歌单共 ${source.trackCount} 首）。`;
  }
  return result;
}

export async function shows() {
  await requireAccount();
  const result = new Map();
  for (let offset = 0; offset < 2000;) {
    const data = await request("/api/djradio/get/subed", { limit: 100, offset, total: "true" });
    const items = data.djRadios || [];
    const previousSize = result.size;
    for (const item of items) {
      const show = toShow(item);
      if (!show) continue;
      result.set(show.id, { ...show, subscribed: true });
    }
    if (!data.hasMore) return [...result.values()];
    if (!items.length || result.size === previousSize) {
      throw new Error("网易云未返回完整的播客订阅列表，请稍后重试");
    }
    offset += items.length;
  }
  throw new Error("播客订阅超过本版本支持的 2000 个，暂时无法完整加载");
}

export async function show({ id, offset = 0 }) {
  id = idOf(id);
  offset = pageOffset(offset);
  const [detail, programs] = await Promise.all([
    request("/api/djradio/v2/get", { id }),
    request("/api/dj/program/byradio", { radioId: id, limit: PAGE_SIZE, offset, asc: "false" }),
  ]);
  if (!detail.data || String(detail.data.id) !== id) throw fail("unavailable", "播客不存在或当前账号无权访问");
  const show = toShow(detail.data);
  if (!show) throw fail("unavailable", "播客不存在或当前账号无权访问");
  return {
    show,
    episodes: (programs.programs || []).map(program => toEpisode(program, detail.data)),
    more: !!programs.more,
  };
}

export async function album({ id }) {
  const data = await request(`/api/v1/album/${idOf(id)}`);
  if (!data.album) throw fail("unavailable", "专辑不可用");
  return { album: toAlbum(data.album), tracks: (await songDetails((data.songs || []).map((song) => song.id), data.songs || [])).map(toTrack) };
}

async function artistAlbums(id) {
  // The host has no artist-album pagination action. Collect every page here,
  // advancing by raw page length so overlapping albums do not shift offsets.
  const albums = new Map();
  for (let offset = 0; offset < 10000;) {
    const data = await request(`/api/artist/albums/${id}`, { limit: PAGE_SIZE, offset });
    const items = data.hotAlbums || [];
    const previousSize = albums.size;
    for (const item of items) albums.set(String(item.id), toAlbum(item));
    if (!data.more) return [...albums.values()];
    if (!items.length || albums.size === previousSize) {
      throw new Error("网易云未返回完整的歌手专辑列表，请稍后重试");
    }
    offset += items.length;
  }
  throw new Error("歌手专辑过多，暂时无法完整加载");
}

export async function artist({ id }) {
  id = idOf(id);
  const [detail, albums] = await Promise.all([
    request(`/api/v1/artist/${id}`), artistAlbums(id),
  ]);
  if (!detail.artist) throw fail("unavailable", "歌手不可用");
  return {
    artist: toArtist(detail.artist), albums,
    tracks: (await songDetails((detail.hotSongs || []).map((song) => song.id), detail.hotSongs || [])).map(toTrack),
  };
}

async function likedIDs() {
  const profile = await requireAccount();
  if (likedCache && likedCache.uid === profile.id && Date.now() - likedCache.at < 60000) return likedCache.ids;
  const data = await eapi("/api/song/like/get", { uid: profile.id });
  const ids = (data.ids || []).map(String);
  likedCache = { uid: profile.id, ids, at: Date.now() };
  return ids;
}

export async function liked({ offset = 0 }) {
  offset = pageOffset(offset);
  const ids = await likedIDs();
  return { tracks: (await songDetails(ids.slice(offset, offset + PAGE_SIZE))).map(toTrack), more: offset + PAGE_SIZE < ids.length };
}

export async function isLiked({ ids }) {
  const identities = ids.map(id => ({ id, ...trackIdentity(id) }));
  const songs = identities.filter(item => !item.program);
  const result = Object.fromEntries(ids.map(id => [id, false]));
  // The host also asks about episode IDs. This read-only podcast integration
  // does not export likeEpisode and must not query song likes for episodes.
  if (!songs.length) return result;
  currentSession();
  if (!session.cookies.MUSIC_U) return result;
  const liked = new Set(await likedIDs());
  for (const item of songs) result[item.id] = liked.has(item.audio);
  return result;
}

export async function like({ id, on }) {
  const identity = trackIdentity(id);
  if (identity.program) throw fail("unsupported", "暂不支持喜欢或取消喜欢播客节目");
  await requireAccount();
  await eapi("/api/radio/like", { alg: "itembased", trackId: identity.audio, like: String(!!on), time: "3" });
  likedCache = null;
}

function checkPlaylistSession(activeSession, generation) {
  if (generation !== epoch || activeSession !== session) {
    throw new Error("账号状态已改变，请重试");
  }
}

async function submitPlaylistTracks(op, id, ids, activeSession, generation) {
  checkPlaylistSession(activeSession, generation);
  const form = new URLSearchParams({ op, pid: id, imme: "true", trackIds: JSON.stringify(ids.map(Number)) });
  if (activeSession.cookies.__csrf) form.set("csrf_token", activeSession.cookies.__csrf);
  try {
    const data = await request("/api/playlist/manipulate/tracks", {}, {
      session: activeSession, form: form.toString(), codes: [200, 502],
    });
    checkPlaylistSession(activeSession, generation);
    return data;
  } catch (error) {
    // Preserve signIn so the host can offer login; a content 401 keeps session.
    error.message = `${op === "add" ? "添加到歌单" : "移出歌单"}失败：${error.message}`;
    throw error;
  }
}

async function playlistTrackIDs(id, activeSession, generation) {
  checkPlaylistSession(activeSession, generation);
  const data = await request("/api/v6/playlist/detail", { id, n: PLAYLIST_LIMIT }, {
    session: activeSession,
  });
  checkPlaylistSession(activeSession, generation);
  const source = data.playlist;
  if (String(source?.id) !== id || !Array.isArray(source.trackIds) || source.trackIds.length < source.trackCount) {
    throw new Error("无法确认歌单的完整歌曲列表，请刷新后重试");
  }
  return new Set(source.trackIds.map(track => String(track.id)));
}

async function manipulatePlaylistTracks(op, id, trackIds) {
  const pid = String(Number(idOf(id)));
  if (trackIds == null) trackIds = [];
  if (!Array.isArray(trackIds)) throw new Error("无效的歌曲列表");
  const ids = [...new Set(trackIds.map(value => {
    const identity = trackIdentity(value);
    if (identity.program) throw fail("unsupported", "暂不支持将播客节目添加到歌曲歌单或从中移除");
    return String(Number(identity.audio));
  }))];
  if (!ids.length) return;
  const activeSession = currentSession();
  const generation = epoch;
  await requireAccount();
  checkPlaylistSession(activeSession, generation);
  let data = await submitPlaylistTracks(op, pid, ids, activeSession, generation);
  if (op === "add" && Number(data.code) === 502) {
    // A duplicate rejects the whole batch. Only retry songs proved absent;
    // never treat an unexplained 502 or a concurrent edit as successful.
    const present = await playlistTrackIDs(pid, activeSession, generation);
    const missing = ids.filter(trackID => !present.has(trackID));
    if (!missing.length) {
      throw fail("duplicate", ids.length === 1 ? "这首歌已经在这个歌单里了" : "这些歌曲已经在这个歌单里了");
    }
    if (missing.length < ids.length) {
      data = await submitPlaylistTracks(op, pid, missing, activeSession, generation);
    }
  }
  if (Number(data.code) !== 200) {
    throw new Error(`${op === "add" ? "添加到歌单" : "移出歌单"}未完成（${data.code}），请刷新歌单后重试`);
  }
  likedCache = null;
}

export async function addToPlaylist({ id, trackIds }) {
  await manipulatePlaylistTracks("add", id, trackIds);
}

export async function removeFromPlaylist({ id, trackIds }) {
  await manipulatePlaylistTracks("del", id, trackIds);
}

export async function comments({ trackId, offset = 0 }) {
  const identity = trackIdentity(trackId);
  const data = await request(`/api/v1/resource/comments/${identity.thread}`, {
    limit: PAGE_SIZE, offset: pageOffset(offset),
  });
  // Hot comments overlap the chronological list. Adding them here would make
  // the host skip comments when it advances by the number already displayed.
  return { comments: (data.comments || []).map(toComment), total: data.total || 0, more: !!data.more };
}

export async function lyrics({ id }) {
  const identity = trackIdentity(id);
  if (identity.program) return { lrc: "", translation: "" };
  const activeSession = currentSession();
  const generation = epoch;
  const data = await request("/api/song/lyric", { id: identity.audio, lv: 1, tv: -1 });
  const lrc = data.lrc?.lyric || "";
  const translation = data.tlyric?.lyric || "";
  if (lrc.trim()) return { lrc, translation };
  // Some songs have empty web lyrics while the desktop endpoint has LRC.
  // Do not treat that empty response as proof that the song is instrumental.
  if (activeSession !== session || generation !== epoch) throw new Error("账号状态已改变，请重试");
  const desktop = await eapi("/api/song/lyric/v1", {
    id: identity.audio, cp: false, tv: 0, lv: 0, rv: 0, kv: 0, yv: 0, ytv: 0, yrv: 0,
  }, { session: activeSession });
  if (activeSession !== session || generation !== epoch) throw new Error("账号状态已改变，请重试");
  return { lrc: desktop.lrc?.lyric || "", translation: desktop.tlyric?.lyric || translation };
}

// A successful source is kept for a very short window, keyed by the session,
// the song and the quality that was asked for. The result keeps the quality
// the response proved, so a fallback is never relabelled as the request.
function cachedStream(key) {
  const entry = streamCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at >= STREAM_CACHE_TTL_MS) {
    streamCache.delete(key);
    return null;
  }
  return entry;
}

function rememberStream(key, result, diagnostic, generation) {
  // A session change while the request was in flight makes this answer belong
  // to the previous session. Never let it answer for the current one.
  if (generation !== epoch) return;
  // NetEase's URL record has no expiry field with documented units, so none is
  // interpreted here. The TTL is short and only complete, non-trial sources
  // are stored: a result the server calls shorter than this window is not put
  // in the cache at all.
  streamCache.set(key, {
    at: Date.now(),
    result: { ...result, headers: { ...result.headers } },
    diagnostic: { ...diagnostic },
  });
  while (streamCache.size > STREAM_CACHE_LIMIT) {
    streamCache.delete(streamCache.keys().next().value);
  }
}

function coolDownStreams() {
  streamCooldownUntil = Math.max(streamCooldownUntil, Date.now() + STREAM_COOLDOWN_MS);
}

async function waitForStreamCooldown(deadline, minimumDelay = 0) {
  const target = Math.max(streamCooldownUntil, Date.now() + minimumDelay);
  const delay = target - Date.now();
  if (delay <= 0) return;
  const left = deadline - Date.now();
  if (left <= 0) throw deadlineFailure();
  await new Promise(resolve => setTimeout(resolve, Math.min(delay, left)));
  if (Date.now() >= deadline) throw deadlineFailure();
}

async function waitForStreamRetry(error, deadline) {
  const left = deadline - Date.now();
  if (left <= 0) throw deadlineFailure();
  // A server that names a wait longer than this call can afford is not an
  // invitation to retry early: say so and stop inside the budget.
  if (error.retryAfterMs > left) {
    throw deadlineFailure(`网易云要求等待 ${Math.ceil(error.retryAfterMs / 1000)} 秒，超过本次取源预算，请稍后重试`);
  }
  await waitForStreamCooldown(deadline, Math.max(STREAM_RETRY_MS, error.retryAfterMs || 0));
}

export async function stream({ id, quality = "high" }) {
  id = trackIdentity(id).audio;
  if (!id) throw fail("unavailable", "该播客节目没有可播放的音频");
  const activeSession = currentSession();
  const generation = epoch;
  const asked = STREAM_LEVELS[quality] ? quality : "high";
  const key = `${generation}:${id}:${asked}`;
  const cached = cachedStream(key);
  if (cached) {
    // Reuse is worth recording, but it is still just fields: no URL, no query.
    rememberStreamDiagnostics([{ ...cached.diagnostic, at: new Date().toISOString(), outcome: "cached" }]);
    return { ...cached.result, headers: { ...cached.result.headers } };
  }
  if (pendingStreams.has(key)) return pendingStreams.get(key);
  const deadline = Date.now() + STREAM_BUDGET_MS;
  const pending = loadStream(id, asked, generation, activeSession, deadline, key);
  pendingStreams.set(key, pending);
  try { return await pending; }
  finally { if (pendingStreams.get(key) === pending) pendingStreams.delete(key); }
}

async function loadStream(id, quality, generation, activeSession, deadline, cacheKey) {
  const records = [];
  const tried = [];
  let missing = "";
  try {
    // A refusal pauses the next source fetch. The first call made while a
    // cooldown is active still waits, but unrelated APIs never do.
    await waitForStreamCooldown(deadline);
    for (let ask = quality; ask; ask = LOWER_QUALITY[ask]) {
      const level = STREAM_LEVELS[ask];
      tried.push(QUALITY_NAMES[ask]);
      for (let attempt = 1; ; attempt++) {
        if (generation !== epoch) throw new Error("账号状态已改变，请重试");
        let data;
        try {
          data = await eapi("/api/song/enhance/player/url/v1", {
            ids: JSON.stringify([Number(id)]), level, encodeType: level === "lossless" ? "flac" : "mp3",
          }, { deadline });
        } catch (error) {
          records.push(streamDiagnostic(id, level, error.transient ? "transient" : "error", null, error.neteaseCode));
          if (error.deadline || !error.transient) throw error;
          coolDownStreams();
          if (attempt >= STREAM_ATTEMPTS) {
            // Still refused at the quality asked for, so this song may play
            // later: say that, and never turn a refusal into a lower level.
            if ([460, -460].includes(error.neteaseCode)) {
              throw new Error(`网易云仍拒绝播放请求（${error.neteaseCode}），请稍后再试，并在官方客户端确认该歌曲可正常播放`);
            }
            throw error;
          }
          await waitForStreamRetry(error, deadline);
          continue;
        }
        const audio = (data.data || []).find((item) => String(item.id) === id);
        if (!audio) {
          // A success without this song's record is a soft refusal or a moment
          // of the service, not proof that the account may not play it.
          records.push(streamDiagnostic(id, level, "empty", null, data.code));
          coolDownStreams();
          if (attempt < STREAM_ATTEMPTS) {
            await waitForStreamCooldown(deadline, STREAM_RETRY_MS);
            continue;
          }
          throw new Error("网易云未返回这首歌的音源，请稍后重试");
        }
        const code = audio.code == null ? null : Number(audio.code);
        if (audio.freeTrialInfo != null) {
          // A trial is all this account may play: a lower level never gives
          // more, so never fall back, and never hand the clip to the host.
          records.push(streamDiagnostic(id, level, "trial", audio, code));
          throw fail("unavailable", "当前账号只有这首歌的试听权限，无法播放完整版本");
        }
        if ([460, -460].includes(code)) {
          records.push(streamDiagnostic(id, level, "transient", audio, code));
          coolDownStreams();
          if (attempt < STREAM_ATTEMPTS) {
            await waitForStreamCooldown(deadline, STREAM_RETRY_MS);
            continue;
          }
          throw new Error(`网易云仍拒绝播放请求（${code}），请稍后再试，并在官方客户端确认该歌曲可正常播放`);
        }
        if (code === 401) {
          // A 401 inside the song record may be this song's permission or an
          // ended login. Ask the account, read-only, as the top-level 401 does,
          // instead of deciding from the number. No lower level can answer it.
          records.push(streamDiagnostic(id, level, "denied", audio, code));
          let expired = false;
          try {
            expired = await sessionExpired(activeSession, generation, deadline);
          } catch (error) {
            // This caller's budget ended while waiting. The shared check keeps
            // running for other callers; this one stops without acting on it.
            if (error.deadline) throw error;
          }
          if (expired) {
            if (activeSession === session && generation === epoch) clearSession();
            throw fail("signIn", "请重新登录网易云音乐");
          }
          throw fail("unavailable", "当前账号无权播放这首歌");
        }
        if (code === 403) {
          records.push(streamDiagnostic(id, level, "denied", audio, code));
          throw fail("unavailable", "当前账号无权播放这首歌");
        }
        if (transientCode(code)) {
          // Throttling and server errors say nothing about this level either:
          // answer them the way a failed request is answered, at the same level.
          records.push(streamDiagnostic(id, level, "transient", audio, code));
          coolDownStreams();
          if (attempt < STREAM_ATTEMPTS) {
            await waitForStreamCooldown(deadline, STREAM_RETRY_MS);
            continue;
          }
          throw new Error(`网易云暂时无法返回音源（${code}），请稍后重试`);
        }
        // Downgrading is allowed only for a shape that proves this level has no
        // source: a successful record without a URL, or the 404 already used
        // above. An unlisted code, a record that contradicts itself, or a login
        // code inside this layer (301/302 carries no evidence here) is not that
        // proof: stop, keep the session, and keep the number.
        if (!audio.url && (code === 200 || code === 404)) {
          records.push(streamDiagnostic(id, level, "missing", audio, code));
          missing = `网易云未返回可播放音源（已尝试：${tried.join("、")}）`;
          break;
        }
        if (!audio.url || (code != null && code !== 200)) {
          records.push(streamDiagnostic(id, level, "refused", audio, code));
          throw neteaseRefusal(code, `网易云返回了无法识别的音源结果（${code == null ? "无结果码" : code}），已停止降档`);
        }
        const url = new URL(secureURL(audio.url));
        const type = String(audio.type || "mp3").toLowerCase();
        if (url.protocol !== "https:" || !/^(?:[a-z0-9-]+\.)*music\.126\.net$/i.test(url.hostname)) {
          records.push(streamDiagnostic(id, level, "error", audio, code));
          throw fail("unavailable", "网易云返回了不支持的音频地址");
        }
        if (!["mp3", "flac", "ogg"].includes(type)) {
          records.push(streamDiagnostic(id, level, "error", audio, code));
          throw fail("unavailable", "该歌曲的音频格式暂不支持");
        }
        const diagnostic = streamDiagnostic(id, level, "ok", audio, code);
        records.push(diagnostic);
        const result = {
          url: url.toString(), type, size: audio.size || 0, bitRate: audio.br || 0,
          quality: streamQuality(audio), gain: audio.gain || 0, peak: audio.peak || 0,
          headers: { "User-Agent": UA, Referer: `${SITE}/` },
        };
        rememberStream(cacheKey, result, diagnostic, generation);
        return result;
      }
    }
    throw fail("unavailable", missing || "当前账号无完整播放权限，或歌曲在当前地区不可用");
  } finally {
    rememberStreamDiagnostics(records);
  }
}

// NetEase names more levels than the host has: higher, exhigh, hires, and the
// immersive ones it reports only by name. Say what the stream proves, and never
// call a lossy file lossless: the cache keeps it under that name, and then
// answers later lossless requests with it.
function streamQuality(audio) {
  const level = String(audio.level || "").toLowerCase();
  const type = String(audio.type || "").toLowerCase();
  // A known lossy container never proves lossless, whatever the level claims.
  const lossy = type === "mp3" || type === "ogg";
  if (level === "standard") return "standard";
  if (lossy) return "high";
  if (["lossless", "hires"].includes(level)) return "lossless";
  if (["higher", "exhigh"].includes(level)) return "high";
  return type === "flac" ? "lossless" : "high";
}

// One line per attempt, with what tells a refusal from a missing level and a
// trial, and nothing else. Never a URL, its query, a cookie, a header or an
// account: this is kept where the listener can read it.
function streamDiagnostic(id, level, outcome, audio = null, code = null) {
  const result = code == null ? null : Number(code);
  return {
    at: new Date().toISOString(), song: String(id), level, outcome,
    code: Number.isFinite(result) ? result : null,
    hasURL: !!(audio && audio.url),
    trial: !!(audio && audio.freeTrialInfo != null),
    actual: audio && audio.level ? String(audio.level) : null,
  };
}

// The host has no log to read and discards console output, so the plugin keeps
// the last few attempts in its own storage instead: bounded, so reading it
// later never has to rotate it, and never with anything to identify anyone.
function rememberStreamDiagnostics(records) {
  if (!records.length) return;
  try {
    const saved = host.storage.get("streamLog");
    const log = Array.isArray(saved) ? saved : [];
    host.storage.set("streamLog", log.concat(records).slice(-DIAGNOSTIC_LIMIT));
  } catch {
    // What is kept for reading later must never fail a play.
  }
}

// The host asks stationNext again as the queue runs out. These modes are
// NetEase's own recommendations, not a shuffle of the current local list.
function stationList() {
  return [
    { id: "DEFAULT", name: "私人漫游", description: "随心听，持续推荐你可能喜欢的歌曲" },
    { id: "FAMILIAR", name: "熟悉的歌", description: "回到熟悉的旋律" },
    { id: "EXPLORE", name: "新发现", description: "探索还没听过的音乐" },
  ].map((station, index) => ({
    ...station,
    // Older hosts replace source errors with a generic toast, so keep the
    // prerequisite visible on the station card as well.
    description: `${station.description}。需在网易云 App 中开启「个性化服务」。`,
    imageUrl: discoveryCover(index + 3),
  }));
}

export async function stations() {
  if (discoveryCovers === null) await discoverySection();
  return stationList();
}

// Candidate only: HEART is deliberately absent from stationList until live
// account and continuation checks pass. This uses NetEase's intelligence API,
// never the FAMILIAR radio or a local shuffle as a substitute.
function checkHeartAccount(activeSession, generation) {
  if (activeSession !== session || generation !== epoch) {
    throw new Error("账号状态已改变，请重试");
  }
}

async function startHeart(activeSession, generation, profile) {
  let likedPlaylist;
  for (let offset = 0; offset < 2000; offset += 200) {
    const data = await request("/api/user/playlist", { uid: profile.id, limit: 200, offset }, {
      session: activeSession,
    });
    checkHeartAccount(activeSession, generation);
    if (!Array.isArray(data.playlist)) throw new Error("无法读取喜欢的音乐歌单");
    likedPlaylist = data.playlist.find(item => item && Number(item.specialType) === 5 &&
      String(item.creator?.userId) === profile.id);
    if (likedPlaylist) break;
    if (!data.more || data.playlist.length < 200) break;
  }
  if (!likedPlaylist) throw fail("unavailable", "未找到当前账号的喜欢歌单，暂时无法开启心动模式");
  const playlistID = idOf(likedPlaylist.id);
  const data = await request("/api/v6/playlist/detail", { id: playlistID, n: 1 }, {
    session: activeSession,
  });
  checkHeartAccount(activeSession, generation);
  const playlist = data.playlist;
  if (!playlist || String(playlist.id) !== playlistID || Number(playlist.specialType) !== 5 ||
      String(playlist.creator?.userId) !== profile.id) {
    throw fail("unavailable", "无法确认当前账号的喜欢歌单");
  }
  const tracks = playlist.trackIds || playlist.tracks;
  if (!Array.isArray(tracks)) throw new Error("网易云未返回喜欢歌单的歌曲列表");
  if (!tracks.length) throw fail("unavailable", "喜欢歌单为空，请先在网易云喜欢一首歌曲");
  const seedTrack = tracks.find(track => track && /^\d+$/.test(String(track.id)) &&
    Number.isSafeInteger(Number(track.id)) && Number(track.id) > 0);
  if (!seedTrack) throw fail("unavailable", "喜欢歌单没有可用的种子歌曲");
  const seed = idOf(seedTrack.id);
  return { uid: profile.id, generation, playlistID, seed, last: seed, seen: [] };
}

async function loadHeart(activeSession, generation) {
  const profile = await requireAccount();
  checkHeartAccount(activeSession, generation);
  const state = heartState?.generation === generation && heartState.uid === profile.id
    ? heartState : await startHeart(activeSession, generation, profile);
  checkHeartAccount(activeSession, generation);
  const seen = new Set(state.seen);
  let cursor = state.last;
  // Advance over repeated batches, but do not loop indefinitely if the
  // service cannot supply a new recommendation or stops advancing its cursor.
  for (let attempt = 0; attempt < 3; attempt++) {
    const data = await eapi("/api/playmode/intelligence/list", {
      songId: cursor, startMusicId: state.seed, playlistId: state.playlistID,
      type: "fromPlayOne", count: 1,
    }, { session: activeSession });
    checkHeartAccount(activeSession, generation);
    if (!Array.isArray(data.data)) throw new Error("网易云未返回有效的心动推荐列表");
    const songs = [];
    let nextCursor = cursor;
    for (const item of data.data) {
      // Removed songs can leave null entries or empty songInfo records.
      if (item == null) continue;
      if (typeof item !== "object") throw new Error("网易云返回了无效的心动推荐歌曲");
      if (item.songInfo == null) continue;
      const id = idOf(item.songInfo.id);
      nextCursor = id;
      if (!seen.has(id)) { seen.add(id); songs.push(item.songInfo); }
    }
    if (songs.length) {
      const ids = songs.map(song => idOf(song.id));
      const tracks = (await songDetails(ids, songs, { session: activeSession })).map(toTrack);
      checkHeartAccount(activeSession, generation);
      heartState = { ...state, last: nextCursor, seen: [...seen].slice(-200) };
      return tracks;
    }
    // No new tracks need resolving; retain the service's cursor so the next
    // invocation does not restart at the original repeated batch.
    heartState = { ...state, last: nextCursor };
    if (nextCursor === cursor) break;
    cursor = nextCursor;
  }
  throw fail("unavailable", "网易云暂未返回新的心动推荐，请稍后重试");
}

async function heartNext() {
  const activeSession = currentSession();
  const generation = epoch;
  if (pendingHeart?.session === activeSession && pendingHeart.generation === generation) {
    return pendingHeart.promise;
  }
  const pending = { session: activeSession, generation, promise: loadHeart(activeSession, generation) };
  pendingHeart = pending;
  try { return await pending.promise; }
  finally { if (pendingHeart === pending) pendingHeart = null; }
}

export async function stationNext({ id }) {
  if (id === "HEART") return heartNext();
  if (!["DEFAULT", "FAMILIAR", "EXPLORE"].includes(id)) throw fail("unsupported", "没有这个漫游模式");
  await requireAccount();
  const data = await eapi("/api/v1/radio/get", { mode: id, limit: 3 });
  const songs = data.data || [];
  if (songs.length === 0) {
    let personalizationDisabled = false;
    try {
      const preferences = await request("/api/user/setting", {});
      personalizationDisabled = preferences.setting?.personalServiceSetting === 2;
    } catch (error) {
      // A diagnostic lookup must not turn a transient empty batch into a new
      // failure, but an expired session still needs the normal sign-in flow.
      if (error.code === "signIn") throw error;
    }
    if (personalizationDisabled) {
      throw fail("unavailable", "网易云的「个性化服务」已关闭。请在官方 App 的「设置 → 消息和隐私 → 个性化服务」中开启后重试。");
    }
  }
  return (await songDetails(songs.map(song => song.id), songs)).map(toTrack);
}
