import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as events from 'aws-cdk-lib/aws-events';

export interface BbEcsStackProps extends cdk.StackProps {
  imageTag: string;
  appSecretName: string;       // Secrets Manager secret (JSON) berisi env: DATABASE_URL, SQS_*, vendor creds
  rdsSecurityGroupId: string;  // bb-sg-rds — biar Fargate boleh nyolok RDS:5432
  certificateArn?: string;     // ACM cert utk HTTPS:443 (opsional; tanpa ini jalan di HTTP:80)
}

export class BbEcsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: BbEcsStackProps) {
    super(scope, id, props);

    // === VPC default (tempat RDS hidup) — biar Fargate satu jaringan sama DB ===
    const vpc = ec2.Vpc.fromLookup(this, 'Vpc', { isDefault: true });

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc, clusterName: 'bb-prod', containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // === Secret app (DATABASE_URL pakai bb_app, SQS urls, dst) ===
    const appSecret = secretsmanager.Secret.fromSecretNameV2(this, 'AppSecret', props.appSecretName);
    const sm = (key: string) => ecs.Secret.fromSecretsManager(appSecret, key);
    // Tambah sisa env (vendor creds) sesuai packages/common/src/config/env.ts
    // PENTING: tiap key di sini HARUS ada di secret `bb/prod/app`, atau task gagal start.
    // Ini = env yang REQUIRED di production (env.ts) + SQS (buat comms). Cukup buat boot.
    const secrets: Record<string, ecs.Secret> = {
      DATABASE_URL: sm('DATABASE_URL'),
      JWT_ACCESS_SECRET: sm('JWT_ACCESS_SECRET'),
      JWT_REFRESH_SECRET: sm('JWT_REFRESH_SECRET'),
      ADMIN_JWT_SECRET: sm('ADMIN_JWT_SECRET'),
      S3_ACCESS_KEY_ID: sm('S3_ACCESS_KEY_ID'),
      S3_SECRET_ACCESS_KEY: sm('S3_SECRET_ACCESS_KEY'),
      S3_BUCKET: sm('S3_BUCKET'),
      MEDIA_TOKEN_SECRET: sm('MEDIA_TOKEN_SECRET'),
      SQS_COMMS_URGENT_URL: sm('SQS_COMMS_URGENT_URL'),
      SQS_COMMS_NORMAL_URL: sm('SQS_COMMS_NORMAL_URL'),
      // --- VENDOR (nama key sudah dicocokkan ke env.ts) ---
      // ⚠️ Tiap key di bawah HARUS ada di secret bb/prod/app sebelum deploy, atau task gagal start.
      //    Belum punya nilai prod? Isi sandbox/staging dulu (app tetap jalan), swap nanti.
      XENDIT_SECRET_KEY: sm('XENDIT_SECRET_KEY'),
      XENDIT_CALLBACK_TOKEN: sm('XENDIT_CALLBACK_TOKEN'),
      REVENUECAT_WEBHOOK_AUTH: sm('REVENUECAT_WEBHOOK_AUTH'),

      // Bunny: cuma 2 yang DIPAKAI media module (streamApiKey & libraryId itu dead field).
      BUNNY_STREAM_TOKEN_KEY: sm('BUNNY_STREAM_TOKEN_KEY'),
      BUNNY_STREAM_CDN_HOST: sm('BUNNY_STREAM_CDN_HOST'),

      SUMSUB_APP_TOKEN: sm('SUMSUB_APP_TOKEN'),
      SUMSUB_SECRET_KEY: sm('SUMSUB_SECRET_KEY'),
      SUMSUB_WEBHOOK_SECRET: sm('SUMSUB_WEBHOOK_SECRET'),
      SUMSUB_LEVEL_NAME: sm('SUMSUB_LEVEL_NAME'),

      // Social login: cuma audiences (validasi token). OAUTH_CLIENT_ID/SECRET = optional, staging nggak set.
      GOOGLE_CLIENT_IDS: sm('GOOGLE_CLIENT_IDS'),
      APPLE_CLIENT_IDS: sm('APPLE_CLIENT_IDS'),

      // FCM — tambah nanti (lihat catatan FCM): FCM_PROJECT_ID, FCM_SERVICE_ACCOUNT_JSON
      // SUMSUB_BASE_URL & SUMSUB_TOKEN_TTL_SECONDS sengaja DIBUANG — env.ts udah punya default benar.
    };
    const env: Record<string, string> = {
      NODE_ENV: 'production',
      SQS_REGION: this.region,
      API_DOCS_ENABLED: 'false',
    };

    // === ECR images ===
    const img = (repo: string) =>
      ecs.ContainerImage.fromEcrRepository(
        ecr.Repository.fromRepositoryName(this, `${repo}Repo`, `bb/${repo}`), props.imageTag);
    const mobileApiImg = img('mobile-api');   // dipakai 3×: api, comms-relay, cron
    const commsImg = img('bb-comms');
    // backoffice-api (skeleton kosong) & admin-ejs (panel admin, belum dibutuhin) SENGAJA di-skip.
    // Image-nya tetap ada di ECR; tinggal tambah service-nya nanti kalau perlu.

    // === Task role (perm runtime: SQS) ===
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sqs:SendMessage', 'sqs:ReceiveMessage', 'sqs:DeleteMessage',
                'sqs:GetQueueUrl', 'sqs:GetQueueAttributes'],
      resources: ['*'], // TODO: persempit ke ARN 2 queue (urgent, normal)
    }));

    const logGroup = (name: string) => new logs.LogGroup(this, `Log-${name}`, {
      logGroupName: `/bb/prod/${name}`, retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // === Security group Fargate + izinkan ke RDS ===
    const appSg = new ec2.SecurityGroup(this, 'AppSg', {
      vpc, description: 'bb fargate tasks', allowAllOutbound: true,
    });
    const rdsSg = ec2.SecurityGroup.fromSecurityGroupId(this, 'RdsSg', props.rdsSecurityGroupId);
    rdsSg.addIngressRule(appSg, ec2.Port.tcp(5432), 'Fargate tasks to RDS');

    const placement = { vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC }, assignPublicIp: true, securityGroups: [appSg] };

    // ============ HTTP service helper (di belakang ALB) ============
    const makeHttpService = (id: string, image: ecs.ContainerImage, port: number, command?: string[]) => {
      const td = new ecs.FargateTaskDefinition(this, `${id}Task`, {
        cpu: 512, memoryLimitMiB: 1024, taskRole,
        runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64 }, // Graviton: native build di Mac + ~20% lebih murah
      });
      td.addContainer(id, {
        image, command,
        environment: { ...env, PORT: String(port) },
        secrets,
        logging: ecs.LogDrivers.awsLogs({ streamPrefix: id, logGroup: logGroup(id) }),
        portMappings: [{ containerPort: port }],
      });
      return new ecs.FargateService(this, `${id}Svc`, {
        cluster, taskDefinition: td, desiredCount: 1,
        minHealthyPercent: 100, maxHealthyPercent: 200, ...placement,
        circuitBreaker: { rollback: true }, // deploy gagal → cepet stop + rollback (bukan gantung 3 jam)
      });
    };

    // ---- mobile-api (autoscale 2->6 berdasar CPU; min 2 = floor) ----
    const mobileSvc = makeHttpService('mobile-api', mobileApiImg, 3000, ['node', 'dist/main.js']);
    const scaling = mobileSvc.autoScaleTaskCount({ minCapacity: 2, maxCapacity: 6 });
    scaling.scaleOnCpuUtilization('Cpu', { targetUtilizationPercent: 60 });

    // ============ ALB → mobile-api ============
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', { vpc, internetFacing: true });
    const healthCheck = { path: '/health', healthyHttpCodes: '200' };

    if (props.certificateArn) {
      // HTTPS:443 (cert) + HTTP:80 redirect → 443
      const https = alb.addListener('Https', {
        port: 443, open: true,
        certificates: [elbv2.ListenerCertificate.fromArn(props.certificateArn)],
      });
      https.addTargets('mobile-api', {
        port: 3000, protocol: elbv2.ApplicationProtocol.HTTP, targets: [mobileSvc], healthCheck,
      });
      alb.addListener('Http', { // logical ID sama dgn branch non-cert → update in-place (bukan create baru)
        port: 80, open: true,
        defaultAction: elbv2.ListenerAction.redirect({ protocol: 'HTTPS', port: '443', permanent: true }),
      });
    } else {
      // belum ada cert → HTTP:80 doang
      const http = alb.addListener('Http', { port: 80, open: true });
      http.addTargets('mobile-api', {
        port: 3000, protocol: elbv2.ApplicationProtocol.HTTP, targets: [mobileSvc], healthCheck,
      });
    }
    // TODO WAF: associate WAFv2 web ACL (rate-based per-IP) ke ALB.

    // ============ comms-relay (SINGLETON — jangan autoscale) ============
    const relayTd = new ecs.FargateTaskDefinition(this, 'CommsRelayTask', {
      cpu: 256, memoryLimitMiB: 512, taskRole,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64 },
    });
    relayTd.addContainer('comms-relay', {
      image: mobileApiImg, command: ['node', 'dist/workers/comms-relay.js'],
      environment: env, secrets,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'comms-relay', logGroup: logGroup('comms-relay') }),
    });
    new ecs.FargateService(this, 'CommsRelaySvc', {
      cluster, taskDefinition: relayTd, desiredCount: 1, ...placement,
      minHealthyPercent: 0, maxHealthyPercent: 100, // singleton: jangan jalanin 2 sekaligus
      circuitBreaker: { rollback: true },
    });

    // ============ cron (EventBridge → RunTask, tiap jam) ============
    // Task def eksplisit biar bisa set ARM64 + taskRole.
    const cronTd = new ecs.FargateTaskDefinition(this, 'CronTask', {
      cpu: 256, memoryLimitMiB: 512, taskRole,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64 },
    });
    cronTd.addContainer('cron', {
      image: mobileApiImg, command: ['node', 'dist/jobs-runner.js'],
      environment: env, secrets,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'cron', logGroup: logGroup('cron') }),
    });
    new ecsPatterns.ScheduledFargateTask(this, 'Cron', {
      cluster,
      schedule: events.Schedule.cron({ minute: '0' }), // 0 * * * *  hourly
      subnetSelection: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [appSg],
      scheduledFargateTaskDefinitionOptions: { taskDefinition: cronTd },
    });
    // CATATAN: ScheduledFargateTask nggak set assignPublicIp. Kalau cron gagal pull image
    // (no route ke ECR di public subnet), tambah VPC endpoint (ECR/S3/Logs/Secrets) atau NAT.

    // ============ bb-comms (consumer SQS; autoscale by queue depth nanti) ============
    const commsTd = new ecs.FargateTaskDefinition(this, 'BbCommsTask', {
      cpu: 256, memoryLimitMiB: 512, taskRole,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64 },
    });
    commsTd.addContainer('bb-comms', {
      image: commsImg,
      environment: env, secrets,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'bb-comms', logGroup: logGroup('bb-comms') }),
    });
    new ecs.FargateService(this, 'BbCommsSvc', {
      cluster, taskDefinition: commsTd, desiredCount: 1, ...placement,
      minHealthyPercent: 0, maxHealthyPercent: 200,
      circuitBreaker: { rollback: true },
    });

    new cdk.CfnOutput(this, 'AlbDns', { value: alb.loadBalancerDnsName });
    new cdk.CfnOutput(this, 'AppSecurityGroupId', { value: appSg.securityGroupId });
  }
}
