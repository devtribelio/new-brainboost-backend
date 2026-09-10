import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app';

describe('OpenAPI / Swagger', () => {
  const app = buildApp();

  it('GET /api/docs.json returns valid OpenAPI 3 doc', async () => {
    const r = await request(app).get('/api/docs.json');
    expect(r.status).toBe(200);
    expect(r.body.openapi).toBe('3.0.3');
    expect(r.body.info.title).toContain('API');
    expect(typeof r.body.paths).toBe('object');
  });

  it('OpenAPI doc lists key endpoints', async () => {
    const r = await request(app).get('/api/docs.json');
    const paths = Object.keys(r.body.paths);
    expect(paths).toContain('/api/member/oauth/token');
    expect(paths).toContain('/api/member/data/banner');
    expect(paths).toContain('/api/member/topic/list');
    expect(paths).toContain('/api/member/post/list');
    expect(paths).toContain('/api/member/info');
  });

  it('OpenAPI doc has tags and security scheme', async () => {
    const r = await request(app).get('/api/docs.json');
    const tagNames = (r.body.tags as { name: string }[]).map((t) => t.name);
    expect(tagNames).toEqual(expect.arrayContaining(['Auth', 'Banner', 'Post', 'Comment']));
    expect(r.body.components.securitySchemes.bearerAuth).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
  });

  it('LoginDto schema has grant_type required + enum', async () => {
    const r = await request(app).get('/api/docs.json');
    const schema = r.body.components.schemas.LoginDto;
    expect(schema).toBeTruthy();
    expect(schema.required).toContain('grant_type');
    expect(schema.properties.grant_type.enum).toEqual(
      expect.arrayContaining(['password', 'refresh_token']),
    );
  });

  it('GET /api/docs serves swagger-ui html', async () => {
    const r = await request(app).get('/api/docs/').redirects(0);
    expect([200, 301]).toContain(r.status);
  });

  it('routes guarded by authGuard auto-emit bearerAuth security', async () => {
    const r = await request(app).get('/api/docs.json');
    const productList = r.body.paths['/api/member/product/list']?.get;
    expect(productList).toBeTruthy();
    expect(productList.security).toEqual([{ bearerAuth: [] }]);
  });

  it('unauthenticated routes have no security entry', async () => {
    const r = await request(app).get('/api/docs.json');
    const oauthToken = r.body.paths['/api/member/oauth/token']?.post;
    expect(oauthToken).toBeTruthy();
    expect(oauthToken.security).toBeUndefined();
  });

  // `type: () => [Dto]` used to fall through every branch of `toJsonSchemaType`
  // and emit `{ type: 'string' }`, so every nested list in the event module was
  // documented as a string and its item schema was never registered. A reader of
  // the spec could not tell what to put in `attendees`.
  it('documents an array-of-DTO property as an array of $ref', async () => {
    const r = await request(app).get('/api/docs.json');
    const schemas = r.body.components.schemas;

    expect(schemas.EventCheckoutDto.properties.attendees).toMatchObject({
      type: 'array',
      items: { $ref: '#/components/schemas/EventAttendeeDto' },
    });
    // The item schema must also exist — a $ref to nothing renders as an empty box.
    expect(schemas.EventAttendeeDto).toBeTruthy();
    expect(Object.keys(schemas.EventAttendeeDto.properties)).toEqual(
      expect.arrayContaining(['name', 'email']),
    );
    // Same form on a response, to prove it is the mechanism and not one call site.
    expect(schemas.EventOrderResultDto.properties.tickets).toMatchObject({
      type: 'array',
      items: { $ref: '#/components/schemas/EventOrderTicketDto' },
    });
  });
});
