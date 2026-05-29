import type { Router } from 'express';

export interface AppModule {
  name: string;
  prefix: string;
  routes: () => Router;
}
