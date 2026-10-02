import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as bcrypt from 'bcryptjs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { prisma } from '@bb/db';
import { PostService } from '@bb/domain/post/post.service';
import { CommentService } from '@bb/domain/comment/comment.service';
import { moderatePost, parseVerdict } from '@bb/domain/moderation/post-moderation';
import { moderatePosts } from '@bb/domain/jobs/moderate-posts';
import { registerTopicNotificationListener } from '@bb/domain/notification/listeners/topic.listener';
import { notificationEvents } from '@bb/common/events/notification-events';
import { SettingsService, settingsService, SETTING_KEYS } from '@bb/common/services/settings.service';
import { ForbiddenException } from '@bb/common/exceptions';
import { parsePagination } from '@bb/common/utils/pagination.util';

function uid(): string {
  return Math.random().toString(36).slice(2, 12);
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v) || Date.now() > deadline) return v;
    await wait(25);
  }
}

const IMAGE = 'https://cdn.test.local/public/posts/u/pic.webp';
const API_KEY = 'sk-test-moderation-key';
const CATEGORY = `Judi online ${uid()}`;

const clean = { violation: false, category: null, reason: 'ok' };
const violation = { violation: true, category: CATEGORY, reason: 'iklan slot' };

describe('parseVerdict', () => {
  it.each([
    ['plain object', '{"violation":false,"category":null,"reason":"ok"}', clean],
    ['json code fence', '```json\n{"violation": true, "category": "Judi", "reason": "slot"}\n```', { violation: true, category: 'Judi', reason: 'slot' }],
    ['prose around the object', 'Here you go: {"violation":false,"category":null,"reason":"ok"} Hope it helps.', clean],
    ['a brace inside the reason', '{"violation":true,"category":"Judi","reason":"text says {win}"}', { violation: true, category: 'Judi', reason: 'text says {win}' }],
    ['missing reason and category', '{"violation":false}', { violation: false, category: null, reason: '' }],
    ['blank category', '{"violation":true,"category":"  ","reason":"x"}', { violation: true, category: null, reason: 'x' }],
  ])('reads %s', (_name, text, expected) => {
    expect(parseVerdict(text)).toEqual(expected);
  });

  it.each([
    ['empty string', ''],
    ['no JSON at all', 'The post looks fine to me.'],
    ['violation as a string', '{"violation":"false","category":null,"reason":"ok"}'],
    ['violation missing', '{"category":null,"reason":"ok"}'],
    ['truncated object', '{"violation":false,"reason":"o'],
    ['broken JSON', '{violation: false}'],
    ['a JSON array with no object', '[true, "ok"]'],
    ['non-string content', null],
  ])('refuses %s', (_name, text) => {
    expect(parseVerdict(text)).toBeNull();
  });
});

describe('tribe post moderation', () => {
  const postService = new PostService();
  const page = parsePagination({ page: '1', perPage: '50' });

  let server: http.Server;
  let requests: Array<{ url: string; auth: string; body: any }> = [];
  // What the fake provider does with the next request. `null` = never answer.
  let respond: (() => Promise<{ status: number; content: string }> | { status: number; content: string }) | null;

  let authorId = '';
  let followerId = '';
  let otherId = '';
  let topicId = '';
  let memberIds: string[] = [];

  const answer = (verdict: object) => () => ({ status: 200, content: JSON.stringify(verdict) });

  async function setSettings(enabled: boolean, baseUrl: string) {
    await settingsService.set(SETTING_KEYS.moderationEnabled, String(enabled));
    await settingsService.set(SETTING_KEYS.moderationBaseUrl, baseUrl);
    await settingsService.set(SETTING_KEYS.moderationModel, 'vision-test');
    await settingsService.set(SETTING_KEYS.moderationApiKey, API_KEY);
  }

  let baseUrl = '';

  const imagePost = (extra: Record<string, unknown> = {}) =>
    postService.create(authorId, { content: `<p>foto ${uid()}</p>`, topicId, imageUrls: [IMAGE], ...extra });

  const row = (postId: string) => prisma.postModeration.findUnique({ where: { postId } });
  const settled = (postId: string) => until(() => row(postId), (r) => !!r && r.status !== 'PENDING');
  const status = async (postId: string) =>
    (await prisma.post.findUniqueOrThrow({ where: { id: postId } })).publishStatus;
  const followerNotifs = (postId: string) =>
    prisma.notification.count({ where: { memberId: followerId, type: 'newPost', dedupeKey: `newPost:${postId}:${followerId}` } });
  const inFeedOf = async (viewerId: string, postId: string) =>
    (await postService.list(page, { viewerId, topicIds: [topicId] })).rows.some((r) => r.id === postId);

  // A post already published fail-open: ERROR row, attempts as given.
  async function failedOpenPost(attempts = 1, decidedBy = 'AI') {
    const p = await prisma.post.create({
      data: { authorId, topicId, content: `err ${uid()}`, imageUrls: [IMAGE], publishStatus: 'PUBLISHED' },
    });
    await prisma.postModeration.create({ data: { postId: p.id, status: 'ERROR', attempts, decidedBy } });
    return p.id;
  }

  beforeAll(async () => {
    registerTopicNotificationListener();

    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', async () => {
        requests.push({ url: req.url ?? '', auth: req.headers.authorization ?? '', body: JSON.parse(raw) });
        if (!respond) return; // hang → client timeout
        const { status: code, content } = await respond();
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/`;

    const make = async (tag: string) =>
      (
        await prisma.member.create({
          data: {
            email: `moderation-${tag}-${uid()}@test.local`,
            passwordHash: await bcrypt.hash('s', 4),
            isActive: true,
            notificationsEnabled: true,
          },
        })
      ).id;
    authorId = await make('author');
    followerId = await make('follower');
    otherId = await make('other');
    memberIds = [authorId, followerId, otherId];

    topicId = (await prisma.topic.create({ data: { name: `Moderation Topic ${uid()}` } })).id;
    await prisma.topicSubscription.create({ data: { memberId: followerId, topicId } });
    await prisma.moderationCategory.create({
      data: { name: CATEGORY, description: 'Iklan atau promosi judi online, slot, togel.' },
    });
  });

  beforeEach(async () => {
    requests = [];
    respond = answer(clean);
    await setSettings(true, baseUrl);
  });

  afterAll(async () => {
    const posts = await prisma.post.findMany({ where: { authorId }, select: { id: true } });
    await prisma.postModeration.deleteMany({ where: { postId: { in: posts.map((p) => p.id) } } });
    await prisma.notification.deleteMany({ where: { memberId: { in: memberIds } } });
    await prisma.comment.deleteMany({ where: { authorId: { in: memberIds } } });
    await prisma.post.deleteMany({ where: { authorId } });
    await prisma.topicSubscription.deleteMany({ where: { topicId } });
    await prisma.topic.delete({ where: { id: topicId } });
    await prisma.member.deleteMany({ where: { id: { in: memberIds } } });
    await prisma.moderationCategory.deleteMany({ where: { name: CATEGORY } });
    // Back to the seeded (off, empty) values rather than deleting the rows.
    await settingsService.set(SETTING_KEYS.moderationEnabled, 'false');
    await settingsService.set(SETTING_KEYS.moderationBaseUrl, '');
    await settingsService.set(SETTING_KEYS.moderationModel, '');
    await settingsService.set(SETTING_KEYS.moderationApiKey, '');
    SettingsService.clearCache();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await prisma.$disconnect();
  });

  describe('when moderation is off', () => {
    it.each([
      ['the switch is off', () => setSettings(false, baseUrl)],
      ['the provider is not configured', () => setSettings(true, '')],
      [
        'no category is active',
        () => prisma.moderationCategory.updateMany({ where: { name: CATEGORY }, data: { isActive: false } }),
      ],
    ])('publishes image and text posts straight away while %s', async (_name, turnOff) => {
      await turnOff();
      try {
        const post = await imagePost();
        expect(post.publishStatus).toBe('PUBLISHED');
        expect(await row(post.id)).toBeNull();
        expect(await until(() => followerNotifs(post.id), (n) => n > 0)).toBe(1);
        const text = await postService.create(authorId, { content: `teks ${uid()}`, topicId });
        expect(text.publishStatus).toBe('PUBLISHED');
        expect(await row(text.id)).toBeNull();
        expect(requests).toHaveLength(0);
      } finally {
        await prisma.moderationCategory.updateMany({ where: { name: CATEGORY }, data: { isActive: true } });
      }
    });
  });

  describe('text-only posts', () => {
    const textPost = () =>
      postService.create(authorId, { title: `Judul ${uid()}`, content: `<p>teks saja ${uid()}</p>`, topicId });

    it('holds a text-only post and publishes it once cleared, sending no image parts', async () => {
      const post = await textPost();
      expect(post.publishStatus).toBe('IN_REVIEW');
      expect(await settled(post.id)).toMatchObject({ status: 'APPROVED', attempts: 0 });
      expect(await status(post.id)).toBe('PUBLISHED');
      expect(await until(() => followerNotifs(post.id), (n) => n > 0)).toBe(1);

      expect(requests).toHaveLength(1);
      const parts = requests[0].body.messages[1].content;
      expect(parts).toHaveLength(1);
      expect(parts[0].type).toBe('text');
      expect(parts[0].text).toContain('Judul');
      expect(parts[0].text).toContain('teks saja');
      expect(parts[0].text).not.toContain('<p>');
    });

    it('rejects a violating text-only post and tells only the author', async () => {
      respond = answer(violation);
      const post = await textPost();
      expect(await settled(post.id)).toMatchObject({ status: 'REJECTED', categoryName: CATEGORY });
      expect(await status(post.id)).toBe('REJECTED');
      expect(await inFeedOf(otherId, post.id)).toBe(false);
      await expect(postService.detail(post.id, otherId)).rejects.toBeInstanceOf(ForbiddenException);
      expect((await postService.detail(post.id, authorId)).id).toBe(post.id);
      expect(
        await until(
          () => prisma.notification.count({ where: { memberId: authorId, dedupeKey: `postRejected:${post.id}` } }),
          (n) => n > 0,
        ),
      ).toBe(1);
      await wait(150);
      expect(await followerNotifs(post.id)).toBe(0);
    });

    it('fails open on a provider error, and the job re-check can still reject it', async () => {
      respond = () => ({ status: 500, content: '' });
      const post = await textPost();
      expect(await settled(post.id)).toMatchObject({ status: 'ERROR', attempts: 1 });
      expect(await status(post.id)).toBe('PUBLISHED');
      expect(await until(() => followerNotifs(post.id), (n) => n > 0)).toBe(1);

      respond = answer(violation);
      expect(await moderatePosts(new Date(), { postIds: [post.id] })).toMatchObject({ rejected: 1 });
      expect(await status(post.id)).toBe('REJECTED');
    });

    it.each([
      ['a bare video post', { content: '', videoUrl: 'https://cdn.test.local/clip.mp4' }],
      ['markup-only content', { content: '<p> &nbsp; </p>', videoUrl: 'https://cdn.test.local/clip.mp4' }],
    ])('publishes %s directly: no text and no images means nothing to check', async (_name, dto) => {
      const post = await postService.create(authorId, { ...dto, topicId });
      expect(post.publishStatus).toBe('PUBLISHED');
      expect(await row(post.id)).toBeNull();
      expect(await until(() => followerNotifs(post.id), (n) => n > 0)).toBe(1);
      expect(requests).toHaveLength(0);
    });
  });

  it('holds an image post, then publishes and announces it once the model clears it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    respond = async () => {
      await gate;
      return { status: 200, content: '```json\n' + JSON.stringify(clean) + '\n```' };
    };
    const emit = vi.spyOn(notificationEvents, 'emit');

    const post = await imagePost();
    expect(post.publishStatus).toBe('IN_REVIEW');
    await until(async () => requests.length, (n) => n > 0);

    // Held: invisible to everyone but the author, and nobody is told.
    expect((await row(post.id))?.status).toBe('PENDING');
    expect(await inFeedOf(otherId, post.id)).toBe(false);
    await expect(postService.detail(post.id, otherId)).rejects.toBeInstanceOf(ForbiddenException);
    expect((await postService.detail(post.id, authorId)).id).toBe(post.id);
    await expect(postService.toggleLike(otherId, post.id)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      new CommentService().create(otherId, { postId: post.id, content: 'halo' }),
    ).rejects.toMatchObject({ code: 'COMMENT_ON_UNPUBLISHED_POST' });
    expect(await followerNotifs(post.id)).toBe(0);

    release();
    const done = await settled(post.id);
    expect(done).toMatchObject({ status: 'APPROVED', decidedBy: 'AI', model: 'vision-test', attempts: 0 });
    expect(done?.checkedAt).not.toBeNull();
    expect(await status(post.id)).toBe('PUBLISHED');
    expect(await inFeedOf(otherId, post.id)).toBe(true);
    expect(await until(() => followerNotifs(post.id), (n) => n > 0)).toBe(1);
    expect(emit.mock.calls.filter(([e, p]) => e === 'post.published' && (p as any).postId === post.id)).toHaveLength(1);
    emit.mockRestore();

    // What went to the provider.
    expect(requests).toHaveLength(1);
    const [req] = requests;
    expect(req.url).toBe('/v1/chat/completions');
    expect(req.auth).toBe(`Bearer ${API_KEY}`);
    expect(req.body.model).toBe('vision-test');
    expect(req.body.messages[0].content).toContain(`${CATEGORY}: Iklan atau promosi judi online`);
    const parts = req.body.messages[1].content;
    expect(parts[0].text).toContain('foto');
    expect(parts[0].text).not.toContain('<p>');
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: IMAGE } });
  });

  it('rejects a violating post: hidden from others, visible to its author, only the author is told', async () => {
    respond = answer(violation);
    const post = await imagePost();
    const done = await settled(post.id);

    expect(done).toMatchObject({ status: 'REJECTED', categoryName: CATEGORY, reason: 'iklan slot', decidedBy: 'AI' });
    expect(await status(post.id)).toBe('REJECTED');
    expect(await inFeedOf(otherId, post.id)).toBe(false);
    expect(await inFeedOf(authorId, post.id)).toBe(false);
    await expect(postService.detail(post.id, otherId)).rejects.toBeInstanceOf(ForbiddenException);
    expect((await postService.detail(post.id, authorId)).publishStatus).toBe('REJECTED');

    const told = await until(
      () => prisma.notification.findMany({ where: { memberId: authorId, type: 'postRejected' } }),
      (rows) => rows.some((r) => (r.payload as any)?.refId === post.id),
    );
    const notif = told.find((r) => (r.payload as any)?.refId === post.id)!;
    expect(notif.payload).toMatchObject({ refTable: 'post', refId: post.id });
    expect(`${notif.title} ${notif.body}`).not.toContain(CATEGORY);
    await wait(150);
    expect(await followerNotifs(post.id)).toBe(0);
  });

  it('drops a category name the model made up', async () => {
    respond = answer({ violation: true, category: 'Something else', reason: 'x' });
    const post = await imagePost();
    expect(await settled(post.id)).toMatchObject({ status: 'REJECTED', categoryName: null });
  });

  it.each([
    ['a non-2xx answer', () => ({ status: 500, content: '' })],
    ['a reply that is not a verdict', () => ({ status: 200, content: 'Looks fine to me!' })],
  ])('fails open on %s: published, ERROR row', async (_name, reply) => {
    respond = reply;
    const post = await imagePost();
    const done = await settled(post.id);
    expect(done).toMatchObject({ status: 'ERROR', attempts: 1 });
    expect(done?.lastError).toBeTruthy();
    expect(done?.lastError).not.toContain(API_KEY);
    expect(await status(post.id)).toBe('PUBLISHED');
    expect(await until(() => followerNotifs(post.id), (n) => n > 0)).toBe(1);
  });

  it('fails open on a provider timeout', async () => {
    respond = null;
    const p = await prisma.post.create({
      data: { authorId, topicId, content: `lambat ${uid()}`, imageUrls: [IMAGE], publishStatus: 'IN_REVIEW' },
    });
    await prisma.postModeration.create({ data: { postId: p.id, status: 'PENDING' } });

    expect(await moderatePost(p.id, { timeoutMs: 100 })).toBe('error');
    expect(await row(p.id)).toMatchObject({ status: 'ERROR', attempts: 1 });
    expect(await status(p.id)).toBe('PUBLISHED');
  });

  describe('moderatePosts job', () => {
    it('re-checks a fail-open post and rejects it when the model now finds a violation', async () => {
      respond = () => ({ status: 500, content: '' });
      const post = await imagePost();
      await settled(post.id);
      expect(await status(post.id)).toBe('PUBLISHED');

      respond = answer(violation);
      expect(await moderatePosts(new Date(), { postIds: [post.id] })).toMatchObject({ rejected: 1 });
      expect(await row(post.id)).toMatchObject({ status: 'REJECTED', categoryName: CATEGORY, lastError: null });
      expect(await status(post.id)).toBe('REJECTED');
      expect(await inFeedOf(otherId, post.id)).toBe(false);
      expect(
        await prisma.notification.count({ where: { memberId: authorId, dedupeKey: `postRejected:${post.id}` } }),
      ).toBe(1);
    });

    it('hides the comments of a post rejected after it was published', async () => {
      const postId = await failedOpenPost();
      const comments = new CommentService();
      await comments.create(otherId, { postId, content: 'komentar' });
      expect((await comments.listForPost(page, postId)).total).toBe(1);

      respond = answer(violation);
      await moderatePosts(new Date(), { postIds: [postId] });
      expect((await comments.listForPost(page, postId)).total).toBe(0);
    });

    it('marks a fail-open post APPROVED when the re-check is clean, without announcing it twice', async () => {
      const postId = await failedOpenPost();
      const emit = vi.spyOn(notificationEvents, 'emit');
      expect(await moderatePosts(new Date(), { postIds: [postId] })).toMatchObject({ approved: 1 });
      expect(await row(postId)).toMatchObject({ status: 'APPROVED', attempts: 1 });
      expect(await status(postId)).toBe('PUBLISHED');
      expect(emit).not.toHaveBeenCalled();
      expect(await followerNotifs(postId)).toBe(0);
      emit.mockRestore();
    });

    it('gives up after 3 failed checks and leaves the post published', async () => {
      respond = () => ({ status: 503, content: '' });
      const postId = await failedOpenPost(1);
      await moderatePosts(new Date(), { postIds: [postId] });
      await moderatePosts(new Date(), { postIds: [postId] });
      expect(await row(postId)).toMatchObject({ status: 'ERROR', attempts: 3 });

      requests = [];
      expect(await moderatePosts(new Date(), { postIds: [postId] })).toEqual({ approved: 0, rejected: 0, error: 0, skipped: 0 });
      expect(requests).toHaveLength(0);
      expect(await status(postId)).toBe('PUBLISHED');
    });

    it('picks up a PENDING post the inline check never reached, and tells followers', async () => {
      const mk = async (createdAt: Date) => {
        const p = await prisma.post.create({
          data: { authorId, topicId, content: `tertinggal ${uid()}`, excerpt: 'tertinggal', imageUrls: [IMAGE], publishStatus: 'IN_REVIEW' },
        });
        await prisma.postModeration.create({ data: { postId: p.id, status: 'PENDING', createdAt } });
        return p.id;
      };
      const stale = await mk(new Date(Date.now() - 3 * 60 * 1000));
      const fresh = await mk(new Date());

      expect(await moderatePosts(new Date(), { postIds: [stale, fresh] })).toMatchObject({ approved: 1 });
      expect(await status(stale)).toBe('PUBLISHED');
      // Awaited by the job itself — no listener round-trip to wait for.
      expect(await followerNotifs(stale)).toBe(1);
      expect(await status(fresh)).toBe('IN_REVIEW');
      expect((await row(fresh))?.status).toBe('PENDING');
    });

    it('never touches a row an admin decided', async () => {
      const postId = await failedOpenPost(0, 'ADMIN');
      respond = answer(violation);
      expect(await moderatePosts(new Date(), { postIds: [postId] })).toEqual({ approved: 0, rejected: 0, error: 0, skipped: 0 });
      expect(await moderatePost(postId)).toBe('skipped');
      expect(requests).toHaveLength(0);
      expect(await row(postId)).toMatchObject({ status: 'ERROR', decidedBy: 'ADMIN', attempts: 0 });
      expect(await status(postId)).toBe('PUBLISHED');
    });
  });

  it('keeps an admin decision made while the model was still thinking', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    respond = async () => {
      await gate;
      return { status: 200, content: JSON.stringify(clean) };
    };
    const post = await imagePost();
    await until(async () => requests.length, (n) => n > 0);

    // The backoffice rejects it by SQL before the model answers "clean".
    await prisma.postModeration.update({
      where: { postId: post.id },
      data: { status: 'REJECTED', decidedBy: 'ADMIN', reason: 'manual' },
    });
    await prisma.post.update({ where: { id: post.id }, data: { publishStatus: 'REJECTED' } });

    release();
    await wait(300);
    expect(await row(post.id)).toMatchObject({ status: 'REJECTED', decidedBy: 'ADMIN', reason: 'manual' });
    expect(await status(post.id)).toBe('REJECTED');
    expect(await followerNotifs(post.id)).toBe(0);
  });

  it('lets the author post again after a rejection (no duplicate block)', async () => {
    respond = answer(violation);
    const content = `ulang ${uid()}`;
    const first = await postService.create(authorId, { content, topicId, imageUrls: [IMAGE] });
    await settled(first.id);
    respond = answer(clean);
    const second = await postService.create(authorId, { content, topicId, imageUrls: [IMAGE] });
    expect((await settled(second.id))?.status).toBe('APPROVED');
  });
});
