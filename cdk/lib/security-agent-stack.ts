import * as cdk from 'aws-cdk-lib/core';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Construct } from 'constructs';
import * as agentcore from '@aws-cdk/aws-bedrock-agentcore-alpha';
import * as path from 'path';

const SSM_PREFIX = '/security-agent';

export class SecurityAgentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ========================================
    // AgentCore Runtime
    // ========================================

    const runtime = new agentcore.Runtime(this, 'AgentRuntime', {
      runtimeName: 'security_agent_runtime',
      agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromAsset(
        path.join(__dirname, '../../agent')
      ),
      environmentVariables: {
        SSM_TAVILY_API_KEY: `${SSM_PREFIX}/tavily-api-key`,
        SSM_NVD_API_KEY: `${SSM_PREFIX}/nvd-api-key`,
      },
    });

    runtime.role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_PREFIX}/*`,
      ],
    }));

    runtime.role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: ['*'],
    }));

    runtime.role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        `arn:aws:bedrock:${this.region}::foundation-model/*`,
        'arn:aws:bedrock:::foundation-model/*',
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/*`,
      ],
    }));

    const gateway = new agentcore.Gateway(this, 'AgentGateway', {
      gatewayName: 'security-agent-gateway',
      description: 'Gateway for the Security Agent',
    });

    // ========================================
    // Slack 連携 (Receiver + SQS FIFO + Worker)
    // ========================================

    // SQS DLQ
    const dlq = new sqs.Queue(this, 'SlackDlq', {
      queueName: 'security-agent-slack-dlq.fifo',
      fifo: true,
      retentionPeriod: cdk.Duration.days(14),
    });

    // SQS FIFO Queue
    const queue = new sqs.Queue(this, 'SlackQueue', {
      queueName: 'security-agent-slack.fifo',
      fifo: true,
      contentBasedDeduplication: false,
      visibilityTimeout: cdk.Duration.seconds(900),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 2 },
    });

    // Receiver Lambda
    const projectRoot = path.join(__dirname, '../..');
    const receiver = new NodejsFunction(this, 'SlackReceiver', {
      entry: path.join(projectRoot, 'slack/lambda/receiver.ts'),
      projectRoot,
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(10),
      environment: {
        QUEUE_URL: queue.queueUrl,
        SSM_SIGNING_SECRET: `${SSM_PREFIX}/slack-signing-secret`,
      },
    });
    queue.grantSendMessages(receiver);
    receiver.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_PREFIX}/slack-signing-secret`,
      ],
    }));
    receiver.addToRolePolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: ['*'],
    }));

    // Worker Lambda
    const worker = new NodejsFunction(this, 'SlackWorker', {
      entry: path.join(projectRoot, 'slack/lambda/worker.ts'),
      projectRoot,
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(900),
      memorySize: 256,
      environment: {
        RUNTIME_ARN: runtime.agentRuntimeArn,
        SSM_BOT_TOKEN: `${SSM_PREFIX}/slack-bot-token`,
      },
    });
    worker.addEventSource(new SqsEventSource(queue, { batchSize: 1 }));
    worker.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:InvokeAgentRuntime'],
      resources: [`${runtime.agentRuntimeArn}`, `${runtime.agentRuntimeArn}/*`],
    }));
    worker.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_PREFIX}/slack-bot-token`,
      ],
    }));
    worker.addToRolePolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: ['*'],
    }));

    // API Gateway HTTP API
    const httpApi = new HttpApi(this, 'SlackApi', {
      apiName: 'security-agent-slack',
    });
    httpApi.addRoutes({
      path: '/slack/events',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('SlackReceiverIntegration', receiver),
    });

    // ========================================
    // Security Hub → EventBridge → Push Worker
    // ========================================

    const enableSecurityHubPush = this.node.tryGetContext('enableSecurityHubPush') ?? false;

    const pushWorker = new NodejsFunction(this, 'PushWorker', {
      entry: path.join(projectRoot, 'slack/lambda/push-worker.ts'),
      projectRoot,
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(900),
      memorySize: 256,
      environment: {
        RUNTIME_ARN: runtime.agentRuntimeArn,
        SSM_BOT_TOKEN: `${SSM_PREFIX}/slack-bot-token`,
        SLACK_CHANNEL: this.node.tryGetContext('slackChannel') ?? '',
      },
    });
    pushWorker.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:InvokeAgentRuntime'],
      resources: [`${runtime.agentRuntimeArn}`, `${runtime.agentRuntimeArn}/*`],
    }));
    pushWorker.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_PREFIX}/slack-bot-token`,
      ],
    }));
    pushWorker.addToRolePolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: ['*'],
    }));

    const securityHubRule = new events.Rule(this, 'SecurityHubRule', {
      ruleName: 'security-agent-finding',
      enabled: enableSecurityHubPush,
      eventPattern: {
        source: ['aws.securityhub'],
        detailType: ['Security Hub Findings - Imported'],
        detail: {
          findings: {
            RecordState: ['ACTIVE'],
            'Workflow': { Status: ['NEW'] },
          },
        },
      },
    });
    securityHubRule.addTarget(new targets.LambdaFunction(pushWorker));

    // Outputs
    new cdk.CfnOutput(this, 'SlackApiUrl', {
      value: `${httpApi.apiEndpoint}/slack/events`,
      description: 'Slack Event Subscriptions に設定する URL',
    });

    new cdk.CfnOutput(this, 'RuntimeArn', {
      value: runtime.agentRuntimeArn,
      description: 'AgentCore Runtime ARN',
    });
  }
}
