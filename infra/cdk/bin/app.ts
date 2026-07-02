#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { BbEcsStack } from '../lib/bb-ecs-stack';

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
});
