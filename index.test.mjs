import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createCipheriv, createDecipheriv, createHash } from "node:crypto";

let sequence = 0;
const response = (body, cookies = [], headers = {}) => ({
  ok: true, status: 200, json: async () => body,
  headers: {
    getSetCookie: () => cookies,
    get: (name) => headers[String(name).toLowerCase()] ?? null,
  },
});
// Mock timers replace setImmediate too; a microtask flush still lets the
// fetch promise chain settle before the next tick.
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };

async function setup(handler, savedSession) {
  const storage = new Map(savedSession ? [["session", structuredClone(savedSession)]] : []);
  const prompts = [];
  const storageReads = [];
  globalThis.host = {
    storage: { get: (k) => { storageReads.push(k); return storage.get(k); }, set: (k, v) => storage.set(k, structuredClone(v)), remove: (k) => storage.delete(k) },
    crypto: {
      md5: (text) => createHash("md5").update(text).digest("hex"),
      aesEcbEncrypt: (key, text) => {
        const c = createCipheriv("aes-128-ecb", key, null);
        return Buffer.concat([c.update(text, "utf8"), c.final()]).toString("hex");
      },
    },
    signInPrompt: (prompt) => prompts.push(prompt),
  };
  globalThis.fetch = handler;
  const plugin = await import(`./index.js?test=${++sequence}`);
  return { plugin, storage, prompts, storageReads };
}

function decode(body) {
  const encrypted = new URLSearchParams(body).get("params");
  const c = createDecipheriv("aes-128-ecb", "e82ckenh8dichen8", null);
  const text = Buffer.concat([c.update(Buffer.from(encrypted, "hex")), c.final()]).toString();
  const [path, json, digest] = text.split("-36cd479b6b5-");
  assert.equal(digest, createHash("md5").update(`nobody${path}use${json}md5forencrypt`).digest("hex"));
  return { path, data: JSON.parse(json) };
}

const song = (id) => ({ id, name: `Song ${id}`, ar: [{ id: 5, name: "Artist" }], al: { id: 6, name: "Album" }, dt: 180000, fee: 1 });

// Each public search mapping must expose a template, not the full original or
// a fixed small picture that would also be used in Now Playing.
test("search provides sized artwork for tracks, albums, artists, playlists and shows", async () => {
  const picture = "http://p1.music.126.net/fixture.jpg";
  const track = { ...song(1), al: { id: 6, picUrl: picture }, ar: [{ id: 5, img1v1Url: picture }] };
  for (const [kind, key, item] of [
    ["tracks", "songs", track], ["albums", "albums", { id: 6, picUrl: picture }],
    ["artists", "artists", { id: 5, img1v1Url: picture }],
    ["playlists", "playlists", { id: 9, coverImgUrl: picture }],
    ["shows", "djRadios", { id: 8, picUrl: picture }],
  ]) {
    const { plugin } = await setup(async (url) => url.includes("cloudsearch")
      ? response({ code: 200, result: { [key]: [item] } })
      : response({ code: 200, songs: [track], privileges: [] }));
    const record = (await plugin.search({ query: "fixture", kind }))[kind][0];
    const images = kind === "tracks" ? [record.album.imageUrl, record.artists[0].imageUrl] : [record.imageUrl];
    for (const image of images) {
      const url = new URL(image);
      assert.equal(url.protocol, "https:", kind);
      assert.equal(url.searchParams.get("param"), "{size}y{size}", kind);
    }
  }
});

// Only the image CDN understands param; existing query values, fragments and
// non-CDN URLs must survive without redirecting their requests to another host.
test("artwork templates preserve query values and leave other URLs alone", async () => {
  const source = "https://p12.music.126.net/cover.jpg?quality=90&param=200y200&version=v2&param=800y800&label=a%20b&token=a%2Fb#cover";
  const unchanged = [
    "https://images.example/cover.jpg?param=200y200",
    "https://p1.music.126.net.example/cover.jpg",
    "https://m1.music.126.net/cover.jpg",
    "https://p1.music.126.net:8443/cover.jpg",
    "https://user:password@p1.music.126.net/cover.jpg",
    "file:///tmp/cover.jpg", "data:image/png;base64,fixture", "not a URL",
  ];
  const { plugin } = await setup(async () => response({ code: 200, result: {
    albums: [source, ...unchanged, "http://images.example/cover.jpg", "", null].map((picUrl, id) => ({ id, picUrl })),
  } }));
  const albums = (await plugin.search({ query: "fixture", kind: "albums" })).albums;
  const url = new URL(albums[0].imageUrl);
  assert.deepEqual(url.searchParams.getAll("param"), ["{size}y{size}"]);
  assert.equal(url.searchParams.get("quality"), "90");
  assert.equal(url.searchParams.get("version"), "v2");
  assert.equal(url.searchParams.get("label"), "a b");
  assert.equal(url.searchParams.get("token"), "a/b");
  assert.equal(url.hash, "#cover");
  assert.deepEqual(albums.slice(1, 1 + unchanged.length).map(album => album.imageUrl), unchanged);
  assert.deepEqual(albums.slice(-3).map(album => album.imageUrl), ["https://images.example/cover.jpg", "", ""]);
});

// Podcast episodes can have their own cover or fall back to their show; both
// routes need the same size contract as albums and playlist artwork.
test("podcast covers and episode fallbacks use sized artwork", async () => {
  const showPicture = "https://p2.music.126.net/show.jpg";
  const episodePicture = "https://p3.music.126.net/episode.jpg";
  const { plugin } = await setup(async (url) => url.includes("djradio/v2/get")
    ? response({ code: 200, data: { id: 8, picUrl: showPicture } })
    : response({ code: 200, programs: [
      { id: 1, coverUrl: episodePicture, mainSong: { id: 11 } },
      { id: 2, mainSong: { id: 12 } },
    ] }));
  const page = await plugin.show({ id: "8" });
  const covers = [page.show.imageUrl, ...page.episodes.map(episode => episode.album.imageUrl)];
  assert.deepEqual(covers.map(cover => new URL(cover).pathname), ["/show.jpg", "/episode.jpg", "/show.jpg"]);
  assert.ok(covers.every(cover => new URL(cover).searchParams.get("param") === "{size}y{size}"));
});

// Account and comment avatars pass through the host's image loader too.
test("account and comment avatars use the same artwork size contract", async () => {
  const picture = "https://p4.music.126.net/avatar.jpg";
  const { plugin } = await setup(async (url) => url.includes("account/get")
    ? response({ code: 200, profile: { userId: 8, nickname: "Fixture", avatarUrl: picture } })
    : response({ code: 200, comments: [{ commentId: 9, user: { nickname: "Fixture", avatarUrl: picture } }] }),
  { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
  const account = await plugin.account();
  const page = await plugin.comments({ trackId: "1" });
  assert.equal(new URL(account.imageUrl).searchParams.get("param"), "{size}y{size}");
  assert.equal(new URL(page.comments[0].avatarUrl).searchParams.get("param"), "{size}y{size}");
});

// MyGo 0.1.6 holds its mutex while importing: top-level storage calls deadlock.
test("module initialization defers host storage until an action", async () => {
  const { plugin, storageReads } = await setup(async () => response({ code: 200 }));
  assert.deepEqual(storageReads, []);
  assert.equal(await plugin.account(), null);
  assert.deepEqual(storageReads, ["session"]);
});

// Details may return IDs in another order and correct search's stale privileges.
test("search preserves order, pages, and uses the account's detail privileges", async () => {
  const { plugin } = await setup(async (url, init) => {
    if (url.includes("cloudsearch")) {
      assert.equal(new URL(url).searchParams.get("offset"), "30");
      return response({ code: 200, result: { songs: [song(1), song(2)], songCount: 90 } });
    }
    const { path, data } = decode(init.body);
    assert.equal(path, "/api/v3/song/detail");
    assert.deepEqual(JSON.parse(data.c), [{ id: 1 }, { id: 2 }]);
    return response({ code: 200, songs: [song(2), song(1)], privileges: [{ id: 1, st: 0, pl: 320000 }, { id: 2, st: 0, pl: 0 }] });
  });
  const result = await plugin.search({ query: "song", offset: 30 });
  assert.deepEqual(result.tracks.map((t) => [t.id, t.unavailable]), [["1", false], ["2", true]]);
  assert.equal(result.more, true);
});

// The host shows one ranked string per suggestion. NetEase groups them by
// kind, so flatten in its order, drop blanks and repeats, and never turn a
// missing name into "undefined".
test("suggest maps NetEase groups to ranked, unique search strings", async () => {
  const { plugin } = await setup(async (url) => {
    assert.ok(url.includes("/api/search/suggest/web"));
    assert.equal(new URL(url).searchParams.get("s"), "周杰");
    return response({ code: 200, result: {
      songs: [{ id: 1, name: "七里香" }, { id: 2, name: "同名" }, { id: 3 }],
      artists: [{ id: 4, name: "周杰伦" }, { id: 5, name: "同名" }],
      albums: [{ id: 6, name: "叶惠美" }],
      playlists: [{ id: 7, name: "" }, { id: 8, name: "周杰伦歌单" }],
      order: ["artists", "songs", "albums", "playlists"],
    } });
  });
  assert.deepEqual(await plugin.suggest({ query: " 周杰 " }), ["周杰伦", "同名", "七里香", "叶惠美", "周杰伦歌单"]);
});

// An empty query must not ask the server, and the host needs no more than ten
// options. The host already ignores a late answer after the query changes.
test("suggest skips empty queries and caps the host's list", async () => {
  let calls = 0;
  const { plugin } = await setup(async () => {
    calls++;
    return response({ code: 200, result: {
      songs: Array.from({ length: 20 }, (_, i) => ({ id: i + 1, name: `Song ${i + 1}` })),
    } });
  });
  assert.deepEqual(await plugin.suggest({ query: "   " }), []);
  assert.equal(calls, 0);
  assert.equal((await plugin.suggest({ query: "song" })).length, 10);
});

// A playlist can contain only a preview of the actual track list.
test("playlist resolves trackIds beyond the preview and retains their order", async () => {
  const { plugin } = await setup(async (url) => url.includes("playlist/detail")
    ? response({ code: 200, playlist: { id: 9, name: "List", trackCount: 3, tracks: [song(3)], trackIds: [{ id: 3 }, { id: 2 }, { id: 1 }] } })
    : response({ code: 200, songs: [song(1), song(2), song(3)], privileges: [] }));
  assert.deepEqual((await plugin.playlist({ id: "9" })).tracks.map((t) => t.id), ["3", "2", "1"]);
});

// Previews and missing authorization must not be represented as full playback.
test("stream rejects previews, unavailable tracks and unexpected download hosts", async () => {
  for (const audio of [
    { id: 1, url: "https://m1.music.126.net/song.mp3", freeTrialInfo: { start: 0, end: 30 } },
    { id: 1, url: null, code: 404 },
    { id: 1, url: "https://unexpected.example/song.mp3" },
  ]) {
    const { plugin } = await setup(async () => response({ code: 200, data: [audio] }));
    await assert.rejects(plugin.stream({ id: "1" }), { code: "unavailable" });
  }
});

// Host quality names differ from NetEase's; CDN requests must never get cookies.
test("stream maps quality and keeps the session away from the CDN", async () => {
  const { plugin } = await setup(async (_url, init) => {
    const { data } = decode(init.body);
    assert.equal(data.level, "exhigh");
    assert.equal(data.header.MUSIC_U, "synthetic-session");
    return response({ code: 200, data: [{ id: 1, code: 200, url: "http://m1.music.126.net/song.mp3?token=audio%2Ftoken&expires=123", type: "mp3", level: "exhigh", size: 100, freeTrialInfo: null }] });
  }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
  const audio = await plugin.stream({ id: "1", quality: "high" });
  assert.equal(audio.url, "https://m1.music.126.net/song.mp3?token=audio%2Ftoken&expires=123");
  assert.equal(audio.quality, "high");
  assert.equal(audio.headers.Cookie, undefined);
});

// A late account response after sign-out must not resurrect persisted credentials.
test("sign-out wins over an in-flight account request", async () => {
  let finish;
  const { plugin, storage } = await setup(() => new Promise((resolve) => { finish = resolve; }), {
    cookies: { MUSIC_U: "synthetic-session" }, profile: null,
  });
  const pending = plugin.account();
  plugin.signOut();
  finish(response({ code: 200, profile: { userId: 8, nickname: "Fixture" } }));
  await assert.rejects(pending);
  assert.equal(await plugin.account(), null);
  assert.equal(storage.has("session"), false);
});

// A QR confirmation persists only accepted session cookies, not response metadata.
test("QR sign-in stores an approved session, restores it, then removes it on sign-out", async () => {
  const { plugin, storage, prompts } = await setup(async (url, init) => {
    if (url.includes("unikey")) return response({ code: 200, unikey: "synthetic-qr" });
    if (url.includes("qrcode/client/login")) return response({ code: 803 }, [
      "MUSIC_U=synthetic-session; Expires=Wed, 09 Jun 2027 10:18:14 GMT; Path=/; HttpOnly",
      "__csrf=synthetic-csrf; Path=/", "unrelated=ignored; Path=/",
    ]);
    assert.equal(init.headers.Cookie, "MUSIC_U=synthetic-session; __csrf=synthetic-csrf");
    return response({ code: 200, profile: { userId: 8, nickname: "Fixture" } });
  });
  assert.equal((await plugin.signIn()).id, "8");
  assert.equal(prompts.some((p) => !!p.qr), true);
  assert.deepEqual(Object.keys(storage.get("session").cookies).sort(), ["MUSIC_U", "__csrf"]);
  assert.equal((await plugin.account()).name, "Fixture");
  plugin.signOut();
  assert.equal(await plugin.account(), null);
  assert.equal(storage.has("session"), false);
});

// Expired credentials must lead to a sign-in prompt instead of endless retries.
test("expired session is cleared; guest private actions require sign-in", async () => {
  const { plugin, storage } = await setup(async () => response({ code: 301 }), {
    cookies: { MUSIC_U: "synthetic-session" }, profile: null,
  });
  assert.equal(await plugin.account(), null);
  assert.equal(storage.has("session"), false);
  await assert.rejects(plugin.like({ id: "1", on: true }), { code: "signIn" });
  await assert.rejects(plugin.liked({ offset: 0 }), { code: "signIn" });
  assert.deepEqual(await plugin.playlists(), []);
});

// Missing details must still consume a slot in the host's offset-based pages.
test("search and liked keep missing IDs across partial and empty detail pages", async () => {
  const all = Array.from({ length: 60 }, (_, i) => i + 1);
  for (const kind of ["search", "liked"]) {
    for (const missingAll of [false, true]) {
      const offsets = [];
      const { plugin } = await setup(async (url, init) => {
        if (url.includes("account/get")) return response({ code: 200, profile: { userId: 8, nickname: "Fixture" } });
        if (url.includes("cloudsearch")) {
          const offset = Number(new URL(url).searchParams.get("offset"));
          offsets.push(offset);
          return response({ code: 200, result: { songs: all.slice(offset, offset + 30).map(song), songCount: 60 } });
        }
        const { path, data } = decode(init.body);
        if (path === "/api/song/like/get") return response({ code: 200, ids: all });
        assert.equal(path, "/api/v3/song/detail");
        const ids = JSON.parse(data.c).map(x => x.id);
        const present = ids.filter(id => missingAll ? id > 30 : id !== 1);
        return response({ code: 200, songs: present.map(song), privileges: present.map(id => ({ id, st: 0, pl: 320000 })) });
      }, kind === "liked" ? { cookies: { MUSIC_U: "synthetic-session" }, profile: null } : undefined);
      const page = offset => kind === "search" ? plugin.search({ query: "song", offset }) : plugin.liked({ offset });
      const first = await page(0);
      assert.equal(first.tracks.length, 30);
      assert.equal(first.more, true);
      assert.equal(first.tracks[0].id, "1");
      assert.equal(first.tracks[0].unavailable, true);
      if (kind === "search") assert.equal(first.tracks[0].name, "Song 1");
      if (missingAll) assert.ok(first.tracks.every(track => track.unavailable));
      const second = await page(first.tracks.length);
      assert.equal(second.more, false);
      assert.deepEqual([...first.tracks, ...second.tracks].map(track => track.id), all.map(String));
      if (kind === "search") assert.deepEqual(offsets, [0, 30]);
    }
  }
});

// A successful response can revoke a session through Set-Cookie, not only code 301.
test("server cookie deletion clears persisted state and cannot return after reload", async () => {
  for (const cookie of [
    "MUSIC_U=deleted; Max-Age=0; Path=/",
    "MUSIC_U=deleted; Max-Age=-1; Path=/",
    "MUSIC_U=; Path=/",
    "MUSIC_U=deleted; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/",
  ]) {
    const { plugin, storage } = await setup(async () => response({ code: 200, result: [] }, [cookie]), {
      cookies: { MUSIC_U: "synthetic-old-session" }, profile: { id: "8", name: "Fixture" },
    });
    await assert.rejects(plugin.home(), { code: "signIn" });
    assert.equal(storage.has("session"), false);
    assert.equal(await plugin.account(), null);
    const restored = await setup(async (_url, init) => {
      assert.equal(init.headers.Cookie, undefined);
      return response({ code: 200, result: [] });
    }, storage.get("session"));
    await restored.plugin.home();
    assert.equal(await restored.plugin.account(), null);
  }
});

// A positive Max-Age overrides Expires and must persist the replacement cookie.
test("normal cookie renewal remains persisted", async () => {
  const { plugin, storage } = await setup(async () => response({ code: 200, result: [] }, [
    "MUSIC_U=synthetic-renewed; Max-Age=3600; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/",
  ]), { cookies: { MUSIC_U: "synthetic-old" }, profile: null });
  await plugin.home();
  assert.equal(storage.get("session").cookies.MUSIC_U, "synthetic-renewed");
});

// Concurrent requests share a single retry, using the same identity and quality.
test("stream recovers from one 460 without duplicating concurrent requests", async () => {
  for (const code of [460, -460]) {
    const requests = [];
    const { plugin } = await setup(async (_url, init) => {
      requests.push(decode(init.body).data);
      if (requests.length === 1) return response({ code });
      return response({ code: 200, data: [{ id: 1, code: 200, url: "https://m1.music.126.net/song.mp3", type: "mp3", freeTrialInfo: null }] });
    }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
    const [a, b] = await Promise.all([plugin.stream({ id: "1" }), plugin.stream({ id: "1" })]);
    assert.deepEqual(a, b);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].header.deviceId, requests[1].header.deviceId);
    assert.equal(requests[0].header.MUSIC_U, requests[1].header.MUSIC_U);
    assert.equal(requests[0].level, requests[1].level);
  }
});

// Persistent rejection stops after two attempts, and the failed promise isn't cached.
test("stream bounds persistent 460 retries and releases the in-flight entry", async () => {
  let calls = 0;
  const { plugin } = await setup(async () => {
    calls++;
    if (calls <= 2) return response({ code: -460 });
    return response({ code: 200, data: [{ id: 1, url: "https://m1.music.126.net/song.mp3", freeTrialInfo: null }] });
  });
  await assert.rejects(plugin.stream({ id: "1" }), /仍拒绝播放请求（-460）/);
  assert.equal(calls, 2);
  assert.equal((await plugin.stream({ id: "1" })).type, "mp3");
  assert.equal(calls, 3);
});

// Signing out during backoff must prevent the retry from using another session.
test("sign-out cancels a scheduled playback retry", async (t) => {
  const timer = globalThis.setTimeout;
  let wake;
  let scheduled;
  const queued = new Promise(resolve => { scheduled = resolve; });
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) => {
    // The retry wait can be a millisecond less than the 2s cooldown.
    if (ms >= 1000 && ms < 12000) { wake = fn; scheduled(); return 0; }
    return timer(fn, ms, ...args);
  });
  let calls = 0;
  const { plugin } = await setup(async () => { calls++; return response({ code: -460 }); });
  const playing = plugin.stream({ id: "1" });
  await queued;
  plugin.signOut();
  wake();
  await assert.rejects(playing, /账号状态已改变/);
  assert.equal(calls, 1);
});

// The retry must not turn permission errors or previews into playback successes.
test("stream does not retry expired authentication or trial audio", async () => {
  for (const body of [
    { code: 301 },
    { code: 200, data: [{ id: 1, url: "https://m1.music.126.net/song.mp3", freeTrialInfo: { start: 0, end: 30 } }] },
  ]) {
    let calls = 0;
    const { plugin } = await setup(async () => { calls++; return response(body); });
    await assert.rejects(plugin.stream({ id: "1" }));
    assert.equal(calls, 1);
  }
});

// A song with no lossless source must still play at the level that has one:
// asking once and skipping was the reported "next track skipped a song".
test("stream asks the level below only when this level has no source", async () => {
  const levels = [];
  const { plugin, storage } = await setup(async (_url, init) => {
    const { data } = decode(init.body);
    levels.push(data.level);
    if (data.level === "lossless") {
      return response({ code: 200, data: [{ id: 1, url: null, code: 404, level: "lossless", freeTrialInfo: null }] });
    }
    return response({ code: 200, data: [{ id: 1, code: 200, url: "https://m1.music.126.net/song.mp3", type: "mp3", level: "exhigh" }] });
  }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
  const audio = await plugin.stream({ id: "1", quality: "lossless" });
  assert.deepEqual(levels, ["lossless", "exhigh"]);
  // The host caches what actually plays, so the level it reports decides
  // whether a later play of the same song is served from the cache.
  assert.equal(audio.quality, "high");
  assert.deepEqual(storage.get("streamLog").map(entry => [entry.song, entry.level, entry.outcome, entry.hasURL]), [
    ["1", "lossless", "missing", false],
    ["1", "exhigh", "ok", true],
  ]);
});

// A trial is what the account may play. Asking lower cannot give more, and
// handing the clip over would play a preview as if it were the song.
test("stream never falls back after a trial or into one", async () => {
  const levels = [];
  const { plugin, storage } = await setup(async (_url, init) => {
    levels.push(decode(init.body).data.level);
    return response({ code: 200, data: [{ id: 1, url: "https://m1.music.126.net/clip.mp3", code: 200, level: "lossless", freeTrialInfo: { start: 0, end: 30 } }] });
  });
  await assert.rejects(plugin.stream({ id: "1", quality: "lossless" }), { code: "unavailable" });
  assert.deepEqual(levels, ["lossless"]);
  assert.equal(storage.get("streamLog")[0].trial, true);
});

// A server error or a timeout says nothing about this song's levels, so it is
// retried at the quality asked for and never answered by a lower one.
test("stream retries a moment's failure at the same level, not a lower one", async () => {
  const levels = [];
  const { plugin, storage } = await setup(async (_url, init) => {
    levels.push(decode(init.body).data.level);
    return { ok: false, status: 503, json: async () => ({}), headers: { getSetCookie: () => [] } };
  });
  await assert.rejects(plugin.stream({ id: "1", quality: "lossless" }), /HTTP 503/);
  assert.deepEqual(levels, ["lossless", "lossless"]);
  assert.deepEqual(storage.get("streamLog").map(entry => entry.outcome), ["transient", "transient"]);
});

// The diagnostic must name the code that refused, so a reader can tell a
// throttled request from a lost network. A missing code made 460 look unknown.
test("stream records the NetEase code that refused the request", async () => {
  for (const code of [460, -460]) {
    const { plugin, storage } = await setup(async () => response({ code }));
    await assert.rejects(plugin.stream({ id: "1" }), new RegExp(`仍拒绝播放请求（${code}）`));
    assert.deepEqual(storage.get("streamLog").map(entry => [entry.outcome, entry.code]), [
      ["transient", code], ["transient", code],
    ], String(code));
  }
});

// NetEase reports throttling and server errors inside the song record too, with
// a successful transport. Only waiting can change that answer, so it is retried
// at the level asked for, never read as "this level has no source".
test("stream retries a moment's failure inside the song record at the same level", async () => {
  for (const code of [429, 500, 502, 503]) {
    const levels = [];
    const { plugin, storage } = await setup(async (_url, init) => {
      levels.push(decode(init.body).data.level);
      return response({ code: 200, data: [{ id: 1, code, url: null, level: "lossless", freeTrialInfo: null }] });
    }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
    await assert.rejects(plugin.stream({ id: "1", quality: "lossless" }), new RegExp(`暂时无法返回音源（${code}）`));
    assert.deepEqual(levels, ["lossless", "lossless"], String(code));
    assert.deepEqual(storage.get("streamLog").map(entry => [entry.level, entry.outcome, entry.code]), [
      ["lossless", "transient", code], ["lossless", "transient", code],
    ], String(code));
  }
});

// The retry is a wait, not a downgrade: the next answer plays the level asked for.
test("stream plays at the asked level after one transitory song record", async () => {
  let calls = 0;
  const { plugin, storage } = await setup(async () => {
    calls++;
    if (calls === 1) return response({ code: 200, data: [{ id: 1, code: 429, level: "lossless", freeTrialInfo: null }] });
    return response({ code: 200, data: [{ id: 1, code: 200, url: "https://m1.music.126.net/song.flac", type: "flac", level: "lossless" }] });
  });
  const audio = await plugin.stream({ id: "1", quality: "lossless" });
  assert.equal(audio.type, "flac");
  assert.equal(audio.quality, "lossless");
  assert.equal(calls, 2);
  assert.deepEqual(storage.get("streamLog").map(entry => entry.outcome), ["transient", "ok"]);
});

// An empty answer is a soft refusal, not proof that the account lacks the
// right to play the song: it must not become a permission error or a downgrade.
test("stream does not call an empty answer a permission problem", async () => {
  const levels = [];
  const { plugin } = await setup(async (_url, init) => {
    levels.push(decode(init.body).data.level);
    return response({ code: 200, data: [] });
  });
  await assert.rejects(plugin.stream({ id: "1", quality: "lossless" }), (error) => {
    assert.equal(error.code, undefined);
    assert.match(error.message, /未返回这首歌的音源/);
    return true;
  });
  assert.deepEqual(levels, ["lossless", "lossless"]);
});

// A content 401 must not sign the listener out: the session is still valid, and
// signing out loses their library over one song the account may not open. The
// account endpoint is the only thing that can tell the two 401s apart.
const ACCOUNT_OK = { code: 200, profile: { userId: 8, nickname: "Fixture" } };

test("stream keeps the session when a content 401 comes back", async () => {
  let probes = 0;
  const { plugin, storage } = await setup(async (url, init) => {
    if (url.includes("/api/nuser/account/get")) {
      probes++;
      assert.match(init.headers.Cookie, /MUSIC_U=synthetic-session/);
      return response(ACCOUNT_OK);
    }
    return response({ code: 401 });
  }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
  await assert.rejects(plugin.stream({ id: "1" }), { code: "unavailable" });
  assert.equal(storage.get("session").cookies.MUSIC_U, "synthetic-session");
  assert.deepEqual(storage.get("streamLog").map(entry => entry.outcome), ["error"]);
  await assert.rejects(plugin.stream({ id: "2" }), { code: "unavailable" });
});

// A 401 with no account behind it is a real expiry: the listener has to be told
// to sign in again, and the dead credentials must not stay in storage.
test("content 401 without an account asks for sign-in and clears the session", async () => {
  const { plugin, storage } = await setup(async (url) => url.includes("/api/nuser/account/get")
    ? response({ code: 200 })
    : response({ code: 401 }), { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
  await assert.rejects(plugin.stream({ id: "1" }), { code: "signIn" });
  assert.equal(storage.has("session"), false);
  assert.equal(await plugin.account(), null);
});

// The check must never become the sign-out it is meant to prevent: a network
// failure, a refusal or even a 301 from the probe leaves the session alone.
test("a content 401 whose account check cannot finish keeps the session", async () => {
  for (const answer of [
    () => { throw new Error("network down"); },
    () => response({ code: 503 }),
    () => response({ code: 460 }),
    () => response({ code: 301 }),
  ]) {
    const { plugin, storage } = await setup(async (url) => url.includes("/api/nuser/account/get")
      ? answer()
      : response({ code: 401 }), { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
    await assert.rejects(plugin.stream({ id: "1" }), { code: "unavailable" });
    assert.equal(storage.get("session").cookies.MUSIC_U, "synthetic-session");
  }
});

// Every refusal in the window shares one check, so a queue of unavailable songs
// does not add an account request per song.
test("repeated content 401s in one window ask the account once", async () => {
  let probes = 0;
  const { plugin, storage } = await setup(async (url) => {
    if (url.includes("/api/nuser/account/get")) {
      probes++;
      return response(ACCOUNT_OK);
    }
    return response({ code: 401 });
  }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
  await assert.rejects(plugin.stream({ id: "1" }), { code: "unavailable" });
  await assert.rejects(plugin.stream({ id: "2" }), { code: "unavailable" });
  assert.equal(probes, 1);
  assert.equal(storage.get("session").cookies.MUSIC_U, "synthetic-session");
});

// A 401 can also revoke the cookie. Taking it must not sign out on its own: the
// deletion is kept in memory, the check runs without a cookie, and only its
// answer clears the stored session.
test("a content 401 that deletes the cookie signs out only after the account check", async () => {
  const { plugin, storage } = await setup(async (url, init) => {
    if (url.includes("/api/nuser/account/get")) {
      assert.equal(init.headers.Cookie, undefined);
      return response({ code: 200 });
    }
    return response({ code: 401 }, ["MUSIC_U=deleted; Max-Age=0; Path=/"]);
  }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
  await assert.rejects(plugin.stream({ id: "1" }), { code: "signIn" });
  assert.equal(storage.has("session"), false);
});

// The check is a window, not a permanent answer: once it lapses, the next 401
// must ask the account again, or an expiry after the first check is never seen.
test("an expired account check asks the account again", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  let probes = 0;
  let hasAccount = true;
  const { plugin, storage } = await setup(async (url) => {
    if (url.includes("/api/nuser/account/get")) {
      probes++;
      return hasAccount ? response(ACCOUNT_OK) : response({ code: 200 });
    }
    return response({ code: 401 });
  }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
  await assert.rejects(plugin.stream({ id: "1" }), { code: "unavailable" });
  assert.equal(probes, 1);
  assert.equal(storage.get("session").cookies.MUSIC_U, "synthetic-session");
  hasAccount = false;
  t.mock.timers.tick(31000);
  await assert.rejects(plugin.stream({ id: "2" }), { code: "signIn" });
  assert.equal(probes, 2);
  assert.equal(storage.has("session"), false);
});

// A 401 inside the song record is the same ambiguous 401 as the top-level one:
// ask the account read-only, and never sign out on the number alone.
test("a 401 inside the song record asks the account instead of signing out", async () => {
  let probes = 0;
  let streams = 0;
  const { plugin, storage } = await setup(async (url) => {
    if (url.includes("/api/nuser/account/get")) {
      probes++;
      return response(ACCOUNT_OK);
    }
    streams++;
    return response({ code: 200, data: [{ id: 1, code: 401, url: null }] });
  }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
  await assert.rejects(plugin.stream({ id: "1", quality: "lossless" }), { code: "unavailable" });
  assert.equal(probes, 1);
  // No lower level can answer a refused login, so only the asked level ran.
  assert.equal(streams, 1);
  assert.equal(storage.get("session").cookies.MUSIC_U, "synthetic-session");
});

// A 401 inside the song record with no account behind it is a real expiry, and
// the dead credentials must not stay in storage.
test("a 401 inside the song record signs out when the account is gone", async () => {
  const { plugin, storage } = await setup(async (url) => url.includes("/api/nuser/account/get")
    ? response({ code: 200 })
    : response({ code: 200, data: [{ id: 1, code: 401, url: null }] }),
  { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
  await assert.rejects(plugin.stream({ id: "1" }), { code: "signIn" });
  assert.equal(storage.has("session"), false);
});

// A check that cannot finish says nothing about the login, so the song-record
// 401 keeps the session just like the top-level one does.
test("a 401 inside the song record keeps the session when the check cannot finish", async () => {
  for (const answer of [
    () => { throw new Error("network down"); },
    () => response({ code: 460 }),
    () => response({ code: 200, profile: { nickname: "Fixture" } }),
  ]) {
    const { plugin, storage } = await setup(async (url) => url.includes("/api/nuser/account/get")
      ? answer()
      : response({ code: 200, data: [{ id: 1, code: 401, url: null }] }),
    { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
    await assert.rejects(plugin.stream({ id: "1" }), { code: "unavailable" });
    assert.equal(storage.get("session").cookies.MUSIC_U, "synthetic-session");
  }
});

// A cached "still signed in" belongs to the credential it was asked with. If
// the same window later loses MUSIC_U, the next 401 must check again.
test("a cached account check stops answering once the cookie is gone", async () => {
  let refusals = 0;
  const { plugin, storage } = await setup(async (url) => {
    if (url.includes("/api/nuser/account/get")) return response(ACCOUNT_OK);
    refusals++;
    return refusals === 1
      ? response({ code: 401 })
      : response({ code: 401 }, ["MUSIC_U=deleted; Max-Age=0; Path=/"]);
  }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
  await assert.rejects(plugin.stream({ id: "1" }), { code: "unavailable" });
  assert.equal(storage.get("session").cookies.MUSIC_U, "synthetic-session");
  await assert.rejects(plugin.stream({ id: "2" }), { code: "signIn" });
  assert.equal(storage.has("session"), false);
});

// 301 and 302 inside the song record carry no evidence here that the login
// ended, and no lower level can answer them: stop, keep the session and code.
test("a 301 or 302 inside the song record stops without downgrading or signing out", async () => {
  for (const code of [301, 302]) {
    const levels = [];
    const { plugin, storage } = await setup(async (_url, init) => {
      levels.push(decode(init.body).data.level);
      return response({ code: 200, data: [{ id: 1, code, url: null }] });
    }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
    await assert.rejects(plugin.stream({ id: "1", quality: "lossless" }), (error) => {
      assert.equal(error.code, undefined, String(code));
      assert.equal(error.neteaseCode, code, String(code));
      assert.match(error.message, new RegExp(String(code)), String(code));
      return true;
    });
    assert.deepEqual(levels, ["lossless"], String(code));
    assert.equal(storage.get("session").cookies.MUSIC_U, "synthetic-session");
    assert.deepEqual(storage.get("streamLog").map(entry => [entry.level, entry.outcome, entry.code]),
      [["lossless", "refused", code]], String(code));
  }
});

// Downgrading is only allowed for a shape that proves the level has no source.
// An unlisted code, a missing code, or a record that contradicts itself is not
// that proof: stop at the level asked and keep the number for the reader.
test("an unlisted stream result stops at the level asked and keeps its number", async () => {
  for (const [record, code, label] of [
    [{ id: 1, code: 402, url: null }, 402, "402"],
    [{ id: 1, url: null }, null, "no code"],
    [{ id: 1, code: 404, url: "https://m1.music.126.net/song.mp3" }, 404, "contradictory 404"],
  ]) {
    const levels = [];
    const { plugin, storage } = await setup(async (_url, init) => {
      levels.push(decode(init.body).data.level);
      return response({ code: 200, data: [record] });
    }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
    await assert.rejects(plugin.stream({ id: "1", quality: "lossless" }), (error) => {
      assert.equal(error.code, undefined, label);
      assert.equal(error.neteaseCode, code, label);
      assert.match(error.message, /已停止降档/, label);
      return true;
    });
    assert.deepEqual(levels, ["lossless"], label);
    assert.deepEqual(storage.get("streamLog").map(entry => [entry.level, entry.outcome, entry.code]),
      [["lossless", "refused", code ?? null]], label);
  }
});

// A top-level throttle or server error code is a moment's failure, not a
// missing level: retry once at the quality asked for, keep the number, and
// never fall back to a lower quality.
test("stream retries a top-level 429 or 5xx code at the same level", async () => {
  for (const code of [429, 500, 503, 599]) {
    const levels = [];
    const { plugin, storage } = await setup(async (_url, init) => {
      levels.push(decode(init.body).data.level);
      return response({ code });
    }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
    await assert.rejects(plugin.stream({ id: "1", quality: "lossless" }), (error) => {
      assert.equal(error.neteaseCode, code, String(code));
      assert.equal(error.transient, true, String(code));
      return true;
    });
    assert.deepEqual(levels, ["lossless", "lossless"], String(code));
    assert.deepEqual(storage.get("streamLog").map(entry => [entry.level, entry.outcome, entry.code]), [
      ["lossless", "transient", code], ["lossless", "transient", code],
    ], String(code));
  }
});

// The top-level 405, a failed HTTP request, and a transient JSON code must all
// leave their number in the diagnostics. Only the already-transient ones are
// retried: recording a code must not widen the retry policy.
test("stream diagnostics record the code of a top-level refusal or HTTP failure", async () => {
  for (const [answer, code, attempts, outcome] of [
    [() => response({ code: 405 }), 405, 2, "transient"],
    [() => ({ ok: false, status: 502, json: async () => ({}), headers: { getSetCookie: () => [] } }), 502, 2, "transient"],
    [() => response({ code: 503 }), 503, 2, "transient"],
    [() => response({ code: 402 }), 402, 1, "error"],
  ]) {
    let calls = 0;
    const { plugin, storage } = await setup(async () => { calls++; return answer(); },
      { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
    await assert.rejects(plugin.stream({ id: "1", quality: "lossless" }), { neteaseCode: code });
    assert.equal(calls, attempts, String(code));
    const log = storage.get("streamLog");
    assert.equal(log.length, attempts, String(code));
    for (const entry of log) assert.deepEqual([entry.level, entry.outcome, entry.code], ["lossless", outcome, code], String(code));
  }
});

// An account answer without a usable ID is neither an account nor proof that
// the login ended: never cache it and never sign out over it.
test("an account answer without a usable ID is neither cached nor a sign-out", async () => {
  const { plugin, storage } = await setup(async (url) => url.includes("/api/nuser/account/get")
    ? response({ code: 200, profile: { nickname: "Fixture" } })
    : response({ code: 200, data: [{ id: 1, code: 401, url: null }] }),
  { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
  await assert.rejects(plugin.stream({ id: "1" }), { code: "unavailable" });
  assert.equal(storage.get("session").cookies.MUSIC_U, "synthetic-session");
  assert.equal(storage.get("session").profile ?? null, null);
  await assert.rejects(plugin.account(), /有效的账号信息/);
});

// Diagnostics are kept for reading later, so they are bounded and hold nothing
// that could identify the listener or the audio.
test("stream diagnostics stay bounded and leave out URLs and cookies", async () => {
  const { plugin, storage } = await setup(async (_url, init) => {
    const { data } = decode(init.body);
    const id = JSON.parse(data.ids)[0];
    return response({ code: 200, data: [
      { id, code: 200, url: "https://m1.music.126.net/song.mp3?token=audio%2Ftoken&expires=123", type: "mp3", level: "exhigh" },
    ] });
  }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
  // Distinct songs keep the cache from answering for the requests this test
  // counts; the ring must still hold only the last 20 attempts.
  for (let i = 1; i <= 25; i++) await plugin.stream({ id: String(i) });
  const log = storage.get("streamLog");
  assert.equal(log.length, 20);
  const saved = JSON.stringify(log);
  assert.ok(!saved.includes("audio%2Ftoken&expires=123"), saved);
  assert.ok(!saved.includes("synthetic-session"), saved);
  assert.ok(!saved.includes("https://"), saved);
  assert.deepEqual(Object.keys(log[0]).sort(), ["actual", "at", "attempt", "code", "elapsedMs", "hasURL", "level", "outcome", "song", "trial", "waitMs"]);
  assert.deepEqual([log[0].song, log[0].level, log[0].code, log[0].hasURL, log[0].trial, log[0].actual],
    ["6", "exhigh", 200, true, false, "exhigh"]);
  assert.deepEqual([log.at(-1).song, log.at(-1).outcome], ["25", "ok"]);
});

// NetEase's immersive levels have no host name of their own. A lossless file
// kept as "high" is downloaded again on every lossless play; a lossy file kept
// as "lossless" would be served to lossless requests instead.
test("stream reports the quality the response proves", async () => {
  for (const [level, type, quality] of [
    ["jymaster", "flac", "lossless"], ["sky", "flac", "lossless"], ["jymaster", "mp3", "high"],
    [undefined, "flac", "lossless"], [undefined, "mp3", "high"], ["hires", "flac", "lossless"],
    // A known lossy container outranks the level name it came with.
    ["lossless", "mp3", "high"], ["hires", "ogg", "high"],
  ]) {
    const { plugin } = await setup(async () => response({ code: 200, data: [
      { id: 1, code: 200, url: "https://m1.music.126.net/song", type, level },
    ] }));
    assert.equal((await plugin.stream({ id: "1", quality: "lossless" })).quality, quality, `${level} ${type}`);
  }
});

// Prefetch and the real play often ask for the same song within a moment. A
// short cache may reuse that answer, but it must keep the quality the response
// proved and must use the quality that was asked for as its key.
test("cooldown releases different songs in separate request slots", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const starts = []; let refused = false;
  const { plugin, storage } = await setup(async (_url, init) => {
    const id = JSON.parse(decode(init.body).data.ids)[0];
    starts.push({ id, at: Date.now() });
    if (!refused) { refused = true; return response({ code: -460 }); }
    return response({ code: 200, data: [{ id, code: 200, url: "https://m1.music.126.net/source.flac", type: "flac" }] });
  });
  const settle = async () => { for (let i = 0; i < 12; i++) await flush(); };
  const first = plugin.stream({ id: "1" }); await settle();
  const second = plugin.stream({ id: "2" }); const third = plugin.stream({ id: "3" }); await settle();
  t.mock.timers.tick(2000); await settle();
  assert.equal(starts.length, 2, "only one request leaves at the cooldown boundary");
  t.mock.timers.tick(200); await settle();
  t.mock.timers.tick(200); await settle();
  await Promise.all([first, second, third]);
  for (let i = 2; i < starts.length; i++) assert.ok(starts[i].at - starts[i - 1].at >= 200);
  const recovered = storage.get("streamLog").find(item => item.song === "1" && item.outcome === "ok");
  assert.equal(recovered.attempt, 2);
  assert.ok(recovered.waitMs >= 2000);
  assert.ok(recovered.elapsedMs >= recovered.waitMs);
});

test("QR completion invalidates sources fetched while the old session was active", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let calls = 0;
  const { plugin } = await setup(async (url) => {
    if (url.includes("/qrcode/unikey")) return response({ code: 200, unikey: "fixture-qr" });
    if (url.includes("/qrcode/client/login")) return response({ code: 803 }, ["MUSIC_U=synthetic-new; Path=/"]);
    if (url.includes("/nuser/account/get")) return response({ code: 200, profile: { userId: 2, nickname: "Fixture" } });
    calls++; return response({ code: 200, data: [{ id: 1, code: 200, url: "https://m1.music.126.net/source.flac", type: "flac" }] });
  }, { cookies: { MUSIC_U: "synthetic-old" }, profile: { id: "1" } });
  const login = plugin.signIn();
  await plugin.stream({ id: "1" });
  t.mock.timers.tick(1500); for (let i = 0; i < 12; i++) await flush();
  await login;
  await plugin.stream({ id: "1" });
  assert.equal(calls, 2, "new session cannot reuse the old session's source");
});

test("late successful source responses are rejected before caching", async (t) => {
  let clock = Date.now(); t.mock.method(Date, "now", () => clock);
  const { plugin, storage } = await setup(async () => {
    clock += 26000;
    return response({ code: 200, data: [{ id: 1, code: 200, url: "https://m1.music.126.net/source.flac", type: "flac" }] });
  });
  await assert.rejects(plugin.stream({ id: "1" }), error => error.deadline === true);
  assert.ok((storage.get("streamLog") || []).every(item => item.outcome !== "ok"));
});

test("Retry-After is shared by later source calls, not only the rejected call", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let calls = 0;
  const { plugin } = await setup(async () => {
    calls++;
    if (calls === 1) return response({ code: 429 }, [], { "retry-after": "60" });
    return response({ code: 200, data: [{ id: 2, code: 200, url: "https://m1.music.126.net/source.flac", type: "flac" }] });
  });
  await assert.rejects(plugin.stream({ id: "1" }), error => error.deadline === true);
  const waiting = plugin.stream({ id: "2" }).then(value => ({ value }), error => ({ error }));
  for (let i = 0; i < 12; i++) await flush();
  t.mock.timers.tick(2000); for (let i = 0; i < 12; i++) await flush();
  assert.equal(calls, 1, "new calls must not shorten the server's requested wait");
  t.mock.timers.tick(23000); for (let i = 0; i < 12; i++) await flush();
  assert.equal((await waiting).error.deadline, true);
});

test("stream reuses a brief successful source without relabelling a fallback", async () => {
  const levels = [];
  const { plugin, storage } = await setup(async (_url, init) => {
    const { data } = decode(init.body);
    const id = JSON.parse(data.ids)[0];
    levels.push(data.level);
    if (data.level === "lossless") {
      return response({ code: 200, data: [{ id, url: null, code: 404, level: "lossless", freeTrialInfo: null }] });
    }
    return response({ code: 200, data: [
      { id, code: 200, url: "https://m1.music.126.net/song.mp3", type: "mp3", level: "exhigh" },
    ] });
  }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
  const first = await plugin.stream({ id: "1", quality: "lossless" });
  assert.equal(first.quality, "high");
  const second = await plugin.stream({ id: "1", quality: "lossless" });
  assert.deepEqual(second, first);
  assert.deepEqual(levels, ["lossless", "exhigh"], "the cached answer is reused");
  assert.deepEqual(storage.get("streamLog").map((entry) => [entry.level, entry.outcome, entry.hasURL]), [
    ["lossless", "missing", false], ["exhigh", "ok", true], ["exhigh", "cached", true],
  ]);
  assert.ok(!JSON.stringify(storage.get("streamLog")).includes("https://"), "no URL in cached diagnostics");
  // Another requested quality is another key, even for the same song.
  await plugin.stream({ id: "1", quality: "high" });
  assert.deepEqual(levels, ["lossless", "exhigh", "exhigh"]);
  // So is another song.
  await plugin.stream({ id: "2", quality: "lossless" });
  assert.deepEqual(levels, ["lossless", "exhigh", "exhigh", "lossless", "exhigh"]);
});

// The reuse window is deliberately short: it joins a prefetch with its play,
// not a listening session.
test("stream stops reusing a source after the short cache window", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  let calls = 0;
  const { plugin } = await setup(async () => {
    calls++;
    return response({ code: 200, data: [
      { id: 1, code: 200, url: "https://m1.music.126.net/song.mp3", type: "mp3", level: "exhigh" },
    ] });
  });
  await plugin.stream({ id: "1" });
  await plugin.stream({ id: "1" });
  assert.equal(calls, 1);
  t.mock.timers.tick(15000);
  await plugin.stream({ id: "1" });
  assert.equal(calls, 2);
});

// A cached source belongs to the session that asked for it.
test("stream does not reuse a source across a session change", async () => {
  let calls = 0;
  const { plugin } = await setup(async () => {
    calls++;
    return response({ code: 200, data: [
      { id: 1, code: 200, url: "https://m1.music.126.net/song.mp3", type: "mp3", level: "exhigh" },
    ] });
  }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
  await plugin.stream({ id: "1" });
  plugin.signOut();
  await plugin.stream({ id: "1" });
  assert.equal(calls, 2);
});

// The cache is bounded by song count, not only by time.
test("stream bounds how many successful sources it keeps", async () => {
  let calls = 0;
  const { plugin } = await setup(async (_url, init) => {
    calls++;
    const { data } = decode(init.body);
    const id = JSON.parse(data.ids)[0];
    return response({ code: 200, data: [
      { id, code: 200, url: "https://m1.music.126.net/song.mp3", type: "mp3", level: "exhigh" },
    ] });
  });
  for (let i = 1; i <= 12; i++) await plugin.stream({ id: String(i) });
  assert.equal(calls, 12);
  await plugin.stream({ id: "1" });
  assert.equal(calls, 12, "a recent answer is reused");
  await plugin.stream({ id: "13" });
  assert.equal(calls, 13);
  await plugin.stream({ id: "1" });
  assert.equal(calls, 14, "the oldest answer was released");
  await plugin.stream({ id: "3" });
  assert.equal(calls, 14, "a recent answer is still there");
});

// A refusal pauses the next source fetch. It must not serialize unrelated API
// calls, and the wait must end inside the stream budget.
test("a refusal cools down source fetches without blocking other APIs", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const requests = [];
  const { plugin } = await setup(async (url) => {
    requests.push(url);
    if (url.includes("/song/enhance/player/url/v1")) return response({ code: -460 });
    return response({ code: 200, result: [] });
  });
  const sourceCalls = () => requests.filter((url) => url.includes("/song/enhance/player/url/v1")).length;
  const first = plugin.stream({ id: "1" }).then((value) => ({ value }), (error) => ({ error }));
  await flush();
  assert.equal(sourceCalls(), 1);
  t.mock.timers.tick(2000);
  await flush();
  const firstOutcome = await first;
  assert.match(firstOutcome.error.message, /仍拒绝播放请求（-460）/);
  assert.equal(sourceCalls(), 2);
  // An unrelated read answers while the cooldown is still active.
  const before = requests.length;
  await plugin.home();
  assert.equal(requests.length, before + 1);
  const second = plugin.stream({ id: "2" }).then((value) => ({ value }), (error) => ({ error }));
  await flush();
  assert.equal(sourceCalls(), 2, "no source request while cooling down");
  t.mock.timers.tick(2000);
  await flush();
  assert.equal(sourceCalls(), 3);
  t.mock.timers.tick(2000);
  await flush();
  const secondOutcome = await second;
  assert.match(secondOutcome.error.message, /仍拒绝播放请求（-460）/);
});

// A request that hangs must stop before the host's 30s timeout. The budget
// covers the request timeout, the cooldown and the second attempt.
test("a hanging source request stops inside the stream budget", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let calls = 0;
  const { plugin } = await setup(async (_url, init) => {
    calls++;
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  });
  const started = Date.now();
  const playing = plugin.stream({ id: "1" }).then((value) => ({ value }), (error) => ({ error }));
  await flush();
  t.mock.timers.tick(12000);
  await flush();
  t.mock.timers.tick(2000);
  await flush();
  t.mock.timers.tick(11000);
  await flush();
  const outcome = await playing;
  assert.match(outcome.error.message, /等待预算/);
  assert.equal(calls, 2);
  assert.equal(Date.now() - started, 25000);
});

// A Retry-After is a server instruction, not a suggestion: wait at least that
// long, and never retry earlier just to turn a refusal into a success.
test("stream honors a valid Retry-After beyond its own cooldown", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let calls = 0;
  const { plugin } = await setup(async () => {
    calls++;
    if (calls === 1) {
      return {
        ok: false, status: 429, json: async () => ({}),
        headers: { getSetCookie: () => [], get: (name) => String(name).toLowerCase() === "retry-after" ? "3" : null },
      };
    }
    return response({ code: 200, data: [
      { id: 1, code: 200, url: "https://m1.music.126.net/song.mp3", type: "mp3", level: "exhigh" },
    ] });
  });
  const playing = plugin.stream({ id: "1" });
  await flush();
  assert.equal(calls, 1);
  t.mock.timers.tick(2999);
  await flush();
  assert.equal(calls, 1, "waited for Retry-After, not the 2s cooldown");
  t.mock.timers.tick(1);
  await flush();
  assert.equal((await playing).type, "mp3");
  assert.equal(calls, 2);
});

// If the server asks for more time than this call can spend, stop inside the
// budget instead of retrying early.
test("stream stops instead of retrying before an unaffordable Retry-After", async () => {
  let calls = 0;
  const { plugin } = await setup(async () => {
    calls++;
    return {
      ok: false, status: 429, json: async () => ({}),
      headers: { getSetCookie: () => [], get: (name) => String(name).toLowerCase() === "retry-after" ? "60" : null },
    };
  });
  await assert.rejects(plugin.stream({ id: "1" }), /要求等待 60 秒/);
  assert.equal(calls, 1);
});

// A check that could not finish says nothing about the login. Its "no answer"
// must not be cached as a reusable answer for the next 401.
test("an unfinished account check is not reused by the next 401", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let probes = 0;
  const { plugin, storage } = await setup(async (url, init) => {
    if (url.includes("/api/nuser/account/get")) {
      probes++;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    return response({ code: 401 });
  }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
  const first = plugin.stream({ id: "1" }).then((value) => ({ value }), (error) => ({ error }));
  await flush();
  t.mock.timers.tick(10000);
  await flush();
  const firstOutcome = await first;
  assert.equal(firstOutcome.error.code, "unavailable");
  assert.equal(probes, 1);
  assert.equal(storage.get("session").cookies.MUSIC_U, "synthetic-session");
  const second = plugin.stream({ id: "2" }).then((value) => ({ value }), (error) => ({ error }));
  await flush();
  t.mock.timers.tick(10000);
  await flush();
  const secondOutcome = await second;
  assert.equal(secondOutcome.error.code, "unavailable");
  assert.equal(probes, 2);
});

// One caller's budget must not cancel the account check that another caller is
// still waiting for. The check has its own timeout and keeps running.
test("one waiter's budget does not cancel a shared account check", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let probes = 0;
  let source = 0;
  const { plugin } = await setup(async (url, init) => {
    if (url.includes("/api/nuser/account/get")) {
      probes++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(response(ACCOUNT_OK)), 10000);
        init.signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
      });
    }
    source++;
    if (source === 1) {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    if (source === 2) {
      return new Promise((resolve) => {
        setTimeout(() => resolve(response({ code: 401 })), 2000);
      });
    }
    return response({ code: 401 });
  }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
  const a = plugin.stream({ id: "1" }).then((value) => ({ value }), (error) => ({ error }));
  await flush();
  t.mock.timers.tick(12000);
  await flush();
  t.mock.timers.tick(2000);
  await flush();
  t.mock.timers.tick(2000);
  await flush();
  const b = plugin.stream({ id: "2" }).then((value) => ({ value }), (error) => ({ error }));
  await flush();
  t.mock.timers.tick(9000);
  await flush();
  const aOutcome = await a;
  assert.match(aOutcome.error.message, /等待预算/);
  t.mock.timers.tick(1000);
  await flush();
  const bOutcome = await b;
  assert.equal(bOutcome.error.code, "unavailable");
  assert.equal(probes, 1, "the shared check was not restarted or cancelled");
});

test("suggest ignores malformed and unknown groups without breaking valid candidates", async () => {
  const { plugin } = await setup(async () => response({ code: 200, result: {
    order: ["__proto__", "constructor", "songs", "artists"],
    songs: { name: "Invalid list" }, artists: [{ name: "Valid artist" }],
  } }));
  assert.deepEqual(await plugin.suggest({ query: "test" }), ["Valid artist"]);
});

test("empty hot podcast pages stop advancing but keep the previous page", async () => {
  const { plugin } = await setup(async () => response({ code: 200, djRadios: [], hasMore: true }));
  const page = await plugin.browse({ page: "podcasts:hot:30" });
  assert.deepEqual(page.sections[0].shows, []);
  assert.deepEqual(page.sections[1].links.map(link => link.page), ["podcasts:hot:0"]);
});

test("podcast discovery rejects malformed lists and deduplicates valid IDs", async () => {
  let invalid = true;
  const { plugin } = await setup(async () => response({ code: 200, djRadios: invalid
    ? { unexpected: true }
    : [{ id: 11, name: "First" }, { id: 11, name: "Duplicate" }, null] }));
  await assert.rejects(plugin.browse({ page: "podcasts:recommend" }), /无效的播客列表/);
  invalid = false;
  const page = await plugin.browse({ page: "podcasts:recommend" });
  assert.deepEqual(page.sections[0].shows.map(show => show.name), ["First"]);
});

// Personal recommendations require a real session before making their requests.
test("guests can discover entries but private recommendations ask for sign-in", async () => {
  let calls = 0;
  const { plugin } = await setup(async () => { calls++; return response({ code: 200, result: [] }); });
  const home = await plugin.home();
  assert.ok(home.sections.some(section => section.links?.some(link => link.page === "daily")));
  const stations = await plugin.stations();
  assert.equal(stations.length, 3);
  assert.ok(stations.every(station => station.description.includes("个性化服务")));
  for (const page of ["daily", "radar", "recommendations"]) await assert.rejects(plugin.browse({ page }), { code: "signIn" });
  await assert.rejects(plugin.stationNext({ id: "DEFAULT" }), { code: "signIn" });
  assert.equal(calls, 1);
});

// Discovery links keep Home to one request; the podcast pages load only when
// the listener opens them.
test("home links to podcast discovery reuse sized artwork without extra requests", async () => {
  let calls = 0;
  const { plugin } = await setup(async (url) => {
    calls++;
    assert.ok(url.includes("/api/personalized/playlist"));
    return response({ code: 200, result: Array.from({ length: 5 }, (_, id) => ({
      id: id + 1, name: `Discovery ${id}`, picUrl: `http://p2.music.126.net/discovery-${id}.jpg`,
    })) });
  });
  const home = await plugin.home();
  const links = home.sections.flatMap((section) => section.links || []);
  const recentLink = links.find(item => item.page === "recent");
  assert.equal(recentLink.title, "最近播放");
  assert.equal(new URL(recentLink.imageUrl).protocol, "https:");
  assert.equal(new URL(recentLink.imageUrl).searchParams.get("param"), "{size}y{size}");
  for (const [page, index] of [["podcasts:recommend", 3], ["podcasts:hot:0", 4]]) {
    const link = links.find(item => item.page === page);
    assert.ok(link, page);
    const cover = new URL(link.imageUrl);
    assert.equal(cover.protocol, "https:");
    assert.equal(cover.pathname, `/discovery-${index}.jpg`);
    assert.equal(cover.searchParams.get("param"), "{size}y{size}");
  }
  assert.equal(calls, 1);
});

// Recommended and hot podcasts are public pages. The hot list pages by links
// because the host's Browse page has no offset argument of its own.
test("podcast discovery maps shows and pages the hot list with links", async () => {
  const picture = "http://p2.music.126.net/show.jpg";
  const { plugin } = await setup(async (url) => {
    if (url.includes("djradio/recommend/v1")) {
      return response({ code: 200, djRadios: [
        { id: 11, name: "Show 11", picUrl: picture, desc: "About 11", dj: { nickname: "Host" }, programCount: 4, subed: true },
        { id: 13, name: "Show 13", picUrl: picture, rcmdtext: "Why 13" },
        { id: "", name: "No ID" },
        { id: "not-a-number", name: "Bad ID" },
        null,
      ] });
    }
    const params = new URL(url).searchParams;
    assert.equal(params.get("limit"), "30");
    if (params.get("offset") === "30") {
      return response({ code: 200, djRadios: [{ id: 12, name: "Show 12", picUrl: picture }], hasMore: true });
    }
    assert.equal(params.get("offset"), "0");
    return response({ code: 200, djRadios: [], hasMore: false });
  });

  const recommended = await plugin.browse({ page: "podcasts:recommend" });
  assert.deepEqual(recommended.sections[0].shows.map((show) => show.id), ["11", "13"]);
  assert.equal(recommended.sections[0].shows[0].description, "About 11");
  assert.equal(recommended.sections[0].shows[1].description, "Why 13");
  assert.equal(recommended.sections[0].shows[0].publisher, "Host");
  assert.equal(recommended.sections[0].shows[0].episodeCount, 4);
  assert.equal(recommended.sections[0].shows[0].subscribed, true);
  assert.equal(new URL(recommended.sections[0].shows[0].imageUrl).searchParams.get("param"), "{size}y{size}");

  const first = await plugin.browse({ page: "podcasts:hot:0" });
  assert.equal(first.subtitle, "第 1 页");
  assert.equal(first.sections.length, 1);

  const second = await plugin.browse({ page: "podcasts:hot:30" });
  assert.equal(second.subtitle, "第 2 页");
  assert.deepEqual(second.sections[0].shows.map((show) => show.id), ["12"]);
  assert.deepEqual(second.sections[1].links.map((link) => link.page), ["podcasts:hot:0", "podcasts:hot:60"]);
  assert.deepEqual(second.sections[1].links.map((link) => link.title), ["上一页", "下一页"]);
});

// A made-up page must not reach the server with a negative, fractional or
// absurd offset.
test("podcast pagination rejects pages outside its bounded offset", async () => {
  let calls = 0;
  const { plugin } = await setup(async () => { calls++; return response({ code: 200 }); });
  for (const page of ["podcasts:hot:-1", "podcasts:hot:1.5", "podcasts:hot:abc", "podcasts:hot:10001", "podcasts:hot:99999999999999999999"]) {
    await assert.rejects(plugin.browse({ page }), { code: "unsupported" });
  }
  assert.equal(calls, 0);
});

// Discovery is optional, but an expired login must still reach the host's
// sign-in flow instead of being hidden behind an empty section.
test("podcast discovery keeps a sign-in failure", async () => {
  const { plugin } = await setup(async () => response({ code: 301 }));
  await assert.rejects(plugin.browse({ page: "podcasts:recommend" }), { code: "signIn" });
});

// Daily songs and each FM mode use their own endpoint and account-aware details.
test("daily, radar, personalized playlists and continuous FM map to host capabilities", async () => {
  const modes = [];
  const { plugin } = await setup(async (url, init) => {
    if (url.includes("account/get")) return response({ code: 200, profile: { userId: 8, nickname: "Fixture" } });
    if (url.includes("playlist/detail")) {
      assert.equal(new URL(url).searchParams.get("id"), "3136952023");
      assert.match(init.headers.Cookie, /MUSIC_U=synthetic-session/);
      return response({ code: 200, playlist: { id: 3136952023, name: "Fixture Radar", trackCount: 2, trackIds: [{ id: 2 }, { id: 1 }] } });
    }
    if (url.includes("recommend/songs")) return response({ code: 200, data: { dailySongs: [song(2), song(1)] } });
    if (url.includes("recommend/resource")) return response({ code: 200, recommend: [{ id: 9, name: "Fixture Radar", trackCount: 2 }] });
    const { path, data } = decode(init.body);
    assert.equal(data.header.MUSIC_U, "synthetic-session");
    if (path === "/api/v1/radio/get") {
      modes.push(data.mode);
      assert.equal(data.limit, 3);
      return response({ code: 200, data: [song(2), song(1)] });
    }
    assert.equal(path, "/api/v3/song/detail");
    return response({ code: 200, songs: [song(1), song(2)], privileges: [{ id: 1, st: 0, pl: 320000 }, { id: 2, st: 0, pl: 320000 }] });
  }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
  const daily = await plugin.browse({ page: "daily" });
  assert.deepEqual(daily.sections[0].tracks.map(track => track.id), ["2", "1"]);
  assert.ok(daily.sections[0].tracks.every(track => !track.unavailable));
  const radar = await plugin.browse({ page: "radar" });
  assert.deepEqual(radar.sections[0].tracks.map(track => track.id), ["2", "1"]);
  const lists = await plugin.browse({ page: "recommendations" });
  assert.equal(lists.sections[0].playlists[0].id, "9");
  for (const id of ["DEFAULT", "FAMILIAR", "EXPLORE", "DEFAULT"]) {
    assert.deepEqual((await plugin.stationNext({ id })).map(track => track.id), ["2", "1"]);
  }
  assert.deepEqual(modes, ["DEFAULT", "FAMILIAR", "EXPLORE", "DEFAULT"]);
  await assert.rejects(plugin.stationNext({ id: "unknown" }), { code: "unsupported" });
});

test("disabled personalization explains an empty radio batch and permits recovery", async () => {
  for (const mode of ["DEFAULT", "FAMILIAR", "EXPLORE"]) {
    let radioCalls = 0;
    let detailCalls = 0;
    let settingsCalls = 0;
    const { plugin } = await setup(async (url, init) => {
      if (url.includes("account/get")) return response({ code: 200, profile: { userId: 8, nickname: "Fixture" } });
      if (url.includes("/user/setting")) {
        settingsCalls++;
        assert.match(init.headers.Cookie, /MUSIC_U=synthetic-session/);
        return response({ code: 200, setting: { personalServiceSetting: 2 } });
      }
      const { path, data } = decode(init.body);
      if (path === "/api/v1/radio/get") {
        assert.equal(data.mode, mode);
        radioCalls++;
        return response({ code: 200, data: radioCalls === 1 ? [] : [song(1)] });
      }
      assert.equal(path, "/api/v3/song/detail");
      detailCalls++;
      return response({ code: 200, songs: [song(1)], privileges: [{ id: 1, st: 0, pl: 320000 }] });
    }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });

    await assert.rejects(plugin.stationNext({ id: mode }), error => {
      assert.equal(error.code, "unavailable");
      assert.match(error.message, /个性化服务/);
      return true;
    });
    assert.equal(radioCalls, 1);
    assert.equal(detailCalls, 0);
    assert.equal(settingsCalls, 1);
    assert.notEqual(await plugin.account(), null);
    assert.deepEqual((await plugin.stationNext({ id: mode })).map(track => track.id), ["1"]);
    assert.equal(radioCalls, 2);
    assert.equal(detailCalls, 1);
    assert.equal(settingsCalls, 1);
  }
});

test("other empty radio batches remain retryable when the setting is enabled or unknown", async () => {
  for (const preferences of [
    { code: 200, setting: { personalServiceSetting: 0 } },
    { code: 200, setting: {} },
    { code: 500 },
  ]) {
    const { plugin } = await setup(async (url, init) => {
      if (url.includes("account/get")) return response({ code: 200, profile: { userId: 8, nickname: "Fixture" } });
      if (url.includes("/user/setting")) return response(preferences);
      assert.equal(decode(init.body).path, "/api/v1/radio/get");
      return response({ code: 200, data: [] });
    }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
    assert.deepEqual(await plugin.stationNext({ id: "DEFAULT" }), []);
    assert.notEqual(await plugin.account(), null);
  }
});

test("radio and diagnostic authentication failures keep their sign-in error", async () => {
  for (const failingEndpoint of ["radio", "settings"]) {
    const { plugin } = await setup(async (url, init) => {
      if (url.includes("account/get")) return response({ code: 200, profile: { userId: 8, nickname: "Fixture" } });
      if (url.includes("/user/setting")) return response({ code: 301 });
      assert.equal(decode(init.body).path, "/api/v1/radio/get");
      return response(failingEndpoint === "radio" ? { code: 301 } : { code: 200, data: [] });
    }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });

    await assert.rejects(plugin.stationNext({ id: "DEFAULT" }), { code: "signIn" });
    assert.equal(await plugin.account(), null);
  }
});

// The host must recognize NetEase's built-in liked playlist without losing ownership.
test("fixed playlist mapping preserves ownership across lists and detail", async () => {
  const fixtures = [
    { id: 21, specialType: 5, creator: { userId: 7 }, expectedFixed: true, expectedMine: true },
    { id: 22, specialType: "5", creator: { userId: 8 }, subscribed: true, expectedFixed: true, expectedMine: false },
    { id: 23, specialType: 0, creator: { userId: 7 }, expectedFixed: false, expectedMine: true },
    { id: 24, creator: { userId: 8 }, subscribed: true, expectedFixed: false, expectedMine: false },
  ];
  const { plugin } = await setup(async (url) => {
    if (url.includes("nuser/account/get")) return response({ code: 200, profile: { userId: 7, nickname: "Fixture" } });
    if (url.includes("user/playlist")) return response({ code: 200, playlist: fixtures, more: false });
    if (url.includes("playlist/detail")) {
      const id = Number(new URL(url).searchParams.get("id"));
      return response({ code: 200, playlist: { ...fixtures.find(p => p.id === id), trackIds: [] } });
    }
    throw new Error(`Unexpected request: ${url}`);
  }, { cookies: { MUSIC_U: "synthetic-session" }, profile: { id: "7", name: "Fixture" } });
  const lists = await plugin.playlists();
  assert.equal(lists.length, fixtures.length);
  for (const [i, source] of fixtures.entries()) {
    for (const mapped of [lists[i], await plugin.playlist({ id: String(source.id) })]) {
      assert.equal(mapped.fixed, source.expectedFixed, `fixed for ${source.id}`);
      assert.equal(mapped.mine, source.expectedMine, `mine for ${source.id}`);
      assert.equal(mapped.saved, !!source.subscribed, `saved for ${source.id}`);
    }
  }
});

// A play costs no request: the host's callback gives the ID, and the history
// is only a reading list. Episodes stay out so a later play cannot find the
// wrong audio behind a song ID.
test("played records song history locally without asking NetEase", async () => {
  let calls = 0;
  const { plugin, storage } = await setup(async () => { calls++; return response({ code: 200 }); },
    { cookies: { MUSIC_U: "synthetic-session" }, profile: { id: "7", name: "Fixture" } });
  plugin.played({ id: "1" });
  plugin.played({ id: "program:2:3" });
  plugin.played({ id: "not-a-song" });
  plugin.played({ id: 2 });
  plugin.played({ id: "1" });
  assert.equal(calls, 0);
  assert.deepEqual(storage.get("recent:7").map((entry) => entry.id), ["1", "2"]);
  assert.ok(storage.get("recent:7").every((entry) => Number.isFinite(entry.at) && entry.at > 0));
});

// The host calls played once per track, so repeats must not grow the list and
// an evening of listening must not grow storage without bound.
test("play history keeps the newest hundred songs and moves repeats to the front", async () => {
  const { plugin, storage } = await setup(async () => response({ code: 200 }));
  for (let i = 1; i <= 105; i++) plugin.played({ id: String(i) });
  plugin.played({ id: "50" });
  const entries = storage.get("recent:guest");
  assert.equal(entries.length, 100);
  assert.deepEqual(entries.slice(0, 2).map((entry) => entry.id), ["50", "105"]);
  assert.equal(new Set(entries.map((entry) => entry.id)).size, 100);
  assert.equal(entries.at(-1).id, "6");
});

// One machine, two accounts: the second must never see the first one's songs,
// and a session without a profile must not guess whose plays they are.
test("history stays with one account across sign-out and guest listening", async () => {
  let calls = 0;
  const { plugin, storage } = await setup(async (url) => {
    if (url.includes("play-record")) throw new Error(`unexpected cloud request: ${url}`);
    calls++;
    return response({ code: 200, songs: [song(2)], privileges: [{ id: 2, st: 0, pl: 320000 }] });
  }, { cookies: { MUSIC_U: "synthetic-session" }, profile: { id: "7", name: "Fixture" } });
  plugin.played({ id: "1" });
  plugin.signOut();
  plugin.played({ id: "2" });
  assert.deepEqual(storage.get("recent:7").map((entry) => entry.id), ["1"]);
  assert.deepEqual(storage.get("recent:guest").map((entry) => entry.id), ["2"]);
  assert.deepEqual((await plugin.recent()).map((track) => track.id), ["2"]);
  assert.equal(calls, 1);
});

// Local plays are newest, the service's list is its own order: merge them once
// and let one detail request give every row the account's privileges.
test("recent merges local plays with the service list and fills cloud privileges", async () => {
  const requests = [];
  const { plugin, storage } = await setup(async (url, init) => {
    const { path, data } = decode(init.body);
    requests.push(path);
    if (path === "/api/play-record/song/list") {
      assert.equal(data.limit, 100);
      assert.equal(data.header.MUSIC_U, "synthetic-session");
      return response({ code: 200, data: { list: [{ data: song(2) }, { data: song(3) }, { data: null }] } });
    }
    assert.equal(path, "/api/v3/song/detail");
    assert.deepEqual(JSON.parse(data.c), [{ id: 1 }, { id: 4 }, { id: 2 }, { id: 3 }]);
    return response({ code: 200, songs: [song(2), song(1), song(3)], privileges: [
      { id: 1, st: 0, pl: 320000 }, { id: 2, st: -1, pl: 0 }, { id: 3, st: 0, pl: 320000 },
    ] });
  }, { cookies: { MUSIC_U: "synthetic-session" }, profile: { id: "7", name: "Fixture" } });
  storage.set("recent:7", [{ id: "1", at: 3 }, { id: "4", at: 2 }, { id: "1", at: 1 }, { id: "bad", at: 0 }]);
  const tracks = await plugin.recent();
  assert.deepEqual(requests, ["/api/play-record/song/list", "/api/v3/song/detail"]);
  assert.deepEqual(tracks.map((track) => track.id), ["1", "2", "3"]);
  assert.deepEqual(tracks.map((track) => track.unavailable), [false, true, false]);
});

// Nothing to show means nothing to ask for, with no session and no local plays.
test("recent asks nothing until there is a history or a service list", async () => {
  let calls = 0;
  const { plugin } = await setup(async () => { calls++; return response({ code: 200 }); });
  assert.deepEqual(await plugin.recent(), []);
  assert.equal(calls, 0);
});

// A cloud failure must not hide what this machine played; the page says so
// instead of looking empty.
test("recent keeps local plays when the service list fails and the page says so", async () => {
  const { plugin, storage } = await setup(async (url) => {
    if (url.includes("play-record")) return response({ code: 500 });
    return response({ code: 200, songs: [song(1)], privileges: [{ id: 1, st: 0, pl: 320000 }] });
  }, { cookies: { MUSIC_U: "synthetic-session" }, profile: { id: "7", name: "Fixture" } });
  storage.set("recent:7", [{ id: "1", at: 2 }]);
  const page = await plugin.browse({ page: "recent" });
  assert.equal(page.title, "最近播放");
  assert.match(page.subtitle, /云端播放记录暂时无法加载/);
  assert.deepEqual(page.sections[0].tracks.map((track) => track.id), ["1"]);
  assert.ok(page.sections[0].empty.includes("还没有播放记录"));
});

// A sign-out mid-flight makes the response belong to the previous account.
test("a sign-out during the service list rejects its stale history", async () => {
  let finish;
  const { plugin, storage } = await setup((url) => {
    if (url.includes("play-record")) return new Promise((resolve) => { finish = resolve; });
    throw new Error(`unexpected request: ${url}`);
  }, { cookies: { MUSIC_U: "synthetic-session" }, profile: { id: "7", name: "Fixture" } });
  storage.set("recent:7", [{ id: "1", at: 2 }]);
  const pending = plugin.recent();
  plugin.signOut();
  finish(response({ code: 200, data: { list: [{ data: song(1) }] } }));
  await assert.rejects(pending, /账号状态已改变/);
});

// An expired login on the history page must reach the host's sign-in prompt.
test("an expired login keeps its sign-in prompt on the recent page", async () => {
  const { plugin } = await setup(async (url) => url.includes("play-record")
    ? response({ code: 301 })
    : response({ code: 200 }),
  { cookies: { MUSIC_U: "synthetic-session" }, profile: { id: "7", name: "Fixture" } });
  await assert.rejects(plugin.recent(), { code: "signIn" });
});

// Prefetching the next song is not playing it: only the host's played
// callback may write history.
test("fetching a source leaves the play history alone", async () => {
  const { plugin, storage } = await setup(async () => response({ code: 200, data: [
    { id: 1, url: "https://m1.music.126.net/song.mp3", type: "mp3", level: "exhigh", size: 10, br: 320000 },
  ] }), { cookies: { MUSIC_U: "synthetic-session" }, profile: { id: "7", name: "Fixture" } });
  await plugin.stream({ id: "1" });
  assert.equal(storage.has("recent:7"), false);
});

// The page needs a visible entry, not only the export the host may not use.
test("the sidebar has a visible recent page", async () => {
  const manifest = JSON.parse(await readFile(new URL("./plugin.json", import.meta.url), "utf8"));
  const entry = manifest.navigation.find((item) => item.page === "recent");
  assert.ok(entry);
  assert.equal(entry.title, "最近播放");
});

// QR confirmation replaces the session object without changing its generation.
// A history read begun during the scan must still be rejected after confirmation.
test("recent rejects old details after QR confirmation in the same generation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10000 });
  let finish;
  const { plugin, storage } = await setup(async (url) => {
    if (url.includes("/qrcode/unikey")) return response({ code: 200, unikey: "fixture-key" });
    if (url.includes("/qrcode/client/login")) return response({ code: 803 }, ["MUSIC_U=synthetic-next; Path=/"]);
    if (url.includes("/nuser/account/get")) return response({ code: 200, profile: { userId: 8, nickname: "Fixture" } });
    if (url.includes("/play-record/song/list")) return response({ code: 200, data: { list: [{ data: song(1) }] } });
    if (url.includes("/v3/song/detail")) return new Promise(resolve => { finish = resolve; });
    throw new Error("Unexpected fixture request");
  }, { cookies: { MUSIC_U: "synthetic-old" }, profile: { id: "7" } });
  const login = plugin.signIn(); await flush();
  const pending = plugin.recent(); await flush();
  assert.equal(typeof finish, "function");
  t.mock.timers.tick(1500); await flush(); await login;
  finish(response({ code: 200, songs: [song(1)], privileges: [{ id: 1, st: 0, pl: 320000 }] }));
  await assert.rejects(pending, /账号状态已改变/);
  plugin.played({ id: "2" });
  assert.deepEqual(storage.get("recent:8").map(item => item.id), ["2"]);
  assert.equal(storage.has("recent:7"), false);
});

test("merged recent history stays at one hundred with overlapping and oversized service rows", async () => {
  const { plugin } = await setup(async (_url, init) => {
    const { path, data } = decode(init.body);
    if (path === "/api/play-record/song/list") {
      assert.equal(data.limit, 100);
      return response({ code: 200, data: { list: Array.from({ length: 150 }, (_, i) => ({ data: song(i + 26) })) } });
    }
    assert.equal(path, "/api/v3/song/detail");
    const ids = JSON.parse(data.c).map(item => item.id);
    assert.equal(ids.length, 100);
    return response({ code: 200, songs: ids.map(song), privileges: ids.map(id => ({ id, st: 0, pl: 320000 })) });
  }, { cookies: { MUSIC_U: "synthetic-session" }, profile: { id: "7" } });
  for (let i = 1; i <= 50; i++) plugin.played({ id: String(i) });
  const tracks = await plugin.recent();
  assert.equal(tracks.length, 100);
  assert.equal(new Set(tracks.map(item => item.id)).size, 100);
  assert.equal(tracks[0].id, "50");
  assert.equal(tracks[49].id, "1");
  assert.equal(tracks.at(-1).id, "100");
});
