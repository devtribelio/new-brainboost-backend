#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import * as fs from 'fs';
import * as path from 'path';
import { BbEcsStack } from '../lib/bb-ecs-stack';
import { BbMediaCdnStack } from '../lib/bb-media-cdn-stack';

const app = new cdk.App();

const region = app.node.tryGetContext('region') ?? 'ap-southeast-3';
const account = process.env.CDK_DEFAULT_ACCOUNT;

new BbEcsStack(app, 'BbEcsStack', {
  env: { account, region },
  imageTag: app.node.tryGetContext('imageTag') ?? 'latest',
  appSecretName: app.node.tryGetContext('appSecretName') ?? 'bb/prod/app',
  rdsSecurityGroupId: app.node.tryGetContext('rdsSecurityGroupId'),
  certificateArn: app.node.tryGetContext('certificateArn') || undefined,
  // Resync worker: off unless `-c resyncEnabled=true`. resyncImageTag defaults to imageTag.
  resyncEnabled: app.node.tryGetContext('resyncEnabled') === 'true',
  resyncImageTag: app.node.tryGetContext('resyncImageTag') || undefined,
  // bb-comms (repo bb-notification-service) tag terpisah; default = imageTag.
  commsImageTag: app.node.tryGetContext('commsImageTag') || undefined,
});

// === CDN media (CloudFront di depan bucket yang sudah ada) ===
// Satu stack per env, dipilih dengan `-c mediaCdnEnv=staging`. Cert-nya WAJIB
// us-east-1 dan dibuat di luar CDK (DNS di Cloudflare, bukan Route53):
//   aws acm request-certificate --region us-east-1 --domain-name <domain> --validation-method DNS
// lalu pasang CNAME validasinya di Cloudflare, tunggu ISSUED, baru deploy dengan
// `-c mediaCdnCertificateArn=<arn>`. Public key di infra/cdk/cdn-keys/<env>.public.pem;
// private key-nya di Secrets Manager `bb/<env>/cdn-signing-key` → MEDIA_CDN_PRIVATE_KEY.
const MEDIA_CDN_ENVS: Record<string, { bucketName: string; bucketRegion: string; domainName: string }> = {
  staging: {
    bucketName: 'brainboost-staging',
    bucketRegion: 'ap-southeast-1',
    domainName: 'cdn-staging.brainboostos.com',
  },
  // prod: distribusi cdn.brainboost.id (EAN6B036LQYKV) dibuat manual dan TIDAK
  // dikelola stack ini (jangan dibuat baru). Behavior private/audio/* + key group
  // bb-media-prod (public key K3FE2W1Z0KLGDM, infra/cdk/cdn-keys/prod.public.pem)
  // ditambahkan 2026-09-21 lewat CLI; private key di Secrets Manager
  // bb/prod/cdn-signing-key. Kandidat `cdk import` kalau mau disatukan.
};
const mediaCdnEnv = app.node.tryGetContext('mediaCdnEnv') as string | undefined;
if (mediaCdnEnv) {
  const cfg = MEDIA_CDN_ENVS[mediaCdnEnv];
  if (!cfg) throw new Error(`mediaCdnEnv tidak dikenal: ${mediaCdnEnv}`);
  const certificateArn = app.node.tryGetContext('mediaCdnCertificateArn');
  if (!certificateArn) throw new Error('mediaCdnCertificateArn wajib (ACM us-east-1, status ISSUED)');
  new BbMediaCdnStack(app, `BbMediaCdn${mediaCdnEnv[0].toUpperCase()}${mediaCdnEnv.slice(1)}Stack`, {
    env: { account, region },
    envName: mediaCdnEnv,
    ...cfg,
    certificateArn,
    signingPublicKeyPem: fs.readFileSync(
      path.join(__dirname, '..', 'cdn-keys', `${mediaCdnEnv}.public.pem`),
      'utf8',
    ),
  });
}
