# Third-party notices

This plugin is licensed under AGPL-3.0-only. The complete license is in `LICENSE`.

The NetEase API protocol and data mappings are adapted from:

- Repository: https://github.com/sogud/mygo-cloudmusic
- Original project: https://github.com/egoist/mygo-cloudmusic
- Upstream author: egoist and contributors; preserved fork: sogud.
- Reference commit: `b13f52a2a2ff0746502b85b9c4c7fa1e86a1c385`.
- Files consulted: `internal/netease/eapi.go`, `auth.go`, `netease.go`, `catalog.go`, `podcast.go`, `search_suggest.go`, `subscriptions.go`.
- Upstream license: GNU Affero General Public License version 3.

Modifications made on 2026-11-06: ported Go requests to MyGo Music's JavaScript
plugin API; replaced the HTTP cookie jar and keychain integration with explicit
cookie handling and the host's private storage; added host data conversion,
quality mapping, bounded playlist loading, session invalidation, domain
validation, and tests. No Go code or upstream binaries are included in the plugin.

Host API reference: https://github.com/egoist/mygo-music at
`1af0d8efd77fdf630c27cfc635f12e9cb089ce10` (MyGo Music 0.1.22), especially its
README, `examples/demo-plugin`, `internal/music/music.go`, `internal/plugin`,
`internal/app/ui_browse.go`, and `internal/app/ui_suggest.go`.
The host itself is licensed under AGPL-3.0 and is distributed separately.

NetEase Cloud Music names and content belong to their respective owners. This
project is not an official NetEase or MyGo Music release. The license covers
this plugin's source, not music content or service access rights.

Recommendation endpoint shapes and FM modes were also checked against
AkinoKaede/mygo-music-netease-cloud-music, commit
`c988df7f4d787c1a133ba66e1f4f9dd71a2650cf` (`index.js`, AGPL-3.0),
and the public playlist metadata returned by NetEase for private radar.

Modifications made on 2026-11-07: added read-only comment pages, subscribed
podcasts and episode browsing, and kept program identity separate from its
audio ID for playback and comments; retained server cookie updates on
transient playback refusals for the existing bounded retry.

Playlist track editing is adapted from jieye666's contribution in
https://github.com/sogud/mygo-music-netease/pull/6, commit
`29c6cffd6990d527a3d9e46757824dc0f6903881` (AGPL-3.0-only), with
current-session checks, podcast ID rejection, and conservative duplicate retry.

Modifications made on 2026-11-10: added ranked search suggestions from
`/api/search/suggest/web`, and public recommended and hot podcast discovery
pages. The hot list encodes its offset in the host's Browse page name and pages
with links, because the host has no offset argument for Browse. Invalid or
missing external show IDs are omitted instead of being passed to the host.

The unexposed heart-mode candidate is adapted from `HeartMode` in
`internal/netease/radio.go` at the same preserved upstream commit. Its request
uses NetEase's intelligence endpoint; live continuation and account validation
remain pending, so the candidate is not listed in the plugin's navigation.


Recent-play history endpoint and callback behavior were checked against
AkinoKaede/mygo-music-netease-cloud-music, commit
`15e722d90d6d0921cab8f8153e27596130f099e1`, `src/recent.ts`
(SPDX-FileCopyrightText: 2026 Kaede Akino; AGPL-3.0-or-later).
The implementation here records only song IDs and timestamps when the host
calls `played`, merges up to 100 local and remote songs, and batches details
for current privileges. It does not upload listening events to NetEase.
The host's `internal/player/player.go` and `internal/plugin/source.go` at the
MyGo Music revision above define when `played` is called and the `recent`
return contract. The custom discovery page and sidebar both expose this list.
