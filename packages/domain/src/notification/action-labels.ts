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
  PaymentPending: 'paymentPending',
  PaymentRefunded: 'paymentRefunded',
  SubscriptionRenewed: 'subscriptionRenewed',
  CommissionEarned: 'commissionEarned',
} as const;

export type ActionLabel = (typeof ActionLabel)[keyof typeof ActionLabel];

export const NotifGroup = {
  General: 'general',
  Creator: 'creator',
} as const;

export type NotifGroup = (typeof NotifGroup)[keyof typeof NotifGroup];
