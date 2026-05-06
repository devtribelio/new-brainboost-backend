import { Router } from 'express';
import type { AppModule } from './module.interface';
import { logger } from '@/config/logger';

import { AuthModule } from '@/modules/auth/auth.module';
import { AccountModule } from '@/modules/account/account.module';
import { MemberModule } from '@/modules/member/member.module';
import { ProfileModule } from '@/modules/profile/profile.module';
import { LocationModule } from '@/modules/location/location.module';
import { UploadModule } from '@/modules/upload/upload.module';
import { BannerModule } from '@/modules/banner/banner.module';
import { ProductModule } from '@/modules/product/product.module';
import { CommissionModule } from '@/modules/commission/commission.module';
import { TopicModule } from '@/modules/topic/topic.module';
import { PostModule } from '@/modules/post/post.module';
import { CommentModule } from '@/modules/comment/comment.module';
import { ReplyModule } from '@/modules/reply/reply.module';
import { NetworkModule } from '@/modules/network/network.module';
import { ReportModule } from '@/modules/report/report.module';
import { NotificationModule } from '@/modules/notification/notification.module';

const modules: AppModule[] = [
  AuthModule,
  AccountModule,
  MemberModule,
  ProfileModule,
  LocationModule,
  UploadModule,
  BannerModule,
  ProductModule,
  CommissionModule,
  TopicModule,
  PostModule,
  CommentModule,
  ReplyModule,
  NetworkModule,
  ReportModule,
  NotificationModule,
];

export function registerModules(): Router {
  const root = Router();
  for (const mod of modules) {
    root.use(mod.prefix, mod.routes());
    logger.debug({ module: mod.name, prefix: mod.prefix }, 'Module registered');
  }
  return root;
}
