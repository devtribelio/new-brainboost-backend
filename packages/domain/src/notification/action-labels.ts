export const ActionLabel = {
  NewPost: 'newPost',
  // FROZEN once shipped: the mobile app routes on these two values, so an old
  // build keeps sending taps here forever. Rename = broken deep link. Add a new
  // value instead. See docs/fcm-targeted-push-contract.md #3.
  TopicDigest: 'topicDigest',
  TribeDigest: 'tribeDigest',
  NewComment: 'newComment',
  NewReply: 'newReply',
  NewLike: 'newLike',
  Tag: 'tag',
  RequestJoin: 'requestJoin',
  ApproveJoin: 'approveJoin',
  MemberJoin: 'memberJoin',
  PaymentSuccess: 'paymentSuccess',
  // Free-trial voucher grant. Separate from PaymentSuccess because the member did
  // not pay and the only thing worth telling them is when access stops. Safe to add
  // without a client release: payment notifications route on `refTable`, and an
  // unknown `type` falls to the default icon — which paymentSuccess already does.
  // FROZEN once shipped, same rule as the digest values above.
  TrialStarted: 'trialStarted',
  PaymentPending: 'paymentPending',
  PaymentRefunded: 'paymentRefunded',
  SubscriptionRenewed: 'subscriptionRenewed',
  CommissionEarned: 'commissionEarned',
  // Listening-streak reminders (docs/tracker-streak.md §5.4). Deliberately NOT in
  // PUSH_LIMIT_EXEMPT: that list is money — a member must hear about a payment
  // whatever their app habits — while a streak nudge is engagement, and the member
  // who forgot to listen for days is exactly the one already past the unopened-push
  // budget. Exempting it would make the streak the last thing still buzzing at
  // someone who stopped opening the app, which is how notifications get turned off.
  // FROZEN once shipped, same rule as the digest values above.
  StreakAtRisk: 'streakAtRisk',
  StreakDimmed: 'streakDimmed',
} as const;

export type ActionLabel = (typeof ActionLabel)[keyof typeof ActionLabel];

export const NotifGroup = {
  General: 'general',
  Creator: 'creator',
} as const;

export type NotifGroup = (typeof NotifGroup)[keyof typeof NotifGroup];
