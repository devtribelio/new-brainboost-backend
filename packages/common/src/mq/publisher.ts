import amqp, { type Channel, type ChannelModel } from 'amqplib';
import { env } from '@bb/common/config/env';
import { logger } from '@bb/common/config/logger';
import { TOPOLOGY, routingKeyFor } from '@bb/common/mq/topology';
import type { CommsMessage } from '@bb/common/mq/comms-contract';

/**
 * Lazy-singleton AMQP publisher for the comms exchange. Used by the comms-relay
 * daemon to push outbox rows. Asserts only the exchange (bb-comms owns queues +
 * DLX). Publishes persistent messages keyed by priority routing key.
 */
let conn: ChannelModel | null = null;
let chan: Channel | null = null;

async function getChannel(): Promise<Channel> {
  if (chan) return chan;
  if (!env.rabbitmq.url) {
    throw new Error('RABBITMQ_URL not configured');
  }
  const url = new URL(env.rabbitmq.url);
  url.pathname = `/${encodeURIComponent(env.rabbitmq.vhost)}`;

  conn = await amqp.connect(url.toString());
  conn.on('error', (err) => logger.error({ err }, '[mq-publisher] connection error'));
  conn.on('close', () => {
    logger.warn('[mq-publisher] connection closed');
    conn = null;
    chan = null;
  });

  chan = await conn.createChannel();
  await chan.assertExchange(TOPOLOGY.exchange, TOPOLOGY.exchangeType, { durable: true });
  logger.info({ exchange: TOPOLOGY.exchange, vhost: env.rabbitmq.vhost }, '[mq-publisher] connected');
  return chan;
}

/** Publish one comms message. Throws on failure so the relay leaves it PENDING. */
export async function publishComms(msg: CommsMessage): Promise<void> {
  const channel = await getChannel();
  const ok = channel.publish(
    TOPOLOGY.exchange,
    routingKeyFor(msg.priority),
    Buffer.from(JSON.stringify(msg), 'utf8'),
    { persistent: true, messageId: msg.messageId, contentType: 'application/json' },
  );
  if (!ok) {
    // Write buffer full — apply backpressure so the relay retries this row.
    await new Promise<void>((resolve) => channel.once('drain', resolve));
  }
}

export async function closePublisher(): Promise<void> {
  try {
    await chan?.close();
    await conn?.close();
  } finally {
    chan = null;
    conn = null;
  }
}
