/**
 * POC: copy ONE video from the legacy Bunny Stream library (157244) into the
 * Model C library (666592). Proves the migration path before doing all videos.
 *
 *   create video in 666592  ->  fetch the legacy original  ->  poll encoding
 *
 * The legacy library's CDN is referrer-gated, so the fetch carries a Referer
 * header. The new library mints a NEW guid — printed at the end (map entry).
 *
 * Run:  pnpm exec tsx scripts/copy-bunny-video.ts [sourceGuid]
 * Requires BUNNY_ACCOUNT_API_KEY in .env.
 */
import 'dotenv/config';

const ACCOUNT_KEY = process.env.BUNNY_ACCOUNT_API_KEY ?? '';
const REFERER = process.env.BUNNY_REFERER || 'https://brainboost.id';

const SRC_LIBRARY_ID = 157244;
const SRC_CDN = 'vz-5439ef3e-878.b-cdn.net';
const DST_LIBRARY_ID = 666592;

// Default: the 40-second "Preview BB Turunkan Kolesterol" — small, fast to encode.
const SRC_GUID = process.argv[2] ?? '0a1c8ed3-011d-4fd4-bdca-888b6bb7a6a1';

const API = 'https://video.bunnycdn.com';

async function getLibraryApiKey(libraryId: number): Promise<string> {
  const r = await fetch(`https://api.bunny.net/videolibrary/${libraryId}`, {
    headers: { AccessKey: ACCOUNT_KEY, accept: 'application/json' },
  });
  if (r.status !== 200) throw new Error(`videolibrary/${libraryId} -> HTTP ${r.status}`);
  const lib = (await r.json()) as { ApiKey?: string };
  if (!lib.ApiKey) throw new Error(`no ApiKey on library ${libraryId}`);
  return lib.ApiKey;
}

async function main(): Promise<void> {
  if (!ACCOUNT_KEY) {
    console.error('BUNNY_ACCOUNT_API_KEY must be set in .env.');
    process.exit(1);
  }
  console.log(`source: library ${SRC_LIBRARY_ID} video ${SRC_GUID}`);

  // 1. Management keys for both libraries (via the account API).
  const srcKey = await getLibraryApiKey(SRC_LIBRARY_ID);
  const dstKey = await getLibraryApiKey(DST_LIBRARY_ID);

  // 2. Read the source video's title.
  const srcR = await fetch(`${API}/library/${SRC_LIBRARY_ID}/videos/${SRC_GUID}`, {
    headers: { AccessKey: srcKey, accept: 'application/json' },
  });
  if (srcR.status !== 200) throw new Error(`source video lookup -> HTTP ${srcR.status}`);
  const src = (await srcR.json()) as { title?: string };
  const title = src.title ?? `migrated-${SRC_GUID}`;
  console.log(`title: ${title}`);

  // 3. Create the destination video (returns the new guid).
  const createR = await fetch(`${API}/library/${DST_LIBRARY_ID}/videos`, {
    method: 'POST',
    headers: { AccessKey: dstKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (createR.status !== 200) throw new Error(`create video -> HTTP ${createR.status} ${await createR.text()}`);
  const created = (await createR.json()) as { guid: string };
  const newGuid = created.guid;
  console.log(`created in ${DST_LIBRARY_ID}: new guid ${newGuid}`);

  // 4. Fetch the legacy 720p rendition into the new video. `/original` is
  //    blocked (ExposeOriginals=false); the MP4 fallback rendition is exposed.
  //    The Referer header clears the legacy pull zone's referrer gate.
  const sourceUrl = `https://${SRC_CDN}/${SRC_GUID}/play_720p.mp4`;
  const fetchR = await fetch(`${API}/library/${DST_LIBRARY_ID}/videos/${newGuid}/fetch`, {
    method: 'POST',
    headers: { AccessKey: dstKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ url: sourceUrl, headers: { Referer: REFERER } }),
  });
  console.log(`fetch kicked off -> HTTP ${fetchR.status} ${(await fetchR.text()).slice(0, 160)}`);

  async function deleteNew(): Promise<void> {
    await fetch(`${API}/library/${DST_LIBRARY_ID}/videos/${newGuid}`, {
      method: 'DELETE',
      headers: { AccessKey: dstKey, accept: 'application/json' },
    });
    console.log(`cleaned up failed video ${newGuid}`);
  }

  if (fetchR.status !== 200) {
    await deleteNew();
    throw new Error('fetch request failed');
  }

  // 5. Poll encoding (status 4 = finished, 5/6 = failed).
  for (let i = 0; i < 40; i += 1) {
    await new Promise((res) => setTimeout(res, 6000));
    const vR = await fetch(`${API}/library/${DST_LIBRARY_ID}/videos/${newGuid}`, {
      headers: { AccessKey: dstKey, accept: 'application/json' },
    });
    if (vR.status !== 200) continue;
    const v = (await vR.json()) as { status?: number; encodeProgress?: number };
    console.log(`  status=${v.status} encodeProgress=${v.encodeProgress}`);
    if (v.status === 4) {
      console.log(`\nDONE.  ${SRC_GUID}  ->  ${newGuid}`);
      return;
    }
    if (v.status === 5 || v.status === 6) {
      await deleteNew();
      console.log(`\nFAILED. encode status ${v.status}`);
      return;
    }
  }
  console.log(`\nstill encoding after timeout — new guid ${newGuid}, check later.`);
}

void main().catch((err) => {
  console.error('ERROR:', (err as Error).message);
  process.exit(1);
});
