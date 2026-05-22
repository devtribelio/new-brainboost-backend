import { describe, it, expect } from 'vitest';
import type { Product } from '@prisma/client';
import { serializeCourseDetailLegacy } from '@/modules/product/product.serializer';
import { verifyMediaToken } from '@/modules/media/media-token.util';

/**
 * The product `course/detail` response must never leak Bunny identifiers
 * (`guid`, `videoLibraryId`, `library_id`, or the raw iframe HTML). It instead
 * carries an opaque `streamUrl` that points at the media proxy.
 */

const COURSE_UUID = '01890000-0000-7000-8000-000000000001';
const AUDIO_GUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const VIDEO_GUID = '11111111-2222-3333-4444-555555555555';

/** Deep-scan an arbitrary JSON value for any string key/value containing `needle`. */
function deepIncludes(value: unknown, needle: string): boolean {
  if (value == null) return false;
  if (typeof value === 'string') return value.toLowerCase().includes(needle.toLowerCase());
  if (Array.isArray(value)) return value.some((v) => deepIncludes(v, needle));
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(
      ([k, v]) => k.toLowerCase().includes(needle.toLowerCase()) || deepIncludes(v, needle),
    );
  }
  return false;
}

/** Collect every value held under any `streamUrl` key, anywhere in the tree. */
function collectStreamUrls(value: unknown, acc: string[] = []): string[] {
  if (value == null) return acc;
  if (Array.isArray(value)) {
    value.forEach((v) => collectStreamUrls(v, acc));
    return acc;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'streamUrl' && typeof v === 'string') acc.push(v);
      else collectStreamUrls(v, acc);
    }
  }
  return acc;
}

function tokenFromStreamUrl(url: string): string {
  const m = /[?&]t=([^&]+)/.exec(url);
  if (!m) throw new Error(`no token in streamUrl: ${url}`);
  return decodeURIComponent(m[1]);
}

const audioSlide = {
  id: 'slide-audio-1',
  type: 'AudioTemplate',
  name: 'Intro Audio',
  duration: 120,
  data: {
    title: 'Welcome',
    description: 'An intro track',
    platform: 'bunnynet',
    audio: {
      guid: AUDIO_GUID,
      videoLibraryId: 157244,
      directPlayUrl: `https://iframe.mediadelivery.net/play/157244/${AUDIO_GUID}`,
      collectionId: 'col-123',
      originalHash: 'deadbeef',
      storageSize: 9999,
      thumbnailFileName: 'thumb.jpg',
      dateUploaded: '2026-01-01',
      encodeProgress: 100,
      availableResolutions: '480p,720p',
      duration: 120,
    },
  },
};

const videoSlide = {
  id: 'slide-video-1',
  type: 'VideoTemplate',
  name: 'Lesson Video',
  duration: 600,
  data: {
    title: 'Chapter 1',
    description: 'The first chapter',
    platform: 'bunnynet',
    url: `<div style="position:relative"><iframe src="https://iframe.mediadelivery.net/embed/157244/${VIDEO_GUID}?autoplay=true&loop=false" loading="lazy"></iframe></div>`,
  },
};

const textSlide = {
  id: 'slide-text-1',
  type: 'TextTemplate',
  name: 'Notes',
  duration: 0,
  data: { title: 'Notes', description: 'plain text', body: 'some content' },
};

const youtubeSlide = {
  id: 'slide-video-yt',
  type: 'VideoTemplate',
  name: 'External Video',
  duration: 300,
  data: {
    title: 'Bonus',
    platform: 'youtube',
    url: '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>',
  },
};

function buildProduct(): Parameters<typeof serializeCourseDetailLegacy>[0] {
  const base = {
    id: '01890000-0000-7000-8000-0000000000aa',
    legacyId: 42,
    type: 'course',
    title: 'Test Course',
    description: 'desc',
    descriptionHtml: '<p>desc</p>',
    sellingPoints: [],
    thumbnail: null,
    code: 'test-course',
    slug: 'test-course',
    marketingLink: null,
    price: 100_000,
    status: 'active',
    updatedAt: new Date(),
  } as unknown as Product;

  return {
    ...base,
    course: {
      id: COURSE_UUID,
      legacyCourseId: 7,
      sections: [
        {
          name: 'Section 1',
          order: 1,
          legacySectionId: 1,
          lessons: [
            {
              name: 'Lesson A (preview)',
              description: null,
              order: 1,
              legacyLessonId: 100,
              code: 'lsn-a',
              slug: 'lesson-a',
              lessonStatus: 'PUBLISH',
              isPreview: true,
              duration: 720,
              slidesData: [audioSlide, textSlide],
            },
            {
              name: 'Lesson B',
              description: null,
              order: 2,
              legacyLessonId: 101,
              code: 'lsn-b',
              slug: 'lesson-b',
              lessonStatus: 'PUBLISH',
              isPreview: false,
              duration: 900,
              slidesData: [videoSlide, youtubeSlide],
            },
          ],
        },
      ],
    },
  } as Parameters<typeof serializeCourseDetailLegacy>[0];
}

const reviewAggregate = { avg: 0, total: 0, distribution: {} };

describe('serializeCourseDetailLegacy — Bunny identifier scrubbing', () => {
  it('emits no guid / videoLibraryId / library_id / iframe HTML anywhere in the response', () => {
    const out = serializeCourseDetailLegacy(buildProduct(), reviewAggregate);

    expect(deepIncludes(out, 'guid')).toBe(false);
    expect(deepIncludes(out, 'videolibraryid')).toBe(false);
    expect(deepIncludes(out, 'library_id')).toBe(false);
    expect(deepIncludes(out, AUDIO_GUID)).toBe(false);
    expect(deepIncludes(out, VIDEO_GUID)).toBe(false);
    expect(deepIncludes(out, 'mediadelivery.net')).toBe(false);
    expect(deepIncludes(out, 'directplayurl')).toBe(false);
    expect(deepIncludes(out, 'collectionid')).toBe(false);
    expect(deepIncludes(out, 'originalhash')).toBe(false);
  });

  it('replaces the audio slide Bunny object with a streamUrl, keeping title/description/platform', () => {
    const out = serializeCourseDetailLegacy(buildProduct(), reviewAggregate) as Record<
      string,
      unknown
    >;
    const lessonsData = out.lessonsData as Array<Record<string, unknown>>;
    const lessonA = (lessonsData[0].courseLessonData as Array<Record<string, unknown>>)[0];
    const slides = lessonA.slidesData as Array<Record<string, unknown>>;
    const audio = slides[0];

    expect(audio.type).toBe('AudioTemplate');
    const data = audio.data as Record<string, unknown>;
    expect(data.title).toBe('Welcome');
    expect(data.description).toBe('An intro track');
    expect(data.platform).toBe('mp4');
    const audioObj = data.audio as Record<string, unknown>;
    expect(audioObj.streamUrl).toMatch(/^\/api\/member\/media\/stream\?t=/);
    expect(audioObj.guid).toBeUndefined();
    expect(audioObj.videoLibraryId).toBeUndefined();
    expect(audioObj.directPlayUrl).toBeUndefined();
    expect(audioObj.duration).toBe(120);
  });

  it('drops the VideoTemplate iframe HTML and adds data.streamUrl', () => {
    const out = serializeCourseDetailLegacy(buildProduct(), reviewAggregate) as Record<
      string,
      unknown
    >;
    const lessonsData = out.lessonsData as Array<Record<string, unknown>>;
    const lessonB = (lessonsData[0].courseLessonData as Array<Record<string, unknown>>)[1];
    const slides = lessonB.slidesData as Array<Record<string, unknown>>;
    const video = slides[0];

    expect(video.type).toBe('VideoTemplate');
    const data = video.data as Record<string, unknown>;
    expect(data.title).toBe('Chapter 1');
    expect(data.platform).toBe('mp4');
    expect(data.url).toBeUndefined();
    expect(data.streamUrl).toMatch(/^\/api\/member\/media\/stream\?t=/);
  });

  it('passes non-media slides through unchanged', () => {
    const out = serializeCourseDetailLegacy(buildProduct(), reviewAggregate) as Record<
      string,
      unknown
    >;
    const lessonsData = out.lessonsData as Array<Record<string, unknown>>;
    const lessonA = (lessonsData[0].courseLessonData as Array<Record<string, unknown>>)[0];
    const slides = lessonA.slidesData as Array<Record<string, unknown>>;
    const text = slides[1];

    expect(text.type).toBe('TextTemplate');
    expect((text.data as Record<string, unknown>).body).toBe('some content');
  });

  it('preserves external (non-Bunny) video URLs untouched', () => {
    const out = serializeCourseDetailLegacy(buildProduct(), reviewAggregate) as Record<
      string,
      unknown
    >;
    const lessonsData = out.lessonsData as Array<Record<string, unknown>>;
    const lessonB = (lessonsData[0].courseLessonData as Array<Record<string, unknown>>)[1];
    const slides = lessonB.slidesData as Array<Record<string, unknown>>;
    const yt = slides[1];

    const data = yt.data as Record<string, unknown>;
    expect(data.url).toContain('youtube.com');
    expect(data.streamUrl).toBeUndefined();
  });

  it('dataContent entries carry a streamUrl instead of guid/videoLibraryId', () => {
    const out = serializeCourseDetailLegacy(buildProduct(), reviewAggregate) as Record<
      string,
      unknown
    >;
    const dataContent = out.dataContent as Array<Record<string, unknown>>;
    // audio + bunny video + youtube video are all VideoTemplate/AudioTemplate
    const audioEntry = dataContent.find((e) => e.type === 'AudioTemplate');
    const videoEntries = dataContent.filter((e) => e.type === 'VideoTemplate');

    expect(audioEntry?.streamUrl).toMatch(/^\/api\/member\/media\/stream\?t=/);
    expect(audioEntry?.guid).toBeUndefined();
    expect(audioEntry?.videoLibraryId).toBeUndefined();

    const bunnyVideo = videoEntries.find((e) => typeof e.streamUrl === 'string');
    expect(bunnyVideo?.streamUrl).toMatch(/^\/api\/member\/media\/stream\?t=/);
    expect(bunnyVideo?.guid).toBeUndefined();
  });

  it('mints media tokens carrying the right guid / courseId / isPreview', () => {
    const out = serializeCourseDetailLegacy(buildProduct(), reviewAggregate);
    const urls = collectStreamUrls(out);
    expect(urls.length).toBeGreaterThan(0);

    const payloads = urls.map((u) => verifyMediaToken(tokenFromStreamUrl(u)));
    // Every token points back at the course UUID.
    payloads.forEach((p) => expect(p.courseId).toBe(COURSE_UUID));

    // Audio lives in the preview lesson -> isPreview true; video in a non-preview lesson.
    const audioToken = payloads.find((p) => p.guid === AUDIO_GUID);
    const videoToken = payloads.find((p) => p.guid === VIDEO_GUID);
    expect(audioToken?.isPreview).toBe(true);
    expect(videoToken?.isPreview).toBe(false);
  });
});
