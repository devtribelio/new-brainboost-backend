export const ActionLabel = {
  NewPost: 'newPost',
  /** Nightly 21:00 WIB recap: "9 post baru di Topic A". One row per topic. */
  TopicDigest: 'topicDigest',
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
