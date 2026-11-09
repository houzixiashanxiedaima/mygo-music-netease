import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash } from "node:crypto";

let sequence = 0;
const response = (body, cookies = []) => ({
  ok: true, status: 200, json: async () => body, headers: { getSetCookie: () => cookies },
});

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
    if (ms === 1000) { wake = fn; scheduled(); return 0; }
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
// signing out loses their library over one song the account may not open.
test("stream keeps the session when a content 401 comes back", async () => {
  const { plugin, storage } = await setup(async (_url, init) => {
    if (init.headers.Cookie !== undefined && !init.headers.Cookie.includes("MUSIC_U=synthetic-session")) {
      throw new Error("session was lost");
    }
    return response({ code: 401 });
  }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
  await assert.rejects(plugin.stream({ id: "1" }), { code: "unavailable" });
  assert.equal(storage.get("session").cookies.MUSIC_U, "synthetic-session");
  await assert.rejects(plugin.stream({ id: "2" }), { code: "unavailable" });
});

// Diagnostics are kept for reading later, so they are bounded and hold nothing
// that could identify the listener or the audio.
test("stream diagnostics stay bounded and leave out URLs and cookies", async () => {
  const { plugin, storage } = await setup(async () => response({ code: 200, data: [
    { id: 1, code: 200, url: "https://m1.music.126.net/song.mp3?token=audio%2Ftoken&expires=123", type: "mp3", level: "exhigh" },
  ] }), { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
  for (let i = 0; i < 25; i++) await plugin.stream({ id: "1" });
  const log = storage.get("streamLog");
  assert.equal(log.length, 20);
  const saved = JSON.stringify(log);
  assert.ok(!saved.includes("audio%2Ftoken&expires=123"), saved);
  assert.ok(!saved.includes("synthetic-session"), saved);
  assert.ok(!saved.includes("https://"), saved);
  assert.deepEqual(Object.keys(log[0]).sort(), ["actual", "at", "code", "hasURL", "level", "outcome", "song", "trial"]);
  assert.deepEqual([log[0].song, log[0].level, log[0].code, log[0].hasURL, log[0].trial, log[0].actual],
    ["1", "exhigh", 200, true, false, "exhigh"]);
});

// NetEase's immersive levels have no host name of their own. A lossless file
// kept as "high" is downloaded again on every lossless play; a lossy file kept
// as "lossless" would be served to lossless requests instead.
test("stream reports the quality the response proves", async () => {
  for (const [level, type, quality] of [
    ["jymaster", "flac", "lossless"], ["sky", "flac", "lossless"], ["jymaster", "mp3", "high"],
    [undefined, "flac", "lossless"], [undefined, "mp3", "high"], ["hires", "flac", "lossless"],
  ]) {
    const { plugin } = await setup(async () => response({ code: 200, data: [
      { id: 1, code: 200, url: "https://m1.music.126.net/song", type, level },
    ] }));
    assert.equal((await plugin.stream({ id: "1", quality: "lossless" })).quality, quality, `${level} ${type}`);
  }
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
