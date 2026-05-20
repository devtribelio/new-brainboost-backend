import { prisma } from '@/config/prisma';
import type { ResourceConfig } from '../util/crud-factory';
import {
  loadMembers,
  loadTopics,
  loadCountries,
  loadProvinces,
  loadCities,
  loadDistricts,
  loadProducts,
  loadPosts,
  loadComments,
  loadNetworks,
  loadReportCategories,
} from './loaders';

const memberResource: ResourceConfig = {
  key: 'members',
  label: 'Member',
  pluralLabel: 'Members',
  model: prisma.member,
  searchField: 'email',
  defaultOrderBy: { createdAt: 'desc' },
  listColumns: [
    { field: 'email', label: 'Email' },
    { field: 'fullName', label: 'Full Name' },
    { field: 'phone', label: 'Phone' },
    { field: 'isActive', label: 'Active' },
    { field: 'isVerified', label: 'Verified' },
    { field: 'createdAt', label: 'Created' },
  ],
  fields: [
    { name: 'email', label: 'Email', type: 'text', required: true },
    { name: 'username', label: 'Username', type: 'text' },
    { name: 'phone', label: 'Phone', type: 'text' },
    { name: 'fullName', label: 'Full Name', type: 'text' },
    {
      name: 'passwordHash',
      label: 'Password',
      type: 'password',
      required: true,
      hashOnSet: true,
      helpText: 'Leave blank when editing to keep current password.',
    },
    { name: 'avatarUrl', label: 'Avatar URL', type: 'text' },
    { name: 'bio', label: 'Bio', type: 'textarea' },
    { name: 'isActive', label: 'Is Active', type: 'boolean' },
    { name: 'isVerified', label: 'Is Verified', type: 'boolean' },
  ],
};

const memberProfileResource: ResourceConfig = {
  key: 'member-profiles',
  label: 'Member Profile',
  pluralLabel: 'Member Profiles',
  model: prisma.memberProfile,
  defaultOrderBy: { updatedAt: 'desc' },
  listColumns: [
    { field: 'memberId', label: 'Member' },
    { field: 'address', label: 'Address' },
    { field: 'postalCode', label: 'Postal Code' },
    { field: 'updatedAt', label: 'Updated' },
  ],
  fields: [
    { name: 'memberId', label: 'Member', type: 'select', required: true, optionsLoader: loadMembers },
    { name: 'countryId', label: 'Country', type: 'select', optionsLoader: loadCountries },
    { name: 'provinceId', label: 'Province', type: 'select', optionsLoader: loadProvinces },
    { name: 'cityId', label: 'City', type: 'select', optionsLoader: loadCities },
    { name: 'districtId', label: 'District', type: 'select', optionsLoader: loadDistricts },
    { name: 'address', label: 'Address', type: 'textarea' },
    { name: 'postalCode', label: 'Postal Code', type: 'text' },
  ],
};

const deviceResource: ResourceConfig = {
  key: 'devices',
  label: 'Device',
  pluralLabel: 'Devices',
  model: prisma.device,
  defaultOrderBy: { lastSeenAt: 'desc' },
  listColumns: [
    { field: 'memberId', label: 'Member' },
    { field: 'deviceId', label: 'Device ID' },
    { field: 'platform', label: 'Platform' },
    { field: 'lastSeenAt', label: 'Last Seen' },
  ],
  fields: [
    { name: 'memberId', label: 'Member', type: 'select', required: true, optionsLoader: loadMembers },
    { name: 'deviceId', label: 'Device ID', type: 'text', required: true },
    { name: 'platform', label: 'Platform', type: 'text', required: true },
    { name: 'fcmToken', label: 'FCM Token', type: 'textarea' },
  ],
};

const refreshTokenResource: ResourceConfig = {
  key: 'refresh-tokens',
  label: 'Refresh Token',
  pluralLabel: 'Refresh Tokens',
  model: prisma.refreshToken,
  defaultOrderBy: { createdAt: 'desc' },
  canCreate: false,
  canEdit: true,
  listColumns: [
    { field: 'memberId', label: 'Member' },
    { field: 'expiresAt', label: 'Expires' },
    { field: 'revokedAt', label: 'Revoked' },
    { field: 'createdAt', label: 'Created' },
  ],
  fields: [
    { name: 'revokedAt', label: 'Revoked At (revoke by setting now)', type: 'datetime' },
  ],
};

const otpCodeResource: ResourceConfig = {
  key: 'otp-codes',
  label: 'OTP Code',
  pluralLabel: 'OTP Codes',
  model: prisma.otpCode,
  searchField: 'target',
  defaultOrderBy: { createdAt: 'desc' },
  canCreate: false,
  canEdit: false,
  listColumns: [
    { field: 'target', label: 'Target' },
    { field: 'purpose', label: 'Purpose' },
    { field: 'expiresAt', label: 'Expires' },
    { field: 'usedAt', label: 'Used At' },
    { field: 'createdAt', label: 'Created' },
  ],
  fields: [],
};

const countryResource: ResourceConfig = {
  key: 'countries',
  label: 'Country',
  pluralLabel: 'Countries',
  model: prisma.country,
  searchField: 'name',
  defaultOrderBy: { name: 'asc' },
  listColumns: [
    { field: 'name', label: 'Name' },
    { field: 'code', label: 'Code' },
  ],
  fields: [
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'code', label: 'Code', type: 'text' },
  ],
};

const provinceResource: ResourceConfig = {
  key: 'provinces',
  label: 'Province',
  pluralLabel: 'Provinces',
  model: prisma.province,
  searchField: 'name',
  defaultOrderBy: { name: 'asc' },
  listColumns: [
    { field: 'name', label: 'Name' },
    { field: 'countryId', label: 'Country' },
  ],
  fields: [
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'countryId', label: 'Country', type: 'select', required: true, optionsLoader: loadCountries },
  ],
};

const cityResource: ResourceConfig = {
  key: 'cities',
  label: 'City',
  pluralLabel: 'Cities',
  model: prisma.city,
  searchField: 'name',
  defaultOrderBy: { name: 'asc' },
  listColumns: [
    { field: 'name', label: 'Name' },
    { field: 'provinceId', label: 'Province' },
  ],
  fields: [
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'provinceId', label: 'Province', type: 'select', required: true, optionsLoader: loadProvinces },
  ],
};

const districtResource: ResourceConfig = {
  key: 'districts',
  label: 'District',
  pluralLabel: 'Districts',
  model: prisma.district,
  searchField: 'name',
  defaultOrderBy: { name: 'asc' },
  listColumns: [
    { field: 'name', label: 'Name' },
    { field: 'cityId', label: 'City' },
  ],
  fields: [
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'cityId', label: 'City', type: 'select', required: true, optionsLoader: loadCities },
  ],
};

const bannerResource: ResourceConfig = {
  key: 'banners',
  label: 'Banner',
  pluralLabel: 'Banners',
  model: prisma.banner,
  searchField: 'title',
  defaultOrderBy: { position: 'asc' },
  listColumns: [
    { field: 'title', label: 'Title' },
    { field: 'imageUrl', label: 'Image URL' },
    { field: 'linkUrl', label: 'Link' },
    { field: 'position', label: 'Pos' },
    { field: 'isActive', label: 'Active' },
  ],
  fields: [
    { name: 'title', label: 'Title', type: 'text', required: true },
    { name: 'imageUrl', label: 'Image URL', type: 'text', required: true },
    { name: 'linkUrl', label: 'Link URL', type: 'text' },
    { name: 'position', label: 'Position', type: 'number' },
    { name: 'isActive', label: 'Is Active', type: 'boolean' },
  ],
};

const productResource: ResourceConfig = {
  key: 'products',
  label: 'Product',
  pluralLabel: 'Products',
  model: prisma.product,
  searchField: 'title',
  defaultOrderBy: { createdAt: 'desc' },
  listColumns: [
    { field: 'title', label: 'Title' },
    { field: 'type', label: 'Type' },
    { field: 'price', label: 'Price' },
    { field: 'isActive', label: 'Active' },
  ],
  fields: [
    { name: 'type', label: 'Type', type: 'text', required: true, helpText: 'e.g. course, ebook, event' },
    { name: 'title', label: 'Title', type: 'text', required: true },
    { name: 'description', label: 'Description', type: 'textarea' },
    { name: 'thumbnail', label: 'Thumbnail URL', type: 'text' },
    { name: 'price', label: 'Price (cents)', type: 'number' },
    { name: 'isActive', label: 'Is Active', type: 'boolean' },
  ],
};

const courseResource: ResourceConfig = {
  key: 'courses',
  label: 'Course',
  pluralLabel: 'Courses',
  model: prisma.course,
  defaultOrderBy: { id: 'desc' },
  listColumns: [
    { field: 'productId', label: 'Product' },
    { field: 'durationMin', label: 'Duration (min)' },
    { field: 'level', label: 'Level' },
  ],
  fields: [
    { name: 'productId', label: 'Product', type: 'select', required: true, optionsLoader: loadProducts },
    { name: 'durationMin', label: 'Duration (minutes)', type: 'number' },
    { name: 'level', label: 'Level', type: 'text' },
    { name: 'contentRef', label: 'Content Reference', type: 'text' },
  ],
};

const topicResource: ResourceConfig = {
  key: 'topics',
  label: 'Topic',
  pluralLabel: 'Topics',
  model: prisma.topic,
  searchField: 'name',
  defaultOrderBy: { name: 'asc' },
  listColumns: [
    { field: 'name', label: 'Name' },
    { field: 'description', label: 'Description' },
    { field: 'isActive', label: 'Active' },
  ],
  fields: [
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'description', label: 'Description', type: 'textarea' },
    { name: 'iconUrl', label: 'Icon (emoji or URL)', type: 'text' },
    { name: 'iconType', label: 'Icon Type', type: 'text' },
    { name: 'isActive', label: 'Is Active', type: 'boolean' },
  ],
};

const topicSubscriptionResource: ResourceConfig = {
  key: 'topic-subscriptions',
  label: 'Topic Subscription',
  pluralLabel: 'Topic Subscriptions',
  model: prisma.topicSubscription,
  defaultOrderBy: { createdAt: 'desc' },
  listColumns: [
    { field: 'memberId', label: 'Member' },
    { field: 'topicId', label: 'Topic' },
    { field: 'createdAt', label: 'Created' },
  ],
  fields: [
    { name: 'memberId', label: 'Member', type: 'select', required: true, optionsLoader: loadMembers },
    { name: 'topicId', label: 'Topic', type: 'select', required: true, optionsLoader: loadTopics },
  ],
};

const postResource: ResourceConfig = {
  key: 'posts',
  label: 'Post',
  pluralLabel: 'Posts',
  model: prisma.post,
  searchField: 'content',
  defaultOrderBy: { createdAt: 'desc' },
  listColumns: [
    { field: 'authorId', label: 'Author' },
    { field: 'topicId', label: 'Topic' },
    { field: 'content', label: 'Content' },
    { field: 'isDeleted', label: 'Deleted' },
    { field: 'createdAt', label: 'Created' },
  ],
  fields: [
    { name: 'authorId', label: 'Author', type: 'select', required: true, optionsLoader: loadMembers },
    { name: 'topicId', label: 'Topic', type: 'select', optionsLoader: loadTopics },
    { name: 'content', label: 'Content', type: 'textarea', required: true },
    {
      name: 'imageUrls',
      label: 'Image URLs',
      type: 'string-array',
      helpText: 'One URL per line',
    },
    { name: 'isDeleted', label: 'Is Deleted', type: 'boolean' },
  ],
};

const postLikeResource: ResourceConfig = {
  key: 'post-likes',
  label: 'Post Like',
  pluralLabel: 'Post Likes',
  model: prisma.postLike,
  defaultOrderBy: { createdAt: 'desc' },
  listColumns: [
    { field: 'postId', label: 'Post' },
    { field: 'memberId', label: 'Member' },
    { field: 'createdAt', label: 'Created' },
  ],
  fields: [
    { name: 'postId', label: 'Post', type: 'select', required: true, optionsLoader: loadPosts },
    { name: 'memberId', label: 'Member', type: 'select', required: true, optionsLoader: loadMembers },
  ],
};

const commentResource: ResourceConfig = {
  key: 'comments',
  label: 'Comment',
  pluralLabel: 'Comments',
  model: prisma.comment,
  searchField: 'content',
  defaultOrderBy: { createdAt: 'desc' },
  listColumns: [
    { field: 'postId', label: 'Post' },
    { field: 'authorId', label: 'Author' },
    { field: 'parentId', label: 'Parent' },
    { field: 'content', label: 'Content' },
    { field: 'isDeleted', label: 'Deleted' },
  ],
  fields: [
    { name: 'postId', label: 'Post', type: 'select', required: true, optionsLoader: loadPosts },
    { name: 'authorId', label: 'Author', type: 'select', required: true, optionsLoader: loadMembers },
    { name: 'parentId', label: 'Parent Comment', type: 'select', optionsLoader: loadComments },
    { name: 'content', label: 'Content', type: 'textarea', required: true },
    { name: 'isDeleted', label: 'Is Deleted', type: 'boolean' },
  ],
};

const commentLikeResource: ResourceConfig = {
  key: 'comment-likes',
  label: 'Comment Like',
  pluralLabel: 'Comment Likes',
  model: prisma.commentLike,
  defaultOrderBy: { createdAt: 'desc' },
  listColumns: [
    { field: 'commentId', label: 'Comment' },
    { field: 'memberId', label: 'Member' },
    { field: 'createdAt', label: 'Created' },
  ],
  fields: [
    { name: 'commentId', label: 'Comment', type: 'select', required: true, optionsLoader: loadComments },
    { name: 'memberId', label: 'Member', type: 'select', required: true, optionsLoader: loadMembers },
  ],
};

const networkResource: ResourceConfig = {
  key: 'networks',
  label: 'Network',
  pluralLabel: 'Networks',
  model: prisma.network,
  searchField: 'name',
  defaultOrderBy: { name: 'asc' },
  listColumns: [
    { field: 'name', label: 'Name' },
    { field: 'description', label: 'Description' },
  ],
  fields: [
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'description', label: 'Description', type: 'textarea' },
    { name: 'iconUrl', label: 'Icon URL', type: 'text' },
  ],
};

const networkMemberResource: ResourceConfig = {
  key: 'network-members',
  label: 'Network Member',
  pluralLabel: 'Network Members',
  model: prisma.networkMember,
  defaultOrderBy: { joinedAt: 'desc' },
  listColumns: [
    { field: 'networkId', label: 'Network' },
    { field: 'memberId', label: 'Member' },
    { field: 'joinedAt', label: 'Joined' },
  ],
  fields: [
    { name: 'networkId', label: 'Network', type: 'select', required: true, optionsLoader: loadNetworks },
    { name: 'memberId', label: 'Member', type: 'select', required: true, optionsLoader: loadMembers },
  ],
};

const networkTagResource: ResourceConfig = {
  key: 'network-tags',
  label: 'Network Tag',
  pluralLabel: 'Network Tags',
  model: prisma.networkTag,
  searchField: 'name',
  defaultOrderBy: { name: 'asc' },
  listColumns: [
    { field: 'networkId', label: 'Network' },
    { field: 'name', label: 'Name' },
  ],
  fields: [
    { name: 'networkId', label: 'Network', type: 'select', required: true, optionsLoader: loadNetworks },
    { name: 'name', label: 'Name', type: 'text', required: true },
  ],
};

const reportCategoryResource: ResourceConfig = {
  key: 'report-categories',
  label: 'Report Category',
  pluralLabel: 'Report Categories',
  model: prisma.reportCategory,
  searchField: 'name',
  defaultOrderBy: { name: 'asc' },
  listColumns: [
    { field: 'name', label: 'Name' },
    { field: 'isActive', label: 'Active' },
  ],
  fields: [
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'isActive', label: 'Is Active', type: 'boolean' },
  ],
};

const postReportResource: ResourceConfig = {
  key: 'post-reports',
  label: 'Post Report',
  pluralLabel: 'Post Reports',
  model: prisma.postReport,
  defaultOrderBy: { createdAt: 'desc' },
  listColumns: [
    { field: 'postId', label: 'Post' },
    { field: 'reporterId', label: 'Reporter' },
    { field: 'categoryId', label: 'Category' },
    { field: 'reason', label: 'Reason' },
    { field: 'createdAt', label: 'Created' },
  ],
  fields: [
    { name: 'postId', label: 'Post', type: 'select', required: true, optionsLoader: loadPosts },
    { name: 'reporterId', label: 'Reporter', type: 'select', required: true, optionsLoader: loadMembers },
    {
      name: 'categoryId',
      label: 'Category',
      type: 'select',
      required: true,
      optionsLoader: loadReportCategories,
    },
    { name: 'reason', label: 'Reason', type: 'textarea' },
  ],
};

const memberReportResource: ResourceConfig = {
  key: 'member-reports',
  label: 'Member Report',
  pluralLabel: 'Member Reports',
  model: prisma.memberReport,
  defaultOrderBy: { createdAt: 'desc' },
  listColumns: [
    { field: 'reporterId', label: 'Reporter' },
    { field: 'targetId', label: 'Target' },
    { field: 'categoryId', label: 'Category' },
    { field: 'reason', label: 'Reason' },
    { field: 'createdAt', label: 'Created' },
  ],
  fields: [
    { name: 'reporterId', label: 'Reporter', type: 'select', required: true, optionsLoader: loadMembers },
    { name: 'targetId', label: 'Target Member', type: 'select', required: true, optionsLoader: loadMembers },
    {
      name: 'categoryId',
      label: 'Category',
      type: 'select',
      required: true,
      optionsLoader: loadReportCategories,
    },
    { name: 'reason', label: 'Reason', type: 'textarea' },
  ],
};

const notificationResource: ResourceConfig = {
  key: 'notifications',
  label: 'Notification',
  pluralLabel: 'Notifications',
  model: prisma.notification,
  searchField: 'title',
  defaultOrderBy: { createdAt: 'desc' },
  listColumns: [
    { field: 'memberId', label: 'Member' },
    { field: 'type', label: 'Type' },
    { field: 'title', label: 'Title' },
    { field: 'seenAt', label: 'Seen' },
    { field: 'createdAt', label: 'Created' },
  ],
  fields: [
    { name: 'memberId', label: 'Member', type: 'select', required: true, optionsLoader: loadMembers },
    { name: 'type', label: 'Type', type: 'text', required: true },
    { name: 'title', label: 'Title', type: 'text', required: true },
    { name: 'body', label: 'Body', type: 'textarea' },
    { name: 'payload', label: 'Payload (JSON)', type: 'json' },
    { name: 'seenAt', label: 'Seen At', type: 'datetime' },
  ],
};

const adminResource: ResourceConfig = {
  key: 'admins',
  label: 'Admin',
  pluralLabel: 'Admins',
  model: prisma.admin,
  searchField: 'email',
  defaultOrderBy: { createdAt: 'desc' },
  listColumns: [
    { field: 'email', label: 'Email' },
    { field: 'fullName', label: 'Full Name' },
    { field: 'role', label: 'Role' },
    { field: 'isActive', label: 'Active' },
    { field: 'lastLoginAt', label: 'Last Login' },
  ],
  fields: [
    { name: 'email', label: 'Email', type: 'text', required: true },
    { name: 'fullName', label: 'Full Name', type: 'text', required: true },
    {
      name: 'passwordHash',
      label: 'Password',
      type: 'password',
      required: true,
      hashOnSet: true,
      helpText: 'Leave blank when editing to keep current password.',
    },
    {
      name: 'role',
      label: 'Role',
      type: 'select',
      required: true,
      options: [
        { value: 'ADMIN', label: 'ADMIN' },
        { value: 'SUPERADMIN', label: 'SUPERADMIN' },
      ],
    },
    { name: 'isActive', label: 'Is Active', type: 'boolean' },
  ],
};

export const resources: ResourceConfig[] = [
  memberResource,
  memberProfileResource,
  deviceResource,
  refreshTokenResource,
  otpCodeResource,
  countryResource,
  provinceResource,
  cityResource,
  districtResource,
  bannerResource,
  productResource,
  courseResource,
  topicResource,
  topicSubscriptionResource,
  postResource,
  postLikeResource,
  commentResource,
  commentLikeResource,
  networkResource,
  networkMemberResource,
  networkTagResource,
  reportCategoryResource,
  postReportResource,
  memberReportResource,
  notificationResource,
  adminResource,
];
