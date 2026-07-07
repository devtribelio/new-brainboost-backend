export const ActionLabel = {
  NewPost: 'newPost',
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
  SubscriptionActivated: 'subscriptionActivated',
  SubscriptionExpired: 'subscriptionExpired',
  SubscriptionCanceled: 'subscriptionCanceled',
  SubscriptionReminder: 'subscriptionReminder',
  CommissionEarned: 'commissionEarned',
} as const;

export type ActionLabel = (typeof ActionLabel)[keyof typeof ActionLabel];

export const NotifGroup = {
  General: 'general',
  Creator: 'creator',
} as const;

export type NotifGroup = (typeof NotifGroup)[keyof typeof NotifGroup];
