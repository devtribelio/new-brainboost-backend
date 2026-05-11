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

    // Issue 9: success / ok must be declared as boolean (was defaulting to string).
    expect(doc.components.schemas.ApiErrorResponseDto.properties.success.type).toBe('boolean');
    expect(doc.components.schemas.GenericOkDto.properties.ok.type).toBe('boolean');

    // Issue 3: network/join request body documented via NetworkJoinBodyDto.
    expect(doc.components.schemas.NetworkJoinBodyDto).toBeTruthy();
    expect(doc.components.schemas.NetworkJoinBodyDto.properties.code).toBeTruthy();
    expect(doc.components.schemas.NetworkJoinBodyDto.properties.networkCode).toBeTruthy();
    expect(doc.components.schemas.NetworkJoinBodyDto.properties.networkId).toBeTruthy();
    expect(doc.components.schemas.NetworkJoinBodyDto.properties.action.enum).toEqual([
      'join',
      'leave',
    ]);
    const joinBody =
      doc.paths['/api/member/network/join'].post.requestBody.content['application/json'].schema;
    expect(joinBody.$ref).toBe('#/components/schemas/NetworkJoinBodyDto');

    // Issue 4: network/tag exposes page/perPage/keyword/sort and none are required.
    const tagParams = doc.paths['/api/member/network/tag'].get.parameters as {
      name: string;
      required: boolean;
    }[];
    const tagParamNames = tagParams.map((p) => p.name);
    expect(tagParamNames).toEqual(
      expect.arrayContaining(['code', 'networkId', 'page', 'perPage', 'keyword', 'sort']),
    );
    expect(tagParams.every((p) => p.required === false)).toBe(true);

    // Issue 5 (PR1 portion): community networkId is no longer nullable.
    const community = doc.components.schemas.CommunityEntryDto;
    expect(community.properties.networkId.nullable).toBeUndefined();
    expect(community.required).toEqual(expect.arrayContaining(['networkId']));
  });
});
