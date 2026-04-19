#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { SecurityAgentStack } from '../lib/security-agent-stack';

const app = new cdk.App();
new SecurityAgentStack(app, 'SecurityAgentStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
