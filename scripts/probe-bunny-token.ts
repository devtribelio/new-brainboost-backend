/**
 * Probe: confirm the Model C library config + verify a signed HLS URL works.
 *
 * Run: pnpm exec tsx scripts/probe-bunny-token.ts
 * Requires BUNNY_ACCOUNT_API_KEY + BUNNY_STREAM_TOKEN_KEY in .env.
 *
 *   signed HLS 200 -> Model C ready.
 *   403 with AllowDirectPlay=false -> enable Direct Play on the library.
 */
import 'dotenv/config';
import { signBunnyUrl } from '../src/modules/media/bunny-sign.util';

const ACCOUNT_KEY = process.env.BUNNY_ACCOUNT_API_KEY ?? '';
const TOKEN_KEY = process.env.BUNNY_STREAM_TOKEN_KEY ?? '';
const LIBRARY_ID = 666592;
const CDN = 'vz-f594ac4d-255.b-cdn.net';
const GUID = process.argv[2] ?? '7fa0efa5-6132-48af-b605-32f87049ca9b';

async function main(): Promise<void> {
  if (!TOKEN_KEY) {
    console.error('BUNNY_STREAM_TOKEN_KEY must be set in .env.');
    process.exit(1);
  }

  if (ACCOUNT_KEY) {
    const r = await fetch(`https://api.bunny.net/videolibrary/${LIBRARY_ID}`, {
      headers: { AccessKey: ACCOUNT_KEY, accept: 'application/json' },
    });
    if (r.status === 200) {
      const lib = (await r.json()) as Record<string, unknown>;
      console.log(`library config: AllowDirectPlay=${lib.AllowDirectPlay}  BlockNoneReferrer=${lib.BlockNoneReferrer}`);
    } else {
      console.log(`library config fetch -> HTTP ${r.status}`);
    }
  }

  const signed = signBunnyUrl(`https://${CDN}/${GUID}/playlist.m3u8`, TOKEN_KEY, {
    expirationSeconds: 3600,
    isDirectory: true,
    pathAllowed: `/${GUID}/`,
  });
  const r = await fetch(signed, { redirect: 'manual' });
  console.log(`signed HLS request  ->  HTTP ${r.status}${r.status === 200 ? '  OK — Model C verified' : ''}`);
  if (r.status !== 200) {
    console.log('  body:', (await r.text()).slice(0, 140).replace(/\s+/g, ' '));
  }
}

void main();
