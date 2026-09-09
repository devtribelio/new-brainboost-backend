/* eslint-disable no-console */
/**
 * Create one sellable event with its ticket types, for QA and FE development.
 *
 *   pnpm seed:event                       # default: 1 online + 1 offline + 1 free
 *   pnpm seed:event --slug=webinar-tidur  # fixed slug (idempotent, see below)
 *   pnpm seed:event --status=DRAFT        # DRAFT | ON_SALE | CLOSED | CANCELED
 *   pnpm seed:event --quota=3             # small quota, to test "sold out"
 *   pnpm seed:event --days=2              # starts in N days (use a negative N for a past event)
 *   pnpm seed:event --delete=<slug>       # remove a seeded event and its products
 *
 * This exists because there is NO other way to create an event until the
 * backoffice pages land (BO-01): the app has no authoring endpoint, by design —
 * events are authored by the backoffice over plain SQL. Without this, the
 * marketplace and QA cannot start.
 *
 * Writes through Prisma rather than raw SQL on purpose: the backoffice will have
 * to supply `id` and `updated_at` itself, but a seed script has no reason to
 * reproduce that trap.
 *
 * Idempotent per slug: an existing event with the same slug is reported and left
 * ALONE rather than overwritten — re-running must never silently reset a row
 * someone is mid-test on. Use `--delete` then re-seed to start over.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit?.split('=').slice(1).join('=');
}

const DAY = 24 * 3600 * 1000;

async function remove(slug: string) {
  const event = await prisma.event.findUnique({
    where: { slug },
    select: { id: true, ticketTypes: { select: { id: true, productId: true } } },
  });
  if (!event) {
    console.log(`= no event with slug "${slug}"`);
    return;
  }
  const typeIds = event.ticketTypes.map((t) => t.id);
  const productIds = event.ticketTypes.map((t) => t.productId);

  // Refuse rather than cascade: a sold ticket points at a real order and a real
  // payment, and deleting it would leave the money side describing a purchase of
  // something that no longer exists.
  const sold = await prisma.eventTicket.count({ where: { ticketTypeId: { in: typeIds } } });
  if (sold > 0) {
    console.error(`! "${slug}" has ${sold} ticket(s) sold — refusing to delete. Clean those first.`);
    process.exitCode = 1;
    return;
  }

  await prisma.eventTicketType.deleteMany({ where: { eventId: event.id } });
  await prisma.event.delete({ where: { id: event.id } });
  await prisma.product.deleteMany({ where: { id: { in: productIds } } });
  console.log(`- deleted "${slug}" (+${productIds.length} product rows)`);
}

async function main() {
  const toDelete = arg('delete');
  if (toDelete) return remove(toDelete);

  const slug = arg('slug') ?? `webinar-demo-${Date.now().toString(36)}`;
  const status = (arg('status') ?? 'ON_SALE').toUpperCase();
  const quota = Number(arg('quota') ?? 25);
  const days = Number(arg('days') ?? 14);

  const existing = await prisma.event.findUnique({ where: { slug }, select: { id: true } });
  if (existing) {
    console.log(`= event "${slug}" already exists — left untouched. Use --delete=${slug} to reset.`);
    return;
  }

  const startsAt = new Date(Date.now() + days * DAY);
  const event = await prisma.event.create({
    data: {
      slug,
      title: 'Webinar: Tidur Berkualitas',
      description:
        '<p>Sesi dua jam bersama praktisi tidur: kenapa kamu terbangun jam 3 pagi, dan apa yang bisa diubah malam ini juga.</p>',
      coverUrl: null,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 2 * 3600 * 1000),
      location: 'Zoom',
      locationUrl: null,
      status,
    },
    select: { id: true, slug: true, startsAt: true, status: true },
  });

  // Three tiers on purpose: the two paid ones prove the price/quota path, and the
  // free one exercises the amount=0 bypass (no Xendit), which is the branch most
  // likely to be forgotten in FE testing.
  const tiers = [
    { name: 'Online', kind: 'ONLINE', price: 150_000, quota, sortOrder: 0 },
    { name: 'Offline', kind: 'OFFLINE', price: 250_000, quota: Math.max(1, Math.floor(quota / 5)), sortOrder: 1 },
    { name: 'Gratis', kind: 'ONLINE', price: 0, quota: 5, sortOrder: 2 },
  ];

  for (const tier of tiers) {
    const product = await prisma.product.create({
      data: {
        type: 'event_ticket',
        title: `Webinar: Tidur Berkualitas — ${tier.name}`,
        price: tier.price,
        isActive: true,
        status: 'active',
      },
      select: { id: true },
    });
    await prisma.eventTicketType.create({
      data: {
        eventId: event.id,
        productId: product.id,
        name: tier.name,
        kind: tier.kind,
        quota: tier.quota,
        maxPerOrder: 10,
        sortOrder: tier.sortOrder,
        isActive: true,
      },
    });
    console.log(`+ ${tier.name.padEnd(8)} Rp ${tier.price.toLocaleString('id-ID').padStart(9)}  quota=${tier.quota}`);
  }

  console.log(`\n+ event "${event.slug}" (${event.status}), starts ${event.startsAt.toISOString()}`);
  console.log(`  GET /api/event/${event.slug}`);
  console.log(`  GET /api/event/on-sale${status === 'ON_SALE' ? '' : '   (absent — status is not ON_SALE)'}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
