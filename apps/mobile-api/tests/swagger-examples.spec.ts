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

    // Paginated envelope: { success, data: PostDto[], meta: { pagination }, error }.
    const postListSchema =
      doc.paths['/api/member/post/list'].get.responses['200'].content['application/json'].schema;
    expect(postListSchema.properties.success.example).toBe(true);
    expect(postListSchema.properties.data.type).toBe('array');
    expect(postListSchema.properties.data.items.$ref).toBe('#/components/schemas/PostDto');
    expect(postListSchema.properties.meta.properties.pagination.$ref).toBe(
      '#/components/schemas/PaginationMetaDto',
    );

    const postDto = doc.components.schemas.PostDto;
    expect(postDto.properties.content.example).toBeTypeOf('string');
    expect(postDto.properties.member.$ref).toBe('#/components/schemas/MemberLiteDto');

    const memberLite = doc.components.schemas.MemberLiteDto;
    expect(memberLite.properties.email.example).toBe('john.doe@example.com');

    // Banner now uses unified paginated envelope (no special-case okLegacy shape).
    const bannerSchema =
      doc.paths['/api/member/data/banner'].get.responses['200'].content['application/json']
        .schema;
    expect(bannerSchema.properties.data.type).toBe('array');
    expect(bannerSchema.properties.data.items.$ref).toBe('#/components/schemas/BannerDto');

    const productListSchema =
      doc.paths['/api/member/product/list'].get.responses['200'].content['application/json']
        .schema;
    expect(productListSchema.properties.data.items.$ref).toBe('#/components/schemas/ProductDto');
    expect(productListSchema.properties.meta.properties.pagination.$ref).toBe(
      '#/components/schemas/PaginationMetaDto',
    );

    const productDto = doc.components.schemas.ProductDto;
    expect(productDto.properties.productName.example).toBe('React Fundamentals');

    const accountChangePwBody =
      doc.paths['/api/member/account/changePassword'].post.requestBody.content['application/json']
        .schema;
    expect(accountChangePwBody.$ref).toBe('#/components/schemas/ChangePasswordDto');
    const changePwDto = doc.components.schemas.ChangePasswordDto;
    expect(changePwDto.properties.oldPassword.example).toBe('oldS3cret');

    // Pagination meta DTO is registered globally for every paginated response.
    expect(doc.components.schemas.PaginationMetaDto.properties.totalPages).toBeDefined();
    expect(doc.components.schemas.CommissionSummaryDto.properties.currency.example).toBe('IDR');
    expect(doc.components.schemas.UploadedFileDto.properties.url.example).toBe(
      'public/uploads/01935f.../a1b2c3.webp',
    );

    // Upload endpoint documents a multipart/form-data body with a binary `image` field.
    const uploadOp = doc.paths['/api/member/upload/temporary'].post;
    const uploadBody = uploadOp.requestBody.content['multipart/form-data'].schema;
    expect(uploadBody.properties.image.items.format).toBe('binary');
    expect(uploadBody.required).toContain('image');
    // ...and a `kind` query param enumerating the folder kinds.
    const kindParam = uploadOp.parameters.find((p: { name: string }) => p.name === 'kind');
    expect(kindParam.in).toBe('query');
    expect(kindParam.schema.enum).toContain('avatar');

    // Error envelope: { success:false, data:null, meta:null, error: { code, message, details? } }.
    expect(doc.components.schemas.ErrorEnvelopeDto.properties.success.type).toBe('boolean');
    expect(doc.components.schemas.ErrorEnvelopeDto.properties.error.$ref).toBe(
      '#/components/schemas/ApiErrorDto',
    );
    expect(doc.components.schemas.ApiErrorDto.properties.code.type).toBe('string');
    expect(doc.components.schemas.ApiErrorDto.properties.message.type).toBe('string');
    expect(doc.components.schemas.GenericOkDto.properties.ok.type).toBe('boolean');

    // network/join request body documented via NetworkJoinBodyDto.
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

    // network/tag exposes page/perPage/keyword/sort and none are required.
    const tagParams = doc.paths['/api/member/network/tag'].get.parameters as {
      name: string;
      required: boolean;
    }[];
    const tagParamNames = tagParams.map((p) => p.name);
    expect(tagParamNames).toEqual(
      expect.arrayContaining(['code', 'networkId', 'page', 'perPage', 'keyword', 'sort']),
    );
    expect(tagParams.every((p) => p.required === false)).toBe(true);

    // community networkId is no longer nullable.
    const community = doc.components.schemas.CommunityEntryDto;
    expect(community.properties.networkId.nullable).toBeUndefined();
    expect(community.required).toEqual(expect.arrayContaining(['networkId']));
  });
});
