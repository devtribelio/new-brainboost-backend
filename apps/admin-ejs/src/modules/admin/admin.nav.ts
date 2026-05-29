export interface SidebarLink {
  label: string;
  href: string;
}

export interface SidebarSection {
  label: string;
  links: SidebarLink[];
}

export const sidebarSections: SidebarSection[] = [
  {
    label: 'Auth',
    links: [
      { label: 'Members', href: '/admin/members' },
      { label: 'Member Profiles', href: '/admin/member-profiles' },
      { label: 'Devices', href: '/admin/devices' },
      { label: 'Refresh Tokens', href: '/admin/refresh-tokens' },
      { label: 'OTP Codes', href: '/admin/otp-codes' },
    ],
  },
  {
    label: 'Location',
    links: [
      { label: 'Countries', href: '/admin/countries' },
      { label: 'Provinces', href: '/admin/provinces' },
      { label: 'Cities', href: '/admin/cities' },
      { label: 'Districts', href: '/admin/districts' },
    ],
  },
  {
    label: 'Content',
    links: [
      { label: 'Banners', href: '/admin/banners' },
      { label: 'Products', href: '/admin/products' },
      { label: 'Courses', href: '/admin/courses' },
      { label: 'Topics', href: '/admin/topics' },
      { label: 'Topic Subscriptions', href: '/admin/topic-subscriptions' },
      { label: 'Posts', href: '/admin/posts' },
      { label: 'Post Likes', href: '/admin/post-likes' },
      { label: 'Comments', href: '/admin/comments' },
      { label: 'Comment Likes', href: '/admin/comment-likes' },
      { label: 'Networks', href: '/admin/networks' },
      { label: 'Network Members', href: '/admin/network-members' },
      { label: 'Network Tags', href: '/admin/network-tags' },
    ],
  },
  {
    label: 'Moderation',
    links: [
      { label: 'Report Categories', href: '/admin/report-categories' },
      { label: 'Post Reports', href: '/admin/post-reports' },
      { label: 'Member Reports', href: '/admin/member-reports' },
    ],
  },
  {
    label: 'System',
    links: [
      { label: 'Notifications', href: '/admin/notifications' },
      { label: 'Commission Entries', href: '/admin/commission-entries' },
      { label: 'Admins', href: '/admin/admins' },
    ],
  },
];
