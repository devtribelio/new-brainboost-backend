import type { Response } from 'express';
import { prisma } from '@/config/prisma';
import type { AdminRequest } from './admin.types';
import { renderAdmin } from './util/view';

interface CountCard {
  label: string;
  value: number;
  href: string;
}

export class AdminDashboardController {
  index = async (req: AdminRequest, res: Response) => {
    const [
      members,
      banners,
      products,
      courses,
      topics,
      posts,
      comments,
      networks,
      postReports,
      memberReports,
      notifications,
      admins,
    ] = await Promise.all([
      prisma.member.count(),
      prisma.banner.count(),
      prisma.product.count(),
      prisma.course.count(),
      prisma.topic.count(),
      prisma.post.count({ where: { isDeleted: false } }),
      prisma.comment.count({ where: { isDeleted: false } }),
      prisma.network.count(),
      prisma.postReport.count(),
      prisma.memberReport.count(),
      prisma.notification.count(),
      prisma.admin.count(),
    ]);

    const cards: CountCard[] = [
      { label: 'Members', value: members, href: '/admin/members' },
      { label: 'Banners', value: banners, href: '/admin/banners' },
      { label: 'Products', value: products, href: '/admin/products' },
      { label: 'Courses', value: courses, href: '/admin/courses' },
      { label: 'Topics', value: topics, href: '/admin/topics' },
      { label: 'Posts', value: posts, href: '/admin/posts' },
      { label: 'Comments', value: comments, href: '/admin/comments' },
      { label: 'Networks', value: networks, href: '/admin/networks' },
      { label: 'Post Reports', value: postReports, href: '/admin/post-reports' },
      { label: 'Member Reports', value: memberReports, href: '/admin/member-reports' },
      { label: 'Notifications', value: notifications, href: '/admin/notifications' },
      { label: 'Admins', value: admins, href: '/admin/admins' },
    ];

    renderAdmin(req, res, 'admin/dashboard', { title: 'Dashboard', cards });
  };
}
