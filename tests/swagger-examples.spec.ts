import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/app';

describe('OpenAPI doc — response examples', () => {
  const app = buildApp();

  it('serves /api/docs.json with example values on key endpoints', async () => {
    const r = await request(app).get('/api/docs.json');
    expect(r.status).toBe(200);
    const doc = r.body;

    const tokenDto = doc.components.schemas.TokenBundleDto;
    expect(tokenDto).toBeTruthy();
    expect(tokenDto.properties.access_token.example).toBeTypeOf('string');
    expect(tokenDto.properties.expires_in.example).toBe(900);

    const postListSchema =
      doc.paths['/api/member/post/list'].get.responses['200'].content['application/json'].schema;
    expect(postListSchema.properties.success.example).toBe(true);
    expect(postListSchema.properties.data.$ref).toBe('#/components/schemas/PostPageDto');

    const postPage = doc.components.schemas.PostPageDto;
    expect(postPage.properties.items.items.$ref).toBe('#/components/schemas/PostDto');
    expect(postPage.properties.total.example).toBeTypeOf('number');

    const postDto = doc.components.schemas.PostDto;
    expect(postDto.properties.content.example).toBeTypeOf('string');
    expect(postDto.properties.member.$ref).toBe('#/components/schemas/MemberLiteDto');

    const memberLite = doc.components.schemas.MemberLiteDto;
    expect(memberLite.properties.email.example).toBe('john.doe@example.com');

    const bannerOp = doc.paths['/api/member/data/banner'].get;
    const bannerArrayItems =
      bannerOp.responses['200'].content['application/json'].schema.properties.data.items;
    expect(bannerArrayItems.$ref).toBe('#/components/schemas/BannerDto');

    const productPage = doc.components.schemas.ProductPageDto;
    expect(productPage.properties.items.items.$ref).toBe('#/components/schemas/ProductDto');

    const productDto = doc.components.schemas.ProductDto;
    expect(productDto.properties.productName.example).toBe('React Fundamentals');

    const accountChangePwBody =
      doc.paths['/api/member/account/changePassword'].post.requestBody.content['application/json']
        .schema;
    expect(accountChangePwBody.$ref).toBe('#/components/schemas/ChangePasswordDto');
    const changePwDto = doc.components.schemas.ChangePasswordDto;
    expect(changePwDto.properties.oldPassword.example).toBe('oldS3cret');

    expect(doc.components.schemas.CountryPageDto).toBeTruthy();
    expect(doc.components.schemas.NotificationPageDto.properties.unread.example).toBe(4);
    expect(doc.components.schemas.CommissionSummaryDto.properties.currency.example).toBe('IDR');
    expect(doc.components.schemas.UploadedFileDto.properties.url.example).toBe(
      '/static/temporary/tmp-abc123.jpg',
    );
  });
});
