import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { prisma } from '@bb/db';
import { ShopVisitService } from '@bb/domain/shop/visit.service';
import { buildApp } from '../../src/app';

const app = buildApp();
const created = { events: [] as string[], guests: [] as string[], members: [] as string[] };

async function makeEvent() {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const event = await prisma.event.create({
    data: {
      slug: `visit-event-${suffix}`,
      title: `Visit Event ${suffix}`,
      startsAt: new Date(Date.now() + 48 * 3600 * 1000),
      status: 'ON_SALE',
    },
  });
  created.events.push(event.id);
  return event;
}

function guest() {
  const id = `guest-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  created.guests.push(id);
  return id;
}

afterEach(async () => {
  await prisma.eventVisit.deleteMany({ where: { guestId: { in: created.guests } } });
  await prisma.shopVisit.deleteMany({ where: { guestId: { in: created.guests } } });
  await prisma.event.deleteMany({ where: { id: { in: created.events } } });
  await prisma.member.deleteMany({ where: { id: { in: created.members } } });
  created.events = [];
  created.guests = [];
  created.members = [];
});

describe('POST /api/event/visits', () => {
  it('logs a visit and resolves the event by slug', async () => {
    const event = await makeEvent();
    const guestId = guest();

    const res = await request(app)
      .post('/api/event/visits')
      .send({ guestId, eventSlug: event.slug, utmSource: 'instagram', utmCampaign: 'mt-denny' })
      .expect(200);

    expect(res.body.data.status).toBe('logged');
    const [row] = await prisma.eventVisit.findMany({ where: { guestId } });
    expect(row.eventId).toBe(event.id);
    expect(row.utmSource).toBe('instagram');
  });

  it('never leaves a row in shop_visits — the two stores stay apart', async () => {
    const event = await makeEvent();
    const guestId = guest();

    await request(app).post('/api/event/visits').send({ guestId, eventSlug: event.slug }).expect(200);

    expect(await prisma.shopVisit.count({ where: { guestId } })).toBe(0);
    expect(await prisma.eventVisit.count({ where: { guestId } })).toBe(1);
  });

  it('still logs an unknown slug, with a null eventId', async () => {
    const guestId = guest();

    const res = await request(app)
      .post('/api/event/visits')
      .send({ guestId, eventSlug: 'no-such-event', utmSource: 'whatsapp' })
      .expect(200);

    expect(res.body.data.status).toBe('logged');
    const [row] = await prisma.eventVisit.findMany({ where: { guestId } });
    // The UTM is real traffic even when the slug is not — refusing it would
    // throw away the only record that the click happened.
    expect(row.eventId).toBeNull();
    expect(row.utmSource).toBe('whatsapp');
  });

  it('answers 200 with a status instead of 4xx when the payload is unusable', async () => {
    const res = await request(app).post('/api/event/visits').send({}).expect(200);
    expect(res.body.data.status).toBe('invalid');
  });

  it('drops an unfurl bot at write time', async () => {
    const event = await makeEvent();
    const guestId = guest();

    const res = await request(app)
      .post('/api/event/visits')
      .set('user-agent', 'WhatsApp/2.23 A')
      .send({ guestId, eventSlug: event.slug })
      .expect(200);

    expect(res.body.data.status).toBe('invalid');
    expect(await prisma.eventVisit.count({ where: { guestId } })).toBe(0);
  });

  it('dedupes a retry by clientEventId but not a genuine second visit', async () => {
    const event = await makeEvent();
    const guestId = guest();
    const clientEventId = `evt-${Date.now()}`;

    await request(app)
      .post('/api/event/visits')
      .send({ guestId, eventSlug: event.slug, clientEventId })
      .expect(200);
    const retry = await request(app)
      .post('/api/event/visits')
      .send({ guestId, eventSlug: event.slug, clientEventId })
      .expect(200);
    // A refresh sends a NEW id and must produce a new row, else "Kunjungan"
    // collapses onto "Pengunjung unik".
    await request(app)
      .post('/api/event/visits')
      .send({ guestId, eventSlug: event.slug, clientEventId: `${clientEventId}-2` })
      .expect(200);

    expect(retry.body.data.status).toBe('duplicate');
    expect(await prisma.eventVisit.count({ where: { guestId } })).toBe(2);
  });
});

describe('claim binds both visit stores', () => {
  it('claims event visits through the existing shop claim', async () => {
    const event = await makeEvent();
    const guestId = guest();
    const member = await prisma.member.create({
      data: { email: `claim-${Date.now()}@test.local`, passwordHash: 'x', fullName: 'Claimer' },
    });
    created.members.push(member.id);

    await request(app).post('/api/event/visits').send({ guestId, eventSlug: event.slug }).expect(200);
    await prisma.shopVisit.create({ data: { guestId, utmSource: 'instagram' } });

    const { claimed } = await new ShopVisitService().claimForMember(member.id, guestId);

    // One row in each store: the FE calls one endpoint and must not have to know
    // how many tables answer it.
    expect(claimed).toBe(2);
    expect((await prisma.eventVisit.findFirst({ where: { guestId } }))!.memberId).toBe(member.id);
  });
});
