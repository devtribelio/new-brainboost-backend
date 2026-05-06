import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BadRequestException } from '@/common/exceptions';

type ClassConstructor<T> = new (...args: unknown[]) => T;
type Source = 'body' | 'query' | 'params';

export function validateDto<T extends object>(
  cls: ClassConstructor<T>,
  source: Source = 'body',
): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const raw = req[source] as unknown;
      const instance = plainToInstance(cls, raw, { enableImplicitConversion: true });
      const errors = await validate(instance as object, {
        whitelist: true,
        forbidNonWhitelisted: false,
      });

      if (errors.length > 0) {
        const details = errors.map((e) => ({
          property: e.property,
          constraints: e.constraints,
        }));
        return next(new BadRequestException('Validation failed', details));
      }

      (req as unknown as Record<Source, T>)[source] = instance;
      next();
    } catch (err) {
      next(err);
    }
  };
}
