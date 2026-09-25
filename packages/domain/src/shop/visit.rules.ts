/**
 * Write rules shared by every visit logger (shop, event).
 *
 * Shared rather than copied because these two are exactly the parts that drift:
 * a bot pattern added to one table's filter and not the other's shows up months
 * later as one report counting unfurls and the other not.
 */

/**
 * User agents that are not visitors: link unfurlers (WhatsApp, Slack), crawlers
 * and scripted clients. Matched at WRITE time — each unfurl carries a fresh
 * cookie-less guest id, so filtering at read time is impossible.
 */
export const BOT_UA =
  /bot|crawler|spider|crawling|preview|facebookexternalhit|slackbot|whatsapp|telegrambot|twitterbot|discordbot|embedly|quora link preview|pinterest|redditbot|applebot|bingpreview|headlesschrome|python-requests|curl\/|wget\//i;

/** Empty and whitespace-only both mean "not sent", and both store as NULL. */
export function trimOrNull(value?: string | null): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed === '' ? null : trimmed;
}
