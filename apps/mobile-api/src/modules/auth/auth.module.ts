import passport from 'passport';
import type { AppModule } from '@bb/common/core/module.interface';
import { authRoutes } from './auth.routes';
import { GoogleIdTokenStrategy } from './strategies/google-id-token.strategy';

passport.use(new GoogleIdTokenStrategy());

export const AuthModule: AppModule = {
  name: 'auth',
  prefix: '/member',
  routes: authRoutes,
};
