import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';

export interface BbMediaCdnStackProps extends cdk.StackProps {
  /** Nama env, jadi bagian nama resource (staging | prod). */
  envName: string;
  /** Bucket yang sudah ada (TIDAK dibuat di sini). */
  bucketName: string;
  bucketRegion: string;
  /** Alias CDN, mis. cdn-staging.brainboostos.com. DNS-nya di Cloudflare (CNAME, DNS-only). */
  domainName: string;
  /** ACM cert WAJIB di us-east-1 (syarat CloudFront), dibuat di luar stack: DNS-nya bukan Route53. */
  certificateArn: string;
  /** Public key PEM pasangan MEDIA_CDN_PRIVATE_KEY di backend. */
  signingPublicKeyPem: string;
}

/**
 * CDN media di depan bucket S3 yang sudah ada — satu bucket, satu distribusi,
 * dua behavior:
 *   - default (`public/*` dst)  : baca bebas, seperti cdn.brainboost.id sekarang.
 *   - `private/audio/*`         : WAJIB CloudFront signed URL (key group di bawah).
 * Bucket tetap tertutup: hanya OAC distribusi ini yang boleh GetObject.
 *
 * Bucket policy TIDAK dikelola di sini (bucket-nya imported; BucketPolicy CDK
 * akan menimpa policy public/* yang sudah ada). Statement yang harus ditambah
 * dicetak sebagai output `BucketPolicyStatement`.
 */
export class BbMediaCdnStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: BbMediaCdnStackProps) {
    super(scope, id, props);

    const bucket = s3.Bucket.fromBucketAttributes(this, 'Bucket', {
      bucketName: props.bucketName,
      region: props.bucketRegion,
    });
    const certificate = acm.Certificate.fromCertificateArn(this, 'Cert', props.certificateArn);

    const publicKey = new cloudfront.PublicKey(this, 'SigningPublicKey', {
      publicKeyName: `bb-media-${props.envName}`,
      encodedKey: props.signingPublicKeyPem,
      comment: `pasangan MEDIA_CDN_PRIVATE_KEY backend ${props.envName}`,
    });
    const keyGroup = new cloudfront.KeyGroup(this, 'SigningKeyGroup', {
      keyGroupName: `bb-media-${props.envName}`,
      items: [publicKey],
    });

    const origin = origins.S3BucketOrigin.withOriginAccessControl(bucket, {
      originAccessLevels: [cloudfront.AccessLevel.READ],
    });

    // Samakan dengan cdn.brainboost.id yang ada: CachingOptimized, redirect-to-https,
    // HTTP/2+3, IPv6. Query string signed URL (Expires/Signature/Key-Pair-Id) tidak
    // masuk cache key — CloudFront memvalidasinya sendiri sebelum menyentuh cache.
    const common: cloudfront.AddBehaviorOptions = {
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      compress: true,
    };

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `bb media ${props.envName} (${props.bucketName})`,
      domainNames: [props.domainName],
      certificate,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      enableIpv6: true,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
      defaultBehavior: { origin, ...common },
      additionalBehaviors: {
        'private/audio/*': { origin, ...common, trustedKeyGroups: [keyGroup] },
      },
    });

    new cdk.CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new cdk.CfnOutput(this, 'DistributionDomain', {
      value: distribution.distributionDomainName,
      description: `Target CNAME ${props.domainName} di Cloudflare (DNS only)`,
    });
    new cdk.CfnOutput(this, 'KeyPairId', {
      value: publicKey.publicKeyId,
      description: 'MEDIA_CDN_KEY_PAIR_ID di backend',
    });
    new cdk.CfnOutput(this, 'BucketPolicyStatement', {
      description: 'Tambahkan ke bucket policy (merge, jangan replace)',
      value: cdk.Stack.of(this).toJsonString({
        Sid: `AllowCloudFront-${props.envName}`,
        Effect: 'Allow',
        Principal: { Service: 'cloudfront.amazonaws.com' },
        Action: 's3:GetObject',
        Resource: `arn:aws:s3:::${props.bucketName}/*`,
        Condition: {
          StringEquals: {
            'AWS:SourceArn': `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
          },
        },
      }),
    });
  }
}
